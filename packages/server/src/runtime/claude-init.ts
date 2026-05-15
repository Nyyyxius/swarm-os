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
 * Phase 6 — lift the host `~/.claude.json` (sibling of `~/.claude/`) into the
 * per-container runtime root. Returns the lift result so the caller can log
 * which path was used.
 *
 * Resolution order for the source:
 *   1. `claudeJsonSource` (from `SWARM_OS_CLAUDE_JSON_SOURCE` env)
 *   2. `<sourceDir>.json` (implicit sibling — e.g. `/claude-source.json`,
 *      matches the optional second mount line in compose examples)
 *
 * If neither is a regular file, we return `'absent'` (dev mode no-op).
 * Otherwise we copy it to `<runtimeDir>/.claude.json` (mode 0600). Idempotent
 * via mtime comparison against the marker tracked by `initClaudeRuntime`.
 *
 * Why this matters: without `~/.claude.json`, claude prints
 * "configuration file not found" and runs the interactive theme picker on
 * the first spawn, which wedges the PTY and blocks orchestrators. Phase 5
 * known issue, doc'd in `docs/phase-5-containerisation.md` §11.
 */
function liftClaudeJson(opts: {
  sourceDir: string;
  runtimeDir: string;
  claudeJsonSource: string | null;
}): { result: 'absent' | 'lifted' | 'cache-hit'; source?: string } {
  const explicit = opts.claudeJsonSource;
  const implicit = `${opts.sourceDir}.json`;
  const candidates = [explicit, implicit].filter((p): p is string => Boolean(p && p.length));
  let chosen: string | null = null;
  let chosenStat: fs.Stats | null = null;
  for (const c of candidates) {
    const st = statSafe(c);
    if (st && st.isFile()) {
      chosen = c;
      chosenStat = st;
      break;
    }
  }
  if (!chosen || !chosenStat) {
    return { result: 'absent' };
  }
  const dest = path.join(opts.runtimeDir, '.claude.json');
  // Cache check: compare source mtime against existing dest mtime.
  const destStat = statSafe(dest);
  if (
    destStat &&
    destStat.isFile() &&
    Math.floor(destStat.mtimeMs) === Math.floor(chosenStat.mtimeMs)
  ) {
    return { result: 'cache-hit', source: chosen };
  }
  try {
    fs.cpSync(chosen, dest, {
      force: true,
      preserveTimestamps: true,
      dereference: true,
      errorOnExist: false,
    });
    try {
      fs.chmodSync(dest, 0o600);
    } catch {
      /* best-effort */
    }
    return { result: 'lifted', source: chosen };
  } catch (err) {
    log.warn({
      event: 'claude_init.json_lift_failed',
      source: chosen,
      dest,
      error: err instanceof Error ? err.message : String(err),
    });
    return { result: 'absent', source: chosen };
  }
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
    Math.floor(marker.sourceMtimeMs) === Math.floor(sourceMtimeMs)
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
