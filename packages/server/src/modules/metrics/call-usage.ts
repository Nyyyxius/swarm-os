/**
 * Per-call ledger — every API call of every claude agent, persisted and charted
 * (docs/monitoring-agents.md, « Appels par agent »).
 *
 * WHERE THE CALLS COME FROM. Nowhere new. The transcript reader of Lot 11
 * (`TranscriptContextSource`) already bills each turn exactly once, by
 * `message.id`; the scan that computes the token delta now also hands over the
 * calls behind it (`TranscriptCall`), and `record()` files them. Nothing is
 * added on the agent side — no prompt, no tool, no hook.
 *
 * NO TIMER, like the rest of the module. Calls arrive when the transcript is
 * read (the `/orchestrators` poll, an agent's idle boundary, its exit); the
 * 14-day retention is enforced by the insert path itself, at most once an hour.
 *
 * EVERY OUTCOME IS A VALUE. `record()` never throws (the DB layer already
 * swallows and logs), and every read answers with a well-formed, possibly
 * empty, view. A monitoring chart has no business failing a request.
 *
 * The time-bucket arithmetic is done IN SQL (`GROUP BY ts / bucket`): 10 000
 * calls a night across 7 teams is ~140 000 rows at the retention horizon, and
 * shipping them to JavaScript to add them up would be the one way to make this
 * slow.
 */
import type {
  CallUsageBucketRow,
  CallUsageTeamRow,
  SessionCallBucketRow,
  SessionCallRow,
  SwarmDb,
} from '../db/index.js';
import type { CallLedgerSession, TranscriptCall } from '../orchestrator/context-usage.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** How long a call is kept. */
export const CALL_RETENTION_MS = 14 * 24 * HOUR_MS;

/** The retention purge runs at insertion, at most this often. */
export const CALL_PURGE_INTERVAL_MS = HOUR_MS;

/**
 * Most points `GET /sessions/:id/calls` returns. Past it, calls are folded into
 * time buckets in SQL — ~600 bars is already more than a band a thousand pixels
 * wide can draw one pixel apart.
 */
export const CALL_POINTS_CAP = 600;

/** Most buckets a team / fleet series may have (the bucket × window product). */
export const CALL_SERIES_MAX_BUCKETS = 1000;

// ---------------------------------------------------------------------------
// Query vocabulary
// ---------------------------------------------------------------------------

export type CallWindow = '1h' | '24h' | '3d' | '14d';

const WINDOW_MS: Record<CallWindow, number> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '3d': 3 * 24 * HOUR_MS,
  '14d': 14 * 24 * HOUR_MS,
};

export const CALL_WINDOWS: readonly CallWindow[] = ['1h', '24h', '3d', '14d'];

/** `undefined` ⇒ the default (`24h`); anything unknown ⇒ `null` (a 400). */
export function parseCallWindow(raw: unknown): CallWindow | null {
  if (raw === undefined || raw === '') return '24h';
  return typeof raw === 'string' && (CALL_WINDOWS as readonly string[]).includes(raw)
    ? (raw as CallWindow)
    : null;
}

export function callWindowMs(window: CallWindow): number {
  return WINDOW_MS[window];
}

export type CallBucket = '5m' | 'hour' | 'day';

const BUCKET_MS: Record<CallBucket, number> = {
  '5m': 5 * MINUTE_MS,
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
};

export const CALL_BUCKETS: readonly CallBucket[] = ['5m', 'hour', 'day'];

/** `undefined` ⇒ `hour`; anything unknown ⇒ `null` (a 400). */
export function parseCallBucket(raw: unknown): CallBucket | null {
  if (raw === undefined || raw === '') return 'hour';
  return typeof raw === 'string' && (CALL_BUCKETS as readonly string[]).includes(raw)
    ? (raw as CallBucket)
    : null;
}

export function callBucketMs(bucket: CallBucket): number {
  return BUCKET_MS[bucket];
}

/**
 * The bucket sizes a per-agent chart may fold into, smallest first. Round
 * values, so a tooltip can say "5 min" rather than "2 min 24 s".
 */
const FOLD_STEPS_MS = [
  10_000, 30_000, MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS,
  15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 2 * HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS,
];

