import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { RoleStore } from '../roles/index.js';
import { SkillStore } from './store.js';
import { SkillInstaller } from './installer.js';
import { SkillsSubsystem } from './index.js';
import type { Config } from '../../config.js';

let dir: string;
let db: SwarmDb;
let store: SkillStore;
let roleStore: RoleStore;
let subsystem: SkillsSubsystem;

function fakeConfig(): Config {
  return {
    dataDir: dir,
    workspaceRoot: path.join(dir, 'ws'),
    hostWorkspaceRoot: null,
    agentTransport: 'local',
  } as unknown as Config;
}

async function installSkill(name: string, body = 'Do the thing.'): Promise<void> {
  const src = path.join(dir, `src-${name}`);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'SKILL.md'),
    `---\nname: ${name}\nversion: 0.1.0\ndescription: ${name}.\n---\n${body}\n`,
    'utf8',
  );
  await subsystem.import({ kind: 'dir', dir: src });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sub-'));
  db = new SwarmDb(dir);
  store = new SkillStore(db);
  roleStore = new RoleStore(db);
  const installer = new SkillInstaller({ skillsDir: path.join(dir, 'skills'), store });
  subsystem = new SkillsSubsystem({ store, installer, roleStore, config: fakeConfig() });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SkillsSubsystem scopes', () => {
  it('activates + resolves an orch-scoped skill (persists, hot no-op without a live orch)', async () => {
    await installSkill('sk');
    const r = subsystem.activate({ name: 'sk', scope: 'orch', orchestratorId: 'orch1' });
    expect(r.found).toBe(true);
    expect(r.persisted).toBe(true);
    expect(r.injected).toBe(0); // no orchestrator lookup wired → hot reaches nobody

    const frags = subsystem.resolveForSession(null, 'orch1', 'sess1');
    expect(frags.map((f) => f.name)).toEqual(['sk']);
    // A different team does NOT see it.
    expect(subsystem.resolveForSession(null, 'orch2', 'sessX')).toEqual([]);
  });

  it('a session-scope disable SUPPRESSES a broader orch activation (precedence)', async () => {
    await installSkill('sk');
    subsystem.activate({ name: 'sk', scope: 'orch', orchestratorId: 'orch1' });
    expect(subsystem.resolveForSession(null, 'orch1', 'sess1').map((f) => f.name)).toEqual(['sk']);

    subsystem.deactivate({ name: 'sk', scope: 'session', orchestratorId: 'orch1', sessionId: 'sess1' });
    // sess1 no longer sees it …
    expect(subsystem.resolveForSession(null, 'orch1', 'sess1')).toEqual([]);
    // … but another session of the same team still does.
    expect(subsystem.resolveForSession(null, 'orch1', 'sess2').map((f) => f.name)).toEqual(['sk']);
  });

  it('merges role + orch + session scopes and dedups', async () => {
    await installSkill('role-sk');
    await installSkill('orch-sk');
    await installSkill('sess-sk');
    const role = roleStore.create({ label: 'R', skills: [{ name: 'role-sk', mode: 'inject' }] });
    subsystem.activate({ name: 'orch-sk', scope: 'orch', orchestratorId: 'orch1' });
    subsystem.activate({ name: 'sess-sk', scope: 'session', orchestratorId: 'orch1', sessionId: 'sess1' });

    const names = subsystem.activeNamesForSession(role.id, 'orch1', 'sess1').sort();
    expect(names).toEqual(['orch-sk', 'role-sk', 'sess-sk']);
  });

  it('deactivate at orch scope removes it for the team', async () => {
    await installSkill('sk');
    subsystem.activate({ name: 'sk', scope: 'orch', orchestratorId: 'orch1' });
    subsystem.deactivate({ name: 'sk', scope: 'orch', orchestratorId: 'orch1' });
    expect(subsystem.resolveForSession(null, 'orch1', 'sess1')).toEqual([]);
  });

  it('remove() purges the skill AND its activations', async () => {
    await installSkill('sk');
    subsystem.activate({ name: 'sk', scope: 'orch', orchestratorId: 'orch1' });
    subsystem.remove('sk');
    expect(store.get('sk')).toBeNull();
    expect(store.listActivations('orch', 'orch1')).toEqual([]);
  });

  it('returns not-found for activating an unknown skill', () => {
    const r = subsystem.activate({ name: 'ghost', scope: 'orch', orchestratorId: 'orch1' });
    expect(r.found).toBe(false);
    expect(r.persisted).toBe(false);
  });

  it('activeForSession tags each skill with its most specific scope', async () => {
    await installSkill('role-sk');
    await installSkill('orch-sk');
    const role = roleStore.create({ label: 'R', skills: [{ name: 'role-sk', mode: 'inject' }] });
    subsystem.activate({ name: 'orch-sk', scope: 'orch', orchestratorId: 'orch1' });
    // role-sk ALSO activated at orch scope → orch wins (more specific).
    subsystem.activate({ name: 'role-sk', scope: 'orch', orchestratorId: 'orch1' });

    const info = subsystem.activeForSession(role.id, 'orch1', 'sess1');
    const byName = Object.fromEntries(info.map((i) => [i.name, i.scope]));
    expect(byName['orch-sk']).toBe('orch');
    expect(byName['role-sk']).toBe('orch');
  });

  it('activationsForSkill lists orch/session provenance', async () => {
    await installSkill('sk');
    subsystem.activate({ name: 'sk', scope: 'orch', orchestratorId: 'orch1' });
    subsystem.activate({ name: 'sk', scope: 'session', orchestratorId: 'orch1', sessionId: 'sess1' });
    const acts = subsystem.activationsForSkill('sk');
    expect(acts).toHaveLength(2);
    expect(acts.some((a) => a.scope === 'orch' && a.scopeId === 'orch1' && a.enabled)).toBe(true);
    expect(acts.some((a) => a.scope === 'session' && a.scopeId === 'sess1' && a.enabled)).toBe(true);
  });
});
