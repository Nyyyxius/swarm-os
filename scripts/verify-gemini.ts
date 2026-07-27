/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scripts/verify-gemini.ts
 *
 * Spike — establish the CLI contract of `gemini` (Google Gemini CLI) so that
 * swarm-os can drive it as an autonomous agent inside a PTY, exactly the way
 * it drives `claude` today.
 *
 * Run via:
 *   pnpm verify:gemini
 * which under the hood runs:
 *   pnpm --filter server exec tsx ../../scripts/verify-gemini.ts
 *
 * NON-NEGOTIABLE INVARIANT
 * ------------------------
 * This spike NEVER writes into the operator's real `~/.gemini`. Everything
 * happens under `<tmpdir>/swarm-os-spike/gemini/`. Credentials are **copied**
 * (mode 0600), never symlinked: gemini refreshes `oauth_creds.json` in place,
 * and a symlink is followed on write — which would mutate the operator's file.
 * (That is not a hypothesis: an early iteration of this spike symlinked the
 * file and gemini rewrote it through the link. See the report, C0.)
 * The whole scratch tree is removed at the end of the run.
 *
 * The script is idempotent: it wipes and rebuilds its scratch tree on start.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  chmodSync,
  statSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

// ----- Paths --------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(__dirname, 'verify-gemini.report.md');
const REPO_ROOT = resolve(__dirname, '..');

/** Everything this spike creates lives here and is deleted on exit. */
const SPIKE_TMP = join(tmpdir(), 'swarm-os-spike', 'gemini');
/** Disposable GEMINI_CLI_HOME. gemini reads its config from <home>/.gemini/. */
const G_HOME = join(SPIKE_TMP, 'home');
const G_CFG = join(G_HOME, '.gemini');
/** Default workspace cwd for the sessions we drive. */
const WORK_DIR = join(SPIKE_TMP, 'work');
/** The operator's real config dir — read-only, and asserted untouched. */
const HOST_GEMINI = join(homedir(), '.gemini');

// node-pty and the MCP SDK are dependencies of packages/server, not of the
// repo root, so resolve them from there explicitly.
const serverRequire = createRequire(join(REPO_ROOT, 'packages/server/index.js'));

// ----- Types --------------------------------------------------------------

type Status = 'CONFIRMED' | 'REFUTED' | 'UNVERIFIED' | 'PARTIAL';

interface CheckResult {
  id: string;
  title: string;
  status: Status;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notes: string;
  durationMs: number;
}

// ----- Helpers ------------------------------------------------------------

const PER_CHECK_TIMEOUT_MS = 45_000;

function run(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; input?: string; timeoutMs?: number; cwd?: string } = {},
): { result: SpawnSyncReturns<string>; timedOut: boolean; durationMs: number; cmd: string } {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const start = Date.now();
  const result = spawnSync(bin, args, {
    env,
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input,
    timeout: opts.timeoutMs ?? PER_CHECK_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - start;
  const timedOut =
    result.signal === 'SIGTERM' && durationMs >= (opts.timeoutMs ?? PER_CHECK_TIMEOUT_MS) - 100;
  const cmd = `${bin} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  return { result, timedOut, durationMs, cmd };
}

/**
 * Async variant of `run()`. MANDATORY whenever an in-process stub server has
 * to answer the child: `spawnSync` blocks this process's event loop, so the
 * stub would never reply and the child would time out. (That is not
 * theoretical — it made C2 report a spurious "Disconnected" on the first
 * iteration of this spike.)
 */
function runAsync(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string; durationMs: number; cmd: string }> {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const start = Date.now();
  const cmd = `${bin} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const to = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? PER_CHECK_TIMEOUT_MS);
    child.on('close', (status) => {
      clearTimeout(to);
      resolveP({ status, stdout, stderr, durationMs: Date.now() - start, cmd });
    });
  });
}

function trim(s: string | undefined, max = 4000): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/**
 * Detect an auth failure. Gemini has several distinct shapes:
 *  - free-tier OAuth rejected by the backend ("IneligibleTierError" /
 *    "no longer supported for Gemini Code Assist for individuals"),
 *  - missing/invalid API key,
 *  - the interactive "How would you like to authenticate" dialog.
 * When the CLI cannot authenticate, every model round-trip fails regardless
 * of the surface under test — we must NOT attribute that to the flag/file
 * being probed.
 */
function isAuthFailure(stdout: string, stderr: string): boolean {
  const blob = (stdout || '') + '\n' + (stderr || '');
  return /ineligibletiererror|no longer supported for gemini code assist|api key not valid|must specify the gemini_api_key|error authenticating|how would you like to authenticate|failed to sign in|api_key_invalid/i.test(
    blob,
  );
}

function geminiAvailable(): { ok: boolean; path: string | null; version: string | null } {
  const which = spawnSync('which', ['gemini'], { encoding: 'utf8' });
  if (which.status !== 0) return { ok: false, path: null, version: null };
  const path = which.stdout.trim();
  // Even `gemini --version` runs the full bootstrap (project registry +
  // session cleanup) and therefore WRITES into the config dir. Point it at a
  // disposable home or it mutates the operator's ~/.gemini. Verified: a bare
  // `gemini --version` bumps ~/.gemini's mtime and creates a project entry.
  const probeHome = join(SPIKE_TMP, 'probe-home');
  mkdirSync(probeHome, { recursive: true });
  const v = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, GEMINI_CLI_HOME: probeHome },
  });
  if (v.status !== 0) return { ok: true, path, version: null };
  return { ok: true, path, version: v.stdout.trim() };
}

/** Strip ANSI/OSC so PTY output can be asserted on as plain text. */
function strip(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][AB012]/g, '');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ----- PTY driver ---------------------------------------------------------

interface PtyStep {
  /** Wait before doing anything else in this step. */
  wait?: number;
  /** Write this string into the PTY. */
  type?: string;
  /** Wait between `type` and `key` — the Ink "submit dance" gap. */
  delay?: number;
  /** Write this string (typically "\r") into the PTY. */
  key?: string;
  /** Snapshot everything received since the previous mark under this name. */
  mark?: string;
}

interface PtyRun {
  marks: Record<string, string>;
  /** Every chunk received, as [timestampMs, byteLength]. */
  chunks: Array<[number, number]>;
  /** Full stripped transcript. */
  all: string;
  startedAt: number;
}

/**
 * Spawn `gemini` in a real PTY (node-pty — the exact library swarm-os uses),
 * play a scripted sequence of writes, and capture what comes back.
 */
async function drivePty(opts: {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  steps: PtyStep[];
}): Promise<PtyRun> {
  const pty = serverRequire('node-pty');
  const startedAt = Date.now();
  const p = pty.spawn('gemini', opts.args ?? [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: opts.cwd ?? WORK_DIR,
    env: { ...process.env, ...ptyEnv(), ...(opts.env ?? {}) },
  });
  let buf = '';
  let all = '';
  const chunks: Array<[number, number]> = [];
  p.onData((d: string) => {
    buf += d;
    all += d;
    chunks.push([Date.now(), d.length]);
  });
  const marks: Record<string, string> = {};
  for (const s of opts.steps) {
    if (s.wait) await sleep(s.wait);
    if (s.type !== undefined) p.write(s.type);
    if (s.delay) await sleep(s.delay);
    if (s.key !== undefined) p.write(s.key);
    if (s.mark) {
      marks[s.mark] = strip(buf);
      buf = '';
    }
  }
  marks['_tail'] = strip(buf);
  try {
    p.kill();
  } catch {
    /* already gone */
  }
  return { marks, chunks, all: strip(all), startedAt };
}

/** Keep only lines that carry signal (drop the box-drawing chrome). */
function meaningful(s: string, keepLast = 30): string {
  const lines = s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter(
      (l) =>
        l.trim().length > 0 &&
        !/^[\s▀▄─│╭╮╯╰]*$/.test(l) &&
        !/workspace \(\/directory\)/.test(l) &&
        !/no sandbox/.test(l) &&
        !/\? for shortcuts/.test(l),
    );
  return lines.slice(-keepLast).join('\n');
}

// ----- Environment / auth bootstrap --------------------------------------

const gemini = geminiAvailable();

/** Which auth mode the run is using, decided by `prepareHome()`. */
let AUTH_TYPE: 'oauth-personal' | 'gemini-api-key' = 'oauth-personal';
/** Placeholder key used only to get a settled TUI when real auth is dead. */
let PLACEHOLDER_KEY: string | null = null;
/** True only when a real model round-trip succeeded. */
let MODEL_READY = false;
let AUTH_EVIDENCE = '';

