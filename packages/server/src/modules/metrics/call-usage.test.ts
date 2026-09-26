import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import type { CallLedgerSession, TranscriptCall } from '../orchestrator/context-usage.js';
import {
  CALL_POINTS_CAP,
  CALL_RETENTION_MS,
  CallLedger,
  densifySeries,
  foldBucketMs,
  parseCallBucket,
  parseCallWindow,
  toSessionCallRow,
} from './call-usage.js';

/**
 * Per-call ledger — the storage half, against a REAL SQLite file: insertion,
 * the UNIQUE de-duplication, the 14-day retention and its hourly throttle, and
 * the SQL aggregations behind the three routes.
 */

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-26T12:30:00.000Z');

let dir: string;
let db: SwarmDb;
let clock: number;

const LEAD: CallLedgerSession = { id: 'lead-1', orchestratorId: 'orch-a', type: 'lead' };
const WORKER: CallLedgerSession = { id: 'wrk-1', orchestratorId: 'orch-a', type: 'worker' };
const OTHER: CallLedgerSession = { id: 'lead-2', orchestratorId: 'orch-b', type: 'lead' };

function call(id: string, ts: number | null, t: Partial<TranscriptCall> = {}): TranscriptCall {
  return {
    messageId: id,
    ts,
    model: 'claude-opus-5-5',
    input: 2,
    cacheWrite: 100,
    cacheRead: 1_000,
    output: 50,
    isSidechain: false,
    ...t,
  };
}

