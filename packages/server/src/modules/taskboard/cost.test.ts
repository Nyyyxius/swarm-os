import { describe, it, expect } from 'vitest';
import { makeSessionCostLookup, type CostSession, type CostTeam } from './cost.js';

/** A session stub shaped like the slice the resolver reads off a real one. */
function session(id: string, name: string, costUsd: number | null | undefined): CostSession {
  return {
    id,
    name,
    toView: () => (costUsd === undefined ? {} : { tokenUsage: { costUsd } }),
  };
}

function team(sessions: CostSession[]): CostTeam {
  return {
    getSession: (id) => sessions.find((s) => s.id === id),
    listSessions: () => sessions,
  };
}

function registry(teams: Record<string, CostTeam>) {
  return { get: (id: string) => teams[id] };
}

const ORCH = 'orch-a';

describe('makeSessionCostLookup', () => {
  it('resolves an assignee that is a session id', () => {
    const lookup = makeSessionCostLookup(registry({ [ORCH]: team([session('s1', 'alice', 4.25)]) }));
    expect(lookup(ORCH, 's1')).toEqual({ sessionId: 's1', costUsd: 4.25 });
  });

  it('falls back to a UNIQUE agent name', () => {
    const lookup = makeSessionCostLookup(
      registry({ [ORCH]: team([session('s1', 'alice', 1), session('s2', 'bob', 2)]) }),
    );
    // The name resolves to the SESSION ID — that is what gets booked.
    expect(lookup(ORCH, 'bob')).toEqual({ sessionId: 's2', costUsd: 2 });
  });

  it('refuses an ambiguous name (a worker restarted under the same name)', () => {
    const lookup = makeSessionCostLookup(
      registry({ [ORCH]: team([session('s1', 'bob', 1), session('s2', 'bob', 2)]) }),
    );
    expect(lookup(ORCH, 'bob')).toBeNull();
  });

  it('prefers an id match over a name match', () => {
    // A session literally named after another session's id: the id wins.
    const lookup = makeSessionCostLookup(
      registry({ [ORCH]: team([session('s1', 'alice', 1), session('s2', 's1', 2)]) }),
    );
    expect(lookup(ORCH, 's1')).toEqual({ sessionId: 's1', costUsd: 1 });
  });

  it('answers null for an unknown team or an unknown assignee', () => {
    const lookup = makeSessionCostLookup(registry({ [ORCH]: team([session('s1', 'alice', 1)]) }));
    expect(lookup('orch-gone', 's1')).toBeNull();
    expect(lookup(ORCH, 'ghost')).toBeNull();
  });

  it('answers costUsd: null for a session that was never priced', () => {
    // `toView()` omits tokenUsage entirely until something is measured.
    const lookup = makeSessionCostLookup(registry({ [ORCH]: team([session('s1', 'alice', undefined)]) }));
    expect(lookup(ORCH, 's1')).toEqual({ sessionId: 's1', costUsd: null });
  });

  it('passes through an explicit null cost (a model with no known price)', () => {
    const lookup = makeSessionCostLookup(registry({ [ORCH]: team([session('s1', 'alice', null)]) }));
    expect(lookup(ORCH, 's1')).toEqual({ sessionId: 's1', costUsd: null });
  });

  it('still prices a terminated session (a bill stays true after the agent exits)', () => {
    const lookup = makeSessionCostLookup(registry({ [ORCH]: team([session('s1', 'alice', 7)]) }));
    expect(lookup(ORCH, 's1')?.costUsd).toBe(7);
  });
});
