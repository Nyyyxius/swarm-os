// Context-usage formatting + thresholds — the single source of truth for
// every CTX surface (RightPanel cell, AgentSheet cell, LeftPanel AGENT
// CONTEXT rows, MonitoringPage table).
//
// See `docs/monitoring-agents.md` (§ "Forme du champ", § Lots 4-5).
//
// This helper inherits the editorial guard-rail that `lib/loadPercent.ts`
// used to carry for the dead `LOAD` cell, and which that file's own preamble
// asked for the day a real signal landed: **never invent a number**. The
// backend supplies `contextUsage.pct` only when it could actually read a
// transcript (claude today; codex/opencode best-effort later; gemini never).
// Anything else — field absent, `null` limit, provider without telemetry,
// terminated session — renders the em-dash `—` (U+2014, NOT the ASCII
// hyphen). A fabricated `62%` would suggest a precision we do not have and
// could drive an irreversible operator decision (a needless CLEAR wipes an
// agent's working context).
//
// `stale` is NOT a missing value: it is a real, last-known measurement that
// the server flagged as possibly outdated (typically right after a `/clear`,
// until the agent's next turn is read back). We keep showing the number —
// dropping to `—` would lose information — but muted, with a `STALE` tag, so
// the operator knows not to act on the last digit.

/** Em-dash placeholder used when no context signal is available. */
export const CONTEXT_PLACEHOLDER = '—';

/**
 * Threshold between `ok` and `warn`. Below it the agent has comfortable
 * headroom; at or above it a compaction starts being worth considering.
 */
export const CONTEXT_WARN_AT = 0.7;

/**
 * Threshold between `warn` and `bad`. At or above it the agent is close
 * enough to its window that the CLI may auto-compact mid-task.
 */
export const CONTEXT_BAD_AT = 0.9;

/** Severity bucket — maps 1:1 onto the `--ok` / `--warn` / `--bad` tokens. */
export type ContextLevel = 'ok' | 'warn' | 'bad';

/**
 * Bucket a context fraction. `null` for any non-measurement (absent field,
 * null pct, NaN, ±Infinity) so callers can branch on "no signal" without
 * re-implementing the guard.
 *
 * Boundaries are inclusive on the upper bucket: `ok < 0.7 ≤ warn < 0.9 ≤ bad`.
 */
export function contextLevel(
  pct: number | null | undefined,
): ContextLevel | null {
  if (pct === null || pct === undefined) return null;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (pct >= CONTEXT_BAD_AT) return 'bad';
  if (pct >= CONTEXT_WARN_AT) return 'warn';
  return 'ok';
}

/**
 * CSS custom-property reference for a bucket, ready to drop into a `color`
 * or `background` style. `null` (no signal) → the muted text token, which is
 * also what the `—` placeholder should be painted with.
 */
export function contextColorVar(level: ContextLevel | null): string {
  switch (level) {
    case 'ok': return 'var(--ok)';
    case 'warn': return 'var(--warn)';
    case 'bad': return 'var(--bad)';
    default: return 'var(--text-mute)';
  }
}

/**
 * Format a context fraction as `NN%`, or `—` when there is no measurement.
 * Rounded to the nearest integer and clamped to `[0, 100]` (the server
 * already clamps `used/limit` to 1, but a stale snapshot from an older
 * backend must not be able to paint `142%`).
 */
export function formatContextPercent(
  pct: number | null | undefined,
): string {
  if (contextLevel(pct) === null) return CONTEXT_PLACEHOLDER;
  const rounded = Math.round((pct as number) * 100);
  return `${Math.max(0, Math.min(100, rounded))}%`;
}

/**
 * Width of the mini `.pill-bar` fill, in percent, for a context fraction.
 * `0` when there is no measurement — the bar renders empty rather than
 * absent, so the row keeps its rhythm in a column of gauges.
 */
export function contextBarWidth(pct: number | null | undefined): number {
  if (contextLevel(pct) === null) return 0;
  return Math.max(0, Math.min(100, (pct as number) * 100));
}

/**
 * Compact token count: `847`, `156K`, `1.2M`. `—` when absent.
 *
 * `K`/`M` are upper-case on purpose — every numeric label in this UI is
 * Geist Mono all-caps (`CTX`, `MSGS`, `AGT`), and a lower-case `k` next to
 * them reads as a different typeface.
 */
export function formatTokensShort(n: number | null | undefined): string {
  if (n === null || n === undefined) return CONTEXT_PLACEHOLDER;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return CONTEXT_PLACEHOLDER;
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/**
 * The tag of a gauge whose context was just reset and has made no call since
 * (`ContextUsageView.awaitingCall`), or `null`. It REPLACES the STALE tag:
 * there is no old number left to call stale — the server sends none.
 */
export function contextResetTag(
  usage: { awaitingCall?: 'compact' | 'clear' } | null | undefined,
): string | null {
  if (!usage?.awaitingCall) return null;
  return usage.awaitingCall === 'clear' ? 'CLEARED · NEXT CALL' : 'COMPACTED · NEXT CALL';
}

/** Tooltip twin of `contextResetTag`. */
export const CONTEXT_RESET_TITLE =
  'context was just reset — the next API call will give the new size (the old one is not shown)';

/**
 * `156K/200K` — the used/limit pair shown under the percentage. When the
 * limit is unknown (`limitTokens: null` — model absent from the catalogue
 * and from the pinned fallbacks) we still show what we DID measure:
 * `156K/—`. Returns `null` when there is no usage object at all, so the
 * caller can drop the whole label instead of rendering `—/—`.
 */
export function formatContextTokens(
  used: number | null | undefined,
  limit: number | null | undefined,
): string | null {
  if (used === null || used === undefined) return null;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return `${formatTokensShort(used)}/${formatTokensShort(limit)}`;
}
