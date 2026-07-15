import { Orchestrator, WorkerCapError, type OrchestratorInit, type StartOptions } from '../orchestrator/index.js';
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
import type { PluginOrchSubscription } from '../plugins/api-types.js';
import { isIdle, SIGNAL_TEXT, pushToLeadInbox } from '../orchestrator/messaging.js';

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
}

export class Spawner {
  private readonly orchestrators = new Map<string, Orchestrator>();
  readonly notifier: Notifier;
  readonly persistence: Persistence;
  readonly roleStore: RoleStore | null;
  readonly discordBotPool: DiscordBotPool | null;
  readonly connectorRegistry: ConnectorRegistry | null;

  constructor(
    private readonly config: Config,
    deps: SpawnerDeps = {},
  ) {
    this.notifier = deps.notifier ?? new NoOpNotifier();
    this.persistence = deps.persistence ?? new NoOpPersistence();
    this.roleStore = deps.roleStore ?? null;
    this.discordBotPool = deps.discordBotPool ?? null;
    this.connectorRegistry = deps.connectorRegistry ?? null;
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
      // KILL UI flow on the lead: when the operator clicked KILL we ask the
      // orchestrator to call us back once it reaches terminal, so we can soft
      // delete the whole team from the map in one shot.
      onHideRequested: (id) => {
        this.hideOrchestrator(id);
      },
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

  get(id: string): Orchestrator | undefined {
    return this.orchestrators.get(id);
  }

  list(): Orchestrator[] {
    return Array.from(this.orchestrators.values());
  }

  listActive(): Orchestrator[] {
    return this.list().filter(
      (o) => o.status !== 'stopped' && o.status !== 'failed',
    );
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
    opts: { staggerMs?: number } = {},
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
        onHideRequested: (id) => this.hideOrchestrator(id),
      });
      this.orchestrators.set(orch.id, orch);

      try {
        await orch.resume({ leadRow, workerRows, staggerMs });
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
