/**
 * CronScriptRunner — executes an `action='script'` cron (docs/crons-agents.md §2.5).
 *
 * A script cron exists so the *script* decides whether the agent is worth
 * waking: it polls whatever it polls (Jira, a repo, a queue), prints one JSON
 * line, and only a `{"wake": true}` costs an agent turn. Everything here serves
 * that one contract, plus the containment rules that make running operator code
 * inside the container tolerable.
 *
 * Five decisions worth restating, because each one has a failure mode that is
 * invisible until it bites:
 *
 *  1. **Containment is re-checked at EVERY fire, and the argv uses the realpath
 *     it returns.** Checking at creation only would be defeated by swapping the
 *     file for a symlink afterwards; re-checking but then spawning the ORIGINAL
 *     string would be decorative (classic TOCTOU — resolve, then act on the
 *     unresolved name). `resolveUnderRoots` returns the resolved path and that
 *     is the one that reaches `spawn`.
 *
 *  2. **The interpreter is explicit, never inferred from the `+x` bit.** Mode
 *     bits on a host bind mount, or on a file an agent created in-container
 *     (umask 0644, uid 1000), do not reliably say "executable", and the UI
 *     offers no chmod. An allowlisted `python3|bash|node` in argv[0] is both
 *     predictable and shell-free — there is no shell anywhere on this path, so
 *     a script path or an argument containing `;` is just a string.
 *
 *  3. **`detached: true` + `process.kill(-pid, 'SIGKILL')` at the timeout.**
 *     `execFile`'s own `timeout` sends a single SIGTERM to the direct child
 *     only. The direct child is typically `uv run …`, which spawns a
 *     grandchild; SIGTERM kills the wrapper and leaves the real work running
 *     forever. Spawning into its own process group and killing the GROUP is the
 *     same reasoning as the `setsid` launcher in `orchestrator/ssh-exec.ts`.
 *
 *  4. **The output bound is enforced here, and it is distinguishable from the
 *     timeout.** `graphify.ts:131` shows the trap: it tests `killed/SIGTERM`
 *     first, so a `maxBuffer` overflow is reported as a timeout and the
 *     operator tunes the wrong knob. We count bytes ourselves and carry an
 *     explicit `truncated` flag, checked before the timeout flag.
 *
 *  5. **The environment is built from scratch, not inherited.** This is a
 *     deliberate break with `graphify.ts` / `install-core/fetch.ts`, which
 *     spread `...process.env`: those run OUR code, this runs an OPERATOR's.
 *     `process.env` here holds `SWARM_OS_TOKEN`, the hook token and every
 *     provider API key, and a cron script has no business reading them (§2.5 —
 *     script secrets live in a file under `/data`, read by the script itself).
 *
 * Never throws: every failure comes back as a result object. The caller is a
 * timer callback, and an exception there would take the cadence down.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import { normalizeWorkspaceRelativeCwd, resolveUnderRoots } from '../../http/validation.js';
import { CRON_INTERPRETERS, DEFAULT_CRON_TIMEOUT_MS } from './store.js';

const log = withModule('crons.runner');

/**
 * Cap on captured output, per stream. Aligned with `graphify.ts:33` and
 * `install-core/fetch.ts:64` — the value is arbitrary, the consistency is not.
 */
export const CRON_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** How much of each stream's tail is kept for the run's excerpt. */
const TAIL_CHARS = 2000;

/**
 * Grace between the child's `exit` and giving up on `close`. `close` is the
 * event we want (it means every pipe is drained), but it only fires once ALL
 * stdio holders are gone — a grandchild that outlived its parent and kept the
 * pipe open would otherwise hold the overlap guard forever. Settling with the
 * output collected so far is strictly better than a cron that never runs again.
 */
const CLOSE_GRACE_MS = 2000;

/** Where `uv run --with` caches wheels. See `buildEnv`. */
export function uvCacheDir(dataDir: string): string {
  return path.join(dataDir, 'crons', 'uv-cache');
}

/** What the runner needs to know about this deployment. */
export interface CronScriptPolicy {
  /** Allowed root #1 — the agents' tree. */
  workspaceRoot: string;
  /** Allowed root #2 — `/data`, which agents cannot write (§2.5, recommended). */
  dataDir: string;
  /** `SWARM_OS_SCHEDULE_TZ`, exported to the child as `TZ`. */
  timezone: string;
  /**
   * Agent transport. Under `ssh` the agents display HOST paths, so an operator
   * typing a path into the form is likely to give one that does not exist in
   * the container; a non-container path is then read as workspace-relative
   * (same convenience as the team-creation `cwd` field). Under `local` the
   * displayed paths are already container paths and no guessing is needed.
   */
  transport: 'local' | 'ssh';
  /** Test seam. Defaults to `CRON_MAX_OUTPUT_BYTES`. */
  maxOutputBytes?: number;
}

