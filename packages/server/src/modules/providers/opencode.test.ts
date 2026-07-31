import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './ids.js';

/**
 * Contract test for the opencode adapter (Lot 6a).
 *
 * Modelled on `claude.test.ts`: it freezes the exact bytes the adapter is
 * responsible for, so a later edit that drifts from
 * `scripts/verify-opencode.report.md` fails here instead of producing an agent
 * that boots, looks healthy, and is not a member of the swarm.
 *
 * What is frozen, and which spike check paid for it:
 *   1. argv — `--prompt` for the message, NEVER the positional (C0: the
 *      positional of `opencode [project]` is the project PATH)
 *   2. env  — inline `OPENCODE_CONFIG_CONTENT` (C1), the four per-session
 *      `XDG_*` roots (C1/C1b), `OPENCODE_DISABLE_AUTOUPDATE`,
 *      `OPENCODE_SERVER_PASSWORD` (C8: the control plane is otherwise
 *      unauthenticated)
 *   3. the WHOLE env in `secretEnv` and `env` left empty — under SSH `env`
 *      becomes the remote command line, readable by any host user's `ps`, and
 *      three of this adapter's values are secrets (the OpenRouter key, the inline
 *      config embedding the session's MCP url, the control-plane password)
 *   4. the config JSON: `mcp.type === "remote"` (not "http") with the secret in
 *      the URL path (C2), `instructions[]` (C3), `permission: "allow"` (C4), and
 *      the model as `openrouter/<vendor>/<model>` (C5)
 *   5. the two-roots rule: `paths.data` for what the SERVER wrote — with an
 *      assertion that fails if someone reaches for `paths.workspace`
 *   6. `probe()` — three distinct, human-readable outcomes, and it never throws
 *   7. `cleanupPaths` really covers the per-session `XDG_*` dirs
 *
 * THE BINARY IS NEVER LAUNCHED. `probe.js` is mocked; the spike is what tests
 * real CLI behaviour.
 */

