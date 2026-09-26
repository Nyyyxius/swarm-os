// Tests for `contextPercent.ts` — the CTX formatting contract.
//
// This file inherits the concerns of the deleted `loadPercent.test.ts`: the
// editorial guard-rail (every "no signal" shape renders the em-dash, NEVER a
// fabricated `%`) now applies to a metric that IS measured for some
// providers and never for others (gemini), so the two branches — real number
// vs `—` — must both be locked down.
//
// The threshold table is the second contract: `ok < 0.7 ≤ warn < 0.9 ≤ bad`.
// Off-by-one on a boundary paints an agent green at 90% of its window, which
// is exactly the state an operator needs to see in red.

import { describe, it, expect } from 'vitest';
import {
  CONTEXT_BAD_AT,
  CONTEXT_PLACEHOLDER,
  CONTEXT_WARN_AT,
  contextBarWidth,
  contextColorVar,
  contextLevel,
  formatContextPercent,
  formatContextTokens,
  formatTokensShort, contextResetTag,
} from './contextPercent';

describe('CONTEXT_PLACEHOLDER', () => {
  it('is the U+2014 em-dash (not the ASCII hyphen)', () => {
    expect(CONTEXT_PLACEHOLDER).toBe('—');
    expect(CONTEXT_PLACEHOLDER).not.toBe('-');
    expect(CONTEXT_PLACEHOLDER.charCodeAt(0)).toBe(0x2014);
  });
});

describe('contextLevel — thresholds', () => {
  it('buckets ok below the warn threshold', () => {
    expect(contextLevel(0)).toBe('ok');
    expect(contextLevel(0.42)).toBe('ok');
    expect(contextLevel(0.6999)).toBe('ok');
  });

  it('treats the warn threshold as inclusive (0.7 is already WARN)', () => {
    expect(contextLevel(CONTEXT_WARN_AT)).toBe('warn');
    expect(contextLevel(0.7)).toBe('warn');
    expect(contextLevel(0.8999)).toBe('warn');
  });

  it('treats the bad threshold as inclusive (0.9 is already BAD)', () => {
    expect(contextLevel(CONTEXT_BAD_AT)).toBe('bad');
    expect(contextLevel(0.9)).toBe('bad');
    expect(contextLevel(1)).toBe('bad');
  });

  it('returns null for every "no measurement" shape', () => {
    expect(contextLevel(null)).toBeNull();
    expect(contextLevel(undefined)).toBeNull();
    expect(contextLevel(Number.NaN)).toBeNull();
    expect(contextLevel(Number.POSITIVE_INFINITY)).toBeNull();
    expect(contextLevel(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('contextColorVar', () => {
  it('maps each bucket onto its design token', () => {
    expect(contextColorVar('ok')).toBe('var(--ok)');
    expect(contextColorVar('warn')).toBe('var(--warn)');
    expect(contextColorVar('bad')).toBe('var(--bad)');
  });

  it('paints "no signal" with the muted text token, not a status colour', () => {
    expect(contextColorVar(null)).toBe('var(--text-mute)');
  });
});

describe('formatContextPercent — guard-rail (no signal)', () => {
  it.each([
    ['undefined (field absent — backend predates Lot 2)', undefined],
    ['null (gemini / provider without telemetry)', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('returns the em-dash for %s', (_label, value) => {
    expect(formatContextPercent(value as number | null | undefined))
      .toBe(CONTEXT_PLACEHOLDER);
  });

  it('never emits a percent sign when there is no measurement', () => {
    for (const v of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatContextPercent(v as number | null | undefined))
        .not.toContain('%');
    }
  });
});

describe('formatContextPercent — numeric branch', () => {
  it('rounds to the nearest integer percent', () => {
    expect(formatContextPercent(0)).toBe('0%');
    expect(formatContextPercent(0.5)).toBe('50%');
    expect(formatContextPercent(0.784)).toBe('78%');
    expect(formatContextPercent(0.786)).toBe('79%');
    expect(formatContextPercent(1)).toBe('100%');
  });

  it('clamps out-of-range values instead of painting 142%', () => {
    expect(formatContextPercent(1.42)).toBe('100%');
    expect(formatContextPercent(-0.3)).toBe('0%');
  });
});

describe('contextBarWidth', () => {
  it('is the clamped percentage for a measurement', () => {
    expect(contextBarWidth(0.5)).toBe(50);
    expect(contextBarWidth(1.4)).toBe(100);
    expect(contextBarWidth(-1)).toBe(0);
  });

  it('is 0 (empty bar, not a missing bar) with no measurement', () => {
    expect(contextBarWidth(null)).toBe(0);
    expect(contextBarWidth(undefined)).toBe(0);
  });
});

describe('formatTokensShort', () => {
  it('leaves counts below 1000 verbatim', () => {
    expect(formatTokensShort(0)).toBe('0');
    expect(formatTokensShort(847)).toBe('847');
  });

  it('uses an upper-case K above 1000', () => {
    expect(formatTokensShort(1_000)).toBe('1K');
    expect(formatTokensShort(156_400)).toBe('156K');
    expect(formatTokensShort(199_999)).toBe('200K');
  });

  it('uses M above a million', () => {
    expect(formatTokensShort(1_000_000)).toBe('1.0M');
    expect(formatTokensShort(2_450_000)).toBe('2.5M');
  });

  it('returns the em-dash for absent / nonsense counts', () => {
    expect(formatTokensShort(null)).toBe(CONTEXT_PLACEHOLDER);
    expect(formatTokensShort(undefined)).toBe(CONTEXT_PLACEHOLDER);
    expect(formatTokensShort(Number.NaN)).toBe(CONTEXT_PLACEHOLDER);
    expect(formatTokensShort(-5)).toBe(CONTEXT_PLACEHOLDER);
  });
});

describe('formatContextTokens', () => {
  it('renders the used/limit pair', () => {
    expect(formatContextTokens(156_000, 200_000)).toBe('156K/200K');
  });

  it('keeps the measured half when the model limit is unknown', () => {
    // `limitTokens: null` = model absent from models.dev AND from the pinned
    // per-model fallbacks. We still measured the usage; hiding it would throw
    // away the only real number we have.
    expect(formatContextTokens(156_000, null)).toBe('156K/—');
  });

  it('returns null (drop the whole label) when nothing was measured', () => {
    expect(formatContextTokens(null, 200_000)).toBeNull();
    expect(formatContextTokens(undefined, undefined)).toBeNull();
    expect(formatContextTokens(Number.NaN, 200_000)).toBeNull();
  });
});

describe('contextResetTag (v0.10.3)', () => {
  it('names the reset while no call has been read since, nothing otherwise', () => {
    expect(contextResetTag({ awaitingCall: 'compact' })).toBe('COMPACTED · NEXT CALL');
    expect(contextResetTag({ awaitingCall: 'clear' })).toBe('CLEARED · NEXT CALL');
    expect(contextResetTag({})).toBeNull();
    expect(contextResetTag(null)).toBeNull();
  });

  it('renders no figure for the reset state (usedTokens null)', () => {
    expect(formatContextTokens(null, 200_000)).toBeNull();
  });
});
