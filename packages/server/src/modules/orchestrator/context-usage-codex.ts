/**
 * Context-window occupancy of a codex session (docs/monitoring-agents.md, Lot 6).
 *
 * WHERE THE NUMBER COMES FROM. codex writes a `rollout` JSONL for every thread,
 * under the per-session `CODEX_HOME` swarm-os already creates and owns
 * (`providers/codex.ts#prepareSessionConfig`):
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<thread-uuid>.jsonl
 *
 * It is flushed continuously — the spike watched it grow WHILE a turn was still
 * running — so a bounded tail read of a live agent is not merely possible, it is
 * the same read `tail -c` would do. Cost: zero model requests, zero network,
 * zero extra CLI flags. We are reading a file codex writes anyway.
 * (`scripts/verify-codex-rollout.report.md`, 6/6 CONFIRMED.)
 *
 * THE ONE FIELD, AND THE ONE THAT LOOKS LIKE IT. Usage rides
 * `{"type":"event_msg","payload":{"type":"token_count","info":{…}}}`, and `info`
 * carries TWO counters with almost the same name:
 *
 *   `last_token_usage`  — the accounting of the MOST RECENT request. Since every
 *                         request re-sends the whole conversation, this IS the
 *                         current footprint. ✅ read this.
 *   `total_token_usage` — the CUMULATIVE billing counter for the session. On a
 *                         real rollout from this machine it reached 11 724 290
 *                         against a 258 400-token window: 45×. A gauge built on
 *                         it reads 4 500 %. ❌ never.
 *
 * Cross-checked against codex itself: `/status` prints "Context window: 57% left
 * (119K used / 258K)" and the "used" it displays is exactly
 * `last_token_usage.total_tokens` from the rollout (R4). We read what codex reads.
 *
 * THREE TRAPS, all measured:
 *
 *  1. **`info` is nullable.** Some `token_count` events carry only `rate_limits`
 *     (2 of 8 in the spike run). Reading them as `0` would drop the gauge to
 *     zero at random. They are skipped, not read.
 *  2. **The rollout does not exist at boot.** A control run that spawned the TUI
 *     and typed NOTHING never saw a file appear: it is created by the first
 *     model request. The absence is a normal phase, not a failure.
 *  3. **After `/new` the next rollout is created LAZILY.** Its filename carries
 *     the timestamp of the `/new`, but the file only materialises at the new
 *     thread's first model request — so "most recent by mtime" keeps resolving
 *     to the previous, complete, plausible-looking file. That is why the primary
 *     key is the `thread-id` codex hands us in its `notify` payload, which flips
 *     immediately; mtime is only the bootstrap, before any turn has completed.
 *
 * `cached_input_tokens` is a SUBSET of `input_tokens` (prompt cache), not an
 * addition — summing them double-counts. `total_tokens` already has it right.
 *
 * PERCENTAGE. We keep the RAW ratio `last.total_tokens / model_context_window`.
 * codex's own `/status` subtracts an incompressible baseline (system prompt +
 * tool schemas, bracketed by the spike at ~11–15 K) before displaying a
 * percentage, which is why it still says "100% left" at 11 626 tokens used. The
 * raw ratio is the physical occupancy and therefore the honest trigger for "when
 * do I compact?"; reproducing codex's cosmetic offset would mean pinning a
 * constant fitted to two measurements.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config.js';
import { hostExec as nodeHostExec } from './ssh-exec.js';
import {
  TRANSCRIPT_READ_TIMEOUT_MS,
  TRANSCRIPT_TAIL_BYTES,
  createLocalTailReader,
  emptyTokenUsage,
  isZeroTokenUsage,
  type ContextUsageBasis,
  type ContextUsageReading,
  type ContextUsageSource,
  type ProviderQuotaView,
  type TailHostExec,
  type TokenUsageCounters,
  type TranscriptTailReader,
} from './context-usage.js';

/** One rollout file, as a lister found it. */
export interface RolloutFile {
  path: string;
  /** Epoch ms. `0` when the transport could not report one — see the ssh lister. */
  mtimeMs: number;
}

/**
 * Lists the rollout files of ONE `CODEX_HOME`'s `sessions/` tree. Never throws:
 * a missing directory (the normal state before the first turn) is an empty list.
 */
export type RolloutLister = (sessionsDir: string) => Promise<readonly RolloutFile[]>;

