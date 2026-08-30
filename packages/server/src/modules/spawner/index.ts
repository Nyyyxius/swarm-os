import { randomUUID } from 'node:crypto';
import {
  Orchestrator,
  WorkerCapError,
  type OrchestratorInit,
  type OrchestratorStatus,
  type StartOptions,
} from '../orchestrator/index.js';
import type { PluginToolSummary } from '../orchestrator/preamble.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import type { Session } from '../orchestrator/session.js';
import type { Notifier } from '../notify/index.js';
import { DiscordWebhookNotifier } from '../notify/discord.js';
import type { Persistence, ResumableState } from '../orchestrator/persistence.js';
import { NoOpNotifier } from '../notify/null.js';
import { NoOpPersistence } from '../orchestrator/persistence.js';
import type { RoleStore, Role, Connector } from '../roles/index.js';
import { connectorConfig, isDiscordConnector } from '../roles/index.js';
import type { SessionRow } from '../db/index.js';
import type { DiscordBotPool } from '../discord/pool.js';
import type { ConnectorRegistry } from '../plugins/connector-registry.js';
import { createBuiltinProviderRegistry } from '../providers/index.js';
import type { ModelCatalogue } from '../providers/catalogue.js';
import { ProviderAvailabilityCache } from '../providers/availability.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { PluginOrchSubscription } from '../plugins/api-types.js';
import type { MemoryStore } from '../memory/store.js';
import type { TaskboardStore } from '../taskboard/store.js';
import type { GraphStore } from '../codegraph/store.js';
import type { ApprovalStore } from '../approvals/store.js';
import type { SkillsSubsystem } from '../skills/index.js';
import type { SkillFragment } from '../orchestrator/preamble.js';
import { buildApprovalReplyResolver } from '../approvals/reply.js';
import { buildApprovalReactionResolver } from '../approvals/reaction.js';
import {
  isIdle,
  SIGNAL_TEXT,
  pushToLeadInbox,
  emitMailboxMessage,
} from '../orchestrator/messaging.js';

const log = withModule('spawner');

export type { OrchestratorInit, StartOptions };

export class SpawnerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'SpawnerError';
  }
}

export interface SpawnerCreateResult {
  orchestrator: Orchestrator;
  lead: Session;
}

/**
 * update_system D.5 — one team's handle on a `warnLeads()` round. Keep it
 * (in memory, or in the update run) for the whole warning window: the
 * `notice_id` is what makes the read receipt observable.
 */
export interface LeadWarning {
  orch_id: string;
  orch_name: string;
  lead_id: string;
  /** Pre-minted mailbox message id — the read receipt handle. */
  notice_id: string;
  /** The mailbox row was queued. */
  queued: boolean;
  /** The PTY notice was armed (false ⇒ paused / terminal / no PTY). */
  armed: boolean;
}

/**
 * Delivery state of one warned lead, per plan D.5:
 *  - `read`          — an agent drained the inbox containing our notice.
 *  - `queued_unread` — the PTY signal landed, the message is still queued.
 *  - `never_idle`    — nothing reached the agent: the lead never offered an
 *                      idle boundary before the deadline (or had no PTY).
 */
export type LeadNoticeState = 'read' | 'queued_unread' | 'never_idle';

export interface LeadWarningStatus extends LeadWarning {
  /** The notice text was actually written into the lead's PTY. */
  signalled: boolean;
  /** An agent drained the inbox that held our notice id. */
  read: boolean;
  state: LeadNoticeState;
}

/**
 * The single definition of the `LeadNoticeState` trichotomy.
 *
 * Exported on purpose: this rule used to be a one-liner inside
 * `leadNoticeStatus`, and every fake spawner re-typed it verbatim. A copy
 * cannot fail — two independent changes to the real rule left the
 * `updates/teams-port` suite fully green while it asserted the OLD rule. Any
 * test double must call this instead of restating it, so that changing the
 * rule here changes what the doubles produce.
 *
 * Precedence is deliberate: an observed consumption outranks the PTY signal
 * (an agent that read the inbox was reached, whether or not the injector also
 * got a word in), and "nothing reached the agent" is the fallback — the
 * honest verdict whenever we have no positive evidence at all.
 */
export function deriveLeadNoticeState(o: { read: boolean; signalled: boolean }): LeadNoticeState {
  return o.read ? 'read' : o.signalled ? 'queued_unread' : 'never_idle';
}

/** update_system D.6 — a team that was alive before a destructive action. */
export interface TeamSnapshotEntry {
  orch_id: string;
  orch_name: string;
  lead_id: string | null;
}

export type TeamReconcileReason = 'ok' | 'absent' | 'not_running' | 'no_lead' | 'lead_dead';

export interface TeamReconcileEntry extends TeamSnapshotEntry {
  /** Live, non-terminal, with a live lead. */
  back: boolean;
  /** Orchestrator status now (null when it isn't in the live map at all). */
  status: OrchestratorStatus | null;
  /** Lead id now — differs from `lead_id` after a fresh restart-in-place. */
  lead_id_now: string | null;
  reason: TeamReconcileReason;
}

export interface TeamReconciliation {
  teams: TeamReconcileEntry[];
  back: number;
  missing: number;
}

/**
 * Optional dependencies the Spawner uses. Both default to no-op variants so
 * Phase 1/2/3 tests don't have to wire them — production `index.ts` always
 * passes a real notifier + persistence after Phase 4.
 */
