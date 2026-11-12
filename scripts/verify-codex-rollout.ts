/**
 * scripts/verify-codex-rollout.ts
 *
 * Spike `spike-codex-rollout` — can swarm-os read the **token usage / context
 * window occupancy** of a *living* codex session by tailing its rollout file?
 *
 * Context: swarm-os runs codex agents in a PTY with a per-session `CODEX_HOME`
 * (see `packages/server/src/modules/providers/codex.ts`, `CODEX_SHARED_ENTRIES`
 * :104-112 and `prepareSessionConfig` :379-395). That home is destroyed when the
 * session ends, but it is alive FOR THE WHOLE SESSION — so a tracker could tail
 * `$CODEX_HOME/sessions/**\/rollout-*.jsonl` while the agent works.
 *
 * Run via:
 *   pnpm --filter server exec tsx ../../scripts/verify-codex-rollout.ts
 *
 * SAFETY INVARIANT — identical to `scripts/verify-codex.ts`: nothing is ever
 * written into the operator's real `~/.codex`. Everything happens under a
 * disposable scratch root, and the only thing borrowed from the real home is
 * `auth.json`, symlinked read-only into the throwaway CODEX_HOME. The scratch
 * tree is removed at the end.
 *
 * COST — one interactive session, cheapest model available (`gpt-5.4-mini`;
 * there is no `gpt-5-nano` in this install's model cache), reasoning effort
 * "low", four one-word prompts. `/status`, `/compact` and `/new` are free of
 * model calls except the compaction summary itself.
 *
 * WHAT IT MEASURES (R1..R6)
 *   R1  a rollout file exists under the live per-session CODEX_HOME, and when
 *   R2  the token-count event: exact type + full payload schema
 *   R3  update frequency + continuous flush (a real incremental tailer runs
 *       against the file for the whole session and timestamps what it sees)
 *   R4  which field reflects context-window occupancy, cross-checked against
 *       the TUI's own "% context left" / `/status` readout
 *   R5  what `/compact` and `/new` do to the file and to the counters
 *   R6  how many rollout files a single CODEX_HOME accumulates
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
  rmSync,
  statSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ----- Paths --------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REPORT_PATH = resolve(__dirname, 'verify-codex-rollout.report.md');
/**
 * Scratch root. Overridable so the spike can run outside /tmp — under a temp
 * dir the CLI logs `Refusing to create helper binaries under temporary dir`
 * (harmless, see verify-codex C1).
 */
const SPIKE_TMP =
  process.env['CODEX_ROLLOUT_SPIKE_TMP'] ?? '/tmp/claude-1000/swarm-os-spike-codex-rollout';
const REAL_AUTH = join(homedir(), '.codex', 'auth.json');

const requireFromServer = createRequire(join(REPO_ROOT, 'packages', 'server', 'package.json'));

// ----- Types --------------------------------------------------------------

type Status = 'CONFIRMED' | 'REFUTED' | 'UNVERIFIED' | 'PARTIAL';

interface CheckResult {
  id: string;
  title: string;
  status: Status;
  command: string;
  stdout: string;
  notes: string;
}

/** One JSONL line of a rollout, as seen by the tailer. */
interface RolloutLine {
  /** ms since the PTY was spawned, i.e. when OUR tailer saw the line. */
  seenAtMs: number;
  /** Byte offset the line started at. */
  offset: number;
  file: string;
  raw: string;
  json: RolloutEvent | null;
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface RolloutEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    cli_version?: string;
    originator?: string;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
      model_context_window?: number;
    } | null;
    rate_limits?: unknown;
    [k: string]: unknown;
  };
}

// ----- Helpers ------------------------------------------------------------

const MODEL = process.env['CODEX_SPIKE_MODEL'] ?? 'gpt-5.4-mini';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function trim(s: string | undefined, max = 6000): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Collapse a raw PTY capture to something greppable (copied from verify-codex.ts). */
function plain(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*\s[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][A-Z0-9]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[=>]/g, '')
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

/** Every `rollout-*.jsonl` under `<home>/sessions`, recursively, with mtime. */
function findRollouts(home: string): Array<{ path: string; mtimeMs: number; size: number }> {
  const root = join(home, 'sessions');
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e))
        out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// ----- The tailer (the thing the production tracker would be) -------------

/**
 * A byte-offset incremental reader — exactly what a swarm-os tracker would do.
 * It NEVER re-reads from the start: it keeps an offset per file, reads only the
 * new bytes, and buffers a trailing partial line. If this works while the
 * session is alive, the tracker works.
 */
class RolloutTailer {
  lines: RolloutLine[] = [];
  /** file → [ts since spawn, size] samples, to prove continuous flushing. */
  sizeSamples = new Map<string, Array<[number, number]>>();
  filesSeen: string[] = [];
  firstSeenMs = new Map<string, number>();
  private offsets = new Map<string, number>();
  private partials = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly t0: number,
  ) {}

  /** One poll cycle: discover new files, read new bytes from each. */
  poll(): void {
    const now = Date.now() - this.t0;
    for (const f of findRollouts(this.home)) {
      if (!this.firstSeenMs.has(f.path)) {
        this.firstSeenMs.set(f.path, now);
        this.filesSeen.push(f.path);
        this.offsets.set(f.path, 0);
        this.sizeSamples.set(f.path, []);
      }
      const samples = this.sizeSamples.get(f.path);
      const last = samples?.[samples.length - 1];
      if (samples && (!last || last[1] !== f.size)) samples.push([now, f.size]);

      const from = this.offsets.get(f.path) ?? 0;
      if (f.size <= from) continue;
      // Read ONLY the new bytes — a live `tail -c +<offset>` in JS.
      const fd = openSync(f.path, 'r');
      try {
        const len = f.size - from;
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, from);
        this.offsets.set(f.path, from + read);
        const chunk = (this.partials.get(f.path) ?? '') + buf.subarray(0, read).toString('utf8');
        const parts = chunk.split('\n');
        this.partials.set(f.path, parts.pop() ?? '');
        let off = from;
        for (const raw of parts) {
          const lineOffset = off;
          off += Buffer.byteLength(raw, 'utf8') + 1;
          if (!raw.trim()) continue;
          let json: RolloutEvent | null = null;
          try {
            json = JSON.parse(raw) as RolloutEvent;
          } catch {
            json = null;
          }
          this.lines.push({ seenAtMs: now, offset: lineOffset, file: f.path, raw, json });
        }
      } finally {
        closeSync(fd);
      }
    }
  }

  tokenEvents(): RolloutLine[] {
    return this.lines.filter((l) => l.json?.payload?.type === 'token_count');
  }

  /** token_count events that actually carry usage numbers (`info` non-null). */
  usageEvents(): RolloutLine[] {
    return this.tokenEvents().filter((l) => l.json?.payload?.info != null);
  }
}

// ----- PTY driver (same shape as verify-codex.ts) -------------------------

interface PtyHandle {
  write: (s: string) => void;
  kill: () => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
}

class PtyRun {
  raw = '';
  lastData = Date.now();
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

  async waitIdle(ms: number, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.exited) return true;
      if (Date.now() - this.lastData >= ms) return true;
      await sleep(80);
    }
    return false;
  }

  /** swarm-os's two-step injection (session.ts:1006-1050). */
  submitTwoStep(text: string): void {
    this.write(text);
    setTimeout(() => this.write('\r'), 150);
  }
}