/**
 * Ceiling on files returned by a lister. A per-session `CODEX_HOME` holds one
 * rollout per thread — 2 after a single `/new`, a handful over a long day — so
 * this is not a budget, it is a guard against walking a directory that turned
 * out to be something else entirely.
 */
export const MAX_ROLLOUT_FILES = 512;

/** `sessions/YYYY/MM/DD/rollout-*.jsonl` — three levels, and we walk no deeper. */
const ROLLOUT_WALK_MAX_DEPTH = 4;

/**
 * How many rollout files one source keeps a billing base for (Lot 11). A
 * session's `CODEX_HOME` gains one per `/new`; only the newest can still be
 * resolved to, so anything beyond a handful is dead weight.
 */
const MAX_TRACKED_ROLLOUTS = 8;

const ROLLOUT_PREFIX = 'rollout-';
const ROLLOUT_SUFFIX = '.jsonl';

// ---------------------------------------------------------------------------
// The parser — pure, exported, reusable by the future cost module
// ---------------------------------------------------------------------------

export interface CodexRolloutUsage {
  usedTokens: number;
  /** codex's EFFECTIVE window, straight off the event. `null` when absent. */
  limitTokens: number | null;
  /** Event timestamp in epoch ms, or `null` when unparseable. */
  at: number | null;
  /**
   * `total_token_usage` — the CUMULATIVE billing counter of this thread
   * (docs/monitoring-agents.md, Lot 11).
   *
   * The very field the gauge above refuses, and for the very reason it refuses
   * it: it is a running total, not an occupancy. That makes it wrong for a
   * percentage and exactly right for a bill. `null` when the event carries none.
   */
  totals: TokenUsageCounters | null;
}

/**
 * Occupancy of the newest usage-bearing `token_count` event in a rollout tail,
 * or `null` when the tail holds none.
 *
 * `text` is expected to be the LAST bytes of a `.jsonl`, so its first line is
 * usually cut in half. No special case is needed: a JSON object sliced mid-way
 * never parses, and `JSON.parse` is guarded per line.
 *
 * Scans BACKWARDS and stops at the first hit — trap 3 of the claude parser
 * applies here for a different reason: a turn emits one event per MODEL REQUEST,
 * consecutive events can repeat identical numbers, and each one already
 * describes the whole conversation. Keep the latest, never accumulate.
 */
export function parseContextUsageFromCodexRolloutTail(text: string): CodexRolloutUsage | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partial head line, or a line that is not JSON at all.
      continue;
    }
    const row = asRecord(parsed);
    if (!row || row.type !== 'event_msg') continue;
    const payload = asRecord(row.payload);
    if (!payload || payload.type !== 'token_count') continue;
    // Trap 1 — a rate-limit-only refresh. `info` is genuinely `null` there, and
    // reading it as zero would drop the gauge to 0 % at random.
    const info = asRecord(payload.info);
    if (!info) continue;
    const used = lastRequestTokens(info.last_token_usage);
    // An `info` we cannot read is not a zero either: keep scanning backwards for
    // an event we can.
    if (used === null) continue;
    return {
      usedTokens: used,
      limitTokens: positiveInt(info.model_context_window),
      at: epochMs(row.timestamp),
      totals: cumulativeTokens(info.total_token_usage),
    };
  }
  return null;
}

/**
 * What `rate_limits` boils down to. Structurally the view the API serves, so
 * nothing has to re-map it on the way out.
 */
export type CodexRateLimits = ProviderQuotaView;

/**
 * The account quota codex carries on its `token_count` events (Lot 13).
 *
 * Scans BACKWARDS for the newest event carrying a readable `rate_limits`, and —
 * unlike the gauge parser above — it does NOT skip the events whose `info` is
 * `null`. Those are precisely the rate-limit-only refreshes codex emits
 * before/independently of a model request (2 of 8 in the spike), so they are the
 * FRESHEST quota readings in the file. Lot 6 ignores them; this is the read that
 * makes them worth their bytes.
 *
 * A `rate_limits` we cannot read a single field out of is skipped rather than
 * returned all-null, the same rule `parseContextUsageFromCodexRolloutTail`
 * applies to an unreadable `info`: an older reading we understand beats a
 * newer one we do not.
 */
