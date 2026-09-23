// Unit tests for the pure half of the per-role auto-compact threshold
// (docs/auto-compact.md, Lot 2).
//
// The whole risk is that three states collapse into two. `null` (inherit),
// `0` (never compact this role) and `1..100` all travel through the same
// nullable integer, and each confusion has a visible consequence:
//
//   1. `0` read as "empty" silently puts a role the operator took out of
//      auto-compact back under the instance default;
//   2. an empty field read as `0` disables a role nobody asked to disable;
//   3. a value the server would 400 on (`3.5`, `"35 %"`, `101`) must never be
//      coerced into something that looks saved.
//
// The read-only line is asserted here rather than through a RolesPage render:
// the page has no test harness, and this is where its sentence is built.

import { describe, it, expect } from 'vitest';
import {
  autoCompactFieldValue,
  autoCompactSummary,
  parseAutoCompactPct,
  AUTO_COMPACT_ERROR,
  DEFAULT_AUTO_COMPACT_PCT,
} from './autoCompact';

describe('parseAutoCompactPct', () => {
  it('reads an empty field as "inherit", not as an error and not as 0', () => {
    expect(parseAutoCompactPct('')).toEqual({ ok: true, value: null });
    expect(parseAutoCompactPct('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts the whole 0..100 range, 0 being the per-role opt-out', () => {
    expect(parseAutoCompactPct('0')).toEqual({ ok: true, value: 0 });
    expect(parseAutoCompactPct('35')).toEqual({ ok: true, value: 35 });
    expect(parseAutoCompactPct('100')).toEqual({ ok: true, value: 100 });
  });

  it('accepts a trailing % — what an operator re-typing the line types', () => {
    expect(parseAutoCompactPct('40 %')).toEqual({ ok: true, value: 40 });
    expect(parseAutoCompactPct('40%')).toEqual({ ok: true, value: 40 });
  });

  it('refuses what the server refuses instead of rounding it', () => {
    for (const bad of ['101', '3.5', '-5', '1e2', '35abc', 'abc', '1000']) {
      expect(parseAutoCompactPct(bad)).toEqual({ ok: false, error: AUTO_COMPACT_ERROR });
    }
  });
});

describe('autoCompactFieldValue', () => {
  it('keeps 0 visible as "0" — never collapsed to an empty (inheriting) field', () => {
    expect(autoCompactFieldValue(0)).toBe('0');
  });

  it('renders a stored threshold, and nothing at all for inherit', () => {
    expect(autoCompactFieldValue(35)).toBe('35');
    expect(autoCompactFieldValue(null)).toBe('');
    expect(autoCompactFieldValue(undefined)).toBe('');
  });

  it('treats a value the server should never have sent as inherit', () => {
    expect(autoCompactFieldValue(3.5)).toBe('');
    expect(autoCompactFieldValue(101)).toBe('');
    expect(autoCompactFieldValue(-1)).toBe('');
  });
});

describe('autoCompactSummary', () => {
  it('names the inherited value rather than the word "inherit" alone', () => {
    expect(autoCompactSummary(null, 35)).toBe('Hérite (35 %)');
    expect(autoCompactSummary(undefined, 20)).toBe('Hérite (20 %)');
  });

  it('falls back to the documented default when the server sent none', () => {
    expect(autoCompactSummary(null)).toBe(`Hérite (${DEFAULT_AUTO_COMPACT_PCT} %)`);
  });

  it('says so when the instance itself has auto-compact off', () => {
    expect(autoCompactSummary(null, 0)).toBe('Hérite (désactivé)');
  });

  it('distinguishes a disabled role from an inheriting one', () => {
    expect(autoCompactSummary(0, 35)).toBe('Désactivé');
    expect(autoCompactSummary(50, 35)).toBe('50 %');
  });
});
