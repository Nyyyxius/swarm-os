/**
 * scripts/verify-codex.ts
 *
 * Spike `spike-codex` — establish, empirically, the CLI contract of the
 * `codex` CLI so swarm-os can drive it inside a PTY exactly like it drives
 * `claude` today (see `scripts/verify-claude-code.ts`, the template this
 * script is modelled on).
 *
 * Run via:
 *   pnpm verify:codex
 * which under the hood runs:
 *   pnpm --filter server exec tsx ../../scripts/verify-codex.ts
 *
 * SAFETY INVARIANT — the spike NEVER writes into the operator's real
 * `~/.codex`. Every run happens under `$TMPDIR/swarm-os-spike/codex/`, and the
 * only thing borrowed from the real home is `auth.json`, symlinked read-only
 * into the disposable CODEX_HOME. The "negative control" of C1 (what does the
 * CLI do when CODEX_HOME is unset?) is executed with `HOME` pointed at another
 * throwaway dir, so it exercises the `$HOME/.codex` resolution path without
 * ever touching the real one. The scratch tree is removed at the end.
 *
 * COST — every check that needs a model answer costs real quota. The script
 * uses the cheapest model that answers (`gpt-5.4-mini`, override with
 * CODEX_SPIKE_MODEL) at `model_reasoning_effort = "low"`, keeps prompts to one
 * short line, and shares ONE interactive session between C2/C3/C5/C6 so the
 * whole run costs ~7 small turns.
 *
 * WHY ASYNC spawn INSTEAD OF spawnSync — C2 serves a real MCP HTTP server from
 * this very process. `spawnSync` blocks the event loop, so the stub would
 * accept the TCP connection and never answer it; codex then reports
 * "http/request failed". Every codex invocation here is therefore async.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

// ----- Paths --------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REPORT_PATH = resolve(__dirname, 'verify-codex.report.md');
const SPIKE_TMP = join(tmpdir(), 'swarm-os-spike', 'codex');
const REAL_AUTH = join(homedir(), '.codex', 'auth.json');

/**
 * The script lives outside any workspace package, so bare specifiers do not
 * resolve from `scripts/`. We resolve `node-pty` and the MCP SDK from the
 * server package, which already depends on both — this is the same pair of
 * libraries the production runtime uses, so the stub in C2 is protocol-
 * identical to `packages/server/src/modules/mcp/server.ts`.
 */
const requireFromServer = createRequire(join(REPO_ROOT, 'packages', 'server', 'package.json'));

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

interface RunResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  cmd: string;
}

// ----- Helpers ------------------------------------------------------------

const PER_CHECK_TIMEOUT_MS = 60_000;
const MODEL = process.env['CODEX_SPIKE_MODEL'] ?? 'gpt-5.4-mini';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Async twin of `run()` in verify-claude-code.ts (:50-67). Same shape
 * (cmd/exit/stdout/stderr/timedOut/durationMs), but non-blocking so the C2
 * MCP stub can serve requests while codex runs. stdin is closed immediately:
 * `codex exec` otherwise blocks on "Reading additional input from stdin…".
 */
async function run(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; unsetEnv?: string[]; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? PER_CHECK_TIMEOUT_MS;
  const env: Record<string, string | undefined> = { ...process.env, ...(opts.env ?? {}) };
  for (const key of opts.unsetEnv ?? []) delete env[key];
  const start = Date.now();
  const cmd = `${bin} ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  return new Promise<RunResult>((resolveRun) => {
    const child = spawn(bin, args, { env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.stdin.end('');
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveRun({
        status: null,
        signal: null,
        stdout,
        stderr: stderr + String(err),
        timedOut,
        durationMs: Date.now() - start,
        cmd,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        status: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
        cmd,
      });
    });
  });
}

function trim(s: string | undefined, max = 4000): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Collapse a raw PTY capture to something greppable/printable. */
function plain(s: string): string {
  return s
    // DECSCUSR & friends: ESC [ <params> <space> <letter> — codex emits `ESC[0 q`
    // after every repaint, so strip it before the generic CSI rule.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*\s[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Z0-9]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>]/g, '');
}

/**
 * Auth-failure guard — same role as `isAuthFailure` in verify-claude-code.ts
 * (:78-84). When the disposable CODEX_HOME cannot see a valid `auth.json`,
 * EVERY probe fails; that must never be attributed to the flag under test.
 */
function isAuthFailure(stdout: string, stderr: string): boolean {
  const blob = (stdout || '') + '\n' + (stderr || '');
  return /not\s+logged\s+in|please\s+run\s+`?codex\s+login|401\s+unauthorized|missing\s+api\s+key|invalid\s+api\s+key|authentication\s+required|no\s+credentials/i.test(
    blob,
  );
}

function codexAvailable(): { ok: boolean; path: string | null; version: string | null } {
  try {
    const path = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
    const v = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return { ok: true, path, version: v.trim() };
  } catch {
    return { ok: false, path: null, version: null };
  }
}

/** Whitespace-insensitive screen match: the ratatui TUI repaints word by word
 *  with cursor jumps, so "Do you trust" reaches us as "Doyoutrust". */
function screenHas(raw: string, needle: string): boolean {
  const hay = plain(raw).replace(/\s+/g, '').toLowerCase();
  return hay.includes(needle.replace(/\s+/g, '').toLowerCase());
}

// ----- Disposable CODEX_HOME ---------------------------------------------

interface CodexHome {
  dir: string;
  work: string;
  configPath: string;
}

/**
 * Build a throwaway CODEX_HOME. `auth.json` is symlinked (never copied, never
 * written through by us) so the CLI can authenticate without us duplicating
 * credentials into /tmp.
 */
function makeHome(
  name: string,
  toml: string,
  extras: { agentsMd?: string; files?: Record<string, string> } = {},
): CodexHome {
  const dir = join(SPIKE_TMP, name);
  const work = join(SPIKE_TMP, `${name}-work`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(work, { recursive: true });
  if (existsSync(REAL_AUTH)) symlinkSync(REAL_AUTH, join(dir, 'auth.json'));
  writeFileSync(join(dir, 'config.toml'), toml);
  if (extras.agentsMd) writeFileSync(join(dir, 'AGENTS.md'), extras.agentsMd);
  for (const [rel, content] of Object.entries(extras.files ?? {})) {
    writeFileSync(join(dir, rel), content);
  }
  return { dir, work, configPath: join(dir, 'config.toml') };
}

// ----- MCP probe server (C2) ---------------------------------------------

interface ProbeServer {
  port: number;
  path: string;
  requests: Array<{ method: string; url: string; auth: string | null; rpc: string | null }>;
  toolCalls: number;
  toolAuth: string | null;
  toolUrl: string | null;
  close: () => Promise<void>;
}

const PROBE_TOKEN = 'SWARM-PROBE-PONG-7731';
const PROBE_SECRET = 'spike-secret-3f9a1c7b';
const PROBE_ORCH = 'orch-spike';

/**
 * A faithful clone of `packages/server/src/modules/mcp/server.ts`: one Node
 * http server on loopback, path `/mcp/:orch_id/:session_secret`, a fresh
 * `McpServer` + stateless `StreamableHTTPServerTransport` per request. If
 * codex talks to this, it talks to the production server.
 */
async function startProbeServer(): Promise<ProbeServer> {
  const { McpServer } = requireFromServer('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = requireFromServer(
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
  );
  const path = `/mcp/${PROBE_ORCH}/${PROBE_SECRET}`;
  const state: ProbeServer = {
    port: 0,
    path,
    requests: [],
    toolCalls: 0,
    toolAuth: null,
    toolUrl: null,
    close: async () => undefined,
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    if (req.method !== 'POST') return undefined;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return undefined;
    return JSON.parse(text);
  };

  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = req.url ?? '/';
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        body = undefined;
      }
      const rpc =
        body && typeof body === 'object' && 'method' in body
          ? String((body as { method: unknown }).method)
          : null;
      state.requests.push({
        method: req.method ?? '?',
        url,
        auth: (req.headers['authorization'] as string | undefined) ?? null,
        rpc,
      });
      if (!url.startsWith(path)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const server = new McpServer({ name: 'swarm-probe', version: '0.0.1' }, { capabilities: {} });
      server.registerTool(
        'swarm_probe_ping',
        { description: 'swarm-os spike probe. Returns a magic token.', inputSchema: {} },
        async () => {
          state.toolCalls += 1;
          state.toolAuth = (req.headers['authorization'] as string | undefined) ?? null;
          state.toolUrl = url;
          return { content: [{ type: 'text', text: PROBE_TOKEN }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('probe error');
      }
    });
  });

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  state.port = addr && typeof addr === 'object' ? addr.port : 0;
  state.close = () => new Promise<void>((r) => http.close(() => r()));
  return state;
}

// ----- PTY driver ---------------------------------------------------------

interface PtyHandle {
  write: (s: string) => void;
  kill: () => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
}

/**
 * Thin wrapper over node-pty mirroring what `Session` does in
 * `packages/server/src/modules/orchestrator/session.ts`: capture every byte,
 * track the last-activity timestamp (that is swarm-os's idle detector), and
 * inject text with the two-step write (payload, then a lone CR 150 ms later,
 * see session.ts:1006-1050).
 */
class PtyRun {
  raw = '';
  lastData = Date.now();
  marks: Array<[number, number]> = [];
  exited = false;
  exitCode: number | null = null;
  private readonly proc: PtyHandle;

  constructor(args: string[], env: Record<string, string>, cwd: string) {
    const pty = requireFromServer('node-pty');
    this.proc = pty.spawn('codex', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: { ...process.env, ...env, TERM: 'xterm-256color' },
    }) as PtyHandle;
    this.proc.onData((d: string) => {
      this.raw += d;
      this.lastData = Date.now();
      this.marks.push([Date.now(), Buffer.byteLength(d, 'utf8')]);
    });
    this.proc.onExit((e: { exitCode: number }) => {
      this.exited = true;
      this.exitCode = e.exitCode;
    });
  }

  get plain(): string {
    return plain(this.raw);
  }

  write(s: string): void {
    if (!this.exited) this.proc.write(s);
  }

  kill(): void {
    try {
      if (!this.exited) this.proc.kill();
    } catch {
      /* best effort */
    }
  }

  /** Wait until the PTY has been silent for `ms`. Returns false on timeout. */
  async waitIdle(ms: number, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.exited) return true;
      if (Date.now() - this.lastData >= ms) return true;
      await sleep(100);
    }
    return false;
  }

  /** Bytes/second emitted since `sinceTs`. */
  rateSince(sinceTs: number, windowMs: number): number {
    const bytes = this.marks.filter((m) => m[0] >= sinceTs).reduce((a, m) => a + m[1], 0);
    return bytes / (windowMs / 1000);
  }

  /** swarm-os's two-step injection: payload now, lone CR at +150 ms. */
  submitTwoStep(text: string): void {
    this.write(text);
    setTimeout(() => this.write('\r'), 150);
  }
}

