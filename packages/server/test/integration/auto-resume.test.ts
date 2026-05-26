/**
 * Phase 8 — auto-resume + persisted mailbox round-trips.
 *
 * Exercises the DB-only surface (no Spawner, no PTYs):
 *  - loadResumableState() partitions starting/running vs stopping vs terminal
 *  - the atomic guard flips rows to 'interrupted' BEFORE returning them
 *  - mailbox CRUD (insert, batch insert, mark delivered, GC, INSERT OR IGNORE)
 *  - markAllNonTerminalAsInterrupted leaves 'interrupted' rows alone
 *
 * Live PTY respawn is covered manually via the Docker verify step (§I).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SwarmDb,
  type OrchestratorRow,
  type SessionRow,
  type MailboxMessageRow,
} from '../../src/modules/db/index.js';
import { DbPersistence } from '../../src/modules/orchestrator/persistence.js';

let tmpRoot: string;
let db: SwarmDb;

function orchRow(over: Partial<OrchestratorRow> = {}): OrchestratorRow {
  return {
    id: 'orch-A',
    name: 'team-A',
    role: 'co',
    role_id: null,
    status: 'running',
    lead_session_id: 'sess-A',
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
    last_resumed_at: null,
    resume_count: 0,
    ...over,
  };
}

function sessRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-A',
    orchestrator_id: 'orch-A',
    name: 'A-lead',
    role: 'co',
    type: 'lead',
    cwd: '/w/x',
    initial_prompt: 'do thing',
    model: 'm',
    effort: 'low',
    permission_mode: 'bypassPermissions',
    status: 'running',
    pid: 100,
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    last_error: null,
    stop_reason: null,
    log_path: '/tmp/log',
    last_activity_at: new Date().toISOString(),
    hidden_at: null,
    ...over,
  };
}

function msgRow(over: Partial<MailboxMessageRow> = {}): MailboxMessageRow {
  return {
    id: 'msg-1',
    orchestrator_id: 'orch-A',
    to_session_id: 'sess-A',
    from_id: 'human',
    content: 'hello',
    ts: new Date().toISOString(),
    from_orchestrator_id: null,
    from_orchestrator_name: null,
    from_session_name: null,
    delivered_at: null,
    ...over,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-resume-'));
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

describe('loadResumableState (Phase 8 atomic guard)', () => {
  it('returns running orchs as resumable AND flips them to interrupted in-DB', () => {
    db.upsertOrchestrator(orchRow({ id: 'A', status: 'running', lead_session_id: 'sA' }));
    db.upsertSession(sessRow({ id: 'sA', orchestrator_id: 'A' }));

    const state = new DbPersistence(db).loadResumableState();

    // Returned for the spawner to rebuild.
    expect(state.resumable).toHaveLength(1);
    expect(state.resumable[0]?.orch.id).toBe('A');
    expect(state.resumable[0]?.sessions).toHaveLength(1);
    // CRUCIAL: row is already flipped to 'interrupted' on disk so a crash
    // mid-resume won't double-spawn.
    expect(db.getOrchestrator('A')?.status).toBe('interrupted');
    expect(db.getOrchestrator('A')?.stop_reason).toBe('resume-in-progress');
  });

  it('reaps stopping orchs as failed (not resumable)', () => {
    db.upsertOrchestrator(orchRow({ id: 'B', status: 'stopping' }));
    const state = new DbPersistence(db).loadResumableState();
    expect(state.resumable).toHaveLength(0);
    expect(state.reaped.orchestrators).toBe(1);
    expect(db.getOrchestrator('B')?.status).toBe('interrupted');
    expect(db.getOrchestrator('B')?.stop_reason).toBe('server-restart-during-stop');
  });

  it('ignores terminal orchs and hidden orchs', () => {
    db.upsertOrchestrator(orchRow({ id: 'C', status: 'stopped' }));
    db.upsertOrchestrator(orchRow({ id: 'D', status: 'failed' }));
    // Hidden row — direct UPDATE to bypass the upsert ON CONFLICT.
    db.upsertOrchestrator(orchRow({ id: 'E', status: 'running' }));
    db.hideOrchestrator('E');
    const state = new DbPersistence(db).loadResumableState();
    expect(state.resumable).toHaveLength(0);
  });

  it('legacy markAllNonTerminalAsInterrupted does not clobber atomic-guard rows', () => {
    db.upsertOrchestrator(orchRow({ id: 'F', status: 'running' }));
    new DbPersistence(db).loadResumableState();
    // Now 'F' is 'interrupted' with stop_reason='resume-in-progress'.
    // The legacy sweep should NOT change that.
    const r = db.markAllNonTerminalAsInterrupted();
    expect(r.orchestrators).toBe(0); // already interrupted, excluded
    expect(db.getOrchestrator('F')?.stop_reason).toBe('resume-in-progress');
  });
});

describe('mailbox_messages persistence', () => {
  it('round-trips insertMailboxMessage / selectPending / markDelivered', () => {
    db.upsertOrchestrator(orchRow({ id: 'X' }));
    db.upsertSession(sessRow({ id: 'sX', orchestrator_id: 'X' }));
    db.insertMailboxMessage(msgRow({ id: 'm1', orchestrator_id: 'X', to_session_id: 'sX' }));
    db.insertMailboxMessage(msgRow({ id: 'm2', orchestrator_id: 'X', to_session_id: 'sX' }));

    const pending = db.selectPendingMailboxMessagesForOrch('X');
    expect(pending.map((r) => r.id).sort()).toEqual(['m1', 'm2']);

    db.markMailboxMessagesDelivered(['m1']);
    const stillPending = db.selectPendingMailboxMessagesForOrch('X');
    expect(stillPending.map((r) => r.id)).toEqual(['m2']);
  });

  it('insertMailboxMessagesBatch wraps in a single transaction', () => {
    db.upsertOrchestrator(orchRow({ id: 'Y' }));
    const rows = Array.from({ length: 25 }, (_, i) =>
      msgRow({ id: `b-${i}`, orchestrator_id: 'Y' }),
    );
    db.insertMailboxMessagesBatch(rows);
    expect(db.selectPendingMailboxMessagesForOrch('Y')).toHaveLength(25);
  });

  it('insertMailboxMessageOrIgnore is idempotent on PK collision', () => {
    db.upsertOrchestrator(orchRow({ id: 'Z' }));
    db.insertMailboxMessage(msgRow({ id: 'dup', orchestrator_id: 'Z' }));
    // Second call would throw via insertMailboxMessage (PK collision logged),
    // but insertMailboxMessageOrIgnore must swallow silently.
    expect(() =>
      db.insertMailboxMessageOrIgnore(msgRow({ id: 'dup', orchestrator_id: 'Z' })),
    ).not.toThrow();
    expect(db.selectPendingMailboxMessagesForOrch('Z')).toHaveLength(1);
  });

  it('deleteOldDeliveredMailboxMessages GCs delivered rows past cutoff', () => {
    db.upsertOrchestrator(orchRow({ id: 'W' }));
    const old = '2020-01-01T00:00:00.000Z';
    const recent = new Date().toISOString();
    db.insertMailboxMessage(
      msgRow({ id: 'old-d', orchestrator_id: 'W', delivered_at: old }),
    );
    db.insertMailboxMessage(
      msgRow({ id: 'new-d', orchestrator_id: 'W', delivered_at: recent }),
    );
    db.insertMailboxMessage(
      msgRow({ id: 'pending', orchestrator_id: 'W', delivered_at: null }),
    );
    const cutoff = new Date(Date.now() - 86400 * 1000).toISOString();
    const n = db.deleteOldDeliveredMailboxMessages(cutoff);
    expect(n).toBe(1);
    // 'pending' (NULL delivered_at) and 'new-d' (post-cutoff) survive.
    const remaining = db.db
      .prepare<[], { id: string }>('SELECT id FROM mailbox_messages')
      .all()
      .map((r) => r.id);
    expect(remaining.sort()).toEqual(['new-d', 'pending']);
  });
});

describe('orchestrator audit columns survive round-trip', () => {
  it('persists last_resumed_at + resume_count via upsert', () => {
    const t = new Date().toISOString();
    db.upsertOrchestrator(orchRow({ id: 'O', last_resumed_at: t, resume_count: 3 }));
    const got = db.getOrchestrator('O');
    expect(got?.last_resumed_at).toBe(t);
    expect(got?.resume_count).toBe(3);
  });
});
