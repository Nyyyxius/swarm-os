/**
 * Lot 12 — the two SQL aggregates behind the team bill.
 *
 * The one property that makes this feature work, and the one a future refactor
 * is most likely to break: these queries do NOT filter `hidden_at IS NULL`.
 * Every other SELECT in `SwarmDb` does, because everywhere else "hidden" means
 * "the operator removed it from the map". Here it means "this worker was killed
 * or reaped" — and a team's bill is what it spent, not what is still breathing.
 *
 * The second property, just as easy to lose: `SUM` over an all-NULL group
 * returns NULL and must stay NULL. A `COALESCE(…, 0)` would turn "these rows
 * predate the counters" into "these agents were free".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb, type OrchestratorRow, type SessionRow } from './index.js';

let tmpRoot: string;
let db: SwarmDb;

/** `sessions.orchestrator_id` is a real FK — every team here needs a row. */
function makeOrchRow(id: string): OrchestratorRow {
  return {
    id,
    name: id,
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

function makeSessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    orchestrator_id: 'orch-1',
    name: 'team-lead',
    role: 'coordinator',
    type: 'lead',
    cwd: '/workspace/x',
    initial_prompt: null,
    model: 'claude-opus-5',
    effort: 'high',
    permission_mode: 'bypassPermissions',
    provider: 'claude',
    status: 'running',
    pid: 1234,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: null,
    exit_code: null,
    last_error: null,
    stop_reason: null,
    log_path: '/logs/sess-1.log',
    last_activity_at: new Date().toISOString(),
    hidden_at: null,
    tokens_in: 1000,
    tokens_out: 100,
    tokens_cache_read: 5000,
    tokens_cache_write: 200,
    ...over,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-costs-'));
  db = new SwarmDb(tmpRoot);
  db.upsertOrchestrator(makeOrchRow('orch-1'));
  db.upsertOrchestrator(makeOrchRow('orch-2'));
});

afterEach(() => {
  db.db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sumTokenUsageByOrchestrator', () => {
  it('counts HIDDEN rows — the killed workers are most of the bill', () => {
    db.upsertSession(makeSessionRow({ id: 's1' }));
    db.upsertSession(
      makeSessionRow({
        id: 's2',
        type: 'worker',
        status: 'killed',
        hidden_at: new Date().toISOString(),
      }),
    );

    const rows = db.sumTokenUsageByOrchestrator();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      orchestrator_id: 'orch-1',
      provider: 'claude',
      model: 'claude-opus-5',
      in: 2000,
      out: 200,
      cache_read: 10_000,
      cache_write: 400,
      removed_count: 1,
      removed_in: 1000,
      removed_out: 100,
      removed_cache_read: 5000,
      removed_cache_write: 200,
    });
    // Sanity: the ordinary listing does hide it, so the aggregate is genuinely
    // seeing something no other reader does.
    expect(db.listSessions('orch-1')).toHaveLength(1);
  });

  it('leaves NULL counters NULL rather than folding them to 0', () => {
    // A whole team that ran before Lot 11 existed.
    db.upsertSession(
      makeSessionRow({
        id: 's1',
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
      }),
    );
    const row = db.sumTokenUsageByOrchestrator()[0]!;
    expect(row.in).toBeNull();
    expect(row.out).toBeNull();
    expect(row.cache_read).toBeNull();
    expect(row.cache_write).toBeNull();
    expect(row.has_null_counters).toBe(1);
    expect(row.removed_count).toBe(0);
  });

  it('sums the measured rows and ignores the unmeasured ones beside them', () => {
    db.upsertSession(makeSessionRow({ id: 's1', tokens_in: 700 }));
    db.upsertSession(
      makeSessionRow({
        id: 's2',
        type: 'worker',
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
      }),
    );
    const row = db.sumTokenUsageByOrchestrator()[0]!;
    expect(row.in).toBe(700);
    expect(row.has_null_counters).toBe(1);
  });

  it('reports removed_* as NULL when the removed rows carry no counters', () => {
    db.upsertSession(makeSessionRow({ id: 's1' }));
    db.upsertSession(
      makeSessionRow({
        id: 's2',
        type: 'worker',
        hidden_at: new Date().toISOString(),
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
      }),
    );
    const row = db.sumTokenUsageByOrchestrator()[0]!;
    expect(row.removed_count).toBe(1);
    expect(row.removed_in).toBeNull();
    expect(row.removed_has_null).toBe(1);
    // The live row is untouched by its dead neighbour.
    expect(row.in).toBe(1000);
  });

  it('folds by (team, provider, model) so a mixed team can be priced', () => {
    db.upsertSession(makeSessionRow({ id: 's1', model: 'claude-opus-5', tokens_in: 10 }));
    db.upsertSession(
      makeSessionRow({ id: 's2', type: 'worker', model: 'claude-sonnet-4-5', tokens_in: 20 }),
    );
    db.upsertSession(
      makeSessionRow({ id: 's3', type: 'worker', provider: 'codex', model: 'gpt-5', tokens_in: 30 }),
    );
    db.upsertSession(makeSessionRow({ id: 's4', orchestrator_id: 'orch-2', tokens_in: 40 }));

    const rows = db.sumTokenUsageByOrchestrator();
    const first = rows.filter((r) => r.orchestrator_id === 'orch-1');
    expect(first).toHaveLength(3);
    expect(first.map((r) => r.in).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10, 20, 30]);
    expect(rows.filter((r) => r.orchestrator_id === 'orch-2')).toHaveLength(1);
  });

  it('is empty on an empty database rather than throwing', () => {
    expect(db.sumTokenUsageByOrchestrator()).toEqual([]);
  });
});

describe('sessionCostRowsForOrchestrator', () => {
  it('returns live AND hidden rows, in start order, with the pricing fields', () => {
    const t0 = Date.now();
    db.upsertSession(
      makeSessionRow({ id: 's1', started_at: new Date(t0).toISOString() }),
    );
    db.upsertSession(
      makeSessionRow({
        id: 's2',
        name: 'worker-a',
        type: 'worker',
        status: 'killed',
        provider: 'codex',
        model: 'gpt-5',
        started_at: new Date(t0 + 1000).toISOString(),
        hidden_at: new Date(t0 + 2000).toISOString(),
      }),
    );
    db.upsertSession(makeSessionRow({ id: 's9', orchestrator_id: 'orch-2' }));

    const rows = db.sessionCostRowsForOrchestrator('orch-1');
    expect(rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(rows[1]).toMatchObject({
      id: 's2',
      name: 'worker-a',
      type: 'worker',
      status: 'killed',
      provider: 'codex',
      model: 'gpt-5',
      tokens_in: 1000,
    });
    expect(rows[0]!.hidden_at).toBeNull();
    expect(rows[1]!.hidden_at).not.toBeNull();
  });

  it('carries NULL counters through untouched', () => {
    db.upsertSession(
      makeSessionRow({
        id: 's1',
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
      }),
    );
    const row = db.sessionCostRowsForOrchestrator('orch-1')[0]!;
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_cache_write).toBeNull();
  });

  it('is empty for an unknown team', () => {
    expect(db.sessionCostRowsForOrchestrator('nope')).toEqual([]);
  });
});
