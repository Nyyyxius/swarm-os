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
 * An OPTIONAL filesystem watcher on each enabled scope just schedules a
 * debounced out-of-band sweep so edits are picked up in seconds rather than at
 * the next interval — the janitor remains the source of truth; the watcher only
 * accelerates it, and any watch failure is swallowed.
 *
 * That watcher used to be a single `fs.watch(scope.path, { recursive: true })`.
 * On Linux that expands to ONE inotify watch per directory of the tree and
 * accepts no exclusions — so it watched every directory the scan deliberately
 * ignores. Measured on a real deployment (`stiix`, workspace `~/projets/fyrel`):
 * 21 518 directories, of which 19 415 (90 %) were `node_modules`, 1 394 (6,5 %)
 * `.git` internals and only 709 (3,3 %) actual code. With ~8 scopes over that
 * tree the server process held **165 502 inotify watches — 89 % of the host's
 * `fs.inotify.max_user_watches` (184 930)**, of which ~5 700 were useful. The
 * fallout was not theoretical: a SECOND swarm-os instance on the same host
 * (`trader`) could no longer arm the watcher behind its trading kill-switch
 * (`ENOSPC: System limit for number of file watchers reached`) — a safety
 * mechanism taken down by an unrelated redeploy.
 *
 * So the watcher is now EXPLICIT and BOUNDED: we walk the scope ourselves with
 * the same exclusion predicate as the scan (`shouldSkipDir`), place one
 * NON-recursive `fs.watch` per retained directory, and refuse to go past a hard
 * ceiling (see `MAX_WATCHES_PER_SCOPE` / `MAX_WATCHES_TOTAL`), loudly, rather
 * than quietly draining the host. The global ceiling is shared out with a
 * guaranteed per-scope floor (`MIN_WATCHES_PER_SCOPE`) so that bounding the
 * total can never leave one scope with no watcher at all.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { MemoryStore } from '../memory/store.js';
import type { GraphStore } from './store.js';
import type { PluginLister, DiscoveredScope } from './discovery.js';
import { discoverScopes } from './discovery.js';
import { sourceFingerprint } from './scan.js';
import { shouldSkipDir } from './ignore.js';
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
  /** Enable the debounced, bounded fs.watch accelerator (default true). */
  watch?: boolean;
  /**
   * TEST SEAM ONLY — override the watch ceilings. Production leaves this
   * undefined and gets `MAX_WATCHES_PER_SCOPE` / `MAX_WATCHES_TOTAL`; the tests
   * lower them so proving the guard fires does not require materialising 2 000
   * real directories (nor 2 000 real inotify watches on the test host, which is
   * precisely the resource this change exists to protect).
   */
  watchCaps?: { perScope?: number; total?: number };
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

/**
 * Hard ceiling on the directory watches ONE scope may hold.
 *
 * DO NOT remove this as "defensive noise". A previous version of this file had
 * no ceiling at all (it delegated the walk to `fs.watch({recursive:true})`) and
 * a single deployment ended up holding 165 502 inotify watches — 89 % of the
 * host budget — for ~5 700 useful directories, which cost a sibling instance
 * the watcher behind its trading kill-switch (`ENOSPC`). Exclusions alone are
 * not a guarantee: they depend on a tree looking the way we expect. This
 * ceiling is the guarantee — whatever the tree looks like, one instance cannot
 * drain the host's watch budget again.
 *
 * 2 000 is far above any first-party source tree we have measured (709 code
 * directories in the workspace above), so hitting it means the tree is unusual,
 * which is exactly when we want a log line rather than silent consumption.
 */
const MAX_WATCHES_PER_SCOPE = 2000;

/**
 * Hard ceiling on the watches held by this janitor across ALL scopes. Per-scope
 * capping alone is not enough: the failure above came from ~8 scopes each
 * watching the same oversized tree, and a workspace with 50 projects would
 * multiply the per-scope ceiling by 50. 8 000 comfortably covers the ~5 700
 * genuinely useful directories measured on the busiest real workspace while
 * staying a small fraction of a default host budget — i.e. sibling processes
 * (and other users of inotify on the box) keep room to breathe.
 */
const MAX_WATCHES_TOTAL = 8000;

