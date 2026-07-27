/**
 * Helpers shared by every provider adapter when it builds a per-session config
 * directory. Extracted verbatim from `Session` (multi-provider plan, Lot 1) —
 * the behaviour here is load-bearing and was paid for in production incidents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default mode for a per-session file: readable by the agent's user only. */
export const SESSION_FILE_MODE = 0o600;
/** Mode for a per-session file the CLI **execs** (codex's `notify.sh`). */
export const SESSION_EXEC_MODE = 0o700;

/**
 * Write a per-session config file, enforcing the invariant every adapter
 * depends on: **a per-session file is a REGULAR file, never a symlink**.
 *
 * This is the one place that enforcement lives. It is not politeness:
 *
 *   - a per-session config dir also holds SYMLINKS into the shared host state
 *     (`linkSharedState` below) — credentials, history, install identity;
 *   - `fs.writeFileSync` FOLLOWS a symlink at the destination. A link that
 *     landed on a per-session path (a stale one from an older server version, a
 *     leftover after a hard container kill — the session dir survives, and
 *     auto-resume re-prepares the SAME `sessionId`) therefore makes us write
 *     THROUGH it;
 *   - what we write there is this session's MCP url (a bearer secret in a path
 *     segment) and its hook token. Writing that through a link truncates the
 *     operator's SHARED `~/.gemini/settings.json`, `~/.codex/config.toml` or
 *     `~/.claude/settings.json` and hands one session's secret to every agent
 *     and to the operator's own CLI. Reproduced by planting a link and
 *     re-preparing the same session id.
 *
 * `fs.rmSync` on a symlink removes the LINK and never touches its target, so
 * the shared file is safe by construction. The explicit `chmodSync` is there
 * because `writeFileSync`'s `mode` is masked by the process umask on create and
 * ignored entirely for a file that already exists.
 *
 * Throws whatever `writeFileSync` throws — every caller already treats a failed
 * per-session write as a phase-A failure. Only the removal is best-effort.
 */
export function writeSessionFile(
  file: string,
  contents: string,
  mode: number = SESSION_FILE_MODE,
): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to remove — or a directory we are about to fail on anyway */
  }
  fs.writeFileSync(file, contents, { mode });
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* best-effort */
  }
}

/** `writeSessionFile` for a JSON body: 2-space indent, trailing newline, 0600. */
export function writeSessionJson(file: string, body: unknown): void {
  writeSessionFile(file, `${JSON.stringify(body, null, 2)}\n`);
}

export interface LinkSharedStateOptions {
  /**
   * Root the symlink *targets* are resolved against, from the AGENT's point of
   * view. In local transport this is the container's writable runtime root; in
   * SSH transport it is the host's real state dir (`~/.claude`), which the
   * container cannot see.
   */
  targetRoot: string;
  /** Container path of the per-session config dir the links are created in. */
  configDir: string;
  /** Entry names to link. Anything absent from the list is simply not shared. */
  entries: readonly string[];
  /**
   * `true` — lstat `<targetRoot>/<entry>` and skip what does not exist (only
   * possible when `targetRoot` is a path WE can see).
   * `false` — write the links unconditionally: under SSH the target lives in
   * the host namespace, the agent resolves it there and ignores what is
   * missing.
   */
  existsCheck: boolean;
  /** Called once per entry that could not be linked. Never throws upward. */
  onError: (info: { entry: string; target: string; error: string }) => void;
}

/**
 * Symlink a set of shared state entries into a per-session config dir, so the
 * agent sees the shared credentials / history while keeping its own
 * `settings.json`.
 *
 * Best-effort by construction: a failure on one entry is reported through
 * `onError` and the loop continues. Stale links are removed first — there is
 * no `force` option on `fs.symlinkSync`.
 */
export function linkSharedState(opts: LinkSharedStateOptions): void {
  for (const name of opts.entries) {
    const target = path.join(opts.targetRoot, name);
    const linkPath = path.join(opts.configDir, name);
    if (opts.existsCheck) {
      try {
        fs.lstatSync(target);
      } catch {
        continue;
      }
    }
    try {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* didn't exist — fine */
      }
      fs.symlinkSync(target, linkPath);
    } catch (err) {
      opts.onError({
        entry: name,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Shell command run by the agent's `Notification` hook.
 *
 * The CLI streams its hook event as JSON on stdin; we capture it with `cat`,
 * JSON-escape it (python3 when available, `sed` otherwise) and POST a minimal
 * envelope carrying OUR ids — the CLI's own `session_id` is its internal one
 * and means nothing to us. `curl` is mandatory and present in the images.
 *
 * The exact quoting of this string is production-critical: it is parsed by the
 * agent's shell, not by Node. Do not "tidy" it. The same command works for
 * gemini (its hook payload is Claude-Code-compatible).
 */
export function buildNotificationHookCommand(opts: {
  orchestratorId: string;
  sessionId: string;
  hookToken: string;
  mainHttpPort: number;
}): string {
  const hookUrl = `http://127.0.0.1:${opts.mainHttpPort}/hooks/notification`;
  return (
    `payload=$(cat); ` +
    `msg=$(printf '%s' "$payload" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || ` +
    `msg=$(printf '"%s"' "$(printf '%s' "$payload" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\n/\\\\n/g')"); ` +
    `body=$(printf '{"orch_id":"%s","session_id":"%s","kind":"session.waiting","message":%s}' '${opts.orchestratorId}' '${opts.sessionId}' "$msg"); ` +
    `curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${opts.hookToken}' -d "$body" '${hookUrl}' >/dev/null 2>&1 || true`
  );
}
