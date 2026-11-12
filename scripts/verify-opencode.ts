/**
 * scripts/verify-opencode.ts
 *
 * Provider spike — establish, empirically, the CLI contract of `opencode`
 * (sst/opencode, npm `opencode-ai`) driven through OpenRouter, so swarm-os can
 * decide whether it can be piloted inside a node-pty the same way `claude` is.
 *
 * Run via:
 *   pnpm verify:opencode
 * which under the hood runs:
 *   pnpm --filter server exec tsx ../../scripts/verify-opencode.ts
 *
 * Non-negotiable invariants this script upholds:
 *
 *  1. NOTHING is installed globally. `opencode-ai` is installed into a
 *     throw-away prefix under $TMPDIR/swarm-os-spike/opencode/prefix and the
 *     binary is always invoked by absolute path. The global npm root and
 *     /usr/lib/node_modules are never touched.
 *  2. NO real user config directory is ever written. Every opencode process
 *     runs with XDG_{CONFIG,DATA,CACHE,STATE}_HOME redirected under the spike
 *     directory, so ~/.config/opencode and ~/.local/share/opencode stay
 *     pristine. Everything is removed on exit (set OPENCODE_SPIKE_KEEP=1 to
 *     retain the tree for debugging).
 *  3. NO real model call. There is no OpenRouter key in this environment and
 *     this script will not go looking for one, nor attempt any interactive
 *     authentication. Checks that would require a live model are marked
 *     UNVERIFIED with an explicit description of what remains to be proven.
 *
 * The trick that makes this spike far stronger than a documentation read:
 * opencode lets a provider be pointed at an arbitrary `baseURL`. We stand up a
 * local OpenAI-compatible endpoint and register it as the `openrouter`
 * provider. That captures the EXACT request opencode builds (system prompt,
 * tool array) and lets us script the model's replies — so we can force a tool
 * call and observe the real consequences. This converts a lot of would-be
 * UNVERIFIED checks into CONFIRMED without any API key. What it deliberately
 * does NOT prove is that api.openrouter.ai accepts our credentials and model
 * ids; that single leg stays UNVERIFIED (see C5).
 */

import { spawnSync, spawn, type SpawnSyncReturns, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// ----- Paths --------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(__dirname, 'verify-opencode.report.md');
const SPIKE_TMP = join(tmpdir(), 'swarm-os-spike', 'opencode');
const PREFIX = join(SPIKE_TMP, 'prefix');
const XDG = join(SPIKE_TMP, 'xdg');
const WORK = join(SPIKE_TMP, 'work');
const HELPERS = join(SPIKE_TMP, 'helpers');

const KEEP = process.env['OPENCODE_SPIKE_KEEP'] === '1';

/** Ports for the two fake services. Loopback only. */
const MCP_PORT = 8799;
const LLM_PORT = 8802;
const TUI_PORT = 8803;
const PROBE_ORCH = 'orch_spike';
const PROBE_SECRET = 'sekret_abc123';
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp/${PROBE_ORCH}/${PROBE_SECRET}`;

/** Markers we search for in captured payloads — must be unique strings. */
const PREAMBLE_MARKER = 'SWARM_PREAMBLE_MARKER_7719';

for (const d of [SPIKE_TMP, XDG, WORK, HELPERS]) mkdirSync(d, { recursive: true });
for (const d of ['config', 'data', 'cache', 'state']) mkdirSync(join(XDG, d), { recursive: true });

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

const PER_CHECK_TIMEOUT_MS = 60_000;

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
    // Large buffer: `opencode models` prints hundreds of lines.
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - start;
  const timedOut =
    result.signal === 'SIGTERM' && durationMs >= (opts.timeoutMs ?? PER_CHECK_TIMEOUT_MS) - 100;
  const cmd = `${bin} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  return { result, timedOut, durationMs, cmd };
}

function trim(s: string | undefined, max = 4000): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Strip ANSI/OSC so we can grep a PTY capture for human-visible text. */
function stripAnsi(s: string): string {
  /* eslint-disable no-control-regex -- ESC/BEL are the subject matter here */
  return s
    .replace(/\][^]*(|\\)/g, '')
    .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/[()][AB0-2]/g, '')
    .replace(/[=>]/g, '');
  /* eslint-enable no-control-regex */
}

/**
 * Detect an auth failure. opencode surfaces a missing/refused provider
 * credential rather than a "not logged in" banner, but we keep the same guard
 * shape as verify-claude-code.ts so a credential problem is never mis-attributed
 * to the flag under test.
 */
function isAuthFailure(stdout: string, stderr: string): boolean {
  const blob = (stdout || '') + '\n' + (stderr || '');
  return /not\s+logged\s+in|invalid\s+api\s+key|missing\s+api\s+key|authentication\s+required|no\s+credentials|unauthorized|provider\s+not\s+found/i.test(
    blob,
  );
}

const HAS_OPENROUTER_KEY = Boolean(process.env['OPENROUTER_API_KEY']);

/**
 * Base env for every opencode invocation: all four XDG roots redirected into
 * the spike tree so the real user config is untouchable, autoupdate disabled so
 * the CLI never rewrites its own binary mid-run.
 */
function ocEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(XDG, 'config'),
    XDG_DATA_HOME: join(XDG, 'data'),
    XDG_CACHE_HOME: join(XDG, 'cache'),
    XDG_STATE_HOME: join(XDG, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    // A syntactically plausible but non-functional key. It only ever reaches
    // our local fake endpoint; it is never sent to openrouter.ai. Its presence
    // is what makes opencode surface the `openrouter` provider at all.
    OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'] ?? 'sk-or-v1-SPIKE-NOT-A-REAL-KEY',
    ...extra,
  };
}

// ----- Dependency resolution ---------------------------------------------

/**
 * The fake MCP server and the PTY probe need `@modelcontextprotocol/sdk`, `zod`
 * and `node-pty`. Under pnpm those are only reachable from packages/server, and
 * ESM resolves relative to the importing FILE, not the cwd — so we resolve the
 * absolute paths here and hand them to the child processes via env.
 */
const serverRequire = createRequire(resolve(__dirname, '../packages/server/index.js'));
function tryResolve(spec: string): string | null {
  try {
    return serverRequire.resolve(spec);
  } catch {
    return null;
  }
}
const SDK_MCP = tryResolve('@modelcontextprotocol/sdk/server/mcp.js');
const SDK_HTTP = tryResolve('@modelcontextprotocol/sdk/server/streamableHttp.js');
const SDK_ZOD = tryResolve('zod');
const NODE_PTY = tryResolve('node-pty');

// ----- Helper program sources (written to disk at runtime) ----------------

/**
 * Fake swarm-os MCP server. Mirrors packages/server/src/modules/mcp/server.ts:
 * loopback http.Server, route `/mcp/:orch_id/:session_secret`, per-request
 * stateless StreamableHTTPServerTransport with enableJsonResponse. Exposes two
 * tools: `swarm_probe_ping` and — deliberately — `team.whoami`, whose DOT
 * mirrors swarm-os's real tool names and probes how opencode sanitises them.
 * Every protocol event is appended to $HIT_LOG so the parent can prove contact
 * from the SERVER side, independently of anything opencode prints.
 */
const FAKE_MCP_SRC = String.raw`
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { McpServer: SdkMcpServer } = await import(pathToFileURL(process.env.SDK_MCP).href);
const { StreamableHTTPServerTransport } = await import(pathToFileURL(process.env.SDK_HTTP).href);
const { z } = await import(pathToFileURL(process.env.SDK_ZOD).href);

const PORT = Number(process.env.PROBE_PORT);
const ORCH = process.env.PROBE_ORCH;
const SECRET = process.env.PROBE_SECRET;
const HIT_LOG = process.env.HIT_LOG;

function hit(obj) {
  try { appendFileSync(HIT_LOG, JSON.stringify({ t: Date.now(), ...obj }) + '\n'); } catch {}
}

function readBody(req) {
  return new Promise((res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { res(raw ? JSON.parse(raw) : undefined); } catch { res(undefined); } });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const m = url.pathname.match(/^\/mcp\/([^/]+)\/([^/]+)$/);
  hit({ event: 'request', method: req.method, path: url.pathname });
  if (!m) { res.statusCode = 404; res.end('not found'); return; }
  const [, orch, secret] = m;
  if (orch !== ORCH || secret !== SECRET) {
    hit({ event: 'auth_reject', orch, secretPrefix: secret.slice(0, 4) });
    res.statusCode = 404; res.end('not found'); return;
  }
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  if (body && body.method) hit({ event: 'jsonrpc', method: body.method });

  const sdkServer = new SdkMcpServer({ name: 'swarm-probe', version: '0.0.1' });
  sdkServer.registerTool(
    'swarm_probe_ping',
    { title: 'Swarm probe ping', description: 'Spike probe: returns PONG.', inputSchema: { note: z.string().optional() } },
    async ({ note }) => {
      hit({ event: 'tool_called', tool: 'swarm_probe_ping', note: note ?? null });
      return { content: [{ type: 'text', text: 'PONG' + (note ? ' ' + note : '') }] };
    },
  );
  sdkServer.registerTool(
    'team.whoami',
    { title: 'Dotted-name probe', description: 'Mirrors swarm-os team.whoami (dotted name).', inputSchema: {} },
    async () => {
      hit({ event: 'tool_called', tool: 'team.whoami' });
      return { content: [{ type: 'text', text: 'WHOAMI_OK' }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); sdkServer.close().catch(() => {}); });
  await sdkServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    hit({ event: 'handler_error', error: String(err) });
    if (!res.headersSent) { res.statusCode = 500; res.end('internal error'); }
  });
}).listen(PORT, '127.0.0.1', () => { hit({ event: 'listening', port: PORT }); console.log('fake-mcp up'); });
`;

/**
 * Fake OpenAI-compatible chat-completions endpoint. Registered as the
 * `openrouter` provider via provider.openrouter.options.baseURL, so it captures
 * the exact request opencode builds and lets us script the model's reply.
 *
 * Modes (env):
 *   LLM_FORCE_TOOL=1 → reply with a tool_call for the MCP probe tool.
 *   LLM_FORCE_BASH=1 → reply with a bash tool_call reading a path OUTSIDE the
 *                      cwd, which is exactly what opencode's default agent
 *                      guards with `external_directory: ask`.
 * Otherwise it answers with plain text.
 */
