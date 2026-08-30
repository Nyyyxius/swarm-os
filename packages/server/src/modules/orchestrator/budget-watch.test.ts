import { describe, it, expect } from 'vitest';
import {
  checkBudgetsOnce,
  isBudgetExceeded,
  resolveTeamBudget,
  type BudgetCheckDeps,
  type BudgetFlagState,
  type BudgetWatchSession,
  type BudgetWatchTeam,
  type TeamBudgetPolicy,
} from './budget-watch.js';
import type { BudgetExceededPayload } from '../../events.js';
import type { SessionStatus } from './session.js';

/**
 * Unit tests for the cost-budget LOGIC (no timer, no Spawner, no DB, no bus).
 *
 * The truth table the watch must honour:
 *   role with no budget / no role at all      → never anything
 *   cost `null` (no counters anywhere)        → never a crossing, at any budget
 *   cost < budget                             → silence
 *   cost >= budget, first time                → event + notify (+ pause if asked)
 *   cost >= budget, every tick after          → SILENCE (one-shot)
 *   budget raised above the cost              → re-armed, next crossing fires
 *   team gone / budget cleared                → flag dropped (re-armed)
 *
 * `pause` is asserted through session doubles: what is pinned is that the WHOLE
 * team is suspended, lead included, and that nothing is killed.
 */

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function session(id: string, status: SessionStatus): BudgetWatchSession {
  return { id, status };
}

interface Fixture {
  deps: BudgetCheckDeps;
  /** Payloads passed to `emit`, in order. */
  events: BudgetExceededPayload[];
  /** Payloads passed to `notify`, in order. */
  notified: BudgetExceededPayload[];
  /** Session ids handed to `pauseSession`, in order. */
  paused: string[];
  flagged: BudgetFlagState;
  /** Mutable so a test can move the cost / the policy between ticks. */
  set(next: { cost?: number | null; policy?: TeamBudgetPolicy | null }): void;
  /** Drop the team from the live list, as a destroyed orchestrator would. */
  destroy(): void;
}

function makeFixture(opts: {
  sessions?: BudgetWatchSession[];
  policy: TeamBudgetPolicy | null;
  cost: number | null;
  roleId?: string | null;
  /** Make `pauseSession` throw for these ids (a terminated/PTY-less session). */
  unpausable?: string[];
  onEmit?: () => void;
}): Fixture {
  const events: BudgetExceededPayload[] = [];
  const notified: BudgetExceededPayload[] = [];
  const paused: string[] = [];
  const flagged: BudgetFlagState = new Map();
  let policy = opts.policy;
  let cost = opts.cost;
  let live = true;

  const team: BudgetWatchTeam = {
    id: 'orch-1',
    name: 'CALM-A',
    roleId: opts.roleId !== undefined ? opts.roleId : policy ? 'role-1' : null,
    listSessions: () => opts.sessions ?? [],
    pauseSession: (id: string) => {
      if (opts.unpausable?.includes(id)) throw new Error(`cannot pause ${id}`);
      paused.push(id);
      return undefined;
    },
  };

  return {
    events,
    notified,
    paused,
    flagged,
    set: (next) => {
      if (next.cost !== undefined) cost = next.cost;
      if (next.policy !== undefined) policy = next.policy;
    },
    destroy: () => {
      live = false;
    },
    deps: {
      orchestrators: () => (live ? [team] : []),
      policyForRole: (roleId) => (roleId ? policy : null),
      costForTeam: () => cost,
      flagged,
      emit: (_team, payload) => {
        events.push(payload);
        opts.onEmit?.();
      },
      notify: (_team, payload) => {
        notified.push(payload);
      },
      now: () => NOW,
    },
  };
}

const NOTIFY_50: TeamBudgetPolicy = { costBudgetUsd: 50, budgetAction: 'notify' };
const PAUSE_50: TeamBudgetPolicy = { costBudgetUsd: 50, budgetAction: 'pause' };
const NO_BUDGET: TeamBudgetPolicy = { costBudgetUsd: null, budgetAction: 'notify' };