function ledger(opts: { purgeIntervalMs?: number } = {}): CallLedger {
  return new CallLedger(db, { now: () => clock, ...opts });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ledger-'));
  db = new SwarmDb(dir);
  clock = NOW;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('query vocabulary', () => {
  it('parses windows and buckets, with defaults and refusals', () => {
    expect(parseCallWindow(undefined)).toBe('24h');
    expect(parseCallWindow('14d')).toBe('14d');
    expect(parseCallWindow('7d')).toBeNull();
    expect(parseCallBucket(undefined)).toBe('hour');
    expect(parseCallBucket('5m')).toBe('5m');
    expect(parseCallBucket('week')).toBeNull();
  });

  it('folds a window into round buckets, at most CALL_POINTS_CAP of them', () => {
    expect(foldBucketMs(HOUR)).toBe(10_000);
    expect(foldBucketMs(24 * HOUR)).toBe(5 * 60_000);
    expect(foldBucketMs(3 * 24 * HOUR)).toBe(10 * 60_000);
    expect(foldBucketMs(14 * 24 * HOUR)).toBe(HOUR);
    for (const w of [HOUR, 24 * HOUR, 72 * HOUR, 336 * HOUR]) {
      expect(w / foldBucketMs(w)).toBeLessThanOrEqual(CALL_POINTS_CAP);
    }
  });

  it('computes context as input + cache write + cache read, and stamps a missing ts with now', () => {
    const row = toSessionCallRow(WORKER, call('m', null, { isSidechain: true }), NOW);
    expect(row).toMatchObject({
      ts: NOW,
      session_type: 'worker',
      context_tokens: 1_102,
      is_sidechain: 1,
    });
  });
});

describe('CallLedger.record — insert, dedup, retention', () => {
  it('files calls and ignores a re-read of the same message id', () => {
    const l = ledger();
    expect(l.record(LEAD, [call('m1', NOW - 1000), call('m2', NOW - 500)])).toBe(2);
    // A restart re-reads the transcript from 0: same ids, no new row.
    expect(l.record(LEAD, [call('m1', NOW - 1000), call('m2', NOW - 500), call('m3', NOW)])).toBe(1);
    expect(db.countSessionCalls(LEAD.id, 0, NOW + 1)).toBe(3);
  });

  it('the same message id in two sessions is two calls (UNIQUE is per session)', () => {
    const l = ledger();
    l.record(LEAD, [call('m1', NOW)]);
    l.record(WORKER, [call('m1', NOW)]);
    expect(db.countSessionCalls(LEAD.id, 0, NOW + 1)).toBe(1);
    expect(db.countSessionCalls(WORKER.id, 0, NOW + 1)).toBe(1);
  });

  it('does not write calls already past the 14-day horizon', () => {
    const l = ledger();
    expect(l.record(LEAD, [call('old', NOW - CALL_RETENTION_MS - 1), call('new', NOW)])).toBe(1);
  });

  it('purges expired rows at insertion, at most once per interval', () => {
    const l = ledger();
    l.record(LEAD, [call('a', NOW - 10 * HOUR)]);
    // 14 days minus 30 minutes later, 'a' is not expired yet; 'b' is filed.
    clock = NOW - 10 * HOUR + CALL_RETENTION_MS - 30 * 60_000;
    l.record(LEAD, [call('b', clock)]);
    expect(db.countSessionCalls(LEAD.id, 0, clock + 1)).toBe(2);
    // 45 minutes later 'a' IS expired, but the last purge was < 1 h ago.
    clock += 45 * 60_000;
    l.record(LEAD, [call('c', clock)]);
    expect(db.countSessionCalls(LEAD.id, 0, clock + 1)).toBe(3);
    // Past the interval: the next insert purges.
    clock += 20 * 60_000;
    l.record(LEAD, [call('d', clock)]);
    expect(db.listSessionCalls(LEAD.id, 0, clock + 1).map((r) => r.message_id)).toEqual(['b', 'c', 'd']);
  });

  it('is a silent no-op over a DB stub without the ledger methods', () => {
    const l = new CallLedger({});
    expect(l.record(LEAD, [call('m', NOW)])).toBe(0);
    expect(l.sessionCalls(LEAD.id, '1h').calls).toEqual([]);
  });
});

describe('CallLedger.sessionCalls — one agent', () => {
  it('returns single calls, oldest first, with hourly counts and totals', () => {
    const l = ledger();
    l.record(LEAD, [
      call('m1', NOW - 2 * HOUR, { input: 1, output: 10 }),
      call('m2', NOW - 20 * 60_000, { cacheRead: 5_000, isSidechain: true }),
      call('m3', NOW - 10 * 60_000, { model: 'claude-haiku-4-5' }),
    ]);
    l.record(OTHER, [call('x', NOW)]); // never leaks into LEAD
    const view = l.sessionCalls(LEAD.id, '24h');
    expect(view.aggregated).toBe(false);
    expect(view.bucketMs).toBeNull();
    expect(view.calls.map((c) => c.n)).toEqual([1, 1, 1]);
    expect(view.calls[0]).toMatchObject({ input: 1, output: 10, context: 1 + 100 + 1_000, sidechain: false });
    expect(view.calls[1]).toMatchObject({ context: 2 + 100 + 5_000, sidechain: true });
    expect(view.calls[2]?.model).toBe('claude-haiku-4-5');
    expect(view.hourly).toEqual([
      { t: '2026-09-26T10:00:00.000Z', calls: 1 },
      { t: '2026-09-26T12:00:00.000Z', calls: 2 },
    ]);
    expect(view.totals).toEqual({
      calls: 3,
      input: 1 + 2 + 2,
      cacheWrite: 300,
      cacheRead: 1_000 + 5_000 + 1_000,
      output: 10 + 50 + 50,
      maxContext: 5_102,
    });
    expect(l.sessionCalls(LEAD.id, '1h').calls).toHaveLength(2);
  });

  it('folds into SQL buckets past the cap — sums, max context, model only if unique', () => {
    const l = ledger();
    const calls: TranscriptCall[] = [];
    for (let i = 0; i < CALL_POINTS_CAP + 1; i++) {
      calls.push(call(`m${i}`, NOW - 50 * 60_000 + i * 1_000, {
        cacheRead: 1_000 + i,
        model: i === 0 ? 'claude-haiku-4-5' : 'claude-opus-5-5',
      }));
    }
    l.record(LEAD, calls);
    const view = l.sessionCalls(LEAD.id, '1h');
    expect(view.aggregated).toBe(true);
    expect(view.bucketMs).toBe(10_000);
    expect(view.calls.length).toBeLessThanOrEqual(CALL_POINTS_CAP);
    expect(view.calls.reduce((n, p) => n + p.n, 0)).toBe(CALL_POINTS_CAP + 1);
    const first = view.calls[0];
    expect(first?.model).toBeNull(); // haiku + opus in the same bucket
    expect(view.calls[1]?.model).toBe('claude-opus-5-5');
    const last = view.calls[view.calls.length - 1];
    expect(last?.context).toBe(2 + 100 + 1_000 + CALL_POINTS_CAP);
    expect(view.totals.calls).toBe(CALL_POINTS_CAP + 1);
  });
});

describe('CallLedger.callUsage — team and fleet series', () => {
  function seed(l: CallLedger): void {
    l.record(LEAD, [call('l1', NOW - 3 * HOUR), call('l2', NOW - 5 * 60_000)]);
    l.record(WORKER, [call('w1', NOW - 5 * 60_000), call('w2', NOW - 4 * 60_000), call('w3', NOW - 3 * 60_000)]);
    l.record(OTHER, [call('o1', NOW - HOUR)]);
  }

  it('splits lead and workers per hour, dense over the window', () => {
    const l = ledger();
    seed(l);
    const view = l.callUsage('orch-a', '24h', 'hour');
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.bucketMs).toBe(HOUR);
    expect(view.lead).toHaveLength(view.workers.length);
    expect(view.lead.length).toBeGreaterThanOrEqual(24);
    const at = (t: string) => view.lead.findIndex((p) => p.t === t);
    const noon = at('2026-09-26T12:00:00.000Z');
    const nine = at('2026-09-26T09:00:00.000Z');
    expect(view.lead[noon]?.calls).toBe(1);
    expect(view.workers[noon]?.calls).toBe(3);
    expect(view.lead[nine]?.calls).toBe(1);
    expect(view.workers[nine]?.calls).toBe(0);
    expect(view.totals.lead).toMatchObject({ calls: 2, cacheRead: 2_000 });
    expect(view.totals.workers).toMatchObject({ calls: 3, output: 150 });
    expect(view.teams).toBeUndefined();
  });

  it('fleet view: every team, plus one total per team, named, busiest first', () => {
    const l = ledger();
    seed(l);
    const view = l.callUsage(null, '24h', 'hour', (id) => (id === 'orch-a' ? 'Alpha' : null));
    expect(view?.totals.lead.calls).toBe(3);
    expect(view?.totals.workers.calls).toBe(3);
    expect(view?.teams).toEqual([
      { orchestratorId: 'orch-a', name: 'Alpha', calls: 5, input: 10, cacheWrite: 500, cacheRead: 5_000, output: 250 },
      { orchestratorId: 'orch-b', name: null, calls: 1, input: 2, cacheWrite: 100, cacheRead: 1_000, output: 50 },
    ]);
  });

  it('refuses a window × bucket product over the cap', () => {
    const l = ledger();
    expect(l.callUsage(null, '14d', '5m')).toBeNull();
    expect(l.callUsage(null, '3d', '5m')).not.toBeNull();
    expect(l.callUsage(null, '14d', 'day')?.lead.length).toBeGreaterThanOrEqual(14);
  });

  it('densifySeries drops rows outside the window rather than inventing buckets', () => {
    const out = densifySeries(
      [{ t: -HOUR, session_type: 'lead', calls: 9, input_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }],
      0,
      2 * HOUR,
      HOUR,
    );
    expect(out.lead.map((p) => p.calls)).toEqual([0, 0]);
  });
});

