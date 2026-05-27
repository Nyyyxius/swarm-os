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

/**
 * Shell-escape a single arg into a `bash -lc`-safe single-quoted token.
 *
 * SSH transports the remote command as a single string that the remote login
 * shell parses, so every argv element we want to survive intact (cwd path,
 * env values, --mcp-config=<path>, the preamble + prompt blob with newlines)
 * must be quoted defensively.
 *
 * Strategy: wrap in single quotes; any embedded single quote becomes the
 * sequence `'\''` (close quote, escaped quote, reopen quote). This is the
 * standard POSIX-safe form.
 */
export function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface SshAgentOptions {
  /** SSH destination, e.g. `ubuntu@host.docker.internal`. */
  sshTarget: string;
  /** Path to the SSH private key inside this process' filesystem. */
  sshKey: string;
  /** SSH port on the host. Default 22. */
  sshPort?: number;
  /** Host-side directory the remote shell should `cd` into before exec. */
  remoteCwd: string;
  /** Env vars to set on the remote side, e.g. `CLAUDE_CONFIG_DIR=<host-path>`. */
  remoteEnv?: Record<string, string>;
  /** Remote binary to invoke, e.g. `claude`. */
  remoteCommand: string;
  /** Args for the remote binary (claude flags + prompt). */
  args: readonly string[];
  cols?: number;
  rows?: number;
  /**
   * Container-side port that the remote claude needs to reach back through SSH.
   * Set up as `ssh -R <port>:127.0.0.1:<port>` so the host's loopback
   * `127.0.0.1:<port>` tunnels back into the container's namespace. Used by
   * the team-comms MCP server (default 8788) which binds container loopback
   * only (plan §14). Set to 0 / omit to skip the reverse forward.
   */
  reverseTunnelPort?: number;
}

/**
 * `AgentProcess` that runs the remote `claude` binary on the host via SSH.
 *
 * Implementation:
 *   - `node-pty.spawn('ssh', [...])` with `-tt` to force PTY allocation on
 *     the remote side (preserves Claude's TTY-aware behavior + lets us route
 *     signals like SIGSTOP/SIGCONT through the local ssh's PTY).
 *   - The remote command is `cd <cwd> && exec <env vars> <cmd> <args...>`,
 *     all single-quoted defensively (the remote shell parses one string).
 *   - `kill(signal)` targets the local `ssh` process; SSH propagates the
 *     equivalent to the remote PTY session (SIGTERM closes the channel,
 *     SIGSTOP/SIGCONT freeze/unfreeze the local ssh — works for the
 *     swarm-os pause UX, which only needs the orchestrator to stop reading
 *     output, not strictly the remote process to be SIGSTOPped).
 */
export class SshAgentProcess implements AgentProcess {
  private readonly proc: pty.IPty;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(info: AgentExitInfo) => void>();
  private exited = false;

  constructor(opts: SshAgentOptions) {
    const sshArgs: string[] = [
      '-tt',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=/tmp/swarm-os-known-hosts',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=4',
      // ControlMaster multiplexing: every session SSH command shares a single
      // TCP connection + auth handshake to the host. The first session sets
      // up the connection + reverse forward; subsequent sessions piggyback
      // via the control socket. ControlPersist=600 keeps the master alive
      // long enough that a new session arriving moments after the previous
      // one ended still finds the tunnel up.
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/swarm-os-ssh-mux-${opts.sshTarget.replace(/[^a-zA-Z0-9]/g, '_')}.sock`,
      '-o', 'ControlPersist=600',
      // Don't kill the session if the -R forward can't be set up (typical
      // when the master already has it bound). The session connects via the
      // existing master, which already routes the tunnel.
      '-o', 'ExitOnForwardFailure=no',
      '-i', opts.sshKey,
      '-p', String(opts.sshPort ?? 22),
    ];
    if (opts.reverseTunnelPort && opts.reverseTunnelPort > 0) {
      sshArgs.push('-R', `${opts.reverseTunnelPort}:127.0.0.1:${opts.reverseTunnelPort}`);
    }
    sshArgs.push(opts.sshTarget, '--');

    // Build the remote command. `exec` replaces the login shell with claude so
    // signals delivered to the SSH server's child go directly to claude.
    //
    // Wrap in `bash -lc '<…>'` so the remote `~/.profile` / `~/.bashrc` runs
    // and `claude` resolves on PATH (typical user installs land in
    // `~/.local/bin` which is NOT in the non-login PATH SSH defaults to).
    const envParts: string[] = [];
    for (const [k, v] of Object.entries(opts.remoteEnv ?? {})) {
      envParts.push(`${k}=${shellQuote(v)}`);
    }
    const remoteArgv = [opts.remoteCommand, ...opts.args].map(shellQuote).join(' ');
    const envPrefix = envParts.length > 0 ? `env ${envParts.join(' ')} ` : '';
    const inner = `cd ${shellQuote(opts.remoteCwd)} && exec ${envPrefix}${remoteArgv}`;
    const remoteCmd = `bash -lc ${shellQuote(inner)}`;

    sshArgs.push(remoteCmd);

    this.proc = pty.spawn('ssh', sshArgs, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      // Local cwd of the ssh process is irrelevant; use /tmp to avoid any
      // accidental dependency on the container's working dir.
      cwd: '/tmp',
      env: { ...process.env },
    });

    this.proc.onData((d) => {
      for (const cb of this.dataListeners) {
        try {
          cb(d);
        } catch (err) {
          log.error({
            event: 'ssh_agent.onData_listener_failed',
            error: err instanceof Error ? err.message : String(err),
          });
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
          log.error({
            event: 'ssh_agent.onExit_listener_failed',
            error: err instanceof Error ? err.message : String(err),
          });
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
      const sig: string =
        typeof signal === 'number'
          ? `SIG${signal}`
          : ((signal ?? 'SIGTERM') as unknown as string);
      this.proc.kill(sig);
    } catch (err) {
      log.error({
        event: 'ssh_agent.kill_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  /**
   * S5 — public test-only log of every kill(signal) the orchestrator
   * requested. Tests assert on `signals` to verify SIGSTOP / SIGCONT actually
   * landed without having to spy on the kill() call directly.
   */
  readonly signals: string[] = [];

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
    const sig = typeof signal === 'string' ? signal : 'SIGTERM';
    this.signals.push(sig);
    // S5 — SIGSTOP / SIGCONT must NOT exit the fake process. On a real PTY
    // SIGSTOP freezes the process (it stays alive, just suspended) and
    // SIGCONT wakes it back up. Without this branch, calling pause() on a
    // FakeAgentProcess-backed Session would synthesize an exit immediately,
    // making every pause/resume test a false positive.
    if (sig === 'SIGSTOP' || sig === 'SIGCONT') return;
    this.exited = true;
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