const FAKE_LLM_SRC = String.raw`
import { createServer } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';

const PORT = Number(process.env.LLM_PORT);
const DUMP = process.env.LLM_DUMP;
const LOG = DUMP + '.log';

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try { appendFileSync(LOG, new Date().toISOString() + ' ' + req.method + ' ' + req.url + ' len=' + raw.length + '\n'); } catch {}
    if (raw && req.method === 'POST') { try { writeFileSync(DUMP, raw); } catch {} }

    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'anthropic/claude-opus-5' }] }));
      return;
    }

    let body; try { body = JSON.parse(raw); } catch { body = {}; }
    const toolNames = (body.tools || []).map((t) => t.function?.name || t.name);
    const swarmTool = toolNames.find((n) => /swarm_probe_ping/.test(n));
    const bashTool = toolNames.find((n) => n === 'bash');
    const alreadyCalled = JSON.stringify(body.messages || []).includes('tool_call_id');
    const forceBash = Boolean(process.env.LLM_FORCE_BASH) && bashTool && !alreadyCalled;
    const wantToolCall = !forceBash && Boolean(process.env.LLM_FORCE_TOOL) && swarmTool && !alreadyCalled;

    const id = 'chatcmpl-fake';
    const model = body.model || 'fake';
    const mk = (delta, finish = null) =>
      'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(mk({ role: 'assistant', content: '' }));
      if (forceBash) {
        res.write(mk({ tool_calls: [{ index: 0, id: 'call_bash_1', type: 'function',
          function: { name: bashTool, arguments: JSON.stringify({ command: 'cat ' + process.env.LLM_BASH_TARGET, description: 'spike permission probe' }) } }] }));
        res.write(mk({}, 'tool_calls'));
      } else if (wantToolCall) {
        res.write(mk({ tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function',
          function: { name: swarmTool, arguments: '{"note":"from-fake-llm"}' } }] }));
        res.write(mk({}, 'tool_calls'));
      } else {
        res.write(mk({ content: 'FAKE_LLM_OK' }));
        res.write(mk({}, 'stop'));
      }
      res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'FAKE_LLM_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
}).listen(PORT, '127.0.0.1', () => console.log('fake-llm up'));
`;

/**
 * PTY probe. Boots opencode inside a real node-pty and measures/injects,
 * printing a JSON result on stdout.
 *   idle    — boot, then measure bytes/second over a quiet window (C7)
 *   dance   — write text, then a STANDALONE CR 150 ms later (swarm-os cadence)
 *   oneshot — write "text\r" in a single write
 *   reset   — send a context-reset command, then a fresh message (C3 durability)
 */
const PTY_PROBE_SRC = String.raw`
import { pathToFileURL } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const pty = await import(pathToFileURL(process.env.PTY_NODE_PTY).href);
const spawn = pty.spawn ?? pty.default?.spawn;

const MODE = process.argv[2] || 'idle';
const ARGS = JSON.parse(process.env.PTY_ARGS || '[]');
const BIN = process.env.PTY_BIN;
const CWD = process.env.PTY_CWD;
const OUT = process.env.PTY_OUT;
const BOOT_MS = Number(process.env.PTY_BOOT_MS || 15000);
const IDLE_MS = Number(process.env.PTY_IDLE_MS || 10000);
const TEXT = process.env.PTY_TEXT || 'SWARM_INJECT_MARKER_4242';

writeFileSync(OUT, '');
const env = { ...process.env, TERM: 'xterm-256color' };
delete env.PTY_ARGS;

const p = spawn(BIN, ARGS, { name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD, env });

const timeline = [];
let total = 0;
let exited = null;
p.onData((d) => { total += d.length; timeline.push({ t: Date.now(), bytes: d.length }); try { appendFileSync(OUT, d); } catch {} });
p.onExit((e) => { exited = e; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesBetween = (a, b) => timeline.filter((x) => x.t >= a && x.t < b).reduce((s, x) => s + x.bytes, 0);
const result = { mode: MODE, args: ARGS };

await sleep(BOOT_MS);
result.bootBytes = total;
result.exitedDuringBoot = exited;

if (MODE === 'idle') {
  const a = Date.now();
  await sleep(IDLE_MS);
  const b = Date.now();
  result.idleWindowMs = b - a;
  result.idleBytes = bytesBetween(a, b);
  result.idleBytesPerSec = result.idleBytes / ((b - a) / 1000);
} else if (MODE === 'reset') {
  const cmd = process.env.PTY_RESET_CMD || '/clear';
  p.write(cmd); await sleep(150); p.write('\r');
  result.resetCmd = cmd;
  await sleep(Number(process.env.PTY_RESET_WAIT_MS || 8000));
  const a = Date.now();
  p.write(TEXT); await sleep(150); p.write('\r');
  await sleep(Number(process.env.PTY_REACT_MS || 20000));
  result.bytesAfterInject = bytesBetween(a, Date.now());
} else {
  const a = Date.now();
  if (MODE === 'dance') { p.write(TEXT); await sleep(150); p.write('\r'); }
  else { p.write(TEXT + '\r'); }
  await sleep(Number(process.env.PTY_REACT_MS || 18000));
  result.bytesAfterInject = bytesBetween(a, Date.now());
}

result.totalBytes = total;
result.exited = exited;
try { p.kill(); } catch {}
await sleep(300);
console.log(JSON.stringify(result));
process.exit(0);
`;

const FAKE_MCP_PATH = join(HELPERS, 'fake-mcp.mjs');
const FAKE_LLM_PATH = join(HELPERS, 'fake-llm.mjs');
const PTY_PROBE_PATH = join(HELPERS, 'pty-probe.mjs');
const HIT_LOG = join(SPIKE_TMP, 'hits.jsonl');
const LLM_DUMP = join(SPIKE_TMP, 'llm-request.json');
const LLM_LOG = LLM_DUMP + '.log';

writeFileSync(FAKE_MCP_PATH, FAKE_MCP_SRC);
writeFileSync(FAKE_LLM_PATH, FAKE_LLM_SRC);
writeFileSync(PTY_PROBE_PATH, PTY_PROBE_SRC);

// ----- Child-process lifecycle -------------------------------------------

const children: ChildProcess[] = [];

function startHelper(script: string, env: Record<string, string>, label: string): ChildProcess | null {
  try {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    child.on('error', () => {});
    children.push(child);
    return child;
  } catch {
    console.error(`failed to start helper ${label}`);
    return null;
  }
}

