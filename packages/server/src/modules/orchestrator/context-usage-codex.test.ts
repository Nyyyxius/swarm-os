import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodexRolloutSource,
  codexTokenDelta,
  createLocalRolloutLister,
  createSshRolloutLister,
  parseCodexRateLimitsFromTail,
  parseContextUsageFromCodexRolloutTail,
  pickCodexRollout,
  type RolloutFile,
} from './context-usage-codex.js';
import { ContextUsageTracker, type TranscriptTailReader } from './context-usage.js';
import { Session } from './session.js';
import { Orchestrator } from './index.js';
import { NoOpPersistence } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { Config } from '../../config.js';

/**
 * Monitoring, Lot 6 (docs/monitoring-agents.md) — context usage of a codex
 * session, read from the rollout JSONL codex writes into the per-session
 * `CODEX_HOME` swarm-os already owns.
 *
 * Every fixture below is shaped after the events the spike actually captured
 * (`scripts/verify-codex-rollout.report.md` §R2/R4), traps included — because
 * the traps are the whole difficulty here. Two counters share a name and differ
 * by 45×; `info` is genuinely `null` on some events; and the file the tracker
 * must read does not exist at boot, then quietly stops being the right one after
 * a `/new` while remaining perfectly readable.
 */

// ---------------------------------------------------------------------------
// Rollout fixtures — verbatim shapes from R2
// ---------------------------------------------------------------------------

function usageEvent(opts: {
  /** `last_token_usage.total_tokens` — the one number that means occupancy. */
  last?: number;
  /** `total_token_usage.total_tokens` — the cumulative billing counter. */
  cumulative?: number;
  window?: number | null;
  timestamp?: string;
  /** Drop `total_tokens` to exercise the input+output fallback. */
  omitTotal?: boolean;
  cachedInput?: number;
}): string {
  const last = opts.last ?? 11_626;
  const info: Record<string, unknown> = {
    total_token_usage: {
      input_tokens: opts.cumulative ?? last,
      cached_input_tokens: 2304,
      output_tokens: 35,
      reasoning_output_tokens: 27,
      total_tokens: opts.cumulative ?? last,
    },
    last_token_usage: {
      input_tokens: last - 35,
      cached_input_tokens: opts.cachedInput ?? 2304,
      output_tokens: 35,
      reasoning_output_tokens: 27,
      ...(opts.omitTotal ? {} : { total_tokens: last }),
    },
    ...(opts.window === null ? {} : { model_context_window: opts.window ?? 258_400 }),
  };
  return JSON.stringify({
    timestamp: opts.timestamp ?? '2026-08-30T13:43:06.986Z',
    type: 'event_msg',
    payload: { type: 'token_count', info, rate_limits: RATE_LIMITS },
  });
}

/**
 * What `RATE_LIMITS` below must parse into (Lot 13). `resets_at` is an epoch in
 * SECONDS, and 18:34:44Z is exactly the "5h limit … (resets 18:34)" the spike's
 * own `/status` printed for this rollout — the unit is measured, not assumed.
 */
const QUOTA = {
  usedPercent: 1,
  resetsAt: '2026-08-30T18:34:44.000Z',
  plan: 'plus',
};

const RATE_LIMITS = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 1, window_minutes: 300, resets_at: 1_788_114_884 },
  secondary: { used_percent: 0, window_minutes: 10_080, resets_at: 1_788_701_684 },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  plan_type: 'plus',
  rate_limit_reached_type: null,
};

/**
 * TRAP 1 — a `token_count` whose `info` is genuinely `null`. Two of the eight
 * events in the spike run were these rate-limit-only refreshes.
 */
const RATE_LIMIT_ONLY_EVENT = JSON.stringify({
  timestamp: '2026-08-30T13:43:07.100Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: RATE_LIMITS },
});

/** The other payload types the spike saw on the same file. */
const ROLLOUT_NOISE = [
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
  JSON.stringify({ type: 'turn_context', payload: { cwd: '/work' } }),
];

const THREAD_A = '01a052e8-bad9-7f13-a9e0-e89f692a9bd8';
const THREAD_B = '01a052e9-2de2-7012-92ae-74e66eb1d478';

function rolloutName(threadId: string, stamp = '2026-08-30T13-42-59'): string {
  return `rollout-${stamp}-${threadId}.jsonl`;
}

// ---------------------------------------------------------------------------
// 1. The parser — where a wrong NUMBER would come from
// ---------------------------------------------------------------------------