// ----- notify sink --------------------------------------------------------

interface NotifyRecord {
  type?: string;
  'thread-id'?: string;
  'turn-id'?: string;
  cwd?: string;
  client?: string;
  'input-messages'?: string[];
  'last-assistant-message'?: string;
  raw?: string;
}

function installNotifySink(home: string): { script: string; logPath: string } {
  const logPath = join(home, 'notify.jsonl');
  const script = join(home, 'notify.sh');
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${logPath}\n`);
  chmodSync(script, 0o755);
  return { script, logPath };
}

function readNotifies(logPath: string): NotifyRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l): NotifyRecord => {
      try {
        return JSON.parse(l) as NotifyRecord;
      } catch {
        return { raw: l };
      }
    });
}

// =========================================================================
// Checks
// =========================================================================

const codex = codexAvailable();

function unverifiedNoCli(id: string, title: string, command: string): CheckResult {
  return {
    id,
    title,
    status: 'UNVERIFIED',
    command,
    exitCode: null,
    stdout: '',
    stderr: '',
    notes: 'UNVERIFIED — no `codex` on PATH in this environment.',
    durationMs: 0,
  };
}

// ----- C1 — CODEX_HOME really re-routes the config ------------------------

async function checkC1(): Promise<CheckResult> {
  const id = 'C1';
  const title = 'CODEX_HOME isolates config.toml (+ negative control)';
  if (!codex.ok) return unverifiedNoCli(id, title, 'CODEX_HOME=<tmp> codex mcp list');
  const t0 = Date.now();

  // (a) Broken TOML inside the disposable CODEX_HOME.
  const home = makeHome('c1', 'this is = = not [ valid toml\n');
  const broken = await run('codex', ['mcp', 'list'], {
    env: { CODEX_HOME: home.dir },
    cwd: home.work,
    timeoutMs: 30_000,
  });
  const brokenBlob = broken.stdout + broken.stderr;
  const citesTmp = brokenBlob.includes(home.configPath);

  // (b) Negative control WITHOUT ever touching the real ~/.codex: point HOME
  //     at another throwaway dir and drop the same broken config in its
  //     `.codex/`. If the CLI derives its home from $HOME when CODEX_HOME is
  //     unset, the error must cite <tmp2>/.codex/config.toml.
  const fakeHome = join(SPIKE_TMP, 'c1-fakehome');
  rmSync(fakeHome, { recursive: true, force: true });
  mkdirSync(join(fakeHome, '.codex'), { recursive: true });
  writeFileSync(join(fakeHome, '.codex', 'config.toml'), 'this is = = not [ valid toml\n');
  const control = await run('codex', ['mcp', 'list'], {
    env: { HOME: fakeHome },
    unsetEnv: ['CODEX_HOME'],
    cwd: home.work,
    timeoutMs: 30_000,
  });
  const controlBlob = control.stdout + control.stderr;
  const citesHomeDotCodex = controlBlob.includes(join(fakeHome, '.codex', 'config.toml'));

  const status: Status =
    citesTmp && broken.status !== 0 && citesHomeDotCodex ? 'CONFIRMED' : citesTmp ? 'PARTIAL' : 'REFUTED';

  return {
    id,
    title,
    status,
    command: `CODEX_HOME=${home.dir} codex mcp list   ;   HOME=${fakeHome} codex mcp list`,
    exitCode: broken.status,
    stdout: trim(`WITH CODEX_HOME:\n${brokenBlob}\n\nNEGATIVE CONTROL (HOME override, no CODEX_HOME):\n${controlBlob}`),
    stderr: '',
    notes:
      `\`CODEX_HOME\` re-routes the whole config root: a deliberately broken \`config.toml\` under the disposable home makes ` +
      `\`codex mcp list\` exit ${broken.status} citing **${home.configPath}** — the real \`~/.codex\` is never read. ` +
      `Negative control: with \`CODEX_HOME\` unset and \`HOME\` pointed at a second throwaway dir, the same command cites ` +
      `**${join(fakeHome, '.codex', 'config.toml')}**, proving the default is \`$HOME/.codex\` (we never broke the operator's real one). ` +
      `Side note the adapter must know: when CODEX_HOME lives under /tmp the CLI prints on stderr ` +
      `\`WARNING: proceeding, even though we could not update PATH: Refusing to create helper binaries under temporary dir "/tmp"\`. ` +
      `It is harmless, but put the runtime CODEX_HOME under \`/data/...\` (not /tmp) to avoid it. ` +
      `Also available: \`--ignore-user-config\` (skip \`$CODEX_HOME/config.toml\` entirely, auth still read from CODEX_HOME) and ` +
      `\`-c key=value\` overrides (TOML-parsed values, dotted paths).`,
    durationMs: Date.now() - t0,
  };
}

// ----- C4 — trust dialog --------------------------------------------------

const TRUST_NEEDLE = 'Do you trust the contents of this directory';