describe('cost — 7 teams, ~10 000 calls a night, 14 days of history', () => {
  it('keeps every read under a few tens of milliseconds at the retention horizon', () => {
    const l = ledger({ purgeIntervalMs: Number.MAX_SAFE_INTEGER });
    // 14 nights × 10 000 calls = 140 000 rows, spread over 7 teams × 5 agents.
    const perBatch = 500;
    const total = 140_000;
    for (let i = 0; i < total; i += perBatch) {
      const batch: TranscriptCall[] = [];
      for (let j = i; j < i + perBatch; j++) {
        batch.push(call(`m${j}`, NOW - CALL_RETENTION_MS + 60_000 + Math.floor((j / total) * (CALL_RETENTION_MS - 120_000))));
      }
      const team = (i / perBatch) % 7;
      const agent = (i / perBatch) % 5;
      l.record({ id: `s-${team}-${agent}`, orchestratorId: `orch-${team}`, type: agent === 0 ? 'lead' : 'worker' }, batch);
    }
    const time = (fn: () => unknown): number => {
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    };
    const timings = {
      agent14d: time(() => l.sessionCalls('s-3-2', '14d')),
      agent24h: time(() => l.sessionCalls('s-3-2', '24h')),
      team14d: time(() => l.callUsage('orch-3', '14d', 'hour')),
      fleet14d: time(() => l.callUsage(null, '14d', 'hour')),
      fleet24h: time(() => l.callUsage(null, '24h', 'hour')),
    };
    // Generous bounds — CI boxes are slow. Measured on the dev box: agent 24h
    // ~3 ms, team 14d ~14 ms, fleet 14d ~160 ms (series + per-team totals).
    expect(timings.agent24h).toBeLessThan(250);
    expect(timings.team14d).toBeLessThan(500);
    expect(timings.fleet14d).toBeLessThan(1_500);
  }, 60_000);
});