describe('parseContextUsageFromCodexRolloutTail', () => {
  it('reads last_token_usage.total_tokens and the window off the newest event', () => {
    const tail = [usageEvent({ last: 11_626 }), ...ROLLOUT_NOISE].join('\n');
    expect(parseContextUsageFromCodexRolloutTail(tail)).toEqual({
      usedTokens: 11_626,
      limitTokens: 258_400,
      at: Date.parse('2026-08-30T13:43:06.986Z'),
      // Lot 11 — the cumulative counter rides along for BILLING, which is the
      // one question it answers correctly. `cached_input_tokens` is a subset of
      // `input_tokens`, so `in` is the difference and `cacheRead` the rest.
      totals: { in: 11_626 - 2304, out: 35, cacheRead: 2304, cacheWrite: 0 },
    });
  });

  it('NEVER reads total_token_usage — 45× the window on a real rollout', () => {
    // The measured extreme: 11 724 290 cumulative against a 258 400 window. A
    // gauge on that field reads 4 500 %, and it would look like a real reading.
    const tail = usageEvent({ last: 118_675, cumulative: 11_724_290, window: 258_400 });
    const parsed = parseContextUsageFromCodexRolloutTail(tail);
    expect(parsed?.usedTokens).toBe(118_675);
    expect(parsed?.usedTokens).not.toBe(11_724_290);
    // The honest raw ratio: 45.9 % used, not 4 537 %.
    expect(parsed!.usedTokens / parsed!.limitTokens!).toBeCloseTo(0.459, 3);
  });

  it('skips a token_count whose info is null instead of reading it as 0', () => {
    // TRAP 1. These arrive between real requests; reading one as zero drops the
    // gauge to 0 % at random, which is indistinguishable from a fresh /clear.
    const tail = [usageEvent({ last: 11_626 }), RATE_LIMIT_ONLY_EVENT].join('\n');
    expect(parseContextUsageFromCodexRolloutTail(tail)?.usedTokens).toBe(11_626);
  });

  it('keeps the LATEST event and never accumulates', () => {
    // One turn emits one event per MODEL REQUEST, and consecutive events can
    // repeat identical numbers. Each already describes the whole conversation.
    const tail = [
      usageEvent({ last: 11_612 }),
      usageEvent({ last: 11_652, timestamp: '2026-08-30T13:43:29.000Z' }),
    ].join('\n');
    const parsed = parseContextUsageFromCodexRolloutTail(tail);
    expect(parsed?.usedTokens).toBe(11_652);
    expect(parsed?.at).toBe(Date.parse('2026-08-30T13:43:29.000Z'));
  });

  it('ignores the partial first line a `tail -c` always produces', () => {
    const tail = ['token_usage":{"total_toke', usageEvent({ last: 9_000 })].join('\n');
    expect(parseContextUsageFromCodexRolloutTail(tail)?.usedTokens).toBe(9_000);
  });

  it('falls back to input+output, and never adds cached_input_tokens', () => {
    // `cached_input_tokens` is a SUBSET of `input_tokens` (prompt cache), so
    // summing it double-counts. Here: input 8965 + output 35 = 9000, and the
    // 2304 cached tokens must not appear anywhere in the answer.
    const parsed = parseContextUsageFromCodexRolloutTail(
      usageEvent({ last: 9_000, omitTotal: true, cachedInput: 2_304 }),
    );
    expect(parsed?.usedTokens).toBe(9_000);
  });

  it('answers null for a tail with no usage-bearing event', () => {
    expect(parseContextUsageFromCodexRolloutTail(ROLLOUT_NOISE.join('\n'))).toBeNull();
    expect(parseContextUsageFromCodexRolloutTail(RATE_LIMIT_ONLY_EVENT)).toBeNull();
    expect(parseContextUsageFromCodexRolloutTail('')).toBeNull();
    expect(parseContextUsageFromCodexRolloutTail('not json at all')).toBeNull();
  });

  it('reports no window rather than a made-up one when the event omits it', () => {
    const parsed = parseContextUsageFromCodexRolloutTail(usageEvent({ window: null }));
    expect(parsed?.limitTokens).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Resolution — thread-id vs mtime, i.e. the lazy-creation trap
// ---------------------------------------------------------------------------

describe('pickCodexRollout', () => {
  const older: RolloutFile = { path: `/h/sessions/2026/08/30/${rolloutName(THREAD_A)}`, mtimeMs: 100 };
  const newer: RolloutFile = {
    path: `/h/sessions/2026/08/30/${rolloutName(THREAD_B, '2026-08-30T13-43-28')}`,
    mtimeMs: 200,
  };

  it('matches the thread exactly, even when another file is more recent', () => {
    expect(pickCodexRollout([older, newer], THREAD_A)).toBe(older.path);
    expect(pickCodexRollout([older, newer], THREAD_B)).toBe(newer.path);
  });

  it('answers null — never the stale newest file — while the new rollout is missing', () => {
    // TRAP 3, and the reason the thread-id exists at all. After a `/new` the new
    // rollout is created LAZILY (at the next model request) while its NAME
    // already carries the reset's timestamp. "Most recent" therefore resolves to
    // the previous file: complete, plausible, and describing a dead thread.
    expect(pickCodexRollout([older], THREAD_B)).toBeNull();
  });

  it('falls back to the newest mtime only while no thread is known', () => {
    expect(pickCodexRollout([older, newer], null)).toBe(newer.path);
    expect(pickCodexRollout([newer, older], null)).toBe(newer.path);
  });

  it('answers null for an empty listing (the boot state)', () => {
    expect(pickCodexRollout([], THREAD_A)).toBeNull();
    expect(pickCodexRollout([], null)).toBeNull();
  });
});

describe('rollout listers', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-codex-roll-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('walks sessions/YYYY/MM/DD and reports each rollout with its mtime', async () => {
    const day = path.join(root, 'sessions', '2026', '08', '30');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, rolloutName(THREAD_A)), 'x');
    fs.writeFileSync(path.join(day, 'something-else.json'), 'x');
    const files = await createLocalRolloutLister()(path.join(root, 'sessions'));
    expect(files).toHaveLength(1);
    expect(path.basename(files[0]!.path)).toBe(rolloutName(THREAD_A));
    expect(files[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it('answers an empty list for the directory that does not exist yet', async () => {
    // TRAP 2 — the boot state. A control run that spawned the TUI and typed
    // nothing never saw a rollout appear: the file is born of the first model
    // request, and its absence is a phase, not a failure.
    expect(await createLocalRolloutLister()(path.join(root, 'sessions'))).toEqual([]);
  });

  it('shells out to a bounded find over ssh and parses `%T@\\t<path>`', async () => {
    const calls: string[][] = [];
    const lister = createSshRolloutLister({ agentTransport: 'ssh' } as Config, {
      hostExec: async (_c, input) => {
        calls.push(input.argv);
        return {
          code: 0,
          stdout: `1788098024.5\t/host/sessions/2026/08/30/${rolloutName(THREAD_A)}\n`,
          stderr: '',
          timedOut: false,
        };
      },
    });
    const files = await lister('/host/sessions');
    expect(files).toEqual([
      { path: `/host/sessions/2026/08/30/${rolloutName(THREAD_A)}`, mtimeMs: 1_788_098_024_500 },
    ]);
    expect(calls[0]).toEqual([
      'find',
      '/host/sessions',
      '-type',
      'f',
      '-name',
      'rollout-*.jsonl',
      '-printf',
      '%T@\t%p\n',
    ]);
  });

  it('retries without `-printf` when the host find does not support it', async () => {
    // Losing the mtimes costs nothing once a thread-id is known: an exact
    // filename match needs no ordering at all.
    let call = 0;
    const lister = createSshRolloutLister({ agentTransport: 'ssh' } as Config, {
      hostExec: async () => {
        call++;
        return call === 1
          ? { code: 1, stdout: '', stderr: 'find: unknown predicate', timedOut: false }
          : { code: 0, stdout: `/host/${rolloutName(THREAD_A)}\n`, stderr: '', timedOut: false };
      },
    });
    expect(await lister('/host/sessions')).toEqual([
      { path: `/host/${rolloutName(THREAD_A)}`, mtimeMs: 0 },
    ]);
  });

  it('answers an empty list — never throws — when the host is unreachable', async () => {
    const lister = createSshRolloutLister({ agentTransport: 'ssh' } as Config, {
      hostExec: async () => {
        throw new Error('host-exec requires the ssh agent transport');
      },
    });
    expect(await lister('/host/sessions')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The source — the four traps, end to end
// ---------------------------------------------------------------------------

/** A lister whose answer a test can change between reads. */
function mutableLister(): {
  lister: (dir: string) => Promise<readonly RolloutFile[]>;
  files: RolloutFile[];
  dirs: string[];
} {
  const state = { files: [] as RolloutFile[], dirs: [] as string[] };
  return {
    files: state.files,
    dirs: state.dirs,
    lister: async (dir: string) => {
      state.dirs.push(dir);
      return state.files;
    },
  };
}

function tailOf(bodies: Record<string, string>): TranscriptTailReader {
  return async (filePath) => bodies[filePath] ?? null;
}

describe('CodexRolloutSource', () => {
  const pathA = `/h/sessions/2026/08/30/${rolloutName(THREAD_A)}`;
  const pathB = `/h/sessions/2026/08/30/${rolloutName(THREAD_B, '2026-08-30T13-43-28')}`;

  it('tolerates the missing rollout at boot, then reports it once it appears', async () => {
    const { lister, files, dirs } = mutableLister();
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: tailOf({ [pathA]: usageEvent({ last: 11_626 }) }),
    });
    // Boot: the CODEX_HOME exists, the rollout does not.
    expect(await source.read()).toEqual({ kind: 'empty' });
    expect(dirs[0]).toBe('/h/sessions');

    files.push({ path: pathA, mtimeMs: 100 });
    expect(await source.read()).toMatchObject({
      kind: 'sample',
      usedTokens: 11_626,
      limitTokens: 258_400,
    });
  });

  it('follows the thread-id, not the newest file, after a /new', async () => {
    const { lister, files } = mutableLister();
    files.push({ path: pathA, mtimeMs: 100 });
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: tailOf({
        [pathA]: usageEvent({ last: 11_626 }),
        [pathB]: usageEvent({ last: 7_000, timestamp: '2026-08-30T13:43:45.000Z' }),
      }),
    });
    source.retarget(THREAD_A);
    expect(await source.read()).toMatchObject({ usedTokens: 11_626 });

    // `/new` fires. The new thread's rollout has not materialised yet, and the
    // old file is still sitting there being perfectly readable.
    source.invalidate();
    // Lot 13 — the quota rides an `empty` too: it comes off the same tail, and
    // a context reset has no opinion about an account's consumption.
    expect(await source.read()).toEqual({ kind: 'empty', quota: QUOTA });

    // `notify` reports the new thread, and its file finally exists.
    expect(source.retarget(THREAD_B)).toBe(true);
    files.push({ path: pathB, mtimeMs: 200 });
    expect(await source.read()).toMatchObject({ kind: 'sample', usedTokens: 7_000 });
    expect(source.target).toBe(THREAD_B);
  });

  it('refuses to re-report the PRE-compaction event, then reports the new one', async () => {
    // `/compact` keeps the same thread and the same file, so the pre-reset
    // number stays right where the tracker last read it. Without the guard the
    // very next poll would serve it again and mark it FRESH.
    const bodies: Record<string, string> = { [pathA]: usageEvent({ last: 118_675 }) };
    const { lister, files } = mutableLister();
    files.push({ path: pathA, mtimeMs: 100 });
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: async (p) => bodies[p] ?? null,
    });
    source.retarget(THREAD_A);
    expect(await source.read()).toMatchObject({ usedTokens: 118_675 });

    source.invalidate();
    // Lot 13 — the quota rides an `empty` too: it comes off the same tail, and
    // a context reset has no opinion about an account's consumption.
    expect(await source.read()).toEqual({ kind: 'empty', quota: QUOTA });

    // The compaction's own request lands, with a strictly newer timestamp.
    bodies[pathA] = [
      usageEvent({ last: 118_675 }),
      usageEvent({ last: 12_100, timestamp: '2026-08-30T13:44:10.000Z' }),
    ].join('\n');
    expect(await source.read()).toMatchObject({ kind: 'sample', usedTokens: 12_100 });
  });

  it('reports `unavailable` when the rollout is there but cannot be read', async () => {
    const { lister, files } = mutableLister();
    files.push({ path: pathA, mtimeMs: 100 });
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: async () => null,
    });
    expect(await source.read()).toEqual({ kind: 'unavailable', reason: 'rollout-unreadable' });
  });

  it('is ready from the start — unlike claude, it has nothing to wait for', async () => {
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: async () => [],
    });
    expect(source.ready).toBe(true);
    expect(source.target).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3b. Lot 11 — the BILL, off the very counter the gauge refuses
// ---------------------------------------------------------------------------

describe('CodexRolloutSource — token deltas', () => {
  const pathA = `/h/sessions/2026/08/30/${rolloutName(THREAD_A)}`;
  const pathB = `/h/sessions/2026/08/30/${rolloutName(THREAD_B, '2026-08-30T13-43-28')}`;

  /** A rollout whose cumulative counter can be moved between reads. */
  function movable(): {
    source: CodexRolloutSource;
    bodies: Record<string, string>;
    files: RolloutFile[];
  } {
    const { lister, files } = mutableLister();
    const bodies: Record<string, string> = {};
    return {
      files,
      bodies,
      source: new CodexRolloutSource({
        sessionsDir: '/h/sessions',
        listRollouts: lister,
        readTail: tailOf(bodies),
      }),
    };
  }

  it('bills the WHOLE cumulative counter on the first read of a file', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    // 11 626 cumulative, of which 2 304 were served from the prompt cache.
    bodies[pathA] = usageEvent({ last: 11_626, cumulative: 11_626 });
    // Nothing has ever been billed for this file, so the base is zero and the
    // whole counter is the delta.
    expect(await source.read()).toMatchObject({
      tokens: { in: 11_626 - 2304, out: 35, cacheRead: 2304, cacheWrite: 0 },
    });
  });

  it('bills the DIFFERENCE on every later read, never the total again', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 10_000, cumulative: 10_000 });
    await source.read();

    // A turn later the cumulative counter has moved. Re-billing it whole would
    // multiply an agent's cost by the number of times we polled it.
    bodies[pathA] = usageEvent({
      last: 12_000,
      cumulative: 30_000,
      timestamp: '2026-08-30T13:44:00.000Z',
    });
    expect(await source.read()).toMatchObject({ tokens: { in: 20_000, out: 0 } });
  });

  it('says nothing at all when the counter has not moved', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 10_000, cumulative: 10_000 });
    await source.read();
    // Same file, same event: a zero delta is not a reading, it is silence — and
    // the tracker must not spend a state notification on it.
    expect(await source.read()).not.toHaveProperty('tokens');
  });

  it('re-bases SILENTLY on a counter that RECEDES under the same file', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 100_000, cumulative: 100_000 });
    await source.read();

    // A real `/new` shows up as a NEW rollout path (null base — billed in
    // full). The SAME path receding means the counter was rewritten under us:
    // everything up to 100 000 is already billed, so billing the rewritten
    // cumulative again would double-count. Err low: bill nothing, re-base.
    bodies[pathA] = usageEvent({
      last: 3_000,
      cumulative: 3_000,
      timestamp: '2026-08-30T13:45:00.000Z',
    });
    expect(await source.read()).not.toHaveProperty('tokens');
    // The base re-anchored on the rewritten counter: growth from there bills
    // the growth alone.
    bodies[pathA] = usageEvent({
      last: 5_000,
      cumulative: 5_000,
      timestamp: '2026-08-30T13:46:00.000Z',
    });
    const grown = await source.read();
    expect(grown.tokens).toBeDefined();
    const g = grown.tokens as { in: number; out: number; cacheRead: number; cacheWrite: number };
    expect(g.in + g.out + g.cacheRead + g.cacheWrite).toBe(2_000);
  });

  it('keeps one base per rollout file, so two threads cannot cross-bill', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 100_000, cumulative: 100_000 });
    source.retarget(THREAD_A);
    await source.read();

    // `/new`: another thread, another file, its own counter starting fresh.
    files.push({ path: pathB, mtimeMs: 200 });
    bodies[pathB] = usageEvent({
      last: 5_000,
      cumulative: 5_000,
      timestamp: '2026-08-30T13:45:00.000Z',
    });
    source.retarget(THREAD_B);
    expect(await source.read()).toMatchObject({ tokens: { in: 5_000 - 2304 } });

    // Back to A — whose counter has moved on by 500 since we last read it. A
    // single shared base would bill the 95 000 gap between two unrelated files.
    bodies[pathA] = usageEvent({
      last: 100_500,
      cumulative: 100_500,
      timestamp: '2026-08-30T13:46:00.000Z',
    });
    source.retarget(THREAD_A);
    expect(await source.read()).toMatchObject({ tokens: { in: 500, out: 0 } });
  });

  it('bills a pre-reset event the guard refuses to show as an occupancy', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 50_000, cumulative: 50_000 });
    source.retarget(THREAD_A);
    await source.read();

    // A `/compact` reached the PTY; the file still holds the PRE-reset event.
    source.invalidate();
    bodies[pathA] = usageEvent({ last: 50_000, cumulative: 62_000 });
    const reading = await source.read();
    // The gauge refuses it — it would re-bless a dead number as fresh…
    expect(reading.kind).toBe('empty');
    // …and the bill takes it anyway, because those tokens were paid for.
    expect(reading).toMatchObject({ tokens: { in: 12_000 } });
  });

  it('adopts the pre-restart total as a BASE on a resumed session', async () => {
    // The restart hazard, and the one that compounds: the running total comes
    // back from SQLite while the base it was measured against died with the
    // process. The session id survives a resume, so the CODEX_HOME is the same
    // directory and the frozen pre-restart rollout is still in it. Billing it
    // again would double the agent's cost at every redeploy, for ever.
    const { lister, files } = mutableLister();
    const bodies: Record<string, string> = {};
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 118_675, cumulative: 4_000_000 });
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: tailOf(bodies),
      resumed: true,
    });

    // Four million tokens already billed and persisted: not one of them again.
    expect(await source.read()).not.toHaveProperty('tokens');

    // …and the agent's NEXT turn is billed normally, from that base.
    bodies[pathA] = usageEvent({
      last: 120_000,
      cumulative: 4_050_000,
      timestamp: '2026-08-30T13:50:00.000Z',
    });
    expect(await source.read()).toMatchObject({ tokens: { in: 50_000, out: 0 } });
  });

  it('bills the first rollout in full on a FIRST spawn', async () => {
    // The mirror image: nothing has been billed for a brand-new session, so the
    // re-base must not fire and swallow its first turns.
    const { lister, files } = mutableLister();
    const bodies: Record<string, string> = {};
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 9_000, cumulative: 9_000 });
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: tailOf(bodies),
    });
    expect(await source.read()).toMatchObject({ tokens: { in: 9_000 - 2304 } });
  });

  it('re-bases only ONCE, and only the file it first landed on', async () => {
    const { lister, files } = mutableLister();
    const bodies: Record<string, string> = {};
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 100_000, cumulative: 1_000_000 });
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: lister,
      readTail: tailOf(bodies),
      resumed: true,
    });
    expect(await source.read()).not.toHaveProperty('tokens');

    // The resumed CLI opens a NEW thread. Its rollout has never been billed, so
    // it is billed in full — the re-base is spent and must not swallow it.
    files.push({ path: pathB, mtimeMs: 200 });
    bodies[pathB] = usageEvent({
      last: 6_000,
      cumulative: 6_000,
      timestamp: '2026-08-30T13:55:00.000Z',
    });
    source.retarget(THREAD_B);
    expect(await source.read()).toMatchObject({ tokens: { in: 6_000 - 2304 } });
  });

  it('keeps its base when the cumulative counter cannot be read', async () => {
    // A `total_token_usage` present but unreadable by these field names (an
    // upstream rename, a nesting change) must NOT be adopted as a base of zero
    // — the next event that did parse would then be billed in full a second
    // time, on top of everything already counted.
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = usageEvent({ last: 10_000, cumulative: 10_000 });
    await source.read();

    bodies[pathA] = JSON.stringify({
      timestamp: '2026-08-30T13:44:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 10_500 },
          // Same field, renamed underneath us.
          total_token_usage: { prompt_tokens: 30_000, completion_tokens: 500 },
          model_context_window: 258_400,
        },
      },
    });
    expect(await source.read()).not.toHaveProperty('tokens');

    // The base survived: only the genuine growth is billed.
    bodies[pathA] = usageEvent({
      last: 11_000,
      cumulative: 10_800,
      timestamp: '2026-08-30T13:45:00.000Z',
    });
    expect(await source.read()).toMatchObject({ tokens: { in: 800, out: 0 } });
  });

  it('reports nothing for an event that carries no cumulative counter', async () => {
    const { source, bodies, files } = movable();
    files.push({ path: pathA, mtimeMs: 100 });
    bodies[pathA] = JSON.stringify({
      timestamp: '2026-08-30T13:43:06.986Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 9_000 }, model_context_window: 258_400 },
      },
    });
    const reading = await source.read();
    expect(reading).toMatchObject({ kind: 'sample', usedTokens: 9_000 });
    expect(reading).not.toHaveProperty('tokens');
  });
});

