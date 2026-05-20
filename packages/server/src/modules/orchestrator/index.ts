import * as crypto from 'node:crypto';
import { Session, type SessionView } from './session.js';
import { Mailbox } from './mailbox.js';
import { buildPreamble } from './preamble.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';
import type { AgentProcess } from './agent-process.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import type { Notifier } from '../notify/index.js';
import { NoOpNotifier } from '../notify/null.js';
import type { Persistence } from './persistence.js';
import { NoOpPersistence } from './persistence.js';

const log = withModule('orchestrator');

export type OrchestratorStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

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
  /** Phase 4: surfaced so UI can show "interrupted (server-restart)" etc. */
  stopReason?: string | null;
}

/** Phase 4: optional dependencies wired by the Spawner. */
export interface OrchestratorDeps {
  notifier?: Notifier;
  persistence?: Persistence;
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
}

export class WorkerCapError extends Error {
  readonly code = 'MAX_WORKERS_PER_ORCH';
  constructor(cap: number) {
    super(`max workers per orchestrator (${cap}) reached`);
    this.name = 'WorkerCapError';
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

  readonly notifier: Notifier;
  readonly persistence: Persistence;

  /** All sessions, including terminated ones, indexed by id. */
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly init: OrchestratorInit,
    private readonly config: Config,
    deps: OrchestratorDeps = {},
  ) {
    this.id = crypto.randomUUID();
    this.name = init.name;
    this.role = init.role;
    this.roleId = init.roleId ?? null;
    this.defaultModel = init.defaultModel;
    this.defaultEffort = init.defaultEffort;
    this.defaultPermissionMode = init.defaultPermissionMode;
    this.leadPreamble = init.leadPreamble;
    this.workerPreamble = init.workerPreamble;
    this.createdAt = new Date().toISOString();
    this.mailbox = new Mailbox({ maxSize: this.config.maxInboxSize });
    this.notifier = deps.notifier ?? new NoOpNotifier();
    this.persistence = deps.persistence ?? new NoOpPersistence();
  }

  /** Public Phase 4 accessor — needed by persistence to write `stop_reason`. */
  get stopReason(): string | null {
    return this._stopReason;
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
    const sessionId = crypto.randomUUID();
    const preambleText = buildPreamble({
      identity: {
        name: spec.name,
        role: spec.role,
        sessionId,
        orchName: this.name,
      },
      isLead: false,
      customOverride: spec.preamble ?? this.workerPreamble,
    });

    const worker = new Session({
      id: sessionId,
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

  toView(): OrchestratorView {
    return {
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
      sessions: this.listSessions().map((s) => s.toView()),
      stopReason: this._stopReason,
    };
  }

  // --- Internals ---------------------------------------------------------

  private _isActive(s: Session): boolean {
    return s.status === 'running' || s.status === 'starting' || s.status === 'waiting';
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