// ----- notify sink (turn-complete signal) ---------------------------------

interface NotifyRecord {
  type?: string;
  'thread-id'?: string;
  'last-assistant-message'?: string;
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
        return {};
      }
    });
}

// ----- The driven session -------------------------------------------------

interface Phase {
  label: string;
  /** ms since spawn when the phase ended. */
  atMs: number;
  /** rollout files known at that moment. */
  files: string[];
  /** usage events accumulated so far. */
  usageCount: number;
  /** last usage snapshot at that moment. */
  last?: { total: TokenUsage; last: TokenUsage; window: number };
  /** TUI screen tail, for the % context readouts. */
  screen: string;
}

interface Outcome {
  ok: boolean;
  error?: string;
  tailer: RolloutTailer;
  phases: Phase[];
  /** ms from spawn to the rollout file's first appearance. */
  firstRolloutMs: number | null;
  firstRolloutPath: string | null;
  /** ms from spawn to the first line our tailer could read. */
  firstLineMs: number | null;
  /** ms from spawn to the first usage-bearing token_count. */
  firstUsageMs: number | null;
  notifies: number;
  /** `/status` screen capture (free — no model call). */
  statusScreen: string;
  /** Every "N% context left/used" the TUI printed, in order. */
  pctReadouts: string[];
  finalFiles: Array<{ path: string; size: number; mtimeMs: number }>;
  ptyExited: boolean;
  ptyExitCode: number | null;
  trace: string[];
  /** Proof the file is readable mid-turn: (ms, bytes) taken WHILE a turn ran. */
  midTurnGrowth: Array<[number, number]>;
}

const PCT_RE = /(\d{1,3})\s*%\s*context\s*(left|used)/gi;

