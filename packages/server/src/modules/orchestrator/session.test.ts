import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from './session.js';
import { FakeAgentProcess } from './agent-process.js';

/**
 * Pre-seed `.claude.json` so claude-code's "Trust this folder?" widget
 * never fires on first spawn. See `Session._seedClaudeJsonTrust`.
 */

let tmpRoot: string;
let logsDir: string;
let mcpRuntimeDir: string;
let claudeRuntimeDir: string;
let cwd: string;
const openSessions: Session[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-session-'));
  logsDir = path.join(tmpRoot, 'logs');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  claudeRuntimeDir = path.join(tmpRoot, 'claude-runtime');
  cwd = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });
  fs.mkdirSync(claudeRuntimeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  openSessions.length = 0;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeSession(opts: { sessionCwd?: string } = {}): Session {
  const s = new Session({
    orchestratorId: 'orch-seed-test',
    name: 'seed-test',
    role: 'tester',
    type: 'worker',
    cwd: opts.sessionCwd ?? cwd,
    initialPrompt: null,
    preamble: null,
    model: 'test-model',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd }),
    // Seed only runs when all three are set (production path).
    hookToken: 'test-hook',
    mainHttpPort: 12345,
    claudeConfigRoot: claudeRuntimeDir,
  });
  openSessions.push(s);
  return s;
}

function readSeed(s: Session): Record<string, unknown> {
  const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
  return JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Record<string, unknown>;
}

function readSessionSettings(s: Session): Record<string, unknown> {
  const p = path.join(s.claudeConfigDir!, 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

describe('Session — settings.json bypass disclaimer', () => {
  it('writes skipDangerousModePermissionPrompt:true so the bypass widget never opens', () => {
    // Required to survive the claude 2.1.143 migration that moves
    // .claude.json#bypassPermissionsModeAccepted into userSettings and
    // then deletes the source field. The runtime widget check reads only
    // userSettings/localSettings/flagSettings/policySettings.
    const s = makeSession();
    const settings = readSessionSettings(s);
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  });
});

describe('Session — .claude.json trust seed', () => {
  it('writes a regular file (not a symlink) with the trust flags set for cwd', () => {
    const s = makeSession();
    const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
    expect(fs.lstatSync(seedPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(seedPath).isFile()).toBe(true);

    const json = readSeed(s);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects).toBeDefined();
    expect(projects[cwd]).toBeDefined();
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(projects[cwd].hasCompletedProjectOnboarding).toBe(true);
    expect(projects[cwd].hasClaudeMdExternalIncludesApproved).toBe(true);
    // Pre-accepts the bypass-permissions disclaimer at the top level so the
    // CLI doesn't open an interactive widget on first spawn.
    expect(json.bypassPermissionsModeAccepted).toBe(true);
  });

  it('preserves top-level keys lifted from the runtime .claude.json', () => {
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        userID: 'user-xyz',
        theme: 'dark',
      }),
    );

    const s = makeSession();
    const json = readSeed(s);
    expect(json.hasCompletedOnboarding).toBe(true);
    expect(json.userID).toBe('user-xyz');
    expect(json.theme).toBe('dark');
    // And the cwd trust entry got merged in.
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project entries for other cwds and merges (not replaces) the target cwd', () => {
    const otherCwd = '/some/other/path';
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({
        projects: {
          [otherCwd]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
          [cwd]: { lastSessionId: 'prev-session', allowedTools: ['Read'] },
        },
      }),
    );

    const s = makeSession();
    const json = readSeed(s);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    // Other cwd untouched.
    expect(projects[otherCwd]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash'],
    });
    // Target cwd: existing fields preserved, trust flags added on top,
    // empty containers NOT injected over real saved state.
    expect(projects[cwd].lastSessionId).toBe('prev-session');
    expect(projects[cwd].allowedTools).toEqual(['Read']);
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  it('falls back to a minimal seed when the runtime .claude.json is absent', () => {
    // No file at claudeRuntimeDir/.claude.json — typical fresh container.
    const s = makeSession();
    const json = readSeed(s);
    expect(json.hasCompletedOnboarding).toBe(true);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('falls back to a minimal seed when the runtime .claude.json is malformed', () => {
    fs.writeFileSync(path.join(claudeRuntimeDir, '.claude.json'), '{not valid json');
    const s = makeSession();
    const json = readSeed(s);
    expect(json.hasCompletedOnboarding).toBe(true);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('does not symlink .claude.json from runtime (would let writeFileSync corrupt the shared copy)', () => {
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({ canary: 'untouched' }),
    );

    const s = makeSession();
    const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
    expect(fs.lstatSync(seedPath).isSymbolicLink()).toBe(false);

    // Verify the runtime copy was not modified.
    const runtimeRaw = fs.readFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      'utf8',
    );
    expect(JSON.parse(runtimeRaw)).toEqual({ canary: 'untouched' });
  });
});
