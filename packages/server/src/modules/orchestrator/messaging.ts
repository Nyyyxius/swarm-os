import type { Message, Mailbox } from './mailbox.js';
import type { Session } from './session.js';
import type { Orchestrator } from './index.js';
import { withModule } from '../../logger.js';

const log = withModule('messaging');

/**
 * High-level messaging helpers (plan §11).
 *
 * `sendMessage` and `broadcast` sit between the MCP tools / REST handlers
 * and the raw `Mailbox`. They:
 *
 * 1. Validate the payload size (`SWARM_OS_MAX_MESSAGE_SIZE_KB`, default 16).
 * 2. Validate the recipient is an active session in the orchestrator.
 * 3. Push to the mailbox.
 * 4. If the recipient is **idle** (no PTY output for ≥ `idleThresholdMs`,
 *    default 2000 ms), inject a short signal in their PTY so they wake up
 *    and call `team.read_inbox`. Otherwise we stay silent — the worker is
 *    busy and a signal would garble its current output stream.
 * 5. Log a structured `mail.send`/`mail.broadcast` line *without* the body.
 *
 * No throwing on idle-signal failure — the message is in the inbox no
 * matter what; the signal is just a hint.
 */

export const SIGNAL_TEXT = '[swarm-os] new message in inbox — call team.read_inbox to fetch';

export class MessageError extends Error {
  /** HTTP status (REST) — MCP code is derived in tools.ts. */
  readonly httpStatus: number;
  /** Stable code for clients to switch on. */
  readonly code: string;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'MessageError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface MessagingDefaults {
  /** Max content bytes (UTF-8). */
  maxMessageSizeBytes: number;
  /** Idle threshold in ms before injecting a signal. */
  idleThresholdMs: number;
}

export interface SendOptions {
  /**
   * If true, we skip the active-recipient check (used by orchestrator-internal
   * notifications such as the abnormal-exit auto-message — the lead is the
   * recipient and is expected to be alive, but we don't want to fight a
   * race). Defaults to false.
   */
  skipRecipientCheck?: boolean;
}

export interface SendOutcome {
  delivered: boolean;
  dropped: boolean;
  queueSize: number;
  /** Did we actually inject the PTY signal? */
  signalled: boolean;
}

export interface BroadcastOutcome {
  delivered_to: string[];
  /** Sessions skipped because they were terminated or were the sender. */
  skipped: string[];
}

export interface MessagingDeps {
  orchestrator: Orchestrator;
  mailbox: Mailbox;
  defaults: MessagingDefaults;
}

/** Re-exported in tools.ts and tests so callers can do their own checks. */
export function validateMessageSize(
  content: string,
  maxBytes: number,
): { ok: true; bytes: number } | { ok: false; bytes: number; max: number } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > maxBytes) return { ok: false, bytes, max: maxBytes };
  return { ok: true, bytes };
}

function isActive(s: Session | undefined | null): boolean {
  if (!s) return false;
  return s.status === 'running' || s.status === 'starting' || s.status === 'waiting';
}

/**
 * Compute idle-ness with respect to the configured threshold.
 *
 * "Idle" means the session has not produced PTY output for at least
 * `idleThresholdMs`. We use `Session.idleSince` (epoch ms, set on every PTY
 * data event) instead of `lastActivityAt` (ISO string) to avoid a
 * Date.parse() per call.
 */
export function isIdle(session: Session, now: number, idleThresholdMs: number): boolean {
  return now - session.idleSince >= idleThresholdMs;
}

/**
 * Inject the signal into the recipient's PTY. Wraps the text in `\n…\n` so
 * it always lands on its own line (terminals can be mid-write at any
 * column). Best-effort: the underlying `notifySignal` swallows write errors.
 */
function injectSignal(session: Session): boolean {
  try {
    session.notifySignal(SIGNAL_TEXT);
    return true;
  } catch (err) {
    log.error({
      event: 'notifySignal.failed',
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * `team.send_message` core implementation. The `from` argument is the
 * sender — usually a session id, but may be `'human'` or `'system'`.
 */
export function sendMessage(
  deps: MessagingDeps,
  fromSid: string,
  toSid: string,
  content: string,
  opts: SendOptions = {},
): SendOutcome {
  const sizeCheck = validateMessageSize(content, deps.defaults.maxMessageSizeBytes);
  if (!sizeCheck.ok) {
    throw new MessageError(
      'MESSAGE_TOO_LARGE',
      `message too large: ${sizeCheck.bytes} bytes > ${sizeCheck.max}`,
      413,
    );
  }
  if (!toSid || typeof toSid !== 'string') {
    throw new MessageError('INVALID_RECIPIENT', 'recipient session id required', 400);
  }
  const recipient = deps.orchestrator.getSession(toSid);
  if (!recipient) {
    throw new MessageError(
      'RECIPIENT_UNKNOWN',
      `recipient ${toSid} does not exist in this orchestrator`,
      404,
    );
  }
  if (!opts.skipRecipientCheck && !isActive(recipient)) {
    throw new MessageError(
      'RECIPIENT_NOT_ACTIVE',
      `recipient ${toSid} is not an active session in this orchestrator`,
      404,
    );
  }

  const result = deps.mailbox.push(toSid, { from: fromSid, content });

  // Structured log — body is intentionally NOT included (plan §15).
  log.info({
    event: 'mail.send',
    from: fromSid,
    to: toSid,
    len: sizeCheck.bytes,
    queueSize: result.queueSize,
    dropped: result.dropped,
  });

  let signalled = false;
  if (isIdle(recipient, Date.now(), deps.defaults.idleThresholdMs)) {
    signalled = injectSignal(recipient);
  }

  return {
    delivered: true,
    dropped: result.dropped,
    queueSize: result.queueSize,
    signalled,
  };
}

/**
 * `team.broadcast` core implementation. Pushes to every active session
 * EXCEPT `fromSid` (the sender doesn't echo back to itself). Idle-signals
 * each recipient using the same rule as `sendMessage`.
 */
export function broadcast(
  deps: MessagingDeps,
  fromSid: string,
  content: string,
): BroadcastOutcome {
  const sizeCheck = validateMessageSize(content, deps.defaults.maxMessageSizeBytes);
  if (!sizeCheck.ok) {
    throw new MessageError(
      'MESSAGE_TOO_LARGE',
      `message too large: ${sizeCheck.bytes} bytes > ${sizeCheck.max}`,
      413,
    );
  }

  const delivered: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  for (const s of deps.orchestrator.listSessions()) {
    if (s.id === fromSid) {
      skipped.push(s.id);
      continue;
    }
    if (!isActive(s)) {
      skipped.push(s.id);
      continue;
    }
    deps.mailbox.push(s.id, { from: fromSid, content });
    if (isIdle(s, now, deps.defaults.idleThresholdMs)) {
      injectSignal(s);
    }
    delivered.push(s.id);
  }

  log.info({
    event: 'mail.broadcast',
    from: fromSid,
    delivered: delivered.length,
    skipped: skipped.length,
    len: sizeCheck.bytes,
  });

  return { delivered_to: delivered, skipped };
}

/**
 * Convenience wrapper that callers (REST handler, orchestrator) use to read
 * a session's inbox and emit the canonical log. Mirrors `team.read_inbox`.
 */
export function readInbox(deps: MessagingDeps, sid: string): Message[] {
  const msgs = deps.mailbox.read(sid);
  log.info({
    event: 'mail.read',
    sid,
    count: msgs.length,
  });
  return msgs;
}
