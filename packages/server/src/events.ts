import { EventEmitter } from 'node:events';

/**
 * Core event kinds emitted by the server itself. `plugin.host.changed` is a
 * built-in surfaced when a plugin's enable/status changes — its minimal
 * payload `{ name, status, enabled }` lets the UI patch a row without a refetch.
 */
export type BuiltinSwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited'
  | 'mailbox.message'
  | 'plugin.host.changed';

/**
 * Shared-memory (knowledge graph) event kinds. Emitted by `MemoryStore` via the
 * event bus and rebroadcast on `/ws/events` so the web Memory page can patch its
 * graph without a refetch. Added to the open union below — additive, non-breaking.
 */
export type MemorySwarmEventKind =
  | 'memory.node_created'
  | 'memory.node_updated'
  | 'memory.node_deleted'
  | 'memory.edge_created';

/**
 * Task-board (Kanban) event kinds. Emitted by `TaskboardStore` via the event bus
 * and rebroadcast on `/ws/events` so the web Board page can patch a column
 * without a refetch. Per-team: each event carries the recipient team's
 * `orchestratorId` on the `SwarmEvent` (and in its payload) for client filtering.
 * Added to the open union below — additive, non-breaking.
 */
export type TaskboardSwarmEventKind =
  | 'taskboard.card_created'
  | 'taskboard.card_updated'
  | 'taskboard.card_moved'
  | 'taskboard.card_assigned'
  | 'taskboard.comment_added'
  | 'taskboard.dep_changed'
  | 'taskboard.card_closed'
  | 'taskboard.card_reopened'
  | 'taskboard.card_deleted'
  | 'taskboard.card_orphaned';

/**
 * Approval-gate (human-in-the-loop) event kinds. Emitted by `ApprovalStore` via
 * the event bus and rebroadcast on `/ws/events` so the web can surface an
 * actionable approval toast (P3) without a refetch. Per-team: each event carries
 * the recipient team's `orchestratorId` (and `sessionId`) on the `SwarmEvent`
 * for client filtering. Added to the open union below — additive, non-breaking.
 */
export type ApprovalSwarmEventKind = 'approval.requested' | 'approval.resolved';

/**
 * Open union: plugins emit `plugin.<name>.<subKind>` via `api.events.emit`
 * (the host forces the prefix, so a plugin can never forge a core kind). The
 * `EventsHub` rebroadcasts everything unfiltered and the web client matches
 * kinds with independent `if`s, so unknown kinds are ignored gracefully.
 */
export type SwarmEventKind =
  | BuiltinSwarmEventKind
  | MemorySwarmEventKind
  | TaskboardSwarmEventKind
  | ApprovalSwarmEventKind
  | `plugin.${string}`;

/** Payload of `memory.node_created` / `memory.node_updated` / `memory.node_deleted`. */
export interface MemoryNodeEventPayload {
  name: string;
  type: string;
}

/** Payload of `memory.edge_created`. */
export interface MemoryEdgeEventPayload {
  from: string;
  to: string;
}

/**
 * Payload of `approval.requested` / `approval.resolved`. `orchestratorId` and
 * `sessionId` are duplicated here (they also ride the top-level `SwarmEvent`)
 * for client autosufficiency. `requestedSummary` is the short human-facing
 * label; `status` reflects the request AFTER the event (pending on request,
 * terminal on resolve). `decision` / `resolvedBy` are present only on resolve.
 */
export interface ApprovalEventPayload {
  approvalId: string;
  orchestratorId: string;
  sessionId: string;
  category: 'permission' | 'question';
  requestedSummary: string;
  status: string;
  decision?: string | null;
  by?: string | null;
}

export interface SwarmEvent {
  kind: SwarmEventKind;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  payload?: unknown;
}

/** Payload of the built-in `plugin.host.changed` event. */
export interface PluginHostChangedPayload {
  name: string;
  status: string;
  enabled: boolean;
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

export class SwarmEventBus extends EventEmitter {
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