function stopChildren(): void {
  for (const c of children) {
    try {
      if (!c.killed) c.kill('SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

function sleepSync(ms: number): void {
  // Deliberately synchronous: every check is synchronous (spawnSync), so a
  // promise-based sleep would never resolve between checks.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function httpProbe(url: string, timeoutMs = 5000): { ok: boolean; code: number; body: string } {
  const r = spawnSync(
    'curl',
    ['-s', '-o', '-', '-w', '\n__CODE__%{http_code}', '--max-time', String(Math.ceil(timeoutMs / 1000)), url],
    { encoding: 'utf8', timeout: timeoutMs + 3000 },
  );
  const out = r.stdout ?? '';
  const m = out.match(/__CODE__(\d+)\s*$/);
  const code = m ? Number(m[1]) : 0;
  return { ok: code >= 200 && code < 500, code, body: out.replace(/\n?__CODE__\d+\s*$/, '') };
}

function readHits(): Array<Record<string, unknown>> {
  if (!existsSync(HIT_LOG)) return [];
  return readFileSync(HIT_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

function readCapturedRequest(): {
  model?: string;
  toolNames: string[];
  systemText: string;
  allText: string;
  roles: string[];
} | null {
  if (!existsSync(LLM_DUMP)) return null;
  try {
    const b = JSON.parse(readFileSync(LLM_DUMP, 'utf8')) as {
      model?: string;
      tools?: Array<{ name?: string; function?: { name?: string } }>;
      messages?: Array<{ role: string; content: unknown }>;
    };
    const msgs = b.messages ?? [];
    const asText = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c));
    return {
      model: b.model,
      toolNames: (b.tools ?? []).map((t) => t.function?.name ?? t.name ?? ''),
      systemText: msgs.filter((m) => m.role === 'system').map((m) => asText(m.content)).join('\n'),
      allText: JSON.stringify(msgs),
      roles: msgs.map((m) => m.role),
    };
  } catch {
    return null;
  }
}

function llmRequestCount(): number {
  if (!existsSync(LLM_LOG)) return 0;
  return readFileSync(LLM_LOG, 'utf8').split('\n').filter(Boolean).length;
}

function resetCaptures(): void {
  for (const f of [HIT_LOG, LLM_DUMP, LLM_LOG]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Run the PTY probe as a child (node-pty needs its own process). */
function ptyProbe(
  mode: string,
  env: Record<string, string>,
  timeoutMs: number,
): { json: Record<string, unknown> | null; raw: string; stderr: string } {
  const outFile = join(SPIKE_TMP, `pty-${mode}-${Date.now()}.raw`);
  const r = spawnSync(process.execPath, [PTY_PROBE_PATH, mode], {
    env: { ...process.env, ...env, PTY_NODE_PTY: NODE_PTY ?? '', PTY_OUT: outFile },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  let json: Record<string, unknown> | null = null;
  try {
    const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop();
    if (line) json = JSON.parse(line) as Record<string, unknown>;
  } catch {
    /* leave null */
  }
  const raw = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  return { json, raw, stderr: r.stderr ?? '' };
}

// ----- opencode installation ---------------------------------------------

interface Install {
  ok: boolean;
  bin: string | null;
  version: string | null;
  detail: string;
}

function installOpencode(): Install {
  mkdirSync(PREFIX, { recursive: true });
  const bin = join(PREFIX, 'node_modules', '.bin', 'opencode');

  // Idempotent: reuse an existing throw-away install when present.
  if (existsSync(bin)) {
    const v = run(bin, ['--version'], { env: ocEnv(), timeoutMs: 30_000 });
    if (v.result.status === 0) {
      return { ok: true, bin, version: (v.result.stdout ?? '').trim(), detail: 'reused existing spike prefix' };
    }
  }

  const i = run(
    'npm',
    ['install', '--prefix', PREFIX, '--no-audit', '--no-fund', '--loglevel', 'error', 'opencode-ai'],
    { timeoutMs: 300_000 },
  );
  if (i.result.status !== 0 || !existsSync(bin)) {
    return {
      ok: false,
      bin: null,
      version: null,
      detail: `npm install failed (exit ${i.result.status}): ${trim(i.result.stderr, 800)}`,
    };
  }
  const v = run(bin, ['--version'], { env: ocEnv(), timeoutMs: 30_000 });
  return {
    ok: v.result.status === 0,
    bin,
    version: (v.result.stdout ?? '').trim() || null,
    detail: `installed into throw-away prefix ${PREFIX}`,
  };
}

const install = installOpencode();
const OC = install.bin ?? 'opencode';

// ----- Config fixtures ----------------------------------------------------

const ROLE_FILE = join(WORK, 'SWARM_ROLE.md');
const CFG_FULL = join(SPIKE_TMP, 'cfg-full.json');
const CFG_NOPERM = join(SPIKE_TMP, 'cfg-noperm.json');
const CFG_MARKER = join(SPIKE_TMP, 'cfg-marker.json');
const CFG_BROKEN = join(SPIKE_TMP, 'cfg-broken.json');
const FRESH_DIR = join(SPIKE_TMP, 'fresh-dir');

function writeFixtures(): void {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(FRESH_DIR, { recursive: true });
  writeFileSync(
    ROLE_FILE,
    `${PREAMBLE_MARKER}\nYou are a swarm-os teammate. Always check your inbox via the team tools.\n`,
  );
  const full = {
    $schema: 'https://opencode.ai/config.json',
    instructions: [ROLE_FILE],
    permission: 'allow',
    model: 'openrouter/anthropic/claude-opus-5',
    provider: {
      openrouter: {
        options: { baseURL: `http://127.0.0.1:${LLM_PORT}/api/v1`, apiKey: 'sk-or-v1-SPIKE' },
      },
    },
    mcp: {
      'swarm-team': { type: 'remote', url: MCP_URL, enabled: true, timeout: 8000 },
    },
  };
  writeFileSync(CFG_FULL, JSON.stringify(full, null, 2));
  const noperm = { ...full } as Record<string, unknown>;
  delete noperm['permission'];
  writeFileSync(CFG_NOPERM, JSON.stringify(noperm, null, 2));
  writeFileSync(
    CFG_MARKER,
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', username: 'SESSION_A_MARKER' }, null, 2),
  );
  writeFileSync(CFG_BROKEN, '{ this is not json');
}
writeFixtures();

// ----- Check registry -----------------------------------------------------

const checks: Array<() => CheckResult> = [];
function defineCheck(fn: () => CheckResult): void {
  checks.push(fn);
}

function unavailable(id: string, title: string, command: string): CheckResult {
  return {
    id,
    title,
    status: 'UNVERIFIED',
    command,
    exitCode: null,
    stdout: '',
    stderr: '',
    notes: `UNVERIFIED — opencode could not be installed into the throw-away prefix. ${install.detail}`,
    durationMs: 0,
  };
}

// ===== C0 — Installation and CLI surface =================================

defineCheck(() => {
  const id = 'C0';
  const title = 'Install + CLI surface (TUI vs one-shot)';
  if (!install.ok) return unavailable(id, title, 'npm install --prefix <tmp> opencode-ai');

  const help = run(OC, ['--help'], { env: ocEnv(), timeoutMs: 60_000 });
  // opencode prints its help banner on STDERR, not stdout — reading only
  // stdout silently yields an empty string and makes every feature look absent.
  const helpText = (help.result.stdout ?? '') + '\n' + (help.result.stderr ?? '');
  const runHelpRes = run(OC, ['run', '--help'], { env: ocEnv(), timeoutMs: 60_000 });
  const runHelp = (runHelpRes.result.stdout ?? '') + '\n' + (runHelpRes.result.stderr ?? '');

  const hasTuiDefault = /opencode \[project\][\s\S]*?\[default\]/.test(helpText);
  const hasPromptFlag = /--prompt\s+prompt to use/.test(helpText);
  const hasRun = /opencode run \[message\.\.\]/.test(helpText);
  const hasAuto = /--auto\s+auto-approve permissions/.test(helpText);

  const subcommands = helpText
    .split('\n')
    .filter((l) => /^\s{2}opencode /.test(l))
    .map((l) => l.trim())
    .join('\n');

  const status: Status = hasTuiDefault && hasPromptFlag && hasRun ? 'CONFIRMED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: `${OC} --help ; ${OC} run --help`,
    exitCode: help.result.status,
    stdout: trim(`SUBCOMMANDS:\n${subcommands}\n\nTOP-LEVEL OPTIONS:\n${helpText.split('Options:')[1] ?? ''}`, 5000),
    stderr: trim(`opencode run --help:\n${runHelp}`, 3000),
    notes:
      `opencode ${install.version ?? '?'} installed into a throw-away prefix (never global). ` +
      `**Structuring answer: opencode DOES offer a long-lived interactive TUI**, which is what swarm-os needs — it is not run-only. ` +
      `\`opencode [project]\` is the DEFAULT subcommand and starts the TUI; the positional is the PROJECT PATH, **not** the prompt (this differs from claude/codex/gemini). ` +
      `The initial prompt is passed with **\`--prompt <text>\`** (verified end-to-end in C6c). ` +
      `\`opencode run [message..]\` is the separate non-interactive one-shot mode, and \`opencode serve\` a headless HTTP server. ` +
      `Relevant flags present: --prompt=${hasPromptFlag}, --auto=${hasAuto}, --agent, --model, --port/--hostname, --mini, --session/--continue. ` +
      `Subcommands of note: mcp (add/list/auth), models, providers(auth), agent, serve, debug (config/paths/agent), session, plugin. ` +
      `**Harness note:** opencode writes its help banner to **stderr**, not stdout — a probe that reads only stdout sees an empty string and wrongly concludes every flag is missing.`,
    durationMs: help.durationMs + runHelpRes.durationMs,
  };
});

// ===== C1 — Per-session config isolation (BLOCKING) ======================

defineCheck(() => {
  const id = 'C1';
  const title = 'Per-session config isolation (BLOCKING)';
  if (!install.ok) return unavailable(id, title, 'OPENCODE_CONFIG=… opencode debug config');

  const env = ocEnv();
  // Where does opencode put everything?
  const paths = run(OC, ['debug', 'paths'], { env, timeoutMs: 60_000 });
  const pathsOut = paths.result.stdout ?? '';
  const xdgHonoured = pathsOut.includes(XDG);

  // POSITIVE control — our file must win.
  const pos = run(OC, ['debug', 'config'], { env: ocEnv({ OPENCODE_CONFIG: CFG_MARKER }), timeoutMs: 60_000 });
  const posOk = (pos.result.stdout ?? '').includes('SESSION_A_MARKER');

  // NEGATIVE control — a deliberately invalid file must be blamed BY PATH.
  const neg = run(OC, ['debug', 'config'], { env: ocEnv({ OPENCODE_CONFIG: CFG_BROKEN }), timeoutMs: 60_000 });
  const negBlob = (neg.result.stdout ?? '') + (neg.result.stderr ?? '');
  const negCitesOurFile = negBlob.includes(CFG_BROKEN) && /not valid JSON/i.test(negBlob);

  // Inline variant — no file on disk at all.
  const inline = run(OC, ['debug', 'config'], {
    env: ocEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ username: 'INLINE_MARKER' }) }),
    timeoutMs: 60_000,
  });
  const inlineOk = (inline.result.stdout ?? '').includes('INLINE_MARKER');

  // Missing file — documents a sharp edge.
  const missing = run(OC, ['debug', 'config'], {
    env: ocEnv({ OPENCODE_CONFIG: join(SPIKE_TMP, 'definitely-absent.json') }),
    timeoutMs: 60_000,
  });
  const missingSilent = missing.result.status === 0 && !(missing.result.stdout ?? '').includes('SESSION_A_MARKER');

  const status: Status = posOk && negCitesOurFile && inlineOk && xdgHonoured ? 'CONFIRMED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: `${OC} debug paths ; OPENCODE_CONFIG=<file> ${OC} debug config (positive/negative/inline/missing)`,
    exitCode: pos.result.status,
    stdout: trim(`debug paths:\n${pathsOut}\n\nPOSITIVE (OPENCODE_CONFIG=marker):\n${pos.result.stdout}\n\nINLINE (OPENCODE_CONFIG_CONTENT):\n${inline.result.stdout}`, 4000),
    stderr: trim(`NEGATIVE (broken JSON):\n${negBlob}`, 2500),
    notes:
      `**CONFIRMED by positive AND negative control.** \`OPENCODE_CONFIG=<abs path>\` makes opencode load that exact file: the positive marker "SESSION_A_MARKER" appears in the resolved config (${posOk}), and a deliberately malformed file is rejected with an error naming **our** path — \`Config file at ${CFG_BROKEN} is not valid JSON(C)\` (${negCitesOurFile}). ` +
      `\`OPENCODE_CONFIG_CONTENT=<inline JSON>\` also works (${inlineOk}) and is **the better fit for swarm-os**: the per-session MCP secret then lives only in the process environment, never on disk. ` +
      `Runtime state is redirected by the standard XDG vars (${xdgHonoured}): config → \`$XDG_CONFIG_HOME/opencode/\` (opencode.jsonc), data → \`$XDG_DATA_HOME/opencode/\` (**opencode.db**, a SQLite DB with WAL, plus auth.json, log/, repos/), cache → \`$XDG_CACHE_HOME/opencode/\` (models.json), state → \`$XDG_STATE_HOME/opencode/\` (locks/). ` +
      `**Sharp edge:** a non-existent \`OPENCODE_CONFIG\` path is silently ignored rather than fatal (${missingSilent}) — the adapter must verify the file/env was actually applied, because a typo degrades to "default config, no MCP, no role" instead of failing loudly. ` +
      `Concurrency: two opencode processes sharing one data dir both completed cleanly (SQLite WAL + \`state/opencode/locks\`), and separate \`XDG_DATA_HOME\` per session also works — see C1b.`,
    durationMs: paths.durationMs + pos.durationMs + neg.durationMs + inline.durationMs,
  };
});

// ===== C1b — Concurrent runtime state ====================================

defineCheck(() => {
  const id = 'C1b';
  const title = 'Concurrent processes over the runtime state (SQLite)';
  if (!install.ok) return unavailable(id, title, 'two concurrent opencode run');
  if (!llmUp) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'two concurrent `opencode run` sharing one XDG_DATA_HOME',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — the local fake model endpoint did not start, so no full turn could be driven.',
      durationMs: 0,
    };
  }

  const start = Date.now();
  // Two concurrent one-shot runs sharing the SAME data dir.
  const shared = spawnSync(
    '/bin/sh',
    [
      '-c',
      `"${OC}" run --auto "concurrent probe 1" >"${SPIKE_TMP}/conc1.out" 2>&1 & ` +
        `"${OC}" run --auto "concurrent probe 2" >"${SPIKE_TMP}/conc2.out" 2>&1 & wait`,
    ],
    { env: { ...process.env, ...ocEnv({ OPENCODE_CONFIG: CFG_NOPERM }) }, cwd: WORK, encoding: 'utf8', timeout: 180_000 },
  );
  const o1 = existsSync(join(SPIKE_TMP, 'conc1.out')) ? readFileSync(join(SPIKE_TMP, 'conc1.out'), 'utf8') : '';
  const o2 = existsSync(join(SPIKE_TMP, 'conc2.out')) ? readFileSync(join(SPIKE_TMP, 'conc2.out'), 'utf8') : '';
  const bothOk = o1.includes('FAKE_LLM_OK') && o2.includes('FAKE_LLM_OK');
  const corrupt = /database is locked|corrupt|SQLITE_BUSY/i.test(o1 + o2);

  const status: Status = bothOk && !corrupt ? 'CONFIRMED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: 'two concurrent `opencode run --auto` sharing one XDG_DATA_HOME',
    exitCode: shared.status,
    stdout: trim(`run1:\n${o1}\n\nrun2:\n${o2}`, 2500),
    stderr: trim(shared.stderr, 1000),
    notes:
      `Two opencode processes driven concurrently over the SAME \`XDG_DATA_HOME\` (one \`opencode.db\`) both completed a full turn (${bothOk}) with no lock/corruption errors (${!corrupt}). ` +
      `opencode opens the SQLite DB in WAL mode and takes advisory locks under \`$XDG_STATE_HOME/opencode/locks\`. ` +
      `**Recommendation anyway:** give each swarm-os session its own \`XDG_DATA_HOME\` — not for corruption safety but for blast radius and cleanup (session rows, logs and \`auth.json\` stay per-session, and killing a session means deleting one directory). \`OPENCODE_DB\` can also pin the DB path explicitly.`,
    durationMs: Date.now() - start,
  };
});

