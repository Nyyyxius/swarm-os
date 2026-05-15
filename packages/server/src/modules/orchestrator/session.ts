import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type AgentProcess,
  type AgentExitInfo,
  type Disposable,
  PtyAgentProcess,
} from './agent-process.js';
import { eventBus } from '../../events.js';
import type { EffortLevel, PermissionMode } from '../../config.js';

const LOG_CAP_BYTES = 50 * 1024 * 1024; // 50 MB per plan §15
const RING_BUFFER_LINES = 200;

export type SessionType = 'lead' | 'worker';
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'exited'
  | 'killed'
  | 'interrupted'
  | 'failed';

export interface SessionInit {
  orchestratorId: string;
  name: string;
  role: string;
  type: SessionType;
  cwd: string;
  initialPrompt: string | null;
  preamble: string | null;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  logsDir: string; // <dataDir>/logs
  claudeBin?: string;
  /** Skip the actual claude CLI spawn — useful for smoke testing without claude. */
  skipSpawn?: boolean;
  /** Inject a preconstructed AgentProcess (tests). */
  agentProcessOverride?: AgentProcess;
}

export interface SessionView {
  id: string;
  orchestratorId: string;
  name: string;
  role: string;
  type: SessionType;
  cwd: string;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  status: SessionStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  stopReason: string | null;
  logPath: string;
  lastActivityAt: string;
  // sessionSecret intentionally NOT included
}