/**
 * Watches GUARANTEED to every enabled scope before any scope may take a second
 * helping of `MAX_WATCHES_TOTAL`.
 *
 * This exists because bounding the total is not enough — how you SHARE it is
 * itself a failure mode. The first version of this budget was a plain greedy
 * hand-out in scope-id order (`limit = min(maxPerScope, remaining)`): four
 * scopes at the per-scope ceiling zeroed `remaining`, and the fifth got
 * `limit = 0` — which does not mean "watch a bit less", it means
 * `collectWatchDirs` returns an EMPTY set, and the reconciliation below then
 * closes the watchers that scope already held. Not even its own root directory
 * survived, and the outcome was stable sweep after sweep: an alphabetically
 * unlucky scope silently lost its ~3 s accelerator and fell back to the 3-minute
 * janitor interval until the next redeploy. Silent per-scope degradation is
 * precisely what this module exists to prevent.
 *
 * 64 is sized off the same measurement as the ceilings: the busiest real
 * workspace held ~709 code directories over ~8 scopes (~89 each), so 64 covers
 * the shallow structure of a typical project — the levels where edits and new
 * sub-trees actually appear — while 8000/64 = 125 scopes can all be floored
 * before the global ceiling is even contended. It is a FLOOR, not a target: a
 * scope wanting more gets more from the leftover pass, in stable order.
 */
const MIN_WATCHES_PER_SCOPE = 64;

/**
 * How often a scope stuck at the ceiling repeats its warning. Once at boot
 * would be invisible to anyone reading logs of a 24/7 process a week later;
 * every sweep would be spam. Truncated coverage must stay VISIBLE — a watcher
 * that silently covers half the tree while presenting itself as complete is the
 * exact trap this module is meant to avoid.
 */
const WATCH_CAP_WARN_INTERVAL_MS = 15 * 60_000;

/**
 * Collect the directories a scope should watch, breadth-first from `root`,
 * stopping at `limit`.
 *
 * Breadth-first is deliberate: when the ceiling truncates the walk, we keep the
 * SHALLOW directories — the ones nearest the scope root, where edits and new
 * sub-trees actually show up — instead of an arbitrary deep branch.
 *
 * The skip rules mirror `scan.ts`'s walk exactly — same predicates, same order,
 * on purpose: a directory the fingerprint never reads is a directory whose
 * events could never change the outcome of a sweep, so watching it is pure waste
 * (that waste WAS the bug).
 *   - `extraExcludes` first → the workspace-root scope skips its child
 *     project-scope dirs, which have their own scope (and therefore their own
 *     watchers); without this the root scope alone would double every watch.
 *     It goes first because it is a Set lookup, while `shouldSkipDir` may pay an
 *     `existsSync` — the outcome is identical either way, only the cost differs;
 *   - `shouldSkipDir` → dependency / build / VCS dirs + virtualenvs;
 *   - symlinks are never followed (they can escape the scope or form cycles).
 *
 * Best-effort and never throws: an unreadable directory is simply not watched.
 */