export function parseCodexRateLimitsFromTail(text: string): CodexRateLimits | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = asRecord(parsed);
    if (!row || row.type !== 'event_msg') continue;
    const payload = asRecord(row.payload);
    if (!payload || payload.type !== 'token_count') continue;
    const limits = asRecord(payload.rate_limits);
    if (!limits) continue;
    const snapshot = readRateLimits(limits, epochMs(row.timestamp));
    if (snapshot !== null) return snapshot;
  }
  return null;
}

/**
 * `rate_limits` → the three fields the UI shows, or `null` when it holds none.
 *
 * `primary` is the short window (300 min in the spike) — the one that actually
 * throttles an agent mid-shift. `secondary` (the weekly) is deliberately not
 * surfaced: two percentages in one chip say less than one.
 */
function readRateLimits(limits: Record<string, unknown>, eventAtMs: number | null): CodexRateLimits | null {
  const primary = asRecord(limits.primary);
  const usedPercent = percent(primary?.used_percent);
  const resetsAt = resetIso(primary, eventAtMs);
  const plan = nonEmptyString(limits.plan_type);
  if (usedPercent === null && resetsAt === null && plan === null) return null;
  return { usedPercent, resetsAt, plan };
}

/** 0-100, clamped. A quota outside that range is a field we misread — `null`. */
function percent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0) return 0;
  return v > 100 ? 100 : v;
}

/**
 * When the primary window rolls over, as an ISO string.
 *
 * `resets_at` is what the spike measured: an ABSOLUTE epoch, in SECONDS
 * (1788114884 → 2026-06-29T…). It is accepted in milliseconds too, on the
 * threshold that separates the two for any date this decade, because one field
 * silently switching unit is exactly the kind of upstream change that would
 * otherwise print the year 1970 in an operator's chip.
 *
 * `resets_in_seconds` is the RELATIVE spelling — not seen in the spike, kept
 * because a countdown is the other obvious way to publish this. It only means
 * anything against the event's own timestamp, so without one it is dropped
 * rather than dated from `Date.now()` (a tail can be minutes old).
 */
function resetIso(primary: Record<string, unknown> | null, eventAtMs: number | null): string | null {
  if (primary === null) return null;
  const absolute = primary.resets_at;
  if (typeof absolute === 'number' && Number.isFinite(absolute) && absolute > 0) {
    const ms = absolute < EPOCH_SECONDS_CEILING ? absolute * 1000 : absolute;
    return isoOrNull(ms);
  }
  const relative = primary.resets_in_seconds;
  if (typeof relative === 'number' && Number.isFinite(relative) && relative >= 0 && eventAtMs !== null) {
    return isoOrNull(eventAtMs + relative * 1000);
  }
  return null;
}

/**
 * Below this, a positive epoch is in seconds; at or above it, milliseconds.
 * (1e12 ms = 2001-09-09; 1e12 s is the year 33 658.)
 */
const EPOCH_SECONDS_CEILING = 1e12;

function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * `total_token_usage` → the four buckets, or `null`.
 *
 * `cached_input_tokens` is a SUBSET of `input_tokens`, not an addition (the
 * header says it twice because it is the one field that silently doubles a
 * bill): the cached half is subtracted out and moved to `cacheRead`, so the two
 * buckets stay disjoint and `in` means "billed at the full input rate".
 *
 * codex publishes no cache-CREATION counter — the API it talks to bills cache
 * writes inside `input_tokens` — so `cacheWrite` is 0. That is a measured
 * absence, not a gap we could fill.
 */
function cumulativeTokens(value: unknown): TokenUsageCounters | null {
  const total = asRecord(value);
  if (!total) return null;
  const input = nonNegativeInt(total.input_tokens);
  const cached = Math.min(nonNegativeInt(total.cached_input_tokens), input);
  const output = nonNegativeInt(total.output_tokens);
  if (input === 0 && output === 0 && cached === 0) {
    // `null`, NOT a zeroed record — the same rule `lastRequestTokens` applies
    // to `info`, and for a sharper reason here. A `total_token_usage` we cannot
    // read by these field names (an upstream rename, a nesting change, `{}`)
    // would otherwise be adopted as a BASE of zero, and the next event that did
    // parse would be billed in full a second time. Answering `null` leaves the
    // previous base standing, which is right whether this record is unreadable
    // or genuinely still at zero.
    return null;
  }
  return { in: input - cached, out: output, cacheRead: cached, cacheWrite: 0 };
}

