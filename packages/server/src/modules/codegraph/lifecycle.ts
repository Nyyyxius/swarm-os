/**
 * Codegraph janitor — the periodic sweep that keeps every scope's graph fresh
 * WITHOUT ever running graphify blindly.
 *
 * Modelled on `taskboard/lifecycle.ts:startTaskboardJanitor`: an unref'd
 * `setInterval`, one immediate sweep, every tick wrapped so a failure can never
 * crash the 24/7 loop, and a `stop()`.
 *
 * Each sweep:
 *   1. (re)discover scopes and reconcile them into the store (new projects/
 *      plugins appear, deleted ones are removed, the C3 gate flips enabled).
 *   2. for each ENABLED scope, compute a cheap source fingerprint (sorted
 *      path+size+mtime hash of first-party code) and compare to `lastSourceHash`.
 *      Only when it DIFFERS (or the scope was never indexed) do we invoke
 *      graphify — a no-change `update` still costs seconds, so this guard is the
 *      whole point (P0 refinement).
 *   3. graphify runs are serialised (one at a time) and per-scope locked, so a
 *      long build never overlaps itself or pins every core at once.
 *
 * An OPTIONAL recursive `fs.watch` on each enabled scope just schedules a
 * debounced out-of-band sweep so edits are picked up in seconds rather than at
 * the next interval — the janitor remains the source of truth; the watcher only
 * accelerates it, and any watch failure is swallowed.
 */

import * as fs from 'node:fs';
import { withModule } from '../../logger.js';
import type { MemoryStore } from '../memory/store.js';
import type { GraphStore } from './store.js';
import type { PluginLister, DiscoveredScope } from './discovery.js';
import { discoverScopes } from './discovery.js';
import { sourceFingerprint } from './scan.js';
import { runUpdate, type CodegraphEngine } from './graphify.js';
import { CodegraphMemoryNotes } from './memory-notes.js';

const log = withModule('codegraph.lifecycle');

export interface CodegraphJanitorDeps {
  store: GraphStore;
  workspaceRoot: string;
  dataDir: string;
  pluginStore?: PluginLister | null;
  graphifyBin: string;
  engine: CodegraphEngine;
  /** Per-run graphify timeout (ms). */
  runTimeoutMs: number;
  /** Enable the debounced recursive fs.watch accelerator (default true). */
  watch?: boolean;
  /**
   * Shared memory store, for the Option-A integration (auto note per scope +
   * hub note). OPTIONAL — when absent (memory off), note maintenance is skipped
   * and indexing is unaffected.
   */
  memory?: MemoryStore | null;
}

export interface CodegraphJanitorHandle {
  stop(): void;
  /** Exposed for tests / manual triggers: run exactly one sweep to completion. */
  sweepNow(): Promise<void>;
}

/** Debounce window before a watch event triggers an out-of-band sweep. */
const WATCH_DEBOUNCE_MS = 3000;

