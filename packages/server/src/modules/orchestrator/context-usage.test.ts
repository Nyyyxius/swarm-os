import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ContextUsageTracker,
  CONTEXT_HISTORY_MAX_POINTS,
  CONTEXT_HISTORY_MAX_RESETS,
  CONTEXT_HISTORY_MAX_SAMPLES,
  CONTEXT_SPARK_POINTS,
  CONTEXT_USAGE_MAX_CONCURRENT_REFRESH,
  createLocalTailReader,
  createSshTailReader,
  downsampleContextHistory,
  evictContextHistory,
  parseContextUsageFromTranscriptTail,
  type ContextUsageSample,
  type TranscriptTailReader,
} from './context-usage.js';
import { Session } from './session.js';
import { Orchestrator } from './index.js';
import { NoOpPersistence } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { Config } from '../../config.js';

/**
 * Monitoring, Lot 2 (docs/monitoring-agents.md) — context usage of a claude
 * session.
 *
 * The contract in one line: a number an operator can trust or a `—`, never a
 * guess, and never at the cost of a request. So the suite is in three parts —
 * the parser (which is where a wrong NUMBER would come from), the tracker
 * (which is where a wrong COST would come from: a read per poll, a stampede of
 * ssh processes, a snapshot that never goes stale) and the session wiring
 * (which is where the number reaches the UI, or must NOT).
 *
 * Every parser fixture below is shaped after the transcript the spike actually
 * captured (`scripts/verify-claude-sessionstart.report.md` §S2), traps included.
 */

// ---------------------------------------------------------------------------
// Transcript fixtures
// ---------------------------------------------------------------------------

function assistantLine(opts: {
  id?: string;
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  sidechain?: boolean;
  usage?: Record<string, unknown> | null;
}): string {
  const usage =
    opts.usage === null
      ? undefined
      : (opts.usage ?? {
          input_tokens: opts.input ?? 0,
          cache_creation_input_tokens: opts.cacheCreation ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          output_tokens: opts.output ?? 0,
        });
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    parentUuid: 'p',
    requestId: 'req_1',
    message: {
      id: opts.id ?? 'msg_1',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hi' }],
      ...(usage ? { usage } : {}),
    },
  });
}

/** The line types the spike observed AFTER the last assistant line. */
const TAIL_NOISE = [
  JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success' } }),
  JSON.stringify({ type: 'queue-operation', op: 'drain' }),
  JSON.stringify({ type: 'last-prompt', prompt: 'hi' }),
];

// ---------------------------------------------------------------------------
// 1. The parser
// ---------------------------------------------------------------------------

