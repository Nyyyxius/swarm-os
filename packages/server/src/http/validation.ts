import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * REST-only convenience: interpret a user-supplied `cwd` as workspace-relative
 * when it isn't already under `workspaceRoot`. Lets the dialog accept `/` or
 * `/reviewer` from a human who doesn't know the container's mount layout, while
 * scripts/agents that already send `/workspace/foo` keep working unchanged.
 *
 * Not applied to the MCP `spawn_worker` path — agents run inside the container
 * and see real paths.
 */
export function normalizeWorkspaceRelativeCwd(cwd: string, workspaceRoot: string): string {
  if (cwd === workspaceRoot || cwd.startsWith(workspaceRoot + path.sep)) {
    return cwd;
  }
  const trimmed = cwd.replace(/^\/+/, '');
  return trimmed.length === 0 ? workspaceRoot : path.join(workspaceRoot, trimmed);
}

/**
 * Validate that `cwd` resolves under `workspaceRoot` after symlink resolution.
 * Throws an Error with a descriptive message if not.
 *
 * Returns the realpath-resolved absolute path.
 */
export async function validateCwdUnderWorkspace(
  cwd: string,
  workspaceRoot: string,
): Promise<string> {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cwd must be a non-empty string');
  }
  let resolvedCwd: string;
  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(workspaceRoot);
  } catch (err) {
    throw new Error(
      `workspace root ${workspaceRoot} cannot be resolved (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  try {
    resolvedCwd = await fs.realpath(cwd);
  } catch (err) {
    throw new Error(
      `cwd ${cwd} cannot be resolved (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const rel = path.relative(resolvedRoot, resolvedCwd);
  // Reject if cwd escapes root via `..` or absolute paths outside.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `cwd ${resolvedCwd} is not under workspace root ${resolvedRoot} (resolved relative: ${rel})`,
    );
  }
  return resolvedCwd;
}
