import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from '../orchestrator/session.js';
import { FakeAgentProcess } from '../orchestrator/agent-process.js';
import { FakeProvider } from './fake.js';

/**
 * The branches claude never takes.
 *
 * `Session` used to hard-code Claude Code's PTY choreography: the two-step
 * write (text, then a solo `\r` at +150 ms) that an Ink TUI needs to parse a
 * submit rather than a paste, and the assumption that `/clear` and `/compact`
 * always exist. Both are now capability-driven. These tests pin the OTHER
 * side of each condition — the claude side is covered end-to-end in
 * `claude.test.ts` and `../orchestrator/session.test.ts`.
 */

let tmpRoot: string;
let logsDir: string;
let mcpRuntimeDir: string;
let cwd: string;
const openSessions: Session[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-fake-provider-'));
  logsDir = path.join(tmpRoot, 'logs');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  cwd = path.join(tmpRoot, 'workspace');
  for (const d of [logsDir, mcpRuntimeDir, cwd]) fs.mkdirSync(d, { recursive: true });
});

afterEach(async () => {
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 20));
  openSessions.length = 0;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeSession(provider: FakeProvider): { s: Session; fake: FakeAgentProcess } {
  const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
  const s = new Session({
    orchestratorId: 'orch-fake',
    name: 'fake',
    role: 'tester',
    type: 'worker',
    cwd,
    initialPrompt: null,
    preamble: null,
    model: 'fake-model',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    agentProcessOverride: fake,
    provider,
  });
  openSessions.push(s);
  return { s, fake };
}

describe('Session — capabilities.inkSubmitDance === false', () => {
  it('submitInput does ONE write with the CR attached (two for an Ink TUI)', async () => {
    const { s, fake } = makeSession(
      new FakeProvider({ capabilities: { inkSubmitDance: false } }),
    );
    s.submitInput('hi');
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.writes).toEqual(['hi\r']);
  });

  it('notifySignal does ONE write with the CR attached', async () => {
    const { s, fake } = makeSession(
      new FakeProvider({ capabilities: { inkSubmitDance: false } }),
    );
    s.notifySignal('inbox: 1 new');
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.writes).toEqual(['\rinbox: 1 new\r']);
  });

  it('keeps the two-step cadence when the capability is set (claude default)', async () => {
    const { s, fake } = makeSession(new FakeProvider());
    s.submitInput('hi');
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.writes).toEqual(['hi', '\r']);
  });
});

