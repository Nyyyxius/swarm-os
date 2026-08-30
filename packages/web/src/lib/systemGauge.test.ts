/**
 * Monitoring Lot 10 — the pure half of the system gauges.
 *
 * What is worth asserting here is not "toFixed works" but the three
 * properties the widget's honesty rests on:
 *
 *   1. No measurement produces NO arc and NO number — never a `0 %` that an
 *      operator would read as "the container is idle".
 *   2. The threshold boundaries are the SAME ones the CTX cells use, and they
 *      are inclusive on the upper bucket. A gauge that turned amber at 0.71
 *      while the table next to it turned at 0.70 would make the colour
 *      language meaningless.
 *   3. The dash length is a real fraction of the drawn path, so a 50 %
 *      reading actually points straight up.
 */
import { describe, it, expect } from 'vitest';
import {
  GAUGE_ARC_LENGTH, NO_CGROUP_DATA, cpuSubLabel, formatBytesShort,
  formatGaugePercent, gaugeArcColor, gaugeArcDash, gaugeTextColor,
  memorySubLabel,
} from './systemGauge';
import { contextLevel } from './contextPercent';

// ── geometry ────────────────────────────────────────────────────────────────

describe('gaugeArcDash', () => {
  it('is πr long — the half-circumference of the artboard path', () => {
    // `M8 44 A34 34 0 0 1 76 44` — radius 34, 180°.
    expect(GAUGE_ARC_LENGTH).toBeCloseTo(106.81, 2);
  });

  it('maps a fraction to that fraction of the drawn path', () => {
    const half = gaugeArcDash(0.5)!;
    const [dash, gap] = half.split(' ').map(Number);
    expect(dash).toBeCloseTo(GAUGE_ARC_LENGTH / 2, 2);
    // The gap swallows the whole path, so no second dash can ever appear.
    expect(gap).toBeCloseTo(GAUGE_ARC_LENGTH, 2);
  });

  it('fills the arc exactly at 1 and leaves it empty at 0', () => {
    expect(Number(gaugeArcDash(1)!.split(' ')[0])).toBeCloseTo(GAUGE_ARC_LENGTH, 2);
    expect(Number(gaugeArcDash(0)!.split(' ')[0])).toBe(0);
  });

  it('clamps out-of-range readings instead of painting past the cap', () => {
    expect(Number(gaugeArcDash(1.4)!.split(' ')[0])).toBeCloseTo(GAUGE_ARC_LENGTH, 2);
    expect(Number(gaugeArcDash(-0.2)!.split(' ')[0])).toBe(0);
  });

  it('returns null — not a zero-length dash — when there is no reading', () => {
    // This is what makes "track only" structural rather than cosmetic.
    expect(gaugeArcDash(null)).toBeNull();
    expect(gaugeArcDash(undefined)).toBeNull();
    expect(gaugeArcDash(Number.NaN)).toBeNull();
    expect(gaugeArcDash(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ── thresholds ──────────────────────────────────────────────────────────────

describe('gauge thresholds', () => {
  it('buckets on the shared boundaries, inclusive upward', () => {
    expect(contextLevel(0.6999)).toBe('ok');
    expect(contextLevel(0.7)).toBe('warn');
    expect(contextLevel(0.8999)).toBe('warn');
    expect(contextLevel(0.9)).toBe('bad');
  });

  it('colours the arc from the ok/warn/bad tokens', () => {
    expect(gaugeArcColor(contextLevel(0.10))).toBe('var(--ok)');
    expect(gaugeArcColor(contextLevel(0.7))).toBe('var(--warn)');
    expect(gaugeArcColor(contextLevel(0.9))).toBe('var(--bad)');
    expect(gaugeArcColor(contextLevel(null))).toBe('var(--text-mute)');
  });

  it('keeps the percentage in the text token while ok, then adopts the threshold', () => {
    // A band of green numerals would make "all fine" the loudest thing here.
    expect(gaugeTextColor(contextLevel(0.10))).toBe('var(--text)');
    expect(gaugeTextColor(contextLevel(0.6999))).toBe('var(--text)');
    expect(gaugeTextColor(contextLevel(0.7))).toBe('var(--warn)');
    expect(gaugeTextColor(contextLevel(0.9))).toBe('var(--bad)');
    expect(gaugeTextColor(contextLevel(null))).toBe('var(--text-mute)');
  });
});

describe('formatGaugePercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatGaugePercent(0.574)).toBe('57%');
    expect(formatGaugePercent(0.576)).toBe('58%');
  });

  it('renders the em-dash, never 0 %, when there is no reading', () => {
    expect(formatGaugePercent(null)).toBe('—');
    expect(formatGaugePercent(undefined)).toBe('—');
  });

  it('clamps rather than printing an impossible 142 %', () => {
    expect(formatGaugePercent(1.42)).toBe('100%');
    expect(formatGaugePercent(-0.5)).toBe('0%');
  });
});

// ── byte formatting ─────────────────────────────────────────────────────────

describe('formatBytesShort', () => {
  it('uses binary units so an 8 GiB cgroup limit reads 8.0G', () => {
    expect(formatBytesShort(8 * 1024 ** 3)).toBe('8.0G');
    expect(formatBytesShort(6.2 * 1024 ** 3)).toBe('6.2G');
  });

  it('steps down through M, K and raw bytes', () => {
    expect(formatBytesShort(512 * 1024 ** 2)).toBe('512.0M');
    expect(formatBytesShort(48 * 1024)).toBe('48.0K');
    expect(formatBytesShort(900)).toBe('900B');
    expect(formatBytesShort(0)).toBe('0B');
  });

  it('switches unit exactly at the boundary', () => {
    expect(formatBytesShort(1024 ** 3 - 1)).toBe('1024.0M');
    expect(formatBytesShort(1024 ** 3)).toBe('1.0G');
  });

  it('em-dashes anything that is not a real size', () => {
    expect(formatBytesShort(null)).toBe('—');
    expect(formatBytesShort(undefined)).toBe('—');
    expect(formatBytesShort(-1)).toBe('—');
    expect(formatBytesShort(Number.NaN)).toBe('—');
  });
});

// ── sub-labels ──────────────────────────────────────────────────────────────

describe('cpuSubLabel', () => {
  it('shows the cores in use against the cores available', () => {
    expect(cpuSubLabel({ pct: 0.35, cores: 4, basis: 'cgroup' })).toBe('1.4 / 4.0 CORES');
  });

  it('still names the core count while the first delta is being sampled', () => {
    // The sampler needs two `cpu.stat` reads; `— / 4.0 CORES` for those three
    // seconds is truer than an empty line.
    expect(cpuSubLabel({ pct: null, cores: 4, basis: 'host' })).toBe('— / 4.0 CORES');
  });

  it('returns null — the caller says NO CGROUP DATA — when nothing is known', () => {
    expect(cpuSubLabel({ pct: null, cores: null, basis: null })).toBeNull();
    expect(cpuSubLabel(null)).toBeNull();
    expect(cpuSubLabel(undefined)).toBeNull();
  });
});

describe('memorySubLabel', () => {
  it('shows used against the limit the percentage came from', () => {
    expect(memorySubLabel({
      usedBytes: 6.2 * 1024 ** 3,
      limitBytes: 8 * 1024 ** 3,
      pct: 0.775,
      basis: 'cgroup',
    })).toBe('6.2G / 8.0G');
  });

  it('prints what it has when only one half is readable', () => {
    expect(memorySubLabel({
      usedBytes: 6.2 * 1024 ** 3, limitBytes: null, pct: null, basis: null,
    })).toBe('6.2G / —');
  });

  it('returns null when nothing is known', () => {
    expect(memorySubLabel({
      usedBytes: null, limitBytes: null, pct: null, basis: null,
    })).toBeNull();
    expect(memorySubLabel(null)).toBeNull();
  });

  it('has a placeholder the component can fall back to', () => {
    expect(NO_CGROUP_DATA).toBe('NO CGROUP DATA');
  });
});
