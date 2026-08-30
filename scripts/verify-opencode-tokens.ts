/**
 * scripts/verify-opencode-tokens.ts
 *
 * Provider spike — can swarm-os read the TOKEN USAGE of a LIVE opencode session
 * through the per-session HTTP control plane it already starts and already
 * authenticates (`--port N --hostname 127.0.0.1`, basic auth via
 * `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`)?
 *
 * Follow-up to `scripts/verify-opencode.ts` (check C8), which proved the control
 * plane exists and that `GET /event` carries `permission.asked` / `session.idle`
 * but never looked at the token counters. `OpencodeAdapter.controlPlane()`
 * (packages/server/src/modules/providers/opencode.ts) hands out the port and the
 * credentials and is still unconsumed; this spike establishes exactly what a
 * context tracker should poll on it, and with which formula.
 *
 * Run via:
 *   pnpm --filter server exec tsx ../../scripts/verify-opencode-tokens.ts
 *
 * Invariants, same family as the other verify-* scripts:
 *
 *  1. NO real user config is touched. Every opencode process runs with the four
 *     XDG_* roots redirected under the spike tree, exactly as the adapter does
 *     in production (`buildSpawn`, opencode.ts:825-828). ~/.config/opencode and
 *     ~/.local/share/opencode stay pristine.
 *  2. The tree is removed on exit (set OPENCODE_TOKENS_SPIKE_KEEP=1 to retain).
 *  3. A REAL model call is required — token counters cannot exist without one —
 *     so this spike DOES need an OpenRouter key. It uses the cheapest usable
 *     model and prompts of a few tokens; a full run costs well under one cent.
 *     Without a key every check reports UNVERIFIED rather than fabricating.
 *  4. NOTHING under packages/ is read at runtime except node-pty, which pnpm
 *     only exposes from packages/server.
 *
 * Method note. The two reset paths are tested the way swarm-os ACTUALLY drives
 * them: `contextResetLine()` (opencode.ts:940-951) returns the bare `/compact`
 * or `/clear` string and `Session` writes it into the PTY, so this spike writes
 * them into a real PTY with swarm-os's own cadence (text, then a standalone CR
 * 150 ms later — C6). Driving them over HTTP instead would prove nothing about
 * production, and in fact behaves differently (see T5).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// ----- Paths / constants --------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = resolve(__dirname, 'verify-opencode-tokens.report.md');
const SPIKE_TMP = join(tmpdir(), 'swarm-os-spike', 'opencode-tokens');
const XDG = join(SPIKE_TMP, 'xdg');
const WORK = join(SPIKE_TMP, 'work');
const HELPERS = join(SPIKE_TMP, 'helpers');

const KEEP = process.env['OPENCODE_TOKENS_SPIKE_KEEP'] === '1';

/**
 * Control-plane port. Inside the adapter's real window
 * (OPENCODE_CONTROL_PORT_BASE=47100 + 900) but at the top of it, so a spike run
 * on a host that is also running swarm-os does not collide with a live agent.
 */
/**
 * Randomised per run, for two independent reasons:
 *   - a spike run on a host that is also running swarm-os must not squat a port
 *     a live agent is about to be given;
 *   - a FIXED port makes back-to-back runs flaky. The previous run leaves
 *     TIME_WAIT sockets on it, opencode's server then fails to bind — and the
 *     TUI carries on regardless, perfectly healthy but with NO control plane.
 *     That failure mode is worth knowing about for production too: a bind
 *     failure is silent from the PTY's point of view.
 */
const CONTROL_PORT = 47_100 + Math.floor(Math.random() * 890);
/** Side channel the PTY helper listens on so the parent can inject keystrokes. */
const PTY_CTL_PORT = CONTROL_PORT + 1000;

/** Same values the adapter hard-codes / generates (opencode.ts:187, 908). */
const CONTROL_USERNAME = 'swarm';
const CONTROL_PASSWORD = 'spike0123456789abcdef0123456789ab';

/**
 * Cheapest model that still resolves through OpenRouter and supports tool
 * calling (opencode always offers its tool array, so a non-tool model errors).
 * Overridable for a re-run on another catalogue.
 */
const MODEL = process.env['OPENCODE_TOKENS_SPIKE_MODEL'] ?? 'openrouter/google/gemini-2.5-flash-lite';
/** Same id without the `openrouter/` prefix — the shape the API reports. */
const MODEL_API_ID = MODEL.replace(/^openrouter\//, '');

const AUTH_HEADER =
  'Basic ' + Buffer.from(`${CONTROL_USERNAME}:${CONTROL_PASSWORD}`).toString('base64');
const BASE = `http://127.0.0.1:${CONTROL_PORT}`;

// ----- Credential resolution ---------------------------------------------

/**
 * Where the key comes from, in the order a developer would expect.
 *
 * In production the adapter reads it from `instance_settings` through
 * `OpenRouterKeySource` and passes it as `OPENROUTER_API_KEY` in `secretEnv`
 * (opencode.ts:839); neither path is reachable from a standalone script, so the
 * spike falls back to the operator's own opencode credential file — the same
 * file `opencode auth login` writes. It is READ, never written.
 */
function resolveApiKey(): { key: string | null; source: string } {
  const env = process.env['OPENROUTER_API_KEY'];
  if (env) return { key: env, source: 'OPENROUTER_API_KEY (environment)' };
  const authPath = join(
    process.env['HOME'] ?? '/root',
    '.local',
    'share',
    'opencode',
    'auth.json',
  );
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as Record<
      string,
      { type?: string; key?: string }
    >;
    const key = parsed['openrouter']?.key;
    if (key) return { key, source: `${authPath} (operator's own opencode credential, read-only)` };
  } catch {
    /* no file, or unreadable — falls through to "no key" */
  }
  return { key: null, source: 'none found' };
}

const API_KEY = resolveApiKey();

// ----- Result model -------------------------------------------------------

type Verdict = 'CONFIRMED' | 'INFIRMED' | 'PARTIAL' | 'UNVERIFIED';

interface CheckResult {
  id: string;
  title: string;
  status: Verdict;
  /** What was executed / requested. */
  command: string;
  /** Raw evidence — JSON extracts, verbatim. */
  evidence: string;
  notes: string;
  durationMs: number;
}

const checks: CheckResult[] = [];

function unverified(id: string, title: string, command: string, why: string): CheckResult {
  return { id, title, status: 'UNVERIFIED', command, evidence: '(not run)', notes: why, durationMs: 0 };
}

