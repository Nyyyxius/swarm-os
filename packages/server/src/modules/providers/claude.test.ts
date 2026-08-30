import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * GOLDEN TEST — the refactor's safety net (plan Lot 1, "garde-fou du refactor").
 *
 * Written against the PRE-refactor `Session` and frozen there on purpose: it
 * asserts the exact bytes the claude adapter is responsible for, through the
 * only seams a real spawn crosses.
 *
 *   1. argv + env + cwd handed to `PtyAgentProcess` (local transport)
 *   2. argv + remoteEnv + remoteCwd handed to `SshAgentProcess` (host paths)
 *   3. the literal body of the per-session `settings.json` (Notification hook
 *      command included, character for character)
 *   4. the per-session `.claude.json` trust seed — a REGULAR file, never a
 *      symlink (a writeFileSync through a symlink corrupts the shared copy)
 *   5. the shared-state symlink farm: 17 entries, existence-checked locally,
 *      unconditional and host-rooted under SSH
 *   6. phase ordering: the mcp.json is written (and logged into the ALREADY
 *      OPEN session log) before the `skipSpawn` early return
 *
 * If any of these move, the extraction drifted — fix the extraction, not the
 * expectation.
 *
 * The agent-process module is mocked so we capture the constructor options
 * instead of forking a real PTY / ssh.
 */

const captured = vi.hoisted(() => ({
  pty: [] as Array<Record<string, unknown>>,
  ssh: [] as Array<Record<string, unknown>>,
}));

vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../orchestrator/agent-process.js')>();
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
  return {
    ...actual,
    PtyAgentProcess: MockPtyAgentProcess,
    SshAgentProcess: MockSshAgentProcess,
  };
});

import { Session, buildClaudeArgs, type SessionSshTransport } from '../orchestrator/session.js';
import { CLAUDE_PROVIDER } from './claude.js';
import { buildResumeNotice } from '../orchestrator/log-tail-reader.js';

/**
 * The 17 entries symlinked from the shared runtime root into every per-session
 * config dir. Frozen here (not imported) so a silent edit of the production
 * list fails this test instead of agreeing with itself.
 */
const SHARED_ENTRIES = [
  '.credentials.json',
  '.last-cleanup',
  'backups',
  'cache',
  'debug',
  'file-history',
  'history.jsonl',
  'mcp-needs-auth-cache.json',
  'paste-cache',
  'plans',
  'plugins',
  'projects',
  'session-env',
  'shell-snapshots',
  'tasks',
  'telemetry',
  'todos',
];

/**
 * Literal copy of the hook commands. Duplicated on purpose: these strings are
 * executed by claude-code inside the agent's shell, so an accidental quoting
 * change during a refactor must fail loudly here.
 *
 * The `session.transcript` variant differs by exactly two clauses, and both are
 * measured (spike `scripts/verify-claude-sessionstart.report.md`): `-o /dev/null`
 * because a `SessionStart` hook's STDOUT IS INJECTED into the agent's context
 * (S3), and `-m 5` because that hook runs synchronously while the CLI boots.
 */
function expectedHookCommand(opts: {
  orchestratorId: string;
  sessionId: string;
  hookToken: string;
  mainHttpPort: number;
  kind?: 'session.waiting' | 'session.transcript';
}): string {
  const hookUrl = `http://127.0.0.1:${opts.mainHttpPort}/hooks/notification`;
  const kind = opts.kind ?? 'session.waiting';
  const curlFlags = kind === 'session.transcript' ? '-sS -m 5 -o /dev/null' : '-s';
  return (
    `payload=$(cat); ` +
    `msg=$(printf '%s' "$payload" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || ` +
    `msg=$(printf '"%s"' "$(printf '%s' "$payload" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\n/\\\\n/g')"); ` +
    `body=$(printf '{"orch_id":"%s","session_id":"%s","kind":"${kind}","message":%s}' '${opts.orchestratorId}' '${opts.sessionId}' "$msg"); ` +
    `curl ${curlFlags} -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${opts.hookToken}' -d "$body" '${hookUrl}' >/dev/null 2>&1 || true`
  );
}

