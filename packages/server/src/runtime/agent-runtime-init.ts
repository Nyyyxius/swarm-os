import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from 'pino';

/**
 * Boot-time materialisation of an agent CLI's host state into a writable
 * per-container runtime root.
 *
 * Generalised out of `claude-init.ts` (multi-provider plan, Lot 1). The shape
 * of the problem is the same for every CLI that keeps a mixed RW state dir in
 * `$HOME`:
 *
 *   `~/.X` is a mixed RW directory (sessions, cache, history, credentials), so
 *   the host mount **must** be RO and the container needs a private writable
 *   copy. This module produces that copy.
 *
 * Design (unchanged from the claude-only version):
 *   - If `<sourceDir>` is missing or unreadable (typical of `pnpm dev` outside
 *     a container), this is a **no-op** — the CLI resolves `~/.X` from the
 *     user's actual home directory.
 *   - When the source exists, we copy its contents into `<runtimeDir>` (RW).
 *     The copy is **idempotent**: a marker file records the source mtime; on
 *     subsequent boots we skip the copy if the source mtime hasn't changed.
 *   - `<runtimeDir>` is `chmod 0700` so other users on the host can't snoop
 *     the credentials we just copied.
 *
 * Every emitted log line is parametrised through `AgentRuntimeSpec` (logger +
 * event prefix) so a provider's operational surface stays byte-identical
 * across this refactor.
 *
 * Concurrency: callers MUST run `initAgentRuntime` **before** the HTTP server
 * accepts traffic (so no orchestrator can race against the copy).
 *
 * NOTE: under `SWARM_OS_AGENT_TRANSPORT=ssh` none of this runs — the agent
 * resolves its own `~/.X` on the host through per-session symlinks.
 */

/** Outcome of a per-file lift. */
export type FileLift = 'absent' | 'lifted' | 'cache-hit';

export interface AgentRuntimeSpec {
  /** Logger the module emits through (`withModule('claude-init')`, …). */
  log: Logger;
  /** Structured-event prefix, e.g. `claude_init` → `claude_init.copied`. */
  eventPrefix: string;
  /** Marker filename written inside `runtimeDir`. */
  markerFilename: string;
  /**
   * Files INSIDE the source dir that the host mutates **in place**, which the
   * dir-mtime cache cannot see (claude: `.credentials.json`, rotated on every
   * OAuth refresh). Each gets its own mtime cache key.
   */
  volatileFiles: readonly string[];
  /**
   * A config file that lives BESIDE the source dir rather than inside it
   * (claude: `~/.claude.json`, exposed as `<sourceDir>.json`). `null` when the
   * provider has no such sibling.
   */
  siblingFile: { destName: string; sourceSuffix: string } | null;
  /** Free-text `note` attached to the "source missing" log line. */
  noSourceNote: string;
}

export interface AgentRuntimeInitOptions {
  sourceDir: string;
  runtimeDir: string;
  /**
   * Explicit override for the sibling file's source path. When unset, falls
   * back to `<sourceDir><spec.siblingFile.sourceSuffix>`. When neither
   * resolves to a file, the lift is a silent no-op.
   */
  siblingSource?: string | null;
}

export interface AgentRuntimeInitResult {
  /** Whether the source was present and the copy actually ran or was skipped via cache. */
  initialized: boolean;
  /** True iff a copy ran on this boot. False on no-op or cache-hit. */
  copied: boolean;
  /** Resolved source dir (may not exist). */
  sourceDir: string;
  /** Resolved runtime dir (always exists post-call). */
  runtimeDir: string;
  /** Reason if no copy happened. */
  skipReason?: 'source-missing' | 'source-unreadable' | 'cache-hit';
  /** Source mtime captured (only when initialized). */
  sourceMtimeMs?: number;
  /** Rough estimate via top-level entries when copied. */
  entriesCopied?: number;
  /** Sibling-file lift result (`'absent'` when the provider has none). */
  sibling: FileLift;
  /** Source path actually used for the sibling lift, if any. */
  siblingSource?: string;
}

export interface AgentSharedRefreshResult {
  /** One entry per `spec.volatileFiles`, keyed by filename. */
  files: Record<string, FileLift>;
  sibling: FileLift;
}

interface MarkerFile {
  sourceDir: string;
  sourceMtimeMs: number;
  initializedAt: string;
}

function readMarker(runtimeDir: string, spec: AgentRuntimeSpec): MarkerFile | null {
  try {
    const raw = fs.readFileSync(path.join(runtimeDir, spec.markerFilename), 'utf8');
    const parsed = JSON.parse(raw) as MarkerFile;
    if (
      typeof parsed.sourceDir === 'string' &&
      typeof parsed.sourceMtimeMs === 'number' &&
      typeof parsed.initializedAt === 'string'
    ) {
      return parsed;
    }
  } catch {
    /* missing / malformed → treat as absent */
  }
  return null;
}

