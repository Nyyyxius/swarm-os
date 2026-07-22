/**
 * `ssh-exec` — run a one-shot, non-interactive command on the HOST via SSH.
 *
 * Two consumers share this module:
 *   - `ai/improve-via-ssh.ts` (runs `claude -p …` on the host);
 *   - the plugin `api.host.exec` façade (capability `host-exec`).
 *
 * Both need the SAME connection mechanics as the agent PTY transport
 * (`SshAgentProcess`): the ControlMaster mux, the known-hosts file, the keep-
 * alive probes and the private key / port from `Config`. `buildSshBaseArgs`
 * factors those out so there is a single source of truth. Unlike the PTY
 * transport this path uses **no `-tt`** — a plain exec channel with piped
 * stdio, never a remote PTY.
 *
 * ⚠️ Correctness: ssh hands the remote command to the host login shell as ONE
 * string. Every `argv` element (and the `cwd`) is `shellQuote`d before it is
 * spliced in, so an argument containing spaces, single quotes or shell
 * metacharacters can never break out of its token. See `agent-process.shellQuote`.
 *
 * ⚠️ Timeout termination: without a PTY, and with the ControlMaster mux keeping
 * the master connection alive, killing the LOCAL `ssh` client does NOT stop the
 * remote process — it is reparented under the surviving master and runs to
 * completion (e.g. a `sleep 600` would outlive a 5 s timeout by ~595 s). So the
 * `host.exec` path wraps the remote command in the host's `timeout(1)`
 * (coreutils): the HOST terminates the process itself (SIGTERM, then SIGKILL
 * after a short grace). The local SIGKILL is retained as a backstop and remains
 * the authority that flips `timedOut` (its window is <= the remote one).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import { shellQuote } from './agent-process.js';
import { toHostPath } from './path-translate.js';

/** Default per-call wall-clock timeout when the caller omits `timeoutMs`. */
export const HOST_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
/** Hard ceiling on `timeoutMs` — a plugin may not hold a host process forever. */
export const HOST_EXEC_MAX_TIMEOUT_MS = 120_000;
/** Default per-stream capture cap when the caller omits `maxOutputBytes`. */
export const HOST_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
/** Hard ceiling on `maxOutputBytes` — bounds the server's memory per call. */
export const HOST_EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB
/**
 * Grace between the host `timeout`'s SIGTERM and its SIGKILL (`--kill-after`).
 * A well-behaved program dies on SIGTERM immediately; this only bounds how long
 * a signal-ignoring program can cling on before the host force-kills it.
 */
export const HOST_EXEC_KILL_GRACE_S = 5;

export interface HostExecInput {
  /** Program + args. Non-empty; element 0 is the binary (resolved on the host PATH). */
  argv: string[];
  /** Working directory ON THE HOST. Container `/workspace` + `/data` paths are translated. */
  cwd?: string;
  /** Wall-clock timeout in ms. Default 30 000, capped at 120 000. */
  timeoutMs?: number;
  /** Per-stream capture cap in bytes. Default 1 MiB, capped at 8 MiB. */
  maxOutputBytes?: number;
}

export interface HostExecResult {
  /** Process exit code, or `null` when the process was terminated by a signal (incl. timeout). */
  code: number | null;
  /** Captured stdout (utf8), truncated to `maxOutputBytes` with a marker suffix. */
  stdout: string;
  /** Captured stderr (utf8), truncated to `maxOutputBytes` with a marker suffix. */
  stderr: string;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

/** Optional injection seam — tests pass a `spawnImpl` double; production uses `child_process.spawn`. */
export interface HostExecDeps {
  spawnImpl?: typeof spawn;
}

/**
 * The connection-option prefix shared by every non-interactive host exec. Ends
 * with `<sshTarget> --`; the caller appends its single remote-command string.
 * Mirrors `SshAgentProcess`'s option block MINUS the PTY (`-tt`) and the
 * reverse tunnel (only the agent transport needs those).
 */
export function buildSshBaseArgs(config: Config): string[] {
  if (!config.sshTarget) throw new Error('sshTarget is null');
  const muxKey = config.sshTarget.replace(/[^a-zA-Z0-9]/g, '_');
  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/tmp/swarm-os-known-hosts',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=/tmp/swarm-os-ssh-mux-${muxKey}.sock`,
    '-o', 'ControlPersist=600',
    '-o', 'ExitOnForwardFailure=no',
    '-i', config.sshKey,
    '-p', String(config.sshPort),
    config.sshTarget,
    '--',
  ];
}

