/**
 * Cost-budget watch (docs/monitoring-agents.md, Lot 14).
 *
 * A role can carry a ceiling — `costBudgetUsd` — on what ONE team of that role
 * is allowed to spend in total. This module is the periodic janitor that
 * notices the crossing and acts on it, patterned on `reaper.ts`: a pure
 * `checkBudgetsOnce(deps)` plus an unref'd `startBudgetWatch` around it.
 *
 * WHICH NUMBER IS COMPARED, and why it matters more than anything else here:
 * the team's spend comes from the Lot 12 machinery — `buildTeamCostRows` over
 * `db.sumTokenUsageByOrchestrator()` — and NOT from a sum over the live
 * sessions. Three consequences, all deliberate:
 *
 *   - **Removed agents count.** A reaped or killed worker keeps its row
 *     (`hidden_at IS NOT NULL`) and its counters. On a 24/7 swarm those workers
 *     are most of the bill; a budget that ignored them would never trigger.
 *   - **The figure is a LOWER BOUND.** Tokens billed on a model the rate card
 *     cannot price contribute 0, never a guess (`priceBuckets`). So a team can
 *     only ever cross its budget LATE — never early on an invented price. This
 *     is the honest direction to be wrong in for a guard-rail that pauses
 *     agents.
 *   - **`costUsd: null` is not `$0`.** A team whose rows carry no counters at
 *     all has no measurement, and no measurement can cross a ceiling. Such a
 *     team is skipped, not flagged.
 *
 * ONE-SHOT PER CROSSING. The janitor keeps an in-memory `Map<orchId, flag>`.
 * A team already flagged is silent on every subsequent tick — no event, no
 * Discord, no second pause. It re-arms only when the comparison stops holding
 * (in practice: the operator raised the budget) or when the team stops being a
 * budgeted live team at all (destroyed, role changed, budget cleared). The
 * state is memory-only on purpose: after a restart the fleet is re-evaluated
 * from the DB aggregate, and re-announcing a still-exceeded budget once is a
 * better failure than never mentioning it again.
 *
 * Hard invariants:
 *   - a role with no budget (`costBudgetUsd === null`) is NEVER touched, and
 *     neither is a team with no role;
 *   - `pause` suspends every RUNNING/WAITING session of the team, LEAD
 *     INCLUDED, and kills nothing — the operator resumes by hand;
 *   - every team, every session and every side effect is wrapped, so one bad
 *     row can neither stop the timer nor skip the rest of the sweep.
 */

import { withModule } from '../../logger.js';
import { eventBus, type BudgetExceededPayload } from '../../events.js';
import type { Spawner } from '../spawner/index.js';
import type { RoleStore, BudgetAction } from '../roles/index.js';
import type { SwarmDb } from '../db/index.js';
import { buildTeamCostRows, type TeamBudgetView } from '../metrics/costs.js';
import type { SessionStatus } from './session.js';

const log = withModule('orchestrator.budget');

/**
 * Statuses a session can actually be paused from — the exact set
 * `Session.pause()` accepts. `starting` is excluded there (freezing an agent
 * mid-boot leaves it unidentified), and terminal / already-paused sessions have
 * nothing to suspend. Filtering here rather than catching the refusal keeps the
 * pause count honest.
 */
const PAUSABLE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'running',
  'waiting',
]);

/** Reason stamped in the session log when the budget suspends a team. */
const PAUSE_REASON = 'budget-exceeded';

/** The two role fields this janitor consults. `Role` satisfies it. */
export interface TeamBudgetPolicy {
  /** The ceiling in USD, or `null` for "no budget" (never `0`). */
  costBudgetUsd: number | null;
  budgetAction: BudgetAction;
}

/** The minimal session shape the watch reads. `Session` satisfies it. */
export interface BudgetWatchSession {
  id: string;
  status: SessionStatus;
}

/** The minimal orchestrator shape the watch reads. `Orchestrator` satisfies it. */
export interface BudgetWatchTeam {
  id: string;
  name: string;
  roleId: string | null;
  listSessions(): readonly BudgetWatchSession[];
  /** SIGSTOP one session. Throws on an impossible transition — always wrapped. */
  pauseSession(id: string, reason?: string): unknown;
}