describe('Session — contextResetLine() returning null', () => {
  it('resolves the armed reset without writing anything into the PTY', async () => {
    const { s, fake } = makeSession(new FakeProvider({ contextResetLine: () => null }));
    expect(s.requestContextReset('/clear', { idleMs: 10 })).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    // Armed, fired, and deliberately nothing typed: a reset that wipes the
    // role while leaving the tools in place is worse than no reset.
    expect(s.hasPendingContextReset).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it('still writes when the provider supplies a line', async () => {
    const { s, fake } = makeSession(
      new FakeProvider({ contextResetLine: (cmd) => (cmd === '/compact' ? '/compress' : cmd) }),
    );
    s.requestContextReset('/compact', { idleMs: 10 });
    await new Promise((r) => setTimeout(r, 350));
    expect(fake.writes.join('')).toContain('/compress');
  });
});

describe('Session — provider-declared cleanup paths', () => {
  it('removes them when the session exits, and leaves them alone until then', async () => {
    // codex (Lot 4) keeps per-session SQLite state that must NOT be shared
    // across sessions, so its config dir is born and dies with the session.
    // claude returns no cleanup paths, so this is the only way the branch runs.
    const doomed = path.join(tmpRoot, 'per-session-config');
    fs.mkdirSync(path.join(doomed, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(doomed, 'nested', 'state.sqlite'), 'x');
    const { s, fake } = makeSession(
      new FakeProvider({
        sessionConfig: () => ({ configDir: doomed, cleanupPaths: [doomed] }),
      }),
    );
    expect(fs.existsSync(doomed)).toBe(true);
    fake._simulateExit({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.status).toBe('exited');
    expect(fs.existsSync(doomed)).toBe(false);
  });

  it('is a no-op for a provider that declares none (claude)', async () => {
    const keep = path.join(tmpRoot, 'kept-config');
    fs.mkdirSync(keep, { recursive: true });
    const { s, fake } = makeSession(
      new FakeProvider({ sessionConfig: () => ({ configDir: keep, cleanupPaths: [] }) }),
    );
    fake._simulateExit({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.status).toBe('exited');
    expect(fs.existsSync(keep)).toBe(true);
  });
});

describe('Session — a FAILED spawn still reclaims its artifacts', () => {
  it('removes the per-session config dir, not just the MCP config', async () => {
    // Lot 9a. The failed-spawn path used to call `_cleanupMcpConfig()` and
    // nothing else, so a provider whose `buildSpawn` refused left its config dir
    // on disk FOREVER — `_handleExit` never runs when there is no process to
    // exit. For codex/gemini that directory holds credential symlinks and the
    // session's MCP url; for opencode, four XDG roots and a SQLite db.
    const doomed = path.join(tmpRoot, 'partial-config');
    fs.mkdirSync(doomed, { recursive: true });
    fs.writeFileSync(path.join(doomed, 'config.toml'), 'url = "http://…/secret"');
    const provider = new FakeProvider({
      sessionConfig: () => ({ configDir: doomed, cleanupPaths: [doomed] }),
      buildSpawnError: 'refusing to launch a half-configured agent',
    });
    const s = new Session({
      orchestratorId: 'orch-fail',
      name: 'fails',
      role: 'tester',
      type: 'worker',
      cwd,
      initialPrompt: null,
      preamble: null,
      model: 'fake-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      provider,
    });
    openSessions.push(s);
    expect(s.status).toBe('failed');
    expect(s.lastError).toMatch(/half-configured/);
    expect(fs.existsSync(doomed)).toBe(false);
    // …and the MCP teardown ran too, so a session secret merged into a config
    // file is scrubbed even when the directory removal is what got it.
    expect(provider.mcpCleanupRequests).toHaveLength(1);
  });
});

describe('Session — removeMcpConfig for an INLINE-config provider', () => {
  it('is called on exit even though writeMcpConfig returned null', async () => {
    // Lot 9a. `_cleanupMcpConfig` began with `if (!this.mcpConfigPath) return;`,
    // and `mcpConfigPath` is permanently null for a provider that writes no MCP
    // file — i.e. every inline-config provider (opencode is the first: its config,
    // MCP url included, travels in `OPENCODE_CONFIG_CONTENT`). Such a provider
    // never got the callback at all and had to sweep its own state later.
    const provider = new FakeProvider();
    const { s, fake } = makeSession(provider);
    expect(provider.mcpCleanupRequests).toHaveLength(0);
    fake._simulateExit({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.status).toBe('exited');
    expect(provider.mcpCleanupRequests).toHaveLength(1);
    expect(provider.mcpCleanupRequests[0]?.sessionId).toBe(s.id);
  });

  it('is called when a process-less session is stopped', async () => {
    // `stop()` on a session with no PTY (skipSpawn, or a spawn that never
    // produced one) is a TERMINAL state that `_handleExit` will never follow, so
    // it is the only place those artifacts can be reclaimed.
    const doomed = path.join(tmpRoot, 'skip-spawn-config');
    fs.mkdirSync(doomed, { recursive: true });
    const provider = new FakeProvider({
      sessionConfig: () => ({ configDir: doomed, cleanupPaths: [doomed] }),
    });
    const s = new Session({
      orchestratorId: 'orch-skip',
      name: 'skipped',
      role: 'tester',
      type: 'worker',
      cwd,
      initialPrompt: null,
      preamble: null,
      model: 'fake-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      skipSpawn: true,
      provider,
    });
    openSessions.push(s);
    s.stop('operator', 0);
    expect(s.status).toBe('killed');
    expect(provider.mcpCleanupRequests).toHaveLength(1);
    expect(fs.existsSync(doomed)).toBe(false);
  });
});

describe('Session — PreparedSpawn.secretEnv', () => {
  it('merges into the child env in local transport (no file, no command line)', () => {
    // Nothing to hide from locally: the child's environment is readable only by
    // the same uid, which is where we already are. So the two buckets merge and
    // no file is written.
    const configDir = path.join(tmpRoot, 'local-config');
    fs.mkdirSync(configDir, { recursive: true });
    const provider = new FakeProvider({
      binary: 'true',
      sessionConfig: () => ({ configDir, cleanupPaths: [] }),
      env: { PUBLIC_THING: 'visible' },
      secretEnv: { SECRET_THING: 'sk-test-123' },
    });
    const s = new Session({
      orchestratorId: 'orch-secret-local',
      name: 'secret-local',
      role: 'tester',
      type: 'worker',
      cwd,
      initialPrompt: null,
      preamble: null,
      model: 'fake-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      provider,
    });
    openSessions.push(s);
    // No env file anywhere in the config dir.
    expect(fs.readdirSync(configDir)).toEqual([]);
  });

  it('never writes a file for a provider that declares no secrets', () => {
    const configDir = path.join(tmpRoot, 'no-secret-config');
    fs.mkdirSync(configDir, { recursive: true });
    const provider = new FakeProvider({
      binary: 'true',
      sessionConfig: () => ({ configDir, cleanupPaths: [] }),
    });
    const s = new Session({
      orchestratorId: 'orch-no-secret',
      name: 'no-secret',
      role: 'tester',
      type: 'worker',
      cwd,
      initialPrompt: null,
      preamble: null,
      model: 'fake-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      provider,
    });
    openSessions.push(s);
    expect(fs.readdirSync(configDir)).toEqual([]);
  });
});

describe('Session — a provider that writes no MCP artifact', () => {
  it('spawns anyway, with a null mcpConfigPath in the spawn request', () => {
    const provider = new FakeProvider();
    const { s } = makeSession(provider);
    expect(s.status).toBe('running');
    // `agentProcessOverride` short-circuits buildSpawn, so drive the adapter
    // through a real (skipSpawn=false, no override) session instead.
    const direct = new Session({
      orchestratorId: 'orch-fake-2',
      name: 'fake-2',
      role: 'tester',
      type: 'worker',
      cwd,
      initialPrompt: null,
      preamble: null,
      model: 'fake-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      skipSpawn: true,
      provider,
    });
    openSessions.push(direct);
    // No mcp.json on disk, and no `mcp.json written at …` line to log.
    expect(fs.existsSync(path.join(mcpRuntimeDir, 'orch-orch-fake-2'))).toBe(false);
    expect(direct.status).toBe('running');
  });
});