/**
 * Translate a plugin-supplied cwd into a path the HOST shell can resolve. A
 * plugin runs in-process (container namespace) and naturally thinks in
 * container paths, but the remote shell resolves everything in the host
 * namespace. We reuse `toHostPath` as a prefix-replacer — exactly as
 * `session.ts` does for the agent cwd:
 *   - under `workspaceRoot` (`/workspace`) → `hostWorkspaceRoot`;
 *   - under `dataDir` (`/data`)            → `hostDataDir`;
 *   - anything else is assumed to be a host-native path and passed through.
 * In `ssh` transport `hostWorkspaceRoot`/`hostDataDir` are guaranteed non-null
 * by config validation, so the guards below are belt-and-suspenders.
 */
export function translateCwdForHost(config: Config, cwd: string): string {
  if (
    config.hostWorkspaceRoot &&
    (cwd === config.workspaceRoot || cwd.startsWith(config.workspaceRoot + path.sep))
  ) {
    return toHostPath({
      containerPath: cwd,
      dataDir: config.workspaceRoot,
      hostDataDir: config.hostWorkspaceRoot,
    });
  }
  if (
    config.hostDataDir &&
    (cwd === config.dataDir || cwd.startsWith(config.dataDir + path.sep))
  ) {
    return toHostPath({
      containerPath: cwd,
      dataDir: config.dataDir,
      hostDataDir: config.hostDataDir,
    });
  }
  return cwd;
}

export interface RemoteCommandOptions {
  /** Working directory on the host (translated from container paths by the caller path). */
  cwd?: string;
  /**
   * When set, the remote command is wrapped in the host's `timeout(1)` so the
   * HOST terminates it after ~`ceil(timeoutMs/1000)`s (SIGTERM, then SIGKILL
   * after `HOST_EXEC_KILL_GRACE_S`). Guarantees the remote process dies even
   * though killing the local ssh client does not (no PTY + ControlMaster mux).
   */
  timeoutMs?: number;
}

/**
 * Build the single remote-command string ssh runs on the host. The program is
 * wrapped in `bash -lc '<…>'` (login shell) so the host user's PATH is set up
 * and binaries from `~/.local/bin` resolve — consistent with the agent
 * transport. `exec` replaces the login shell with the target program so there
 * is no lingering intermediate shell (and the host `timeout` signals the real
 * program directly). Every token is `shellQuote`d.
 *
 * With `timeoutMs`, the whole thing is prefixed with `timeout --kill-after=<g>s
 * <n>s …` (coreutils) so the process is terminated ON THE HOST — the local ssh
 * kill alone cannot stop a remote process reparented under the ControlMaster
 * mux. `timeout` (`/usr/bin/timeout`) resolves on the sshd default PATH.
 */
export function buildRemoteCommand(
  config: Config,
  argv: readonly string[],
  opts: RemoteCommandOptions = {},
): string {
  const remoteArgv = argv.map((a) => shellQuote(a)).join(' ');
  const inner =
    opts.cwd !== undefined
      ? `cd ${shellQuote(translateCwdForHost(config, opts.cwd))} && exec ${remoteArgv}`
      : `exec ${remoteArgv}`;
  const bashCmd = `bash -lc ${shellQuote(inner)}`;
  if (opts.timeoutMs === undefined) return bashCmd;
  const durationS = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  return `timeout --kill-after=${HOST_EXEC_KILL_GRACE_S}s ${durationS}s ${bashCmd}`;
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined) return HOST_EXEC_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(ms)), HOST_EXEC_MAX_TIMEOUT_MS);
}

function clampMaxOutput(bytes: number | undefined): number {
  if (bytes === undefined) return HOST_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(Math.max(1, Math.floor(bytes)), HOST_EXEC_MAX_OUTPUT_BYTES);
}

/** Byte-bounded capture sink for one stdio stream. */
function makeSink(maxBytes: number): {
  push(chunk: Buffer): void;
  result(): string;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      if (truncated) return;
      if (total + chunk.length <= maxBytes) {
        chunks.push(chunk);
        total += chunk.length;
        return;
      }
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
    },
    result(): string {
      const text = Buffer.concat(chunks).toString('utf8');
      return truncated ? `${text}\n[output truncated at ${maxBytes} bytes]` : text;
    },
  };
}

/**
 * Run `argv` on the host over SSH and resolve with the captured result. Rejects
 * only for a hard infrastructure failure (transport not `ssh`, or the local
 * `ssh` binary failing to spawn). A remote non-zero exit is a NORMAL result
 * (`code` set, promise resolves). A timeout kills the local ssh process and
 * resolves with `timedOut: true`.
 */