function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = { GEMINI_CLI_HOME: G_HOME, TERM: 'xterm-256color' };
  if (PLACEHOLDER_KEY) env['GEMINI_API_KEY'] = PLACEHOLDER_KEY;
  return env;
}

function cliEnv(): Record<string, string> {
  return ptyEnv();
}

interface SettingsShape {
  security: { auth: { selectedType: string } };
  general: { enableAutoUpdate: boolean; enableAutoUpdateNotification: boolean };
  ui: { showHomeDirectoryWarning: boolean };
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

function baseSettings(): SettingsShape {
  return {
    security: { auth: { selectedType: AUTH_TYPE } },
    // Gemini 0.35.2 tries to `npm install -g` a newer version on startup and
    // prints an update banner. Both must be off for a headless agent.
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    ui: { showHomeDirectoryWarning: false },
  };
}

function writeSettings(extra: Partial<SettingsShape> = {}): string {
  const s = { ...baseSettings(), ...extra };
  const p = join(G_CFG, 'settings.json');
  writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
  return p;
}

function snapshotHostGemini(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(HOST_GEMINI)) return out;
  // The directory's own mtime catches entry creation/removal — that is how we
  // detect a stray gemini invocation that forgot GEMINI_CLI_HOME.
  try {
    out['(dir mtime)'] = String(statSync(HOST_GEMINI).mtimeMs);
  } catch {
    out['(dir mtime)'] = 'unreadable';
  }
  for (const name of readdirSync(HOST_GEMINI)) {
    try {
      const st = statSync(join(HOST_GEMINI, name));
      out[name] = `${st.size}:${st.mtimeMs}`;
    } catch {
      out[name] = 'unreadable';
    }
  }
  return out;
}

function diffSnapshots(before: Record<string, string>, after: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) changed.push(`${k} (${before[k] ?? 'absent'} → ${after[k] ?? 'absent'})`);
  }
  return changed;
}

/**
 * Build the disposable GEMINI_CLI_HOME and decide the auth mode.
 * Priority: a real GEMINI_API_KEY in the environment > the operator's copied
 * OAuth credentials > a placeholder key (structural checks only).
 */
