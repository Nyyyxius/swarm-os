import * as crypto from 'node:crypto';
import { withModule } from '../../logger.js';

const log = withModule('mailbox');

/**
 * In-memory mailbox for an orchestrator (plan §11).
 *
 * Holds one bounded queue per session id. Messages are NEVER persisted —
 * they live exactly as long as the orchestrator process holds them. This is
 * a deliberate design choice (plan §11 / §17): the PTY processes themselves
 * don't survive a server restart, so persisting their inboxes would only
 * grow the DB without any consumer.
 *
 * The cap (`maxSize`, default `SWARM_OS_MAX_INBOX_SIZE = 100`) is enforced
 * on `push()`: when we would exceed it, the oldest message is dropped and a
 * structured warning is logged. The sender's `send_message` return payload
 * carries `dropped: true` so the caller can detect overflow.
 *
 * Concurrency: every method is synchronous. The Node single-threaded event
 * loop is enough — we never await between read and mutation.
 */

export interface Message {
  /** UUID v4. Stable across the lifetime of the message. */
  id: string;
  /** Sender — usually a session id, but may be `'system'` or `'human'`. */
  from: string;
  /** Free-form content (sender's responsibility to keep it small). */
  content: string;
  /** ISO 8601 timestamp set at push time. */
  ts: string;
  /**
   * Origin orchestrator id — present ONLY for cross-team messages
   * (swarm.send_to_lead / swarm.broadcast_to_leads). Absent for intra-team
   * messages so the existing wire format stays unchanged.
   */
  fromOrchestratorId?: string;
  /** Denormalized source orch name (cross-team only). */
  fromOrchestratorName?: string;
  /** Denormalized source session name (cross-team only). */
  fromSessionName?: string;
  /**
   * External source kind. Present only when the message originates from an
   * external bridge (`'discord'` built-in, or a plugin connector type such as
   * `'slack'` — J4). Absent for intra-team and cross-team swarm-internal
   * traffic.
   */
  sourceKind?: string;
  /**
   * Native source platform message id (e.g. Discord snowflake). Lets the lead
   * reference the original message in subsequent calls (reply, thread anchor).
   */
  sourceMessageId?: string;
  /**
   * Thread id of the source platform (e.g. Discord thread snowflake). Present
   * only when the inbound message was posted inside a thread.
   */
  threadId?: string;
  /** Human-readable thread name, denormalized alongside `threadId`. */
  threadName?: string;
}

export interface PushResult {
  /** True if push triggered a drop of the oldest message (over cap). */
  dropped: boolean;
  /** Queue size **after** the push (and possible drop). */
  queueSize: number;
}

/**
 * Phase 8 — write-through persistence hook. When supplied, every `push`
 * INSERTs into `mailbox_messages` so messages survive a server restart;
 * `markDelivered` is called by the MCP `read_inbox` handler after the
 * response has been flushed (NOT inside `Mailbox.read`, so partial reads
 * don't lose data — see plan §F.1 / at-least-once "soft" semantics).
 *
 * The hook intentionally lives behind an interface so this module stays
 * free of any DB imports; the concrete impl lives in
 * `mailbox-persistence.ts`.
 */
export interface MailboxPersistHook {
  writeMessage(to: string, msg: Message): void;
  writeMessagesBatch(items: Array<{ to: string; msg: Message }>): void;
  markDelivered(ids: string[]): void;
}

export interface MailboxOptions {
  /** Max messages per session inbox. Defaults to plan's 100. */
  maxSize?: number;
  /**
   * Phase 8 — optional write-through persistence. When undefined (tests,
   * legacy NoOpPersistence), the mailbox stays purely in-memory.
   */
  persist?: MailboxPersistHook;
}

export interface PushOptions {
  /**
   * Phase 8 — rehydrate path only. Skip the `_messagesTotal++` bump AND the
   * persist-hook write, since the message is already counted in the
   * previous incarnation's history and already on disk in the DB.
   * Without this, every restart would fake-spike the `/metrics/bus`
   * throughput gauge as rehydrated messages get "pushed" again.
   */
  silent?: boolean;
}

