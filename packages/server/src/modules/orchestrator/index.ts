import * as crypto from 'node:crypto';
import { Session, type SessionView, type SessionSshTransport } from './session.js';
import { Mailbox } from './mailbox.js';
import { buildPreamble } from './preamble.js';
import { emitMailboxMessage } from './messaging.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';
import type { AgentProcess } from './agent-process.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import type { Notifier } from '../notify/index.js';
import { NoOpNotifier } from '../notify/null.js';
import type { Persistence } from './persistence.js';
import { NoOpPersistence } from './persistence.js';
import { computeOrchestratorHealth, type OrchestratorHealth } from './health.js';
import { makeMailboxPersistenceForOrch } from './mailbox-persistence.js';
import { buildResumeNotice } from './log-tail-reader.js';
import type { SessionRow } from '../db/index.js';

const log = withModule('orchestrator');

export type OrchestratorStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type { OrchestratorHealth } from './health.js';
export { computeOrchestratorHealth } from './health.js';

export interface OrchestratorInit {
  name: string;
  role: string;
  /** Optional FK into the `roles` table. Stored as denormalized label in `role`. */
  roleId?: string | null;
  defaultModel: string;
  defaultEffort: EffortLevel;
  defaultPermissionMode: PermissionMode;
  leadPreamble: string | null;
  workerPreamble: string | null;
  lead: {
    cwd: string;
    prompt: string;
    preamble?: string | null;
  };
  /**
   * Phase 8 — auto-resume only. When provided, reuse this UUID instead of
   * minting a fresh one. The Spawner sets this when rebuilding an
   * orchestrator from a persisted DB row so the session ids, log paths,
   * mailbox routing keys, and history references all stay stable.
   */
  id?: string;
  /**
   * Phase 8 — auto-resume only. When provided, reuse this ISO timestamp
   * for `createdAt` so the historical "team age" survives the restart.
   */
  createdAt?: string;
  /**
   * Phase 8 — auto-resume only. Seed for the monotonic `resume_count`.
   * Incremented once at the end of a successful `resume()`.
   */
  resumeCount?: number;
}

export interface OrchestratorView {
  id: string;
  name: string;
  role: string;
  roleId: string | null;
  status: OrchestratorStatus;
  leadSessionId: string | null;
  defaultModel: string;
  defaultEffort: EffortLevel;
  defaultPermissionMode: PermissionMode;
  leadPreamble: string | null;
  workerPreamble: string | null;
  createdAt: string;
  endedAt: string | null;
  lastError: string | null;
  sessions: SessionView[];
  /**
   * Phase update_system S1 — cumulative count of bus messages pushed into
   * this orchestrator's mailbox since it started. Monotone, never reset
   * (`read`/`peek`/`removeSession`/`clearAll` don't decrement). One push =
   * one increment, so a broadcast hitting N recipients adds N. In-memory
   * only: history rows recovered from SQLite expose `msgCount: 0` because
   * the live mailbox no longer exists.
   */
  msgCount: number;
  /** Phase 4: surfaced so UI can show "interrupted (server-restart)" etc. */
  stopReason?: string | null;
  /**
   * Phase update_system S7 — aggregated health verdict, derived from
   * `status`, `lead.status`, worker statuses, and `lastError`. Recomputed
   * on every `toView()` call by `computeOrchestratorHealth` (pure
   * function). The new desktop UI maps this to the per-team pill
   * (`ok|warn|bad|stopped` ↔ `HEALTHY|DEGRADED|FAILED|OFFLINE`).
   */
  health: OrchestratorHealth;
  /**
   * Phase 8 — count of successful auto-resumes since this orch's first
   * boot. 0 means "never restarted"; >0 means the UI can surface a
   * "Resumed N×" chip so operators can spot restart loops without grepping
   * logs.
   */
  resumeCount: number;
  /** Phase 8 — ISO timestamp of the latest successful resume (or null). */
  lastResumedAt: string | null;
}

/** Phase 4: optional dependencies wired by the Spawner. */
export interface OrchestratorDeps {
  notifier?: Notifier;
  persistence?: Persistence;
  /**
   * Invoked once when the orchestrator first reaches a terminal status
   * (`stopped` / `failed`) AND `setHideOnExit(true)` was called beforehand
   * (i.e. the operator clicked KILL on the lead). The Spawner wires this to
   * its own `hideOrchestrator(id)` so the team disappears from the map
   * without a second REMOVE click.
   */
  onHideRequested?: (orchestratorId: string) => void;
}

export interface StartOptions {
  /** Skip the actual `claude` spawn — used by smoke test when CLI unavailable. */
  skipSpawn?: boolean;
  /** Test hook — substitute the lead's underlying AgentProcess. */
  agentProcessOverride?: AgentProcess;
}

/**
 * Spec passed to `addWorker()`. Mirrors the MCP `team.spawn_worker` schema
 * (plan §10), with optional inheritance from orchestrator defaults.
 */