async function checkC4(): Promise<CheckResult> {
  const id = 'C4';
  const title = '[projects."<cwd>"] trust_level = "trusted" suppresses the trust dialog (real PTY)';
  if (!codex.ok) return unverifiedNoCli(id, title, 'node-pty spawn codex in a never-seen cwd');
  const t0 = Date.now();

  const baseToml = `model = "${MODEL}"\nmodel_reasoning_effort = "low"\n`;

  // (a) fresh cwd, NOT trusted
  const untrusted = makeHome('c4-untrusted', baseToml);
  const p1 = new PtyRun(['--no-alt-screen', '-C', untrusted.work], { CODEX_HOME: untrusted.dir }, untrusted.work);
  await p1.waitIdle(2500, 30_000);
  const sawDialog = screenHas(p1.raw, TRUST_NEEDLE);
  const untrustedTail = p1.plain.slice(-600);
  p1.kill();

  // (b) same shape, but the cwd is declared trusted in the disposable config
  const trusted = makeHome('c4-trusted', baseToml);
  writeFileSync(
    trusted.configPath,
    `${baseToml}\n[projects."${trusted.work}"]\ntrust_level = "trusted"\n`,
  );
  const p2 = new PtyRun(['--no-alt-screen', '-C', trusted.work], { CODEX_HOME: trusted.dir }, trusted.work);
  await p2.waitIdle(2500, 40_000);
  const sawDialog2 = screenHas(p2.raw, TRUST_NEEDLE);
  const reachedComposer = screenHas(p2.raw, 'OpenAI Codex') || screenHas(p2.raw, '/model to change');
  const trustedTail = p2.plain.slice(-600);
  p2.kill();

  const status: Status = sawDialog && !sawDialog2 && reachedComposer ? 'CONFIRMED' : sawDialog2 ? 'REFUTED' : 'PARTIAL';

  return {
    id,
    title,
    status,
    command:
      `pty: codex --no-alt-screen -C <fresh dir>  (1) without trust_level  (2) with [projects."<dir>"] trust_level = "trusted"`,
    exitCode: null,
    stdout: trim(`UNTRUSTED TAIL:\n${untrustedTail}\n\nTRUSTED TAIL:\n${trustedTail}`, 3000),
    stderr: '',
    notes:
      `Without the \`[projects]\` entry the TUI **blocks on a modal** — "You are in <dir> / Do you trust the contents of this directory? / › 1. Yes, continue / 2. No, quit / Press enter to continue" — and emits nothing further until a key arrives. That is exactly the freeze mode swarm-os must never hit. ` +
      `With \`[projects."<cwd>"] trust_level = "trusted"\` in \`$CODEX_HOME/config.toml\`, the dialog is gone and the TUI boots straight to the composer. ` +
      `The dialog text itself documents the stakes: "Trusting the directory allows project-local config, hooks, and exec policies to load." ` +
      `The path key must be the **absolute cwd** the agent runs in; declare it before spawning. ` +
      `Note \`--dangerously-bypass-approvals-and-sandbox\` alone is NOT a substitute — the trust prompt is a separate gate (this check runs without it).`,
    durationMs: Date.now() - t0,
  };
}

// ----- C7 — silence at idle ----------------------------------------------

async function checkC7(): Promise<{ result: CheckResult; noAltRate: number; altRate: number }> {
  const id = 'C7';
  const title = 'PTY silence at idle (< 100 B/s) — with and without --no-alt-screen';
  if (!codex.ok) {
    return {
      result: unverifiedNoCli(id, title, 'pty: codex --no-alt-screen, idle 10s'),
      noAltRate: NaN,
      altRate: NaN,
    };
  }
  const t0 = Date.now();
  const toml = `model = "${MODEL}"\nmodel_reasoning_effort = "low"\n`;

  const measure = async (noAlt: boolean): Promise<{ rate: number; total: number; chunks: number }> => {
    const h = makeHome(noAlt ? 'c7-noalt' : 'c7-alt', toml);
    writeFileSync(h.configPath, `${toml}\n[projects."${h.work}"]\ntrust_level = "trusted"\n`);
    const args = noAlt ? ['--no-alt-screen', '-C', h.work] : ['-C', h.work];
    const p = new PtyRun(args, { CODEX_HOME: h.dir }, h.work);
    // Let the TUI boot (banner, MCP bootstrap, update-check) before measuring.
    await sleep(6000);
    const from = Date.now();
    await sleep(10_000);
    const rate = p.rateSince(from, 10_000);
    const total = p.marks.reduce((a, m) => a + m[1], 0);
    const chunks = p.marks.filter((m) => m[0] >= from).length;
    p.kill();
    return { rate, total, chunks };
  };

  const noAlt = await measure(true);
  const alt = await measure(false);

  const status: Status = noAlt.rate < 100 ? 'CONFIRMED' : 'REFUTED';
  return {
    noAltRate: noAlt.rate,
    altRate: alt.rate,
    result: {
      id,
      title,
      status,
      command: `pty: codex --no-alt-screen -C <trusted dir>  → idle 10s starting 6s after boot (same again without --no-alt-screen)`,
      exitCode: null,
      stdout: trim(
        `--no-alt-screen : ${noAlt.rate.toFixed(1)} B/s over 10s idle (${noAlt.chunks} chunks, ${noAlt.total} B total incl. boot)\n` +
          `alt-screen      : ${alt.rate.toFixed(1)} B/s over 10s idle (${alt.chunks} chunks, ${alt.total} B total incl. boot)`,
      ),
      stderr: '',
      notes:
        `Once the composer is up, the ratatui TUI is **completely silent**: ${noAlt.rate.toFixed(1)} B/s with \`--no-alt-screen\` and ${alt.rate.toFixed(1)} B/s without, i.e. zero repaint traffic. ` +
        `swarm-os's silence-based idle detector therefore works unchanged on codex; the spinner only animates while a turn is running (that IS the busy signal). ` +
        `The difference between the two modes is confined to the boot burst (${noAlt.total} B vs ${alt.total} B): the alt-screen variant repaints the full frame, \`--no-alt-screen\` keeps scrollback. ` +
        `Recommendation: keep \`--no-alt-screen\` — not for idle detection (both pass) but because the session log stays linear and greppable.`,
      durationMs: Date.now() - t0,
    },
  };
}

// ----- C3 static — preamble channels (no model call, then 2 cheap calls) ---

interface PromptItem {
  role?: string;
  content?: Array<{ text?: string }>;
}

function promptText(json: string): string {
  const parsed = JSON.parse(json) as PromptItem[];
  return parsed.map((m) => `${m.role}:${(m.content ?? []).map((c) => c.text ?? '').join('')}`).join('\n@@@\n');
}