function collectWatchDirs(
  root: string,
  limit: number,
  extraExcludes?: ReadonlySet<string>,
): { dirs: string[]; capped: boolean } {
  const dirs: string[] = [];
  if (limit <= 0) return { dirs, capped: true };
  const queue: string[] = [root];
  let head = 0;
  while (head < queue.length) {
    // Items still queued while the ceiling is reached ⇒ coverage is truncated.
    if (dirs.length >= limit) return { dirs, capped: true };
    const dir = queue[head++] as string;
    dirs.push(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
      if (extraExcludes?.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (shouldSkipDir(full, ent.name)) continue;
      queue.push(full);
    }
  }
  return { dirs, capped: false };
}

/** One scope's share of the watch budget, decided before anything is armed. */
interface WatchPlan {
  scope: DiscoveredScope;
  excludes: ReadonlySet<string> | undefined;
  dirs: string[];
  /** The limit that produced `dirs`; compared to `maxPerScope` it names the cause. */
  limit: number;
  /** `true` ⇒ the walk still had queued directories when it hit `limit`. */
  truncated: boolean;
}

/** Why a scope's coverage is truncated — the two causes need different fixes. */
type WatchCapReason = 'per-scope' | 'global-budget';

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
  /**
   * scopeId → (absolute directory → its NON-recursive watcher).
   *
   * Keying the inner map by directory is what makes the refactor leak-proof:
   * `ensureWatchers` re-derives the wanted directory set on every sweep and
   * reconciles against this map (close+delete what left, add only what is
   * missing), so a scope that is re-scanned forever can never accumulate a
   * second watcher for a directory it already watches. Nothing else in this
   * module calls `fs.watch`, and nothing else inserts into these maps.
   */
  const watchers = new Map<string, Map<string, fs.FSWatcher>>();
  /** scopeId → last time we warned it is stuck at the watch ceiling. */
  const capWarnedAt = new Map<string, number>();
  const maxPerScope = deps.watchCaps?.perScope ?? MAX_WATCHES_PER_SCOPE;
  const maxTotal = deps.watchCaps?.total ?? MAX_WATCHES_TOTAL;
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

      // Watch only what we index, and pass the whole descriptor: the walk needs
      // `extraExcludes` (the root scope must not re-watch its child scopes' dirs).
      if (useWatch) ensureWatchers(discovered.filter((s) => s.hasCode));

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

  /** Close one watcher, swallowing everything (a dead watcher may throw). */
  function closeWatcher(w: fs.FSWatcher): void {
    try {
      w.close();
    } catch {
      /* best-effort */
    }
  }

  /** Close and forget every watcher of one scope. */
  function closeScopeWatchers(byDir: Map<string, fs.FSWatcher>): void {
    for (const w of byDir.values()) closeWatcher(w);
    byDir.clear();
  }

  /**
   * Warn — at most every WATCH_CAP_WARN_INTERVAL_MS — that coverage is truncated.
   *
   * `reason` is not decoration. The two causes are diagnosed and fixed
   * differently, and `limit` alone cannot tell them apart (a scope squeezed by
   * the global budget reports a small limit it never asked for):
   *   - `per-scope`     → THIS tree is unusually large; look at the tree, or
   *                       raise MAX_WATCHES_PER_SCOPE.
   *   - `global-budget` → a SIBLING scope ate the shared budget; the reported
   *                       `remaining`/`maxTotal` are the numbers to act on.
   */
  function warnWatchCapped(
    scope: DiscoveredScope,
    info: { limit: number; watched: number; reason: WatchCapReason; remaining: number },
  ): void {
    const now = Date.now();
    const last = capWarnedAt.get(scope.id) ?? 0;
    if (now - last < WATCH_CAP_WARN_INTERVAL_MS) return;
    capWarnedAt.set(scope.id, now);
    log.warn({
      event: 'codegraph.watch_capped',
      scopeId: scope.id,
      path: scope.path,
      limit: info.limit,
      watched: info.watched,
      reason: info.reason,
      maxPerScope,
      maxTotal,
      remaining: info.remaining,
      note:
        info.reason === 'per-scope'
          ? 'per-scope directory watch ceiling reached — the rest of THIS tree is ' +
            'NOT watched. Changes there are still indexed by the periodic janitor ' +
            'sweep (the source of truth); only the seconds-latency accelerator is ' +
            'missing for them. The ceiling exists so one instance can never exhaust ' +
            'the host inotify budget.'
          : 'shared watch budget exhausted by sibling scopes — the rest of this tree ' +
            'is NOT watched (this scope still holds its guaranteed floor, never zero). ' +
            'Changes there are still indexed by the periodic janitor sweep (the source ' +
            'of truth); only the seconds-latency accelerator is missing for them. Look ' +
            'at the OTHER scopes: one of them is large enough to eat the global budget.',
    });
  }

  /**
   * Reconcile the watcher set with the currently enabled scopes.
   *
   * Called on EVERY sweep, which is also how the watched tree keeps up with new
   * directories: a non-recursive watch on a directory does report the creation
   * of a child, the handler schedules the debounced sweep, and that sweep comes
   * back through here and arms the newcomer. So a new directory is watched about
   * one debounce window (~3 s) after it appears — and any file created inside it
   * meanwhile is picked up regardless, because the sweep's fingerprint walks the
   * tree itself. No extra machinery: this watcher is a best-effort accelerator,
   * the janitor stays the source of truth.
   */
  function ensureWatchers(scopes: DiscoveredScope[]): void {
    // Belt-and-braces: never re-arm a watcher after stop() emptied the maps.
    if (stopped) return;

    // Sorted so the global budget is handed out in a stable order — the same
    // scopes keep the same share sweep after sweep instead of thrashing
    // (closing and re-opening watchers) because readdir order moved.
    const ordered = [...scopes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const wanted = new Set(ordered.map((s) => s.id));

    // Drop watchers for scopes no longer enabled/present.
    for (const [id, byDir] of watchers) {
      if (!wanted.has(id)) {
        closeScopeWatchers(byDir);
        watchers.delete(id);
        capWarnedAt.delete(id);
      }
    }

    if (ordered.length === 0) return;

    // --- Share out the global budget, floor first ---------------------------
    // Two passes, and the FIRST one is the whole point. A single greedy pass in
    // id order gives the early scopes everything and hands `limit = 0` to the
    // rest — which is not "watch less", it is "watch nothing, and close what you
    // already had" (see MIN_WATCHES_PER_SCOPE for the incident shape). So:
    //   pass 1 — every scope gets its floor, no matter who its neighbours are;
    //   pass 2 — the leftover goes to the scopes the floor truncated, in the
    //            same stable id order.
    // A scope's share can still shrink because of a large sibling; it can never
    // reach zero. Stable order matters as much as fairness here: an allocation
    // that moved between sweeps would close and re-open watchers for nothing.
    const floor = Math.min(MIN_WATCHES_PER_SCOPE, maxPerScope, Math.floor(maxTotal / ordered.length));
    // …but never below 1: the scope root is what makes the accelerator exist at
    // all (it is the directory that reports new top-level sub-trees). Only a
    // workspace with MORE scopes than the total budget can push the floor here,
    // and there the hard ceiling deliberately wins — that is a physical
    // shortage, not a neighbour taking someone else's share.
    const perScopeFloor = Math.max(1, floor);

    let remaining = maxTotal;
    const plans: WatchPlan[] = [];
    for (const scope of ordered) {
      const excludes = scope.extraExcludes.length ? new Set(scope.extraExcludes) : undefined;
      const limit = Math.min(perScopeFloor, remaining);
      const { dirs, capped } = collectWatchDirs(scope.path, limit, excludes);
      // Charge the PLAN, not what we end up holding: a plan is an upper bound of
      // the descriptors this scope will own, so the total can only come in under
      // `maxTotal`, never over. (Arming can fail — ENOSPC, exotic filesystems.)
      remaining -= dirs.length;
      plans.push({ scope, excludes, dirs, limit, truncated: capped });
    }
    for (const plan of plans) {
      if (remaining <= 0) break;
      if (!plan.truncated) continue;
      const limit = Math.min(maxPerScope, plan.dirs.length + remaining);
      if (limit <= plan.dirs.length) continue; // already at its own ceiling
      // Re-walking is cheap and only happens for scopes the floor truncated: the
      // walk is deterministic and breadth-first, so the second pass re-derives
      // the same prefix and simply continues past it. The alternative — a
      // resumable walk carrying its queue between passes — buys a handful of
      // readdirs at the price of a stateful walker in the module whose bugs cost
      // us a trading kill-switch.
      const { dirs, capped } = collectWatchDirs(plan.scope.path, limit, plan.excludes);
      remaining -= dirs.length - plan.dirs.length;
      plan.dirs = dirs;
      plan.limit = limit;
      plan.truncated = capped;
    }

    // --- Reconcile each scope against its plan ------------------------------
    for (const plan of plans) {
      const scope = plan.scope;
      const byDir = watchers.get(scope.id) ?? new Map<string, fs.FSWatcher>();
      watchers.set(scope.id, byDir);

      const dirs = plan.dirs;
      const want = new Set(dirs);

      // 1. Release watchers whose directory vanished, became ignored, or fell
      //    outside the ceiling. This is the half that prevents the leak.
      for (const [dir, w] of byDir) {
        if (!want.has(dir)) {
          closeWatcher(w);
          byDir.delete(dir);
        }
      }
      // 2. Arm only the directories not already watched.
      for (const dir of dirs) {
        if (byDir.has(dir)) continue;
        try {
          const w = fs.watch(dir, { recursive: false }, () => scheduleDebouncedSweep());
          w.on('error', (err) => {
            log.debug({ event: 'codegraph.watch_error', scopeId: scope.id, dir, error: String(err) });
            // An errored watcher is dead: close it and forget it so the next
            // sweep can re-arm the directory. Guarded by an identity check —
            // a later sweep may already have installed a replacement, and
            // dropping THAT one from the map would leak it.
            closeWatcher(w);
            const current = watchers.get(scope.id);
            if (current?.get(dir) === w) current.delete(dir);
          });
          w.unref?.();
          byDir.set(dir, w);
        } catch (err) {
          // fs.watch may be unsupported on some filesystems, or the host may be
          // out of watch descriptors — fall back silently to the periodic sweep
          // (the source of truth), per this module's "any watch failure is
          // swallowed" contract.
          log.debug({ event: 'codegraph.watch_unavailable', scopeId: scope.id, dir, error: String(err) });
          // ENOSPC means the host inotify budget is gone: retrying for every
          // remaining directory would just burn syscalls. Stop here, the next
          // sweep will try again (and by then we may be the ones who freed
          // descriptors, so this is not sticky).
          if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') break;
        }
      }

      if (plan.truncated) {
        // `limit === maxPerScope` ⇒ the scope hit ITS OWN ceiling; anything
        // lower is a limit the shared budget imposed on it.
        warnWatchCapped(scope, {
          limit: plan.limit,
          watched: byDir.size,
          reason: plan.limit >= maxPerScope ? 'per-scope' : 'global-budget',
          remaining,
        });
      } else {
        capWarnedAt.delete(scope.id); // back under the ceiling → re-warn if it returns
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
      // `stopped` is set FIRST: it gates sweep() and ensureWatchers(), so no
      // watcher can be armed after this point — the maps we clear below are the
      // last ones that will ever exist for this janitor.
      stopped = true;
      clearInterval(timer);
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const byDir of watchers.values()) closeScopeWatchers(byDir);
      watchers.clear();
      capWarnedAt.clear();
    },
    sweepNow: sweep,
  };
}
