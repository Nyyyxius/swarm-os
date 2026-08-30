import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ContextUsageTracker,
  MessageIdMemory,
  TranscriptContextSource,
  addTokenUsage,
  createLocalRangeReader,
  createSshRangeReader,
  isZeroTokenUsage,
  normalizeTokenUsage,
  parseSshRange,
  scanTranscriptRange,
  type ContextUsageReading,
  type ContextUsageSource,
  type ProviderQuotaView,
  type TokenUsageCounters,
  type TranscriptRangeReader,
  type TranscriptTailReader,
} from './context-usage.js';
import { Session } from './session.js';
import { Orchestrator } from './index.js';
import {
  NoOpPersistence,
  rowToSessionView,
  sessionRowTokenSeed,
  sessionToRow,
} from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { SessionRow } from '../db/index.js';
import type { Config } from '../../config.js';

/**
 * Monitoring, Lot 11 (docs/monitoring-agents.md) — tokens in/out and the cost
 * estimate they carry.
 *
 * The contract in one line: an agent's bill is CUMULATIVE, counted exactly
 * once, and survives everything that resets its context. So the suite is
 * organised around the four ways a token counter goes wrong:
 *
 *   1. it counts a turn TWICE (two transcript lines share one `message.id`, a
 *      poll re-reads bytes it already read, a cumulative counter is re-billed
 *      whole on every poll);
 *   2. it counts a turn ZERO times (a line straddles a read window, a `/clear`
 *      lands mid-read, a slice ends mid-line and is swallowed);
 *   3. it RESETS on something that is not a restart (`/clear`, `/compact`, a
 *      new rollout file, a server redeploy);
 *   4. it prices what it counted with a rate nobody quoted.
 *
 * The claude fixtures below are shaped after the transcript the spike captured
 * (`scripts/verify-claude-sessionstart.report.md` §S2), traps included. codex
 * and opencode carry their own delta suites, next to their own fixtures.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function assistantLine(opts: {
  id?: string;
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  sidechain?: boolean;
  omitId?: boolean;
  pad?: string;
}): string {
  const message: Record<string, unknown> = {
    ...(opts.omitId ? {} : { id: opts.id ?? 'msg_1' }),
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: opts.pad ?? 'hi' }],
    usage: {
      input_tokens: opts.input ?? 0,
      cache_creation_input_tokens: opts.cacheCreation ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      output_tokens: opts.output ?? 0,
    },
  };
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    parentUuid: 'p',
    requestId: 'req_1',
    message,
  });
}

/** The line types the spike observed AFTER the last assistant line. */
const TAIL_NOISE = [
  JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success' } }),
  JSON.stringify({ type: 'last-prompt', prompt: 'hi' }),
];

const TRANSCRIPT = '/agent/transcript.jsonl';

/**
 * A transcript held in memory, read with the SAME byte semantics as
 * `createLocalRangeReader`: whole-file size, a slice from an offset, and an
 * empty answer for a cursor past the end.
 */
function memoryRange(
  files: Record<string, string>,
  opts: { withSize?: boolean } = {},
): { read: TranscriptRangeReader; calls: Array<{ offset: number; maxBytes: number }> } {
  const calls: Array<{ offset: number; maxBytes: number }> = [];
  const read: TranscriptRangeReader = async (filePath, offset, maxBytes) => {
    const body = files[filePath];
    if (body === undefined) return null;
    calls.push({ offset, maxBytes });
    const buf = Buffer.from(body, 'utf8');
    // `withSize: false` models the SSH reader, which cannot afford the extra
    // round trip a size would cost.
    const size = opts.withSize === false ? null : buf.length;
    if (offset >= buf.length) return { text: '', bytes: 0, size };
    const slice = buf.subarray(offset, Math.min(buf.length, offset + maxBytes));
    return { text: slice.toString('utf8'), bytes: slice.length, size };
  };
  return { read, calls };
}

/** A tail reader that counts how often the gauge fell back to it. */
function countingTail(answer: string | null = null): {
  read: TranscriptTailReader;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    read: async () => {
      state.calls++;
      return answer;
    },
  };
}

function makeSource(
  files: Record<string, string>,
  opts: {
    maxRangeBytes?: number;
    withSize?: boolean;
    tail?: TranscriptTailReader;
  } = {},
): {
  source: TranscriptContextSource;
  calls: Array<{ offset: number; maxBytes: number }>;
} {
  const { read, calls } = memoryRange(files, { withSize: opts.withSize ?? true });
  const source = new TranscriptContextSource({
    readRange: read,
    readTail: opts.tail ?? (async () => null),
    ...(opts.maxRangeBytes !== undefined ? { maxRangeBytes: opts.maxRangeBytes } : {}),
  });
  source.retarget(TRANSCRIPT);
  return { source, calls };
}