let tmpRoot: string;
let dataDir: string;
let logsDir: string;
let mcpRuntimeDir: string;
let claudeRuntimeDir: string;
let workspaceRoot: string;
let cwd: string;
const openSessions: Session[] = [];

const HOST_DATA_DIR = '/host/data';
const HOST_WORKSPACE_ROOT = '/host/workspace';
const HOST_CLAUDE_DIR = '/host/home/.claude';

function sshBundle(): SessionSshTransport {
  return {
    sshTarget: 'ubuntu@host.docker.internal',
    sshKey: '/keys/id_ed25519',
    sshPort: 2222,
    dataDir,
    hostDataDir: HOST_DATA_DIR,
    hostClaudeDir: HOST_CLAUDE_DIR,
    workspaceRoot,
    hostWorkspaceRoot: HOST_WORKSPACE_ROOT,
  };
}

beforeEach(() => {
  captured.pty.length = 0;
  captured.ssh.length = 0;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-provider-claude-'));
  dataDir = path.join(tmpRoot, 'data');
  logsDir = path.join(dataDir, 'logs');
  mcpRuntimeDir = path.join(dataDir, 'mcp-runtime');
  claudeRuntimeDir = path.join(dataDir, '.claude-runtime');
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
  mcpPort?: number;
  claudeSourceDir?: string;
  claudeJsonSource?: string | null;
  hooks?: boolean;
}

function makeSession(opts: MakeOpts = {}): Session {
  const s = new Session({
    id: opts.id ?? 'sess-0000',
    orchestratorId: 'orch-1111',
    name: 'golden',
    role: 'tester',
    type: 'worker',
    cwd,
    initialPrompt: opts.initialPrompt ?? 'TASK',
    preamble: opts.preamble ?? 'ROLE PREAMBLE',
    resumeNotice: opts.resumeNotice ?? null,
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: opts.mcpPort ?? 8788,
    skipSpawn: opts.skipSpawn,
    hookToken: opts.hooks === false ? undefined : 'hook-token-xyz',
    mainHttpPort: opts.hooks === false ? undefined : 8787,
    runtimeRoot: claudeRuntimeDir,
    sourceDir: opts.claudeSourceDir,
    siblingSource: opts.claudeJsonSource,
    sshTransport: opts.ssh ? sshBundle() : null,
  });
  openSessions.push(s);
  return s;
}

// ---------------------------------------------------------------------------
// 1. buildClaudeArgs — the pure argv contract
// ---------------------------------------------------------------------------

describe('claude adapter — argv (buildClaudeArgs)', () => {
  it('emits the exact flag order with the mandatory `--mcp-config=<path>` form', () => {
    const args = buildClaudeArgs({
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      preamble: 'ROLE PREAMBLE',
      initialPrompt: 'TASK',
      mcpConfigPath: '/tmp/x/mcp.json',
    });
    expect(args).toEqual([
      '--model',
      'claude-opus-4-8',
      '--effort',
      'high',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      'ROLE PREAMBLE',
      '--mcp-config=/tmp/x/mcp.json',
      '--strict-mcp-config',
      '--',
      'TASK',
    ]);
    // `--mcp-config` is variadic in claude 2.1.x: the two-token form would
    // swallow the positional prompt as a second config file (ENAMETOOLONG).
    expect(args).not.toContain('--mcp-config');
  });

  it('omits the mcp flags entirely when no config path is available', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'low',
      permissionMode: 'default',
      preamble: null,
      initialPrompt: null,
      mcpConfigPath: null,
    });
    expect(args).toEqual(['--model', 'm', '--effort', 'low', '--permission-mode', 'default']);
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('prefixes the resume notice onto the positional prompt only', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'low',
      permissionMode: 'default',
      preamble: 'ROLE',
      initialPrompt: 'TASK',
      resumeNotice: 'NOTICE',
    });
    expect(args[args.length - 1]).toBe('NOTICE\n\nTASK');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('ROLE');
  });

  it('guards the positional with `--` so a REAL resume notice survives argv parsing', () => {
    // Regression, measured 2026-07-26: `buildResumeNotice` starts its body with
    // a literal `---`, and without the separator commander rejects it outright
    //   error: unknown option '---\n## Server restart notice…'   (exit 1)
    // so every resumed session died before reaching the model. This is the
    // "resumed leads exit 1 while a fresh start survives" symptom — a fresh
    // start has no notice. Built from the real producer, not a hand-written
    // fixture, precisely because the hand-written one dropped the leading `---`
    // and was blind to this.
    const notice = buildResumeNotice(null);
    expect(notice.startsWith('---')).toBe(true);

    const args = buildClaudeArgs({
      model: 'm',
      effort: 'low',
      permissionMode: 'default',
      preamble: null,
      initialPrompt: 'TASK',
      resumeNotice: notice,
    });
    // The separator must be the LAST option token, immediately before the text.
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe(`${notice}\n\nTASK`);
    // And nothing dash-leading may sit outside the guard.
    const guard = args.indexOf('--');
    expect(args.slice(guard + 1).length).toBe(1);
  });

  it('uses the resume notice alone when there is no initial prompt', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'low',
      permissionMode: 'default',
      preamble: null,
      initialPrompt: null,
      resumeNotice: 'NOTICE',
    });
    expect(args[args.length - 1]).toBe('NOTICE');
  });
});