describe('parseContextUsageFromTranscriptTail', () => {
  it('sums the four usage fields of the newest assistant line', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      assistantLine({ input: 10, cacheCreation: 0, cacheRead: 20_411, output: 86 }),
    ].join('\n');
    // The exact figure the spike measured, field for field.
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 20_507 });
  });

  it('scans BACKWARDS: the last line of a transcript is almost never assistant', () => {
    // Measured tail: `… assistant, assistant, last-prompt`. A parser reading the
    // final line of the tail finds `last-prompt` and reports nothing, forever.
    const text = [
      assistantLine({ input: 5, cacheRead: 100, output: 20 }),
      ...TAIL_NOISE,
    ].join('\n');
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 125 });
  });

  it('never SUMS two assistant lines that share one message.id', () => {
    // Trap 2 (spike S2): the thinking block and the text block of ONE turn are
    // two lines carrying the SAME `usage` object. Summing reports double the
    // occupancy — and the gauge would cross 100 % on a half-full context.
    const line = assistantLine({ id: 'msg_same', input: 10, cacheRead: 20_000, output: 90 });
    const text = [line, line, ...TAIL_NOISE].join('\n');
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 20_100 });
  });

  it('skips sidechain lines — a sub-agent has its own window', () => {
    const text = [
      assistantLine({ id: 'msg_main', input: 1, cacheRead: 1_000, output: 9 }),
      assistantLine({ id: 'msg_sub', sidechain: true, input: 500_000, output: 500_000 }),
      ...TAIL_NOISE,
    ].join('\n');
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 1_010 });
  });

  it('ignores the partial first line a `tail -c` always produces', () => {
    const whole = assistantLine({ input: 7, cacheRead: 700, output: 3 });
    // A byte-offset read cuts the previous line in half. Its remainder must not
    // parse, must not throw, and must not shadow the good line below it.
    const cut = whole.slice(40);
    const text = [cut, whole, ...TAIL_NOISE].join('\n');
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 710 });
  });

  it('treats missing usage fields as zero rather than as a failure', () => {
    const text = assistantLine({ usage: { input_tokens: 12, output_tokens: 8 } });
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 20 });
  });

  it('ignores junk values in the usage block', () => {
    const text = assistantLine({
      usage: {
        input_tokens: 'lots',
        cache_read_input_tokens: -5,
        cache_creation_input_tokens: null,
        output_tokens: 4,
      },
    });
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 4 });
  });

  it('keeps scanning past an assistant line with no usage at all', () => {
    const text = [
      assistantLine({ id: 'older', input: 3, cacheRead: 30, output: 7 }),
      assistantLine({ id: 'newer', usage: null }),
      ...TAIL_NOISE,
    ].join('\n');
    expect(parseContextUsageFromTranscriptTail(text)).toEqual({ usedTokens: 40 });
  });

  it('answers null when nothing usable is in the tail', () => {
    expect(parseContextUsageFromTranscriptTail('')).toBeNull();
    expect(parseContextUsageFromTranscriptTail('not json\n{"type":"user"}\n')).toBeNull();
    // A transcript freshly rotated by `/clear`: real lines, no turn yet.
    expect(parseContextUsageFromTranscriptTail(TAIL_NOISE.join('\n'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The tail readers
// ---------------------------------------------------------------------------

describe('tail readers', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ctxtail-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads only the END of the file, never the whole thing', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, `${'x'.repeat(1_000)}\nTHE-TAIL`);
    const read = createLocalTailReader();
    return read(file, 8).then((text) => {
      expect(text).toBe('THE-TAIL');
    });
  });

  it('returns the whole file when it is smaller than the cap', async () => {
    const file = path.join(dir, 'small.jsonl');
    fs.writeFileSync(file, 'abc');
    expect(await createLocalTailReader()(file, 4096)).toBe('abc');
  });

  it('answers null — never throws — for a file that is not there', async () => {
    expect(await createLocalTailReader()(path.join(dir, 'gone.jsonl'), 4096)).toBeNull();
  });

  it('refuses a FIFO WITHOUT opening it — open would block forever and leak a refresh slot', async () => {
    // The path comes from an agent-controlled hook payload; open('r') on a
    // FIFO with no writer never settles. The lstat guard must answer null
    // before any open happens.
    const fifo = path.join(dir, 'hostile.fifo');
    execFileSync('mkfifo', [fifo]);
    let opened = false;
    const read = createLocalTailReader({
      openImpl: ((...args: Parameters<typeof fs.promises.open>) => {
        opened = true;
        return fs.promises.open(...args);
      }) as typeof fs.promises.open,
    });
    expect(await read(fifo, 4096)).toBeNull();
    expect(opened).toBe(false);
  });

  it('refuses a symlink in final position — lstat does not follow it', async () => {
    const real = path.join(dir, 'real.jsonl');
    fs.writeFileSync(real, 'abc');
    const link = path.join(dir, 'link.jsonl');
    fs.symlinkSync(real, link);
    expect(await createLocalTailReader()(link, 4096)).toBeNull();
  });

  it('shells out to a bounded `tail -c` over ssh, and swallows its failures', async () => {
    const calls: Array<{ argv: string[]; maxOutputBytes?: number }> = [];
    const config = { agentTransport: 'ssh' } as Config;
    const ok = createSshTailReader(config, {
      hostExec: async (_cfg, input) => {
        calls.push(input as { argv: string[]; maxOutputBytes?: number });
        return { code: 0, stdout: 'remote-tail', stderr: '', timedOut: false };
      },
    });
    expect(await ok('/host/path.jsonl', 65_536)).toBe('remote-tail');
    expect(calls[0]?.argv).toEqual(['tail', '-c', '65536', '/host/path.jsonl']);
    // Headroom over what `tail -c` can return: the capture sink appends a
    // truncation marker at the cap, and it would land inside the last line.
    expect(calls[0]?.maxOutputBytes).toBeGreaterThan(65_536);

    const failing = createSshTailReader(config, {
      hostExec: async () => ({ code: 1, stdout: '', stderr: 'no such file', timedOut: false }),
    });
    expect(await failing('/host/path.jsonl', 65_536)).toBeNull();

    const timingOut = createSshTailReader(config, {
      hostExec: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    });
    expect(await timingOut('/host/path.jsonl', 65_536)).toBeNull();

    const throwing = createSshTailReader(config, {
      hostExec: async () => {
        throw new Error('host-exec requires the ssh agent transport');
      },
    });
    expect(await throwing('/host/path.jsonl', 65_536)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The tracker
// ---------------------------------------------------------------------------

/** A reader whose calls are counted and whose answers are scripted. */
function scriptedReader(answers: Array<string | null>): {
  read: TranscriptTailReader;
  paths: string[];
} {
  const paths: string[] = [];
  let i = 0;
  const read: TranscriptTailReader = async (filePath) => {
    paths.push(filePath);
    const answer = answers[Math.min(i, answers.length - 1)];
    i++;
    return answer ?? null;
  };
  return { read, paths };
}

/** A reader that hangs until the returned `release()` is called. */
function blockingReader(): {
  read: TranscriptTailReader;
  calls: string[];
  release: () => void;
} {
  const calls: string[] = [];
  let unblock: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const read: TranscriptTailReader = async (filePath) => {
    calls.push(filePath);
    await gate;
    return null;
  };
  return { read, calls, release: () => unblock?.() };
}

/** Let the fire-and-forget refresh chain settle (scripted readers: one tick). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

/**
 * Wait for a condition the REAL filesystem reader has to satisfy.
 *
 * A fixed sleep is what a full `vitest run` breaks: 128 files run sequentially
 * on a box that is also hosting live agents, and an open+stat+read+close that
 * takes 2 ms alone can take far longer there. The condition is the assertion's
 * own precondition, so a poll is exact where a sleep is a guess.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TURN = [assistantLine({ input: 10, cacheRead: 90, output: 100 }), ...TAIL_NOISE].join('\n');
const BIGGER_TURN = [
  assistantLine({ id: 'msg_2', input: 10, cacheRead: 390, output: 100 }),
  ...TAIL_NOISE,
].join('\n');

function makeTracker(
  opts: {
    read?: TranscriptTailReader;
    ttlMs?: number;
    limit?: number | null;
    now?: () => number;
  } = {},
): ContextUsageTracker {
  return new ContextUsageTracker({
    sessionId: 'sess-1',
    ttlMs: opts.ttlMs ?? 15_000,
    limitTokens: () => (opts.limit === undefined ? 200_000 : opts.limit),
    readTail: opts.read ?? scriptedReader([TURN]).read,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

describe('ContextUsageTracker — the snapshot', () => {
  it('is null until a turn has actually been read', async () => {
    const tracker = makeTracker();
    expect(tracker.snapshot()).toBeNull();
    // No path yet ⇒ nothing to read, and no attempt made.
    tracker.maybeRefresh();
    await flush();
    expect(tracker.snapshot()).toBeNull();
  });

  it('carries used, limit, pct, basis and freshness once read', async () => {
    const tracker = makeTracker();
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    const snap = tracker.snapshot();
    expect(snap).toMatchObject({
      usedTokens: 200,
      limitTokens: 200_000,
      pct: 0.001,
      basis: 'transcript',
      stale: false,
    });
    expect(Date.parse(snap!.updatedAt)).not.toBeNaN();
  });

  it('reports pct null — never a made-up denominator — without a limit', async () => {
    const tracker = makeTracker({ limit: null });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 200, limitTokens: null, pct: null });
  });

  it('clamps pct at 1 rather than showing 130 %', async () => {
    const tracker = makeTracker({ limit: 100 });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    expect(tracker.snapshot()?.pct).toBe(1);
  });
});

describe('ContextUsageTracker — what bounds the reads', () => {
  it('reads at most once per TTL, clocked from the START of the read', async () => {
    let now = 1_000;
    const { read, paths } = scriptedReader([TURN]);
    const tracker = makeTracker({ read, ttlMs: 15_000, now: () => now });
    tracker.setTranscriptPath('/t.jsonl');

    tracker.maybeRefresh();
    await flush();
    expect(paths).toHaveLength(1);

    // The `/orchestrators` poll is 3 s: four more polls inside one TTL.
    for (let i = 0; i < 4; i++) {
      now += 3_000;
      tracker.maybeRefresh();
      await flush();
    }
    expect(paths).toHaveLength(1);

    now += 4_000; // 16 s after the first read started
    tracker.maybeRefresh();
    await flush();
    expect(paths).toHaveLength(2);
  });

  it('never lets two reads of the same session overlap', async () => {
    const { read, calls, release } = blockingReader();
    const tracker = makeTracker({ read, ttlMs: 0.0001 });
    tracker.setTranscriptPath('/t.jsonl');
    // TTL is effectively nothing: only the in-flight flag can stop the second.
    tracker.maybeRefresh();
    tracker.maybeRefresh();
    tracker.maybeRefresh();
    expect(calls).toHaveLength(1);
    release();
    await flush();
  });

  it('caps concurrent reads module-wide, and the losers retry immediately', async () => {
    // The guard-rail that matters under SSH: one `ssh` process per read, and a
    // 40-agent deployment polls them all on the same 3 s tick.
    const overCap = CONTEXT_USAGE_MAX_CONCURRENT_REFRESH + 2;
    const { read, calls, release } = blockingReader();
    const trackers = Array.from({ length: overCap }, (_, i) => {
      const t = makeTracker({ read, ttlMs: 15_000 });
      t.setTranscriptPath(`/t-${i}.jsonl`);
      return t;
    });
    for (const t of trackers) t.maybeRefresh();
    expect(calls).toHaveLength(CONTEXT_USAGE_MAX_CONCURRENT_REFRESH);

    release();
    await flush();

    // A deferral is not an attempt: the two that lost never stamped their
    // clock, so the very next poll reads instead of waiting out a 15 s TTL.
    for (const t of trackers) t.maybeRefresh();
    await flush();
    expect(calls).toHaveLength(overCap);
  });

  it('reads nothing at all when the TTL knob is 0', async () => {
    const { read, paths } = scriptedReader([TURN]);
    const tracker = makeTracker({ read, ttlMs: 0 });
    tracker.setTranscriptPath('/t.jsonl');
    expect(tracker.enabled).toBe(false);
    tracker.maybeRefresh();
    await flush();
    expect(paths).toEqual([]);
    expect(tracker.snapshot()).toBeNull();
  });
});

describe('ContextUsageTracker — staleness', () => {
  it('keeps the last number and marks it stale when the read fails', async () => {
    let now = 1_000;
    const { read } = scriptedReader([TURN, null]);
    const tracker = makeTracker({ read, now: () => now });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 200, stale: false });

    now += 20_000;
    tracker.maybeRefresh();
    await flush();
    // Not null: an operator watching a gauge blank out learns nothing. The
    // number survives, flagged for what it is.
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 200, stale: true });
  });

  it('marks stale when the transcript holds no turn yet (a fresh /clear)', async () => {
    let now = 1_000;
    const { read } = scriptedReader([TURN, TAIL_NOISE.join('\n')]);
    const tracker = makeTracker({ read, now: () => now });
    tracker.setTranscriptPath('/old.jsonl');
    tracker.maybeRefresh();
    await flush();
    now += 20_000;
    tracker.maybeRefresh();
    await flush();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 200, stale: true });
  });

  it('clears staleness at the first turn read back', async () => {
    let now = 1_000;
    const { read } = scriptedReader([TURN, BIGGER_TURN]);
    const tracker = makeTracker({ read, now: () => now });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    tracker.markStale();
    expect(tracker.snapshot()?.stale).toBe(true);

    now += 20_000;
    tracker.maybeRefresh();
    await flush();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 500, stale: false });
  });

  it('discards a read that was already in flight when the context was reset', async () => {
    // The one race that could report a CONFIDENT WRONG number: the read of the
    // pre-compact tail lands after the reset and would clear `stale` while
    // restating the occupancy of a conversation that has just been thrown away.
    let resolveRead: ((text: string) => void) | null = null;
    const read: TranscriptTailReader = async () =>
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      });
    const tracker = makeTracker({ read });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();

    tracker.markStale();
    resolveRead!(TURN);
    await flush();
    // Nothing committed: no number invented, and the stale flag stands.
    expect(tracker.snapshot()).toBeNull();
  });

  it('markStale() re-opens the TTL — the number is known to be wrong NOW', async () => {
    let now = 1_000;
    const { read, paths } = scriptedReader([TURN, BIGGER_TURN]);
    const tracker = makeTracker({ read, ttlMs: 15_000, now: () => now });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    expect(paths).toHaveLength(1);

    tracker.markStale();
    now += 100; // still deep inside the TTL
    tracker.maybeRefresh();
    await flush();
    expect(paths).toHaveLength(2);
  });
});

describe('ContextUsageTracker — setTranscriptPath', () => {
  it('always adopts the LAST path: /clear rotates the file', async () => {
    // Spike S4: `/clear` hands back a new `session_id` AND a new `.jsonl`; the
    // old one stays on disk, orphaned and frozen. A tracker keeping its
    // boot-time path reports a dead file for the rest of the session's life.
    let now = 1_000;
    const { read, paths } = scriptedReader([TURN, BIGGER_TURN]);
    const tracker = makeTracker({ read, now: () => now });
    tracker.setTranscriptPath('/boot.jsonl');
    tracker.maybeRefresh();
    await flush();
    expect(paths).toEqual(['/boot.jsonl']);

    tracker.setTranscriptPath('/after-clear.jsonl');
    expect(tracker.transcriptPath).toBe('/after-clear.jsonl');
    // The rotation invalidates both the number and the TTL of the old file.
    expect(tracker.snapshot()?.stale).toBe(true);
    now += 10; // well inside the TTL
    tracker.maybeRefresh();
    await flush();
    expect(paths).toEqual(['/boot.jsonl', '/after-clear.jsonl']);
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 500, stale: false });
  });

  it('is a no-op for the same path re-supplied (`/compact` rewrites in place)', async () => {
    const { read } = scriptedReader([TURN]);
    const tracker = makeTracker({ read });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    tracker.setTranscriptPath('/t.jsonl');
    expect(tracker.snapshot()?.stale).toBe(false);
  });

  it('ignores an empty or blank path', () => {
    const tracker = makeTracker();
    tracker.setTranscriptPath('');
    tracker.setTranscriptPath('   ');
    expect(tracker.transcriptPath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The session wiring — where the number reaches the UI, or must not
// ---------------------------------------------------------------------------

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 8788,
    projectName: 'test',
    defaultModel: 'claude-opus-5',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir,
    logsDir,
    mcpRuntimeDir,
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 100,
    idleThresholdMs: 50,
    contextUsageTtlMs: 15_000,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
    ...overrides,
  } as unknown as Config;
}

/**
 * A live team on a fake adapter registered under the id whose sessions we want.
 * `claude` is the only id `setTranscriptPath` accepts, so the gate itself is
 * testable by registering the same fake under another one.
 */
function makeTeam(
  providerId = 'claude',
  configOverrides: Partial<Config> = {},
): { orch: Orchestrator; lead: Session } {
  const config = makeConfig(configOverrides);
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider({ id: providerId }), { builtin: true });
  const orch = new Orchestrator(
    {
      name: 'monitoring',
      role: 'co',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      defaultProvider: providerId,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    config,
    { persistence: new NoOpPersistence(), providerRegistry: registry },
  );
  const lead = orch.start({
    agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot }),
  });
  openSessions.push(lead);
  return { orch, lead };
}

/** A transcript on disk, read through the REAL local reader. */
function writeTranscript(name: string, body: string): string {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, `${body}\n`);
  return file;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ctxusage-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir]) fs.mkdirSync(d, { recursive: true });
  openSessions = [];
});

afterEach(async () => {
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  openSessions = [];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Session + Orchestrator — context usage on the view', () => {
  it('serializes contextUsage for a running session, limit from the pins', async () => {
    // End to end on the real local reader and the real pinned table:
    // `claude-opus-5` → 200 000, which no test double supplies.
    const { orch, lead } = makeTeam();
    lead.setTranscriptPath(writeTranscript('t.jsonl', TURN));
    expect(lead.toView().contextUsage).toBeUndefined();

    // `Orchestrator.toView()` IS the heartbeat — no timer exists anywhere in
    // this feature.
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);

    expect(lead.toView().contextUsage).toMatchObject({
      usedTokens: 200,
      limitTokens: 200_000,
      pct: 0.001,
      basis: 'transcript',
      stale: false,
    });
  });

  it('omits the field entirely once the session is no longer live', async () => {
    // `DbPersistence.writeSession` builds its row from this view: a terminated
    // session's occupancy describes a context that no longer exists, and
    // persisting it would make the map lie after every restart.
    const { orch, lead } = makeTeam();
    lead.setTranscriptPath(writeTranscript('t.jsonl', TURN));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);
    expect(lead.toView().contextUsage).toBeDefined();

    lead.stop('test', 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(lead.status).not.toBe('running');
    expect('contextUsage' in lead.toView()).toBe(false);
  });

  it('tracks nothing for a provider that is not claude', async () => {
    // gemini's hook payload is Claude-Code-compatible and would hand us a path
    // whose `.jsonl` carries no `message.usage` at all. codex and opencode get
    // their own source in Lots 6/7.
    const { orch, lead } = makeTeam('gemini');
    lead.setTranscriptPath(writeTranscript('t.jsonl', TURN));
    orch.toView();
    // A generous window on purpose: this assertion is about something that
    // must NEVER appear, so it may not be satisfied by being early.
    await new Promise((r) => setTimeout(r, 200));
    expect(lead.contextUsage).toBeNull();
    expect('contextUsage' in lead.toView()).toBe(false);
  });

  it('reads nothing when the TTL knob is 0', async () => {
    const { orch, lead } = makeTeam('claude', { contextUsageTtlMs: 0 });
    lead.setTranscriptPath(writeTranscript('t.jsonl', TURN));
    orch.toView();
    await new Promise((r) => setTimeout(r, 200));
    expect(lead.contextUsage).toBeNull();
  });

  it('marks the snapshot stale as soon as a reset reaches the PTY', async () => {
    // NOT when a `SessionStart` comes back: a `/compact` the CLI refuses
    // ("Not enough messages to compact") fires no hook at all (spike S1d), and
    // a gauge waiting on one would stay wrong forever.
    const { orch, lead } = makeTeam();
    lead.setTranscriptPath(writeTranscript('t.jsonl', TURN));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);
    expect(lead.contextUsage?.stale).toBe(false);

    // Fires at the next idle boundary (50 ms here) plus the two-step PTY write.
    orch.requestContextReset(lead.id, '/compact');
    await waitUntil(() => lead.contextUsage?.stale === true);
    expect(lead.contextUsage).toMatchObject({ usedTokens: 200, stale: true });
  });

  it('stops reading once the session is dead', async () => {
    // `listSessions()` keeps terminated sessions for the map. Their transcript
    // is frozen: refreshing it is one file read per dead agent per TTL, for a
    // number the view no longer carries.
    const { orch, lead } = makeTeam();
    const file = writeTranscript('t.jsonl', TURN);
    lead.setTranscriptPath(file);
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);
    expect(lead.contextUsage?.usedTokens).toBe(200);

    lead.stop('test', 0);
    await waitUntil(() => lead.status !== 'running');
    // A bigger turn lands in the same file — a live session would pick it up.
    fs.writeFileSync(file, `${BIGGER_TURN}\n`);
    orch.toView();
    await new Promise((r) => setTimeout(r, 200));
    expect(lead.contextUsage?.usedTokens).toBe(200);
  });

  it('follows the rotated transcript a /clear hands back', async () => {
    const { orch, lead } = makeTeam();
    lead.setTranscriptPath(writeTranscript('boot.jsonl', TURN));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);
    expect(lead.contextUsage?.usedTokens).toBe(200);

    // What the `SessionStart(clear)` hook does through `hooks.ts`.
    lead.setTranscriptPath(writeTranscript('after-clear.jsonl', BIGGER_TURN));
    orch.toView();
    await waitUntil(() => lead.contextUsage?.usedTokens === 500);
    expect(lead.contextUsage).toMatchObject({ usedTokens: 500, stale: false });
  });
});