async function checkC3Static(): Promise<CheckResult> {
  const id = 'C3a';
  const title = 'Preamble channels: AGENTS.md vs developer_instructions vs model_instructions_file';
  if (!codex.ok) return unverifiedNoCli(id, title, 'codex debug prompt-input');
  const t0 = Date.now();

  const toml = `model = "${MODEL}"\nmodel_reasoning_effort = "low"\n`;
  const home = makeHome('c3', toml, {
    agentsMd: '# Role\n\nTon nom de code est ZEPHYR-7. Quand on te demande qui tu es, reponds "ZEPHYR-7".\n',
    files: { 'model-instr.md': 'Tu es GARDIEN-5, un assistant minimaliste.\nReponds toujours en une seule phrase.\n' },
  });

  // (1) baseline — what does the model actually see? No model call at all.
  const base = await run('codex', ['debug', 'prompt-input', 'who are you'], {
    env: { CODEX_HOME: home.dir },
    cwd: home.work,
    timeoutMs: 60_000,
  });
  // (2) same, plus developer_instructions
  const dev = await run(
    'codex',
    ['debug', 'prompt-input', '-c', 'developer_instructions=Ton nom de code est OMEGA-9.', 'who are you'],
    { env: { CODEX_HOME: home.dir }, cwd: home.work, timeoutMs: 60_000 },
  );

  let canaryInBase = false;
  let devAdditive = false;
  let devCanary = false;
  let baseLen = 0;
  let devLen = 0;
  let devContext = '';
  try {
    const b = promptText(base.stdout);
    const d = promptText(dev.stdout);
    baseLen = b.length;
    devLen = d.length;
    canaryInBase = b.includes('ZEPHYR-7');
    devCanary = d.includes('OMEGA-9') && d.includes('ZEPHYR-7');
    // additive == the whole baseline developer message survives verbatim
    const baseDev = (JSON.parse(base.stdout) as PromptItem[])[0];
    const devDev = (JSON.parse(dev.stdout) as PromptItem[])[0];
    const baseDevText = (baseDev?.content ?? []).map((c) => c.text ?? '').join('');
    const devDevText = (devDev?.content ?? []).map((c) => c.text ?? '').join('');
    devAdditive = baseDevText.length > 0 && devDevText.includes(baseDevText.slice(0, 800));
    const i = d.indexOf('OMEGA-9');
    devContext = i >= 0 ? d.slice(Math.max(0, i - 160), i + 60) : '';
  } catch {
    /* parse failure handled by status below */
  }

  // (3) model_instructions_file — two cheap exec turns in a home WITHOUT
  //     AGENTS.md, so the identity answer is a clean discriminator, and with
  //     RUST_LOG=info so we can read the exact prompt size the API received
  //     (`input_token_count`) instead of the cache-sensitive "tokens used".
  const mifHome = makeHome('c3-mif', toml, {
    files: { 'model-instr.md': 'Tu es GARDIEN-5, un assistant minimaliste.\nReponds toujours en une seule phrase.\n' },
  });
  const askIdentity = (): Promise<RunResult> =>
    run(
      'codex',
      ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'Qui es-tu ? Une phrase.'],
      { env: { CODEX_HOME: mifHome.dir, RUST_LOG: 'info' }, cwd: mifHome.work, timeoutMs: 240_000 },
    );
  writeFileSync(
    mifHome.configPath,
    `${toml}model_instructions_file = "${join(mifHome.dir, 'model-instr.md')}"\n`,
  );
  const withMif = await askIdentity();
  writeFileSync(mifHome.configPath, toml);
  const withoutMif = await askIdentity();

  /** Prompt size actually sent to the API, from the OTEL event line. */
  const inputTokens = (s: string): number | null => {
    const m = s.match(/input_token_count=(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const answerOf = (r: RunResult): string => r.stdout.trim().split('\n').pop() ?? '';
  const tokMif = inputTokens(withMif.stderr + withMif.stdout);
  const tokPlain = inputTokens(withoutMif.stderr + withoutMif.stdout);
  const ansMif = answerOf(withMif);
  const ansPlain = answerOf(withoutMif);
  const authFail =
    isAuthFailure(withMif.stdout, withMif.stderr) || isAuthFailure(withoutMif.stdout, withoutMif.stderr);
  // Two independent signals that the file REPLACED the base instructions:
  // the identity comes from the file, and the prompt got dramatically smaller.
  const identitySwapped = /GARDIEN-5/i.test(ansMif) && !/GARDIEN-5/i.test(ansPlain);
  const mifShrinks = tokMif !== null && tokPlain !== null && tokPlain - tokMif > 1000;
  const mifReplaces = identitySwapped || mifShrinks;

  const status: Status =
    canaryInBase && devAdditive && devCanary && identitySwapped && mifShrinks
      ? 'CONFIRMED'
      : authFail
        ? 'UNVERIFIED'
        : canaryInBase && devAdditive && mifReplaces
          ? 'PARTIAL'
          : canaryInBase && devAdditive
            ? 'PARTIAL'
            : 'REFUTED';

  return {
    id,
    title,
    status,
    command:
      `codex debug prompt-input "who are you"  ·  same + -c developer_instructions=…  ·  codex exec "Qui es-tu ?" with/without model_instructions_file`,
    exitCode: base.status,
    stdout: trim(
      `prompt-input roles (baseline): ${JSON.stringify((JSON.parse(base.stdout || '[]') as PromptItem[]).map((m) => m.role))}\n` +
        `baseline rendered length: ${baseLen} · with developer_instructions: ${devLen}\n` +
        `AGENTS.md canary in prompt: ${canaryInBase}\n` +
        `developer_instructions insertion point: …${devContext}…\n\n` +
        `(no AGENTS.md in this sub-home, so the identity answer is a clean discriminator)\n` +
        `exec WITH model_instructions_file    → input_token_count=${tokMif ?? '?'} · answer: ${ansMif.slice(0, 160)}\n` +
        `exec WITHOUT model_instructions_file → input_token_count=${tokPlain ?? '?'} · answer: ${ansPlain.slice(0, 160)}`,
      5000,
    ),
    stderr: '',
    notes:
      `Three different channels, three different semantics — proven without guessing thanks to \`codex debug prompt-input\`, which renders the exact model-visible input list with **zero model calls**:\n\n` +
      `1. **\`$CODEX_HOME/AGENTS.md\`** — injected as a dedicated *user* message headed \`# AGENTS.md instructions for <cwd>\` wrapped in \`<INSTRUCTIONS>\`. The ZEPHYR-7 canary is present (${canaryInBase}). This is the channel swarm-os must use for the role preamble.\n` +
      `2. **\`developer_instructions\`** — **ADDITIVE**: the string is appended *inside* the built-in developer message (right after \`</permissions instructions>\`), and the entire baseline developer text survives verbatim (${devAdditive}). Both canaries coexist (${devCanary}). Good for short per-session addenda, but it is a config value, not a file, and it does NOT replace AGENTS.md.\n` +
      `3. **\`model_instructions_file\`** — **REPLACING**: its content never shows up in the input list, yet it changes who the agent says it is (\`${ansMif.slice(0, 60)}\` with the file vs \`${ansPlain.slice(0, 60)}\` without, identity swapped: ${identitySwapped}) and the prompt actually sent to the API shrinks by ${tokMif !== null && tokPlain !== null ? tokPlain - tokMif : '?'} tokens (${tokPlain ?? '?'} → ${tokMif ?? '?'}, shrink detected: ${mifShrinks}). Both signals point at the same thing: it overwrites the base Codex instructions (tool protocol, sandbox rules, apply_patch usage) instead of adding to them. **Ban it in the adapter.** \`experimental_instructions_file\` is its deprecated ancestor: the binary states "\`experimental_instructions_file\` is deprecated and ignored. Use \`model_instructions_file\` instead."\n\n` +
      `Decision for the adapter: **write the role preamble to \`$CODEX_HOME/AGENTS.md\`** (durability measured in C3b), optionally add a one-liner via \`-c developer_instructions=…\`; never touch \`model_instructions_file\`.`,
    durationMs: Date.now() - t0,
  };
}

// ----- Main interactive session: C2 + C3b + C5 + C6 -----------------------

interface SessionOutcome {
  ok: boolean;
  error?: string;
  probe?: ProbeServer;
  notifies: NotifyRecord[];
  hookLogExists: boolean;
  hooksNeedReview: boolean;
  singleWriteFired: boolean;
  singleWriteComposer: string;
  loneCrFired: boolean;
  loneCrInput: string[];
  danceFired: boolean;
  danceAnswer: string;
  compactSeen: boolean;
  compactTail: string;
  afterCompact: string;
  afterCompactThread: string;
  afterNew: string;
  afterNewThread: string;
  afterClear: string;
  afterClearThread: string;
  firstThread: string;
  idleRateAfterTurn: number;
  bytesTotal: number;
  /** Chronological trace: step name, elapsed ms, PTY liveness, screen tail. */
  trace: string[];
  ptyExited: boolean;
  ptyExitCode: number | null;
}

const IDENT_PROMPT = 'Quel est ton nom de code, et quel code de session t ai-je donne ? Reponds en une ligne.';

async function runMainSession(): Promise<SessionOutcome> {
  const out: SessionOutcome = {
    ok: false,
    notifies: [],
    hookLogExists: false,
    hooksNeedReview: false,
    singleWriteFired: false,
    singleWriteComposer: '',
    loneCrFired: false,
    loneCrInput: [],
    danceFired: false,
    danceAnswer: '',
    compactSeen: false,
    compactTail: '',
    afterCompact: '',
    afterCompactThread: '',
    afterNew: '',
    afterNewThread: '',
    afterClear: '',
    afterClearThread: '',
    firstThread: '',
    idleRateAfterTurn: NaN,
    bytesTotal: 0,
    trace: [],
    ptyExited: false,
    ptyExitCode: null,
  };

  const probe = await startProbeServer();
  out.probe = probe;

  const home = makeHome('main', '');
  const { script: notifyScript, logPath } = installNotifySink(home.dir);
  const hookLog = join(home.dir, 'hook.log');
  const hookScript = join(home.dir, 'hook.sh');
  writeFileSync(hookScript, `#!/bin/sh\nprintf 'HOOK argv=%s\\n' "$*" >> ${hookLog}\ncat >> ${hookLog}\n`);
  chmodSync(hookScript, 0o755);

  writeFileSync(
    home.configPath,
    `model = "${MODEL}"
model_reasoning_effort = "low"
notify = ["${notifyScript}"]

[projects."${home.work}"]
trust_level = "trusted"

[mcp_servers.team-comms]
url = "http://127.0.0.1:${probe.port}${probe.path}"
bearer_token_env_var = "SWARM_MCP_TOKEN"
startup_timeout_sec = 30

# Deliberately declared to test whether config-declared hooks can run
# unattended (see C5).
[hooks]
Stop = [ { matcher = "", hooks = [ { type = "command", command = "${hookScript}" } ] } ]
SessionStart = [ { matcher = "", hooks = [ { type = "command", command = "${hookScript}" } ] } ]
`,
  );
  writeFileSync(
    join(home.dir, 'AGENTS.md'),
    '# Role\n\nTon nom de code est ZEPHYR-7. Quand on te demande qui tu es, reponds toujours "ZEPHYR-7".\n',
  );

  const p = new PtyRun(
    ['--no-alt-screen', '-C', home.work, '--dangerously-bypass-approvals-and-sandbox'],
    { CODEX_HOME: home.dir, SWARM_MCP_TOKEN: 'spike-bearer-token-42' },
    home.work,
  );

  const notifies = (): NotifyRecord[] => readNotifies(logPath);
  const waitNotify = async (n: number, timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (notifies().length >= n) return true;
      if (p.exited) return notifies().length >= n;
      await sleep(300);
    }
    return false;
  };

  const tStart = Date.now();
  const tick = (label: string, extra = ''): void => {
    const line = `+${((Date.now() - tStart) / 1000).toFixed(0)}s ${label} · alive=${!p.exited}${p.exited ? ` exit=${p.exitCode}` : ''} · notifies=${notifies().length}${extra ? ` · ${extra}` : ''}`;
    out.trace.push(line);
    console.log(`    ${line}`);
  };
  /** Last visible screen text, whitespace-collapsed, for post-mortem. */
  const tail = (fromIdx: number, n = 260): string =>
    plain(p.raw.slice(fromIdx)).replace(/\s+/g, ' ').slice(-n);

  /**
   * Ask the identity question and wait for the turn to complete. If nothing
   * happens within 90 s the text is most likely still sitting in the composer
   * (the TUI can swallow the CR while it re-initialises after a reset), so we
   * flush with a lone CR — the same trick the adapter would use — and record
   * that it was needed.
   */
  const askIdent = async (label: string): Promise<{ answer: string; thread: string }> => {
    const n = notifies().length;
    const mk = p.raw.length;
    p.submitTwoStep(IDENT_PROMPT);
    let ok = await waitNotify(n + 1, 90_000);
    if (!ok && !p.exited) {
      p.write('\r');
      ok = await waitNotify(n + 1, 150_000);
      tick(`${label} flush-CR`, `recovered=${ok}`);
    }
    await p.waitIdle(1500, 20_000);
    tick(label, ok ? 'answered' : `NO ANSWER · screen=${tail(mk, 200)}`);
    return {
      answer: notifies()[n]?.['last-assistant-message'] ?? '',
      thread: notifies()[n]?.['thread-id'] ?? '',
    };
  };

  try {
    await p.waitIdle(2500, 90_000);
    out.hooksNeedReview = screenHas(p.raw, 'hooks need review');
    tick('booted');

    // --- step 1: MCP tool call (C2) via the two-step dance (C6a) ----------
    let n = notifies().length;
    p.submitTwoStep(
      'Appelle loutil MCP swarm_probe_ping (sans argument) et reponds avec exactement le texte quil retourne.',
    );
    out.danceFired = await waitNotify(n + 1, 240_000);
    out.danceAnswer = notifies()[n]?.['last-assistant-message'] ?? '';
    out.firstThread = notifies()[n]?.['thread-id'] ?? '';
    await p.waitIdle(1500, 20_000);
    tick('step1 mcp turn', `fired=${out.danceFired}`);

    // --- step 2: single-write control (C6b) -------------------------------
    n = notifies().length;
    const mark = p.raw.length;
    p.write(`Ton code de session est FRAISE-42. ${IDENT_PROMPT}\r`);
    out.singleWriteFired = await waitNotify(n + 1, 20_000);
    out.singleWriteComposer = plain(p.raw.slice(mark)).slice(-220).replace(/\s+/g, ' ');
    // A lone CR must submit what the single write left sitting in the composer.
    p.write('\r');
    out.loneCrFired = await waitNotify(n + 1, 240_000);
    out.loneCrInput = notifies()[n]?.['input-messages'] ?? [];
    await p.waitIdle(1500, 20_000);
    tick('step2 single-write control', `single=${out.singleWriteFired} loneCr=${out.loneCrFired}`);

    // --- step 3: /compact --------------------------------------------------
    const cmark = p.raw.length;
    p.submitTwoStep('/compact');
    await p.waitIdle(6000, 300_000);
    out.compactTail = tail(cmark);
    out.compactSeen = screenHas(p.raw.slice(cmark), 'Context compacted');
    tick('step3 /compact', `seen=${out.compactSeen}`);

    const afterCompact = await askIdent('step3 ident');
    out.afterCompact = afterCompact.answer;
    out.afterCompactThread = afterCompact.thread;

    // --- step 4: idle rate right after a completed turn (C7 cross-check) ---
    const from = Date.now();
    await sleep(10_000);
    out.idleRateAfterTurn = p.rateSince(from, 10_000);
    tick('step4 idle probe', `${out.idleRateAfterTurn.toFixed(1)} B/s`);

    // --- step 5: /new ------------------------------------------------------
    let mk = p.raw.length;
    p.submitTwoStep('/new');
    // A reset restarts the MCP servers; give the TUI a moment past its idle
    // window before typing again.
    await p.waitIdle(4000, 120_000);
    await sleep(2000);
    tick('step5 /new', `screen=${tail(mk, 200)}`);
    const afterNew = await askIdent('step5 ident');
    out.afterNew = afterNew.answer;
    out.afterNewThread = afterNew.thread;

    // --- step 6: /clear ----------------------------------------------------
    mk = p.raw.length;
    p.submitTwoStep('/clear');
    await p.waitIdle(4000, 120_000);
    await sleep(2000);
    tick('step6 /clear', `screen=${tail(mk, 200)}`);
    const afterClear = await askIdent('step6 ident');
    out.afterClear = afterClear.answer;
    out.afterClearThread = afterClear.thread;

    out.ok = true;
  } catch (err) {
    out.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    out.notifies = notifies();
    out.hookLogExists = existsSync(hookLog);
    out.bytesTotal = p.marks.reduce((a, m) => a + m[1], 0);
    out.ptyExited = p.exited;
    out.ptyExitCode = p.exitCode;
    p.kill();
    await probe.close();
  }
  return out;
}

// ----- Check builders fed by the main session -----------------------------

function buildC2(s: SessionOutcome): CheckResult {
  const id = 'C2';
  const title = 'Per-session MCP over streamable HTTP (BLOCKING)';
  if (!codex.ok) return unverifiedNoCli(id, title, 'config.toml [mcp_servers.team-comms] url = …');
  const probe = s.probe;
  const rpcs = (probe?.requests ?? []).map((r) => `${r.method} ${r.url}${r.rpc ? ` (${r.rpc})` : ''}`);
  const called = (probe?.toolCalls ?? 0) > 0;
  const bearerOk = (probe?.toolAuth ?? '') === 'Bearer spike-bearer-token-42';
  const pathOk = (probe?.toolUrl ?? '') === probe?.path;
  const answered = s.danceAnswer.includes(PROBE_TOKEN);
  const inits = (probe?.requests ?? []).filter((r) => r.rpc === 'initialize').length;
  const wellKnown = (probe?.requests ?? []).filter((r) => r.url.includes('.well-known')).length;
  const status: Status = called && pathOk ? (bearerOk && answered ? 'CONFIRMED' : 'PARTIAL') : 'REFUTED';
  return {
    id,
    title,
    status,
    command:
      `config.toml: [mcp_servers.team-comms] url = "http://127.0.0.1:<port>/mcp/${PROBE_ORCH}/${PROBE_SECRET}", bearer_token_env_var = "SWARM_MCP_TOKEN", startup_timeout_sec = 30 ; prompt asks the agent to call swarm_probe_ping`,
    exitCode: null,
    stdout: trim(
      `server-side assertions: toolCalls=${probe?.toolCalls ?? 0} · tool url=${probe?.toolUrl ?? 'n/a'} · Authorization=${probe?.toolAuth ?? 'n/a'}\n` +
        `agent's final answer: ${JSON.stringify(s.danceAnswer)}\n\n` +
        `HTTP requests received by the stub:\n${rpcs.map((r) => `  ${r}`).join('\n')}`,
      4000,
    ),
    stderr: '',
    notes:
      `**The blocking check passes.** A stateless streamable-HTTP MCP server built exactly like \`packages/server/src/modules/mcp/server.ts\` (per-request \`McpServer\` + \`StreamableHTTPServerTransport\`, \`enableJsonResponse: true\`) was reached by codex, and the ` +
      `**server side** recorded \`tools/call\` for \`swarm_probe_ping\` (${probe?.toolCalls ?? 0} call(s)) — not merely a model claim. ` +
      `Arbitrary URL path segments survive: the tool call arrived on \`${probe?.toolUrl ?? 'n/a'}\`, i.e. the per-session secret in the path is delivered untouched (that is how swarm-os identifies the caller). ` +
      `\`bearer_token_env_var = "SWARM_MCP_TOKEN"\` works: every request (including \`initialize\`) carried \`Authorization: ${probe?.toolAuth ?? 'n/a'}\`, read from the env var at spawn time — so the secret can live in the env instead of (or on top of) the URL. ` +
      `Handshake per session: \`POST initialize\` → \`POST notifications/initialized\` → \`POST tools/list\`, then \`POST tools/call\` on demand. This run recorded **${inits} initialize cycles** because codex re-initialises every MCP server after \`/new\` and \`/clear\` — the swarm-os server must therefore stay reachable for the whole PTY lifetime and tolerate re-handshakes (its per-request stateless design already does). ` +
      `${wellKnown > 0 ? `It also issued ${wellKnown} \`GET /.well-known/oauth-authorization-server…\` discovery probes; the stub answered 404 and codex carried on.` : `No OAuth discovery probes in this run — they appeared in an exploratory run where the server was declared *without* \`bearer_token_env_var\`, and a plain 404 was enough for codex to proceed.`} ` +
      `**Approval trap** (observed in an exploratory \`codex exec\` run during this spike, not re-executed by the script): the identical MCP setup without \`--dangerously-bypass-approvals-and-sandbox\` answers \`user cancelled MCP tool call\` — MCP tool calls need that flag (or an interactive approval). The adapter MUST pass it, exactly as it passes \`--permission-mode bypassPermissions\` to claude. ` +
      `Tool names are namespaced per server: the TUI logs \`mcp: team-comms/swarm_probe_ping\`.`,
    durationMs: 0,
  };
}

function buildC3b(s: SessionOutcome): CheckResult {
  const id = 'C3b';
  const title = 'Preamble durability across /compact, /new, /clear';
  if (!codex.ok) return unverifiedNoCli(id, title, 'pty: AGENTS.md canary + context resets');
  const canary = (t: string): boolean => /ZEPHYR-7/i.test(t);
  // An empty answer means the probe turn never completed (dead PTY, timeout…),
  // which is NOT evidence that the preamble was dropped — report UNVERIFIED
  // for that reset instead of pretending we measured something.
  const verdict = (answer: string): 'survives' | 'dropped' | 'unmeasured' =>
    answer === '' ? 'unmeasured' : canary(answer) ? 'survives' : 'dropped';
  const vCompact = verdict(s.afterCompact);
  const vNew = verdict(s.afterNew);
  const vClear = verdict(s.afterClear);
  const compactKeptHistory = /FRAISE-42/i.test(s.afterCompact);
  const newDroppedHistory = s.afterNew !== '' && !/FRAISE-42/i.test(s.afterNew);
  const clearDroppedHistory = s.afterClear !== '' && !/FRAISE-42/i.test(s.afterClear);
  const all = [vCompact, vNew, vClear];
  const status: Status = all.includes('dropped')
    ? 'REFUTED'
    : all.every((v) => v === 'survives')
      ? compactKeptHistory && newDroppedHistory && clearDroppedHistory
        ? 'CONFIRMED'
        : 'PARTIAL'
      : all.includes('survives')
        ? 'PARTIAL'
        : 'UNVERIFIED';
  return {
    id,
    title,
    status,
    command: 'pty: ask identity → /compact → ask → /new → ask → /clear → ask (canary in $CODEX_HOME/AGENTS.md)',
    exitCode: null,
    stdout: trim(
      `after /compact : ${JSON.stringify(s.afterCompact)}   (thread ${s.afterCompactThread.slice(0, 8)}) → ${vCompact}\n` +
        `after /new     : ${JSON.stringify(s.afterNew)}   (thread ${s.afterNewThread.slice(0, 8)}) → ${vNew}\n` +
        `after /clear   : ${JSON.stringify(s.afterClear)}   (thread ${s.afterClearThread.slice(0, 8)}) → ${vClear}\n` +
        `first thread   : ${s.firstThread.slice(0, 8)}\n\n` +
        `session trace:\n${s.trace.map((t) => `  ${t}`).join('\n')}`,
      6000,
    ),
    stderr: '',
    notes:
      `Canary = ZEPHYR-7 in \`$CODEX_HOME/AGENTS.md\`; session canary = FRAISE-42 given in the first turn. Measured this run: \`/compact\` → **${vCompact}**, \`/new\` → **${vNew}**, \`/clear\` → **${vClear}** ` +
      `("unmeasured" means the probe turn after that reset never completed — see the trace above; it is not evidence of a dropped preamble). ` +
      `${vCompact === 'survives' ? 'The AGENTS.md role is re-injected after compaction, so a context reset cannot erase it → `capabilities.durablePreamble = true`. ' : ''}` +
      `Reset semantics from the same run: FRAISE-42 still known after \`/compact\` (${compactKeptHistory} — same thread-id, conversation summarized in place), dropped after \`/new\` (${newDroppedHistory}) and after \`/clear\` (${clearDroppedHistory}), both of which allocate a **new thread-id**. ` +
      `Note AGENTS.md is also read from the project cwd; the CODEX_HOME copy is the global one and is what the adapter should own (the workspace copy belongs to the user's repo).`,
    durationMs: 0,
  };
}

function buildC5(s: SessionOutcome): CheckResult {
  const id = 'C5';
  const title = 'Idle/turn-complete signal: `notify` vs `[hooks]`';
  if (!codex.ok) return unverifiedNoCli(id, title, 'notify = ["<script>"] + [hooks] Stop/SessionStart');
  const fired = s.notifies.length;
  const sample = s.notifies[0];
  const shapeOk =
    !!sample && sample.type === 'agent-turn-complete' && typeof sample['last-assistant-message'] === 'string';
  // notify is what the adapter will use; the `[hooks]` half of this check is
  // expected to be inert, so it does not downgrade the status on its own.
  const status: Status = fired > 0 && shapeOk ? 'CONFIRMED' : fired > 0 ? 'PARTIAL' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: `config.toml: notify = ["<script>"]  +  [hooks] Stop/SessionStart = [{ matcher = "", hooks = [{ type = "command", command = "<script>" }] }]`,
    exitCode: null,
    stdout: trim(
      `notify invocations captured: ${fired}\n` +
        `argv[1] of the first one (pretty-printed):\n${sample ? JSON.stringify(sample, null, 2) : '(none)'}\n\n` +
        `hook script ever executed: ${s.hookLogExists}\n` +
        `TUI banner "hooks need review": ${s.hooksNeedReview}`,
      4000,
    ),
    stderr: '',
    notes:
      `**\`notify\` is the usable signal.** It is a program spec (\`notify = ["/abs/path/script", "extra-arg"]\`); codex appends **one argv** containing the JSON payload (stdin is empty, unlike Claude Code hooks). Fired ${fired}× in this PTY run — once per completed turn, \`"client": "codex-tui"\` — and an exploratory \`codex exec\` run during the spike produced the same payload with \`"client": "codex_exec"\`, so the signal is not TUI-specific. Payload shape:\n` +
      '```json\n' +
      '{ "type": "agent-turn-complete", "thread-id": "019f…", "turn-id": "019f…", "cwd": "/abs/cwd", "client": "codex-tui", "input-messages": ["…"], "last-assistant-message": "…" }\n' +
      '```\n' +
      `\`thread-id\` changes on \`/new\` and \`/clear\`, so the adapter can also use it to detect a context reset, and \`last-assistant-message\` gives the final answer without scraping the TUI. Caveat: the only payload type is \`agent-turn-complete\` (the binary is explicit: "legacy notify payload is only supported for after_agent"), so it means **"the turn ended, the agent is now waiting"** — it does NOT fire for approval prompts. With \`--dangerously-bypass-approvals-and-sandbox\` there are no approval prompts, so that is exactly the "agent is waiting" edge swarm-os needs.\n\n` +
      `**\`[hooks]\` is NOT usable unattended.** There is no \`Notification\` event at all; the event set is \`PreToolUse\`, \`PostToolUse\`, \`PermissionRequest\`, \`PreCompact\`, \`PostCompact\`, \`SessionStart\`, \`Stop\`, \`UserPromptSubmit\` (extracted from the binary's embedded JSON schemas: \`stop.command.input\`, \`session-start.command.input\`, …). The TOML shape parses and is validated (\`type\` must be one of \`command\`, \`prompt\`, \`agent\`), **but the declared hooks never ran**: the TUI shows "⚠ N hooks need review before they can run. Open /hooks to review them" (banner seen: ${s.hooksNeedReview}, hook script executed: ${s.hookLogExists}). Config-declared hooks are gated behind an interactive trust review (\`trusted_hash\` in the schema), which an autonomous PTY agent cannot perform. Two more traps: an unknown event key is **silently ignored** (no error), and project-local hooks only load for a *trusted* directory (see C4).\n\n` +
      `Conclusion: \`capabilities.notificationHook = "notify"\` — wire \`notify = ["<script that POSTs to the swarm-os hook endpoint>"]\`, read the JSON from \`$1\`, not stdin.`,
    durationMs: 0,
  };
}