// ---------------------------------------------------------------------------
// 2. spawn — local transport
// ---------------------------------------------------------------------------

describe('claude adapter — spawn (local transport)', () => {
  it('hands PtyAgentProcess the exact command / args / cwd / env', () => {
    const s = makeSession();
    expect(captured.ssh).toHaveLength(0);
    expect(captured.pty).toHaveLength(1);
    const opts = captured.pty[0]!;
    const mcpPath = path.join(
      mcpRuntimeDir,
      'orch-orch-1111',
      'session-sess-0000',
      'mcp.json',
    );
    expect(opts.command).toBe('claude');
    expect(opts.cwd).toBe(cwd);
    expect(opts.args).toEqual([
      '--model',
      'claude-opus-4-8',
      '--effort',
      'high',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      'ROLE PREAMBLE',
      `--mcp-config=${mcpPath}`,
      '--strict-mcp-config',
      '--',
      'TASK',
    ]);
    // Exactly two env vars — no more, no less. ENABLE_TOOL_SEARCH='false'
    // pins the pre-2.1.2xx inline MCP tool behaviour (small models fail the
    // ToolSearch→call dance and lose team-comms without it).
    expect(opts.env).toEqual({
      CLAUDE_CONFIG_DIR: s.claudeConfigDir,
      ENABLE_TOOL_SEARCH: 'false',
    });
    expect(s.claudeConfigDir).toBe(path.join(claudeRuntimeDir, 'sessions', 'sess-0000'));
  });

  it('still exports ENABLE_TOOL_SEARCH when no per-session config dir exists', () => {
    makeSession({ hooks: false });
    const opts = captured.pty[0]!;
    expect(opts.env).toEqual({ ENABLE_TOOL_SEARCH: 'false' });
  });
});

// ---------------------------------------------------------------------------
// 3. spawn — SSH transport (translated paths)
// ---------------------------------------------------------------------------

