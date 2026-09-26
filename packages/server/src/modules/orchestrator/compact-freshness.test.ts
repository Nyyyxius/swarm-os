import { describe, it, expect } from 'vitest';
import {
  ContextUsageTracker,
  TranscriptContextSource,
  scanTranscriptRange,
  type TranscriptRangeReader,
} from './context-usage.js';
import { decideAutoCompact } from './auto-compact.js';

/**
 * v0.10.3 — "the context gauge often stays unchanged after a compact".
 *
 * Root cause, measured on real transcripts (CLI 2.1.2xx): a compaction does NOT
 * rewrite the file, it APPENDS a `system/compact_boundary` line (then the
 * summary). No assistant line follows until the next call, so the incremental
 * reader kept serving the last pre-compact turn — and the tracker accepted it
 * as a FRESH sample. After a server-fired `/compact`, the very next read did
 * exactly that before the boundary had even landed.
 *
 * The contract pinned here: after a compact or a clear, the gauge NEVER shows
 * the old context. It shows an explicit "reset, awaiting the next call" state
 * (`awaitingCall`, `usedTokens: null`), then the real figure at the first call.
 * `compactMetadata.postTokens` is NOT used as a figure: it is the summary alone
 * (~5-11 K measured) while the first call after it sends ~80-110 K.
 */

const T = '/agent/t.jsonl';
const BASE = Date.parse('2026-09-26T10:00:00.000Z');

function assistant(id: string, ctx: number, atMs: number, sidechain = false): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    timestamp: new Date(atMs).toISOString(),
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 10, output_tokens: 0 },
    },
  });
}

function boundary(atMs: number, sidechain = false): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    isSidechain: sidechain,
    timestamp: new Date(atMs).toISOString(),
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 150_000, postTokens: 6_000 },
  });
}

function summary(atMs: number): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    isCompactSummary: true,
    timestamp: new Date(atMs).toISOString(),
    message: { role: 'user', content: 'This session is being continued…' },
  });
}

function rangeOver(files: Record<string, string>): TranscriptRangeReader {
  return async (p, offset, max) => {
    const body = files[p];
    if (body === undefined) return null;
    const buf = Buffer.from(body, 'utf8');
    if (offset >= buf.length) return { text: '', bytes: 0, size: buf.length };
    const slice = buf.subarray(offset, Math.min(buf.length, offset + max));
    return { text: slice.toString('utf8'), bytes: slice.length, size: buf.length };
  };
}

function setup(opts: { withRange?: boolean } = {}) {
  const files: Record<string, string> = { [T]: `${assistant('m1', 150_000, BASE)}\n` };
  let clock = BASE + 1_000;
  const now = () => clock;
  const source = new TranscriptContextSource({
    ...(opts.withRange === false ? {} : { readRange: rangeOver(files) }),
    readTail: async (p) => files[p] ?? null,
    now,
  });
  source.retarget(T);
  const tracker = new ContextUsageTracker({
    sessionId: 's',
    ttlMs: 3_600_000,
    limitTokens: () => 200_000,
    source,
    now,
  });
  return {
    files,
    tracker,
    tick: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
  };
}

describe('scanTranscriptRange — compact boundaries', () => {
  it('a boundary AFTER the last turn means "compacted, no call since"', () => {
    const scan = scanTranscriptRange(`${assistant('a', 150_000, BASE)}\n${boundary(BASE + 1)}\n${summary(BASE + 2)}\n`);
    expect(scan.compacted).toBe(true);
  });

  it('a turn after the boundary is the new figure', () => {
    const scan = scanTranscriptRange(`${boundary(BASE)}\n${assistant('b', 90_000, BASE + 5)}\n`);
    expect(scan.compacted).toBe(false);
    expect(scan.gaugeUsedTokens).toBe(90_000);
    expect(scan.gaugeAt).toBe(BASE + 5);
  });

  it('a sub-agent’s boundary is not this agent’s', () => {
    const scan = scanTranscriptRange(`${assistant('a', 150_000, BASE)}\n${boundary(BASE + 1, true)}\n`);
    expect(scan.compacted).toBe(false);
  });
});