// ---------------------------------------------------------------------------
// The comparison rule itself — shared with GET /metrics/costs
// ---------------------------------------------------------------------------

describe('isBudgetExceeded', () => {
  it('treats the budget as a ceiling that is REACHED, not only passed', () => {
    expect(isBudgetExceeded(49.999999, 50)).toBe(false);
    expect(isBudgetExceeded(50, 50)).toBe(true);
    expect(isBudgetExceeded(50.000001, 50)).toBe(true);
  });

  it('never crosses on a null / non-finite cost — no measurement is not a small one', () => {
    expect(isBudgetExceeded(null, 0.01)).toBe(false);
    expect(isBudgetExceeded(Number.NaN, 0.01)).toBe(false);
    expect(isBudgetExceeded(Number.POSITIVE_INFINITY, 50)).toBe(false);
  });
});

describe('resolveTeamBudget', () => {
  it('answers null for a team with no role / no budget — not "exceeded: false"', () => {
    expect(resolveTeamBudget(null, 999)).toBeNull();
    expect(resolveTeamBudget(NO_BUDGET, 999)).toBeNull();
  });

  it('carries the ceiling, the action and a measured verdict', () => {
    expect(resolveTeamBudget(PAUSE_50, 12)).toEqual({ usd: 50, action: 'pause', exceeded: false });
    expect(resolveTeamBudget(PAUSE_50, 50)).toEqual({ usd: 50, action: 'pause', exceeded: true });
    // No counters at all: a budget, but no verdict against it yet.
    expect(resolveTeamBudget(NOTIFY_50, null)).toEqual({
      usd: 50,
      action: 'notify',
      exceeded: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('checkBudgetsOnce', () => {
  it('stays silent while the team is under its budget', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 49.5 });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.notified).toEqual([]);
    expect(f.flagged.size).toBe(0);
  });

  it('emits the event AND the notification on the crossing', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 62.5 });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    expect(f.events).toEqual([
      { teamName: 'CALM-A', costUsd: 62.5, budgetUsd: 50, action: 'notify' },
    ]);
    expect(f.notified).toEqual(f.events);
    // `notify` never touches a session.
    expect(f.paused).toEqual([]);
    expect(f.flagged.get('orch-1')).toEqual({ flaggedAt: NOW, budgetUsd: 50 });
  });

  it('fires at the exact boundary (cost === budget)', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 50 });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    expect(f.events).toHaveLength(1);
  });

  it('is ONE-SHOT: every later tick over the same budget is silent', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 62.5 });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    // The bill keeps climbing — that is the same crossing, not a new one.
    f.set({ cost: 900 });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.events).toHaveLength(1);
    expect(f.notified).toHaveLength(1);
  });

  it('re-arms when the budget is raised above the cost, and fires again after', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 62.5 });
    expect(checkBudgetsOnce(f.deps)).toBe(1);

    // Operator raises the ceiling past the current spend.
    f.set({ policy: { costBudgetUsd: 100, budgetAction: 'notify' } });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.flagged.size).toBe(0); // re-armed

    // …and the team spends its way through the new ceiling.
    f.set({ cost: 140 });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    expect(f.events).toHaveLength(2);
    expect(f.events[1]).toEqual({
      teamName: 'CALM-A',
      costUsd: 140,
      budgetUsd: 100,
      action: 'notify',
    });
  });

  it('pauses the WHOLE team — lead included — when the action is pause', () => {
    const f = makeFixture({
      policy: PAUSE_50,
      cost: 51,
      sessions: [
        session('lead-1', 'running'),
        session('w-run', 'running'),
        session('w-wait', 'waiting'),
        session('w-boot', 'starting'), // pause() refuses mid-boot
        session('w-dead', 'killed'), // terminal — nothing to suspend
        session('w-paused', 'paused'), // already suspended
      ],
    });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    expect(f.paused).toEqual(['lead-1', 'w-run', 'w-wait']);
    // The alert still goes out — pause is additive to the notification.
    expect(f.events[0]?.action).toBe('pause');
    expect(f.notified).toHaveLength(1);
  });

  it('pauses only once: a paused team is not re-suspended every tick', () => {
    const f = makeFixture({
      policy: PAUSE_50,
      cost: 51,
      sessions: [session('lead-1', 'running')],
    });
    checkBudgetsOnce(f.deps);
    checkBudgetsOnce(f.deps);
    expect(f.paused).toEqual(['lead-1']);
  });

  it('keeps suspending the rest of the team when one session refuses to pause', () => {
    const f = makeFixture({
      policy: PAUSE_50,
      cost: 51,
      sessions: [session('lead-1', 'running'), session('w-bad', 'running'), session('w-ok', 'running')],
      unpausable: ['w-bad'],
    });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    expect(f.paused).toEqual(['lead-1', 'w-ok']);
  });

  it('still pauses when the event emission throws', () => {
    const f = makeFixture({
      policy: PAUSE_50,
      cost: 51,
      sessions: [session('lead-1', 'running')],
      onEmit: () => {
        throw new Error('bus exploded');
      },
    });
    expect(checkBudgetsOnce(f.deps)).toBe(1);
    expect(f.paused).toEqual(['lead-1']);
    expect(f.notified).toHaveLength(1);
  });

  it('ignores a team whose role carries no budget', () => {
    const f = makeFixture({ policy: NO_BUDGET, cost: 10_000 });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.flagged.size).toBe(0);
  });

  it('ignores a team with no role at all', () => {
    const f = makeFixture({ policy: null, cost: 10_000, roleId: null });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.events).toEqual([]);
  });

  it('never crosses when the team has no cost measurement (costUsd null)', () => {
    // A team whose rows predate the counters, or whose models are all
    // unpriceable: `null` is not `$0`, and it is certainly not "over budget".
    const f = makeFixture({
      policy: PAUSE_50,
      cost: null,
      sessions: [session('lead-1', 'running')],
    });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.paused).toEqual([]);
    expect(f.flagged.size).toBe(0);
  });

  it('drops the flag of a team that disappears, so a recreated one is announced', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 62.5 });
    checkBudgetsOnce(f.deps);
    expect(f.flagged.size).toBe(1);
    f.destroy();
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.flagged.size).toBe(0);
  });

  it('drops the flag when the budget is cleared on the role', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 62.5 });
    checkBudgetsOnce(f.deps);
    f.set({ policy: NO_BUDGET });
    expect(checkBudgetsOnce(f.deps)).toBe(0);
    expect(f.flagged.size).toBe(0);
  });

  it('flags each team independently in a mixed fleet', () => {
    const flagged: BudgetFlagState = new Map();
    const events: string[] = [];
    const teams: BudgetWatchTeam[] = [
      { id: 'a', name: 'A', roleId: 'r-budget', listSessions: () => [], pauseSession: () => undefined },
      { id: 'b', name: 'B', roleId: 'r-budget', listSessions: () => [], pauseSession: () => undefined },
      { id: 'c', name: 'C', roleId: null, listSessions: () => [], pauseSession: () => undefined },
    ];
    const costs: Record<string, number | null> = { a: 80, b: 3, c: 10_000 };
    const deps: BudgetCheckDeps = {
      orchestrators: () => teams,
      policyForRole: (roleId) => (roleId === 'r-budget' ? NOTIFY_50 : null),
      costForTeam: (id) => costs[id] ?? null,
      flagged,
      emit: (team) => {
        events.push(team.id);
      },
      now: () => NOW,
    };
    expect(checkBudgetsOnce(deps)).toBe(1);
    expect(events).toEqual(['a']);

    // B catches up later; A stays silent.
    costs.b = 51;
    expect(checkBudgetsOnce(deps)).toBe(1);
    expect(events).toEqual(['a', 'b']);
  });

  it('works with no notify dep wired at all (no Discord configured)', () => {
    const f = makeFixture({ policy: NOTIFY_50, cost: 51 });
    const deps: BudgetCheckDeps = { ...f.deps, notify: undefined };
    expect(checkBudgetsOnce(deps)).toBe(1);
    expect(f.events).toHaveLength(1);
    expect(f.notified).toEqual([]);
  });
});
