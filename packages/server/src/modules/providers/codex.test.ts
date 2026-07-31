import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './ids.js';

/**
 * Codex adapter contract (multi-provider plan, Lot 4).
 *
 * Modelled on `claude.test.ts`: the assertions go through the seams a real
 * spawn crosses (the `PtyAgentProcess` / `SshAgentProcess` constructor options,
 * and the files left on disk), so the SSH path mapper under test is the real
 * one rather than a re-implementation.
 *
 * The codex binary is NEVER launched — CI has no OpenAI authentication, and
 * every behavioural claim about the CLI itself already lives in the spike
 * report (`scripts/verify-codex.report.md`). What is pinned here is the bytes
 * swarm-os produces:
 *
 *   1. argv + env, both transports, with the SSH paths translated
 *   2. the generated `config.toml`, section by section
 *   3. the TWO-ROOTS trap: the trust key must come from `paths.workspace` and
 *      `CODEX_HOME` from `paths.data`. Inverting them throws nothing in
 *      production — the trust modal comes back and the PTY just looks busy —
 *      so there are tests below that fail if they are swapped.
 *   4. `cleanupPaths` (codex writes per-session SQLite; the dir must die)
 *   5. `notify.sh`: present, 0700, and fed from argv[1] rather than stdin
 *   6. `AGENTS.md` carries the preamble
 *   7. `probe()` reports unavailable for a missing binary and never throws
 */

const captured = vi.hoisted(() => ({
  pty: [] as Array<Record<string, unknown>>,
  ssh: [] as Array<Record<string, unknown>>,
}));

vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/agent-process.js')>();
  class RecordingProcess {
    readonly pid = 4343;
    write(): void {}
    resize(): void {}
    kill(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onExit(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
  }
  class MockPtyAgentProcess extends RecordingProcess {
    constructor(opts: Record<string, unknown>) {
      super();
      captured.pty.push(opts);
    }
  }
  class MockSshAgentProcess extends RecordingProcess {
    constructor(opts: Record<string, unknown>) {
      super();
      captured.ssh.push(opts);
    }
  }
  return {
    ...actual,
    PtyAgentProcess: MockPtyAgentProcess,
    SshAgentProcess: MockSshAgentProcess,
  };
});

import { Session, type SessionSshTransport } from '../orchestrator/session.js';
import {
  CodexProvider,
  CODEX_EFFORT_MAP,
  CODEX_MCP_SERVER_NAME,
  CODEX_MCP_TOOL_NAMESPACE,
  buildCodexNotifyScript,
  codexMcpToolName,
} from './codex.js';
import { buildNotificationHookCommand } from './session-config.js';
import { IDENTITY_PATH_MAPPER } from './types.js';
import type { Config } from '../../config.js';

/**
 * The shared `~/.codex` entries, frozen here rather than imported so a silent
 * edit of the production list fails this test instead of agreeing with itself.
 * The SQLite files are the point: linking them would corrupt N sessions.
 */
const SHARED_ENTRIES = [
  'auth.json',
  'installation_id',
  'models_cache.json',
  'memories',
  'rules',
  'skills',
  'plugins',
];
const NEVER_SHARED = [
  'config.toml',
  'logs_2.sqlite',
  'logs_2.sqlite-wal',
  'state_5.sqlite',
  'state_5.sqlite-shm',
  'sessions',
  'history.jsonl',
];

let tmpRoot: string;
let dataDir: string;
let logsDir: string;
let mcpRuntimeDir: string;
let claudeRuntimeDir: string;
let hostCodexDir: string;
let workspaceRoot: string;
let cwd: string;
const openSessions: Session[] = [];

const HOST_DATA_DIR = '/host/data';
const HOST_WORKSPACE_ROOT = '/host/workspace';
const HOST_CLAUDE_DIR = '/host/home/.claude';
const HOST_CODEX_DIR = '/host/home/.codex';

/** Container path of the per-session CODEX_HOME, spelled out (never imported). */
function expectedConfigDir(sessionId: string): string {
  return path.join(dataDir, '.codex-runtime', 'sessions', sessionId);
}

function codexProvider(opts: { hostCodexDir?: string | null } = {}): CodexProvider {
  const host = opts.hostCodexDir === undefined ? hostCodexDir : opts.hostCodexDir;
  return new CodexProvider(host ? ({ hostCodexDir: host } as Config) : undefined);
}

