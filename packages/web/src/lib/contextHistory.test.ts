// Tests for `contextHistory.ts` — the maths behind the CONTEXT HISTORY band
// (docs/monitoring-agents.md, Lot 9).
//
// A chart is the easiest place in a UI to be confidently wrong: an inverted
// axis, a threshold drawn against the wrong ceiling or a downsampler that
// averages away a `/compact` cliff all render as a perfectly plausible
// picture. So the contracts locked here are the ones an operator would act
// on:
//
//   1. Percent scale ONLY with a known window; raw tokens otherwise, and
//      then NO threshold lines at all (a 70% line needs a 100% to mean
//      anything).
//   2. Downsampling keeps min/max/last — never an average.
//   3. X is mapped by TIME, so a reset marker lands on its real instant and
//      an idle gap stays a gap.
//   4. The crosshair snaps to the nearest bucket in X, deterministically.

import { describe, it, expect } from 'vitest';
import {
  buildContextChart,
  CONTEXT_HISTORY_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  contextFraction,
  downsampleHistory,
  formatAxisTime,
  formatClock,
  formatSampleTime,
  nearestSampleIndex,
  normalizeContextSpark,
} from './contextHistory';
import type { ContextHistoryPoint, ContextHistoryReset } from '../api/client';

const T0 = Date.parse('2026-08-30T10:00:00.000Z');
const MIN = 60_000;

/** `n` buckets one minute apart, flat unless `at` says otherwise. */
function series(values: number[], stepMs = MIN): ContextHistoryPoint[] {
  return values.map((v, i) => ({
    t: new Date(T0 + i * stepMs).toISOString(),
    min: v,
    max: v,
    last: v,
  }));
}

const BOX = { width: 800, height: 200 };

describe('window selector', () => {
  it('offers exactly the three windows the server accepts', () => {
    expect(CONTEXT_HISTORY_WINDOWS.map((w) => w.key)).toEqual(['1h', '24h', '3d']);
    expect(CONTEXT_HISTORY_WINDOWS.map((w) => w.label)).toEqual(['1H', '24H', '3D']);
  });

  it('defaults to 24H', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe('24h');
  });
});

describe('normalizeContextSpark', () => {
  it('passes a clean series through', () => {
    expect(normalizeContextSpark([10, 20, 30])).toEqual([10, 20, 30]);
  });

  it('returns null for every "no series" shape', () => {
    expect(normalizeContextSpark(undefined)).toBeNull();
    expect(normalizeContextSpark(null)).toBeNull();
    expect(normalizeContextSpark([])).toBeNull();
  });

  it('refuses a single reading (no direction, and Sparkline would divide by zero)', () => {
    expect(normalizeContextSpark([42])).toBeNull();
    expect(normalizeContextSpark([Number.NaN, 42])).toBeNull();
  });

  it('drops non-finite entries instead of poisoning the whole series', () => {
    expect(normalizeContextSpark([10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30]))
      .toEqual([10, 20, 30]);
  });

  it('clamps to 0-100 so a drifting backend cannot stretch the autoscale', () => {
    expect(normalizeContextSpark([-5, 250, 50])).toEqual([0, 100, 50]);
  });
});

describe('downsampleHistory', () => {
  it('returns the points untouched when they already fit', () => {
    const pts = series([1, 2, 3]);
    expect(downsampleHistory(pts, 10)).toEqual(pts);
  });

  it('keeps the extremes of each merged group — never an average', () => {
    const pts: ContextHistoryPoint[] = [
      { t: new Date(T0).toISOString(), min: 10, max: 90, last: 20 },
      { t: new Date(T0 + MIN).toISOString(), min: 5, max: 40, last: 30 },
      { t: new Date(T0 + 2 * MIN).toISOString(), min: 50, max: 60, last: 55 },
      { t: new Date(T0 + 3 * MIN).toISOString(), min: 51, max: 70, last: 65 },
    ];
    const out = downsampleHistory(pts, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      t: new Date(T0 + MIN).toISOString(), min: 5, max: 90, last: 30,
    });
    expect(out[1]).toEqual({
      t: new Date(T0 + 3 * MIN).toISOString(), min: 50, max: 70, last: 65,
    });
  });

  it('never exceeds the cap, whatever the input length', () => {
    for (const n of [7, 11, 100, 301]) {
      expect(downsampleHistory(series(new Array(n).fill(1)), 20).length)
        .toBeLessThanOrEqual(20);
    }
  });

  it('timestamps a merged bucket with its LAST sample (X stays monotone)', () => {
    const out = downsampleHistory(series([1, 2, 3, 4]), 2);
    expect(out.map((p) => p.t)).toEqual([
      new Date(T0 + MIN).toISOString(),
      new Date(T0 + 3 * MIN).toISOString(),
    ]);
  });
});

