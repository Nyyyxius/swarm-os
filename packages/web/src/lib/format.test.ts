// Unit tests for the format.ts helpers added in Step 4 (Phase B.4).
// The existing helpers (formatUptime, formatRelative, formatClock,
// formatClockShort, statusLabel, statusChipClass) are exercised
// indirectly by other tests; here we focus on the new ones.

import { describe, it, expect } from 'vitest';
import { formatMsgCount, formatUptimeShort, statusChipClass } from './format';

describe('formatMsgCount', () => {
  it('returns "0" for 0', () => {
    expect(formatMsgCount(0)).toBe('0');
  });
  it('returns plain int below threshold', () => {
    expect(formatMsgCount(42)).toBe('42');
    expect(formatMsgCount(999)).toBe('999');
  });
  it('formats Nk above 999', () => {
    expect(formatMsgCount(1000)).toBe('1.0k');
    expect(formatMsgCount(1234)).toBe('1.2k');
    expect(formatMsgCount(12345)).toBe('12.3k');
  });
  it('formats NM above 999_999', () => {
    expect(formatMsgCount(1_000_000)).toBe('1.0M');
    expect(formatMsgCount(2_500_000)).toBe('2.5M');
  });
  it('handles non-finite / negative gracefully', () => {
    expect(formatMsgCount(NaN)).toBe('0');
    expect(formatMsgCount(-5)).toBe('0');
    expect(formatMsgCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatUptimeShort', () => {
  it('returns "—" for null/undefined/invalid', () => {
    expect(formatUptimeShort(null)).toBe('—');
    expect(formatUptimeShort(undefined)).toBe('—');
    expect(formatUptimeShort('not-a-date')).toBe('—');
  });
  it('returns "0m" for < 1 min', () => {
    expect(formatUptimeShort(Date.now() - 30_000)).toBe('0m');
  });
  it('returns "Xm" for minutes only', () => {
    expect(formatUptimeShort(Date.now() - 15 * 60_000)).toBe('15m');
  });
  it('returns "Xh Ym" for hours + minutes', () => {
    expect(formatUptimeShort(Date.now() - (3 * 60 + 25) * 60_000))
      .toBe('3h 25m');
  });
  it('returns "Xd Yh" beyond 24h', () => {
    expect(formatUptimeShort(Date.now() - (2 * 24 + 5) * 3600_000))
      .toBe('2d 5h');
  });
  it('accepts an ISO string', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatUptimeShort(iso)).toBe('5m');
  });
});

describe('statusChipClass', () => {
  it('maps paused to warn (was falling through to ok before)', () => {
    expect(statusChipClass('paused')).toBe('warn');
  });
  it('keeps running as ok', () => {
    expect(statusChipClass('running')).toBe('ok');
  });
  it('keeps terminal statuses as stopped', () => {
    expect(statusChipClass('exited')).toBe('stopped');
    expect(statusChipClass('killed')).toBe('stopped');
  });
  it('keeps failed as bad', () => {
    expect(statusChipClass('failed')).toBe('bad');
  });
});
