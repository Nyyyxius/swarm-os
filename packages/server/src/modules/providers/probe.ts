/**
 * `probeCliBinary` — the one way an adapter answers "is my CLI usable, from
 * where the agents actually run?".
 *
 * Two transports, one contract:
 *   - `local`: `spawnSync(<binary>, ['--version'])` in OUR namespace. The agent
 *     would be spawned by `PtyAgentProcess` from the same PATH, so a hit here
 *     is a hit there.
 *   - `ssh`:   the same argv through `modules/orchestrator/ssh-exec.ts`, which
 *     reuses the agent transport's ControlMaster mux, key and port. Crucially
 *     it runs under `bash -lc`, i.e. the host LOGIN shell — the same resolution
 *     the agent PTY gets. A `claude` installed under `~/.local/bin` or a node
 *     version manager is found here and would be found there; probing with a
 *     bare `ssh <target> claude --version` would not be equivalent.
 *
 * Never throws. Every failure becomes `{ available: false, reason }` with a
 * reason an operator can act on, because that string is what the UI shows next
 * to a greyed-out provider.
 */

import { spawnSync } from 'node:child_process';
import { hostExec } from '../orchestrator/ssh-exec.js';
import type { ProviderAvailability, ProviderProbeContext } from './types.js';

/** Default budget for one probe. The cache's own deadline is what bounds a request. */
export const PROBE_DEFAULT_TIMEOUT_MS = 5_000;

export interface ProbeCliOptions extends ProviderProbeContext {
  /** Binary resolved on PATH (locally, or through the host login shell). */
  binary: string;
  /** Args that make it print a version and exit. Defaults to `['--version']`. */
  versionArgs?: readonly string[];
}

/**
 * First non-empty line, trimmed and clipped. CLIs print anything from
 * `1.2.3 (Claude Code)` to a three-line banner; we keep one line so the UI can
 * render it inline.
 */
function firstLine(out: string): string | undefined {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 120) : undefined;
}

export async function probeCliBinary(opts: ProbeCliOptions): Promise<ProviderAvailability> {
  const args = [...(opts.versionArgs ?? ['--version'])];
  const timeoutMs = opts.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;

  if (opts.transport === 'ssh') {
    if (opts.config.agentTransport !== 'ssh' || !opts.config.sshTarget) {
      return {
        available: false,
        reason: 'ssh transport requested but SWARM_OS_SSH_TARGET is not configured',
      };
    }
    try {
      const res = await hostExec(opts.config, {
        argv: [opts.binary, ...args],
        timeoutMs,
      });
      if (res.timedOut) {
        return {
          available: false,
          reason: `\`${opts.binary} ${args.join(' ')}\` timed out after ${timeoutMs} ms on ${opts.config.sshTarget}`,
        };
      }
      if (res.code !== 0) {
        const detail = firstLine(res.stderr) ?? firstLine(res.stdout) ?? `exit ${res.code}`;
        return {
          available: false,
          reason: `\`${opts.binary}\` not usable on ${opts.config.sshTarget}: ${detail}`,
        };
      }
      const version = firstLine(res.stdout) ?? firstLine(res.stderr);
      return version ? { available: true, version } : { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `ssh probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Local transport. `spawnSync` (not `exec`) so no shell is involved: the
  // binary name is never interpreted, matching how `PtyAgentProcess` launches.
  try {
    const res = spawnSync(opts.binary, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          available: false,
          reason: `\`${opts.binary}\` is not on PATH in this container`,
        };
      }
      return { available: false, reason: `${opts.binary}: ${res.error.message}` };
    }
    if (res.status !== 0) {
      const detail =
        firstLine(res.stderr ?? '') ?? firstLine(res.stdout ?? '') ?? `exit ${res.status}`;
      return { available: false, reason: `\`${opts.binary}\` not usable: ${detail}` };
    }
    const version = firstLine(res.stdout ?? '') ?? firstLine(res.stderr ?? '');
    return version ? { available: true, version } : { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
