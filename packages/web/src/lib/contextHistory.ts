// Context-history chart maths — everything the CONTEXT HISTORY band draws,
// as pure functions. See `docs/monitoring-agents.md`, Lot 9.
//
// The band renders a hand-rolled SVG (no charting library: one series, one
// axis, three annotation kinds — a library would cost more bytes than the
// forty lines below and would fight the design tokens). Keeping the maths
// OUT of the component is what makes it testable: a chart is exactly the
// kind of code where an off-by-one in a scale is invisible in review and
// obvious in a unit test.
//
// Two editorial rules are enforced here rather than left to the component:
//
//   1. **Never invent a scale.** Percentages exist only when the server told
//      us the model's window (`limitTokens`). Without it we plot raw tokens
//      and drop the 70/90 % threshold lines entirely — a threshold drawn
//      against an unknown ceiling is a fabricated number, the same sin
//      `contextPercent.ts` guards the `—` placeholder against.
//   2. **Never smooth away a drop.** The server sends min/max/last per
//      bucket precisely so a `/compact` inside a bucket stays visible; the
//      display downsampler below merges buckets the SAME way (min of mins,
//      max of maxes, last of lasts) instead of averaging.

import type {
  ContextHistoryPoint,
  ContextHistoryReset,
  ContextHistoryWindow,
} from '../api/client';
import { CONTEXT_BAD_AT, CONTEXT_WARN_AT, formatTokensShort } from './contextPercent';

/** The window selector, in display order. `key` is the wire value. */
export const CONTEXT_HISTORY_WINDOWS: readonly {
  key: ContextHistoryWindow;
  label: string;
}[] = [
  { key: '1h', label: '1H' },
  { key: '24h', label: '24H' },
  { key: '3d', label: '3D' },
];

/**
 * Default window. A day is the span an operator actually reasons about
 * ("did this agent climb overnight?"); 1H is a zoom, 3D is the archive.
 */
export const DEFAULT_CONTEXT_WINDOW: ContextHistoryWindow = '24h';

/** Poll cadence while the band is open. Cheap, and never while it is closed. */
export const CONTEXT_HISTORY_REFRESH_MS = 30_000;

// ── sparkline series (MONITORING table SPARK column) ─────────────────────────

/**
 * Sanitise `SessionView.contextSpark` for the `Sparkline` component.
 *
 * Returns `null` — the cell then renders `—` — when the field is absent, not
 * an array, or carries fewer than TWO usable readings. The two-point floor is
 * not fussiness: `Sparkline` maps `i / (n - 1)`, so a single value divides by
 * zero and paints `M NaN NaN`. And a one-sample "trend" would be a line with
 * no direction, which is worse than the honest em-dash.
 *
 * Non-finite entries are dropped rather than poisoning the whole series, and
 * values are clamped to 0-100: the server sends whole percents, but a
 * drifting backend must not be able to stretch the sparkline's autoscale.
 */
export function normalizeContextSpark(
  raw: readonly number[] | null | undefined,
): number[] | null {
  if (!Array.isArray(raw)) return null;
  const clean: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    clean.push(Math.max(0, Math.min(100, v)));
  }
  return clean.length >= 2 ? clean : null;
}

// ── display downsampling ─────────────────────────────────────────────────────

/**
 * Merge buckets down to at most `maxPoints`, preserving the extremes.
 *
 * The server already caps its answer at ~300 buckets, which is fine on a
 * wide desktop plot but is several buckets per pixel on a phone. Merging
 * with min/max/last (never an average) keeps a compaction cliff on screen at
 * every width; the merged bucket is timestamped with its LAST sample so the
 * X scale stays monotone.
 */
export function downsampleHistory(
  points: readonly ContextHistoryPoint[],
  maxPoints: number,
): ContextHistoryPoint[] {
  if (maxPoints < 1) return [];
  if (points.length <= maxPoints) return [...points];
  const size = Math.ceil(points.length / maxPoints);
  const out: ContextHistoryPoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const group = points.slice(i, i + size);
    const tail = group[group.length - 1];
    if (!tail) continue;
    let min = tail.min;
    let max = tail.max;
    for (const p of group) {
      if (p.min < min) min = p.min;
      if (p.max > max) max = p.max;
    }
    out.push({ t: tail.t, min, max, last: tail.last });
  }
  return out;
}

