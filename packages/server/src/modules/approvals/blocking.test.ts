/**
 * `listBlockingApprovalTeams` (docs/builtin-features.md D9) — the enumeration
 * behind the approvals disable/uninstall 409 guard. A live team is "blocking"
 * iff it has a non-terminal session whose `(provider, permissionMode)` arms the
 * approval guard under the team's role settings (the SAME predicate the hook path
 * uses to create an approval). Driven with light fakes for the spawner + roles.
 */

import { describe, it, expect } from 'vitest';
import { listBlockingApprovalTeams } from './blocking.js';
import type { Spawner } from '../spawner/index.js';
import type { RoleStore, Role, RoleApprovalSettings } from '../roles/index.js';

interface FakeSession {
  provider: string;
  permissionMode: string;
  status: string;
}
interface FakeTeam {
  id: string;
  name: string;
  roleId: string | null;
  sessions: FakeSession[];
}

function build(
  teams: FakeTeam[],
  roleApprovals: Record<string, RoleApprovalSettings | null> = {},
): { spawner: Spawner; roleStore: RoleStore } {
  const spawner = {
    listActive: () =>
      teams.map((t) => ({
        id: t.id,
        name: t.name,
        roleId: t.roleId,
        toView: () => ({ sessions: t.sessions }),
      })),
  } as unknown as Spawner;
  const roleStore = {
    get: (id: string): Role | null =>
      id in roleApprovals ? ({ id, approval: roleApprovals[id] } as unknown as Role) : null,
  } as unknown as RoleStore;
  return { spawner, roleStore };
}

const S = (over: Partial<FakeSession> = {}): FakeSession => ({
  provider: 'claude',
  permissionMode: 'default',
  status: 'running',
  ...over,
});

describe('listBlockingApprovalTeams', () => {
  it('flags a team with a prompting claude session (default arming)', () => {
    const { spawner, roleStore } = build([
      { id: 'o1', name: 'alpha', roleId: null, sessions: [S()] },
    ]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual(['alpha']);
  });

  it('does NOT flag a bypass-only team (never prompts, never blocks)', () => {
    const { spawner, roleStore } = build([
      { id: 'o1', name: 'alpha', roleId: null, sessions: [S({ permissionMode: 'bypassPermissions' })] },
    ]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual([]);
  });

  it('does NOT flag a non-claude provider (bypass-only providers today)', () => {
    const { spawner, roleStore } = build([
      { id: 'o1', name: 'alpha', roleId: null, sessions: [S({ provider: 'gemini' })] },
    ]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual([]);
  });

  it('ignores TERMINAL sessions (an exited prompting session cannot block)', () => {
    const { spawner, roleStore } = build([
      { id: 'o1', name: 'alpha', roleId: null, sessions: [S({ status: 'exited' })] },
    ]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual([]);
  });

  it('a role with approval.enabled:false is NOT blocking even in a prompting mode', () => {
    const { spawner, roleStore } = build(
      [{ id: 'o1', name: 'alpha', roleId: 'r1', sessions: [S()] }],
      { r1: { enabled: false } },
    );
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual([]);
  });

  it('armingModes can make a normally-silent mode blocking (override arms bypass)', () => {
    const { spawner, roleStore } = build(
      [{ id: 'o1', name: 'alpha', roleId: 'r1', sessions: [S({ permissionMode: 'bypassPermissions' })] }],
      { r1: { armingModes: ['bypassPermissions'] } },
    );
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual(['alpha']);
  });

  it('a mixed team is flagged if ANY live session arms the guard', () => {
    const { spawner, roleStore } = build([
      {
        id: 'o1',
        name: 'alpha',
        roleId: null,
        sessions: [S({ permissionMode: 'bypassPermissions' }), S({ permissionMode: 'plan' })],
      },
    ]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual(['alpha']);
  });

  it('returns every blocking team, sorted and de-duplicated', () => {
    const { spawner, roleStore } = build([
      { id: 'o1', name: 'charlie', roleId: null, sessions: [S()] },
      { id: 'o2', name: 'alpha', roleId: null, sessions: [S({ permissionMode: 'bypassPermissions' })] },
      { id: 'o3', name: 'bravo', roleId: null, sessions: [S()] },
    ]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual(['bravo', 'charlie']);
  });

  it('falls back to the team id when the name is empty', () => {
    const { spawner, roleStore } = build([{ id: 'o1', name: '', roleId: null, sessions: [S()] }]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual(['o1']);
  });

  it('is empty when nothing is live', () => {
    const { spawner, roleStore } = build([]);
    expect(listBlockingApprovalTeams(spawner, roleStore)).toEqual([]);
  });
});