/** Like `positiveInt` but `0` is a value, not an absence. */
function nonNegativeInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * `current − base`, per bucket, clamped at zero — and the ONE case where the
 * clamp would lie is caught first.
 *
 * A cumulative counter that RECEDES did not un-spend anything: it is a NEW
 * counter, started from zero by a new thread (`/new`) or by a rollout file
 * recreated under a name we had already read. Everything it now shows is spend
 * we have never billed, so the whole current value is the delta.
 */
export function codexTokenDelta(
  current: TokenUsageCounters,
  base: TokenUsageCounters | null,
): TokenUsageCounters {
  if (base === null) return { ...current };
  if (
    current.in < base.in ||
    current.out < base.out ||
    current.cacheRead < base.cacheRead ||
    current.cacheWrite < base.cacheWrite
  ) {
    // A cumulative that RECEDES under the SAME key is a rewritten/corrupt
    // counter, not a fresh thread (a new thread arrives under a new key with a
    // null base). Everything up to `base` was already billed, so billing the
    // whole new cumulative would double-count — err low: bill nothing and let
    // the caller re-base on `current`.
    return emptyTokenUsage();
  }
  return {
    in: current.in - base.in,
    out: current.out - base.out,
    cacheRead: current.cacheRead - base.cacheRead,
    cacheWrite: current.cacheWrite - base.cacheWrite,
  };
}

/**
 * `last_token_usage` → the footprint of the last request.
 *
 * `total_tokens` is the field codex's own `/status` displays, so it is what we
 * read. The `input + output` fallback exists only for a payload that somehow
 * omits it (the spike never saw one, and the two agreed to the token when both
 * were present); `cached_input_tokens` is deliberately NOT added — it is a
 * subset of `input_tokens`, and summing it double-counts the prompt cache.
 */
function lastRequestTokens(value: unknown): number | null {
  const last = asRecord(value);
  if (!last) return null;
  const total = positiveInt(last.total_tokens);
  if (total !== null) return total;
  const input = positiveInt(last.input_tokens);
  const output = positiveInt(last.output_tokens);
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

/**
 * Absent, not `null`, when the tail carried no quota — the tracker keeps its
 * previous reading on a silence, so an explicit `undefined` would be the same
 * thing said louder.
 */
function quotaOf(limits: CodexRateLimits | null): { quota?: CodexRateLimits } {
  return limits === null ? {} : { quota: limits };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** ISO 8601 → epoch ms. `null` for anything else, including a garbled string. */
function epochMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Resolution — which rollout is THIS agent writing right now?
// ---------------------------------------------------------------------------

/**
 * Pick the rollout that belongs to `threadId`, or the newest one when no thread
 * is known yet. Pure, so the whole trap-3 argument is testable without a codex.
 *
 * With a thread-id there is NO mtime fallback, and that is the entire point: for
 * as long as the new thread's file has not materialised, "most recent" resolves
 * to the previous file, which is complete, plausible and WRONG. Answering `null`
 * costs a poll cycle of `—`; answering the old file costs a wrong number nobody
 * can see is wrong.
 */
export function pickCodexRollout(
  files: readonly RolloutFile[],
  threadId: string | null,
): string | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (threadId !== null && threadId.length > 0) {
    const suffix = `-${threadId.toLowerCase()}${ROLLOUT_SUFFIX}`;
    for (const file of files) {
      const base = path.basename(file.path).toLowerCase();
      if (base.startsWith(ROLLOUT_PREFIX) && base.endsWith(suffix)) return file.path;
    }
    return null;
  }
  let newest: RolloutFile | null = null;
  for (const file of files) {
    if (newest === null || file.mtimeMs > newest.mtimeMs) newest = file;
  }
  return newest?.path ?? null;
}

/**
 * The two filesystem calls the local lister makes, narrowed to what it uses.
 * Narrower than `fs.promises.*` on purpose: the real signatures are a thicket of
 * overloads whose `Buffer`-flavoured branch has nothing to do with this walk,
 * and a test double should not have to satisfy it.
 */
export type RolloutReaddir = (
  dir: string,
  opts: { withFileTypes: true },
) => Promise<readonly { name: string; isDirectory(): boolean }[]>;
export type RolloutStat = (filePath: string) => Promise<{ mtimeMs: number }>;

/**
 * Local transport: walk `sessions/YYYY/MM/DD`. Depth- and count-bounded, and
 * every failure — starting with the directory not existing yet, which is the
 * normal state until the agent's first model request — is an empty list.
 */
export function createLocalRolloutLister(
  deps: { readdirImpl?: RolloutReaddir; statImpl?: RolloutStat } = {},
): RolloutLister {
  const readdir: RolloutReaddir =
    deps.readdirImpl ?? ((dir, opts) => fs.promises.readdir(dir, opts));
  const stat: RolloutStat = deps.statImpl ?? ((p) => fs.promises.stat(p));
  return async (sessionsDir) => {
    const out: RolloutFile[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > ROLLOUT_WALK_MAX_DEPTH || out.length >= MAX_ROLLOUT_FILES) return;
      let entries: Awaited<ReturnType<RolloutReaddir>>;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_ROLLOUT_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.name.startsWith(ROLLOUT_PREFIX) || !entry.name.endsWith(ROLLOUT_SUFFIX)) {
          continue;
        }
        try {
          const st = await stat(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch {
          // Vanished between readdir and stat. Keep it, ordered last: an exact
          // thread-id match does not need an mtime at all.
          out.push({ path: full, mtimeMs: 0 });
        }
      }
    };
    await walk(sessionsDir, 0);
    return out;
  };
}