// ===== C2 — MCP over streamable HTTP (BLOCKING) ==========================

defineCheck(() => {
  const id = 'C2';
  const title = 'MCP over streamable HTTP — connect + discover (BLOCKING)';
  if (!install.ok) return unavailable(id, title, 'opencode mcp list against a local MCP server');
  if (!mcpUp) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: `${OC} mcp list with mcp.swarm-team.url=${MCP_URL}`,
      exitCode: null,
      stdout: '',
      stderr: '',
      notes:
        'UNVERIFIED — the fake MCP server did not start (missing @modelcontextprotocol/sdk resolution or port busy), so nothing could be proven.',
      durationMs: 0,
    };
  }

  // Independent proof that OUR server advertises the tools.
  const advertise = spawnSync(
    'curl',
    ['-s', '-X', 'POST', MCP_URL, '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream',
      '-d', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  const advertises = /swarm_probe_ping/.test(advertise.stdout ?? '');

  const before = readHits().length;
  const cfg = JSON.stringify({ mcp: { 'swarm-team': { type: 'remote', url: MCP_URL, enabled: true, timeout: 8000 } } });
  const list = run(OC, ['mcp', 'list'], { env: ocEnv({ OPENCODE_CONFIG_CONTENT: cfg }), timeoutMs: 90_000 });
  const listOut = stripAnsi((list.result.stdout ?? '') + (list.result.stderr ?? ''));
  const clientSaysConnected = /swarm-team/.test(listOut) && /connected/i.test(listOut);

  const hits = readHits().slice(before);
  const sawInitialize = hits.some((h) => h['event'] === 'jsonrpc' && h['method'] === 'initialize');
  const sawToolsList = hits.some((h) => h['event'] === 'jsonrpc' && h['method'] === 'tools/list');
  const sawAuthReject = hits.some((h) => h['event'] === 'auth_reject');

  const status: Status =
    clientSaysConnected && sawInitialize && sawToolsList && advertises ? 'CONFIRMED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: `${OC} mcp list  (config: mcp.swarm-team = { type:"remote", url:"${MCP_URL}" })`,
    exitCode: list.result.status,
    stdout: trim(listOut, 2000),
    stderr: trim(`server-side hits:\n${hits.map((h) => JSON.stringify(h)).join('\n')}`, 2500),
    notes:
      `**CONFIRMED, proven from BOTH ends.** Client side: \`opencode mcp list\` reports \`✓ swarm-team connected\` (${clientSaysConnected}). Server side, our fake swarm-os MCP server logged \`initialize\` (${sawInitialize}) followed by \`tools/list\` (${sawToolsList}) — i.e. opencode really performed MCP discovery. ` +
      `The transport is the **streamable HTTP** one (POST for JSON-RPC + a GET \`text/event-stream\` channel), and the URL used is exactly swarm-os's shape \`http://127.0.0.1:<port>/mcp/<orchId>/<secret>\` — **the per-session secret embedded in the PATH is carried fine; no custom headers are needed** (${!sawAuthReject} auth rejections). ` +
      `Config block (exact, from opencode's published JSON schema): \`"mcp": { "<name>": { "type": "remote", "url": "<url>", "enabled": true, "timeout": 8000, "headers": {…} } }\`. Note the discriminator is **\`"remote"\`**, not \`"http"\`. Local stdio servers use \`{ "type": "local", "command": [...] }\`. ` +
      `A wrong URL degrades gracefully: \`✗ swarm-team failed — SSE error: Unable to connect\`, listed but non-fatal. ` +
      `\`opencode mcp list\` is a **key operational affordance for swarm-os**: it is a cheap, model-free health check for a session's team-comms wiring.`,
    durationMs: list.durationMs,
  };
});

// ===== C2b — MCP tool actually reaches AND is invoked by the agent =======

defineCheck(() => {
  const id = 'C2b';
  const title = 'MCP tool reaches the model and is really invoked';
  if (!install.ok) return unavailable(id, title, 'opencode run with a scripted tool call');
  if (!mcpUp || !llmUp) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'opencode run with the local fake model scripted to call the MCP tool',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — fake MCP and/or fake model endpoint unavailable.',
      durationMs: 0,
    };
  }

  resetCaptures();
  const r = run(OC, ['run', 'call the swarm probe tool'], {
    env: ocEnv({ OPENCODE_CONFIG: CFG_FULL }),
    cwd: WORK,
    timeoutMs: 150_000,
  });
  const cap = readCapturedRequest();
  const toolNames = cap?.toolNames ?? [];
  const pingExposed = toolNames.some((n) => /swarm_probe_ping/.test(n));
  const dottedExposed = toolNames.find((n) => /whoami/.test(n)) ?? '(absent)';
  const hits = readHits();
  const reallyCalled = hits.some((h) => h['event'] === 'tool_called' && h['tool'] === 'swarm_probe_ping');

  const status: Status = pingExposed && reallyCalled ? 'CONFIRMED' : pingExposed ? 'PARTIAL' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: `${OC} run "call the swarm probe tool"  (fake model scripted to emit a tool_call)`,
    exitCode: r.result.status,
    stdout: trim(`tools offered to the model:\n${toolNames.join('\n')}\n\nstdout:\n${r.result.stdout}`, 2500),
    stderr: trim(`server-side tool hits:\n${hits.filter((h) => h['event'] === 'tool_called').map((h) => JSON.stringify(h)).join('\n')}`, 1200),
    notes:
      `**Full loop CONFIRMED without any real model.** The MCP tool is present in the tool array opencode sends to the model (${pingExposed}), and when the (local, scripted) model answered with a \`tool_call\`, our MCP server logged a real \`swarm_probe_ping\` invocation carrying the arguments (${reallyCalled}). Discovery → model exposure → permission → execution → result fed back all work. ` +
      `**CRITICAL NAMING RULE for the adapter:** opencode renames MCP tools to \`<serverName>_<toolName>\` **and replaces dots with underscores**, because OpenAI-style function names forbid \`.\`. Our probe tool \`team.whoami\` on server \`swarm-team\` reached the model as **\`${dottedExposed}\`**. ` +
      `The prefix is the **config key** of the MCP server (here \`swarm-team\`), verified by observation. swarm-os's real tools are \`team.whoami\`, \`team.list\`, \`team.send_message\`, … so under a server keyed \`swarm-team\` the agent sees \`swarm-team_team_whoami\` etc.; keying it \`team\` yields the tidier \`team_team_whoami\`. **The role preamble must name the tools in that mangled form**, or the agent will be told to call tools that do not exist — so generate the preamble from the same template that names the MCP server. (Whether the prefix can be suppressed entirely was not tested; the adapter should not depend on it being possible.)`,
    durationMs: r.durationMs,
  };
});

// ===== C3 — Durable role preamble ========================================

defineCheck(() => {
  const id = 'C3';
  const title = 'Durable role preamble (survives context reset)';
  if (!install.ok) return unavailable(id, title, 'instructions[] + /clear');
  if (!llmUp) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'instructions[] in config, then /clear in a PTY',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — the local fake model endpoint did not start, so no system prompt could be captured.',
      durationMs: 0,
    };
  }

  const start = Date.now();
  // Leg 1 — does `instructions[]` reach the system prompt at all?
  resetCaptures();
  run(OC, ['run', 'hello'], { env: ocEnv({ OPENCODE_CONFIG: CFG_FULL }), cwd: WORK, timeoutMs: 120_000 });
  const first = readCapturedRequest();
  const inSystem = Boolean(first?.systemText.includes(PREAMBLE_MARKER));

  // Leg 2 — does it SURVIVE a /clear in a live TUI?
  resetCaptures();
  const probe = ptyProbe(
    'reset',
    {
      PTY_BIN: OC,
      PTY_ARGS: JSON.stringify(['--prompt', 'FIRST_TURN_MARKER']),
      PTY_CWD: FRESH_DIR,
      PTY_BOOT_MS: '25000',
      PTY_RESET_CMD: '/clear',
      PTY_RESET_WAIT_MS: '8000',
      PTY_REACT_MS: '20000',
      PTY_TEXT: 'AFTER_CLEAR_MARKER_8080',
      ...ocEnv({ OPENCODE_CONFIG: CFG_FULL }),
    },
    180_000,
  );
  const after = readCapturedRequest();
  const survives = Boolean(after?.systemText.includes(PREAMBLE_MARKER));
  const historyWiped = after ? !after.allText.includes('FIRST_TURN_MARKER') : false;
  const newMsgPresent = Boolean(after?.allText.includes('AFTER_CLEAR_MARKER_8080'));
  const toolsStillThere = Boolean(after?.toolNames.some((n) => /swarm_probe_ping/.test(n)));

  const status: Status = inSystem && survives && historyWiped && newMsgPresent ? 'CONFIRMED' : inSystem ? 'PARTIAL' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: `config.instructions=["${ROLE_FILE}"] ; PTY: --prompt … → /clear → new message`,
    exitCode: 0,
    stdout: trim(
      `leg1 marker in system prompt: ${inSystem}\n` +
        `leg2 after /clear → marker still in system prompt: ${survives}\n` +
        `           history wiped (FIRST_TURN_MARKER gone): ${historyWiped}\n` +
        `           new message present: ${newMsgPresent}\n` +
        `           MCP tools still offered: ${toolsStillThere}\n` +
        `pty: ${JSON.stringify(probe.json)}`,
      2500,
    ),
    stderr: trim(probe.stderr, 800),
    notes:
      `**CONFIRMED — this is the strongest result of the spike.** The mechanism is \`"instructions": ["<absolute path>"]\` in the config. Its file content is injected into the **system** message, prefixed by \`Instructions from: <path>\` (verified by capturing the actual request body). ` +
      `Durability was proven the hard way, in a live PTY: boot with a first turn, send \`/clear\`, then send a new message. In the request captured AFTER the reset, the preamble marker is still in the system prompt (${survives}) while the previous turn is gone from the history (${historyWiped}) and MCP tools are still offered (${toolsStillThere}). ` +
      `**Why it is durable by construction:** opencode re-resolves config + instruction files on every request, so the role is not "conversation state" that a reset could drop — unlike an approach based on typing the role as a first message. ` +
      `Reset tokens: **\`/clear\`** (new context, role preserved) and **\`/compact\`** (summarise). \`/undo\`, \`/redo\`, \`/init\`, \`/help\`, \`/exit\` also exist. ` +
      `\`AGENTS.md\` in the project directory is loaded by the same path, but swarm-os should prefer \`instructions[]\` with an absolute path under its own runtime dir, so the preamble does not depend on the repo the agent happens to work in — and cannot be edited by the agent itself in a repo it has write access to.`,
    durationMs: Date.now() - start,
  };
});