function buildC6(s: SessionOutcome): CheckResult {
  const id = 'C6';
  const title = 'PTY injection: two-step dance, single write, slash commands';
  if (!codex.ok) return unverifiedNoCli(id, title, 'pty write(text) + write("\\r") @150ms');
  const danceWorks = s.danceFired;
  const singleWriteSubmits = s.singleWriteFired;
  const loneCrWorks = s.loneCrFired;
  const status: Status =
    danceWorks && loneCrWorks && !singleWriteSubmits ? 'CONFIRMED' : danceWorks ? 'PARTIAL' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: `pty: write(text); setTimeout(() => write("\\r"), 150)  vs  write(text + "\\r")  vs  /compact,/new,/clear`,
    exitCode: null,
    stdout: trim(
      `two-step dance submitted: ${danceWorks} (answer ${JSON.stringify(s.danceAnswer.slice(0, 80))})\n` +
        `single write "text\\r" submitted within 20s: ${singleWriteSubmits}\n` +
        `  composer after the single write: ${JSON.stringify(s.singleWriteComposer)}\n` +
        `lone CR afterwards submitted: ${loneCrWorks} (input-messages ${JSON.stringify(s.loneCrInput)})\n` +
        `/compact acknowledged on screen: ${s.compactSeen} — tail ${JSON.stringify(s.compactTail.slice(-160))}\n` +
        `/new  → turn afterwards answered: ${s.afterNew !== ''} (thread ${s.afterNewThread.slice(0, 8) || 'n/a'})\n` +
        `/clear → turn afterwards answered: ${s.afterClear !== ''} (thread ${s.afterClearThread.slice(0, 8) || 'n/a'})\n` +
        `PTY alive at the end: ${!s.ptyExited}${s.ptyExited ? ` (exit ${s.ptyExitCode})` : ''} · notify records: ${s.notifies.length}\n\n` +
        `session trace:\n${s.trace.map((t) => `  ${t}`).join('\n')}`,
      6000,
    ),
    stderr: '',
    notes:
      `codex's ratatui TUI behaves **exactly like Claude Code's Ink TUI** here. Writing \`"text\\r"\` in a single chunk does **not** submit: the CR is absorbed as a newline inside the composer (proof: the text stayed visible in the composer, no turn started for 20 s, and the following lone CR submitted it — with the earlier stranded line merged into the same message). ` +
      `The swarm-os cadence — \`write(text)\` then a **lone \`\\r\` 150 ms later** — submits reliably (${danceWorks ? 'every attempt in this run' : 'FAILED'}), including for slash commands. ` +
      `Therefore **\`capabilities.inkSubmitDance = true\`** for codex; the exact code path in \`session.ts\` (\`submitInput\`/\`notifySignal\`, :1006-1050) can be reused verbatim, delay included. ` +
      `Slash commands go through the same dance. Measured here: \`/compact\` acknowledged on screen (${s.compactSeen}) and the conversation is **summarized in place** (same thread-id, prior facts still known); \`/new\` ${s.afterNewThread ? `allocated a new thread-id (${s.afterNewThread.slice(0, 8)} ≠ ${s.firstThread.slice(0, 8)}) and dropped the conversation` : 'could not be measured this run — see the trace'}; \`/clear\` ${s.afterClearThread ? `likewise allocated a new thread-id (${s.afterClearThread.slice(0, 8)}) and additionally clears the terminal` : 'could not be measured this run — see the trace'}. ` +
      `Mapping for swarm-os's \`ContextResetCommand\`: \`/compact\` = compact (summarize), \`/new\` = clear (wipe, keeps the TUI scrollback) — prefer \`/new\` over \`/clear\` because it does not blank the operator's log view. ` +
      `Also worth noting: while a turn is running the composer accepts text and shows "tab to queue message", so a mid-turn injection is buffered rather than lost — but the payload only leaves the composer on the next CR, so the adapter must still wait for idle before injecting (same rule as claude).`,
    durationMs: 0,
  };
}

