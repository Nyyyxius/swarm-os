import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './ids.js';

/**
 * Gemini adapter contract (plan Lot 5, spike S2 = `scripts/verify-gemini.report.md`).
 *
 * The real `gemini` binary is NEVER executed here — not even `--version`: spike
 * S2 established that EVERY gemini invocation writes into the config dir, so a
 * test that shelled out would pollute the operator's `~/.gemini`. The probe's
 * `spawnSync` / `hostExec` are injected instead.
 *
 * What is frozen, and why each one is load-bearing:
 *
 *   1. the `.gemini/` LEVEL — gemini treats `GEMINI_CLI_HOME` as a `$HOME`, so a
 *      `settings.json` written one directory too high is read by nobody and
 *      fails silently (no MCP, no hook, no trust, no error);
 *   2. `settings.json` byte for byte: `mcpServers.<n>.httpUrl` (NOT claude's
 *      `{type,url}`), `trust:true`, the hook under `AfterAgent` (`Notification`
 *      never fires under `--yolo`), and both auto-update flags off;
 *   3. the two roots: `trustedFolders.json`'s key goes through
 *      `paths.workspace`, `GEMINI_CLI_HOME` through `paths.data` — inverting
 *      them throws nothing and just wedges the PTY on an invisible dialog;
 *   4. credentials are SYMLINKED into the shared `~/.gemini` while every
 *      per-session file stays a REGULAR file — the link is what makes the SSH
 *      transport work at all (a copy has no readable source there) and what keeps
 *      token refreshes mutualised instead of N diverging copies of one refresh
 *      token; the regular-file assertion is what keeps this session's MCP url out
 *      of the shared dir;
 *   5. `security.auth.selectedType` is decided on EVIDENCE (the resolved
 *      credentials, or the operator's `SWARM_OS_GEMINI_AUTH_TYPE`) and never on
 *      the mere existence of a symlink we created ourselves — under ssh that
 *      test always passed and pinned OAuth on hosts that have none;
 *   6. `probe()` refuses when the binary is missing OR when `GEMINI_CLI_HOME` is
 *      not honoured (plan Risk 4), and never throws. Its double models "gemini
 *      READS the home it is given", never "gemini writes file X" — the latter is
 *      what froze the previous probe to 0.35.2's behaviour.
 */

const captured = vi.hoisted(() => ({
  pty: [] as Array<Record<string, unknown>>,
  ssh: [] as Array<Record<string, unknown>>,
}));

vi.mock('../orchestrator/agent-process.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../orchestrator/agent-process.js')>();
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
import type { Config } from '../../config.js';
import { IDENTITY_PATH_MAPPER, type SessionConfigRequest } from './types.js';
import {
  GeminiProvider,
  GEMINI_SHARED_ENTRIES,
  GEMINI_PROBE_MCP_NAME,
  GEMINI_PROBE_READ_BEGIN,
  GEMINI_PROBE_READ_END,
  GEMINI_PROBE_MIN_TIMEOUT_MS,
  buildGeminiProbeScript,
  geminiMcpToolName,
  type ProbeHostExec,
  type ProbeSpawnSync,
} from './gemini.js';

/**
 * Literal copy of the notification hook command — the same duplication as
 * `claude.test.ts`, for the same reason: the string is executed by the AGENT's
 * shell, and spike C5 proved it works under gemini unchanged. A quoting change
 * must fail here rather than in production.
 */
function expectedHookCommand(opts: {
  orchestratorId: string;
  sessionId: string;
  hookToken: string;
  mainHttpPort: number;
}): string {
  const hookUrl = `http://127.0.0.1:${opts.mainHttpPort}/hooks/notification`;
  return (
    `payload=$(cat); ` +
    `msg=$(printf '%s' "$payload" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || ` +
    `msg=$(printf '"%s"' "$(printf '%s' "$payload" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\n/\\\\n/g')"); ` +
    `body=$(printf '{"orch_id":"%s","session_id":"%s","kind":"session.waiting","message":%s}' '${opts.orchestratorId}' '${opts.sessionId}' "$msg"); ` +
    `curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${opts.hookToken}' -d "$body" '${hookUrl}' >/dev/null 2>&1 || true`
  );
}

const HOST_DATA_DIR = '/host/data';
const HOST_WORKSPACE_ROOT = '/host/workspace';
const HOST_CLAUDE_DIR = '/host/home/.claude';
// The instance default, read from `ids.ts` rather than frozen here: `pnpm
// models:sync` rewrites that table before a release, and this suite is about the
// spawn plumbing, not about which gemini id is current.
const MODEL = BUILTIN_PROVIDER_DEFAULT_MODELS.gemini;

let tmpRoot: string;
let dataDir: string;
let logsDir: string;
let mcpRuntimeDir: string;
let runtimeRoot: string;
let workspaceRoot: string;
let cwd: string;
/** Stand-in for the host's `~/.gemini` (`config.hostGeminiDir`). */
let hostGeminiDir: string;
const openSessions: Session[] = [];