export interface SpawnerDeps {
  notifier?: Notifier;
  persistence?: Persistence;
  /**
   * Optional — when present the spawner looks up the role attached to the
   * orchestrator init (if any) to (a) build a per-role notifier that wins
   * over the global one when a Discord webhook is set on the role, and
   * (b) spawn the role's initial workers right after the lead is up.
   */
  roleStore?: RoleStore;
  /**
   * Optional Discord bot pool. Retained for the OUTBOUND path
   * (`discord.send_message` routes via `botForOrch`). Inbound wiring now flows
   * through the `connectorRegistry` (the built-in `discord` provider wraps this
   * same pool). The pool starts a bot per distinct token, lazily.
   */
  discordBotPool?: DiscordBotPool;
  /**
   * Optional connector registry (J4). When set, every role connector whose type
   * has a registered provider is subscribed at create/resume time and detached
   * at destroy/hide/restart. A provider registered LATE (a plugin enabled while
   * teams run) retro-wires the matching live orchestrators. Absent in unit tests
   * that don't exercise connectors.
   */
  connectorRegistry?: ConnectorRegistry;
  /**
   * Agent-provider adapters. Defaults to the built-in registry constructed
   * from `config` (which is what carries the per-provider host state dirs).
   * Overridable so a test can drive a `FakeProvider` end to end.
   */
  providerRegistry?: ProviderRegistry;
  /**
   * Live model catalogue, already bound to the adapters by `src/index.ts`.
   *
   * Carried here ONLY so `GET /providers` can await its cold resolve alongside
   * the availability probes — the adapters reach it directly. Absent by default,
   * which is what keeps every test hermetic: no test stack passes one, so no
   * test ever touches models.dev, and the tests that pin model ids keep passing
   * against the pinned constants without knowing this feature exists.
   */
  modelCatalogue?: ModelCatalogue;
  /**
   * Snapshot source for the plugin-tools section of every preamble. Forwarded
   * verbatim to each `Orchestrator`; see `OrchestratorDeps.pluginTools` for why
   * it is a thunk. Absent in unit tests ⇒ no plugin section.
   */
  pluginTools?: () => readonly PluginToolSummary[];
  /**
   * The shared knowledge-graph store, GLOBAL to the deployment. Held on the
   * Spawner because it is the one long-lived object every surface (MCP tools via
   * `ToolContext`, REST) already reaches. Absent in unit tests that don't
   * exercise memory ⇒ the memory MCP tools answer `MEMORY_UNAVAILABLE`.
   */
  memory?: MemoryStore;
  /**
   * The durable task-board store, scoped per team. Held on the Spawner like
   * `memory` (the one long-lived object every surface reaches). Absent in unit
   * tests that don't exercise the board ⇒ the `board.*` tools answer
   * `TASKBOARD_UNAVAILABLE`.
   */
  taskboard?: TaskboardStore;
  /**
   * The code-knowledge-graph store (Graphify integration). Held on the Spawner
   * like `memory` so the MCP `codegraph.*` tools reach it via `ToolContext`.
   * Absent in unit tests that don't exercise codegraph ⇒ the tools answer
   * `CODEGRAPH_UNAVAILABLE`.
   */
  graph?: GraphStore;
  /**
   * The human-in-the-loop approval queue (docs/garde-fous-approbation.md). Held
   * on the Spawner so the Discord connector wiring can attach a P4 reply-router
   * to each orch's subscription. Absent ⇒ no reply routing (approvals still work
   * via the web/REST path).
   */
  approvals?: ApprovalStore;
  /**
   * The skills subsystem (docs/plan-skills-importables.md). Held on the Spawner
   * like `taskboard`: `spawner.skills` feeds the MCP `skills.*` tools and the
   * per-spawn preamble resolver. Absent ⇒ `skills.*` answer SKILLS_UNAVAILABLE
   * and no skill is injected.
   */
  skills?: SkillsSubsystem;
}

export class Spawner {
  private readonly orchestrators = new Map<string, Orchestrator>();
  private readonly pluginTools: (() => readonly PluginToolSummary[]) | null;
  /**
   * update_system D.5 — bookkeeping for the current `warnLeads()` round, keyed
   * by notice id. Carries (a) the text/sender so `leadNoticeStatus` can
   * re-push a notice that inbox pressure evicted, and (b) `readBaseline`, the
   * lead's `mailbox.readCount()` at the instant we queued the notice — the
   * reference point that turns "an agent drained this inbox" into an
   * observation instead of an inference.
   *
   * Cleared (and thus bounded to one round) at the start of every `warnLeads`
   * call; purely in-memory, exactly like the mailbox it mirrors — the warning
   * window never outlives the process. A handle with no entry here therefore
   * can never be credited with a read, which is the fail-closed direction.
   */
  private readonly _leadNotices = new Map<
    string,
    { text: string; from: string; readBaseline: number }
  >();
  readonly notifier: Notifier;
  readonly persistence: Persistence;
  readonly roleStore: RoleStore | null;
  readonly discordBotPool: DiscordBotPool | null;
  readonly connectorRegistry: ConnectorRegistry | null;
  /**
   * The adapter table every orchestrator resolves ids against. Lives on the
   * Spawner because it is the one long-lived object every surface already has
   * a handle on (HTTP routers, MCP tools, the orchestrators themselves).
   */
  readonly providerRegistry: ProviderRegistry;
  /**
   * Availability verdicts, TTL-cached. Shared by `GET /providers` and the 409
   * gate in `POST /orchestrators` so both see ONE set of probes — two caches
   * would double the SSH round-trips and could disagree with each other.
   */
  readonly providerAvailability: ProviderAvailabilityCache;

  /**
   * The live model catalogue, or `null` when none was wired (every test, and any
   * deployment running with the kill switch). Read by `GET /providers` only.
   */
  readonly modelCatalogue: ModelCatalogue | null;

  /**
   * The shared knowledge-graph store (docs/memoire-partagee.md), or `null` when
   * none was wired. Threaded into every `ToolContext` by `McpServer`.
   */
  readonly memory: MemoryStore | null;
  readonly approvals: ApprovalStore | null;

  /**
   * The code-knowledge-graph store (Graphify integration), or `null` when none
   * was wired. Threaded into every `ToolContext` by `McpServer`.
   */
  readonly graph: GraphStore | null;

  /**
   * The durable task-board store (docs/tableau-de-taches.md), or `null` when
   * none was wired. Threaded into every `ToolContext` by `McpServer`.
   */
  readonly taskboard: TaskboardStore | null;

