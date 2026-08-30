// packages/web/src/lib/budget.ts
//
// Cost budgets — the pure half of Lot 14 (docs/monitoring-agents.md).
//
// One module for BOTH ends of the feature, because they are two views of the
// same number and splitting them is how `$50` and `$50.00` end up on the same
// screen:
//
//   - the FORM end (RoleDialog, RolesPage): parsing what the operator typed
//     into the `costBudgetUsd` a role stores, and saying back what is stored;
//   - the READING end (toast, TEAM COSTS badge, agent table badge): how a
//     crossing reads once the server has decided there was one.
//
// Money formatting is `lib/tokenCost.ts`' `formatUsd` throughout — never a
// second `toFixed(2)`. The rule the rest of the monitoring surfaces follow
// holds here too: absent is absent. A team with no `budget` is silent, NOT a
// team that is comfortably under one.

import type { BudgetAction, TeamCostRow } from '../api/client';
import { formatUsd } from './tokenCost';

/** The one label, so the badge and its tests can never drift apart. */
export const OVER_BUDGET_BADGE = 'OVER BUDGET';

/** Default when the server omits the field — see `BudgetAction`. */
export const DEFAULT_BUDGET_ACTION: BudgetAction = 'notify';

/** Narrow an arbitrary value to a `BudgetAction`, defaulting to `notify`. */
export function toBudgetAction(v: unknown): BudgetAction {
  return v === 'pause' ? 'pause' : DEFAULT_BUDGET_ACTION;
}

// ── the form end ────────────────────────────────────────────────────────────

/**
 * Parse the COST BUDGET (USD) field.
 *
 * Empty (or blank) is a legitimate value — it means "no budget" — and is the
 * ONLY way to clear one, hence `{ ok: true, value: null }` rather than an
 * error. Anything else must be a real number strictly greater than zero:
 *
 *   - `0` is rejected rather than silently treated as "no budget". A budget of
 *     zero would fire on the team's first token, and an operator who typed it
 *     meant something we cannot guess; asking is cheaper than pausing a swarm.
 *   - a typo (`5O`, `-3`, `1e999`) is rejected rather than coerced to null.
 *     Dropping it would leave the dialog looking saved with no budget set,
 *     which is the one failure mode this field cannot afford — the operator
 *     walks away believing a ceiling exists.
 *
 * A leading `$` and thousands separators are accepted: they are what a person
 * copying a figure out of a bill actually pastes.
 */
export function parseCostBudget(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const cleaned = trimmed.replace(/^\$/, '').replace(/,/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      error: 'Le budget doit être un nombre > 0 (laisse vide pour aucun budget).',
    };
  }
  return { ok: true, value: n };
}

/**
 * The stored budget as a form value: `'50'` / `'12.5'`, `''` for none.
 *
 * Trailing zeros are dropped (`50`, not `50.00`) — this is an input the
 * operator will edit, not an amount they will compare down a column, and
 * `50.00` invites a cursor fight the first time they want `500`.
 */
export function budgetFieldValue(usd: number | null | undefined): string {
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0
    ? String(usd)
    : '';
}

/**
 * The RolesPage read-only line, in the register of `autoCleanupSummary`:
 * `$50.00 · pause de la team au dépassement` / the disabled sentence.
 */
export function budgetSummary(
  usd: number | null | undefined,
  action: BudgetAction | undefined,
): string {
  const amount = typeof usd === 'number' && usd > 0 ? formatUsd(usd) : null;
  if (amount === null) return '— (aucun budget : la team dépense sans plafond) —';
  return toBudgetAction(action) === 'pause'
    ? `${amount} · pause de toute la team au dépassement`
    : `${amount} · notification seule au dépassement`;
}

// ── the reading end ─────────────────────────────────────────────────────────

/** `TEAM PAUSED` / `NOTIFY` — the second half of the toast's figure line. */
export function budgetActionLabel(action: BudgetAction | undefined): string {
  return toBudgetAction(action) === 'pause' ? 'TEAM PAUSED' : 'NOTIFY';
}

/**
 * `$52.10 / $50.00` — spend over ceiling.
 *
 * An unformattable side (absent, negative, NaN) falls back to `—` on that side
 * alone rather than dropping the pair: "we know the ceiling, not the spend" is
 * still worth saying, and it is the shape the toast would take if a future
 * server ever emitted a partial payload.
 */
export function formatBudgetPair(
  costUsd: number | null | undefined,
  budgetUsd: number | null | undefined,
): string {
  return `${formatUsd(costUsd) ?? '—'} / ${formatUsd(budgetUsd) ?? '—'}`;
}

/** The toast's figure line: `$52.10 / $50.00 · TEAM PAUSED`. */
export function formatBudgetLine(
  costUsd: number | null | undefined,
  budgetUsd: number | null | undefined,
  action: BudgetAction | undefined,
): string {
  return `${formatBudgetPair(costUsd, budgetUsd)} · ${budgetActionLabel(action)}`;
}

/**
 * Has this team crossed its budget? `false` for a team with no budget at all,
 * and for one the server has not (yet) flagged.
 *
 * The verdict is the SERVER's `exceeded` flag rather than a client-side
 * `cost > usd`: the janitor compares against a DB aggregate that includes
 * removed workers, and re-deriving it here from the rounded total on screen
 * would let the badge and the pause disagree at the boundary.
 */
export function isOverBudget(team: Pick<TeamCostRow, 'budget'>): boolean {
  return team.budget?.exceeded === true;
}

/**
 * The orchestrator ids whose team is over budget — the lookup the agent table
 * maps its rows through (it knows a session's `teamId`, not its team's bill).
 *
 * A `Set` rather than a scan per row: the table renders every agent of every
 * team on each 3 s snapshot, and the cost snapshot beside it is polled
 * independently.
 */
export function overBudgetTeamIds(
  teams: readonly TeamCostRow[] | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const t of teams ?? []) {
    if (isOverBudget(t)) out.add(t.orchId);
  }
  return out;
}

/**
 * The native title of the TOTAL cell of an over-budget team — the one place
 * the pair is shown next to the amount it is about. `undefined` for every
 * other team, so no unexplained tooltip appears on a healthy row.
 */
export function budgetTitle(team: TeamCostRow): string | undefined {
  if (!isOverBudget(team)) return undefined;
  const b = team.budget!;
  return `${formatBudgetPair(team.total.costUsd, b.usd)} — budget exceeded · ${
    budgetActionLabel(b.action)
  }`;
}