/** Smallest round bucket that fits `windowMs` into at most `cap` buckets. */
export function foldBucketMs(windowMs: number, cap: number = CALL_POINTS_CAP): number {
  const min = windowMs / Math.max(1, cap);
  for (const step of FOLD_STEPS_MS) if (step >= min) return step;
  return FOLD_STEPS_MS[FOLD_STEPS_MS.length - 1] ?? HOUR_MS;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** The four token buckets of a call, on the wire. */
export interface CallTokens {
  /** Fresh input tokens — the cache misses. */
  input: number;
  /** Tokens written to the prompt cache. */
  cacheWrite: number;
  /** Tokens read from the prompt cache. */
  cacheRead: number;
  output: number;
}

/**
 * One bar of an agent's chart: ONE call (`n === 1`) or, when the window holds
 * more than {@link CALL_POINTS_CAP}, every call of a time bucket (`n > 1`).
 * Token buckets are sums; `context` is the context the call sent — for a
 * bucket, the LARGEST one (a peak is never averaged away).
 */
export interface CallPoint extends CallTokens {
  /** ISO. The call's own time, or the start of its bucket. */
  t: string;
  n: number;
  /** `null` when unknown, or when a bucket mixed several models. */
  model: string | null;
  context: number;
  /** Single calls only: a sub-agent's call (`isSidechain` in the transcript). */
  sidechain?: boolean;
}

export interface CallTotals extends CallTokens {
  calls: number;
  /** Largest context sent in the window, `0` when there was no call. */
  maxContext: number;
}

export interface SessionCallsView {
  window: CallWindow;
  since: string;
  until: string;
  /** `true` ⇒ `calls` are time buckets of `bucketMs`, not single calls. */
  aggregated: boolean;
  bucketMs: number | null;
  calls: CallPoint[];
  /** Calls per hour, hours with at least one call only. */
  hourly: { t: string; calls: number }[];
  totals: CallTotals;
}

export interface CallSeriesPoint extends CallTokens {
  t: string;
  calls: number;
}

export interface CallUsageTeam extends CallTokens {
  orchestratorId: string;
  name: string | null;
  calls: number;
}

export interface CallUsageView {
  window: CallWindow;
  bucket: CallBucket;
  bucketMs: number;
  since: string;
  until: string;
  /** Dense (every bucket of the window, zeros included), oldest first. */
  lead: CallSeriesPoint[];
  workers: CallSeriesPoint[];
  totals: { lead: CallTotalsLite; workers: CallTotalsLite };
  /** Fleet view only: one row per team that made a call, busiest first. */
  teams?: CallUsageTeam[];
}

export type CallTotalsLite = CallTokens & { calls: number };

/** The slice of `SwarmDb` the ledger uses — a fixture in tests. */
export type CallLedgerDb = Pick<
  SwarmDb,
  | 'insertSessionCalls'
  | 'deleteSessionCallsBefore'
  | 'countSessionCalls'
  | 'listSessionCalls'
  | 'sessionCallBuckets'
  | 'callUsageSeries'
  | 'callUsageByTeam'
>;

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface CallLedgerOptions {
  now?: () => number;
  retentionMs?: number;
  purgeIntervalMs?: number;
}

/**
 * Row shape of one call. Pure. `ts` falls back to `now` when the transcript
 * line carried no timestamp — a call filed at read time beats a call dropped.
 */
export function toSessionCallRow(
  session: CallLedgerSession,
  call: TranscriptCall,
  now: number,
): SessionCallRow {
  return {
    session_id: session.id,
    orchestrator_id: session.orchestratorId,
    session_type: session.type === 'lead' ? 'lead' : 'worker',
    ts: call.ts !== null && Number.isFinite(call.ts) ? Math.floor(call.ts) : now,
    message_id: call.messageId,
    model: call.model,
    input_tokens: call.input,
    cache_creation_tokens: call.cacheWrite,
    cache_read_tokens: call.cacheRead,
    output_tokens: call.output,
    context_tokens: call.input + call.cacheWrite + call.cacheRead,
    is_sidechain: call.isSidechain ? 1 : 0,
  };
}

export class CallLedger {
  readonly #db: Partial<CallLedgerDb>;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #purgeIntervalMs: number;
  /** Epoch ms of the last purge; `null` ⇒ the first insert of the process purges. */
  #purgedAt: number | null = null;

  /**
   * `db` is PARTIAL on purpose: the `NoOpPersistence` stub that tests wire into
   * an Orchestrator carries none of these methods, and a ledger over it must
   * be a silent no-op rather than a crash on the first transcript read.
   */
  constructor(db: Partial<CallLedgerDb>, opts: CallLedgerOptions = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => Date.now());
    this.#retentionMs = opts.retentionMs ?? CALL_RETENTION_MS;
    this.#purgeIntervalMs = opts.purgeIntervalMs ?? CALL_PURGE_INTERVAL_MS;
  }

  /**
   * File the calls one transcript read billed. Returns how many rows were NEW
   * (a re-read is ignored by the UNIQUE index, not an error). Calls already
   * past the retention horizon are not written at all — a resumed transcript
   * can carry weeks of history, which would only be purged an hour later.
   * Never throws.
   */
  record(session: CallLedgerSession, calls: readonly TranscriptCall[]): number {
    const insert = this.#db.insertSessionCalls;
    if (typeof insert !== 'function' || calls.length === 0) return 0;
    const now = this.#now();
    const horizon = now - this.#retentionMs;
    const rows: SessionCallRow[] = [];
    for (const call of calls) {
      const row = toSessionCallRow(session, call, now);
      if (row.ts >= horizon) rows.push(row);
    }
    let inserted = 0;
    try {
      inserted = rows.length > 0 ? insert.call(this.#db, rows) : 0;
    } catch {
      inserted = 0;
    }
    this.#maybePurge(now);
    return inserted;
  }

  /** The 14-day retention, at most once per interval, on the insert path. */
  #maybePurge(now: number): void {
    if (this.#purgedAt !== null && now - this.#purgedAt < this.#purgeIntervalMs) return;
    this.#purgedAt = now;
    try {
      this.#db.deleteSessionCallsBefore?.(now - this.#retentionMs);
    } catch {
      /* swallowed by the DB layer already; belt to its braces */
    }
  }

  /**
   * One agent's calls over `window`: single calls up to {@link CALL_POINTS_CAP},
   * time buckets past it. `hourly` and `totals` are always computed in SQL over
   * the whole window, whatever the chart resolution.
   */
  sessionCalls(sessionId: string, window: CallWindow): SessionCallsView {
    const until = this.#now() + 1;
    const since = until - callWindowMs(window);
    const hours = this.#safe(() => this.#db.sessionCallBuckets?.(sessionId, since, until, HOUR_MS));
    const count = this.#safe(() => this.#db.countSessionCalls?.(sessionId, since, until)) ?? 0;

    let aggregated = false;
    let bucketMs: number | null = null;
    let calls: CallPoint[];
    if (count > CALL_POINTS_CAP) {
      aggregated = true;
      bucketMs = foldBucketMs(callWindowMs(window));
      const b = bucketMs;
      calls = (this.#safe(() => this.#db.sessionCallBuckets?.(sessionId, since, until, b)) ?? [])
        .map(bucketToPoint);
    } else {
      calls = (this.#safe(() => this.#db.listSessionCalls?.(sessionId, since, until)) ?? [])
        .map(rowToPoint);
    }

    const totals: CallTotals = { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, maxContext: 0 };
    const hourly: { t: string; calls: number }[] = [];
    for (const h of hours ?? []) {
      hourly.push({ t: iso(h.t), calls: num(h.calls) });
      totals.calls += num(h.calls);
      totals.input += num(h.input_tokens);
      totals.cacheWrite += num(h.cache_creation_tokens);
      totals.cacheRead += num(h.cache_read_tokens);
      totals.output += num(h.output_tokens);
      totals.maxContext = Math.max(totals.maxContext, num(h.context_max));
    }
    return {
      window,
      since: iso(since),
      until: iso(until),
      aggregated,
      bucketMs,
      calls,
      hourly,
      totals,
    };
  }

  /**
   * Calls and tokens per bucket, lead and workers apart — for one team, or for
   * the whole fleet when `orchestratorId` is `null` (which also lists the
   * teams, named through `teamName`). `null` when `window × bucket` would
   * exceed {@link CALL_SERIES_MAX_BUCKETS} (the route's 400).
   */
  callUsage(
    orchestratorId: string | null,
    window: CallWindow,
    bucket: CallBucket,
    teamName: (orchestratorId: string) => string | null = () => null,
  ): CallUsageView | null {
    const windowMs = callWindowMs(window);
    const bucketMs = callBucketMs(bucket);
    if (Math.ceil(windowMs / bucketMs) + 1 > CALL_SERIES_MAX_BUCKETS) return null;
    const until = this.#now() + 1;
    const since = until - windowMs;
    const rows = this.#safe(() => this.#db.callUsageSeries?.(orchestratorId, since, until, bucketMs)) ?? [];
    const { lead, workers } = densifySeries(rows, since, until, bucketMs);
    const view: CallUsageView = {
      window,
      bucket,
      bucketMs,
      since: iso(since),
      until: iso(until),
      lead,
      workers,
      totals: { lead: sumSeries(lead), workers: sumSeries(workers) },
    };
    if (orchestratorId === null) {
      const teams = this.#safe(() => this.#db.callUsageByTeam?.(since, until)) ?? [];
      view.teams = teams
        .map((r) => teamRowToView(r, teamName))
        .sort((a, b) => b.calls - a.calls || a.orchestratorId.localeCompare(b.orchestratorId));
    }
    return view;
  }

  #safe<T>(fn: () => T | undefined): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rowToPoint(r: SessionCallRow): CallPoint {
  return {
    t: iso(r.ts),
    n: 1,
    model: r.model ?? null,
    input: num(r.input_tokens),
    cacheWrite: num(r.cache_creation_tokens),
    cacheRead: num(r.cache_read_tokens),
    output: num(r.output_tokens),
    context: num(r.context_tokens),
    sidechain: r.is_sidechain === 1,
  };
}

function bucketToPoint(b: SessionCallBucketRow): CallPoint {
  return {
    t: iso(b.t),
    n: num(b.calls),
    model: b.model_count === 1 ? (b.model ?? null) : null,
    input: num(b.input_tokens),
    cacheWrite: num(b.cache_creation_tokens),
    cacheRead: num(b.cache_read_tokens),
    output: num(b.output_tokens),
    context: num(b.context_max),
  };
}

function emptySeriesPoint(t: number): CallSeriesPoint {
  return { t: iso(t), calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

/**
 * Sparse SQL buckets → two DENSE series over the window, so a chart can put
 * bar `i` of the lead and bar `i` of the workers at the same X without a join.
 * Buckets are aligned on the epoch (UTC), exactly as SQL computed them.
 */
export function densifySeries(
  rows: readonly CallUsageBucketRow[],
  since: number,
  until: number,
  bucketMs: number,
): { lead: CallSeriesPoint[]; workers: CallSeriesPoint[] } {
  const first = Math.floor(since / bucketMs) * bucketMs;
  const lead: CallSeriesPoint[] = [];
  const workers: CallSeriesPoint[] = [];
  const index = new Map<number, number>();
  for (let t = first, i = 0; t < until; t += bucketMs, i++) {
    lead.push(emptySeriesPoint(t));
    workers.push(emptySeriesPoint(t));
    index.set(t, i);
  }
  for (const r of rows) {
    const i = index.get(r.t);
    if (i === undefined) continue;
    const target = (r.session_type === 'lead' ? lead : workers)[i];
    if (!target) continue;
    target.calls += num(r.calls);
    target.input += num(r.input_tokens);
    target.cacheWrite += num(r.cache_creation_tokens);
    target.cacheRead += num(r.cache_read_tokens);
    target.output += num(r.output_tokens);
  }
  return { lead, workers };
}

function sumSeries(series: readonly CallSeriesPoint[]): CallTotalsLite {
  const out: CallTotalsLite = { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const p of series) {
    out.calls += p.calls;
    out.input += p.input;
    out.cacheWrite += p.cacheWrite;
    out.cacheRead += p.cacheRead;
    out.output += p.output;
  }
  return out;
}

function teamRowToView(
  r: CallUsageTeamRow,
  teamName: (orchestratorId: string) => string | null,
): CallUsageTeam {
  let name: string | null = null;
  try {
    name = teamName(r.orchestrator_id);
  } catch {
    name = null;
  }
  return {
    orchestratorId: r.orchestrator_id,
    name,
    calls: num(r.calls),
    input: num(r.input_tokens),
    cacheWrite: num(r.cache_creation_tokens),
    cacheRead: num(r.cache_read_tokens),
    output: num(r.output_tokens),
  };
}
