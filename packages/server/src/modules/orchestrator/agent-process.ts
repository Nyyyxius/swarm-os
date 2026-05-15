import * as pty from 'node-pty';

export interface AgentExitInfo {
  exitCode: number;
  signal?: number | undefined;
}

export interface Disposable {
  dispose(): void;
}

/**
 * Abstraction over a PTY-backed agent process.
 *
 * Two implementations are provided:
 *  - `PtyAgentProcess` (real, uses `node-pty`)
 *  - `FakeAgentProcess` (Phase 7 will flesh this out — for Phase 1 it is a stub
 *     with the right shape so tests/mocks can attach later).
 */
export interface AgentProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals | number): void;
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (info: AgentExitInfo) => void): Disposable;
}

export interface SpawnAgentOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export class PtyAgentProcess implements AgentProcess {
  private readonly proc: pty.IPty;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(info: AgentExitInfo) => void>();
  private exited = false;

  constructor(opts: SpawnAgentOptions) {
    this.proc = pty.spawn(opts.command, [...opts.args], {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });

    this.proc.onData((d) => {
      for (const cb of this.dataListeners) {
        try {
          cb(d);
        } catch (err) {
          // Never let a bad listener kill the PTY pump.
          console.error('[swarm-os] agent onData listener threw:', err);
        }
      }
    });
    this.proc.onExit((info) => {
      this.exited = true;
      const out: AgentExitInfo = {
        exitCode: info.exitCode,
        signal: info.signal ?? undefined,
      };
      for (const cb of this.exitListeners) {
        try {
          cb(out);
        } catch (err) {
          console.error('[swarm-os] agent onExit listener threw:', err);
        }
      }
      this.dataListeners.clear();
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  write(data: string): void {
    if (this.exited) return;
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    } catch {
      /* ignore resize errors after exit */
    }
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      // node-pty accepts signal as string; numeric signals are uncommon. Default SIGTERM.
      const sig: string =
        typeof signal === 'number'
          ? `SIG${signal}`
          : ((signal ?? 'SIGTERM') as unknown as string);
      this.proc.kill(sig);
    } catch (err) {
      console.error('[swarm-os] kill failed:', err);
    }
  }

  onData(cb: (data: string) => void): Disposable {
    this.dataListeners.add(cb);
    return { dispose: () => this.dataListeners.delete(cb) };
  }

  onExit(cb: (info: AgentExitInfo) => void): Disposable {
    if (this.exited) {
      // Late subscriber — fire synchronously? Better to schedule.
      setImmediate(() => cb({ exitCode: 0 }));
      return { dispose: () => undefined };
    }
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }
}

/**
 * Stub fake implementation. Phase 7 will turn this into a deterministic
 * scriptable agent for tests; for Phase 1 this exists only so the rest of
 * the codebase can depend on the abstraction without importing node-pty
 * in non-runtime contexts.
 *
 * TODO(phase-7): implement scriptable output, exit codes, idle/active modes.
 */
export class FakeAgentProcess implements AgentProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(info: AgentExitInfo) => void>();
  private _pid = 1; // placeholder
  private exited = false;

  constructor(_opts: SpawnAgentOptions) {
    // intentionally unused in Phase 1
  }

  get pid(): number {
    return this._pid;
  }

  write(_data: string): void {
    // no-op
  }

  resize(_cols: number, _rows: number): void {
    // no-op
  }

  kill(_signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    this.exited = true;
    const info: AgentExitInfo = { exitCode: 143, signal: 15 };
    for (const cb of this.exitListeners) cb(info);
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  onData(cb: (data: string) => void): Disposable {
    this.dataListeners.add(cb);
    return { dispose: () => this.dataListeners.delete(cb) };
  }

  onExit(cb: (info: AgentExitInfo) => void): Disposable {
    if (this.exited) {
      setImmediate(() => cb({ exitCode: 0 }));
      return { dispose: () => undefined };
    }
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }

  /** Test helper — emit data as if the underlying process produced it. */
  _emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data);
  }
}
