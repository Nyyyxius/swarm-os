/**
 * Context-window occupancy of an opencode session (docs/monitoring-agents.md, Lot 7).
 *
 * WHERE THE NUMBER COMES FROM. Unlike claude and codex, opencode writes no
 * transcript we can tail — but it already runs an HTTP control plane that
 * swarm-os itself started and password-protected (`--port`, basic auth
 * `swarm:<generated>`, `providers/opencode.ts#controlPlane`). Until now nothing
 * consumed it. The tracker is its first consumer, and it needs no new flag, no
 * new secret and no new plumbing (`scripts/verify-opencode-tokens.report.md`,
 * 7/7 CONFIRMED).
 *
 * THE READING, in three calls:
 *
 *   GET /session                  → the CURRENT session: `max(time.created)`
 *   GET /session/{id}/message     → `tokens.total` of the last COMPLETED
 *                                   assistant message
 *   GET /config/providers         → `models[<id>].limit.context` (cached for the
 *                                   session's life; a catalogue does not move)
 *
 * Cross-checked byte-for-byte: that formula prints `8.0K (1%)`, the exact string
 * opencode's own status bar shows its user (T7).
 *
 * THREE TRAPS, and every one of them is silent:
 *
 *  1. **Never `GET /session`.tokens.** It is a cumulative sum over every
 *     assistant message — a billing counter. It has no `total` field, it only
 *     grows, and it does NOT drop after a `/compact` (measured: the per-message
 *     reading fell 8251 → 798 across a compaction while the aggregate rose).
 *     A gauge on it passes 100 % and keeps climbing.
 *  2. **Never the last assistant message unfiltered.** While a turn is in flight
 *     the message ALREADY EXISTS with all-zero counters and no `time.completed`
 *     (measured at t+1760 ms). Taking it reports 0 % for a busy agent — exactly
 *     when a gauge is most likely to be read.
 *  3. **Never remember the session id.** `/compact` keeps it (and the counter
 *     drops on its own, nothing to do); `/clear` creates a NEW session, but
 *     LAZILY — only at the next prompt — and the old one stays listed forever,
 *     frozen at its final counters. An id resolved once freezes the gauge at the
 *     first `/clear`. So we re-resolve on EVERY poll, and compare `time.created`
 *     explicitly rather than trusting the array's order.
 *
 * LOCAL TRANSPORT ONLY. Under SSH the plane listens on the HOST's loopback and
 * `SshAgentProcess` only sets up a REVERSE forward (`-R`, for MCP); reaching it
 * would need a forward one (`ssh -L`), the same gap already documented for the
 * `/event` consumer (opencode.ts:868-871). `Session` therefore builds no source
 * at all for an SSH opencode agent, and the UI shows `—`.
 *
 * A PLANE THAT NEVER BOUND IS NOT AN ERROR. A fixed port can lose a race with
 * `TIME_WAIT`, and opencode's TUI then carries on perfectly well WITHOUT its
 * control plane — silently. That session has no measurement, which is a `—`, a
 * throttled log line, and nothing else.
 */

import { emptyTokenUsage, isZeroTokenUsage } from './context-usage.js';
import type {
  ContextUsageBasis,
  ContextUsageReading,
  ContextUsageSource,
  TokenUsageCounters,
} from './context-usage.js';