describe('claude adapter — spawn (ssh transport)', () => {
  it('translates every container path into a host path before handing it off', () => {
    makeSession({ ssh: true });
    expect(captured.pty).toHaveLength(0);
    expect(captured.ssh).toHaveLength(1);
    const opts = captured.ssh[0]!;
    expect(opts.remoteCommand).toBe('claude');
    expect(opts.sshTarget).toBe('ubuntu@host.docker.internal');
    expect(opts.sshKey).toBe('/keys/id_ed25519');
    expect(opts.sshPort).toBe(2222);
    // cwd is translated through workspaceRoot → hostWorkspaceRoot…
    expect(opts.remoteCwd).toBe(`${HOST_WORKSPACE_ROOT}/proj`);
    // …while CLAUDE_CONFIG_DIR and --mcp-config go through dataDir → hostDataDir.
    expect(opts.remoteEnv).toEqual({
      CLAUDE_CONFIG_DIR: `${HOST_DATA_DIR}/.claude-runtime/sessions/sess-0000`,
      ENABLE_TOOL_SEARCH: 'false',
    });
    expect(opts.args).toEqual([
      '--model',
      'claude-opus-4-8',
      '--effort',
      'high',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      'ROLE PREAMBLE',
      `--mcp-config=${HOST_DATA_DIR}/mcp-runtime/orch-orch-1111/session-sess-0000/mcp.json`,
      '--strict-mcp-config',
      '--',
      'TASK',
    ]);
    // The container MCP listens on loopback only — the reverse tunnel is what
    // makes the host's 127.0.0.1:<port> reach back in.
    expect(opts.reverseTunnelPort).toBe(8788);
  });

  it('skips the reverse tunnel when mcp is not wired (port 0)', () => {
    makeSession({ ssh: true, mcpPort: 0 });
    expect(captured.ssh[0]!.reverseTunnelPort).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. prepareSessionConfig — settings.json literal
// ---------------------------------------------------------------------------

describe('claude adapter — per-session settings.json', () => {
  it('writes the exact literal body, hook command included', () => {
    const s = makeSession({ skipSpawn: true });
    const cfgDir = s.claudeConfigDir!;
    const body = JSON.parse(
      fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(body).toEqual({
      // Survives the claude 2.1.143 migration of the legacy
      // `.claude.json#bypassPermissionsModeAccepted` flag.
      skipDangerousModePermissionPrompt: true,
      // Pins the classic inline renderer — the fullscreen one repaints
      // constantly and kills idle detection.
      tui: 'default',
      hooks: {
        Notification: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: expectedHookCommand({
                  orchestratorId: 'orch-1111',
                  sessionId: 'sess-0000',
                  hookToken: 'hook-token-xyz',
                  mainHttpPort: 8787,
                }),
              },
            ],
          },
        ],
        // Monitoring (docs/monitoring-agents.md, Lot 2) — the transcript
        // announcer. Empty matcher = every source: startup, clear, compact,
        // and the resume/fork ones the spike did not exercise.
        SessionStart: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: expectedHookCommand({
                  orchestratorId: 'orch-1111',
                  sessionId: 'sess-0000',
                  hookToken: 'hook-token-xyz',
                  mainHttpPort: 8787,
                  kind: 'session.transcript',
                }),
              },
            ],
          },
        ],
      },
    });
  });

  it('keeps the SessionStart hook silent — its stdout would enter the context', () => {
    // THE fact this whole channel rests on (spike S3): claude-code appends the
    // hook's trimmed stdout to the conversation as an `attachment` /
    // `hook_success` line. A chatty curl would pollute every boot, every
    // `/clear` and every `/compact` — and inflate the very number the hook
    // exists to measure. Asserted on the shipped string, not on the builder.
    const s = makeSession({ skipSpawn: true });
    const body = JSON.parse(
      fs.readFileSync(path.join(s.claudeConfigDir!, 'settings.json'), 'utf8'),
    ) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = body.hooks.SessionStart[0]!.hooks[0]!.command;
    expect(command).toContain('-o /dev/null');
    expect(command).toContain('>/dev/null 2>&1 || true');
    // And bounded: the hook blocks the CLI's startup while it runs.
    expect(command).toContain('-m 5');
    expect(command).toContain('"kind":"session.transcript"');
  });

  it('creates the config dir 0700 and the settings file 0600', () => {
    const s = makeSession({ skipSpawn: true });
    const cfgDir = s.claudeConfigDir!;
    expect(fs.statSync(cfgDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(cfgDir, 'settings.json')).mode & 0o777).toBe(0o600);
  });

  it('returns a null config dir when hook wiring is incomplete', () => {
    const s = makeSession({ skipSpawn: true, hooks: false });
    expect(s.claudeConfigDir).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. prepareSessionConfig — .claude.json trust seed
// ---------------------------------------------------------------------------

describe('claude adapter — .claude.json trust seed', () => {
  it('writes a regular file (never a symlink) keyed on the container cwd', () => {
    const s = makeSession({ skipSpawn: true });
    const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
    const st = fs.lstatSync(seedPath);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    const json = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Record<string, unknown>;
    expect(json.bypassPermissionsModeAccepted).toBe(true);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(Object.keys(projects)).toEqual([cwd]);
    expect(projects[cwd]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      hasClaudeMdExternalIncludesApproved: true,
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
    });
  });

  it('keys the project entry on the HOST cwd under ssh (or claude re-opens the trust dialog)', () => {
    const s = makeSession({ skipSpawn: true, ssh: true });
    const json = JSON.parse(
      fs.readFileSync(path.join(s.claudeConfigDir!, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(Object.keys(projects)).toEqual([`${HOST_WORKSPACE_ROOT}/proj`]);
  });

  it('reads the runtime .claude.json locally and the source-mount one under ssh', () => {
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({ marker: 'runtime' }),
    );
    const local = makeSession({ id: 'sess-local', skipSpawn: true });
    expect(
      (
        JSON.parse(
          fs.readFileSync(path.join(local.claudeConfigDir!, '.claude.json'), 'utf8'),
        ) as Record<string, unknown>
      ).marker,
    ).toBe('runtime');

    // SSH: the container-side runtime copy is never populated. The seed comes
    // from the RO source mount (`<claudeSourceDir>.json` fallback).
    const sourceDir = path.join(tmpRoot, 'claude-source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(`${sourceDir}.json`, JSON.stringify({ marker: 'host' }));
    const ssh = makeSession({
      id: 'sess-ssh',
      skipSpawn: true,
      ssh: true,
      claudeSourceDir: sourceDir,
    });
    expect(
      (
        JSON.parse(
          fs.readFileSync(path.join(ssh.claudeConfigDir!, '.claude.json'), 'utf8'),
        ) as Record<string, unknown>
      ).marker,
    ).toBe('host');
  });
});

// ---------------------------------------------------------------------------
// 6. prepareSessionConfig — the shared-state symlink farm
// ---------------------------------------------------------------------------

describe('claude adapter — shared state symlinks', () => {
  it('links only the entries that exist in the runtime root (local transport)', () => {
    fs.writeFileSync(path.join(claudeRuntimeDir, '.credentials.json'), '{}');
    fs.mkdirSync(path.join(claudeRuntimeDir, 'projects'), { recursive: true });
    // `sessions` exists at the runtime root and must NEVER be linked — the
    // per-session config dir lives inside that very namespace.
    fs.mkdirSync(path.join(claudeRuntimeDir, 'sessions'), { recursive: true });

    const s = makeSession({ skipSpawn: true });
    const cfgDir = s.claudeConfigDir!;
    expect(fs.readlinkSync(path.join(cfgDir, '.credentials.json'))).toBe(
      path.join(claudeRuntimeDir, '.credentials.json'),
    );
    expect(fs.readlinkSync(path.join(cfgDir, 'projects'))).toBe(
      path.join(claudeRuntimeDir, 'projects'),
    );
    expect(fs.existsSync(path.join(cfgDir, 'cache'))).toBe(false);
    // Only the session dir itself, plus the two links, plus our own writes.
    expect(new Set(fs.readdirSync(cfgDir))).toEqual(
      new Set(['.credentials.json', 'projects', '.claude.json', 'settings.json']),
    );
  });

  it('links all 17 entries unconditionally to the host ~/.claude under ssh', () => {
    const s = makeSession({ skipSpawn: true, ssh: true });
    const cfgDir = s.claudeConfigDir!;
    for (const name of SHARED_ENTRIES) {
      expect(fs.readlinkSync(path.join(cfgDir, name))).toBe(
        path.join(HOST_CLAUDE_DIR, name),
      );
    }
    // `sessions` is not part of the list — and `.claude.json` stays a real file.
    expect(fs.existsSync(path.join(cfgDir, 'sessions'))).toBe(false);
    expect(fs.lstatSync(path.join(cfgDir, '.claude.json')).isSymbolicLink()).toBe(false);
    expect(new Set(fs.readdirSync(cfgDir))).toEqual(
      new Set([...SHARED_ENTRIES, '.claude.json', 'settings.json']),
    );
  });

  it('never writes a per-session file THROUGH a planted link', () => {
    // The invariant the whole config dir rests on: shared state is symlinked,
    // per-session state is a REGULAR file. `settings.json` carries the hook
    // token and `.claude.json` the trust seed; a link at either path would make
    // `writeFileSync` follow it and truncate the operator's shared file.
    //
    // The link is planted the way production produces one: the session dir
    // survives a hard container kill and auto-resume re-prepares the SAME id.
    const shared = path.join(tmpRoot, 'operator-shared.json');
    const SHARED_BODY = JSON.stringify({ operator: 'do not touch' });
    const first = makeSession({ skipSpawn: true });
    const cfgDir = first.claudeConfigDir!;

    for (const name of ['settings.json', '.claude.json']) {
      fs.writeFileSync(shared, SHARED_BODY);
      const dest = path.join(cfgDir, name);
      fs.rmSync(dest);
      fs.symlinkSync(shared, dest);

      // Same session id ⇒ same config dir ⇒ the link is in the way.
      const again = makeSession({ skipSpawn: true });
      expect(again.claudeConfigDir).toBe(cfgDir);

      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(shared, 'utf8')).toBe(SHARED_BODY);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Phase ordering — mcp.json is written into the already-open log, before
//    the skipSpawn early return.
// ---------------------------------------------------------------------------

describe('claude adapter — phase ordering', () => {
  it('writes the mcp.json before the skipSpawn early return and logs it', async () => {
    const s = makeSession({ skipSpawn: true });
    const mcpPath = path.join(
      mcpRuntimeDir,
      'orch-orch-1111',
      'session-sess-0000',
      'mcp.json',
    );
    expect(fs.existsSync(mcpPath)).toBe(true);
    // The session log is a WriteStream — let it flush before reading it back.
    await new Promise((r) => setTimeout(r, 50));
    const logText = fs.readFileSync(s.logPath, 'utf8');
    const skipIdx = logText.indexOf('[swarm-os] skipSpawn=true');
    const mcpIdx = logText.indexOf(`[swarm-os] mcp.json written at ${mcpPath}`);
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    // The mcp.json line lands in the session log, which proves the log stream
    // was opened before `_spawn` ran and that the write happens before the
    // early return.
    expect(mcpIdx).toBeGreaterThan(skipIdx);
    // And the config dir was fully prepared before the log even opened.
    expect(fs.existsSync(path.join(s.claudeConfigDir!, 'settings.json'))).toBe(true);
  });

  it('emits the mcp.json config with the session-secret URL', () => {
    const s = makeSession({ skipSpawn: true });
    const mcpPath = path.join(
      mcpRuntimeDir,
      'orch-orch-1111',
      'session-sess-0000',
      'mcp.json',
    );
    const body = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string }>;
    };
    expect(body.mcpServers['team-comms']).toEqual({
      type: 'http',
      url: `http://127.0.0.1:8788/mcp/orch-1111/${s.sessionSecret}`,
    });
  });
});

// ---------------------------------------------------------------------------
// MCP tool naming (Lot 9b)
// ---------------------------------------------------------------------------

describe('claude adapter — MCP tool naming', () => {
  it('is the identity, so the preamble keeps the canonical dotted names', () => {
    // A DECISION, not an observation: Claude Code does expose an MCP tool as
    // `mcp__<server>__<tool>` (the literal `mcp__server__tool` is in the shipped
    // 2.1.220 binary). We keep handing the agent `team.whoami` because that is
    // the only rendering with a production track record — every claude team this
    // server has run reached its mailbox with it. Changing the live path is a
    // decision to take on its own evidence; if this assertion ever flips, the
    // preamble of every claude session changes with it.
    for (const t of [
      'team.whoami',
      'team.send_message',
      'team.read_inbox',
      'swarm.list_teams',
      'discord.send_message',
    ]) {
      expect(CLAUDE_PROVIDER.mcpToolName(t)).toBe(t);
    }
  });
});