export async function hostExec(
  config: Config,
  input: HostExecInput,
  deps: HostExecDeps = {},
): Promise<HostExecResult> {
  if (config.agentTransport !== 'ssh') {
    throw new Error(
      'host-exec requires the ssh agent transport (SWARM_OS_AGENT_TRANSPORT=ssh)',
    );
  }
  if (!config.sshTarget) {
    throw new Error('host-exec requires the ssh agent transport (sshTarget is not configured)');
  }
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw new Error('host-exec: argv must be a non-empty array');
  }

  const timeoutMs = clampTimeout(input.timeoutMs);
  const maxOutputBytes = clampMaxOutput(input.maxOutputBytes);
  const spawnImpl = deps.spawnImpl ?? spawn;

  const sshArgs = [
    ...buildSshBaseArgs(config),
    buildRemoteCommand(config, input.argv, { cwd: input.cwd, timeoutMs }),
  ];

  return await new Promise<HostExecResult>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      // No PTY: plain pipes, stdin closed (never interactive).
      proc = spawnImpl('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const stdout = makeSink(maxOutputBytes);
    const stderr = makeSink(maxOutputBytes);
    let timedOut = false;
    let settled = false;

    // Local backstop: kill the ssh client and flip `timedOut`. The remote
    // `timeout(1)` wrapper (see buildRemoteCommand) is what actually terminates
    // the process ON THE HOST; this local kill just stops us waiting and is the
    // authority for `timedOut` (its window <= the remote one).
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();

    proc.stdout?.on('data', (d: Buffer) => stdout.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderr.push(d));

    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.result(),
        stderr: stderr.result(),
        timedOut,
      });
    });
  });
}

// ===========================================================================
// Detached host jobs (`api.host.spawnJob` / `jobStatus` / `killJob`)
// ===========================================================================
//
// A host job is a long-running command launched on the HOST and DETACHED from
// the SSH channel: `spawnJob` returns immediately with a `jobId`, the command
// keeps running under `setsid` (its own session), and the caller polls
// `jobStatus` (or `killJob`) later. This is the shape a plugin needs for a
// multi-minute install/provision step that must SURVIVE the caller — and even
// survive a swarm-os restart (the job's bookkeeping lives on the `/data` bind
// mount, readable from BOTH the container and the host).
//
// Why not `hostExec`: `hostExec` runs the command in the FOREGROUND and wraps
// it in the host's `timeout(1)` (§buildRemoteCommand) — it is built to bound a
// short call and KILL the remote process when the SSH client goes away. A job
// is the opposite: it must outlive the client. So we launch it with a clean
// `setsid` template (below) via a SHORT foreground `hostExec` whose only job is
// to fork+detach the real work. `setsid` puts the job in a new session with no
// controlling terminal, so closing the ControlPersist mux never SIGHUPs it.
//
// The pgid — the identity `killJob` signals to reap grandchildren (pip, docker,
// …), not just the top shell — is captured ROBUSTLY: the detached shell is (via
// setsid) its own session leader, so its `$$` == pgid whether or not setsid had
// to fork (it forks when its caller is already a group leader, e.g. under the
// `timeout(1)` wrapper hostExec adds, which puts the launcher in a fresh group).
// So the shell records its OWN `$$` to the `pid` file as its FIRST action, and
// `spawnJob` waits for that file — we never trust the launcher's `$!`, which
// would be the ephemeral setsid parent in the fork case.

/** Subdir under `<dataDir>`/`<hostDataDir>` that holds every job's bookkeeping. */
export const HOST_JOBS_SUBDIR = 'host-jobs';
/** Wall-clock cap for the SHORT foreground exec that launches / probes / kills a job. */
const HOST_JOB_CONTROL_TIMEOUT_MS = 15_000;
/** How long `spawnJob` waits for the detached shell to record its pgid to `pid`. */
const HOST_JOB_PID_WAIT_MS = 5_000;
/** Grace between the process-group SIGTERM and the follow-up SIGKILL in `killJob`. */
const HOST_JOB_KILL_GRACE_S = 2;
/** Default per-stream tail returned by `jobStatus` when the caller omits `tailBytes`. */
export const HOST_JOB_DEFAULT_TAIL_BYTES = 16 * 1024;
/** Hard ceiling on `jobStatus` `tailBytes` — bounds the read + the server's memory. */
export const HOST_JOB_MAX_TAIL_BYTES = 1024 * 1024;

/** Opaque handle returned by `spawnHostJob`. `jobId` is a server-minted UUID. */
export interface HostJobRef {
  jobId: string;
}