  /**
   * The skills subsystem (docs/plan-skills-importables.md), or `null` when none
   * was wired. Reached by the MCP `skills.*` tools via `ToolContext` and by the
   * per-spawn preamble resolver.
   */
  readonly skills: SkillsSubsystem | null;

  constructor(
    private readonly config: Config,
    deps: SpawnerDeps = {},
  ) {
    this.notifier = deps.notifier ?? new NoOpNotifier();
    this.persistence = deps.persistence ?? new NoOpPersistence();
    this.roleStore = deps.roleStore ?? null;
    this.discordBotPool = deps.discordBotPool ?? null;
    this.connectorRegistry = deps.connectorRegistry ?? null;
    this.providerRegistry = deps.providerRegistry ?? createBuiltinProviderRegistry(config);
    this.pluginTools = deps.pluginTools ?? null;
    this.providerAvailability = new ProviderAvailabilityCache({
      registry: this.providerRegistry,
      config,
    });
    this.modelCatalogue = deps.modelCatalogue ?? null;
    this.memory = deps.memory ?? null;
    this.taskboard = deps.taskboard ?? null;
    this.skills = deps.skills ?? null;
    this.graph = deps.graph ?? null;
    this.approvals = deps.approvals ?? null;
    // Retro-wire live orchestrators when a connector provider registers late
    // (a plugin enabled while teams are already running — red-team I1).
    this.connectorRegistry?.setRetroactiveWirer((type) => this.retroWireConnectorType(type));
  }

  /**
   * Subscribe an orchestrator to every connector its role carries whose type
   * has a registered provider (J4 — generalisation of the old `wireDiscordBot`).
   * Fire-and-forget: a provider's `subscribeOrch` may lazily open a network
   * connection (a few seconds for Discord's Gateway), so `create()` stays
   * synchronous and the orch serves traffic while the connector wires up.
   */
  private wireConnectors(orch: Orchestrator, role: Role | null): void {
    if (!this.connectorRegistry || !role) return;
    for (const connector of role.connectors) {
      this.subscribeConnector(orch, connector);
    }
  }