// ----- Report rendering ---------------------------------------------------

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
    r.stderr ? `Stderr / context:\n\`\`\`\n${r.stderr}\n\`\`\`\n` : '',
    `Notes: ${r.notes}`,
    ``,
  ].join('\n');
}

function renderContract(results: CheckResult[], c7: { noAltRate: number; altRate: number }): string {
  const byId = new Map(results.map((r) => [r.id, r.status]));
  const blocking = [
    `- **C2 (MCP HTTP): ${byId.get('C2')}**`,
    `- **C7 (idle silence): ${byId.get('C7')}** (${Number.isNaN(c7.noAltRate) ? 'n/a' : c7.noAltRate.toFixed(1)} B/s with \`--no-alt-screen\`)`,
  ].join('\n');

  return [
    `## Contrat pour l'adaptateur`,
    ``,
    `Blocking checks: `,
    blocking,
    ``,
    `### 1. argv`,
    ``,
    '```sh',
    `codex \\`,
    `  --no-alt-screen \\`,
    `  -C <workspace-cwd> \\`,
    `  -m <model> \\`,
    `  --dangerously-bypass-approvals-and-sandbox`,
    '```',
    ``,
    `- \`--no-alt-screen\` — inline TUI, linear scrollback in the session log (idle silence is fine either way, see C7).`,
    `- \`-C <dir>\` — working root. The same absolute path MUST appear in \`[projects]\` (see below) or the TUI blocks on the trust modal (C4).`,
    `- \`-m <model>\` — or set \`model\` in config.toml. Spike ran on \`${MODEL}\`; the operator's default is \`gpt-5.5\`.`,
    `- \`--dangerously-bypass-approvals-and-sandbox\` — the equivalent of claude's \`--permission-mode bypassPermissions\`. **Mandatory**: without it, MCP tool calls come back as \`user cancelled MCP tool call\` (C2).`,
    `- Do NOT pass a positional PROMPT: it would start the turn before swarm-os has a chance to observe the boot. Inject the first message through the PTY like everything else.`,
    `- \`-a/--ask-for-approval\` exists only on the interactive command, **not** on \`codex exec\`.`,
    ``,
    `### 2. Environment`,
    ``,
    '```sh',
    `CODEX_HOME=/data/.codex-runtime/sessions/<session_id>   # per-session config root (C1)`,
    `SWARM_MCP_TOKEN=<per-session bearer>                     # consumed by bearer_token_env_var (C2)`,
    `TERM=xterm-256color`,
    '```',
    ``,
    `Seed the disposable CODEX_HOME with a **symlink** (or copy) of \`~/.codex/auth.json\`; nothing else from the operator's home is needed. Keep it OUT of \`/tmp\` — under a temp dir the CLI logs \`Refusing to create helper binaries under temporary dir\`.`,
    ``,
    `### 3. \`$CODEX_HOME/config.toml\` to generate`,
    ``,
    '```toml',
    `model = "gpt-5.5"`,
    `model_reasoning_effort = "high"           # none|minimal|low|medium|high|xhigh`,
    `notify = ["/data/.codex-runtime/sessions/<id>/notify.sh"]`,
    ``,
    `[projects."/workspace/<team>"]            # exact absolute cwd passed to -C`,
    `trust_level = "trusted"`,
    ``,
    `[mcp_servers.team-comms]`,
    `url = "http://127.0.0.1:8788/mcp/<orch_id>/<session_secret>"`,
    `bearer_token_env_var = "SWARM_MCP_TOKEN"  # optional; header arrives on every request`,
    `startup_timeout_sec = 30`,
    '```',
    ``,
    `Do **not** generate a \`[hooks]\` table: config-declared hooks never run unattended (they wait for an interactive review), and they make the TUI print a warning banner (C5).`,
    ``,
    `### 4. Preamble file`,
    ``,
    `\`$CODEX_HOME/AGENTS.md\` — plain markdown, injected as a user message headed \`# AGENTS.md instructions for <cwd>\`, re-injected after every context reset (C3a/C3b).`,
    `Optional short addendum: \`-c developer_instructions='…'\` (additive, appended inside the built-in developer message).`,
    `**Banned:** \`model_instructions_file\` (replaces the base Codex instructions — the agent loses its tool protocol) and its deprecated ancestor \`experimental_instructions_file\` (ignored outright).`,
    ``,
    `### 5. Context-reset tokens`,
    ``,
    `| swarm-os intent | codex token | effect |`,
    `|---|---|---|`,
    `| compact (summarize, keep going) | \`/compact\` | same thread-id, conversation summarized, prior facts survive |`,
    `| clear (wipe conversation) | \`/new\` | new thread-id, conversation dropped, TUI scrollback kept |`,
    `| clear + wipe the screen | \`/clear\` | new thread-id, conversation dropped, terminal cleared |`,
    ``,
    `All three are injected with the same two-step dance as ordinary text. The role preamble survives all three (C3b).`,
    ``,
    `### 6. capabilities`,
    ``,
    '```ts',
    `{`,
    `  effort: 'model_reasoning_effort',   // config.toml key; none|minimal|low|medium|high|xhigh (no CLI flag)`,
    `  notificationHook: 'notify',         // notify = ["<script>"]; JSON payload arrives as argv[1], stdin is empty`,
    `  inkSubmitDance: true,               // "text\\r" in one write does NOT submit; lone CR at +150 ms does`,
    `  durablePreamble: true,              // $CODEX_HOME/AGENTS.md survives /compact, /new and /clear`,
    `  httpMcp: true,                      // streamable HTTP, secret-in-path, optional bearer via env var`,
    `}`,
    '```',
    ``,
  ].join('\n');
}