export interface CronScriptRunInput {
  cronId: string;
  cronName: string;
  /** As stored on the cron — normalised + re-resolved on every call. */
  scriptPath: string;
  interpreter: string;
  args: readonly string[];
  /** `null` → `DEFAULT_CRON_TIMEOUT_MS`. */
  timeoutMs: number | null;
  /** Fire time, exported as `SWARM_OS_FIRE`. */
  firedAt: Date;
}

export interface CronScriptResult {
  /**
   * `true` only when the child ran to completion, exited 0 AND printed a valid
   * `{wake, message?}` line. Everything else (containment refusal, spawn error,
   * non-zero exit, timeout, output overflow, unparseable output) is `false` and
   * becomes an `error` run — a script whose contract is broken must be visible
   * in LAST RUNS, not silently treated as "nothing to do".
   */
  ok: boolean;
  /** The script's verdict. Meaningless unless `ok`. */
  wake: boolean;
  /** Message to deliver; filled with a default when `wake` came without one. */
  message: string | null;
  exitCode: number | null;
  /** stdout/stderr tails (+ the failure reason), for `cron_runs.output_excerpt`. */
  excerpt: string | null;
}

/** Keep the last `TAIL_CHARS` characters, marking the cut. */
function tail(s: string): string {
  const trimmed = s.trimEnd();
  if (trimmed.length <= TAIL_CHARS) return trimmed;
  return `…${trimmed.slice(-TAIL_CHARS)}`;
}

/**
 * Compose the persisted excerpt: the failure reason first (it is what an
 * operator reads), then whatever the streams said. The store clamps the result
 * to `CRON_EXCERPT_MAX_BYTES` — the tails above only keep it from carrying
 * 32 MiB through the call.
 */
function buildExcerpt(reason: string | null, stdout: string, stderr: string): string | null {
  const parts: string[] = [];
  if (reason) parts.push(reason);
  const err = tail(stderr);
  if (err) parts.push(`stderr: ${err}`);
  const out = tail(stdout);
  if (out) parts.push(`stdout: ${out}`);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Last non-empty line of stdout — the only line the contract looks at. */
export function lastNonEmptyLine(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = (lines[i] ?? '').trim();
    if (t.length > 0) return t;
  }
  return null;
}

export interface ParsedVerdict {
  wake: boolean;
  message: string | null;
}

/**
 * Parse the contract line. Strict on purpose: a script that prints anything but
 * `{"wake": …}` on its last line has a bug, and reporting it as `error` (rather
 * than assuming "no wake") is what lets the operator find it.
 */
