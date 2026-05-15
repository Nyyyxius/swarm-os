import * as crypto from 'node:crypto';

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

  constructor(opts: MailboxOptions = {}) {
    const cap = opts.maxSize ?? 100;
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error(`Mailbox maxSize must be a positive integer, got ${cap}`);
    }
    this.maxSize = cap;
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
    };
    q.push(full);
    let dropped = false;
    if (q.length > this.maxSize) {
      // Drop the OLDEST. Plan §11 step 3: bounded, drop-oldest semantics.
      const evicted = q.shift();
      dropped = true;
      // Structured log so an operator can spot a runaway inbox without
      // grepping. We never log the message body (plan §15).
      console.warn(
        JSON.stringify({
          event: 'mail.dropped',
          to,
          evictedId: evicted?.id,
          maxSize: this.maxSize,
        }),
      );
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