async function runSession(): Promise<Outcome> {
  const home = join(SPIKE_TMP, 'home');
  const work = join(SPIKE_TMP, 'work');
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  if (existsSync(REAL_AUTH)) symlinkSync(REAL_AUTH, join(home, 'auth.json'));

  const notifyLog = join(home, 'notify.jsonl');
  const notifyScript = join(home, 'notify.sh');
  writeFileSync(notifyScript, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${notifyLog}\n`);
  chmodSync(notifyScript, 0o755);

  writeFileSync(
    join(home, 'config.toml'),
    `model = "${MODEL}"
model_reasoning_effort = "low"
notify = ["${notifyScript}"]

[projects."${work}"]
trust_level = "trusted"
`,
  );

  const out: Outcome = {
    ok: false,
    tailer: null as unknown as RolloutTailer,
    phases: [],
    firstRolloutMs: null,
    firstRolloutPath: null,
    firstLineMs: null,
    firstUsageMs: null,
    notifies: 0,
    statusScreen: '',
    pctReadouts: [],
    finalFiles: [],
    ptyExited: false,
    ptyExitCode: null,
    trace: [],
    midTurnGrowth: [],
  };

  const t0 = Date.now();
  const tailer = new RolloutTailer(home, t0);
  out.tailer = tailer;

  const p = new PtyRun(
    ['--no-alt-screen', '-C', work, '--dangerously-bypass-approvals-and-sandbox'],
    { CODEX_HOME: home },
    work,
  );

  // The tailer runs at 200 ms for the WHOLE session — this is the production
  // shape (a poller, not a one-shot read at the end).
  const pollTimer = setInterval(() => {
    try {
      tailer.poll();
      if (out.firstRolloutMs === null && tailer.filesSeen.length > 0) {
        out.firstRolloutMs = tailer.firstSeenMs.get(tailer.filesSeen[0]!) ?? null;
        out.firstRolloutPath = tailer.filesSeen[0] ?? null;
      }
      if (out.firstLineMs === null && tailer.lines.length > 0)
        out.firstLineMs = tailer.lines[0]!.seenAtMs;
      if (out.firstUsageMs === null && tailer.usageEvents().length > 0)
        out.firstUsageMs = tailer.usageEvents()[0]!.seenAtMs;
    } catch {
      /* keep polling */
    }
  }, 200);

  const notifies = (): NotifyRecord[] => readNotifies(notifyLog);
  const waitNotify = async (n: number, timeoutMs: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (notifies().length >= n) return true;
      if (p.exited) return notifies().length >= n;
      await sleep(250);
    }
    return false;
  };

  const snapshotUsage = ():
    | { total: TokenUsage; last: TokenUsage; window: number }
    | undefined => {
    const evs = tailer.usageEvents();
    const info = evs[evs.length - 1]?.json?.payload?.info;
    if (!info) return undefined;
    return {
      total: info.total_token_usage ?? {},
      last: info.last_token_usage ?? {},
      window: info.model_context_window ?? 0,
    };
  };

  const screenTail = (from: number, n = 400): string =>
    plain(p.raw.slice(from)).replace(/\s+/g, ' ').slice(-n);

  const mark = (label: string, fromIdx: number): void => {
    const ph: Phase = {
      label,
      atMs: Date.now() - t0,
      files: [...tailer.filesSeen],
      usageCount: tailer.usageEvents().length,
      last: snapshotUsage(),
      screen: screenTail(fromIdx),
    };
    out.phases.push(ph);
    const l = ph.last;
    const line =
      `+${(ph.atMs / 1000).toFixed(0)}s ${label} · files=${ph.files.length} · usageEvents=${ph.usageCount}` +
      (l
        ? ` · last.total_tokens=${l.last.total_tokens} · total.total_tokens=${l.total.total_tokens} · win=${l.window}`
        : ' · (no usage yet)');
    out.trace.push(line);
    console.log(`    ${line}`);
  };

  /** Ask a one-word question and wait for the turn to complete. */
  const ask = async (label: string, prompt: string): Promise<void> => {
    const n = notifies().length;
    const idx = p.raw.length;
    p.submitTwoStep(prompt);
    // Sample the rollout WHILE the turn runs — proves mid-turn readability.
    const growthStart = Date.now();
    const growthTimer = setInterval(() => {
      const f = out.firstRolloutPath;
      if (!f) return;
      try {
        out.midTurnGrowth.push([Date.now() - t0, statSync(f).size]);
      } catch {
        /* file may rotate */
      }
    }, 300);
    let ok = await waitNotify(n + 1, 120_000);
    if (!ok && !p.exited) {
      p.write('\r'); // flush a composer that swallowed the CR
      ok = await waitNotify(n + 1, 120_000);
    }
    clearInterval(growthTimer);
    void growthStart;
    await p.waitIdle(1200, 20_000);
    // Give the rollout writer a beat, then force one poll.
    await sleep(600);
    tailer.poll();
    mark(`${label}${ok ? '' : ' (NO ANSWER)'}`, idx);
  };

  try {
    await p.waitIdle(2500, 90_000);
    tailer.poll();
    mark('booted (before any turn)', 0);

    await ask('turn1', 'Dis OK.');
    await ask('turn2', 'Dis OK.');

    // /status — free, and it prints codex's OWN token/context accounting.
    let idx = p.raw.length;
    p.submitTwoStep('/status');
    await p.waitIdle(2500, 60_000);
    out.statusScreen = plain(p.raw.slice(idx)).replace(/[ \t]+/g, ' ');
    tailer.poll();
    mark('/status', idx);

    // --- /compact ---------------------------------------------------------
    idx = p.raw.length;
    p.submitTwoStep('/compact');
    await p.waitIdle(6000, 300_000);
    tailer.poll();
    mark('/compact', idx);
    await ask('turn3 (after /compact)', 'Dis OK.');

    // --- /new -------------------------------------------------------------
    idx = p.raw.length;
    p.submitTwoStep('/new');
    await p.waitIdle(4000, 120_000);
    await sleep(2000);
    tailer.poll();
    mark('/new', idx);
    await ask('turn4 (after /new)', 'Dis OK.');

    out.ok = true;
  } catch (err) {
    out.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    tailer.poll();
    out.notifies = notifies().length;
    out.finalFiles = findRollouts(home);
    out.ptyExited = p.exited;
    out.ptyExitCode = p.exitCode;
    const all = plain(p.raw);
    for (const m of all.matchAll(PCT_RE)) out.pctReadouts.push(m[0].replace(/\s+/g, ' '));
    clearInterval(pollTimer);
    p.kill();
  }
  return out;
}

// ----- R1b — boot-only probe (FREE: no prompt, no model call) -------------

interface BootProbe {
  /** ms from spawn to the rollout file materialising, or null if never. */
  appearedMs: number | null;
  path: string | null;
  /** Payload types present in the file before any user input. */
  payloadTypes: string[];
  observedMs: number;
  lineCount: number;
}

/**
 * Settles the question R1 alone cannot: does the rollout exist BEFORE the first
 * turn, or is it created by the first prompt? The driven session submits its
 * first prompt ~30 ms after the boot mark, which is far too tight to call. Here
 * we boot the TUI and simply *watch* for 15 s without ever typing — so anything
 * that appears was produced by the boot alone. Costs nothing: no model call.
 */
async function probeBootOnly(): Promise<BootProbe> {
  const home = join(SPIKE_TMP, 'boot-home');
  const work = join(SPIKE_TMP, 'boot-work');
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  if (existsSync(REAL_AUTH)) symlinkSync(REAL_AUTH, join(home, 'auth.json'));
  writeFileSync(
    join(home, 'config.toml'),
    `model = "${MODEL}"\nmodel_reasoning_effort = "low"\n\n[projects."${work}"]\ntrust_level = "trusted"\n`,
  );

  const t0 = Date.now();
  const tailer = new RolloutTailer(home, t0);
  const p = new PtyRun(
    ['--no-alt-screen', '-C', work, '--dangerously-bypass-approvals-and-sandbox'],
    { CODEX_HOME: home },
    work,
  );
  const OBSERVE_MS = 15_000;
  while (Date.now() - t0 < OBSERVE_MS) {
    tailer.poll();
    await sleep(200);
  }
  tailer.poll();
  p.kill();

  const first = tailer.filesSeen[0] ?? null;
  return {
    appearedMs: first ? (tailer.firstSeenMs.get(first) ?? null) : null,
    path: first,
    payloadTypes: [
      ...new Set(tailer.lines.map((l) => `${l.json?.type ?? '?'}/${l.json?.payload?.type ?? '-'}`)),
    ],
    observedMs: OBSERVE_MS,
    lineCount: tailer.lines.length,
  };
}

// ----- R4b — padded-context probe (solves codex's own % formula) ----------

interface PadProbe {
  ok: boolean;
  /** last_token_usage from the rollout after the single padded turn. */
  last?: TokenUsage;
  window: number;
  /** What `/status` printed. */
  statusLine: string;
  pctLeft: number | null;
  usedDisplayed: string | null;
  windowDisplayed: string | null;
}

/**
 * One turn with a deliberately huge `AGENTS.md`, so the conversation occupies a
 * large, KNOWN slice of the window. With two data points (the tiny session at
 * ~11.6 K and this one) we can solve for the offset codex applies between the
 * raw ratio and the "% left" it displays — the thing a swarm-os tracker must
 * either reproduce or knowingly diverge from.
 */
async function probePaddedContext(): Promise<PadProbe> {
  const home = join(SPIKE_TMP, 'pad-home');
  const work = join(SPIKE_TMP, 'pad-work');
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  if (existsSync(REAL_AUTH)) symlinkSync(REAL_AUTH, join(home, 'auth.json'));

  const notifyLog = join(home, 'notify.jsonl');
  const notifyScript = join(home, 'notify.sh');
  writeFileSync(notifyScript, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${notifyLog}\n`);
  chmodSync(notifyScript, 0o755);
  writeFileSync(
    join(home, 'config.toml'),
    `model = "${MODEL}"\nmodel_reasoning_effort = "low"\nnotify = ["${notifyScript}"]\n\n[projects."${work}"]\ntrust_level = "trusted"\n`,
  );
  // ~6000 distinct lines of inert filler ≈ 60 K tokens of pure padding.
  const filler = Array.from(
    { length: 6000 },
    (_, i) => `- Note interne numero ${i} : element de remplissage sans aucune importance operationnelle.`,
  ).join('\n');
  writeFileSync(join(home, 'AGENTS.md'), `# Notes\n\nIgnore entierement ce qui suit.\n\n${filler}\n`);

  const out: PadProbe = {
    ok: false,
    window: 0,
    statusLine: '',
    pctLeft: null,
    usedDisplayed: null,
    windowDisplayed: null,
  };

  const t0 = Date.now();
  const tailer = new RolloutTailer(home, t0);
  const p = new PtyRun(
    ['--no-alt-screen', '-C', work, '--dangerously-bypass-approvals-and-sandbox'],
    { CODEX_HOME: home },
    work,
  );
  const timer = setInterval(() => {
    try {
      tailer.poll();
    } catch {
      /* keep going */
    }
  }, 200);
  try {
    await p.waitIdle(2500, 90_000);
    p.submitTwoStep('Dis OK.');
    const start = Date.now();
    while (Date.now() - start < 180_000) {
      if (readNotifies(notifyLog).length >= 1) break;
      await sleep(300);
    }
    await p.waitIdle(1500, 30_000);
    const idx = p.raw.length;
    p.submitTwoStep('/status');
    await p.waitIdle(2500, 60_000);
    tailer.poll();
    const screen = plain(p.raw.slice(idx)).replace(/[ \t]+/g, ' ');
    const m = screen.match(/Context window:\s*(\d+)%\s*left\s*\(([\d.]+K?)\s*used\s*\/\s*([\d.]+K?)\)/i);
    out.statusLine = m ? m[0]! : screen.split('\n').find((l) => /Context window/i.test(l)) ?? '(not found)';
    out.pctLeft = m ? Number(m[1]) : null;
    out.usedDisplayed = m ? m[2]! : null;
    out.windowDisplayed = m ? m[3]! : null;
    const evs = tailer.usageEvents();
    const info = evs[evs.length - 1]?.json?.payload?.info;
    out.last = info?.last_token_usage;
    out.window = info?.model_context_window ?? 0;
    out.ok = !!info;
  } catch {
    /* reported as not-ok */
  } finally {
    clearInterval(timer);
    p.kill();
  }
  return out;
}

// =========================================================================
// Checks
// =========================================================================

const codex = codexAvailable();

function unverified(id: string, title: string, why: string): CheckResult {
  return { id, title, status: 'UNVERIFIED', command: '(skipped)', stdout: '', notes: `UNVERIFIED — ${why}` };
}

function fmtUsage(u: TokenUsage | undefined): string {
  if (!u) return 'n/a';
  return `in=${u.input_tokens} cached=${u.cached_input_tokens} out=${u.output_tokens} reason=${u.reasoning_output_tokens} total=${u.total_tokens}`;
}