/** What `AgentProvider.controlPlane()` gives us. A superset is fine. */
export interface OpencodeControlTarget {
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * Budget for ONE control-plane call. Deliberately short: three of these run
 * inside a poll the UI is waiting on, against a loopback port that either
 * answers in milliseconds or is not there at all.
 */
export const CONTROL_PLANE_TIMEOUT_MS = 3_000;

/** Ceiling on a control-plane response we will parse, in bytes. */
export const CONTROL_PLANE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How many opencode sessions one source keeps a billing base for (Lot 11).
 * `/clear` opens one and abandons the previous, so an agent gains one per
 * rotation and only the newest is ever current again.
 */
const MAX_TRACKED_SESSIONS = 8;

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

// ---------------------------------------------------------------------------
// The selectors — pure, exported, and where the three traps are actually paid
// ---------------------------------------------------------------------------

export interface OpencodeCurrentSession {
  id: string;
  providerID: string | null;
  modelID: string | null;
  createdAt: number;
  /**
   * The session's `tokens` aggregate — trap 1's forbidden field, read here on
   * purpose (docs/monitoring-agents.md, Lot 11).
   *
   * It is a CUMULATIVE sum over every assistant message: useless as an
   * occupancy (it only grows, it survives a `/compact`) and precisely right as
   * a bill. The gauge above still refuses it; this is the other question.
   * `null` when the row carries none.
   */
  tokens: TokenUsageCounters | null;
  /**
   * The session's `cost`, in dollars, as OPENCODE computed it (Lot 13).
   *
   * A real number, not an estimate of ours: opencode prices every assistant
   * message from the `cost:{input,output,cache:{read,write}}` block of the
   * provider catalogue it already holds, and publishes the running sum here
   * (`0.00016725` for the spike's two messages, matching the per-message
   * `0.0000831 + 0.00008415` to the cent-millionth).
   *
   * Cumulative and monotonic, exactly like `tokens` above — so it is billed by
   * exactly the same delta-and-rebase machinery, and `/clear` rotates its base
   * the same way. `null` when the row carries none.
   */
  costUsd: number | null;
}

/**
 * THE session an opencode agent is talking to right now: the one with the
 * greatest `time.created` (trap 3).
 *
 * `/session` was observed newest-first, but nothing documents that ordering and
 * opencode ids do not sort chronologically as plain strings — so the comparison
 * is explicit and `[0]` is never trusted.
 */
export function selectCurrentOpencodeSession(body: unknown): OpencodeCurrentSession | null {
  const rows = asArray(body);
  if (rows === null) return null;
  let best: OpencodeCurrentSession | null = null;
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const id = typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : null;
    if (id === null) continue;
    const createdAt = finiteNumber(asRecord(rec.time)?.created) ?? 0;
    if (best !== null && createdAt <= best.createdAt) continue;
    const model = asRecord(rec.model);
    best = {
      id,
      providerID: typeof model?.providerID === 'string' ? model.providerID : null,
      modelID: typeof model?.id === 'string' ? model.id : null,
      createdAt,
      tokens: sessionTokens(rec.tokens),
      costUsd: sessionCostUsd(rec.cost),
    };
  }
  return best;
}

/**
 * `{input, output, reasoning, cache:{read, write}}` → the four buckets.
 *
 * `reasoning` folds into `out`: opencode counts it apart, every provider bills
 * it as output, and a column that hid it would under-report exactly the models
 * that think the longest. The four opencode fields are DISJOINT (unlike codex's
 * `cached_input_tokens`), so nothing is subtracted here.
 */
export function sessionTokens(value: unknown): TokenUsageCounters | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const cache = asRecord(rec.cache);
  return {
    in: count(rec.input),
    out: count(rec.output) + count(rec.reasoning),
    cacheRead: count(cache?.read),
    cacheWrite: count(cache?.write),
  };
}

/**
 * `cost` → dollars, or `null` (Lot 13).
 *
 * `0` is a VALUE, not an absence — a free model, or a session that has not
 * spent anything yet — and it must be adopted as a base like any other, or the
 * first paying turn would be billed against `null` and re-billed in full. Only
 * a missing / non-numeric / negative field answers `null`. NOT rounded: this is
 * the number the provider quoted, and sub-cent amounts are the normal case
 * (a whole spike session cost $0.00016725).
 */