// ── time formatting ──────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` in the operator's local time. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `HH:MM:SS` — used by the 1H window, whose buckets are seconds apart. */
export function formatClockSeconds(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const DAY_MS = 86_400_000;

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * X-axis label: a clock inside today, `D-2` for an older calendar day.
 *
 * Only the 3D window can span days, so it is the only one that ever falls
 * back to the day form — `14:20` repeated three times across a 72 h axis
 * would be actively misleading. `D-n` counts CALENDAR days back from `refMs`
 * (the newest sample), not 24 h multiples, so it matches how an operator
 * reads "yesterday".
 */
export function formatAxisTime(
  ms: number,
  window: ContextHistoryWindow,
  refMs: number,
): string {
  if (window !== '3d') return formatClock(ms);
  const days = Math.round((startOfLocalDay(refMs) - startOfLocalDay(ms)) / DAY_MS);
  return days > 0 ? `D-${days}` : formatClock(ms);
}

/** Tooltip clock: seconds only where buckets are seconds apart. */
export function formatSampleTime(ms: number, window: ContextHistoryWindow): string {
  return window === '1h' ? formatClockSeconds(ms) : formatClock(ms);
}

// ── the chart ────────────────────────────────────────────────────────────────

/**
 * `used / limit` as a 0-1 fraction, or `null` when there is no limit to
 * divide by. Feeds `contextLevel` / `contextColorVar` so the band's colours
 * come from the same thresholds as every other CTX surface.
 */
export function contextFraction(
  used: number,
  limit: number | null,
): number | null {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(1, used / limit));
}

export interface ChartSample {
  /** Epoch ms of the bucket. */
  t: number;
  /** Raw token counts, straight from the wire. */
  min: number;
  max: number;
  last: number;
  x: number;
  /** Y of `last` — the plotted line. */
  y: number;
  /** Y of the bucket's HIGH value (smaller number: SVG Y grows downward). */
  yHigh: number;
  /** Y of the bucket's LOW value. */
  yLow: number;
}

export interface ChartReset {
  t: number;
  x: number;
  cmd: 'compact' | 'clear';
  /** `COMPACT` / `CLEAR` — the tag is always drawn as TEXT, never colour alone. */
  label: string;
  /** False when a neighbour already claimed the space (tick still drawn). */
  labelled: boolean;
}