function providerConfig(): Config {
  return { hostGeminiDir } as unknown as Config;
}

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-provider-gemini-'));
  dataDir = path.join(tmpRoot, 'data');
  logsDir = path.join(dataDir, 'logs');
  mcpRuntimeDir = path.join(dataDir, 'mcp-runtime');
  runtimeRoot = path.join(dataDir, '.claude-runtime');
  workspaceRoot = path.join(tmpRoot, 'workspace');
  cwd = path.join(workspaceRoot, 'proj');
  hostGeminiDir = path.join(tmpRoot, 'host-home', '.gemini');
  for (const d of [logsDir, mcpRuntimeDir, runtimeRoot, cwd, hostGeminiDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // The host's shared state: the three entries we take, plus a `settings.json`
  // that must NEVER be copied (the per-session one carries this session's MCP
  // url and hook).
  fs.writeFileSync(
    path.join(hostGeminiDir, 'oauth_creds.json'),
    JSON.stringify({ refresh_token: 'HOST-REFRESH' }),
  );
  fs.writeFileSync(
    path.join(hostGeminiDir, 'google_accounts.json'),
    JSON.stringify({ active: 'operator@example.com' }),
  );
  fs.writeFileSync(path.join(hostGeminiDir, 'installation_id'), 'install-abc');
  fs.writeFileSync(
    path.join(hostGeminiDir, 'settings.json'),
    JSON.stringify({ mcpServers: { 'operator-server': {} } }),
  );
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
  preamble?: string | null;
  initialPrompt?: string | null;
  resumeNotice?: string | null;
  hooks?: boolean;
  /** Omit `runtimeRoot` — no isolation possible. */
  noRuntimeRoot?: boolean;
  hostDir?: string | null;
  /** `config.geminiAuthType` (`SWARM_OS_GEMINI_AUTH_TYPE`). */
  authType?: string;
}

function makeSession(opts: MakeOpts = {}): Session {
  const cfg = {
    hostGeminiDir: opts.hostDir === undefined ? hostGeminiDir : opts.hostDir,
    ...(opts.authType === undefined ? {} : { geminiAuthType: opts.authType }),
  } as unknown as Config;
  const s = new Session({
    id: opts.id ?? 'sess-0000',
    orchestratorId: 'orch-1111',
    name: 'golden',
    role: 'tester',
    type: 'worker',
    cwd,
    initialPrompt: opts.initialPrompt === undefined ? 'TASK' : opts.initialPrompt,
    preamble: opts.preamble === undefined ? 'ROLE PREAMBLE' : opts.preamble,
    resumeNotice: opts.resumeNotice ?? null,
    model: MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 8788,
    hookToken: opts.hooks === false ? undefined : 'hook-token-xyz',
    mainHttpPort: opts.hooks === false ? undefined : 8787,
    ...(opts.noRuntimeRoot ? {} : { runtimeRoot }),
    sshTransport: opts.ssh ? sshBundle() : null,
    provider: new GeminiProvider(cfg),
  });
  openSessions.push(s);
  return s;
}

/** Container path of the per-session fake `$HOME` (= `GEMINI_CLI_HOME`). */
function homeFor(id = 'sess-0000'): string {
  return path.join(runtimeRoot, 'gemini-sessions', id);
}
/** Container path of the config tree gemini actually reads. */
function cfgFor(id = 'sess-0000'): string {
  return path.join(homeFor(id), '.gemini');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** Direct phase-A call, no Session — for the edge cases. */
function directRequest(over: Partial<SessionConfigRequest> = {}): SessionConfigRequest {
  return {
    sessionId: 'sess-direct',
    orchestratorId: 'orch-1111',
    cwd,
    transport: 'local',
    paths: IDENTITY_PATH_MAPPER,
    preamble: 'ROLE PREAMBLE',
    hookToken: 'hook-token-xyz',
    mainHttpPort: 8787,
    runtimeRoot,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. The config tree — and the `.gemini/` level in particular
// ---------------------------------------------------------------------------

describe('gemini adapter — per-session config tree', () => {
  it('writes everything under `<GEMINI_CLI_HOME>/.gemini/`, never one level up', () => {
    const s = makeSession();
    const home = homeFor();
    const cfg = cfgFor();
    // `claudeConfigDir` is the historical name of "the provider's per-session
    // config dir"; for gemini it is the fake $HOME, NOT the .gemini inside it.
    expect(s.claudeConfigDir).toBe(home);
    for (const name of ['settings.json', 'GEMINI.md', 'trustedFolders.json']) {
      expect(fs.existsSync(path.join(cfg, name))).toBe(true);
      // The level is the whole point: gemini reads the env var as a $HOME and
      // appends `.gemini`. A file at `<home>/settings.json` is read by nobody.
      expect(fs.existsSync(path.join(home, name))).toBe(false);
    }
  });

  it('holds exactly the shared-credential links plus our four files — nothing of the host settings', () => {
    makeSession();
    expect(new Set(fs.readdirSync(cfgFor()))).toEqual(
      new Set([
        ...GEMINI_SHARED_ENTRIES,
        'settings.json',
        'GEMINI.md',
        'trustedFolders.json',
        'projects.json',
      ]),
    );
  });

  it('seeds gemini’s project registry so the PTY does not open on an ENOENT stack', () => {
    // Every config dir we build is COLD, and a cold `ProjectRegistry.getShortId`
    // races itself on a fixed `projects.json.tmp` name: gemini catches the
    // failure but prints the whole ENOENT stack. Verified on 0.35.2: seeding the
    // file makes `gemini --version` print `0.35.2` and nothing else.
    makeSession();
    expect(readJson(path.join(cfgFor(), 'projects.json'))).toEqual({ projects: {} });
  });

  it('creates both directory levels 0700 and every SESSION file 0600', () => {
    makeSession();
    expect(fs.statSync(homeFor()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cfgFor()).mode & 0o777).toBe(0o700);
    // The per-session files only. The shared entries are SYMLINKS (their own
    // mode is meaningless — the target's permissions are what apply), which is
    // asserted in the "shared credentials" block below. The 0700 on the two
    // directory levels is what keeps them unreadable either way.
    for (const name of ['settings.json', 'GEMINI.md', 'trustedFolders.json', 'projects.json']) {
      const st = fs.lstatSync(path.join(cfgFor(), name));
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('asks for the whole fake home to be removed on exit', () => {
    const p = new GeminiProvider(providerConfig());
    const res = p.prepareSessionConfig(directRequest());
    expect(res.configDir).toBe(path.join(runtimeRoot, 'gemini-sessions', 'sess-direct'));
    // The home holds copied OAuth credentials and gemini's own per-session
    // state; none of it should outlive the session.
    expect(res.cleanupPaths).toEqual([res.configDir]);
  });

  it('never throws and returns a null config dir when isolation is impossible', () => {
    const p = new GeminiProvider(providerConfig());
    let res!: ReturnType<GeminiProvider['prepareSessionConfig']>;
    expect(() => {
      res = p.prepareSessionConfig(directRequest({ runtimeRoot: undefined }));
    }).not.toThrow();
    expect(res.configDir).toBeNull();
  });

  it('writes GEMINI.md as the role text VERBATIM — nothing appended', () => {
    makeSession();
    const md = fs.readFileSync(path.join(cfgFor(), 'GEMINI.md'), 'utf8');
    // Byte for byte, plus the trailing newline. This adapter used to staple a
    // "gemini renames MCP tools" note onto every preamble, because the text it
    // was handed named `team.whoami` — a tool no gemini agent has. The renaming
    // now happens where the text is BUILT (`buildPreamble` +
    // `geminiMcpToolName`), so the adapter is a transport again and the note
    // must not come back: two copies of that advice, one of them stale, is how
    // an agent ends up guessing.
    expect(md).toBe('ROLE PREAMBLE\n');
    expect(md).not.toMatch(/Tool naming/i);
  });

  it('skips GEMINI.md entirely when there is no preamble', () => {
    makeSession({ preamble: null });
    expect(fs.existsSync(path.join(cfgFor(), 'GEMINI.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. settings.json — the literal body
// ---------------------------------------------------------------------------

describe('gemini adapter — settings.json', () => {
  it('freezes the exact body: httpUrl MCP, AfterAgent hook, auto-update off', () => {
    const s = makeSession();
    const body = readJson(path.join(cfgFor(), 'settings.json'));
    expect(body).toEqual({
      // Pinned so gemini never opens the auth-method picker: any modal keeps
      // the Ink renderer repainting and idle detection reads it as "busy".
      security: { auth: { selectedType: 'oauth-personal' } },
      // MANDATORY: both default to true and make gemini `npm install -g` at
      // boot, printing into the PTY (spike C8).
      general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
      ui: { showHomeDirectoryWarning: false },
      hooks: {
        // NOT `Notification`: that event only fires on ToolPermission, which
        // never happens under `--yolo`, so the `waiting` status would be lost.
        AfterAgent: [
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
      },
      mcpServers: {
        'team-comms': {
          httpUrl: `http://127.0.0.1:8788/mcp/orch-1111/${s.sessionSecret}`,
          trust: true,
          timeout: 30000,
        },
      },
    });
  });

  it('uses `httpUrl` — never claude’s `{type:"http", url}` shape', () => {
    makeSession();
    const body = readJson(path.join(cfgFor(), 'settings.json'));
    const servers = body.mcpServers as Record<string, Record<string, unknown>>;
    const team = servers['team-comms']!;
    expect(typeof team.httpUrl).toBe('string');
    expect(team).not.toHaveProperty('url');
    expect(team).not.toHaveProperty('type');
  });

  it('registers the hook under AfterAgent only', () => {
    makeSession();
    const hooks = readJson(path.join(cfgFor(), 'settings.json')).hooks as Record<
      string,
      unknown
    >;
    expect(Object.keys(hooks)).toEqual(['AfterAgent']);
    expect(hooks).not.toHaveProperty('Notification');
  });

  it('still isolates the config dir when the hook wiring is missing', () => {
    // Divergence from claude (which returns a null config dir): isolation
    // outranks the hook. A session with no `waiting` signal is a degradation;
    // a session sharing `~/.gemini` is a cross-authentication bug.
    const s = makeSession({ hooks: false });
    expect(s.claudeConfigDir).toBe(homeFor());
    const body = readJson(path.join(cfgFor(), 'settings.json'));
    expect(body).not.toHaveProperty('hooks');
    expect(body.general).toEqual({
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
    });
  });

  it('pins the api-key auth mode when no OAuth credentials could be placed', () => {
    // No host state dir at all ⇒ no credentials link ⇒ nothing suggests OAuth.
    // See the auth-mode block below for the full decision.
    const s = makeSession({ hostDir: null });
    const body = readJson(path.join(path.join(s.claudeConfigDir!, '.gemini'), 'settings.json'));
    expect(body.security).toEqual({ auth: { selectedType: 'gemini-api-key' } });
  });
});

// ---------------------------------------------------------------------------
// 3. The two roots — trustedFolders.json vs GEMINI_CLI_HOME
// ---------------------------------------------------------------------------

describe('gemini adapter — trust file and the two path roots', () => {
  it('keys trustedFolders.json on the container cwd in local transport', () => {
    makeSession();
    expect(readJson(path.join(cfgFor(), 'trustedFolders.json'))).toEqual({
      [cwd]: 'TRUST_FOLDER',
    });
  });

  it('keys it on the HOST cwd under ssh, and routes GEMINI_CLI_HOME through dataDir', () => {
    makeSession({ ssh: true });
    const trust = readJson(path.join(cfgFor(), 'trustedFolders.json'));
    const opts = captured.ssh[0]!;
    const hostCwd = `${HOST_WORKSPACE_ROOT}/proj`;
    const hostHome = `${HOST_DATA_DIR}/.claude-runtime/gemini-sessions/sess-0000`;

    // `paths.workspace` for the trust key (the AGENT resolves it where it runs)…
    expect(Object.keys(trust)).toEqual([hostCwd]);
    expect(trust[hostCwd]).toBe('TRUST_FOLDER');
    // …and `paths.data` for the config dir (WE wrote it, under the data mount).
    expect(opts.remoteEnv).toEqual({ GEMINI_CLI_HOME: hostHome });

    // Anti-inversion: swapping the two mappers throws nothing — `toHostPath`
    // passes a non-matching prefix THROUGH UNCHANGED — so assert each value is
    // NOT what the other mapper would have produced. The failure mode being
    // guarded is gemini re-opening its trust dialog and the PTY wedging on a
    // widget nobody can see.
    expect(Object.keys(trust)).not.toContain(cwd);
    expect(Object.keys(trust)[0]).not.toContain(HOST_DATA_DIR);
    expect(opts.remoteEnv).not.toEqual({ GEMINI_CLI_HOME: homeFor() });
    expect(hostHome).not.toContain(HOST_WORKSPACE_ROOT);
  });
});

// ---------------------------------------------------------------------------
// 4. Credentials are SYMLINKED into the shared ~/.gemini, like claude's
// ---------------------------------------------------------------------------

describe('gemini adapter — shared credentials', () => {
  it('symlinks each shared entry at the host state dir', () => {
    // Reversal of the Lot 5 decision to COPY (consolidation Lot 9a). Two
    // reasons, both in `GEMINI_SHARED_ENTRIES`: under SSH a copy has NO readable
    // source (the host `~/.gemini` is not mounted), so the copy placed nothing at
    // all in the only transport this deployment uses; and N copies of ONE refresh
    // token invalidate each other when Google rotates it.
    makeSession();
    for (const name of GEMINI_SHARED_ENTRIES) {
      const link = path.join(cfgFor(), name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(hostGeminiDir, name));
    }
    // …and it reads through, so gemini finds real credentials.
    expect(readJson(path.join(cfgFor(), 'oauth_creds.json'))).toEqual({
      refresh_token: 'HOST-REFRESH',
    });
  });

  it('a token refresh in the session lands in the SHARED file — mutualised, not fragmented', () => {
    makeSession();
    // gemini rewrites `oauth_creds.json` in place when it refreshes, and it
    // follows symlinks. Reaching the shared file is the INTENDED behaviour: every
    // session and the operator move to the new token together, which is exactly
    // what claude has done in production with `.credentials.json`.
    fs.writeFileSync(
      path.join(cfgFor(), 'oauth_creds.json'),
      JSON.stringify({ refresh_token: 'ROTATED-IN-SESSION' }),
    );
    expect(readJson(path.join(hostGeminiDir, 'oauth_creds.json'))).toEqual({
      refresh_token: 'ROTATED-IN-SESSION',
    });
  });

  it('re-points a stale link left by an earlier session', () => {
    const p = new GeminiProvider(providerConfig());
    const first = p.prepareSessionConfig(directRequest());
    const dest = path.join(first.configDir!, '.gemini', 'oauth_creds.json');
    // A link from an older server version pointing somewhere else entirely.
    fs.rmSync(dest);
    fs.symlinkSync(path.join(hostGeminiDir, 'installation_id'), dest);
    p.prepareSessionConfig(directRequest());
    expect(fs.readlinkSync(dest)).toBe(path.join(hostGeminiDir, 'oauth_creds.json'));
  });

  it('never lets a per-session write follow a planted link into the shared dir', () => {
    // The flip side of symlinking the credentials: the SESSION files must not
    // be links. Every per-session write goes through
    // `session-config.writeSessionFile`, which removes whatever sits at the
    // path first — so a link planted at any of them (a stale one from an older
    // server version, or a leftover in a session dir that survived a hard
    // container kill and is re-prepared under the SAME id by auto-resume) cannot
    // carry this session's MCP url or hook token into the operator's ~/.gemini.
    const p = new GeminiProvider(providerConfig());
    const first = p.prepareSessionConfig(directRequest());
    const cfg = path.join(first.configDir!, '.gemini');
    const shared = path.join(hostGeminiDir, 'shared-bystander.json');
    const SHARED_BODY = JSON.stringify({ operator: 'do not touch' });
    for (const name of ['settings.json', 'GEMINI.md', 'trustedFolders.json', 'projects.json']) {
      fs.writeFileSync(shared, SHARED_BODY);
      const dest = path.join(cfg, name);
      fs.rmSync(dest);
      fs.symlinkSync(shared, dest);

      p.prepareSessionConfig(directRequest());

      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(shared, 'utf8')).toBe(SHARED_BODY);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    }
    // Phase B.1 merges into settings.json on its own: same guarantee there.
    fs.writeFileSync(shared, SHARED_BODY);
    const settings = path.join(cfg, 'settings.json');
    fs.rmSync(settings);
    fs.symlinkSync(shared, settings);
    p.writeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-direct',
      sessionSecret: 'sekret',
      mcpHost: '127.0.0.1',
      mcpPort: 8788,
      configDir: first.configDir!,
      paths: IDENTITY_PATH_MAPPER,
    });
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(shared, 'utf8')).toBe(SHARED_BODY);
  });

  it('links unconditionally under SSH, where the target cannot be stat’d', () => {
    // `hostGeminiDir` is a HOST path in production: the container cannot see it,
    // so `existsCheck` is off and the links are written blind. A dangling link is
    // the honest representation of "the host has no credentials"; refusing to
    // create it would leave the agent with no path to read at all.
    const s = makeSession({ ssh: true, hostDir: '/host/home/.gemini' });
    expect(s.claudeConfigDir).toBe(homeFor());
    for (const name of GEMINI_SHARED_ENTRIES) {
      const link = path.join(cfgFor(), name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(`/host/home/.gemini/${name}`);
    }
    // …and placing the link proves NOTHING about the credentials — see the
    // auth-mode block below, which is where that used to go wrong.
  });

  it('carries on (config dir intact) when the local host state dir is unreachable', () => {
    // Local transport: we CAN stat, so a missing source means no link rather than
    // a dangling one. Isolation still matters more than credentials.
    const s = makeSession({ hostDir: '/nonexistent/host/.gemini' });
    expect(s.claudeConfigDir).toBe(homeFor());
    for (const name of GEMINI_SHARED_ENTRIES) {
      expect(fs.existsSync(path.join(cfgFor(), name))).toBe(false);
    }
    expect(fs.existsSync(path.join(cfgFor(), 'settings.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4b. security.auth.selectedType — what the session pins, and on what evidence
// ---------------------------------------------------------------------------

describe('gemini adapter — auth mode', () => {
  function authOf(cfgDir: string): unknown {
    return (readJson(path.join(cfgDir, 'settings.json')).security as Record<string, unknown>)
      .auth;
  }

  it('pins oauth-personal when the credentials RESOLVE (local transport)', () => {
    // `hostGeminiDir` holds a real `oauth_creds.json` here, so the link reads
    // through and the session can genuinely use OAuth.
    makeSession();
    expect(authOf(cfgFor())).toEqual({ selectedType: 'oauth-personal' });
  });

  it('pins gemini-api-key when the host dir has no oauth_creds.json', () => {
    fs.rmSync(path.join(hostGeminiDir, 'oauth_creds.json'));
    makeSession();
    expect(authOf(cfgFor())).toEqual({ selectedType: 'gemini-api-key' });
  });

  it('does NOT read oauth-personal out of a DANGLING link under ssh', () => {
    // THE REGRESSION. Under ssh `existsCheck` is off, so the link is created
    // whatever the host holds; the old code then `lstat`ed the link it had just
    // made — which always succeeds, link or no target — and pinned
    // `oauth-personal` in the only transport this deployment uses. On a host
    // that authenticates with an API key that produces an OAuth prompt instead
    // of a TUI: the PTY goes silent, the agent reads as idle for ever, its
    // messages are typed into an authorization-code prompt.
    const s = makeSession({ ssh: true, hostDir: '/host/home/.gemini' });
    const cfg = path.join(s.claudeConfigDir!, '.gemini');
    // The link IS there (the agent resolves it on the host)…
    expect(fs.lstatSync(path.join(cfg, 'oauth_creds.json')).isSymbolicLink()).toBe(true);
    // …and it is NOT evidence of anything.
    expect(authOf(cfg)).toEqual({ selectedType: 'gemini-api-key' });
  });

  it('lets SWARM_OS_GEMINI_AUTH_TYPE state what the container cannot see', () => {
    // The escape hatch for an OAuth host under ssh: the operator knows, we
    // cannot. It wins over every inference.
    const s = makeSession({ ssh: true, hostDir: '/host/home/.gemini', authType: 'oauth-personal' });
    expect(authOf(path.join(s.claudeConfigDir!, '.gemini'))).toEqual({
      selectedType: 'oauth-personal',
    });
  });

  it('lets the override win over local evidence too', () => {
    // Local transport with real credentials on disk, and the operator still
    // says "use the API key" — one rule, both transports.
    makeSession({ authType: 'gemini-api-key' });
    expect(authOf(cfgFor())).toEqual({ selectedType: 'gemini-api-key' });
  });

  it('ignores a typo rather than pinning a value gemini rejects', () => {
    // An unknown `selectedType` is an auth error at boot for every agent, so a
    // bad override falls back to the inferred value instead of being obeyed.
    makeSession({ authType: 'oauth_personal' });
    expect(authOf(cfgFor())).toEqual({ selectedType: 'oauth-personal' });
  });
});

// ---------------------------------------------------------------------------
// 5. writeMcpConfig / removeMcpConfig
// ---------------------------------------------------------------------------

describe('gemini adapter — MCP merge', () => {
  it('merges into the phase-A settings.json without dropping the hook', () => {
    const p = new GeminiProvider(providerConfig());
    const prepared = p.prepareSessionConfig(directRequest());
    const res = p.writeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-direct',
      sessionSecret: 'secret-abc',
      mcpHost: '127.0.0.1',
      mcpPort: 8788,
      configDir: prepared.configDir,
      paths: IDENTITY_PATH_MAPPER,
    })!;
    expect(res.path).toBe(path.join(prepared.configDir!, '.gemini', 'settings.json'));
    expect(res.url).toBe('http://127.0.0.1:8788/mcp/orch-1111/secret-abc');
    const body = readJson(res.path);
    expect(body).toHaveProperty('hooks');
    expect(body).toHaveProperty('security');
    expect(body.mcpServers).toEqual({
      'team-comms': { httpUrl: res.url, trust: true, timeout: 30000 },
    });
  });

  it('returns null when there is no config dir to merge into', () => {
    const p = new GeminiProvider(providerConfig());
    expect(
      p.writeMcpConfig({
        runtimeDir: mcpRuntimeDir,
        orchestratorId: 'o',
        sessionId: 's',
        sessionSecret: 'x',
        mcpHost: '127.0.0.1',
        mcpPort: 8788,
        configDir: null,
        paths: IDENTITY_PATH_MAPPER,
      }),
    ).toBeNull();
  });

  it('revokes only the team-comms entry, and never throws on a missing file', () => {
    const p = new GeminiProvider(providerConfig());
    const prepared = p.prepareSessionConfig(directRequest());
    const settingsPath = path.join(prepared.configDir!, '.gemini', 'settings.json');
    const withExtra = readJson(settingsPath);
    withExtra.mcpServers = { 'team-comms': { httpUrl: 'x' }, other: { httpUrl: 'y' } };
    fs.writeFileSync(settingsPath, JSON.stringify(withExtra));

    p.removeMcpConfig({
      runtimeDir: mcpRuntimeDir,
      orchestratorId: 'orch-1111',
      sessionId: 'sess-direct',
      configDir: prepared.configDir,
    });
    expect(readJson(settingsPath).mcpServers).toEqual({ other: { httpUrl: 'y' } });

    // `Session._cleanupMcpConfig` does not guard the call: a throw here would
    // keep a session from reaching a terminal state.
    expect(() =>
      p.removeMcpConfig({
        runtimeDir: mcpRuntimeDir,
        orchestratorId: 'orch-1111',
        sessionId: 'sess-direct',
        configDir: '/nonexistent/config/dir',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. buildSpawn — argv + env, both transports
// ---------------------------------------------------------------------------

describe('gemini adapter — spawn', () => {
  it('hands PtyAgentProcess the exact command / args / cwd / env (local)', () => {
    makeSession();
    expect(captured.ssh).toHaveLength(0);
    expect(captured.pty).toHaveLength(1);
    const opts = captured.pty[0]!;
    expect(opts.command).toBe('gemini');
    expect(opts.cwd).toBe(cwd);
    expect(opts.args).toEqual(['-m', MODEL, '--yolo', '--', 'TASK']);
    expect(opts.env).toEqual({ GEMINI_CLI_HOME: homeFor() });
  });

  it('keeps the preamble, the effort and the permission mode OUT of the argv', () => {
    makeSession();
    const args = captured.pty[0]!.args as string[];
    // The preamble lives in GEMINI.md — that is what makes it survive /clear.
    expect(args).not.toContain('ROLE PREAMBLE');
    expect(args).not.toContain('--append-system-prompt');
    // `-p/--prompt` is HEADLESS: it would print an answer and exit, leaving no
    // TUI for Session to drive.
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--prompt');
    // No CLI equivalent exists for either.
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('--permission-mode');
    // No MCP flag: the server list lives in settings.json.
    expect(args.some((a) => a.startsWith('--mcp-config'))).toBe(false);
  });

  it('translates the config dir to a host path under ssh', () => {
    makeSession({ ssh: true });
    const opts = captured.ssh[0]!;
    expect(opts.remoteCommand).toBe('gemini');
    expect(opts.remoteCwd).toBe(`${HOST_WORKSPACE_ROOT}/proj`);
    expect(opts.args).toEqual(['-m', MODEL, '--yolo', '--', 'TASK']);
    expect(opts.remoteEnv).toEqual({
      GEMINI_CLI_HOME: `${HOST_DATA_DIR}/.claude-runtime/gemini-sessions/sess-0000`,
    });
    expect(opts.reverseTunnelPort).toBe(8788);
  });

  it('prefixes the resume notice onto the positional prompt only', () => {
    makeSession({ resumeNotice: 'NOTICE' });
    expect(captured.pty[0]!.args).toEqual(['-m', MODEL, '--yolo', '--', 'NOTICE\n\nTASK']);
  });

  it('omits the positional argument entirely when there is no prompt', () => {
    makeSession({ initialPrompt: null });
    expect(captured.pty[0]!.args).toEqual(['-m', MODEL, '--yolo']);
  });

  it('refuses to spawn without an isolated GEMINI_CLI_HOME', () => {
    // Sharing one `~/.gemini` across sessions means one MCP url and one
    // identity: every agent would authenticate as the last writer (Risk 4).
    const s = makeSession({ noRuntimeRoot: true });
    expect(captured.pty).toHaveLength(0);
    expect(s.status).toBe('failed');
    expect(s.lastError).toMatch(/GEMINI_CLI_HOME/);
  });
});

// ---------------------------------------------------------------------------
// 7. Static contract
// ---------------------------------------------------------------------------

describe('gemini adapter — declared contract', () => {
  it('describes itself accurately', () => {
    const p = new GeminiProvider(providerConfig());
    expect([p.id, p.label, p.binary]).toEqual(['gemini', 'Gemini CLI', 'gemini']);
    expect(p.capabilities.effort).toBe(false);
    expect(p.capabilities.inkSubmitDance).toBe(true);
    // `AfterAgent` fires at the END OF EVERY TURN, including a failed one (spike
    // C5) — it is an inactivity boundary, NOT "a human is needed". Declaring it
    // `'needs-human'` (or the old `true`) is what produced one Discord alert and
    // one armed `/compact` per turn; `/hooks/notification` filters on this value.
    expect(p.capabilities.notificationHook).toBe('turn-complete');
    expect(p.capabilities.durablePreamble).toBe(true);
    expect(p.capabilities.httpMcp).toBe(true);
    // Exactly one mode, and it IS the fallback: `--yolo` is the only permission
    // vocabulary gemini has (see `ProviderCapabilities.permissionModes` — never
    // empty, always contains the fallback, `length === 1` means "not a choice").
    expect(p.capabilities.permissionModes).toEqual(['bypassPermissions']);
    expect(p.capabilities.fallbackPermissionMode).toBe('bypassPermissions');
    expect(p.defaults()).toEqual({
      model: MODEL,
      effort: 'high',
      permissionMode: 'bypassPermissions',
    });
    expect(p.initRuntime({ sourceDir: '/x', runtimeDir: '/y' })).toEqual({
      initialized: false,
      copied: false,
      skipReason: 'not-applicable',
    });
  });

  it('maps both reset commands to themselves (/compact is an alias of /compress)', () => {
    const p = new GeminiProvider();
    expect(p.contextResetLine('/clear')).toBe('/clear');
    expect(p.contextResetLine('/compact')).toBe('/compact');
    expect(p.contextResetLine('/compact', 'keep the API contract')).toBe(
      '/compact keep the API contract',
    );
  });
});

// ---------------------------------------------------------------------------
// 8. probe() — the GEMINI_CLI_HOME re-routing check (plan Risk 4)
// ---------------------------------------------------------------------------

interface SpawnCall {
  command: string;
  args: readonly string[];
  home: string | undefined;
  cwd: string;
  timeout: number;
  /** Entries the fake found in `<home>/.gemini` when it was invoked. */
  seeded: string[];
}

/**
 * A `spawnSync` double standing in for gemini.
 *
 * It models THE PROPERTY THE ADAPTER DEPENDS ON — "does gemini READ the config
 * tree in the home it is handed?" — and nothing else. `readsHome: false` plays
 * the future release that dropped `GEMINI_CLI_HOME`: it lists the servers of
 * some OTHER home, so ours never appear.
 *
 * Deliberately NOT modelled: any file gemini happens to create. The previous
 * double created `tmp/` and `history/` because 0.35.2 did, the probe asserted on
 * that, and 0.52.0 — which writes nothing on `--version` — was reported as "no
 * longer honours GEMINI_CLI_HOME" on a perfectly healthy install. A double that
 * freezes a version's housekeeping freezes the bug with it.
 *
 * `mcp list` prints on STDERR outside a TTY (measured on 0.52.0), so that is
 * where the listing goes here; a probe that only read stdout would see nothing.
 */
function fakeGemini(opts: {
  readsHome: boolean;
  calls: SpawnCall[];
  /** Exit code of `--version` — the only one the verdict may depend on. */
  versionStatus?: number;
  version?: string;
  versionStderr?: string;
  /** Exit code of `mcp list`. It tracks AUTH on the real CLI: must not matter. */
  mcpStatus?: number;
  /** Play the untrusted-folder case: a list was found, names suppressed. */
  untrusted?: boolean;
  /** `mcp list` never returns (timeout). */
  mcpSignal?: NodeJS.Signals;
}): ProbeSpawnSync {
  return (command, args, options) => {
    const home = options.env.GEMINI_CLI_HOME;
    const cfg = home ? path.join(home, '.gemini') : null;
    let seeded: string[] = [];
    try {
      seeded = cfg ? fs.readdirSync(cfg) : [];
    } catch {
      seeded = [];
    }
    opts.calls.push({
      command,
      args: [...args],
      home,
      cwd: options.cwd,
      timeout: options.timeout,
      seeded,
    });
    if (args[0] === '--version') {
      return {
        status: opts.versionStatus ?? 0,
        signal: null,
        stdout: `${opts.version ?? '0.52.0'}\n`,
        stderr: opts.versionStderr ?? '',
      };
    }
    // `gemini mcp list`: report the servers of the home we actually read.
    if (opts.mcpSignal) {
      return { status: null, signal: opts.mcpSignal, stdout: '', stderr: '' };
    }
    const names = opts.readsHome && cfg ? mcpServerNames(cfg) : [];
    const status = opts.mcpStatus ?? 0;
    if (names.length === 0) {
      return { status, signal: null, stdout: '', stderr: 'No MCP servers configured.\n' };
    }
    if (opts.untrusted) {
      return {
        status,
        signal: null,
        stdout: '',
        stderr:
          'Warning: MCP servers are configured but disabled because this folder is untrusted.\n' +
          'Configured MCP servers:\n',
      };
    }
    return {
      status,
      signal: null,
      stdout: '',
      stderr: `Configured MCP servers:\n\n${names
        .map((n) => `✗ ${n}: (http) - Disconnected`)
        .join('\n')}\n`,
    };
  };
}

/** Server names declared in `<cfg>/settings.json`, as gemini would read them. */
function mcpServerNames(cfg: string): string[] {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return Object.keys(body.mcpServers ?? {});
  } catch {
    return [];
  }
}

describe('gemini adapter — probe (local transport)', () => {
  const localCtx = { transport: 'local' as const, config: {} as unknown as Config };

  it('proves the re-routing by READING back a marker server, and writes nothing', async () => {
    const calls: SpawnCall[] = [];
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: true, calls }),
    });
    // The double creates NO file at all — that is 0.52.0's `--version`
    // behaviour, and it must not make the provider unavailable.
    await expect(p.probe(localCtx)).resolves.toEqual({
      available: true,
      version: '0.52.0',
    });
    expect(calls.map((c) => c.args.join(' '))).toEqual(['--version', 'mcp list']);
    for (const call of calls) {
      expect(call.command).toBe('gemini');
      // The disposable home is mandatory: gemini writes into its config dir on
      // almost any invocation, so a probe without it pollutes ~/.gemini.
      expect(call.home).toBeTruthy();
      // …and gemini must run from the folder `trustedFolders.json` is keyed on,
      // not from the server's cwd, or the trust seed misses.
      expect(call.cwd.startsWith(call.home!)).toBe(true);
      // The three files a session gets, so the read proof is about OUR tree.
      expect(new Set(call.seeded)).toEqual(
        new Set(['projects.json', 'settings.json', 'trustedFolders.json']),
      );
    }
  });

  it('reports unavailable when gemini reads some OTHER home (Risk 4)', async () => {
    const calls: SpawnCall[] = [];
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: false, calls }),
    });
    const res = await p.probe(localCtx);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/did not read the settings\.json/);
    expect(res.reason).toMatch(new RegExp(GEMINI_PROBE_MCP_NAME));
    // Exit 0 and a perfectly good version string are NOT enough: a gemini that
    // read someone else's config would put every session on one ~/.gemini.
    expect(res.version).toBeUndefined();
  });

  it('ignores the exit code of `mcp list` — it tracks auth, not the CLI', async () => {
    // Measured on this host: `mcp list` exits 41 when the home it runs in has no
    // `security.auth.selectedType`. Basing the verdict on it would make an
    // unauthenticated host look like a missing binary.
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: true, calls: [], mcpStatus: 41 }),
    });
    await expect(p.probe(localCtx)).resolves.toEqual({
      available: true,
      version: '0.52.0',
    });
  });

  it('accepts the untrusted-folder wording as a weaker proof', async () => {
    // If the trust seed ever stops taking, gemini says the servers are
    // configured but disabled. That still proves it read OUR file.
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: true, calls: [], untrusted: true }),
    });
    await expect(p.probe(localCtx)).resolves.toEqual({
      available: true,
      version: '0.52.0',
    });
  });

  it('raises the probe budget above gemini’s own boot cost, and splits ONE budget', async () => {
    // The availability cache hands adapters 12 000 ms; two gemini boots were
    // measured at 4 578 ms total on this host (0.52.0). A budget applied twice
    // over would let one probe run for double the caller's deadline.
    const calls: SpawnCall[] = [];
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: true, calls }),
    });
    await p.probe({ ...localCtx, timeoutMs: 2_500 });
    // Frozen LITERAL, not the exported constant: a test that reads the value it
    // is checking agrees with itself.
    expect(calls[0]!.timeout).toBeGreaterThanOrEqual(8_000);
    expect(GEMINI_PROBE_MIN_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
    // Second call gets what is LEFT of the same budget, never a fresh one.
    expect(calls[1]!.timeout).toBeLessThanOrEqual(calls[0]!.timeout);
  });

  it('removes the throwaway home whatever the verdict', async () => {
    const calls: SpawnCall[] = [];
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: true, calls }),
    });
    await p.probe(localCtx);
    expect(fs.existsSync(calls[0]!.home!)).toBe(false);
  });

  it('says so when the binary is missing, without running the second command', async () => {
    const enoent = Object.assign(new Error('spawnSync gemini ENOENT'), {
      code: 'ENOENT',
    });
    let n = 0;
    const p = new GeminiProvider(undefined, {
      spawnSync: () => {
        n += 1;
        return { status: null, signal: null, stdout: null, stderr: null, error: enoent };
      },
    });
    const res = await p.probe(localCtx);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not on PATH/);
    expect(n).toBe(1);
  });

  it('surfaces the CLI’s own failure text on a non-zero `--version` exit', async () => {
    const calls: SpawnCall[] = [];
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({
        readsHome: true,
        calls,
        versionStatus: 41,
        version: '',
        versionStderr:
          'Error authenticating: IneligibleTierError: This client is no longer supported',
      }),
    });
    const res = await p.probe(localCtx);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/exit 41/);
    // The operator has to see gemini's message to know what to fix.
    expect(res.reason).toMatch(/IneligibleTierError/);
    // `--version` failed: there is nothing to ask a second time.
    expect(calls).toHaveLength(1);
  });

  it('reports a timeout rather than a mysterious failure', async () => {
    const p = new GeminiProvider(undefined, {
      spawnSync: () => ({
        status: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      }),
    });
    const res = await p.probe(localCtx);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/timed out/);
  });

  it('treats a `mcp list` that never answered as unproven, never as proven', async () => {
    const p = new GeminiProvider(undefined, {
      spawnSync: fakeGemini({ readsHome: true, calls: [], mcpSignal: 'SIGTERM' }),
    });
    const res = await p.probe(localCtx);
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/could not verify/);
  });

  it('never throws, even on a broken spawn implementation', async () => {
    const p = new GeminiProvider(undefined, {
      spawnSync: () => {
        throw new Error('boom');
      },
    });
    const res = await p.probe(localCtx);
    expect(res).toEqual({ available: false, reason: 'gemini probe failed: boom' });
  });
});