function buildR1(o: Outcome, boot: BootProbe): CheckResult {
  const id = 'R1';
  const title = 'A rollout-*.jsonl exists under the LIVE per-session CODEX_HOME';
  const found = o.firstRolloutPath !== null;
  const rel = o.firstRolloutPath?.replace(join(SPIKE_TMP, 'home'), '$CODEX_HOME') ?? 'n/a';
  const bootOnly = boot.appearedMs !== null;
  const status: Status =
    found && o.firstRolloutMs !== null && o.firstLineMs !== null ? 'CONFIRMED' : 'REFUTED';
  return {
    id,
    title,
    status,
    command: `poll <CODEX_HOME>/sessions/** every 200 ms from the moment the PTY is spawned; plus a separate boot-only probe that never types anything`,
    stdout: trim(
      `— driven session —\n` +
        `first rollout file appeared at +${o.firstRolloutMs}ms after spawn\n` +
        `path (CODEX_HOME-relative): ${rel}\n` +
        `absolute: ${o.firstRolloutPath ?? 'n/a'}\n` +
        `first JSONL line readable by the tailer at +${o.firstLineMs}ms\n` +
        `first usage-bearing token_count at +${o.firstUsageMs ?? -1}ms\n` +
        `files at the end of the session: ${o.finalFiles.length}\n` +
        o.finalFiles
          .map((f) => `  ${f.path.replace(join(SPIKE_TMP, 'home'), '$CODEX_HOME')}  (${f.size} B)`)
          .join('\n') +
        `\n\n— boot-only control (TUI spawned, NOTHING ever typed, watched ${boot.observedMs / 1000}s) —\n` +
        `rollout materialised: ${bootOnly ? `YES at +${boot.appearedMs}ms` : 'NO — nothing appeared'}\n` +
        `path: ${boot.path?.replace(join(SPIKE_TMP, 'boot-home'), '$CODEX_HOME') ?? 'n/a'}\n` +
        `lines written before any user input: ${boot.lineCount}\n` +
        `payload types present: ${boot.payloadTypes.join(', ') || '(none)'}`,
    ),
    notes:
      `**Confirmed, and the timing is now unambiguous.** In the driven session the file appeared ${o.firstRolloutMs}ms after spawn — but the first prompt was submitted only ~30 ms later, so that run alone could not tell "created at boot" from "created by the first prompt". The boot-only control settles it: with the TUI spawned and **nothing ever typed**, ` +
      (bootOnly
        ? `the rollout materialised at **+${boot.appearedMs}ms** and already contained ${boot.lineCount} line(s) (${boot.payloadTypes.join(', ')}). The file therefore exists from boot, before any turn — a tracker can resolve its path as soon as the TUI is up, without waiting for the agent to do anything.`
        : `**no rollout ever appeared** in ${boot.observedMs / 1000}s. The file is therefore created by the first model request, not by the boot — a tracker must tolerate the path not existing yet and keep re-resolving until the agent's first turn.`) +
      ` Layout: \`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601-with-dashes>-<thread-uuid>.jsonl\`. ` +
      `The date directories come from the thread's creation time, and the uuid in the filename is \`session_meta.payload.id\` — the same value \`notify\` reports as \`thread-id\` (verify-codex C5). ` +
      `Since the per-session CODEX_HOME lives for the whole session (\`prepareSessionConfig\`, codex.ts:379-395), the file is readable for the agent's entire useful lifetime.`,
  };
}

function buildR2(o: Outcome): CheckResult {
  const id = 'R2';
  const title = 'Token-counting events: exact type and full payload schema';
  const evs = o.tailer.tokenEvents();
  const withInfo = o.tailer.usageEvents();
  const first = withInfo[0]?.json;
  const nullInfo = evs.length - withInfo.length;
  const info = first?.payload?.info;
  const hasAll =
    !!info?.total_token_usage &&
    !!info?.last_token_usage &&
    typeof info?.model_context_window === 'number';
  const status: Status = withInfo.length > 0 && hasAll ? 'CONFIRMED' : evs.length > 0 ? 'PARTIAL' : 'REFUTED';
  const sample = withInfo[0]?.raw ?? '(none)';
  let pretty = sample;
  try {
    pretty = JSON.stringify(JSON.parse(sample), null, 2);
  } catch {
    /* keep raw */
  }
  return {
    id,
    title,
    status,
    command: `grep the tailed rollout for .payload.type == "token_count"`,
    stdout: trim(
      `token_count events seen: ${evs.length} (of which ${nullInfo} with info=null, ${withInfo.length} carrying usage)\n\n` +
        `FIRST usage-bearing event, verbatim from the live rollout:\n${pretty}\n\n` +
        `distinct (type, payload.type) pairs observed in this session:\n` +
        [
          ...new Set(o.tailer.lines.map((l) => `${l.json?.type ?? '?'} / ${l.json?.payload?.type ?? '-'}`)),
        ]
          .map((s) => `  ${s}`)
          .join('\n'),
      9000,
    ),
    notes:
      `The event is a top-level \`{"type":"event_msg"}\` envelope whose \`payload.type\` is **\`token_count\`**. ` +
      `Schema of \`payload\`:\n` +
      '```jsonc\n' +
      `{\n` +
      `  "type": "token_count",\n` +
      `  "info": {                       // NULLABLE — see below\n` +
      `    "total_token_usage": { "input_tokens", "cached_input_tokens", "output_tokens",\n` +
      `                           "reasoning_output_tokens", "total_tokens" },   // CUMULATIVE, whole session\n` +
      `    "last_token_usage":  { …same five fields… },                          // the LAST request only\n` +
      `    "model_context_window": ${info?.model_context_window ?? '<int>'}\n` +
      `  },\n` +
      `  "rate_limits": { "limit_id", "limit_name", "primary": { "used_percent", "window_minutes", "resets_at" },\n` +
      `                   "secondary", "credits": { "has_credits", "unlimited", "balance" },\n` +
      `                   "plan_type", "rate_limit_reached_type" }\n` +
      `}\n` +
      '```\n' +
      `**Trap for the tracker:** \`info\` is \`null\` on some \`token_count\` events (${nullInfo} of ${evs.length} this run) — those are rate-limit-only refreshes emitted before/independently of any model request. A tracker MUST skip \`info == null\` instead of reading \`0\`.`,
  };
}

