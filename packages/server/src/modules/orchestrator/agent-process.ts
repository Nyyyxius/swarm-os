import * as pty from 'node-pty';
import { withModule } from '../../logger.js';

const log = withModule('agent-process');

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
          log.error({ event: 'agent.onData_listener_failed', error: err instanceof Error ? err.message : String(err) });
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
          log.error({ event: 'agent.onExit_listener_failed', error: err instanceof Error ? err.message : String(err) });
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
      log.error({ event: 'agent.kill_failed', error: err instanceof Error ? err.message : String(err) });
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
 * Deterministic fake `AgentProcess` for Phase 3 tests + verify scripts.
 *
 * - `_emitData(text)` lets a test pretend the underlying claude printed.
 * - Every write the orchestrator made into the PTY is recorded in `writes`
 *   so a test can assert that the mailbox PTY signal actually arrived.
 * - `_simulateExit({ exitCode, signal })` reproduces a crash WITHOUT going
 *   through `kill()` — the Session distinguishes user-requested stops from
 *   crashes via `_stopRequested`, so we have to bypass `kill()` to drive
 *   the worker-exit-anomaly path.
 */
export interface FakeAgentOptions extends SpawnAgentOptions {
  pid?: number;
}

export class FakeAgentProcess implements AgentProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(info: AgentExitInfo) => void>();
  private _pid: number;
  private exited = false;
  /** Public test-only history of every write() the orchestrator made. */
  readonly writes: string[] = [];

  constructor(opts: FakeAgentOptions) {
    this._pid = opts.pid ?? 1;
  }

  get pid(): number {
    return this._pid;
  }

  write(data: string): void {
    if (this.exited) return;
    this.writes.push(data);
  }

  resize(_cols: number, _rows: number): void {
    // no-op
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    this.exited = true;
    const sig = typeof signal === 'string' ? signal : 'SIGTERM';
    const info: AgentExitInfo =
      sig === 'SIGKILL' ? { exitCode: 137, signal: 9 } : { exitCode: 143, signal: 15 };
    setImmediate(() => {
      for (const cb of this.exitListeners) {
        try {
          cb(info);
        } catch (err) {
          log.error({ event: 'fake_agent.exit_cb_failed', error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.dataListeners.clear();
      this.exitListeners.clear();
    });
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

  /**
   * Test helper — simulate an arbitrary exit (e.g. crash with non-zero
   * code) WITHOUT going through `kill()`.
   */
  _simulateExit(info: AgentExitInfo): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => {
      for (const cb of this.exitListeners) {
        try {
          cb(info);
        } catch (err) {
          log.error({ event: 'fake_agent.exit_cb_failed', error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.dataListeners.clear();
      this.exitListeners.clear();
    });
  }
}
