// paths.js — pure path helpers. No I/O, no module state, no side effects.
//
// Three concerns, all of them about ONE question: where does a generated file
// live, and what does that path mean to whoever reads it?
//   - workspaceRoot()    the CONTAINER-side root of the bind-mounted workspace.
//   - toAgentPath()      container path -> path the AGENT can actually resolve.
//                        Identity under the `local` transport; under `ssh` the
//                        `claude` process runs on the HOST and resolves paths in
//                        its own namespace, so `/workspace/x` must become
//                        `<hostWorkspaceRoot>/x` or the agent's Read gets ENOENT.
//   - resolveOutputDir() containment: the operator's relative `outputDir` may
//                        never escape the workspace (the plugin runs in-process
//                        with the server's rights).
//
// `path.resolve` is applied on BOTH sides of every comparison, exactly like the
// server does (packages/server/src/config.ts:587 and :727) — a trailing slash or
// a non-normalised env value must not silently defeat the prefix test.
//
// NOTE (ESM cache) — modules under lib/ SURVIVE an enable/disable cycle: the
// loader's cache-buster is applied to index.js only
// (packages/server/src/modules/plugins/loader.ts:29-30) and a relative import
// resolved from that busted URL loses the query. Nothing here may hold mutable
// module state; every function re-reads process.env on each call.

import * as path from 'node:path';

/** Container mount point of the workspace when the env var is unset. */
const DEFAULT_WS = '/workspace';

/**
 * Absolute, normalised container path of the workspace root.
 *
 * `SWARM_OS_WORKSPACE_ROOT` is the official precedent for a plugin
 * (`discord-agent/lib/provision.js:29-30`).
 *
 * @returns {string}
 */
export function workspaceRoot() {
  return path.resolve(process.env.SWARM_OS_WORKSPACE_ROOT || DEFAULT_WS);
}

/**
 * Container path → path the AGENT can resolve (identity under the local
 * transport).
 *
 * Under `ssh`, `SWARM_OS_HOST_WORKSPACE_ROOT` is guaranteed present — the server
 * refuses to boot without it (`packages/server/src/config.ts:740-744`) — so the
 * fallback below only ever fires under the local transport.
 *
 * @param {string} containerAbs absolute path inside the container
 * @returns {string}
 */
export function toAgentPath(containerAbs) {
  const ws = workspaceRoot();
  const raw = process.env.SWARM_OS_HOST_WORKSPACE_ROOT;
  if (process.env.SWARM_OS_AGENT_TRANSPORT !== 'ssh' || !raw) return containerAbs;
  const host = path.resolve(raw);
  if (containerAbs === ws) return host;
  if (containerAbs.startsWith(ws + path.sep)) return host + containerAbs.slice(ws.length);
  return containerAbs; // outside the bind mount — the host would not see it anyway
}

/**
 * Resolve the operator's RELATIVE `outputDir` against the workspace root and
 * refuse anything that escapes it (absolute path, `..` traversal, symlink-free
 * lexical check only — the caller creates the directory itself).
 *
 * This is the plugin's only write path that is not a fixed constant, and the
 * value comes from the operator, never from an agent.
 *
 * @param {string} rel path relative to the workspace root
 * @returns {string} absolute container path
 * @throws {Error} when the resolved path escapes the workspace
 */
export function resolveOutputDir(rel) {
  const ws = workspaceRoot();
  const raw = typeof rel === 'string' && rel.trim() !== '' ? rel.trim() : '.';
  const abs = path.resolve(ws, raw);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error(
      `outputDir invalide: "${raw}" resout vers "${abs}", hors du workspace "${ws}". ` +
        'Utiliser un chemin RELATIF sans ".." (exemple: "novelai").',
    );
  }
  return abs;
}