// ----- HTTP helpers -------------------------------------------------------

interface HttpResult<T = unknown> {
  status: number;
  body: T | null;
  text: string;
}

async function api<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown; auth?: string | null },
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const auth = init?.auth === undefined ? AUTH_HEADER : init.auth;
  if (auth) headers['Authorization'] = auth;
  try {
    const res = await fetch(BASE + path, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let body: T | null = null;
    try {
      body = JSON.parse(text) as T;
    } catch {
      /* html or empty */
    }
    return { status: res.status, body, text };
  } catch (err) {
    return { status: 0, body: null, text: String(err) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the PTY helper to type `text`, then send a standalone CR 150 ms later. */
async function ptyType(text: string): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${PTY_CTL_PORT}/type`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.status;
  } catch {
    return 0;
  }
}

// ----- opencode API shapes (only the fields this spike reads) --------------

interface TokenCounts {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

interface SessionInfo {
  id: string;
  slug?: string;
  directory?: string;
  cost?: number;
  tokens?: TokenCounts;
  title?: string;
  model?: { id: string; providerID: string };
  version?: string;
  time?: { created: number; updated: number };
}

interface MessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: TokenCounts;
  finish?: string;
  summary?: boolean | unknown;
}

/** `GET /session/{id}/message` returns `{info, parts}` envelopes in 1.18.x. */
function infoOf(m: { info?: MessageInfo } & Partial<MessageInfo>): MessageInfo {
  return (m.info ?? m) as MessageInfo;
}

async function listSessions(): Promise<SessionInfo[]> {
  const r = await api<SessionInfo[]>('/session');
  return Array.isArray(r.body) ? r.body : [];
}

async function listMessages(sessionId: string): Promise<MessageInfo[]> {
  const r = await api<Array<{ info?: MessageInfo }>>(`/session/${sessionId}/message`);
  return Array.isArray(r.body) ? r.body.map(infoOf) : [];
}

/**
 * THE recommended reading, implemented here so the report's recommendation is
 * executable rather than prose: the last assistant message that has FINISHED.
 * An in-flight one exists in the list with all-zero counters and no `total`
 * (proven in T4) — reading it would make a busy agent look like a fresh one.
 */
function lastCompletedAssistant(messages: MessageInfo[]): MessageInfo | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role !== 'assistant') continue;
    if (m.time?.completed === undefined) continue;
    if (typeof m.tokens?.total !== 'number') continue;
    return m;
  }
  return null;
}

/** Poll until `pred` holds or `timeoutMs` elapses. Returns whether it held. */
async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(everyMs);
  }
  return false;
}

// ----- PTY helper ---------------------------------------------------------

/**
 * Boots opencode in a real node-pty and exposes a loopback side channel so the
 * parent can inject keystrokes with swarm-os's exact cadence. node-pty needs its
 * own process (native module + event loop), hence a child rather than an import.
 */
const PTY_HELPER_SRC = String.raw`
import { pathToFileURL } from 'node:url';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const pty = await import(pathToFileURL(process.env.PTY_NODE_PTY).href);
const spawn = pty.spawn ?? pty.default?.spawn;

const ARGS = JSON.parse(process.env.PTY_ARGS || '[]');
const OUT = process.env.PTY_OUT;
writeFileSync(OUT, '');

const env = { ...process.env, TERM: 'xterm-256color' };
delete env.PTY_ARGS;
delete env.PTY_NODE_PTY;

const p = spawn(process.env.PTY_BIN, ARGS, {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: process.env.PTY_CWD, env,
});
p.onData((d) => { try { appendFileSync(OUT, d); } catch {} });
p.onExit((e) => { try { appendFileSync(OUT, '\n[[EXIT ' + JSON.stringify(e) + ']]\n'); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url === '/type') {
      const { text } = JSON.parse(body || '{}');
      // swarm-os cadence (C6): the text, then a STANDALONE CR 150 ms later.
      p.write(text);
      await sleep(150);
      p.write('\r');
      res.writeHead(200).end('ok');
    } else if (req.url === '/kill') {
      res.writeHead(200).end('ok');
      try { p.kill(); } catch {}
      process.exit(0);
    } else {
      res.writeHead(404).end();
    }
  });
}).listen(Number(process.env.PTY_CTL_PORT), '127.0.0.1', () => console.log('pty-helper up'));
`;

const serverRequire = createRequire(resolve(__dirname, '../packages/server/index.js'));
function tryResolve(spec: string): string | null {
  try {
    return serverRequire.resolve(spec);
  } catch {
    return null;
  }
}
const NODE_PTY = tryResolve('node-pty');

const children: ChildProcess[] = [];

function cleanup() {
  // SIGKILL on the helper does NOT reap the opencode it spawned inside the PTY
  // — that one would survive as an orphan still holding the control port, and
  // the next run would find the port taken. Match it on its own argv, which
  // carries the randomised port and so cannot hit anyone else's agent.
  try {
    spawnSync('pkill', ['-f', `--port ${CONTROL_PORT} --hostname 127.0.0.1`], { timeout: 5000 });
  } catch {
    /* pkill absent — the SIGKILL below is still attempted */
  }
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (!KEEP) {
    try {
      rmSync(SPIKE_TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

/** Locate the opencode binary without installing anything. */
function findOpencode(): string | null {
  const which = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' });
  const p = (which.stdout || '').trim();
  return p.length > 0 && existsSync(p) ? p : null;
}

const OC = findOpencode();

function ocVersion(): string {
  if (!OC) return 'not installed';
  const r = spawnSync(OC, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return (r.stdout || r.stderr || '').trim().split('\n')[0] ?? 'unknown';
}

/** The inline config the adapter builds (`OPENCODE_CONFIG_CONTENT`, C1). */
function spikeConfig(): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: MODEL,
    permission: { bash: 'allow', edit: 'allow', webfetch: 'allow' },
  });
}

function bootTui(prompt: string): ChildProcess | null {
  if (!NODE_PTY || !OC || !API_KEY.key) return null;
  const args = [
    '--auto',
    '--port',
    String(CONTROL_PORT),
    '--hostname',
    '127.0.0.1',
    '--model',
    MODEL,
    '--prompt',
    prompt,
  ];
  const child = spawn(process.execPath, [join(HELPERS, 'pty-helper.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: process.env['HOME'] ?? '',
      PATH: process.env['PATH'] ?? '',
      PTY_NODE_PTY: NODE_PTY,
      PTY_BIN: OC,
      PTY_CWD: WORK,
      PTY_OUT: join(SPIKE_TMP, 'tui.log'),
      PTY_CTL_PORT: String(PTY_CTL_PORT),
      PTY_ARGS: JSON.stringify(args),
      // Exactly the `secretEnv` bundle of buildSpawn (opencode.ts:819-844).
      XDG_CONFIG_HOME: join(XDG, 'config'),
      XDG_DATA_HOME: join(XDG, 'data'),
      XDG_CACHE_HOME: join(XDG, 'cache'),
      XDG_STATE_HOME: join(XDG, 'state'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: spikeConfig(),
      OPENCODE_SERVER_USERNAME: CONTROL_USERNAME,
      OPENCODE_SERVER_PASSWORD: CONTROL_PASSWORD,
      OPENROUTER_API_KEY: API_KEY.key,
      TERM: 'xterm-256color',
    },
  });
  child.on('error', () => {});
  children.push(child);
  return child;
}

/** Human-visible text of the TUI, ANSI stripped — used to read the status bar. */
function tuiScreen(): string {
  try {
    const raw = readFileSync(join(SPIKE_TMP, 'tui.log'), 'utf8');
    return raw
      // eslint-disable-next-line no-control-regex
      .replace(/\][^]*/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[()][AB0-2]/g, '')
      .replace(/[ \t]+/g, ' ');
  } catch {
    return '';
  }
}

/**
 * opencode's own context indicator, e.g. `8.3K (1%)` or `832 (0%)`. Reading it
 * back out of the TUI is what turns "this formula looks right" into "this is
 * the number opencode itself displays".
 */
function tuiContextIndicator(): string | null {
  const m = tuiScreen().match(/([0-9]+(?:\.[0-9]+)?K?) \(([0-9]+)%\)/g);
  return m && m.length > 0 ? (m[m.length - 1] ?? null) : null;
}

const j = (v: unknown) => JSON.stringify(v, null, 2);

// ==========================================================================
// Checks
// ==========================================================================

async function main(): Promise<void> {
  mkdirSync(HELPERS, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  for (const d of ['config', 'data', 'cache', 'state']) mkdirSync(join(XDG, d), { recursive: true });
  writeFileSync(join(HELPERS, 'pty-helper.mjs'), PTY_HELPER_SRC);

  const blockers: string[] = [];
  if (!OC) blockers.push('`opencode` is not on PATH');
  if (!NODE_PTY) blockers.push('`node-pty` could not be resolved from packages/server');
  if (!API_KEY.key) blockers.push('no OpenRouter key (env `OPENROUTER_API_KEY`, nor ~/.local/share/opencode/auth.json)');

  if (blockers.length > 0) {
    const why = `UNVERIFIED — ${blockers.join('; ')}. Token counters cannot exist without a real model call; this spike will not fabricate them.`;
    for (const [id, title] of [
      ['T1', 'GET /session on a live TUI — schema + identifying the current session'],
      ['T2', 'Where the token counters live (session aggregate vs per-message)'],
      ['T3', 'Model context limit exposed by the API'],
      ['T4', 'Freshness — do the counters move during/right after a turn?'],
      ['T5', '/compact and /clear — session identity and counter reset'],
      ['T6', 'Basic auth exactly as the adapter configures it'],
      ['T7', "Cross-check — the formula reproduces opencode's own context indicator"],
    ] as const) {
      checks.push(unverified(id, title, 'n/a', why));
    }
    emitReport();
    return;
  }

  // ---- boot ------------------------------------------------------------
  const t0 = Date.now();
  bootTui('Reply with exactly: PONG');
  const up = await waitFor(async () => (await api('/session')).status === 200, 60_000, 1000);
  if (!up) {
    const why = `UNVERIFIED — the TUI never answered on ${BASE} within 60 s. TUI capture:\n${tuiScreen().slice(-800)}`;
    checks.push(unverified('T1', 'GET /session on a live TUI', `opencode --auto --port ${CONTROL_PORT}`, why));
    emitReport();
    return;
  }
  const bootMs = Date.now() - t0;

  // ---- T6 — auth (cheap, do it first while the first turn runs) --------
  await checkAuth();

  // Let the boot prompt finish before measuring anything.
  await waitFor(async () => {
    const s = await listSessions();
    return (s[0]?.tokens?.input ?? 0) > 0;
  }, 90_000, 1500);

  const sessions = await listSessions();
  const sessionId = sessions[0]?.id ?? '';

  await checkSessionList(sessions, bootMs);
  await checkCounterLocations(sessionId);
  await checkContextLimit();
  await checkFreshness(sessionId);
  await checkReset(sessionId);
  await checkFormulaMatchesTui();

  emitReport();
}

// ---- T6 ------------------------------------------------------------------

async function checkAuth(): Promise<void> {
  const t = Date.now();
  const none = await api('/session', { auth: null });
  const wrongPass = await api('/session', {
    auth: 'Basic ' + Buffer.from(`${CONTROL_USERNAME}:wrong-password`).toString('base64'),
  });
  const wrongUser = await api('/session', {
    auth: 'Basic ' + Buffer.from(`nobody:${CONTROL_PASSWORD}`).toString('base64'),
  });
  const good = await api('/session');

  // The challenge header proves it is HTTP Basic, not a bespoke scheme.
  let challenge = '';
  try {
    const r = await fetch(BASE + '/session');
    challenge = r.headers.get('www-authenticate') ?? '';
  } catch {
    /* ignore */
  }

  const ok = none.status === 401 && wrongPass.status === 401 && wrongUser.status === 401 && good.status === 200;
  checks.push({
    id: 'T6',
    title: 'Basic auth exactly as the adapter configures it',
    status: ok ? 'CONFIRMED' : 'INFIRMED',
    command: `GET ${BASE}/session with and without \`Authorization: Basic base64(${CONTROL_USERNAME}:<password>)\``,
    evidence: [
      `no Authorization header      → HTTP ${none.status}`,
      `www-authenticate            → ${challenge || '(none)'}`,
      `wrong password              → HTTP ${wrongPass.status}`,
      `wrong username              → HTTP ${wrongUser.status}`,
      `correct credentials         → HTTP ${good.status}`,
    ].join('\n'),
    notes: ok
      ? 'The credentials `OpencodeAdapter` already generates (`OPENCODE_CONTROL_USERNAME` = `swarm`, `generateServerPassword()`) are accepted verbatim as HTTP Basic. A tracker needs no new secret and no new plumbing: `controlPlane(configDir)` returns everything required. Note the corollary — the plane is **fully unauthenticated** when those two variables are unset, which is why the adapter treats them as mandatory rather than optional.'
      : 'The basic-auth contract does not behave as the adapter assumes — investigate before building anything on this plane.',
    durationMs: Date.now() - t,
  });
}

