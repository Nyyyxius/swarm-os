// System-gauge geometry + formatting — the pure half of `SystemGauge`
// (docs/monitoring-agents.md, Lot 10).
//
// Everything here is deliberately free of React so the two things that are
// easy to get silently wrong — the arc length a percentage maps to, and the
// byte/core sub-labels — are testable without a DOM.
//
// Editorial rule, inherited verbatim from `lib/contextPercent.ts`: **never
// invent a number**. Every field of `GET /metrics/system` is nullable because
// a container whose cgroup files are unreadable (or a server predating this
// endpoint, which 404s) genuinely has nothing to report. A fabricated `0%`
// there would read as "the box is idle" at the exact moment an operator is
// trying to work out why the swarm has stalled. Unknown renders `—`.
//
// Thresholds are NOT re-declared: a CPU gauge that turned amber at a different
// point than the CTX cells sitting two centimetres to its right would make the
// colour meaningless as a language. `contextLevel` / `contextColorVar` are the
// single source of truth for `ok < 0.7 ≤ warn < 0.9 ≤ bad`.

import {
  CONTEXT_PLACEHOLDER, contextColorVar, contextLevel, type ContextLevel,
} from './contextPercent';

/** Em-dash placeholder, re-exported so gauge callers need one import. */
export { CONTEXT_PLACEHOLDER as GAUGE_PLACEHOLDER };

// ── arc geometry ────────────────────────────────────────────────────────────

/**
 * The 180° track, straight from the design artboard. Left cap at (8, 44),
 * right cap at (76, 44), sweeping over the top — so the gauge fills
 * left-to-right, the direction the eye already reads the KPI band in.
 */
export const GAUGE_ARC_PATH = 'M8 44 A34 34 0 0 1 76 44';

/** Radius of {@link GAUGE_ARC_PATH}. */
export const GAUGE_ARC_RADIUS = 34;

/**
 * Drawn length of the half-circle, `πr ≈ 106.81`. This is the number
 * `stroke-dasharray` is expressed in; hard-coding a rounded `106.8` instead
 * would leave a ~0.2 px stub of track visible at 100 %.
 */
export const GAUGE_ARC_LENGTH = Math.PI * GAUGE_ARC_RADIUS;

/** viewBox of the gauge SVG — the arc plus room for its 5 px round caps. */
export const GAUGE_VIEWBOX = '0 0 84 52';

/**
 * `stroke-dasharray` for the value arc: a dash of `pct × πr` followed by a
 * gap long enough to swallow the rest of the path.
 *
 * `null` when there is no measurement, which is what makes "track only, no
 * value arc" a *structural* property of the component rather than a styling
 * accident. The fraction is clamped to `[0, 1]`: the server clamps too, but a
 * gauge is a shape, and an over-unity dash would paint past the right cap
 * onto the label.
 */
export function gaugeArcDash(pct: number | null | undefined): string | null {
  if (contextLevel(pct) === null) return null;
  const clamped = Math.max(0, Math.min(1, pct as number));
  return `${(clamped * GAUGE_ARC_LENGTH).toFixed(2)} ${GAUGE_ARC_LENGTH.toFixed(2)}`;
}

/**
 * Colour of the arc itself — the ONE element carrying status in this widget.
 * Straight passthrough to the shared token mapping.
 */
export function gaugeArcColor(level: ContextLevel | null): string {
  return contextColorVar(level);
}

/**
 * Colour of the centred percentage. `ok` stays in the plain text token: a
 * band of green numerals would make "everything is fine" the loudest thing on
 * the page. `warn`/`bad` adopt the threshold colour so a glance at the number
 * alone is enough, and a missing reading is muted like every other `—`.
 */
export function gaugeTextColor(level: ContextLevel | null): string {
  if (level === null) return 'var(--text-mute)';
  return level === 'ok' ? 'var(--text)' : contextColorVar(level);
}