// ---------------------------------------------------------------------------
// 5. Lot 9 — the rolling history
//
// Three properties matter, and each has its own failure mode:
//   * only ACCEPTED samples land in the ring (an `empty` repeated every 15 s
//     would draw a flat line through a `/clear` that emptied the window);
//   * the ring is bounded twice — by age AND by count — because the TTL is a
//     knob and 72 h at a 1 s TTL is 260 000 points per session;
//   * the downsampler folds with min/max/last, never an average: the whole
//     point of this graph is the cliff a `/compact` leaves behind.
// ---------------------------------------------------------------------------

/** A reader scripted in occupancy terms: a number, no turn yet, or unreadable. */
function occupancyReader(script: Array<number | 'empty' | 'unreadable'>): TranscriptTailReader {
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step === 'unreadable') return null;
    if (step === 'empty') return TAIL_NOISE.join('\n');
    return [
      assistantLine({ id: `msg_${i}`, cacheRead: step ?? 0 }),
      ...TAIL_NOISE,
    ].join('\n');
  };
}

const HOUR_MS = 60 * 60 * 1000;

describe('ContextUsageTracker — the sample ring', () => {
  it('appends only the samples the tracker ACCEPTS', async () => {
    let now = 1_000_000;
    const tracker = makeTracker({
      read: occupancyReader([100, 'empty', 'unreadable', 300]),
      ttlMs: 15_000,
      now: () => now,
    });
    tracker.setTranscriptPath('/t.jsonl');
    for (let i = 0; i < 4; i++) {
      tracker.maybeRefresh();
      await flush();
      now += 15_000;
    }
    // Four reads, two measurements: `empty` and `unreadable` measured nothing
    // and must not put a point on the graph.
    expect(tracker.history().samples.map((s) => s.used)).toEqual([100, 300]);
    expect(tracker.history().samples.map((s) => s.t)).toEqual([1_000_000, 1_045_000]);
  });

  it('carries the limit alongside the samples, even before the first read', () => {
    const tracker = makeTracker();
    expect(tracker.history()).toEqual({ limitTokens: 200_000, samples: [], resets: [] });
    expect(makeTracker({ limit: null }).history().limitTokens).toBeNull();
  });

  it('evicts past 72 h, on append and on read alike', async () => {
    let now = 1_000_000;
    const tracker = makeTracker({
      read: occupancyReader([100, 200, 300]),
      ttlMs: 15_000,
      now: () => now,
    });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    now += 15_000;
    tracker.maybeRefresh();
    await flush();
    expect(tracker.history().samples).toHaveLength(2);

    // Three days later, nothing was appended: the READ has to evict, otherwise
    // an idle session serves a graph of a conversation nobody remembers.
    now += 73 * HOUR_MS;
    expect(tracker.history().samples).toEqual([]);

    // And the next accepted sample starts a fresh ring.
    tracker.maybeRefresh();
    await flush();
    expect(tracker.history().samples.map((s) => s.used)).toEqual([300]);
  });

  it('hands out copies — a caller cannot mutate the rings', async () => {
    const tracker = makeTracker({ read: occupancyReader([100]) });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    const first = tracker.history().samples as ContextUsageSample[];
    first.length = 0;
    expect(tracker.history().samples).toHaveLength(1);
  });
});