describe('gemini adapter — probe (ssh transport)', () => {
  const sshConfig = {
    agentTransport: 'ssh',
    sshTarget: 'ubuntu@host.docker.internal',
  } as unknown as Config;

  function fakeHostExec(out: {
    code: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
    calls?: Array<{ argv: string[]; timeoutMs: number | undefined }>;
  }): ProbeHostExec {
    return (_config, input) => {
      out.calls?.push({ argv: input.argv, timeoutMs: input.timeoutMs });
      return Promise.resolve({
        code: out.code,
        stdout: out.stdout ?? '',
        stderr: out.stderr ?? '',
        timedOut: out.timedOut ?? false,
      });
    };
  }

  /**
   * VERBATIM stdout of `buildGeminiProbeScript('gemini')` executed by bash
   * against the real `@google/gemini-cli` 0.52.0 on this host, 2026-07-26.
   * Frozen here so the parser is tested against the CLI's real bytes — merged
   * streams, blank line and all — rather than against a tidy invention.
   */
  const REAL_HOST_STDOUT = [
    '0.52.0',
    GEMINI_PROBE_READ_BEGIN,
    'Configured MCP servers:',
    '',
    `✗ ${GEMINI_PROBE_MCP_NAME}: http://127.0.0.1:59999/mcp/${GEMINI_PROBE_MCP_NAME} (http) - Disconnected`,
    GEMINI_PROBE_READ_END,
    '',
  ].join('\n');

  /**
   * Same script, same host, same day, with `GEMINI_CLI_HOME` neutralised so
   * gemini reads an empty `$HOME/.gemini` instead — the exact behaviour plan
   * Risk 4 is about. This is what the adapter must refuse on.
   */
  const REAL_HOST_STDOUT_IGNORED = [
    '0.52.0',
    GEMINI_PROBE_READ_BEGIN,
    'No MCP servers configured.',
    GEMINI_PROBE_READ_END,
    '',
  ].join('\n');

  it('runs the isolated script on the host and reads the marker server back', async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    const p = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({ code: 0, stdout: REAL_HOST_STDOUT, calls }),
    });
    await expect(p.probe({ transport: 'ssh', config: sshConfig })).resolves.toEqual({
      available: true,
      version: '0.52.0',
    });
    const script = calls[0]!.argv[2]!;
    expect(calls[0]!.argv.slice(0, 2)).toEqual(['bash', '-c']);
    expect(script).toBe(buildGeminiProbeScript('gemini'));
    // A throwaway home, both invocations isolated into it, the marker server
    // seeded where gemini must read it, the trust seed keyed on the cwd gemini
    // is actually run from, both streams merged, and no leftovers.
    expect(script).toContain('mktemp -d');
    expect(script).toContain(`"${GEMINI_PROBE_MCP_NAME}"`);
    expect(script).toContain('trustedFolders.json');
    expect(script).toContain('cd "$d/work"');
    expect(script).toContain('GEMINI_CLI_HOME="$d" gemini --version 2>&1');
    expect(script).toContain('GEMINI_CLI_HOME="$d" gemini mcp list 2>&1');
    expect(script).toContain(`echo "${GEMINI_PROBE_READ_BEGIN}"`);
    expect(script).toContain(`echo "${GEMINI_PROBE_READ_END}"`);
    expect(script).toContain('rm -rf "$d"');
    expect(script).toContain('exit $rc');
    // Never a single quote inside the embedded JSON — it rides in
    // single-quoted shell arguments.
    expect(script).toContain(`'{"projects":{}}'`);
    expect(script.split("'").length % 2).toBe(1);
  });

  it('reports unavailable when the host gemini reads another config tree', async () => {
    const p = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({ code: 0, stdout: REAL_HOST_STDOUT_IGNORED }),
    });
    const res = await p.probe({ transport: 'ssh', config: sshConfig });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/did not read the settings\.json/);
    expect(res.reason).toMatch(/host\.docker\.internal/);
  });

  it('treats a missing end marker as unproven, never as proven', async () => {
    // The script died before its last line: we know nothing about the
    // re-routing, and "unknown" must not read as "fine".
    const p = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({ code: 0, stdout: `0.52.0\n${GEMINI_PROBE_READ_BEGIN}\n` }),
    });
    const res = await p.probe({ transport: 'ssh', config: sshConfig });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/could not verify/);
  });

  it('never turns an unrecognised listing into an available provider', async () => {
    // A gemini that ignored the variable AND found the operator's own servers
    // prints a list — without OUR marker. The name is the proof; a header is not.
    const p = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({
        code: 0,
        stdout: [
          '0.52.0',
          GEMINI_PROBE_READ_BEGIN,
          'Configured MCP servers:',
          '',
          '✓ operator-server: http://127.0.0.1:1234/mcp (http) - Connected',
          GEMINI_PROBE_READ_END,
        ].join('\n'),
      }),
    });
    const res = await p.probe({ transport: 'ssh', config: sshConfig });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/could not verify/);
  });

  it('distinguishes "not installed" (127) from a staging failure (90)', async () => {
    const missing = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({ code: 127, stderr: 'bash: gemini: command not found' }),
    });
    const r1 = await missing.probe({ transport: 'ssh', config: sshConfig });
    expect(r1.available).toBe(false);
    expect(r1.reason).toMatch(/not on PATH/);

    const staging = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({ code: 90 }),
    });
    const r2 = await staging.probe({ transport: 'ssh', config: sshConfig });
    expect(r2.available).toBe(false);
    expect(r2.reason).toMatch(/throwaway GEMINI_CLI_HOME/);
  });

  it('reports a host timeout', async () => {
    const p = new GeminiProvider(undefined, {
      hostExec: fakeHostExec({ code: null, timedOut: true }),
    });
    const res = await p.probe({ transport: 'ssh', config: sshConfig });
    expect(res.reason).toMatch(/timed out/);
  });

  it('refuses without an ssh target instead of probing locally by accident', async () => {
    const p = new GeminiProvider(undefined, {
      hostExec: () => {
        throw new Error('must not be called');
      },
    });
    const res = await p.probe({
      transport: 'ssh',
      config: { agentTransport: 'local' } as unknown as Config,
    });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/SWARM_OS_SSH_TARGET/);
  });
});