/** Snapshot of a host job's liveness + captured output tails. */
export interface HostJobStatus {
  /** True while the job's process group is still alive (no `exit` file yet). */
  running: boolean;
  /** Exit code once the job finished; `null` while running or if it vanished untracked. */
  code: number | null;
  /** Last `tailBytes` of the job's stdout (utf8), with a truncation marker when clipped. */
  stdoutTail: string;
  /** Last `tailBytes` of the job's stderr (utf8), with a truncation marker when clipped. */
  stderrTail: string;
}

/** Input to `spawnHostJob`. */
export interface HostJobSpawnInput {
  /** Program + args. Non-empty; element 0 is the binary (resolved on the host PATH). */
  argv: string[];
  /** Working directory ON THE HOST. Container `/workspace` + `/data` paths are translated. */
  cwd?: string;
}

/** Every host-job path requires the ssh transport (there is no host under `local`). */
function requireHostJobTransport(config: Config): void {
  if (config.agentTransport !== 'ssh' || !config.sshTarget) {
    throw new Error(
      'host jobs require the ssh agent transport (SWARM_OS_AGENT_TRANSPORT=ssh)',
    );
  }
}

/**
 * Build the `setsid` launcher run (once, in the foreground) to detach a job.
 * Pure: `hostJobDir` and `cwd` are ALREADY host-native paths (translated by the
 * caller) so the template can be unit-tested without a `Config`. Every path and
 * argv element is `shellQuote`d.
 *
 * Shape: the detached shell records its OWN pgid (`$$`, valid because setsid
 * made it a session leader) to `pid` FIRST, then runs the real command with
 * stdout/stderr redirected to files, and records the exit code to `exit` — the
 * file `jobStatus` treats as authoritative. The outer `</dev/null >/dev/null
 * 2>&1` detaches the setsid process from the (closing) SSH channel; the trailing
 * `& echo $!` just returns the launcher promptly (its value is unused — see the
 * section header on why `$!` is NOT the job's pgid under the timeout wrapper).
 */
export function buildHostJobLauncher(
  hostJobDir: string,
  argv: readonly string[],
  cwd?: string,
): string {
  const quotedArgv = argv.map((a) => shellQuote(a)).join(' ');
  const jd = shellQuote(hostJobDir);
  const pidF = shellQuote(path.posix.join(hostJobDir, 'pid'));
  const stdoutF = shellQuote(path.posix.join(hostJobDir, 'stdout'));
  const stderrF = shellQuote(path.posix.join(hostJobDir, 'stderr'));
  const exitF = shellQuote(path.posix.join(hostJobDir, 'exit'));
  const cd = cwd !== undefined ? `cd ${shellQuote(cwd)} && ` : '';
  const inner =
    `mkdir -p ${jd} && echo $$ >${pidF} && ` +
    `{ ${cd}{ ${quotedArgv} ; } >${stdoutF} 2>${stderrF}; echo $? >${exitF} ; }`;
  return `setsid bash -c ${shellQuote(inner)} </dev/null >/dev/null 2>&1 & echo $!`;
}

/** Container-side jobdir (on the `/data` bind mount) for a plugin's job. */
function containerJobDir(config: Config, pluginName: string, jobId: string): string {
  return path.join(config.dataDir, HOST_JOBS_SUBDIR, pluginName, jobId);
}

