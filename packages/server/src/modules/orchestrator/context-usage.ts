/**
 * Context-window occupancy of one agent (docs/monitoring-agents.md, Lots 2/6/7/9).
 *
 * ONE TRACKER, THREE SOURCES. Every provider answers the same question from a
 * different place, so the *policy* (a TTL, one read at a time, a global cap, a
 * generation guard, "stale rather than confidently wrong") lives here, once, in
 * `ContextUsageTracker`, and the *plumbing* lives behind `ContextUsageSource`:
 *
 *   claude    `TranscriptContextSource`   — the transcript `.jsonl` tail (below)
 *   codex     `CodexRolloutSource`        — `context-usage-codex.ts`
 *   opencode  `OpencodeControlPlaneSource`— `context-usage-opencode.ts`
 *   gemini    no source, therefore no tracker, therefore `—`
 *
 * WHERE THE CLAUDE NUMBER COMES FROM. The CLIs run as a TUI inside a PTY:
 * nothing on their stdout is machine-readable. The reliable source is Claude
 * Code's own transcript `.jsonl`, whose `type:"assistant"` lines carry
 * `message.usage`. The `SessionStart` hook hands us the path to that file at
 * every boot, every `/clear` and every `/compact` (spike
 * `scripts/verify-claude-sessionstart.report.md`, 9/9 CONFIRMED) —
 * `Session.setTranscriptPath` feeds it here.
 *
 * THREE PARSING TRAPS, all measured rather than assumed (spike S2/S4):
 *
 *  1. **The last line is almost never an assistant line.** Observed tails end on
 *     `last-prompt`, `queue-operation`, `attachment`, `atis-latch`. So we scan
 *     BACKWARDS for the first assistant line, never read the final one.
 *  2. **Never sum.** Two consecutive `type:"assistant"` lines of ONE turn (the
 *     thinking block and the text block) repeat the SAME `message.id` and the
 *     SAME `usage` object. Summing double-counts; the newest line alone is the
 *     whole occupancy, because `input + cache_read + cache_creation` already
 *     describes the entire prompt that was sent.
 *  3. **Sidechains are not the main conversation.** `isSidechain: true` lines
 *     belong to a sub-agent with its own window; counting them reports another
 *     context's size as this agent's.
 *
 * NO TIMER, by the same doctrine as `providers/catalogue.ts` and
 * `providers/availability.ts`: `Orchestrator.toView()` calls `maybeRefresh()`,
 * and the UI already polls `/orchestrators` every 3 s. The heartbeat exists; a
 * scheduler would only add a lifecycle to shut down.
 *
 * A HISTORY, NOT A TIMER (Lot 9). The same tracker keeps two bounded rings —
 * accepted samples and resets that actually fired — trimmed to 72 h on append
 * and on read. They feed `SessionView.contextSpark` (~20 integers on the poll
 * that already happens) and `GET /sessions/:id/context-history`. Memory only:
 * nothing is persisted, and the history dies with the process by design.
 *
 * TWO QUESTIONS, ONE FILE (Lot 11). "How full is the window" and "what has this
 * agent spent" are answered from the same transcript by two different reads, and
 * conflating them is the whole trap. The gauge wants the LAST turn, re-read as
 * often as asked; the bill wants EVERY turn, counted exactly once. So the claude
 * source keeps a byte cursor into the append-only file, bills forward from it
 * (deduplicating by `message.id`, sidechains INCLUDED — a sub-agent spends this
 * agent's money even though it occupies its own window), and, once that cursor
 * has caught up with the file, serves the gauge from what it just passed over
 * instead of issuing a second read. Rotation (`/clear`) resets the cursor, never
 * the totals. codex and opencode need no cursor: both already publish a
 * cumulative counter, so their sources report the difference since last time.
 *
 * EVERY OUTCOME IS A VALUE. Neither the reader nor the tracker ever throws or
 * rejects: a transcript that vanished, an SSH host that timed out and a
 * truncated line all resolve to "keep the previous snapshot, mark it stale, try
 * again at the next TTL". This code runs on the serialization path of every
 * poll — it has no business failing a request.
 */

import * as fs from 'node:fs';
import { withModule } from '../../logger.js';
import type { Config } from '../../config.js';
import { shellQuote } from './agent-process.js';
import { hostExec as nodeHostExec } from './ssh-exec.js';
import { estimateTokenCostUsd, type TokenCostRates } from '../providers/catalogue.js';
import type { ContextUsageView, ProviderQuotaView } from './session.js';

export type { ProviderQuotaView };

const log = withModule('context-usage');

/**
 * How much of the transcript tail we read. 64 KiB covers dozens of lines of a
 * verbose turn — orders of magnitude more than the one assistant line we need
 * — while keeping the SSH round trip small enough to run every 15 s per session.
 */
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/**
 * Module-wide ceiling on refreshes in flight, ACROSS every session.
 *
 * The local reader is a bounded pread and would not need one; the SSH reader
 * forks an `ssh` process per call, and a 40-agent deployment polling on the
 * same 3 s tick would otherwise open 40 connections at once. Sessions that lose
 * the race simply do not stamp their clock, so they retry on the very next poll
 * instead of waiting a TTL.
 */
export const CONTEXT_USAGE_MAX_CONCURRENT_REFRESH = 4;

/** Budget for one tail read over SSH — a `tail -c 65536`, no more. */
export const TRANSCRIPT_READ_TIMEOUT_MS = 10_000;

/** At most one "cannot read the transcript" warning per tracker per window. */
const READ_WARN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * How far back the in-memory history goes (Lot 9). Three days is the operator's
 * decision: long enough to see a night of work and the `/compact` that ended
 * it, short enough that NOTHING has to be persisted — the rings die with the
 * process, and the UI says so.
 */
export const CONTEXT_HISTORY_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Belt to the 72 h braces. At the default TTL a session samples ~4×/min, i.e.
 * ~17 280 points over 72 h — but `SWARM_OS_CONTEXT_USAGE_TTL_MS` is a knob, and
 * a 1 s TTL would sample 60× faster. So the ring also caps by COUNT, dropping
 * oldest-first: ~17 500 × two numbers is a few hundred KiB per session, and
 * that ceiling holds under any configuration.
 */
export const CONTEXT_HISTORY_MAX_SAMPLES = 17_500;

/** Same idea for the reset ring — a `/compact` every 15 min for 3 days is 288. */
export const CONTEXT_HISTORY_MAX_RESETS = 300;

/** How many samples ride `SessionView.contextSpark` on the 3 s poll. */
export const CONTEXT_SPARK_POINTS = 20;

/** Hard ceiling on what one `/context-history` response may carry. */
export const CONTEXT_HISTORY_MAX_POINTS = 300;

/**
 * How much of a transcript one incremental poll may swallow (Lot 11).
 *
 * A transcript is append-only, so token accounting reads it FORWARD from a
 * remembered byte offset instead of re-reading a tail. The cap bounds one poll,
 * not the file: a transcript that grew by more than this is caught up over
 * several polls, in order, never by skipping ahead.
 */
export const TRANSCRIPT_RANGE_BYTES = 1024 * 1024;

/**
 * How many `message.id`s the incremental reader remembers.
 *
 * Two consecutive `type:"assistant"` lines of ONE turn repeat the SAME id and
 * the SAME `usage` (spike S2) — billing it twice would double every agent's
 * cost. The window only has to span the lines of a single turn plus whatever a
 * re-read of the same bytes could replay, so it is tiny by design: this is a
 * de-duplicator, not a history.
 */
export const TRANSCRIPT_USAGE_ID_MEMORY = 64;

/** Refreshes in flight right now, all trackers included. */
let activeRefreshes = 0;

// ---------------------------------------------------------------------------
// Token accounting — the cumulative counters behind `SessionView.tokenUsage`
// ---------------------------------------------------------------------------

/**
 * What one agent has BILLED, by bucket (docs/monitoring-agents.md, Lot 11).
 *
 * Deliberately NOT the same question as `ContextUsageView.usedTokens`. The gauge
 * asks "how full is the window right now", answered by the newest turn alone;
 * these four ask "what has this agent spent since it started", answered by
 * summing every turn — including the sub-agent turns the gauge must ignore,
 * because a sidechain has its own window but not its own invoice.
 *
 *   `in`         input tokens billed at the full rate (cache misses)
 *   `out`        output tokens, reasoning included where the provider folds it in
 *   `cacheRead`  prompt-cache hits — the cheap bucket
 *   `cacheWrite` cache creation — the expensive bucket
 *
 * `in` NEVER includes the cached tokens: claude reports them apart already,
 * codex reports `cached_input_tokens` as a SUBSET of `input_tokens` (so the
 * adapter subtracts), and opencode reports four disjoint fields.
 */