describe('codexTokenDelta', () => {
  const base = { in: 10, out: 20, cacheRead: 30, cacheWrite: 0 };

  it('subtracts bucket by bucket', () => {
    expect(codexTokenDelta({ in: 15, out: 25, cacheRead: 40, cacheWrite: 0 }, base)).toEqual({
      in: 5,
      out: 5,
      cacheRead: 10,
      cacheWrite: 0,
    });
  });

  it('treats ANY receding bucket as already billed — zero delta, re-base', () => {
    // Only `cacheRead` went backwards, and that alone proves the counter was
    // rewritten under the SAME key (a fresh thread arrives under a new key,
    // base null). Everything up to `base` was billed: billing the rewritten
    // cumulative again would double-count — the delta is nothing.
    const current = { in: 11, out: 21, cacheRead: 1, cacheWrite: 0 };
    expect(codexTokenDelta(current, base)).toEqual({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('bills everything when there is no base yet', () => {
    expect(codexTokenDelta(base, null)).toEqual(base);
  });
});

describe('ContextUsageTracker on a codex source', () => {
  it("prefers the rollout's own window over the catalogue's figure", async () => {
    // codex reports its EFFECTIVE window (258 400) for a model whose own cache
    // advertises 272 000. The gauge must divide by what the CLI actually cuts
    // the agent off at.
    const tracker = new ContextUsageTracker({
      sessionId: 'sess-codex',
      ttlMs: 15_000,
      limitTokens: () => 272_000,
      source: new CodexRolloutSource({
        sessionsDir: '/h/sessions',
        listRollouts: async () => [{ path: '/h/r.jsonl', mtimeMs: 1 }],
        readTail: async () => usageEvent({ last: 118_675, window: 258_400 }),
      }),
    });
    tracker.maybeRefresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.snapshot()).toMatchObject({
      usedTokens: 118_675,
      limitTokens: 258_400,
      basis: 'transcript',
      stale: false,
    });
  });

  it('routes markStale through to the source guard', async () => {
    const source = new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: async () => [{ path: '/h/r.jsonl', mtimeMs: 1 }],
      readTail: async () => usageEvent({ last: 50_000 }),
    });
    const tracker = new ContextUsageTracker({
      sessionId: 'sess-codex',
      ttlMs: 0.0001,
      source,
    });
    tracker.maybeRefresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.snapshot()?.stale).toBe(false);

    tracker.markStale();
    tracker.maybeRefresh();
    await new Promise((r) => setTimeout(r, 20));
    // Same file, same event: the number is still the pre-reset one, so it stays
    // visible and stays STALE rather than being re-blessed as fresh.
    expect(tracker.snapshot()).toMatchObject({ usedTokens: 50_000, stale: true });
  });
});