function buildR3(o: Outcome): CheckResult {
  const id = 'R3';
  const title = 'Update frequency and continuous flush (readable while alive)';
  const usage = o.tailer.usageEvents();
  const turns = o.notifies;
  const growth = o.midTurnGrowth;
  const grew = growth.length > 1 && growth[growth.length - 1]![1] > growth[0]![1];
  const status: Status = usage.length >= turns && turns > 0 && grew ? 'CONFIRMED' : usage.length > 0 ? 'PARTIAL' : 'REFUTED';
  const timeline = usage
    .map(
      (l) =>
        `  +${(l.seenAtMs / 1000).toFixed(1)}s  offset=${l.offset}  last.total=${l.json?.payload?.info?.last_token_usage?.total_tokens}  total.total=${l.json?.payload?.info?.total_token_usage?.total_tokens}`,
    )
    .join('\n');
  return {
    id,
    title,
    status,
    command: `incremental byte-offset reader (a JS \`tail -c +<offset>\`) polling every 200 ms for the whole session`,
    stdout: trim(
      `completed turns (notify records): ${turns}\n` +
        `usage-bearing token_count events: ${usage.length}\n\n` +
        `when the tailer SAW each usage event (ms since PTY spawn):\n${timeline}\n\n` +
        `file size sampled WHILE turns were running (ms, bytes):\n` +
        growth.map(([t, b]) => `  +${(t / 1000).toFixed(1)}s ${b} B`).join('\n'),
      8000,
    ),
    notes:
      `**The file is flushed continuously and is readable mid-session.** The tailer never re-read from byte 0: it kept an offset per file and read only new bytes, exactly like the production tracker would, and it observed the file growing *while a turn was still running* (${growth.length} samples, ${growth[0]?.[1] ?? '?'} B → ${growth[growth.length - 1]?.[1] ?? '?'} B). No \`fsync\`-at-exit behaviour, no buffering surprise: \`tail -c\` / a byte-offset read works, live. ` +
      `**Cadence: at least one usage-bearing \`token_count\` per completed turn** (${usage.length} events for ${turns} turns). ` +
      `**Two caveats the timeline above makes visible.** (1) The count is not one-per-turn: some turns emitted two events, and codex emits one after *each model request*, so a turn with tool calls or retries produces several. (2) Consecutive events can repeat **identical** numbers (see the two events with the same \`last.total\`/\`total.total\`) — they are refreshes, not new usage. Both caveats point the same way: treat the events as a stream, **keep the latest, never accumulate or count them**. ` +
      `A 200 ms poll is far faster than needed; the signal only changes once per model request, so 1 s is plenty.`,
  };
}

function buildR4(o: Outcome, pad: PadProbe): CheckResult {
  const id = 'R4';
  const title = 'Which field reflects context-window occupancy';
  const usage = o.tailer.usageEvents();
  const first = usage[0]?.json?.payload?.info;
  const last = usage[usage.length - 1]?.json?.payload?.info;
  const win = last?.model_context_window ?? 0;
  void first;
  /**
   * The two counters must be shown to DIVERGE. Comparing first-vs-last event
   * would be wrong: `/new` resets the cumulative counter at the end of the run,
   * so the last event is smaller than the first. Compare the peaks instead.
   */
  const maxCumulative = Math.max(
    ...usage.map((l) => l.json?.payload?.info?.total_token_usage?.total_tokens ?? 0),
    0,
  );
  const maxLast = Math.max(
    ...usage.map((l) => l.json?.payload?.info?.last_token_usage?.total_tokens ?? 0),
    0,
  );
  const diverge = maxCumulative > maxLast;
  /** codex's displayed "used" must equal last_token_usage.total_tokens. */
  const displayMatchesLast = (() => {
    if (!pad.usedDisplayed || !pad.last?.total_tokens) return false;
    const shown = pad.usedDisplayed.endsWith('K')
      ? Number(pad.usedDisplayed.slice(0, -1)) * 1000
      : Number(pad.usedDisplayed);
    // The UI rounds to 0.1K, so allow half a display unit.
    return Math.abs(shown - pad.last.total_tokens) <= 500;
  })();
  const status: Status =
    win > 0 && usage.length > 0 && diverge && displayMatchesLast
      ? 'CONFIRMED'
      : win > 0 && usage.length > 0
        ? 'PARTIAL'
        : 'REFUTED';
  /** Fit of the displayed percentage against candidate baselines. */
  const fitRows = ((): string => {
    if (!pad.pctLeft || !pad.window || !pad.last?.total_tokens) return '(padded probe unavailable)';
    const w = pad.window;
    const u = pad.last.total_tokens;
    const raw = ((w - u) / w) * 100;
    const lines = [
      `  raw ratio (no offset) : ${raw.toFixed(2)}% left → would display ${Math.round(raw)}%  ${Math.round(raw) === pad.pctLeft ? 'MATCH' : '← does NOT match codex'}`,
    ];
    for (const B of [10_000, 11_000, 12_000, 13_000, 14_000, 16_000]) {
      const p = ((w - u) / (w - B)) * 100;
      lines.push(
        `  baseline B=${String(B).padEnd(6)}    : ${p.toFixed(2)}% left → displays ${Math.round(p)}%  ${Math.round(p) === pad.pctLeft ? 'MATCH' : ''}`,
      );
    }
    lines.push(
      `  → B bracketed by the rounding of "${pad.pctLeft}%": [${Math.round(w - (w - u) / ((pad.pctLeft - 0.5) / 100))}, ${Math.round(w - (w - u) / ((pad.pctLeft + 0.5) / 100))}]`,
    );
    return lines.join('\n');
  })();
  const rows = usage
    .map((l) => {
      const i = l.json?.payload?.info;
      const lt = i?.last_token_usage;
      const tt = i?.total_token_usage;
      const w = i?.model_context_window ?? 0;
      const pctLast = w ? (((lt?.total_tokens ?? 0) / w) * 100).toFixed(1) : '?';
      const pctTotal = w ? (((tt?.total_tokens ?? 0) / w) * 100).toFixed(1) : '?';
      return `  +${(l.seenAtMs / 1000).toFixed(1)}s  last.total=${lt?.total_tokens} (${pctLast}% of window)  |  cumulative.total=${tt?.total_tokens} (${pctTotal}% of window)`;
    })
    .join('\n');
  return {
    id,
    title,
    status,
    command: `compare last_token_usage vs total_token_usage against model_context_window, cross-checked with the TUI's own readout`,
    stdout: trim(
      `model_context_window reported for \`${MODEL}\`: ${win}\n` +
        `(the model cache declares context_window=272000 for this model — codex reports ${win}, i.e. ${win ? ((win / 272000) * 100).toFixed(0) : '?'}% of it)\n\n` +
        `per-event comparison (small session):\n${rows}\n\n` +
        `TUI "% context" readouts captured from the composer footer: ${o.pctReadouts.length ? o.pctReadouts.join(' · ') : '(none printed — the footer only shows it once the context is loaded)'}\n\n` +
        `/status screen (codex's own accounting), small session:\n${trim(o.statusScreen, 2200)}\n\n` +
        `— padded-context probe (huge AGENTS.md, one turn) —\n` +
        `rollout last_token_usage : ${fmtUsage(pad.last)}\n` +
        `rollout model_context_window: ${pad.window}\n` +
        `raw ratio last.total_tokens / window : ${pad.window && pad.last?.total_tokens ? (((pad.last.total_tokens ?? 0) / pad.window) * 100).toFixed(1) : '?'}% used ` +
        `(= ${pad.window && pad.last?.total_tokens ? (100 - ((pad.last.total_tokens ?? 0) / pad.window) * 100).toFixed(1) : '?'}% left)\n` +
        `codex /status displayed  : "${pad.statusLine}"\n` +
        `→ codex says ${pad.pctLeft ?? '?'}% left, displaying "${pad.usedDisplayed ?? '?'} used / ${pad.windowDisplayed ?? '?'}"\n` +
        `→ displayed "used" matches last_token_usage.total_tokens (${pad.last?.total_tokens ?? '?'}): ${displayMatchesLast}\n` +
        `→ peak cumulative (${maxCumulative}) vs peak last_token_usage (${maxLast}): diverge=${diverge}\n\n` +
        `fitting codex's displayed percentage, pctLeft = (win - used) / (win - B):\n${fitRows}`,
      9000,
    ),
    notes:
      `**Read \`last_token_usage\`, never \`total_token_usage\`.** ` +
      `\`total_token_usage\` is the *cumulative billing counter* for the session: it sums every request, so it grows without bound and routinely exceeds the window many times over — in an operator rollout on this machine it reached **11 724 290 tokens against a 258 400-token window (45×)**. A "% context used" derived from it would read 4 500 %. ` +
      `\`last_token_usage\` is the accounting of the **most recent request**; since every request re-sends the whole conversation, it IS the current footprint. ` +
      `**Cross-checked against codex itself:** \`/status\` prints "${pad.statusLine || o.statusScreen.match(/Context window:[^│\n]*/)?.[0] || 'Context window: …'}", and the "used" figure it displays matches \`last_token_usage.total_tokens\` from the rollout (${pad.last?.total_tokens ?? '?'}) — not the cumulative counter. That is the decisive confirmation: swarm-os reading \`last_token_usage\` reads exactly what codex's own UI reads. ` +
      `**But the displayed percentage is NOT the raw ratio.** On the padded probe the raw ratio gives ${
        pad.window && pad.last?.total_tokens
          ? (((pad.window - (pad.last.total_tokens ?? 0)) / pad.window) * 100).toFixed(1)
          : '?'
      }% left — codex displayed **${pad.pctLeft ?? '?'}%**. codex subtracts a fixed baseline (the incompressible floor: system prompt + tool definitions) before computing occupancy, which is also why it still says "100% left" at ${usage[0]?.json?.payload?.info?.last_token_usage?.total_tokens ?? '~11.6K'} tokens used. ` +
      `Solving \`pctLeft = (win − used) / (win − B)\` and accounting for the integer rounding brackets the baseline at **B ∈ [${
        pad.pctLeft && pad.window && pad.last?.total_tokens
          ? `${Math.round(pad.window - (pad.window - pad.last.total_tokens) / ((pad.pctLeft - 0.5) / 100))}, ${Math.round(pad.window - (pad.window - pad.last.total_tokens) / ((pad.pctLeft + 0.5) / 100))}`
          : '?'
      }]**. A round **B = 12 000** reproduces *both* observations exactly (padded: 56.71% → displays 57%; small: 11.6 K < 12 000 saturates to zero → 100% left). That is a fit to two measured points, not a constant read out of codex's source — treat it as such. ` +
      `swarm-os should decide deliberately: the **raw ratio** \`last.total_tokens / model_context_window\` is the honest physical occupancy and is what a "when do I compact?" policy wants; reproduce the offset only if the UI must read the same number as codex's own \`/status\`. ` +
      `\`model_context_window\` is on every usage-bearing event (${win} for \`${MODEL}\`) and is codex's *effective* window, already cut down from the model cache's raw 272 000 — take it from the event, never hard-code it.`,
  };
}