export function parseVerdict(line: string | null): { ok: true; value: ParsedVerdict } | { ok: false; error: string } {
  if (line == null) {
    return { ok: false, error: 'script printed nothing on stdout (expected a final JSON line {"wake": bool})' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: `last stdout line is not JSON: ${line.slice(0, 200)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `last stdout line is not a JSON object: ${line.slice(0, 200)}` };
  }
  const obj = parsed as { wake?: unknown; message?: unknown };
  if (typeof obj.wake !== 'boolean') {
    return { ok: false, error: 'the JSON output must carry a boolean `wake` field' };
  }
  if (obj.message != null && typeof obj.message !== 'string') {
    return { ok: false, error: '`message` must be a string when present' };
  }
  return { ok: true, value: { wake: obj.wake, message: (obj.message as string | undefined) ?? null } };
}

/** A child still running, tracked so `killAll()` can reach its process group. */
interface InFlightChild {
  cronId: string;
  child: ChildProcess;
  pgid: number;
}

export class CronScriptRunner {
  private readonly policy: CronScriptPolicy;
  /** Live children, keyed by pid — the shutdown registry (§2.5). */
  private readonly children = new Map<number, InFlightChild>();
  private uvCacheReady = false;

  constructor(policy: CronScriptPolicy) {
    this.policy = policy;
  }

  /** The two allowed roots, in the order they are tried. */
  private roots(): string[] {
    return [this.policy.workspaceRoot, this.policy.dataDir];
  }

  /**
   * Normalise + containment-check a script path. Public because the ROUTE calls
   * it at creation time (an operator gets the refusal in the form, not three
   * hours later in a run history) — and the runner calls it again at every
   * fire, because "checked once" is not a security property.
   *
   * Returns the realpath. Throws with a human-readable reason.
   */
  async resolveScriptPath(raw: string): Promise<string> {
    return resolveUnderRoots(this.normalize(raw), this.roots(), {
      label: 'scriptPath',
      rootLabel: 'the workspace or data root',
    });
  }

  /**
   * Container-path guessing, ssh transport only (see `CronScriptPolicy`). A
   * path that already sits under one of the roots is left alone — otherwise
   * `/data/crons/x.py` would be rewritten to `/workspace/data/crons/x.py` and
   * the data root would be unreachable from the form.
   */
  private normalize(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return trimmed;
    if (this.isUnderRootLexically(trimmed)) return trimmed;
    if (this.policy.transport !== 'ssh') return trimmed;
    return normalizeWorkspaceRelativeCwd(trimmed, this.policy.workspaceRoot);
  }

  /** Cheap string prefix test — the REAL check is `resolveUnderRoots`. */
  private isUnderRootLexically(p: string): boolean {
    return this.roots().some((root) => p === root || p.startsWith(root + path.sep));
  }

  /**
   * Environment handed to the script. Explicit allowlist, built from nothing —
   * see decision 5 in the module header.
   */
  private buildEnv(input: CronScriptRunInput): NodeJS.ProcessEnv {
    const home = process.env.HOME ?? '/root';
    const basePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      // `~/.local/bin` is where `uv` installs itself in the image, and a script
      // that shells out to `uv run` would otherwise not find it.
      PATH: `${basePath}:${path.join(home, '.local', 'bin')}`,
      // A UTF-8 locale, or python3 writes `ascii` and dies on the first accented
      // character in a Jira ticket title.
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      // Same timezone the cadence is evaluated in, so a script computing "today"
      // agrees with the schedule that woke it.
      TZ: this.policy.timezone,
      // Without this, `uv run --with requests` re-downloads on EVERY tick: uv's
      // default cache lives in the container's ephemeral layer.
      UV_CACHE_DIR: uvCacheDir(this.policy.dataDir),
      SWARM_OS_CRON_ID: input.cronId,
      SWARM_OS_CRON_NAME: input.cronName,
      SWARM_OS_FIRE: input.firedAt.toISOString(),
    };
    // Proxies are infrastructure, not credentials: a deployment behind a proxy
    // has no other way to let a script reach the network.
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }

  /** Create the uv cache dir once per process. Failure is not fatal. */
  private ensureUvCache(): void {
    if (this.uvCacheReady) return;
    try {
      fs.mkdirSync(uvCacheDir(this.policy.dataDir), { recursive: true });
    } catch (err) {
      log.warn({ event: 'crons.uv_cache_failed', error: String(err) });
    }
    this.uvCacheReady = true;
  }

  /**
   * Run one script cron to completion. Never rejects.
   */
  async run(input: CronScriptRunInput): Promise<CronScriptResult> {
    if (!CRON_INTERPRETERS.includes(input.interpreter)) {
      return fail(`interpreter must be one of ${CRON_INTERPRETERS.join('|')}`);
    }

    let realPath: string;
    try {
      realPath = await this.resolveScriptPath(input.scriptPath);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    this.ensureUvCache();
    const timeoutMs = input.timeoutMs ?? DEFAULT_CRON_TIMEOUT_MS;
    const maxBytes = this.policy.maxOutputBytes ?? CRON_MAX_OUTPUT_BYTES;

    return new Promise<CronScriptResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(input.interpreter, [realPath, ...input.args], {
          // The script's own directory: a script may sit next to its data files
          // and read them by relative path, which is the least surprising cwd.
          cwd: path.dirname(realPath),
          env: this.buildEnv(input),
          // Own process group — this is what makes the timeout able to kill a
          // `uv run` grandchild (decision 3).
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        resolve(fail(spawnErrorMessage(err, input.interpreter)));
        return;
      }

      // No pid means `spawn` already failed and will emit `error` on the next
      // tick (a missing or non-executable interpreter). We must NOT return
      // early here: nothing would be listening for that event, and an
      // unhandled `error` on a ChildProcess takes the whole process down. The
      // handlers below are attached either way, and the run settles through
      // `spawnErrorMessage` like any other failure.
      const pid = child.pid;
      if (pid !== undefined) this.children.set(pid, { cronId: input.cronId, child, pgid: pid });

      let stdout = '';
      let stderr = '';
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let spawnError: string | null = null;
      let settled = false;
      const startedAt = Date.now();

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) this.killGroup(pid);
      }, timeoutMs);
      // Never let a cron's timeout keep the process alive on its own.
      timeoutTimer.unref?.();
      let closeGrace: NodeJS.Timeout | null = null;

      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (closeGrace) clearTimeout(closeGrace);
        if (pid !== undefined) this.children.delete(pid);
        const exitCode = typeof child.exitCode === 'number' ? child.exitCode : null;
        const durationMs = Date.now() - startedAt;

        // ORDER MATTERS (decision 4): an overflow also kills the child, so
        // asking "was it killed?" first would report every overflow as a
        // timeout — the exact bug `graphify.ts:131` carries.
        if (spawnError) {
          resolve({ ok: false, wake: false, message: null, exitCode, excerpt: buildExcerpt(spawnError, stdout, stderr) });
          return;
        }
        if (truncated) {
          resolve({
            ok: false,
            wake: false,
            message: null,
            exitCode,
            excerpt: buildExcerpt(
              `script output exceeded ${maxBytes} bytes — process group killed`,
              stdout,
              stderr,
            ),
          });
          return;
        }
        if (timedOut) {
          resolve({
            ok: false,
            wake: false,
            message: null,
            exitCode,
            excerpt: buildExcerpt(
              `script timed out after ${timeoutMs}ms — process group killed (SIGKILL)`,
              stdout,
              stderr,
            ),
          });
          return;
        }
        if (exitCode !== 0) {
          resolve({
            ok: false,
            wake: false,
            message: null,
            exitCode,
            excerpt: buildExcerpt(
              `script exited with code ${exitCode ?? 'null'}${child.signalCode ? ` (signal ${child.signalCode})` : ''}`,
              stdout,
              stderr,
            ),
          });
          return;
        }

        const verdict = parseVerdict(lastNonEmptyLine(stdout));
        if (!verdict.ok) {
          resolve({ ok: false, wake: false, message: null, exitCode, excerpt: buildExcerpt(verdict.error, stdout, stderr) });
          return;
        }
        log.info({
          event: 'crons.script_done',
          cronId: input.cronId,
          name: input.cronName,
          wake: verdict.value.wake,
          exitCode,
          durationMs,
        });
        resolve({
          ok: true,
          wake: verdict.value.wake,
          // A `wake:true` with nothing to say still has to deliver SOMETHING —
          // an empty inbox message would look like a bug to the agent.
          message: verdict.value.wake
            ? (verdict.value.message ?? `[cron:${input.cronName}] wake requested`)
            : verdict.value.message,
          exitCode,
          excerpt: buildExcerpt(null, stdout, stderr),
        });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxBytes) {
          if (!truncated) {
            truncated = true;
            if (pid !== undefined) this.killGroup(pid);
          }
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > maxBytes) {
          if (!truncated) {
            truncated = true;
            if (pid !== undefined) this.killGroup(pid);
          }
          return;
        }
        stderr += chunk.toString('utf8');
      });
      // A stream error (EPIPE on a killed child) must not reach the process as
      // an unhandled 'error' event.
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});

      child.on('error', (err) => {
        spawnError = spawnErrorMessage(err, input.interpreter);
        settle();
      });
      child.on('exit', () => {
        // Wait for `close` (pipes drained) but not forever — see CLOSE_GRACE_MS.
        closeGrace = setTimeout(settle, CLOSE_GRACE_MS);
        closeGrace.unref?.();
      });
      child.on('close', settle);
    });
  }

  /**
   * SIGKILL a child's whole process group. `-pid` is the group (the child is
   * its own group leader thanks to `detached`), which is the only way to reach
   * a `uv run` grandchild. Best-effort: ESRCH just means it already died.
   */
  private killGroup(pid: number): void {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group may already be gone; fall back to the direct child so a
      // platform without process groups still terminates something.
      try {
        this.children.get(pid)?.child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }

  /**
   * Kill every in-flight script's process group. Called by
   * `CronScheduler.stop()` on shutdown, BEFORE `index.ts` reaches `db.close()`
   * — the scheduler then journals those runs as `error`. Without this a SIGTERM
   * leaves an orphaned script running against a dead server, with no trace in
   * the run history.
   *
   * Returns the cron ids that had a child killed (for logging).
   */
  killAll(): string[] {
    const killed: string[] = [];
    for (const [pid, entry] of this.children) {
      killed.push(entry.cronId);
      this.killGroup(pid);
    }
    this.children.clear();
    if (killed.length > 0) log.info({ event: 'crons.script_killed', crons: killed });
    return killed;
  }

  /** Number of live children — for tests / introspection. */
  get inFlightCount(): number {
    return this.children.size;
  }
}

/** A refusal that never reached `spawn`. */
function fail(reason: string): CronScriptResult {
  return { ok: false, wake: false, message: null, exitCode: null, excerpt: reason };
}

/**
 * Map the two `spawn` errno cases the plan calls out to sentences an operator
 * can act on. Done BEFORE the excerpt is assembled (and so before truncation),
 * so the reason is never the part that gets cut.
 */
function spawnErrorMessage(err: unknown, interpreter: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return `interpreter not found: ${interpreter}`;
  if (code === 'EACCES') return 'script is not executable';
  return err instanceof Error ? err.message : String(err);
}
