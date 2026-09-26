import { EventEmitter } from 'node:events';
// Type-only (erased at runtime): `modules/features/registry` imports the value
// `SwarmEventBus` from HERE, so this arrow must never carry a runtime edge or
// the two would form an import cycle. TS handles the type-level cycle fine.
import type { FeatureName, FeatureState } from './modules/features/registry.js';

/**
 * Core event kinds emitted by the server itself. `plugin.host.changed` is a
 * built-in surfaced when a plugin's enable/status changes — its minimal
 * payload `{ name, status, enabled }` lets the UI patch a row without a refetch.
 * `feature.changed` is the same idea for the six built-in features: its payload
 * `{ name, state }` lets the web patch its feature map without a refetch.
 */
export type BuiltinSwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited'
  | 'mailbox.message'
  | 'plugin.host.changed'
  | 'feature.changed';

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
 * Cost-budget event kind (docs/monitoring-agents.md, Lot 14). Emitted by the
 * budget janitor (modules/orchestrator/budget-watch) via the event bus and
 * rebroadcast on `/ws/events` so the web raises an actionable toast without a
 * refetch. Per-team: the `orchestratorId` on the `SwarmEvent` is the team that
 * crossed its budget.
 *
 * ONE-SHOT per crossing: the janitor keeps in-memory state and re-arms only if
 * the team falls back UNDER its budget (i.e. the operator raised it). The web
 * relies on that — its toast has no auto-dismiss, because a second frame is
 * never coming.
 *
 * Named `session.*` rather than `team.*` for one reason: it is the wire name the
 * shipped web half already listens for.
 */
export type BudgetSwarmEventKind = 'session.budget_exceeded';

/**
 * Auto-compact event kind (docs/auto-compact.md, D8). Emitted by
 * `Orchestrator._onSessionIdle` at the exact moment a `/compact` is ARMED for
 * an agent whose context crossed its role's threshold while it sat idle with an
 * empty inbox — never when the command actually reaches the PTY, which happens
 * at the following idle boundary and is already visible through
 * `contextResetPending`.
 *
 * Deliberately NOT wired to a toast in the web (docs/auto-compact.md §6): on a
 * 24/7 fleet every agent crosses its threshold several times a day, and a toast
 * per crossing is noise about something the operator asked the server to do.
 * The frame exists so a dashboard or a plugin can COUNT compactions; the badge
 * already covers the UI.
 */
export type AutoCompactSwarmEventKind = 'session.auto_compact' | 'session.post_compact_nudge';

/**
 * Code-graph (Graphify integration) event kinds. Emitted by `GraphStore` via the
 * event bus and rebroadcast on `/ws/events` so the web code-graph page (P4) can
 * patch a scope row without a refetch. GLOBAL to the deployment (like memory) —
 * no per-team `orchestratorId`. Added to the open union below — additive,
 * non-breaking.
 */
export type CodegraphSwarmEventKind =
  | 'code.graph.indexed'
  | 'code.graph.scope_enabled'
  | 'code.graph.scope_disabled';

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
  | CodegraphSwarmEventKind
  | BudgetSwarmEventKind
  | AutoCompactSwarmEventKind
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
 * Payload of the `code.graph.*` events. `scopeId` is always present; `kind`
 * (project|plugin) and the counts are present when known (indexed / enabled).
 */
export interface CodegraphEventPayload {
  scopeId: string;
  kind?: string;
  nodeCount?: number;
  edgeCount?: number;
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

/**
 * Payload of `session.budget_exceeded` (Lot 14).
 *
 * `costUsd` is the team's CUMULATIVE spend as the Lot 12 aggregate reports it —
 * removed/reaped workers included, and a LOWER BOUND (a model with no published
 * rate contributes 0, never a guess). `budgetUsd` is the role's ceiling at the
 * moment of the crossing, `action` what the server did about it.
 *
 * Every field is a convenience for the toast, none is load-bearing: the web
 * reads them defensively and renders the notice regardless, because the frame
 * itself is the news.
 */
export interface BudgetExceededPayload {
  /** The team's display name — the toast has no other way to name it. */
  teamName: string;
  costUsd: number;
  budgetUsd: number;
  action: 'notify' | 'pause';
}

/**
 * Payload of `session.auto_compact` (docs/auto-compact.md, D8).
 *
 * `pct` is the occupancy that triggered the arming, as an INTEGER percentage
 * (0..100) — the same rounding the decision itself used, so a consumer can
 * never see a frame whose figures fail the `pct >= thresholdPct` test that
 * produced it. `thresholdPct` is the value in force for that agent's role at
 * that instant (roles are read live, so two frames seconds apart may legitimately
 * carry different thresholds).
 */
export interface AutoCompactEventPayload {
  pct: number;
  thresholdPct: number;
}

/**
 * Payload of `session.post_compact_nudge` (docs/auto-compact.md §8.1, D9) —
 * emitted when the "resume" line was actually typed into an agent's PTY at the
 * end of a server-fired `/compact`. Same no-toast policy as
 * `session.auto_compact`: it exists so a dashboard or a plugin can count them.
 *
 * `inboxCount` is the queue length at that boundary; `inboxSignalled` says
 * whether the inbox signal was folded into the same line (it is owed right
 * after a reset whenever the queue is non-empty).
 */
export interface PostCompactNudgeEventPayload {
  inboxCount: number;
  inboxSignalled: boolean;
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
 * Payload of the built-in `feature.changed` event. Emitted by `FeatureRegistry`
 * on every enable/disable/uninstall so the web can patch its feature map (and
 * flush the approvals/budget toast stacks) without a refetch (D10).
 */
export interface FeatureChangedPayload {
  name: FeatureName;
  state: FeatureState;
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