describe('evictContextHistory', () => {
  it('drops everything older than the 72 h window, oldest first', () => {
    const now = 100 * HOUR_MS;
    const entries = [
      { t: now - 80 * HOUR_MS, used: 1 },
      { t: now - 73 * HOUR_MS, used: 2 },
      { t: now - 71 * HOUR_MS, used: 3 },
      { t: now, used: 4 },
    ];
    evictContextHistory(entries, now, CONTEXT_HISTORY_MAX_SAMPLES);
    expect(entries.map((e) => e.used)).toEqual([3, 4]);
  });

  it('caps by COUNT too — the TTL is a knob and 72 h of it is unbounded', () => {
    const now = Date.now();
    // A 1 s TTL for three days: every entry is inside the age window, so only
    // the count bound stands between this session and hundreds of thousands of
    // points.
    const entries = Array.from({ length: CONTEXT_HISTORY_MAX_SAMPLES + 100 }, (_, i) => ({
      t: now - (CONTEXT_HISTORY_MAX_SAMPLES + 100 - i) * 1_000,
      used: i,
    }));
    evictContextHistory(entries, now, CONTEXT_HISTORY_MAX_SAMPLES);
    expect(entries).toHaveLength(CONTEXT_HISTORY_MAX_SAMPLES);
    // Drop-OLDEST: the newest point is always the one kept.
    expect(entries[entries.length - 1]?.used).toBe(CONTEXT_HISTORY_MAX_SAMPLES + 99);
    expect(entries[0]?.used).toBe(100);
  });

  it('is a no-op on an empty or already-bounded ring', () => {
    const empty: { t: number }[] = [];
    evictContextHistory(empty, Date.now(), 10);
    expect(empty).toEqual([]);
    const one = [{ t: Date.now() }];
    evictContextHistory(one, Date.now(), 10);
    expect(one).toHaveLength(1);
  });
});