/** Build the argv for `claude` per Phase 0 bis report. */
export function buildClaudeArgs(opts: {
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  initialPrompt: string | null;
  preamble: string | null;
}): string[] {
  const args: string[] = [
    '--model',
    opts.model,
    '--effort',
    opts.effort,
    '--permission-mode',
    opts.permissionMode,
  ];
  // Phase 1: prepend preamble to the initial prompt if provided.
  // Phase 2 will swap to --append-system-prompt or settings.json for the preamble proper.
  const prompt =
    opts.preamble && opts.initialPrompt
      ? `${opts.preamble}\n\n${opts.initialPrompt}`
      : (opts.initialPrompt ?? opts.preamble ?? null);
  if (prompt) {
    args.push(prompt);
  }
  return args;
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly sessionSecret: string;
  readonly orchestratorId: string;
  readonly name: string;
  readonly role: string;
  readonly type: SessionType;
  readonly cwd: string;
  readonly initialPrompt: string | null;
  readonly model: string;
  readonly effort: EffortLevel;
  readonly permissionMode: PermissionMode;
  readonly logPath: string;
  readonly startedAt: string;

  private _status: SessionStatus = 'starting';
  private _pid: number | null = null;
  private _endedAt: string | null = null;
  private _exitCode: number | null = null;
  private _lastError: string | null = null;
  private _stopReason: string | null = null;
  private _lastActivityAt: string;
  private _idleSince: number; // epoch ms — used by mailbox idle detection (Phase 3)

  private agent: AgentProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private logBytes = 0;
  private readonly ringBuffer: string[] = [];
  private partialLine = '';
  private _stopRequested = false;
  private _killTimer: NodeJS.Timeout | null = null;
  private _agentDataDisp: Disposable | null = null;
  private _agentExitDisp: Disposable | null = null;

  constructor(init: SessionInit) {
    super();
    this.id = crypto.randomUUID();
    this.sessionSecret = crypto.randomUUID();
    this.orchestratorId = init.orchestratorId;
    this.name = init.name;
    this.role = init.role;
    this.type = init.type;
    this.cwd = init.cwd;
    this.initialPrompt = init.initialPrompt;
    this.model = init.model;
    this.effort = init.effort;
    this.permissionMode = init.permissionMode;
    this.startedAt = new Date().toISOString();
    this._lastActivityAt = this.startedAt;
    this._idleSince = Date.now();

    const orchLogDir = path.join(init.logsDir, this.orchestratorId);
    fs.mkdirSync(orchLogDir, { recursive: true });
    this.logPath = path.join(orchLogDir, `${this.id}.log`);

    this._openLog();
    this._spawn(init);
  }

  // --- Public API --------------------------------------------------------

  get status(): SessionStatus {
    return this._status;
  }

  get pid(): number | null {
    return this._pid;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get stopReason(): string | null {
    return this._stopReason;
  }

  get endedAt(): string | null {
    return this._endedAt;
  }

  get lastActivityAt(): string {
    return this._lastActivityAt;
  }

  /** Epoch ms — Phase 3 mailbox idle detection. */
  get idleSince(): number {
    return this._idleSince;
  }

  /** Returns the last N lines from the in-memory ring buffer (Phase 3 crash dump helper). */
  getRecentLines(n = 20): string[] {
    return this.ringBuffer.slice(-Math.max(0, n));
  }

  toView(): SessionView {
    return {
      id: this.id,
      orchestratorId: this.orchestratorId,
      name: this.name,
      role: this.role,
      type: this.type,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      status: this._status,
      pid: this._pid,
      startedAt: this.startedAt,
      endedAt: this._endedAt,
      exitCode: this._exitCode,
      lastError: this._lastError,
      stopReason: this._stopReason,
      logPath: this.logPath,
      lastActivityAt: this._lastActivityAt,
    };
  }

  /** Push human input to the underlying PTY. */
  writeInput(data: string): void {
    if (!this.agent) return;
    this.agent.write(data);
  }

  resize(cols: number, rows: number): void {
    this.agent?.resize(cols, rows);
  }

  /** Subscribe to PTY output. */
  onData(cb: (data: string) => void): Disposable {
    if (!this.agent) {
      return { dispose: () => undefined };
    }
    return this.agent.onData(cb);
  }

  /** Begin shutdown. SIGTERM, then SIGKILL after grace ms if still alive. */
  stop(reason: string, graceMs = 5000): void {
    if (this._status === 'exited' || this._status === 'killed' || this._status === 'failed') {
      return;
    }
    this._stopReason ??= reason;
    // Mark the intent so _handleExit knows this was a user-requested stop,
    // not a crash/natural exit.
    this._stopRequested = true;
    if (!this.agent) {
      this._setStatus('killed');
      this._endedAt ??= new Date().toISOString();
      return;
    }
    try {
      this.agent.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (this._killTimer) {
      // Already armed — caller asked twice. Keep the original timer.
      return;
    }
    const timer = setTimeout(() => {
      try {
        this.agent?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this._killTimer = null;
    }, graceMs);
    // Don't keep the event loop alive just for this timer.
    timer.unref();
    this._killTimer = timer;
  }

  // --- Internals ---------------------------------------------------------

  private _spawn(init: SessionInit): void {
    if (init.skipSpawn) {
      // Smoke / dev mode: write a marker, mark running, no real subprocess.
      this._appendLog(
        `[swarm-os] skipSpawn=true — no claude subprocess started (cwd=${this.cwd})\n`,
      );
      this._setStatus('running');
      return;
    }

    let agent: AgentProcess;
    try {
      if (init.agentProcessOverride) {
        agent = init.agentProcessOverride;
      } else {
        const args = buildClaudeArgs({
          model: this.model,
          effort: this.effort,
          permissionMode: this.permissionMode,
          initialPrompt: this.initialPrompt,
          preamble: init.preamble,
        });
        agent = new PtyAgentProcess({
          command: init.claudeBin ?? 'claude',
          args,
          cwd: this.cwd,
        });
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._setStatus('failed');
      this._endedAt = new Date().toISOString();
      this._appendLog(`[swarm-os] failed to spawn claude: ${this._lastError}\n`);
      eventBus.emitEvent({
        kind: 'session.exited',
        orchestratorId: this.orchestratorId,
        sessionId: this.id,
        payload: { status: this._status, error: this._lastError },
      });
      return;
    }

    this.agent = agent;
    this._pid = agent.pid;
    this._setStatus('running');

    this._agentDataDisp = agent.onData((d) => {
      this._lastActivityAt = new Date().toISOString();
      this._idleSince = Date.now();
      this._appendLog(d);
    });

    this._agentExitDisp = agent.onExit((info) => this._handleExit(info));
  }

  private _handleExit(info: AgentExitInfo): void {
    this._exitCode = info.exitCode;
    this._endedAt = new Date().toISOString();
    if (this._status === 'killed') {
      // already known
    } else if (this._stopRequested) {
      // Stop was user-initiated. Whatever exit code came back, classify as
      // 'killed' (clean shutdown by orchestrator request) so downstream
      // consumers don't confuse it with a crash.
      this._setStatus('killed');
    } else if (info.exitCode === 0) {
      this._setStatus('exited');
    } else {
      this._setStatus('failed');
      this._lastError ??= `exit code ${info.exitCode}${info.signal ? ` signal ${info.signal}` : ''}`;
    }
    this._appendLog(
      `[swarm-os] process exited code=${info.exitCode}${info.signal ? ` signal=${info.signal}` : ''}\n`,
    );
    this._closeLog();
    // Clear the SIGKILL grace timer if it's still armed.
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    // Drop our PTY-side listener disposables (the underlying impl already
    // clears its callback sets on exit, but be explicit for the case where a
    // session is recycled or replaced in tests).
    this._agentDataDisp?.dispose();
    this._agentDataDisp = null;
    this._agentExitDisp?.dispose();
    this._agentExitDisp = null;
    eventBus.emitEvent({
      kind: 'session.exited',
      orchestratorId: this.orchestratorId,
      sessionId: this.id,
      payload: { exitCode: info.exitCode, signal: info.signal, status: this._status },
    });
    this.emit('exit', info);
    // Drop EventEmitter listeners — TerminalRoom registers `.once('exit')` so
    // this is mainly defensive against subscribers that might forget to
    // unregister.
    this.removeAllListeners('exit');
  }

  private _setStatus(s: SessionStatus): void {
    if (this._status === s) return;
    this._status = s;
    eventBus.emitEvent({
      kind: 'session.status_changed',
      orchestratorId: this.orchestratorId,
      sessionId: this.id,
      payload: { status: s },
    });
  }

  private _openLog(): void {
    // Truncate if existing file is over cap (per plan §15).
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > LOG_CAP_BYTES) {
        fs.truncateSync(this.logPath, 0);
      } else {
        this.logBytes = stat.size;
      }
    } catch {
      // file doesn't exist — that's fine
    }
    this.logStream = fs.createWriteStream(this.logPath, { flags: 'a', mode: 0o600 });
  }

  private _appendLog(chunk: string): void {
    // Maintain ring buffer of last RING_BUFFER_LINES lines (in memory only, no secrets).
    this.partialLine += chunk;
    let nl = this.partialLine.indexOf('\n');
    while (nl !== -1) {
      const line = this.partialLine.slice(0, nl);
      this.ringBuffer.push(line);
      if (this.ringBuffer.length > RING_BUFFER_LINES) this.ringBuffer.shift();
      this.partialLine = this.partialLine.slice(nl + 1);
      nl = this.partialLine.indexOf('\n');
    }

    if (!this.logStream) return;
    if (this.logBytes >= LOG_CAP_BYTES) {
      // Drop further writes once cap is hit; truncation happens on next open.
      return;
    }
    try {
      const buf = Buffer.from(chunk, 'utf8');
      this.logStream.write(buf);
      this.logBytes += buf.length;
    } catch {
      /* ignore log write errors */
    }
  }

  private _closeLog(): void {
    try {
      this.logStream?.end();
    } catch {
      /* ignore */
    }
    this.logStream = null;
  }
}
