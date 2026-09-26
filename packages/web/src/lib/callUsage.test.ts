import { describe, it, expect } from 'vitest';
import type { CallPoint, CallSeriesPoint } from '../api/client';
import {
  activeHourRate, barValues, buildCallChart, buildSeriesChart, callUsageBucketFor, contextGapMs,
  densifyHourly, formatBucket, formatCallAxisTime, nearestBarIndex,
} from './callUsage';

const H = 3_600_000;
const T0 = Date.parse('2026-09-26T10:00:00.000Z');

function point(over: Partial<CallPoint> = {}): CallPoint {
  return {
    t: new Date(T0).toISOString(),
    n: 1,
    model: 'claude-opus-5-5',
    input: 10,
    cacheWrite: 90,
    cacheRead: 900,
    output: 100,
    context: 1_000,
    ...over,
  };
}

function series(calls: number[], t0 = T0): CallSeriesPoint[] {
  return calls.map((n, i) => ({
    t: new Date(t0 + i * H).toISOString(), calls: n, input: n, cacheWrite: 0, cacheRead: 10 * n, output: 0,
  }));
}

describe('buildCallChart', () => {
  const base = {
    aggregated: false,
    since: new Date(T0 - H).toISOString(),
    until: new Date(T0).toISOString(),
    width: 544,
    height: 128,
    window: '1h' as const,
  };

  it('stacks the four buckets bottom-up and scales Y to the tallest bar', () => {
    const chart = buildCallChart({ ...base, calls: [point()] });
    expect(chart).not.toBeNull();
    if (!chart) return;
    expect(chart.yMax).toBe(1_100);
    const bar = chart.bars[0];
    expect(bar?.segments.map((s) => s.key)).toEqual(['input', 'cacheWrite', 'cacheRead', 'output']);
    // The stack spans the whole plot: bottom of `input` at the baseline, top
    // of `output` at the top edge.
    const bottom = bar?.segments[0];
    const top = bar?.segments[3];
    expect((bottom?.y ?? 0) + (bottom?.h ?? 0)).toBeCloseTo(chart.plot.y + chart.plot.h, 1);
    expect(top?.y).toBeCloseTo(chart.plot.y, 1);
    // The context line sits at context / yMax.
    expect(bar?.yContext).toBeCloseTo(chart.plot.y + chart.plot.h * (1 - 1_000 / 1_100), 1);
  });

  it('places bars on TIME, so a gap stays a gap', () => {
    const chart = buildCallChart({
      ...base,
      calls: [point({ t: new Date(T0 - H).toISOString() }), point({ t: new Date(T0 - H / 2).toISOString() })],
    });
    const [a, b] = chart?.bars ?? [];
    expect(a?.x).toBeCloseTo(chart?.plot.x ?? 0, 1);
    expect(b?.x).toBeCloseTo((chart?.plot.x ?? 0) + (chart?.plot.w ?? 0) / 2, 1);
  });

  it('draws an aggregated bucket as its MEAN call, context left as the peak', () => {
    const p = point({ n: 4, input: 40, cacheWrite: 360, cacheRead: 3_600, output: 400, context: 1_200 });
    expect(barValues(p, true)).toEqual({ input: 10, cacheWrite: 90, cacheRead: 900, output: 100, context: 1_200 });
    expect(barValues(p, false).input).toBe(40);
    const chart = buildCallChart({ ...base, aggregated: true, calls: [p] });
    expect(chart?.yMax).toBe(1_200);
  });

  it('skips empty segments and returns null when nothing is plottable', () => {
    const chart = buildCallChart({ ...base, calls: [point({ input: 0, cacheWrite: 0 })] });
    expect(chart?.bars[0]?.segments.map((s) => s.key)).toEqual(['cacheRead', 'output']);
    expect(buildCallChart({ ...base, calls: [] })).toBeNull();
    expect(buildCallChart({ ...base, calls: [point({ t: 'nope' })] })).toBeNull();
    expect(buildCallChart({ ...base, since: 'x', calls: [point()] })).toBeNull();
  });
});