export interface WorkerSpec {
  name: string;
  role: string;
  /** Initial prompt seed. The preamble is concatenated automatically. */
  prompt: string;
  /** Defaults to the lead's cwd if omitted. Caller MUST validate first. */
  cwd?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** Optional override that wins over the orchestrator-level worker preamble. */
  preamble?: string | null;
  /** Test hooks — same as StartOptions for the lead. */
  skipSpawn?: boolean;
  agentProcessOverride?: AgentProcess;
  /**
   * Phase 8 — auto-resume only. When provided, reuse this session id +
   * startedAt instead of minting a fresh UUID. Required so the rebuilt
   * worker keeps the same DB row, log path, and mailbox routing key.
   */
  existingId?: string;
  startedAt?: string;
  /**
   * Phase 8 — auto-resume only. Appended to the preamble (after any
   * customOverride) so the agent sees the "## Server restart notice"
   * block at the start of its replayed prompt.
   */
  resumeNotice?: string;
}

export class WorkerCapError extends Error {
  readonly code = 'MAX_WORKERS_PER_ORCH';
  constructor(cap: number) {
    super(`max workers per orchestrator (${cap}) reached`);
    this.name = 'WorkerCapError';
  }
}

/**
 * S5 — typed error for per-session lifecycle actions. The HTTP layer maps
 * `httpStatus` straight to the response; the `code` is the stable token
 * clients switch on.
 */
export class SessionActionError extends Error {
  constructor(
    public readonly code:
      | 'SESSION_UNKNOWN'
      | 'LEAD_NOT_STOPPABLE'
      | 'LEAD_NOT_RESTARTABLE'
      | 'ALREADY_TERMINATED'
      | 'NOT_PAUSED'
      | 'INVALID_TRANSITION'
      | 'RESTART_IN_PROGRESS',
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'SessionActionError';
  }
}

/**
 * Owns one team: 1 lead session + 0..N worker sessions, plus the in-memory
 * mailbox shared across them (plan §11).
 */
export class Orchestrator {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly roleId: string | null;
  readonly defaultModel: string;
  readonly defaultEffort: EffortLevel;
  readonly defaultPermissionMode: PermissionMode;
  readonly leadPreamble: string | null;
  readonly workerPreamble: string | null;
  readonly createdAt: string;
  readonly mailbox: Mailbox;

  private _status: OrchestratorStatus = 'starting';
  private _endedAt: string | null = null;
  private _lastError: string | null = null;
  private _leadSessionId: string | null = null;
  private _stopReason: string | null = null;
  private _endNotified = false;
  private _hideOnExit = false;
  private _hideRequestFired = false;
  // Phase 8 — auto-resume audit. `_resumeCount` is incremented at the end
  // of a successful `resume()`; `_lastResumedAt` is stamped at the same
  // time. Both are persisted via UPSERT in `_setStatus` and surfaced in
  // `toView()` for the UI chip.
  private _resumeCount: number;
  private _lastResumedAt: string | null = null;

  readonly notifier: Notifier;
  readonly persistence: Persistence;
  private readonly _onHideRequested: ((orchestratorId: string) => void) | null;

