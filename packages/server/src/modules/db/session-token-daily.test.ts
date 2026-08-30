/**
 * Lot 15 — the SQL behind `GET /metrics/costs/export`.
 *
 * Two properties this query must never lose:
 *
 *  - it LEFT JOINs. `session_token_daily` is an accounting ledger and carries no
 *    foreign key on purpose: a row whose team or agent has been deleted keeps
 *    its spend and loses only its label. An inner join would silently drop the
 *    history of everything the fleet has churned through, which on a 24/7 swarm
 *    is most of it.
 *  - it is ORDERED and TOTALLY ordered — day, then team, then session id — so
 *    two exports of the same window are byte-identical and a diff between them
 *    means something.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb, type OrchestratorRow, type SessionRow, type SessionTokenDailyRow } from './index.js';

let tmpRoot: string;
let db: SwarmDb;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-daily-'));
  db = new SwarmDb(tmpRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeOrchRow(id: string, name: string): OrchestratorRow {
  return {
    id,
    name,
    role: 'coordinator',
    role_id: null,
    status: 'running',
    lead_session_id: null,
    default_model: 'claude-opus-5',
    default_effort: 'high',
    default_permission_mode: 'bypassPermissions',
    default_provider: 'claude',
    lead_preamble: null,
    worker_preamble: null,
    created_at: new Date().toISOString(),
    ended_at: null,
    hidden_at: null,
    last_error: null,
    stop_reason: null,
    last_resumed_at: null,
    resume_count: 0,
  };
}

function makeSessionRow(id: string, orchId: string, name: string): SessionRow {
  return {
    id,
    orchestrator_id: orchId,
    name,
    role: 'coordinator',
    type: 'lead',
    cwd: '/workspace/x',
    initial_prompt: null,
    model: 'claude-opus-5',
    effort: 'high',
    permission_mode: 'bypassPermissions',
    provider: 'claude',
    status: 'running',
    pid: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    last_error: null,
    stop_reason: null,
    log_path: '/tmp/x.log',
    last_activity_at: new Date().toISOString(),
    hidden_at: null,
  };
}

function daily(over: Partial<SessionTokenDailyRow> = {}): SessionTokenDailyRow {
  return {
    day: '2026-08-30',
    session_id: 'sess-1',
    orchestrator_id: 'orch-1',
    tokens_in: 1_000,
    tokens_out: 10,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 0.5,
    cum_in: 1_000,
    cum_out: 10,
    cum_cache_read: 0,
    cum_cache_write: 0,
    ...over,
  };
}

describe('SwarmDb.sessionTokenDailySince', () => {
  it('joins the team and agent names in', () => {
    db.upsertOrchestrator(makeOrchRow('orch-1', 'CALM-A'));
    db.upsertSession(makeSessionRow('sess-1', 'orch-1', 'team-lead'));
    db.upsertSessionTokenDaily(daily());

    expect(db.sessionTokenDailySince('2026-01-01')).toEqual([
      {
        day: '2026-08-30',
        orchestrator_id: 'orch-1',
        team: 'CALM-A',
        session_id: 'sess-1',
        agent: 'team-lead',
        tokens_in: 1_000,
        tokens_out: 10,
        cache_read: 0,
        cache_write: 0,
        cost_usd: 0.5,
      },
    ]);
  });

  it('keeps the spend of a team or agent that no longer exists, with an empty name', () => {
    // No orchestrator row, no session row — the ledger outlives both.
    db.upsertSessionTokenDaily(daily({ session_id: 'ghost', orchestrator_id: 'orch-gone' }));
    expect(db.sessionTokenDailySince('2026-01-01')).toEqual([
      expect.objectContaining({ orchestrator_id: 'orch-gone', team: '', session_id: 'ghost', agent: '' }),
    ]);
  });

  it('keeps a soft-deleted agent — a reaped worker is most of the bill', () => {
    db.upsertOrchestrator(makeOrchRow('orch-1', 'CALM-A'));
    db.upsertSession(makeSessionRow('sess-1', 'orch-1', 'worker-1'));
    db.hideSession('sess-1');
    db.upsertSessionTokenDaily(daily());
    expect(db.sessionTokenDailySince('2026-01-01')).toHaveLength(1);
  });

  it('cuts the window at sinceDay, inclusive', () => {
    db.upsertSessionTokenDaily(daily({ day: '2026-08-28' }));
    db.upsertSessionTokenDaily(daily({ day: '2026-08-29' }));
    db.upsertSessionTokenDaily(daily({ day: '2026-08-30' }));
    expect(db.sessionTokenDailySince('2026-08-29').map((r) => r.day)).toEqual([
      '2026-08-29',
      '2026-08-30',
    ]);
  });

  it('orders day, then team, then session id — totally, so exports are stable', () => {
    db.upsertOrchestrator(makeOrchRow('orch-a', 'ZULU'));
    db.upsertOrchestrator(makeOrchRow('orch-b', 'ALPHA'));
    db.upsertSessionTokenDaily(daily({ day: '2026-08-30', session_id: 's2', orchestrator_id: 'orch-a' }));
    db.upsertSessionTokenDaily(daily({ day: '2026-08-30', session_id: 's1', orchestrator_id: 'orch-a' }));
    db.upsertSessionTokenDaily(daily({ day: '2026-08-30', session_id: 's3', orchestrator_id: 'orch-b' }));
    db.upsertSessionTokenDaily(daily({ day: '2026-08-29', session_id: 's4', orchestrator_id: 'orch-a' }));

    expect(db.sessionTokenDailySince('2026-01-01').map((r) => [r.day, r.team, r.session_id])).toEqual([
      ['2026-08-29', 'ZULU', 's4'],
      ['2026-08-30', 'ALPHA', 's3'],
      ['2026-08-30', 'ZULU', 's1'],
      ['2026-08-30', 'ZULU', 's2'],
    ]);
  });

  it('answers an empty window with an empty array', () => {
    expect(db.sessionTokenDailySince('2026-08-30')).toEqual([]);
  });
});

describe('session_token_daily — an existing database gains it at boot', () => {
  it('creates the table on a DB that predates the feature', () => {
    // `CREATE TABLE IF NOT EXISTS` skips an existing TABLE, but a whole missing
    // table is created on every boot — which is why this one needed no ALTER in
    // `applyMigrations`. Reopening the same directory is that boot.
    db.close();
    fs.rmSync(path.join(tmpRoot, 'swarm-os.db'), { force: true });
    // A database with the old schema minus this table.
    const legacy = new SwarmDb(tmpRoot);
    legacy.db.exec('DROP TABLE session_token_daily');
    legacy.close();

    db = new SwarmDb(tmpRoot);
    expect(() => db.upsertSessionTokenDaily(daily())).not.toThrow();
    expect(db.sessionTokenDailySince('2026-01-01')).toHaveLength(1);
  });
});