export interface TokenUsageCounters {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The additive identity. Frozen: it is handed out as a default in places. */
export const ZERO_TOKEN_USAGE: Readonly<TokenUsageCounters> = Object.freeze({
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/** A fresh, mutable zero — for accumulators. */
export function emptyTokenUsage(): TokenUsageCounters {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokenUsage(
  a: TokenUsageCounters,
  b: TokenUsageCounters,
): TokenUsageCounters {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** `true` when nothing at all has been billed — the "say nothing" condition. */
export function isZeroTokenUsage(u: TokenUsageCounters): boolean {
  return u.in === 0 && u.out === 0 && u.cacheRead === 0 && u.cacheWrite === 0;
}

/**
 * Any shape → four finite, non-negative integers.
 *
 * Used on both untrusted edges: a resume seed read out of SQLite (a hand-edited
 * or corrupt row must not make the counter run backwards, same clamp as
 * `messagesProcessed`) and a delta a source computed.
 */
export function normalizeTokenUsage(
  raw: Partial<Record<keyof TokenUsageCounters, unknown>> | null | undefined,
): TokenUsageCounters {
  return {
    in: tokenCount(raw?.in),
    out: tokenCount(raw?.out),
    cacheRead: tokenCount(raw?.cacheRead),
    cacheWrite: tokenCount(raw?.cacheWrite),
  };
}

/**
 * FIFO set of the `message.id`s already billed.
 *
 * FIFO rather than LRU-by-use: transcript lines arrive in order, so "oldest
 * inserted" IS "least likely to come back", and an eviction policy that reorders
 * on every hit would buy nothing at the cost of being a second thing to reason
 * about.
 */
export class MessageIdMemory {
  readonly #max: number;
  readonly #ids = new Set<string>();

  constructor(max: number = TRANSCRIPT_USAGE_ID_MEMORY) {
    this.#max = Math.max(1, Math.floor(max));
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  add(id: string): void {
    if (this.#ids.has(id)) return;
    this.#ids.add(id);
    while (this.#ids.size > this.#max) {
      const oldest = this.#ids.values().next();
      if (oldest.done === true) break;
      this.#ids.delete(oldest.value);
    }
  }

  clear(): void {
    this.#ids.clear();
  }

  get size(): number {
    return this.#ids.size;
  }
}

// ---------------------------------------------------------------------------
// The parser — pure, exported, and reused by the future cost module
// ---------------------------------------------------------------------------

/**
 * Occupancy of the newest turn found in a transcript tail, or `null` when the
 * tail holds no usable assistant line (a freshly rotated file after `/clear`,
 * a tail that landed entirely inside one huge tool result, an unreadable blob).
 *
 * `text` is expected to be the LAST bytes of a `.jsonl`, so its first line is
 * usually cut in half. No special case is needed for it: a JSON object sliced
 * mid-way never parses, and `JSON.parse` is guarded per line.
 */
export function parseContextUsageFromTranscriptTail(
  text: string,
): { usedTokens: number } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  // Backwards: trap 1. The newest assistant line wins and we stop there — trap 2.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partial head line, or a log line that is not JSON at all.
      continue;
    }
    const row = asRecord(parsed);
    if (!row || row.type !== 'assistant') continue;
    // Trap 3 — a sub-agent's window, not this agent's.
    if (row.isSidechain === true) continue;
    const usage = asRecord(asRecord(row.message)?.usage);
    if (!usage) continue;
    return {
      usedTokens:
        tokenCount(usage.input_tokens) +
        tokenCount(usage.cache_read_input_tokens) +
        tokenCount(usage.cache_creation_input_tokens) +
        tokenCount(usage.output_tokens),
    };
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A missing / negative / non-numeric token field counts as zero, never as a failure. */
function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** What one forward pass over a transcript slice found (Lot 11). */
export interface TranscriptScan {
  /**
   * Bytes of COMPLETE lines, i.e. how far the cursor may advance. A slice
   * almost always ends mid-line (the reader cuts on a byte count, not on a
   * newline); those trailing bytes are NOT consumed and are re-read next poll.
   */
  consumedBytes: number;
  /** Tokens billed by the message ids seen here for the FIRST time. */
  delta: TokenUsageCounters;
  /** Those ids, in order — the caller commits them to its memory. */
  countedIds: readonly string[];
  /**
   * Occupancy of the newest MAIN-conversation assistant line in this slice, or
   * `null` when it holds none. Same three traps as
   * `parseContextUsageFromTranscriptTail` — sidechains excluded, latest wins,
   * never summed — so a caught-up incremental reader can serve the gauge too.
   */
  gaugeUsedTokens: number | null;
}

/**
 * Forward pass over a slice of an append-only transcript.
 *
 * Pure: `seen` is only interrogated, never mutated, and every decision is a
 * function of the text. The caller owns the cursor and the id memory.
 *
 * WHY THE TWO ANSWERS DIFFER ON SIDECHAINS. `gaugeUsedTokens` skips
 * `isSidechain: true` lines because a sub-agent's window is not this agent's
 * (trap 3). `delta` counts them, because the sub-agent's tokens are on this
 * agent's bill: the money left the account either way.
 *
 * A usage line with no `message.id` is NOT billed. Two lines of one turn repeat
 * the same id and the same numbers, so an id is the only thing that makes
 * "count this once" decidable; counting an anonymous line would double every
 * turn it appears in. In the payloads measured (spike S2) every assistant line
 * carries one.
 */
export function scanTranscriptRange(
  text: string,
  seen: { has(id: string): boolean } = { has: () => false },
): TranscriptScan {
  const delta = emptyTokenUsage();
  const countedIds: string[] = [];
  let gaugeUsedTokens: number | null = null;
  if (typeof text !== 'string' || text.length === 0) {
    return { consumedBytes: 0, delta, countedIds, gaugeUsedTokens };
  }
  const lastNewline = text.lastIndexOf('\n');
  // Not one complete line yet: consume nothing, so the partial line is re-read
  // whole at the next poll rather than parsed (and lost) as a broken fragment.
  if (lastNewline < 0) {
    return { consumedBytes: 0, delta, countedIds, gaugeUsedTokens };
  }
  const complete = text.slice(0, lastNewline + 1);
  // Bytes, not characters: the cursor is a byte offset into the file. Slicing on
  // a newline guarantees only whole UTF-8 sequences are measured here.
  const consumedBytes = Buffer.byteLength(complete, 'utf8');
  // Ids billed inside THIS slice, so a turn's two lines cannot both count even
  // though neither is in the caller's memory yet.
  const here = new Set<string>();

  for (const raw of complete.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A leading fragment left by a line longer than one read window, or a
      // line that is not JSON at all.
      continue;
    }
    const row = asRecord(parsed);
    if (!row || row.type !== 'assistant') continue;
    const message = asRecord(row.message);
    const usage = asRecord(message?.usage);
    if (!usage) continue;

    const input = tokenCount(usage.input_tokens);
    const cacheRead = tokenCount(usage.cache_read_input_tokens);
    const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
    const output = tokenCount(usage.output_tokens);

    if (row.isSidechain !== true) {
      gaugeUsedTokens = input + cacheRead + cacheWrite + output;
    }

    const id = typeof message?.id === 'string' && message.id.length > 0 ? message.id : null;
    if (id === null) continue;
    if (here.has(id) || seen.has(id)) continue;
    here.add(id);
    countedIds.push(id);
    delta.in += input;
    delta.out += output;
    delta.cacheRead += cacheRead;
    delta.cacheWrite += cacheWrite;
  }
  return { consumedBytes, delta, countedIds, gaugeUsedTokens };
}

// ---------------------------------------------------------------------------
// Bounded tail readers — one per transport, both returning `null` on any failure
// ---------------------------------------------------------------------------

/** Reads at most `maxBytes` from the END of `filePath`. `null` ⇒ unreadable. */
export type TranscriptTailReader = (
  filePath: string,
  maxBytes: number,
) => Promise<string | null>;

/**
 * Local transport: a positioned read of the file's tail. Never `readFileSync` —
 * a transcript grows without bound and the whole point is to stay O(64 KiB).
 */
export function createLocalTailReader(
  deps: { openImpl?: typeof fs.promises.open; lstatImpl?: typeof fs.promises.lstat } = {},
): TranscriptTailReader {
  const open = deps.openImpl ?? fs.promises.open;
  const lstat = deps.lstatImpl ?? fs.promises.lstat;
  return async (filePath, maxBytes) => {
    let handle: fs.promises.FileHandle | null = null;
    try {
      // The path comes from a hook payload an agent controls. `open('r')` on a
      // FIFO BLOCKS until a writer shows up — the promise never settles, the
      // tracker's in-flight flag and one of the module-wide refresh slots leak
      // forever, and four such paths freeze every gauge in the process. lstat
      // never blocks, and rejecting anything but a regular file also refuses a
      // symlink in final position.
      const st = await lstat(filePath);
      if (!st.isFile()) return null;
      handle = await open(filePath, 'r');
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      if (length <= 0) return '';
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, stat.size - length);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return null;
    } finally {
      try {
        await handle?.close();
      } catch {
        /* best-effort */
      }
    }
  };
}

/** Narrow shape of `ssh-exec.hostExec` this module needs (mirrors `CatalogueHostExec`). */
export type TailHostExec = (
  config: Config,
  input: { argv: string[]; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

/**
 * SSH transport: the transcript lives in the HOST's namespace, so the read has
 * to happen over there — same pattern as `providers/catalogue.ts#readCodexCache`.
 *
 * `maxOutputBytes` is deliberately larger than what `tail -c` can return: the
 * capture sink appends a `[output truncated at N bytes]` marker when it hits the
 * cap, and that marker would land INSIDE the last line.
 *
 * `hostExec` THROWS when the transport is not ssh, hence the guarded call: this
 * reader must be a value-returning function under every configuration.
 */
export function createSshTailReader(
  config: Config,
  deps: { hostExec?: TailHostExec } = {},
): TranscriptTailReader {
  const exec = deps.hostExec ?? nodeHostExec;
  return async (filePath, maxBytes) => {
    try {
      const res = await exec(config, {
        argv: ['tail', '-c', String(maxBytes), filePath],
        timeoutMs: TRANSCRIPT_READ_TIMEOUT_MS,
        maxOutputBytes: maxBytes + 4096,
      });
      if (res.timedOut || res.code !== 0) return null;
      return res.stdout;
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Bounded RANGE readers — the append-only half, for token accounting (Lot 11)
// ---------------------------------------------------------------------------

/** One forward slice of a transcript. */
export interface TranscriptRange {
  /** The bytes read, decoded as UTF-8. May end mid-line, and mid-character. */
  text: string;
  /**
   * How many BYTES were read. Not `text.length`: a slice can cut a multi-byte
   * character in half, and the cursor is measured in bytes.
   */
  bytes: number;
  /**
   * File size at read time, when the transport can say. `null` over SSH, where
   * asking would cost a second round trip — the reader then infers "caught up"
   * from a short answer instead.
   */
  size: number | null;
}

/**
 * Reads at most `maxBytes` starting AT `offset`. `null` ⇒ unreadable.
 *
 * The counterpart of `TranscriptTailReader`, and the reason both exist: the
 * gauge wants the END of the file (the newest turn, whenever we last looked),
 * while billing wants everything we have not read YET, exactly once.
 */
export type TranscriptRangeReader = (
  filePath: string,
  offset: number,
  maxBytes: number,
) => Promise<TranscriptRange | null>;

/**
 * Local transport: a positioned read at `offset`. Same FIFO guard as
 * `createLocalTailReader` — `open('r')` on a FIFO blocks forever and would leak
 * one of the four module-wide refresh slots.
 */
export function createLocalRangeReader(
  deps: { openImpl?: typeof fs.promises.open; lstatImpl?: typeof fs.promises.lstat } = {},
): TranscriptRangeReader {
  const open = deps.openImpl ?? fs.promises.open;
  const lstat = deps.lstatImpl ?? fs.promises.lstat;
  return async (filePath, offset, maxBytes) => {
    let handle: fs.promises.FileHandle | null = null;
    try {
      const st = await lstat(filePath);
      if (!st.isFile()) return null;
      handle = await open(filePath, 'r');
      const stat = await handle.stat();
      const from = Math.max(0, Math.floor(offset));
      const length = Math.min(Math.max(0, stat.size - from), maxBytes);
      // Nothing new — or a cursor past the end, which the caller reads as "this
      // file got shorter" and handles by restarting at 0.
      if (length <= 0) return { text: '', bytes: 0, size: stat.size };
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, from);
      return {
        text: buf.subarray(0, bytesRead).toString('utf8'),
        bytes: bytesRead,
        size: stat.size,
      };
    } catch {
      return null;
    } finally {
      try {
        await handle?.close();
      } catch {
        /* best-effort */
      }
    }
  };
}

/**
 * SSH transport: `tail -c +N | head -c M`, the portable spelling of a ranged
 * read (`dd` would need a block size that divides the offset, and `tail -c +N`
 * is 1-BASED, hence the `offset + 1`).
 *
 * The pipeline goes through `sh -c` because `buildRemoteCommand` `exec`s its
 * argv as one program — a pipe has to be inside a shell string. Every path is
 * `shellQuote`d into it, the same way ssh-exec quotes its own tokens.
 *
 * TWO THINGS THIS SCRIPT DOES THAT LOOK OPTIONAL AND ARE NOT:
 *
 *  1. **`test -f` first.** A pipeline's exit status is its LAST command's, and
 *     `head` exits 0 whether or not `tail` found anything. So a transcript that
 *     was deleted, renamed or made unreadable would come back as a perfectly
 *     successful EMPTY read — the cursor would stop advancing, billing would
 *     stop silently, and (because an empty answer also reads as "caught up")
 *     the gauge would keep re-serving its last number as FRESH for ever, with
 *     no warning logged. The guard turns that into a non-zero exit, i.e. into
 *     the `unavailable` it is. `pipefail` would NOT do: `head -c` closing the
 *     pipe early kills `tail` with SIGPIPE on every full-window read, which is
 *     the normal catch-up case, not a failure.
 *  2. **`wc -c` on the first line.** It costs nothing (same round trip) and it
 *     is what makes the "file got shorter" branch reachable over SSH at all —
 *     without a size, a truncation is undetectable and the cursor can never
 *     recover. It also makes "caught up" an exact answer rather than an
 *     inference from a short read.
 */
export function createSshRangeReader(
  config: Config,
  deps: { hostExec?: TailHostExec } = {},
): TranscriptRangeReader {
  const exec = deps.hostExec ?? nodeHostExec;
  return async (filePath, offset, maxBytes) => {
    const from = Math.max(0, Math.floor(offset)) + 1;
    const quoted = shellQuote(filePath);
    const script =
      `test -f ${quoted} || exit 3; wc -c < ${quoted}; ` +
      `tail -c +${from} ${quoted} | head -c ${Math.floor(maxBytes)}`;
    try {
      const res = await exec(config, {
        argv: ['sh', '-c', script],
        timeoutMs: TRANSCRIPT_READ_TIMEOUT_MS,
        // Above what `head -c` can return: the capture sink appends a
        // truncation marker when it hits its cap, and that marker would land
        // INSIDE the last line.
        maxOutputBytes: maxBytes + 4096,
      });
      if (res.timedOut || res.code !== 0) return null;
      return parseSshRange(res.stdout);
    } catch {
      return null;
    }
  };
}

/**
 * `<size>\n<slice…>` → a `TranscriptRange`. `null` when the size line is not
 * there, which means the script did not run as written and nothing downstream
 * should trust the bytes that follow.
 */
export function parseSshRange(stdout: string): TranscriptRange | null {
  if (typeof stdout !== 'string') return null;
  const newline = stdout.indexOf('\n');
  if (newline < 0) return null;
  const size = Number.parseInt(stdout.slice(0, newline).trim(), 10);
  if (!Number.isFinite(size) || size < 0) return null;
  const text = stdout.slice(newline + 1);
  return { text, bytes: Buffer.byteLength(text, 'utf8'), size };
}

// ---------------------------------------------------------------------------
// The source contract — one per provider, all of them value-returning
// ---------------------------------------------------------------------------

export type ContextUsageBasis = ContextUsageView['basis'];

/**
 * What one read of a source produced. THREE outcomes, not two, because the
 * tracker owes the operator a different answer to each:
 *
 *   `sample`      — a number. The snapshot becomes fresh.
 *   `empty`       — the source is fine, it simply has nothing to say yet: a
 *                   codex rollout that the first model request has not created,
 *                   an opencode turn still in flight, a transcript freshly
 *                   rotated by `/clear`. NORMAL, and silent: whatever we last
 *                   counted stays visible but goes `stale`.
 *   `unavailable` — the source could not be read at all (file gone, SSH
 *                   timeout, control plane refusing connections). Same visible
 *                   effect as `empty` — stale, never a thrown request — but it
 *                   earns a throttled warning, because it is a degradation
 *                   rather than a phase of normal operation.
 */
/**
 * Tokens a source measured during ONE read, as a DELTA since its own previous
 * read (docs/monitoring-agents.md, Lot 11).
 *
 * Rides every outcome, `unavailable` included, and the tracker adds it up
 * whatever the reading turned out to be — because the two questions are
 * independent. A `/clear` that invalidates the GAUGE does not un-spend the
 * tokens; a control plane that answered `/session` and then failed on
 * `/session/{id}/message` still told us the truth about the bill.
 *
 * The contract that makes summing safe is on the SOURCE: it must report each
 * delta exactly once — advance its cursor, re-base its counter — at the moment
 * it hands it over. A source that cannot promise that reports nothing.
 */
export interface TokenUsageReading {
  tokens?: TokenUsageCounters;
  /**
   * Lot 13 — dollars the PROVIDER itself billed for those same tokens, as a
   * delta under exactly the contract above (reported once, the source re-bases
   * in the same breath).
   *
   * opencode only: it prices every session and every message from the provider
   * catalogue it already holds, so the money needs no rate card of ours. Absent
   * everywhere else, which leaves the estimate in charge.
   */
  reportedCostUsd?: number;
}

/**
 * The provider ACCOUNT's quota, when the source happened to see one (Lot 13).
 *
 * Rides every outcome for the same reason the bill does, and for one more: the
 * codex events that carry it most often are the ones with `info: null`, which
 * produce no sample at all. A quota that only travelled on `kind: 'sample'`
 * would be the one we never got to read.
 */
export interface ProviderQuotaReading {
  quota?: ProviderQuotaView;
}

/** Everything that rides a reading whatever its outcome. */
type ReadingSideChannel = TokenUsageReading & ProviderQuotaReading;

export type ContextUsageReading =
  | (ReadingSideChannel & {
      kind: 'sample';
      usedTokens: number;
      /**
       * Window size the SOURCE itself reported (codex's `model_context_window`,
       * opencode's `limit.context`). It beats the catalogue: it is the effective
       * window of the running CLI, already trimmed from whatever the model
       * advertises (codex reports 258 400 for a model whose cache says 272 000).
       */
      limitTokens?: number | null;
      /**
       * When the underlying event happened (epoch ms), when the source can say.
       * Used for ONE thing: proving, after a `/compact` or `/clear`, that what
       * we are about to read is still the PRE-reset measurement. See
       * `ContextUsageSource.invalidate`.
       */
      at?: number | null;
    })
  | (ReadingSideChannel & { kind: 'empty' })
  | (ReadingSideChannel & { kind: 'unavailable'; reason: string });

/**
 * Where one provider's occupancy comes from. Implementations MUST NOT throw and
 * MUST NOT reject — every failure is a `ContextUsageReading`.
 */
export interface ContextUsageSource {
  readonly basis: ContextUsageBasis;
  /**
   * What the source is currently following, for logs and tests: a transcript
   * path (claude), a codex thread-id, `null` for a source that re-resolves its
   * own target on every read (opencode).
   */
  readonly target: string | null;
  /**
   * `false` ⇒ there is nothing to read yet and the tracker must not even spend
   * a TTL on it (a claude session whose `SessionStart` hook has not fired).
   */
  readonly ready: boolean;
  read(): Promise<ContextUsageReading>;
  /**
   * Point the source at a newly reported target — the path from a `SessionStart`
   * payload, the `thread-id` from a codex `notify`. Returns `true` when that
   * CHANGED the target, which is the tracker's signal to invalidate. Absent on a
   * source that resolves its own target (opencode).
   */
  retarget?(target: string): boolean;
  /**
   * The live context was just thrown away (`/compact` or `/clear` reached the
   * PTY). A source that can tell a pre-reset measurement from a post-reset one
   * uses this to refuse the former — otherwise the very next poll would re-read
   * the old number and proudly mark it fresh.
   */
  invalidate?(): void;
}

/**
 * claude — the transcript `.jsonl` the `SessionStart` hook points us at.
 *
 * The path is the whole state: `/clear` rotates the file (new CLI session id,
 * new file, the old one orphaned on disk) while `/compact` rewrites it in place,
 * so "always adopt the newest path" covers both.
 */
export class TranscriptContextSource implements ContextUsageSource {
  readonly basis: ContextUsageBasis = 'transcript';
  readonly #readTail: TranscriptTailReader;
  readonly #maxBytes: number;
  #path: string | null = null;

  // --- Lot 11: the append-only cursor ------------------------------------
  /**
   * `null` ⇒ no incremental reader was wired, so this source does exactly what
   * it did before Lot 11: one tail read per poll, no token accounting. That is
   * the shape every pre-Lot-11 call site (and every test that injects only a
   * `readTail`) builds, and it stays byte-for-byte identical.
   */
  readonly #readRange: TranscriptRangeReader | null;
  readonly #rangeBytes: number;
  /** Byte offset up to which this file has been billed. */
  #offset = 0;
  /** `true` once the cursor has seen every byte the file had at read time. */
  #caughtUp = false;
  /** Newest main-conversation occupancy the cursor has passed over. */
  #gauge: number | null = null;
  #ids = new MessageIdMemory(TRANSCRIPT_USAGE_ID_MEMORY);
  /**
   * Bumped by `retarget`. A ranged read is issued against ONE file at ONE
   * cursor; if `/clear` rotates the transcript while that read is in flight,
   * the bytes that come back belong to a file we no longer follow and, worse,
   * would advance a cursor that has just been reset to 0 on a different file.
   * The epoch makes that landing a no-op.
   */
  #epoch = 0;
  /**
   * The file a rotation left behind, and the cursor we still had into it.
   *
   * `/clear` is typically typed moments after the turn that filled the window,
   * and that turn's bytes were written AFTER our last poll — up to a full TTL
   * of spend sitting in a file nobody will ever read again, because the hook
   * has already pointed us at the new one. So the old cursor survives the
   * rotation exactly long enough for one final, bounded read.
   *
   * Best-effort by construction: one read, no retry, and whatever exceeds the
   * window is dropped. A rotation must not be able to stall the live file.
   */
  #pendingDrain: { path: string; offset: number; seen: MessageIdMemory } | null = null;

  constructor(
    opts: {
      readTail?: TranscriptTailReader;
      maxTailBytes?: number;
      /** Wire this to bill tokens; omit it for the gauge alone. */
      readRange?: TranscriptRangeReader;
      maxRangeBytes?: number;
    } = {},
  ) {
    this.#readTail = opts.readTail ?? createLocalTailReader();
    this.#maxBytes = opts.maxTailBytes ?? TRANSCRIPT_TAIL_BYTES;
    this.#readRange = opts.readRange ?? null;
    this.#rangeBytes = opts.maxRangeBytes ?? TRANSCRIPT_RANGE_BYTES;
  }

  get target(): string | null {
    return this.#path;
  }

  get ready(): boolean {
    return this.#path !== null;
  }

  /** Byte cursor into the current transcript (tests / diagnostics). */
  get offset(): number {
    return this.#offset;
  }

  /**
   * A new file to follow — `/clear` rotates the transcript (spike S4).
   *
   * The cursor goes back to 0 and the id memory is emptied: a different file has
   * different bytes at every offset, and its ids cannot collide with the old
   * ones anyway. The TOTALS are not this object's to reset — they live in the
   * tracker, which is exactly why a `/clear` does not zero an agent's bill.
   */
  retarget(next: string): boolean {
    if (next === this.#path) return false;
    // Whatever the abandoned file gained since our last poll is still owed. Keep
    // its cursor for one last read — see `#pendingDrain`.
    if (this.#path !== null && this.#readRange !== null) {
      // Hand the drain the LIVE id memory along with the cursor: the cursor
      // can sit BETWEEN the two lines of one turn (same message.id, same
      // usage), in which case the first line is already billed — a drain that
      // forgets the ids would bill that turn a second time (up to a whole
      // context window of input+cache). The source starts a fresh memory: a
      // different file's ids cannot collide with the old ones.
      this.#pendingDrain = { path: this.#path, offset: this.#offset, seen: this.#ids };
      this.#ids = new MessageIdMemory(TRANSCRIPT_USAGE_ID_MEMORY);
    }
    this.#path = next;
    this.#offset = 0;
    this.#caughtUp = false;
    this.#gauge = null;
    this.#ids.clear();
    this.#epoch++;
    return true;
  }

  async read(): Promise<ContextUsageReading> {
    const filePath = this.#path;
    if (filePath === null) return { kind: 'empty' };

    let tokens: TokenUsageCounters | null = null;
    if (this.#readRange !== null) {
      // The tail of the file a rotation left behind, billed before anything
      // else — it is owed, and one poll later it would be unreachable.
      const drained = await this.#drain();
      const scanned = await this.#advance(filePath);
      if (scanned === 'unreadable') {
        // The drain still counts: it measured a different file, successfully.
        return { kind: 'unavailable', reason: 'unreadable', ...withTokens(drained) };
      }
      tokens = addTokenUsage(drained, scanned);
      // The cursor has seen the whole file, so it knows the newest turn as well
      // as any tail read would — and it remembers it between polls, so a quiet
      // agent keeps its gauge fresh instead of going stale for want of new
      // bytes. This is the ONLY reason the two reads do not both run every poll.
      if (this.#caughtUp) {
        return this.#gauge === null
          ? // A transcript with no assistant turn yet — the normal state right
            // after `/clear`.
            { kind: 'empty', ...withTokens(tokens) }
          : { kind: 'sample', usedTokens: this.#gauge, ...withTokens(tokens) };
      }
    }

    // Still catching up (or no incremental reader at all): the tail is the only
    // way to know the NEWEST turn, and reporting a turn from the middle of the
    // catch-up as if it were current would be exactly the "confidently wrong"
    // this module refuses.
    let text: string | null = null;
    try {
      text = await this.#readTail(filePath, this.#maxBytes);
    } catch {
      text = null;
    }
    if (text === null) return { kind: 'unavailable', reason: 'unreadable', ...withTokens(tokens) };
    const parsed = parseContextUsageFromTranscriptTail(text);
    // The file is there but holds no assistant turn yet — the normal state of a
    // transcript freshly rotated by `/clear`.
    if (parsed === null) return { kind: 'empty', ...withTokens(tokens) };
    return { kind: 'sample', usedTokens: parsed.usedTokens, ...withTokens(tokens) };
  }

  /**
   * One last bounded read of the file a rotation left behind. Never throws,
   * never retries, and clears the slot whatever happens: the live file's
   * accounting may not be held hostage by a dead one.
   *
   * The id memory snapshotted at `retarget` IS consulted: the cursor can have
   * stopped BETWEEN the two lines of one turn, so the slice past it may open
   * with the second line of an already-billed turn. `scanTranscriptRange` also
   * de-duplicates within the slice, which covers every other repetition.
   */
  async #drain(): Promise<TokenUsageCounters> {
    const pending = this.#pendingDrain;
    const readRange = this.#readRange;
    if (pending === null || readRange === null) return emptyTokenUsage();
    this.#pendingDrain = null;
    let chunk: TranscriptRange | null = null;
    try {
      chunk = await readRange(pending.path, pending.offset, this.#rangeBytes);
    } catch {
      chunk = null;
    }
    if (chunk === null) return emptyTokenUsage();
    // A file that SHRANK under its old cursor tells us nothing we can bill: the
    // bytes we were owed are gone, and re-reading from 0 would re-bill.
    if (chunk.size !== null && chunk.size < pending.offset) return emptyTokenUsage();
    return scanTranscriptRange(chunk.text, pending.seen).delta;
  }

  /**
   * One incremental step: read from the cursor, bill what is new, move the
   * cursor by what was actually consumed. `'unreadable'` is the only failure —
   * everything else is a (possibly zero) delta.
   */
  async #advance(filePath: string): Promise<TokenUsageCounters | 'unreadable'> {
    const readRange = this.#readRange;
    if (readRange === null) return emptyTokenUsage();
    const epoch = this.#epoch;
    const offset = this.#offset;
    let chunk: TranscriptRange | null = null;
    try {
      chunk = await readRange(filePath, offset, this.#rangeBytes);
    } catch {
      chunk = null;
    }
    if (chunk === null) {
      this.#caughtUp = false;
      return 'unreadable';
    }
    // A rotation landed while we were reading: these bytes belong to a file the
    // cursor no longer points into. Bill nothing, move nothing.
    if (this.#epoch !== epoch || this.#path !== filePath) return emptyTokenUsage();

    // The file is SHORTER than our cursor: it was replaced or rewritten under
    // the same name. Restart at 0 — but KEEP the id memory, which is the only
    // thing that stops a rewrite from re-billing the messages it preserved.
    if (chunk.size !== null && chunk.size < offset) {
      this.#offset = 0;
      this.#caughtUp = false;
      return emptyTokenUsage();
    }

    const scan = scanTranscriptRange(chunk.text, this.#ids);
    let consumed = scan.consumedBytes;
    if (consumed === 0 && chunk.bytes >= this.#rangeBytes) {
      // One line longer than a whole read window (a huge tool result). Stepping
      // over the window is the only way forward: the next chunk starts
      // mid-line, its leading fragment fails `JSON.parse`, and the cursor
      // resynchronises on the following newline. That single line's usage is
      // lost — which is a bounded, documented cost, unlike a stalled cursor
      // that would stop billing the agent for good.
      consumed = chunk.bytes;
    }
    this.#offset = offset + consumed;
    for (const id of scan.countedIds) this.#ids.add(id);
    if (scan.gaugeUsedTokens !== null) this.#gauge = scan.gaugeUsedTokens;
    // "Seen every byte", not "consumed every byte": a slice that ends mid-line
    // still tells us nothing is hiding behind it, and re-reading the tail for a
    // line the writer has not finished flushing would buy nothing.
    this.#caughtUp =
      chunk.size !== null ? offset + chunk.bytes >= chunk.size : chunk.bytes < this.#rangeBytes;
    return scan.delta;
  }
}

/**
 * Spread helper: attach a delta to a reading only when there is one to report.
 *
 * A ZERO delta is silence, not a reading — the overwhelming majority of polls
 * measure nothing new, and every source keeps the same rule so a caller can
 * treat "has `tokens`" as "something was billed".
 */
function withTokens(tokens: TokenUsageCounters | null): TokenUsageReading {
  return tokens === null || isZeroTokenUsage(tokens) ? {} : { tokens };
}

// ---------------------------------------------------------------------------
// The rolling history — Lot 9, memory only, no timer, pure functions
// ---------------------------------------------------------------------------

/** One accepted measurement. `t` is epoch ms, `used` a token count. */
export interface ContextUsageSample {
  t: number;
  used: number;
}

/**
 * The wire vocabulary of a context reset — bare words, never slash commands:
 * what claude spells `/clear` codex spells `/new`, and that mapping is the
 * adapter's business (same rule as `POST /sessions/:id/context-reset`).
 */
export type ContextResetKind = 'compact' | 'clear';

/** A reset that ACTUALLY reached the PTY, stamped when it was submitted. */
export interface ContextResetMark {
  t: number;
  cmd: ContextResetKind;
}

/** What `ContextUsageTracker.history()` hands the route. */
export interface ContextUsageHistory {
  limitTokens: number | null;
  samples: readonly ContextUsageSample[];
  resets: readonly ContextResetMark[];
}

/** `'/compact'`, `'compact'`, `' /Compact '` ⇒ `'compact'`; anything else ⇒ `null`. */
export function normalizeContextResetKind(cmd: unknown): ContextResetKind | null {
  if (typeof cmd !== 'string') return null;
  const bare = cmd.trim().replace(/^\//, '').toLowerCase();
  return bare === 'compact' || bare === 'clear' ? bare : null;
}

/**
 * Trim a history ring IN PLACE: everything older than 72 h first, then anything
 * still above `maxEntries`, oldest-first.
 *
 * Both bounds matter and neither subsumes the other: the age bound is the
 * operator's contract (three sliding days), the count bound is what makes the
 * memory footprint independent of the TTL knob. Called on append and on read —
 * that is the whole eviction policy, and it is why this feature adds no timer.
 *
 * Entries are assumed appended in clock order, which is what the tracker does.
 */
export function evictContextHistory(
  entries: { t: number }[],
  nowMs: number,
  maxEntries: number,
): void {
  const cutoff = nowMs - CONTEXT_HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < entries.length) {
    const entry = entries[drop];
    if (entry === undefined || entry.t >= cutoff) break;
    drop++;
  }
  const overflow = entries.length - drop - Math.max(0, maxEntries);
  if (overflow > 0) drop += overflow;
  if (drop > 0) entries.splice(0, drop);
}

// ---------------------------------------------------------------------------
// The burn ring — Lot 12, memory only, no timer, and NO STORED PRICE
// ---------------------------------------------------------------------------

/**
 * One point of the burn ring: the four CUMULATIVE counters as they stood at a
 * tick (docs/monitoring-agents.md, Lot 12).
 *
 * TOKENS, NOT DOLLARS. A rate card is a live thing — models get repriced, and
 * a catalogue that was cold at boot warms up minutes later. A ring of stored
 * costs would freeze yesterday's price list into today's burn rate, and there
 * would be no way to notice. Storing counters keeps the SAME property the rest
 * of Lot 11 has: money is a multiplication done at READ time, so a price
 * correction upstream fixes every figure, retroactively and for free.
 */
export interface TokenBurnSample {
  t: number;
  counters: TokenUsageCounters;
}

/** The trailing window a burn rate is measured over. */
export const BURN_WINDOW_MS = 60 * 60 * 1000;

/**
 * Shortest span that may be extrapolated to an hour.
 *
 * Below this, one expensive turn landing inside a two-minute span multiplies
 * out to a burn rate thirty times the truth, and the operator reads it as a
 * runaway team. `null` — the UI renders `—` — is the honest answer until the
 * ring is wide enough to divide by.
 */
export const BURN_MIN_SPAN_MS = 10 * 60 * 1000;

/**
 * USD/hour over the trailing hour, or `null` when the question cannot be
 * answered honestly. Pure — the whole burn contract is testable without a
 * session, a clock or a catalogue.
 *
 * `(counters(newest) − counters(ref)) priced, ÷ Δh`, where `ref` is the OLDEST
 * sample still inside the window. Oldest rather than "the one nearest an hour
 * ago": the counters are cumulative, so any two points bracket a true delta,
 * and taking the widest available pair is what makes the figure stop swinging
 * on a team that has only been up for twenty minutes.
 *
 * `null` when: fewer than two samples in the window, a span under
 * {@link BURN_MIN_SPAN_MS}, or no rate card. Never `0` for "I don't know" — a
 * team burning nothing and a team we cannot price look nothing alike to an
 * operator deciding whether to kill it.
 */
export function estimateBurnPerHourUsd(
  samples: readonly TokenBurnSample[],
  rates: TokenCostRates | null | undefined,
  nowMs: number,
): number | null {
  if (!rates) return null;
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const since = nowMs - BURN_WINDOW_MS;
  let ref: TokenBurnSample | null = null;
  let newest: TokenBurnSample | null = null;
  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.t) || sample.t < since) continue;
    if (ref === null || sample.t < ref.t) ref = sample;
    if (newest === null || sample.t >= newest.t) newest = sample;
  }
  if (ref === null || newest === null) return null;
  const spanMs = newest.t - ref.t;
  if (spanMs < BURN_MIN_SPAN_MS) return null;
  // Cumulative counters only ever grow; a decrease means a resumed session
  // re-based its source. Clamp rather than report a negative burn.
  const delta: TokenUsageCounters = {
    in: Math.max(0, newest.counters.in - ref.counters.in),
    out: Math.max(0, newest.counters.out - ref.counters.out),
    cacheRead: Math.max(0, newest.counters.cacheRead - ref.counters.cacheRead),
    cacheWrite: Math.max(0, newest.counters.cacheWrite - ref.counters.cacheWrite),
  };
  const usd = estimateTokenCostUsd(delta, rates);
  if (usd === null) return null;
  return Math.round((usd / (spanMs / (60 * 60 * 1000))) * 1_000_000) / 1_000_000;
}

/** The three windows the graph offers. Anything else is a 400, never a guess. */
export type ContextHistoryWindow = '1h' | '24h' | '3d';

/**
 * Span and bucket size per window.
 *
 * `bucketMs: 0` ⇒ raw samples: over one hour at the default TTL that is ≤ 240
 * points, and downsampling a graph nobody can read closer than a pixel would
 * only lose detail. The two long windows bucket to 288 points each.
 */
const CONTEXT_HISTORY_WINDOWS: Record<
  ContextHistoryWindow,
  { spanMs: number; bucketMs: number }
> = {
  '1h': { spanMs: 60 * 60 * 1000, bucketMs: 0 },
  '24h': { spanMs: 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
  '3d': { spanMs: CONTEXT_HISTORY_WINDOW_MS, bucketMs: 15 * 60 * 1000 },
};

/** `undefined` / `''` ⇒ the default `1h`; an unknown value ⇒ `null` ⇒ 400. */
export function parseContextHistoryWindow(raw: unknown): ContextHistoryWindow | null {
  if (raw === undefined || raw === null || raw === '') return '1h';
  if (raw === '1h' || raw === '24h' || raw === '3d') return raw;
  return null;
}

/** How far back a window reaches, for filtering the reset ring alongside. */
export function contextHistoryWindowMs(window: ContextHistoryWindow): number {
  return CONTEXT_HISTORY_WINDOWS[window].spanMs;
}

/** One bucket of the response: `t` is the bucket START, ISO 8601. */
export interface ContextHistoryPoint {
  t: string;
  min: number;
  max: number;
  last: number;
}

/**
 * Fold raw samples into at most `CONTEXT_HISTORY_MAX_POINTS` buckets — pure, so
 * the whole downsampling contract is testable without a session.
 *
 * MIN/MAX/LAST, never an average. The one event this graph exists to show is a
 * `/compact`: 180 000 tokens falling to 20 000 inside one five-minute bucket.
 * An averaged bucket renders that as a gentle slope, i.e. as the exact opposite
 * of what happened; carrying `min` alongside `last` keeps the cliff visible at
 * every zoom level. `last` is what the line is drawn through, `min`/`max` the
 * band around it.
 *
 * Buckets are aligned on the epoch (`floor(t / bucketMs)`), not on `nowMs`, so
 * two calls a second apart return the same buckets and a client can cache them.
 */
export function downsampleContextHistory(
  samples: readonly ContextUsageSample[],
  window: ContextHistoryWindow,
  nowMs: number,
): ContextHistoryPoint[] {
  const spec = CONTEXT_HISTORY_WINDOWS[window];
  const since = nowMs - spec.spanMs;
  const kept: ContextUsageSample[] = [];
  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.t) || !Number.isFinite(sample.used)) continue;
    if (sample.t < since) continue;
    kept.push(sample);
  }
  // The ring is appended in clock order; sorting costs nothing on sorted input
  // and makes the function total rather than order-dependent.
  kept.sort((a, b) => a.t - b.t);

  let bucketMs = spec.bucketMs;
  if (bucketMs <= 0) {
    if (kept.length <= CONTEXT_HISTORY_MAX_POINTS) {
      return kept.map((s) => ({
        t: new Date(s.t).toISOString(),
        min: s.used,
        max: s.used,
        last: s.used,
      }));
    }
    // A TTL far below the default (the knob allows it) can put thousands of
    // samples in one hour. Bucket rather than break the cap the client sizes
    // its rendering for.
    bucketMs = Math.ceil(spec.spanMs / CONTEXT_HISTORY_MAX_POINTS);
  }

  const points: ContextHistoryPoint[] = [];
  let openBucket: number | null = null;
  for (const sample of kept) {
    const start = Math.floor(sample.t / bucketMs) * bucketMs;
    if (start !== openBucket) {
      openBucket = start;
      points.push({
        t: new Date(start).toISOString(),
        min: sample.used,
        max: sample.used,
        last: sample.used,
      });
      continue;
    }
    const point = points[points.length - 1];
    if (point === undefined) continue;
    if (sample.used < point.min) point.min = sample.used;
    if (sample.used > point.max) point.max = sample.used;
    point.last = sample.used;
  }
  return points;
}

// ---------------------------------------------------------------------------
// The per-session tracker
// ---------------------------------------------------------------------------

/**
 * Everything a `Session` needs to be handed to track its context usage. Built
 * by `Orchestrator` (the only layer that holds both the `Config` and the model
 * catalogue) and passed down; absent ⇒ the session simply never tracks.
 */
export interface ContextUsageWiring {
  /** Refresh TTL in ms (`config.contextUsageTtlMs`). `0` ⇒ never read anything. */
  ttlMs: number;
  /**
   * Context limit of this session's model, re-read on EVERY snapshot rather
   * than captured once: the catalogue is cold at boot and warms up seconds
   * later, and a session spawned in that window would otherwise show `—` for
   * its whole life. Only consulted when the SOURCE reports no window of its own.
   */
  limitTokens?: () => number | null;
  /**
   * Bounded tail reader for this session's transport (claude transcripts, codex
   * rollouts — both are files in the agent's namespace). Default: local fs.
   */
  readTail?: TranscriptTailReader;
  /**
   * Ranged reader for the same transport (Lot 11). Only claude uses it — codex
   * and opencode get their cumulative counters from the payload they already
   * read. Absent ⇒ no token accounting, and the gauge behaves exactly as it did
   * before Lot 11.
   */
  readRange?: TranscriptRangeReader;
  /**
   * Lists a codex `CODEX_HOME`'s rollout files in the agent's namespace. Same
   * transport split as `readTail`; ignored by every other provider.
   */
  listRollouts?: RolloutLister;
  /**
   * Per-million prices of this session's model, re-read on every view for the
   * same reason as `limitTokens`: the catalogue is cold at boot. `null` per
   * bucket, or `null` outright, when nothing can answer — and then `costUsd`
   * is `null` rather than a figure nobody quoted.
   *
   * Read by `Session.toView()`, not by the tracker: the tracker counts tokens,
   * money is a view-time multiplication.
   */
  costRates?: () => TokenCostRates | null;
}

/**
 * Structural mirror of `context-usage-codex.ts#RolloutLister`.
 *
 * Declared here rather than imported so the wiring type — which `Session` and
 * `Orchestrator` both hold — does not drag the codex module into every consumer
 * of this file. The codex module aliases this exact shape.
 */
export type RolloutLister = (
  sessionsDir: string,
) => Promise<readonly { path: string; mtimeMs: number }[]>;

export interface ContextUsageTrackerOptions extends ContextUsageWiring {
  /** For log correlation only. */
  sessionId: string;
  /** Injectable clock — same seam as the catalogue / availability caches. */
  now?: () => number;
  maxTailBytes?: number;
  maxRangeBytes?: number;
  /**
   * Where the number comes from. Defaults to the claude transcript source built
   * from `readTail`/`maxTailBytes`, which is what every pre-Lot-6 call site
   * expects; codex and opencode pass their own.
   */
  source?: ContextUsageSource;
  /**
   * Lot 11 — called with every accepted delta, so the `Session` can mirror the
   * running totals into the shape everything durable is built from
   * (`toView()`), exactly as `Mailbox` mirrors `messagesProcessed`. Never
   * called with a zero delta: a poll that measured nothing must not cost a
   * state notification.
   */
  onTokenUsage?: (delta: TokenUsageCounters) => void;
  /**
   * Lot 13 — same mirror, same rules, for the dollars a provider reported
   * itself. Separate from `onTokenUsage` because the two are independent
   * measurements: a source may know the tokens and not the price, and the
   * session persists them in different columns.
   */
  onReportedCost?: (deltaUsd: number) => void;
}

export class ContextUsageTracker {
  readonly #sessionId: string;
  readonly #ttlMs: number;
  readonly #limitTokens: () => number | null;
  readonly #source: ContextUsageSource;
  readonly #now: () => number;

  #usedTokens: number | null = null;
  /**
   * Window the source itself last reported, which outranks the catalogue. Kept
   * once set: codex puts it on every usage event and opencode caches it for the
   * process's life, so a read that fails to carry one is a gap, not a retraction.
   */
  #sourceLimitTokens: number | null = null;
  #updatedAt: string | null = null;
  #stale = false;
  /** Epoch ms stamped at the START of a refresh, so a slow read cannot pile up. */
  #refreshStartedAtMs: number | null = null;
  #inFlight = false;
  #warnedAtMs: number | null = null;
  /**
   * Bumped whenever what we are reading stops describing the live context (a
   * rotation, a reset). A read that started before the bump is discarded when
   * it lands: it would otherwise overwrite `stale: true` with a `stale: false`
   * carrying the PREVIOUS conversation's number — the one case where this
   * feature could report a confident wrong figure rather than an honest stale one.
   */
  #generation = 0;
  /**
   * Lot 9 — the rolling history, oldest first. Provider-agnostic by
   * construction: claude, codex and opencode all reach the same ring through
   * the same `#run`, because it is the TRACKER that accepts a sample, not the
   * source. Bounded by `evictContextHistory` on every append and every read;
   * nothing here is ever persisted or serialized for a dead session.
   */
  readonly #samples: ContextUsageSample[] = [];
  readonly #resets: ContextResetMark[] = [];
  /**
   * Lot 12 — the burn ring, appended at exactly the same tick as `#samples`
   * and evicted by exactly the same policy (72 h, then the count cap). Same
   * ring rate means the two histories line up point for point, which is what
   * lets an operator read a cost spike against the `/compact` that caused it.
   */
  readonly #burn: TokenBurnSample[] = [];
  /**
   * Lot 11 — what this tracker's source has billed since the process started.
   * The `Session` keeps the authoritative total (it carries the resume seed);
   * this copy is what makes the tracker testable on its own.
   */
  #tokens: TokenUsageCounters = emptyTokenUsage();
  readonly #onTokenUsage: ((delta: TokenUsageCounters) => void) | null;
  /** Lot 13 — the same, in dollars the provider itself quoted. */
  #reportedCostUsd = 0;
  readonly #onReportedCost: ((deltaUsd: number) => void) | null;
  /**
   * Lot 13 — the account quota, LAST reading wins and nothing accumulates.
   *
   * The opposite of the counters above by nature: a rolling-window percentage
   * is a level, not a flow, and the only honest answer is the freshest one the
   * source has seen. Never cleared by a reset either — a `/clear` throws away a
   * context, not an account's consumption.
   */
  #quota: ProviderQuotaView | null = null;

  constructor(opts: ContextUsageTrackerOptions) {
    this.#sessionId = opts.sessionId;
    this.#ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 0;
    this.#limitTokens = opts.limitTokens ?? (() => null);
    this.#now = opts.now ?? (() => Date.now());
    this.#onTokenUsage = opts.onTokenUsage ?? null;
    this.#onReportedCost = opts.onReportedCost ?? null;
    this.#source =
      opts.source ??
      new TranscriptContextSource({
        readTail: opts.readTail,
        maxTailBytes: opts.maxTailBytes,
        ...(opts.readRange ? { readRange: opts.readRange } : {}),
        ...(opts.maxRangeBytes !== undefined ? { maxRangeBytes: opts.maxRangeBytes } : {}),
      });
  }

  /** Cumulative tokens this tracker has billed. A copy — callers may not mutate. */
  get tokenUsage(): TokenUsageCounters {
    return { ...this.#tokens };
  }

  /** Lot 13 — cumulative dollars the PROVIDER reported. `0` when none ever did. */
  get reportedCostUsd(): number {
    return this.#reportedCostUsd;
  }

  /** Lot 13 — the freshest account quota this tracker's source has seen. */
  get providerQuota(): ProviderQuotaView | null {
    return this.#quota === null ? null : { ...this.#quota };
  }

  /** `false` under `SWARM_OS_CONTEXT_USAGE_TTL_MS=0` — the tracker never reads. */
  get enabled(): boolean {
    return this.#ttlMs > 0;
  }

  /** What the source is following (tests / diagnostics). */
  get target(): string | null {
    return this.#source.target;
  }

  /** The claude spelling of `target` — a transcript path. */
  get transcriptPath(): string | null {
    return this.#source.target;
  }

  /**
   * Adopt the target a provider callback just reported — ALWAYS the newest one,
   * never the first. For claude that is the transcript path from `SessionStart`;
   * for codex the `thread-id` from `notify`.
   *
   * `/clear` ROTATES what we read (claude: spike S4 — new CLI `session_id`, new
   * file, the old one left orphaned on disk; codex: a new thread and a new
   * rollout) while `/compact` keeps it in place. Keeping a boot-time target
   * therefore means reading a dead conversation for the rest of the session's
   * life. When the target changes under us the previous count describes a
   * conversation that no longer exists, so the snapshot goes stale until a new
   * turn has actually been read back.
   */
  retarget(target: string): void {
    if (typeof target !== 'string') return;
    const next = target.trim();
    if (next.length === 0) return;
    const retarget = this.#source.retarget;
    if (typeof retarget !== 'function') return;
    const had = this.#source.target !== null;
    if (!retarget.call(this.#source, next)) return;
    if (!had) return;
    this.#stale = true;
    this.#generation++;
    // The target changed: the TTL of the OLD one must not delay the first read
    // of the new one.
    this.#refreshStartedAtMs = null;
  }

  /** The claude spelling of `retarget`. */
  setTranscriptPath(filePath: string): void {
    this.retarget(filePath);
  }

  /**
   * Mark the current number as no longer describing the live context.
   *
   * Called when a `/clear` or `/compact` was actually typed into the PTY. Note
   * the asymmetry the spike measured: a `/compact` the CLI REFUSES ("Not enough
   * messages to compact") fires no `SessionStart` at all, so nothing here may
   * wait on a hook callback — the flag simply clears on the next successful read.
   *
   * The source is told too. claude does not care (the hook hands back a path, and
   * a rotated file cannot hold the old number anyway), but codex and opencode
   * both keep serving the pre-reset conversation from the same place for a turn
   * or two, and only they can tell that measurement from a post-reset one.
   */
  markStale(): void {
    this.#stale = true;
    this.#generation++;
    this.#refreshStartedAtMs = null;
    try {
      this.#source.invalidate?.();
    } catch {
      /* a source may not break the reset path */
    }
  }

  /**
   * Record a `/compact` or `/clear` that ACTUALLY reached the PTY.
   *
   * Called from the post-submission callback of `Session._fireContextReset`,
   * and from nowhere else — in particular never from a hook: a `/compact` the
   * CLI refuses ("Not enough messages to compact") fires no `SessionStart` at
   * all (spike S1d), and a marker on the graph for a reset that never happened
   * is worse than no marker.
   *
   * Slash spelling accepted and stripped: the ring stores the wire vocabulary.
   */
  recordReset(cmd: string): void {
    const kind = normalizeContextResetKind(cmd);
    if (kind === null) return;
    const at = this.#now();
    this.#resets.push({ t: at, cmd: kind });
    evictContextHistory(this.#resets, at, CONTEXT_HISTORY_MAX_RESETS);
  }

  /**
   * The rolling history, evicted at read time (the other half of "no timer").
   * Arrays are copies: a caller may not mutate the rings.
   */
  history(): ContextUsageHistory {
    const now = this.#now();
    evictContextHistory(this.#samples, now, CONTEXT_HISTORY_MAX_SAMPLES);
    evictContextHistory(this.#resets, now, CONTEXT_HISTORY_MAX_RESETS);
    return {
      limitTokens: this.#resolvedLimit(),
      samples: this.#samples.slice(),
      resets: this.#resets.slice(),
    };
  }

  /**
   * Lot 12 — the burn ring, evicted at read time like `history()`. A copy of
   * every entry: a caller may not mutate the ring, and `counters` is an object.
   */
  burnSamples(): readonly TokenBurnSample[] {
    const now = this.#now();
    evictContextHistory(this.#burn, now, CONTEXT_HISTORY_MAX_SAMPLES);
    return this.#burn.map((s) => ({ t: s.t, counters: { ...s.counters } }));
  }

  /**
   * USD/hour over the trailing hour for THIS agent, priced at read time from
   * the rate card the caller hands in. `null` whenever
   * {@link estimateBurnPerHourUsd} cannot answer honestly.
   */
  burnPerHourUsd(rates: TokenCostRates | null | undefined): number | null {
    const now = this.#now();
    evictContextHistory(this.#burn, now, CONTEXT_HISTORY_MAX_SAMPLES);
    return estimateBurnPerHourUsd(this.#burn, rates, now);
  }

  /**
   * The last `maxPoints` samples as integer percentages, for the sparkline the
   * `/orchestrators` poll carries for free (~20 small integers per session).
   *
   * `null` — the field then stays ABSENT from the view — when there is no
   * history yet or no limit to divide by: a sparkline whose scale is unknown
   * would be a shape without a meaning.
   */
  spark(maxPoints = CONTEXT_SPARK_POINTS): number[] | null {
    const limit = this.#resolvedLimit();
    if (limit === null) return null;
    const now = this.#now();
    evictContextHistory(this.#samples, now, CONTEXT_HISTORY_MAX_SAMPLES);
    if (this.#samples.length === 0) return null;
    const from = Math.max(0, this.#samples.length - Math.max(1, maxPoints));
    const out: number[] = [];
    for (let i = from; i < this.#samples.length; i++) {
      const sample = this.#samples[i];
      if (sample === undefined) continue;
      out.push(Math.round(Math.min(1, Math.max(0, sample.used / limit)) * 100));
    }
    return out.length > 0 ? out : null;
  }

  /**
   * The denominator, resolved once for every consumer. The window the CLI
   * itself reported wins over the catalogue: it is the EFFECTIVE window of the
   * running binary (codex serves 258 400 for a model whose own cache advertises
   * 272 000), and a gauge must divide by the number the agent is actually being
   * cut off at.
   */
  #resolvedLimit(): number | null {
    let limit: number | null = this.#sourceLimitTokens;
    if (limit === null) {
      try {
        limit = this.#limitTokens();
      } catch {
        limit = null;
      }
    }
    return limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null;
  }

  /** Synchronous, cache-only. `null` until a turn has actually been read. */
  snapshot(): ContextUsageView | null {
    const used = this.#usedTokens;
    if (used === null || this.#updatedAt === null) return null;
    const limitTokens = this.#resolvedLimit();
    return {
      usedTokens: used,
      limitTokens,
      pct: limitTokens === null ? null : Math.min(1, used / limitTokens),
      basis: this.#source.basis,
      updatedAt: this.#updatedAt,
      stale: this.#stale,
    };
  }

  /**
   * Fire-and-forget refresh, TTL-gated. Returns immediately, always.
   *
   * Three guards, in the order a caller meets them: the in-flight flag (a read
   * slower than the poll must not stack), the TTL clock (stamped at the START
   * of the read, so a 10 s SSH read does not licence a second read the instant
   * it finishes) and the module-wide concurrency cap.
   */
  maybeRefresh(): void {
    if (!this.enabled) return;
    if (!this.#source.ready) return;
    if (this.#inFlight) return;
    const now = this.#now();
    if (this.#refreshStartedAtMs !== null && now - this.#refreshStartedAtMs < this.#ttlMs) {
      return;
    }
    if (activeRefreshes >= CONTEXT_USAGE_MAX_CONCURRENT_REFRESH) {
      // No clock stamp: this is a deferral, not an attempt. The next poll (3 s)
      // retries rather than waiting out a TTL nobody spent.
      return;
    }
    this.#refreshStartedAtMs = now;
    this.#inFlight = true;
    activeRefreshes++;
    void this.#run()
      .catch(() => {
        /* `#run` cannot reject — belt to its braces */
      })
      .finally(() => {
        this.#inFlight = false;
        activeRefreshes--;
      });
  }

  /** Never rejects. Every failure keeps the previous snapshot and marks it stale. */
  async #run(): Promise<void> {
    const generation = this.#generation;
    let reading: ContextUsageReading;
    try {
      reading = await this.#source.read();
    } catch {
      // The contract says a source never throws; this is the belt to its braces.
      reading = { kind: 'unavailable', reason: 'source-threw' };
    }
    // Lot 11 — BEFORE the generation guard, and whatever the outcome. Tokens
    // are a delta the source has already committed to (its cursor moved, its
    // counter re-based), and a `/clear` that lands mid-read invalidates the
    // GAUGE, not the invoice. Dropping the delta here would silently lose spend
    // on exactly the polls where an agent is being reset the most.
    this.#bill(reading.tokens);
    // Lot 13 — same placement, same argument. The dollars are half of the same
    // invoice, and the quota is an ACCOUNT-level level reading that a context
    // reset has no opinion about whatsoever.
    this.#billReportedCost(reading.reportedCostUsd);
    this.#acceptQuota(reading.quota);
    // A `/clear` or a reset landed while we were reading: whatever we just read
    // is about a conversation that no longer exists. The invalidation already
    // marked the snapshot stale and re-opened the TTL, so the next poll reads
    // the right thing — this read simply never happened.
    if (this.#generation !== generation) return;
    if (reading.kind === 'unavailable') {
      this.#stale = true;
      this.#warnRead(reading.reason);
      return;
    }
    if (reading.kind === 'empty') {
      // The source is fine and has nothing to say yet — a rollout the first
      // model request has not created, a turn still running, a transcript
      // freshly rotated by `/clear`. Whatever we last counted belongs to the
      // previous state, so it stays visible but stale.
      this.#stale = true;
      return;
    }
    this.#usedTokens = reading.usedTokens;
    const limit = reading.limitTokens;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      this.#sourceLimitTokens = Math.floor(limit);
    }
    const at = this.#now();
    this.#updatedAt = new Date(at).toISOString();
    this.#stale = false;
    // Lot 9 — this is the ONE place a sample is accepted, so it is the one
    // place the history grows. An `empty` (a rotated transcript, a turn still
    // running) measured nothing and must not flatten the graph with a repeat of
    // the previous point.
    this.#samples.push({ t: at, used: reading.usedTokens });
    evictContextHistory(this.#samples, at, CONTEXT_HISTORY_MAX_SAMPLES);
    // Lot 12 — the cumulative counters as of this tick. `#bill` ran above, so
    // whatever this read measured is already in them. No price is computed and
    // none is stored: see `TokenBurnSample`.
    this.#burn.push({ t: at, counters: { ...this.#tokens } });
    evictContextHistory(this.#burn, at, CONTEXT_HISTORY_MAX_SAMPLES);
  }

  /**
   * Add one source-reported delta to the running totals and mirror it out.
   *
   * A zero delta is dropped on the floor rather than propagated: the mirror
   * costs a state notification (and, downstream, a throttled DB write), and the
   * overwhelming majority of polls measure nothing new.
   */
  #bill(delta: TokenUsageCounters | undefined): void {
    if (delta === undefined) return;
    const clean = normalizeTokenUsage(delta);
    if (isZeroTokenUsage(clean)) return;
    this.#tokens = addTokenUsage(this.#tokens, clean);
    if (this.#onTokenUsage === null) return;
    try {
      this.#onTokenUsage(clean);
    } catch {
      /* a mirror may not break the read path */
    }
  }

  /**
   * Lot 13 — add one source-reported cost delta to the running total.
   *
   * Same "zero is dropped" rule as `#bill`, and the same reason: a mirror costs
   * a state notification. A negative or non-finite delta is a source bug, and it
   * is refused rather than allowed to walk a cumulative bill backwards.
   */
  #billReportedCost(deltaUsd: number | undefined): void {
    if (typeof deltaUsd !== 'number' || !Number.isFinite(deltaUsd) || deltaUsd <= 0) return;
    this.#reportedCostUsd += deltaUsd;
    if (this.#onReportedCost === null) return;
    try {
      this.#onReportedCost(deltaUsd);
    } catch {
      /* a mirror may not break the read path */
    }
  }

  /**
   * Lot 13 — adopt the newest account quota. A read that carries none leaves the
   * previous one standing: codex only re-publishes `rate_limits` when it has
   * something to say, so an absence is a silence, not a retraction.
   */
  #acceptQuota(quota: ProviderQuotaView | undefined): void {
    if (quota === undefined || quota === null) return;
    this.#quota = { ...quota };
  }

  /** One line per throttle window: a missing transcript is a poll-rate event. */
  #warnRead(reason: string): void {
    const now = this.#now();
    if (this.#warnedAtMs !== null && now - this.#warnedAtMs < READ_WARN_THROTTLE_MS) return;
    this.#warnedAtMs = now;
    log.warn({
      event: 'context_usage.read_failed',
      sessionId: this.#sessionId,
      basis: this.#source.basis,
      target: this.#source.target,
      reason,
    });
  }
}