export function sessionCostUsd(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

/**
 * `current − base`, in dollars, with the same recede rule as the counters.
 *
 * A total BELOW its base is a new opencode session's counter (`/clear`), not a
 * refund: everything it shows is spend we have never billed.
 */
export function opencodeCostDelta(current: number, base: number | null): number {
  if (base === null) return current;
  // Same-key regression = rewritten counter, already billed up to `base` —
  // err low: bill nothing, the caller re-bases on `current`.
  if (current < base) return 0;
  return current - base;
}

/** A missing / negative / non-numeric counter is zero, never a failure. */
function count(v: unknown): number {
  const n = finiteNumber(v);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

/**
 * `current − base`, per bucket — with the same recede rule as codex.
 *
 * `/clear` opens a NEW opencode session whose aggregate starts at zero, so a
 * total below the base means we are looking at a counter we have never billed,
 * not at a refund. Bases are kept per session id, so the rotation costs nothing
 * and the totals carry straight across it.
 */
export function opencodeTokenDelta(
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
    // Same-key regression (a `/clear` arrives under a NEW session id with a
    // null base): already billed up to `base`, so bill nothing and re-base.
    return emptyTokenUsage();
  }
  return {
    in: current.in - base.in,
    out: current.out - base.out,
    cacheRead: current.cacheRead - base.cacheRead,
    cacheWrite: current.cacheWrite - base.cacheWrite,
  };
}

export interface OpencodeCompletedMessage {
  usedTokens: number;
  /** `time.completed`, epoch ms — the proof this message is not still running. */
  completedAt: number;
}

/**
 * `tokens.total` of the last COMPLETED assistant message (traps 1 and 2).
 *
 * `total` is exactly `input + output + reasoning + cache.read + cache.write`,
 * verified to the token: everything sent to the model (fresh prompt + the prefix
 * replayed from cache) plus everything that came back. That is the footprint of
 * the request, and since every request re-sends the conversation, it is the
 * occupancy of the window.
 *
 * Scans BACKWARDS and returns the newest message that carries BOTH a
 * `time.completed` and a numeric `tokens.total`. User messages have no `tokens`
 * at all, which is why the scan cannot simply take the last element. Elements
 * may be either the message itself or a `{info, parts}` envelope around it.
 */
export function selectLastCompletedAssistant(body: unknown): OpencodeCompletedMessage | null {
  const rows = asArray(body);
  if (rows === null) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const outer = asRecord(rows[i]);
    if (!outer) continue;
    const msg = asRecord(outer.info) ?? outer;
    if (msg.role !== 'assistant') continue;
    const completedAt = finiteNumber(asRecord(msg.time)?.completed);
    if (completedAt === null) continue; // trap 2 — this turn is still running
    const total = finiteNumber(asRecord(msg.tokens)?.total);
    if (total === null || total < 0) continue;
    return { usedTokens: Math.floor(total), completedAt };
  }
  return null;
}

/**
 * `providers[<providerID>].models[<modelID>].limit.context` (T3) — the limit
 * lives on neither the session nor the message, so the two have to be joined.
 *
 * Shape-tolerant on purpose: the payload has been observed as `{providers:[…]}`
 * with `id`-carrying entries, and the same information could equally arrive as a
 * map keyed by provider id. Both are accepted; anything else answers `null`,
 * which shows raw tokens and no percentage rather than a wrong denominator.
 */
export function lookupOpencodeContextLimit(
  body: unknown,
  providerID: string | null,
  modelID: string | null,
): number | null {
  if (providerID === null || modelID === null) return null;
  const root = asRecord(body);
  const providers = root?.providers ?? body;
  const entry = pickProvider(providers, providerID);
  const models = asRecord(entry?.models);
  const model = asRecord(models?.[modelID]);
  const limit = finiteNumber(asRecord(model?.limit)?.context);
  return limit !== null && limit > 0 ? Math.floor(limit) : null;
}