// ---------------------------------------------------------------------------
// MCP tool naming (Lot 9b)
// ---------------------------------------------------------------------------

describe('gemini adapter — MCP tool naming', () => {
  it('prefixes with mcp_<server>_ and KEEPS the dots', () => {
    // The open question S2 left behind (its probe tool had no dot) — settled two
    // ways. (1) `generateValidName()` in the installed bundle only replaces
    // characters outside `[a-zA-Z0-9_\-.:]`, so `.` and `-` survive.
    // (2) MEASURED: gemini pointed at a real MCP server exposing `team.whoami`
    // and at a fake `GOOGLE_GEMINI_BASE_URL` declared, verbatim,
    // `mcp_team-comms_team.whoami` in its :streamGenerateContent body.
    expect(geminiMcpToolName('team.whoami')).toBe('mcp_team-comms_team.whoami');
    expect(geminiMcpToolName('team.send_message')).toBe('mcp_team-comms_team.send_message');
    expect(geminiMcpToolName('discord.send_message')).toBe('mcp_team-comms_discord.send_message');
  });

  it('reproduces the sanitisation for characters gemini does reject', () => {
    // Same character class as `generateValidName`: `-`, `.` and `:` pass, a
    // space or a slash becomes `_`. Nothing in our vocabulary hits this branch;
    // it is pinned so a future tool name cannot silently drift from the CLI.
    expect(geminiMcpToolName('team.odd name')).toBe('mcp_team-comms_team.odd_name');
    expect(geminiMcpToolName('team/list')).toBe('mcp_team-comms_team_list');
    expect(geminiMcpToolName('team.whoami', 'swarm-probe')).toBe(
      'mcp_swarm-probe_team.whoami',
    );
  });

  it('exposes the same naming through the provider', () => {
    expect(new GeminiProvider(providerConfig()).mcpToolName('team.read_inbox')).toBe(
      'mcp_team-comms_team.read_inbox',
    );
  });
});