export class Mailbox {
  private readonly inboxes = new Map<string, Message[]>();
  /**
   * update_system D.5 — per-session count of *draining* `read()` calls, i.e.
   * the number of times an agent actually took messages out of this inbox.
   *
   * This exists because "the message is no longer in the queue" is NOT proof
   * that anybody read it: `clearAll()` (lead exit → `Orchestrator.stop()`,
   * and `shutdownForRestart()`), `removeSession()` and the drop-oldest cap
   * eviction all empty queues without a single agent being involved. Only
   * `read()` is an agent. So the counter is bumped in exactly one place, and
   * a caller that wants an honest read receipt compares it against a baseline
   * taken when it queued its message (see `Spawner.leadNoticeStatus`).
   *
   * Invariants that make it trustworthy:
   *  - **Monotonic, never reset.** Not by `read()` dropping the queue, not by
   *    `removeSession()`, and above all NOT by `clearAll()` — a wipe that
   *    could look like a read is the exact lie this counter prevents.
   *  - **Only non-empty drains count.** Reading an already-empty inbox
   *    provably consumed nothing, so counting it could only ever manufacture
   *    a false "read". A read that took our message is non-empty by
   *    definition, so this can never produce a false negative.
   *  - **In-memory only**, like the queues themselves: it dies with the
   *    process. A handle replayed after a restart therefore reads 0 and can
   *    never be credited with a read — fail-closed, which is the safe side.
   *
   * Bounded by the number of distinct session ids of ONE orchestrator that
   * ever drained an inbox (a handful), so it is not a growth concern.
   */
  private readonly reads = new Map<string, number>();
  /**
   * Monitoring (docs/monitoring-agents.md, Lot 1) — per-session count of
   * *messages* an agent actually took out of this inbox, as opposed to
   * `reads`, which counts the drains themselves.
   *
   * Same single-increment discipline as `reads`, for the same reason: a queue
   * emptied by `clearAll()`, `removeSession()` or the drop-oldest cap eviction
   * was never handed to anybody, so counting it would inflate the number the
   * operator reads on the monitoring page into a fiction. Only `read()` moves
   * it, by the exact number of messages returned.
   *
   * In-memory like the queues; the durable value is mirrored onto the
   * `Session` at drain time (`readInbox`) and persisted from there.
   */
  private readonly processed = new Map<string, number>();
  private readonly maxSize: number;
  private readonly persist: MailboxPersistHook | undefined;
  /**
   * Cumulative count of messages pushed into this mailbox since the
   * orchestrator started. Backed by `_messagesTotal`, surfaced via the
   * `messagesTotal` getter — see its JSDoc for semantics.
   */
  private _messagesTotal = 0;

