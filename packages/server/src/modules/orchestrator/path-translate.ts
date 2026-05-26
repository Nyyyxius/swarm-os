import * as path from 'node:path';

/**
 * Translate a container-side absolute path into the equivalent host-side path
 * for use with `agentTransport=ssh`. The host claude resolves all paths in its
 * own namespace, so any path we hand it (`CLAUDE_CONFIG_DIR`, `--mcp-config`,
 * the cwd argument to `ssh`) must already be a host path.
 *
 * Mapping rule:
 *   <dataDir>/foo → <hostDataDir>/foo
 *
 * `workspaceRoot` is intentionally NOT translated here — when SSH mode is
 * active, the cwd stored in DB / passed to the session is already a host path
 * (per architectural decision: paths are host-native in SSH mode). Translation
 * is only needed for state created on the container side (per-session config
 * dirs, mcp.json runtime).
 */
export function toHostPath(opts: {
  containerPath: string;
  dataDir: string;
  hostDataDir: string;
}): string {
  const { containerPath, dataDir, hostDataDir } = opts;
  if (containerPath === dataDir) return hostDataDir;
  if (containerPath.startsWith(dataDir + path.sep)) {
    return hostDataDir + containerPath.slice(dataDir.length);
  }
  // Path lives outside the dataDir bind mount — likely /tmp or similar. The
  // host can't see those. Caller's responsibility to fail upstream if such a
  // path reaches the SSH command.
  return containerPath;
}
