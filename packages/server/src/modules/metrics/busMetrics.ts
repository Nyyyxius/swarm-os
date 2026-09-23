/**
 * S8 — Bus health metrics collector (`/metrics/bus`).
 *
 * Maintains a 60-slot ring buffer (1 slot per second) covering the trailing
 * 60 s window. Each slot tracks:
 *   - `requests`         — count of MCP tool calls observed (any outcome)
 *   - `errors`           — subset that threw inside `transport.handleRequest`
 *   - `latencySumMs`     — sum of measured durations (ms, float)
 *   - `latencyCount`     — denominator for the latency mean
 *   - `messagesTotal`    — snapshot of `Σ orch.mailbox.messagesTotal` at the
 *                          end of that 1 s slot (for throughput delta)
 *
 * The collector is started at boot from `index.ts` and stopped first during
 * graceful shutdown so the tick never sees a half-torn-down mailbox.
 *
 * Public payload shape returned by `snapshot()`:
 *   {
 *     latency_ms: number,             // sliding mean over the window
 *     throughput_msg_per_s: number,   // mean msg/s over min(60, secondsSinceBoot)
 *     queue_depth: number,            // instantaneous Σ mailbox.totalSize()
 *     err_rate_pct: number,           // 100 * errors / max(1, requests)
 *     window_seconds: 60              // constant — UI uses it to label charts
 *   }
 *
 * Lifecycle / memory:
 *   - All state is in-memory. Restart resets to zeros — acceptable v1
 *     (same as the MessagesAggregator, cf. `09_metrics_messages.md` §7.3).
 *   - Ring size: 60 × ~40 bytes = ~2.4 KiB. Negligible.
 *
 * Concurrency:
 *   - Every method is synchronous. We MUST never `await` between the
 *     `recordRequestStart`/`recordRequestEnd` pair (the caller wraps a
 *     synchronous bookkeeping update around an async transport call, never
 *     the other way around).
 */

import type { Orchestrator } from '../orchestrator/index.js';
import { withModule } from '../../logger.js';

const log = withModule('metrics');

/** Public payload shape — see the file header comment. */
export interface BusMetricsSnapshot {
  /** Sliding mean MCP RTT (ms) over the trailing 60 s window. */
  latency_ms: number;
  /** Mean bus throughput (messages / second) over the trailing window. */
  throughput_msg_per_s: number;
  /** Instantaneous Σ mailbox.totalSize() across every orch. */
  queue_depth: number;
  /** Sliding error rate (%) over the trailing window. */
  err_rate_pct: number;
  /** Constant 60 — handy for UI labelling. */
  window_seconds: number;
}

/**
 * Minimal interface the collector consumes from the Spawner. Mirrors the
 * narrowing used by `MessagesAggregator` so unit tests can stub it with a
 * literal `{ list: () => [...] }`.
 */
export interface BusMetricsSpawnerLike {
  list(): Array<Pick<Orchestrator, 'id' | 'mailbox'>>;
}

export interface BusMetricsCollectorOptions {
  /** Override the 1 000 ms tick interval (tests). */
  tickMs?: number;
}

interface RingSlot {
  requests: number;
  errors: number;
  latencySumMs: number;
  latencyCount: number;
  messagesTotal: number;
}

const RING_SIZE = 60;
const DEFAULT_TICK_MS = 1_000;
const WINDOW_SECONDS = 60;

function emptySlot(): RingSlot {
  return { requests: 0, errors: 0, latencySumMs: 0, latencyCount: 0, messagesTotal: 0 };
}

/**
 * Optional MCP server handle — the collector calls `mcpServer.setCollector`
 * if available so we can wire instrumentation post-construction without
 * exposing a setter on `McpServer` itself for tests that don't care.
 *
 * Currently unused — we wire the collector directly into `McpServer` via
 * its constructor. Kept here so the optional positional arg in the
 * constructor stays explicitly documented.
 */
export interface BusMetricsMcpHook {
  /** Reserved for future use. */
  readonly _placeholder?: never;
}

