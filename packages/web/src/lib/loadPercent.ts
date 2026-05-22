// S10 — "load %" editorial guard-rail.
//
// See `docs/update_system/10_load_percent.md` for the full design rationale.
//
// Context: the desktop prototype (`prototypes/panels.jsx:192-205` and
// `prototypes/mobile/mobile-sheets.jsx:95-108`) renders a 3-cell stat-bar
// `pr-stats` where the first cell shows a `LOAD` percentage derived from a
// hard-coded `selected.load` scalar. The production backend has NO source
// of truth for a per-session "load" metric — no `load`/`cpu`/`bytesPerSec`
// field on `SessionView` or `OrchestratorView`, no `/proc` polling, no PTY
// throughput accounting.
//
// Decision (S10 option a): until a real signal exists, the UI MUST render
// the em-dash `—` (U+2014, NOT the ASCII hyphen `-` U+002D). Never invent
// a number — a fake `62%` would suggest a precision we don't have and
// could drive irreversible operator decisions ("session overloaded → kill").
//
// This helper is the SINGLE source of formatting for that cell. It exists
// now so that when the `ProcessPanel` stat-bar is ported from `prototypes/`
// to `packages/web/src/components/`, the component can simply call
// `formatLoadPercent(session.load)` and the v1 contract ("`—` everywhere")
// is enforced by the helper rather than scattered through render code.
//
// Forward compatibility: if S10 option (b) — PTY output-rate — ever lands
// (cf. §5.2 of the doc), the backend would expose a numeric `loadHint`
// (NOT named `load`) and this helper would start rendering `XX%`. The
// label in the UI would then be `ACTIVITY`/`OUT`, not `LOAD`, to avoid
// pretending we measured CPU.

/**
 * Em-dash placeholder used when no load signal is available.
 * Explicit U+2014 (not ASCII hyphen) for visual consistency with the
 * `UPTIME`/`PARENT` cells of the prototype stat-bar.
 */
export const LOAD_PLACEHOLDER = '—';

/**
 * Format a per-session load value for the `pr-stats` stat-bar cell.
 *
 * Contract:
 *   - `null` / `undefined` / `NaN` / non-finite → returns `—` (U+2014).
 *   - A finite number in `[0, 1]` → returns `XX%` (rounded to nearest int,
 *     clamped to `[0, 100]`).
 *
 * In v1 the backend never supplies a value, so every call site receives
 * `undefined` and the cell renders `—`. The numeric branch exists only to
 * keep the helper future-proof for option (b) (cf. file preamble) — until
 * that day, do NOT pass a synthesised number; that would defeat the whole
 * point of the S10 guard-rail.
 *
 * @param value backend-supplied load fraction in `[0, 1]`, or `null`/
 *              `undefined` when no measurement exists.
 */
export function formatLoadPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return LOAD_PLACEHOLDER;
  if (typeof value !== 'number' || !Number.isFinite(value)) return LOAD_PLACEHOLDER;
  const pct = Math.round(value * 100);
  const clamped = Math.max(0, Math.min(100, pct));
  return `${clamped}%`;
}