export function startCodegraphJanitor(
  deps: CodegraphJanitorDeps,
  opts: { intervalMs: number },
): CodegraphJanitorHandle {
  const { intervalMs } = opts;
  const useWatch = deps.watch ?? true;

  if (intervalMs <= 0) {
    log.info({ event: 'codegraph.janitor_disabled', intervalMs });
    return { stop: () => undefined, sweepNow: async () => undefined };
  }

  // Per-scope run lock + whole-sweep reentrancy guard: a sweep may take longer
  // than one interval (a big rebuild), and the watch accelerator can fire mid-
  // sweep — neither may start an overlapping run.
  const running = new Set<string>();
  let sweepInFlight = false;
  let stopped = false;
  const watchers = new Map<string, fs.FSWatcher>();
  let debounceTimer: NodeJS.Timeout | null = null;
  // Option-A memory integration (no-op when memory is absent).
  const notes = new CodegraphMemoryNotes(deps.memory ?? null, deps.store);

  /** Index one scope if its source changed. Never throws. */
  async function maybeIndex(discovered: DiscoveredScope): Promise<void> {
    const scopeId = discovered.id;
    if (running.has(scopeId)) return;
    const scope = deps.store.getScope(scopeId);
    if (!scope || !scope.enabled) return;

    // The root scope excludes its child project-scope dirs from BOTH the
    // change-detection fingerprint and the graph (see discovery extraExcludes).
    const excludes = discovered.extraExcludes.length
      ? new Set(discovered.extraExcludes)
      : undefined;

    let fp: { fileCount: number; hash: string };
    try {
      fp = sourceFingerprint(scope.path, excludes);
    } catch (err) {
      log.warn({ event: 'codegraph.fingerprint_failed', scopeId, error: String(err) });
      return;
    }

    // Unchanged since last successful index → skip (the guard that avoids the
    // expensive blind re-run). `lastSourceHash` is only set on success, so an
    // errored or never-indexed scope always has a mismatching (null) hash.
    if (scope.lastSourceHash === fp.hash) return;

    running.add(scopeId);
    deps.store.setStatus(scopeId, 'indexing');
    try {
      const result = await runUpdate({
        bin: deps.graphifyBin,
        sourceDir: scope.path,
        indexDir: deps.store.indexDirFor(scopeId),
        engine: deps.engine,
        timeoutMs: deps.runTimeoutMs,
        extraExcludes: discovered.extraExcludes,
      });
      if (result.ok) {
        deps.store.recordIndexResult(scopeId, {
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          sourceHash: fp.hash,
        });
        // Option A: refresh this scope's memory note (best-effort, never throws).
        notes.syncScope(scopeId);
        log.info({
          event: 'codegraph.indexed',
          scopeId,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          files: fp.fileCount,
        });
      } else {
        deps.store.setStatus(scopeId, 'error', result.error);
      }
    } catch (err) {
      // runUpdate is designed not to throw, but belt-and-braces.
      deps.store.setStatus(scopeId, 'error', err instanceof Error ? err.message : String(err));
    } finally {
      running.delete(scopeId);
    }
  }

  async function sweep(): Promise<void> {
    if (sweepInFlight || stopped) return;
    sweepInFlight = true;
    try {
      const discovered = discoverScopes({
        workspaceRoot: deps.workspaceRoot,
        dataDir: deps.dataDir,
        pluginStore: deps.pluginStore ?? null,
      });
      const discoveredIds = new Set(discovered.map((s) => s.id));

      // Reconcile: upsert descriptors, flip the C3 gate. A scope that lost its
      // code (gate now false) drops its memory note.
      for (const s of discovered) {
        deps.store.upsertScope({ id: s.id, kind: s.kind, path: s.path, enabled: s.hasCode });
        deps.store.setEnabled(s.id, s.hasCode);
        if (!s.hasCode) notes.removeScope(s.id);
      }
      // Prune scopes that vanished from the workspace/plugin set (+ their notes).
      for (const existing of deps.store.listScopes()) {
        if (!discoveredIds.has(existing.id)) {
          deps.store.removeScope(existing.id);
          notes.removeScope(existing.id);
        }
      }

      if (useWatch) ensureWatchers(discovered.filter((s) => s.hasCode).map((s) => s.id));

      // Index changed scopes, serialised to bound CPU.
      for (const s of discovered) {
        if (stopped) break;
        if (!s.hasCode) continue;
        await maybeIndex(s);
      }

      // Refresh the hub note once per sweep (idempotent — writes only on change).
      notes.refreshHub();
    } catch (err) {
      log.warn({ event: 'codegraph.sweep_failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      sweepInFlight = false;
    }
  }

  function scheduleDebouncedSweep(): void {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void sweep();
    }, WATCH_DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  function ensureWatchers(enabledScopeIds: string[]): void {
    const wanted = new Set(enabledScopeIds);
    // Drop watchers for scopes no longer enabled/present.
    for (const [id, w] of watchers) {
      if (!wanted.has(id)) {
        try {
          w.close();
        } catch {
          /* best-effort */
        }
        watchers.delete(id);
      }
    }
    // Add watchers for newly-enabled scopes.
    for (const id of wanted) {
      if (watchers.has(id)) continue;
      const scope = deps.store.getScope(id);
      if (!scope) continue;
      try {
        const w = fs.watch(scope.path, { recursive: true }, () => scheduleDebouncedSweep());
        w.on('error', (err) => {
          log.debug({ event: 'codegraph.watch_error', id, error: String(err) });
        });
        w.unref?.();
        watchers.set(id, w);
      } catch (err) {
        // Recursive fs.watch may be unsupported on some FS — fall back silently
        // to the periodic sweep (the source of truth).
        log.debug({ event: 'codegraph.watch_unavailable', id, error: String(err) });
      }
    }
  }

  // Fire one sweep immediately (catch changes stranded by a previous boot), then
  // every interval.
  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();
  log.info({ event: 'codegraph.janitor_started', intervalMs, watch: useWatch });

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const w of watchers.values()) {
        try {
          w.close();
        } catch {
          /* best-effort */
        }
      }
      watchers.clear();
    },
    sweepNow: sweep,
  };
}