// ---------------------------------------------------------------------------
// 4. Session wiring — no hook needed, and nothing for the other providers
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
    defaultModel: 'gpt-5.4-mini',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'codex',
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
    // Short on purpose: these tests drive the heartbeat by hand (`orch.toView()`)
    // and assert on what the NEXT poll reads. The production TTL is 15 s and is
    // exercised in `context-usage.test.ts`, where it is the subject.
    contextUsageTtlMs: 5,
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

/** A live team whose adapter answers with a per-session `CODEX_HOME`. */
function makeTeam(
  providerId: string,
  opts: { configDir?: string | null; config?: Partial<Config> } = {},
): { orch: Orchestrator; lead: Session } {
  const config = makeConfig(opts.config ?? {});
  const registry = new ProviderRegistry();
  registry.register(
    new FakeProvider({
      id: providerId,
      sessionConfig: () => ({
        configDir: opts.configDir === undefined ? path.join(tmpRoot, 'codex-home') : opts.configDir,
        cleanupPaths: [],
      }),
    }),
    { builtin: true },
  );
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

/** Materialise a rollout under the fake `CODEX_HOME`, as codex would. */
function writeRollout(threadId: string, body: string): string {
  const day = path.join(tmpRoot, 'codex-home', 'sessions', '2026', '08', '30');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, rolloutName(threadId));
  fs.writeFileSync(file, `${body}\n`);
  return file;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ctxcodex-'));
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

describe('Session + Orchestrator — codex context usage', () => {
  it('tracks with NO hook at all: the CODEX_HOME is enough', async () => {
    // The whole difference with claude. codex has no `SessionStart`, and it does
    // not need one: the directory is known from phase A, and the tracker's job
    // is to keep looking until the first model request creates the rollout.
    const { orch, lead } = makeTeam('codex');
    orch.toView();
    await new Promise((r) => setTimeout(r, 50));
    expect(lead.contextUsage).toBeNull();

    writeRollout(THREAD_A, usageEvent({ last: 11_626, window: 258_400 }));
    // PUMP the heartbeat rather than calling it once. Since docs/auto-compact.md
    // D2, the idle boundary also calls `maybeRefreshContextUsage` — and the two
    // share ONE TTL stamp, so a single `toView()` landing inside the window the
    // boundary just opened is deferred rather than served. That is precisely
    // what the 3 s UI poll does in production, where the next poll picks it up.
    await waitUntil(() => {
      orch.toView();
      return lead.contextUsage !== null;
    });
    expect(lead.toView().contextUsage).toMatchObject({
      usedTokens: 11_626,
      limitTokens: 258_400,
      basis: 'transcript',
      stale: false,
    });
    // The raw ratio, not codex's cosmetic "100% left": 11 626 / 258 400.
    expect(lead.contextUsage?.pct).toBeCloseTo(0.045, 3);
  });

  it('adopts the thread-id a notify payload hands back', async () => {
    const { orch, lead } = makeTeam('codex');
    writeRollout(THREAD_A, usageEvent({ last: 11_626 }));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);

    // What `hooks.ts` does with the `thread-id` of a codex `notify`.
    lead.setAgentThreadId(THREAD_B);
    writeRollout(THREAD_B, usageEvent({ last: 7_010, timestamp: '2026-08-30T13:44:00.000Z' }));
    orch.toView();
    await waitUntil(() => lead.contextUsage?.usedTokens === 7_010);
    expect(lead.contextUsage).toMatchObject({ usedTokens: 7_010, stale: false });
  });

  it('ignores a thread-id for any provider that is not codex', async () => {
    const { lead } = makeTeam('gemini');
    lead.setAgentThreadId(THREAD_A);
    writeRollout(THREAD_A, usageEvent({ last: 11_626 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(lead.contextUsage).toBeNull();
    expect('contextUsage' in lead.toView()).toBe(false);
  });

  it('tracks nothing when phase A produced no CODEX_HOME', async () => {
    const { orch, lead } = makeTeam('codex', { configDir: null });
    orch.toView();
    await new Promise((r) => setTimeout(r, 100));
    expect(lead.contextUsage).toBeNull();
  });

  it('reads nothing when the TTL knob is 0', async () => {
    const { orch, lead } = makeTeam('codex', { config: { contextUsageTtlMs: 0 } });
    writeRollout(THREAD_A, usageEvent({ last: 11_626 }));
    orch.toView();
    await new Promise((r) => setTimeout(r, 150));
    expect(lead.contextUsage).toBeNull();
  });

  it('marks the snapshot stale as soon as a reset reaches the PTY', async () => {
    const { orch, lead } = makeTeam('codex');
    writeRollout(THREAD_A, usageEvent({ last: 11_626 }));
    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);
    expect(lead.contextUsage?.stale).toBe(false);

    orch.requestContextReset(lead.id, '/clear');
    await waitUntil(() => lead.contextUsage?.stale === true);
    expect(lead.contextUsage).toMatchObject({ usedTokens: 11_626, stale: true });
  });
});

// ---------------------------------------------------------------------------
// Lot 13 — the ACCOUNT quota codex has been carrying all along
// ---------------------------------------------------------------------------

/**
 * `rate_limits` rides the very events Lot 6 reads, and the freshest ones are
 * precisely those Lot 6 SKIPS: a `token_count` whose `info` is `null` carries
 * no usage and exists for no other purpose than to refresh this. Every fixture
 * below is the spike's payload (`scripts/verify-codex-rollout.report.md` §R2).
 */
describe('parseCodexRateLimitsFromTail', () => {
  it('reads the quota off a normal usage event', () => {
    expect(parseCodexRateLimitsFromTail(usageEvent({ last: 11_626 }))).toEqual(QUOTA);
  });

  it('reads it off a rate-limit-ONLY event, the one the gauge walks past', () => {
    // Two of the spike's eight events were these. The gauge parser refuses them
    // (an `info` of `null` is not a zero); the quota parser exists for them.
    expect(parseContextUsageFromCodexRolloutTail(RATE_LIMIT_ONLY_EVENT)).toBeNull();
    expect(parseCodexRateLimitsFromTail(RATE_LIMIT_ONLY_EVENT)).toEqual(QUOTA);
  });

  it('takes the NEWEST reading, scanning backwards', () => {
    const stale = JSON.stringify({
      timestamp: '2026-08-30T13:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: { ...RATE_LIMITS, primary: { used_percent: 99, resets_at: 1_788_114_884 } },
      },
    });
    // A percentage is a LEVEL, not a flow: the last one wins outright.
    expect(parseCodexRateLimitsFromTail([stale, RATE_LIMIT_ONLY_EVENT].join('\n'))).toEqual(QUOTA);
    expect(parseCodexRateLimitsFromTail([RATE_LIMIT_ONLY_EVENT, stale].join('\n'))).toMatchObject({
      usedPercent: 99,
    });
  });

  it('survives a tail with no quota at all — and the usual noise', () => {
    expect(parseCodexRateLimitsFromTail(ROLLOUT_NOISE.join('\n'))).toBeNull();
    expect(parseCodexRateLimitsFromTail('')).toBeNull();
    expect(parseCodexRateLimitsFromTail('{"half of a li')).toBeNull();
    // A `token_count` that carries none: the event is right, the field is absent.
    expect(
      parseCodexRateLimitsFromTail(
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      ),
    ).toBeNull();
  });

  it('keeps the fields it can read and nulls the ones it cannot', () => {
    const partial = (limits: Record<string, unknown>): string =>
      JSON.stringify({
        timestamp: '2026-08-30T13:43:07.100Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: limits },
      });
    // No `primary` at all — the plan is still worth saying.
    expect(parseCodexRateLimitsFromTail(partial({ plan_type: 'plus' }))).toEqual({
      usedPercent: null,
      resetsAt: null,
      plan: 'plus',
    });
    // A percentage with no window rollover, and no plan.
    expect(parseCodexRateLimitsFromTail(partial({ primary: { used_percent: 42 } }))).toEqual({
      usedPercent: 42,
      resetsAt: null,
      plan: null,
    });
    // Nothing readable in it at all ⇒ `null`, so an OLDER reading we do
    // understand can win instead of being masked by an empty one.
    expect(parseCodexRateLimitsFromTail(partial({}))).toBeNull();
    expect(parseCodexRateLimitsFromTail(partial({ primary: {}, plan_type: '  ' }))).toBeNull();
    expect(
      parseCodexRateLimitsFromTail(
        [partial({ primary: { used_percent: 7 } }), partial({})].join('\n'),
      ),
    ).toMatchObject({ usedPercent: 7 });
  });

  it('refuses a percentage that is not one, and clamps the ones that are', () => {
    const pct = (used: unknown): number | null =>
      parseCodexRateLimitsFromTail(
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: { primary: { used_percent: used }, plan_type: 'plus' },
          },
        }),
      )?.usedPercent ?? null;
    expect(pct(0)).toBe(0);
    expect(pct(99.5)).toBe(99.5);
    expect(pct(140)).toBe(100);
    expect(pct(-3)).toBe(0);
    expect(pct('1')).toBeNull();
    expect(pct(null)).toBeNull();
  });

  it('dates the rollover from `resets_at` — an epoch in SECONDS', () => {
    // Cross-checked against codex itself: the spike's `/status` printed
    // "5h limit … (resets 18:34)" for this very rollout.
    expect(parseCodexRateLimitsFromTail(RATE_LIMIT_ONLY_EVENT)?.resetsAt).toBe(
      '2026-08-30T18:34:44.000Z',
    );
  });

  it('accepts a rollover published in milliseconds, or as a countdown', () => {
    const withPrimary = (primary: Record<string, unknown>, timestamp?: string): string =>
      JSON.stringify({
        ...(timestamp ? { timestamp } : {}),
        type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: { primary } },
      });
    // Milliseconds — the same instant, not the year 1970.
    expect(parseCodexRateLimitsFromTail(withPrimary({ resets_at: 1_788_114_884_000 }))?.resetsAt).toBe(
      '2026-08-30T18:34:44.000Z',
    );
    // A relative countdown only means something against the event's own clock:
    // the tail we are reading can be minutes old, so `Date.now()` would lie.
    expect(
      parseCodexRateLimitsFromTail(
        withPrimary({ resets_in_seconds: 600 }, '2026-08-30T13:43:07.000Z'),
      )?.resetsAt,
    ).toBe('2026-08-30T13:53:07.000Z');
    // A countdown with no event clock is unusable — and since it was the only
    // readable field, the whole snapshot is `null` rather than three nulls.
    expect(parseCodexRateLimitsFromTail(withPrimary({ resets_in_seconds: 600 }))).toBeNull();
    expect(parseCodexRateLimitsFromTail(withPrimary({ resets_at: 'soon' }))).toBeNull();
    // …but it does not sink a reading that has something else to say.
    expect(
      parseCodexRateLimitsFromTail(withPrimary({ used_percent: 12, resets_in_seconds: 600 })),
    ).toEqual({ usedPercent: 12, resetsAt: null, plan: null });
  });
});