  constructor(opts: MailboxOptions = {}) {
    const cap = opts.maxSize ?? 100;
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error(`Mailbox maxSize must be a positive integer, got ${cap}`);
    }
    this.maxSize = cap;
    this.persist = opts.persist;
  }

  /**
   * Cumulative count of bus messages pushed into this mailbox since the
   * orchestrator started. Phase update_system S1.
   *
   * Semantics (documented for UI consumers):
   * - **One push = one increment.** A `team.broadcast` that reaches N
   *   active sessions increments the counter by N (one push per
   *   recipient), not by 1. The counter measures bus *traffic*, not
   *   "logical messages".
   * - **Monotone, never reset.** `read()`, `peek()`, `removeSession()`,
   *   and `clearAll()` leave it untouched — they don't represent bus
   *   activity, just inbox lifecycle.
   * - **Drop-oldest still counts.** When a push exceeds the cap and the
   *   oldest message is evicted, the counter has already taken +1 for
   *   that older push and takes +1 for the new push. The drop is a cap
   *   effect, not a bus failure.
   * - **In-memory only.** The counter dies with the orchestrator process
   *   and restarts at 0. Acceptable v1 (cf. `update_system.md`).
   * - **Wraparound non-issue.** `Number.MAX_SAFE_INTEGER` (~9e15) at
   *   1000 msg/s sustained 24/7 = ~285 000 years. We don't wrap in
   *   BigInt.
   */
  get messagesTotal(): number {
    return this._messagesTotal;
  }

  /**
   * Push a message into `to`'s inbox. Mints `id` and `ts` if not provided.
   * Returns `{ dropped, queueSize }`. When `dropped` is true the oldest
   * message in the recipient's queue was evicted to make room.
   *
   * Phase 8 — `opts.silent: true` skips both the `_messagesTotal++` bump
   * and the persist-hook write. Used by `rehydrateMailbox` to reload
   * already-persisted messages without double-counting or double-writing.
   */
  push(
    to: string,
    msg: Omit<Message, 'id' | 'ts'> & Partial<Pick<Message, 'id' | 'ts'>>,
    opts: PushOptions = {},
  ): PushResult {
    let q = this.inboxes.get(to);
    if (!q) {
      q = [];
      this.inboxes.set(to, q);
    }
    const full: Message = {
      id: msg.id ?? crypto.randomUUID(),
      from: msg.from,
      content: msg.content,
      ts: msg.ts ?? new Date().toISOString(),
      ...(msg.fromOrchestratorId ? { fromOrchestratorId: msg.fromOrchestratorId } : {}),
      ...(msg.fromOrchestratorName ? { fromOrchestratorName: msg.fromOrchestratorName } : {}),
      ...(msg.fromSessionName ? { fromSessionName: msg.fromSessionName } : {}),
      ...(msg.sourceKind ? { sourceKind: msg.sourceKind } : {}),
      ...(msg.sourceMessageId ? { sourceMessageId: msg.sourceMessageId } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      ...(msg.threadName ? { threadName: msg.threadName } : {}),
    };
    q.push(full);
    if (!opts.silent) {
      // Phase update_system S1: count *every* push, irrespective of recipient
      // and irrespective of the drop-oldest path below (cf. `messagesTotal`
      // JSDoc — the drop is a cap effect, not a bus failure).
      this._messagesTotal++;
      // Phase 8: write-through persist (sync, single-row INSERT).
      // `silent` path bypasses this so rehydrate doesn't double-write.
      try {
        this.persist?.writeMessage(to, full);
      } catch (err) {
        log.warn({
          event: 'mail.persist_failed',
          to,
          msgId: full.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    let dropped = false;
    if (q.length > this.maxSize) {
      // Drop the OLDEST. Plan §11 step 3: bounded, drop-oldest semantics.
      const evicted = q.shift();
      dropped = true;
      // Structured log so an operator can spot a runaway inbox without
      // grepping. We never log the message body (plan §15).
      log.warn({
        event: 'mail.dropped',
        to,
        evictedId: evicted?.id,
        maxSize: this.maxSize,
      });
      // Phase 8: mark the evicted msg delivered so rehydrate doesn't bring
      // it back at the next boot. Skip in silent mode (rehydrate path) —
      // there's no DB row corresponding to a freshly-evicted in-memory msg.
      if (!opts.silent && evicted?.id) {
        try {
          this.persist?.markDelivered([evicted.id]);
        } catch {
          /* best-effort */
        }
      }
    }
    return { dropped, queueSize: q.length };
  }

  /**
   * Phase 8 — push N messages and write them through the persist hook in a
   * single transaction (one fsync for the whole batch). Used by
   * `messaging.broadcast` so a 50-recipient broadcast doesn't block the
   * event loop on 50 individual fsyncs.
   *
   * Cap enforcement runs per recipient like `push()`. Returns the per-item
   * PushResult array in the same order.
   */
  pushBatch(
    items: Array<{
      to: string;
      msg: Omit<Message, 'id' | 'ts'> & Partial<Pick<Message, 'id' | 'ts'>>;
    }>,
  ): PushResult[] {
    if (items.length === 0) return [];
    const results: PushResult[] = [];
    const persistedItems: Array<{ to: string; msg: Message }> = [];
    const evictedIds: string[] = [];
    for (const item of items) {
      const { to, msg } = item;
      let q = this.inboxes.get(to);
      if (!q) {
        q = [];
        this.inboxes.set(to, q);
      }
      const full: Message = {
        id: msg.id ?? crypto.randomUUID(),
        from: msg.from,
        content: msg.content,
        ts: msg.ts ?? new Date().toISOString(),
        ...(msg.fromOrchestratorId ? { fromOrchestratorId: msg.fromOrchestratorId } : {}),
        ...(msg.fromOrchestratorName ? { fromOrchestratorName: msg.fromOrchestratorName } : {}),
        ...(msg.fromSessionName ? { fromSessionName: msg.fromSessionName } : {}),
        ...(msg.sourceKind ? { sourceKind: msg.sourceKind } : {}),
        ...(msg.sourceMessageId ? { sourceMessageId: msg.sourceMessageId } : {}),
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(msg.threadName ? { threadName: msg.threadName } : {}),
      };
      q.push(full);
      this._messagesTotal++;
      persistedItems.push({ to, msg: full });
      let dropped = false;
      if (q.length > this.maxSize) {
        const evicted = q.shift();
        dropped = true;
        log.warn({
          event: 'mail.dropped',
          to,
          evictedId: evicted?.id,
          maxSize: this.maxSize,
        });
        if (evicted?.id) evictedIds.push(evicted.id);
      }
      results.push({ dropped, queueSize: q.length });
    }
    try {
      this.persist?.writeMessagesBatch(persistedItems);
    } catch (err) {
      log.warn({
        event: 'mail.persist_batch_failed',
        count: persistedItems.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (evictedIds.length > 0) {
      try {
        this.persist?.markDelivered(evictedIds);
      } catch {
        /* best-effort */
      }
    }
    return results;
  }

  /**
   * Read AND empty `sid`'s inbox (the canonical `team.read_inbox` semantic).
   * Returns an empty array if the inbox doesn't exist or is empty. The
   * underlying queue is dropped after a drain so we don't keep an empty Map
   * entry around for stale sessions.
   */
  read(sid: string): Message[] {
    const q = this.inboxes.get(sid);
    if (!q || q.length === 0) {
      // Don't keep empty queues hanging in the Map. No `readCount` bump: an
      // empty drain consumed nothing, and crediting it would let a wipe +
      // an idle poll masquerade as a delivery (see `readCount`).
      this.inboxes.delete(sid);
      return [];
    }
    this.inboxes.delete(sid);
    // The ONLY place these counters move. Every other way a queue can empty
    // (clearAll, removeSession, cap eviction) is not an agent reading.
    this.reads.set(sid, (this.reads.get(sid) ?? 0) + 1);
    this.processed.set(sid, (this.processed.get(sid) ?? 0) + q.length);
    return q;
  }

  /**
   * Non-destructive snapshot — used by the UI's inbox-count poll. Returns a
   * shallow copy so callers can't mutate the internal queue.
   */
  peek(sid: string): Message[] {
    const q = this.inboxes.get(sid);
    return q ? q.slice() : [];
  }

  /** Number of messages currently queued for `sid`. */
  size(sid: string): number {
    return this.inboxes.get(sid)?.length ?? 0;
  }

  /**
   * Epoch ms of the NEWEST message queued for `sid`, or `null` when the queue
   * is empty (docs/auto-compact.md §3.2).
   *
   * Exists for exactly one rule, at the idle boundary: re-signal the inbox only
   * when something arrived AFTER the last signal we sent
   * (`Session.lastInboxSignalAt`). That is what caps the wake-ups at one per
   * message — an agent that keeps ignoring its inbox is not nudged again at
   * every boundary for the rest of its life.
   *
   * Scans the queue rather than reading the last element: `rehydrateMailbox`
   * re-pushes persisted rows with their ORIGINAL `ts`, so insertion order is
   * not timestamp order across a restart. Bounded by `maxSize` (100), O(n) on
   * integers, once per boundary.
   *
   * A row whose `ts` does not parse is skipped rather than treated as `now`:
   * inventing a fresh timestamp for a corrupt one would re-signal forever.
   */
  newestTs(sid: string): number | null {
    const q = this.inboxes.get(sid);
    if (!q || q.length === 0) return null;
    let newest: number | null = null;
    for (const m of q) {
      const t = Date.parse(m.ts);
      if (Number.isNaN(t)) continue;
      if (newest === null || t > newest) newest = t;
    }
    return newest;
  }

  /**
   * Monotonic count of draining `read()` calls served for `sid` since this
   * mailbox was constructed — see the `reads` field for the full contract.
   *
   * The intended use is differential, never absolute: take it when you queue
   * a message, compare it later, and treat *an increase* as the proof that an
   * agent drained the inbox in between.
   */
  readCount(sid: string): number {
    return this.reads.get(sid) ?? 0;
  }

  /**
   * Monotonic count of inbox messages `sid` actually drained since this
   * mailbox was constructed — see the `processed` field for the full
   * contract. 0 for a session that never read anything.
   *
   * Absolute (unlike `readCount`), which is why it is mirrored onto the
   * `Session` and persisted: the in-memory value restarts at 0 with the
   * process, and the operator's counter must not.
   */
  messagesProcessed(sid: string): number {
    return this.processed.get(sid) ?? 0;
  }

  /**
   * Sum of every inbox queue length across all sessions in this mailbox.
   * Phase update_system S8 — used by `BusMetricsCollector.snapshot()` to
   * compute the instantaneous `queue_depth` KPI surfaced on `/metrics/bus`.
   * O(N sessions) — does NOT scan messages, only sums queue lengths.
   */
  totalSize(): number {
    let sum = 0;
    for (const q of this.inboxes.values()) sum += q.length;
    return sum;
  }

  /**
   * Drop everything queued for `sid`. Called when the session is destroyed
   * (worker killed, lead exit) so we don't leak across recycled ids.
   *
   * Phase 8 — also stamps DB rows as delivered so they don't ressurect at
   * the next boot. An operator who just killed a worker would be confused
   * to see its old undelivered messages re-emerge after a server restart.
   */
  removeSession(sid: string): void {
    const q = this.inboxes.get(sid);
    if (q && q.length > 0) {
      try {
        this.persist?.markDelivered(q.map((m) => m.id));
      } catch {
        /* best-effort */
      }
    }
    this.inboxes.delete(sid);
  }

  /**
   * Wipe every queue. Used by `Orchestrator.stop()` and tests.
   *
   * Phase 8 — same rationale as `removeSession`: stamp the persisted rows
   * delivered so a server restart that fires straight after `stop()`
   * doesn't bring messages back from the dead.
   */
  clearAll(): void {
    const ids: string[] = [];
    for (const q of this.inboxes.values()) {
      for (const m of q) ids.push(m.id);
    }
    if (ids.length > 0) {
      try {
        this.persist?.markDelivered(ids);
      } catch {
        /* best-effort */
      }
    }
    this.inboxes.clear();
  }
}