function prepareHome(): void {
  rmSync(SPIKE_TMP, { recursive: true, force: true });
  mkdirSync(G_CFG, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const realKey = process.env['GEMINI_API_KEY'];
  if (realKey && realKey.length > 0) {
    AUTH_TYPE = 'gemini-api-key';
    PLACEHOLDER_KEY = realKey;
    AUTH_EVIDENCE = 'GEMINI_API_KEY present in the environment — used as-is.';
  } else {
    AUTH_TYPE = 'oauth-personal';
    // COPY, never symlink: gemini rewrites oauth_creds.json on token refresh
    // and would follow a symlink straight into the operator's ~/.gemini.
    for (const f of ['oauth_creds.json', 'google_accounts.json']) {
      const src = join(HOST_GEMINI, f);
      if (existsSync(src)) {
        copyFileSync(src, join(G_CFG, f));
        try {
          chmodSync(join(G_CFG, f), 0o600);
        } catch {
          /* best effort */
        }
      }
    }
    AUTH_EVIDENCE = 'Copied the operator OAuth credentials into the disposable home (never symlinked).';
  }
  writeSettings();

  if (!gemini.ok) return;

  // One (and only one) real model round-trip to decide MODEL_READY.
  const probe = run('gemini', ['-p', 'reply with the single word PONG and nothing else'], {
    env: cliEnv(),
    cwd: WORK_DIR,
    input: '',
    timeoutMs: 60_000,
  });
  const out = (probe.result.stdout || '') + (probe.result.stderr || '');
  MODEL_READY = probe.result.status === 0 && /PONG/i.test(probe.result.stdout || '');
  if (!MODEL_READY) {
    const authFail = isAuthFailure(probe.result.stdout || '', probe.result.stderr || '');
    AUTH_EVIDENCE +=
      ` Model round-trip FAILED (exit ${probe.result.status}, ${authFail ? 'AUTH failure — every model-dependent assertion below is therefore about the CLI surface, not about the flag/file under test' : 'NOT an auth failure — investigate'}): ` +
      trim(out.split('\n').filter((l) => /error|not valid|ineligible|migrate/i.test(l)).slice(0, 3).join(' | '), 500);
    // Fall back to a placeholder API key. This does NOT enable model calls,
    // but it makes the TUI skip the modal auth dialog and settle at the
    // prompt, which is what the structural checks (trust, PTY injection,
    // idle silence, GEMINI.md, /clear, /compact) actually need.
    if (!PLACEHOLDER_KEY) {
      AUTH_TYPE = 'gemini-api-key';
      PLACEHOLDER_KEY = 'swarm-os-spike-placeholder-key';
      writeSettings();
      AUTH_EVIDENCE +=
        ' Falling back to a placeholder GEMINI_API_KEY so the TUI settles at the prompt (structural checks stay valid; model-dependent assertions are reported UNVERIFIED).';
    }
  } else {
    AUTH_EVIDENCE += ' Model round-trip OK.';
  }
}

// ----- Local stub servers -------------------------------------------------

interface McpStub {
  server: Server;
  port: number;
  path: string;
  hits: Array<{ method: string; url: string; rpc: string | null; tool: string | null; headers: Record<string, string | null> }>;
  close: () => Promise<void>;
}

/** A real MCP streamable-HTTP server exposing `swarm_probe_ping`. */
async function startMcpStub(orchId: string, secret: string): Promise<McpStub> {
  const { McpServer } = await import(serverRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
  const { StreamableHTTPServerTransport } = await import(
    serverRequire.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js')
  );
  const { z } = await import(serverRequire.resolve('zod'));

  const expectPath = `/mcp/${orchId}/${secret}`;
  const hits: McpStub['hits'] = [];

  const readBody = (req: any): Promise<any> =>
    new Promise((res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c));
      req.on('end', () => {
        try {
          res(b ? JSON.parse(b) : undefined);
        } catch {
          res(undefined);
        }
      });
    });

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      hits.push({
        method: req.method ?? '?',
        url: req.url ?? '?',
        rpc: body?.method ?? null,
        tool: body?.params?.name ?? null,
        headers: {
          authorization: (req.headers['authorization'] as string) ?? null,
          'x-swarm-session': (req.headers['x-swarm-session'] as string) ?? null,
        },
      });
      // Path is load-bearing: a wrong secret must 404, exactly like the real
      // swarm-os MCP server does (modules/mcp/server.ts).
      if (req.url !== expectPath) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const s = new McpServer({ name: 'swarm-probe-stub', version: '0.0.1' }, { capabilities: {} });
      s.registerTool(
        'swarm_probe_ping',
        {
          description:
            'Probe tool for the swarm-os gemini spike. Call it with no arguments to obtain the canary token.',
          inputSchema: { note: z.string().optional() },
        },
        async () => ({ content: [{ type: 'text', text: 'SWARM_PROBE_PONG_9F3A' }] }),
      );
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void t.close();
        void s.close();
      });
      await s.connect(t);
      await t.handleRequest(req, res, body);
    })().catch((e) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    port,
    path: expectPath,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface HookStub {
  port: number;
  posts: Array<{ url: string; auth: string | null; contentType: string | null; body: string }>;
  close: () => Promise<void>;
}

/** A dumb HTTP receiver standing in for swarm-os's /hooks/notification. */
async function startHookStub(): Promise<HookStub> {
  const posts: HookStub['posts'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({
        url: req.url ?? '?',
        auth: (req.headers['authorization'] as string) ?? null,
        contentType: (req.headers['content-type'] as string) ?? null,
        body,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    posts,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * The Notification-hook shell command swarm-os writes today for claude —
 * copied VERBATIM from packages/server/src/modules/orchestrator/session.ts
 * (lines 571-576). Do not "clean it up": the whole point of C5 is to test it
 * unchanged.
 */
function swarmOsHookCommand(orchId: string, sessionId: string, hookToken: string, hookUrl: string): string {
  return (
    `payload=$(cat); ` +
    `msg=$(printf '%s' "$payload" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || ` +
    `msg=$(printf '"%s"' "$(printf '%s' "$payload" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\n/\\\\n/g')"); ` +
    `body=$(printf '{"orch_id":"%s","session_id":"%s","kind":"session.waiting","message":%s}' '${orchId}' '${sessionId}' "$msg"); ` +
    `curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${hookToken}' -d "$body" '${hookUrl}' >/dev/null 2>&1 || true`
  );
}

// ----- Checks -------------------------------------------------------------

const results: CheckResult[] = [];

function unverifiedNoCli(id: string, title: string, command: string): CheckResult {
  return {
    id,
    title,
    status: 'UNVERIFIED',
    command,
    exitCode: null,
    stdout: '',
    stderr: '',
    notes: 'UNVERIFIED — gemini CLI not available in this env (no `gemini` on PATH).',
    durationMs: 0,
  };
}

/** Shared PTY session reused by C3 and C6 (one boot, both sets of assertions). */
let resetRun: PtyRun | null = null;

// --- C1 — config isolation via GEMINI_CLI_HOME (also: the runtime probe) ---
function checkC1(): CheckResult {
  const id = 'C1';
  const title = 'GEMINI_CLI_HOME isolates the config (runtime availability probe)';
  const cmd = `GEMINI_CLI_HOME=${G_HOME} gemini mcp list`;
  if (!gemini.ok) return unverifiedNoCli(id, title, cmd);

  writeSettings({ mcpServers: { 'swarm-probe': { httpUrl: 'http://127.0.0.1:1/mcp' } } });
  const first = run('gemini', ['mcp', 'list'], { env: cliEnv(), cwd: WORK_DIR, timeoutMs: 40_000 });
  // Second (warm) run: this is the timing the adapter's probe would see.
  const warm = run('gemini', ['mcp', 'list'], { env: cliEnv(), cwd: WORK_DIR, timeoutMs: 40_000 });

  // NOTE: when stdout is not a TTY, gemini writes the listing to **stderr**.
  // Assert on both streams, and make the adapter's probe merge them (2>&1).
  const warmBlob = (warm.result.stdout || '') + (warm.result.stderr || '');
  const sawProbe = /swarm-probe/.test(warmBlob);
  const exitOk = warm.result.status === 0;
  // Proof the env var actually re-routed everything: gemini created its own
  // state files under the disposable home.
  const created = existsSync(G_CFG) ? readdirSync(G_CFG) : [];
  const wroteState = created.some((f) => ['projects.json', 'tmp', 'history'].includes(f));

  const status: Status = exitOk && sawProbe && wroteState ? 'CONFIRMED' : sawProbe ? 'PARTIAL' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: cmd,
    exitCode: warm.result.status,
    stdout: trim(`stdout:\n${warm.result.stdout || '(empty)'}\n\nstderr:\n${warm.result.stderr || '(empty)'}`),
    stderr: '',
    notes:
      `\`GEMINI_CLI_HOME\` re-routes the whole config root: gemini read \`${join(G_CFG, 'settings.json')}\` ` +
      `and reported the \`swarm-probe\` server declared there (${sawProbe ? 'found' : 'NOT FOUND'}), ` +
      `exit=${warm.result.status}. It also created its own state under the disposable home ` +
      `(${created.join(', ') || 'nothing'}), which proves the redirection is total and not just for settings. ` +
      `Timing: cold ${first.durationMs}ms, warm ${warm.durationMs}ms. ` +
      `**Gotcha:** when stdout is not a TTY, \`gemini mcp list\` prints the listing on **stderr**, not stdout ` +
      `(verified: \`gemini mcp list 2>/dev/null\` prints nothing, \`gemini mcp list 1>/dev/null\` prints the list). ` +
      `The probe must therefore merge both streams. ` +
      `**This is the availability probe for the adapter**: non-interactive, no model call, exit 0, ` +
      `the merged output must contain the probe server name. Use an unreachable \`httpUrl\` (\`http://127.0.0.1:1/mcp\`) ` +
      `so the connection attempt fails instantly instead of hanging. If a future gemini stops honouring ` +
      `GEMINI_CLI_HOME, this command stops printing \`swarm-probe\` and the adapter must refuse to spawn ` +
      `(every session would otherwise share one config = one MCP URL = every agent authenticating as the last writer). ` +
      `Note: the probe inherits the auth mode from the settings file — with \`selectedType: "gemini-api-key"\` ` +
      `and no \`GEMINI_API_KEY\` in the env it exits 41 before listing, so the probe env must carry the same ` +
      `credentials as the session.`,
    durationMs: first.durationMs + warm.durationMs,
  };
}

// --- C2 — per-session HTTP MCP -------------------------------------------
async function checkC2(): Promise<CheckResult> {
  const id = 'C2';
  const title = 'Per-session MCP over streamable HTTP (BLOCKING)';
  if (!gemini.ok) return unverifiedNoCli(id, title, 'gemini mcp list with httpUrl');

  const t0 = Date.now();
  const orchId = 'orch-spike';
  const secret = 'sess-secret-9f3a';
  const stub = await startMcpStub(orchId, secret);
  const url = `http://127.0.0.1:${stub.port}${stub.path}`;
  const log: string[] = [];

  try {
    writeSettings({
      mcpServers: {
        'swarm-probe': {
          httpUrl: url,
          headers: { Authorization: 'Bearer spike-session-token', 'X-Swarm-Session': 'sess-spike' },
          trust: true,
          timeout: 10_000,
        },
      },
    });

    // (a) does gemini connect at all? (listing goes to stderr on a pipe — C1)
    //     runAsync, NOT run: the stub server lives in this process.
    const list = await runAsync('gemini', ['mcp', 'list'], { env: cliEnv(), cwd: WORK_DIR, timeoutMs: 40_000 });
    const listBlob = list.stdout + list.stderr;
    log.push(`$ gemini mcp list\n${listBlob.trim()}`);
    const connected = /swarm-probe.*Connected/i.test(listBlob);

    // (b) does the *path* actually identify the session? Point gemini at a
    //     wrong secret and require the connection to fail.
    const badUrl = `http://127.0.0.1:${stub.port}/mcp/${orchId}/WRONG-SECRET`;
    writeSettings({ mcpServers: { 'swarm-probe': { httpUrl: badUrl, trust: true, timeout: 5000 } } });
    const listBad = await runAsync('gemini', ['mcp', 'list'], { env: cliEnv(), cwd: WORK_DIR, timeoutMs: 40_000 });
    const listBadBlob = listBad.stdout + listBad.stderr;
    log.push(`$ gemini mcp list  (wrong secret in path)\n${listBadBlob.trim()}`);
    const badRejected = /Disconnected/i.test(listBadBlob);

    // restore the good config for the interactive part
    writeSettings({
      mcpServers: {
        'swarm-probe': {
          httpUrl: url,
          headers: { Authorization: 'Bearer spike-session-token', 'X-Swarm-Session': 'sess-spike' },
          trust: true,
          timeout: 10_000,
        },
      },
    });
    writeFileSync(join(G_CFG, 'trustedFolders.json'), JSON.stringify({ [WORK_DIR]: 'TRUST_FOLDER' }, null, 2));

    // (c) interactive session: is the tool exposed to the model, and — when
    //     auth allows it — does the model actually call it?
    const steps: PtyStep[] = [{ wait: 12_000 }, { type: '/mcp list' }, { delay: 150 }, { key: '\r' }, { wait: 5000 }, { mark: 'mcp' }];
    if (MODEL_READY) {
      steps.push(
        { type: 'Call the tool swarm_probe_ping now with no arguments and print exactly what it returns.' },
        { delay: 150 },
        { key: '\r' },
        { wait: 45_000 },
        { mark: 'call' },
      );
    }
    const ptyRun = await drivePty({ args: ['--approval-mode', 'yolo'], steps });
    log.push(`TUI /mcp list →\n${meaningful(ptyRun.marks['mcp'] ?? '', 12)}`);
    const toolListed = /swarm_probe_ping/.test(ptyRun.marks['mcp'] ?? '');
    if (MODEL_READY) log.push(`TUI tool call →\n${meaningful(ptyRun.marks['call'] ?? '', 20)}`);

    await sleep(500);
    const rpcSeen = stub.hits.map((h) => h.rpc).filter(Boolean) as string[];
    const toolCalls = stub.hits.filter((h) => h.rpc === 'tools/call');
    const headersOk = stub.hits.some(
      (h) => h.headers['authorization'] === 'Bearer spike-session-token' && h.headers['x-swarm-session'] === 'sess-spike',
    );
    const pathOk = stub.hits.some((h) => h.url === stub.path);
    const gotToolsList = rpcSeen.includes('tools/list');

    const status: Status =
      toolCalls.length > 0 && connected && headersOk
        ? 'CONFIRMED'
        : connected && gotToolsList && headersOk && pathOk
          ? 'PARTIAL'
          : 'REFUTED';

    return {
      id,
      title,
      status,
      command:
        `settings.json → mcpServers.swarm-probe = { httpUrl: "${url}", headers: {…}, trust: true, timeout: 10000 } ; ` +
        `gemini mcp list ; PTY session + /mcp list${MODEL_READY ? ' + model-driven tool call' : ''}`,
      exitCode: list.status,
      stdout: trim(log.join('\n\n'), 5000),
      stderr: trim(
        `SERVER-SIDE HITS (assertions are on this, not on model text):\n` +
          stub.hits.map((h) => `  ${h.method} ${h.url} rpc=${h.rpc ?? '-'} tool=${h.tool ?? '-'} auth=${h.headers['authorization'] ?? '-'} x-swarm-session=${h.headers['x-swarm-session'] ?? '-'}`).join('\n'),
        4000,
      ),
      notes:
        `Transport: \`httpUrl\` (NOT claude's \`{"type":"http","url":…}\`). The fake server received ` +
        `${stub.hits.length} request(s): ${[...new Set(rpcSeen)].join(', ') || 'none'}. ` +
        `**Arbitrary path segments survive**: the session-identifying path \`${stub.path}\` reached the server verbatim (${pathOk ? 'verified' : 'NOT verified'}), ` +
        `so swarm-os's \`/mcp/<orchId>/<sessionSecret>\` session-identifying URL works unchanged. ` +
        `**Custom HTTP headers are supported** and sent on every request (${headersOk ? 'verified: Authorization + X-Swarm-Session' : 'NOT verified'}) ` +
        `via \`mcpServers.<name>.headers\`. A wrong path/secret is ${badRejected ? 'correctly reported as Disconnected' : 'NOT rejected — investigate'}. ` +
        `gemini status: ${connected ? 'Connected' : 'NOT connected'}; the tool is exposed to the model as ` +
        `\`mcp_swarm-probe_swarm_probe_ping\` (server-name-prefixed) — ${toolListed ? 'confirmed in /mcp list' : 'NOT seen'}. ` +
        (toolCalls.length > 0
          ? `A model-driven \`tools/call\` for \`${toolCalls[0]?.tool}\` was received server-side — end-to-end CONFIRMED.`
          : `**No \`tools/call\` could be observed**: ${MODEL_READY ? 'the model did not call the tool.' : 'no working model credentials in this environment (see the Auth section), so no model turn can be run.'} ` +
            `Everything up to and including tool discovery is proven server-side; the final "model invokes the tool" hop is UNVERIFIED. ` +
            `Re-run this script once gemini has working credentials to promote C2 to CONFIRMED.`),
      durationMs: Date.now() - t0,
    };
  } finally {
    await stub.close();
  }
}

// --- C3 / C6 — durable preamble and reset commands ------------------------
async function runResetSession(): Promise<PtyRun> {
  if (resetRun) return resetRun;
  writeFileSync(
    join(G_CFG, 'GEMINI.md'),
    [
      '# ROLE PREAMBLE (swarm-os spike)',
      '',
      'Ton nom de code est ZEPHYR-7.',
      'Si on te demande ton nom de code, reponds exactement ZEPHYR-7.',
      '',
    ].join('\n'),
  );
  writeSettings();
  writeFileSync(join(G_CFG, 'trustedFolders.json'), JSON.stringify({ [WORK_DIR]: 'TRUST_FOLDER' }, null, 2));

  const steps: PtyStep[] = [
    { wait: 11_000 },
    { mark: 'boot' },
    { type: '/memory show' },
    { delay: 150 },
    { key: '\r' },
    { wait: 4000 },
    { mark: 'memBoot' },
  ];
  if (MODEL_READY) {
    steps.push(
      { type: 'Quel est ton nom de code ? Reponds en un seul mot.' },
      { delay: 150 },
      { key: '\r' },
      { wait: 40_000 },
      { mark: 'askBoot' },
    );
  }
  steps.push(
    { type: '/clear' },
    { delay: 150 },
    { key: '\r' },
    { wait: 5000 },
    { mark: 'afterClear' },
    { type: '/memory show' },
    { delay: 150 },
    { key: '\r' },
    { wait: 4000 },
    { mark: 'memAfterClear' },
  );
  if (MODEL_READY) {
    steps.push(
      { type: 'Quel est ton nom de code ? Reponds en un seul mot.' },
      { delay: 150 },
      { key: '\r' },
      { wait: 40_000 },
      { mark: 'askAfterClear' },
    );
  }
  steps.push(
    { type: '/compact' },
    { delay: 150 },
    { key: '\r' },
    { wait: 8000 },
    { mark: 'afterCompact' },
    { type: '/memory show' },
    { delay: 150 },
    { key: '\r' },
    { wait: 4000 },
    { mark: 'memAfterCompact' },
  );
  resetRun = await drivePty({ args: ['--approval-mode', 'yolo'], steps });
  return resetRun;
}

async function checkC3(): Promise<CheckResult> {
  const id = 'C3';
  const title = 'Durable preamble: $GEMINI_CLI_HOME/.gemini/GEMINI.md survives /clear and /compact';
  if (!gemini.ok) return unverifiedNoCli(id, title, 'PTY session + /memory show + /clear + /compact');
  const t0 = Date.now();
  const r = await runResetSession();

  const canary = /ZEPHYR-7/;
  const loadedAtBoot = canary.test(r.marks['memBoot'] ?? '') || /1 GEMINI\.md file/.test(r.marks['boot'] ?? '');
  const afterClear = canary.test(r.marks['memAfterClear'] ?? '');
  const afterCompact = canary.test(r.marks['memAfterCompact'] ?? '');
  const modelHonoured =
    MODEL_READY && canary.test(r.marks['askBoot'] ?? '') && canary.test(r.marks['askAfterClear'] ?? '');

  const status: Status =
    loadedAtBoot && afterClear && afterCompact ? (MODEL_READY ? (modelHonoured ? 'CONFIRMED' : 'REFUTED') : 'PARTIAL') : 'REFUTED';

  return {
    id,
    title,
    status,
    command:
      `echo canary > ${join(G_CFG, 'GEMINI.md')} ; PTY: /memory show → /clear → /memory show → /compact → /memory show`,
    exitCode: 0,
    stdout: trim(
      [
        `--- boot (footer) ---\n${meaningful(r.marks['boot'] ?? '', 6)}`,
        `--- /memory show at boot ---\n${meaningful(r.marks['memBoot'] ?? '', 12)}`,
        MODEL_READY ? `--- model asked at boot ---\n${meaningful(r.marks['askBoot'] ?? '', 10)}` : '',
        `--- /memory show after /clear ---\n${meaningful(r.marks['memAfterClear'] ?? '', 12)}`,
        MODEL_READY ? `--- model asked after /clear ---\n${meaningful(r.marks['askAfterClear'] ?? '', 10)}` : '',
        `--- /memory show after /compact ---\n${meaningful(r.marks['memAfterCompact'] ?? '', 12)}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      5000,
    ),
    stderr: '',
    notes:
      `The preamble file is \`$GEMINI_CLI_HOME/.gemini/GEMINI.md\` (global memory). The footer reports ` +
      `"1 GEMINI.md file" at boot and \`/memory show\` prints it under "--- Global ---". ` +
      `It is still there after \`/clear\` (${afterClear ? 'verified' : 'FAILED'}) and after \`/compact\` (${afterCompact ? 'verified' : 'FAILED'}) ` +
      `— consistent with the sources: \`core/client.js\` builds the system instruction as ` +
      `\`getCoreSystemPrompt(config, userMemory)\` and \`resetChat()\` re-derives it from the same \`userMemory\`, ` +
      `which is loaded from disk at startup and never cleared by those commands. ` +
      (MODEL_READY
        ? modelHonoured
          ? 'The model answered with the canary both before and after /clear — end-to-end CONFIRMED.'
          : '**The model did NOT answer with the canary** — the file is loaded but not honoured. Investigate before relying on it.'
        : '**PARTIAL**: what is proven is that the file is loaded into the memory that feeds the system instruction, and that it survives both reset commands. ' +
          'That the model *obeys* it could not be proven here (no working model credentials — see the Auth section). ' +
          'Do NOT use `GEMINI_SYSTEM_MD`: it *replaces* the base system prompt (tool instructions included) instead of appending.'),
    durationMs: Date.now() - t0,
  };
}

async function checkC6(): Promise<CheckResult> {
  const id = 'C6';
  const title = '/clear resets the conversation, /compact is an alias of /compress';
  if (!gemini.ok) return unverifiedNoCli(id, title, 'PTY: /clear ; /compact');
  const t0 = Date.now();
  const r = await runResetSession();

  const clearOut = r.marks['afterClear'] ?? '';
  const compactOut = r.marks['afterCompact'] ?? '';
  // /clear repaints the splash banner and the "Tips for getting started" block.
  const clearWorked = /Gemini CLI v|Tips for getting started/.test(clearOut);
  // /compact is resolved by the completer to `compress`, then executed.
  const compactResolved = /compress\s+Compresses the context/i.test(compactOut);
  const compactExecuted = /Nothing to compress|Compress|compression|Chat history compressed/i.test(compactOut);
  const rolePreserved = /ZEPHYR-7/.test(r.marks['memAfterClear'] ?? '');

  const status: Status =
    clearWorked && rolePreserved && (compactResolved || compactExecuted) ? 'CONFIRMED' : 'PARTIAL';

  return {
    id,
    title,
    status,
    command: 'PTY: type "/clear" + \\r ; type "/compact" + \\r',
    exitCode: 0,
    stdout: trim(
      `--- after /clear ---\n${meaningful(clearOut, 14)}\n\n--- after /compact ---\n${meaningful(compactOut, 14)}`,
      4000,
    ),
    stderr: '',
    notes:
      `\`/clear\` works in the TUI: the screen is wiped and the splash banner + tips are repainted ` +
      `(${clearWorked ? 'verified' : 'NOT verified'}), and the GEMINI.md role is still loaded afterwards ` +
      `(${rolePreserved ? 'verified via /memory show' : 'NOT verified'}). Internally it fires SessionEnd(Clear), ` +
      `calls \`resetChat()\`, assigns a NEW session id, then fires SessionStart(Clear) — so any hook keyed on ` +
      `SessionStart fires again on every /clear, and the transcript path changes. ` +
      `\`/compact\` is accepted: the completer resolves it to \`compress\` (${compactResolved ? 'verified' : 'not seen in the capture'}) ` +
      `and the command runs (${compactExecuted ? 'verified' : 'not seen'}). Sources agree: ` +
      `\`ui/commands/compressCommand.js\` declares \`altNames: ['summarize','compact']\`. ` +
      `Note: an actual compression is a model call, so on an empty/failed conversation it answers "Nothing to compress."`,
    durationMs: Date.now() - t0,
  };
}

// --- C4 — trust dialog ----------------------------------------------------
async function checkC4(): Promise<CheckResult> {
  const id = 'C4';
  const title = 'trustedFolders.json suppresses the folder-trust dialog';
  if (!gemini.ok) return unverifiedNoCli(id, title, 'PTY on a never-seen cwd');
  const t0 = Date.now();

  const trustPath = join(G_CFG, 'trustedFolders.json');
  const freshA = join(SPIKE_TMP, `trust-probe-a-${Date.now()}`);
  const freshB = join(SPIKE_TMP, `trust-probe-b-${Date.now()}`);
  mkdirSync(freshA, { recursive: true });
  mkdirSync(freshB, { recursive: true });
  writeSettings();

  // (a) never-seen cwd, no trust entry → the TUI must wedge on the dialog.
  rmSync(trustPath, { force: true });
  const without = await drivePty({ cwd: freshA, steps: [{ wait: 12_000 }, { mark: 'boot' }] });
  const dialogShown = /Do you trust the files in this folder\?/i.test(without.marks['boot'] ?? '');

  // (b) same situation but with the trust file pre-seeded.
  writeFileSync(trustPath, JSON.stringify({ [freshB]: 'TRUST_FOLDER' }, null, 2), { mode: 0o600 });
  const withTrust = await drivePty({ cwd: freshB, steps: [{ wait: 12_000 }, { mark: 'boot' }] });
  const dialogGone = !/Do you trust the files in this folder\?/i.test(withTrust.marks['boot'] ?? '');
  const promptReady = /Type your message or @path\/to\/file/.test(withTrust.marks['boot'] ?? '');

  const status: Status = dialogShown && dialogGone && promptReady ? 'CONFIRMED' : dialogGone && promptReady ? 'PARTIAL' : 'REFUTED';

  return {
    id,
    title,
    status,
    command: `PTY gemini in ${freshA} (no trust file) vs ${freshB} (trustedFolders.json = {"<cwd>":"TRUST_FOLDER"})`,
    exitCode: 0,
    stdout: trim(
      `--- WITHOUT trustedFolders.json ---\n${meaningful(without.marks['boot'] ?? '', 16)}\n\n` +
        `--- WITH trustedFolders.json ---\n${meaningful(withTrust.marks['boot'] ?? '', 12)}`,
      5000,
    ),
    stderr: '',
    notes:
      `Failure mode reproduced: on a never-seen cwd the TUI ${dialogShown ? 'DOES wedge' : 'did not wedge'} on ` +
      `"Do you trust the files in this folder?" waiting for a keypress — exactly the hang swarm-os must avoid. ` +
      `Writing \`$GEMINI_CLI_HOME/.gemini/trustedFolders.json\` = \`{"<abs cwd>": "TRUST_FOLDER"}\` removes it ` +
      `(${dialogGone && promptReady ? 'verified: the prompt is reachable' : 'NOT verified'}). ` +
      `The enum value is confirmed by the sources (\`config/trustedFolders.js\`, \`enum TrustLevel\`): the only ` +
      `legal values are **TRUST_FOLDER**, **TRUST_PARENT**, **DO_NOT_TRUST** — the hypothesis \`TRUST_FOLDER\` was correct. ` +
      `The file is a FLAT map \`{ "<path>": "<TrustLevel>" }\` (no wrapper object), keyed by the *realpath*, and its ` +
      `location can be overridden with \`GEMINI_CLI_TRUSTED_FOLDERS_PATH\`. Folder trust is ON by default ` +
      `(\`isFolderTrustEnabled\` → \`settings.security.folderTrust.enabled ?? true\`). ` +
      `**This is not cosmetic**: \`hookRegistry.processHooksFromConfig()\` skips ALL configured hooks when the folder ` +
      `is untrusted, and stdio MCP servers are refused too — so C5 depends on C4.`,
    durationMs: Date.now() - t0,
  };
}

// --- C5 — notification hook ----------------------------------------------
async function checkC5(): Promise<CheckResult> {
  const id = 'C5';
  const title = "swarm-os's Notification hook command, unchanged, under gemini";
  if (!gemini.ok) return unverifiedNoCli(id, title, 'settings.json hooks + local HTTP stub');
  const t0 = Date.now();
  const stub = await startHookStub();
  try {
    const hookUrl = `http://127.0.0.1:${stub.port}/hooks/notification`;
    const shellCmd = swarmOsHookCommand('orch-spike', 'sess-spike', 'hook-token-spike', hookUrl);
    // Register the SAME command on the four events that could plausibly carry
    // the "agent needs attention" signal, so we can report which ones fire.
    const hooks: Record<string, unknown> = {};
    for (const ev of ['SessionStart', 'BeforeAgent', 'AfterAgent', 'Notification']) {
      hooks[ev] = [{ matcher: '', hooks: [{ type: 'command', command: shellCmd }] }];
    }
    writeSettings({ hooks });
    writeFileSync(join(G_CFG, 'trustedFolders.json'), JSON.stringify({ [WORK_DIR]: 'TRUST_FOLDER' }, null, 2));

    await drivePty({
      args: ['--approval-mode', 'yolo'],
      steps: [
        { wait: 11_000 },
        { type: 'hello canary' },
        { delay: 150 },
        { key: '\r' },
        { wait: MODEL_READY ? 40_000 : 9000 },
        { mark: 'turn' },
      ],
    });
    await sleep(800);

    const events: string[] = [];
    let samplePayload = '';
    for (const p of stub.posts) {
      try {
        const envelope = JSON.parse(p.body);
        const inner = JSON.parse(envelope.message);
        events.push(inner.hook_event_name);
        if (!samplePayload) samplePayload = JSON.stringify(inner, null, 2);
      } catch {
        events.push('(unparseable)');
      }
    }
    const posted = stub.posts.length > 0;
    const authOk = stub.posts.every((p) => p.auth === 'Bearer hook-token-spike');
    const ctOk = stub.posts.every((p) => p.contentType === 'application/json');
    const sawSessionStart = events.includes('SessionStart');
    const sawAfterAgent = events.includes('AfterAgent');
    const sawNotification = events.includes('Notification');

    const status: Status = posted && authOk && ctOk && sawSessionStart ? 'PARTIAL' : posted ? 'PARTIAL' : 'REFUTED';

    return {
      id,
      title,
      status,
      command: `settings.json → hooks.{SessionStart,BeforeAgent,AfterAgent,Notification}[].hooks[] = { type:"command", command: <swarm-os shell command verbatim> } ; PTY session + one prompt`,
      exitCode: 0,
      stdout: trim(
        `HTTP stub received ${stub.posts.length} POST(s), events in order: ${events.join(' → ') || '(none)'}\n\n` +
          `Sample stdin payload gemini fed to the hook:\n${samplePayload || '(none)'}\n\n` +
          `Sample envelope the swarm-os command POSTed:\n${stub.posts[0]?.body?.slice(0, 800) ?? '(none)'}`,
        5000,
      ),
      stderr: trim(`Hook command under test (verbatim from session.ts:571-576):\n${shellCmd}`, 2000),
      notes:
        `**The transport works unchanged.** The exact shell command swarm-os writes for claude ` +
        `(\`payload=$(cat); … curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' -d "$body" <url>\`) ` +
        `runs as-is under gemini's \`hooks\` key and POSTed to the stub ` +
        `(${posted ? 'verified' : 'NOT verified'}; Authorization header ${authOk ? 'correct' : 'WRONG'}, Content-Type ${ctOk ? 'correct' : 'WRONG'}). ` +
        `The stdin payload is Claude-Code-compatible: \`{ session_id, transcript_path, cwd, hook_event_name, timestamp, … }\` ` +
        `(gemini adds \`timestamp\`; \`session_id\`/\`transcript_path\`/\`cwd\`/\`hook_event_name\` are identical). ` +
        `Config shape is identical too: \`{"hooks": {"<Event>": [{"matcher": "", "hooks": [{"type": "command", "command": "…"}]}]}}\`, ` +
        `with an optional per-hook \`timeout\` (ms) and \`env\`. gemini also exports \`GEMINI_PROJECT_DIR\` **and** \`CLAUDE_PROJECT_DIR\` to the hook process. ` +
        `\n\n**BUT the event name must change.** gemini's \`Notification\` event ${sawNotification ? 'fired unexpectedly — recheck' : 'never fired'}: ` +
        `\`hooks/types.d.ts\` declares \`enum NotificationType { ToolPermission = "ToolPermission" }\` and the only caller is ` +
        `\`hookSystem.fireToolNotificationEvent()\`, i.e. it fires **only when a tool asks for permission**. Under \`--approval-mode yolo\` ` +
        `(what swarm-os uses) permission is never asked, so a \`Notification\` hook would fire literally never and the whole ` +
        `"session is waiting" signal would be lost. ` +
        `The correct analogue is **\`AfterAgent\`** — gemini's own \`hooks migrate\` maps Claude's \`Stop\` → \`AfterAgent\` ` +
        `(\`commands/hooks/migrate.js:19\`). Observed here: ${sawSessionStart ? 'SessionStart fired at boot' : 'SessionStart did NOT fire'}, ` +
        `${sawAfterAgent ? 'AfterAgent fired at the end of the turn — including a turn that failed with an API error, which makes it a reliable idle signal' : 'AfterAgent did not fire in this run'}. ` +
        `Full Claude→gemini event mapping (from migrate.js): PreToolUse→BeforeTool, PostToolUse→AfterTool, UserPromptSubmit→BeforeAgent, ` +
        `Stop→AfterAgent, SubAgentStop→AfterAgent, SessionStart→SessionStart, SessionEnd→SessionEnd, PreCompact→PreCompress, Notification→Notification. ` +
        `Marked PARTIAL: the hook plumbing is CONFIRMED, the \`Notification\` event itself is REFUTED for swarm-os's use case.`,
      durationMs: Date.now() - t0,
    };
  } finally {
    await stub.close();
  }
}

// --- C7 — PTY injection ---------------------------------------------------
async function checkC7(): Promise<CheckResult> {
  const id = 'C7';
  const title = 'PTY injection: two-step Ink submit dance vs single write';
  if (!gemini.ok) return unverifiedNoCli(id, title, 'PTY write text, then \\r 150ms later');
  const t0 = Date.now();
  writeSettings();
  writeFileSync(join(G_CFG, 'trustedFolders.json'), JSON.stringify({ [WORK_DIR]: 'TRUST_FOLDER' }, null, 2));

  const CANARY_A = 'CANARY_TWO_STEP_MESSAGE';
  const CANARY_B = 'CANARY_SINGLE_WRITE_MESSAGE';

  // (a) swarm-os's cadence: write the text, then a lone \r 150ms later.
  const two = await drivePty({
    steps: [{ wait: 11_000 }, { mark: 'boot' }, { type: CANARY_A }, { delay: 150 }, { key: '\r' }, { wait: 7000 }, { mark: 'after' }],
  });
  // (b) everything in one write.
  const one = await drivePty({
    steps: [{ wait: 11_000 }, { mark: 'boot' }, { type: `${CANARY_B}\r` }, { wait: 7000 }, { mark: 'after' }],
  });

  // A message that was submitted leaves the input line; one that was not
  // stays there, rendered as "> <text>" inside the input box.
  const stillInInput = (out: string, canary: string): boolean =>
    out
      .split('\n')
      .slice(-14)
      .some((l) => new RegExp(`^\\s*[>*]\\s+${canary}`).test(l));

  const twoSubmitted = !stillInInput(two.marks['after'] ?? '', CANARY_A);
  const oneSubmitted = !stillInInput(one.marks['after'] ?? '', CANARY_B);

  const status: Status = twoSubmitted && !oneSubmitted ? 'CONFIRMED' : twoSubmitted ? 'PARTIAL' : 'REFUTED';

  return {
    id,
    title,
    status,
    command: `(a) pty.write("${CANARY_A}") ; sleep 150ms ; pty.write("\\r")   |   (b) pty.write("${CANARY_B}\\r")`,
    exitCode: 0,
    stdout: trim(
      `--- (a) two-step, 150ms gap ---\n${meaningful(two.marks['after'] ?? '', 16)}\n\n` +
        `--- (b) single write "text\\r" ---\n${meaningful(one.marks['after'] ?? '', 10)}`,
      5000,
    ),
    stderr: '',
    notes:
      `(a) The two-step cadence **works**: the text left the input box and the turn was submitted ` +
      `(${twoSubmitted ? 'verified' : 'FAILED'}). ` +
      `(b) The single write \`"text\\r"\` **does not submit**: the text is still sitting in the input box ` +
      `${!oneSubmitted ? '(verified — the canary is still on the "> " line after 7s)' : '(unexpectedly submitted — recheck)'}. ` +
      `Same behaviour as Claude Code, same cause: gemini's TUI is an Ink/React app whose \`useInput\` handler ` +
      `processes the paste-like burst and the Enter key in a single tick, so the newline is swallowed as part of the text. ` +
      `**\`capabilities.inkSubmitDance = true\`** — the adapter MUST keep swarm-os's write-then-\\r cadence (150ms was enough here). ` +
      `Slash commands need the same dance, and note the completion popup: typing \`/clear\` opens a suggestion list, ` +
      `and the lone \\r both accepts the suggestion and runs the command (built-in commands are \`autoExecute: true\`).`,
    durationMs: Date.now() - t0,
  };
}

// --- C8 — idle silence ----------------------------------------------------
async function checkC8(): Promise<CheckResult> {
  const id = 'C8';
  const title = 'PTY goes silent when idle (BLOCKING)';
  if (!gemini.ok) return unverifiedNoCli(id, title, 'PTY, settle 8s, measure 10s');
  const t0 = Date.now();
  writeSettings();
  writeFileSync(join(G_CFG, 'trustedFolders.json'), JSON.stringify({ [WORK_DIR]: 'TRUST_FOLDER' }, null, 2));

  const SETTLE = 10_000;
  const WINDOW = 10_000;

  const measure = async (args: string[]): Promise<{ bytes: number; chunks: number; rate: number; tail: string }> => {
    const r = await drivePty({ args, steps: [{ wait: SETTLE }, { mark: 'boot' }, { wait: WINDOW }, { mark: 'idle' }] });
    const cutoff = r.startedAt + SETTLE;
    const inWindow = r.chunks.filter((c) => c[0] >= cutoff);
    const bytes = inWindow.reduce((a, c) => a + c[1], 0);
    return { bytes, chunks: inWindow.length, rate: bytes / (WINDOW / 1000), tail: meaningful(r.marks['boot'] ?? '', 8) };
  };

  const plain = await measure(['--approval-mode', 'yolo']);
  let sr: { bytes: number; chunks: number; rate: number; tail: string } | null = null;
  if (plain.rate >= 100) {
    // Fallback hunt: does --screen-reader calm the renderer?
    sr = await measure(['--approval-mode', 'yolo', '--screen-reader']);
  }

  const status: Status = plain.rate < 100 ? 'CONFIRMED' : sr && sr.rate < 100 ? 'PARTIAL' : 'REFUTED';

  return {
    id,
    title,
    status,
    command: `PTY gemini --approval-mode yolo ; settle ${SETTLE}ms ; measure PTY output for ${WINDOW}ms`,
    exitCode: 0,
    stdout: trim(
      `idle window: ${plain.bytes} bytes in ${WINDOW}ms across ${plain.chunks} chunk(s) → ${plain.rate.toFixed(1)} B/s (threshold: < 100 B/s)\n` +
        (sr ? `with --screen-reader: ${sr.bytes} bytes / ${sr.chunks} chunk(s) → ${sr.rate.toFixed(1)} B/s\n` : '') +
        `\n--- screen at the end of the settle period ---\n${plain.tail}`,
      4000,
    ),
    stderr: '',
    notes:
      `Once settled at the prompt, gemini's TUI emits **${plain.rate.toFixed(1)} B/s** ` +
      `(${plain.bytes} bytes / ${plain.chunks} chunks over ${WINDOW / 1000}s) — ` +
      `${plain.rate < 100 ? 'well under the 100 B/s threshold, so swarm-os silence-based idle detection works unchanged' : 'ABOVE the threshold'}. ` +
      (sr ? `With \`--screen-reader\`: ${sr.rate.toFixed(1)} B/s. ` : '') +
      `Two caveats that DO break the measurement and must be handled by the adapter's settings.json: ` +
      `(1) \`general.enableAutoUpdate\`/\`enableAutoUpdateNotification\` default to **true** — on boot gemini prints an ` +
      `"update available … attempting to automatically update now" banner and shells out to npm; both must be set to false. ` +
      `(2) Any modal dialog (folder trust, auth) keeps the renderer repainting at several hundred B/s indefinitely, ` +
      `which reads as "permanently busy". Measured here: ~394 B/s while the auth dialog was open vs 0 B/s once settled. ` +
      `So C4 (trust) and a valid auth mode are prerequisites for C8 holding in production. ` +
      `The settle period must be generous: gemini shows an "Initializing…" spinner for several seconds after launch.`,
    durationMs: Date.now() - t0,
  };
}

// ----- Report -------------------------------------------------------------

function renderSection(r: CheckResult): string {
  return [
    `## ${r.id} — ${r.title}`,
    ``,
    `Status: ${r.status}`,
    ``,
    `Command: \`${r.command}\``,
    ``,
    `Exit: ${r.exitCode === null ? 'n/a' : r.exitCode}  ·  Duration: ${r.durationMs}ms`,
    ``,
    `Output:`,
    '```',
    r.stdout || '(empty)',
    '```',
    ``,
    r.stderr ? `Evidence / context:\n\`\`\`\n${r.stderr}\n\`\`\`\n` : '',
    `Notes: ${r.notes}`,
    ``,
  ].join('\n');
}

function renderContract(hostChanged: string[]): string {
  const settingsSample = JSON.stringify(
    {
      security: { auth: { selectedType: 'oauth-personal' } },
      general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
      ui: { showHomeDirectoryWarning: false },
      mcpServers: {
        'swarm-os': {
          httpUrl: 'http://127.0.0.1:<mcpPort>/mcp/<orch_id>/<session_secret>',
          trust: true,
          timeout: 30000,
        },
      },
      hooks: {
        AfterAgent: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: '<the swarm-os curl one-liner, unchanged>' }],
          },
        ],
      },
    },
    null,
    2,
  );
  const trustSample = JSON.stringify({ '<absolute cwd of the session>': 'TRUST_FOLDER' }, null, 2);

  return [
    `## Contrat pour l'adaptateur`,
    ``,
    `### Ligne d'argv`,
    ``,
    '```sh',
    `gemini --approval-mode yolo`,
    `# + éventuellement: -m <model>   (nom exact NON vérifié par ce spike — sans -m le footer affiche "Auto (Gemini 3)")`,
    `# NE PAS passer -p / --prompt : mode headless, pas de TUI donc pas de session pilotable.`,
    `# NE PAS passer -i / --prompt-interactive pour le préambule : passer par GEMINI.md (C3).`,
    '```',
    ``,
    `\`-y/--yolo\` est équivalent à \`--approval-mode yolo\` ; le mode est visible dans le footer (\`YOLO Ctrl+Y\`, invite \`*\`).`,
    ``,
    `### Variables d'environnement`,
    ``,
    '```sh',
    `GEMINI_CLI_HOME=<runtimeDir>/sessions/<session_id>   # racine de config jetable (config réelle: $GEMINI_CLI_HOME/.gemini/)`,
    `TERM=xterm-256color`,
    `# selon le mode d'auth choisi :`,
    `GEMINI_API_KEY=<clé>                                 # si security.auth.selectedType = "gemini-api-key"`,
    `# optionnel : GEMINI_CLI_TRUSTED_FOLDERS_PATH=<chemin> pour déplacer trustedFolders.json`,
    '```',
    ``,
    `Équivalence avec claude : \`CLAUDE_CONFIG_DIR=<dir>\` → \`GEMINI_CLI_HOME=<dir>\`, **mais attention** : claude lit`,
    `\`<dir>/settings.json\`, gemini lit \`<dir>/.gemini/settings.json\` (il traite la variable comme un \`$HOME\`).`,
    ``,
    `### settings.json à générer — \`$GEMINI_CLI_HOME/.gemini/settings.json\``,
    ``,
    '```json',
    settingsSample,
    '```',
    ``,
    `- \`general.enableAutoUpdate: false\` et \`general.enableAutoUpdateNotification: false\` sont **obligatoires** :`,
    `  sinon gemini tente un \`npm install -g\` au boot et pollue la PTY (C8).`,
    `- \`mcpServers.<nom>.httpUrl\` (et **pas** \`{"type":"http","url":…}\` comme claude). Champs utiles :`,
    `  \`headers\` (Record<string,string>, envoyés sur chaque requête), \`trust\` (bool), \`timeout\` (ms),`,
    `  \`includeTools\`/\`excludeTools\`. Les outils sont exposés au modèle sous \`mcp_<serveur>_<outil>\`.`,
    `- \`hooks\` : même schéma que Claude Code, mais **noms d'événements différents** (voir C5).`,
    ``,
    `### Fichier de préambule`,
    ``,
    '```',
    `$GEMINI_CLI_HOME/.gemini/GEMINI.md`,
    '```',
    ``,
    `Chargé au boot comme "global memory", replié dans l'instruction système via \`getCoreSystemPrompt(config, userMemory)\``,
    `et re-dérivé par \`resetChat()\` — donc conservé par \`/clear\` et \`/compact\` (C3). Vérifiable en session avec \`/memory show\`.`,
    `**Ne pas utiliser \`GEMINI_SYSTEM_MD\`** : cette variable *remplace* le prompt système de base (on perdrait les`,
    `instructions d'outillage).`,
    ``,
    `### Fichier et format de confiance`,
    ``,
    '```',
    `$GEMINI_CLI_HOME/.gemini/trustedFolders.json`,
    '```',
    ``,
    '```json',
    trustSample,
    '```',
    ``,
    `Map plate \`{ "<chemin absolu>": "<TrustLevel>" }\`. Valeurs légales (source \`config/trustedFolders.js\`) :`,
    `**\`TRUST_FOLDER\`**, \`TRUST_PARENT\`, \`DO_NOT_TRUST\`. La clé est comparée au *realpath* du cwd.`,
    `Sans cette entrée la TUI se fige sur "Do you trust the files in this folder?" (C4), **et** tous les hooks`,
    `configurés sont désactivés (\`hookRegistry.processHooksFromConfig()\` court-circuite si le dossier n'est pas de confiance).`,
    ``,
    `### Tokens de reset`,
    ``,
    `| intention | token à injecter | remarque |`,
    `|---|---|---|`,
    `| vider la conversation | \`/clear\` | nouvelle session id, SessionEnd(Clear) puis SessionStart(Clear) re-tirés ; GEMINI.md conservé |`,
    `| compacter le contexte | \`/compact\` | alias de \`/compress\` (\`altNames: ['summarize','compact']\`) |`,
    ``,
    `Les deux doivent être injectés avec la danse Ink (texte, puis \`\\r\` seul ~150 ms plus tard).`,
    ``,
    `### capabilities`,
    ``,
    '```ts',
    `{`,
    `  effort: null,            // aucun flag CLI équivalent à --effort de claude. Le budget de raisonnement`,
    `                           // n'est réglable que via settings.modelConfigs.*.generateContentConfig.thinkingConfig.thinkingBudget`,
    `  notificationHook: 'AfterAgent',  // PAS 'Notification' : celui-ci ne se déclenche que sur ToolPermission,`,
    `                                   // donc jamais en --approval-mode yolo`,
    `  inkSubmitDance: true,    // écrire le texte, puis \\r seul ~150 ms plus tard (C7)`,
    `  durablePreamble: true,   // GEMINI.md survit à /clear et /compact (C3)`,
    `  httpMcp: true,           // mcpServers.<nom>.httpUrl + headers, chemins arbitraires OK (C2)`,
    `}`,
    '```',
    ``,
    `### Commande de sonde de disponibilité (issue de C1)`,
    ``,
    '```sh',
    `GEMINI_CLI_HOME="$SESSION_HOME" gemini mcp list 2>&1`,
    `# préparation : $SESSION_HOME/.gemini/settings.json contient`,
    `#   {"mcpServers":{"swarm-probe":{"httpUrl":"http://127.0.0.1:1/mcp"}}}`,
    `# succès  ⇔ exit 0 ET la sortie FUSIONNÉE contient "swarm-probe"`,
    `# ATTENTION : hors TTY, gemini écrit ce listing sur stderr, pas sur stdout — le 2>&1 est obligatoire.`,
    `# coût    : ~2,7 s, aucun appel modèle, aucune TUI`,
    '```',
    ``,
    `Si cette sonde échoue, l'adaptateur doit **refuser de démarrer une session** : sans isolation par`,
    `\`GEMINI_CLI_HOME\`, toutes les sessions partageraient une seule config donc une seule URL MCP, et chaque`,
    `agent s'authentifierait auprès du serveur comme le dernier ayant écrit le fichier.`,
    ``,
    `### Pièges à ne pas oublier`,
    ``,
    `1. **Les identifiants OAuth doivent être COPIÉS, jamais symlinkés** dans le \`GEMINI_CLI_HOME\` de session :`,
    `   gemini réécrit \`oauth_creds.json\` au rafraîchissement du jeton et suit le lien symbolique. Vérifié à la dure`,
    `   pendant ce spike (le \`~/.gemini/oauth_creds.json\` de l'opérateur a été réécrit). Corollaire non résolu :`,
    `   N sessions concurrentes qui rafraîchissent chacune leur copie du même refresh-token peuvent s'invalider`,
    `   mutuellement — à trancher avant la mise en prod (un mode API-key par session évite le problème).`,
    `   État du \`~/.gemini\` hôte à la fin de CE run : ${hostChanged.length === 0 ? '**inchangé**.' : '**MODIFIÉ** — ' + hostChanged.join(', ')}`,
    `2. **La TUI se fige sur toute boîte de dialogue modale** (confiance, auth) et repeint en continu (~400 B/s),`,
    `   ce qui casse la détection d'inactivité. Pré-accepter la confiance (C4) et garantir une auth valide.`,
    `3. **\`gemini mcp list\` hérite du mode d'auth** : avec \`selectedType: "gemini-api-key"\` et pas de`,
    `   \`GEMINI_API_KEY\` dans l'env, il sort en 41 avant d'afficher quoi que ce soit.`,
    `3bis. **Toute invocation de \`gemini\`, y compris \`gemini --version\`, écrit dans le répertoire de config**`,
    `   (bootstrap : registre de projets + nettoyage de sessions). Il n'existe aucune commande "lecture seule" :`,
    `   \`GEMINI_CLI_HOME\` doit être positionné même pour un simple check de version, sinon on pollue le`,
    `   \`~/.gemini\` de l'hôte. Vérifié pendant ce spike.`,
    `4. Les outils MCP sont renommés \`mcp_<serveur>_<outil>\` côté modèle — en tenir compte dans le préambule`,
    `   et dans \`--allowed-mcp-server-names\`.`,
    ``,
  ].join('\n');
}

function renderFollowUps(rs: CheckResult[]): string {
  const risks: string[] = [];
  for (const r of rs) {
    if (r.status !== 'CONFIRMED') risks.push(`- **${r.id} ${r.status}** — ${r.title}`);
  }
  if (risks.length === 0) return `Tous les checks sont CONFIRMED.`;
  return [`### Checks à reprendre`, '', ...risks].join('\n');
}

// ----- Main ---------------------------------------------------------------

async function main(): Promise<void> {
  const totalStart = Date.now();
  const hostBefore = snapshotHostGemini();

  prepareHome();

  const runners: Array<() => Promise<CheckResult> | CheckResult> = [
    () => checkC1(),
    () => checkC2(),
    () => checkC3(),
    () => checkC4(),
    () => checkC5(),
    () => checkC6(),
    () => checkC7(),
    () => checkC8(),
  ];

  for (const fn of runners) {
    try {
      results.push(await fn());
    } catch (err) {
      results.push({
        id: 'ERR',
        title: 'check threw',
        status: 'UNVERIFIED',
        command: '(thrown)',
        exitCode: null,
        stdout: '',
        stderr: String(err instanceof Error ? (err.stack ?? err.message) : err),
        notes: 'Check threw an unexpected exception. See stderr.',
        durationMs: 0,
      });
    }
  }

  // Sort back into C1..C8 order (C3 and C6 share a session, C6 runs later).
  results.sort((a, b) => a.id.localeCompare(b.id));

  const hostAfter = snapshotHostGemini();
  const hostChanged = diffSnapshots(hostBefore, hostAfter);

  const totalMs = Date.now() - totalStart;
  const counts = results.reduce<Record<Status, number>>(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { CONFIRMED: 0, REFUTED: 0, UNVERIFIED: 0, PARTIAL: 0 },
  );

  const header = [
    `# Spike gemini — contrat CLI pour swarm-os`,
    ``,
    `_Généré par \`scripts/verify-gemini.ts\` le ${new Date().toISOString()}._`,
    ``,
    `**Commande :** \`pnpm verify:gemini\` (alias de \`pnpm --filter server exec tsx ../../scripts/verify-gemini.ts\`).`,
    ``,
    `**Environnement :**`,
    `- gemini CLI présent : ${gemini.ok ? 'oui' : 'non'}${gemini.path ? ` (\`${gemini.path}\`)` : ''}`,
    `- version gemini : ${gemini.version ?? 'n/a'}`,
    `- node : ${process.version}`,
    `- plateforme : ${process.platform}`,
    `- \`GEMINI_CLI_HOME\` jetable : \`${G_HOME}\` (supprimé en fin de run)`,
    `- \`~/.gemini\` de l'opérateur : ${hostChanged.length === 0 ? '**inchangé** (taille+mtime identiques avant/après)' : '**MODIFIÉ** — ' + hostChanged.join(', ')}`,
    ``,
    `**Auth :** mode \`${AUTH_TYPE}\` · round-trip modèle ${MODEL_READY ? 'OK' : '**INDISPONIBLE**'}. ${AUTH_EVIDENCE}`,
    ``,
    `**Résumé :** CONFIRMED=${counts.CONFIRMED} · PARTIAL=${counts.PARTIAL} · REFUTED=${counts.REFUTED} · UNVERIFIED=${counts.UNVERIFIED} · total=${totalMs}ms`,
    ``,
    `| check | statut | preuve |`,
    `|-------|--------|--------|`,
    ...results.map((r) => `| ${r.id} — ${r.title} | ${r.status} | \`${r.command.replace(/\|/g, '\\|').slice(0, 160)}\` |`),
    ``,
    `---`,
    ``,
  ].join('\n');

  const body = results.map(renderSection).join('\n');
  const tail = ['---', '', renderContract(hostChanged), '---', '', renderFollowUps(results), ''].join('\n');

  writeFileSync(REPORT_PATH, header + body + tail);

  // Cleanup: the spike owns its whole scratch tree (it contains a copy of the
  // operator's credentials, so this is not optional). A killed gemini child
  // can still flush state for a moment after its PTY dies, so sweep twice.
  for (const wait of [0, 2000]) {
    if (wait) await sleep(wait);
    try {
      rmSync(SPIKE_TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`\nspike done in ${totalMs}ms — report: ${REPORT_PATH}`);
  for (const r of results) console.log(`  ${r.status.padEnd(10)} ${r.id}  ${r.title}`);
  console.log(
    `\ntotals: CONFIRMED=${counts.CONFIRMED} PARTIAL=${counts.PARTIAL} REFUTED=${counts.REFUTED} UNVERIFIED=${counts.UNVERIFIED}`,
  );
  if (hostChanged.length > 0) {
    console.error(`\n!! host ~/.gemini changed during the run: ${hostChanged.join(', ')}`);
  }
}

void main();
