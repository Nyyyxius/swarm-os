// Unit tests for the pure half of Lot 14 (docs/monitoring-agents.md).
//
// Two things carry all the risk here and both are about ABSENCE:
//
//   1. A budget that was typed but not stored. `parseCostBudget` must never
//      turn a bad input into "no budget" — the operator would walk away
//      believing a ceiling exists.
//   2. A team with no budget must be indistinguishable from a team that had
//      none before Lot 14 shipped: no badge, no tooltip, no verdict.

import { describe, it, expect } from 'vitest';
import {
  budgetActionLabel, budgetFieldValue, budgetSummary, budgetTitle,
  formatBudgetLine, formatBudgetPair, isOverBudget, overBudgetTeamIds,
  parseCostBudget, toBudgetAction, OVER_BUDGET_BADGE,
} from './budget';
import type { TeamCostRow } from '../api/client';

function team(over: Partial<TeamCostRow> = {}): TeamCostRow {
  return {
    orchId: 'o1',
    name: 'ATLAS',
    live: 3,
    total: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0, costUsd: 52.1 },
    removed: { count: 0, costUsd: null },
    burnPerHour: 1.84,
    ...over,
  };
}

describe('parseCostBudget', () => {
  it('reads an empty field as "no budget", not as an error', () => {
    expect(parseCostBudget('')).toEqual({ ok: true, value: null });
    expect(parseCostBudget('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts a plain amount, decimals included', () => {
    expect(parseCostBudget('50')).toEqual({ ok: true, value: 50 });
    expect(parseCostBudget('12.5')).toEqual({ ok: true, value: 12.5 });
  });

  it('accepts what a person actually pastes off a bill', () => {
    expect(parseCostBudget('$50')).toEqual({ ok: true, value: 50 });
    expect(parseCostBudget('1,250.75')).toEqual({ ok: true, value: 1250.75 });
  });

  it('REJECTS a typo rather than silently storing no budget', () => {
    for (const bad of ['5O', 'abc', '-3', 'NaN', 'Infinity']) {
      const r = parseCostBudget(bad);
      expect(r.ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it('rejects zero — it is not the way to say "no budget"', () => {
    // A zero budget fires on the first token; whatever the operator meant, it
    // was not that. The empty field is how a budget is removed.
    const r = parseCostBudget('0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/> 0/);
  });
});

describe('budgetFieldValue', () => {
  it('round-trips a stored budget into an editable string', () => {
    expect(budgetFieldValue(50)).toBe('50');
    expect(budgetFieldValue(12.5)).toBe('12.5');
  });

  it('renders every flavour of "none" as an empty field', () => {
    expect(budgetFieldValue(null)).toBe('');
    expect(budgetFieldValue(undefined)).toBe('');
    expect(budgetFieldValue(0)).toBe('');
  });
});

describe('toBudgetAction', () => {
  it('defaults to notify for anything that is not an explicit pause', () => {
    expect(toBudgetAction(undefined)).toBe('notify');
    expect(toBudgetAction(null)).toBe('notify');
    expect(toBudgetAction('nonsense')).toBe('notify');
    expect(toBudgetAction('notify')).toBe('notify');
  });

  it('keeps pause when the server said pause', () => {
    expect(toBudgetAction('pause')).toBe('pause');
  });
});

describe('budgetSummary (RolesPage read-only line)', () => {
  it('says plainly when a role has no ceiling', () => {
    expect(budgetSummary(null, undefined)).toMatch(/aucun budget/);
    expect(budgetSummary(undefined, 'pause')).toMatch(/aucun budget/);
  });

  it('names the amount and what crossing it does', () => {
    expect(budgetSummary(50, 'notify')).toBe('$50.00 · notification seule au dépassement');
    expect(budgetSummary(50, 'pause')).toBe('$50.00 · pause de toute la team au dépassement');
  });

  it('reads an absent action as notify, never as pause', () => {
    expect(budgetSummary(50, undefined)).toMatch(/notification seule/);
  });
});

describe('the figure line', () => {
  it('pairs spend with ceiling', () => {
    expect(formatBudgetPair(52.1, 50)).toBe('$52.10 / $50.00');
  });

  it('em-dashes only the half it does not know', () => {
    expect(formatBudgetPair(undefined, 50)).toBe('— / $50.00');
    expect(formatBudgetPair(52.1, undefined)).toBe('$52.10 / —');
  });

  it('closes with what the server did', () => {
    expect(formatBudgetLine(52.1, 50, 'pause')).toBe('$52.10 / $50.00 · TEAM PAUSED');
    expect(formatBudgetLine(52.1, 50, 'notify')).toBe('$52.10 / $50.00 · NOTIFY');
    expect(budgetActionLabel(undefined)).toBe('NOTIFY');
  });
});

describe('the team verdict', () => {
  it('is the server flag, and nothing else', () => {
    expect(isOverBudget(team({ budget: { usd: 50, action: 'pause', exceeded: true } }))).toBe(true);
    expect(isOverBudget(team({ budget: { usd: 50, action: 'pause', exceeded: false } }))).toBe(false);
  });

  it('never invents one from the amounts on screen', () => {
    // $52.10 spent against a $50 budget the server has NOT flagged: the
    // janitor compares against the DB aggregate, and a client-side `>` here
    // would let the badge and the actual pause disagree at the boundary.
    expect(isOverBudget(team({
      total: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0, costUsd: 52.1 },
      budget: { usd: 50, action: 'pause', exceeded: false },
    }))).toBe(false);
  });

  it('is silent for a team with no budget at all', () => {
    expect(isOverBudget(team())).toBe(false);
    expect(isOverBudget(team({ budget: null }))).toBe(false);
    expect(budgetTitle(team())).toBeUndefined();
    expect(budgetTitle(team({ budget: null }))).toBeUndefined();
  });

  it('carries the pair and the consequence in the TOTAL cell title', () => {
    expect(budgetTitle(team({ budget: { usd: 50, action: 'pause', exceeded: true } })))
      .toBe('$52.10 / $50.00 — budget exceeded · TEAM PAUSED');
    expect(budgetTitle(team({ budget: { usd: 50, action: 'notify', exceeded: true } })))
      .toBe('$52.10 / $50.00 — budget exceeded · NOTIFY');
  });
});

describe('overBudgetTeamIds', () => {
  it('collects only the flagged teams', () => {
    const ids = overBudgetTeamIds([
      team({ orchId: 'over', budget: { usd: 50, action: 'pause', exceeded: true } }),
      team({ orchId: 'under', budget: { usd: 500, action: 'notify', exceeded: false } }),
      team({ orchId: 'none' }),
    ]);
    expect([...ids]).toEqual(['over']);
  });

  it('is empty — not a throw — with no snapshot at all', () => {
    expect(overBudgetTeamIds(null).size).toBe(0);
    expect(overBudgetTeamIds(undefined).size).toBe(0);
    expect(overBudgetTeamIds([]).size).toBe(0);
  });
});

describe('the badge label', () => {
  it('is defined once', () => {
    expect(OVER_BUDGET_BADGE).toBe('OVER BUDGET');
  });
});
