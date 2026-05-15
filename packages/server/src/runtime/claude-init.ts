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
 * Run the claude-init step. See module doc.
 */
export function initClaudeRuntime(opts: {
  sourceDir: string;
  runtimeDir: string;
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
  };
}