/** Sum of every `tokens` a sequence of reads reported. */
async function drain(source: TranscriptContextSource, times: number): Promise<TokenUsageCounters> {
  let total: TokenUsageCounters = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (let i = 0; i < times; i++) {
    const reading = await source.read();
    if (reading.tokens) total = addTokenUsage(total, reading.tokens);
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1. The forward scanner — where a DOUBLE count would come from
// ---------------------------------------------------------------------------

describe('scanTranscriptRange', () => {
  it('bills one turn ONCE even though it is written as two lines', () => {
    // Trap 2 (spike S2): the thinking block and the text block of one turn
    // repeat the SAME `message.id` and the SAME `usage`. This is the trap that
    // doubles an agent's invoice rather than its gauge.
    const line = assistantLine({ id: 'msg_turn', input: 10, cacheRead: 20_000, output: 90 });
    const scan = scanTranscriptRange(`${line}\n${line}\n`);
    expect(scan.delta).toEqual({ in: 10, out: 90, cacheRead: 20_000, cacheWrite: 0 });
    expect(scan.countedIds).toEqual(['msg_turn']);
  });

  it('bills a sidechain — the sub-agent spends THIS agent’s money', () => {
    // The one place the bill and the gauge disagree on purpose: a sub-agent has
    // its own window (so the gauge skips it) and no invoice of its own.
    const scan = scanTranscriptRange(
      [
        assistantLine({ id: 'msg_main', input: 1, cacheRead: 1_000, output: 9 }),
        assistantLine({ id: 'msg_sub', sidechain: true, input: 500, output: 700 }),
        '',
      ].join('\n'),
    );
    expect(scan.delta).toEqual({ in: 501, out: 709, cacheRead: 1_000, cacheWrite: 0 });
    // …and the gauge still reports the MAIN conversation's newest turn.
    expect(scan.gaugeUsedTokens).toBe(1_010);
  });

  it('does not consume a trailing partial line', () => {
    const whole = assistantLine({ id: 'msg_a', input: 5, output: 5 });
    const partial = assistantLine({ id: 'msg_b', input: 999, output: 999 }).slice(0, 40);
    const scan = scanTranscriptRange(`${whole}\n${partial}`);
    // Only the complete line is billed…
    expect(scan.delta.in).toBe(5);
    // …and the cursor stops right after its newline, so the cut line is re-read
    // whole next poll instead of being lost as an unparseable fragment.
    expect(scan.consumedBytes).toBe(Buffer.byteLength(`${whole}\n`, 'utf8'));
  });

  it('counts consumed BYTES, not characters', () => {
    // A cursor is a byte offset. Measuring a transcript full of accented text in
    // JS string length would drift the cursor a little further every poll until
    // it started slicing lines in half.
    const line = assistantLine({ id: 'msg_utf8', input: 1, pad: 'héllo — ünïcode ✨' });
    const scan = scanTranscriptRange(`${line}\n`);
    expect(scan.consumedBytes).toBe(Buffer.byteLength(`${line}\n`, 'utf8'));
    expect(scan.consumedBytes).toBeGreaterThan(`${line}\n`.length);
  });

  it('skips ids it has already seen', () => {
    const seen = new MessageIdMemory(4);
    seen.add('msg_old');
    const scan = scanTranscriptRange(
      [
        assistantLine({ id: 'msg_old', input: 100 }),
        assistantLine({ id: 'msg_new', input: 7 }),
        '',
      ].join('\n'),
      seen,
    );
    expect(scan.delta.in).toBe(7);
    expect(scan.countedIds).toEqual(['msg_new']);
  });

  it('refuses to bill a usage line with no message.id', () => {
    // With no id, "count this once" is not decidable — and the two lines of one
    // turn would each be counted in full.
    const scan = scanTranscriptRange(`${assistantLine({ omitId: true, input: 50 })}\n`);
    expect(scan.delta.in).toBe(0);
    // It is still a perfectly good occupancy reading.
    expect(scan.gaugeUsedTokens).toBe(50);
  });

  it('survives noise, half-lines and non-JSON without throwing', () => {
    const scan = scanTranscriptRange(
      [
        'not json at all',
        '{"type":"assistant","message":{"id":"broken"',
        ...TAIL_NOISE,
        assistantLine({ id: 'msg_ok', input: 3, output: 4 }),
        '',
      ].join('\n'),
    );
    expect(scan.delta).toEqual({ in: 3, out: 4, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('MessageIdMemory', () => {
  it('evicts oldest-first and stays bounded', () => {
    const mem = new MessageIdMemory(2);
    mem.add('a');
    mem.add('b');
    mem.add('c');
    expect(mem.size).toBe(2);
    expect(mem.has('a')).toBe(false);
    expect(mem.has('c')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The cursor — where a MISSED or REPLAYED turn would come from
// ---------------------------------------------------------------------------

describe('TranscriptContextSource — incremental billing', () => {
  it('reads from 0, then only from where it stopped', async () => {
    const body = `${assistantLine({ id: 'msg_1', input: 10, output: 5 })}\n`;
    const files = { [TRANSCRIPT]: body };
    const { source, calls } = makeSource(files);

    expect(await source.read()).toMatchObject({ tokens: { in: 10, out: 5 } });
    expect(calls[0]?.offset).toBe(0);
    expect(source.offset).toBe(Buffer.byteLength(body, 'utf8'));

    // The agent takes another turn; the file grows.
    const second = `${assistantLine({ id: 'msg_2', input: 20, output: 7 })}\n`;
    files[TRANSCRIPT] = body + second;
    expect(await source.read()).toMatchObject({ tokens: { in: 20, out: 7 } });
    // The second read starts where the first stopped — the first turn's bytes
    // are never handed to the parser twice.
    expect(calls[1]?.offset).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('re-reads a line the writer had not finished flushing', async () => {
    const line = assistantLine({ id: 'msg_1', input: 42, output: 8 });
    const files = { [TRANSCRIPT]: line.slice(0, 30) };
    const { source } = makeSource(files);

    // Half a line: nothing to bill, and — crucially — nothing consumed.
    expect(await source.read()).not.toHaveProperty('tokens');
    expect(source.offset).toBe(0);

    files[TRANSCRIPT] = `${line}\n`;
    expect(await source.read()).toMatchObject({ tokens: { in: 42, out: 8 } });
  });

  it('bills one turn once even when its two lines land in different polls', async () => {
    const first = assistantLine({ id: 'msg_turn', input: 10, cacheRead: 900, output: 5 });
    const files = { [TRANSCRIPT]: `${first}\n` };
    const { source } = makeSource(files);
    expect(await source.read()).toMatchObject({ tokens: { in: 10, cacheRead: 900, out: 5 } });

    // The text block of the SAME turn arrives a poll later, repeating the id
    // and the numbers. The id memory is what stops it being billed again.
    files[TRANSCRIPT] += `${first}\n`;
    expect(await source.read()).not.toHaveProperty('tokens');
  });

  it('catches up over several polls, in order, without skipping a turn', async () => {
    const lines = [
      assistantLine({ id: 'm1', input: 100, output: 1 }),
      assistantLine({ id: 'm2', input: 200, output: 2 }),
      assistantLine({ id: 'm3', input: 300, output: 3 }),
      assistantLine({ id: 'm4', input: 400, output: 4 }),
    ];
    const body = `${lines.join('\n')}\n`;
    const oneLine = Buffer.byteLength(`${lines[0]}\n`, 'utf8');
    // A window that fits roughly two lines — the shape of an agent that spoke
    // more between two polls than one read may swallow.
    const tail = countingTail();
    const { source, calls } = makeSource({ [TRANSCRIPT]: body }, {
      maxRangeBytes: oneLine * 2 + 10,
      tail: tail.read,
    });

    const first = await source.read();
    expect(first.tokens).toEqual({ in: 300, out: 3, cacheRead: 0, cacheWrite: 0 });
    // Not caught up yet, so the gauge is served by the tail read rather than by
    // a turn from the middle of the backlog.
    expect(tail.calls).toBe(1);

    const second = await source.read();
    expect(second.tokens).toEqual({ in: 700, out: 7, cacheRead: 0, cacheWrite: 0 });
    expect(calls.map((c) => c.offset)).toEqual([0, oneLine * 2]);
    expect(source.offset).toBe(Buffer.byteLength(body, 'utf8'));
    // Every turn billed exactly once, whatever the window size.
    expect(await drain(source, 1)).toEqual({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('steps over a line longer than one whole read window', async () => {
    // A giant tool result can exceed any window. Stalling the cursor on it
    // would stop billing the agent for good, so we step past — and resynchronise
    // on the next newline rather than parsing the fragment we land in.
    const huge = assistantLine({ id: 'm_huge', input: 9_999, pad: 'x'.repeat(4_000) });
    const next = assistantLine({ id: 'm_next', input: 11, output: 3 });
    const body = `${huge}\n${next}\n`;
    // A window that comfortably fits the ordinary line and cannot fit the giant.
    const { source } = makeSource(
      { [TRANSCRIPT]: body },
      { maxRangeBytes: Buffer.byteLength(next, 'utf8') + 8 },
    );

    // Enough polls to cross the giant one window at a time — the cursor never
    // jumps, it just keeps stepping.
    const window = Buffer.byteLength(next, 'utf8') + 8;
    const total = await drain(source, Math.ceil(Buffer.byteLength(body, 'utf8') / window) + 2);
    expect(total).toEqual({ in: 11, out: 3, cacheRead: 0, cacheWrite: 0 });
    expect(source.offset).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('serves the gauge itself once caught up — no second read per poll', async () => {
    const tail = countingTail();
    const files = {
      [TRANSCRIPT]: [assistantLine({ id: 'm1', input: 10, cacheRead: 20_000, output: 90 }), ...TAIL_NOISE, ''].join('\n'),
    };
    const { source } = makeSource(files, { tail: tail.read });

    expect(await source.read()).toMatchObject({ kind: 'sample', usedTokens: 20_100 });
    // Nothing new arrives: the gauge stays FRESH off the remembered turn rather
    // than going stale for want of new bytes.
    expect(await source.read()).toMatchObject({ kind: 'sample', usedTokens: 20_100 });
    expect(tail.calls).toBe(0);
  });

  it('answers `empty` for a rotated file that holds no turn yet', async () => {
    const tail = countingTail();
    const { source } = makeSource({ [TRANSCRIPT]: `${TAIL_NOISE.join('\n')}\n` }, {
      tail: tail.read,
    });
    expect(await source.read()).toMatchObject({ kind: 'empty' });
    expect(tail.calls).toBe(0);
  });

  it('reports `unavailable` — and bills nothing — when the file cannot be read', async () => {
    const { source } = makeSource({});
    const reading = await source.read();
    expect(reading).toMatchObject({ kind: 'unavailable', reason: 'unreadable' });
    expect(reading).not.toHaveProperty('tokens');
  });

  it('restarts at 0 with the id memory INTACT when the file shrinks', async () => {
    const line = assistantLine({ id: 'm1', input: 500, output: 50 });
    const files = { [TRANSCRIPT]: `${line}\n` };
    // A working tail, as in production: a rewind is not a degradation, and the
    // gauge keeps being served from the tail while the cursor catches back up.
    const { source } = makeSource(files, { tail: countingTail(`${line}\n`).read });
    expect(await source.read()).toMatchObject({ tokens: { in: 500 } });

    // The file was rewritten under the same name and is now shorter than our
    // cursor. Restarting at 0 is the only safe move — and keeping the ids is
    // what stops the messages the rewrite preserved from being billed twice.
    files[TRANSCRIPT] = `${line}\n`.slice(0, 20);
    expect(await source.read()).not.toHaveProperty('tokens');
    expect(source.offset).toBe(0);

    files[TRANSCRIPT] = `${line}\n`;
    expect(await source.read()).not.toHaveProperty('tokens');
  });

  it('infers "caught up" from a short answer when the transport has no size', async () => {
    // The SSH reader answers `size: null` — asking for one would cost a second
    // round trip per session per poll.
    const tail = countingTail();
    const files = {
      [TRANSCRIPT]: `${assistantLine({ id: 'm1', input: 1, output: 2 })}\n`,
    };
    const { read } = memoryRange(files, { withSize: false });
    const source = new TranscriptContextSource({
      readRange: read,
      readTail: tail.read,
      maxRangeBytes: 4096,
    });
    source.retarget(TRANSCRIPT);
    expect(await source.read()).toMatchObject({ kind: 'sample', usedTokens: 3 });
    expect(tail.calls).toBe(0);
  });

  it('bills the tail of the file a rotation left behind', async () => {
    // `/clear` is typed moments after the turn that filled the window, and that
    // turn was written AFTER our last poll. Without one last read of the old
    // file, an operator's most common move silently loses its most expensive
    // turn — up to a whole TTL of spend, every single time.
    const files = {
      [TRANSCRIPT]: `${assistantLine({ id: 'm1', input: 100, output: 10 })}\n`,
      '/agent/after-clear.jsonl': '',
    };
    const { source } = makeSource(files);
    expect(await source.read()).toMatchObject({ tokens: { in: 100 } });

    // The big turn lands, and the operator clears before we poll again.
    files[TRANSCRIPT] += `${assistantLine({ id: 'm2', input: 90_000, output: 400 })}\n`;
    source.retarget('/agent/after-clear.jsonl');

    // The first read of the new file also settles the old one's debt.
    expect(await source.read()).toMatchObject({ tokens: { in: 90_000, out: 400 } });
    // …exactly once.
    files['/agent/after-clear.jsonl'] = `${assistantLine({ id: 'm3', input: 7 })}\n`;
    expect(await source.read()).toMatchObject({ tokens: { in: 7, out: 0 } });
  });

  it('does not re-bill a turn straddling the cursor when a rotation drains it', async () => {
    // The two lines of one turn carry the SAME message.id and the SAME usage.
    // A poll can leave the cursor exactly between them; the rotation drain then
    // reads a slice that OPENS on line 2 of an already-billed turn — without
    // the id snapshot it would bill that turn a second time.
    const line = assistantLine({ id: 'm1', input: 50_000, output: 200 });
    const files = {
      [TRANSCRIPT]: `${line}\n`,
      '/agent/after-clear.jsonl': '',
    };
    const { source } = makeSource(files);
    expect(await source.read()).toMatchObject({ tokens: { in: 50_000 } });

    // Line 2 of the same turn lands after the poll, then the operator clears.
    files[TRANSCRIPT] += `${line}\n`;
    source.retarget('/agent/after-clear.jsonl');

    const reading = await source.read();
    expect(reading.tokens ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }).toEqual({
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('never lets the abandoned file block the live one', async () => {
    // The drain is best-effort: one read, no retry. An unreadable old file
    // costs its own tail and nothing else.
    const files = { [TRANSCRIPT]: `${assistantLine({ id: 'm1', input: 5 })}\n` };
    const { source } = makeSource(files);
    await source.read();
    source.retarget('/agent/gone.jsonl');
    source.retarget('/agent/live.jsonl');
    files['/agent/live.jsonl'] = `${assistantLine({ id: 'm2', input: 8, output: 2 })}\n`;
    expect(await source.read()).toMatchObject({ tokens: { in: 8, out: 2 } });
  });

  it('keeps behaving exactly as before when no range reader is wired', async () => {
    // Every pre-Lot-11 call site builds this shape. One tail read, no cursor,
    // no token accounting — and no behaviour change to regress.
    const tail = countingTail(assistantLine({ id: 'm1', input: 5, cacheRead: 100, output: 20 }));
    const source = new TranscriptContextSource({ readTail: tail.read });
    source.retarget(TRANSCRIPT);
    const reading = await source.read();
    expect(reading).toEqual({ kind: 'sample', usedTokens: 125 });
    expect(tail.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The tracker — where a `/clear` would wipe an invoice
// ---------------------------------------------------------------------------

describe('ContextUsageTracker — token totals', () => {
  function trackerOver(
    files: Record<string, string>,
    mirror: TokenUsageCounters[] = [],
  ): { tracker: ContextUsageTracker; source: TranscriptContextSource; mirror: TokenUsageCounters[] } {
    const { read } = memoryRange(files);
    const source = new TranscriptContextSource({
      readRange: read,
      readTail: async () => null,
    });
    source.retarget(TRANSCRIPT);
    const tracker = new ContextUsageTracker({
      sessionId: 'sess-tokens',
      ttlMs: 1,
      source,
      onTokenUsage: (delta) => mirror.push(delta),
    });
    return { tracker, source, mirror };
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it('accumulates deltas and mirrors each one out exactly once', async () => {
    const files = { [TRANSCRIPT]: `${assistantLine({ id: 'm1', input: 10, output: 5 })}\n` };
    const { tracker, mirror } = trackerOver(files);

    tracker.maybeRefresh();
    await settle();
    expect(tracker.tokenUsage).toEqual({ in: 10, out: 5, cacheRead: 0, cacheWrite: 0 });
    expect(mirror).toEqual([{ in: 10, out: 5, cacheRead: 0, cacheWrite: 0 }]);

    files[TRANSCRIPT] += `${assistantLine({ id: 'm2', input: 1, cacheCreation: 300 })}\n`;
    tracker.maybeRefresh();
    await settle();
    expect(tracker.tokenUsage).toEqual({ in: 11, out: 5, cacheRead: 0, cacheWrite: 300 });
    expect(mirror).toHaveLength(2);

    // A poll that measured nothing must not cost a state notification.
    tracker.maybeRefresh();
    await settle();
    expect(mirror).toHaveLength(2);
  });

  it('KEEPS the totals across a rotation, and rewinds only the cursor', async () => {
    const files = {
      [TRANSCRIPT]: `${assistantLine({ id: 'm1', input: 1_000, output: 100 })}\n`,
      '/agent/after-clear.jsonl': `${assistantLine({ id: 'm2', input: 7, output: 3 })}\n`,
    };
    const { tracker, source } = trackerOver(files);
    tracker.maybeRefresh();
    await settle();
    expect(tracker.tokenUsage).toMatchObject({ in: 1_000 });

    // `/clear` rotates the transcript (spike S4): new CLI session, new file.
    tracker.retarget('/agent/after-clear.jsonl');
    expect(source.offset).toBe(0);
    tracker.maybeRefresh();
    await settle();
    // The bill CARRIES — a reset throws away a context, not an invoice.
    expect(tracker.tokenUsage).toEqual({ in: 1_007, out: 103, cacheRead: 0, cacheWrite: 0 });
  });

  it('bills a read that landed after a reset, even though the gauge discards it', async () => {
    // The generation guard exists so a pre-reset OCCUPANCY is never re-blessed
    // as fresh. Money is not occupancy: those tokens were spent.
    const files = { [TRANSCRIPT]: `${assistantLine({ id: 'm1', input: 4_000, output: 9 })}\n` };
    const { tracker } = trackerOver(files);
    tracker.maybeRefresh();
    tracker.markStale();
    await settle();
    expect(tracker.snapshot()).toBeNull();
    expect(tracker.tokenUsage).toMatchObject({ in: 4_000, out: 9 });
  });
});

// ---------------------------------------------------------------------------
// 4. The counter helpers
// ---------------------------------------------------------------------------

describe('token counter helpers', () => {
  it('clamps a corrupt seed instead of letting the bill run backwards', () => {
    expect(normalizeTokenUsage({ in: -5, out: 1.9, cacheRead: NaN, cacheWrite: null })).toEqual({
      in: 0,
      out: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(isZeroTokenUsage(normalizeTokenUsage(null))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The Session mirror, the columns, and the seed
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

/** A bare session — no provider config, no spawn, no tracker. */
function makeSession(init: Partial<Parameters<typeof Session.prototype.constructor>[0]> = {}): Session {
  const s = new Session({
    orchestratorId: 'orch-tokens',
    name: 'agent',
    role: 'tester',
    type: 'worker',
    cwd: tmpRoot,
    initialPrompt: null,
    preamble: null,
    model: 'claude-opus-5',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    skipSpawn: true,
    ...init,
  });
  openSessions.push(s);
  return s;
}

/**
 * A live team on a fake `claude` adapter — the real wiring, end to end.
 *
 * The TTL is deliberately tiny: `Orchestrator.toView()` is the only heartbeat
 * this feature has, and a test that appends a second turn has to be allowed to
 * observe it without waiting out the production 15 s.
 */
function makeTeam(overrides: Partial<Config> = {}): { orch: Orchestrator; lead: Session } {
  const config = makeConfig({ contextUsageTtlMs: 25, ...overrides });
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider({ id: 'claude' }), { builtin: true });
  const orch = new Orchestrator(
    {
      name: 'monitoring',
      role: 'co',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      defaultProvider: 'claude',
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

async function waitUntil(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function baseRow(): SessionRow {
  return {
    id: 'sess-1',
    orchestrator_id: 'orch-1',
    name: 'lead',
    role: 'r',
    type: 'lead',
    cwd: '/workspace/x',
    initial_prompt: null,
    model: 'claude-opus-5',
    effort: 'low',
    permission_mode: 'bypassPermissions',
    provider: 'claude',
    status: 'exited',
    pid: null,
    started_at: '2026-08-30T10:00:00.000Z',
    ended_at: '2026-08-30T11:00:00.000Z',
    exit_code: 0,
    last_error: null,
    stop_reason: null,
    log_path: '/x/y',
    last_activity_at: '2026-08-30T11:00:00.000Z',
    hidden_at: null,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tokens-'));
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

describe('Session — the token mirror', () => {
  it('says NOTHING at all until something has been measured', () => {
    // `—`, not `0`: an agent whose provider has no source (gemini) and an agent
    // that has not spoken yet are both "not measured", and the UI must be able
    // to tell that from a measured zero.
    const s = makeSession();
    expect(s.toView().tokenUsage).toBeUndefined();
    expect('tokenUsage' in s.toView()).toBe(false);
  });

  it('accumulates deltas and notifies the persistence layer, unforced', () => {
    let forced: boolean[] = [];
    const s = makeSession({ onStateChange: (_s, force) => forced.push(force) });
    // Only the notifications this counter causes are under test — a spawn emits
    // its own, forced, and rightly so.
    forced = [];
    s.recordTokenUsage({ in: 10, out: 2, cacheRead: 100, cacheWrite: 0 });
    s.recordTokenUsage({ in: 5, out: 1, cacheRead: 0, cacheWrite: 40 });
    expect(s.tokenUsage).toEqual({ in: 15, out: 3, cacheRead: 100, cacheWrite: 40 });
    // Unforced: it rides the existing 1 write/s throttle rather than adding a
    // DB write per poll.
    expect(forced.every((f) => f === false)).toBe(true);

    // A zero delta is silence, not a notification.
    const before = forced.length;
    s.recordTokenUsage({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    expect(forced).toHaveLength(before);
  });

  it('keeps the totals on the view of a TERMINATED session', () => {
    // Unlike `contextUsage`, which describes a context that no longer exists.
    // And this view is what the final DB write is built from: gating it would
    // erase the columns on the way out.
    const s = makeSession();
    s.recordTokenUsage({ in: 9, out: 1, cacheRead: 0, cacheWrite: 0 });
    s.stop('done', 0);
    expect(s.toView().tokenUsage).toMatchObject({ in: 9, out: 1 });
  });

  it('seeds from a resumed row — including a seeded ZERO', () => {
    const resumed = makeSession({
      tokenUsage: { in: 1_000, out: 200, cacheRead: 5_000, cacheWrite: 300 },
    });
    expect(resumed.toView().tokenUsage).toMatchObject({ in: 1_000, cacheRead: 5_000 });
    resumed.recordTokenUsage({ in: 1, out: 0, cacheRead: 0, cacheWrite: 0 });
    expect(resumed.tokenUsage.in).toBe(1_001);

    // A row that measured zero is not a row that never measured.
    const zeroed = makeSession({ tokenUsage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(zeroed.toView().tokenUsage).toMatchObject({ in: 0, costBasis: 'estimated' });
  });

  it('clamps a corrupt seed rather than starting the bill negative', () => {
    const s = makeSession({ tokenUsage: { in: -9, out: null, cacheRead: 3, cacheWrite: null } });
    expect(s.tokenUsage).toEqual({ in: 0, out: 0, cacheRead: 3, cacheWrite: 0 });
  });

  it('prices the view from the live rate card, and says `estimated`', () => {
    const s = makeSession({
      contextUsage: {
        ttlMs: 0,
        costRates: () => ({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
      },
    });
    s.recordTokenUsage({ in: 1_000_000, out: 100_000, cacheRead: 2_000_000, cacheWrite: 0 });
    expect(s.toView().tokenUsage).toMatchObject({ costUsd: 8.5, costBasis: 'estimated' });
  });

  it('serves `costUsd: null` when nothing can price the model', () => {
    const s = makeSession({ contextUsage: { ttlMs: 0, costRates: () => null } });
    s.recordTokenUsage({ in: 10, out: 10, cacheRead: 0, cacheWrite: 0 });
    const view = s.toView().tokenUsage;
    // The tokens are still served: a bill in tokens beats no bill at all.
    expect(view).toMatchObject({ in: 10, out: 10, costUsd: null });
  });

  it('survives a rate thunk that throws', () => {
    const s = makeSession({
      contextUsage: {
        ttlMs: 0,
        costRates: () => {
          throw new Error('catalogue exploded');
        },
      },
    });
    s.recordTokenUsage({ in: 10, out: 0, cacheRead: 0, cacheWrite: 0 });
    expect(s.toView().tokenUsage).toMatchObject({ in: 10, costUsd: null });
  });
});

describe('persistence — the four columns', () => {
  it('round-trips the counters through sessionToRow / rowToSessionView', () => {
    const s = makeSession();
    s.recordTokenUsage({ in: 11, out: 22, cacheRead: 33, cacheWrite: 44 });
    const row = sessionToRow(s.toView(), null);
    expect(row).toMatchObject({
      tokens_in: 11,
      tokens_out: 22,
      tokens_cache_read: 33,
      tokens_cache_write: 44,
    });
    expect(rowToSessionView(row).tokenUsage).toEqual({
      in: 11,
      out: 22,
      cacheRead: 33,
      cacheWrite: 44,
      costUsd: null,
      costBasis: 'estimated',
    });
  });

  it('writes NULL — not 0 — for a view that carries no counter', () => {
    const row = sessionToRow(makeSession().toView(), null);
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
    expect(row.tokens_cache_read).toBeNull();
    expect(row.tokens_cache_write).toBeNull();
    // …and a row of NULLs says nothing rather than inventing a zero bill.
    expect(rowToSessionView(row).tokenUsage).toBeUndefined();
  });

  it('prices a terminated agent when a rate card is passed in', () => {
    const row = { ...baseRow(), tokens_in: 1_000_000, tokens_out: 0 };
    const view = rowToSessionView(row, (providerId, modelId) =>
      providerId === 'claude' && modelId === 'claude-opus-5'
        ? { input: 5, output: 25, cacheRead: null, cacheWrite: null }
        : null,
    );
    expect(view.tokenUsage).toMatchObject({ in: 1_000_000, costUsd: 5 });
  });

  it('builds a resume seed only for a row that actually carries one', () => {
    expect(sessionRowTokenSeed(baseRow())).toBeNull();
    expect(sessionRowTokenSeed({ ...baseRow(), tokens_in: 7 })).toEqual({
      in: 7,
      out: null,
      cacheRead: null,
      cacheWrite: null,
    });
  });

  it('carries a real bill through row → seed → session, unchanged', () => {
    // The restart path in one line: a redeploy relaunches the CLI on a brand-new
    // transcript, so without this the bill would reset on every deploy.
    const s = makeSession();
    s.recordTokenUsage({ in: 1_234, out: 56, cacheRead: 7_890, cacheWrite: 12 });
    const row = sessionToRow(s.toView(), null);
    const resumed = makeSession({ tokenUsage: sessionRowTokenSeed(row) });
    expect(resumed.tokenUsage).toEqual({ in: 1_234, out: 56, cacheRead: 7_890, cacheWrite: 12 });
  });
});

// ---------------------------------------------------------------------------
// 6. End to end — the real reader, the real wiring
// ---------------------------------------------------------------------------

describe('Session + Orchestrator — tokens on the view', () => {
  it('bills a claude agent off its transcript, through the real local reader', async () => {
    const { orch, lead } = makeTeam();
    const file = path.join(tmpRoot, 'transcript.jsonl');
    fs.writeFileSync(
      file,
      `${[
        assistantLine({ id: 'm1', input: 10, cacheRead: 20_411, output: 86 }),
        assistantLine({ id: 'm1', input: 10, cacheRead: 20_411, output: 86 }),
        ...TAIL_NOISE,
      ].join('\n')}\n`,
    );
    lead.setTranscriptPath(file);
    expect(lead.toView().tokenUsage).toBeUndefined();

    // `Orchestrator.toView()` IS the heartbeat — no timer exists in this feature.
    orch.toView();
    await waitUntil(() => lead.tokenUsage.in > 0);

    // The turn's two lines were billed ONCE, and the gauge came off the same
    // read: 10 + 20 411 + 0 + 86.
    expect(lead.toView().tokenUsage).toMatchObject({
      in: 10,
      out: 86,
      cacheRead: 20_411,
      cacheWrite: 0,
      costBasis: 'estimated',
    });
    expect(lead.toView().contextUsage).toMatchObject({ usedTokens: 20_507 });

    // A second turn appends; only its own tokens are added.
    fs.appendFileSync(file, `${assistantLine({ id: 'm2', input: 4, output: 6 })}\n`);
    await waitUntil(() => {
      orch.toView();
      return lead.tokenUsage.out === 92;
    });
    expect(lead.tokenUsage).toMatchObject({ in: 14, out: 92, cacheRead: 20_411 });
  });

  it('keeps the bill across a `/clear` that rotates the transcript', async () => {
    const { orch, lead } = makeTeam();
    const first = path.join(tmpRoot, 'first.jsonl');
    fs.writeFileSync(first, `${assistantLine({ id: 'm1', input: 900, output: 100 })}\n`);
    lead.setTranscriptPath(first);
    orch.toView();
    await waitUntil(() => lead.tokenUsage.in === 900);

    // `/clear`: a new CLI session id, a new file, the old one orphaned.
    const second = path.join(tmpRoot, 'second.jsonl');
    fs.writeFileSync(second, `${assistantLine({ id: 'm2', input: 5, output: 1 })}\n`);
    lead.setTranscriptPath(second);
    await waitUntil(() => {
      orch.toView();
      return lead.tokenUsage.in === 905;
    });
    expect(lead.tokenUsage).toMatchObject({ in: 905, out: 101 });
  });
});

describe('parseSshRange', () => {
  it('splits the size line from the slice and measures the slice in bytes', () => {
    expect(parseSshRange('1024\n{"a":1}\n')).toEqual({
      text: '{"a":1}\n',
      bytes: 8,
      size: 1_024,
    });
  });

  it('answers null when the size line is missing', () => {
    // The script did not run as written, so nothing that follows can be
    // trusted — and trusting it would advance a persistent byte cursor.
    expect(parseSshRange('')).toBeNull();
    expect(parseSshRange('no-newline')).toBeNull();
    expect(parseSshRange('not-a-number\nbody')).toBeNull();
  });

  it('reports an empty slice at EOF rather than a failure', () => {
    expect(parseSshRange('4096\n')).toEqual({ text: '', bytes: 0, size: 4_096 });
  });
});

describe('createSshRangeReader', () => {
  const config = { agentTransport: 'ssh' } as unknown as Config;

  function fakeExec(
    answer: { code: number | null; stdout: string; timedOut?: boolean },
    seen: string[] = [],
  ): { exec: Parameters<typeof createSshRangeReader>[1]['hostExec']; seen: string[] } {
    return {
      seen,
      exec: async (_cfg, input) => {
        seen.push(input.argv.join(' '));
        return {
          code: answer.code,
          stdout: answer.stdout,
          stderr: '',
          timedOut: answer.timedOut ?? false,
        };
      },
    };
  }

  it('guards the pipeline with `test -f`, because `head` always exits 0', async () => {
    // Without the guard a deleted transcript comes back as a SUCCESSFUL empty
    // read: the cursor freezes, billing stops, and the gauge keeps serving its
    // last number as fresh for ever — silently, with no warning logged.
    const { exec, seen } = fakeExec({ code: 0, stdout: '99\nline\n' });
    const read = createSshRangeReader(config, { hostExec: exec });
    await read("/h/it's.jsonl", 10, 4_096);
    const script = seen[0] ?? '';
    expect(script).toContain('test -f');
    expect(script).toContain('|| exit 3');
    // 1-BASED: byte offset 10 is `tail -c +11`.
    expect(script).toContain('tail -c +11');
    expect(script).toContain('head -c 4096');
    // A quote in the path cannot break out of its token.
    expect(script).toContain(`'/h/it'\\''s.jsonl'`);
  });

  it('turns the guard’s non-zero exit into an unreadable answer', async () => {
    const { exec } = fakeExec({ code: 3, stdout: '' });
    const read = createSshRangeReader(config, { hostExec: exec });
    expect(await read('/h/gone.jsonl', 0, 4_096)).toBeNull();
  });

  it('carries a real size, so a truncation is detectable over SSH too', async () => {
    const { exec } = fakeExec({ code: 0, stdout: '7\nabc' });
    const read = createSshRangeReader(config, { hostExec: exec });
    expect(await read('/h/t.jsonl', 4, 4_096)).toEqual({ text: 'abc', bytes: 3, size: 7 });
  });

  it('answers null on a timeout', async () => {
    const { exec } = fakeExec({ code: null, stdout: '', timedOut: true });
    const read = createSshRangeReader(config, { hostExec: exec });
    expect(await read('/h/t.jsonl', 0, 4_096)).toBeNull();
  });
});

describe('createLocalRangeReader', () => {
  it('reads a slice from an offset and reports the file size', async () => {
    const file = path.join(tmpRoot, 'range.txt');
    fs.writeFileSync(file, 'abcdefghij');
    const read = createLocalRangeReader();
    expect(await read(file, 3, 4)).toEqual({ text: 'defg', bytes: 4, size: 10 });
    // A cursor at (or past) the end answers empty rather than failing — that is
    // how the caller detects "nothing new" and "the file shrank".
    expect(await read(file, 10, 4)).toEqual({ text: '', bytes: 0, size: 10 });
    expect(await read(file, 99, 4)).toEqual({ text: '', bytes: 0, size: 10 });
  });

  it('answers null for a missing path and for anything that is not a file', async () => {
    const read = createLocalRangeReader();
    expect(await read(path.join(tmpRoot, 'nope.txt'), 0, 10)).toBeNull();
    expect(await read(tmpRoot, 0, 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Lot 13 — the reported bill, and the account quota
// ---------------------------------------------------------------------------

/** A source that hands back exactly the readings a test scripts, in order. */
function scriptedSource(readings: ContextUsageReading[]): ContextUsageSource {
  let i = 0;
  return {
    basis: 'control-plane',
    target: null,
    ready: true,
    read: async () => readings[Math.min(i++, readings.length - 1)] ?? { kind: 'empty' },
  };
}

const QUOTA: ProviderQuotaView = {
  usedPercent: 12,
  resetsAt: '2026-08-30T18:34:44.000Z',
  plan: 'plus',
};

describe('ContextUsageTracker — reported cost and quota', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  function trackerOver(
    readings: ContextUsageReading[],
    mirror: number[] = [],
  ): ContextUsageTracker {
    return new ContextUsageTracker({
      sessionId: 'sess-lot13',
      ttlMs: 1,
      source: scriptedSource(readings),
      onReportedCost: (usd) => mirror.push(usd),
    });
  }

  it('accumulates cost deltas and mirrors each one out exactly once', async () => {
    const mirror: number[] = [];
    const tracker = trackerOver(
      [
        { kind: 'sample', usedTokens: 10, reportedCostUsd: 0.25 },
        { kind: 'sample', usedTokens: 20, reportedCostUsd: 0.1 },
        { kind: 'sample', usedTokens: 20 },
      ],
      mirror,
    );
    tracker.maybeRefresh();
    await settle();
    expect(tracker.reportedCostUsd).toBe(0.25);

    tracker.maybeRefresh();
    await settle();
    expect(tracker.reportedCostUsd).toBeCloseTo(0.35, 10);
    expect(mirror).toEqual([0.25, 0.1]);

    // A poll that measured no new spend costs no notification.
    tracker.maybeRefresh();
    await settle();
    expect(mirror).toHaveLength(2);
  });

  it('refuses a delta that would walk the bill backwards', async () => {
    const mirror: number[] = [];
    const tracker = trackerOver(
      [
        { kind: 'sample', usedTokens: 1, reportedCostUsd: 1 },
        { kind: 'sample', usedTokens: 1, reportedCostUsd: -5 },
        { kind: 'sample', usedTokens: 1, reportedCostUsd: Number.NaN },
      ],
      mirror,
    );
    for (let i = 0; i < 3; i++) {
      tracker.maybeRefresh();
      await settle();
    }
    expect(tracker.reportedCostUsd).toBe(1);
    expect(mirror).toEqual([1]);
  });

  it('bills the cost of a read the GAUGE throws away', async () => {
    // Same argument as the tokens: a `/clear` landing mid-read invalidates the
    // occupancy, not the invoice.
    const tracker = trackerOver([{ kind: 'sample', usedTokens: 4_000, reportedCostUsd: 2.5 }]);
    tracker.maybeRefresh();
    tracker.markStale();
    await settle();
    expect(tracker.snapshot()).toBeNull();
    expect(tracker.reportedCostUsd).toBe(2.5);
  });

  it('keeps the LAST quota — including one that rode an unreadable poll', async () => {
    const tracker = trackerOver([
      { kind: 'empty', quota: QUOTA },
      { kind: 'unavailable', reason: 'rollout-unreadable', quota: { ...QUOTA, usedPercent: 44 } },
      { kind: 'sample', usedTokens: 9 },
    ]);
    expect(tracker.providerQuota).toBeNull();

    tracker.maybeRefresh();
    await settle();
    expect(tracker.providerQuota).toEqual(QUOTA);

    // A level, not a flow: the newest reading replaces the previous outright.
    tracker.maybeRefresh();
    await settle();
    expect(tracker.providerQuota).toMatchObject({ usedPercent: 44 });

    // …and a read that carries none is a silence, not a retraction.
    tracker.maybeRefresh();
    await settle();
    expect(tracker.providerQuota).toMatchObject({ usedPercent: 44 });
  });

  it('does not let a context reset clear an ACCOUNT quota', async () => {
    const tracker = trackerOver([{ kind: 'sample', usedTokens: 5, quota: QUOTA }]);
    tracker.maybeRefresh();
    await settle();
    tracker.markStale();
    // A `/clear` throws away a context, not an account's consumption.
    expect(tracker.providerQuota).toEqual(QUOTA);
  });

  it('hands out a COPY, so a caller cannot poison the tracker', async () => {
    const tracker = trackerOver([{ kind: 'sample', usedTokens: 5, quota: QUOTA }]);
    tracker.maybeRefresh();
    await settle();
    const first = tracker.providerQuota;
    if (first) first.usedPercent = 100;
    expect(tracker.providerQuota).toMatchObject({ usedPercent: 12 });
  });
});

describe('Session — the reported bill', () => {
  const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it('switches the basis to `reported`, and the reported figure WINS', () => {
    const s = makeSession({ contextUsage: { ttlMs: 0, costRates: () => RATES } });
    s.recordTokenUsage({ in: 1_000_000, out: 100_000, cacheRead: 2_000_000, cacheWrite: 0 });
    // The estimate the catalogue would produce for exactly these tokens.
    expect(s.toView().tokenUsage).toMatchObject({ costUsd: 8.5, costBasis: 'estimated' });

    // opencode then tells us what it actually cost. Its arithmetic is done
    // against the provider's real billing rules, so it outranks ours outright
    // — it is not averaged with it, and it is not ignored for being smaller.
    s.recordReportedCost(0.42);
    expect(s.toView().tokenUsage).toMatchObject({
      in: 1_000_000,
      cacheRead: 2_000_000,
      costUsd: 0.42,
      costBasis: 'reported',
    });
  });

  it('prices a model the catalogue has never heard of', () => {
    // The reported path consults no rate card at all, which is exactly why it
    // survives a cold catalogue and an unknown model.
    const s = makeSession({ contextUsage: { ttlMs: 0, costRates: () => null } });
    s.recordTokenUsage({ in: 10, out: 10, cacheRead: 0, cacheWrite: 0 });
    expect(s.toView().tokenUsage).toMatchObject({ costUsd: null, costBasis: 'estimated' });
    s.recordReportedCost(0.00016725);
    expect(s.toView().tokenUsage).toMatchObject({
      costUsd: 0.00016725,
      costBasis: 'reported',
    });
  });

  it('accumulates deltas, unforced, and ignores the ones that are not spend', () => {
    let forced: boolean[] = [];
    const s = makeSession({ onStateChange: (_s, force) => forced.push(force) });
    forced = [];
    s.recordReportedCost(0.1);
    s.recordReportedCost(0.05);
    expect(s.reportedCostUsd).toBeCloseTo(0.15, 10);
    expect(forced.every((f) => f === false)).toBe(true);

    const before = forced.length;
    s.recordReportedCost(0);
    s.recordReportedCost(-1);
    s.recordReportedCost(Number.NaN);
    expect(s.reportedCostUsd).toBeCloseTo(0.15, 10);
    expect(forced).toHaveLength(before);
  });

  it('shows the bill on a reported cost ALONE', () => {
    // A provider could quote a price for a request whose counters we never got.
    // `—` would be a lie: we hold a figure.
    const s = makeSession();
    expect(s.toView().tokenUsage).toBeUndefined();
    s.recordReportedCost(0.02);
    expect(s.toView().tokenUsage).toMatchObject({
      in: 0,
      costUsd: 0.02,
      costBasis: 'reported',
    });
  });

  it('seeds from a resumed row, and clamps a corrupt one', () => {
    const resumed = makeSession({ reportedCostUsd: 1.5 });
    expect(resumed.reportedCostUsd).toBe(1.5);
    expect(resumed.toView().tokenUsage).toMatchObject({ costUsd: 1.5, costBasis: 'reported' });
    resumed.recordReportedCost(0.5);
    expect(resumed.reportedCostUsd).toBe(2);

    expect(makeSession({ reportedCostUsd: -3 }).reportedCostUsd).toBe(0);
    expect(makeSession({ reportedCostUsd: null }).reportedCostUsd).toBe(0);
    expect(makeSession({ reportedCostUsd: Number.NaN }).reportedCostUsd).toBe(0);
  });

  it('keeps the reported bill on the view of a TERMINATED session', () => {
    // This view is what the final DB write is built from.
    const s = makeSession();
    s.recordReportedCost(0.75);
    s.stop('done', 0);
    expect(s.toView().tokenUsage).toMatchObject({ costUsd: 0.75, costBasis: 'reported' });
  });
});

describe('persistence — the reported cost column', () => {
  it('round-trips a sub-cent bill through sessionToRow / rowToSessionView', () => {
    const s = makeSession();
    s.recordTokenUsage({ in: 11, out: 22, cacheRead: 33, cacheWrite: 44 });
    s.recordReportedCost(0.00016725);
    const row = sessionToRow(s.toView(), null);
    // REAL, not INTEGER — a floor here would report a day's work as free.
    expect(row.reported_cost_usd).toBe(0.00016725);
    expect(rowToSessionView(row).tokenUsage).toEqual({
      in: 11,
      out: 22,
      cacheRead: 33,
      cacheWrite: 44,
      costUsd: 0.00016725,
      costBasis: 'reported',
    });
  });

  it('writes NULL for an ESTIMATED cost — that one is never stored', () => {
    // An estimate is a function of the tokens and a live rate card: storing it
    // would only freeze what a model cost on the day it ran.
    const s = makeSession({
      contextUsage: { ttlMs: 0, costRates: () => ({ input: 5, output: 25, cacheRead: null, cacheWrite: null }) },
    });
    s.recordTokenUsage({ in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 });
    const row = sessionToRow(s.toView(), null);
    expect(s.toView().tokenUsage).toMatchObject({ costUsd: 5, costBasis: 'estimated' });
    expect(row.reported_cost_usd).toBeNull();

    // And a session that measured nothing at all writes NULL too.
    expect(sessionToRow(makeSession().toView(), null).reported_cost_usd).toBeNull();
  });

  it('serves a reported cost even with no rate card, and beats one that exists', () => {
    const row = { ...baseRow(), tokens_in: 1_000_000, tokens_out: 0, reported_cost_usd: 0.31 };
    expect(rowToSessionView(row).tokenUsage).toMatchObject({
      costUsd: 0.31,
      costBasis: 'reported',
    });
    // The rate card would have said $5. The provider said $0.31.
    const priced = rowToSessionView(row, () => ({
      input: 5,
      output: 25,
      cacheRead: null,
      cacheWrite: null,
    }));
    expect(priced.tokenUsage).toMatchObject({ costUsd: 0.31, costBasis: 'reported' });
  });

  it('shows a bill for a row whose ONLY figure is a reported cost', () => {
    const row = { ...baseRow(), reported_cost_usd: 0.05 };
    expect(rowToSessionView(row).tokenUsage).toEqual({
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.05,
      costBasis: 'reported',
    });
    // …while a row with nothing at all still says nothing.
    expect(rowToSessionView(baseRow()).tokenUsage).toBeUndefined();
  });

  it('ignores a corrupt column rather than reporting a negative bill', () => {
    expect(rowToSessionView({ ...baseRow(), tokens_in: 5, reported_cost_usd: -2 }).tokenUsage)
      .toMatchObject({ costBasis: 'estimated' });
    expect(rowToSessionView({ ...baseRow(), tokens_in: 5, reported_cost_usd: 0 }).tokenUsage)
      .toMatchObject({ costBasis: 'estimated' });
  });

  it('carries a real reported bill through row → seed → session, unchanged', () => {
    // The restart path. Unlike the tokens, this figure cannot be recomputed
    // from anything we keep: losing it here loses it for good.
    const s = makeSession();
    s.recordTokenUsage({ in: 1_234, out: 56, cacheRead: 7_890, cacheWrite: 12 });
    s.recordReportedCost(3.25);
    const row = sessionToRow(s.toView(), null);
    const resumed = makeSession({
      tokenUsage: sessionRowTokenSeed(row),
      reportedCostUsd: row.reported_cost_usd,
    });
    expect(resumed.tokenUsage).toEqual({ in: 1_234, out: 56, cacheRead: 7_890, cacheWrite: 12 });
    expect(resumed.reportedCostUsd).toBe(3.25);
    expect(resumed.toView().tokenUsage).toMatchObject({ costUsd: 3.25, costBasis: 'reported' });
  });
});

describe('Session — providerQuota on the view', () => {
  /** A `token_count` whose `info` is null: the spike's rate-limit-only refresh. */
  const RATE_LIMIT_ONLY = JSON.stringify({
    timestamp: '2026-08-30T13:43:07.100Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 1, window_minutes: 300, resets_at: 1_788_114_884 },
        secondary: { used_percent: 0, window_minutes: 10_080, resets_at: 1_788_701_684 },
        plan_type: 'plus',
      },
    },
  });

  function sessionOn(providerId: string): Session {
    const configDir = path.join(tmpRoot, `cfg-${providerId}`);
    fs.mkdirSync(configDir, { recursive: true });
    return makeSession({
      provider: new FakeProvider({
        id: providerId,
        sessionConfig: () => ({ configDir, cleanupPaths: [] }),
      }),
      contextUsage: {
        ttlMs: 1,
        readTail: async () => RATE_LIMIT_ONLY,
        listRollouts: async () => [{ path: '/h/sessions/rollout.jsonl', mtimeMs: 1 }],
      },
    });
  }

  it('serves the account quota for a codex session', async () => {
    const s = sessionOn('codex');
    expect(s.toView().providerQuota).toBeUndefined();

    s.maybeRefreshContextUsage();
    await waitUntil(() => s.providerQuota !== null);
    // Note what this proves: the rollout holds NO usage event at all, so there
    // is no gauge and no bill — and the quota still comes through, off the very
    // events Lot 6 skips.
    expect(s.toView().providerQuota).toEqual({
      usedPercent: 1,
      resetsAt: '2026-08-30T18:34:44.000Z',
      plan: 'plus',
    });
    expect(s.contextUsage).toBeNull();
    expect('contextUsage' in s.toView()).toBe(false);
    expect(s.toView().tokenUsage).toBeUndefined();
  });

  it('says nothing for the providers that report no quota', async () => {
    for (const id of ['opencode', 'gemini']) {
      const s = sessionOn(id);
      s.maybeRefreshContextUsage();
      await new Promise((r) => setTimeout(r, 30));
      const view = s.toView();
      expect(view.providerQuota).toBeUndefined();
      // Absent, not `null` — a consumer that predates the field is unaffected.
      expect('providerQuota' in view).toBe(false);
    }
  });

  it('says nothing for a claude session, transcript and all', async () => {
    const file = path.join(tmpRoot, 'quota-claude.jsonl');
    fs.writeFileSync(file, `${assistantLine({ id: 'q1', input: 10, output: 5 })}\n`);
    const s = makeSession({ contextUsage: { ttlMs: 1, readTail: async () => null } });
    s.setTranscriptPath(file);
    s.maybeRefreshContextUsage();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.providerQuota).toBeNull();
    expect('providerQuota' in s.toView()).toBe(false);
  });

  it('drops it the moment the session is no longer live', async () => {
    // A rolling-window percentage read before an agent exited is not a quota,
    // it is a fossil — and unlike the bill, nothing persists it.
    const s = sessionOn('codex');
    s.maybeRefreshContextUsage();
    await waitUntil(() => s.providerQuota !== null);
    expect(s.toView().providerQuota).toBeDefined();

    s.stop('done', 0);
    const view = s.toView();
    expect(view.providerQuota).toBeUndefined();
    expect('providerQuota' in view).toBe(false);
    // The tracker still holds it — it is the VIEW that refuses to serve it.
    expect(s.providerQuota).not.toBeNull();
    // …and the bill, which is not a fossil, survives untouched.
    expect(sessionToRow(view, null).reported_cost_usd).toBeNull();
  });
});