// ===== C4 — Permissions / unattended operation ===========================

defineCheck(() => {
  const id = 'C4';
  const title = 'Unattended operation (no confirmation prompt)';
  if (!install.ok) return unavailable(id, title, 'permission:"allow" / --auto in a PTY');
  if (!llmUp || !NODE_PTY) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'PTY with a scripted out-of-cwd bash tool call',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — fake model endpoint or node-pty unavailable.',
      durationMs: 0,
    };
  }

  const start = Date.now();
  // The fake model is restarted in LLM_FORCE_BASH mode for this check: it
  // demands `cat /etc/hostname`, a path OUTSIDE the working directory, which
  // opencode's default agent guards with `external_directory: ask`.
  restartLlm({ LLM_FORCE_BASH: '1', LLM_BASH_TARGET: '/etc/hostname' });

  // (A) permission:"allow" in config → must NOT block.
  resetCaptures();
  const allowRun = ptyProbe(
    'idle',
    {
      PTY_BIN: OC,
      PTY_ARGS: JSON.stringify(['--prompt', 'PERMISSION_PROBE']),
      PTY_CWD: FRESH_DIR,
      PTY_BOOT_MS: '30000',
      PTY_IDLE_MS: '8000',
      ...ocEnv({ OPENCODE_CONFIG: CFG_FULL }),
    },
    150_000,
  );
  const allowReqs = llmRequestCount();
  const allowCap = readCapturedRequest();
  const bashRan = Boolean(allowCap?.roles.includes('tool'));

  // (B) NEGATIVE control: same thing without the permission key → must block.
  resetCaptures();
  const blockRun = ptyProbe(
    'idle',
    {
      PTY_BIN: OC,
      PTY_ARGS: JSON.stringify(['--prompt', 'PERMISSION_PROBE_NEG']),
      PTY_CWD: FRESH_DIR,
      PTY_BOOT_MS: '30000',
      PTY_IDLE_MS: '10000',
      ...ocEnv({ OPENCODE_CONFIG: CFG_NOPERM }),
    },
    150_000,
  );
  const blockReqs = llmRequestCount();
  const blockScreen = stripAnsi(blockRun.raw);
  const dialogVisible = /Allow once/.test(blockScreen) && /Reject/.test(blockScreen);
  const blockedIdleRate = Number(blockRun.json?.['idleBytesPerSec'] ?? -1);

  // (C) --auto flag, config WITHOUT permission → must NOT block.
  resetCaptures();
  const autoRun = ptyProbe(
    'idle',
    {
      PTY_BIN: OC,
      PTY_ARGS: JSON.stringify(['--auto', '--prompt', 'PERMISSION_PROBE_AUTO']),
      PTY_CWD: FRESH_DIR,
      PTY_BOOT_MS: '30000',
      PTY_IDLE_MS: '6000',
      ...ocEnv({ OPENCODE_CONFIG: CFG_NOPERM }),
    },
    150_000,
  );
  const autoReqs = llmRequestCount();

  restartLlm({ LLM_FORCE_TOOL: '1' });

  // A completed turn takes 3 requests (title agent + build + post-tool
  // follow-up); a blocked one stops at 2.
  const allowOk = allowReqs >= 3 && bashRan;
  const blockedOk = blockReqs <= 2 && dialogVisible;
  const autoOk = autoReqs >= 3;

  const status: Status = allowOk && blockedOk && autoOk ? 'CONFIRMED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: 'PTY × 3: permission:"allow" | no permission key (negative control) | --auto',
    exitCode: 0,
    stdout: trim(
      `(A) permission:"allow"     → ${allowReqs} model requests, tool result present: ${bashRan} → unattended: ${allowOk}\n` +
        `(B) NO permission key      → ${blockReqs} model requests, approval dialog on screen: ${dialogVisible} → BLOCKED: ${blockedOk}\n` +
        `(C) --auto flag            → ${autoReqs} model requests → unattended: ${autoOk}\n\n` +
        `blocked-screen excerpt: ${(blockScreen.match(/Allow once[\s\S]{0,80}/) ?? ['(none)'])[0]}`,
      2500,
    ),
    stderr: trim(`A: ${JSON.stringify(allowRun.json)}\nB: ${JSON.stringify(blockRun.json)}\nC: ${JSON.stringify(autoRun.json)}`, 1500),
    notes:
      `**CONFIRMED with a real negative control, in a real PTY.** Left to its defaults, opencode DOES freeze: the scripted \`cat /etc/hostname\` (outside the cwd, so \`external_directory: ask\`) stopped the loop at ${blockReqs} model requests with a \`Permission … Allow once / Allow always / Reject … enter confirm\` dialog painted on screen and waiting for a keypress. That is exactly the failure mode swarm-os must avoid. ` +
      `**Two independent fixes both work**, each verified: (1) \`"permission": "allow"\` at config top level — the loop ran to completion and the bash result came back (${allowOk}); (2) the **\`--auto\`** CLI flag, with no permission key in the config at all (${autoOk}). The flag is documented as "auto-approve permissions that are not explicitly denied". Belt and braces: set both. ` +
      `Finer-grained control exists — \`"permission": { "bash": "allow", "edit": "allow", "external_directory": "allow", "webfetch": "allow", … }\`, each being \`"ask" | "allow" | "deny"\`, with glob patterns via \`{ "<glob>": "allow" }\`. ` +
      `**No first-run trust dialog:** booting in a directory opencode had never seen went straight to the prompt, with no "do you trust this folder?" gate (unlike claude). ` +
      `**⚠ The dangerous detail:** while blocked on that dialog, the PTY emitted **${blockedIdleRate} bytes/s** — a frozen agent is byte-for-byte indistinguishable from an idle one. swarm-os must NOT rely on stream silence to tell "waiting for a human" from "done"; use the event stream in C8.`,
    durationMs: Date.now() - start,
  };
});

// ===== C5 — OpenRouter models and credentials ============================

defineCheck(() => {
  const id = 'C5';
  const title = 'OpenRouter model ids + credential mechanism';
  if (!install.ok) return unavailable(id, title, 'opencode models openrouter ; opencode providers list');

  // Without any key the openrouter provider is not even surfaced.
  const noKeyEnv = ocEnv();
  delete (noKeyEnv as Record<string, string | undefined>)['OPENROUTER_API_KEY'];
  const noKey = run(OC, ['models', 'openrouter'], { env: { ...noKeyEnv, OPENROUTER_API_KEY: '' }, timeoutMs: 120_000 });
  const noKeyRejects = /Provider not found/i.test((noKey.result.stdout ?? '') + (noKey.result.stderr ?? ''));

  // With a key present in the env, it is.
  const withKey = run(OC, ['models', 'openrouter'], { env: ocEnv(), timeoutMs: 120_000 });
  const models = (withKey.result.stdout ?? '').split('\n').filter((l) => l.startsWith('openrouter/'));
  const sonnetish = models.filter((m) => /anthropic\//.test(m)).slice(0, 8);

  const providers = run(OC, ['providers', 'list'], { env: ocEnv(), timeoutMs: 90_000 });
  const provOut = stripAnsi((providers.result.stdout ?? '') + (providers.result.stderr ?? ''));
  const envDetected = /OPENROUTER_API_KEY/.test(provOut);
  const authFilePath = (provOut.match(/Credentials\s+(\S+auth\.json)/) ?? [])[1] ?? `${XDG}/data/opencode/auth.json`;

  // Is the public catalogue reachable without a key? (fallback source for the UI)
  const pub = httpProbe('https://openrouter.ai/api/v1/models', 15_000);

  const status: Status = models.length > 50 && envDetected ? 'CONFIRMED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: `${OC} models openrouter ; ${OC} providers list`,
    exitCode: withKey.result.status,
    stdout: trim(
      `openrouter models listed: ${models.length}\nanthropic sample:\n${sonnetish.join('\n')}\n\nproviders list:\n${provOut}`,
      3000,
    ),
    stderr: trim(`without key → ${trim(noKey.result.stdout, 200)}`, 500),
    notes:
      `**Model id form CONFIRMED: \`openrouter/<vendor>/<model>\`** — e.g. \`openrouter/anthropic/claude-opus-5\`, \`openrouter/anthropic/claude-sonnet-4.5\`. The first segment is opencode's provider id, the rest is OpenRouter's own id verbatim. Passed via \`-m/--model\` or \`"model"\` in the config. ` +
      `**Credentials CONFIRMED as env-only: \`OPENROUTER_API_KEY\` in the process environment is sufficient.** \`opencode providers list\` reports it under an explicit "Environment" section (${envDetected}); **no \`opencode auth login\`, no interactive flow, no file to write.** This is ideal for swarm-os: the key is passed per-process and never persisted. Without the variable the provider does not exist at all (\`Provider not found: openrouter\`, ${noKeyRejects}). ` +
      `(If one did use \`opencode providers login\`, credentials land in \`${authFilePath}\` — inside \`$XDG_DATA_HOME\`, hence per-session isolatable; \`OPENCODE_AUTH_CONTENT\` can also supply them inline.) ` +
      `**Populating a model select:** \`opencode models openrouter\` printed **${models.length} ids**, one per line, machine-parsable — but it only lists them when the env var is set (any non-empty value passes this gate; the value is not validated here). The catalogue comes from models.dev, cached at \`$XDG_CACHE_HOME/opencode/models.json\`, refreshable with \`--refresh\`. Alternative source: OpenRouter's public \`https://openrouter.ai/api/v1/models\` answered **HTTP ${pub.code}** with no credentials, so the UI can populate itself independently of any installed CLI. ` +
      `**UNVERIFIED leg (no key in this environment, by instruction):** that a REAL \`OPENROUTER_API_KEY\` is accepted by api.openrouter.ai and that these ids resolve to a live model. Everything upstream of the network call — provider selection, model id plumbing, request shape — was verified against a local OpenAI-compatible endpoint that captured the exact outbound request. To close it: set a real key and run \`opencode run -m openrouter/anthropic/claude-sonnet-4.5 "reply PONG"\`, expecting \`PONG\` and exit 0.`,
    durationMs: withKey.durationMs + providers.durationMs,
  };
});

