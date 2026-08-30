import type { Message, Mailbox } from './mailbox.js';
import type { Session } from './session.js';
import type { Orchestrator } from './index.js';
import type { Spawner } from '../spawner/index.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';

const log = withModule('messaging');

/**
 * Emit a `mailbox.message` event on the global bus (update_system S2).
 *
 * Called from every site that successfully pushes into a mailbox so the UI
 * can light up "pulses" on its MapView. `orchestratorId` is ALWAYS the
 * orchestrator of the recipient — for cross-team sends, the source is
 * surfaced via the optional `fromOrchestratorId` field.
 *
 * Exported so `Orchestrator._onWorkerExit` (which lives in `index.ts` and
 * pushes a synthetic `from: 'system'` notice without going through this
 * module) can fire the same canonical event shape.
 */
export function emitMailboxMessage(
  orchestratorId: string,
  from: string,
  to: string | 'broadcast',
  fromOrchestratorId?: string,
): void {
  const payload: {
    from: string;
    to: string | 'broadcast';
    orchestratorId: string;
    fromOrchestratorId?: string;
  } = { from, to, orchestratorId };
  if (fromOrchestratorId !== undefined && fromOrchestratorId !== orchestratorId) {
    payload.fromOrchestratorId = fromOrchestratorId;
  }
  eventBus.emitEvent({
    kind: 'mailbox.message',
    orchestratorId,
    payload,
  });
}

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
  // S5 — `paused` is "active" for the purpose of routing mail (the message
  // sits in the inbox, the agent will read it on resume); it is NOT idle for
  // the purpose of the PTY wake-up signal (`isIdle` handles that). Including
  // `paused` here keeps `team.send_message` / broadcast working against a
  // paused recipient without flipping to RECIPIENT_NOT_ACTIVE.
  return (
    s.status === 'running' ||
    s.status === 'starting' ||
    s.status === 'waiting' ||
    s.status === 'paused'
  );
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
  // S5 — paused sessions deliberately suppress the PTY wake-up signal: the
  // SIGSTOP'd process can't read its tty anyway, and write()s would just
  // buffer up to arrive in a garbled clump on resume. The mailbox push is
  // still effective (the recipient will see the new mail when it wakes up
  // and calls team.read_inbox).
  if (session.status === 'paused') return false;
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
  emitMailboxMessage(deps.orchestrator.id, fromSid, toSid);

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

  // Phase 8 — collect first so we can write all DB rows in a single
  // transaction (one fsync instead of N). Idle-signalling stays per-recipient
  // since it touches the PTY, not the DB.
  const batch: Array<{ to: string; msg: { from: string; content: string } }> = [];
  const idleRecipients: Session[] = [];
  for (const s of deps.orchestrator.listSessions()) {
    if (s.id === fromSid) {
      skipped.push(s.id);
      continue;
    }
    if (!isActive(s)) {
      skipped.push(s.id);
      continue;
    }
    batch.push({ to: s.id, msg: { from: fromSid, content } });
    if (isIdle(s, now, deps.defaults.idleThresholdMs)) idleRecipients.push(s);
    delivered.push(s.id);
  }
  if (batch.length > 0) {
    deps.mailbox.pushBatch(batch);
    for (const s of idleRecipients) injectSignal(s);
  }

  // Single event with `to: 'broadcast'` (update_system S2). We intentionally
  // skip when no one was reached — avoids fantom pulses on a 1-session orch
  // where the sender is the only member.
  if (delivered.length > 0) {
    emitMailboxMessage(deps.orchestrator.id, fromSid, 'broadcast');
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
 * Outcome of a `swarm.send_to_lead` call. `to_session_id` is the lead session
 * id we landed in — included so the caller can correlate logs without a
 * second lookup.
 */
export interface CrossSendOutcome {
  delivered: boolean;
  dropped: boolean;
  queueSize: number;
  signalled: boolean;
  to_session_id: string;
  to_orchestrator_id: string;
}

/** Outcome of a `swarm.broadcast_to_leads` call. */
export interface CrossBroadcastOutcome {
  delivered_to: Array<{ orchestrator_id: string; session_id: string }>;
}

/**
 * `swarm.send_to_lead` core implementation. Cross-orchestrator delivery to
 * the target's current lead. Validation order is deliberate: size first
 * (cheap), then self-target rejection, then orchestrator lookup, then a
 * re-read of the target's lead immediately before push to close the
 * lead-flip race (the lead could exit between `spawner.get()` and the
 * mailbox push).
 *
 * Permission (sender must be a lead) is enforced upstream by the MCP tool
 * via `requireLead`, so this helper does not re-check it.
 */
export function sendMessageToLead(
  spawner: Spawner,
  sourceOrch: Orchestrator,
  sourceSid: string,
  toOrchId: string,
  content: string,
  defaults: MessagingDefaults,
): CrossSendOutcome {
  const sizeCheck = validateMessageSize(content, defaults.maxMessageSizeBytes);
  if (!sizeCheck.ok) {
    throw new MessageError(
      'MESSAGE_TOO_LARGE',
      `message too large: ${sizeCheck.bytes} bytes > ${sizeCheck.max}`,
      413,
    );
  }
  if (!toOrchId || typeof toOrchId !== 'string') {
    throw new MessageError('INVALID_RECIPIENT', 'orchestrator_id required', 400);
  }
  if (toOrchId === sourceOrch.id) {
    throw new MessageError(
      'INVALID_RECIPIENT',
      'cannot use swarm.send_to_lead to message your own team; use team.send_message',
      400,
    );
  }

  const targetOrch = spawner.get(toOrchId);
  if (!targetOrch) {
    throw new MessageError('ORCH_UNKNOWN', `orchestrator ${toOrchId} does not exist`, 404);
  }
  if (
    targetOrch.status === 'stopped' ||
    targetOrch.status === 'failed' ||
    targetOrch.status === 'stopping'
  ) {
    throw new MessageError(
      'ORCH_NOT_ACTIVE',
      `orchestrator ${toOrchId} is not active (status=${targetOrch.status})`,
      404,
    );
  }

  // Re-read the lead immediately before the push to close the lead-flip race.
  const targetLead = targetOrch.lead;
  if (!targetLead || !isActive(targetLead)) {
    throw new MessageError(
      'RECIPIENT_NOT_ACTIVE',
      `lead of orchestrator ${toOrchId} is not active`,
      404,
    );
  }

  const sourceLead = sourceOrch.lead;
  const result = targetOrch.mailbox.push(targetLead.id, {
    from: sourceSid,
    content,
    fromOrchestratorId: sourceOrch.id,
    fromOrchestratorName: sourceOrch.name,
    fromSessionName: sourceLead?.name ?? sourceSid,
  });
  // Cross-team event: `orchestratorId` = destination, `fromOrchestratorId`
  // = source — gives the MapView enough to draw an inter-team arrow.
  emitMailboxMessage(targetOrch.id, sourceSid, targetLead.id, sourceOrch.id);

  log.info({
    event: 'mail.cross_send',
    fromOrch: sourceOrch.id,
    toOrch: toOrchId,
    fromSid: sourceSid,
    toSid: targetLead.id,
    len: sizeCheck.bytes,
    queueSize: result.queueSize,
    dropped: result.dropped,
  });

  let signalled = false;
  if (isIdle(targetLead, Date.now(), defaults.idleThresholdMs)) {
    signalled = injectSignal(targetLead);
  }

  return {
    delivered: true,
    dropped: result.dropped,
    queueSize: result.queueSize,
    signalled,
    to_session_id: targetLead.id,
    to_orchestrator_id: toOrchId,
  };
}

/**
 * `swarm.broadcast_to_leads` core implementation. Iterates every active
 * orchestrator other than the sender's, delivering to each one's current
 * lead. Best-effort: per-recipient failures (lead just exited, signal write
 * error) are logged but do not abort the rest of the broadcast.
 */
export function broadcastToLeads(
  spawner: Spawner,
  sourceOrch: Orchestrator,
  sourceSid: string,
  content: string,
  defaults: MessagingDefaults,
): CrossBroadcastOutcome {
  const sizeCheck = validateMessageSize(content, defaults.maxMessageSizeBytes);
  if (!sizeCheck.ok) {
    throw new MessageError(
      'MESSAGE_TOO_LARGE',
      `message too large: ${sizeCheck.bytes} bytes > ${sizeCheck.max}`,
      413,
    );
  }

  const delivered: Array<{ orchestrator_id: string; session_id: string }> = [];
  const now = Date.now();
  const sourceLead = sourceOrch.lead;

  for (const orch of spawner.listActive()) {
    if (orch.id === sourceOrch.id) continue;
    const lead = orch.lead;
    if (!lead || !isActive(lead)) continue;
    orch.mailbox.push(lead.id, {
      from: sourceSid,
      content,
      fromOrchestratorId: sourceOrch.id,
      fromOrchestratorName: sourceOrch.name,
      fromSessionName: sourceLead?.name ?? sourceSid,
    });
    // N events, one per destination — `orchestratorId` differs each iter.
    emitMailboxMessage(orch.id, sourceSid, lead.id, sourceOrch.id);
    if (isIdle(lead, now, defaults.idleThresholdMs)) {
      injectSignal(lead);
    }
    delivered.push({ orchestrator_id: orch.id, session_id: lead.id });
  }

  log.info({
    event: 'mail.cross_broadcast',
    fromOrch: sourceOrch.id,
    fromSid: sourceSid,
    deliveredCount: delivered.length,
    len: sizeCheck.bytes,
  });

  return { delivered_to: delivered };
}

/**
 * External-origin push to ONE orchestrator's current lead (bridges + plugins).
 *
 * Unlike `sendMessageToLead`, this helper has NO source orchestrator/session
 * context — `from` is a free-form label such as `'plugin:<name>'` or
 * `'discord:<user>'`. It borrows the exact Discord-bridge path: `mailbox.push`
 * + `emitMailboxMessage` + idle wake. Used by the plugin `messaging.sendToLead`
 * façade (plan §J2) and by the host's tool-set-change notification.
 *
 * Throws `MessageError` on oversize content or when the lead is not active.
 */
export function pushToLeadInbox(
  orch: Orchestrator,
  from: string,
  content: string,
  defaults: MessagingDefaults,
  meta?: {
    sourceKind?: string;
    sourceMessageId?: string;
    threadId?: string;
    threadName?: string;
  },
): CrossSendOutcome {
  const sizeCheck = validateMessageSize(content, defaults.maxMessageSizeBytes);
  if (!sizeCheck.ok) {
    throw new MessageError(
      'MESSAGE_TOO_LARGE',
      `message too large: ${sizeCheck.bytes} bytes > ${sizeCheck.max}`,
      413,
    );
  }
  const lead = orch.lead;
  if (!lead || !isActive(lead)) {
    throw new MessageError(
      'RECIPIENT_NOT_ACTIVE',
      `lead of orchestrator ${orch.id} is not active`,
      404,
    );
  }
  const result = orch.mailbox.push(lead.id, { from, content, ...(meta ?? {}) });
  emitMailboxMessage(orch.id, from, lead.id);

  log.info({
    event: 'mail.external_send',
    orch: orch.id,
    from,
    toSid: lead.id,
    len: sizeCheck.bytes,
    queueSize: result.queueSize,
    dropped: result.dropped,
  });

  let signalled = false;
  if (isIdle(lead, Date.now(), defaults.idleThresholdMs)) {
    signalled = injectSignal(lead);
  }

  return {
    delivered: true,
    dropped: result.dropped,
    queueSize: result.queueSize,
    signalled,
    to_session_id: lead.id,
    to_orchestrator_id: orch.id,
  };
}

/**
 * External-origin broadcast to EVERY active orchestrator's lead (plugins).
 *
 * Best-effort, mirroring `broadcastToLeads` but with a free-form `from` label
 * and no source-orch exclusion (a plugin belongs to no team). Per-recipient
 * failures are swallowed. Used by the plugin `messaging.broadcastToLeads`
 * façade and the host's tool-set-change notification.
 */
export function broadcastToLeadsFromExternal(
  spawner: Spawner,
  from: string,
  content: string,
  defaults: MessagingDefaults,
): CrossBroadcastOutcome {
  const sizeCheck = validateMessageSize(content, defaults.maxMessageSizeBytes);
  if (!sizeCheck.ok) {
    throw new MessageError(
      'MESSAGE_TOO_LARGE',
      `message too large: ${sizeCheck.bytes} bytes > ${sizeCheck.max}`,
      413,
    );
  }

  const delivered: Array<{ orchestrator_id: string; session_id: string }> = [];
  const now = Date.now();
  for (const orch of spawner.listActive()) {
    const lead = orch.lead;
    if (!lead || !isActive(lead)) continue;
    try {
      orch.mailbox.push(lead.id, { from, content });
      emitMailboxMessage(orch.id, from, lead.id);
      if (isIdle(lead, now, defaults.idleThresholdMs)) injectSignal(lead);
      delivered.push({ orchestrator_id: orch.id, session_id: lead.id });
    } catch (err) {
      log.warn({
        event: 'mail.external_broadcast_skip',
        orch: orch.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info({
    event: 'mail.external_broadcast',
    from,
    deliveredCount: delivered.length,
    len: sizeCheck.bytes,
  });

  return { delivered_to: delivered };
}

/**
 * Convenience wrapper that callers (REST handler, orchestrator) use to read
 * a session's inbox and emit the canonical log. Mirrors `team.read_inbox`.
 */
export function readInbox(deps: MessagingDeps, sid: string): Message[] {
  const msgs = deps.mailbox.read(sid);
  // Monitoring — mirror the drain onto the Session. The mailbox counter is
  // in-memory and invisible to `toView()`, which is what persistence and
  // `GET /sessions/:id` are built from; this is the one place both the
  // session id and the message count are known at the moment of the drain.
  // A no-op when the drain was empty or the session is already gone.
  if (msgs.length > 0) {
    deps.orchestrator.getSession(sid)?.recordMessagesProcessed(msgs.length);
  }
  log.info({
    event: 'mail.read',
    sid,
    count: msgs.length,
  });
  return msgs;
}