export class BusMetricsCollector {
  private readonly _spawner: BusMetricsSpawnerLike;
  private readonly _tickMs: number;
  /** Ring of 60 slots. `_cursor` points at the slot currently being written. */
  private readonly _slots: RingSlot[] = Array.from({ length: RING_SIZE }, emptySlot);
  /** Index of the slot currently being written (advances on each tick). */
  private _cursor = 0;
  /** Total ticks observed since `start()` (clamped at RING_SIZE for the throughput denominator). */
  private _ticksSinceStart = 0;
  /** setInterval handle. Null when stopped. */
  private _timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether the collector is armed (between `start()` and `stop()`). The MCP
   * server holds a `private readonly` reference and calls
   * `recordRequestStart`/`recordRequestEnd` on EVERY tool call, even while the
   * `monitoring` feature is disabled — this flag turns that instrumentation
   * into a TRUE no-op so it never writes into a frozen slot
   * (docs/builtin-features.md D6). `false` at construction and after `stop()`:
   * a collector that was never `start()`ed — e.g. `monitoring` seeded disabled —
   * records nothing.
   */
  private _active = false;

  constructor(spawner: BusMetricsSpawnerLike, opts: BusMetricsCollectorOptions = {}) {
    this._spawner = spawner;
    this._tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  }