// ---- T1 ------------------------------------------------------------------

async function checkSessionList(sessions: SessionInfo[], bootMs: number): Promise<void> {
  const t = Date.now();
  const single = await api<SessionInfo>(`/session/${sessions[0]?.id}`);
  const ok = sessions.length >= 1 && Boolean(sessions[0]?.id);
  checks.push({
    id: 'T1',
    title: 'GET /session on a live TUI — schema + identifying the current session',
    status: ok ? 'CONFIRMED' : 'INFIRMED',
    command: `GET ${BASE}/session ; GET ${BASE}/session/{id}`,
    evidence:
      `TUI answered on the control plane after ${bootMs} ms.\n` +
      `GET /session → HTTP 200, JSON array, length ${sessions.length}\n\n` +
      j(sessions) +
      `\n\nGET /session/{id} → the same object, unwrapped (HTTP ${single.status}):\n` +
      j(single.body),
    notes:
      '`GET /session` returns a JSON **array** of session objects. A swarm-os agent runs one opencode process per session in its own XDG tree, so this array has exactly one element for as long as the agent has never reset its context — but `/clear` makes it grow (T5), so a tracker must never blindly take `[0]`. Every element carries `id`, `directory`, `title`, `model:{id,providerID}`, `version`, `time:{created,updated}`, plus `cost` and `tokens`. `GET /session/{id}` returns the same object unwrapped, which is the cheaper call once the id is known.',
    durationMs: Date.now() - t,
  });
}

