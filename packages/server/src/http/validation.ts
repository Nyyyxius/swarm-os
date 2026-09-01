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

/** Naming knobs so one containment check can phrase errors for two callers. */
export interface ResolveUnderRootsOptions {
  /** How the value is named in error messages (`cwd`, `scriptPath`). */
  label?: string;
  /** How the allowed roots are named (`workspace root`, `workspace/data root`). */
  rootLabel?: string;
}

/**
 * Containment check for an operator-supplied path: resolve it, resolve every
 * allowed root, and accept only if the resolved path sits inside one of them.
 *
 * BOTH sides are realpath'd on purpose. Comparing the raw strings would accept
 * `<root>/link` where `link` is a symlink pointing anywhere on the filesystem —
 * the whole point of the check is that the *target*, not the name, is contained.
 *
 * Returns the REALPATH, and callers are expected to use that value (not their
 * original input) for whatever they do next: re-checking a path and then acting
 * on the un-resolved string leaves the symlink swap (TOCTOU) wide open, which is
 * exactly the window a cron script re-validated at every fire must not have
 * (docs/crons-agents.md §2.5).
 *
 * Generalised from `validateCwdUnderWorkspace` (its single-root special case) so
 * the cron runner can allow the workspace AND the data root without duplicating
 * the symlink handling.
 */
export async function resolveUnderRoots(
  p: string,
  roots: readonly string[],
  opts: ResolveUnderRootsOptions = {},
): Promise<string> {
  const label = opts.label ?? 'path';
  const rootLabel = opts.rootLabel ?? 'root';
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (roots.length === 0) throw new Error(`no ${rootLabel} is configured`);

  // An unresolvable root is skipped rather than fatal: with several roots, one
  // missing mount must not deny the ones that are there. Only "none of them
  // resolved" is an error, and it reports the first reason.
  const resolvedRoots: string[] = [];
  let rootError: string | null = null;
  for (const root of roots) {
    try {
      resolvedRoots.push(await fs.realpath(root));
    } catch (err) {
      rootError ??= `${rootLabel} ${root} cannot be resolved (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  if (resolvedRoots.length === 0) {
    throw new Error(rootError ?? `${rootLabel} cannot be resolved`);
  }

  let resolved: string;
  try {
    resolved = await fs.realpath(p);
  } catch (err) {
    throw new Error(
      `${label} ${p} cannot be resolved (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  for (const root of resolvedRoots) {
    const rel = path.relative(root, resolved);
    // Inside means: same path (`rel === ''`) or a descendant. A `..` prefix or
    // an absolute `rel` means the path escaped this root.
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved;
  }

  const only = resolvedRoots.length === 1 ? resolvedRoots[0] : undefined;
  if (only !== undefined) {
    const rel = path.relative(only, resolved);
    throw new Error(
      `${label} ${resolved} is not under ${rootLabel} ${only} (resolved relative: ${rel})`,
    );
  }
  throw new Error(
    `${label} ${resolved} is not under ${rootLabel} (${resolvedRoots.join(' | ')})`,
  );
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
  return resolveUnderRoots(cwd, [workspaceRoot], {
    label: 'cwd',
    rootLabel: 'workspace root',
  });
}
