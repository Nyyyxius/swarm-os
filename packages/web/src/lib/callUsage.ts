// Per-call chart maths — everything the API CALLS strip of the agent band and
// the CALL USAGE panel of the MONITORING page draw, as pure functions. Same
// discipline as `contextHistory.ts`: a hand-rolled SVG, and every coordinate
// computed here where a unit test can see an off-by-one.
//
// Two editorial rules:
//
//   1. **The X axis is TIME, not an index.** An agent asleep for three hours
//      is a three-hour gap, not two adjacent bars.
//   2. **One Y scale per plot, and it means one thing.** On the agent chart a
//      bar is the tokens of ONE call and the line is the context of one call,
//      so both share the token scale. When the server folded the window into
//      buckets (`aggregated`), a bucket's bar is drawn as the MEAN call of the
//      bucket — a sum of 40 calls against the context line of one would put
//      the two on different scales and make the line meaningless. The tooltip
//      carries the sums and the count.

import type {
  CallBucket,
  CallPoint,
  CallSeriesPoint,
  CallWindow,
} from '../api/client';
import { formatTokensShort } from './contextPercent';
import { formatClock, formatClockSeconds } from './contextHistory';

/** The agent band's window selector, in display order. */
export const CALL_WINDOWS: readonly { key: CallWindow; label: string }[] = [
  { key: '1h', label: '1H' },
  { key: '24h', label: '24H' },
  { key: '3d', label: '3D' },
  { key: '14d', label: '14D' },
];

export const DEFAULT_CALL_WINDOW: CallWindow = '24h';

/** Poll cadence of the agent band's call strip — while it is open only. */
export const CALL_REFRESH_MS = 30_000;

/** Poll cadence of the team panel — while the page is open only. */
export const CALL_USAGE_REFRESH_MS = 60_000;

/**
 * The bucket each panel window is asked for. An hour of hourly buckets is one
 * bar, so the 1H view asks for 5-minute ones; 14 days of hours is 336 bars,
 * still readable.
 */
export function callUsageBucketFor(window: CallWindow): CallBucket {
  return window === '1h' ? '5m' : 'hour';
}

/** The four stacked segments, bottom to top, with their legend labels. */
export const CALL_SEGMENTS = [
  { key: 'input', label: 'NEW IN' },
  { key: 'cacheWrite', label: 'CACHE WRITE' },
  { key: 'cacheRead', label: 'CACHE READ' },
  { key: 'output', label: 'OUTPUT' },
] as const;

export type CallSegmentKey = (typeof CALL_SEGMENTS)[number]['key'];

// ── formatting ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Axis label: a clock for 1H / 24H, and — on the multi-day windows — `D-n`
 * for an older calendar day (counted back from `refMs`), a clock for today.
 */
export function formatCallAxisTime(ms: number, window: CallWindow, refMs: number): string {
  if (window === '1h' || window === '24h') return formatClock(ms);
  const days = Math.round((startOfLocalDay(refMs) - startOfLocalDay(ms)) / DAY_MS);
  return days > 0 ? `D-${days}` : formatClock(ms);
}

/**
 * Tooltip time: seconds for a single call (two calls a few seconds apart must
 * be tellable apart), and the date on the multi-day windows.
 */
