/**
 * S9 (fusion S4 + S9) — `/metrics/messages` aggregator.
 *
 * Owns the in-memory ring buffers that back the bus-throughput sparklines:
 *  - `_global` : 60-point ring (1 entry per minute, last 60 min).
 *  - `_perOrch[id]` : 8-point ring (last 8 min) per orchestrator id.
 *
 * Each entry is the **delta** of bus messages observed during the last
 * 60 s tick. `snapshot().total` is recomputed on demand from the live
 * `Σ orch.mailbox.messagesTotal` (invariant — the ring never claims to
 * be the source of truth).
 *
 * Lifetime: instantiated once at boot in `index.ts`, started right after
 * the Spawner is wired and stopped first during graceful shutdown. Loss
 * of state on restart is acceptable v1 (per `09_metrics_messages.md`).
 */
import type { Orchestrator } from '../orchestrator/index.js';
import { withModule } from '../../logger.js';

const log = withModule('metrics');

/** Public payload shape — see `12 Schéma payload final retenu` in the spec. */
export interface MessagesMetricsSnapshot {
  /** Σ mailbox.messagesTotal across all orchs at call time. */
  total: number;
  /** Most recent 60-second delta (`global[59]`). */
  per_minute: number;
  /** 60 ints: msg/min over the trailing 60 minutes (oldest first). */
  global: number[];
  /** Per-orchestrator 8-point ring (oldest first). Keyed by orch.id (UUID). */
  per_orchestrator: Record<string, number[]>;
}

const GLOBAL_RING_SIZE = 60;
const PER_ORCH_RING_SIZE = 8;
const DEFAULT_TICK_MS = 60_000;

/**
 * Minimal interface the aggregator consumes from the Spawner. The full
 * `Spawner` type fits trivially; the narrowing makes unit tests trivial
 * (a fake spawner is just `{ list: () => [...] }`).
 */
export interface MetricsSpawnerLike {
  list(): Array<Pick<Orchestrator, 'id' | 'mailbox'>>;
}

export interface MessagesAggregatorOptions {
  /** Override the 60 000 ms tick interval (tests). */
  tickMs?: number;
}

export class MessagesAggregator {
  private readonly _spawner: MetricsSpawnerLike;
  private readonly _tickMs: number;
  /** Global ring (length 60). Pre-allocated to 0 so callers always see 60 entries. */
  private readonly _global: number[] = new Array(GLOBAL_RING_SIZE).fill(0);
  /** Per-orch rings (length 8 each). Allocated lazily the first time we see an id. */
  private readonly _perOrch = new Map<string, number[]>();
  /** Last observed messagesTotal per orch — used to compute deltas at the next tick. */
  private readonly _lastTotalsByOrch = new Map<string, number>();
  /** Last observed Σ messagesTotal — used to compute the global delta. */
  private _lastGlobalTotal = 0;
  /** setInterval handle. Null when stopped. */
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(spawner: MetricsSpawnerLike, opts: MessagesAggregatorOptions = {}) {
    this._spawner = spawner;
    this._tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  }

  /**
   * Start the 60 s tick. Idempotent: a second `start()` is a no-op.
   *
   * Initialises `_lastGlobalTotal` and `_lastTotalsByOrch` to the **current**
   * `messagesTotal` values so the first tick produces deltas of 0 instead of
   * "the entire backlog landed in one minute" (cf. S4 §7.5 / S9 §5.1).
   */
  start(): void {
    if (this._timer) return;
    this._lastGlobalTotal = this._computeGlobalTotal();
    for (const orch of this._spawner.list()) {
      this._lastTotalsByOrch.set(orch.id, orch.mailbox.messagesTotal);
    }
    const timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // Never let an exception kill the interval — log and keep going.
        log.error({
          event: 'metrics.tick_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this._tickMs);
    // `unref` so the interval never holds the event loop open during shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    this._timer = timer;
  }

  /** Stop the tick. Idempotent. */
  stop(): void {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Advance the rings by one slot. Public for tests — production code never
   * calls this directly (the `setInterval` does).
   *
   * @internal
   */
  tick(): void {
    // 1) Global delta.
    const globalNow = this._computeGlobalTotal();
    const dGlobal = Math.max(0, globalNow - this._lastGlobalTotal);
    this._lastGlobalTotal = globalNow;
    this._global.shift();
    this._global.push(dGlobal);

    // 2) Per-orch deltas. Iterate `spawner.list()` (NOT `listActive()`) so a
    //    stopped orch's ring decays gracefully toward [0]*8 over 8 ticks.
    const seenIds = new Set<string>();
    for (const orch of this._spawner.list()) {
      seenIds.add(orch.id);
      const now = orch.mailbox.messagesTotal;
      const prev = this._lastTotalsByOrch.get(orch.id);
      let ring = this._perOrch.get(orch.id);
      if (!ring) {
        // First time we see this orch — preallocate to zeros so the ring
        // length is invariant at 8.
        ring = new Array(PER_ORCH_RING_SIZE).fill(0);
        this._perOrch.set(orch.id, ring);
      }
      const delta = prev === undefined ? 0 : Math.max(0, now - prev);
      this._lastTotalsByOrch.set(orch.id, now);
      ring.shift();
      ring.push(delta);
    }

    // 3) Defensive: for any orch we tracked previously but no longer see in
    //    `spawner.list()`, push 0 so the ring decays. Today Spawner never
    //    purges its map, but if that changes the metric stays consistent.
    for (const [id, ring] of this._perOrch) {
      if (seenIds.has(id)) continue;
      ring.shift();
      ring.push(0);
    }
  }

  /**
   * Snapshot the current state. Returns plain numbers / arrays — safe to
   * `JSON.stringify` directly. Arrays are copies; the caller can mutate
   * without corrupting internal state.
   */
  snapshot(): MessagesMetricsSnapshot {
    const total = this._computeGlobalTotal();
    const global = this._global.slice();
    const per_orchestrator: Record<string, number[]> = {};
    for (const [id, ring] of this._perOrch) {
      per_orchestrator[id] = ring.slice();
    }
    return {
      total,
      per_minute: global[GLOBAL_RING_SIZE - 1] ?? 0,
      global,
      per_orchestrator,
    };
  }

  /** Σ orch.mailbox.messagesTotal at call time — the canonical "total". */
  private _computeGlobalTotal(): number {
    let sum = 0;
    for (const orch of this._spawner.list()) {
      sum += orch.mailbox.messagesTotal;
    }
    return sum;
  }
}