  /** All sessions, including terminated ones, indexed by id. */
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly init: OrchestratorInit,
    private readonly config: Config,
    deps: OrchestratorDeps = {},
  ) {
    // Phase 8: reuse the persisted UUID when resuming, otherwise mint a
    // fresh one. Same for `createdAt` and `resumeCount` so the historical
    // audit survives a server restart.
    this.id = init.id ?? crypto.randomUUID();
    this.name = init.name;
    this.role = init.role;
    this.roleId = init.roleId ?? null;
    this.defaultModel = init.defaultModel;
    this.defaultEffort = init.defaultEffort;
    this.defaultPermissionMode = init.defaultPermissionMode;
    this.leadPreamble = init.leadPreamble;
    this.workerPreamble = init.workerPreamble;
    this.createdAt = init.createdAt ?? new Date().toISOString();
    this._resumeCount = init.resumeCount ?? 0;
    // Mailbox persistence hook is wired below once `persistence` is set.
    this.notifier = deps.notifier ?? new NoOpNotifier();
    this.persistence = deps.persistence ?? new NoOpPersistence();
    this._onHideRequested = deps.onHideRequested ?? null;
    // Phase 8 — write-through mailbox: every push/markDelivered routes to
    // SQLite via the hook below. Constructed AFTER persistence is set.
    // The hook impl is provided by mailbox-persistence.ts to keep the DB
    // SQL out of mailbox.ts. When persistence is a NoOp (tests), the hook
    // resolves to undefined so the mailbox stays purely in-memory.
    this.mailbox = new Mailbox({
      maxSize: this.config.maxInboxSize,
      persist: makeMailboxPersistenceForOrch(this.id, this.persistence),
    });
  }

  /**
   * KILL-on-lead flow: ask for soft-delete of the whole team once the
   * orchestrator reaches a terminal status. The actual hide is delegated to
   * the Spawner via the `onHideRequested` dep.
   */
  setHideOnExit(v: boolean): void {
    this._hideOnExit = v;
  }

  /** Public Phase 4 accessor — needed by persistence to write `stop_reason`. */
  get stopReason(): string | null {
    return this._stopReason;
  }

  /**
   * Build the per-session SSH transport bundle from the orchestrator's Config.
   * Returns `null` for `agentTransport=local`. Centralised so all three Session
   * construction sites (`start`, `resume`, `addWorker`) stay in sync.
   */
  private _sshTransportBundle(): SessionSshTransport | null {
    if (this.config.agentTransport !== 'ssh') return null;
    if (
      !this.config.sshTarget ||
      !this.config.hostDataDir ||
      !this.config.hostWorkspaceRoot
    ) {
      return null;
    }
    return {
      sshTarget: this.config.sshTarget,
      sshKey: this.config.sshKey,
      sshPort: this.config.sshPort,
      dataDir: this.config.dataDir,
      hostDataDir: this.config.hostDataDir,
      hostClaudeDir: this.config.hostClaudeDir,
      workspaceRoot: this.config.workspaceRoot,
      hostWorkspaceRoot: this.config.hostWorkspaceRoot,
    };
  }

  // --- Lifecycle ---------------------------------------------------------

  start(opts: StartOptions = {}): Session {
    if (this._leadSessionId) {
      const existing = this.sessions.get(this._leadSessionId);
      if (existing) return existing;
    }

    const sessionId = crypto.randomUUID();
    // Pre-build the preamble so the agent has the team-comms instructions
    // baked into its initial prompt. We use the orchestrator-level
    // `leadPreamble` as the optional override layered atop the default.
    const preamble = buildPreamble({
      identity: {
        name: `${this.name}-lead`,
        role: this.role,
        sessionId,
        orchName: this.name,
      },
      isLead: true,
      customOverride: this.init.lead.preamble ?? this.leadPreamble,
    });

    const lead = new Session({
      id: sessionId,
      orchestratorId: this.id,
      name: `${this.name}-lead`,
      role: this.role,
      type: 'lead',
      cwd: this.init.lead.cwd,
      initialPrompt: this.init.lead.prompt,
      preamble,
      model: this.defaultModel,
      effort: this.defaultEffort,
      permissionMode: this.defaultPermissionMode,
      logsDir: this.config.logsDir,
      mcpRuntimeDir: this.config.mcpRuntimeDir,
      // MCP server is hardcoded to loopback (plan §14). The host string
      // here is intentionally not configurable — only the port is.
      mcpHost: '127.0.0.1',
      mcpPort: this.config.mcpPort,
      skipSpawn: opts.skipSpawn,
      agentProcessOverride: opts.agentProcessOverride,
      onStateChange: (s, force) => this._onSessionState(s, force),
      // Phase 4: lead session writes a per-session settings.json injecting
      // the Notification hook. The CLAUDE_CONFIG_DIR sub-tree lives under
      // <dataDir>/.claude-runtime/sessions/<id>/. We pass the resolved
      // hookToken + main HTTP port so the hook command can POST back.
      hookToken: this.config.hookToken,
      mainHttpPort: this.config.port,
      claudeConfigRoot: this.config.claudeRuntimeDir,
      claudeSourceDir: this.config.claudeSourceDir,
      claudeJsonSource: this.config.claudeJsonSource,
      sshTransport: this._sshTransportBundle(),
    });

    this._leadSessionId = lead.id;
    this.sessions.set(lead.id, lead);

    if (lead.status === 'failed') {
      this._setStatus('failed');
      this._lastError = lead.lastError;
      this._endedAt = new Date().toISOString();
    } else {
      this._setStatus('running');
    }

    eventBus.emitEvent({
      kind: 'session.created',
      orchestratorId: this.id,
      sessionId: lead.id,
      payload: lead.toView(),
    });

    // Lead exit → all sessions stop, orchestrator → stopped.
    lead.once('exit', () => this._onLeadExit());

    return lead;
  }

  /**
   * Phase 8 — auto-resume entrypoint. Used by `Spawner.resumeFromDb` to
   * rebuild a previously-running team from persisted rows. Behaves like
   * `start()` + `addWorker()` for each worker, but:
   *
   *  - Reuses the persisted session ids / startedAt / log_path so history
   *    stays continuous and mailbox routing keeps working.
   *  - Appends a "## Server restart notice" (with PTY log tail) to every
   *    session's preamble so the agent knows it was interrupted and
   *    re-reads its workspace defensively.
   *  - Awaits `staggerMs` between each PTY spawn (lead first, then each
   *    worker) so 60 PTYs don't race for `/data/.claude-runtime` on boot.
   *  - Bumps `resumeCount` + stamps `lastResumedAt` only at the end, on
   *    full success. A mid-resume failure leaves the row in `failed`
   *    (caller wraps in try/catch and records `last_error`).
   *
   * Throws if the lead session can't be spawned. Worker failures are
   * captured but don't abort the whole resume — the lead being up is
   * what matters most.
   */
  async resume(opts: {
    leadRow: SessionRow;
    workerRows: SessionRow[];
    staggerMs: number;
  }): Promise<void> {
    if (this._leadSessionId) {
      throw new Error(`orchestrator ${this.id} already has a lead — resume called twice?`);
    }

    const leadRow = opts.leadRow;
    const leadNotice = buildResumeNotice(leadRow.log_path);

    // Build the preamble with the resume notice appended. We use the
    // persisted `init.lead.preamble` (already in `this.init.lead.preamble`)
    // OR the orchestrator-level `leadPreamble` for the customOverride —
    // same precedence as `start()`.
    const preamble = buildPreamble({
      identity: {
        name: leadRow.name,
        role: leadRow.role,
        sessionId: leadRow.id,
        orchName: this.name,
      },
      isLead: true,
      customOverride: this.init.lead.preamble ?? this.leadPreamble,
      resumeNotice: leadNotice,
    });

    const lead = new Session({
      id: leadRow.id,
      startedAt: leadRow.started_at,
      orchestratorId: this.id,
      name: leadRow.name,
      role: leadRow.role,
      type: 'lead',
      cwd: leadRow.cwd,
      initialPrompt: leadRow.initial_prompt,
      preamble,
      model: leadRow.model,
      effort: leadRow.effort as EffortLevel,
      permissionMode: leadRow.permission_mode as PermissionMode,
      logsDir: this.config.logsDir,
      mcpRuntimeDir: this.config.mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: this.config.mcpPort,
      onStateChange: (s, force) => this._onSessionState(s, force),
      hookToken: this.config.hookToken,
      mainHttpPort: this.config.port,
      claudeConfigRoot: this.config.claudeRuntimeDir,
      claudeSourceDir: this.config.claudeSourceDir,
      claudeJsonSource: this.config.claudeJsonSource,
      sshTransport: this._sshTransportBundle(),
    });

    this._leadSessionId = lead.id;
    this.sessions.set(lead.id, lead);

    if (lead.status === 'failed') {
      this._setStatus('failed');
      this._lastError = lead.lastError;
      this._endedAt = new Date().toISOString();
      this._stopReason = 'resume-failed';
      throw new Error(`lead session failed to spawn on resume: ${lead.lastError ?? 'unknown'}`);
    }

    this._setStatus('running');
    eventBus.emitEvent({
      kind: 'session.created',
      orchestratorId: this.id,
      sessionId: lead.id,
      payload: lead.toView(),
    });
    lead.once('exit', () => this._onLeadExit());

    // Workers: stagger spawns to avoid /data/.claude-runtime contention.
    for (const workerRow of opts.workerRows) {
      if (workerRow.id === leadRow.id) continue; // safety net
      if (opts.staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.staggerMs));
      }
      // Persisted-paused sessions can't really resume into 'paused' — the
      // SIGSTOP target is gone. Bring them back as 'running' with a
      // last_error stamp so the operator sees what happened.
      const wasPaused = workerRow.status === 'paused';
      try {
        const worker = this.addWorker({
          name: workerRow.name,
          role: workerRow.role,
          prompt: workerRow.initial_prompt ?? '',
          cwd: workerRow.cwd,
          model: workerRow.model,
          effort: workerRow.effort as EffortLevel,
          permissionMode: workerRow.permission_mode as PermissionMode,
          existingId: workerRow.id,
          startedAt: workerRow.started_at,
          resumeNotice: buildResumeNotice(workerRow.log_path),
        });
        if (wasPaused) {
          log.warn({
            event: 'resume.paused_session_unpaused',
            orchId: this.id,
            sessionId: worker.id,
          });
        }
      } catch (err) {
        // A single worker failing shouldn't take down the team. Log + persist
        // a marker via the worker row (which already exists in DB from the
        // previous incarnation) — we leave the DB row as 'interrupted'
        // (atomic guard's flip) so it stays out of the live map.
        log.warn({
          event: 'resume.worker_spawn_failed',
          orchId: this.id,
          workerId: workerRow.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Successful resume: bump audit counters. Persists via writeOrchestrator.
    this._stampResumeCompleted();
  }

  /**
   * Spawn a worker. Throws `WorkerCapError` if the active worker count would
   * exceed `config.maxWorkersPerOrch`. The caller is responsible for any
   * `cwd` realpath validation BEFORE this is called — we don't redo it here
   * because the MCP and REST entrypoints have already done it.
   */
  addWorker(spec: WorkerSpec): Session {
    if (this._status === 'stopped' || this._status === 'failed' || this._status === 'stopping') {
      throw new Error(`orchestrator is ${this._status}; cannot spawn worker`);
    }
    const activeWorkers = this.listSessions().filter(
      (s) => s.type === 'worker' && this._isActive(s),
    );
    if (activeWorkers.length >= this.config.maxWorkersPerOrch) {
      throw new WorkerCapError(this.config.maxWorkersPerOrch);
    }

    const cwd = spec.cwd ?? this.init.lead.cwd;
    const model = spec.model ?? this.defaultModel;
    const effort = spec.effort ?? this.defaultEffort;
    const permissionMode = spec.permissionMode ?? this.defaultPermissionMode;
    // Phase 8: reuse the persisted id when resuming so the row + log path
    // + mailbox routing stay stable; otherwise mint a fresh UUID.
    const sessionId = spec.existingId ?? crypto.randomUUID();
    const preambleText = buildPreamble({
      identity: {
        name: spec.name,
        role: spec.role,
        sessionId,
        orchName: this.name,
      },
      isLead: false,
      customOverride: spec.preamble ?? this.workerPreamble,
      resumeNotice: spec.resumeNotice,
    });

    const worker = new Session({
      id: sessionId,
      startedAt: spec.startedAt,
      orchestratorId: this.id,
      name: spec.name,
      role: spec.role,
      type: 'worker',
      cwd,
      initialPrompt: spec.prompt,
      preamble: preambleText,
      model,
      effort,
      permissionMode,
      logsDir: this.config.logsDir,
      mcpRuntimeDir: this.config.mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: this.config.mcpPort,
      skipSpawn: spec.skipSpawn,
      agentProcessOverride: spec.agentProcessOverride,
      onStateChange: (s, force) => this._onSessionState(s, force),
      hookToken: this.config.hookToken,
      mainHttpPort: this.config.port,
      claudeConfigRoot: this.config.claudeRuntimeDir,
      claudeSourceDir: this.config.claudeSourceDir,
      claudeJsonSource: this.config.claudeJsonSource,
      sshTransport: this._sshTransportBundle(),
    });

    this.sessions.set(worker.id, worker);

    eventBus.emitEvent({
      kind: 'session.created',
      orchestratorId: this.id,
      sessionId: worker.id,
      payload: worker.toView(),
    });

    // Persist immediately so the worker row exists before any exit event.
    this.persistence.writeSession(worker, { force: true });

    // Worker exit handling — distinct from lead exit. Abnormal exit fires
    // a synthetic mailbox message + signal to the lead.
    worker.once('exit', () => this._onWorkerExit(worker));

    return worker;
  }

  /** Phase 4: every session state change funnels through here. */
  private _onSessionState(session: Session, force: boolean): void {
    try {
      this.persistence.writeSession(session, { force });
    } catch (err) {
      log.warn({
        event: 'persistence.session_failed',
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Kill a single worker by session id. SIGTERM, 5s grace, SIGKILL.
   *
   * Idempotent: returns `false` if the id is unknown OR the session is
   * already terminated, `true` if a stop was actually requested. Lead is
   * NEVER killable via this entrypoint — use `stop()` to take down the
   * whole orchestrator.
   */
  killWorker(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.type !== 'worker') return false;
    if (
      s.status === 'exited' ||
      s.status === 'killed' ||
      s.status === 'failed' ||
      s.status === 'interrupted'
    ) {
      return false;
    }
    s.stop('killed-by-lead', 5000);
    return true;
  }

  /**
   * Kill every worker in the team (lead survives). Returns the ids that
   * were actually targeted.
   */
  killAllWorkers(): string[] {
    const killed: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.type !== 'worker') continue;
      if (this.killWorker(s.id)) killed.push(s.id);
    }
    return killed;
  }

  // --- S5 per-session lifecycle actions ---------------------------------

  /**
   * S5 — stop a single worker. Refuses the lead (use `DELETE /orchestrators`
   * to take down the whole team) and refuses already-terminated sessions.
   *
   * When `opts.hideAfterExit` is true, the session will be soft-deleted from
   * the map once the PTY actually exits (handled in `_onWorkerExit`). Used by
   * the KILL UI button to collapse the two-click stop-then-remove flow.
   */
  stopSession(
    id: string,
    reason = 'user-stop-rest',
    opts: { hideAfterExit?: boolean } = {},
  ): Session {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionActionError('SESSION_UNKNOWN', `session ${id} not found`, 404);
    }
    if (s.type === 'lead') {
      throw new SessionActionError(
        'LEAD_NOT_STOPPABLE',
        'cannot stop the lead session directly — use DELETE /orchestrators/:id',
        409,
      );
    }
    if (
      s.status === 'exited' ||
      s.status === 'killed' ||
      s.status === 'failed' ||
      s.status === 'interrupted'
    ) {
      throw new SessionActionError(
        'ALREADY_TERMINATED',
        `session ${id} is already terminated (status=${s.status})`,
        409,
      );
    }
    if (opts.hideAfterExit) s.setHideAfterExit(true);
    s.stop(reason, 5000);
    return s;
  }

  /**
   * S5 — pause a session (SIGSTOP). Lead is allowed (operator may want to
   * freeze the lead to inspect state); workers obviously are too.
   */
  pauseSession(id: string, reason = 'user-pause-rest'): Session {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionActionError('SESSION_UNKNOWN', `session ${id} not found`, 404);
    }
    if (
      s.status === 'exited' ||
      s.status === 'killed' ||
      s.status === 'failed' ||
      s.status === 'interrupted'
    ) {
      throw new SessionActionError(
        'ALREADY_TERMINATED',
        `session ${id} is terminated (status=${s.status})`,
        409,
      );
    }
    if (!s.pause(reason)) {
      throw new SessionActionError(
        'INVALID_TRANSITION',
        `session ${id} cannot be paused from status=${s.status}`,
        409,
      );
    }
    return s;
  }

  /** S5 — resume a paused session (SIGCONT). */
  resumeSession(id: string, reason = 'user-resume-rest'): Session {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionActionError('SESSION_UNKNOWN', `session ${id} not found`, 404);
    }
    if (s.status !== 'paused') {
      throw new SessionActionError(
        'NOT_PAUSED',
        `session ${id} is not paused (status=${s.status})`,
        409,
      );
    }
    if (!s.resume(reason)) {
      throw new SessionActionError(
        'INVALID_TRANSITION',
        `session ${id} could not be resumed`,
        409,
      );
    }
    return s;
  }

  /**
   * S5 — restart a worker: stop the existing PTY (marked `killed` with
   * `stopReason: 'restart-requested'`) and spawn a fresh session with the
   * same config (model, effort, permissionMode, cwd, role, name, prompt).
   *
   * The new session has a fresh UUID (see plan §5.1) — the old row stays
   * visible in history. Lead restart is forbidden (cf. §5.2): bringing the
   * lead back up requires rebuilding the entire team.
   */
  restartSession(id: string): { oldSession: Session; newSession: Session } {
    const old = this.sessions.get(id);
    if (!old) {
      throw new SessionActionError('SESSION_UNKNOWN', `session ${id} not found`, 404);
    }
    if (old.type === 'lead') {
      throw new SessionActionError(
        'LEAD_NOT_RESTARTABLE',
        'cannot restart the lead — destroy and recreate the whole orchestrator',
        409,
      );
    }
    if (old.restarting) {
      throw new SessionActionError(
        'RESTART_IN_PROGRESS',
        `session ${id} is already being restarted`,
        409,
      );
    }
    old.setRestarting(true);
    // Recapture the spawn config BEFORE asking the old session to die — the
    // accessors are still valid for terminal sessions, but reading first
    // keeps the code path simpler and resilient to future changes.
    const spec: WorkerSpec = {
      name: old.name,
      role: old.role,
      prompt: old.initialPromptRaw ?? '',
      cwd: old.cwd,
      model: old.model,
      effort: old.effort,
      permissionMode: old.permissionMode,
    };
    // Kill the old session if it's still alive — otherwise leave it as-is
    // (its row stays in history). Even terminated, mark the stop reason so
    // history reports "restart-requested" instead of a stale value.
    if (
      old.status !== 'exited' &&
      old.status !== 'killed' &&
      old.status !== 'failed' &&
      old.status !== 'interrupted'
    ) {
      old.stop('restart-requested', 5000);
    }
    // addWorker mints a new UUID, rebuilds the preamble against the new
    // session id, and emits `session.created` itself.
    let newSession: Session;
    try {
      newSession = this.addWorker(spec);
    } finally {
      // Always clear the flag — a successful restart hands off to the new
      // session, a failed one leaves the old session in its terminal state.
      old.setRestarting(false);
    }
    return { oldSession: old, newSession };
  }

  /**
   * Idempotent stop: SIGTERM lead+workers, grace 5s, SIGKILL.
   */
  stop(reason: string): void {
    if (this._status === 'stopped' || this._status === 'failed') return;
    if (this._status !== 'stopping') {
      this._setStatus('stopping');
    }
    this._stopReason ??= reason;
    for (const s of this.sessions.values()) {
      s.stop(reason, 5000);
    }
    // Wipe the mailbox now — every PTY is going down anyway, no point
    // keeping queued messages that nobody can read.
    this.mailbox.clearAll();
    // Safety net: if the lead never emits exit (e.g. spawn-failed lead with no
    // 'exit' EventEmitter event), force the transition after grace+1s.
    const safety = setTimeout(() => {
      if (this._status === 'stopping') {
        this._setStatus('stopped');
        this._endedAt ??= new Date().toISOString();
      }
    }, 6000);
    safety.unref();
  }

  // --- Accessors ---------------------------------------------------------

  get status(): OrchestratorStatus {
    return this._status;
  }

  get leadSessionId(): string | null {
    return this._leadSessionId;
  }

  get lead(): Session | null {
    return this._leadSessionId ? (this.sessions.get(this._leadSessionId) ?? null) : null;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Soft-delete a terminal worker session from the map. Callers must check
   * that the session exists, is terminal, and is NOT the lead (lead removal
   * goes through `Spawner.hideOrchestrator`). Returns true if hidden, false
   * if the session was not found or was already gone.
   *
   * The in-memory row is dropped so subsequent `toView()` calls do not
   * include it; the DB row is flipped `hidden_at` so it stays out of
   * history lists too.
   */
  hideSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.mailbox.removeSession(id);
    this.persistence.db.hideSession(id);
    return true;
  }

  toView(): OrchestratorView {
    const sessions = this.listSessions().map((s) => s.toView());
    const base = {
      id: this.id,
      name: this.name,
      role: this.role,
      roleId: this.roleId,
      status: this._status,
      leadSessionId: this._leadSessionId,
      defaultModel: this.defaultModel,
      defaultEffort: this.defaultEffort,
      defaultPermissionMode: this.defaultPermissionMode,
      leadPreamble: this.leadPreamble,
      workerPreamble: this.workerPreamble,
      createdAt: this.createdAt,
      endedAt: this._endedAt,
      lastError: this._lastError,
      sessions,
      msgCount: this.mailbox.messagesTotal,
      stopReason: this._stopReason,
      // Phase 8 — auto-resume audit, surfaced for UI chip.
      resumeCount: this._resumeCount,
      lastResumedAt: this._lastResumedAt,
    };
    return {
      ...base,
      // S7 — derived field, recomputed on every serialization. Cheap
      // (O(N) over sessions, N ≤ maxWorkersPerOrch).
      health: computeOrchestratorHealth(base),
    };
  }

  /**
   * Phase 8 — bump the resume audit counters. Called once per successful
   * `resume()` at the very end so the count never reflects a half-resumed
   * orch. UPSERT through the existing persistence hook.
   */
  _stampResumeCompleted(): void {
    this._resumeCount++;
    this._lastResumedAt = new Date().toISOString();
    try {
      this.persistence.writeOrchestrator(this);
    } catch (err) {
      log.warn({
        event: 'persistence.resume_stamp_failed',
        orchId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Internals ---------------------------------------------------------

  private _isActive(s: Session): boolean {
    // S5 — `paused` counts as active: the PTY still exists, the slot in the
    // worker cap is consumed, and pause/resume must not let an operator
    // sneak past `maxWorkersPerOrch`. Treat it the same as running for every
    // active-set computation.
    return (
      s.status === 'running' ||
      s.status === 'starting' ||
      s.status === 'waiting' ||
      s.status === 'paused'
    );
  }

  private _setStatus(s: OrchestratorStatus): void {
    if (this._status === s) return;
    this._status = s;
    eventBus.emitEvent({
      kind: 'orchestrator.updated',
      orchestratorId: this.id,
      payload: { status: s },
    });
    // Phase 4: persist + maybe notify on terminal transitions.
    try {
      this.persistence.writeOrchestrator(this);
    } catch (err) {
      log.warn({
        event: 'persistence.orch_failed',
        orchId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if ((s === 'stopped' || s === 'failed') && !this._endNotified) {
      this._endNotified = true;
      const lead = this.lead;
      const message =
        s === 'stopped'
          ? `Orchestrator ${this.name} stopped cleanly${this._stopReason ? ` (${this._stopReason})` : ''}.`
          : `Orchestrator ${this.name} failed${this._lastError ? `: ${this._lastError}` : ''}.`;
      // Fire-and-forget — `Notifier.notify` already wraps in try/catch and
      // is timeout-bounded, but we wrap once more so a buggy notifier can't
      // crash the orchestrator.
      void this.notifier
        .notify({
          kind: 'orchestrator.ended',
          orchestrator: {
            id: this.id,
            name: this.name,
            role: this.role,
            status: s,
          },
          session: lead
            ? {
                id: lead.id,
                name: lead.name,
                role: lead.role,
                type: lead.type,
                status: lead.status,
                exitCode: lead.exitCode,
                stopReason: lead.stopReason,
              }
            : undefined,
          message,
          extra: {
            exitCode: lead?.exitCode ?? null,
            stopReason: this._stopReason,
          },
        })
        .catch((err) => {
          log.warn({
            event: 'notify.dispatch_failed',
            kind: 'orchestrator.ended',
            orchId: this.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    // KILL UI flow on the lead: hide the whole team once it reaches terminal.
    // Guarded by `_hideRequestFired` so we never invoke the callback twice
    // (a `stopped → failed` re-transition is unlikely but possible if a
    // downstream component reclassifies).
    if (
      (s === 'stopped' || s === 'failed') &&
      this._hideOnExit &&
      !this._hideRequestFired &&
      this._onHideRequested
    ) {
      this._hideRequestFired = true;
      try {
        this._onHideRequested(this.id);
      } catch (err) {
        log.warn({
          event: 'hide_on_exit.callback_failed',
          orchId: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private _onLeadExit(): void {
    if (this._status === 'stopped' || this._status === 'failed') return;
    if (this._status === 'stopping') {
      // Externally-requested shutdown finished cleanly: lead PTY is gone.
      this._setStatus('stopped');
      this._endedAt ??= new Date().toISOString();
      eventBus.emitEvent({
        kind: 'orchestrator.updated',
        orchestratorId: this.id,
        payload: { status: this._status, reason: this._stopReason ?? 'lead-stopped' },
      });
      return;
    }
    // Lead exited on its own — sweep workers, mark stopped.
    this.stop('lead-stopped');
  }

  /**
   * Worker exit handler. Two paths:
   *
   * 1. **Clean / requested stop** (`killed`, `exited`, `interrupted`): drop
   *    the worker's inbox, no notification — the lead asked for this or the
   *    worker said its piece and exited normally.
   * 2. **Abnormal** (`failed`, or `exited` with non-zero code that wasn't
   *    user-initiated): push a synthetic system message into the lead's
   *    inbox describing what happened, including the last 20 lines of the
   *    worker's output ring buffer. Idle-signal the lead so it picks the
   *    message up promptly.
   */
  private _onWorkerExit(worker: Session): void {
    // Always wipe the dead worker's own inbox — nobody's reading it.
    this.mailbox.removeSession(worker.id);

    // KILL UI flow: the operator asked for stop-then-remove in one click. Drop
    // the row from the map now that the PTY is gone (the session is in a
    // terminal status by definition at this point — `_onWorkerExit` only fires
    // after the Session emits its `exit` event). Run before any further checks
    // so the hide happens even when the orchestrator itself is also shutting
    // down (clean cascade).
    if (worker.hideAfterExit) this.hideSession(worker.id);

    const lead = this.lead;
    if (!lead) return; // lead already gone — no point notifying anyone
    if (this._status === 'stopping' || this._status === 'stopped') return;

    const status = worker.status;
    const code = worker.exitCode;
    // Normal-stop path: 'killed' covers both SIGTERM-by-lead and `stop()`-on-self;
    // we ALSO accept 'exited' with code 0 as normal.
    const isClean =
      status === 'killed' ||
      status === 'interrupted' ||
      (status === 'exited' && (code === 0 || code === null));
    if (isClean) return;

    let lastLines = worker.getRecentLines(20).join('\n');
    // Defensive cap on the synthetic message: the worker's last lines could
    // contain very long output (no per-line cap on a PTY). Trim to keep the
    // synthetic message under the user-visible message size cap so the
    // lead's inbox can't be skewed by one runaway worker. We cap with a
    // tail-preserving truncation: the last bytes are the most relevant.
    const headroomBytes = Math.max(512, this.config.maxMessageSizeBytes - 256);
    if (Buffer.byteLength(lastLines, 'utf8') > headroomBytes) {
      // Keep the tail (most recent output) and prepend a marker.
      const buf = Buffer.from(lastLines, 'utf8');
      const tail = buf.subarray(buf.length - headroomBytes).toString('utf8');
      lastLines = `…[truncated]…\n${tail}`;
    }
    const content =
      `worker ${worker.name} (${worker.id}) exited abnormally with exit_code=${code}` +
      `; status=${status}` +
      (lastLines ? `; last 20 lines:\n${lastLines}` : '');

    this.mailbox.push(lead.id, { from: 'system', content });
    emitMailboxMessage(this.id, 'system', lead.id);
    // Idle-signal the lead (best-effort). We bypass `messaging.sendMessage`
    // here to avoid the active-recipient check (the lead is by definition
    // the recipient — and this is server-internal book-keeping anyway).
    try {
      const idleMs = Date.now() - lead.idleSince;
      if (idleMs >= this.config.idleThresholdMs) {
        lead.notifySignal('[swarm-os] new message in inbox — call team.read_inbox to fetch');
      }
    } catch {
      /* best-effort */
    }
    log.warn({
      event: 'worker.exit_anomaly',
      orchId: this.id,
      workerId: worker.id,
      status,
      exitCode: code,
    });

    // Phase 4: in addition to the synthetic mail to the lead, fire a Discord
    // notification so a human can intervene without watching the UI.
    void this.notifier
      .notify({
        kind: 'session.exit_anomaly',
        orchestrator: {
          id: this.id,
          name: this.name,
          role: this.role,
          status: this._status,
        },
        session: {
          id: worker.id,
          name: worker.name,
          role: worker.role,
          type: worker.type,
          status: worker.status,
          exitCode: worker.exitCode,
          stopReason: worker.stopReason,
        },
        message: `Worker ${worker.name} exited abnormally (exit_code=${code}, status=${status}).`,
        extra: { exitCode: code },
      })
      .catch((err) => {
        log.warn({
          event: 'notify.dispatch_failed',
          kind: 'session.exit_anomaly',
          workerId: worker.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