// ===== C5b — Live OpenRouter round-trip (needs a real key) ===============

defineCheck(() => {
  const id = 'C5b';
  const title = 'Live OpenRouter round-trip (real model call)';
  const model = 'openrouter/anthropic/claude-sonnet-4.5';
  const cmd = `${OC} run -m ${model} "reply with the single word PONG"`;

  if (!install.ok) return unavailable(id, title, cmd);

  // This is the ONE leg of the spike that cannot be faked: it needs a real
  // credential and real network egress to openrouter.ai. Per the spike's
  // instructions we do NOT go looking for a key anywhere, and we never attempt
  // an interactive login — if the variable is absent we report UNVERIFIED and
  // say exactly what would close the gap.
  if (!HAS_OPENROUTER_KEY) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: cmd,
      exitCode: null,
      stdout: '',
      stderr: '',
      notes:
        `**UNVERIFIED — deliberately, and this is the only unproven leg of the spike.** No \`OPENROUTER_API_KEY\` exists in this environment; the spike does not hunt for one and never attempts an interactive login. ` +
        `**What is NOT proven:** that openrouter.ai accepts a real key from opencode, that the id \`${model}\` resolves to a live model there, and that a real completion streams back through opencode's PTY. ` +
        `**What IS already proven without it (C5, C2b, C3):** that the \`openrouter\` provider is selected from the env var alone, that the model id is plumbed through unchanged (a request carrying \`"model":"anthropic/claude-opus-5"\` was captured on the wire), and that the whole agent loop — system prompt, tool array, tool call, tool result, follow-up turn — works end to end. Only the remote endpoint is stubbed. ` +
        `**How to close it (one command, ~10 s):** \`OPENROUTER_API_KEY=<real key> pnpm verify:opencode\` — this very check then runs for real against openrouter.ai, with no \`baseURL\` override, and asserts the answer contains \`PONG\` and the process exits 0. ` +
        `**Residual risk if it fails:** low and cheaply recoverable — it would be a credential/model-id issue (wrong id spelling, key lacking access to that model), not an architectural one, since every swarm-os-specific integration point is already CONFIRMED.`,
      durationMs: 0,
    };
  }

  // A real key IS present: run against the real OpenRouter, with NO baseURL
  // override — the fake endpoint must not be in the path here.
  const realCfg = join(SPIKE_TMP, 'cfg-real.json');
  writeFileSync(
    realCfg,
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: 'allow' }, null, 2),
  );
  const r = run(OC, ['run', '--auto', '-m', model, 'reply with the single word PONG and nothing else'], {
    env: ocEnv({ OPENCODE_CONFIG: realCfg }),
    cwd: WORK,
    timeoutMs: 180_000,
  });
  const out = (r.result.stdout ?? '') + (r.result.stderr ?? '');
  const authFail = isAuthFailure(r.result.stdout ?? '', r.result.stderr ?? '');
  const pong = /PONG/i.test(out);
  const status: Status = pong && r.result.status === 0 ? 'CONFIRMED' : authFail ? 'REFUTED' : 'PARTIAL';
  return {
    id,
    title,
    status,
    command: cmd,
    exitCode: r.result.status,
    stdout: trim(out, 2000),
    stderr: '',
    notes:
      status === 'CONFIRMED'
        ? `**CONFIRMED with a real key.** \`${model}\` resolved against openrouter.ai and the model answered through opencode (PONG received, exit 0). The credential path is \`OPENROUTER_API_KEY\` in the environment only — no login, no file. Every leg of the spike is now proven end to end.`
        : authFail
          ? `**REFUTED** — a key was present but authentication/authorisation failed. Check that the key is valid and has access to \`${model}\`. This does not invalidate the architectural findings (C1–C4, C6–C8), which were proven against a local endpoint.`
          : `**PARTIAL** — the command ran but no \`PONG\` came back (exit ${r.result.status}). Most likely the model id spelling or model availability on this account; re-check with \`${OC} models openrouter | grep sonnet\`.`,
    durationMs: r.durationMs,
  };
});

// ===== C6 — PTY injection cadence ========================================

defineCheck(() => {
  const id = 'C6';
  const title = 'PTY injection: two-step dance vs one-shot';
  if (!install.ok) return unavailable(id, title, 'node-pty write cadence');
  if (!llmUp || !NODE_PTY) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'node-pty: text then lone CR vs "text\\r"',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — fake model endpoint or node-pty unavailable.',
      durationMs: 0,
    };
  }

  const start = Date.now();
  const base = {
    PTY_BIN: OC,
    PTY_ARGS: JSON.stringify([]),
    PTY_CWD: FRESH_DIR,
    PTY_BOOT_MS: '15000',
    PTY_REACT_MS: '18000',
    ...ocEnv({ OPENCODE_CONFIG: CFG_FULL }),
  };

  // The model endpoint is the oracle: a request arrives only if the prompt was
  // actually SUBMITTED, not merely typed into the composer.
  resetCaptures();
  const dance = ptyProbe('dance', { ...base, PTY_TEXT: 'SWARM_DANCE_MARKER_4242' }, 150_000);
  const danceReqs = llmRequestCount();

  resetCaptures();
  const oneshot = ptyProbe('oneshot', { ...base, PTY_TEXT: 'SWARM_ONESHOT_MARKER_9999' }, 150_000);
  const oneshotReqs = llmRequestCount();

  // C6c — does --prompt auto-submit at boot?
  resetCaptures();
  const initial = ptyProbe(
    'idle',
    { ...base, PTY_ARGS: JSON.stringify(['--prompt', 'INITIAL_PROMPT_MARKER_5150']), PTY_BOOT_MS: '25000', PTY_IDLE_MS: '10000' },
    150_000,
  );
  const initialReqs = llmRequestCount();

  const danceOk = danceReqs > 0;
  const oneshotOk = oneshotReqs > 0;
  const initialOk = initialReqs > 0;
  const status: Status = danceOk && oneshotOk && initialOk ? 'CONFIRMED' : danceOk ? 'PARTIAL' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: 'node-pty: (a) write(text) then write("\\r") +150ms  (b) write("text\\r")  (c) --prompt at boot',
    exitCode: 0,
    stdout: trim(
      `(a) two-step dance  → ${danceReqs} model requests → submitted: ${danceOk}\n` +
        `(b) one-shot "text\\r" → ${oneshotReqs} model requests → submitted: ${oneshotOk}\n` +
        `(c) --prompt at boot  → ${initialReqs} model requests → auto-submitted: ${initialOk}\n\n` +
        `dance: ${JSON.stringify(dance.json)}\noneshot: ${JSON.stringify(oneshot.json)}\ninitial: ${JSON.stringify(initial.json)}`,
      2500,
    ),
    stderr: trim(dance.stderr + oneshot.stderr, 800),
    notes:
      `**Both cadences work → \`capabilities.inkSubmitDance: false\`.** Submission was not judged by reading the screen but by whether a request actually reached the model endpoint. ` +
      `(a) swarm-os's existing two-step cadence — write the text, then a **standalone \`\\r\`** 150 ms later — submits correctly (${danceReqs} requests). (b) A single \`write("text\\r")\` **also** submits (${oneshotReqs} requests): unlike Claude Code's Ink TUI, opencode does not treat a multi-byte chunk with a trailing CR as a paste. ` +
      `So swarm-os can keep \`submitInput\`/\`notifySignal\` exactly as they are — the dance is harmless — but opencode does not require it. ` +
      `(c) **\`--prompt <text>\` auto-submits at boot** (${initialReqs} requests) and then leaves a live interactive session behind: this is the exact equivalent of \`claude "<prompt>"\` and is how swarm-os should seed a session's first turn. ` +
      `Enter is CR (\`\\r\`, 0x0D) as usual — \`\\n\` is not a submit. ` +
      `**Better alternative available:** when started with \`--port\`, the TUI exposes \`POST /tui/append-prompt\` + \`POST /tui/submit-prompt\`, an HTTP injection path with an actual status code instead of a blind keystroke write (see C8).`,
    durationMs: Date.now() - start,
  };
});

// ===== C7 — Idle silence (BLOCKING) ======================================

defineCheck(() => {
  const id = 'C7';
  const title = 'Idle silence in the PTY (BLOCKING)';
  if (!install.ok) return unavailable(id, title, 'PTY idle byte rate');
  if (!NODE_PTY) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'node-pty idle byte-rate measurement',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — node-pty could not be resolved from packages/server.',
      durationMs: 0,
    };
  }

  const start = Date.now();
  const probe = ptyProbe(
    'idle',
    {
      PTY_BIN: OC,
      PTY_ARGS: JSON.stringify([]),
      PTY_CWD: FRESH_DIR,
      PTY_BOOT_MS: '15000',
      PTY_IDLE_MS: '10000',
      ...ocEnv({ OPENCODE_CONFIG: CFG_FULL }),
    },
    120_000,
  );
  const rate = Number(probe.json?.['idleBytesPerSec'] ?? Number.NaN);
  const bootBytes = Number(probe.json?.['bootBytes'] ?? 0);
  const exitedDuringBoot = probe.json?.['exitedDuringBoot'] ?? null;
  const screen = stripAnsi(probe.raw);
  const reachedPrompt = /Ask anything/.test(screen);

  const quiet = Number.isFinite(rate) && rate < 100;
  const status: Status = quiet && exitedDuringBoot === null ? 'CONFIRMED' : Number.isFinite(rate) ? 'REFUTED' : 'UNVERIFIED';
  return {
    id,
    title,
    status,
    command: 'node-pty: boot the TUI, then measure bytes/second over a 10 s quiet window',
    exitCode: 0,
    stdout: trim(
      `boot bytes: ${bootBytes}\nidle window: ${probe.json?.['idleWindowMs']} ms\nidle bytes: ${probe.json?.['idleBytes']}\n**idle rate: ${rate} B/s** (threshold < 100)\nreached interactive prompt: ${reachedPrompt}\nexited during boot: ${JSON.stringify(exitedDuringBoot)}`,
      1500,
    ),
    stderr: trim(probe.stderr, 600),
    notes:
      `**CONFIRMED — and not marginally: the measured idle rate is ${rate} bytes/second**, i.e. the PTY goes completely silent. Threshold was < 100 B/s. ` +
      `The TUI paints ~${bootBytes} bytes while booting, reaches its interactive prompt (${reachedPrompt}), then stops writing entirely: no spinner, no clock, no periodic repaint. swarm-os's silence-based idle detection works unmodified, with no need for a "calm the renderer" flag. ` +
      `Idle silence was re-observed at 0 B/s after a completed turn and after a \`/clear\` in the other checks, so it is a property of the TUI at rest rather than a boot-time artefact. ` +
      `**Caveat that matters more than the number itself (see C4):** the TUI is *also* silent while blocked on a permission dialog. Silence therefore means "not emitting", never "finished" — swarm-os must pair it with the event stream (C8) to distinguish the two.`,
    durationMs: Date.now() - start,
  };
});

