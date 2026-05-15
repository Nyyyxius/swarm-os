import * as crypto from 'node:crypto';
import { Session, type SessionView } from './session.js';
import { eventBus } from '../../events.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';

export type OrchestratorStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface OrchestratorInit {
  name: string;
  role: string;
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
}

export interface StartOptions {
  /** Skip the actual `claude` spawn — used by smoke test when CLI unavailable. */
  skipSpawn?: boolean;
}

export class Orchestrator {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly defaultModel: string;
  readonly defaultEffort: EffortLevel;
  readonly defaultPermissionMode: PermissionMode;
  readonly leadPreamble: string | null;
  readonly workerPreamble: string | null;
  readonly createdAt: string;

  private _status: OrchestratorStatus = 'starting';
  private _endedAt: string | null = null;
  private _lastError: string | null = null;
  private _leadSessionId: string | null = null;
  private _stopReason: string | null = null;

  /** All sessions, including terminated ones, indexed by id. */
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly init: OrchestratorInit,
    private readonly config: Config,
  ) {
    this.id = crypto.randomUUID();
    this.name = init.name;
    this.role = init.role;
    this.defaultModel = init.defaultModel;
    this.defaultEffort = init.defaultEffort;
    this.defaultPermissionMode = init.defaultPermissionMode;
    this.leadPreamble = init.leadPreamble;
    this.workerPreamble = init.workerPreamble;
    this.createdAt = new Date().toISOString();
  }

  // --- Lifecycle ---------------------------------------------------------

  start(opts: StartOptions = {}): Session {
    if (this._leadSessionId) {
      const existing = this.sessions.get(this._leadSessionId);
      if (existing) return existing;
    }

    const lead = new Session({
      orchestratorId: this.id,
      name: `${this.name}-lead`,
      role: this.role,
      type: 'lead',
      cwd: this.init.lead.cwd,
      initialPrompt: this.init.lead.prompt,
      preamble: this.init.lead.preamble ?? this.leadPreamble,
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
   * Idempotent stop: SIGTERM lead+workers, grace 5s, SIGKILL.
   *
   * Status transitions to 'stopping' immediately. The orchestrator only
   * becomes 'stopped' once the lead's PTY actually exits (which clamps the
   * status update to the real process lifecycle, not the request that asked
   * for it). A safety timer forces the transition after grace + 1s in case
   * the lead exit listener fails to fire.
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
    };
  }

  // --- Internals ---------------------------------------------------------

  private _setStatus(s: OrchestratorStatus): void {
    if (this._status === s) return;
    this._status = s;
    eventBus.emitEvent({
      kind: 'orchestrator.updated',
      orchestratorId: this.id,
      payload: { status: s },
    });
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
}
