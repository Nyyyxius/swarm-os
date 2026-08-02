/**
 * GraphStore — the registry of code-knowledge-graph SCOPES, one row per
 * indexable unit (a workspace project or an installed plugin). GLOBAL to the
 * deployment, like MemoryStore.
 *
 * Storage model:
 *   - SOURCE OF TRUTH for the graph itself = graphify's `graphify-out/` under
 *     `<dataDir>/codegraph/<scopeId>/` (NetworkX `graph.json` + report + cache).
 *     We deliberately do NOT ingest the graph into SQLite (a monorepo = tens of
 *     thousands of nodes — see docs §4.4 / decision Q2 "Option A").
 *   - This table = just the bookkeeping the janitor needs: which scopes exist,
 *     whether they're enabled (C3 code gate), their last index status/counts and
 *     the source hash that drives change-detection.
 *
 * ⚠️ Like `memory/store.ts` and `plugins/store.ts`, this class OWNS its table
 * via `CREATE TABLE IF NOT EXISTS` on the raw `Database` handle (`SwarmDb.db`).
 * It touches NEITHER `schema.sql` NOR `INLINE_SCHEMA` — the inline fallback is
 * the path that runs in the Docker image (tsc doesn't copy `.sql`), so a double
 * source is a trap. Keeping the DDL here sidesteps it.
 *
 * Robustness: every method is wrapped in try/catch and logs on failure — a
 * broken write NEVER crashes the 24/7 server. `eventBus` is accepted but unused
 * in P1 (event emission is P3); the hook is here so P3 is purely additive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';
import type { SwarmEventBus } from '../../events.js';

const log = withModule('codegraph.store');

export type CodegraphScopeKind = 'project' | 'plugin';

/**
 * Lifecycle status of a scope's index:
 *   - `pending`   — discovered & enabled, never indexed yet.
 *   - `indexing`  — a graphify run is in flight.
 *   - `indexed`   — last run succeeded; counts + hash are current.
 *   - `error`     — last run failed; `lastError` carries why (never fatal).
 *   - `disabled`  — no code detected (C3) or turned off; skipped by the janitor.
 */
export type CodegraphScopeStatus = 'pending' | 'indexing' | 'indexed' | 'error' | 'disabled';