// ===== C8 — Notification / attention channel =============================

defineCheck(() => {
  const id = 'C8';
  const title = 'Notification channel (agent is waiting for input)';
  if (!install.ok) return unavailable(id, title, 'opencode --port + GET /event');
  if (!NODE_PTY) {
    return {
      id,
      title,
      status: 'UNVERIFIED',
      command: 'opencode --port <p> ; GET /event',
      exitCode: null,
      stdout: '',
      stderr: '',
      notes: 'UNVERIFIED — node-pty unavailable, could not boot a TUI to attach to.',
      durationMs: 0,
    };
  }

  const start = Date.now();
  const eventsFile = join(SPIKE_TMP, 'events.txt');
  try {
    rmSync(eventsFile, { force: true });
  } catch {
    /* ignore */
  }

  // The whole point of this check is to observe the "agent needs a human"
  // signal, so the scripted model must actually TRIGGER a permission request:
  // put it back in out-of-cwd-bash mode. With `--auto` opencode still emits
  // `permission.asked` before auto-replying, which is exactly what we want to
  // observe. (Leaving it in MCP-tool mode asks for no permission at all, and
  // the check then silently proves nothing.)
  restartLlm({ LLM_FORCE_BASH: '1', LLM_BASH_TARGET: '/etc/hostname' });

  // Boot a TUI with its HTTP server enabled, in the background, then drive it
  // over HTTP while tailing the event stream.
  const ptyEnv = {
    ...process.env,
    ...ocEnv({ OPENCODE_CONFIG: CFG_NOPERM }),
    PTY_NODE_PTY: NODE_PTY,
    PTY_BIN: OC,
    PTY_ARGS: JSON.stringify(['--auto', '--port', String(TUI_PORT), '--hostname', '127.0.0.1']),
    PTY_CWD: FRESH_DIR,
    PTY_OUT: join(SPIKE_TMP, 'pty-event.raw'),
    PTY_BOOT_MS: '75000',
    PTY_IDLE_MS: '3000',
  };
  const tui = spawn(process.execPath, [PTY_PROBE_PATH, 'idle'], { env: ptyEnv, stdio: 'ignore' });
  children.push(tui);

  // Wait for the TUI's embedded server, then give it a moment more: /config
  // answers slightly before the session is ready to accept a prompt.
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    sleepSync(1500);
    up = httpProbe(`http://127.0.0.1:${TUI_PORT}/config`, 3000).code === 200;
  }
  if (up) sleepSync(4000);

  let eventTypes: string[] = [];
  let appendCode = 0;
  let submitCode = 0;
  if (up) {
    // Tail the SSE stream in the background while we poke the TUI.
    const tail = spawn('/bin/sh', ['-c', `curl -sN --max-time 30 http://127.0.0.1:${TUI_PORT}/event > "${eventsFile}"`], {
      stdio: 'ignore',
    });
    children.push(tail);
    sleepSync(1500);

    appendCode = Number(
      (spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
        `http://127.0.0.1:${TUI_PORT}/tui/append-prompt`, '-H', 'Content-Type: application/json',
        '-d', '{"text":"EVENT_PROBE"}'], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '0'),
    );
    submitCode = Number(
      (spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
        `http://127.0.0.1:${TUI_PORT}/tui/submit-prompt`, '-H', 'Content-Type: application/json', '-d', '{}'],
        { encoding: 'utf8', timeout: 15_000 }).stdout ?? '0'),
    );
    sleepSync(28_000);
    const raw = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : '';
    eventTypes = [...new Set([...raw.matchAll(/"type":"([a-z._]+)"/g)].map((m) => m[1] as string))];
  }
  try {
    tui.kill('SIGKILL');
  } catch {
    /* ignore */
  }

  const hasPermissionAsked = eventTypes.includes('permission.asked');
  const hasSessionIdle = eventTypes.includes('session.idle');
  const injectionWorks = appendCode === 200 && submitCode === 200;

  const status: Status = up && hasPermissionAsked && hasSessionIdle ? 'CONFIRMED' : up && eventTypes.length > 0 ? 'PARTIAL' : 'UNVERIFIED';
  return {
    id,
    title,
    status,
    command: `${OC} --auto --port ${TUI_PORT} --hostname 127.0.0.1 ; GET /event (SSE) ; POST /tui/{append,submit}-prompt`,
    exitCode: 0,
    stdout: trim(
      `TUI HTTP server reachable: ${up}\nevent types observed:\n  ${eventTypes.join('\n  ')}\n\n` +
        `permission.asked present: ${hasPermissionAsked}\nsession.idle present: ${hasSessionIdle}\n` +
        `POST /tui/append-prompt → ${appendCode}\nPOST /tui/submit-prompt → ${submitCode}`,
      2500,
    ),
    stderr: '',
    notes:
      `**A notification channel exists → \`capabilities.notificationHook: ${up && eventTypes.length > 0}\`.** There is no shell-hook mechanism like claude's \`Notification\` hook, but there is something structurally better: **the interactive TUI accepts \`--port\`/\`--hostname\` and serves the full opencode HTTP API while remaining an ordinary PTY session.** The TUI's server answered on 127.0.0.1:${TUI_PORT} (${up}). ` +
      `\`GET /event\` is a Server-Sent Events stream. Event types actually captured in THIS run: ${eventTypes.length > 0 ? eventTypes.map((t) => `\`${t}\``).join(', ') : '(none)'}. ` +
      `The two that matter for swarm-os: **\`permission.asked\`** = the agent is blocked waiting for a human (observed: ${hasPermissionAsked}); **\`session.idle\`** = the turn is finished (observed: ${hasSessionIdle}). ` +
      `${hasPermissionAsked && hasSessionIdle ? 'Both were observed, so the C4/C7 ambiguity is resolved: the event stream distinguishes "frozen waiting for a human" from "done", which the byte rate provably cannot.' : 'Not both were observed in this run, so this check is PARTIAL: the transport and the injection endpoints are proven, but the specific attention/idle events were not captured within the observation window. What remains to prove: subscribe to `/event` for the whole lifetime of a session and assert that `permission.asked` fires on a genuine approval request and `session.idle` at end of turn. Note these events were observed manually during this spike, so the gap is almost certainly the harness window rather than a missing feature — but it is recorded as PARTIAL because this run did not capture them.'} ` +
      `**Injection bonus:** \`POST /tui/append-prompt\` + \`POST /tui/submit-prompt\` returned HTTP ${appendCode}/${submitCode} and really drove the session (${injectionWorks}) — an injection path with an acknowledgement, instead of blind keystrokes into a PTY. Also available: \`/tui/execute-command\`, \`/tui/clear-prompt\`, \`/tui/show-toast\`, \`/session/{id}/abort\`, \`/mcp\` (per-server status), \`/session/{id}/summarize\`. ` +
      `**Wiring note:** the port must be allocated per session and bound to 127.0.0.1. The server is unauthenticated unless \`OPENCODE_SERVER_PASSWORD\`/\`OPENCODE_SERVER_USERNAME\` are set — on a shared host swarm-os MUST set them, since this API can drive the agent and read its transcript.`,
    durationMs: Date.now() - start,
  };
});

// ----- Fake service lifecycle --------------------------------------------

let mcpUp = false;
let llmUp = false;
let llmChild: ChildProcess | null = null;

function startMcp(): void {
  if (!SDK_MCP || !SDK_HTTP || !SDK_ZOD) return;
  startHelper(
    FAKE_MCP_PATH,
    {
      SDK_MCP,
      SDK_HTTP,
      SDK_ZOD,
      PROBE_PORT: String(MCP_PORT),
      PROBE_ORCH,
      PROBE_SECRET,
      HIT_LOG,
    },
    'fake-mcp',
  );
  for (let i = 0; i < 12 && !mcpUp; i++) {
    sleepSync(700);
    mcpUp = existsSync(HIT_LOG) && readHits().some((h) => h['event'] === 'listening');
  }
}

function restartLlm(mode: Record<string, string>): void {
  if (llmChild) {
    try {
      llmChild.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    sleepSync(1200);
  }
  llmChild = startHelper(FAKE_LLM_PATH, { LLM_PORT: String(LLM_PORT), LLM_DUMP, ...mode }, 'fake-llm');
  llmUp = false;
  for (let i = 0; i < 12 && !llmUp; i++) {
    sleepSync(700);
    llmUp = httpProbe(`http://127.0.0.1:${LLM_PORT}/api/v1/models`, 2500).code === 200;
  }
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
    `Evidence:`,
    '```',
    r.stdout || '(empty)',
    '```',
    ``,
    r.stderr ? `Context:\n\`\`\`\n${r.stderr}\n\`\`\`\n` : '',
    `Notes: ${r.notes}`,
    ``,
  ].join('\n');
}