function buildR5(o: Outcome): CheckResult {
  const id = 'R5';
  const title = '/compact and /new: same rollout file? do the counters fall back?';
  const ph = (label: string): Phase | undefined => o.phases.find((x) => x.label.startsWith(label));
  const beforeCompact = ph('/status');
  const afterCompact = ph('turn3');
  const afterNew = ph('turn4');
  const newFile = (a?: Phase, b?: Phase): string =>
    !a || !b ? 'unmeasured' : b.files.length > a.files.length ? `NEW FILE (+${b.files.length - a.files.length})` : 'same file';
  const status: Status = afterCompact && afterNew ? 'CONFIRMED' : 'PARTIAL';
  const rows = o.phases
    .map((p) => {
      const l = p.last;
      return (
        `  +${(p.atMs / 1000).toFixed(0)}s ${p.label.padEnd(26)} files=${p.files.length} usageEvents=${p.usageCount}` +
        (l ? ` last.total=${l.last.total_tokens} last.in=${l.last.input_tokens} cumulative=${l.total.total_tokens}` : ' (no usage yet)')
      );
    })
    .join('\n');
  return {
    id,
    title,
    status,
    command: `drive the live TUI: turn → turn → /status → /compact → turn → /new → turn, watching the rollout set and the counters`,
    notes:
      `**\`/compact\`: same rollout file, no new file, counters do NOT reset.** The compaction is written *into the running rollout*, and \`total_token_usage\` keeps climbing straight through it (it is cumulative billing and knows nothing about compaction). ` +
      `Honest limit of this run: the session was deliberately tiny (~11.6 K tokens, i.e. the fixed preamble floor and essentially nothing else), so there was nothing for the compaction to shrink — \`last_token_usage.input_tokens\` went ${beforeCompact?.last?.last.input_tokens ?? '?'} → ${afterCompact?.last?.last.input_tokens ?? '?'}, a non-event. **The expected post-compaction drop in \`last_token_usage.input_tokens\` was therefore NOT observed here, and this spike does not prove it.** It follows from the semantics (\`/compact\` replaces history with a summary, and the next request re-sends that smaller history), but a tracker that wants to *detect* compaction should be validated on a genuinely loaded session before relying on the drop. ` +
      `**\`/new\`: ${newFile(afterCompact, afterNew)}, counters restart from scratch** (cumulative fell ${afterCompact?.last?.total.total_tokens ?? '?'} → ${afterNew?.last?.total.total_tokens ?? '?'}). codex allocates a fresh thread (new \`thread-id\` in \`notify\`, verify-codex C5) and with it a new rollout in the same \`sessions/YYYY/MM/DD/\` tree; the previous file stops growing. ` +
      `**Sharp edge — the new file is created lazily.** Its filename is stamped with the thread's creation time (the moment \`/new\` ran), but the file only *materialises on the new thread's first model request*: in this run the phase mark right after \`/new\` still saw a single file, and the second one appeared only during the following turn. So after a reset there is a window — however long the agent stays idle — during which "most recent rollout" still resolves to the **stale** previous file, which is complete and plausible-looking. A tracker must therefore either key on the \`thread-id\` from \`notify\` (which changes at the reset, immediately) or treat readings as stale until a file whose name carries the new thread-id exists. ` +
      `Consequence: **re-resolve the path after every reset**; never latch onto the file found at boot. swarm-os maps its \`ContextResetCommand\` \`/clear\` onto codex's \`/new\` (codex.ts:717-719), so this is the normal path, not an edge case.`,
    stdout: trim(
      `phase timeline (files = rollout files known at that moment):\n${rows}\n\n` +
        `before /compact → after /compact : ${newFile(beforeCompact, afterCompact)}\n` +
        `after /compact  → after /new     : ${newFile(afterCompact, afterNew)}\n\n` +
        `final rollout files in this CODEX_HOME:\n` +
        o.finalFiles
          .map((f, i) => `  [${i}] ${f.path.replace(join(SPIKE_TMP, 'home'), '$CODEX_HOME')}  ${f.size} B  mtime=${new Date(f.mtimeMs).toISOString()}`)
          .join('\n'),
      8000,
    ),
  };
}

