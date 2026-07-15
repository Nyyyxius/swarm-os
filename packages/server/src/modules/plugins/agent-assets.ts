/**
 * agentAssets — scripts/CLI a plugin ships for the AGENTS to run (plan §J2).
 *
 * At enable, the declared `agentAssets.dir` is copied recursively into
 * `<workspaceRoot>/.swarm-plugins/<name>/` (executable modes preserved via
 * `fs.cpSync`, which copies source file modes). The workspace is bind-mounted,
 * so agents — even over the SSH transport — see the files. At disable/uninstall
 * the folder is removed.
 *
 * The relative `.swarm-plugins/<name>/` only resolves when an agent's cwd IS the
 * workspace root, and an absolute path differs by transport. So the API exposes
 * a transport-aware BASE PATH (`api.agentAssets.basePath`) the plugin uses in
 * its announcements: container path locally, host path under SSH (red-team I-5).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toHostPath } from '../orchestrator/path-translate.js';
import { withModule } from '../../logger.js';

const log = withModule('plugins.agent-assets');

/** Directory under the workspace that holds every plugin's copied assets. */
export const AGENT_ASSETS_SUBDIR = '.swarm-plugins';

/** Minimal config shape needed to resolve/copy agent assets. */
export interface AgentAssetsConfig {
  workspaceRoot: string;
  hostWorkspaceRoot: string | null;
  agentTransport: string;
}

/** Container-side destination `<workspaceRoot>/.swarm-plugins/<name>`. */
function destDir(config: AgentAssetsConfig, name: string): string {
  return path.join(config.workspaceRoot, AGENT_ASSETS_SUBDIR, name);
}

/**
 * Agent-facing base path for a plugin's assets. Container path locally; under
 * SSH the workspace bind-mount is translated to its host equivalent so the
 * remote claude resolves it in its own namespace.
 */
export function agentAssetsBasePath(config: AgentAssetsConfig, name: string): string {
  const containerPath = destDir(config, name);
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
 * Copy `<pluginDir>/<assetsDir>` → `<workspaceRoot>/.swarm-plugins/<name>`,
 * overwriting any previous copy. Best-effort: a filesystem failure is logged,
 * never fatal to enable (the plugin's MCP tools still work). Returns true on a
 * successful copy.
 */
export function copyAgentAssets(
  config: AgentAssetsConfig,
  pluginDir: string,
  name: string,
  assetsDir: string,
): boolean {
  const src = path.resolve(pluginDir, assetsDir);
  // Anti-traversal: the assets dir must stay inside the plugin folder.
  const rel = path.relative(pluginDir, src);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    log.warn({ event: 'plugins.agent_assets_bad_dir', plugin: name, dir: assetsDir });
    return false;
  }
  const dest = destDir(config, name);
  try {
    if (!fs.existsSync(src)) {
      log.warn({ event: 'plugins.agent_assets_missing', plugin: name, src });
      return false;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // cpSync copies source file modes (the executable bit survives).
    fs.cpSync(src, dest, { recursive: true, force: true });
    log.info({ event: 'plugins.agent_assets_copied', plugin: name, dest });
    return true;
  } catch (err) {
    log.warn({
      event: 'plugins.agent_assets_copy_failed',
      plugin: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Remove a plugin's copied assets. Best-effort. */
export function removeAgentAssets(config: AgentAssetsConfig, name: string): void {
  const dest = destDir(config, name);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    log.info({ event: 'plugins.agent_assets_removed', plugin: name, dest });
  } catch (err) {
    log.warn({
      event: 'plugins.agent_assets_remove_failed',
      plugin: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
