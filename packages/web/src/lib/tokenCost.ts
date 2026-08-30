// Token-spend + estimated-cost formatting — the single source of truth for
// the `TOKENS · COST` column and the `EST. COST` KPI of `#/monitoring`
// (docs/monitoring-agents.md, Lot 11).
//
// Same editorial guard-rail as `lib/contextPercent.ts`, applied to money:
// **never invent a number**. The server counts what it can actually read
// (claude transcript, codex rollout, opencode control plane) and prices it
// from the models.dev catalogue; gemini reports nothing, an old backend
// reports nothing, and a session with no activity yet reports nothing. All of
// those render the em-dash — not `$0.00`, which would read as "this agent is
// free" rather than "we cannot see this agent".
//
// The same rule governs the aggregate, which is why `aggregateCostUsd`
// returns a `partial` flag rather than just a number: a swarm where half the
// agents are unpriced must show `≥ $12.40`, never a bare `$12.40` that
// claims to be the whole bill.
//
// `costBasis` says where an amount came from, and every amount this module
// renders carries it as a two-letter suffix: `EST` for catalogue list prices
// applied to counted tokens, `RPT` for a figure the provider's own CLI put on
// the wire (Lot 13). The suffix is never dropped — an unlabelled `$5.61` is
// the one rendering that lets an operator mistake an estimate for an invoice.

import type { TokenCounters, TokenUsageView } from '../api/client';
import { CONTEXT_PLACEHOLDER, formatTokensShort } from './contextPercent';

/** Em-dash placeholder, shared with every other "no signal" cell. */
export const TOKEN_PLACEHOLDER = CONTEXT_PLACEHOLDER;