const probeState = vi.hoisted(() => ({
  value: { available: true, version: 'opencode 1.18.5' } as {
    available: boolean;
    reason?: string;
    version?: string;
  },
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('./probe.js', () => ({
  PROBE_DEFAULT_TIMEOUT_MS: 5_000,
  probeCliBinary: (opts: Record<string, unknown>) => {
    probeState.calls.push(opts);
    return Promise.resolve(probeState.value);
  },
}));

/** Captured `PtyAgentProcess` / `SshAgentProcess` constructor options. */
const captured = vi.hoisted(() => ({
  pty: [] as Array<Record<string, unknown>>,
  ssh: [] as Array<Record<string, unknown>>,
}));

vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/agent-process.js')>();
  class RecordingProcess {
    readonly pid = 4242;
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
  return { ...actual, PtyAgentProcess: MockPtyAgentProcess, SshAgentProcess: MockSshAgentProcess };
});

import {
  OpencodeProvider,
  OPENCODE_API_KEY_ENV,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_CONTROL_PORT_BASE,
  OPENCODE_MCP_SERVER_KEY,
  OPENCODE_MCP_TIMEOUT_MS,
  OPENCODE_ROLE_FILE,
  OPENCODE_SESSION_SUBDIR,
  OPENCODE_SHARED_ENTRIES,
  SWARM_OPENROUTER_KEY_ENV,
  buildOpencodeConfig,
  normalizeOpencodeModel,
  opencodeMcpToolName,
} from './opencode.js';
import { IDENTITY_PATH_MAPPER, type AgentPathMapper, type PreparedSpawn } from './types.js';
import { toHostPath } from '../orchestrator/path-translate.js';
import { FakeAgentProcess } from '../orchestrator/agent-process.js';
import { Session, type SessionSshTransport } from '../orchestrator/session.js';

const KEY = 'sk-or-v1-TEST-KEY-0123456789';
const PINNED_PASSWORD = 'PINNED_CONTROL_PASSWORD';
const HOST_DATA_DIR = '/host/data';
const HOST_WORKSPACE_ROOT = '/host/workspace';

/**
 * Port + password pinned so the golden argv/env can be exact. The production
 * allocator is exercised separately (see "control plane").
 */
class PinnedOpencodeProvider extends OpencodeProvider {
  protected override allocateControlPort(): number {
    return OPENCODE_CONTROL_PORT_BASE;
  }
  protected override generateServerPassword(): string {
    return PINNED_PASSWORD;
  }
}

let tmpRoot: string;
let dataDir: string;
let logsDir: string;
let mcpRuntimeDir: string;
let runtimeRoot: string;
let workspaceRoot: string;
let cwd: string;

beforeEach(() => {
  captured.pty.length = 0;
  captured.ssh.length = 0;
  probeState.calls.length = 0;
  probeState.value = { available: true, version: 'opencode 1.18.5' };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-provider-opencode-'));
  dataDir = path.join(tmpRoot, 'data');
  logsDir = path.join(dataDir, 'logs');
  mcpRuntimeDir = path.join(dataDir, 'mcp-runtime');
  runtimeRoot = path.join(dataDir, '.claude-runtime');
  workspaceRoot = path.join(tmpRoot, 'workspace');
  cwd = path.join(workspaceRoot, 'proj');
  for (const d of [logsDir, mcpRuntimeDir, runtimeRoot, cwd]) {
    fs.mkdirSync(d, { recursive: true });
  }
  vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Path mapper with the real `toHostPath` semantics, including the one that makes
 * an inversion silent: a prefix that matches NEITHER root is returned unchanged.
 * `workspace` calls are counted so a test can assert the adapter never reaches
 * for the wrong root.
 */
function sshMapper(): AgentPathMapper & { workspaceCalls: string[]; dataCalls: string[] } {
  const workspaceCalls: string[] = [];
  const dataCalls: string[] = [];
  return {
    workspaceCalls,
    dataCalls,
    data: (p: string) => {
      dataCalls.push(p);
      return toHostPath({ containerPath: p, dataDir, hostDataDir: HOST_DATA_DIR });
    },
    workspace: (p: string) => {
      workspaceCalls.push(p);
      return toHostPath({
        containerPath: p,
        dataDir: workspaceRoot,
        hostDataDir: HOST_WORKSPACE_ROOT,
      });
    },
  };
}

interface WireOpts {
  provider?: OpencodeProvider;
  transport?: 'local' | 'ssh';
  paths?: AgentPathMapper;
  sessionId?: string;
  preamble?: string | null;
  runtimeRoot?: string | undefined;
  mcpHost?: string;
  mcpPort?: number;
  sessionSecret?: string;
  model?: string;
  initialPrompt?: string | null;
  resumeNotice?: string | null;
  buildSpawn?: boolean;
}

/** Drive the three phases in the order `Session` drives them. */
function wire(o: WireOpts = {}) {
  const provider = o.provider ?? new PinnedOpencodeProvider();
  const transport = o.transport ?? 'local';
  const paths = o.paths ?? (transport === 'ssh' ? sshMapper() : IDENTITY_PATH_MAPPER);
  const sessionId = o.sessionId ?? 'sess-1';
  const preamble = o.preamble === undefined ? 'ROLE PREAMBLE' : o.preamble;
  const prepared = provider.prepareSessionConfig({
    sessionId,
    orchestratorId: 'orch-1',
    cwd,
    transport,
    paths,
    preamble,
    runtimeRoot: o.runtimeRoot === undefined ? runtimeRoot : o.runtimeRoot,
  });
  const mcp = provider.writeMcpConfig({
    runtimeDir: mcpRuntimeDir,
    orchestratorId: 'orch-1',
    sessionId,
    sessionSecret: o.sessionSecret ?? 'secret-abc',
    mcpHost: o.mcpHost ?? '127.0.0.1',
    mcpPort: o.mcpPort ?? 8788,
    configDir: prepared.configDir,
    paths,
  });
  let spawn: PreparedSpawn | null = null;
  if (o.buildSpawn !== false) {
    spawn = provider.buildSpawn({
      model: o.model ?? 'anthropic/claude-opus-5',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      initialPrompt: o.initialPrompt === undefined ? 'TASK' : o.initialPrompt,
      preamble,
      resumeNotice: o.resumeNotice ?? null,
      cwd,
      configDir: prepared.configDir,
      mcpConfigPath: null,
      paths,
    });
  }
  return { provider, prepared, mcp, spawn, paths, sessionId };
}

function sessionDirOf(sessionId = 'sess-1'): string {
  return path.join(runtimeRoot, OPENCODE_SESSION_SUBDIR, sessionId);
}

/**
 * The env the PROCESS ends up with, whichever bucket carried it.
 *
 * This adapter routes its WHOLE env through `secretEnv` (Lot 9a): `env` would
 * land on the remote command line under SSH and three of its values are secrets
 * (the OpenRouter key, the inline config embedding the session's MCP url, and the
 * control-plane password). `Session` applies both buckets to the same process, so
 * tests that care about the VALUE use this, and tests that care about EXPOSURE
 * assert on `spawn.env` / `spawn.secretEnv` directly.
 */
function envOf(spawn: PreparedSpawn): Record<string, string> {
  return { ...spawn.env, ...(spawn.secretEnv ?? {}) };
}

function configOf(spawn: PreparedSpawn): Record<string, unknown> {
  return JSON.parse(envOf(spawn).OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe('opencode adapter — pure helpers', () => {
  it('prefixes the OpenRouter slug with the provider id, idempotently', () => {
    expect(normalizeOpencodeModel('anthropic/claude-opus-5')).toBe(
      'openrouter/anthropic/claude-opus-5',
    );
    // An operator free-texting the fully qualified id must not get
    // `openrouter/openrouter/…`.
    expect(normalizeOpencodeModel('openrouter/anthropic/claude-opus-5')).toBe(
      'openrouter/anthropic/claude-opus-5',
    );
    expect(normalizeOpencodeModel('  openai/gpt-5.5  ')).toBe('openrouter/openai/gpt-5.5');
    // Never emit the bare prefix — opencode rejects it as a malformed id.
    expect(normalizeOpencodeModel('')).toBe('openrouter/anthropic/claude-opus-5');
  });

  it('mangles MCP tool names the way opencode does (C2b)', () => {
    // Literal observation from the spike: `team.whoami` on a server keyed
    // `swarm-team` reached the model as `swarm-team_team_whoami` — dots become
    // underscores, dashes in the key survive.
    expect(opencodeMcpToolName('team.whoami', 'swarm-team')).toBe('swarm-team_team_whoami');
    // Under the key this adapter uses:
    expect(opencodeMcpToolName('team.whoami')).toBe('team_team_whoami');
    expect(opencodeMcpToolName('team.send_message')).toBe('team_team_send_message');
    expect(OPENCODE_MCP_SERVER_KEY).toBe('team');
  });

  it('exposes that same mangling as the provider naming hook (Lot 9b)', () => {
    // `AgentProvider.mcpToolName` is what `buildPreamble` renders the role text
    // through. It must DELEGATE rather than re-implement: two copies of the
    // mangling is how the config and the preamble drift apart, and the failure
    // is an agent told to call a tool it does not have.
    const p = new OpencodeProvider();
    for (const t of ['team.whoami', 'team.read_inbox', 'swarm.send_to_lead']) {
      expect(p.mcpToolName(t)).toBe(opencodeMcpToolName(t));
    }
    expect(p.mcpToolName('team.whoami')).toBe('team_team_whoami');
  });

  it('builds the config with "remote" (not "http") and both permission belts', () => {
    const cfg = buildOpencodeConfig({
      model: 'openrouter/anthropic/claude-opus-5',
      instructionsPath: '/data/x/SWARM_ROLE.md',
      mcpUrl: 'http://127.0.0.1:8788/mcp/orch-1/secret-abc',
    });
    expect(cfg).toEqual({
      $schema: OPENCODE_CONFIG_SCHEMA,
      model: 'openrouter/anthropic/claude-opus-5',
      instructions: ['/data/x/SWARM_ROLE.md'],
      permission: 'allow',
      mcp: {
        team: {
          type: 'remote',
          url: 'http://127.0.0.1:8788/mcp/orch-1/secret-abc',
          enabled: true,
          timeout: OPENCODE_MCP_TIMEOUT_MS,
        },
      },
    });
  });

  it('omits instructions and mcp when there is nothing to point at', () => {
    const cfg = buildOpencodeConfig({
      model: 'openrouter/x/y',
      instructionsPath: null,
      mcpUrl: null,
    });
    expect(cfg).toEqual({ $schema: OPENCODE_CONFIG_SCHEMA, model: 'openrouter/x/y', permission: 'allow' });
  });

  it('shares nothing from the host ~/.opencode — deliberately', () => {
    // opencode keeps no state there and the OpenRouter key is env-only (C5), so
    // there is no credential to symlink. A non-empty list would mean someone
    // symlinked a WAL-mode SQLite db into N sessions.
    expect(OPENCODE_SHARED_ENTRIES).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Capabilities + catalogue
// ---------------------------------------------------------------------------

describe('opencode adapter — declared capabilities', () => {
  it('matches what the spike proved, field by field', () => {
    expect(new OpencodeProvider().capabilities).toEqual({
      // No effort knob on the interactive TUI (`--variant` is `run`-only).
      effort: false,
      permissionModes: ['bypassPermissions'],
      fallbackPermissionMode: 'bypassPermissions',
      // C8 proved a channel EXISTS (GET /event SSE: permission.asked +
      // session.idle) — but NOTHING CONSUMES IT YET (Lot 6c), so no opencode
      // session ever reaches `waiting`. The field states what the SERVER
      // receives, not what the CLI offers, so the honest value is `false`: that
      // is what makes the UI say "its sessions never report waiting" instead of
      // an operator discovering it while wondering why a team looks silent.
      notificationHook: false,
      // C6 — a single `write("text\r")` submits; opencode is not Ink.
      inkSubmitDance: false,
      // C3 — instructions[] is re-resolved on every request, survives /clear.
      durablePreamble: true,
      // C2 — type:"remote" over streamable HTTP, secret in the URL path.
      httpMcp: true,
    });
  });

  it('keeps the registered identity untouched', () => {
    const p = new OpencodeProvider();
    expect(p.id).toBe('opencode');
    expect(p.label).toBe('OpenCode (OpenRouter)');
    expect(p.binary).toBe('opencode');
  });

  it('lists bare OpenRouter slugs — the provider prefix is the adapter’s job', () => {
    const p = new OpencodeProvider();
    for (const m of p.models()) {
      expect(m.value.startsWith('openrouter/')).toBe(false);
      expect(m.value).toContain('/');
    }
    // The constant, not the literal — `pnpm models:sync` owns that table.
    expect(p.defaults().model).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS.opencode);
    expect(p.defaults().permissionMode).toBe('bypassPermissions');
  });
});

// ---------------------------------------------------------------------------
// 3. PHASE A — per-session config dir
// ---------------------------------------------------------------------------

describe('opencode adapter — prepareSessionConfig', () => {
  it('creates the session dir + four XDG roots at 0700 and the role file at 0600', () => {
    const { prepared } = wire({ buildSpawn: false });
    const dir = sessionDirOf();
    expect(prepared.configDir).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of ['config', 'data', 'cache', 'state']) {
      const sub = path.join(dir, name);
      expect(fs.statSync(sub).isDirectory()).toBe(true);
      expect(fs.statSync(sub).mode & 0o777).toBe(0o700);
    }
    const role = path.join(dir, OPENCODE_ROLE_FILE);
    expect(fs.readFileSync(role, 'utf8')).toBe('ROLE PREAMBLE');
    expect(fs.statSync(role).mode & 0o777).toBe(0o600);
    // Nothing else — in particular no config file on disk (C1: inline instead).
    expect(new Set(fs.readdirSync(dir))).toEqual(
      new Set(['config', 'data', 'cache', 'state', OPENCODE_ROLE_FILE]),
    );
  });

  it('needs no hook token / http port, unlike claude', () => {
    // opencode has no shell-hook mechanism; its notification channel is the
    // --port SSE stream, so a session with a runtimeRoot always gets a dir.
    const { prepared } = wire({ buildSpawn: false });
    expect(prepared.configDir).not.toBeNull();
  });

  it('writes no role file (and no instructions) when there is no preamble', () => {
    const { prepared, spawn } = wire({ preamble: null });
    expect(fs.existsSync(path.join(prepared.configDir!, OPENCODE_ROLE_FILE))).toBe(false);
    expect(configOf(spawn!).instructions).toBeUndefined();
  });

  it('returns a null config dir when no runtime root is configured', () => {
    const p = new PinnedOpencodeProvider();
    const res = p.prepareSessionConfig({
      sessionId: 'no-root',
      orchestratorId: 'orch-1',
      cwd,
      transport: 'local',
      paths: IDENTITY_PATH_MAPPER,
      preamble: 'ROLE',
    });
    expect(res).toEqual({ configDir: null, cleanupPaths: [] });
  });

  it('never throws when the runtime root is not writable', () => {
    const p = new PinnedOpencodeProvider();
    // A regular FILE where the directory tree should go — mkdirSync raises
    // ENOTDIR. Phase A must degrade to "no config dir", not blow up the
    // Session constructor.
    const blocked = path.join(tmpRoot, 'blocked');
    fs.writeFileSync(blocked, 'not a dir');
    const res = p.prepareSessionConfig({
      sessionId: 'sess-x',
      orchestratorId: 'orch-1',
      cwd,
      transport: 'local',
      paths: IDENTITY_PATH_MAPPER,
      preamble: 'ROLE',
      runtimeRoot: blocked,
    });
    expect(res).toEqual({ configDir: null, cleanupPaths: [] });
  });

  it('covers every per-session XDG dir with cleanupPaths', () => {
    const { prepared, spawn } = wire();
    const env = envOf(spawn!);
    const owned = [
      env.XDG_CONFIG_HOME!,
      env.XDG_DATA_HOME!,
      env.XDG_CACHE_HOME!,
      env.XDG_STATE_HOME!,
      path.join(prepared.configDir!, OPENCODE_ROLE_FILE),
    ];
    expect(prepared.cleanupPaths).toEqual([prepared.configDir]);
    for (const p of owned) {
      expect(
        prepared.cleanupPaths.some((root) => p === root || p.startsWith(root + path.sep)),
      ).toBe(true);
    }
    // Now do exactly what `Session._cleanupSessionConfig` does.
    for (const target of prepared.cleanupPaths) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    for (const p of owned) expect(fs.existsSync(p)).toBe(false);
  });

  it('never writes the role file THROUGH a planted link', () => {
    // opencode's session dir holds no credential symlinks today, but the
    // invariant is the adapters', not one adapter's: a per-session file is a
    // REGULAR file. A link planted at `SWARM_ROLE.md` (a leftover in a dir that
    // survived a hard container kill, re-prepared under the same id by
    // auto-resume) must be replaced, never followed — `--instructions` points
    // the agent at this path, so following the link would rewrite whatever the
    // operator kept there.
    const shared = path.join(tmpRoot, 'operator-notes.md');
    const SHARED_BODY = '# operator notes\n';
    fs.writeFileSync(shared, SHARED_BODY);
    const provider = new PinnedOpencodeProvider();
    const first = wire({ provider, buildSpawn: false });
    const dest = path.join(first.prepared.configDir!, OPENCODE_ROLE_FILE);
    fs.rmSync(dest);
    fs.symlinkSync(shared, dest);

    wire({ provider, buildSpawn: false });

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(shared, 'utf8')).toBe(SHARED_BODY);
    expect(fs.readFileSync(dest, 'utf8')).toBe('ROLE PREAMBLE');
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
  });

  it('sweeps state for sessions whose config dir is gone', () => {
    const provider = new PinnedOpencodeProvider();
    const a = wire({ provider, sessionId: 'sess-a', buildSpawn: false });
    expect(provider.controlPlane(a.prepared.configDir)).not.toBeNull();
    // `Session._cleanupSessionConfig` removed the dir on exit, but
    // `_cleanupMcpConfig` (and therefore `removeMcpConfig`) never fired because
    // this adapter returns a null McpWriteResult. The sweep is what bounds the
    // map on a 24/7 process.
    fs.rmSync(a.prepared.configDir!, { recursive: true, force: true });
    wire({ provider, sessionId: 'sess-b', buildSpawn: false });
    expect(provider.controlPlane(a.prepared.configDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. PHASE B.1 — MCP
// ---------------------------------------------------------------------------

describe('opencode adapter — writeMcpConfig', () => {
  it('writes NO file and returns null — the config travels inline', () => {
    const { mcp, prepared } = wire({ buildSpawn: false });
    expect(mcp).toBeNull();
    // Nothing under the mcp runtime dir: a missing OPENCODE_CONFIG path is
    // silently ignored by opencode (C1), so we never create one to typo.
    expect(fs.readdirSync(mcpRuntimeDir)).toEqual([]);
    expect(fs.readdirSync(prepared.configDir!).includes('opencode.json')).toBe(false);
  });

  it('carries the session secret in the URL path, no headers (C2)', () => {
    const { spawn } = wire({ sessionSecret: 'sekret_xyz', mcpPort: 9999 });
    const mcp = (configOf(spawn!).mcp as Record<string, Record<string, unknown>>).team!;
    expect(mcp).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:9999/mcp/orch-1/sekret_xyz',
      enabled: true,
      timeout: OPENCODE_MCP_TIMEOUT_MS,
    });
    expect(mcp.headers).toBeUndefined();
  });

  it('drops the state entry when removeMcpConfig does get called', () => {
    const { provider, prepared } = wire({ buildSpawn: false });
    provider.removeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1',
      sessionId: 'sess-1',
      configDir: prepared.configDir,
    });
    expect(provider.controlPlane(prepared.configDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. PHASE B.2 — argv + env (the golden contract)
// ---------------------------------------------------------------------------

describe('opencode adapter — buildSpawn argv', () => {
  it('emits the exact flag order, with the prompt on --prompt', () => {
    const { spawn } = wire();
    expect(spawn!.command).toBe('opencode');
    expect(spawn!.args).toEqual([
      // C4 — without --auto (and permission:"allow") the loop stops on an
      // Allow/Reject dialog that emits zero bytes.
      '--auto',
      // C8 — per-session HTTP control plane + /event SSE.
      '--port',
      String(OPENCODE_CONTROL_PORT_BASE),
      '--hostname',
      '127.0.0.1',
      '--model',
      'openrouter/anthropic/claude-opus-5',
      // C0/C6c — the message goes here and NOWHERE else.
      '--prompt',
      'TASK',
    ]);
  });

  it('never puts the prompt or the cwd in the positional', () => {
    // `opencode [project]` takes the PROJECT PATH as its positional. A prompt
    // passed there would become a directory name and the turn would never fire.
    const { spawn } = wire({ initialPrompt: 'do the thing' });
    const promptIdx = spawn!.args.indexOf('--prompt');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(spawn!.args[promptIdx + 1]).toBe('do the thing');
    // Nothing after the --prompt value: no trailing positional at all.
    expect(spawn!.args).toHaveLength(promptIdx + 2);
    expect(spawn!.args).not.toContain(cwd);
  });

  it('prefixes the resume notice onto the --prompt text only', () => {
    const { spawn } = wire({ resumeNotice: 'NOTICE' });
    expect(spawn!.args[spawn!.args.indexOf('--prompt') + 1]).toBe('NOTICE\n\nTASK');
    // The durable role is NOT in argv — it is a file in instructions[].
    expect(spawn!.args.join(' ')).not.toContain('ROLE PREAMBLE');
  });

  it('uses the resume notice alone, and omits --prompt when there is nothing to say', () => {
    const notice = wire({ initialPrompt: null, resumeNotice: 'NOTICE' });
    expect(notice.spawn!.args[notice.spawn!.args.indexOf('--prompt') + 1]).toBe('NOTICE');
    const silent = wire({ sessionId: 'sess-2', initialPrompt: null, resumeNotice: null });
    expect(silent.spawn!.args).not.toContain('--prompt');
    expect(silent.spawn!.args[silent.spawn!.args.length - 1]).toBe(
      'openrouter/anthropic/claude-opus-5',
    );
  });

  it('accepts an already-qualified model id without doubling the prefix', () => {
    const { spawn } = wire({ model: 'openrouter/openai/gpt-5.5' });
    expect(spawn!.args[spawn!.args.indexOf('--model') + 1]).toBe('openrouter/openai/gpt-5.5');
    expect(configOf(spawn!).model).toBe('openrouter/openai/gpt-5.5');
  });
});

describe('opencode adapter — buildSpawn env', () => {
  it('exports the inline config, the four XDG roots and the control-plane auth', () => {
    const { spawn } = wire();
    const dir = sessionDirOf();
    const { OPENCODE_CONFIG_CONTENT, ...rest } = envOf(spawn!);
    expect(rest).toEqual({
      XDG_CONFIG_HOME: path.join(dir, 'config'),
      XDG_DATA_HOME: path.join(dir, 'data'),
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      XDG_STATE_HOME: path.join(dir, 'state'),
      // Never let an agent rewrite its own binary mid-session.
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // C8 — the --port API can drive the agent and read its transcript; it is
      // unauthenticated without these two.
      OPENCODE_SERVER_USERNAME: 'swarm',
      OPENCODE_SERVER_PASSWORD: PINNED_PASSWORD,
      // C5 — no key, no `openrouter` provider at all.
      [OPENCODE_API_KEY_ENV]: KEY,
      TERM: 'xterm-256color',
    });
    // The inline config is what replaces OPENCODE_CONFIG=<file>, whose missing
    // path opencode ignores silently (C1).
    expect(OPENCODE_CONFIG_CONTENT).toBeTypeOf('string');
    expect(OPENCODE_CONFIG_CONTENT).not.toContain('\n');
    expect(rest.OPENCODE_CONFIG).toBeUndefined();
  });

  it('puts the ENTIRE env in secretEnv and leaves `env` empty', () => {
    // Lot 9a. `env` is the bucket that becomes the remote command line under SSH
    // (`agent-process.ts` emits `env K=V … exec …`), world-readable through `ps`.
    // Three of this adapter's values are secrets — the OpenRouter key, the inline
    // config (it embeds the per-session MCP url, whose path IS the session's
    // credential) and the control-plane password — and splitting the env to save
    // four harmless tokens would leave a seam for the next value to land on the
    // wrong side.
    const { spawn } = wire();
    expect(spawn!.env).toEqual({});
    expect(Object.keys(spawn!.secretEnv ?? {}).sort()).toEqual([
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_DISABLE_AUTOUPDATE',
      OPENCODE_API_KEY_ENV,
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME',
      'TERM',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ].sort());
  });

  it('freezes the whole config JSON handed to the CLI', () => {
    const { spawn } = wire();
    const dir = sessionDirOf();
    expect(configOf(spawn!)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      model: 'openrouter/anthropic/claude-opus-5',
      instructions: [path.join(dir, OPENCODE_ROLE_FILE)],
      permission: 'allow',
      mcp: {
        team: {
          type: 'remote',
          url: 'http://127.0.0.1:8788/mcp/orch-1/secret-abc',
          enabled: true,
          timeout: 8000,
        },
      },
    });
  });
});

describe('opencode adapter — the OpenRouter key', () => {
  it('rides secretEnv and is PROVABLY absent from env and argv', () => {
    const { spawn } = wire();
    expect(spawn!.secretEnv?.[OPENCODE_API_KEY_ENV]).toBe(KEY);
    // Under SSH, `env` becomes the remote command line (`agent-process.ts`),
    // world-readable through `ps` on the host. The key must never be there — and
    // as of Lot 9a nothing else is either: `env` is empty.
    expect(Object.keys(spawn!.env)).not.toContain(OPENCODE_API_KEY_ENV);
    expect(JSON.stringify(spawn!.env)).not.toContain(KEY);
    expect(spawn!.args.join(' ')).not.toContain(KEY);
    expect(spawn!.command).not.toContain(KEY);
  });

  it('reads the key through the single seam Lot 6b will replace', () => {
    // Lot 6b swaps `resolveApiKey`'s BODY for an instance_settings read. This
    // test is what proves the seam is the only door.
    class SettingsBacked extends PinnedOpencodeProvider {
      protected override resolveApiKey(): string | null {
        return 'from-instance-settings';
      }
    }
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const { spawn } = wire({ provider: new SettingsBacked() });
    expect(spawn!.secretEnv?.[OPENCODE_API_KEY_ENV]).toBe('from-instance-settings');
  });

  it('refuses to spawn with no key rather than booting a provider-less TUI', () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '   ');
    expect(() => wire()).toThrow(/OpenRouter API key/);
    expect(() => wire({ sessionId: 'sess-3' })).toThrow(new RegExp(SWARM_OPENROUTER_KEY_ENV));
  });

  it('refuses to spawn with no per-session config dir', () => {
    // No config dir means no XDG isolation, no MCP and no role: the agent would
    // share the operator’s own ~/.config/opencode and look perfectly healthy.
    const p = new PinnedOpencodeProvider();
    expect(() =>
      p.buildSpawn({
        model: 'anthropic/claude-opus-5',
        effort: 'high',
        permissionMode: 'bypassPermissions',
        initialPrompt: 'TASK',
        preamble: 'ROLE',
        resumeNotice: null,
        cwd,
        configDir: null,
        mcpConfigPath: null,
        paths: IDENTITY_PATH_MAPPER,
      }),
    ).toThrow(/per-session config dir/);
  });

  it('refuses to spawn when phase A never ran for that config dir', () => {
    const p = new PinnedOpencodeProvider();
    expect(() =>
      p.buildSpawn({
        model: 'anthropic/claude-opus-5',
        effort: 'high',
        permissionMode: 'bypassPermissions',
        initialPrompt: 'TASK',
        preamble: 'ROLE',
        resumeNotice: null,
        cwd,
        configDir: '/data/never-prepared',
        mcpConfigPath: null,
        paths: IDENTITY_PATH_MAPPER,
      }),
    ).toThrow(/prepareSessionConfig must run before buildSpawn/);
  });
});

// ---------------------------------------------------------------------------
// 5b. Lot 6b — the key comes from `instance_settings`, live
// ---------------------------------------------------------------------------

/** Mutable stand-in for `SettingsStore` — the seam is one synchronous getter. */
class FakeKeySource {
  constructor(public key: string | null) {}
  getOpenRouterApiKey(): string | null {
    return this.key;
  }
}

describe('opencode adapter — the stored key (Lot 6b)', () => {
  it('prefers the stored setting over the env var', () => {
    // Order matters: a deployment that once exported the env var must not make
    // the masked field in Settings silently ineffective.
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, 'from-env');
    const p = new PinnedOpencodeProvider(undefined, new FakeKeySource('from-settings'));
    const { spawn } = wire({ provider: p });
    expect(spawn!.secretEnv?.[OPENCODE_API_KEY_ENV]).toBe('from-settings');
  });

  it('falls back to the env var when nothing is stored (dev + CI)', () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, 'from-env');
    const p = new PinnedOpencodeProvider(undefined, new FakeKeySource(null));
    const { spawn } = wire({ provider: p });
    expect(spawn!.secretEnv?.[OPENCODE_API_KEY_ENV]).toBe('from-env');
  });

  it('falls back to the env var when no source was bound at all', () => {
    // `useKeySource` is called at boot, after the registry is built: a provider
    // used before that (or in a unit test) must still work off the env.
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, 'from-env');
    const { spawn } = wire({ provider: new PinnedOpencodeProvider() });
    expect(spawn!.secretEnv?.[OPENCODE_API_KEY_ENV]).toBe('from-env');
  });

  it('treats a stored blank as "no key" and keeps looking', () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const p = new PinnedOpencodeProvider(undefined, new FakeKeySource('   '));
    expect(() => wire({ provider: p })).toThrow(/OpenRouter API key/);
  });

  it('re-reads on EVERY spawn — a rotation reaches the next agent, no restart', () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const source = new FakeKeySource('key-v1');
    const p = new PinnedOpencodeProvider(undefined, source);
    expect(wire({ provider: p, sessionId: 'rot-1' }).spawn!.secretEnv?.[OPENCODE_API_KEY_ENV])
      .toBe('key-v1');
    source.key = 'key-v2';
    // Caching the key in a field would hand the stale one to this session, and
    // nothing would say so — the agent would just fail to authenticate.
    expect(wire({ provider: p, sessionId: 'rot-2' }).spawn!.secretEnv?.[OPENCODE_API_KEY_ENV])
      .toBe('key-v2');
  });

  it('accepts SettingsStore structurally, and never exposes the key through it', async () => {
    // The real store over a real SQLite file: this is what proves the seam and
    // the settings module actually fit, and that the masked read is the one a
    // route would serve.
    const { SwarmDb } = await import('../db/index.js');
    const { SettingsStore, PASSWORD_SENTINEL } = await import('../settings/index.js');
    const dbDir = path.join(tmpRoot, 'settings-db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new SwarmDb(dbDir);
    try {
      const store = new SettingsStore(db);
      store.update({ openrouterApiKey: 'sk-or-v1-STORED' });
      expect(store.get().openrouterApiKey).toBe(PASSWORD_SENTINEL);

      vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
      const p = new PinnedOpencodeProvider();
      p.useKeySource(store);
      const { spawn } = wire({ provider: p, sessionId: 'store-1' });
      expect(spawn!.secretEnv?.[OPENCODE_API_KEY_ENV]).toBe('sk-or-v1-STORED');
      // …and the masked value never reaches the agent.
      expect(JSON.stringify(spawn!.secretEnv)).not.toContain(PASSWORD_SENTINEL);
    } finally {
      db.close();
    }
  });

  it('turns a throwing source into a spawn failure, not an unhandled error', () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const p = new PinnedOpencodeProvider(undefined, {
      getOpenRouterApiKey: () => {
        throw new Error('database is locked');
      },
    });
    expect(() => wire({ provider: p })).toThrow(/database is locked/);
  });

  it('probe() changes its mind when a key is saved — no restart, no boot freeze', async () => {
    // The 24/7 requirement in one assertion: the same provider instance that
    // reported "installed but no key" must report available once the row is
    // written. The availability cache upstream has a 60 s TTL; this proves the
    // ADAPTER is not the thing holding a stale verdict.
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const source = new FakeKeySource(null);
    const p = new OpencodeProvider(undefined, source);
    const ctx = () => ({ transport: 'local', config: {} as never, timeoutMs: 1_000 }) as never;

    const before = await p.probe(ctx());
    expect(before.available).toBe(false);
    expect(before.reason).toContain('no OpenRouter API key is configured');

    source.key = 'sk-or-v1-JUST-PASTED';
    const after = await p.probe(ctx());
    expect(after).toEqual({ available: true, version: 'opencode 1.18.5' });
  });

  it('probe() never leaks the key into its reason or version', async () => {
    const source = new FakeKeySource('sk-or-v1-SECRET-VALUE');
    const p = new OpencodeProvider(undefined, source);
    const res = await p.probe(
      { transport: 'local', config: {} as never, timeoutMs: 1_000 } as never,
    );
    expect(JSON.stringify(res)).not.toContain('sk-or-v1-SECRET-VALUE');
  });
});

// ---------------------------------------------------------------------------
// 6. The two-roots rule
// ---------------------------------------------------------------------------

describe('opencode adapter — data root vs workspace root', () => {
  it('translates every path it emits through paths.data, never paths.workspace', () => {
    const mapper = sshMapper();
    const { spawn } = wire({ transport: 'ssh', paths: mapper });
    const hostDir = `${HOST_DATA_DIR}/.claude-runtime/${OPENCODE_SESSION_SUBDIR}/sess-1`;
    const env = envOf(spawn!);
    expect(env.XDG_CONFIG_HOME).toBe(`${hostDir}/config`);
    expect(env.XDG_DATA_HOME).toBe(`${hostDir}/data`);
    expect(env.XDG_CACHE_HOME).toBe(`${hostDir}/cache`);
    expect(env.XDG_STATE_HOME).toBe(`${hostDir}/state`);
    expect(configOf(spawn!).instructions).toEqual([`${hostDir}/${OPENCODE_ROLE_FILE}`]);

    // INVERSION GUARD. Everything this adapter emits is something the SERVER
    // wrote under dataDir, so it all goes through `paths.data`. Swap the two and
    // `toHostPath` returns these paths UNCHANGED (a non-matching prefix passes
    // through — that is exactly why the mistake is silent), so the container
    // path would leak into the agent's environment and the assertions below
    // fail. The agent's cwd is the only workspace-rooted path, and `Session`
    // owns it — this adapter must never call `paths.workspace` at all.
    const emitted = [...Object.values(env), ...spawn!.args].join('\n');
    expect(emitted).not.toContain(runtimeRoot);
    expect(emitted).not.toContain(dataDir);
    expect(emitted).not.toContain(HOST_WORKSPACE_ROOT);
    expect(mapper.workspaceCalls).toEqual([]);
    expect(mapper.dataCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Control plane
// ---------------------------------------------------------------------------

describe('opencode adapter — control plane (Lot 6c consumer)', () => {
  it('exposes the port and credentials of the running TUI api', () => {
    const { provider, prepared, spawn } = wire();
    const plane = provider.controlPlane(prepared.configDir);
    expect(plane).toEqual({
      port: OPENCODE_CONTROL_PORT_BASE,
      hostname: '127.0.0.1',
      username: 'swarm',
      password: PINNED_PASSWORD,
      baseUrl: `http://127.0.0.1:${OPENCODE_CONTROL_PORT_BASE}`,
    });
    // What is exposed must be what the process was actually started with, or
    // the /event consumer authenticates against the wrong session.
    expect(spawn!.args[spawn!.args.indexOf('--port') + 1]).toBe(String(plane!.port));
    expect(envOf(spawn!).OPENCODE_SERVER_PASSWORD).toBe(plane!.password);
    expect(provider.controlPlane(null)).toBeNull();
    expect(provider.controlPlane('/nope')).toBeNull();
  });

  it('hands out a distinct port and a fresh CSPRNG password per session', () => {
    const provider = new OpencodeProvider();
    const planes = ['s1', 's2', 's3'].map((id) => {
      const { prepared } = wire({ provider, sessionId: id, buildSpawn: false });
      return provider.controlPlane(prepared.configDir)!;
    });
    expect(planes.map((p) => p.port)).toEqual([
      OPENCODE_CONTROL_PORT_BASE,
      OPENCODE_CONTROL_PORT_BASE + 1,
      OPENCODE_CONTROL_PORT_BASE + 2,
    ]);
    expect(new Set(planes.map((p) => p.password)).size).toBe(3);
    for (const p of planes) expect(p.password).toMatch(/^[0-9a-f]{32}$/);
    // Loopback only: the API can drive the agent.
    for (const p of planes) expect(p.hostname).toBe('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// 8. Context reset
// ---------------------------------------------------------------------------

describe('opencode adapter — contextResetLine', () => {
  it('maps /clear and /compact to the bare slash commands', () => {
    const p = new OpencodeProvider();
    // C3 verified in a live PTY: /clear wipes the history and the role survives.
    expect(p.contextResetLine('/clear')).toBe('/clear');
    expect(p.contextResetLine('/compact')).toBe('/compact');
  });

  it('drops free-text instructions instead of risking a no-op reset', () => {
    // Whether opencode's slash commands accept an argument is UNVERIFIED; a
    // command that fails to match would leave the palette open and the
    // compaction would never run.
    const p = new OpencodeProvider();
    expect(p.contextResetLine('/compact', 'focus on the mailbox')).toBe('/compact');
  });
});

// ---------------------------------------------------------------------------
// 9. probe()
// ---------------------------------------------------------------------------

describe('opencode adapter — probe', () => {
  const ctx = () =>
    ({ transport: 'local', config: {} as never, timeoutMs: 1_000 }) as never;

  it('reports the missing binary first, with the reason from the CLI probe', async () => {
    probeState.value = {
      available: false,
      reason: '`opencode` is not on PATH in this container',
    };
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const res = await new OpencodeProvider().probe(ctx());
    expect(res.available).toBe(false);
    expect(res.reason).toContain('not on PATH');
    // The binary is the bigger prerequisite: don't send an operator hunting for
    // a key for a CLI that is not installed.
    expect(res.reason).not.toContain('API key');
    expect(res.version).toBeUndefined();
  });

  it('reports "installed but no key" as a distinct, actionable reason', async () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const res = await new OpencodeProvider().probe(ctx());
    expect(res.available).toBe(false);
    expect(res.reason).toContain('no OpenRouter API key is configured');
    expect(res.reason).toContain(SWARM_OPENROUTER_KEY_ENV);
    // Installed-but-useless still reports its version, so the operator can see
    // the CLI is really there.
    expect(res.version).toBe('opencode 1.18.5');
  });

  it('is available when both the binary and the key are there', async () => {
    const res = await new OpencodeProvider().probe(ctx());
    expect(res).toEqual({ available: true, version: 'opencode 1.18.5' });
    expect(probeState.calls[0]).toMatchObject({ binary: 'opencode', transport: 'local' });
  });

  it('gives the two failures genuinely different reasons', async () => {
    vi.stubEnv(SWARM_OPENROUTER_KEY_ENV, '');
    const noKey = await new OpencodeProvider().probe(ctx());
    probeState.value = { available: false, reason: '`opencode` is not on PATH in this container' };
    const noBin = await new OpencodeProvider().probe(ctx());
    expect(noKey.reason).not.toBe(noBin.reason);
  });

  it('never throws — a key lookup that blows up becomes a reason', async () => {
    // Lot 6b's resolveApiKey reads SQLite. A DB error must not reject inside
    // the availability cache.
    class Broken extends OpencodeProvider {
      protected override resolveApiKey(): string | null {
        throw new Error('database is locked');
      }
    }
    const res = await new Broken().probe(ctx());
    expect(res.available).toBe(false);
    expect(res.reason).toContain('database is locked');
    expect(res.version).toBe('opencode 1.18.5');
  });
});

// ---------------------------------------------------------------------------
// 10. Runtime materialisation
// ---------------------------------------------------------------------------

describe('opencode adapter — runtime init', () => {
  it('is a no-op: there is no host credential to lift (C5)', () => {
    const p = new OpencodeProvider();
    expect(p.initRuntime({ sourceDir: '/x', runtimeDir: '/y' })).toEqual({
      initialized: false,
      copied: false,
      skipReason: 'not-applicable',
    });
    expect(() => p.refreshSharedFiles({ sourceDir: '/x', runtimeDir: '/y' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. End to end through a real Session
// ---------------------------------------------------------------------------

function sshBundle(): SessionSshTransport {
  return {
    sshTarget: 'ubuntu@host.docker.internal',
    sshKey: '/keys/id_ed25519',
    sshPort: 2222,
    dataDir,
    hostDataDir: HOST_DATA_DIR,
    hostClaudeDir: '/host/home/.claude',
    workspaceRoot,
    hostWorkspaceRoot: HOST_WORKSPACE_ROOT,
  };
}

const openSessions: Session[] = [];

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
});

function makeSession(opts: {
  provider: OpencodeProvider;
  id?: string;
  ssh?: boolean;
  agentProcessOverride?: FakeAgentProcess;
}): Session {
  const s = new Session({
    id: opts.id ?? 'sess-live',
    orchestratorId: 'orch-1111',
    name: 'golden',
    role: 'tester',
    type: 'worker',
    cwd,
    initialPrompt: 'TASK',
    preamble: 'ROLE PREAMBLE',
    model: 'anthropic/claude-opus-5',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 8788,
    provider: opts.provider,
    runtimeRoot,
    hookToken: 'hook-token-xyz',
    mainHttpPort: 8787,
    agentProcessOverride: opts.agentProcessOverride,
    sshTransport: opts.ssh ? sshBundle() : null,
  });
  openSessions.push(s);
  return s;
}

describe('opencode adapter — driven by a real Session', () => {
  it('hands SshAgentProcess host-side paths and keeps the key off the command line', () => {
    const provider = new PinnedOpencodeProvider();
    const s = makeSession({ provider, ssh: true });
    expect(captured.pty).toHaveLength(0);
    expect(captured.ssh).toHaveLength(1);
    const o = captured.ssh[0]!;
    expect(o.remoteCommand).toBe('opencode');
    // The cwd is the ONE workspace-rooted path, and Session maps it, not us.
    expect(o.remoteCwd).toBe(`${HOST_WORKSPACE_ROOT}/proj`);
    // NOTHING on the remote command line: this adapter routes its whole env
    // through `secretEnv`, and `Session` turns that into a sourced 0600 file.
    expect(o.remoteEnv).toEqual({});
    const envFile = o.remoteEnvFile as string;
    // The path handed to the remote shell is a HOST path (the file lives in the
    // per-session config dir, under the dataDir bind mount). A container path
    // here would make the remote `. <file>` fail and take the spawn with it.
    expect(envFile).toBe(
      `${HOST_DATA_DIR}/.claude-runtime/${OPENCODE_SESSION_SUBDIR}/sess-live/.swarm-agent-env`,
    );
    // …and the secrets are IN that file, 0600, with nothing on the argv.
    const containerFile = path.join(
      runtimeRoot,
      OPENCODE_SESSION_SUBDIR,
      'sess-live',
      '.swarm-agent-env',
    );
    expect(fs.statSync(containerFile).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(containerFile, 'utf8');
    expect(body).toContain(
      `XDG_DATA_HOME='${HOST_DATA_DIR}/.claude-runtime/${OPENCODE_SESSION_SUBDIR}/sess-live/data'`,
    );
    expect(body).toContain(`OPENCODE_SERVER_PASSWORD='${PINNED_PASSWORD}'`);
    expect(body).toContain(`${OPENCODE_API_KEY_ENV}='${KEY}'`);
    // THE assertion of this test: the key (and everything else) is absent from
    // every field `SshAgentProcess` puts on the remote command line, which `ps`
    // exposes to every user on the host.
    expect(JSON.stringify(o)).not.toContain(KEY);
    expect(JSON.stringify(o)).not.toContain(PINNED_PASSWORD);
    // Provider state is reachable from the session's config dir.
    expect(provider.controlPlane(s.claudeConfigDir)?.port).toBe(OPENCODE_CONTROL_PORT_BASE);
    expect(s.claudeConfigDir).toBe(
      path.join(runtimeRoot, OPENCODE_SESSION_SUBDIR, 'sess-live'),
    );
  });

  it('prepares the config dir before the spawn and logs no phantom mcp.json', async () => {
    const provider = new PinnedOpencodeProvider();
    const s = makeSession({ provider });
    const dir = s.claudeConfigDir!;
    expect(fs.existsSync(path.join(dir, OPENCODE_ROLE_FILE))).toBe(true);
    expect(captured.pty).toHaveLength(1);
    expect(captured.pty[0]!.cwd).toBe(cwd);
    await new Promise((r) => setTimeout(r, 50));
    // writeMcpConfig returned null (inline config), so Session must NOT claim a
    // file was written — that line would send an operator looking for a path
    // that does not exist.
    expect(fs.readFileSync(s.logPath, 'utf8')).not.toContain('mcp.json written at');
  });

  it('removes the whole per-session tree when the agent exits', async () => {
    const provider = new PinnedOpencodeProvider();
    const fake = new FakeAgentProcess({ command: 'opencode', args: [], cwd });
    const s = makeSession({ provider, id: 'sess-dies', agentProcessOverride: fake });
    const dir = s.claudeConfigDir!;
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(true);
    fake._simulateExit({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 50));
    // The SQLite db + logs a live opencode grows must not survive its session.
    expect(fs.existsSync(dir)).toBe(false);
  });
});