  /**
   * Subscribe ONE connector. Builds the provider-agnostic
   * `PluginOrchSubscription` (the inbound bridge: `pushToLeadInbox` reuses
   * `mailbox.push` + `emitMailboxMessage` + idle wake; `notifyLead` wakes the
   * lead PTY on demand) and hands it to the type's provider. Skips silently when
   * no provider is registered for the type.
   */
  private subscribeConnector(orch: Orchestrator, connector: Connector): void {
    const provider = this.connectorRegistry?.get(connector.type);
    if (!provider) return;
    const sub: PluginOrchSubscription = {
      orchestratorId: orch.id,
      getLeadSessionId: () => orch.leadSessionId,
      pushToLeadInbox: (content, meta) => {
        try {
          pushToLeadInbox(
            orch,
            meta?.from ?? `connector:${connector.type}`,
            content,
            {
              maxMessageSizeBytes: this.config.maxMessageSizeBytes,
              idleThresholdMs: this.config.idleThresholdMs,
            },
            {
              sourceKind: meta?.sourceKind,
              sourceMessageId: meta?.sourceMessageId,
              threadId: meta?.threadId,
              threadName: meta?.threadName,
            },
          );
        } catch (err) {
          // Inbound delivery to a dead/oversize lead must never crash the
          // connector — log and drop (24/7 safety).
          log.warn({
            event: 'spawner.connector_push_failed',
            orchId: orch.id,
            type: connector.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      notifyLead: () => {
        const leadId = orch.leadSessionId;
        if (!leadId) return;
        const lead = orch.getSession(leadId);
        if (!lead) return;
        if (!isIdle(lead, Date.now(), this.config.idleThresholdMs)) return;
        lead.notifySignal(SIGNAL_TEXT);
      },
      // P4: when the approval store is wired, attach a reply-router so a native
      // Discord reply on this orch's channel resolves the matching pending
      // approval (via the shared core) instead of landing in the lead inbox.
      ...(this.approvals
        ? {
            tryConsumeApprovalReply: buildApprovalReplyResolver({
              spawner: this,
              store: this.approvals,
              orchestratorId: orch.id,
            }),
            // P5: sibling resolver for ✅/♾️/❌ reactions on the approval card.
            tryConsumeApprovalReaction: buildApprovalReactionResolver({
              spawner: this,
              store: this.approvals,
              orchestratorId: orch.id,
            }),
          }
        : {}),
    };
    void Promise.resolve()
      .then(() => provider.subscribeOrch(connectorConfig(connector), sub))
      .catch((err: unknown) => {
        log.warn({
          event: 'spawner.connector_subscribe_failed',
          orchId: orch.id,
          type: connector.type,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * Wire every already-live orchestrator whose role carries `type` (red-team
   * I1). Called by the `ConnectorRegistry` when a provider registers late.
   */
  private retroWireConnectorType(type: string): void {
    if (!this.roleStore) return;
    for (const orch of this.listActive()) {
      if (orch.status !== 'running') continue;
      const roleId = orch.roleId;
      if (!roleId) continue;
      const role = this.roleStore.get(roleId);
      const connector = role?.connectors.find((c) => c.type === type);
      if (!connector) continue;
      this.subscribeConnector(orch, connector);
      log.info({ event: 'spawner.connector_retro_wired', orchId: orch.id, type });
    }
  }

  /**
   * Detach an orchestrator from every connector provider (destroy / hide /
   * restart). Routes through the connector registry when present (covers Discord
   * + plugin connectors); otherwise falls back to the raw Discord pool for the
   * back-compat path where only a pool was injected.
   */
  private unsubscribeConnectors(orchId: string): void {
    if (this.connectorRegistry) {
      void this.connectorRegistry.unsubscribeAll(orchId);
      return;
    }
    void this.discordBotPool?.unsubscribeOrch(orchId);
  }

  /**
   * Pick the notifier to attach to a new orchestrator. If the role has a
   * Discord webhook connector with a `webhookUrl`, build a dedicated
   * `DiscordWebhookNotifier` pointed at it (overriding the global one).
   * A discord connector with only `botToken`+`channelId` (no webhook) is
   * legitimate — system notifications then fall back to the spawner-level
   * notifier.
   */
  private notifierFor(role: Role | null): Notifier {
    if (!role) return this.notifier;
    const discord = role.connectors.find(isDiscordConnector);
    if (!discord || !discord.webhookUrl) return this.notifier;
    return new DiscordWebhookNotifier({
      webhookUrl: discord.webhookUrl,
      projectName: this.config.projectName,
      publicUrl: this.config.publicUrl,
    });
  }

  create(spec: OrchestratorInit, opts: StartOptions = {}): SpawnerCreateResult {
    const active = this.listActive().length;
    if (active >= this.config.maxOrchestrators) {
      throw new SpawnerError(
        `max orchestrators (${this.config.maxOrchestrators}) reached`,
        'MAX_ORCHESTRATORS',
        429,
      );
    }

    // Load the role (if any) so we can pick a notifier and know how many
    // initial workers to spawn. A missing/deleted role is non-fatal — the
    // orchestrator still gets created with the global notifier and 0
    // initial workers. The HTTP layer is responsible for validating roleId
    // upfront, so by this point the only reason for a missing role would
    // be a race with deletion or a programmatic caller passing junk.
    let role: Role | null = null;
    if (spec.roleId && this.roleStore) {
      role = this.roleStore.get(spec.roleId);
      if (!role) {
        log.warn({
          event: 'spawner.role_missing',
          roleId: spec.roleId,
          note: 'continuing with global notifier and no initial workers',
        });
      }
    }

    const effectiveNotifier = this.notifierFor(role);

    const orch = new Orchestrator(spec, this.config, {
      notifier: effectiveNotifier,
      persistence: this.persistence,
      providerRegistry: this.providerRegistry,
      // Monitoring — model context limits for the context-usage gauges.
      modelCatalogue: this.modelCatalogue,
      // KILL UI flow on the lead: when the operator clicked KILL we ask the
      // orchestrator to call us back once it reaches terminal, so we can soft
      // delete the whole team from the map in one shot.
      onHideRequested: (id) => {
        this.hideOrchestrator(id);
      },
      ...(this.pluginTools ? { pluginTools: this.pluginTools } : {}),
      ...(this.taskboard ? { taskboard: this.taskboard } : {}),
      skills: (orchestratorId, sessionId) =>
        this.resolveSkillsFor(spec.roleId ?? null, orchestratorId, sessionId),
    });
    this.orchestrators.set(orch.id, orch);
    eventBus.emitEvent({
      kind: 'orchestrator.created',
      orchestratorId: orch.id,
      payload: orch.toView(),
    });
    // Persist the orchestrator NOW (before lead spawn) so the row exists in
    // case the lead spawn itself crashes the process.
    this.persistence.writeOrchestrator(orch);
    const lead = orch.start(opts);
    // Persist the lead after `start()` mints it (and may have flipped the
    // orchestrator to `failed`).
    this.persistence.writeSession(lead, { force: true });
    this.persistence.writeOrchestrator(orch);

    // Subscribe the orch to its role's connectors (if any) as soon as the lead
    // is up. Skipped silently when no provider is registered for a type —
    // webhook notifications remain unaffected either way.
    if (orch.status === 'running') this.wireConnectors(orch, role);

    // Spawn N initial workers if the role asks for them. Lead failure is
    // non-recoverable — skip spawning workers in that case. WorkerCapError
    // stops the loop without failing the whole orchestrator creation.
    if (role && role.workerCount && role.workerCount > 0 && orch.status === 'running') {
      for (let i = 0; i < role.workerCount; i++) {
        try {
          orch.addWorker({
            name: `${orch.name}-worker-${i + 1}`,
            role: orch.role,
            prompt: '',
            // cwd / model / effort / permissionMode all default to the
            // orchestrator's defaults inside addWorker().
            skipSpawn: opts.skipSpawn,
          });
        } catch (err) {
          if (err instanceof WorkerCapError) {
            log.warn({
              event: 'spawner.initial_workers_capped',
              orchId: orch.id,
              roleId: role.id,
              requested: role.workerCount,
              spawned: i,
            });
            break;
          }
          log.warn({
            event: 'spawner.initial_worker_failed',
            orchId: orch.id,
            roleId: role.id,
            index: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { orchestrator: orch, lead };
  }

  /** Resolve the skills active for a session — the per-spawn preamble thunk. */
  private resolveSkillsFor(
    roleId: string | null,
    orchestratorId: string,
    sessionId: string,
  ): readonly SkillFragment[] {
    return this.skills ? this.skills.resolveForSession(roleId, orchestratorId, sessionId) : [];
  }

  get(id: string): Orchestrator | undefined {
    return this.orchestrators.get(id);
  }

  list(): Orchestrator[] {
    return Array.from(this.orchestrators.values());
  }

  listActive(): Orchestrator[] {
    return this.list().filter((o) => o.status !== 'stopped' && o.status !== 'failed');
  }

  /**
   * Soft-delete a terminal orchestrator. The DB row gets `hidden_at`, all
   * sessions get cascade-hidden, and the in-memory entry is dropped. Returns
   * true if the orchestrator was found AND terminal; false otherwise.
   *
   * Callers must verify terminal status (`stopped` / `failed`) before
   * calling — a still-running orchestrator can't be hidden without first
   * stopping it (its sessions are live PTYs).
   */
  hideOrchestrator(id: string): boolean {
    const orch = this.orchestrators.get(id);
    if (orch) {
      if (orch.status !== 'stopped' && orch.status !== 'failed') return false;
      this.orchestrators.delete(id);
    }
    // Drop any connector subscription so a recycled orch id with a different
    // role can't piggyback on a stale channel binding.
    this.unsubscribeConnectors(id);
    // Whether or not the in-memory row was present, flip the DB rows.
    // history-only orchestrators (server restarted, never re-added to the
    // Map) still need to be hidable.
    return this.persistence.db.hideOrchestrator(id);
  }

  /**
   * Idempotent: returns true if it was running and is now stopped, false if no-op.
   *
   * `opts.hideAfterExit` flips the orchestrator's hide-on-terminal flag so the
   * team disappears from the map as soon as the lead PTY exits — used by the
   * desktop KILL button on a lead (collapses the legacy stop-then-remove
   * two-click flow into one).
   */
  destroy(id: string, reason = 'user', opts: { hideAfterExit?: boolean } = {}): boolean {
    const orch = this.orchestrators.get(id);
    if (!orch) {
      // History-only orchestrator (server restart dropped the in-memory entry
      // but the row is still in SQLite). Honour `hideAfterExit` here too —
      // `hideOrchestrator` handles the history-row case via the DB fallback.
      if (opts.hideAfterExit) this.hideOrchestrator(id);
      return false;
    }
    if (opts.hideAfterExit) orch.setHideOnExit(true);
    if (orch.status === 'stopped' || orch.status === 'failed') {
      // Already terminal — fire the hide immediately so callers using
      // `hideAfterExit` get the expected outcome regardless of timing.
      if (opts.hideAfterExit) this.hideOrchestrator(id);
      return false;
    }
    orch.stop(reason);
    // Stop forwarding connector messages to a terminating lead.
    this.unsubscribeConnectors(id);
    eventBus.emitEvent({
      kind: 'orchestrator.destroyed',
      orchestratorId: id,
      payload: { reason },
    });
    return true;
  }

  /**
   * Process-shutdown only — tear down every orchestrator's PTYs without
   * marking the rows as 'stopping'. The DB therefore carries each orch
   * into the next boot as 'running', so `loadResumableState()` picks it
   * up via the normal auto-resume path. Operator-initiated stops go
   * through `destroy()` → `orch.stop()` and continue to land in 'stopping'.
   */
  shutdownAll(reason = 'shutdown'): void {
    for (const orch of this.orchestrators.values()) {
      try {
        orch.shutdownForRestart(reason);
      } catch (err) {
        log.error({
          event: 'orchestrator.stop_failed',
          orchId: orch.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Counters for /health. */
  counters(): {
    orchestratorsActive: number;
    sessionsActive: number;
    sessionsWaiting: number;
    /** S5 — sessions paused via SIGSTOP. Excluded from sessionsActive. */
    sessionsPaused: number;
  } {
    let sessionsActive = 0;
    let sessionsWaiting = 0;
    let sessionsPaused = 0;
    const orchestratorsActive = this.listActive().length;
    for (const orch of this.orchestrators.values()) {
      for (const s of orch.listSessions()) {
        if (s.status === 'running' || s.status === 'starting') sessionsActive++;
        if (s.status === 'waiting') sessionsWaiting++;
        if (s.status === 'paused') sessionsPaused++;
      }
    }
    return { orchestratorsActive, sessionsActive, sessionsWaiting, sessionsPaused };
  }

  /** Find a session across all orchestrators. */
  findSession(sessionId: string): { orchestrator: Orchestrator; session: Session } | null {
    for (const orch of this.orchestrators.values()) {
      const s = orch.getSession(sessionId);
      if (s) return { orchestrator: orch, session: s };
    }
    return null;
  }

  // --- update_system D.5 / D.6 — warn the leads, then survive -------------

  /**
   * Warn EVERY live team's lead that something is about to interrupt it
   * (container recreation, in practice), and give it a real chance to react.
   *
   * Why this exists instead of `broadcastToLeadsFromExternal`: that helper
   * injects the PTY wake-up only when the lead happens to be idle at that
   * exact instant, and never retries. A lead mid-turn — i.e. every team worth
   * warning — gets a mailbox row and nothing else, forever. Here each lead
   * gets an ARMED notice (`Session.armNotice`) that keeps waiting for a real
   * idle boundary until the deadline.
   *
   * Two things are delivered per team, and they are not redundant:
   *  1. a mailbox message with a **pre-minted id** — the read receipt. Its
   *     disappearance from `mailbox.peek()` is the only honest proof an agent
   *     consumed it (see `leadNoticeStatus`).
   *  2. the armed PTY notice — what actually makes the agent look.
   *
   * The result array is the caller's handle: poll it through
   * `leadNoticeStatus()` to render the countdown screen, persist the final
   * status array as the run's `teams_warned`. Field names match that schema.
   *
   * Never throws: one unreachable team must not abort the warning round.
   */
  warnLeads(
    text: string,
    opts: { deadlineMs: number; idleMs?: number; from?: string },
  ): LeadWarning[] {
    const idleMs = opts.idleMs ?? this.config.idleThresholdMs;
    const from = opts.from ?? 'system';
    // A new round supersedes the previous one (the leads' own `armNotice`
    // does the same). Also bounds this map to one round's worth of entries.
    this._leadNotices.clear();
    const out: LeadWarning[] = [];
    for (const orch of this.listActive()) {
      const lead = orch.lead;
      if (!lead) continue;
      const st = lead.status;
      // Same activity predicate as `messaging.isActive`: `paused` is included
      // on purpose — the mailbox row is still worth queueing, and the refused
      // `armNotice` below correctly reports it as never warned.
      if (st !== 'running' && st !== 'waiting' && st !== 'starting' && st !== 'paused') continue;

      const noticeId = randomUUID();
      // Snapshot BEFORE the push: from here on, any increase means an agent
      // drained this lead's inbox while our notice was sitting in it.
      const readBaseline = orch.mailbox.readCount(lead.id);
      let queued = false;
      try {
        const res = orch.mailbox.push(lead.id, { id: noticeId, from, content: text });
        emitMailboxMessage(orch.id, from, lead.id);
        queued = true;
        if (res.dropped) {
          // The inbox was already at cap, so our push evicted the oldest
          // message. Ours survives (drop-oldest), but the queue now sits AT
          // the cap, which is exactly the state where later traffic can evict
          // ours in turn. `leadNoticeStatus` detects that and re-pushes.
          log.warn({
            event: 'warn_leads.inbox_saturated',
            orchId: orch.id,
            leadId: lead.id,
            queueSize: res.queueSize,
          });
        }
      } catch (err) {
        log.warn({
          event: 'warn_leads.push_failed',
          orchId: orch.id,
          leadId: lead.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let armed = false;
      try {
        armed = lead.armNotice(text, { idleMs, deadlineMs: opts.deadlineMs, id: noticeId });
      } catch (err) {
        log.warn({
          event: 'warn_leads.arm_failed',
          orchId: orch.id,
          leadId: lead.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      this._leadNotices.set(noticeId, { text, from, readBaseline });
      out.push({
        orch_id: orch.id,
        orch_name: orch.name,
        lead_id: lead.id,
        notice_id: noticeId,
        armed,
        queued,
      });
    }
    log.info({
      event: 'warn_leads.round',
      teams: out.length,
      armed: out.filter((w) => w.armed).length,
      deadlineMs: opts.deadlineMs,
      idleMs,
    });
    return out;
  }

  /**
   * Current delivery status of a `warnLeads()` round. Safe to call as often
   * as the UI needs (it is a peek + a field read; no I/O).
   *
   * `read` is a genuine consumption signal, not a proxy. It needs BOTH halves
   * of the evidence, and neither alone is enough:
   *
   *  1. **Our id left the inbox.** Necessary: while the row is still queued,
   *     nothing has taken it.
   *  2. **`Mailbox.readCount()` went up.** Sufficient to name the culprit. A
   *     draining `Mailbox.read()` is the only thing that bumps it, and its
   *     only production callers are the MCP `team.read_inbox` tool and the
   *     plugin API — both mean an AGENT. The UI polls `peek()`, which is
   *     non-destructive and invisible here.
   *
   * Half (2) is not redundant, it is the correction of a real lie. An empty
   * queue is NOT evidence of a read: `Orchestrator.stop()` and
   * `shutdownForRestart()` both call `mailbox.clearAll()`, so the single most
   * likely event of an update window — the lead dying — used to erase the row
   * and leave `leadNoticeStatus` reporting `state: 'read'` for an agent that
   * never saw the message. That is precisely the falsehood the pre-minted id
   * exists to prevent, and inferring it from an ABSENCE let it back in
   * through another door. We now observe the `read()` call itself, so a wipe,
   * an eviction or a session teardown can never be mistaken for a delivery.
   *
   * The DB `delivered_at` column remains deliberately unused for the same
   * reason, one layer down: `clearAll()` stamps it too.
   *
   * The remaining way a message can vanish is the drop-oldest cap eviction,
   * and it stays distinguishable exactly as before: an eviction only ever
   * happens AT the cap and leaves the queue sitting at the cap, so an absent
   * id + no observed read + a full queue means "evicted", and we re-push it
   * with the same id so a later real read is still observable.
   */
  leadNoticeStatus(warnings: LeadWarning[]): LeadWarningStatus[] {
    return warnings.map((w) => {
      const orch = this.orchestrators.get(w.orch_id);
      const lead = orch?.getSession(w.lead_id) ?? null;
      // Only trust an outcome that belongs to OUR notice: a later `armNotice`
      // replaces the session's notice state wholesale.
      const ns = lead?.noticeState ?? null;
      const signalled = ns !== null && ns.id === w.notice_id && ns.outcome === 'fired';

      // The round's bookkeeping. Absent ⇒ this handle is not the live round
      // (superseded, cancelled, or replayed in a later process), so we have no
      // baseline to compare against and must not claim a read.
      const carried = this._leadNotices.get(w.notice_id);
      let read = false;
      if (orch && carried) {
        const queue = orch.mailbox.peek(w.lead_id);
        if (!queue.some((m) => m.id === w.notice_id)) {
          if (orch.mailbox.readCount(w.lead_id) > carried.readBaseline) {
            // An agent drained this inbox after we queued the notice, and the
            // notice is gone with it. This is the only path to `read: true`.
            read = true;
          } else if (queue.length >= this.config.maxInboxSize) {
            // Gone with no read behind it, and the queue is at the cap:
            // evicted by inbox pressure. Self-heal so the next poll can still
            // observe a real read, and stay at `read: false`.
            try {
              orch.mailbox.push(w.lead_id, {
                id: w.notice_id,
                from: carried.from,
                content: carried.text,
              });
              log.warn({
                event: 'warn_leads.notice_evicted_repushed',
                orchId: w.orch_id,
                leadId: w.lead_id,
                queueSize: queue.length,
              });
            } catch {
              /* best-effort — the armed PTY notice is the primary channel */
            }
          }
          // Otherwise: gone, below the cap, and nobody read anything — the
          // mailbox was wiped out from under the notice (lead exit →
          // `stop()`, or `shutdownForRestart()`). Stays `read: false`, so the
          // lead is recorded as `queued_unread` / `never_idle` per what
          // actually reached it.
        }
      }
      // A team that vanished from the live map (destroyed mid-window) has no
      // queue to consume from and no PTY left to signal: report it as never
      // warned rather than inventing a read.
      const state = deriveLeadNoticeState({ read, signalled });
      return { ...w, signalled, read, state };
    });
  }

  /**
   * Drop the armed notices of a round (operator cancelled the update). The
   * mailbox rows are left alone on purpose — the lead was genuinely told
   * something was coming, and a message it may already have read must not be
   * retracted from under it.
   */
  cancelLeadNotices(warnings: LeadWarning[]): number {
    let cancelled = 0;
    for (const w of warnings) {
      const lead = this.orchestrators.get(w.orch_id)?.getSession(w.lead_id);
      const ns = lead?.noticeState ?? null;
      // Only cancel a notice that is still ours and still pending.
      if (lead && ns !== null && ns.id === w.notice_id && lead.cancelNotice()) cancelled++;
      this._leadNotices.delete(w.notice_id);
    }
    return cancelled;
  }

  /**
   * update_system D.6 — snapshot the teams that are alive RIGHT NOW, in a
   * shape the caller persists BEFORE triggering anything destructive.
   *
   * This must not be reconstructed from DB rows afterwards, and that is the
   * whole point: `loadResumableState()` flips every candidate to
   * `interrupted` BEFORE returning it, `listResumableOrchestrators()` only
   * selects `starting|running`, and a failed resume leaves the row
   * `interrupted`. By the time anyone asks "which teams should have come
   * back?", the database no longer knows. This snapshot does.
   */
  snapshotLiveTeams(): TeamSnapshotEntry[] {
    return this.listActive().map((orch) => ({
      orch_id: orch.id,
      orch_name: orch.name,
      lead_id: orch.leadSessionId,
    }));
  }

  /**
   * update_system D.6 — diff a `snapshotLiveTeams()` against what is actually
   * live now (post-restart). Drives the post-update screen and its "restart
   * the teams" button.
   *
   * `back` means: the orchestrator is in the live map, not terminal, and has
   * a lead session that is not terminal either. Anything else is a casualty,
   * with `reason` saying which kind — an operator needs to tell "the team
   * never came back at all" from "it came back but its lead died on spawn"
   * (the classic resumed-lead-dies-over-SSH failure).
   *
   * Note `lead_id_now`: a resume reuses the persisted lead id, whereas a
   * fresh restart-in-place mints a new one, so a differing id is normal and
   * not an error.
   */
  reconcileTeams(snapshot: TeamSnapshotEntry[]): TeamReconciliation {
    const teams = snapshot.map((entry): TeamReconcileEntry => {
      const orch = this.orchestrators.get(entry.orch_id);
      if (!orch) {
        return { ...entry, back: false, status: null, lead_id_now: null, reason: 'absent' };
      }
      const status = orch.status;
      const lead = orch.lead;
      const base = { ...entry, status, lead_id_now: orch.leadSessionId };
      if (status === 'stopped' || status === 'failed' || status === 'stopping') {
        return { ...base, back: false, reason: 'not_running' };
      }
      if (!lead) return { ...base, back: false, reason: 'no_lead' };
      const ls = lead.status;
      if (ls !== 'running' && ls !== 'waiting' && ls !== 'starting' && ls !== 'paused') {
        return { ...base, back: false, reason: 'lead_dead' };
      }
      return { ...base, back: true, reason: 'ok' };
    });
    return {
      teams,
      back: teams.filter((t) => t.back).length,
      missing: teams.filter((t) => !t.back).length,
    };
  }

  /**
   * Phase 8 — auto-resume entrypoint. Replays the `resumable[]` list from
   * `Persistence.loadResumableState()` to rebuild each team's
   * `Orchestrator` + Session PTYs with stable ids. The DB rows were already
   * flipped to 'interrupted' by the atomic guard upstream; a successful
   * `Orchestrator.resume()` UPSERTs them back to 'running'.
   *
   * Behaviour notes:
   *   - `maxOrchestrators` is NOT enforced — we honour what was running
   *     before the restart even if the cap has since been lowered. The cap
   *     still applies to future `create()` calls. A soft warn is logged
   *     when the cap is exceeded so operators notice.
   *   - Per-orch try/catch: one bad cwd / model can't break the rest.
   *   - `staggerMs` is honoured both between orchs AND between worker
   *     spawns inside an orch (see Orchestrator.resume), avoiding a 60-way
   *     contention on `/data/.claude-runtime`.
   */
  async resumeFromDb(
    rows: ResumableState['resumable'],
    opts: {
      staggerMs?: number;
      /**
       * update_system D.5 — banner prepended to each resumed LEAD's resume
       * notice (see `Orchestrator.resume`). The caller reads the in-flight
       * update run at boot and passes e.g. "the container was recreated to
       * apply v0.5.1". Absent ⇒ resume notices are unchanged.
       */
      resumeBanner?: string | null;
    } = {},
  ): Promise<{ resumed: number; failed: Array<{ id: string; error: string }> }> {
    const staggerMs = opts.staggerMs ?? this.config.resumeStaggerMs ?? 0;
    let resumed = 0;
    const failed: Array<{ id: string; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];
      if (!item) continue;
      const { orch: row, sessions } = item;

      // Soft cap: warn if we're going over `maxOrchestrators` but DO bring
      // the orch back up. Restoring fewer teams than were running before
      // surprises the operator more than a soft cap warning.
      if (this.orchestrators.size >= this.config.maxOrchestrators) {
        log.warn({
          event: 'resume.cap_exceeded',
          orchId: row.id,
          cap: this.config.maxOrchestrators,
          inFlight: this.orchestrators.size,
        });
      }

      // Find the lead session row — every orchestrator has at most one
      // lead (type='lead'). Workers are everything else.
      const leadRow = sessions.find((s: SessionRow) => s.type === 'lead');
      const workerRows = sessions.filter((s: SessionRow) => s.type === 'worker');
      if (!leadRow) {
        failed.push({ id: row.id, error: 'no lead session row in DB — cannot resume' });
        continue;
      }

      // Build a fresh OrchestratorInit from the persisted row so the
      // constructor has everything it needs (including the preserved id,
      // createdAt, and resumeCount).
      const init: OrchestratorInit = {
        id: row.id,
        createdAt: row.created_at,
        resumeCount: row.resume_count,
        name: row.name,
        role: row.role,
        roleId: row.role_id,
        defaultModel: row.default_model,
        defaultEffort: row.default_effort as EffortLevel,
        defaultPermissionMode: row.default_permission_mode as PermissionMode,
        defaultProvider: row.default_provider,
        leadPreamble: row.lead_preamble,
        workerPreamble: row.worker_preamble,
        lead: {
          cwd: leadRow.cwd,
          prompt: leadRow.initial_prompt ?? '',
          preamble: row.lead_preamble,
        },
      };

      const role = row.role_id && this.roleStore ? this.roleStore.get(row.role_id) : null;
      const effectiveNotifier = this.notifierFor(role);
      const orch = new Orchestrator(init, this.config, {
        notifier: effectiveNotifier,
        persistence: this.persistence,
        providerRegistry: this.providerRegistry,
        modelCatalogue: this.modelCatalogue,
        onHideRequested: (id) => this.hideOrchestrator(id),
        ...(this.pluginTools ? { pluginTools: this.pluginTools } : {}),
        ...(this.taskboard ? { taskboard: this.taskboard } : {}),
        skills: (orchestratorId, sessionId) =>
          this.resolveSkillsFor(init.roleId ?? null, orchestratorId, sessionId),
      });
      this.orchestrators.set(orch.id, orch);

      try {
        await orch.resume({ leadRow, workerRows, staggerMs, banner: opts.resumeBanner });
        resumed++;
        // Re-attach the role's connector subscriptions so a restarted server
        // keeps delivering channel messages to the rehydrated lead. The mailbox
        // is already rehydrated from `mailbox_messages`, so resumed orchs will
        // see both pre-restart and post-restart messages in order.
        this.wireConnectors(orch, role);
        eventBus.emitEvent({
          kind: 'orchestrator.created',
          orchestratorId: orch.id,
          payload: orch.toView(),
        });
        log.info({
          event: 'resume.orch_ok',
          orchId: orch.id,
          name: orch.name,
          workerCount: workerRows.length,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ id: row.id, error: errMsg });
        // Drop the half-resumed orchestrator from the live map so the next
        // create() doesn't fail on cap. The DB row stays 'interrupted'
        // courtesy of the atomic guard — operator can manually retry later.
        this.orchestrators.delete(orch.id);
        log.warn({
          event: 'resume.orch_failed',
          orchId: orch.id,
          name: row.name,
          error: errMsg,
        });
      }

      // Inter-orch stagger so 10 leads + 50 workers don't all race for
      // `/data/.claude-runtime` and claude-cli startup at once.
      if (staggerMs > 0 && i < rows.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
    }

    return { resumed, failed };
  }

  /**
   * On-demand restart of a single terminal orchestrator — relaunches the team
   * IN PLACE: same id, name, role, config, preambles and `createdAt`, but a
   * brand-new lead session. Backs the desktop RESTART / REACTIVATE button so
   * the operator no longer has to KILL + create a brand-new team (which would
   * mint a new id and lose the team's identity/history).
   *
   * Why a fresh `start()` and NOT the auto-resume path: a *resumed* lead
   * re-runs claude with a "server restart" notice and — on the SSH transport —
   * reliably exits 1 within seconds (this is exactly why teams are found dead
   * after a host reboot). A *fresh* lead (identical to create-new-team) stays
   * up. So restart reuses `create()`, which also re-spawns the role's initial
   * workers and re-wires Discord. `resume_count` is bumped for the audit chip.
   *
   * Throws `SpawnerError`:
   *   - `NOT_FOUND` (404)       — no DB row for `id`.
   *   - `ALREADY_RUNNING` (409) — orch is live in the map and not terminal.
   *   - `NO_LEAD` (409)         — no lead session row to copy cwd/prompt from.
   */
  restartOrchestrator(id: string, opts: StartOptions = {}): Orchestrator {
    const live = this.orchestrators.get(id);
    if (live && live.status !== 'stopped' && live.status !== 'failed') {
      throw new SpawnerError(
        `orchestrator ${id} is ${live.status}; nothing to restart`,
        'ALREADY_RUNNING',
        409,
      );
    }

    const row = this.persistence.db.getOrchestrator(id);
    if (!row) {
      throw new SpawnerError(`orchestrator ${id} not found`, 'NOT_FOUND', 404);
    }

    // `listSessions` is ordered started_at ASC, so the LAST lead row is the
    // most recent incarnation — copy its cwd/prompt into the fresh lead.
    const leadRow = [...this.persistence.db.listSessions(id)]
      .reverse()
      .find((s) => s.type === 'lead');
    if (!leadRow) {
      throw new SpawnerError(
        `orchestrator ${id} has no lead session row — cannot restart`,
        'NO_LEAD',
        409,
      );
    }

    // Drop the stale terminal in-memory entry + its connector subs so `create()`
    // can rebuild under the same id without a key collision.
    if (live) this.orchestrators.delete(id);
    this.unsubscribeConnectors(id);

    const { orchestrator } = this.create(
      {
        id: row.id,
        createdAt: row.created_at,
        resumeCount: row.resume_count + 1,
        name: row.name,
        role: row.role,
        roleId: row.role_id,
        defaultModel: row.default_model,
        defaultEffort: row.default_effort as EffortLevel,
        defaultPermissionMode: row.default_permission_mode as PermissionMode,
        defaultProvider: row.default_provider,
        leadPreamble: row.lead_preamble,
        workerPreamble: row.worker_preamble,
        lead: {
          cwd: leadRow.cwd,
          prompt: leadRow.initial_prompt ?? '',
          preamble: row.lead_preamble,
        },
      },
      opts,
    );
    log.info({ event: 'spawner.orch_restarted', orchId: id, name: orchestrator.name });
    return orchestrator;
  }
}

// Re-export for callers that don't want to import from persistence directly.
export type { ResumableState } from '../orchestrator/persistence.js';
// Re-export so server/index.ts can pass it down without a separate import.
export type { SessionRow } from '../db/index.js';