/**
 * SSH transport: the `CODEX_HOME` lives in the HOST's namespace, so the listing
 * happens over there — same pattern as `providers/catalogue.ts#readCodexCache`.
 *
 * `find -printf` is GNU findutils. On a host whose `find` lacks it the command
 * fails outright, so a second, strictly portable call retrieves the paths alone.
 * Losing the mtimes costs nothing once a `thread-id` is known (an exact filename
 * match needs no ordering) and only degrades the pre-first-turn bootstrap, where
 * there is at most one file anyway.
 *
 * `hostExec` THROWS when the transport is not ssh, hence the guarded calls: a
 * lister must be value-returning under every configuration.
 */
export function createSshRolloutLister(
  config: Config,
  deps: { hostExec?: TailHostExec } = {},
): RolloutLister {
  const exec = deps.hostExec ?? nodeHostExec;
  const run = async (argv: string[]): Promise<string | null> => {
    try {
      const res = await exec(config, {
        argv,
        timeoutMs: TRANSCRIPT_READ_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024,
      });
      if (res.timedOut || res.code !== 0) return null;
      return res.stdout;
    } catch {
      return null;
    }
  };
  const findArgs = [
    'find',
    '',
    '-type',
    'f',
    '-name',
    `${ROLLOUT_PREFIX}*${ROLLOUT_SUFFIX}`,
  ];
  return async (sessionsDir) => {
    const argv = [...findArgs];
    argv[1] = sessionsDir;
    const withTimes = await run([...argv, '-printf', '%T@\t%p\n']);
    if (withTimes !== null) return parseFindOutput(withTimes, true);
    const pathsOnly = await run(argv);
    if (pathsOnly !== null) return parseFindOutput(pathsOnly, false);
    return [];
  };
}

