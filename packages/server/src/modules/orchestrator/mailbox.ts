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
}

export interface PushResult {
  /** True if push triggered a drop of the oldest message (over cap). */
  dropped: boolean;
  /** Queue size **after** the push (and possible drop). */
  queueSize: number;
}

export interface MailboxOptions {
  /** Max messages per session inbox. Defaults to plan's 100. */
  maxSize?: number;
}

export class Mailbox {
  private readonly inboxes = new Map<string, Message[]>();
  private readonly maxSize: number;
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
   */
  push(
    to: string,
    msg: Omit<Message, 'id' | 'ts'> & Partial<Pick<Message, 'id' | 'ts'>>,
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
    };
    q.push(full);
    // Phase update_system S1: count *every* push, irrespective of recipient
    // and irrespective of the drop-oldest path below (cf. `messagesTotal`
    // JSDoc — the drop is a cap effect, not a bus failure).
    this._messagesTotal++;
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
    }
    return { dropped, queueSize: q.length };
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
      // Don't keep empty queues hanging in the Map.
      this.inboxes.delete(sid);
      return [];
    }
    this.inboxes.delete(sid);
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
   */
  removeSession(sid: string): void {
    this.inboxes.delete(sid);
  }

  /**
   * Wipe every queue. Used by `Orchestrator.stop()` and tests.
   */
  clearAll(): void {
    this.inboxes.clear();
  }
}
