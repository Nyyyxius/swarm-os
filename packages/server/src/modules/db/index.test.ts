import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb, type OrchestratorRow, type SessionRow } from './index.js';

/**
 * Phase 7 — SwarmDb round-trips and boot-recovery.
 *
 * The module mostly forwards to better-sqlite3; we test the contracts that
 * actually matter to the rest of the system (upsert idempotency, recovery
 * sweep, indexes present).
 */

let tmpRoot: string;
let db: SwarmDb;

function makeOrchRow(over: Partial<OrchestratorRow> = {}): OrchestratorRow {
  return {
    id: 'orch-1',
    name: 'merge-team',
    role: 'coordinator',
    role_id: null,
    status: 'running',
    lead_session_id: null,
    default_model: 'claude-opus-4-7',
    default_effort: 'xhigh',
    default_permission_mode: 'bypassPermissions',
    lead_preamble: null,
    worker_preamble: null,
    created_at: new Date().toISOString(),
    ended_at: null,
    hidden_at: null,
    last_error: null,
    stop_reason: null,
    // Phase 8 — auto-resume audit. Defaults to "never resumed".
    last_resumed_at: null,
    resume_count: 0,
    ...over,
  };
}

function makeSessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    orchestrator_id: 'orch-1',
    name: 'merge-team-lead',
    role: 'coordinator',
    type: 'lead',
    cwd: '/workspace/x',
    initial_prompt: 'do the thing',
    model: 'claude-opus-4-7',
    effort: 'xhigh',
    permission_mode: 'bypassPermissions',
    status: 'running',
    pid: 1234,
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    last_error: null,
    stop_reason: null,
    log_path: '/data/logs/orch-1/sess-1.log',
    last_activity_at: new Date().toISOString(),
    hidden_at: null,
    ...over,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-db-'));
  db = new SwarmDb(tmpRoot);
});

afterEach(() => {
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('SwarmDb construction', () => {
  it('opens a swarm-os.db file in the data dir', () => {
    expect(fs.existsSync(path.join(tmpRoot, 'swarm-os.db'))).toBe(true);
  });

  it('applies schema with the documented indexes', () => {
    const orchIndexes = db.db
      .prepare<[], { name: string }>('SELECT name FROM sqlite_master WHERE type=? AND tbl_name=?')
      .all('index', 'orchestrators');
    const sessionIndexes = db.db
      .prepare<[], { name: string }>('SELECT name FROM sqlite_master WHERE type=? AND tbl_name=?')
      .all('index', 'sessions');
    const orchNames = orchIndexes.map((r) => r.name);
    const sessNames = sessionIndexes.map((r) => r.name);
    expect(orchNames).toEqual(expect.arrayContaining(['idx_orchestrators_status']));
    expect(sessNames).toEqual(
      expect.arrayContaining(['idx_sessions_orch', 'idx_sessions_status']),
    );
  });
});

describe('upsertOrchestrator + getOrchestrator', () => {
  it('round-trips a fresh row', () => {
    const row = makeOrchRow();
    db.upsertOrchestrator(row);
    expect(db.getOrchestrator('orch-1')).toEqual(row);
  });

  it('upsert overwrites mutable fields on conflict', () => {
    db.upsertOrchestrator(makeOrchRow());
    db.upsertOrchestrator(makeOrchRow({ status: 'stopped', ended_at: '2030-01-01T00:00:00Z' }));
    const got = db.getOrchestrator('orch-1');
    expect(got?.status).toBe('stopped');
    expect(got?.ended_at).toBe('2030-01-01T00:00:00Z');
  });
});

describe('upsertSession + listSessions', () => {
  it('round-trips a session row scoped to an orchestrator', () => {
    db.upsertOrchestrator(makeOrchRow());
    db.upsertSession(makeSessionRow());
    const list = db.listSessions('orch-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('sess-1');
  });

  it('returns [] for an orchestrator with no sessions', () => {
    db.upsertOrchestrator(makeOrchRow({ id: 'orch-empty' }));
    expect(db.listSessions('orch-empty')).toEqual([]);
  });
});

describe('markAllNonTerminalAsInterrupted', () => {
  it('flips running orchestrators to failed and running sessions to interrupted', () => {
    db.upsertOrchestrator(makeOrchRow({ id: 'orch-live', status: 'running' }));
    db.upsertOrchestrator(
      makeOrchRow({ id: 'orch-old', status: 'stopped', ended_at: '2030-01-01T00:00:00Z' }),
    );
    db.upsertSession(makeSessionRow({ id: 'sess-live', orchestrator_id: 'orch-live' }));
    db.upsertSession(makeSessionRow({ id: 'sess-old', orchestrator_id: 'orch-old', status: 'exited' }));
    const r = db.markAllNonTerminalAsInterrupted();
    expect(r.orchestrators).toBe(1);
    expect(r.sessions).toBe(1);
    expect(db.getOrchestrator('orch-live')?.status).toBe('failed');
    expect(db.getOrchestrator('orch-live')?.stop_reason).toBe('server-restart');
    expect(db.listSessions('orch-live')[0]?.status).toBe('interrupted');
    // Already-terminal rows are untouched.
    expect(db.getOrchestrator('orch-old')?.status).toBe('stopped');
    expect(db.listSessions('orch-old')[0]?.status).toBe('exited');
  });

  it('is a no-op when nothing is non-terminal', () => {
    db.upsertOrchestrator(makeOrchRow({ status: 'stopped' }));
    db.upsertSession(makeSessionRow({ status: 'killed' }));
    const r = db.markAllNonTerminalAsInterrupted();
    expect(r.orchestrators).toBe(0);
    expect(r.sessions).toBe(0);
  });
});

describe('listRecentlyTerminatedOrchestrators', () => {
  it('returns only stopped/failed orchestrators ordered by ended_at desc', () => {
    db.upsertOrchestrator(makeOrchRow({ id: 'a', status: 'running' }));
    db.upsertOrchestrator(makeOrchRow({ id: 'b', status: 'stopped', ended_at: '2030-01-02T00:00:00Z' }));
    db.upsertOrchestrator(makeOrchRow({ id: 'c', status: 'failed', ended_at: '2030-01-03T00:00:00Z' }));
    const out = db.listRecentlyTerminatedOrchestrators(10);
    expect(out.map((r) => r.id)).toEqual(['c', 'b']);
  });
});
