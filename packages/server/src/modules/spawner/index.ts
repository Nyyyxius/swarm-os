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
import type { RoleStore, Role } from '../roles/index.js';
import type { SessionRow } from '../db/index.js';
import type { DiscordBotPool } from '../discord/pool.js';

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
   * Optional Discord bot pool. When set AND a role's DiscordConnector
   * has BOTH `channelId` and `botToken`, the orchestrator is subscribed
   * at create/resume time and unsubscribed at destroy/hide/shutdown.
   * The pool starts a bot per distinct token, lazily.
   */
  discordBotPool?: DiscordBotPool;
}

export class Spawner {
  private readonly orchestrators = new Map<string, Orchestrator>();
  readonly notifier: Notifier;
  readonly persistence: Persistence;
  readonly roleStore: RoleStore | null;
  readonly discordBotPool: DiscordBotPool | null;

  constructor(
    private readonly config: Config,
    deps: SpawnerDeps = {},
  ) {
    this.notifier = deps.notifier ?? new NoOpNotifier();
    this.persistence = deps.persistence ?? new NoOpPersistence();
    this.roleStore = deps.roleStore ?? null;
    this.discordBotPool = deps.discordBotPool ?? null;
  }

  /**
   * Hook the orchestrator up to its role's Discord bot when the role has
   * BOTH a `channelId` and a `botToken`. Fire-and-forget: the pool's
   * `subscribeOrch` lazily starts a Gateway connection if needed, which
   * can take a few seconds; we don't make `create()` async over it,
   * because the orch can serve traffic immediately while Discord wires up.
   */
  private wireDiscordBot(orch: Orchestrator, role: Role | null): void {
    if (!this.discordBotPool || !role) return;
    const discord = role.connectors.find((c) => c.type === 'discord');
    if (!discord?.channelId || !discord.botToken) return;
    void this.discordBotPool
      .subscribeOrch(discord.botToken, {
        orchestratorId: orch.id,
        channelId: discord.channelId,
        getLeadSessionId: () => orch.leadSessionId,
        mailbox: orch.mailbox,
      })
      .catch((err) => {
        log.warn({
          event: 'spawner.discord_subscribe_failed',
          orchId: orch.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * Pick the notifier to attach to a new orchestrator. If the role has a
   * Discord webhook connector, build a dedicated `DiscordWebhookNotifier`
   * pointed at it (overriding the global one). Otherwise fall back to the
   * spawner-level notifier.
   */
  private notifierFor(role: Role | null): Notifier {
    if (!role) return this.notifier;
    const discord = role.connectors.find((c) => c.type === 'discord');
    if (!discord) return this.notifier;
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

    // Subscribe the orch to its Discord channel (if any) as soon as the lead
    // is up. Skipped silently when the bot is disabled or the role has no
    // `channelId` — webhook notifications remain unaffected either way.
    if (orch.status === 'running') this.wireDiscordBot(orch, role);

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
    // Drop any Discord subscription so a recycled orch id with a different
    // role can't piggyback on a stale channel binding.
    void this.discordBotPool?.unsubscribeOrch(id);
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
    // Stop forwarding Discord messages to a terminating lead.
    void this.discordBotPool?.unsubscribeOrch(id);
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
        // Re-attach the Discord subscription so a restarted server keeps
        // delivering channel messages to the rehydrated lead. The mailbox is
        // already rehydrated from `mailbox_messages`, so resumed orchs will
        // see both pre-restart and post-restart messages in order.
        this.wireDiscordBot(orch, role);
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
}

// Re-export for callers that don't want to import from persistence directly.
export type { ResumableState } from '../orchestrator/persistence.js';
// Re-export so server/index.ts can pass it down without a separate import.
export type { SessionRow } from '../db/index.js';
