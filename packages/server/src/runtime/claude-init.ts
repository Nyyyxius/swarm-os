import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../logger.js';

const log = withModule('claude-init');

/**
 * Phase 5 — boot-time `~/.claude` materialisation.
 *
 * Per plan §13/§14 + spike H7 (`scripts/verify-claude-code.report.md`):
 *   `~/.claude` is a mixed RW directory (sessions, cache, history, credentials),
 *   so the host mount **must** be RO and the container needs a private
 *   writable copy. This module produces that copy.
 *
 * Design:
 *   - If `<sourceDir>` is missing or unreadable (typical of `pnpm dev` outside
 *     a container), this is a **no-op** — Claude will resolve `~/.claude` from
 *     the user's actual home directory.
 *   - When the source exists, we copy its contents into `<runtimeDir>` (RW).
 *     The copy is **idempotent**: a marker file `<runtimeDir>/.swarm-os-initialized`
 *     records the source mtime; on subsequent boots we skip the copy if the
 *     source mtime hasn't changed.
 *   - `<runtimeDir>` is `chmod 0700` so other users on the host can't snoop
 *     the credentials we just copied. Per-file modes are preserved best-effort
 *     by `fs.cpSync` semantics.
 *
 * Concurrency: callers MUST run this **before** the HTTP server accepts
 * traffic (so no orchestrator can race against the copy). The Spawner reads
 * `claudeRuntimeDir` lazily per session, so the copy must complete first.
 */
export interface ClaudeInitResult {
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
  /** Bytes copied (rough estimate via top-level entries when copied). */
  entriesCopied?: number;
  /**
   * Phase 6 — `.claude.json` lift result. The file lives in `$HOME` (sibling
   * of `~/.claude/`), holds OAuth account state + theme picker bit, and
   * **must** be writable. We support either:
   *   - implicit: `<sourceDir>.json` (e.g. `/claude-source.json`) — works
   *     with the second optional mount line in compose examples.
   *   - explicit: env `SWARM_OS_CLAUDE_JSON_SOURCE` (path to the source file).
   * Result is `'absent'` when neither path resolves to a file (typical of
   * dev mode), `'lifted'` when we copied it on this boot, `'cache-hit'`
   * when the runtime copy is already in sync with the source mtime.
   */
  claudeJson?: 'absent' | 'lifted' | 'cache-hit';
  /** Source path actually used for the `.claude.json` lift, if any. */
  claudeJsonSource?: string;
}

const MARKER_FILENAME = '.swarm-os-initialized';

interface MarkerFile {
  sourceDir: string;
  sourceMtimeMs: number;
  initializedAt: string;
}

