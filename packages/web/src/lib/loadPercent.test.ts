// S10 — Tests for `loadPercent.ts`.
//
// Two concerns:
//   1. The v1 guard-rail: every "no signal" shape (null, undefined, NaN,
//      Infinity) MUST render the em-dash placeholder, NEVER a `%` value.
//      This is the editorial contract — see
//      `docs/update_system/10_load_percent.md`.
//   2. The forward-compat numeric branch (kept for option (b)): finite
//      numbers are formatted as `XX%`, clamped to `[0, 100]`, with the
//      em-dash never appearing alongside `%`.
//
// The "no `%` near `LOAD`" regression-guard from §6 of the doc lives in
// the future ProcessPanel test once the stat-bar is ported; this file
// exercises the helper in isolation.

import { describe, it, expect } from 'vitest';
import { LOAD_PLACEHOLDER, formatLoadPercent } from './loadPercent';

describe('LOAD_PLACEHOLDER', () => {
  it('is the U+2014 em-dash (not the ASCII hyphen)', () => {
    expect(LOAD_PLACEHOLDER).toBe('—');
    expect(LOAD_PLACEHOLDER).not.toBe('-');
    expect(LOAD_PLACEHOLDER.charCodeAt(0)).toBe(0x2014);
  });
});

describe('formatLoadPercent — v1 guard-rail (no signal)', () => {
  it('returns em-dash for undefined (the v1 default — no backend source)', () => {
    expect(formatLoadPercent(undefined)).toBe(LOAD_PLACEHOLDER);
  });

  it('returns em-dash for null', () => {
    expect(formatLoadPercent(null)).toBe(LOAD_PLACEHOLDER);
  });

  it('returns em-dash for NaN (defensive against bad upstream parsing)', () => {
    expect(formatLoadPercent(Number.NaN)).toBe(LOAD_PLACEHOLDER);
  });

  it('returns em-dash for +Infinity', () => {
    expect(formatLoadPercent(Number.POSITIVE_INFINITY)).toBe(LOAD_PLACEHOLDER);
  });

  it('returns em-dash for -Infinity', () => {
    expect(formatLoadPercent(Number.NEGATIVE_INFINITY)).toBe(LOAD_PLACEHOLDER);
  });

  it('never returns a string containing "%" when no signal is available', () => {
    for (const v of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatLoadPercent(v as number | null | undefined)).not.toContain('%');
    }
  });
});

describe('formatLoadPercent — forward-compat numeric branch (option b)', () => {
  it('formats 0 as "0%"', () => {
    expect(formatLoadPercent(0)).toBe('0%');
  });

  it('formats 1 as "100%"', () => {
    expect(formatLoadPercent(1)).toBe('100%');
  });

  it('rounds to the nearest integer', () => {
    expect(formatLoadPercent(0.5)).toBe('50%');
    expect(formatLoadPercent(0.625)).toBe('63%');
    expect(formatLoadPercent(0.624)).toBe('62%');
  });

  it('clamps negative values to 0%', () => {
    expect(formatLoadPercent(-0.5)).toBe('0%');
  });

  it('clamps values > 1 to 100%', () => {
    expect(formatLoadPercent(1.5)).toBe('100%');
    expect(formatLoadPercent(42)).toBe('100%');
  });

  it('never returns a string containing the em-dash when given a finite number', () => {
    for (const v of [0, 0.1, 0.5, 0.999, 1, -1, 2]) {
      expect(formatLoadPercent(v)).not.toContain(LOAD_PLACEHOLDER);
    }
  });
});