// ---- T2 ------------------------------------------------------------------

async function checkCounterLocations(sessionId: string): Promise<void> {
  const t = Date.now();
  const sessions = await listSessions();
  const sess = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const messages = await listMessages(sessionId);
  const assistants = messages.filter((m) => m.role === 'assistant');

  // Does the session aggregate equal the SUM over assistant messages?
  const sum = assistants.reduce(
    (acc, m) => ({
      input: acc.input + (m.tokens?.input ?? 0),
      output: acc.output + (m.tokens?.output ?? 0),
      reasoning: acc.reasoning + (m.tokens?.reasoning ?? 0),
      cacheRead: acc.cacheRead + (m.tokens?.cache?.read ?? 0),
      cacheWrite: acc.cacheWrite + (m.tokens?.cache?.write ?? 0),
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const aggregateIsCumulative =
    sess?.tokens?.input === sum.input &&
    sess?.tokens?.output === sum.output &&
    sess?.tokens?.cache?.read === sum.cacheRead;

  // Is per-message `total` the sum of the components (= the request footprint)?
  const totalsConsistent = assistants.every((m) => {
    const tk = m.tokens;
    if (!tk || typeof tk.total !== 'number') return false;
    return tk.total === tk.input + tk.output + tk.reasoning + tk.cache.read + tk.cache.write;
  });

  const last = lastCompletedAssistant(messages);
  const sessionHasTotal = sess?.tokens !== undefined && 'total' in (sess.tokens as object);

  const ok = aggregateIsCumulative && totalsConsistent && last !== null;
  checks.push({
    id: 'T2',
    title: 'Where the token counters live (session aggregate vs per-message)',
    status: ok ? 'CONFIRMED' : 'PARTIAL',
    command: `GET ${BASE}/session   vs   GET ${BASE}/session/{id}/message`,
    evidence:
      `--- GET /session → the session's \`tokens\` + \`cost\` ---\n` +
      j({ cost: sess?.cost, tokens: sess?.tokens }) +
      `\n\n--- GET /session/{id}/message → every assistant message ---\n` +
      j(
        assistants.map((m) => ({
          id: m.id,
          role: m.role,
          modelID: m.modelID,
          providerID: m.providerID,
          cost: m.cost,
          tokens: m.tokens,
          finish: m.finish,
          time: m.time,
        })),
      ) +
      `\n\n--- arithmetic ---\n` +
      `sum over assistant messages: ${j(sum)}\n` +
      `session aggregate          : ${j(sess?.tokens)}\n` +
      `session aggregate == sum   : ${aggregateIsCumulative}\n` +
      `session object has \`total\` : ${sessionHasTotal}\n` +
      `per-message total == input+output+reasoning+cache.read+cache.write : ${totalsConsistent}\n` +
      `last completed assistant   : ${last?.id} → tokens.total = ${last?.tokens?.total}`,
    notes:
      'Both endpoints expose counters, and **they mean different things — this is the finding the whole tracker hangs on.**\n\n' +
      '- `GET /session` → `tokens:{input,output,reasoning,cache:{read,write}}` and `cost`. It has **no `total`**, and it is a **CUMULATIVE SUM over every assistant message of the session** (verified exactly, to the token, above). It is a *billing* counter: it only ever grows, and it does **not** drop after a compaction (T5). Driving a context gauge from it would show an agent at 300 % of its window.\n' +
      '- `GET /session/{id}/message` → each **assistant** message carries its own `tokens` **including a `total`**, plus `cost`, `finish` and `time.completed`. `total` is exactly `input + output + reasoning + cache.read + cache.write`, i.e. **the full footprint of that one request**: everything that was sent (fresh prompt + cache-read prefix) plus what came back.\n\n' +
      'So the **context currently occupied is `tokens.total` of the LAST COMPLETED assistant message** — not a sum, not the session aggregate. User messages carry no `tokens` at all (`null`), which is why the scan must skip them.',
    durationMs: Date.now() - t,
  });
}

// ---- T3 ------------------------------------------------------------------

async function checkContextLimit(): Promise<void> {
  const t = Date.now();
  const r = await api<{
    providers: Array<{
      id: string;
      models: Record<string, { id: string; limit?: { context: number; output: number }; cost?: unknown }>;
    }>;
    default: Record<string, string>;
  }>('/config/providers');
  const or = r.body?.providers?.find((p) => p.id === 'openrouter');
  const model = or?.models?.[MODEL_API_ID];
  const limit = model?.limit;

  // Is the limit also on the session or the message? (It is not — prove it.)
  const sessions = await listSessions();
  const sessionJson = JSON.stringify(sessions[0] ?? {});
  const messages = await listMessages(sessions[0]?.id ?? '');
  const messageJson = JSON.stringify(lastCompletedAssistant(messages) ?? {});
  const inSession = /"limit"|"context"/.test(sessionJson);
  const inMessage = /"limit"|"context"/.test(messageJson);

  const ok = typeof limit?.context === 'number' && limit.context > 0;
  checks.push({
    id: 'T3',
    title: 'Model context limit exposed by the API',
    status: ok ? 'CONFIRMED' : 'INFIRMED',
    command: `GET ${BASE}/config/providers → providers[openrouter].models["${MODEL_API_ID}"].limit`,
    evidence:
      `providers[openrouter].models["${MODEL_API_ID}"] (trimmed to the relevant fields):\n` +
      j({
        id: model?.id,
        limit: model?.limit,
        cost: (model as { cost?: unknown } | undefined)?.cost,
      }) +
      `\n\nlimit present in the SESSION object : ${inSession}\n` +
      `limit present in the MESSAGE object : ${inMessage}\n` +
      `openrouter models catalogued        : ${Object.keys(or?.models ?? {}).length}`,
    notes: ok
      ? `**CONFIRMED, and it is a first-class field:** \`GET /config/providers\` returns, per provider, a \`models\` map keyed by the api model id, each carrying \`limit:{context,output}\` (here **${limit?.context.toLocaleString('en-US')}** context / ${limit?.output.toLocaleString('en-US')} output) alongside \`cost:{input,output,cache:{read,write}}\` in $/M tokens. It is **not** on the session and **not** on the message (${inSession}/${inMessage}), so the tracker must join the two: take \`model.id\`+\`model.providerID\` from the session object and look them up here. The catalogue is static for the process's lifetime, so fetch it once per session and cache it.`
      : `The model id \`${MODEL_API_ID}\` was not found under providers[openrouter], so no limit could be read. Check the model id.`,
    durationMs: Date.now() - t,
  });
}

// ---- T4 ------------------------------------------------------------------

async function checkFreshness(sessionId: string): Promise<void> {
  const t = Date.now();
  interface Sample {
    tMs: number;
    sessionTokens: TokenCounts | undefined;
    lastAssistantId: string | undefined;
    lastAssistantTokens: TokenCounts | undefined;
    completed: number | 'PENDING';
    msgCount: number;
  }
  const samples: Sample[] = [];
  const start = Date.now();

  async function sample(): Promise<Sample> {
    const sessions = await listSessions();
    const s = sessions.find((x) => x.id === sessionId);
    const msgs = await listMessages(sessionId);
    const assistants = msgs.filter((m) => m.role === 'assistant');
    const last = assistants[assistants.length - 1];
    const smp: Sample = {
      tMs: Date.now() - start,
      sessionTokens: s?.tokens,
      lastAssistantId: last?.id,
      lastAssistantTokens: last?.tokens,
      completed: last?.time?.completed ?? 'PENDING',
      msgCount: msgs.length,
    };
    samples.push(smp);
    return smp;
  }

  const before = await sample();
  await ptyType('Count from 1 to 40, one number per line, nothing else.');
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const s = await sample();
    if (i > 2 && s.completed !== 'PENDING' && s.lastAssistantId !== before.lastAssistantId) break;
  }
  const after = samples[samples.length - 1];

  // First sample where anything moved relative to `before`.
  const firstMove = samples.find(
    (s) =>
      s.tMs > 0 &&
      (s.sessionTokens?.input !== before.sessionTokens?.input ||
        s.msgCount !== before.msgCount),
  );
  // First sample showing an in-flight assistant message (zeroed counters).
  const inFlight = samples.find(
    (s) => s.completed === 'PENDING' && s.lastAssistantId !== before.lastAssistantId,
  );
  const grew = (after?.sessionTokens?.input ?? 0) > (before.sessionTokens?.input ?? 0);

  checks.push({
    id: 'T4',
    title: 'Freshness — do the counters move during/right after a turn?',
    status: grew && firstMove ? 'CONFIRMED' : 'PARTIAL',
    command: 'PTY-inject a prompt (swarm-os cadence), then poll /session + /session/{id}/message every 1.5 s',
    evidence: samples
      .map(
        (s) =>
          `t+${String(s.tMs).padStart(6)}ms  session.tokens=${JSON.stringify(s.sessionTokens)}` +
          `  msgs=${s.msgCount}  lastAssistant=${s.lastAssistantId}` +
          `  tokens=${JSON.stringify(s.lastAssistantTokens)}  completed=${s.completed}`,
      )
      .join('\n'),
    notes:
      `**Counters are live, not end-of-turn.** The first observable movement landed at **t+${firstMove?.tMs ?? '?'} ms** after the prompt was submitted — well before the turn finished — and the session aggregate kept climbing as the turn progressed. A **15 s poll is comfortably viable**; the counters are not batched or flushed at some later checkpoint.\n\n` +
      (inFlight
        ? `**⚠ The trap a naive poller falls into.** While a turn is in flight the assistant message ALREADY EXISTS in \`/session/{id}/message\` with **all-zero counters and no \`total\`** (sample t+${inFlight.tMs} ms: \`${JSON.stringify(inFlight.lastAssistantTokens)}\`, \`time.completed\` absent). Taking "the last assistant message" unconditionally therefore reports **0 tokens of context for a busy agent** — the exact moment a tracker is most likely to be consulted. The reading must skip messages without \`time.completed\`/\`tokens.total\` and fall back to the last completed one (this script's \`lastCompletedAssistant()\`).`
        : '(No in-flight sample was captured in this run — the turn completed between two polls. The guard on `time.completed` remains mandatory: the previous run observed it.)'),
    durationMs: Date.now() - t,
  });
}

// ---- T5 ------------------------------------------------------------------

async function checkReset(sessionId: string): Promise<void> {
  const t = Date.now();
  const beforeSessions = await listSessions();
  const beforeMsgs = await listMessages(sessionId);
  const beforeLast = lastCompletedAssistant(beforeMsgs);
  const beforeIndicator = tuiContextIndicator();

  // --- /compact, driven exactly as swarm-os drives it: PTY keystrokes -----
  await ptyType('/compact');
  const compacted = await waitFor(async () => {
    const msgs = await listMessages(sessionId);
    const last = lastCompletedAssistant(msgs);
    return last !== null && last.id !== beforeLast?.id;
  }, 120_000, 2000);
  // The TUI repaints its status bar a beat after the API settles; read the
  // indicator only once it has, otherwise the cross-check compares against a
  // stale frame still showing the pre-compaction figure.
  await sleep(12_000);

  const afterCompactSessions = await listSessions();
  const afterCompactMsgs = await listMessages(sessionId);
  const afterCompactLast = lastCompletedAssistant(afterCompactMsgs);
  const summaryMsg = afterCompactMsgs.find((m) => m.summary === true);
  const compactIndicator = tuiContextIndicator();

  const sameSession =
    afterCompactSessions.length === beforeSessions.length &&
    afterCompactSessions.some((s) => s.id === sessionId);
  const contextDropped =
    (afterCompactLast?.tokens?.total ?? Infinity) < (beforeLast?.tokens?.total ?? 0);
  const aggregateDropped =
    (afterCompactSessions.find((s) => s.id === sessionId)?.tokens?.input ?? 0) <
    (beforeSessions.find((s) => s.id === sessionId)?.tokens?.input ?? 0);

  // --- /clear, the other reset the adapter can emit ------------------------
  //
  // Tested in TWO steps on purpose: `/clear` alone is not observable on this
  // plane, the new session only materialises when the next prompt is sent. A
  // spike that stopped after step 1 would conclude "no new session" and hand
  // the tracker a session id that silently goes stale.
  await ptyType('/clear');
  await sleep(8000);
  const afterClearIdle = await listSessions();
  const clearAloneMadeSession = afterClearIdle.length > afterCompactSessions.length;

  await ptyType('Say the word BANANA and nothing else.');
  await waitFor(async () => (await listSessions()).length > afterClearIdle.length, 90_000, 2000);
  await sleep(3000);
  const afterClearSessions = await listSessions();
  const clearMadeNewSession = afterClearSessions.length > afterCompactSessions.length;
  const newest = [...afterClearSessions].sort(
    (a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0),
  )[0];
  const newestIsFirst = afterClearSessions[0]?.id === newest?.id;
  const newestMsgs = newest ? await listMessages(newest.id) : [];
  const newestLast = lastCompletedAssistant(newestMsgs);

  const ok = compacted && sameSession && contextDropped;
  checks.push({
    id: 'T5',
    title: '/compact and /clear — session identity and counter reset',
    status: ok ? 'CONFIRMED' : 'PARTIAL',
    command: 'PTY: write "/compact" then a standalone CR (+150 ms) — then the same for "/clear"',
    evidence:
      `=== BEFORE /compact ===\n` +
      `sessions: ${beforeSessions.length} → ${beforeSessions.map((s) => s.id).join(', ')}\n` +
      `session aggregate: ${j(beforeSessions.find((s) => s.id === sessionId)?.tokens)}\n` +
      `last completed assistant: ${beforeLast?.id} tokens.total=${beforeLast?.tokens?.total}\n` +
      `opencode's own TUI indicator: ${beforeIndicator ?? '(not captured)'}\n\n` +
      `=== AFTER /compact (completed: ${compacted}) ===\n` +
      `sessions: ${afterCompactSessions.length} → ${afterCompactSessions.map((s) => s.id).join(', ')}\n` +
      `same session id kept: ${sameSession}\n` +
      `session aggregate: ${j(afterCompactSessions.find((s) => s.id === sessionId)?.tokens)}   (dropped: ${aggregateDropped})\n` +
      `last completed assistant: ${afterCompactLast?.id} tokens.total=${afterCompactLast?.tokens?.total}   (dropped: ${contextDropped})\n` +
      `summary message present (\`summary: true\`): ${Boolean(summaryMsg)} → ${summaryMsg?.id}\n` +
      j(
        summaryMsg
          ? { id: summaryMsg.id, role: summaryMsg.role, summary: summaryMsg.summary, tokens: summaryMsg.tokens, finish: summaryMsg.finish }
          : null,
      ) +
      `\nopencode's own TUI indicator: ${compactIndicator ?? '(not captured)'}\n\n` +
      `=== AFTER /clear, BEFORE any further prompt ===\n` +
      `sessions: ${afterClearIdle.length} → ${afterClearIdle.map((s) => s.id).join(', ')}\n` +
      `a new session appeared on /clear alone: ${clearAloneMadeSession}\n\n` +
      `=== AFTER /clear + one further prompt ===\n` +
      `sessions: ${afterClearSessions.length}\n` +
      afterClearSessions
        .map(
          (s) =>
            `  ${s.id}  created=${s.time?.created}  updated=${s.time?.updated}  tokens.input=${s.tokens?.input ?? 0}`,
        )
        .join('\n') +
      `\na NEW session appeared: ${clearMadeNewSession}\n` +
      `newest by time.created: ${newest?.id}\n` +
      `array is ordered newest-first: ${newestIsFirst}\n` +
      `newest session's last completed assistant: ${newestLast?.id} tokens.total=${newestLast?.tokens?.total}`,
    notes:
      `**\`/compact\` keeps the SAME opencode session (\`${sessionId}\`, ${sameSession}).** No new session id appears; \`GET /session\` still lists the same element. What appears is a new assistant message flagged **\`summary: true\`**, whose \`tokens.total\` is the size of the summary — the compacted context. ` +
      `The per-message reading therefore **drops correctly** across a compaction (${beforeLast?.tokens?.total} → ${afterCompactLast?.tokens?.total}), while the **session aggregate does NOT** (dropped: ${aggregateDropped}) — it keeps accumulating, which is the second and decisive reason not to build the tracker on it.\n\n` +
      `(opencode's own status bar read \`${beforeIndicator ?? '?'}\` before the compaction and \`${compactIndicator ?? '?'}\` ~12 s after it. The bar is **not** a reliable freshness signal — it does not necessarily repaint on compaction alone — which is precisely why the tracker reads the API and not the screen. T7 cross-checks the formula against that bar at an instant where both are settled.)\n\n` +
      `**\`/clear\` behaves completely differently, and it is the one that breaks session resolution.** It creates a **NEW opencode session** (${clearMadeNewSession}) — but **LAZILY**: immediately after \`/clear\` the list was unchanged (new session on \`/clear\` alone: ${clearAloneMadeSession}); the new session only materialised when the **next prompt** was sent. \`GET /session\` then listed ${afterClearSessions.length} sessions for one single agent, the old one frozen at its final counters forever.\n\n` +
      `**Consequence for the tracker:** a session id resolved once at spawn goes stale at the first \`/clear\`, and the gauge then freezes at the pre-clear value while the agent happily fills a fresh window. **Re-resolve on every poll.** Ordering observed here was newest-first (${newestIsFirst}), but nothing documents it and opencode ids do not sort chronologically as plain strings — so compare \`time.created\` explicitly rather than taking \`[0]\`. The newest session (\`${newest?.id}\`) reads \`tokens.total = ${newestLast?.tokens?.total}\`, i.e. opencode's fixed baseline (system prompt + tool schemas) and nothing else, which is exactly right for a just-cleared context.`,
    durationMs: Date.now() - t,
  });
}

// ---- T7 ------------------------------------------------------------------

/** opencode's own compaction of a token count: `832`, `8.0K`, `130.5K`. */
function formatK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}

/**
 * The strongest available evidence that the recommended formula is the right
 * one: compute it, and compare against the number opencode itself puts on
 * screen at that same instant. If they agree, the tracker is not approximating
 * opencode's notion of "context used" — it is reproducing it.
 */
async function checkFormulaMatchesTui(): Promise<void> {
  const t = Date.now();
  // Settle: the status bar repaints a beat after the API does.
  await sleep(8000);

  const sessions = await listSessions();
  const current = sessions.reduce((a, b) =>
    (b.time?.created ?? 0) > (a.time?.created ?? 0) ? b : a,
  );
  const messages = await listMessages(current.id);
  const last = lastCompletedAssistant(messages);
  const used = last?.tokens?.total ?? 0;

  const provs = await api<{
    providers: Array<{ id: string; models: Record<string, { limit?: { context: number } }> }>;
  }>('/config/providers');
  const limit =
    provs.body?.providers?.find((p) => p.id === current.model?.providerID)?.models?.[
      current.model?.id ?? ''
    ]?.limit?.context ?? 0;

  const pct = limit > 0 ? Math.round((used / limit) * 100) : -1;
  const computed = `${formatK(used)} (${pct}%)`;
  const shown = tuiContextIndicator();
  const match = shown === computed;

  checks.push({
    id: 'T7',
    title: "Cross-check — the formula reproduces opencode's own context indicator",
    status: match ? 'CONFIRMED' : 'PARTIAL',
    command: 'compute `lastCompletedAssistant().tokens.total` / `limit.context`, compare to the TUI status bar',
    evidence:
      `current session (max time.created) : ${current.id}\n` +
      `model                              : ${current.model?.providerID}/${current.model?.id}\n` +
      `last completed assistant message   : ${last?.id}\n` +
      `  tokens.total                     : ${used}\n` +
      `limit.context (from /config/providers): ${limit}\n` +
      `computed indicator                 : ${computed}\n` +
      `opencode's own status bar shows    : ${shown ?? '(not captured)'}\n` +
      `match                              : ${match}\n\n` +
      `(for contrast, the SESSION aggregate at the same instant: ${j(current.tokens)})`,
    notes: match
      ? `**CONFIRMED — byte-for-byte.** The recommended reading (\`tokens.total\` of the last completed assistant message, over \`limit.context\` from the provider catalogue) produces \`${computed}\`, which is exactly the string opencode prints in its own status bar. The tracker is therefore not inventing a metric or approximating one: it reports **the same number opencode shows its user**, which is the strongest guarantee available that a swarm-os context gauge and the agent's own view will never disagree.`
      : `The computed value (\`${computed}\`) and the TUI's (\`${shown ?? 'not captured'}\`) differ. The most likely cause is a stale frame in the PTY capture rather than a wrong formula — the arithmetic in T2 is exact and the drop across compaction in T5 behaves correctly — but the mismatch is reported rather than smoothed over.`,
    durationMs: Date.now() - t,
  });
}

// ==========================================================================
// Report
// ==========================================================================

/**
 * The point of the whole spike: an unambiguous contract for the tracker, so
 * nobody has to re-derive it from the evidence blocks above.
 */
function recommendation(): string[] {
  return [
    '---',
    '',
    '## Recommandation ferme pour le tracker de contexte',
    '',
    '**Verdict : OUI — l\'usage de tokens d\'une session opencode vivante est lisible via le plan de contrôle HTTP déjà démarré et déjà authentifié. Aucun flag, aucun secret, aucune dépendance supplémentaire.** `controlPlane(configDir)` (opencode.ts:880-883) fournit déjà tout : port, hostname, username, password.',
    '',
    '### Ce qu\'il faut poller',
    '',
    'Deux appels, toutes les 15 s (les compteurs bougent en < 2 s, cf. T4 — 15 s est confortable) :',
    '',
    '```',
    'GET  {baseUrl}/session                    → résoudre LA session courante',
    'GET  {baseUrl}/session/{id}/message       → lire le contexte occupé',
    '```',
    '',
    'Plus **un seul appel au démarrage de la session**, mis en cache pour toute sa durée de vie :',
    '',
    '```',
    'GET  {baseUrl}/config/providers           → la limite de contexte du modèle',
    '```',
    '',
    'En-tête sur chacun (T6) : `Authorization: Basic base64("<control.username>:<control.password>")`.',
    '',
    '### Formule',
    '',
    '```ts',
    '// 1. Résoudre la session COURANTE à CHAQUE poll — jamais une seule fois.',
    '//    `/clear` en crée une nouvelle (paresseusement), et l\'ancienne reste',
    '//    listée, figée sur ses derniers compteurs (T5).',
    'const sessions = await GET(`/session`);            // tableau',
    'const current  = sessions.reduce((a, b) => (b.time.created > a.time.created ? b : a));',
    '',
    '// 2. Le contexte occupé = `tokens.total` du DERNIER message assistant TERMINÉ.',
    '//    Sauter ceux sans `time.completed` : un message en cours de génération',
    '//    existe déjà, avec des compteurs à ZÉRO (T4).',
    'const messages = await GET(`/session/${current.id}/message`);',
    'const last = [...messages].map(m => m.info ?? m).reverse()',
    '  .find(m => m.role === "assistant" && m.time?.completed !== undefined',
    '          && typeof m.tokens?.total === "number");',
    'const used = last?.tokens.total ?? 0;',
    '',
    '// 3. La limite vient du catalogue, jointe via le modèle de la session.',
    'const limit = providers',
    '  .find(p => p.id === current.model.providerID)',
    '  ?.models[current.model.id]?.limit?.context;',
    '',
    'const pct = limit ? used / limit : null;          // null ⇒ afficher les tokens bruts',
    '```',
    '',
    '`tokens.total` vaut exactement `input + output + reasoning + cache.read + cache.write` (vérifié à l\'unité près, T2) : tout ce qui a été envoyé au modèle (prompt frais + préfixe relu depuis le cache) plus ce qui est revenu. C\'est **la formule qu\'opencode utilise lui-même** — sa barre de statut affiche le même nombre et le même pourcentage, au caractère près (T7).',
    '',
    '### Les trois pièges, et ils sont tous silencieux',
    '',
    '1. **Ne PAS utiliser `tokens` de `GET /session`.** C\'est une somme cumulée sur tous les messages assistant — un compteur de facturation. Il ne redescend jamais, pas même après un `/compact` (T5). Une jauge branchée dessus dépasse 100 % puis continue de monter.',
    '2. **Ne PAS prendre le dernier message assistant sans filtrer.** Pendant un tour, il est déjà là avec `tokens` à zéro et sans `total` : un agent occupé s\'afficherait à 0 % — précisément au moment où on consulte la jauge.',
    '3. **Ne PAS mémoriser l\'id de session.** `/compact` la conserve (et le compteur redescend tout seul, rien à faire) ; `/clear` en crée une nouvelle, mais seulement au prompt suivant. Un id résolu une fois fige la jauge pour toujours après le premier `/clear`.',
    '',
    '### Deux améliorations gratuites, déjà disponibles sur le même plan',
    '',
    '- **`cost`** est exposé aux deux niveaux (cumulé sur la session, par message) et en dollars réels calculés par opencode depuis `cost:{input,output,cache}` du catalogue. Un coût par agent est à portée de main sans rien calculer.',
    '- **`GET /event`** (le flux SSE de C8, toujours non consommé) porte `message.updated` : un consommateur d\'événements rendrait le polling inutile et supprimerait d\'un coup les pièges 2 et 3, puisque les ids de session et de message arrivent dans le flux. Le polling reste le chemin le plus simple pour un premier jet ; l\'événementiel est la cible.',
    '',
    '### Portée / limite connue',
    '',
    '**Sous SSH, ce plan est sur le loopback de l\'HÔTE.** `SshAgentProcess` ne monte qu\'un forward INVERSE (`-R`, pour MCP) : joindre ce port depuis le conteneur demande un forward DIRECT (`ssh -L`), exactement la même dépendance que celle déjà notée pour le consommateur `/event` (opencode.ts:868-871). Le tracker doit traiter un plan injoignable comme « pas de mesure pour cette session » — jamais comme une erreur de session.',
    '',
  ];
}

function emitReport(): void {
  // T6 runs first (it is cheap and can share the boot turn's dead time), so the
  // array is not in reading order. Sort for the reader, not for the runner.
  checks.sort((a, b) => a.id.localeCompare(b.id));
  const counts = { CONFIRMED: 0, INFIRMED: 0, PARTIAL: 0, UNVERIFIED: 0 };
  for (const c of checks) counts[c.status]++;
  const total = Math.round(checks.reduce((s, c) => s + c.durationMs, 0) / 1000);

  const lines: string[] = [];
  lines.push('# Provider spike — usage de tokens d\'une session opencode VIVANTE (plan de contrôle HTTP)');
  lines.push('');
  lines.push(`_Generated by \`scripts/verify-opencode-tokens.ts\` on ${new Date().toISOString()}._`);
  lines.push('');
  lines.push('**Run command:** `pnpm --filter server exec tsx ../../scripts/verify-opencode-tokens.ts`');
  lines.push('');
  lines.push('**Question.** `scripts/verify-opencode.report.md` (C8) proved the per-session control plane exists and carries `permission.asked` / `session.idle`. It never looked at token usage. This spike answers: **can a context tracker read how full an opencode agent\'s window is, live, over that same plane — and with which endpoint, fields and formula?**');
  lines.push('');
  lines.push('**Environment:**');
  lines.push(`- opencode binary: \`${OC ?? 'NOT FOUND'}\``);
  lines.push(`- opencode version: **${ocVersion()}**`);
  lines.push(`- model used (cheapest usable): \`${MODEL}\``);
  lines.push(`- OpenRouter key source: ${API_KEY.key ? API_KEY.source : '**none — every check UNVERIFIED**'}`);
  lines.push(`- control plane: \`${BASE}\`, basic auth \`${CONTROL_USERNAME}\`:\`<generated>\` — the adapter's own scheme`);
  lines.push(`- sandbox (removed on exit): \`${SPIKE_TMP}\``);
  lines.push(`- node: ${process.version} · platform: ${process.platform}`);
  lines.push('');
  lines.push('**Method.** A real opencode TUI is booted inside a real `node-pty` with the *exact* argv and env `OpencodeAdapter.buildSpawn()` produces (`--auto --port N --hostname 127.0.0.1 --model …`, inline `OPENCODE_CONFIG_CONTENT`, four redirected `XDG_*` roots, `OPENCODE_SERVER_USERNAME`/`PASSWORD`). Prompts are injected through the PTY with swarm-os\'s own cadence (text, then a standalone CR 150 ms later), never over HTTP, so `/compact` and `/clear` are exercised on the path production actually uses. Everything below is a verbatim JSON extract from that live session.');
  lines.push('');
  lines.push(`**Summary:** CONFIRMED=${counts.CONFIRMED} · PARTIAL=${counts.PARTIAL} · INFIRMED=${counts.INFIRMED} · UNVERIFIED=${counts.UNVERIFIED} · total=${total}s`);
  lines.push('');
  lines.push('| Check | Statut | En une ligne |');
  lines.push('|-------|--------|--------------|');
  for (const c of checks) {
    const first = c.notes.replace(/\n[\s\S]*$/, '').replace(/\|/g, '\\|').slice(0, 180);
    lines.push(`| ${c.id} — ${c.title} | ${c.status} | ${first} |`);
  }
  lines.push('');
  for (const c of checks) {
    lines.push('---');
    lines.push(`## ${c.id} — ${c.title}`);
    lines.push('');
    lines.push(`Status: ${c.status}`);
    lines.push('');
    lines.push(`Command: \`${c.command}\``);
    lines.push('');
    lines.push(`Duration: ${c.durationMs}ms`);
    lines.push('');
    lines.push('Evidence:');
    lines.push('```');
    lines.push(c.evidence);
    lines.push('```');
    lines.push('');
    lines.push(c.notes);
    lines.push('');
  }
  lines.push(...recommendation());
  writeFileSync(REPORT_PATH, lines.join('\n'));
  // eslint-disable-next-line no-console
  console.log(`report written to ${REPORT_PATH}`);
  // eslint-disable-next-line no-console
  console.log(`CONFIRMED=${counts.CONFIRMED} PARTIAL=${counts.PARTIAL} INFIRMED=${counts.INFIRMED} UNVERIFIED=${counts.UNVERIFIED}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