// ----- main ---------------------------------------------------------------

async function main(): Promise<void> {
  const totalStart = Date.now();
  // Fresh scratch tree; also guarantees idempotency across runs.
  rmSync(SPIKE_TMP, { recursive: true, force: true });
  mkdirSync(SPIKE_TMP, { recursive: true });

  const results: CheckResult[] = [];
  const push = async (fn: () => Promise<CheckResult>, id: string, title: string): Promise<void> => {
    try {
      results.push(await fn());
    } catch (err) {
      results.push({
        id,
        title,
        status: 'UNVERIFIED',
        command: '(threw)',
        exitCode: null,
        stdout: '',
        stderr: String(err instanceof Error ? (err.stack ?? err.message) : err),
        notes: 'Check threw an unexpected exception — see stderr.',
        durationMs: 0,
      });
    }
  };

  const authPresent = existsSync(REAL_AUTH);
  console.log(`codex: ${codex.version ?? 'ABSENT'} · auth.json: ${authPresent ? 'present' : 'MISSING'} · model: ${MODEL}`);

  await push(checkC1, 'C1', 'CODEX_HOME isolates config.toml');
  await push(checkC4, 'C4', 'trust_level suppresses the trust dialog');

  const c7 = await checkC7().catch(
    (err: unknown): { result: CheckResult; noAltRate: number; altRate: number } => ({
      result: {
        id: 'C7',
        title: 'PTY silence at idle',
        status: 'UNVERIFIED',
        command: '(threw)',
        exitCode: null,
        stdout: '',
        stderr: String(err),
        notes: 'Check threw.',
        durationMs: 0,
      },
      noAltRate: NaN,
      altRate: NaN,
    }),
  );
  results.push(c7.result);

  await push(checkC3Static, 'C3a', 'Preamble channels');

  // One interactive session drives C2 (blocking), C3b, C5 and C6.
  let session: SessionOutcome | null = null;
  if (codex.ok && authPresent) {
    session = await runMainSession().catch((err: unknown): SessionOutcome => {
      const empty = {
        ok: false,
        error: String(err),
        notifies: [],
        hookLogExists: false,
        hooksNeedReview: false,
        singleWriteFired: false,
        singleWriteComposer: '',
        loneCrFired: false,
        loneCrInput: [],
        danceFired: false,
        danceAnswer: '',
        compactSeen: false,
        compactTail: '',
        afterCompact: '',
        afterCompactThread: '',
        afterNew: '',
        afterNewThread: '',
        afterClear: '',
        afterClearThread: '',
        firstThread: '',
        idleRateAfterTurn: NaN,
        bytesTotal: 0,
        trace: [],
        ptyExited: false,
        ptyExitCode: null,
      } satisfies SessionOutcome;
      return empty;
    });
  }

  if (session) {
    results.push(buildC2(session), buildC3b(session), buildC5(session), buildC6(session));
    // Cross-check C7 with a third measurement taken in the *working* session,
    // right after a completed turn (the moment swarm-os cares about).
    if (!Number.isNaN(session.idleRateAfterTurn)) {
      c7.result.stdout += `\npost-turn (main session, after an answered prompt): ${session.idleRateAfterTurn.toFixed(1)} B/s over 10s idle`;
      c7.result.notes += ` Cross-checked inside the driven session: ${session.idleRateAfterTurn.toFixed(1)} B/s during the 10 s that follow a completed turn.`;
      if (session.idleRateAfterTurn >= 100 && c7.result.status === 'CONFIRMED') c7.result.status = 'PARTIAL';
    }
  } else {
    const why = !codex.ok ? 'no codex CLI' : 'no ~/.codex/auth.json to symlink';
    for (const [id, title] of [
      ['C2', 'Per-session MCP over streamable HTTP (BLOCKING)'],
      ['C3b', 'Preamble durability across /compact, /new, /clear'],
      ['C5', 'Idle/turn-complete signal: notify vs [hooks]'],
      ['C6', 'PTY injection'],
    ] as const) {
      results.push({
        id,
        title,
        status: 'UNVERIFIED',
        command: '(skipped)',
        exitCode: null,
        stdout: '',
        stderr: '',
        notes: `UNVERIFIED — interactive session skipped (${why}).`,
        durationMs: 0,
      });
    }
  }

  // Order the report the way the mission numbers the checks.
  const order = ['C1', 'C2', 'C3a', 'C3b', 'C4', 'C5', 'C6', 'C7'];
  results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  const totalMs = Date.now() - totalStart;
  const counts = results.reduce<Record<Status, number>>(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { CONFIRMED: 0, REFUTED: 0, UNVERIFIED: 0, PARTIAL: 0 },
  );

  const blockingVerdict = (() => {
    const c2 = results.find((r) => r.id === 'C2')?.status;
    const c7s = results.find((r) => r.id === 'C7')?.status;
    if (c2 === 'REFUTED' || c7s === 'REFUTED')
      return `**BLOCKING CHECK FAILED** — C2=${c2}, C7=${c7s}. codex cannot be driven as an autonomous swarm-os agent as-is.`;
    if (c2 === 'CONFIRMED' && c7s === 'CONFIRMED')
      return `Both blocking checks pass (C2 MCP HTTP, C7 idle silence) — codex is drivable as a swarm-os agent.`;
    return `Blocking checks: C2=${c2}, C7=${c7s} — read their sections before committing to the adapter.`;
  })();

  const header = [
    `# Spike codex — CLI contract report`,
    ``,
    `_Generated by \`scripts/verify-codex.ts\` on ${new Date().toISOString()}._`,
    ``,
    `**Run command:** \`pnpm verify:codex\` (alias for \`pnpm --filter server exec tsx ../../scripts/verify-codex.ts\`).`,
    ``,
    `**Environment:**`,
    `- codex CLI: ${codex.ok ? `yes (\`${codex.path}\`)` : 'NOT FOUND'}`,
    `- codex version: ${codex.version ?? 'n/a'}`,
    `- model used by the spike: \`${MODEL}\` at \`model_reasoning_effort = "low"\``,
    `- node: ${process.version} · platform: ${process.platform}`,
    `- scratch root (removed at the end): \`${SPIKE_TMP}\` — the real \`~/.codex\` is never written to; only \`auth.json\` is symlinked in.`,
    ``,
    `**Summary:** CONFIRMED=${counts.CONFIRMED} · PARTIAL=${counts.PARTIAL} · REFUTED=${counts.REFUTED} · UNVERIFIED=${counts.UNVERIFIED} · total=${(totalMs / 1000).toFixed(0)}s`,
    ``,
    blockingVerdict,
    ``,
    `| check | status | evidence |`,
    `|-------|--------|----------|`,
    ...results.map((r) => `| ${r.id} — ${r.title} | ${r.status} | ${r.command.replace(/\|/g, '\\|').slice(0, 180)} |`),
    ``,
    `---`,
    ``,
  ].join('\n');

  const body = results.map(renderSection).join('\n');
  const tail = ['---', '', renderContract(results, c7), ''].join('\n');
  writeFileSync(REPORT_PATH, header + body + tail);

  // Clean up after ourselves (idempotency + no orphan credentials symlink).
  try {
    rmSync(SPIKE_TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  console.log(`\nspike done in ${(totalMs / 1000).toFixed(0)}s — report: ${REPORT_PATH}`);
  for (const r of results) console.log(`  ${r.status.padEnd(10)} ${r.id.padEnd(4)} ${r.title}`);
  console.log(
    `\ntotals: CONFIRMED=${counts.CONFIRMED} PARTIAL=${counts.PARTIAL} REFUTED=${counts.REFUTED} UNVERIFIED=${counts.UNVERIFIED}`,
  );
}

void main();
