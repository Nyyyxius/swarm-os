/**
 * Skill assets — stage a skill's `assets/` dir into the agent workspace.
 *
 * Mirrors `plugins/agent-assets.ts`: at activation, a skill's declared assets
 * are copied into `<workspaceRoot>/.swarm-skills/<name>/` (bind-mounted, visible
 * to agents even over SSH, executable bit preserved via `fs.cpSync`). Removed at
 * deactivation/uninstall. `skillAssetsBasePath` returns the transport-aware base
 * path the activation announcement points agents at.
 *
 * Lot 1a stages at the WORKSPACE ROOT (shared, like plugins), not per-session —
 * role-scoped activation means a team's sessions share the same skills.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toHostPath } from '../orchestrator/path-translate.js';
import { withModule } from '../../logger.js';

const log = withModule('skills.assets');

/** Directory under the workspace holding every activated skill's assets. */
export const SKILL_ASSETS_SUBDIR = '.swarm-skills';

/** Minimal config shape needed to resolve/copy skill assets. */
export interface SkillAssetsConfig {
  workspaceRoot: string;
  hostWorkspaceRoot: string | null;
  agentTransport: string;
}

function destDir(workspaceRoot: string, name: string): string {
  return path.join(workspaceRoot, SKILL_ASSETS_SUBDIR, name);
}

/**
 * Agent-facing base path for a skill's assets. Container path locally; under SSH
 * the workspace bind-mount is translated to its host equivalent.
 */
export function skillAssetsBasePath(config: SkillAssetsConfig, name: string): string {
  const containerPath = destDir(config.workspaceRoot, name);
  if (config.agentTransport === 'ssh' && config.hostWorkspaceRoot) {
    return toHostPath({
      containerPath,
      dataDir: config.workspaceRoot,
      hostDataDir: config.hostWorkspaceRoot,
    });
  }
  return containerPath;
}

/**
 * Copy `<skillDir>/<assetsDir>` → `<workspaceRoot>/.swarm-skills/<name>`,
 * overwriting any previous copy. Best-effort: a filesystem failure is logged,
 * never fatal. Returns true on a successful copy.
 */
export function copySkillAssets(
  workspaceRoot: string,
  skillDir: string,
  name: string,
  assetsDir: string,
): boolean {
  const src = path.resolve(skillDir, assetsDir);
  // Anti-traversal: the assets dir must stay inside the skill folder.
  const rel = path.relative(skillDir, src);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    log.warn({ event: 'skills.assets_bad_dir', skill: name, dir: assetsDir });
    return false;
  }
  const dest = destDir(workspaceRoot, name);
  try {
    if (!fs.existsSync(src)) {
      log.warn({ event: 'skills.assets_missing', skill: name, src });
      return false;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    log.info({ event: 'skills.assets_copied', skill: name, dest });
    return true;
  } catch (err) {
    log.warn({
      event: 'skills.assets_copy_failed',
      skill: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Remove a skill's staged assets. Best-effort, idempotent. */
export function removeSkillAssets(workspaceRoot: string, name: string): void {
  const dest = destDir(workspaceRoot, name);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    log.info({ event: 'skills.assets_removed', skill: name, dest });
  } catch (err) {
    log.warn({
      event: 'skills.assets_remove_failed',
      skill: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