export function formatCallTime(ms: number, window: CallWindow, single: boolean): string {
  const clock = single ? formatClockSeconds(ms) : formatClock(ms);
  if (window === '1h' || window === '24h') return clock;
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${clock}`;
}

/** `5 MIN`, `1 H` — the bucket size the server folded into, for the footer. */
export function formatBucket(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} H`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} MIN`;
  return `${Math.round(ms / 1000)} S`;
}

/** input + cache write + cache read + output. */
export function callTokenSum(t: { input: number; cacheWrite: number; cacheRead: number; output: number }): number {
  return t.input + t.cacheWrite + t.cacheRead + t.output;
}

/**
 * Average calls per hour over the hours that saw at least one call, or `null`
 * when none did. Idle hours are left out on purpose: an agent that worked
 * two hours of a 24 h window did not work "at 3 calls an hour".
 */
export function activeHourRate(hourly: readonly { calls: number }[]): number | null {
  const active = hourly.filter((h) => h.calls > 0);
  if (active.length === 0) return null;
  return active.reduce((n, h) => n + h.calls, 0) / active.length;
}

// ── the agent chart ─────────────────────────────────────────────────────────

export interface CallBarSegment {
  key: CallSegmentKey;
  y: number;
  h: number;
}

export interface CallBar {
  /** Index into the input `calls`. */
  index: number;
  t: number;
  /** Centre X. */
  x: number;
  w: number;
  segments: CallBarSegment[];
  /** Y of the context line at this bar. */
  yContext: number;
}

export interface CallChart {
  plot: { x: number; y: number; w: number; h: number };
  bars: CallBar[];
  /** `M…L…` through every bar's context. */
  contextPath: string;
  yTicks: { y: number; label: string }[];
  xLabels: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[];
  yMax: number;
}

export interface CallChartInput {
  calls: readonly CallPoint[];
  aggregated: boolean;
  /** ISO bounds of the window — the X axis spans them, not just the data. */
  since: string;
  until: string;
  width: number;
  height: number;
  window: CallWindow;
  /** The server's bucket size when `aggregated` — drives where the line breaks. */
  bucketMs?: number | null;
}

const PAD = { left: 44, right: 12, top: 10, bottom: 18 };

/** The per-call values a bar draws: the call itself, or its bucket's mean call. */
export function barValues(p: CallPoint, aggregated: boolean): {
  input: number; cacheWrite: number; cacheRead: number; output: number; context: number;
} {
  const n = aggregated && p.n > 1 ? p.n : 1;
  return {
    input: p.input / n,
    cacheWrite: p.cacheWrite / n,
    cacheRead: p.cacheRead / n,
    output: p.output / n,
    // Already a max on the server — never divided.
    context: p.context,
  };
}

/**
 * How long two consecutive calls may be apart and still be joined by the
 * context line. Past it the line BREAKS: a diagonal drawn across a three-hour
 * pause would claim a context that was never measured in between. For folded
 * buckets, anything past one empty bucket; for single calls, 5 minutes or
 * 1/96 of the window, whichever is longer (15 min on 24H, 3.5 h on 14D).
 */
export function contextGapMs(windowMs: number, aggregated: boolean, bucketMs?: number | null): number {
  if (aggregated && bucketMs && bucketMs > 0) return bucketMs * 1.5;
  return Math.max(5 * 60_000, windowMs / 96);
}

/**
 * Every coordinate of the agent chart, or `null` when nothing is plottable
 * (the component renders its empty state then — an axis with no bar would
 * read as "zero calls" when the truth may be "not a claude agent").
 */
export function buildCallChart(input: CallChartInput): CallChart | null {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, width - PAD.left - PAD.right),
    h: Math.max(1, height - PAD.top - PAD.bottom),
  };
  const t0 = Date.parse(input.since);
  const t1 = Date.parse(input.until);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;

  const parsed = input.calls
    .map((p, index) => ({ p, index, ts: Date.parse(p.t) }))
    .filter((c) => Number.isFinite(c.ts));
  if (parsed.length === 0) return null;

  const values = parsed.map((c) => barValues(c.p, input.aggregated));
  const yMax = Math.max(1, ...values.map((v) => Math.max(callTokenSum(v), v.context)));
  const yOf = (v: number): number => plot.y + plot.h * (1 - Math.max(0, Math.min(yMax, v)) / yMax);
  const xOf = (t: number): number => plot.x + ((t - t0) / (t1 - t0)) * plot.w;

  // Width: a bucket spans its bucket; a single call gets a share of the plot
  // by count, clamped so a busy hour stays legible and a lone call visible.
  const barW = Math.max(1, Math.min(8, (plot.w / Math.max(1, parsed.length)) * 0.7));

  const bars: CallBar[] = parsed.map((c, i) => {
    const v = values[i] as ReturnType<typeof barValues>;
    let acc = 0;
    const segments: CallBarSegment[] = [];
    for (const seg of CALL_SEGMENTS) {
      const value = v[seg.key];
      if (value <= 0) continue;
      const yTop = yOf(acc + value);
      const yBottom = yOf(acc);
      segments.push({ key: seg.key, y: round(yTop), h: round(Math.max(0.5, yBottom - yTop)) });
      acc += value;
    }
    return {
      index: c.index,
      t: c.ts,
      x: round(Math.max(plot.x, Math.min(plot.x + plot.w, xOf(c.ts)))),
      w: round(barW),
      segments,
      yContext: round(yOf(v.context)),
    };
  });

  const gap = contextGapMs(t1 - t0, input.aggregated, input.bucketMs);
  const contextPath = bars
    .map((b, i) => {
      const prev = bars[i - 1];
      const join = prev !== undefined && b.t - prev.t <= gap;
      return `${join ? 'L' : 'M'} ${b.x} ${b.yContext}`;
    })
    .join(' ');

  const yTicks = [0, yMax / 2, yMax].map((v) => ({ y: round(yOf(v)), label: formatTokensShort(v) }));
  const xLabels = [
    { x: plot.x, label: formatCallAxisTime(t0, input.window, t1), anchor: 'start' as const },
    { x: plot.x + plot.w / 2, label: formatCallAxisTime((t0 + t1) / 2, input.window, t1), anchor: 'middle' as const },
    { x: plot.x + plot.w, label: 'NOW', anchor: 'end' as const },
  ];
  return { plot, bars, contextPath, yTicks, xLabels, yMax };
}

// ── hourly strip + series (panel) ───────────────────────────────────────────

const HOUR_MS = 3_600_000;

/**
 * The sparse `hourly` of `GET /sessions/:id/calls` (hours with a call only) →
 * one point per hour of the window, zeros included, so the strip shows idle
 * hours as gaps. Hours are epoch-aligned, exactly as the server grouped them.
 */
export function densifyHourly(
  hourly: readonly { t: string; calls: number }[],
  since: string,
  until: string,
): CallSeriesPoint[] {
  const t0 = Date.parse(since);
  const t1 = Date.parse(until);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return [];
  const byHour = new Map<number, number>();
  for (const h of hourly) {
    const t = Date.parse(h.t);
    if (Number.isFinite(t)) byHour.set(t, (byHour.get(t) ?? 0) + h.calls);
  }
  const out: CallSeriesPoint[] = [];
  for (let t = Math.floor(t0 / HOUR_MS) * HOUR_MS; t < t1; t += HOUR_MS) {
    out.push({
      t: new Date(t).toISOString(),
      calls: byHour.get(t) ?? 0,
      input: 0, cacheWrite: 0, cacheRead: 0, output: 0,
    });
  }
  return out;
}

export interface SeriesBar {
  index: number;
  t: number;
  x: number;
  w: number;
  /** Bottom segment (lead) and top segment (workers). */
  lead: { y: number; h: number } | null;
  workers: { y: number; h: number } | null;
}

export interface SeriesChart {
  plot: { x: number; y: number; w: number; h: number };
  bars: SeriesBar[];
  yTicks: { y: number; label: string }[];
  xLabels: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[];
  yMax: number;
}

export type SeriesMetric = 'calls' | 'tokens';

export function seriesValue(p: CallSeriesPoint | undefined, metric: SeriesMetric): number {
  if (!p) return 0;
  return metric === 'calls' ? p.calls : callTokenSum(p);
}

/**
 * The team / fleet chart: one slot per bucket, lead stacked under workers.
 * `lead` and `workers` are index-aligned (the server sends them dense); a
 * length mismatch is tolerated by reading the missing side as zero.
 */
export function buildSeriesChart(input: {
  lead: readonly CallSeriesPoint[];
  workers: readonly CallSeriesPoint[];
  metric: SeriesMetric;
  width: number;
  height: number;
  window: CallWindow;
  /**
   * Place bars on TIME over `[since, until]` (ISO), each `bucketMs` wide —
   * so a strip under the per-call chart lines up with it to the pixel.
   * Absent ⇒ one equal slot per bucket.
   */
  span?: { since: string; until: string; bucketMs: number };
}): SeriesChart | null {
  const n = Math.max(input.lead.length, input.workers.length);
  if (n === 0) return null;
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, width - PAD.left - PAD.right),
    h: Math.max(1, height - PAD.top - PAD.bottom),
  };
  const lead = (i: number) => seriesValue(input.lead[i], input.metric);
  const workers = (i: number) => seriesValue(input.workers[i], input.metric);
  let yMax = 1;
  for (let i = 0; i < n; i++) yMax = Math.max(yMax, lead(i) + workers(i));
  const yOf = (v: number): number => plot.y + plot.h * (1 - Math.max(0, Math.min(yMax, v)) / yMax);
  const slot = plot.w / n;
  const stamp = (i: number): number => Date.parse((input.lead[i] ?? input.workers[i])?.t ?? '');
  const s0 = input.span ? Date.parse(input.span.since) : NaN;
  const s1 = input.span ? Date.parse(input.span.until) : NaN;
  const timed = input.span !== undefined && Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0
    && input.span.bucketMs > 0;
  const w = timed
    ? Math.max(1, ((input.span as { bucketMs: number }).bucketMs / (s1 - s0)) * plot.w * 0.72)
    : Math.max(1, slot * 0.72);
  const xAt = (i: number): number => {
    if (!timed) return plot.x + slot * (i + 0.5);
    const mid = stamp(i) + (input.span as { bucketMs: number }).bucketMs / 2;
    return plot.x + Math.max(0, Math.min(1, (mid - s0) / (s1 - s0))) * plot.w;
  };

  const bars: SeriesBar[] = [];
  for (let i = 0; i < n; i++) {
    const l = lead(i);
    const k = workers(i);
    const x = xAt(i);
    bars.push({
      index: i,
      t: stamp(i),
      x: round(x),
      w: round(w),
      lead: l > 0 ? { y: round(yOf(l)), h: round(Math.max(0.5, yOf(0) - yOf(l))) } : null,
      workers: k > 0 ? { y: round(yOf(l + k)), h: round(Math.max(0.5, yOf(l) - yOf(l + k))) } : null,
    });
  }
  const fmt = input.metric === 'calls'
    ? (v: number) => String(Math.round(v))
    : (v: number) => formatTokensShort(v);
  const yTicks = [0, yMax / 2, yMax].map((v) => ({ y: round(yOf(v)), label: fmt(v) }));
  const first = bars[0];
  const last = bars[bars.length - 1];
  const refMs = last && Number.isFinite(last.t) ? last.t : Date.now();
  const xLabels = first && last && Number.isFinite(first.t)
    ? [
      { x: plot.x, label: formatCallAxisTime(first.t, input.window, refMs), anchor: 'start' as const },
      { x: plot.x + plot.w, label: 'NOW', anchor: 'end' as const },
    ]
    : [];
  return { plot, bars, yTicks, xLabels, yMax };
}

/** Index of the bar whose X is nearest `x`, or -1. Same snap as the context chart. */
export function nearestBarIndex(bars: readonly { x: number }[], x: number): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  bars.forEach((b, i) => {
    const d = Math.abs(b.x - x);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

const round = (n: number): number => Math.round(n * 100) / 100;
