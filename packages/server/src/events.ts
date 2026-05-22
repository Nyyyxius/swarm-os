import { EventEmitter } from 'node:events';

export type SwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited'
  | 'mailbox.message';

export interface SwarmEvent {
  kind: SwarmEventKind;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  payload?: unknown;
}

/**
 * Payload shape for the `mailbox.message` event (update_system S2).
 *
 * Emitted on every effective delivery of a message — i.e. once the
 * `mailbox.push` is committed:
 *   - `team.send_message` (intra-team 1:1)
 *   - `team.broadcast` (intra-team 1:N — a SINGLE event with `to:'broadcast'`)
 *   - `swarm.send_to_lead` (cross-team 1:1)
 *   - `swarm.broadcast_to_leads` (cross-team — one event PER target lead,
 *     because `orchestratorId` differs)
 *   - `Orchestrator._onWorkerExit` synthetic system → lead notification
 *
 * Conventions:
 *   - `orchestratorId` (both top-level on `SwarmEvent` AND duplicated in this
 *     payload for autosufficiency) is ALWAYS the orchestrator of the
 *     *recipient*. For cross-team sends, the sender's orchestrator id is
 *     surfaced via the optional `fromOrchestratorId` field so the UI can
 *     draw an inter-team arrow.
 *   - `from` is a session id, the literal `'human'` (REST broadcast) or
 *     `'system'` (synthetic worker-exit notice).
 *   - `to` is a session id OR the literal `'broadcast'` for the intra-team
 *     broadcast case (the UI is expected to fan it out client-side from the
 *     orchestrator's session list).
 */
export interface MailboxMessagePayload {
  from: string;
  to: string | 'broadcast';
  orchestratorId: string;
  /** Source orchestrator id — present only on cross-team events. */
  fromOrchestratorId?: string;
}

class SwarmEventBus extends EventEmitter {
  emitEvent(ev: Omit<SwarmEvent, 'ts'>): void {
    const full: SwarmEvent = { ...ev, ts: new Date().toISOString() };
    this.emit('event', full);
  }

  onEvent(cb: (ev: SwarmEvent) => void): () => void {
    this.on('event', cb);
    return () => this.off('event', cb);
  }
}

export const eventBus = new SwarmEventBus();
// Allow many WS subscribers without spurious warnings.
eventBus.setMaxListeners(100);
