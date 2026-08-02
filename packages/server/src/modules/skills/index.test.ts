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

async function installSkillWith(
  name: string,
  opts: { capabilities?: string[]; plugins?: string[]; withAssets?: boolean } = {},
): Promise<void> {
  const src = path.join(dir, `src-${name}`);
  fs.mkdirSync(src, { recursive: true });
  const req: string[] = [];
  if (opts.plugins?.length) req.push(`plugins: [${opts.plugins.join(', ')}]`);
  if (opts.capabilities?.length) req.push(`capabilities: [${opts.capabilities.join(', ')}]`);
  const lines = ['---', `name: ${name}`, 'version: 0.1.0', `description: ${name}.`];
  if (req.length) lines.push(`requires: { ${req.join(', ')} }`);
  if (opts.withAssets) lines.push('assets: { dir: assets }');
  lines.push('---', `Body for ${name}.`, '');
  fs.writeFileSync(path.join(src, 'SKILL.md'), lines.join('\n'), 'utf8');
  if (opts.withAssets) {
    fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(src, 'assets', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  }
  await subsystem.import({ kind: 'dir', dir: src });
}

describe('SkillsSubsystem trust/review gate (Lot 3)', () => {
  it('activates a plain (non-risky) skill without any review', async () => {
    await installSkill('plain');
    const r = subsystem.activate({ name: 'plain', scope: 'orch', orchestratorId: 'orch1' });
    expect(r.found).toBe(true);
    expect(r.blocked).toBeUndefined();
    expect(r.persisted).toBe(true);
    expect(subsystem.getView('plain')?.reviewRequired).toBe(false);
  });

  it('BLOCKS activation of a skill that ships assets until reviewed', async () => {
    await installSkillWith('withassets', { withAssets: true });
    expect(subsystem.getView('withassets')?.reviewRequired).toBe(true);

    const blocked = subsystem.activate({ name: 'withassets', scope: 'orch', orchestratorId: 'orch1' });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('review_required');
    expect(blocked.persisted).toBe(false);
    // Not persisted → nothing resolves for the team.
    expect(subsystem.resolveForSession(null, 'orch1', 'sess1')).toEqual([]);
  });

  it('activates with reviewed:true (operator consent) and records the review', async () => {
    await installSkillWith('consent', { withAssets: true });
    const ok = subsystem.activate({
      name: 'consent',
      scope: 'orch',
      orchestratorId: 'orch1',
      reviewed: true,
    });
    expect(ok.blocked).toBeUndefined();
    expect(ok.persisted).toBe(true);
    expect(subsystem.getView('consent')?.reviewed).toBe(true);
    expect(subsystem.getView('consent')?.reviewRequired).toBe(false);
    // A later plain activate (no reviewed flag) is no longer gated.
    expect(subsystem.activate({ name: 'consent', scope: 'orch', orchestratorId: 'orch1' }).blocked).toBeUndefined();
  });

  it('gates on requires.capabilities even with no assets', async () => {
    await installSkillWith('needscap', { capabilities: ['fs'] });
    expect(subsystem.getView('needscap')?.reviewRequired).toBe(true);
    expect(subsystem.activate({ name: 'needscap', scope: 'orch', orchestratorId: 'orch1' }).blocked).toBe(true);
  });

  it('setReviewed records the review out-of-band (dedicated endpoint path)', async () => {
    await installSkillWith('reviewed-flag', { withAssets: true });
    expect(subsystem.setReviewed('reviewed-flag', true)?.reviewed).toBe(true);
    expect(subsystem.getView('reviewed-flag')?.reviewRequired).toBe(false);
    expect(subsystem.setReviewed('ghost', true)).toBeNull();
  });

  it('resolves requires.plugins to installed+enabled status + warnings', async () => {
    subsystem.setPluginLookup((n) =>
      n === 'on'
        ? { installed: true, enabled: true }
        : n === 'off'
          ? { installed: true, enabled: false }
          : { installed: false, enabled: false },
    );
    await installSkillWith('needsplugins', { plugins: ['on', 'off', 'missing'] });
    const view = subsystem.getView('needsplugins');
    const byName = Object.fromEntries((view?.pluginStatus ?? []).map((p) => [p.name, p]));
    expect(byName['on']).toEqual({ name: 'on', installed: true, enabled: true });
    expect(byName['off']).toEqual({ name: 'off', installed: true, enabled: false });
    expect(byName['missing']).toEqual({ name: 'missing', installed: false, enabled: false });
    expect(view?.warnings.some((w) => w.includes("'missing'") && w.includes('not installed'))).toBe(true);
    expect(view?.warnings.some((w) => w.includes("'off'") && w.includes('disabled'))).toBe(true);
  });

  it('reviewInfo exposes the assets file list for the dialog', async () => {
    await installSkillWith('inspectme', { withAssets: true });
    const info = subsystem.reviewInfo('inspectme');
    expect(info?.reviewRequired).toBe(true);
    expect(info?.assets.map((a) => a.path)).toContain('run.sh');
    expect(info?.assets.find((a) => a.path === 'run.sh')?.executable).toBe(true);
    const asset = subsystem.assetContent('inspectme', 'run.sh');
    expect(asset?.content).toContain('echo hi');
    // Traversal is refused.
    expect(subsystem.assetContent('inspectme', '../../SKILL.md')).toBeNull();
  });

  it('does NOT stage a risky un-reviewed skill\'s assets even via a role (fail-safe)', async () => {
    await installSkillWith('rolerisky', { withAssets: true });
    const role = roleStore.create({ label: 'R', skills: [{ name: 'rolerisky', mode: 'inject' }] });
    const stagedDir = path.join(dir, 'ws', '.swarm-skills', 'rolerisky');

    // Body injects (fragment present) but assets are withheld until review.
    const frags = subsystem.resolveForSession(role.id, 'orch1', 'sess1');
    expect(frags.map((f) => f.name)).toContain('rolerisky');
    expect(fs.existsSync(stagedDir)).toBe(false);

    // After review, the next resolution stages them.
    subsystem.setReviewed('rolerisky', true);
    subsystem.resolveForSession(role.id, 'orch1', 'sess1');
    expect(fs.existsSync(stagedDir)).toBe(true);
  });
});