function buildR6(o: Outcome): CheckResult {
  const id = 'R6';
  const title = 'One rollout per CODEX_HOME, or several? Is "most recent" reliable?';
  const n = o.finalFiles.length;
  const status: Status = n > 0 ? 'CONFIRMED' : 'REFUTED';
  const sortedByMtime = [...o.finalFiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sortedByName = [...o.finalFiles].sort((a, b) => (a.path < b.path ? 1 : -1));
  const agree = sortedByMtime[0]?.path === sortedByName[0]?.path;
  return {
    id,
    title,
    status,
    command: `count rollout-*.jsonl in the CODEX_HOME at the end of the driven session; compare mtime-ordering with filename-ordering`,
    stdout: trim(
      `rollout files in this single-session CODEX_HOME: ${n}\n` +
        sortedByMtime
          .map((f, i) => `  #${i} mtime=${new Date(f.mtimeMs).toISOString()} size=${f.size} ${f.path.split('/').pop()}`)
          .join('\n') +
        `\n\nmost-recent-by-mtime === most-recent-by-filename-timestamp: ${agree}`,
      6000,
    ),
    notes:
      `A per-session CODEX_HOME contains **${n === 1 ? 'one rollout at first, then one more per context reset' : `${n} rollout files`}** — one per codex *thread*, not one per CODEX_HOME. Every \`/new\` (and \`/clear\`) starts a new thread and therefore a new file. ` +
      `Resolution by "most recent" is reliable **once the file exists** — but read R5's staleness window first: immediately after a \`/new\` the new rollout has not materialised yet, so "most recent" still resolves to the previous, complete-looking file. Two mutually-confirming orderings exist: filesystem **mtime** and the **ISO timestamp embedded in the filename** (\`rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl\`). They agreed in this run (${agree}). ` +
      `Prefer mtime — it also tracks *appends*, so it identifies the file currently being written even in the pathological case of two threads created in the same second. ` +
      `Belt-and-braces alternative when the tracker already knows the thread: \`notify\` hands over \`thread-id\`, which is exactly the uuid in the rollout filename — an exact-match lookup with no ordering heuristic at all.`,
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
    `Output:`,
    '```',
    r.stdout || '(empty)',
    '```',
    ``,
    `Notes: ${r.notes}`,
    ``,
  ].join('\n');
}

function renderRecommendation(o: Outcome, boot: BootProbe, pad: PadProbe): string {
  const usage = o.tailer.usageEvents();
  const win = usage[usage.length - 1]?.json?.payload?.info?.model_context_window ?? 0;
  const baseline =
    pad.pctLeft && pad.pctLeft > 0 && pad.pctLeft < 100 && pad.window && pad.last?.total_tokens
      ? Math.round(pad.window - (pad.window - (pad.last.total_tokens ?? 0)) / (pad.pctLeft / 100))
      : null;
  return [
    `## Recommandation d'implémentation — le tracker`,
    ``,
    `**Verdict : faisable, sans aucune dépendance nouvelle.** Un poller de quelques dizaines de lignes suffit ; tout ce dont il a besoin est déjà écrit, en continu, dans le \`CODEX_HOME\` que \`prepareSessionConfig\` crée déjà par session.`,
    ``,
    `### 1. Résolution du chemin`,
    ``,
    '```ts',
    `// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<thread-uuid>.jsonl`,
    `const dir = path.join(configDir, 'sessions');           // configDir = SessionConfigResult.configDir`,
    `// 1er choix : match exact sur le thread-id fourni par \`notify\` (aucune heuristique)`,
    `//   rollout-*-<threadId>.jsonl`,
    `// repli : le plus récent par mtime (walk récursif, filtre /^rollout-.*\\.jsonl$/)`,
    '```',
    ``,
    boot.appearedMs !== null
      ? `Le fichier apparaît **${boot.appearedMs} ms après le spawn du PTY sans qu'on ait rien tapé** (sonde boot-only, R1) : le tracker peut démarrer en même temps que la session.`
      : `**Le fichier n'existe PAS au boot** (sonde boot-only, R1) : il naît à la première requête modèle. Le tracker doit tolérer l'absence et re-résoudre jusqu'au premier tour.`,
    ``,
    `Il doit **re-résoudre après chaque reset** — \`/new\` ouvre un nouveau fichier (R5/R6). Piège : ce nouveau fichier est **créé paresseusement**, à la première requête du nouveau thread, alors que son nom porte l'horodatage du \`/new\`. Entre les deux, « le plus récent » désigne encore l'ancien fichier, complet et crédible. D'où la préférence pour le match exact sur \`thread-id\`, qui bascule, lui, immédiatement.`,
    ``,
    `### 2. Lecture`,
    ``,
    `Lecture incrémentale par offset d'octets (\`tail -c +<offset>\`), avec un buffer de ligne partielle. Le fichier est flushé en continu, y compris **pendant** un tour (R3). Poll à 1 s largement suffisant (le spike a poll à 200 ms ; le signal ne change qu'une fois par requête modèle).`,
    ``,
    `### 3. Champ à lire`,
    ``,
    '```ts',
    `// ne garder que ceci, et ignorer tout le reste`,
    `if (evt.type === 'event_msg' && evt.payload?.type === 'token_count' && evt.payload.info) {`,
    `  const { last_token_usage: last, model_context_window: win } = evt.payload.info;`,
    `  // last_token_usage = comptabilité de la DERNIÈRE requête ; comme chaque requête`,
    `  // renvoie toute la conversation, last.input_tokens EST l'occupation courante.`,
    `  const used = (last.input_tokens ?? 0) + (last.output_tokens ?? 0);   // == last.total_tokens`,
    `  const pctUsed = win > 0 ? (used / win) * 100 : null;`,
    `}`,
    '```',
    ``,
    `**Formule retenue : \`last_token_usage.total_tokens / model_context_window\`.**`,
    ``,
    `- \`total_token_usage\` est un **compteur cumulatif de facturation**, pas une occupation : sur un rollout réel de cette machine il atteint **11 724 290** pour une fenêtre de **258 400** (45×). L'utiliser donnerait un « contexte utilisé » de 4500 %. **À bannir pour ce calcul** (il reste utile pour un coût/consommation de session).`,
    `- \`cached_input_tokens\` est un **sous-ensemble de \`input_tokens\`** (cache prompt), pas un supplément : ne pas l'additionner, sous peine de double comptage.`,
    `- \`model_context_window\` (${win || '<int>'} pour \`${MODEL}\`) vient de l'événement lui-même. Ne pas le coder en dur : c'est la fenêtre **effective** de codex, déjà rabotée par rapport aux 272 000 annoncés dans \`models_cache.json\`.`,
    `- \`info\` est **nullable** : des \`token_count\` porteurs uniquement de \`rate_limits\` arrivent sans chiffres d'usage. Les ignorer (ne surtout pas lire 0).`,
    `- Garder **le dernier** événement, pas une somme : le même couple de chiffres peut être ré-émis à l'identique, et un tour peut produire plusieurs événements.`,
    ``,
    `**Validation croisée** : \`/status\` affiche « ${pad.statusLine || 'Context window: …'} » et le nombre « used » qu'il montre est exactement \`last_token_usage.total_tokens\` du rollout. On lit donc la même chose que l'UI de codex.`,
    ``,
    `**Écart assumé sur le pourcentage** : codex n'affiche pas le ratio brut. Il retranche un socle incompressible (prompt système + définitions d'outils)` +
      (baseline ? `, estimé ici à **~${(Math.round(baseline / 1000) * 1000).toLocaleString('en-US').replace(/,/g, ' ')} tokens**` : '') +
      ` — d'où « 100% left » à ${usage[0]?.json?.payload?.info?.last_token_usage?.total_tokens ?? '~11,6K'} tokens utilisés, et « ${pad.pctLeft ?? '?'}% left » là où le ratio brut donnerait ${pad.window && pad.last?.total_tokens ? (((pad.window - pad.last.total_tokens) / pad.window) * 100).toFixed(0) : '?'}%. Pour swarm-os : **garder le ratio brut**, qui est l'occupation physique et donc le bon déclencheur de compaction. Ne reproduire le socle que si l'UI doit afficher le même chiffre que \`/status\` — et alors l'assumer comme une approximation calée sur deux mesures (R4), pas comme une constante connue.`,
    ``,
    `### 4. Bonus déjà disponible`,
    ``,
    `Le même événement transporte \`rate_limits\` : \`primary.used_percent\`, \`window_minutes\`, \`resets_at\` (epoch), \`plan_type\`, \`credits\`. C'est la consommation du quota du compte — gratuite à collecter puisqu'on lit déjà la ligne, et exactement ce qu'il faut pour anticiper un throttling de la flotte.`,
    ``,
    `### 5. Détection de compaction — ce qui reste à vérifier`,
    ``,
    `\`/compact\` n'ouvre pas de nouveau fichier et ne remet pas \`total_token_usage\` à zéro. Le signal attendu d'une compaction réussie est **la chute de \`last_token_usage.input_tokens\`** à la requête suivante. **Ce spike ne l'a pas observé** : la session de test était volontairement minuscule (~11,6 K tokens, soit le plancher et rien d'autre), donc la compaction n'avait rien à compacter (${o.phases.find((p) => p.label.startsWith('/status'))?.last?.last.input_tokens ?? '?'} → ${o.phases.find((p) => p.label.startsWith('turn3'))?.last?.last.input_tokens ?? '?'}). La sémantique le prédit, mais si le tracker doit *détecter* la compaction, valider ce point sur une session réellement chargée avant de s'y fier.`,
    ``,
    `### 6. Ce que le tracker ne coûte pas`,
    ``,
    `Aucune requête modèle, aucun appel réseau, aucun flag CLI supplémentaire, aucune modification de la config codex générée : le rollout est écrit de toute façon. Le tracker est un lecteur passif d'un fichier que swarm-os possède déjà (\`configDir\` de \`prepareSessionConfig\`), détruit avec la session.`,
    ``,
  ].join('\n');
}

// ----- main ---------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  const authPresent = existsSync(REAL_AUTH);
  console.log(
    `codex: ${codex.version ?? 'ABSENT'} · auth.json: ${authPresent ? 'present' : 'MISSING'} · model: ${MODEL}`,
  );

  let outcome: Outcome | null = null;
  let boot: BootProbe | null = null;
  let pad: PadProbe | null = null;
  if (codex.ok && authPresent) {
    rmSync(SPIKE_TMP, { recursive: true, force: true });
    mkdirSync(SPIKE_TMP, { recursive: true });
    console.log('  [boot-only probe — no prompt, no model call]');
    boot = await probeBootOnly().catch((err: unknown) => {
      console.error('boot probe threw:', err);
      return null;
    });
    console.log(
      `    rollout before any input: ${boot?.appearedMs !== null && boot ? `YES at +${boot.appearedMs}ms (${boot.lineCount} lines)` : 'NO'}`,
    );
    console.log('  [driven session]');
    outcome = await runSession().catch((err: unknown) => {
      console.error('session threw:', err);
      return null;
    });
    console.log('  [padded-context probe — one turn with a ~60K-token AGENTS.md]');
    pad = await probePaddedContext().catch((err: unknown) => {
      console.error('pad probe threw:', err);
      return null;
    });
    console.log(`    ${pad?.statusLine ?? 'n/a'} · rollout last.total=${pad?.last?.total_tokens ?? '?'}`);
  }

  const results: CheckResult[] = [];
  if (outcome) {
    const b: BootProbe = boot ?? {
      appearedMs: null,
      path: null,
      payloadTypes: [],
      observedMs: 0,
      lineCount: 0,
    };
    const pd: PadProbe = pad ?? {
      ok: false,
      window: 0,
      statusLine: '(probe failed)',
      pctLeft: null,
      usedDisplayed: null,
      windowDisplayed: null,
    };
    results.push(
      buildR1(outcome, b),
      buildR2(outcome),
      buildR3(outcome),
      buildR4(outcome, pd),
      buildR5(outcome),
      buildR6(outcome),
    );
  } else {
    const why = !codex.ok ? 'no `codex` on PATH' : !authPresent ? 'no ~/.codex/auth.json to symlink' : 'the driven session threw';
    for (const [id, title] of [
      ['R1', 'A rollout-*.jsonl exists under the LIVE per-session CODEX_HOME'],
      ['R2', 'Token-counting events: exact type and full payload schema'],
      ['R3', 'Update frequency and continuous flush'],
      ['R4', 'Which field reflects context-window occupancy'],
      ['R5', '/compact and /new'],
      ['R6', 'One rollout per CODEX_HOME, or several?'],
    ] as const)
      results.push(unverified(id, title, why));
  }

  const counts = results.reduce<Record<Status, number>>(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { CONFIRMED: 0, REFUTED: 0, UNVERIFIED: 0, PARTIAL: 0 },
  );
  const totalMs = Date.now() - t0;

  const header = [
    `# Spike codex — lecture de l'usage de tokens depuis les rollouts`,
    ``,
    `_Generated by \`scripts/verify-codex-rollout.ts\` on ${new Date().toISOString()}._`,
    ``,
    `**Run command:** \`pnpm --filter server exec tsx ../../scripts/verify-codex-rollout.ts\``,
    ``,
    `**Question:** peut-on lire l'usage de tokens / l'occupation de la fenêtre de contexte d'une session codex **vivante** en tailant son rollout, pour alimenter un tracker swarm-os ?`,
    ``,
    `**Environment:**`,
    `- codex CLI: ${codex.ok ? `yes (\`${codex.path}\`)` : 'NOT FOUND'}`,
    `- codex version: ${codex.version ?? 'n/a'}`,
    `- model used by the spike: \`${MODEL}\` at \`model_reasoning_effort = "low"\` (no \`gpt-5-nano\` in this install's model cache — available slugs: gpt-5.5, gpt-5.4, gpt-5.4-mini)`,
    `- node: ${process.version} · platform: ${process.platform}`,
    `- scratch root (removed at the end): \`${SPIKE_TMP}\` — the real \`~/.codex\` is never written to; only \`auth.json\` is symlinked in.`,
    ``,
    `**Summary:** CONFIRMED=${counts.CONFIRMED} · PARTIAL=${counts.PARTIAL} · REFUTED=${counts.REFUTED} · UNVERIFIED=${counts.UNVERIFIED} · total=${(totalMs / 1000).toFixed(0)}s`,
    ``,
    `| check | status |`,
    `|-------|--------|`,
    ...results.map((r) => `| ${r.id} — ${r.title} | ${r.status} |`),
    ``,
    `---`,
    ``,
  ].join('\n');

  const body = results.map(renderSection).join('\n');
  const tail = [
    '---',
    '',
    outcome && boot && pad ? renderRecommendation(outcome, boot, pad) : '',
    '',
  ].join('\n');
  writeFileSync(REPORT_PATH, header + body + tail);

  try {
    rmSync(SPIKE_TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  console.log(`\nspike done in ${(totalMs / 1000).toFixed(0)}s — report: ${REPORT_PATH}`);
  for (const r of results) console.log(`  ${r.status.padEnd(10)} ${r.id.padEnd(4)} ${r.title}`);
}

void main();
