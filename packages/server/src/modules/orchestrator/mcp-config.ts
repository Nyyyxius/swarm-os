import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Per-session MCP config file generation.
 *
 * Each session gets a temporary `mcp.json` matching the schema confirmed by
 * the Phase 0 bis spike (`scripts/verify-claude-code.report.md` H4):
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "team-comms": {
 *       "type": "http",
 *       "url": "http://127.0.0.1:8788/mcp/<orch_id>/<session_secret>"
 *     }
 *   }
 * }
 * ```
 *
 * Layout: `<runtimeDir>/orch-<orchId>/session-<sessionId>/mcp.json`. The
 * directory tree gets `0700` and the JSON file `0600` (plan §14). The path
 * is then passed to `claude` via `--mcp-config <path>`.
 */

export interface McpConfigInput {
  /** Root dir, e.g. `/tmp/swarm-os`. */
  runtimeDir: string;
  orchestratorId: string;
  sessionId: string;
  sessionSecret: string;
  /** MCP server bind host. MUST be `127.0.0.1` (loopback). */
  mcpHost: string;
  mcpPort: number;
  /** Logical MCP server name visible to claude (defaults to "team-comms"). */
  serverName?: string;
}

export interface McpConfigResult {
  /** Absolute path to the generated mcp.json. */
  path: string;
  /** URL embedded in the config (handy for logging/testing). */
  url: string;
}

/** Per-session subdirectory. Stable, deterministic from ids. */
export function sessionDirFor(
  runtimeDir: string,
  orchestratorId: string,
  sessionId: string,
): string {
  return path.join(runtimeDir, `orch-${orchestratorId}`, `session-${sessionId}`);
}

/** Write the per-session mcp.json. Returns its absolute path. */
export function writeSessionMcpConfig(input: McpConfigInput): McpConfigResult {
  const dir = sessionDirFor(input.runtimeDir, input.orchestratorId, input.sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync may not chmod existing parent dirs; force the leaf to 0700.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }

  const url = `http://${input.mcpHost}:${input.mcpPort}/mcp/${input.orchestratorId}/${input.sessionSecret}`;
  const filePath = path.join(dir, 'mcp.json');
  const body = {
    mcpServers: {
      [input.serverName ?? 'team-comms']: {
        type: 'http',
        url,
      },
    },
  };
  // Open with O_CREAT|O_TRUNC and explicit 0600 mode in one syscall, then
  // chmod defensively in case umask stripped the bits before the open
  // returned (some filesystems / umasks combine surprisingly).
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(body, null, 2) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
  return { path: filePath, url };
}

/**
 * Best-effort cleanup of the per-session mcp.json and its parent directory.
 * Logs (no throw) on failure; the caller must not depend on success since
 * the directory lives in `/tmp` and will go away on container restart.
 */
export function removeSessionMcpConfig(input: {
  runtimeDir: string;
  orchestratorId: string;
  sessionId: string;
}): void {
  const dir = sessionDirFor(input.runtimeDir, input.orchestratorId, input.sessionId);
  const filePath = path.join(dir, 'mcp.json');
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(
        JSON.stringify({
          event: 'mcp.config.unlink_failed',
          path: filePath,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  // Remove the now-empty per-session dir; ignore ENOTEMPTY in case some
  // other artifact got dropped there in a future phase.
  try {
    fs.rmdirSync(dir);
  } catch {
    /* best-effort */
  }
}
