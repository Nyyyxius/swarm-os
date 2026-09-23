import { describe, it, expect } from 'vitest';
import {
  AUTO_COMPACT_INSTRUCTIONS,
  AUTO_COMPACT_MIN_GROWTH_PCT,
  decideAutoCompact,
  type AutoCompactInput,
} from './auto-compact.js';
import type { ContextUsageView } from './session.js';

/**
 * docs/auto-compact.md D3 — the decision, on its own.
 *
 * Everything about this feature that could be WRONG rather than merely late
 * lives in this function: compacting an agent mid-dialog, compacting one that
 * has unread mail, compacting on a figure that describes a context that no
 * longer exists, or compacting the same agent forever because its floor is
 * already above its threshold. Each of those is one refusal below, and the
 * ORDER of the refusals is part of the contract — the reason an operator reads
 * is the first thing that stopped the arming.
 */

const LIMIT = 200_000;

function usage(over: Partial<ContextUsageView> = {}): ContextUsageView {
  const usedTokens = over.usedTokens ?? 80_000;
  return {
    usedTokens,
    limitTokens: LIMIT,
    pct: usedTokens / LIMIT,
    basis: 'transcript',
    updatedAt: new Date().toISOString(),
    stale: false,
    ...over,
  };
}

function input(over: Partial<AutoCompactInput> = {}): AutoCompactInput {
  return {
    thresholdPct: 35,
    usage: usage(),
    floorTokens: null,
    inboxCount: 0,
    resetPending: false,
    dialogPending: false,
    ...over,
  };
}

describe('decideAutoCompact — it fires', () => {
  it('fires at the threshold with an empty inbox and a free line', () => {
    // 80 000 / 200 000 = 40 % ≥ 35 %.
    expect(decideAutoCompact(input())).toEqual({ fire: true, pct: 40 });
  });

  it('fires EXACTLY at the threshold — the comparison is >=, not >', () => {
    expect(decideAutoCompact(input({ usage: usage({ usedTokens: 70_000 }) }))).toEqual({
      fire: true,
      pct: 35,
    });
  });

  it('rounds pct once, and reports the very figure it compared', () => {
    // 69 000/200 000 = 34.5 % → rounds to 35 → fires, and says 35.
    expect(decideAutoCompact(input({ usage: usage({ usedTokens: 69_000 }) }))).toEqual({
      fire: true,
      pct: 35,
    });
    // 68 900 → 34.45 % → rounds to 34 → refused. No answer can carry a `pct`
    // that fails its own test.
    expect(decideAutoCompact(input({ usage: usage({ usedTokens: 68_900 }) }))).toEqual({
      fire: false,
      reason: 'below-threshold',
    });
  });

  it('reads pct as a FRACTION 0..1, not a percentage', () => {
    // The classic misread: `usage.pct` is 0.40, and a threshold test written
    // against it directly would never fire below 100 %.
    const u = usage({ usedTokens: 80_000 });
    expect(u.pct).toBeCloseTo(0.4);
    expect(decideAutoCompact(input({ usage: u, thresholdPct: 35 }))).toMatchObject({ fire: true });
  });
});