function pickProvider(providers: unknown, providerID: string): Record<string, unknown> | null {
  const list = asArray(providers);
  if (list !== null) {
    for (const row of list) {
      const rec = asRecord(row);
      if (rec && rec.id === providerID) return rec;
    }
    return null;
  }
  return asRecord(asRecord(providers)?.[providerID]);
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** What one opencode session has shown us so far — the base of the next delta. */
interface OpencodeBill {
  tokens: TokenUsageCounters | null;
  costUsd: number | null;
}

export interface OpencodeControlPlaneSourceOptions {
  /**
   * Resolved on EVERY read, never captured: the plane belongs to a live process
   * and `null` simply means the session no longer has one.
   */
  controlPlane: () => OpencodeControlTarget | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * This session came back from a persisted bill (Lot 11) — see
   * `#rebaseFirstBill`.
   */
  resumed?: boolean;
}

export class OpencodeControlPlaneSource implements ContextUsageSource {
  readonly basis: ContextUsageBasis = 'control-plane';
  readonly #controlPlane: () => OpencodeControlTarget | null;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  /** Model → context window, fetched once. A provider catalogue does not move. */
  #limitTokens: number | null = null;
  #limitKey: string | null = null;

  /** Session id + `time.completed` last reported, for the reset guard. */
  #lastSessionId: string | null = null;
  #lastCompletedAt: number | null = null;
  #suspectSessionId: string | null = null;
  #suspectCompletedAt: number | null = null;

  /**
   * Lot 11 — last `tokens` aggregate seen, per opencode session id; Lot 13 adds
   * the `cost` measured in the same breath.
   *
   * One entry, two counters, because they come off the SAME payload and share
   * every rule that matters: the same rotation opens a new base for both, the
   * same resume swallows both, the same eviction must never drop one and keep
   * the other.
   */
  readonly #totalsById = new Map<string, OpencodeBill>();
  /**
   * Lot 11 — swallow the FIRST aggregate after a resume, for the same reason
   * codex does (`context-usage-codex.ts#rebaseFirstBill`): the running total
   * comes back from SQLite while the base it was measured against died with the
   * process. Trap 3 is what makes this reachable — an abandoned session stays
   * listed forever, frozen at its final counters, so the first `/session` of a
   * restarted agent can very well answer with a session whose whole aggregate
   * has already been billed and persisted.
   */
  #rebaseFirstBill: boolean;

  constructor(opts: OpencodeControlPlaneSourceOptions) {
    this.#controlPlane = opts.controlPlane;
    this.#fetch = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.#timeoutMs = opts.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS;
    this.#rebaseFirstBill = opts.resumed === true;
  }

  /** The plane resolves its own target on every poll — there is nothing to name. */
  get target(): string | null {
    return this.#lastSessionId;
  }

  get ready(): boolean {
    return true;
  }

  /**
   * `/compact` keeps the session and drops the counter by itself; `/clear` opens
   * a new session, lazily. Both leave the PRE-reset number sitting in the same
   * place for a turn, so we refuse to re-report it: a reading only counts once
   * it comes from another session, or from a message that completed AFTER the
   * reset.
   */
  invalidate(): void {
    this.#suspectSessionId = this.#lastSessionId;
    this.#suspectCompletedAt = this.#lastCompletedAt;
  }

  async read(): Promise<ContextUsageReading> {
    const plane = this.#controlPlane();
    // No plane at all: the session ended, or opencode never bound its port.
    if (plane === null) return { kind: 'empty' };

    const sessions = await this.#get(plane, '/session');
    if (sessions === null) return { kind: 'unavailable', reason: 'control-plane-unreachable' };
    const current = selectCurrentOpencodeSession(sessions);
    if (current === null) return { kind: 'empty' };

    // Lot 11 — billed the moment `/session` answered, and carried on every
    // outcome below. The bill comes from THIS payload alone; making it wait for
    // the two calls the GAUGE needs would drop real spend every time a message
    // listing failed or a turn was still in flight.
    const billed = this.#bill(current);

    const messages = await this.#get(plane, `/session/${encodeURIComponent(current.id)}/message`);
    if (messages === null) return { kind: 'unavailable', reason: 'messages-unreadable', ...billed };
    const last = selectLastCompletedAssistant(messages);
    // A turn in flight, or a session that has produced nothing yet (the state a
    // fresh `/clear` leaves behind). Normal, and silent.
    if (last === null) return { kind: 'empty', ...billed };

    if (
      this.#suspectSessionId !== null &&
      this.#suspectSessionId === current.id &&
      this.#suspectCompletedAt !== null &&
      last.completedAt <= this.#suspectCompletedAt
    ) {
      return { kind: 'empty', ...billed };
    }

    const limitTokens = await this.#limitFor(plane, current);
    this.#suspectSessionId = null;
    this.#suspectCompletedAt = null;
    this.#lastSessionId = current.id;
    this.#lastCompletedAt = last.completedAt;
    return {
      kind: 'sample',
      usedTokens: last.usedTokens,
      limitTokens,
      at: last.completedAt,
      ...billed,
    };
  }

  /**
   * Delta since this opencode session's last known aggregate, re-basing in the
   * same breath (the "report each delta exactly once" half of the contract).
   *
   * Bases are per session id and bounded: `/clear` opens a new session and
   * leaves the old one listed forever, frozen at its final counters, so a
   * long-lived agent accumulates a few — and the totals ride across every one
   * of those rotations because they live in the tracker, not here.
   */
  #bill(current: OpencodeCurrentSession): { tokens?: TokenUsageCounters; reportedCostUsd?: number } {
    if (current.tokens === null && current.costUsd === null) return {};
    const known = this.#totalsById.get(current.id) ?? null;
    const seen: OpencodeBill = { tokens: current.tokens, costUsd: current.costUsd };
    // A resumed session's first sight of an opencode session: adopt it as the
    // base and bill nothing. See `#rebaseFirstBill`.
    if (this.#rebaseFirstBill && known === null) {
      this.#rebaseFirstBill = false;
      this.#totalsById.set(current.id, seen);
      return {};
    }
    const tokenDelta =
      current.tokens === null ? null : opencodeTokenDelta(current.tokens, known?.tokens ?? null);
    // Lot 13 — the money, off the same payload and under the same rule. Billed
    // even when the token aggregate is missing: a `cost` we can read is spend we
    // owe, whatever happened to the counters beside it.
    const costDelta =
      current.costUsd === null ? 0 : opencodeCostDelta(current.costUsd, known?.costUsd ?? null);
    // A bucket this payload did not carry keeps the base it had, rather than
    // overwriting it with `null` and re-billing the whole aggregate next poll.
    this.#totalsById.set(current.id, {
      tokens: seen.tokens ?? known?.tokens ?? null,
      costUsd: seen.costUsd ?? known?.costUsd ?? null,
    });
    if (this.#totalsById.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.#totalsById.keys().next();
      // Never evict the base being differenced against — that would re-bill the
      // whole aggregate on the next poll.
      if (oldest.done !== true && oldest.value !== current.id) {
        this.#totalsById.delete(oldest.value);
      }
    }
    return {
      ...(tokenDelta !== null && !isZeroTokenUsage(tokenDelta) ? { tokens: tokenDelta } : {}),
      ...(costDelta > 0 ? { reportedCostUsd: costDelta } : {}),
    };
  }

  /**
   * The catalogue call, made once per (provider, model) pair and then never
   * again — it is static for the process's life, and a failure is simply retried
   * at the next poll rather than cached as "no limit".
   */
  async #limitFor(
    plane: OpencodeControlTarget,
    current: OpencodeCurrentSession,
  ): Promise<number | null> {
    const key = `${current.providerID ?? ''}/${current.modelID ?? ''}`;
    if (this.#limitKey === key && this.#limitTokens !== null) return this.#limitTokens;
    const body = await this.#get(plane, '/config/providers');
    if (body === null) return this.#limitKey === key ? this.#limitTokens : null;
    const limit = lookupOpencodeContextLimit(body, current.providerID, current.modelID);
    if (limit !== null) {
      this.#limitKey = key;
      this.#limitTokens = limit;
    }
    return limit;
  }

  /**
   * One bounded, authenticated GET. `null` for every failure there is — a
   * refused connection, a 401, a body that is not JSON, a timeout. Never throws:
   * this runs on the serialization path of a poll.
   */
  async #get(plane: OpencodeControlTarget, route: string): Promise<unknown | null> {
    try {
      const res = await this.#fetch(`${plane.baseUrl}${route}`, {
        method: 'GET',
        headers: {
          Authorization: basicAuthHeader(plane.username, plane.password),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > CONTROL_PLANE_MAX_BYTES) return null;
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}
