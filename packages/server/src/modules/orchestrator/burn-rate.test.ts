/**
 * Lot 12 — the burn rate (docs/monitoring-agents.md § Lot 12).
 *
 * Two halves, tested apart because they fail apart:
 *
 *  1. `estimateBurnPerHourUsd` — a pure function over a ring of cumulative
 *     counters. Everything an operator could misread lives here: the reference
 *     point, the minimum span, and the three ways the answer is `null` rather
 *     than a confident wrong number.
 *  2. the ring itself — that the tracker appends one point per ACCEPTED sample
 *     (not per poll), that it stores counters and never a price, and that it is
 *     bounded by the same 72 h + count policy as the Lot 9 history.
 */
import { describe, it, expect } from 'vitest';
import {
  BURN_MIN_SPAN_MS,
  BURN_WINDOW_MS,
  CONTEXT_HISTORY_MAX_SAMPLES,
  ContextUsageTracker,
  estimateBurnPerHourUsd,
  type ContextUsageReading,
  type ContextUsageSource,
  type TokenBurnSample,
  type TokenUsageCounters,
} from './context-usage.js';
import type { TokenCostRates } from '../providers/catalogue.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** $5/M in, $25/M out — the shape of an Anthropic rate card. */
const RATES: TokenCostRates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

function counters(over: Partial<TokenUsageCounters> = {}): TokenUsageCounters {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, ...over };
}

function sample(t: number, over: Partial<TokenUsageCounters> = {}): TokenBurnSample {
  return { t, counters: counters(over) };
}

// ---------------------------------------------------------------------------
// 1. The pure function
// ---------------------------------------------------------------------------