describe('the gauge after a compaction the CLI did by itself (no server reset)', () => {
  it('drops the old figure at the boundary, then shows the first real call', async () => {
    const { files, tracker } = setup();
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 150_000, stale: false });

    files[T] += `${boundary(BASE + 2_000)}\n${summary(BASE + 2_001)}\n`;
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({
      usedTokens: null, pct: null, stale: true, awaitingCall: 'compact',
    });

    files[T] += `${assistant('m2', 92_000, BASE + 3_000)}\n`;
    await tracker.catchUp();
    const snap = tracker.snapshot();
    expect(snap).toMatchObject({ usedTokens: 92_000, stale: false });
    expect(snap?.awaitingCall).toBeUndefined();
  });

  it('works on the tail path too (no ranged reader)', async () => {
    const { files, tracker } = setup({ withRange: false });
    await tracker.catchUp();
    expect(tracker.snapshot()?.usedTokens).toBe(150_000);
    files[T] += `${boundary(BASE + 2_000)}\n`;
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: null, awaitingCall: 'compact' });
  });
});

describe('the gauge after a server-fired /compact', () => {
  it('never re-serves the pre-compact figure while the compaction runs', async () => {
    const { files, tracker, tick, at } = setup();
    await tracker.catchUp();
    expect(tracker.snapshot()?.usedTokens).toBe(150_000);

    // `/compact` reaches the PTY. Compaction takes a minute; the file does not
    // change meanwhile — this read used to come back "fresh" at 150 K.
    tick(1_000);
    tracker.markStale('compact');
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: null, stale: true, awaitingCall: 'compact' });

    tick(60_000);
    files[T] += `${boundary(at())}\n${summary(at() + 1)}\n`;
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: null, awaitingCall: 'compact' });

    tick(5_000);
    files[T] += `${assistant('m2', 88_000, at())}\n`;
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 88_000, stale: false });
  });

  it('a /compact the CLI refuses resolves at the next call, with the full figure', async () => {
    const { files, tracker, tick, at } = setup();
    await tracker.catchUp();
    tick(1_000);
    tracker.markStale('compact');
    await tracker.catchUp();
    expect(tracker.snapshot()?.awaitingCall).toBe('compact');
    // "Not enough messages to compact": no boundary, the agent just goes on.
    tick(10_000);
    files[T] += `${assistant('m2', 151_000, at())}\n`;
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 151_000, stale: false });
  });

  it('refuses a pre-reset line even on the tail path', async () => {
    const { tracker, tick } = setup({ withRange: false });
    await tracker.catchUp();
    tick(1_000);
    tracker.markStale('compact');
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: null, awaitingCall: 'compact' });
  });
});

describe('the gauge after /clear', () => {
  it('shows "cleared, awaiting a call" until the new transcript has a turn', async () => {
    const { files, tracker, at } = setup();
    await tracker.catchUp();
    files['/agent/new.jsonl'] = '';
    tracker.retarget('/agent/new.jsonl');
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: null, awaitingCall: 'clear' });
    files['/agent/new.jsonl'] = `${assistant('n1', 30_000, at() + 1)}\n`;
    await tracker.catchUp();
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 30_000, stale: false });
  });
});

describe('auto-compact never acts on a reset that has not been followed by a call', () => {
  it('answers `stale`', () => {
    const decision = decideAutoCompact({
      thresholdPct: 35,
      usage: {
        usedTokens: null, limitTokens: 200_000, pct: null, basis: 'transcript',
        updatedAt: new Date(BASE).toISOString(), stale: true, awaitingCall: 'compact',
      },
      floorTokens: null,
      inboxCount: 0,
      resetPending: false,
      dialogPending: false,
    });
    expect(decision).toEqual({ fire: false, reason: 'stale' });
  });
});