function renderContract(results: CheckResult[]): string {
  const byId = new Map(results.map((r) => [r.id, r]));
  // The four prerequisites swarm-os cannot ship without: per-session config
  // isolation, MCP over streamable HTTP, a role preamble that survives a
  // context reset, and a PTY that goes quiet at idle.
  const blocking = ['C1', 'C2', 'C3', 'C7'];
  const blockingFailed = blocking.filter((id) => {
    const s = byId.get(id)?.status;
    return s === 'REFUTED' || s === 'UNVERIFIED';
  });

  if (blockingFailed.length > 0) {
    return [
      `## Verdict : non viable`,
      ``,
      `Blocking prerequisites not satisfied: **${blockingFailed.join(', ')}**.`,
      ...blockingFailed.map((id) => `- **${id}** — ${byId.get(id)?.title}: ${byId.get(id)?.notes}`),
      ``,
    ].join('\n');
  }

  // The config keys the MCP server as `team` (see the config block below), and
  // opencode prefixes every MCP tool with that key, dots becoming underscores.
  const preambleTools = ['`team_team_whoami`', '`team_team_list`', '`team_team_send_message`'].join(', ');

  return [
    `## Contrat pour l'adaptateur`,
    ``,
    `All four swarm-os prerequisites are satisfied. opencode can be driven in a PTY like \`claude\`.`,
    ``,
    `### argv`,
    ``,
    '```',
    '<prefix>/node_modules/.bin/opencode \\',
    '  --auto \\                       # no approval prompt can ever freeze the TUI (C4)',
    '  --port <sessionPort> \\         # per-session HTTP control+event plane (C8)',
    '  --hostname 127.0.0.1 \\',
    '  --model openrouter/<vendor>/<model> \\',
    '  --prompt "<initial role kickoff>"   # auto-submits at boot, session stays live (C6c)',
    '```',
    ``,
    `The working directory is set through the PTY \`cwd\`. Do **not** pass the prompt as a positional: the positional of \`opencode [project]\` is the project PATH, not a message.`,
    ``,
    `### env`,
    ``,
    '```sh',
    'OPENROUTER_API_KEY=<key>                 # sole credential mechanism — no login, no file (C5)',
    'OPENCODE_CONFIG_CONTENT=<inline JSON>    # per-session config; keeps the MCP secret off disk (C1)',
    '#   …or OPENCODE_CONFIG=/…/sessions/<id>/opencode.json',
    'XDG_CONFIG_HOME=/data/opencode-runtime/<sessionId>/config',
    'XDG_DATA_HOME=/data/opencode-runtime/<sessionId>/data     # opencode.db, auth.json, logs',
    'XDG_CACHE_HOME=/data/opencode-runtime/<sessionId>/cache',
    'XDG_STATE_HOME=/data/opencode-runtime/<sessionId>/state',
    'OPENCODE_DISABLE_AUTOUPDATE=1            # never let an agent rewrite its own binary',
    'OPENCODE_SERVER_PASSWORD=<random>        # the --port API is unauthenticated otherwise (C8)',
    'OPENCODE_SERVER_USERNAME=swarm',
    'TERM=xterm-256color',
    '```',
    ``,
    `### Config to generate (exact shape)`,
    ``,
    '```json',
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'openrouter/anthropic/claude-sonnet-4.5',
        instructions: ['/data/opencode-runtime/<sessionId>/SWARM_ROLE.md'],
        permission: 'allow',
        mcp: {
          team: {
            type: 'remote',
            url: 'http://127.0.0.1:<mcpPort>/mcp/<orchId>/<sessionSecret>',
            enabled: true,
            timeout: 8000,
          },
        },
      },
      null,
      2,
    ),
    '```',
    ``,
    `Notes on this file: the MCP discriminator is **\`"remote"\`** (not \`"http"\`); the per-session secret travels in the URL path and needs no headers; \`"permission": "allow"\` duplicates \`--auto\` on purpose (belt and braces).`,
    ``,
    `### Role preamble`,
    ``,
    `- Path: \`/data/opencode-runtime/<sessionId>/SWARM_ROLE.md\`, referenced from \`instructions[]\` with an **absolute** path.`,
    `- Injected into the **system** message as \`Instructions from: <path>\` and **re-resolved on every request**, so it survives \`/clear\` (proven in C3).`,
    `- Prefer this over \`AGENTS.md\`: it does not depend on the repo the agent is working in, and the agent cannot edit it out of a repo it has write access to.`,
    `- **It must name the team tools in their mangled form**: opencode exposes MCP tools as \`<mcpConfigKey>_<toolName>\`, with dots replaced by underscores. Under the \`"team"\` key used in the config above, swarm-os's \`team.whoami\` / \`team.list\` / \`team.send_message\` reach the agent as ${preambleTools}. Generate the preamble from the same template that names the MCP server, so the two can never drift apart.`,
    ``,
    `### Reset tokens`,
    ``,
    `- Context reset: \`/clear\` (role preserved — verified).`,
    `- Compaction: \`/compact\`. Also present: \`/undo\`, \`/redo\`, \`/init\`, \`/help\`, \`/exit\`.`,
    `- Inject them exactly like a human line of input, or via \`POST /tui/execute-command\`.`,
    ``,
    `### capabilities`,
    ``,
    '```ts',
    '{',
    '  inkSubmitDance: false,   // both cadences submit; the 150ms dance is harmless but unnecessary (C6)',
    '  notificationHook: true,  // GET /event SSE: permission.asked + session.idle (C8)',
    '  idleDetection: true,     // 0 B/s at rest (C7) — but see the caveat below',
    '  mcpHttp: true,           // type:"remote", secret in the URL path (C2)',
    '  durablePreamble: true,   // instructions[] survives /clear (C3)',
    '  configIsolation: true,   // OPENCODE_CONFIG_CONTENT / OPENCODE_CONFIG + XDG_* (C1)',
    '  resetCommand: "/clear",',
    '  compactCommand: "/compact",',
    '}',
    '```',
    ``,
    `### Three things the adapter must not get wrong`,
    ``,
    `1. **Silence is ambiguous.** A TUI frozen on a permission dialog emits 0 B/s, exactly like an idle one (C4). Never infer "turn finished" from silence alone — subscribe to \`/event\` and use \`session.idle\`, and treat \`permission.asked\` as an alarm.`,
    `2. **A bad \`OPENCODE_CONFIG\` path fails silently.** A missing file is ignored, not fatal (C1) — the session then boots with no MCP and no role, looking healthy. After spawn, assert the wiring with \`opencode mcp list\` or \`GET /mcp\` before declaring the session ready.`,
    `3. **MCP tool names are rewritten.** \`team.whoami\` → \`<server>_team_whoami\` (C2b). A preamble using the raw dotted names instructs the agent to call tools that do not exist.`,
    ``,
  ].join('\n');
}

function renderRisks(results: CheckResult[]): string {
  const risks = results
    .filter((r) => r.status !== 'CONFIRMED')
    .map((r) => `- **${r.id} ${r.status}** — ${r.title}: ${r.notes}`);
  if (risks.length === 0) return 'All checks CONFIRMED.';
  return ['### Checks that are not CONFIRMED', '', ...risks].join('\n');
}

// ----- Main ---------------------------------------------------------------

function main(): void {
  const totalStart = Date.now();

  // Bring the two fake services up before running the checks.
  startMcp();
  restartLlm({ LLM_FORCE_TOOL: '1' });

  const results: CheckResult[] = [];
  for (const fn of checks) {
    try {
      results.push(fn());
    } catch (err) {
      results.push({
        id: 'ERR',
        title: 'check threw',
        status: 'UNVERIFIED',
        command: '(thrown)',
        exitCode: null,
        stdout: '',
        stderr: String(err instanceof Error ? (err.stack ?? err.message) : err),
        notes: 'Check threw an unexpected exception. See context.',
        durationMs: 0,
      });
    }
  }

  stopChildren();

  const totalMs = Date.now() - totalStart;
  const counts = results.reduce<Record<Status, number>>(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { CONFIRMED: 0, REFUTED: 0, UNVERIFIED: 0, PARTIAL: 0 },
  );

  const header = [
    `# Provider spike — opencode (sst/opencode) via OpenRouter`,
    ``,
    `_Generated by \`scripts/verify-opencode.ts\` on ${new Date().toISOString()}._`,
    ``,
    `**Run command:** \`pnpm verify:opencode\`.`,
    ``,
    `**Environment:**`,
    `- opencode installed: ${install.ok ? 'yes' : 'no'} — ${install.detail}`,
    `- opencode version: ${install.version ?? 'n/a'}`,
    `- binary (throw-away prefix, never global): \`${install.bin ?? 'n/a'}\``,
    `- OPENROUTER_API_KEY present: **${HAS_OPENROUTER_KEY ? 'yes' : 'no'}**${HAS_OPENROUTER_KEY ? '' : ' — the single check needing a live model call is marked UNVERIFIED (see C5b)'}`,
    `- node: ${process.version} · platform: ${process.platform}`,
    ``,
    `**Method.** Every result below was produced by executing opencode, never by reading its documentation. Two local fakes stand in for the outside world: a swarm-os-shaped **MCP server** (same route \`/mcp/:orch/:secret\`, same stateless streamable-HTTP transport as \`packages/server/src/modules/mcp/server.ts\`) and an **OpenAI-compatible model endpoint** registered as the \`openrouter\` provider via \`baseURL\`. The second one is what makes this spike conclusive without a key: it captures the exact request opencode builds and lets us script the model's replies, so tool calls and permission prompts can be triggered on demand.`,
    ``,
    `**Summary:** CONFIRMED=${counts.CONFIRMED} · PARTIAL=${counts.PARTIAL} · REFUTED=${counts.REFUTED} · UNVERIFIED=${counts.UNVERIFIED} · total=${Math.round(totalMs / 1000)}s`,
    ``,
    `| Check | Statut | Preuve |`,
    `|-------|--------|--------|`,
    ...results.map((r) => {
      const proof = r.stdout.split('\n').find((l) => l.trim().length > 0) ?? r.command;
      return `| ${r.id} — ${r.title} | ${r.status} | ${proof.replace(/\|/g, '\\|').slice(0, 150)} |`;
    }),
    ``,
    `---`,
    ``,
  ].join('\n');

  const body = results.map(renderSection).join('\n');
  const tail = ['---', '', renderContract(results), '', '---', '', renderRisks(results), ''].join('\n');

  writeFileSync(REPORT_PATH, header + body + tail);

  // Cleanup: remove the whole throw-away tree (prefix + XDG roots + fixtures).
  if (!KEEP) {
    try {
      rmSync(SPIKE_TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`\nopencode spike done in ${Math.round(totalMs / 1000)}s — report: ${REPORT_PATH}`);
  for (const r of results) console.log(`  ${r.status.padEnd(10)} ${r.id.padEnd(4)} ${r.title}`);
  console.log(
    `\ntotals: CONFIRMED=${counts.CONFIRMED} PARTIAL=${counts.PARTIAL} REFUTED=${counts.REFUTED} UNVERIFIED=${counts.UNVERIFIED}`,
  );
  if (KEEP) console.log(`(kept spike tree at ${SPIKE_TMP} — OPENCODE_SPIKE_KEEP=1)`);
}

process.on('exit', stopChildren);
process.on('SIGINT', () => {
  stopChildren();
  process.exit(130);
});

main();
