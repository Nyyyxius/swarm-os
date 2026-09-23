import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config.js';
import type { Role, RoleStore } from '../roles/index.js';

/**
 * docs/auto-compact.md D6/D7 — `OrchestratorDeps.autoCompact.thresholdPctFor`,
 * as the Spawner builds it.
 *
 * One resolver, read LIVE at every idle boundary of every agent, so a role
 * edited while the fleet runs applies without a restart. What has to hold:
 * a role's own value wins, `null` inherits, `0` is an explicit "never", and
 * every way the lookup can fail — no role id, a role deleted since the team was
 * created, a store that throws — degrades to the instance default rather than
 * to silence or to a crash on the boundary path.
 *
 * Same PTY seam as the sibling spawner suites: the real `PtyAgentProcess` would
 * try to launch a CLI.
 */
vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/agent-process.js')>();
  return { ...actual, PtyAgentProcess: actual.FakeAgentProcess };
});

import { Spawner } from './index.js';
import type { Orchestrator } from '../orchestrator/index.js';

type SpawnerT = InstanceType<typeof Spawner>;

const INSTANCE_DEFAULT = 35;

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let spawner: SpawnerT | null = null;

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 0,
    projectName: 'test',
    defaultModel: 'm',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir,
    logsDir,
    mcpRuntimeDir,
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 5,
    idleThresholdMs: 20,
    autoCompactPct: INSTANCE_DEFAULT,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
    ...over,
  } as Config;
}

/** The slice of a `Role` the Spawner touches on the create path. */
function fakeRole(id: string, autoCompactPct: number | null): Role {
  return { id, autoCompactPct, connectors: [], skills: [] } as unknown as Role;
}

interface StoreRig {
  store: RoleStore;
  /** Make every later `get` throw — a store mid-migration, a plugin-supplied one. */
  breakIt(): void;
}

function fakeRoleStore(roles: Record<string, Role>): StoreRig {
  let broken = false;
  const store = {
    get: (id: string): Role | null => {
      if (broken) throw new Error('role store is down');
      return roles[id] ?? null;
    },
  } as unknown as RoleStore;
  return {
    store,
    breakIt: () => {
      broken = true;
    },
  };
}

/**
 * The threshold this team would use at its next idle boundary.
 *
 * Reaches for the Orchestrator's private resolver on purpose: that single call
 * is the whole chain under test — the Spawner's closure, the role lookup, the
 * `?? config` fallback AND the `try/catch` that keeps a throwing store from
 * taking the boundary down with it. Nothing in production calls it from
 * outside, which is why it is private.
 */
function thresholdOf(orch: Orchestrator): number {
  return (orch as unknown as { _autoCompactThresholdPct(): number })._autoCompactThresholdPct();
}

function createTeam(s: SpawnerT, name: string, roleId: string | null) {
  return s.create({
    name,
    role: 'co',
    ...(roleId ? { roleId } : {}),
    defaultModel: 'm',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    leadPreamble: null,
    workerPreamble: null,
    lead: { cwd: tmpRoot, prompt: 'do work', preamble: null },
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-acpct-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir, path.join(tmpRoot, 'claude-runtime')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  spawner = null;
});

afterEach(async () => {
  spawner?.shutdownAll('test-teardown');
  await new Promise((r) => setTimeout(r, 50));
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Spawner — autoCompact.thresholdPctFor (D6/D7)', () => {
  it('uses the role\'s own value when it has one', () => {
    const { store } = fakeRoleStore({ 'role-1': fakeRole('role-1', 20) });
    spawner = new Spawner(makeConfig(), { roleStore: store });
    const { orchestrator } = createTeam(spawner, 'ALPHA', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(20);
  });

  it('inherits the instance default on a role that set nothing', () => {
    const { store } = fakeRoleStore({ 'role-1': fakeRole('role-1', null) });
    spawner = new Spawner(makeConfig(), { roleStore: store });
    const { orchestrator } = createTeam(spawner, 'BETA', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(INSTANCE_DEFAULT);
  });

  it('honours an explicit 0 — a per-role kill switch, not an absent value', () => {
    // The one case `??` gets right and `||` would not: `0` means "never compact
    // this role", and it must survive a non-zero instance default.
    const { store } = fakeRoleStore({ 'role-1': fakeRole('role-1', 0) });
    spawner = new Spawner(makeConfig(), { roleStore: store });
    const { orchestrator } = createTeam(spawner, 'GAMMA', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(0);
  });

  it('falls back to the instance default for a team with no role at all', () => {
    const { store } = fakeRoleStore({});
    spawner = new Spawner(makeConfig(), { roleStore: store });
    const { orchestrator } = createTeam(spawner, 'DELTA', null);
    expect(orchestrator.roleId).toBeNull();
    expect(thresholdOf(orchestrator)).toBe(INSTANCE_DEFAULT);
  });

  it('falls back when the role has been DELETED since the team was created', () => {
    // A live 24/7 team outliving its role is ordinary, not exceptional.
    const roles: Record<string, Role> = { 'role-1': fakeRole('role-1', 20) };
    const store = {
      get: (id: string): Role | null => roles[id] ?? null,
    } as unknown as RoleStore;
    spawner = new Spawner(makeConfig(), { roleStore: store });
    const { orchestrator } = createTeam(spawner, 'EPSILON', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(20);
    delete roles['role-1'];
    expect(thresholdOf(orchestrator)).toBe(INSTANCE_DEFAULT);
  });

  it('re-reads the role at EVERY call — an edit applies with no restart', () => {
    // D6: nothing is cached, because the alternative is telling an operator to
    // restart the server to change a percentage.
    const role = fakeRole('role-1', 50);
    const { store } = fakeRoleStore({ 'role-1': role });
    spawner = new Spawner(makeConfig(), { roleStore: store });
    const { orchestrator } = createTeam(spawner, 'ZETA', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(50);
    (role as { autoCompactPct: number | null }).autoCompactPct = 15;
    expect(thresholdOf(orchestrator)).toBe(15);
  });

  it('survives a throwing store: the default, not a broken boundary', () => {
    // This resolver runs inside the idle-boundary timer. A store that throws
    // must cost the override and nothing else — certainly not the boundary, on
    // which the inbox signal and guarantee G also depend.
    const rig = fakeRoleStore({ 'role-1': fakeRole('role-1', 20) });
    spawner = new Spawner(makeConfig(), { roleStore: rig.store });
    const { orchestrator } = createTeam(spawner, 'ETA', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(20);
    rig.breakIt();
    expect(() => thresholdOf(orchestrator)).not.toThrow();
    expect(thresholdOf(orchestrator)).toBe(INSTANCE_DEFAULT);
  });

  it('falls back to the instance default when no role store is wired at all', () => {
    spawner = new Spawner(makeConfig());
    const { orchestrator } = createTeam(spawner, 'THETA', 'role-1');
    expect(thresholdOf(orchestrator)).toBe(INSTANCE_DEFAULT);
  });
});
