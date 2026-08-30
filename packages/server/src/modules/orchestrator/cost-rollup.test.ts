/**
 * Lot 15 — the daily roll-up, and the ledger it writes into.
 *
 * Two halves, deliberately:
 *
 *   - `rollupOnce` alone, with the watermark injected. Everything about WHAT a
 *     pass emits — deltas, clamps, skips — is a property of that function and
 *     needs no database.
 *   - the same function over a REAL `SwarmDb`. Everything about what SURVIVES —
 *     two ticks folding into one row, midnight opening a second one, a restart
 *     picking the delta up from SQLite, `cost_usd` merging NULL with an amount —
 *     is a property of the upsert statement, and mimicking that SQL in a fake
 *     would only prove the mimic right.
 *
 * The invariant every test here defends: a token is counted ONCE. Not zero
 * times when the day turns or the process restarts, and not twice when a
 * counter dips.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  rollupOnce,
  costRollupJanitor,
  utcDay,
  type RollupSession,
  type RollupCum,
} from './cost-rollup.js';
import { SwarmDb, type SessionTokenDailyRow } from '../db/index.js';
import type { TokenCostRates } from '../providers/catalogue.js';

/** $5/M in, $25/M out, cache priced too. Only `claude-opus-5` is priceable. */
const RATES: Record<string, TokenCostRates> = {
  'claude:claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const rateLookup = (providerId: string, modelId: string): TokenCostRates | null =>
  RATES[`${providerId}:${modelId}`] ?? null;

/** Midday, so nothing in these tests is an accident of a timezone offset. */
const DAY_1 = Date.parse('2026-08-30T12:00:00Z');
const DAY_2 = Date.parse('2026-08-31T00:30:00Z');

function session(over: Partial<RollupSession> = {}): RollupSession {
  return {
    id: 'sess-1',
    orchestratorId: 'orch-1',
    provider: 'claude',
    model: 'claude-opus-5',
    tokens: { in: 1_000_000, out: 100_000, cacheRead: 0, cacheWrite: 0 },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. The pure pass
// ---------------------------------------------------------------------------

describe('rollupOnce — one pass', () => {
  /** Collects what the pass would write, with an injectable watermark. */
  function pass(
    sessions: RollupSession[],
    cums: Record<string, RollupCum> = {},
    now = DAY_1,
  ): { written: number; rows: SessionTokenDailyRow[] } {
    const rows: SessionTokenDailyRow[] = [];
    const written = rollupOnce({
      sessions: () => sessions,
      lastCum: (id) => cums[id] ?? null,
      write: (row) => rows.push(row),
      rateLookup,
      now: () => now,
    });
    return { written, rows };
  }

  it('files the whole cumulative on a session that has no row yet', () => {
    const { written, rows } = pass([session()]);
    expect(written).toBe(1);
    expect(rows[0]).toEqual({
      day: '2026-08-30',
      session_id: 'sess-1',
      orchestrator_id: 'orch-1',
      tokens_in: 1_000_000,
      tokens_out: 100_000,
      cache_read: 0,
      cache_write: 0,
      // 1M in ($5) + 100k out ($2.50)
      cost_usd: 7.5,
      cum_in: 1_000_000,
      cum_out: 100_000,
      cum_cache_read: 0,
      cum_cache_write: 0,
    });
  });

  it('files the DELTA against the watermark, not the total', () => {
    const { rows } = pass([session()], {
      'sess-1': { in: 600_000, out: 100_000, cacheRead: 0, cacheWrite: 0 },
    });
    // 400k new input, no new output. The row is the difference…
    expect(rows[0]).toMatchObject({ tokens_in: 400_000, tokens_out: 0, cost_usd: 2 });
    // …and the watermark moves to what was OBSERVED.
    expect(rows[0]).toMatchObject({ cum_in: 1_000_000, cum_out: 100_000 });
  });

  it('writes nothing at all when nothing moved', () => {
    // An idle fleet must cost the table nothing — otherwise 200 agents produce
    // 200 zero rows an hour, forever.
    const { written, rows } = pass([session()], {
      'sess-1': { in: 1_000_000, out: 100_000, cacheRead: 0, cacheWrite: 0 },
    });
    expect(written).toBe(0);
    expect(rows).toEqual([]);
  });

  it('clamps a counter that went BACKWARDS to zero, and never re-baselines', () => {
    // A dip must not produce a negative day. And the watermark must NOT follow
    // it down: re-baselining would double-count the climb back up, and this
    // feature errs low on purpose.
    const { written, rows } = pass([session({ tokens: { in: 10, out: 0, cacheRead: 0, cacheWrite: 0 } })], {
      'sess-1': { in: 1_000_000, out: 100_000, cacheRead: 0, cacheWrite: 0 },
    });
    expect(written).toBe(0);
    expect(rows).toEqual([]);
  });

  it('clamps per BUCKET: a dip in one does not cancel growth in another', () => {
    const { rows } = pass(
      [session({ tokens: { in: 1_200_000, out: 10, cacheRead: 0, cacheWrite: 0 } })],
      { 'sess-1': { in: 1_000_000, out: 100_000, cacheRead: 0, cacheWrite: 0 } },
    );
    expect(rows[0]).toMatchObject({ tokens_in: 200_000, tokens_out: 0 });
  });

  it('ignores a session that was never measured — `null` is not zero', () => {
    const { written, rows } = pass([session({ tokens: null })]);
    expect(written).toBe(0);
    expect(rows).toEqual([]);
  });

  it('files an unpriceable delta with cost_usd null, never $0', () => {
    const { rows } = pass([session({ model: 'some-model-nobody-prices' })]);
    expect(rows[0]).toMatchObject({ tokens_in: 1_000_000, cost_usd: null });
  });

  it('survives a throwing rate lookup — a missing price, not a lost row', () => {
    const rows: SessionTokenDailyRow[] = [];
    const written = rollupOnce({
      sessions: () => [session()],
      lastCum: () => null,
      write: (row) => rows.push(row),
      rateLookup: () => {
        throw new Error('catalogue on fire');
      },
      now: () => DAY_1,
    });
    expect(written).toBe(1);
    expect(rows[0]).toMatchObject({ tokens_in: 1_000_000, cost_usd: null });
  });

  it('stamps the UTC day, whatever the host clock is set to', () => {
    // 00:30Z is the 31st in UTC and the 30th in Montréal. The ledger says UTC.
    const { rows } = pass([session()], {}, DAY_2);
    expect(rows[0]!.day).toBe('2026-08-31');
    expect(utcDay(DAY_2)).toBe('2026-08-31');
  });

  it('one bad session cannot cost the sweep the rest of the fleet', () => {
    const rows: SessionTokenDailyRow[] = [];
    const written = rollupOnce({
      sessions: () => [session({ id: 'sess-bad' }), session({ id: 'sess-ok' })],
      lastCum: (id) => {
        if (id === 'sess-bad') throw new Error('watermark unreadable');
        return null;
      },
      write: (row) => rows.push(row),
      rateLookup,
      now: () => DAY_1,
    });
    expect(written).toBe(1);
    expect(rows[0]).toMatchObject({ session_id: 'sess-ok' });
  });
});

// ---------------------------------------------------------------------------
// 2. The ledger, over a real database
// ---------------------------------------------------------------------------

describe('session_token_daily — what survives', () => {
  let tmpRoot: string;
  let db: SwarmDb;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rollup-'));
    db = new SwarmDb(tmpRoot);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** One tick against the live DB, exactly as `startCostRollup` wires it. */
  function tick(sessions: RollupSession[], now: number): number {
    const cums = new Map<string, RollupCum>();
    for (const row of db.lastSessionTokenCums()) {
      cums.set(row.session_id, {
        in: row.cum_in,
        out: row.cum_out,
        cacheRead: row.cum_cache_read,
        cacheWrite: row.cum_cache_write,
      });
    }
    return rollupOnce({
      sessions: () => sessions,
      lastCum: (id) => cums.get(id) ?? null,
      write: (row) => db.upsertSessionTokenDaily(row),
      rateLookup,
      now: () => now,
    });
  }

  function allRows(): SessionTokenDailyRow[] {
    return db.db
      .prepare('SELECT * FROM session_token_daily ORDER BY day ASC, session_id ASC')
      .all() as SessionTokenDailyRow[];
  }

  it('folds two ticks of the same day into ONE row, summed', () => {
    tick([session({ tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1);
    tick([session({ tokens: { in: 1_500_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1 + 3_600_000);

    const rows = allRows();
    expect(rows).toHaveLength(1);
    // 1M then 500k more — the day totals 1.5M, and the row is the day.
    expect(rows[0]).toMatchObject({
      day: '2026-08-30',
      tokens_in: 1_500_000,
      cum_in: 1_500_000,
      cost_usd: 7.5,
    });
  });

  it('opens a second row when the day turns, against the SAME watermark', () => {
    tick([session({ tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1);
    tick([session({ tokens: { in: 1_200_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_2);

    const rows = allRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ day: '2026-08-30', tokens_in: 1_000_000 });
    // Midnight is not special: the 31st gets what was billed since the last
    // tick, not the whole cumulative again.
    expect(rows[1]).toMatchObject({ day: '2026-08-31', tokens_in: 200_000, cum_in: 1_200_000 });
    expect(rows[0]!.tokens_in + rows[1]!.tokens_in).toBe(1_200_000);
  });

  it('continues across a restart — the watermark is in SQLite, not in RAM', () => {
    tick([session({ tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1);
    // Close and reopen: a redeploy. The session comes back with its counters
    // SEEDED from its own DB row, so it reports its whole life, not a fresh 0.
    db.close();
    db = new SwarmDb(tmpRoot);
    tick([session({ tokens: { in: 1_400_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1 + 7_200_000);

    const rows = allRows();
    expect(rows).toHaveLength(1);
    // 1.4M billed in total, 1.4M filed. Not 2.4M (double count), not 1M (lost).
    expect(rows[0]).toMatchObject({ tokens_in: 1_400_000, cum_in: 1_400_000 });
  });

  it('reads the watermark from the LATEST day, not from today alone', () => {
    tick([session({ tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1);
    const cums = db.lastSessionTokenCums();
    expect(cums).toHaveLength(1);
    expect(cums[0]).toMatchObject({ session_id: 'sess-1', day: '2026-08-30', cum_in: 1_000_000 });

    tick([session({ tokens: { in: 1_600_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_2);
    const after = db.lastSessionTokenCums();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ day: '2026-08-31', cum_in: 1_600_000 });
  });

  it('lets a NULL cost become an amount, and never lets an amount become NULL', () => {
    // Tick 1: the catalogue cannot price the model → the day is unpriced.
    const unpriceable = session({ model: 'mystery-model' });
    tick([{ ...unpriceable, tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } }], DAY_1);
    expect(allRows()[0]).toMatchObject({ tokens_in: 1_000_000, cost_usd: null });

    // Tick 2: the same day, this time priceable. NULL + $1 = $1.
    tick([session({ tokens: { in: 1_200_000, out: 0, cacheRead: 0, cacheWrite: 0 } })], DAY_1 + 60_000);
    expect(allRows()[0]).toMatchObject({ tokens_in: 1_200_000, cost_usd: 1 });

    // Tick 3: unpriceable again. The dollars already established STAY.
    tick(
      [{ ...unpriceable, tokens: { in: 1_400_000, out: 0, cacheRead: 0, cacheWrite: 0 } }],
      DAY_1 + 120_000,
    );
    expect(allRows()[0]).toMatchObject({ tokens_in: 1_400_000, cost_usd: 1 });
  });

  it('keeps one row per session per day', () => {
    tick(
      [
        session({ id: 'sess-a', tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } }),
        session({ id: 'sess-b', tokens: { in: 2_000_000, out: 0, cacheRead: 0, cacheWrite: 0 } }),
      ],
      DAY_1,
    );
    const rows = allRows();
    expect(rows.map((r) => r.session_id)).toEqual(['sess-a', 'sess-b']);
  });
});

// ---------------------------------------------------------------------------
// 3. Retention
// ---------------------------------------------------------------------------

describe('costRollupJanitor — the 90-day GC', () => {
  let tmpRoot: string;
  let db: SwarmDb;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rollup-gc-'));
    db = new SwarmDb(tmpRoot);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seed(day: string, sessionId = 'sess-1'): void {
    db.upsertSessionTokenDaily({
      day,
      session_id: sessionId,
      orchestrator_id: 'orch-1',
      tokens_in: 1,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      cost_usd: null,
      cum_in: 1,
      cum_out: 0,
      cum_cache_read: 0,
      cum_cache_write: 0,
    });
  }

  it('drops what is older than 90 days and keeps the boundary itself', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    const cutoff = utcDay(now - 90 * 86_400_000); // 2026-06-01
    seed('2026-05-31'); // older than the window
    seed(cutoff); // exactly at the boundary — `<` keeps it
    seed('2026-08-30');

    expect(costRollupJanitor(db, { now: () => now })).toEqual({ deleted: 1 });
    const days = (
      db.db.prepare('SELECT day FROM session_token_daily ORDER BY day').all() as { day: string }[]
    ).map((r) => r.day);
    expect(days).toEqual([cutoff, '2026-08-30']);
  });

  it('is a no-op on a young table, and safe to run at every boot', () => {
    const now = Date.parse('2026-08-30T12:00:00Z');
    seed('2026-08-29');
    expect(costRollupJanitor(db, { now: () => now })).toEqual({ deleted: 0 });
    expect(costRollupJanitor(db, { now: () => now })).toEqual({ deleted: 0 });
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM session_token_daily').get()).toEqual({ n: 1 });
  });
});