/** Read a whole small bookkeeping file (`pid` / `exit`) or `null` if absent. */
function readJobFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Read the last `maxBytes` of a (possibly large) output file, with a marker when clipped. */
function readTail(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    return start > 0 ? `[…truncated ${start} bytes]\n${text}` : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function clampTailBytes(n: number | undefined): number {
  if (n === undefined) return HOST_JOB_DEFAULT_TAIL_BYTES;
  return Math.min(Math.max(1, Math.floor(n)), HOST_JOB_MAX_TAIL_BYTES);
}

/** Parse the pgid from a `pid` file, or `NaN` if absent/blank/malformed. */
function readPid(dir: string): number {
  const raw = readJobFile(path.join(dir, 'pid'));
  return raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
}

/** Poll the container-side `pid` file until the detached shell records its pgid. */
async function waitForPid(dir: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = readPid(dir);
    if (Number.isInteger(pid) && pid > 0) return pid;
    if (Date.now() >= deadline) return Number.NaN;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Launch `argv` as a DETACHED host job and resolve with its `jobId`. The job
 * outlives this call (and swarm-os itself). Rejects only if the launch itself
 * fails (transport wrong, empty argv, or the job never recorded its pgid within
 * the wait window). The `pid` file (pgid) is written by the detached shell, so
 * once this resolves a later `jobStatus`/`killJob` always finds it.
 */
export async function spawnHostJob(
  config: Config,
  pluginName: string,
  input: HostJobSpawnInput,
  deps: HostExecDeps = {},
): Promise<HostJobRef> {
  requireHostJobTransport(config);
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw new Error('spawnJob: argv must be a non-empty array');
  }
  const jobId = randomUUID();
  const dir = containerJobDir(config, pluginName, jobId);
  // Pre-create the jobdir container-side (on the /data bind mount) so the pid
  // file is visible to us the instant the host shell writes it; the launcher's
  // own `mkdir -p` is belt-and-suspenders.
  fs.mkdirSync(dir, { recursive: true });
  const hostDir = translateCwdForHost(config, dir);
  const hostCwd = input.cwd !== undefined ? translateCwdForHost(config, input.cwd) : undefined;
  const launcher = buildHostJobLauncher(hostDir, input.argv, hostCwd);

  const res = await hostExec(
    config,
    { argv: ['bash', '-c', launcher], timeoutMs: HOST_JOB_CONTROL_TIMEOUT_MS },
    deps,
  );
  if (res.timedOut) {
    throw new Error(`spawnJob: launcher timed out (stderr=${res.stderr.trim().slice(0, 200)})`);
  }
  const pid = await waitForPid(dir, HOST_JOB_PID_WAIT_MS);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `spawnJob: job never recorded a pid (code=${res.code}, ` +
        `stderr=${res.stderr.trim().slice(0, 200)})`,
    );
  }
  return { jobId };
}

/**
 * Report a job's liveness + output tails. The `exit` file is AUTHORITATIVE — a
 * finished job never touches the host again. Only when it is absent do we probe
 * the pid's liveness on the host (`kill -0`); an absent pid with no exit (a host
 * reboot mid-job, or an unknown jobId) is reported as `{running:false, code:null}`
 * rather than trusting a `kill -0` that could hit a reused pid.
 */
export async function hostJobStatus(
  config: Config,
  pluginName: string,
  input: { jobId: string; tailBytes?: number },
  deps: HostExecDeps = {},
): Promise<HostJobStatus> {
  requireHostJobTransport(config);
  const dir = containerJobDir(config, pluginName, input.jobId);
  const tail = clampTailBytes(input.tailBytes);
  const stdoutTail = readTail(path.join(dir, 'stdout'), tail);
  const stderrTail = readTail(path.join(dir, 'stderr'), tail);

  const exitRaw = readJobFile(path.join(dir, 'exit'));
  if (exitRaw !== null && exitRaw.trim().length > 0) {
    const code = Number.parseInt(exitRaw.trim(), 10);
    return { running: false, code: Number.isInteger(code) ? code : null, stdoutTail, stderrTail };
  }

  const pid = readPid(dir);
  if (!Number.isInteger(pid) || pid <= 0) {
    // No pid AND no exit: reboot during the job, or a jobId we never spawned.
    return { running: false, code: null, stdoutTail, stderrTail };
  }
  // `kill -0` as a bash builtin (no dependency on a standalone /bin/kill).
  const probe = await hostExec(
    config,
    { argv: ['bash', '-c', `kill -0 ${pid}`], timeoutMs: HOST_JOB_CONTROL_TIMEOUT_MS },
    deps,
  );
  const running = !probe.timedOut && probe.code === 0;
  return { running, code: null, stdoutTail, stderrTail };
}

/**
 * Terminate a job's whole PROCESS GROUP (SIGTERM, grace, then SIGKILL). Relies
 * on the `setsid` pid==pgid identity so `kill -… -<pid>` reaches grandchildren.
 * Best-effort + idempotent: a missing pid file (never spawned / already reaped)
 * is a no-op, and each signal is `2>/dev/null`'d so an already-dead group never
 * turns into an error.
 */
export async function killHostJob(
  config: Config,
  pluginName: string,
  input: { jobId: string },
  deps: HostExecDeps = {},
): Promise<void> {
  requireHostJobTransport(config);
  const dir = containerJobDir(config, pluginName, input.jobId);
  const pid = readPid(dir);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const cmd =
    `kill -TERM -${pid} 2>/dev/null; sleep ${HOST_JOB_KILL_GRACE_S}; ` +
    `kill -KILL -${pid} 2>/dev/null; true`;
  await hostExec(
    config,
    { argv: ['bash', '-c', cmd], timeoutMs: HOST_JOB_CONTROL_TIMEOUT_MS },
    deps,
  );
}