export interface CodegraphScope {
  id: string;
  kind: CodegraphScopeKind;
  path: string;
  enabled: boolean;
  status: CodegraphScopeStatus;
  nodeCount: number;
  edgeCount: number;
  /** Epoch millis of the last successful index, or null. */
  lastIndexedAt: number | null;
  /** Source fingerprint at the last index — drives change-detection. */
  lastSourceHash: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ScopeRow {
  id: string;
  kind: string;
  path: string;
  enabled: number;
  status: string;
  node_count: number;
  edge_count: number;
  last_indexed_at: number | null;
  last_source_hash: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToScope(r: ScopeRow): CodegraphScope {
  return {
    id: r.id,
    kind: (r.kind === 'plugin' ? 'plugin' : 'project') as CodegraphScopeKind,
    path: r.path,
    enabled: r.enabled !== 0,
    status: r.status as CodegraphScopeStatus,
    nodeCount: r.node_count,
    edgeCount: r.edge_count,
    lastIndexedAt: r.last_indexed_at,
    lastSourceHash: r.last_source_hash,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Fields discovery supplies when (re)registering a candidate scope. */
export interface UpsertScopeInput {
  id: string;
  kind: CodegraphScopeKind;
  path: string;
  enabled: boolean;
}

export class GraphStore {
  private readonly db: Db;
  private readonly indexRoot: string;
  private readonly eventBus: SwarmEventBus | null;

  private readonly getStmt;
  private readonly listStmt;
  private readonly insertStmt;
  private readonly updateDiscoveryStmt;
  private readonly setEnabledStmt;
  private readonly setStatusStmt;
  private readonly recordResultStmt;
  private readonly deleteStmt;

  constructor(swarmDb: SwarmDb, opts: { dataDir: string; eventBus?: SwarmEventBus }) {
    this.db = swarmDb.db;
    this.indexRoot = path.join(opts.dataDir, 'codegraph');
    this.eventBus = opts.eventBus ?? null;

    try {
      fs.mkdirSync(this.indexRoot, { recursive: true });
    } catch (err) {
      log.warn({ event: 'codegraph.index_root_mkdir_failed', error: String(err) });
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codegraph_scopes (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        path             TEXT NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        status           TEXT NOT NULL DEFAULT 'pending',
        node_count       INTEGER NOT NULL DEFAULT 0,
        edge_count       INTEGER NOT NULL DEFAULT 0,
        last_indexed_at  INTEGER,
        last_source_hash TEXT,
        last_error       TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_codegraph_scopes_enabled ON codegraph_scopes(enabled);
    `);

    this.getStmt = this.db.prepare<[string], ScopeRow>(
      'SELECT * FROM codegraph_scopes WHERE id = ?',
    );
    this.listStmt = this.db.prepare<[], ScopeRow>(
      'SELECT * FROM codegraph_scopes ORDER BY id ASC',
    );
    this.insertStmt = this.db.prepare<{
      id: string;
      kind: string;
      path: string;
      enabled: number;
      status: string;
      now: number;
    }>(`
      INSERT INTO codegraph_scopes (id, kind, path, enabled, status, created_at, updated_at)
      VALUES (@id, @kind, @path, @enabled, @status, @now, @now)
    `);
    // Re-discovery: refresh the mutable descriptor (kind/path) WITHOUT clobbering
    // index bookkeeping (counts, hash, status). Enable/disable go through the
    // dedicated statement so a gate flip is explicit.
    this.updateDiscoveryStmt = this.db.prepare<[string, string, number, string]>(
      'UPDATE codegraph_scopes SET kind = ?, path = ?, updated_at = ? WHERE id = ?',
    );
    this.setEnabledStmt = this.db.prepare<[number, string, number, string]>(
      'UPDATE codegraph_scopes SET enabled = ?, status = ?, updated_at = ? WHERE id = ?',
    );
    this.setStatusStmt = this.db.prepare<[string, string | null, number, string]>(
      'UPDATE codegraph_scopes SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
    );
    this.recordResultStmt = this.db.prepare<{
      node_count: number;
      edge_count: number;
      last_source_hash: string;
      last_indexed_at: number;
      updated_at: number;
      id: string;
    }>(`
      UPDATE codegraph_scopes SET
        node_count = @node_count,
        edge_count = @edge_count,
        last_source_hash = @last_source_hash,
        last_indexed_at = @last_indexed_at,
        status = 'indexed',
        last_error = NULL,
        updated_at = @updated_at
      WHERE id = @id
    `);
    this.deleteStmt = this.db.prepare<[string]>('DELETE FROM codegraph_scopes WHERE id = ?');
  }

  /** Absolute per-scope index root: `<dataDir>/codegraph/<scopeId>/`. */
  indexDirFor(id: string): string {
    return path.join(this.indexRoot, id);
  }

  listScopes(): CodegraphScope[] {
    try {
      return this.listStmt.all().map(rowToScope);
    } catch (err) {
      log.warn({ event: 'codegraph.read_failed', op: 'list', error: String(err) });
      return [];
    }
  }

  getScope(id: string): CodegraphScope | null {
    try {
      const row = this.getStmt.get(id);
      return row ? rowToScope(row) : null;
    } catch (err) {
      log.warn({ event: 'codegraph.read_failed', op: 'get', id, error: String(err) });
      return null;
    }
  }

  /**
   * Register or refresh a candidate scope. New rows are inserted with the given
   * enabled/status; existing rows only have their descriptor (kind/path)
   * refreshed here — enable/disable transitions go through `setEnabled` so they
   * are explicit and carry the right status. Returns the stored scope.
   */
  upsertScope(input: UpsertScopeInput): CodegraphScope | null {
    const now = Date.now();
    try {
      const existing = this.getStmt.get(input.id);
      if (!existing) {
        this.insertStmt.run({
          id: input.id,
          kind: input.kind,
          path: input.path,
          enabled: input.enabled ? 1 : 0,
          status: input.enabled ? 'pending' : 'disabled',
          now,
        });
      } else {
        this.updateDiscoveryStmt.run(input.kind, input.path, now, input.id);
      }
      return this.getScope(input.id);
    } catch (err) {
      log.warn({ event: 'codegraph.write_failed', op: 'upsert', id: input.id, error: String(err) });
      return null;
    }
  }

  /**
   * Flip a scope on/off. Disabling parks it at `disabled` (janitor skips it);
   * enabling resets it to `pending` ONLY if it was previously disabled, so an
   * already-`indexed` scope re-enabled by a no-op discovery keeps its state.
   */
  setEnabled(id: string, enabled: boolean): void {
    try {
      const current = this.getStmt.get(id);
      if (!current) return;
      const wasEnabled = current.enabled !== 0;
      if (wasEnabled === enabled) return; // no transition
      const status = enabled ? 'pending' : 'disabled';
      this.setEnabledStmt.run(enabled ? 1 : 0, status, Date.now(), id);
    } catch (err) {
      log.warn({ event: 'codegraph.write_failed', op: 'setEnabled', id, error: String(err) });
    }
  }

  setStatus(id: string, status: CodegraphScopeStatus, err?: string): void {
    try {
      this.setStatusStmt.run(status, err ?? null, Date.now(), id);
    } catch (e) {
      log.warn({ event: 'codegraph.write_failed', op: 'setStatus', id, error: String(e) });
    }
  }

  /** Stamp a successful index: counts + source hash + `indexed` status. */
  recordIndexResult(
    id: string,
    result: { nodeCount: number; edgeCount: number; sourceHash: string },
  ): void {
    const now = Date.now();
    try {
      this.recordResultStmt.run({
        node_count: result.nodeCount,
        edge_count: result.edgeCount,
        last_source_hash: result.sourceHash,
        last_indexed_at: now,
        updated_at: now,
        id,
      });
    } catch (err) {
      log.warn({ event: 'codegraph.write_failed', op: 'recordResult', id, error: String(err) });
    }
  }

  /** Remove a scope row (e.g. a project deleted from the workspace). */
  removeScope(id: string): void {
    try {
      this.deleteStmt.run(id);
    } catch (err) {
      log.warn({ event: 'codegraph.write_failed', op: 'remove', id, error: String(err) });
    }
  }

  /** Present for the P3 event-emission hook; unused in P1. */
  get events(): SwarmEventBus | null {
    return this.eventBus;
  }
}