describe('ContextUsageTracker — the reset ring', () => {
  it('stores the bare vocabulary, whatever spelling the caller used', () => {
    let now = 5_000;
    const tracker = makeTracker({ now: () => now });
    tracker.recordReset('/compact');
    now += 1_000;
    tracker.recordReset('clear');
    expect(tracker.history().resets).toEqual([
      { t: 5_000, cmd: 'compact' },
      { t: 6_000, cmd: 'clear' },
    ]);
  });

  it('ignores anything that is not a context reset', () => {
    const tracker = makeTracker();
    for (const junk of ['', '   ', '/new', 'resume', 'constructor']) {
      tracker.recordReset(junk);
    }
    expect(tracker.history().resets).toEqual([]);
  });

  it('is bounded by age and by count like the sample ring', () => {
    let now = 1_000_000;
    const tracker = makeTracker({ now: () => now });
    for (let i = 0; i < CONTEXT_HISTORY_MAX_RESETS + 5; i++) {
      tracker.recordReset('compact');
      now += 1_000;
    }
    expect(tracker.history().resets).toHaveLength(CONTEXT_HISTORY_MAX_RESETS);
    now += 73 * HOUR_MS;
    expect(tracker.history().resets).toEqual([]);
  });
});

describe('ContextUsageTracker — the sparkline', () => {
  it('answers the last 20 samples as integer percentages', async () => {
    let now = 1_000_000;
    const script = Array.from({ length: 25 }, (_, i) => (i + 1) * 4_000);
    const tracker = makeTracker({
      read: occupancyReader(script),
      ttlMs: 15_000,
      limit: 200_000,
      now: () => now,
    });
    tracker.setTranscriptPath('/t.jsonl');
    for (let i = 0; i < 25; i++) {
      tracker.maybeRefresh();
      await flush();
      now += 15_000;
    }
    const spark = tracker.spark();
    expect(spark).toHaveLength(CONTEXT_SPARK_POINTS);
    // Samples 6..25 (4 %, 8 %, … 50 %), oldest first.
    expect(spark?.[0]).toBe(12);
    expect(spark?.[spark.length - 1]).toBe(50);
    expect(spark?.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
  });

  it('clamps at 100 rather than drawing a bar off the top', async () => {
    const tracker = makeTracker({ read: occupancyReader([500_000]), limit: 200_000 });
    tracker.setTranscriptPath('/t.jsonl');
    tracker.maybeRefresh();
    await flush();
    expect(tracker.spark()).toEqual([100]);
  });

  it('answers null without a limit or without a sample — never a shape without a scale', async () => {
    const noLimit = makeTracker({ read: occupancyReader([100]), limit: null });
    noLimit.setTranscriptPath('/t.jsonl');
    noLimit.maybeRefresh();
    await flush();
    expect(noLimit.spark()).toBeNull();

    const noSample = makeTracker();
    expect(noSample.spark()).toBeNull();
  });
});

describe('downsampleContextHistory', () => {
  const NOW = Date.parse('2026-08-30T12:00:00.000Z');
  const sample = (minutesAgo: number, used: number): ContextUsageSample => ({
    t: NOW - minutesAgo * 60_000,
    used,
  });

  it('1h serves raw samples — no bucket, one point per measurement', () => {
    const samples = [sample(30, 10_000), sample(20, 20_000), sample(10, 15_000)];
    const points = downsampleContextHistory(samples, '1h', NOW);
    expect(points).toEqual([
      { t: new Date(NOW - 30 * 60_000).toISOString(), min: 10_000, max: 10_000, last: 10_000 },
      { t: new Date(NOW - 20 * 60_000).toISOString(), min: 20_000, max: 20_000, last: 20_000 },
      { t: new Date(NOW - 10 * 60_000).toISOString(), min: 15_000, max: 15_000, last: 15_000 },
    ]);
  });

  it('drops what falls outside the window, whatever the window', () => {
    const samples = [
      sample(4 * 24 * 60, 1),   // 4 days — outside every window
      sample(30 * 60, 2),       // 30 h — inside 3d only
      sample(3 * 60, 3),        // 3 h  — inside 24h and 3d
      sample(5, 4),             // 5 min — inside all three
    ];
    expect(downsampleContextHistory(samples, '1h', NOW).map((p) => p.last)).toEqual([4]);
    expect(downsampleContextHistory(samples, '24h', NOW).map((p) => p.last)).toEqual([3, 4]);
    expect(downsampleContextHistory(samples, '3d', NOW).map((p) => p.last)).toEqual([2, 3, 4]);
  });

  it('24h folds into 5-minute buckets, min/max/last — the compact cliff survives', () => {
    // Four samples inside ONE five-minute bucket, with a `/compact` in the
    // middle of it. An averaged bucket would answer ~120 000 and the graph
    // would show a gentle slope where the window was actually emptied.
    const base = NOW - 3 * 60 * 60_000;
    const bucketStart = Math.floor(base / (5 * 60_000)) * (5 * 60_000);
    const samples = [
      { t: bucketStart + 10_000, used: 180_000 },
      { t: bucketStart + 60_000, used: 190_000 },
      { t: bucketStart + 120_000, used: 20_000 },
      { t: bucketStart + 180_000, used: 24_000 },
    ];
    const points = downsampleContextHistory(samples, '24h', NOW);
    expect(points).toEqual([
      { t: new Date(bucketStart).toISOString(), min: 20_000, max: 190_000, last: 24_000 },
    ]);
  });

  it('3d folds into 15-minute buckets, one point per bucket, chronological', () => {
    const quarter = 15 * 60_000;
    const start = Math.floor((NOW - 40 * 60 * 60_000) / quarter) * quarter;
    const samples = [
      { t: start + 60_000, used: 50_000 },
      { t: start + 120_000, used: 60_000 },
      { t: start + quarter + 60_000, used: 70_000 },
      { t: start + 2 * quarter + 60_000, used: 10_000 },
    ];
    const points = downsampleContextHistory(samples, '3d', NOW);
    expect(points.map((p) => p.t)).toEqual([
      new Date(start).toISOString(),
      new Date(start + quarter).toISOString(),
      new Date(start + 2 * quarter).toISOString(),
    ]);
    expect(points.map((p) => [p.min, p.max, p.last])).toEqual([
      [50_000, 60_000, 60_000],
      [70_000, 70_000, 70_000],
      [10_000, 10_000, 10_000],
    ]);
    // Buckets are aligned on the epoch, not on `now`: the same call a second
    // later returns the same stamps, so a client may cache them.
    expect(downsampleContextHistory(samples, '3d', NOW + 1_000)).toEqual(points);
  });

  it('never exceeds the point cap, whatever the TTL knob was set to', () => {
    // A 1 s TTL: 3 600 samples in the 1 h window, which has no bucket by default.
    const samples = Array.from({ length: 3_600 }, (_, i) => ({
      t: NOW - (3_600 - i) * 1_000,
      used: i,
    }));
    for (const window of ['1h', '24h', '3d'] as const) {
      const points = downsampleContextHistory(samples, window, NOW);
      expect(points.length, window).toBeLessThanOrEqual(CONTEXT_HISTORY_MAX_POINTS);
      expect(points.length, window).toBeGreaterThan(0);
    }
  });

  it('is total: junk, unsorted input and an empty ring all answer a value', () => {
    expect(downsampleContextHistory([], '1h', NOW)).toEqual([]);
    const junk = [
      { t: Number.NaN, used: 1 },
      { t: NOW - 60_000, used: Number.POSITIVE_INFINITY },
      { t: NOW - 30_000, used: 7 },
      { t: NOW - 45_000, used: 5 },
    ];
    expect(downsampleContextHistory(junk, '1h', NOW).map((p) => p.last)).toEqual([5, 7]);
  });
});

describe('Session + Orchestrator — history on the wire', () => {
  /** ~50 % of the pinned 200 000-token window. */
  const HALF_FULL = [assistantLine({ id: 'msg_big', cacheRead: 100_000 }), ...TAIL_NOISE].join(
    '\n',
  );

  it('rides the poll as contextSpark — integer percentages, live sessions only', async () => {
    const { orch, lead } = makeTeam();
    lead.setTranscriptPath(writeTranscript('t.jsonl', HALF_FULL));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);

    expect(lead.toView().contextSpark).toEqual([50]);

    // Same gate as `contextUsage`: nothing is serialized for a dead session,
    // and `DbPersistence.writeSession` builds its row from this very view.
    lead.stop('test', 0);
    await waitUntil(() => lead.status !== 'running');
    expect('contextSpark' in lead.toView()).toBe(false);
  });

  it('omits contextSpark for a provider with no tracker', async () => {
    const { orch, lead } = makeTeam('gemini');
    lead.setTranscriptPath(writeTranscript('t.jsonl', HALF_FULL));
    orch.toView();
    await new Promise((r) => setTimeout(r, 200));
    expect('contextSpark' in lead.toView()).toBe(false);
    expect(lead.contextHistory).toBeNull();
  });

  it('records a reset when it FIRES, with the bare command', async () => {
    // Never on the request and never on a hook: an armed reset waits for the
    // agent's next idle boundary, and a `/compact` the CLI refuses fires no
    // `SessionStart` at all. A marker for a reset that never happened would be
    // a lie the operator cannot check.
    const { orch, lead } = makeTeam();
    lead.setTranscriptPath(writeTranscript('t.jsonl', HALF_FULL));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);

    orch.requestContextReset(lead.id, '/compact');
    // Armed is not fired: the ring is still empty while the command waits.
    expect(lead.contextHistory?.resets).toEqual([]);

    await waitUntil(() => (lead.contextHistory?.resets.length ?? 0) === 1);
    orch.requestContextReset(lead.id, '/clear');
    await waitUntil(() => (lead.contextHistory?.resets.length ?? 0) === 2);

    const resets = lead.contextHistory?.resets ?? [];
    expect(resets.map((r) => r.cmd)).toEqual(['compact', 'clear']);
    expect(resets.every((r) => Number.isFinite(r.t))).toBe(true);
    // The samples taken BEFORE the reset stay in the ring — the cliff is the
    // whole point of the graph.
    expect(lead.contextHistory?.samples.map((s) => s.used)).toEqual([100_000]);
  });
});