/** `NN%`, or `—` when there is no measurement. Clamped to `[0, 100]`. */
export function formatGaugePercent(pct: number | null | undefined): string {
  if (contextLevel(pct) === null) return CONTEXT_PLACEHOLDER;
  const rounded = Math.round((pct as number) * 100);
  return `${Math.max(0, Math.min(100, rounded))}%`;
}

// ── sub-labels ──────────────────────────────────────────────────────────────

/**
 * Compact byte size: `6.2G`, `512.0M`, `48.0K`, `900B`. `—` when absent.
 *
 * Binary units (1024), not decimal: these numbers come from `memory.current`
 * and `memory.max`, and a cgroup limit set to 8 GiB must read `8.0G` rather
 * than `8.6G`. The suffix is a bare upper-case letter — the same all-caps
 * Geist Mono register as `156K` tokens two columns over.
 */
export function formatBytesShort(n: number | null | undefined): string {
  if (n === null || n === undefined) return CONTEXT_PLACEHOLDER;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return CONTEXT_PLACEHOLDER;
  }
  const K = 1024, M = K * 1024, G = M * 1024;
  if (n >= G) return `${(n / G).toFixed(1)}G`;
  if (n >= M) return `${(n / M).toFixed(1)}M`;
  if (n >= K) return `${(n / K).toFixed(1)}K`;
  return `${Math.round(n)}B`;
}

/** Sub-line placeholder when the whole reading is missing. */
export const NO_CGROUP_DATA = 'NO CGROUP DATA';

/** `{cpu}` half of the `/metrics/system` payload. */
export interface SystemCpuMetric {
  pct: number | null;
  cores: number | null;
  basis: 'cgroup' | 'host' | null;
}

/** `{memory}` half of the `/metrics/system` payload. */
export interface SystemMemoryMetric {
  usedBytes: number | null;
  limitBytes: number | null;
  pct: number | null;
  basis: 'cgroup' | 'host' | null;
}

/**
 * `1.4 / 4.0 CORES` — the absolute reading under the CPU percentage, because
 * "70 %" answers a different question on a 2-core box than on a 16-core one.
 *
 * Partial knowledge still prints: the CPU sampler returns `pct: null` on its
 * very first call (it needs two `cpu.stat` reads to make a delta) while the
 * core count is available immediately, and `— / 4.0 CORES` is a truer thing to
 * show for those three seconds than nothing at all. `null` only when BOTH
 * halves are unknown, which is the caller's cue for {@link NO_CGROUP_DATA}.
 */
export function cpuSubLabel(cpu: SystemCpuMetric | null | undefined): string | null {
  if (!cpu) return null;
  const cores = typeof cpu.cores === 'number' && Number.isFinite(cpu.cores) && cpu.cores >= 0
    ? cpu.cores
    : null;
  const hasPct = contextLevel(cpu.pct) !== null;
  if (cores === null && !hasPct) return null;
  const used = hasPct && cores !== null
    ? (Math.max(0, Math.min(1, cpu.pct as number)) * cores).toFixed(1)
    : CONTEXT_PLACEHOLDER;
  const total = cores === null ? CONTEXT_PLACEHOLDER : cores.toFixed(1);
  return `${used} / ${total} CORES`;
}

/**
 * `6.2G / 8.0G` — used against the limit the percentage was computed from.
 * Same partial-knowledge rule as {@link cpuSubLabel}.
 */
export function memorySubLabel(
  memory: SystemMemoryMetric | null | undefined,
): string | null {
  if (!memory) return null;
  const hasUsed = typeof memory.usedBytes === 'number' && Number.isFinite(memory.usedBytes);
  const hasLimit = typeof memory.limitBytes === 'number' && Number.isFinite(memory.limitBytes);
  if (!hasUsed && !hasLimit) return null;
  return `${formatBytesShort(memory.usedBytes)} / ${formatBytesShort(memory.limitBytes)}`;
}