/**
 * What the janitor remembers about a crossing it has already signalled.
 * `budgetUsd` is the ceiling that was in force at that moment — kept for the
 * log line that explains WHY a team went quiet, not for the comparison itself
 * (a raised budget re-arms through `isBudgetExceeded`, not through this).
 */
export interface BudgetFlag {
  flaggedAt: number;
  budgetUsd: number;
}

/**
 * One-shot memory, keyed by orchestrator id. Owned by the caller (the janitor
 * holds one for its whole life) so `checkBudgetsOnce` stays a function of its
 * inputs and a test can drive several ticks over the same state.
 */
export type BudgetFlagState = Map<string, BudgetFlag>;

export interface BudgetCheckDeps {
  /** Live orchestrators to sweep. */
  orchestrators: () => Iterable<BudgetWatchTeam>;
  /** Resolve a role id to its budget policy (null = no role / unknown role). */
  policyForRole: (roleId: string | null) => TeamBudgetPolicy | null;
  /**
   * The team's cumulative spend, from the Lot 12 aggregate. `null` = nothing
   * under this team could be priced, which is NOT `$0` and never crosses.
   */
  costForTeam: (orchId: string) => number | null;
  /** One-shot state, carried across ticks by the caller. */
  flagged: BudgetFlagState;
  /** Emit the bus event for a crossing. Wrapped by the caller of this dep. */
  emit: (team: BudgetWatchTeam, payload: BudgetExceededPayload) => void;
  /** Post the Discord notification, when the team has somewhere to post it. */
  notify?: (team: BudgetWatchTeam, payload: BudgetExceededPayload) => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * THE comparison rule, in one place.
 *
 * Exported because two callers must agree on it to the last edge: this janitor,
 * which fires the one-shot, and `GET /metrics/costs`, which renders
 * `budget.exceeded` on the page. If they diverged, the operator would see a row
 * flagged OVER BUDGET that was never announced, or the reverse.
 *
 * `>=` rather than `>`: a budget of $50 is a ceiling, and $50.000000 spent has
 * reached it. `null` cost never crosses — no measurement is not a small one.
 */
export function isBudgetExceeded(costUsd: number | null, budgetUsd: number): boolean {
  if (costUsd === null || !Number.isFinite(costUsd)) return false;
  return costUsd >= budgetUsd;
}

/**
 * The `budget` half of a `/metrics/costs` team row, or `null` when the team has
 * no budget to report against (no role, unknown role, or a role without a
 * ceiling). `null` is not `exceeded: false` — one is "no verdict", the other is
 * a measured verdict — and the shipped web half depends on that distinction.
 */
export function resolveTeamBudget(
  policy: TeamBudgetPolicy | null,
  costUsd: number | null,
): TeamBudgetView | null {
  if (!policy || policy.costBudgetUsd === null) return null;
  return {
    usd: policy.costBudgetUsd,
    action: policy.budgetAction,
    exceeded: isBudgetExceeded(costUsd, policy.costBudgetUsd),
  };
}

/**
 * Read a role's budget policy out of the store. `null` for a team with no role,
 * an unknown role, or a role carrying no ceiling — all three mean "this team is
 * off-limits to the janitor".
 */
export function budgetPolicyForRole(
  roleStore: RoleStore,
  roleId: string | null,
): TeamBudgetPolicy | null {
  if (!roleId) return null;
  const role = roleStore.get(roleId);
  if (!role || role.costBudgetUsd === null) return null;
  return { costBudgetUsd: role.costBudgetUsd, budgetAction: role.budgetAction };
}

/**
 * Suspend every pausable session of a team — LEAD INCLUDED. Errors are per
 * session: a worker that refuses to pause (terminated between the filter and
 * the call, no PTY, a stop in flight) must not cost the rest of the team its
 * suspension. Returns how many were actually paused.
 */
function pauseWholeTeam(team: BudgetWatchTeam): number {
  let paused = 0;
  let sessions: readonly BudgetWatchSession[] = [];
  try {
    sessions = team.listSessions();
  } catch (err) {
    log.warn({
      event: 'budget_watch.list_failed',
      orchId: team.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  for (const session of sessions) {
    try {
      if (!PAUSABLE_STATUSES.has(session.status)) continue;
      team.pauseSession(session.id, PAUSE_REASON);
      paused++;
    } catch (err) {
      log.warn({
        event: 'budget_watch.pause_failed',
        orchId: team.id,
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return paused;
}

/**
 * Run one budget pass. Pure with respect to the injected deps (the side effects
 * are `emit`, `notify` and `pauseSession`, all injected or structural). Returns
 * the number of NEW crossings signalled this pass — a team already flagged
 * counts 0, which is the whole point of the one-shot.
 *
 * Exported for the unit test: the truth table (budget or not · under, at, over ·
 * first tick vs second · budget raised) lives here so it can be exercised with
 * no timer, Spawner, DB or event bus.
 */
export function checkBudgetsOnce(deps: BudgetCheckDeps): number {
  const now = deps.now ? deps.now() : Date.now();
  const flagged = deps.flagged;
  /** Ids that are STILL budgeted live teams — everything else loses its flag. */
  const stillWatched = new Set<string>();
  let crossings = 0;

  for (const team of deps.orchestrators()) {
    try {
      const policy = deps.policyForRole(team.roleId);
      // No role, unknown role, or no ceiling → this whole team is off-limits.
      if (!policy || policy.costBudgetUsd === null) continue;
      const budgetUsd = policy.costBudgetUsd;
      // Recorded BEFORE the cost lookup: a team that is still budgeted keeps
      // its one-shot flag even if pricing throws on this particular tick.
      stillWatched.add(team.id);

      const costUsd = deps.costForTeam(team.id);
      const previous = flagged.get(team.id);

      if (!isBudgetExceeded(costUsd, budgetUsd)) {
        // Back under the ceiling — in practice because the operator raised it.
        // Re-arm, so the NEXT crossing is announced like a first one.
        if (previous) {
          flagged.delete(team.id);
          log.info({
            event: 'budget_watch.rearmed',
            orchId: team.id,
            budgetUsd,
            previousBudgetUsd: previous.budgetUsd,
            costUsd,
          });
        }
        continue;
      }

      // Already announced this crossing: stay silent. No event, no Discord, no
      // second pause — a paused team would otherwise be re-paused every minute
      // and would spam the operator forever.
      if (previous) continue;

      flagged.set(team.id, { flaggedAt: now, budgetUsd });
      crossings++;

      const payload: BudgetExceededPayload = {
        teamName: team.name,
        // Non-null by construction: `isBudgetExceeded` rejects a null cost.
        costUsd: costUsd as number,
        budgetUsd,
        action: policy.budgetAction,
      };

      // (a) The bus event — the web toast. First, and independently wrapped:
      // it is the one signal that must survive a failure of the other two.
      try {
        deps.emit(team, payload);
      } catch (err) {
        log.warn({
          event: 'budget_watch.emit_failed',
          orchId: team.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // (b) Discord, when the team has a webhook behind its notifier.
      if (deps.notify) {
        try {
          deps.notify(team, payload);
        } catch (err) {
          log.warn({
            event: 'budget_watch.notify_failed',
            orchId: team.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // (c) The teeth, when the role asked for them.
      let paused = 0;
      if (policy.budgetAction === 'pause') paused = pauseWholeTeam(team);

      log.warn({
        event: 'budget_watch.exceeded',
        orchId: team.id,
        team: team.name,
        costUsd,
        budgetUsd,
        action: policy.budgetAction,
        paused,
      });
    } catch (err) {
      log.warn({
        event: 'budget_watch.team_failed',
        orchId: team.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Drop the flag of anything that is no longer a budgeted live team: destroyed
  // teams (bounded memory), teams whose role changed, and teams whose budget was
  // cleared. All three mean the crossing we remember no longer describes
  // anything, so a future one deserves to be announced.
  for (const orchId of flagged.keys()) {
    if (!stillWatched.has(orchId)) flagged.delete(orchId);
  }

  return crossings;
}

export interface BudgetWatchHandle {
  stop(): void;
  /**
   * The live one-shot state — exposed for diagnostics and for tests that assert
   * the janitor and its handle share one map. Not a verdict source: the page
   * asks `resolveTeamBudget`, which re-reads the rule against the current cost.
   */
  readonly flagged: BudgetFlagState;
}

/**
 * Start the periodic budget watch. Unref'd interval, every tick guarded — a bad
 * sweep can never crash the 24/7 loop. `intervalMs <= 0` disables it (returns a
 * no-op handle). Mirrors `startSessionReaper`.
 *
 * One DB query per tick, whatever the fleet size: the Lot 12 aggregate is
 * fleet-wide, so the cost of every team is read once and indexed by id.
 */
export function startBudgetWatch(
  spawner: Spawner,
  roleStore: RoleStore,
  db: SwarmDb,
  opts: { intervalMs: number },
): BudgetWatchHandle {
  const { intervalMs } = opts;
  const flagged: BudgetFlagState = new Map();
  if (intervalMs <= 0) {
    log.info({ event: 'budget_watch.disabled', intervalMs });
    return { stop: () => undefined, flagged };
  }

  const tick = (): void => {
    try {
      const teams = spawner.listActive();
      // The Lot 12 roll-up, verbatim: same aggregate, same pricing, same
      // null-rules as the number the MONITORING page shows. Recomputing the
      // arithmetic here would be a second source of truth for the bill.
      const rows = buildTeamCostRows(
        db.sumTokenUsageByOrchestrator(),
        teams,
        (providerId, modelId) => spawner.modelCatalogue?.costRates(providerId, modelId) ?? null,
      );
      const costByOrch = new Map<string, number | null>();
      for (const row of rows) costByOrch.set(row.orchId, row.total.costUsd);

      checkBudgetsOnce({
        orchestrators: () => teams,
        policyForRole: (roleId) => budgetPolicyForRole(roleStore, roleId),
        costForTeam: (orchId) => costByOrch.get(orchId) ?? null,
        flagged,
        emit: (team, payload) => {
          eventBus.emitEvent({
            kind: 'session.budget_exceeded',
            orchestratorId: team.id,
            payload,
          });
        },
        notify: (team, payload) => {
          // Reuse the team's OWN notifier — the Spawner already built it from
          // the role's discord connector (`webhookUrl`), falling back to the
          // instance-wide webhook and then to a no-op. So "notify only when the
          // team has a webhook" needs no lookup here: a team without one holds
          // a `NoOpNotifier`. Fire-and-forget with a belt-and-braces catch, the
          // same shape as every other notify call site.
          const orch = spawner.get(team.id);
          if (!orch) return;
          void orch.notifier
            .notify({
              kind: 'session.budget_exceeded',
              orchestrator: {
                id: orch.id,
                name: orch.name,
                role: orch.role,
                status: orch.status,
              },
              message:
                payload.action === 'pause'
                  ? `Team ${payload.teamName} reached its cost budget and was PAUSED (lead included).`
                  : `Team ${payload.teamName} reached its cost budget.`,
              extra: {
                costUsd: payload.costUsd,
                budgetUsd: payload.budgetUsd,
                action: payload.action,
              },
            })
            .catch((err: unknown) => {
              log.warn({
                event: 'budget_watch.discord_failed',
                orchId: team.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        },
      });
    } catch (err) {
      log.warn({
        event: 'budget_watch.tick_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log.info({ event: 'budget_watch.started', intervalMs });
  return { stop: () => clearInterval(timer), flagged };
}

/**
 * The `budget` lookup `GET /metrics/costs` hands to `buildTeamCostRows`.
 *
 * Deliberately NOT a read of the janitor's flag map. The flag is NOTIFICATION
 * state — one-shot, cleared when a budget is raised, and empty entirely when the
 * janitor is disabled (`SWARM_OS_BUDGET_CHECK_INTERVAL_MS=0`) or has not ticked
 * yet. The page asks a different question ("is this team over its budget right
 * now?") and gets it from the same rule applied to the same numbers, which is
 * what "consistent" has to mean between a 15 s poll and a 60 s sweep.
 */
export function createTeamBudgetLookup(
  spawner: Pick<Spawner, 'get'>,
  roleStore: RoleStore,
): (orchId: string, costUsd: number | null) => TeamBudgetView | null {
  return (orchId, costUsd) => {
    try {
      const orch = spawner.get(orchId);
      if (!orch) return null;
      return resolveTeamBudget(budgetPolicyForRole(roleStore, orch.roleId), costUsd);
    } catch (err) {
      log.warn({
        event: 'budget_watch.lookup_failed',
        orchId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}