describe('CodexRolloutSource — the quota on the reading', () => {
  const pathA = `/h/sessions/2026/08/30/${rolloutName(THREAD_A)}`;

  function sourceOver(body: string): CodexRolloutSource {
    return new CodexRolloutSource({
      sessionsDir: '/h/sessions',
      listRollouts: async () => [{ path: pathA, mtimeMs: 100 }],
      readTail: tailOf({ [pathA]: body }),
    });
  }

  it('carries the quota on a sample, alongside the gauge and the bill', async () => {
    const source = sourceOver(usageEvent({ last: 11_626 }));
    expect(await source.read()).toMatchObject({ kind: 'sample', quota: QUOTA });
  });

  it('carries it on an `empty` — a tail of rate-limit-only refreshes', async () => {
    // The state a brand-new thread is in: codex has published the account's
    // consumption and not yet made a single model request. There is no gauge to
    // report and no token to bill, and the quota is still perfectly true.
    const source = sourceOver([RATE_LIMIT_ONLY_EVENT, RATE_LIMIT_ONLY_EVENT].join('\n'));
    expect(await source.read()).toEqual({ kind: 'empty', quota: QUOTA });
  });

  it('says nothing when the rollout carries no quota', async () => {
    const bare = JSON.stringify({
      timestamp: '2026-08-30T13:43:06.986Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 500 }, model_context_window: 258_400 },
      },
    });
    const reading = await sourceOver(bare).read();
    expect(reading).toMatchObject({ kind: 'sample', usedTokens: 500 });
    // Absent, not null: the tracker keeps whatever it already knew.
    expect('quota' in reading).toBe(false);
  });
});