/** `<epoch-seconds>\t<path>` (or a bare path) per line. Bad lines are dropped. */
function parseFindOutput(stdout: string, withTimes: boolean): RolloutFile[] {
  const out: RolloutFile[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (out.length >= MAX_ROLLOUT_FILES) break;
    if (!withTimes) {
      out.push({ path: line, mtimeMs: 0 });
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const seconds = Number.parseFloat(line.slice(0, tab));
    const filePath = line.slice(tab + 1);
    if (filePath.length === 0) continue;
    out.push({ path: filePath, mtimeMs: Number.isFinite(seconds) ? seconds * 1000 : 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export interface CodexRolloutSourceOptions {
  /**
   * `<CODEX_HOME>/sessions` **as the agent sees it** — the host path under SSH,
   * the container path locally. `Session` translates it through its path mapper.
   */
  sessionsDir: string;
  /** Bounded tail reader matching the session's transport. */
  readTail?: TranscriptTailReader;
  /** Rollout lister matching the session's transport. */
  listRollouts?: RolloutLister;
  maxTailBytes?: number;
  /**
   * This session came back from a persisted bill (Lot 11) — see
   * `#rebaseFirstBill`. `false` for a first spawn, whose `CODEX_HOME` holds no
   * rollout anybody has billed yet.
   */
  resumed?: boolean;
}

export class CodexRolloutSource implements ContextUsageSource {
  readonly basis: ContextUsageBasis = 'transcript';
  readonly #sessionsDir: string;
  readonly #readTail: TranscriptTailReader;
  readonly #list: RolloutLister;
  readonly #maxBytes: number;

  /** The `thread-id` codex's `notify` last reported. The primary resolution key. */
  #threadId: string | null = null;
  /** Cached resolution; dropped whenever the thread changes or a read fails. */
  #resolvedPath: string | null = null;
  /** File the last successful read came from — cached or not. */
  #lastReadPath: string | null = null;
  /** Timestamp of the usage event last reported, for the reset guard below. */
  #lastAt: number | null = null;
  /**
   * A `/compact` or `/new` reached the PTY and we have not yet seen anything
   * newer than `#suspectAt` in `#suspectPath`. Both resets keep serving the
   * PRE-reset conversation from a file that is still there — `/compact` writes
   * the compaction into the same rollout, and `/new`'s rollout is created only
   * at the next model request — so without this the very next poll would re-read
   * the old number and mark it fresh.
   */
  #suspectPath: string | null = null;
  #suspectAt: number | null = null;
  /**
   * Lot 11 — last `total_token_usage` seen, PER ROLLOUT FILE.
   *
   * Keyed by path rather than kept as one running base, because a single base
   * cannot tell "the counter restarted" from "we are looking at another
   * thread's file". codex legitimately writes several rollouts under one
   * `CODEX_HOME` (one per `/new`), and while no thread-id is known the mtime
   * bootstrap can resolve to either — a shared base would then bill the
   * difference between two unrelated totals. One base per file makes each
   * delta a difference against ITS own history.
   *
   * Bounded: a per-session `CODEX_HOME` holds a handful of threads, and only
   * the most recent ones can still be resolved to.
   */
  readonly #totalsByPath = new Map<string, TokenUsageCounters>();
  /**
   * Lot 11 — swallow the FIRST cumulative total, because it has already been
   * billed by a previous life of this session.
   *
   * A restart is the one event that separates the two halves of this counter:
   * the running total comes back from SQLite (`SessionInit.tokenUsage`), while
   * the base it was measured against — `#totalsByPath` — is memory and dies
   * with the process. The session id survives a resume, so the `CODEX_HOME` is
   * the same directory, the pre-restart rollout is still sitting in it, and the
   * first read resolves to that frozen file. Without this flag its whole
   * cumulative total would be billed AGAIN, on top of the seed, and persisted —
   * doubling every agent's cost at every redeploy, compounding.
   *
   * Nothing is lost by re-basing: the file that first read lands on is one no
   * live process is writing to any more. The new thread's rollout does not
   * exist until its first model request (trap 3), and when it appears it is a
   * path with no base, billed in full — correctly, because it IS new spend.
   */
  #rebaseFirstBill: boolean;

  constructor(opts: CodexRolloutSourceOptions) {
    this.#sessionsDir = opts.sessionsDir;
    this.#readTail = opts.readTail ?? createLocalTailReader();
    this.#list = opts.listRollouts ?? createLocalRolloutLister();
    this.#maxBytes = opts.maxTailBytes ?? TRANSCRIPT_TAIL_BYTES;
    this.#rebaseFirstBill = opts.resumed === true;
  }

  get target(): string | null {
    return this.#threadId;
  }

  /**
   * Always. Unlike claude — which cannot read anything before its hook fires —
   * codex's directory is known from the moment the session is configured, and
   * the file appearing in it is exactly what we are waiting for (trap 2).
   */
  get ready(): boolean {
    return true;
  }

  /** The `thread-id` from a `notify` payload. `true` ⇒ a new thread (`/new`). */
  retarget(threadId: string): boolean {
    const next = threadId.trim().toLowerCase();
    if (next.length === 0) return false;
    const changed = next !== this.#threadId;
    this.#threadId = next;
    if (changed) this.#resolvedPath = null;
    // A `notify` means a turn just completed on this thread — which, for a
    // `/compact` (same thread, same file), is precisely the proof that what is
    // in the file now is POST-reset.
    this.#suspectPath = null;
    this.#suspectAt = null;
    return changed;
  }

  invalidate(): void {
    this.#suspectPath = this.#lastReadPath;
    this.#suspectAt = this.#lastAt;
  }

  async read(): Promise<ContextUsageReading> {
    const filePath = await this.#resolve();
    if (filePath === null) {
      // No rollout for this thread yet: the boot window (trap 2) and the window
      // after a `/new` (trap 3). Both are normal phases, not degradations.
      return { kind: 'empty' };
    }
    let text: string | null = null;
    try {
      text = await this.#readTail(filePath, this.#maxBytes);
    } catch {
      text = null;
    }
    if (text === null) {
      this.#resolvedPath = null;
      return { kind: 'unavailable', reason: 'rollout-unreadable' };
    }
    // Lot 13 — read from the SAME tail, before anything can return. The events
    // that carry a quota and no usage (`info: null`) are exactly the ones the
    // gauge parser walks past, so a session whose tail holds only those still
    // has a quota to report while having no sample at all.
    const quota = quotaOf(parseCodexRateLimitsFromTail(text));
    const parsed = parseContextUsageFromCodexRolloutTail(text);
    if (parsed === null) {
      // The file exists but its tail holds no usage-bearing event — the very
      // first bytes of a fresh thread, or a tail that landed inside one huge
      // response item.
      return { kind: 'empty', ...quota };
    }
    // Lot 11 — billed BEFORE the reset guard below. The guard exists to stop a
    // PRE-reset occupancy from being reported as the live one; the tokens that
    // occupancy cost were spent either way, and a `/new` right after a big turn
    // must not erase it from the bill.
    const tokens = this.#bill(filePath, parsed.totals);

    // The reset guard. We can only PROVE a measurement is pre-reset when both
    // timestamps are known; without them we report, because a silent freeze is
    // worse than a number that is one turn old and marked stale anyway.
    if (
      this.#suspectPath !== null &&
      this.#suspectPath === filePath &&
      this.#suspectAt !== null &&
      parsed.at !== null &&
      parsed.at <= this.#suspectAt
    ) {
      return { kind: 'empty', ...tokens, ...quota };
    }
    this.#suspectPath = null;
    this.#suspectAt = null;
    this.#lastReadPath = filePath;
    this.#lastAt = parsed.at;
    return {
      kind: 'sample',
      usedTokens: parsed.usedTokens,
      limitTokens: parsed.limitTokens,
      at: parsed.at,
      ...tokens,
      ...quota,
    };
  }

  /**
   * Delta since this file's last known cumulative total, and re-base in the
   * same breath — the "report each delta exactly once" half of the source
   * contract.
   */
  #bill(filePath: string, totals: TokenUsageCounters | null): { tokens?: TokenUsageCounters } {
    if (totals === null) return {};
    const known = this.#totalsByPath.get(filePath) ?? null;
    // A resumed session's first sight of a rollout: adopt it as the base and
    // bill nothing. See `#rebaseFirstBill`.
    if (this.#rebaseFirstBill && known === null) {
      this.#rebaseFirstBill = false;
      this.#totalsByPath.set(filePath, totals);
      return {};
    }
    const delta = codexTokenDelta(totals, known);
    this.#totalsByPath.set(filePath, totals);
    if (this.#totalsByPath.size > MAX_TRACKED_ROLLOUTS) {
      const oldest = this.#totalsByPath.keys().next();
      // Never evict the base we are actively differencing against: doing so
      // would re-bill this thread's whole cumulative total on the next poll.
      if (oldest.done !== true && oldest.value !== filePath) {
        this.#totalsByPath.delete(oldest.value);
      }
    }
    return isZeroTokenUsage(delta) ? {} : { tokens: delta };
  }

  /**
   * Re-resolve on every read while we have no cached answer. Cheap (one readdir
   * of a 2-file tree) and it is what makes trap 2 and trap 3 survivable: the
   * path is never latched at boot.
   */
  async #resolve(): Promise<string | null> {
    if (this.#resolvedPath !== null) return this.#resolvedPath;
    let files: readonly RolloutFile[] = [];
    try {
      files = await this.#list(this.#sessionsDir);
    } catch {
      files = [];
    }
    const picked = pickCodexRollout(files, this.#threadId);
    // Only a thread-keyed resolution is cached: the mtime bootstrap must be
    // re-run every poll, since the file it picks can be superseded at any time.
    if (picked !== null && this.#threadId !== null) this.#resolvedPath = picked;
    return picked;
  }
}
