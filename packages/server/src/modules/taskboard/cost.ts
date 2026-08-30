/**
 * Lot 16 — the adapter that turns a card's `assignee` into live dollars
 * (docs/monitoring-agents.md "Lot 16").
 *
 * It lives HERE, next to the board, rather than inside `store.ts`: the store
 * owns SQLite and knows nothing about the orchestrator module, and this file
 * keeps it that way. The ports below are structural on purpose — a real
 * `Spawner` / `Orchestrator` / `Session` satisfies them without either module
 * importing the other (same idea as `SpawnerTeamsPort` for the update runner).
 *
 * Honest or absent, never approximate: every path that cannot name ONE session
 * with certainty answers `null`, which costs a cost snapshot and nothing else.
 */

/** The slice of a `Session` this resolver needs. */
export interface CostSession {
  readonly id: string;
  readonly name: string;
  toView(): { tokenUsage?: { costUsd: number | null } };
}

/** The slice of an `Orchestrator` (a team) this resolver needs. */
export interface CostTeam {
  getSession(id: string): CostSession | undefined;
  listSessions(): CostSession[];
}

/** The slice of the `Spawner` (the team registry) this resolver needs. */
export interface CostTeamRegistry {
  get(id: string): CostTeam | undefined;
}

/**
 * Resolve `assignee` inside `team`. The board's `assignee` is CONTRACTUALLY a
 * session id (`board.assign` says so) but nothing enforces it — `assertValidId`
 * only checks the string's shape, and an agent name like `refactor-worker`
 * passes that regex cleanly — so a name is tried as a fallback.
 *
 * A name shared by two sessions (a worker that was restarted under the same
 * name) is genuinely ambiguous about WHO spent the money, so it resolves to
 * nothing at all. Terminated sessions stay eligible on purpose: a bill is still
 * true after the agent exits, and an agent that finished its card between
 * `doing` and `done` is the normal case, not an edge one.
 */
function resolveSession(team: CostTeam, assignee: string): CostSession | null {
  const byId = team.getSession(assignee);
  if (byId) return byId;
  const byName = team.listSessions().filter((s) => s.name === assignee);
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * Build the `TaskboardCostLookup` the board injects at boot. Structurally typed
 * so the caller passes the `Spawner` straight in.
 *
 * Reads the cumulative figure off `toView()` because that is where the money
 * is: `Session` counts TOKENS, and `costUsd` is a read-time multiplication by a
 * live rate card (or the price the provider itself quoted, which wins). There
 * is no cheaper accessor, and this runs only on a card's status transition —
 * never on a poll.
 */
export function makeSessionCostLookup(registry: CostTeamRegistry) {
  return (
    orchestratorId: string,
    assignee: string,
  ): { sessionId: string; costUsd: number | null } | null => {
    const team = registry.get(orchestratorId);
    if (!team) return null;
    const session = resolveSession(team, assignee);
    if (!session) return null;
    return { sessionId: session.id, costUsd: session.toView().tokenUsage?.costUsd ?? null };
  };
}
