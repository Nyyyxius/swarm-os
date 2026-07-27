import { withModule } from '../logger.js';
import {
  initAgentRuntime,
  refreshAgentSharedFiles,
  type AgentRuntimeSpec,
  type FileLift,
} from './agent-runtime-init.js';

/**
 * Phase 5 — boot-time `~/.claude` materialisation, now a thin binding over the
 * provider-agnostic `agent-runtime-init.ts` (multi-provider plan, Lot 1).
 *
 * The mechanics (idempotent copy gated on the source dir mtime, per-file lift
 * of the host-volatile files, 0700 runtime root) live in the generic module.
 * What is claude-specific and stays here:
 *   - `~/.claude` is the source dir, `.credentials.json` its volatile file;
 *   - `~/.claude.json` is a SIBLING of that dir, mounted as `<sourceDir>.json`
 *     or pointed at explicitly by `SWARM_OS_CLAUDE_JSON_SOURCE`;
 *   - the `claude-init` log module and the `claude_init.*` event names.
 *
 * The exported signatures are unchanged — `claude-init.test.ts` is the
 * contract.
 */

const log = withModule('claude-init');

const MARKER_FILENAME = '.swarm-os-initialized';

const CLAUDE_RUNTIME_SPEC: AgentRuntimeSpec = {
  log,
  eventPrefix: 'claude_init',
  markerFilename: MARKER_FILENAME,
  // Rotated in place by the host claude on every OAuth refresh, which the
  // dir-mtime cache cannot see.
  volatileFiles: ['.credentials.json'],
  // `~/.claude.json` lives in $HOME next to `~/.claude/`, holds OAuth account
  // state + the theme picker bit, and **must** be writable.
  siblingFile: { destName: '.claude.json', sourceSuffix: '.json' },
  noSourceNote: 'falling back to host ~/.claude (dev mode)',
};

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
   * Phase 6 — `.claude.json` lift result. We support either:
   *   - implicit: `<sourceDir>.json` (e.g. `/claude-source.json`) — works
   *     with the second optional mount line in compose examples.
   *   - explicit: env `SWARM_OS_CLAUDE_JSON_SOURCE` (path to the source file).
   * Result is `'absent'` when neither path resolves to a file (typical of
   * dev mode), `'lifted'` when we copied it on this boot, `'cache-hit'`
   * when the runtime copy is already in sync with the source mtime.
   */
  claudeJson?: FileLift;
  /** Source path actually used for the `.claude.json` lift, if any. */
  claudeJsonSource?: string;
}

/**
 * Sync the host-volatile files (`.credentials.json` + `.claude.json`) from
 * the RO source mount into the writable runtime root. Called lazily before
 * each new claude spawn (see `ClaudeProvider.prepareSessionConfig`).
 */
export function refreshClaudeSharedFiles(opts: {
  sourceDir: string;
  runtimeDir: string;
  claudeJsonSource: string | null;
}): { credentials: FileLift; claudeJson: FileLift } {
  const r = refreshAgentSharedFiles(
    {
      sourceDir: opts.sourceDir,
      runtimeDir: opts.runtimeDir,
      siblingSource: opts.claudeJsonSource,
    },
    CLAUDE_RUNTIME_SPEC,
  );
  const credentials = r.files['.credentials.json'] ?? 'absent';
  const claudeJson = r.sibling;
  if (credentials === 'lifted' || claudeJson === 'lifted') {
    log.info({
      event: 'claude_init.shared_refresh',
      credentials,
      claudeJson,
    });
  }
  return { credentials, claudeJson };
}

/** Run the claude-init step. See module doc. */
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
  const r = initAgentRuntime(
    {
      sourceDir: opts.sourceDir,
      runtimeDir: opts.runtimeDir,
      siblingSource: opts.claudeJsonSource ?? null,
    },
    CLAUDE_RUNTIME_SPEC,
  );
  return {
    initialized: r.initialized,
    copied: r.copied,
    sourceDir: r.sourceDir,
    runtimeDir: r.runtimeDir,
    skipReason: r.skipReason,
    sourceMtimeMs: r.sourceMtimeMs,
    entriesCopied: r.entriesCopied,
    claudeJson: r.sibling,
    claudeJsonSource: r.siblingSource,
  };
}