  /**
   * Start the 1 s tick. Idempotent: a second `start()` is a no-op.
   *
   * The tick advances the cursor, resets the new slot, and snapshots the
   * current `Σ messagesTotal` into it (so consecutive slots store a strictly
   * monotone series — we derive throughput from `newest - oldest`).
   */
  start(): void {
    if (this._timer) return;
    this._active = true;
    // Reset the ring + tick counter on every (re)start so a disable→enable
    // never reports a throughput SPIKE (docs/builtin-features.md D6). Two things
    // must be reset together:
    //   - `_ticksSinceStart` → 0, so the throughput denominator restarts at
    //     "1 elapsed second" instead of dividing by a stale 60;
    //   - every slot's `messagesTotal` → the CURRENT Σ total (the fresh
    //     baseline), so `(newest − oldest)` starts at 0 rather than measuring
    //     the whole idle gap that elapsed while the collector was stopped
    //     (seeding only the current slot would leave `oldest = 0`, i.e. the
    //     entire lifetime total dumped into one second of "throughput").
    // The MCP no-op (`_active`) already keeps the ring clean while stopped; this
    // guarantees a clean baseline even if a tick or a record slipped in.
    const seed = this._computeGlobalTotal();
    this._cursor = 0;
    this._ticksSinceStart = 0;
    for (const slot of this._slots) {
      slot.requests = 0;
      slot.errors = 0;
      slot.latencySumMs = 0;
      slot.latencyCount = 0;
      slot.messagesTotal = seed;
    }
    const timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // Never let a tick exception kill the interval.
        log.error({
          event: 'metrics.bus_tick_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this._tickMs);
    // unref so the interval never holds the event loop open at shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    this._timer = timer;
  }

  /** Stop the tick and disarm instrumentation. Idempotent. */
  stop(): void {
    // Disarm FIRST (before the timer guard) so `_active` is false even if the
    // collector was already stopped — record* is a no-op from here on.
    this._active = false;
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Advance to the next slot. Public for tests — production code never
   * calls this directly (the `setInterval` does).
   *
   * Steps:
   *   1. Move the cursor forward.
   *   2. Reset the slot we're now writing into.
   *   3. Snapshot the current `Σ messagesTotal` into the fresh slot.
   *
   * @internal
   */
  tick(): void {
    this._cursor = (this._cursor + 1) % RING_SIZE;
    const slot = this._slots[this._cursor]!;
    slot.requests = 0;
    slot.errors = 0;
    slot.latencySumMs = 0;
    slot.latencyCount = 0;
    slot.messagesTotal = this._computeGlobalTotal();
    if (this._ticksSinceStart < RING_SIZE) this._ticksSinceStart++;
  }

  /**
   * Begin an MCP request measurement. Returns a high-resolution start
   * timestamp the caller MUST pass to `recordRequestEnd` exactly once. We
   * return a `bigint` (ns since process start) so the caller's call site
   * stays cheap — no closure allocation, no Date.now drift.
   *
   * Pair-it-with-end overhead: ~150 ns per request. Negligible at any
   * realistic MCP request rate.
   */
  recordRequestStart(): bigint {
    // True no-op when disarmed (monitoring off): skip even the hrtime read and
    // return a sentinel. The matching recordRequestEnd() also short-circuits.
    if (!this._active) return 0n;
    return process.hrtime.bigint();
  }

  /**
   * Finalise an MCP request measurement. `start` MUST be the value returned
   * by the matching `recordRequestStart()`. `ok` is `true` iff the call
   * completed without throwing inside `transport.handleRequest`.
   *
   * Records into the *current* slot — so very-long requests that cross a
   * tick boundary land in the slot of their end timestamp. Acceptable: at
   * 60 ticks/min the systematic bias is < 1 s on a 60 s window.
   */
  recordRequestEnd(start: bigint, ok: boolean): void {
    // Disarmed (monitoring off): never write into the frozen slot. Without this
    // the MCP server's per-call instrumentation would keep inflating whatever
    // slot the cursor stopped on (docs/builtin-features.md D6).
    if (!this._active) return;
    const durationNs = process.hrtime.bigint() - start;
    // Convert ns → ms as a float. Safe: even 1 minute fits in a Number.
    const durationMs = Number(durationNs) / 1_000_000;
    const slot = this._slots[this._cursor]!;
    slot.requests++;
    if (!ok) slot.errors++;
    slot.latencySumMs += durationMs;
    slot.latencyCount++;
  }

  /**
   * Snapshot the current state. Returned object is a fresh plain object the
   * caller can `JSON.stringify` directly.
   */
  snapshot(): BusMetricsSnapshot {
    let latencySum = 0;
    let latencyCount = 0;
    let requests = 0;
    let errors = 0;
    for (const slot of this._slots) {
      latencySum += slot.latencySumMs;
      latencyCount += slot.latencyCount;
      requests += slot.requests;
      errors += slot.errors;
    }

    const latency_ms = latencyCount === 0 ? 0 : latencySum / latencyCount;
    const err_rate_pct = requests === 0 ? 0 : (errors / requests) * 100;

    // Throughput: newest sample = current cursor's messagesTotal, oldest =
    // the slot AHEAD of the cursor (which is the one we'll overwrite next).
    // The denominator is min(60, _ticksSinceStart) so we don't divide by 60
    // before the ring is full (otherwise throughput is wildly understated
    // in the first minute of life).
    const newestTotal = this._slots[this._cursor]!.messagesTotal;
    const oldestIdx = (this._cursor + 1) % RING_SIZE;
    const oldestTotal = this._slots[oldestIdx]!.messagesTotal;
    const denominator = Math.max(1, Math.min(RING_SIZE, this._ticksSinceStart));
    // Clamp at 0: defensive against an orch disappearing between two ticks
    // (cf. doc §7.7). Today Spawner never purges its Map but if it ever
    // does, the metric must stay sane.
    const throughput_msg_per_s = Math.max(0, (newestTotal - oldestTotal) / denominator);

    const queue_depth = this._computeQueueDepth();

    return {
      latency_ms,
      throughput_msg_per_s,
      queue_depth,
      err_rate_pct,
      window_seconds: WINDOW_SECONDS,
    };
  }

  // --- internals ---------------------------------------------------------

  /** Σ orch.mailbox.messagesTotal across every orch at call time. */
  private _computeGlobalTotal(): number {
    let sum = 0;
    for (const orch of this._spawner.list()) {
      sum += orch.mailbox.messagesTotal;
    }
    return sum;
  }

  /** Σ orch.mailbox.totalSize() across every orch at call time. */
  private _computeQueueDepth(): number {
    let sum = 0;
    for (const orch of this._spawner.list()) {
      sum += orch.mailbox.totalSize();
    }
    return sum;
  }
}