describe('decideAutoCompact — disabled', () => {
  it('refuses on 0 — the documented kill switch', () => {
    expect(decideAutoCompact(input({ thresholdPct: 0 }))).toEqual({
      fire: false,
      reason: 'disabled',
    });
  });

  it('refuses on undefined — the partial Config every test builds', () => {
    // `undefined <= 0` is `false`, so without `Number.isInteger` every suite
    // that casts a partial `Config` would fall through to a live `/compact` on
    // a comparison against NaN.
    const bad = input();
    (bad as { thresholdPct: unknown }).thresholdPct = undefined;
    expect(decideAutoCompact(bad)).toEqual({ fire: false, reason: 'disabled' });
  });

  it('refuses on a non-integer or non-finite threshold', () => {
    for (const v of [3.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(decideAutoCompact(input({ thresholdPct: v }))).toEqual({
        fire: false,
        reason: 'disabled',
      });
    }
  });
});

describe('decideAutoCompact — the refusals, in order', () => {
  it('reset-pending outranks everything else', () => {
    // Mono-occupancy: a reset is already armed (the agent compacted itself, or
    // the operator pressed COMPACT), so this boundary belongs to it.
    expect(
      decideAutoCompact(input({ resetPending: true, dialogPending: true, inboxCount: 3 })),
    ).toEqual({ fire: false, reason: 'reset-pending' });
  });

  it('blocked outranks the inbox', () => {
    expect(decideAutoCompact(input({ dialogPending: true, inboxCount: 3 }))).toEqual({
      fire: false,
      reason: 'blocked',
    });
  });

  it('inbox-pending outranks the measurement', () => {
    expect(decideAutoCompact(input({ inboxCount: 1, usage: null }))).toEqual({
      fire: false,
      reason: 'inbox-pending',
    });
  });

  it('no-usage when nothing was ever measured (gemini, TTL 0, fresh session)', () => {
    expect(decideAutoCompact(input({ usage: null }))).toEqual({
      fire: false,
      reason: 'no-usage',
    });
  });

  it('no-usage when the model window is unknown — never a made-up denominator', () => {
    expect(
      decideAutoCompact(input({ usage: usage({ limitTokens: null, pct: null }) })),
    ).toEqual({ fire: false, reason: 'no-usage' });
  });

  it('stale — a figure known not to describe the live context', () => {
    // Waiting one TTL costs one boundary; acting on it costs a compaction of a
    // context that was already reset.
    expect(decideAutoCompact(input({ usage: usage({ stale: true }) }))).toEqual({
      fire: false,
      reason: 'stale',
    });
  });

  it('below-threshold — the ordinary answer', () => {
    expect(decideAutoCompact(input({ usage: usage({ usedTokens: 20_000 }) }))).toEqual({
      fire: false,
      reason: 'below-threshold',
    });
  });
});

describe('decideAutoCompact — not-grown, the anti-loop', () => {
  it('refuses when growth since the floor is under 10 points of the window', () => {
    // Floor 60 % of a 200k window, now 65 %: five points of new conversation.
    // Compacting here would summarise almost nothing and cost a model call.
    expect(
      decideAutoCompact(
        input({ usage: usage({ usedTokens: 130_000 }), floorTokens: 120_000 }),
      ),
    ).toEqual({ fire: false, reason: 'not-grown' });
  });

  it('fires again once 10 points HAVE been added', () => {
    expect(
      decideAutoCompact(
        input({ usage: usage({ usedTokens: 140_000 }), floorTokens: 120_000 }),
      ),
    ).toEqual({ fire: true, pct: 70 });
  });

  it('measures growth in TOKENS against the real window, not in percent', () => {
    // Same 10-point rule, a quarter of the window: 10 % of 50 000 is 5 000.
    const small = (used: number): ContextUsageView => ({
      usedTokens: used,
      limitTokens: 50_000,
      pct: used / 50_000,
      basis: 'transcript',
      updatedAt: new Date().toISOString(),
      stale: false,
    });
    expect(
      decideAutoCompact(input({ usage: small(24_000), floorTokens: 20_000, thresholdPct: 35 })),
    ).toEqual({ fire: false, reason: 'not-grown' });
    expect(
      decideAutoCompact(input({ usage: small(25_500), floorTokens: 20_000, thresholdPct: 35 })),
    ).toMatchObject({ fire: true });
  });

  it('absorbs the pre-compaction figure claude re-serves after a /compact', () => {
    // §2 of the plan: the transcript is rewritten IN PLACE and the gauge serves
    // the pre-compaction number as fresh for a turn. The floor is the MINIMUM
    // since the reset, so that reading yields growth 0 and nothing re-fires.
    expect(
      decideAutoCompact(
        input({ usage: usage({ usedTokens: 130_000 }), floorTokens: 130_000 }),
      ),
    ).toEqual({ fire: false, reason: 'not-grown' });
  });

  it('is skipped entirely when no floor exists yet (first measurement)', () => {
    // A session that has never been reset has no floor: the hysteresis has
    // nothing to hold back, and a first compaction at the threshold is exactly
    // what was asked for.
    expect(decideAutoCompact(input({ floorTokens: null }))).toEqual({ fire: true, pct: 40 });
  });

  it('is checked AFTER the threshold — the reason names what came first', () => {
    expect(
      decideAutoCompact(
        input({ usage: usage({ usedTokens: 20_000 }), floorTokens: 19_000 }),
      ),
    ).toEqual({ fire: false, reason: 'below-threshold' });
  });
});

describe('AUTO_COMPACT_INSTRUCTIONS', () => {
  it('is ONE line — a CR would submit the slash command half-typed', () => {
    expect(AUTO_COMPACT_INSTRUCTIONS).not.toMatch(/[\r\n]/);
  });

  it('names the state a summary destroys, and points back at the inbox', () => {
    expect(AUTO_COMPACT_INSTRUCTIONS).toContain('team.read_inbox');
    expect(AUTO_COMPACT_INSTRUCTIONS).toContain('role');
  });
});

describe('AUTO_COMPACT_MIN_GROWTH_PCT', () => {
  it('is the documented 10 points', () => {
    expect(AUTO_COMPACT_MIN_GROWTH_PCT).toBe(10);
  });
});