function writeMarker(runtimeDir: string, marker: MarkerFile, spec: AgentRuntimeSpec): void {
  try {
    fs.writeFileSync(
      path.join(runtimeDir, spec.markerFilename),
      JSON.stringify(marker, null, 2) + '\n',
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(path.join(runtimeDir, spec.markerFilename), 0o600);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    spec.log.warn({
      event: `${spec.eventPrefix}.marker_write_failed`,
      runtimeDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readDirSafe(p: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * Generic per-file lift with mtime-based caching (integer-second resolution).
 *
 * Why this exists: the dir-mtime cache in `initAgentRuntime` doesn't catch
 * in-place edits of individual files inside the source dir (Linux dir mtime
 * tracks entry add/remove/rename, not in-place content edits). Files that
 * mutate frequently in-place — `.credentials.json` (OAuth refresh on host)
 * and `.claude.json` (theme + onboarding bits) — need a per-file cache key.
 *
 * Returns `'absent'` if the source isn't a regular file, `'cache-hit'` if
 * dst mtime already matches src mtime (integer-second resolution — FS mtime
 * resolution varies and sub-ms drift is real), `'lifted'` if a copy ran.
 */
function liftSingleFile(
  opts: { src: string; dst: string; label: string },
  spec: AgentRuntimeSpec,
): FileLift {
  const srcStat = statSafe(opts.src);
  if (!srcStat || !srcStat.isFile()) {
    return 'absent';
  }
  const dstStat = statSafe(opts.dst);
  if (
    dstStat &&
    dstStat.isFile() &&
    Math.floor(dstStat.mtimeMs / 1000) === Math.floor(srcStat.mtimeMs / 1000)
  ) {
    return 'cache-hit';
  }
  try {
    fs.cpSync(opts.src, opts.dst, {
      force: true,
      preserveTimestamps: true,
      dereference: true,
      errorOnExist: false,
    });
    try {
      fs.chmodSync(opts.dst, 0o600);
    } catch {
      /* best-effort */
    }
    return 'lifted';
  } catch (err) {
    spec.log.warn({
      event: `${spec.eventPrefix}.file_lift_failed`,
      label: opts.label,
      src: opts.src,
      dst: opts.dst,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'absent';
  }
}

/**
 * Resolve the source path for the sibling config file from the explicit
 * override or the implicit `<sourceDir><suffix>`. Returns null if neither
 * resolves to a regular file (or the provider declares no sibling).
 */
export function resolveSiblingSource(
  opts: AgentRuntimeInitOptions,
  spec: AgentRuntimeSpec,
): string | null {
  if (!spec.siblingFile) return null;
  const candidates = [
    opts.siblingSource,
    `${opts.sourceDir}${spec.siblingFile.sourceSuffix}`,
  ].filter((p): p is string => Boolean(p && p.length));
  for (const c of candidates) {
    const st = statSafe(c);
    if (st && st.isFile()) return c;
  }
  return null;
}

/**
 * Lift the sibling config file (claude: the host `~/.claude.json`, sibling of
 * `~/.claude/`) into the per-container runtime root.
 *
 * Why this matters: without `~/.claude.json`, claude prints "configuration
 * file not found" and runs the interactive theme picker on the first spawn,
 * which wedges the PTY and blocks orchestrators.
 */
function liftSibling(
  opts: AgentRuntimeInitOptions,
  spec: AgentRuntimeSpec,
): { result: FileLift; source?: string } {
  if (!spec.siblingFile) return { result: 'absent' };
  const chosen = resolveSiblingSource(opts, spec);
  if (!chosen) return { result: 'absent' };
  const result = liftSingleFile(
    {
      src: chosen,
      dst: path.join(opts.runtimeDir, spec.siblingFile.destName),
      label: spec.siblingFile.destName,
    },
    spec,
  );
  return { result, source: chosen };
}

/**
 * Sync the host-volatile files (`spec.volatileFiles` + the sibling) from the
 * RO source mount into the writable runtime root. Designed to be called
 * lazily before each new spawn — the dir-mtime cache in `initAgentRuntime`
 * only invalidates on entry-level changes, so in-place refreshes of these
 * files (e.g. host claude rotating OAuth tokens) would otherwise stay
 * invisible to the container indefinitely.
 *
 * Cost: a couple of `fs.stat` + 0-N `cpSync` of small files (typically < 1 KB
 * each). Negligible relative to a PTY spawn. Safe to call on every session
 * start. Deliberately silent — the caller owns the summary log line.
 */
export function refreshAgentSharedFiles(
  opts: AgentRuntimeInitOptions,
  spec: AgentRuntimeSpec,
): AgentSharedRefreshResult {
  const files: Record<string, FileLift> = {};
  for (const name of spec.volatileFiles) {
    files[name] = liftSingleFile(
      {
        src: path.join(opts.sourceDir, name),
        dst: path.join(opts.runtimeDir, name),
        label: name,
      },
      spec,
    );
  }
  return { files, sibling: liftSibling(opts, spec).result };
}

/** Run the runtime-init step. See module doc. */
export function initAgentRuntime(
  opts: AgentRuntimeInitOptions,
  spec: AgentRuntimeSpec,
): AgentRuntimeInitResult {
  const { sourceDir, runtimeDir } = opts;

  // Always ensure runtimeDir exists (config.ts also does this — defence in
  // depth). Tighten perms if we can.
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch {
    /* best-effort */
  }

  // Try to lift the sibling regardless of whether the dir source exists —
  // both mounts are independent in compose. Captured here so all return paths
  // can include the result.
  const siblingLift = liftSibling(opts, spec);
  spec.log.info({
    event: `${spec.eventPrefix}.json_lift`,
    result: siblingLift.result,
    source: siblingLift.source ?? null,
  });

  const sourceStat = statSafe(sourceDir);
  if (!sourceStat || !sourceStat.isDirectory()) {
    spec.log.info({
      event: `${spec.eventPrefix}.no_source`,
      sourceDir,
      runtimeDir,
      note: spec.noSourceNote,
    });
    return {
      initialized: false,
      copied: false,
      sourceDir,
      runtimeDir,
      skipReason: 'source-missing',
      sibling: siblingLift.result,
      siblingSource: siblingLift.source,
    };
  }

  const entries = readDirSafe(sourceDir);
  if (entries == null) {
    spec.log.warn({
      event: `${spec.eventPrefix}.source_unreadable`,
      sourceDir,
      runtimeDir,
    });
    return {
      initialized: false,
      copied: false,
      sourceDir,
      runtimeDir,
      skipReason: 'source-unreadable',
      sibling: siblingLift.result,
      siblingSource: siblingLift.source,
    };
  }

  const sourceMtimeMs = sourceStat.mtimeMs;
  const marker = readMarker(runtimeDir, spec);
  if (
    marker &&
    marker.sourceDir === sourceDir &&
    // Compare at integer-second resolution — see `liftSingleFile` for the
    // rationale (FS mtime resolution varies, sub-ms drift is real).
    Math.floor(marker.sourceMtimeMs / 1000) === Math.floor(sourceMtimeMs / 1000)
  ) {
    spec.log.info({
      event: `${spec.eventPrefix}.cache_hit`,
      sourceDir,
      runtimeDir,
      sourceMtimeMs,
      initializedAt: marker.initializedAt,
    });
    return {
      initialized: true,
      copied: false,
      sourceDir,
      runtimeDir,
      skipReason: 'cache-hit',
      sourceMtimeMs,
      sibling: siblingLift.result,
      siblingSource: siblingLift.source,
    };
  }

  const t0 = Date.now();
  let copied = 0;
  for (const entry of entries) {
    // Skip our own marker if it accidentally exists in source.
    if (entry.name === spec.markerFilename) continue;
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(runtimeDir, entry.name);
    try {
      fs.cpSync(src, dst, {
        recursive: true,
        force: true,
        // Preserve timestamps so subsequent mtime comparison stays meaningful.
        preserveTimestamps: true,
        // Dereference symlinks: the source dir is allowed to symlink into
        // other host paths; we want their content captured in the container.
        dereference: true,
        // Don't error if the source has socket / fifo / device files that
        // can't be copied — the CLI doesn't write those, but be defensive.
        errorOnExist: false,
      });
      copied += 1;
    } catch (err) {
      spec.log.warn({
        event: `${spec.eventPrefix}.entry_copy_failed`,
        entry: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Tighten the runtime root again — fs.cpSync on certain children can
  // chmod the parent on some platforms. 0o700 is the security-relevant
  // perm (credentials are inside).
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch {
    /* best-effort */
  }

  writeMarker(
    runtimeDir,
    { sourceDir, sourceMtimeMs, initializedAt: new Date().toISOString() },
    spec,
  );

  spec.log.info({
    event: `${spec.eventPrefix}.copied`,
    sourceDir,
    runtimeDir,
    entries: copied,
    durationMs: Date.now() - t0,
  });

  return {
    initialized: true,
    copied: true,
    sourceDir,
    runtimeDir,
    sourceMtimeMs,
    entriesCopied: copied,
    sibling: siblingLift.result,
    siblingSource: siblingLift.source,
  };
}
