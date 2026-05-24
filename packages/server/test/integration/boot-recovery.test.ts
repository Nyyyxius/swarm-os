/**
 * Phase 7 — boot recovery sweep.
 *
 * Writes a non-terminal session row directly into a fresh SQLite DB, then
 * simulates a server restart by constructing a fresh `SwarmDb` +
 * `DbPersistence` against the same path and calling `recoverFromCrash`.
 *
 * Asserts the row flips to status=interrupted with stop_reason=server-restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../../src/modules/db/index.js';
import { DbPersistence } from '../../src/modules/orchestrator/persistence.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-recover-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Boot recovery', () => {
  it('marks all non-terminal rows as interrupted on a fresh boot', () => {
    // Boot 1: write a "live" orchestrator + session into the DB.
    const db1 = new SwarmDb(tmpRoot);
    db1.upsertOrchestrator({
      id: 'orch-live',
      name: 'merge',
      role: 'co',
      role_id: null,
      status: 'running',
      lead_session_id: 'sess-live',
      default_model: 'm',
      default_effort: 'low',
      default_permission_mode: 'bypassPermissions',
      lead_preamble: null,
      worker_preamble: null,
      created_at: new Date().toISOString(),
      ended_at: null,
      hidden_at: null,
      last_error: null,
      stop_reason: null,
    });
    db1.upsertSession({
      id: 'sess-live',
      orchestrator_id: 'orch-live',
      name: 'lead',
      role: 'r',
      type: 'lead',
      cwd: '/workspace/x',
      initial_prompt: 'do',
      model: 'm',
      effort: 'low',
      permission_mode: 'bypassPermissions',
      status: 'running',
      pid: 1234,
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      last_error: null,
      stop_reason: null,
      log_path: '/tmp/x.log',
      last_activity_at: new Date().toISOString(),
      hidden_at: null,
    });
    db1.close();

    // Boot 2: simulate a fresh server start, sweep stale rows.
    const db2 = new SwarmDb(tmpRoot);
    const persistence = new DbPersistence(db2);
    const result = persistence.recoverFromCrash();
    expect(result.orchestrators).toBe(1);
    expect(result.sessions).toBe(1);
    expect(db2.getOrchestrator('orch-live')?.status).toBe('failed');
    expect(db2.getOrchestrator('orch-live')?.stop_reason).toBe('server-restart');
    expect(db2.listSessions('orch-live')[0]?.status).toBe('interrupted');
    expect(db2.listSessions('orch-live')[0]?.stop_reason).toBe('server-restart');
    db2.close();
  });

  it('is a no-op when nothing is non-terminal', () => {
    const db1 = new SwarmDb(tmpRoot);
    db1.upsertOrchestrator({
      id: 'orch-old',
      name: 'old',
      role: 'r',
      role_id: null,
      status: 'stopped',
      lead_session_id: null,
      default_model: 'm',
      default_effort: 'low',
      default_permission_mode: 'bypassPermissions',
      lead_preamble: null,
      worker_preamble: null,
      created_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      hidden_at: null,
      last_error: null,
      stop_reason: 'user',
    });
    db1.close();

    const db2 = new SwarmDb(tmpRoot);
    const r = new DbPersistence(db2).recoverFromCrash();
    expect(r.orchestrators).toBe(0);
    expect(r.sessions).toBe(0);
    db2.close();
  });
});