function readMarker(runtimeDir: string): MarkerFile | null {
  try {
    const raw = fs.readFileSync(path.join(runtimeDir, MARKER_FILENAME), 'utf8');
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

function writeMarker(runtimeDir: string, marker: MarkerFile): void {
  try {
    fs.writeFileSync(
      path.join(runtimeDir, MARKER_FILENAME),
      JSON.stringify(marker, null, 2) + '\n',
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(path.join(runtimeDir, MARKER_FILENAME), 0o600);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    log.warn({
      event: 'claude_init.marker_write_failed',
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
 * Why this exists: the dir-mtime cache in `initClaudeRuntime` doesn't catch
 * in-place edits of individual files inside the source dir (Linux dir mtime
 * tracks entry add/remove/rename, not in-place content edits). Files that
 * mutate frequently in-place — `.credentials.json` (OAuth refresh on host)
 * and `.claude.json` (theme + onboarding bits) — need a per-file cache key.
 *
 * Returns `'absent'` if the source isn't a regular file, `'cache-hit'` if
 * dst mtime already matches src mtime (integer-second resolution — see
 * Phase 6 comment in `liftClaudeJson` for the FS resolution rationale),
 * `'lifted'` if a copy ran on this call.
 */
function liftSingleFile(opts: {
  src: string;
  dst: string;
  label: string;
}): 'absent' | 'lifted' | 'cache-hit' {
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
    log.warn({
      event: 'claude_init.file_lift_failed',
      label: opts.label,
      src: opts.src,
      dst: opts.dst,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'absent';
  }
}

/**
 * Resolve the source path for `~/.claude.json` from explicit override or
 * implicit `<sourceDir>.json` sibling. Returns null if neither resolves to a
 * regular file.
 */
function resolveClaudeJsonSource(opts: {
  sourceDir: string;
  claudeJsonSource: string | null;
}): string | null {
  const candidates = [opts.claudeJsonSource, `${opts.sourceDir}.json`].filter(
    (p): p is string => Boolean(p && p.length),
  );
  for (const c of candidates) {
    const st = statSafe(c);
    if (st && st.isFile()) return c;
  }
  return null;
}

/**
 * Phase 6 — lift the host `~/.claude.json` (sibling of `~/.claude/`) into the
 * per-container runtime root. Thin wrapper kept for the boot-time callsite
 * in `initClaudeRuntime`. See `liftSingleFile` for the per-file caching
 * semantics.
 *
 * Why this matters: without `~/.claude.json`, claude prints
 * "configuration file not found" and runs the interactive theme picker on
 * the first spawn, which wedges the PTY and blocks orchestrators.
 */
function liftClaudeJson(opts: {
  sourceDir: string;
  runtimeDir: string;
  claudeJsonSource: string | null;
}): { result: 'absent' | 'lifted' | 'cache-hit'; source?: string } {
  const chosen = resolveClaudeJsonSource({
    sourceDir: opts.sourceDir,
    claudeJsonSource: opts.claudeJsonSource,
  });
  if (!chosen) return { result: 'absent' };
  const result = liftSingleFile({
    src: chosen,
    dst: path.join(opts.runtimeDir, '.claude.json'),
    label: '.claude.json',
  });
  return { result, source: chosen };
}

/**
 * Sync the host-volatile files (`.credentials.json` + `.claude.json`) from
 * the RO source mount into the writable runtime root. Designed to be called
 * lazily before each new claude spawn — the dir-mtime cache in
 * `initClaudeRuntime` only invalidates on entry-level changes, so in-place
 * refreshes of these files (e.g. host claude rotating OAuth tokens) would
 * otherwise stay invisible to the container indefinitely.
 *
 * Cost: 2 `fs.stat` + 0-2 `cpSync` of small files (typically < 1 KB each).
 * Negligible relative to a PTY spawn. Safe to call on every session start.
 */
export function refreshClaudeSharedFiles(opts: {
  sourceDir: string;
  runtimeDir: string;
  claudeJsonSource: string | null;
}): {
  credentials: 'absent' | 'lifted' | 'cache-hit';
  claudeJson: 'absent' | 'lifted' | 'cache-hit';
} {
  const credentials = liftSingleFile({
    src: path.join(opts.sourceDir, '.credentials.json'),
    dst: path.join(opts.runtimeDir, '.credentials.json'),
    label: '.credentials.json',
  });
  const jsonSrc = resolveClaudeJsonSource({
    sourceDir: opts.sourceDir,
    claudeJsonSource: opts.claudeJsonSource,
  });
  const claudeJson: 'absent' | 'lifted' | 'cache-hit' = jsonSrc
    ? liftSingleFile({
        src: jsonSrc,
        dst: path.join(opts.runtimeDir, '.claude.json'),
        label: '.claude.json',
      })
    : 'absent';
  if (credentials === 'lifted' || claudeJson === 'lifted') {
    log.info({
      event: 'claude_init.shared_refresh',
      credentials,
      claudeJson,
    });
  }
  return { credentials, claudeJson };
}

/**
 * Run the claude-init step. See module doc.
 */
export function initClaudeRuntime(opts: {
  sourceDir: string;
  runtimeDir: string;
  /**
   * Phase 6 — explicit override for the `.claude.json` source path. When
   * unset, falls back to `<sourceDir>.json` (sibling). When neither
   * resolves to a file, the lift is a silent no-op.
   */
  claudeJsonSource?: string | null;
}): ClaudeInitResult {
  const { sourceDir, runtimeDir } = opts;

  // Always ensure runtimeDir exists (config.ts also does this — defence in
  // depth). Tighten perms if we can.
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch {
    /* best-effort */
  }

  // Phase 6: try to lift `.claude.json` regardless of whether the dir source
  // exists — both mounts are independent in compose. Captured here so all
  // return paths can include the result.
  const jsonLift = liftClaudeJson({
    sourceDir,
    runtimeDir,
    claudeJsonSource: opts.claudeJsonSource ?? null,
  });
  log.info({
    event: 'claude_init.json_lift',
    result: jsonLift.result,
    source: jsonLift.source ?? null,
  });

  const sourceStat = statSafe(sourceDir);
  if (!sourceStat || !sourceStat.isDirectory()) {
    log.info({
      event: 'claude_init.no_source',
      sourceDir,
      runtimeDir,
      note: 'falling back to host ~/.claude (dev mode)',
    });
    return {
      initialized: false,
      copied: false,
      sourceDir,
      runtimeDir,
      skipReason: 'source-missing',
      claudeJson: jsonLift.result,
      claudeJsonSource: jsonLift.source,
    };
  }

  const entries = readDirSafe(sourceDir);
  if (entries == null) {
    log.warn({
      event: 'claude_init.source_unreadable',
      sourceDir,
      runtimeDir,
    });
    return {
      initialized: false,
      copied: false,
      sourceDir,
      runtimeDir,
      skipReason: 'source-unreadable',
      claudeJson: jsonLift.result,
      claudeJsonSource: jsonLift.source,
    };
  }

  const sourceMtimeMs = sourceStat.mtimeMs;
  const marker = readMarker(runtimeDir);
  if (
    marker &&
    marker.sourceDir === sourceDir &&
    // Compare at integer-second resolution — see `liftClaudeJson` for the
    // rationale (FS mtime resolution varies, sub-ms drift is real).
    Math.floor(marker.sourceMtimeMs / 1000) === Math.floor(sourceMtimeMs / 1000)
  ) {
    log.info({
      event: 'claude_init.cache_hit',
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
      claudeJson: jsonLift.result,
      claudeJsonSource: jsonLift.source,
    };
  }

  const t0 = Date.now();
  let copied = 0;
  for (const entry of entries) {
    // Skip our own marker if it accidentally exists in source.
    if (entry.name === MARKER_FILENAME) continue;
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(runtimeDir, entry.name);
    try {
      fs.cpSync(src, dst, {
        recursive: true,
        force: true,
        // Preserve timestamps so subsequent mtime comparison stays meaningful.
        preserveTimestamps: true,
        // Dereference symlinks: source `~/.claude` is allowed to symlink into
        // other host paths; we want their content captured in the container.
        dereference: true,
        // Don't error if the source has socket / fifo / device files that
        // can't be copied — Claude doesn't write those, but be defensive.
        errorOnExist: false,
      });
      copied += 1;
    } catch (err) {
      log.warn({
        event: 'claude_init.entry_copy_failed',
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

  writeMarker(runtimeDir, {
    sourceDir,
    sourceMtimeMs,
    initializedAt: new Date().toISOString(),
  });

  log.info({
    event: 'claude_init.copied',
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
    claudeJson: jsonLift.result,
    claudeJsonSource: jsonLift.source,
  };
}