export interface ChartAxisLabel {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

export interface ContextChart {
  /** `percent` whenever the model window is known; `tokens` otherwise. */
  mode: 'percent' | 'tokens';
  plot: { x: number; y: number; w: number; h: number };
  samples: ChartSample[];
  /** `M…L…` through every `last` value. */
  linePath: string;
  /** The line, closed onto the baseline. */
  areaPath: string;
  /** min→max envelope, or `null` when every bucket is flat. */
  bandPath: string | null;
  yTicks: { y: number; label: string }[];
  /** Empty in `tokens` mode — see the module header. */
  thresholds: { y: number; label: string; level: 'warn' | 'bad' }[];
  resets: ChartReset[];
  xLabels: ChartAxisLabel[];
}

const PAD = { left: 40, right: 14, top: 14, bottom: 20 };
/** Minimum px between two annotations before one gives up its label. */
const LABEL_MIN_GAP = 52;

export interface ContextChartInput {
  points: readonly ContextHistoryPoint[];
  resets: readonly ContextHistoryReset[];
  limitTokens: number | null;
  width: number;
  height: number;
  window: ContextHistoryWindow;
  /** Display downsampling cap. Defaults to one bucket per 3 px of plot. */
  maxSamples?: number;
}

/**
 * Build every coordinate the band needs, or `null` when there is nothing
 * plottable (no usable point). Callers render the empty state on `null`
 * instead of an axis with no series, which would read as "flat at zero".
 */
export function buildContextChart(input: ContextChartInput): ContextChart | null {
  const { points, resets, limitTokens, window } = input;
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, width - PAD.left - PAD.right),
    h: Math.max(1, height - PAD.top - PAD.bottom),
  };

  // Drop unparseable timestamps rather than letting one NaN blow up the
  // whole scale — the band must degrade, never throw.
  const parsed = points
    .map((p) => ({ ...p, ts: Date.parse(p.t) }))
    .filter((p) => Number.isFinite(p.ts)
      && Number.isFinite(p.min) && Number.isFinite(p.max) && Number.isFinite(p.last));
  if (parsed.length === 0) return null;

  const maxSamples = input.maxSamples ?? Math.max(2, Math.floor(plot.w / 3));
  const kept = downsampleHistory(
    parsed.map((p) => ({ t: p.t, min: p.min, max: p.max, last: p.last })),
    maxSamples,
  ).map((p) => ({ ...p, ts: Date.parse(p.t) }));

  const parsedResets = resets
    .map((r) => ({ cmd: r.cmd, ts: Date.parse(r.t) }))
    .filter((r) => Number.isFinite(r.ts));

  // ── X scale: TIME, not index. A bucket gap (agent asleep) must show as a
  // gap, and a reset marker has to land on its real instant.
  const stamps = [...kept.map((p) => p.ts), ...parsedResets.map((r) => r.ts)];
  const t0 = Math.min(...stamps);
  const t1 = Math.max(...stamps);
  const span = t1 - t0;
  const xOf = (t: number): number => (
    span <= 0 ? plot.x + plot.w / 2 : plot.x + ((t - t0) / span) * plot.w
  );

  // ── Y scale.
  const mode: 'percent' | 'tokens' =
    limitTokens !== null && Number.isFinite(limitTokens) && limitTokens > 0
      ? 'percent'
      : 'tokens';
  let yMax: number;
  let valueOf: (tokens: number) => number;
  if (mode === 'percent') {
    const limit = limitTokens as number;
    yMax = 100;
    valueOf = (tokens) => Math.max(0, Math.min(100, (tokens / limit) * 100));
  } else {
    // Raw tokens: the top of the axis is the highest value we actually saw,
    // never a rounded-up guess at a window we do not know.
    yMax = Math.max(1, ...kept.map((p) => p.max));
    valueOf = (tokens) => Math.max(0, Math.min(yMax, tokens));
  }
  const yOf = (value: number): number => plot.y + plot.h * (1 - value / yMax);

  const samples: ChartSample[] = kept.map((p) => ({
    t: p.ts,
    min: p.min,
    max: p.max,
    last: p.last,
    x: xOf(p.ts),
    y: yOf(valueOf(p.last)),
    yHigh: yOf(valueOf(p.max)),
    yLow: yOf(valueOf(p.min)),
  }));

  const linePath = samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${round(s.x)} ${round(s.y)}`)
    .join(' ');
  const baseY = plot.y + plot.h;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  const areaPath = `${linePath} L ${round(last.x)} ${round(baseY)} L ${round(first.x)} ${round(baseY)} Z`;

  // Amplitude band: only worth drawing when a bucket actually spans a range.
  const hasBand = samples.some((s) => s.max > s.min);
  const bandPath = hasBand
    ? [
      ...samples.map((s, i) => `${i === 0 ? 'M' : 'L'} ${round(s.x)} ${round(s.yHigh)}`),
      ...[...samples].reverse().map((s) => `L ${round(s.x)} ${round(s.yLow)}`),
      'Z',
    ].join(' ')
    : null;

  const yTicks = mode === 'percent'
    ? [0, 50, 100].map((v) => ({ y: yOf(v), label: `${v}%` }))
    : [0, yMax / 2, yMax].map((v) => ({ y: yOf(v), label: formatTokensShort(v) }));

  const thresholds = mode === 'percent'
    ? ([
      { y: yOf(CONTEXT_WARN_AT * 100), label: `${Math.round(CONTEXT_WARN_AT * 100)}%`, level: 'warn' as const },
      { y: yOf(CONTEXT_BAD_AT * 100), label: `${Math.round(CONTEXT_BAD_AT * 100)}%`, level: 'bad' as const },
    ])
    : [];

  // Reset markers: every tick is drawn, but a label is dropped when a
  // neighbour already occupies the space — overlapping `COMPACT` tags are
  // less readable than one tag and two ticks.
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const chartResets: ChartReset[] = [...parsedResets]
    .sort((a, b) => a.ts - b.ts)
    .map((r) => {
      const x = xOf(r.ts);
      const labelled = x - lastLabelX >= LABEL_MIN_GAP;
      if (labelled) lastLabelX = x;
      return { t: r.ts, x, cmd: r.cmd, label: r.cmd.toUpperCase(), labelled };
    });

  return {
    mode,
    plot,
    samples,
    linePath,
    areaPath,
    bandPath,
    yTicks,
    thresholds,
    resets: chartResets,
    xLabels: buildXLabels(samples, chartResets, window, t1),
  };
}

/**
 * Time labels: always the two ends of the axis, plus each labelled reset
 * that fits between them. The ends are never sacrificed — they are what
 * gives the whole plot its span.
 */
function buildXLabels(
  samples: readonly ChartSample[],
  resets: readonly ChartReset[],
  window: ContextHistoryWindow,
  refMs: number,
): ChartAxisLabel[] {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return [];
  const startX = first.x;
  const endX = last.x;
  const out: ChartAxisLabel[] = [{
    x: startX,
    label: formatAxisTime(first.t, window, refMs),
    anchor: 'start',
  }];
  if (endX - startX >= LABEL_MIN_GAP) {
    let lastX = startX;
    for (const r of resets) {
      if (!r.labelled) continue;
      if (r.x - lastX < LABEL_MIN_GAP || endX - r.x < LABEL_MIN_GAP) continue;
      out.push({ x: r.x, label: formatAxisTime(r.t, window, refMs), anchor: 'middle' });
      lastX = r.x;
    }
    out.push({
      x: endX,
      label: formatAxisTime(last.t, window, refMs),
      anchor: 'end',
    });
  }
  return out;
}

/**
 * Index of the sample nearest to `x` (px, in chart space), or `-1` when
 * there are none. Drives the crosshair: the operator points at the plot, not
 * at the 1.6 px line, so the reading has to snap to the closest bucket in X
 * regardless of how far the pointer is in Y.
 */
export function nearestSampleIndex(
  samples: readonly { x: number }[],
  x: number,
): number {
  const first = samples[0];
  if (!first) return -1;
  let best = 0;
  let bestDist = Math.abs(first.x - x);
  for (let i = 1; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s) continue;
    const dist = Math.abs(s.x - x);
    // Strictly-less keeps the FIRST of two equidistant samples — an
    // arbitrary but stable tie-break, so the crosshair never flickers
    // between two buckets while the pointer sits still.
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

const round = (n: number): number => Math.round(n * 100) / 100;