function sshBundle(): SessionSshTransport {
  return {
    sshTarget: 'ubuntu@host.docker.internal',
    sshKey: '/keys/id_ed25519',
    sshPort: 2222,
    dataDir,
    hostDataDir: HOST_DATA_DIR,
    // Deliberately the CLAUDE dir: the codex adapter must ignore
    // `hostSharedDir` and use `config.hostCodexDir` instead.
    hostClaudeDir: HOST_CLAUDE_DIR,
    workspaceRoot,
    hostWorkspaceRoot: HOST_WORKSPACE_ROOT,
  };
}

beforeEach(() => {
  captured.pty.length = 0;
  captured.ssh.length = 0;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-provider-codex-'));
  dataDir = path.join(tmpRoot, 'data');
  logsDir = path.join(dataDir, 'logs');
  mcpRuntimeDir = path.join(dataDir, 'mcp-runtime');
  claudeRuntimeDir = path.join(dataDir, '.claude-runtime');
  hostCodexDir = HOST_CODEX_DIR;
  workspaceRoot = path.join(tmpRoot, 'workspace');
  cwd = path.join(workspaceRoot, 'proj');
  for (const d of [logsDir, mcpRuntimeDir, claudeRuntimeDir, cwd]) {
    fs.mkdirSync(d, { recursive: true });
  }
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

interface MakeOpts {
  id?: string;
  ssh?: boolean;
  skipSpawn?: boolean;
  preamble?: string | null;
  initialPrompt?: string | null;
  resumeNotice?: string | null;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model?: string;
  mcpPort?: number;
  runtimeRoot?: string | undefined;
  hooks?: boolean;
  hostCodexDir?: string | null;
}

function makeSession(opts: MakeOpts = {}): Session {
  const s = new Session({
    id: opts.id ?? 'sess-codex-1',
    orchestratorId: 'orch-1111',
    name: 'golden-codex',
    role: 'tester',
    type: 'worker',
    cwd,
    initialPrompt: opts.initialPrompt === undefined ? 'TASK' : opts.initialPrompt,
    preamble: opts.preamble === undefined ? 'ROLE PREAMBLE' : opts.preamble,
    resumeNotice: opts.resumeNotice ?? null,
    model: opts.model ?? 'gpt-5.5',
    effort: opts.effort ?? 'high',
    permissionMode: 'bypassPermissions',
    provider: codexProvider({ hostCodexDir: opts.hostCodexDir }),
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: opts.mcpPort ?? 8788,
    skipSpawn: opts.skipSpawn,
    hookToken: opts.hooks === false ? undefined : 'hook-token-xyz',
    mainHttpPort: opts.hooks === false ? undefined : 8787,
    runtimeRoot: 'runtimeRoot' in opts ? opts.runtimeRoot : claudeRuntimeDir,
    sshTransport: opts.ssh ? sshBundle() : null,
  });
  openSessions.push(s);
  return s;
}

function readToml(s: Session): string {
  return fs.readFileSync(path.join(s.claudeConfigDir!, 'config.toml'), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. capabilities / catalogue — what the UI and Session branch on
// ---------------------------------------------------------------------------

describe('codex adapter — capabilities', () => {
  it('claims exactly what the spike proved', () => {
    const p = codexProvider();
    expect(p.id).toBe('codex');
    expect(p.binary).toBe('codex');
    expect(p.capabilities).toEqual({
      effort: true,
      permissionModes: ['bypassPermissions'],
      fallbackPermissionMode: 'bypassPermissions',
      // C5: `notify` fires once per COMPLETED TURN (`agent-turn-complete` is the
      // only payload type codex emits), not when a human is needed. Declaring
      // that semantic is what stops `/hooks/notification` from turning a
      // twenty-turn codex lead into twenty Discord alerts and twenty armed
      // compactions — the badge and the notification are `'needs-human'` only.
      notificationHook: 'turn-complete',
      // C6: `"text\r"` in one write does NOT submit — ratatui absorbs the CR
      // exactly like Ink. This is the single most load-bearing flag here: with
      // `false`, `Session` would type lines that never fire.
      inkSubmitDance: true,
      durablePreamble: true,
      httpMcp: true,
    });
    expect(p.defaults()).toEqual({
      // Read from `ids.ts` rather than frozen here — `pnpm models:sync` rewrites
      // that table, and this assertion is about the wiring, not about which id
      // happens to be current.
      model: BUILTIN_PROVIDER_DEFAULT_MODELS.codex,
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
    });
    expect(p.models().map((m) => m.value)).toContain(BUILTIN_PROVIDER_DEFAULT_MODELS.codex);
  });

  it('maps our effort levels onto codex reasoning efforts (max → xhigh)', () => {
    expect(CODEX_EFFORT_MAP).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'xhigh',
    });
  });

  it('prefers /new over /clear and never decorates the token', () => {
    const p = codexProvider();
    // `/compact` summarizes in place (same thread-id); `/new` wipes the
    // conversation but keeps the operator's scrollback, unlike codex's own
    // `/clear` which blanks the terminal.
    expect(p.contextResetLine('/compact')).toBe('/compact');
    expect(p.contextResetLine('/clear')).toBe('/new');
    // Only the BARE tokens were proven to submit; a rejected `/compact <text>`
    // would silently skip the compaction, so instructions are dropped.
    expect(p.contextResetLine('/compact', 'keep the API contract')).toBe('/compact');
  });

  it('is a no-op for container-side runtime materialisation', () => {
    const p = codexProvider();
    expect(p.initRuntime({ sourceDir: '/x', runtimeDir: '/y' })).toEqual({
      initialized: false,
      copied: false,
      skipReason: 'not-applicable',
    });
    expect(() => p.refreshSharedFiles({ sourceDir: '/x', runtimeDir: '/y' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. spawn — local transport
// ---------------------------------------------------------------------------

describe('codex adapter — spawn (local transport)', () => {
  it('hands PtyAgentProcess the exact command / args / cwd / env', () => {
    makeSession();
    expect(captured.ssh).toHaveLength(0);
    expect(captured.pty).toHaveLength(1);
    const opts = captured.pty[0]!;
    expect(opts.command).toBe('codex');
    expect(opts.cwd).toBe(cwd);
    expect(opts.args).toEqual([
      '--no-alt-screen',
      '-C',
      cwd,
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=high',
      '--dangerously-bypass-approvals-and-sandbox',
      '--',
      'TASK',
    ]);
    // One env var, and it is the isolation root. No TERM: both PTY transports
    // already open the terminal as xterm-256color.
    expect(opts.env).toEqual({ CODEX_HOME: expectedConfigDir('sess-codex-1') });
  });

  it('never passes the preamble on the argv — it lives in AGENTS.md', () => {
    makeSession({ preamble: 'ROLE PREAMBLE' });
    const args = captured.pty[0]!.args as string[];
    expect(args.join(' ')).not.toContain('ROLE PREAMBLE');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('prefixes the resume notice onto the positional prompt only', () => {
    makeSession({ resumeNotice: 'NOTICE' });
    const args = captured.pty[0]!.args as string[];
    expect(args[args.length - 1]).toBe('NOTICE\n\nTASK');
  });

  it('emits no positional argv at all when there is nothing to seed', () => {
    makeSession({ initialPrompt: null, resumeNotice: null });
    const args = captured.pty[0]!.args as string[];
    expect(args[args.length - 1]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });

  it('maps `max` effort onto xhigh on the argv', () => {
    makeSession({ effort: 'max' });
    const args = captured.pty[0]!.args as string[];
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort=xhigh');
  });

  it('refuses to spawn without a per-session CODEX_HOME instead of half-configuring one', () => {
    // No runtimeRoot ⇒ no config dir ⇒ no trust entry (the PTY would wedge on
    // the trust modal) and no team-comms. `Session` records the refusal.
    const s = makeSession({ runtimeRoot: undefined });
    expect(s.claudeConfigDir).toBeNull();
    expect(captured.pty).toHaveLength(0);
    expect(s.status).toBe('failed');
    expect(() =>
      codexProvider().buildSpawn({
        model: 'gpt-5.5',
        effort: 'high',
        permissionMode: 'bypassPermissions',
        initialPrompt: null,
        preamble: null,
        resumeNotice: null,
        cwd,
        configDir: null,
        mcpConfigPath: null,
        paths: IDENTITY_PATH_MAPPER,
      }),
    ).toThrow(/per-session CODEX_HOME/);
  });
});

// ---------------------------------------------------------------------------
// 3. spawn — SSH transport (translated paths)
// ---------------------------------------------------------------------------

describe('codex adapter — spawn (ssh transport)', () => {
  it('translates the cwd through the workspace mount and CODEX_HOME through the data mount', () => {
    makeSession({ ssh: true });
    expect(captured.pty).toHaveLength(0);
    expect(captured.ssh).toHaveLength(1);
    const opts = captured.ssh[0]!;
    expect(opts.remoteCommand).toBe('codex');
    expect(opts.remoteCwd).toBe(`${HOST_WORKSPACE_ROOT}/proj`);
    expect(opts.args).toEqual([
      '--no-alt-screen',
      '-C',
      `${HOST_WORKSPACE_ROOT}/proj`,
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=high',
      '--dangerously-bypass-approvals-and-sandbox',
      '--',
      'TASK',
    ]);
    expect(opts.remoteEnv).toEqual({
      CODEX_HOME: `${HOST_DATA_DIR}/.codex-runtime/sessions/sess-codex-1`,
    });
    // The container MCP binds loopback only; the reverse tunnel is what lets
    // the host's 127.0.0.1:<port> reach back in.
    expect(opts.reverseTunnelPort).toBe(8788);
  });

  it('CODEX_HOME is data-mapped, NOT workspace-mapped (the silent-failure trap)', () => {
    makeSession({ ssh: true });
    const env = captured.ssh[0]!.remoteEnv as Record<string, string>;
    // Swapping the mappers does not throw: a path that does not match the
    // mapper's prefix is passed THROUGH unchanged. So assert both the right
    // answer and the two wrong ones.
    expect(env.CODEX_HOME).toBe(`${HOST_DATA_DIR}/.codex-runtime/sessions/sess-codex-1`);
    expect(env.CODEX_HOME).not.toBe(expectedConfigDir('sess-codex-1')); // untranslated
    expect(env.CODEX_HOME.startsWith(HOST_WORKSPACE_ROOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. prepareSessionConfig — the per-session CODEX_HOME
// ---------------------------------------------------------------------------

describe('codex adapter — per-session CODEX_HOME', () => {
  it('lives beside claude runtime root, never inside it, and is 0700', () => {
    const s = makeSession({ skipSpawn: true });
    const cfgDir = s.claudeConfigDir!;
    expect(cfgDir).toBe(expectedConfigDir('sess-codex-1'));
    // Never under claude's tree: the whole dir is `rm -rf`'d at exit.
    expect(cfgDir.startsWith(claudeRuntimeDir)).toBe(false);
    // And not under /tmp-like scratch either — codex refuses to create its
    // helper binaries under a temp dir; it must sit in the data mount.
    expect(cfgDir.startsWith(dataDir)).toBe(true);
    expect(fs.statSync(cfgDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(cfgDir, 'config.toml')).mode & 0o777).toBe(0o600);
  });

  it('declares the config dir as a cleanup path (codex writes per-session SQLite there)', () => {
    const p = codexProvider();
    const res = p.prepareSessionConfig({
      sessionId: 'sess-cleanup',
      orchestratorId: 'orch-1111',
      cwd,
      transport: 'local',
      paths: IDENTITY_PATH_MAPPER,
      preamble: 'ROLE',
      hookToken: 'hook-token-xyz',
      mainHttpPort: 8787,
      runtimeRoot: claudeRuntimeDir,
    });
    expect(res.configDir).toBe(expectedConfigDir('sess-cleanup'));
    expect(res.cleanupPaths).toEqual([expectedConfigDir('sess-cleanup')]);
  });

  it('never throws — a broken runtime root yields a null config dir', () => {
    const p = codexProvider();
    // A FILE where the runtime root's parent should be: every mkdir under it
    // fails with ENOTDIR.
    const bogus = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(bogus, 'x');
    let res!: ReturnType<CodexProvider['prepareSessionConfig']>;
    expect(() => {
      res = p.prepareSessionConfig({
        sessionId: 'sess-broken',
        orchestratorId: 'orch-1111',
        cwd,
        transport: 'local',
        paths: IDENTITY_PATH_MAPPER,
        preamble: 'ROLE',
        hookToken: 't',
        mainHttpPort: 1,
        runtimeRoot: path.join(bogus, 'child'),
      });
    }).not.toThrow();
    expect(res.configDir).toBeNull();
  });

  it('writes the preamble to AGENTS.md — the only channel that survives a reset', () => {
    const s = makeSession({ skipSpawn: true, preamble: 'You are AGENT-7.\nUse team.*' });
    const body = fs.readFileSync(path.join(s.claudeConfigDir!, 'AGENTS.md'), 'utf8');
    expect(body).toBe('You are AGENT-7.\nUse team.*\n');
    expect(fs.statSync(path.join(s.claudeConfigDir!, 'AGENTS.md')).mode & 0o777).toBe(0o600);
  });

  it('omits AGENTS.md when there is no preamble', () => {
    const s = makeSession({ skipSpawn: true, preamble: null });
    expect(fs.existsSync(path.join(s.claudeConfigDir!, 'AGENTS.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. config.toml — section by section
// ---------------------------------------------------------------------------

describe('codex adapter — config.toml', () => {
  it('declares the trust entry keyed on the CONTAINER cwd in local transport', () => {
    const s = makeSession({ skipSpawn: true });
    const toml = readToml(s);
    expect(toml).toContain(`[projects."${cwd}"]\ntrust_level = "trusted"`);
  });

  it('keys the trust entry on the HOST cwd under ssh, or the TUI blocks on the modal', () => {
    const s = makeSession({ skipSpawn: true, ssh: true });
    const toml = readToml(s);
    // The right answer …
    expect(toml).toContain(`[projects."${HOST_WORKSPACE_ROOT}/proj"]\ntrust_level = "trusted"`);
    // … and the two ways of getting it wrong. `paths.data(cwd)` would leave the
    // container path untouched (the cwd is not under dataDir), and using the
    // data mount's host root would key the entry on a path codex never opens.
    expect(toml).not.toContain(`[projects."${cwd}"]`);
    expect(toml).not.toContain(`[projects."${HOST_DATA_DIR}`);
  });

  it('points notify at the data-mapped script and nothing else', () => {
    const local = makeSession({ id: 'sess-local', skipSpawn: true });
    expect(readToml(local)).toContain(
      `notify = ["${path.join(expectedConfigDir('sess-local'), 'notify.sh')}"]`,
    );

    const ssh = makeSession({ id: 'sess-ssh', skipSpawn: true, ssh: true });
    expect(readToml(ssh)).toContain(
      `notify = ["${HOST_DATA_DIR}/.codex-runtime/sessions/sess-ssh/notify.sh"]`,
    );
  });

  it('omits notify entirely when the hook is not wired', () => {
    const s = makeSession({ skipSpawn: true, hooks: false });
    const toml = readToml(s);
    expect(toml).not.toContain('notify =');
    // …but the trust entry — the thing that keeps the PTY from wedging — is
    // still there.
    expect(toml).toContain('trust_level = "trusted"');
    expect(fs.existsSync(path.join(s.claudeConfigDir!, 'notify.sh'))).toBe(false);
  });

  it('declares no [hooks] table (config-declared hooks never run unattended)', () => {
    const s = makeSession({ skipSpawn: true });
    // Only the effective TOML matters — the file's header comments name these
    // keys precisely to explain why they are absent.
    const effective = readToml(s)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(effective).not.toContain('[hooks]');
    // Banned: it REPLACES the base Codex instructions, so the agent loses its
    // tool protocol.
    expect(effective).not.toContain('model_instructions_file');
    expect(effective).not.toContain('experimental_instructions_file');
    // Effort/model are argv-side; a stale duplicate here would silently win or
    // lose depending on precedence.
    expect(effective).not.toContain('model_reasoning_effort');
  });

  it('puts every top-level key before the first table header (TOML scoping)', () => {
    const s = makeSession({ skipSpawn: true });
    const toml = readToml(s);
    const firstTable = toml.indexOf('[projects.');
    expect(firstTable).toBeGreaterThan(0);
    // A `notify = …` after a table header would belong to that table and codex
    // would never see it.
    expect(toml.indexOf('notify =')).toBeLessThan(firstTable);
  });

  it('merges the team-comms MCP block with the session-secret URL', () => {
    const s = makeSession({ skipSpawn: true });
    const toml = readToml(s);
    expect(toml).toContain('[mcp_servers.team-comms]');
    expect(toml).toContain(
      `url = "http://127.0.0.1:8788/mcp/orch-1111/${s.sessionSecret}"`,
    );
    expect(toml).toContain('startup_timeout_sec = 30');
    // The MCP artifact IS the config file — codex has no `--mcp-config`.
    expect(s.mcpConfigPath).toBe(path.join(s.claudeConfigDir!, 'config.toml'));
    // No standalone mcp.json is produced for codex.
    expect(
      fs.existsSync(
        path.join(mcpRuntimeDir, 'orch-orch-1111', 'session-sess-codex-1', 'mcp.json'),
      ),
    ).toBe(false);
  });

  it('replaces the MCP table on a second write instead of stacking a duplicate', () => {
    const p = codexProvider();
    const prepared = p.prepareSessionConfig({
      sessionId: 'sess-twice',
      orchestratorId: 'orch-1111',
      cwd,
      transport: 'local',
      paths: IDENTITY_PATH_MAPPER,
      preamble: null,
      hookToken: 'hook-token-xyz',
      mainHttpPort: 8787,
      runtimeRoot: claudeRuntimeDir,
    });
    const req = {
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-twice',
      sessionSecret: 'secret-one',
      mcpHost: '127.0.0.1',
      mcpPort: 8788,
      configDir: prepared.configDir,
      paths: IDENTITY_PATH_MAPPER,
    };
    p.writeMcpConfig(req);
    const second = p.writeMcpConfig({ ...req, sessionSecret: 'secret-two' })!;
    const toml = fs.readFileSync(second.path, 'utf8');
    // TOML rejects a duplicate table outright — a stacked block would make
    // codex exit 1 with `failed to load configuration`.
    expect(toml.match(/\[mcp_servers\.team-comms\]/g)).toHaveLength(1);
    expect(toml).toContain('secret-two');
    expect(toml).not.toContain('secret-one');
    // The phase-A half is untouched by the merge.
    expect(toml).toContain('trust_level = "trusted"');
    expect(toml).toContain('notify = [');
  });

  it('scrubs the session secret from disk on cleanup, and never throws', () => {
    const p = codexProvider();
    const prepared = p.prepareSessionConfig({
      sessionId: 'sess-scrub',
      orchestratorId: 'orch-1111',
      cwd,
      transport: 'local',
      paths: IDENTITY_PATH_MAPPER,
      preamble: null,
      hookToken: 'hook-token-xyz',
      mainHttpPort: 8787,
      runtimeRoot: claudeRuntimeDir,
    });
    const written = p.writeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-scrub',
      sessionSecret: 'top-secret-value',
      mcpHost: '127.0.0.1',
      mcpPort: 8788,
      configDir: prepared.configDir,
      paths: IDENTITY_PATH_MAPPER,
    })!;
    expect(fs.readFileSync(written.path, 'utf8')).toContain('top-secret-value');
    p.removeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-scrub',
      configDir: prepared.configDir,
    });
    const after = fs.readFileSync(written.path, 'utf8');
    expect(after).not.toContain('top-secret-value');
    expect(after).not.toContain('[mcp_servers.team-comms]');
    expect(after).toContain('trust_level = "trusted"');
    // Called unguarded by `Session._cleanupMcpConfig` on the exit path: a throw
    // there would keep the session from reaching a terminal state.
    fs.rmSync(prepared.configDir!, { recursive: true, force: true });
    expect(() =>
      p.removeMcpConfig({
        runtimeDir: mcpRuntimeDir,
        orchestratorId: 'orch-1111',
        sessionId: 'sess-scrub',
        configDir: prepared.configDir,
      }),
    ).not.toThrow();
  });

  it('writes no MCP block when there is no config dir', () => {
    const p = codexProvider();
    expect(
      p.writeMcpConfig({
        runtimeDir: mcpRuntimeDir,
        orchestratorId: 'orch-1111',
        sessionId: 'sess-none',
        sessionSecret: 's',
        mcpHost: '127.0.0.1',
        mcpPort: 8788,
        configDir: null,
        paths: IDENTITY_PATH_MAPPER,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. notify.sh — argv[1], not stdin
// ---------------------------------------------------------------------------

describe('codex adapter — notify.sh', () => {
  it('is executable (0700) and reuses the shared POST pipeline verbatim', () => {
    const s = makeSession({ skipSpawn: true });
    const scriptPath = path.join(s.claudeConfigDir!, 'notify.sh');
    expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o700);
    const body = fs.readFileSync(scriptPath, 'utf8');
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    // codex hands the JSON over as argv[1] and leaves stdin EMPTY, so the
    // script synthesizes the stdin the shared pipeline expects…
    expect(body).toContain('printf \'%s\' "${1-}" | {');
    // …and the pipeline itself is the claude/gemini one, character for
    // character. If this fails, the two have drifted — fix the sharing, not
    // this expectation.
    expect(body).toContain(
      buildNotificationHookCommand({
        orchestratorId: 'orch-1111',
        sessionId: 'sess-codex-1',
        hookToken: 'hook-token-xyz',
        mainHttpPort: 8787,
      }),
    );
  });

  it('POSTs the argv payload (never stdin) with our ids and the hook bearer', () => {
    // Run the real script with a stubbed `curl` on PATH and stdin closed: this
    // is what proves the argv/stdin inversion is handled. The codex binary is
    // never involved.
    const stubBin = path.join(tmpRoot, 'stub-bin');
    const capture = path.join(tmpRoot, 'curl-args.txt');
    fs.mkdirSync(stubBin, { recursive: true });
    fs.writeFileSync(
      path.join(stubBin, 'curl'),
      `#!/bin/sh\n: > ${capture}\nfor a in "$@"; do printf '%s\\n' "$a" >> ${capture}; done\n`,
      { mode: 0o755 },
    );
    const scriptPath = path.join(tmpRoot, 'notify.sh');
    fs.writeFileSync(
      scriptPath,
      buildCodexNotifyScript({
        orchestratorId: 'orch-1111',
        sessionId: 'sess-codex-1',
        hookToken: 'hook-token-xyz',
        mainHttpPort: 8787,
      }),
      { mode: 0o700 },
    );
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': '019fa005-0a8b-7f73-ba10-1ae5a444ea73',
      cwd: '/workspace/proj',
      'last-assistant-message': 'done — "quoted" and \\ backslashed',
    });
    execFileSync('/bin/sh', [scriptPath, payload], {
      env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const args = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean);
    expect(args).toContain('Authorization: Bearer hook-token-xyz');
    expect(args).toContain('http://127.0.0.1:8787/hooks/notification');
    const bodyArg = args[args.indexOf('-d') + 1]!;
    const body = JSON.parse(bodyArg) as Record<string, string>;
    expect(body.orch_id).toBe('orch-1111');
    expect(body.session_id).toBe('sess-codex-1');
    // `/hooks/notification` rejects any other kind with a 400.
    expect(body.kind).toBe('session.waiting');
    // The payload made it through as a JSON string, escaping intact.
    expect(JSON.parse(body.message)).toEqual(JSON.parse(payload));
  });
});

// ---------------------------------------------------------------------------
// 7. shared-state symlinks
// ---------------------------------------------------------------------------

describe('codex adapter — shared state symlinks', () => {
  it('links unconditionally to the host ~/.codex under ssh — never to ~/.claude', () => {
    const s = makeSession({ skipSpawn: true, ssh: true });
    const cfgDir = s.claudeConfigDir!;
    for (const name of SHARED_ENTRIES) {
      expect(fs.readlinkSync(path.join(cfgDir, name))).toBe(
        path.join(HOST_CODEX_DIR, name),
      );
    }
    // `hostSharedDir` carries CLAUDE's root; a codex session that followed it
    // would start, log nothing, and not be authenticated.
    for (const name of SHARED_ENTRIES) {
      expect(fs.readlinkSync(path.join(cfgDir, name)).startsWith(HOST_CLAUDE_DIR)).toBe(
        false,
      );
    }
    // Per-session state and the SQLite files stay per-session.
    for (const name of NEVER_SHARED) {
      expect(fs.lstatSync(path.join(cfgDir, name), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(false);
    }
    expect(new Set(fs.readdirSync(cfgDir))).toEqual(
      new Set([...SHARED_ENTRIES, 'AGENTS.md', 'config.toml', 'notify.sh']),
    );
  });

  it('links only what exists in local transport', () => {
    const localHostDir = path.join(tmpRoot, 'home', '.codex');
    fs.mkdirSync(localHostDir, { recursive: true });
    fs.writeFileSync(path.join(localHostDir, 'auth.json'), '{}');
    fs.mkdirSync(path.join(localHostDir, 'skills'), { recursive: true });
    const s = makeSession({ skipSpawn: true, hostCodexDir: localHostDir });
    const cfgDir = s.claudeConfigDir!;
    expect(fs.readlinkSync(path.join(cfgDir, 'auth.json'))).toBe(
      path.join(localHostDir, 'auth.json'),
    );
    expect(fs.readlinkSync(path.join(cfgDir, 'skills'))).toBe(
      path.join(localHostDir, 'skills'),
    );
    expect(fs.existsSync(path.join(cfgDir, 'memories'))).toBe(false);
  });

  it('still produces a usable config dir when no host codex dir is configured', () => {
    const s = makeSession({ skipSpawn: true, hostCodexDir: null });
    const cfgDir = s.claudeConfigDir!;
    expect(cfgDir).toBe(expectedConfigDir('sess-codex-1'));
    expect(fs.existsSync(path.join(cfgDir, 'auth.json'))).toBe(false);
    expect(fs.readFileSync(path.join(cfgDir, 'config.toml'), 'utf8')).toContain(
      'trust_level = "trusted"',
    );
  });

  it('never writes a per-session file THROUGH a planted link', () => {
    // The other half of the symlink farm: `auth.json` and friends are LINKS into
    // the shared `~/.codex`, and `config.toml` / `AGENTS.md` / `notify.sh` are
    // per-session REGULAR files. A link at one of those paths would send this
    // session's MCP url (a bearer secret) and hook token straight into the
    // operator's shared `~/.codex/config.toml`, truncating it on the way — the
    // exact failure reproduced by planting a link and re-preparing the same id
    // (auto-resume reuses it; the dir survives a hard container kill).
    const shared = path.join(tmpRoot, 'operator-shared.toml');
    const SHARED_BODY = '# operator config\nmodel = "gpt-5.5"\n';
    const first = makeSession({ skipSpawn: true });
    const cfgDir = first.claudeConfigDir!;

    for (const [name, mode] of [
      ['AGENTS.md', 0o600],
      ['config.toml', 0o600],
      ['notify.sh', 0o700],
    ] as const) {
      fs.writeFileSync(shared, SHARED_BODY);
      const dest = path.join(cfgDir, name);
      fs.rmSync(dest);
      fs.symlinkSync(shared, dest);

      const again = makeSession({ skipSpawn: true });
      expect(again.claudeConfigDir).toBe(cfgDir);

      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(shared, 'utf8')).toBe(SHARED_BODY);
      // notify.sh is EXEC'd by codex: the guard must not quietly demote it.
      expect(fs.statSync(dest).mode & 0o777).toBe(mode);
    }
  });

  it('never rewrites the MCP block through a planted link either', () => {
    // Phase B.1 read-modify-writes `config.toml` on its own — including from
    // `removeMcpConfig` after a failed spawn, which does not re-run phase A.
    const shared = path.join(tmpRoot, 'operator-shared.toml');
    const SHARED_BODY = '# operator config\nmodel = "gpt-5.5"\n';
    fs.writeFileSync(shared, SHARED_BODY);
    const p = codexProvider();
    const prepared = p.prepareSessionConfig({
      sessionId: 'sess-codex-1',
      orchestratorId: 'orch-1111',
      cwd,
      transport: 'local',
      paths: IDENTITY_PATH_MAPPER,
      preamble: 'ROLE PREAMBLE',
      hookToken: 'hook-token-xyz',
      mainHttpPort: 8787,
      runtimeRoot: claudeRuntimeDir,
    });
    const dest = path.join(prepared.configDir!, 'config.toml');
    fs.rmSync(dest);
    fs.symlinkSync(shared, dest);

    p.writeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-codex-1',
      sessionSecret: 'sekret',
      mcpHost: '127.0.0.1',
      mcpPort: 8788,
      configDir: prepared.configDir!,
      paths: IDENTITY_PATH_MAPPER,
    });

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(shared, 'utf8')).toBe(SHARED_BODY);
    expect(fs.readFileSync(dest, 'utf8')).toContain('sekret');
  });
});

// ---------------------------------------------------------------------------
// 8. probe — never throws, reports a reason an operator can act on
// ---------------------------------------------------------------------------

/** Same adapter, pointed at a binary that is guaranteed not to exist. */
class MissingBinaryCodex extends CodexProvider {
  override readonly binary = 'codex-not-installed-swarm-os-test';
}

describe('codex adapter — probe', () => {
  it('reports unavailable with a readable reason when the binary is absent', async () => {
    const res = await new MissingBinaryCodex().probe({
      transport: 'local',
      config: {} as Config,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not on PATH/);
  });

  it('never throws when the ssh transport is not configured', async () => {
    const res = await codexProvider().probe({
      transport: 'ssh',
      config: { agentTransport: 'local', sshTarget: null } as unknown as Config,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/SWARM_OS_SSH_TARGET/);
  });

  it('answers the local transport without throwing, whatever the host has', async () => {
    const res = await codexProvider().probe({ transport: 'local', config: {} as Config });
    expect(typeof res.available).toBe('boolean');
    if (!res.available) expect(res.reason).toContain('codex');
  });
});

// ---------------------------------------------------------------------------
// MCP tool naming (Lot 9b)
// ---------------------------------------------------------------------------

describe('codex adapter — MCP tool naming', () => {
  it('turns the dots into underscores and changes nothing else', () => {
    // MEASURED on codex-cli 0.130.0 against a real MCP server plus a fake
    // OpenAI endpoint: the request declared
    //   {"type":"namespace","name":"mcp__team_comms__",
    //    "tools":[{"type":"function","name":"team_whoami",…}]}
    // and a reply naming `team_whoami` (with `namespace` in its own field) made
    // codex issue `tools/call team.whoami` on the MCP server. The
    // fully-qualified spellings were each answered `unsupported call: …`.
    expect(codexMcpToolName('team.whoami')).toBe('team_whoami');
    expect(codexMcpToolName('team.send_message')).toBe('team_send_message');
    expect(codexMcpToolName('swarm.broadcast_to_leads')).toBe('swarm_broadcast_to_leads');
    // Already dotless ⇒ untouched.
    expect(codexMcpToolName('team_whoami')).toBe('team_whoami');
  });

  it('exposes the same naming through the provider', () => {
    expect(codexProvider().mcpToolName('team.read_inbox')).toBe('team_read_inbox');
  });

  it('derives the namespace from the config table name', () => {
    // The namespace is never typed by the agent, but it is what an operator
    // finds in a transcript — and it is the observable proof that the server
    // name and the tool prefix cannot drift apart.
    expect(CODEX_MCP_SERVER_NAME).toBe('team-comms');
    expect(CODEX_MCP_TOOL_NAMESPACE).toBe('mcp__team_comms__');
  });
});
