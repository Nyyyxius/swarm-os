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
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
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

/**
 * Build the single remote-command string ssh runs on the host. Wrapped in
 * `bash -lc '<…>'` (login shell) so the host user's PATH is set up and binaries
 * from `~/.local/bin` resolve — consistent with the agent transport. `exec`
 * replaces the login shell with the target program so there is no lingering
 * intermediate shell. Every token is `shellQuote`d.
 */
export function buildRemoteCommand(config: Config, argv: readonly string[], cwd?: string): string {
  const remoteArgv = argv.map((a) => shellQuote(a)).join(' ');
  const inner =
    cwd !== undefined
      ? `cd ${shellQuote(translateCwdForHost(config, cwd))} && exec ${remoteArgv}`
      : `exec ${remoteArgv}`;
  return `bash -lc ${shellQuote(inner)}`;
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

  const sshArgs = [...buildSshBaseArgs(config), buildRemoteCommand(config, input.argv, input.cwd)];

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