describe('contextFraction', () => {
  it('divides used by the window', () => {
    expect(contextFraction(50_000, 200_000)).toBeCloseTo(0.25);
  });

  it('has no answer without a known window', () => {
    expect(contextFraction(50_000, null)).toBeNull();
    expect(contextFraction(50_000, 0)).toBeNull();
  });

  it('clamps to 0-1', () => {
    expect(contextFraction(300_000, 200_000)).toBe(1);
    expect(contextFraction(-10, 200_000)).toBe(0);
  });
});

describe('buildContextChart — scale modes', () => {
  const points = series([50_000, 100_000, 150_000]);

  it('plots percentages when the model window is known', () => {
    const chart = buildContextChart({
      points, resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.mode).toBe('percent');
    expect(chart.yTicks.map((t) => t.label)).toEqual(['0%', '50%', '100%']);
  });

  it('draws BOTH thresholds, labelled, in percent mode', () => {
    const chart = buildContextChart({
      points, resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.thresholds.map((t) => t.label)).toEqual(['70%', '90%']);
    expect(chart.thresholds.map((t) => t.level)).toEqual(['warn', 'bad']);
    // 90% must sit ABOVE 70% on screen (smaller Y).
    expect(chart.thresholds[1]!.y).toBeLessThan(chart.thresholds[0]!.y);
  });

  it('falls back to raw tokens — and NO thresholds — without a window', () => {
    const chart = buildContextChart({
      points, resets: [], limitTokens: null, window: '24h', ...BOX,
    })!;
    expect(chart.mode).toBe('tokens');
    expect(chart.thresholds).toEqual([]);
    // Top of the axis is the highest value actually seen, not a guess.
    expect(chart.yTicks[2]!.label).toBe('150K');
    expect(chart.yTicks[0]!.label).toBe('0');
  });

  it('scales Y so a bigger reading sits higher on screen', () => {
    const chart = buildContextChart({
      points, resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    const ys = chart.samples.map((s) => s.y);
    expect(ys[0]!).toBeGreaterThan(ys[1]!);
    expect(ys[1]!).toBeGreaterThan(ys[2]!);
    // 50k/200k = 25% → three quarters of the way DOWN the plot.
    expect(ys[0]!).toBeCloseTo(chart.plot.y + chart.plot.h * 0.75, 5);
  });

  it('clamps a reading above its window instead of drawing off-plot', () => {
    const chart = buildContextChart({
      points: series([300_000, 300_000]),
      resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.samples[0]!.y).toBeCloseTo(chart.plot.y, 5);
  });
});

describe('buildContextChart — geometry', () => {
  it('returns null when there is nothing plottable', () => {
    expect(buildContextChart({
      points: [], resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })).toBeNull();
  });

  it('returns null rather than NaN geometry when every timestamp is garbage', () => {
    expect(buildContextChart({
      points: [{ t: 'not-a-date', min: 1, max: 2, last: 1 }],
      resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })).toBeNull();
  });

  it('spreads samples across the plot by TIME, not by index', () => {
    // Two buckets one minute apart, then a nine-minute idle gap.
    const points: ContextHistoryPoint[] = [
      ...series([10_000, 20_000]),
      { t: new Date(T0 + 10 * MIN).toISOString(), min: 30_000, max: 30_000, last: 30_000 },
    ];
    const chart = buildContextChart({
      points, resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    const [a, b, c] = chart.samples;
    expect(a!.x).toBeCloseTo(chart.plot.x, 5);
    expect(c!.x).toBeCloseTo(chart.plot.x + chart.plot.w, 5);
    // 1 of 10 minutes in: a tenth of the way across, NOT halfway.
    expect(b!.x).toBeCloseTo(chart.plot.x + chart.plot.w * 0.1, 5);
  });

  it('centres a lone sample instead of pinning it to the left edge', () => {
    const chart = buildContextChart({
      points: series([10_000]), resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.samples).toHaveLength(1);
    expect(chart.samples[0]!.x).toBeCloseTo(chart.plot.x + chart.plot.w / 2, 5);
    expect(chart.linePath.startsWith('M ')).toBe(true);
  });

  it('draws the min/max band only when a bucket actually spans a range', () => {
    const flat = buildContextChart({
      points: series([10_000, 20_000]), resets: [], limitTokens: 200_000,
      window: '24h', ...BOX,
    })!;
    expect(flat.bandPath).toBeNull();

    const spread = buildContextChart({
      points: [
        { t: new Date(T0).toISOString(), min: 10_000, max: 90_000, last: 20_000 },
        { t: new Date(T0 + MIN).toISOString(), min: 20_000, max: 25_000, last: 22_000 },
      ],
      resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(spread.bandPath).toBeTruthy();
    // The high edge of a bucket is drawn ABOVE its low edge.
    expect(spread.samples[0]!.yHigh).toBeLessThan(spread.samples[0]!.yLow);
  });

  it('closes the area path onto the baseline', () => {
    const chart = buildContextChart({
      points: series([10_000, 20_000]), resets: [], limitTokens: 200_000,
      window: '24h', ...BOX,
    })!;
    expect(chart.areaPath.endsWith('Z')).toBe(true);
    expect(chart.areaPath.startsWith(chart.linePath)).toBe(true);
  });

  it('never emits NaN coordinates', () => {
    const chart = buildContextChart({
      points: series([10_000, 20_000, 30_000]),
      resets: [{ t: new Date(T0 + MIN).toISOString(), cmd: 'compact' }],
      limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.linePath).not.toMatch(/NaN/);
    expect(chart.areaPath).not.toMatch(/NaN/);
    expect(chart.resets.every((r) => Number.isFinite(r.x))).toBe(true);
  });
});

describe('buildContextChart — reset markers', () => {
  const points = series([180_000, 20_000, 30_000, 40_000, 50_000], 10 * MIN);

  it('places a marker at its real instant and tags it in TEXT', () => {
    const resets: ContextHistoryReset[] = [
      { t: new Date(T0 + 20 * MIN).toISOString(), cmd: 'compact' },
    ];
    const chart = buildContextChart({
      points, resets, limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.resets).toHaveLength(1);
    expect(chart.resets[0]!.label).toBe('COMPACT');
    // 20 of 40 minutes → the middle of the plot.
    expect(chart.resets[0]!.x).toBeCloseTo(chart.plot.x + chart.plot.w / 2, 5);
  });

  it('labels a clear as CLEAR', () => {
    const chart = buildContextChart({
      points,
      resets: [{ t: new Date(T0 + 10 * MIN).toISOString(), cmd: 'clear' }],
      limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.resets[0]!.label).toBe('CLEAR');
  });

  it('keeps every tick but drops labels that would overlap', () => {
    const resets: ContextHistoryReset[] = [
      { t: new Date(T0 + 10 * MIN).toISOString(), cmd: 'compact' },
      { t: new Date(T0 + 10 * MIN + 1000).toISOString(), cmd: 'clear' },
      { t: new Date(T0 + 30 * MIN).toISOString(), cmd: 'compact' },
    ];
    const chart = buildContextChart({
      points, resets, limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.resets).toHaveLength(3);
    expect(chart.resets.map((r) => r.labelled)).toEqual([true, false, true]);
  });

  it('sorts markers by time even when the server does not', () => {
    const chart = buildContextChart({
      points,
      resets: [
        { t: new Date(T0 + 30 * MIN).toISOString(), cmd: 'clear' },
        { t: new Date(T0 + 10 * MIN).toISOString(), cmd: 'compact' },
      ],
      limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.resets.map((r) => r.cmd)).toEqual(['compact', 'clear']);
  });

  it('ignores a reset with an unparseable timestamp', () => {
    const chart = buildContextChart({
      points, resets: [{ t: 'nope', cmd: 'compact' }],
      limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.resets).toEqual([]);
  });
});

describe('buildContextChart — X labels', () => {
  it('always labels both ends of the axis', () => {
    const chart = buildContextChart({
      points: series([10_000, 20_000, 30_000], 10 * MIN),
      resets: [], limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.xLabels[0]!.anchor).toBe('start');
    expect(chart.xLabels[chart.xLabels.length - 1]!.anchor).toBe('end');
    expect(chart.xLabels[0]!.label).toBe(formatClock(T0));
  });

  it('adds a label for a labelled reset that fits between the ends', () => {
    const chart = buildContextChart({
      points: series([10_000, 20_000, 30_000, 40_000, 50_000], 10 * MIN),
      resets: [{ t: new Date(T0 + 20 * MIN).toISOString(), cmd: 'compact' }],
      limitTokens: 200_000, window: '24h', ...BOX,
    })!;
    expect(chart.xLabels).toHaveLength(3);
    expect(chart.xLabels[1]!.anchor).toBe('middle');
    expect(chart.xLabels[1]!.label).toBe(formatClock(T0 + 20 * MIN));
  });

  it('keeps a single label when the whole series collapses to one X', () => {
    const chart = buildContextChart({
      points: series([10_000]), resets: [], limitTokens: 200_000,
      window: '24h', ...BOX,
    })!;
    expect(chart.xLabels).toHaveLength(1);
  });
});

describe('time formatting', () => {
  it('uses a clock for the 1H and 24H windows', () => {
    expect(formatAxisTime(T0, '1h', T0)).toBe(formatClock(T0));
    expect(formatAxisTime(T0 - 3 * 86_400_000, '24h', T0))
      .toBe(formatClock(T0 - 3 * 86_400_000));
  });

  it('switches to D-n for an older calendar day in the 3D window', () => {
    expect(formatAxisTime(T0 - 2 * 86_400_000, '3d', T0)).toBe('D-2');
    expect(formatAxisTime(T0, '3d', T0)).toBe(formatClock(T0));
  });

  it('gives the 1H tooltip seconds, the wider windows minutes', () => {
    const stamp = Date.parse('2026-08-30T10:07:09.000Z');
    expect(formatSampleTime(stamp, '1h')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatSampleTime(stamp, '24h')).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('nearestSampleIndex', () => {
  const samples = [{ x: 0 }, { x: 10 }, { x: 20 }, { x: 30 }];

  it('snaps to the closest sample in X', () => {
    expect(nearestSampleIndex(samples, 0)).toBe(0);
    expect(nearestSampleIndex(samples, 11)).toBe(1);
    expect(nearestSampleIndex(samples, 16)).toBe(2);
    expect(nearestSampleIndex(samples, 29)).toBe(3);
  });

  it('clamps beyond either end instead of giving up', () => {
    expect(nearestSampleIndex(samples, -500)).toBe(0);
    expect(nearestSampleIndex(samples, 5_000)).toBe(3);
  });

  it('breaks an exact tie deterministically (first wins — no flicker)', () => {
    expect(nearestSampleIndex(samples, 15)).toBe(1);
    expect(nearestSampleIndex(samples, 15)).toBe(1);
  });

  it('has no answer for an empty series', () => {
    expect(nearestSampleIndex([], 10)).toBe(-1);
  });
});
