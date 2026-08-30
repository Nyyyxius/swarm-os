// Team-level cost helpers — the pure half of the TEAM COSTS section of
// `#/monitoring` (docs/monitoring-agents.md, Lot 12).
//
// Everything about MONEY formatting already lives in `lib/tokenCost.ts` and is
// reused verbatim (`formatUsd`, `aggregateCostUsd`, `formatCostKpi`): a second
// dollar formatter is how `$1,234.50` and `$1234.5` end up on the same screen.
// What is new here is team-shaped, and it is all editorial:
//
//   - which burn rate is worth colouring (relative to the swarm, never an
//     absolute dollar threshold — $2/h is nothing for a 30-agent swarm and
//     alarming for one lead),
//   - how a removed-worker line reads when the workers exist but their
//     counters do not.
//
// (Cache hit — the one derived number that explains a claude bill — started
// here at Lot 12 and moved to `lib/tokenCost.ts` at Lot 13, when the per-agent
// tooltip started showing the same ratio. It is re-exported below.)
//
// The `—` rule of Lot 11 holds throughout: absent is rendered as absent, never
// as zero.

import type {
  SessionCostRow, TeamCostRow, TokenCounters,
} from '../api/client';
import {
  TOKEN_PLACEHOLDER, formatCacheHit, formatTokenIoLine, formatUsd,
} from './tokenCost';

/**
 * Cache hit ratio — MOVED to `lib/tokenCost.ts` at Lot 13, which put the same
 * ratio in the per-agent TOKENS tooltip. Re-exported here so the team
 * surfaces (and their tests) keep importing it from the module they always
 * did; there is exactly one implementation, in `tokenCost.ts`.
 */
export { formatCacheHit };

/**
 * How many times the median burn a team must exceed before its `BURN /H`
 * cell is painted `--warn`.
 *
 * Three, and relative to the MEDIAN rather than the mean, because the mean is
 * dragged up by exactly the outlier we are trying to spot: with burns of
 * `[0.2, 0.3, 9.0]` the mean is 3.2 and the runaway team is a mere 2.8× it —
 * under any sane factor, uncoloured. The median is 0.3 and it is 30×.
 */
export const BURN_ANOMALY_FACTOR = 3;

/** A burn we can actually reason about: a real, finite, non-negative rate. */
function isRate(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Median of the burns we know, or `null` when NOT ONE team reports one.
 *
 * Null burns are dropped rather than counted as zero: a team whose ring
 * buffer has fewer than two points has not been measured, and folding it in
 * as 0 would halve the median and paint half the table amber.
 */
export function medianBurn(teams: readonly TeamCostRow[]): number | null {
  const rates = teams
    .map((t) => t.burnPerHour)
    .filter(isRate)
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const mid = rates.length >> 1;
  const hi = rates[mid] as number;
  return rates.length % 2 === 1 ? hi : ((rates[mid - 1] as number) + hi) / 2;
}

/**
 * Is this burn worth colouring? `> BURN_ANOMALY_FACTOR × median`.
 *
 * Strictly greater, so the single-team case can never light itself up (its
 * own burn IS the median, and `x > 3x` is false for every non-negative x).
 * An unknown burn is never anomalous — `—` has nothing to be alarmed about.
 */
export function isBurnAnomalous(
  burn: number | null | undefined,
  median: number | null,
): boolean {
  if (!isRate(burn) || median === null) return false;
  return burn > BURN_ANOMALY_FACTOR * median;
}

/** `$1.84` for a burn, `—` for a team the tracker cannot measure yet. */
export function formatBurn(burn: number | null | undefined): string {
  return formatUsd(burn ?? null) ?? TOKEN_PLACEHOLDER;
}

/**
 * Cost desc, biggest bill first — the order the operator opened this section
 * to see. Teams with no priced spend sink to the bottom (they cannot be
 * ranked against a number), and ties break on name so the list does not
 * reshuffle under the cursor every 15 s poll.
 *
 * Returns a new array; the snapshot from the hook is never mutated.
 */
export function sortTeamsByCostDesc(
  teams: readonly TeamCostRow[],
): TeamCostRow[] {
  return [...teams].sort((a, b) => {
    const ca = isRate(a.total.costUsd) ? a.total.costUsd : null;
    const cb = isRate(b.total.costUsd) ? b.total.costUsd : null;
    if (ca === null && cb === null) return a.name.localeCompare(b.name);
    if (ca === null) return 1;
    if (cb === null) return -1;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The REMOVED cell: `INCL. 4 REMOVED · $12.40`, `INCL. 4 REMOVED · —` when
 * those workers carry no counters (sessions older than Lot 11), and a bare
 * `—` when nobody ever left the team.
 *
 * The three states are deliberately distinct. `INCL. 4 REMOVED · —` says
 * "four workers are folded into the total above, but we cannot tell you how
 * much of it is theirs"; collapsing it to `—` would hide the fact that the
 * team's history is bigger than its current roster.
 */
export function formatRemovedCell(
  removed: TeamCostRow['removed'],
): string {
  const count = Number.isFinite(removed?.count) ? removed.count : 0;
  if (count <= 0) return TOKEN_PLACEHOLDER;
  return `INCL. ${count} REMOVED · ${formatUsd(removed.costUsd) ?? TOKEN_PLACEHOLDER}`;
}

/** The token line of a removed worker: `IN 4.1M · OUT 22K · CACHE HIT 74%`. */
export function formatSessionTokenLine(counters: TokenCounters): string {
  return `${formatTokenIoLine(counters)} · CACHE HIT ${formatCacheHit(counters)}`;
}

/**
 * The badge on a removed worker, in the `badge-reason` register already used
 * by ended-team cards.
 *
 * `killed` is muted rather than coloured: an operator killing a worker is the
 * NORMAL end of a worker's life, and painting it warn would light up every
 * healthy team in the list. Any other terminal status on a removed session
 * (`failed`, `stopped`, a reaper sweep) keeps the default warn border,
 * because it is something that happened TO the agent rather than to it by
 * design.
 */
export function removedBadge(status: string): { label: string; cls: string } {
  const killed = String(status ?? '').toLowerCase() === 'killed';
  return {
    label: killed ? 'KILLED' : 'REMOVED',
    cls: killed ? 'badge-reason killed' : 'badge-reason',
  };
}

/**
 * The removed sessions of a team detail, in the order the panel lists them:
 * dearest first, so the worker that actually cost something is never below
 * the fold under a dozen $0 ones. Sessions with no priced cost go last.
 */
export function removedSessions(
  sessions: readonly SessionCostRow[],
): SessionCostRow[] {
  return sessions
    .filter((s) => s.removed)
    .sort((a, b) => {
      const ca = isRate(a.costUsd) ? a.costUsd : null;
      const cb = isRate(b.costUsd) ? b.costUsd : null;
      if (ca === null && cb === null) return a.name.localeCompare(b.name);
      if (ca === null) return 1;
      if (cb === null) return -1;
      if (cb !== ca) return cb - ca;
      return a.name.localeCompare(b.name);
    });
}
