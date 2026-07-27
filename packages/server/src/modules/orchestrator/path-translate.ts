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
 * This helper does not choose the roots — its callers do. `workspaceRoot` is
 * translated too, just not here: `session.ts` (`_buildPathMapper`) builds a
 * `workspace` mapper over `{workspaceRoot → hostWorkspaceRoot}` and runs the
 * session cwd through it before handing it to ssh, `ssh-exec.ts`
 * (`translateCwdForHost`) does the same for plugin-supplied cwds, and
 * `plugins/agent-assets.ts` for agent asset paths. The cwd stored in DB is a
 * CONTAINER path; it is translated at spawn time, not at rest.
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