describe('estimateBurnPerHourUsd', () => {
  it('prices the delta between the oldest sample in the window and the newest', () => {
    const now = 10 * HOUR;
    // 1 000 000 input tokens over exactly one hour, at $5/M ⇒ $5/h.
    const burn = estimateBurnPerHourUsd(
      [
        sample(now - 2 * HOUR, { in: 400_000 }), // outside the window — ignored
        sample(now - HOUR, { in: 1_000_000 }),
        sample(now - 30 * MINUTE, { in: 1_500_000 }),
        sample(now, { in: 2_000_000 }),
      ],
      RATES,
      now,
    );
    expect(burn).toBeCloseTo(5, 6);
  });

  it('extrapolates a partial window to the hour', () => {
    const now = 10 * HOUR;
    // 30 min of spend, $2.50 worth ⇒ $5/h.
    const burn = estimateBurnPerHourUsd(
      [sample(now - 30 * MINUTE, { in: 0 }), sample(now, { in: 500_000 })],
      RATES,
      now,
    );
    expect(burn).toBeCloseTo(5, 6);
  });

  it('counts only what was billed SINCE the reference, not the lifetime total', () => {
    const now = 10 * HOUR;
    // A long-lived agent: 50 M tokens on the clock, 1 M of them this hour.
    const burn = estimateBurnPerHourUsd(
      [sample(now - HOUR, { in: 50_000_000 }), sample(now, { in: 51_000_000 })],
      RATES,
      now,
    );
    expect(burn).toBeCloseTo(5, 6);
  });

  it('sums the priced buckets, cache included', () => {
    const now = 10 * HOUR;
    // in 1M×$5 + out 100k×$25 + cacheRead 2M×$0.5 + cacheWrite 100k×$6.25
    //   = 5 + 2.5 + 1 + 0.625 = $9.125 over one hour.
    const burn = estimateBurnPerHourUsd(
      [
        sample(now - HOUR),
        sample(now, { in: 1_000_000, out: 100_000, cacheRead: 2_000_000, cacheWrite: 100_000 }),
      ],
      RATES,
      now,
    );
    expect(burn).toBeCloseTo(9.125, 6);
  });

  it('is null under the minimum span — one expensive turn is not a rate', () => {
    const now = 10 * HOUR;
    const span = BURN_MIN_SPAN_MS - MINUTE;
    expect(
      estimateBurnPerHourUsd([sample(now - span), sample(now, { in: 1_000_000 })], RATES, now),
    ).toBeNull();
    // One minute more and the same data becomes an answer.
    expect(
      estimateBurnPerHourUsd(
        [sample(now - BURN_MIN_SPAN_MS), sample(now, { in: 1_000_000 })],
        RATES,
        now,
      ),
    ).not.toBeNull();
  });

  it('is null without a rate card — never 0, which would read as "free"', () => {
    const now = 10 * HOUR;
    const ring = [sample(now - HOUR), sample(now, { in: 1_000_000 })];
    expect(estimateBurnPerHourUsd(ring, null, now)).toBeNull();
    expect(estimateBurnPerHourUsd(ring, undefined, now)).toBeNull();
    // A rate card that prices NEITHER input nor output is no rate card at all.
    expect(
      estimateBurnPerHourUsd(ring, { input: null, output: null, cacheRead: 0.5, cacheWrite: null }, now),
    ).toBeNull();
  });

  it('is null with fewer than two samples, and with none inside the window', () => {
    const now = 10 * HOUR;
    expect(estimateBurnPerHourUsd([], RATES, now)).toBeNull();
    expect(estimateBurnPerHourUsd([sample(now, { in: 1_000_000 })], RATES, now)).toBeNull();
    // An idle agent whose whole ring predates the window: no measurement, not 0.
    expect(
      estimateBurnPerHourUsd(
        [sample(now - 3 * HOUR), sample(now - 2 * HOUR, { in: 1_000_000 })],
        RATES,
        now,
      ),
    ).toBeNull();
    // Exactly one point left inside the window is still one point.
    expect(
      estimateBurnPerHourUsd(
        [sample(now - BURN_WINDOW_MS - MINUTE), sample(now, { in: 1_000_000 })],
        RATES,
        now,
      ),
    ).toBeNull();
  });

  it('is 0 for a live-but-idle agent — measured, and honestly so', () => {
    const now = 10 * HOUR;
    expect(
      estimateBurnPerHourUsd([sample(now - HOUR, { in: 5_000 }), sample(now, { in: 5_000 })], RATES, now),
    ).toBe(0);
  });

  it('clamps a counter that went backwards (a resumed source re-basing)', () => {
    const now = 10 * HOUR;
    expect(
      estimateBurnPerHourUsd(
        [sample(now - HOUR, { in: 9_000_000 }), sample(now, { in: 1_000 })],
        RATES,
        now,
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The ring inside the tracker
// ---------------------------------------------------------------------------

/** A source under full test control: what it returns, and when. */
class ScriptedSource implements ContextUsageSource {
  readonly basis = 'transcript' as const;
  readonly target = '/t.jsonl';
  readonly ready = true;
  next: ContextUsageReading = { kind: 'empty' };
  async read(): Promise<ContextUsageReading> {
    return this.next;
  }
}

function makeTracker(now: () => number): {
  tracker: ContextUsageTracker;
  source: ScriptedSource;
} {
  const source = new ScriptedSource();
  const tracker = new ContextUsageTracker({
    sessionId: 'sess-burn',
    // Zero TTL between reads is not an option (0 disables the tracker), so the
    // clock is driven by hand and the TTL is small enough never to gate.
    ttlMs: 1,
    limitTokens: () => 200_000,
    now,
    source,
  });
  return { tracker, source };
}

/** Let the fire-and-forget refresh land. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('ContextUsageTracker — the burn ring', () => {
  it('appends the CUMULATIVE counters at the same tick as a Lot 9 sample', async () => {
    let clock = 1_000_000;
    const { tracker, source } = makeTracker(() => clock);

    source.next = { kind: 'sample', usedTokens: 100, tokens: counters({ in: 10, out: 1 }) };
    tracker.maybeRefresh();
    await flush();

    clock += 20 * MINUTE;
    source.next = { kind: 'sample', usedTokens: 300, tokens: counters({ in: 30, out: 2 }) };
    tracker.maybeRefresh();
    await flush();

    const ring = tracker.burnSamples();
    expect(ring).toHaveLength(2);
    // Cumulative, not per-tick deltas — the second point carries the sum.
    expect(ring[0]).toMatchObject({ t: 1_000_000, counters: { in: 10, out: 1 } });
    expect(ring[1]).toMatchObject({ t: 1_000_000 + 20 * MINUTE, counters: { in: 40, out: 3 } });
    // And it stores TOKENS only: no price is ever frozen into the ring.
    expect(Object.keys(ring[0]!.counters).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'in',
      'out',
    ]);
    // The two rings stay aligned point for point.
    expect(tracker.history().samples).toHaveLength(2);
  });

  it('does not append on a poll that measured nothing', async () => {
    let clock = 1_000_000;
    const { tracker, source } = makeTracker(() => clock);
    source.next = { kind: 'sample', usedTokens: 100, tokens: counters({ in: 10 }) };
    tracker.maybeRefresh();
    await flush();

    clock += MINUTE;
    source.next = { kind: 'empty' };
    tracker.maybeRefresh();
    await flush();
    clock += MINUTE;
    source.next = { kind: 'unavailable', reason: 'enoent' };
    tracker.maybeRefresh();
    await flush();

    expect(tracker.burnSamples()).toHaveLength(1);
  });

  it('prices the ring at read time from the rates handed in', async () => {
    let clock = 1_000_000;
    const { tracker, source } = makeTracker(() => clock);
    source.next = { kind: 'sample', usedTokens: 1, tokens: counters({ in: 0 }) };
    tracker.maybeRefresh();
    await flush();

    clock += HOUR;
    source.next = { kind: 'sample', usedTokens: 1, tokens: counters({ in: 1_000_000 }) };
    tracker.maybeRefresh();
    await flush();

    expect(tracker.burnPerHourUsd(RATES)).toBeCloseTo(5, 6);
    // Same ring, no rate card ⇒ `—`, not `$0`.
    expect(tracker.burnPerHourUsd(null)).toBeNull();
  });

  it('evicts beyond 72 h and caps by count, like the Lot 9 ring', async () => {
    let clock = 1_000_000;
    const { tracker, source } = makeTracker(() => clock);

    // One point now, one 73 h later: the first must be gone.
    source.next = { kind: 'sample', usedTokens: 1, tokens: counters({ in: 1 }) };
    tracker.maybeRefresh();
    await flush();
    clock += 73 * HOUR;
    source.next = { kind: 'sample', usedTokens: 2, tokens: counters({ in: 1 }) };
    tracker.maybeRefresh();
    await flush();
    expect(tracker.burnSamples()).toHaveLength(1);
    expect(tracker.burnSamples()[0]?.t).toBe(1_000_000 + 73 * HOUR);

    // Count cap: a pathological TTL cannot grow the ring past the ceiling.
    for (let i = 0; i < CONTEXT_HISTORY_MAX_SAMPLES + 50; i++) {
      clock += 1;
      source.next = { kind: 'sample', usedTokens: 3, tokens: counters({ in: 1 }) };
      tracker.maybeRefresh();
      await flush();
    }
    expect(tracker.burnSamples()).toHaveLength(CONTEXT_HISTORY_MAX_SAMPLES);
  });

  it('hands out copies — a caller cannot mutate the ring', async () => {
    const { tracker, source } = makeTracker(() => 1_000_000);
    source.next = { kind: 'sample', usedTokens: 1, tokens: counters({ in: 7 }) };
    tracker.maybeRefresh();
    await flush();
    const ring = tracker.burnSamples();
    ring[0]!.counters.in = 999_999;
    expect(tracker.burnSamples()[0]?.counters.in).toBe(7);
  });
});
