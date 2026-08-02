import { describe, it, expect } from 'vitest';
import {
  resolveFragments,
  activateHot,
  deactivateHot,
  fragmentOf,
  type HotActivationDeps,
} from './activation.js';
import type { SkillStore, SkillRow } from './store.js';
import type { RoleSkillRef } from '../roles/index.js';
import type { Orchestrator } from '../orchestrator/index.js';

function skillRow(over: Partial<SkillRow> = {}): SkillRow {
  const now = new Date().toISOString();
  return {
    name: 'hello-skill',
    version: '0.1.0',
    display_name: null,
    description: 'greeter',
    source_kind: 'dir',
    source_ref: null,
    source_commit: null,
    checksum: null,
    trust: 'local',
    requires_json: null,
    assets_present: 0,
    body_md: 'Say hello.',
    frontmatter_json: null,
    installed_at: now,
    updated_at: now,
    last_error: null,
    ...over,
  };
}

function fakeStore(rows: Record<string, SkillRow>): SkillStore {
  return { get: (name: string) => rows[name] ?? null } as unknown as SkillStore;
}

function fakeSession(id: string, status: string) {
  const signals: string[] = [];
  return { id, status, notifySignal: (t: string) => signals.push(t), signals };
}

function fakeOrch(sessions: ReturnType<typeof fakeSession>[]) {
  const pushed: Array<{ to: string; from: string; content: string }> = [];
  const orch = {
    roleId: 'role-1',
    listSessions: () => sessions,
    mailbox: {
      push: (to: string, msg: { from: string; content: string }) => {
        pushed.push({ to, from: msg.from, content: msg.content });
        return { dropped: false, queueSize: 1 };
      },
    },
  } as unknown as Orchestrator;
  return { orch, pushed };
}

const hotDeps: HotActivationDeps = {
  store: fakeStore({}),
  skillsDir: '/tmp/skills',
  assetsConfig: { workspaceRoot: '/tmp/ws', hostWorkspaceRoot: null, agentTransport: 'local' },
};

describe('resolveFragments', () => {
  it('maps active inject refs to fragments, skipping unknown + duplicates', () => {
    const store = fakeStore({
      a: skillRow({ name: 'a', body_md: 'A body' }),
      b: skillRow({ name: 'b', body_md: 'B body' }),
    });
    const refs: RoleSkillRef[] = [
      { name: 'a', mode: 'inject' },
      { name: 'a', mode: 'inject' },
      { name: 'ghost', mode: 'inject' },
      { name: 'b', mode: 'inject' },
    ];
    const frags = resolveFragments(store, refs);
    expect(frags.map((f) => f.name)).toEqual(['a', 'b']);
    expect(frags[0]!.body).toBe('A body');
  });
});

describe('fragmentOf', () => {
  it('carries name, version, description, body', () => {
    const f = fragmentOf(skillRow({ name: 'x', version: '2.0.0', description: 'd', body_md: 'B' }));
    expect(f).toEqual({ name: 'x', version: '2.0.0', description: 'd', body: 'B' });
  });
});

describe('activateHot / deactivateHot', () => {
  it('pushes a system message + signals every LIVE session, skipping dead ones', () => {
    const live = fakeSession('s1', 'running');
    const dead = fakeSession('s2', 'exited');
    const { orch, pushed } = fakeOrch([live, dead]);
    const r = activateHot(hotDeps, orch, skillRow({ name: 'hello-skill', body_md: 'Say hi' }));
    expect(r.injected).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.to).toBe('s1');
    expect(pushed[0]!.from).toBe('system');
    expect(pushed[0]!.content).toContain('skill activated');
    expect(pushed[0]!.content).toContain('Say hi');
    expect(live.signals).toHaveLength(1);
    expect(dead.signals).toHaveLength(0);
  });

  it('deactivateHot announces a retract notice', () => {
    const live = fakeSession('s1', 'waiting');
    const { orch, pushed } = fakeOrch([live]);
    const r = deactivateHot(hotDeps, orch, skillRow({ name: 'hello-skill' }));
    expect(r.injected).toBe(1);
    expect(pushed[0]!.content).toContain('skill deactivated');
  });
});