/** A number we can actually reason about: real, finite, non-negative. */
function isCount(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Compact token count: `847`, `1K`, `156K`, `18.2M`. `—` when there is no
 * number to show (absent, NaN, negative).
 *
 * Deliberately a thin alias of `formatTokensShort` rather than a second
 * implementation: the CONTEXT column one cell to the left already formats
 * token counts, and the same 141 229 tokens reading `141K` there and `141.2K`
 * here would look like two different measurements of the same agent.
 */
export function formatTokenCount(n: number | null | undefined): string {
  return formatTokensShort(n);
}

/**
 * A USD amount, two decimals, thousands-separated: `$5.61`, `$1,234.50`.
 *
 * - `null` return means "no amount to show" — the caller decides whether that
 *   becomes `—` alone or `— EST`. Returning the placeholder here would let a
 *   caller print `$—`.
 * - A real zero prints `$0.00`: a model priced at zero is a fact, not a
 *   rounding artefact.
 * - Anything above zero but under a cent prints `<$0.01`, because `$0.00` for
 *   money that was actually spent is a lie the operator would repeat.
 * - Negative or non-finite is treated as no measurement, not as a number to
 *   render: a `-$3.00` bill is a bug upstream, and printing it would hide it
 *   behind a plausible-looking cell.
 *
 * The locale is pinned to `en-US` on purpose — this UI's numerals are
 * Geist Mono all-caps English throughout, and a browser-dependent decimal
 * separator would make the same total render differently per operator.
 */
export function formatUsd(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Line 1 of the cell: `IN 18.2M · OUT 141K`.
 *
 * Only the two buckets the operator budgets against. Cache read/write are
 * real spend too, but they are an order of magnitude noisier and belong in
 * the tooltip, not in a 9 px line that has to be scannable down forty rows.
 *
 * Takes the bare `TokenCounters` rather than a full `TokenUsageView` so the
 * Lot 12 removed-worker rows — whose `costUsd` sits beside the counters, not
 * inside them — render the SAME line as the table column instead of a
 * near-identical second one.
 */
export function formatTokenIoLine(usage: TokenCounters): string {
  return `IN ${formatTokenCount(usage.in)} · OUT ${formatTokenCount(usage.out)}`;
}

/**
 * Cache hit ratio: `cacheRead / (in + cacheRead)`, as `52%`.
 *
 * The single most actionable number on a claude bill — cache reads are an
 * order of magnitude cheaper than fresh input, so a worker at 12% is one
 * whose prompt keeps being invalidated. `—` when the denominator is 0 (a
 * session that never read a token) or the counters are absent: a 0% there
 * would read as "the cache is broken" rather than "nothing was measured".
 *
 * Lives here rather than in `lib/teamCost.ts` (where Lot 12 first wrote it)
 * because Lot 13 puts the same ratio in the per-AGENT tooltip: one
 * implementation, so the team view and the row can never disagree by a point.
 * `lib/teamCost.ts` re-exports it, so the Lot 12 call sites are untouched.
 */
export function formatCacheHit(counters: TokenCounters | null): string {
  if (!counters) return TOKEN_PLACEHOLDER;
  const fresh = isCount(counters.in) ? counters.in : 0;
  const cached = isCount(counters.cacheRead) ? counters.cacheRead : 0;
  const denom = fresh + cached;
  if (denom <= 0) return TOKEN_PLACEHOLDER;
  return `${Math.round((cached / denom) * 100)}%`;
}

/**
 * The two-letter tag that follows every amount: `EST` (catalogue rates) or
 * `RPT` (the provider's own figure). Anything unexpected on the wire falls
 * back to `EST`, which is the claim that promises the least.
 */
export function costBasisTag(basis: TokenUsageView['costBasis']): string {
  return basis === 'reported' ? 'RPT' : 'EST';
}

/**
 * What the tag means, spelled out for a native `title`. Same fallback rule as
 * `costBasisTag`: an unknown basis is described as an estimate.
 */
export function costBasisTitle(basis: TokenUsageView['costBasis']): string {
  return basis === 'reported'
    ? 'reported by the provider'
    : 'estimated from catalogue rates';
}

/**
 * Line 2 of the cell: `$5.61 EST` / `$5.61 RPT`, or `— EST` when the tokens
 * were counted but no price could be applied (model absent from the
 * catalogue). The tag stays in every case: the missing half is the amount,
 * not the statement about where an amount here would come from.
 */
export function formatCostLine(usage: TokenUsageView): string {
  return `${formatUsd(usage.costUsd) ?? TOKEN_PLACEHOLDER} ${costBasisTag(usage.costBasis)}`;
}

/**
 * Full ventilation for the cell's native `title`, at full precision — the
 * tooltip is where a number is allowed to be long:
 * `IN 18,214,003 · OUT 141,229 · CACHE READ 1,204,556 · CACHE WRITE 88,120
 *  · CACHE HIT 6% · EST $5.61`
 *
 * CACHE HIT sits right after the two cache buckets it is computed from, and
 * before the money it explains: reading the tooltip left to right is then the
 * actual causal chain (what was read fresh, what came from cache, how good
 * that ratio is, what it cost).
 */
export function tokenBreakdownTitle(usage: TokenUsageView): string {
  const exact = (n: number): string =>
    (isCount(n) ? Math.round(n).toLocaleString('en-US') : TOKEN_PLACEHOLDER);
  return [
    `IN ${exact(usage.in)}`,
    `OUT ${exact(usage.out)}`,
    `CACHE READ ${exact(usage.cacheRead)}`,
    `CACHE WRITE ${exact(usage.cacheWrite)}`,
    `CACHE HIT ${formatCacheHit(usage)}`,
    `${costBasisTag(usage.costBasis)} ${formatUsd(usage.costUsd) ?? TOKEN_PLACEHOLDER}`,
  ].join(' · ');
}

/**
 * Sum of the costs we actually know, plus whether anything was left out.
 *
 * `total: null` means NOTHING was priced — the KPI renders `—`. `partial` is
 * only ever true alongside a non-null total (some known, some not), so the
 * caller never has to reason about a `≥ —`.
 *
 * Unknown covers every shape of absence in one bucket: no `tokenUsage` at all
 * (gemini, terminated session, backend predating Lot 11), a `costUsd` of
 * `null` (tokens counted, model unpriced), and a non-finite or negative
 * number from a drifting backend — the last one would otherwise poison the
 * whole sum with a single NaN.
 *
 * The unit is USD, but NOT necessarily a total: Lot 12's `BURN /H` KPI sums
 * per-hour rates through this exact function, because "some of the addends
 * are unknown, so the sum is a lower bound" is the same statement about
 * $/h as it is about $. The denomination lives in the KPI's label, which is
 * why nothing here appends one.
 */
export interface CostAggregate {
  /** Sum of the known amounts in USD, or `null` when none were known. */
  total: number | null;
  /** At least one known amount AND at least one unknown one. */
  partial: boolean;
}

export function aggregateCostUsd(
  costs: readonly (number | null | undefined)[],
): CostAggregate {
  let total = 0;
  let known = 0;
  let unknown = 0;
  for (const c of costs) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      total += c;
      known += 1;
    } else {
      unknown += 1;
    }
  }
  return {
    total: known > 0 ? total : null,
    partial: known > 0 && unknown > 0,
  };
}

/**
 * The `EST. COST` KPI value: `—`, `$12.40`, or `≥$12.40` when some of the
 * displayed agents report no cost. The `≥` is not decoration — it is the
 * difference between a total and a lower bound, and the operator budgeting
 * off this number needs to know which one they are reading.
 *
 * Shared verbatim with Lot 12's `BURN /H` cell (a team whose burn is not yet
 * measurable makes the swarm's burn a lower bound in the same way) and with
 * the `Σ` in the TEAM COSTS header.
 */
export function formatCostKpi(agg: CostAggregate): string {
  const amount = formatUsd(agg.total);
  if (amount === null) return TOKEN_PLACEHOLDER;
  return agg.partial ? `≥${amount}` : amount;
}