describe('buildSeriesChart', () => {
  it('stacks workers over lead in one slot per bucket', () => {
    const chart = buildSeriesChart({
      lead: series([2, 0, 1]),
      workers: series([3, 4, 0]),
      metric: 'calls',
      width: 356,
      height: 128,
      window: '24h',
    });
    expect(chart?.yMax).toBe(5);
    const [a, b, c] = chart?.bars ?? [];
    expect(a?.lead).not.toBeNull();
    expect(a?.workers?.y).toBeLessThan(a?.lead?.y ?? 0);
    expect(b?.lead).toBeNull();
    expect(c?.workers).toBeNull();
    expect(chart?.xLabels.map((l) => l.label).at(-1)).toBe('NOW');
  });

  it('switches to tokens (the four buckets summed)', () => {
    const chart = buildSeriesChart({
      lead: series([2]), workers: [], metric: 'tokens', width: 200, height: 100, window: '24h',
    });
    expect(chart?.yMax).toBe(22);
  });

  it('returns null for an empty window', () => {
    expect(buildSeriesChart({ lead: [], workers: [], metric: 'calls', width: 10, height: 10, window: '1h' }))
      .toBeNull();
  });
});

describe('helpers', () => {
  it('densifies the sparse hourly counts over the window', () => {
    const out = densifyHourly(
      [{ t: new Date(T0 - H).toISOString(), calls: 3 }],
      new Date(T0 - 3 * H + 1).toISOString(),
      new Date(T0 + 1).toISOString(),
    );
    expect(out.map((p) => p.calls)).toEqual([0, 0, 3, 0]);
    expect(densifyHourly([], 'x', 'y')).toEqual([]);
  });

  it('averages calls per ACTIVE hour only', () => {
    expect(activeHourRate([{ calls: 0 }, { calls: 4 }, { calls: 2 }])).toBe(3);
    expect(activeHourRate([{ calls: 0 }])).toBeNull();
  });

  it('asks the panel for 5-minute buckets on 1H only', () => {
    expect(callUsageBucketFor('1h')).toBe('5m');
    expect(callUsageBucketFor('14d')).toBe('hour');
  });

  it('formats buckets and axis times', () => {
    expect(formatBucket(300_000)).toBe('5 MIN');
    expect(formatBucket(3_600_000)).toBe('1 H');
    expect(formatBucket(10_000)).toBe('10 S');
    const ref = Date.parse('2026-09-26T12:00:00');
    expect(formatCallAxisTime(Date.parse('2026-09-24T12:00:00'), '14d', ref)).toBe('D-2');
    expect(formatCallAxisTime(Date.parse('2026-09-26T08:05:00'), '24h', ref)).toBe('08:05');
  });

  it('snaps to the nearest bar', () => {
    expect(nearestBarIndex([{ x: 10 }, { x: 20 }, { x: 40 }], 33)).toBe(2);
    expect(nearestBarIndex([], 5)).toBe(-1);
  });
});

describe('time alignment and line breaks', () => {
  it('breaks the context line across a pause instead of drawing a diagonal', () => {
    const since = new Date(T0 - 24 * H).toISOString();
    const until = new Date(T0).toISOString();
    const chart = buildCallChart({
      calls: [
        point({ t: new Date(T0 - 10 * H).toISOString() }),
        point({ t: new Date(T0 - 10 * H + 60_000).toISOString() }),
        point({ t: new Date(T0 - 2 * H).toISOString() }),
      ],
      aggregated: false, since, until, width: 600, height: 120, window: '24h',
    });
    expect(chart?.contextPath.match(/M/g)).toHaveLength(2);
    expect(contextGapMs(24 * H, false)).toBe(15 * 60_000);
    expect(contextGapMs(24 * H, true, 300_000)).toBe(450_000);
  });

  it('places series bars on time when given the span', () => {
    const chart = buildSeriesChart({
      lead: series([1, 1], T0 - 2 * H),
      workers: [],
      metric: 'calls',
      width: 256,
      height: 100,
      window: '24h',
      span: { since: new Date(T0 - 2 * H).toISOString(), until: new Date(T0).toISOString(), bucketMs: H },
    });
    // 200 px of plot over 2 h: bucket centres at 1/4 and 3/4.
    expect(chart?.bars[0]?.x).toBeCloseTo((chart?.plot.x ?? 0) + 50, 1);
    expect(chart?.bars[1]?.x).toBeCloseTo((chart?.plot.x ?? 0) + 150, 1);
  });
});
