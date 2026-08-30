// paths.js — pure path helpers. No I/O, no module state, no side effects.
//
// One question, four answers: where does a file live, and what does that path
// mean to whoever reads it?
//   - workspaceRoot()    the CONTAINER-side root of the bind-mounted workspace.
//   - toAgentPath()      container path -> path the AGENT can resolve. Identity
//                        under the `local` transport; under `ssh` the `claude`
//                        process runs on the HOST and resolves paths in its own
//                        namespace, so `/workspace/x` must become
//                        `<hostWorkspaceRoot>/x` or the agent's Read gets ENOENT.
//   - toContainerPath()  THE INVERSE, and the reason this file differs from the
//                        novelai one. This plugin does not only WRITE files: an
//                        agent hands it a path to read (an image to describe, a
//                        photo to edit). What the agent hands back is a path in
//                        ITS namespace — under `ssh` that path does not exist in
//                        the container. Without this translation, every vision
//                        call from a production (ssh) swarm would ENOENT while
//                        working perfectly in local dev.
//   - resolveOutputDir() containment: the operator's relative `outputDir` may
//                        never escape the workspace (the plugin runs in-process
//                        with the server's rights).
//
// `path.resolve` is applied on BOTH sides of every comparison, exactly like the
// server does (packages/server/src/config.ts:587 and :727) — a trailing slash or
// a non-normalised env value must not silently defeat a prefix test.
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
 * The HOST-side root of the same bind mount, or null when it does not apply
 * (local transport, or the variable is unset).
 *
 * Under `ssh`, `SWARM_OS_HOST_WORKSPACE_ROOT` is guaranteed present — the server
 * refuses to boot without it (`packages/server/src/config.ts:740-744`).
 *
 * @returns {string|null}
 */
function hostRoot() {
  const raw = process.env.SWARM_OS_HOST_WORKSPACE_ROOT;
  if (process.env.SWARM_OS_AGENT_TRANSPORT !== 'ssh' || !raw) return null;
  return path.resolve(raw);
}

/**
 * Container path → path the AGENT can resolve (identity under the local
 * transport).
 *
 * @param {string} containerAbs absolute path inside the container
 * @returns {string}
 */
export function toAgentPath(containerAbs) {
  const host = hostRoot();
  if (!host) return containerAbs;
  const ws = workspaceRoot();
  if (containerAbs === ws) return host;
  if (containerAbs.startsWith(ws + path.sep)) return host + containerAbs.slice(ws.length);
  return containerAbs; // outside the bind mount — the host would not see it anyway
}

/**
 * Path as the AGENT wrote it → path THIS process can open. The inverse of
 * `toAgentPath`, and deliberately permissive about which of the three forms an
 * agent may hand over, because all three are things it legitimately has:
 *
 *   - a relative path              -> resolved against the workspace root
 *   - a host path (`ssh`)          -> rewritten onto the container mount
 *   - a container path             -> already correct, kept as-is
 *
 * CONTAINMENT IS ENFORCED HERE, not by the caller: the resolved path must land
 * inside the workspace. This plugin runs in-process with the server's rights, so
 * an agent asking it to "describe /etc/shadow" or to attach `../../root/.ssh/id_rsa`
 * to a prompt would otherwise exfiltrate it to Google. The check is lexical
 * (a symlink inside the workspace pointing out of it is not caught) — a
 * deliberate, documented limit, consistent with `resolveOutputDir`.
 *
 * @param {string} p path in any of the three forms above
 * @returns {string} absolute CONTAINER path, guaranteed inside the workspace
 * @throws {Error} when the path escapes the workspace
 */
export function toContainerPath(p) {
  const ws = workspaceRoot();
  const raw = typeof p === 'string' ? p.trim() : '';
  if (raw === '') throw new Error('chemin vide');

  let candidate = raw;
  const host = hostRoot();
  // Host -> container FIRST: under `ssh` a host path is absolute, so the plain
  // `path.resolve` below would keep it verbatim and then fail containment with
  // a message about the workspace that would look like the agent's mistake.
  if (host) {
    if (candidate === host) candidate = ws;
    else if (candidate.startsWith(host + path.sep)) candidate = ws + candidate.slice(host.length);
  }

  const abs = path.resolve(ws, candidate);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error(
      `chemin hors du workspace : "${raw}" resout vers "${abs}", en dehors de "${ws}". ` +
        'Seuls les fichiers du workspace peuvent etre lus.',
    );
  }
  return abs;
}

/**
 * Resolve the operator's RELATIVE `outputDir` against the workspace root and
 * refuse anything that escapes it (absolute path, `..` traversal, symlink-free
 * lexical check only — the caller creates the directory itself).
 *
 * The value comes from the operator, never from an agent.
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
        'Utiliser un chemin RELATIF sans ".." (exemple: "gemini").',
    );
  }
  return abs;
}
