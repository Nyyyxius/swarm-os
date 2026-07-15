/**
 * Plugin loader — native ESM `import()` with a cache-buster.
 *
 * `?v=<version>-<Date.now()>` forces Node's ESM loader to fetch a fresh module
 * graph on every enable/reload (the ESM cache is keyed by full URL). The
 * plugin lives OUTSIDE the server's `node_modules`, so it cannot resolve the
 * server's internals — an architectural boundary, not a sandbox.
 *
 * Bounded leak: the ESM cache is never released, so each enable cycle retains
 * a few tens of KB. Documented and accepted (see plan §Risques).
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SwarmPlugin } from './api-types.js';

/**
 * Import `<pluginDir>/<main>` and validate its default export implements
 * `SwarmPlugin`. Throws on a missing file (SyntaxError, module-not-found),
 * or an invalid/absent default export — callers isolate this per plugin so a
 * corrupt entry never aborts the boot sequence.
 */
export async function loadPluginModule(
  pluginDir: string,
  main: string,
  version: string,
): Promise<SwarmPlugin> {
  const entryPath = path.resolve(pluginDir, main);
  const bust = `v=${encodeURIComponent(version)}-${Date.now()}`;
  const url = `${pathToFileURL(entryPath).href}?${bust}`;

  const mod = (await import(url)) as { default?: unknown };
  const def = mod.default;
  if (!def || typeof def !== 'object') {
    throw new Error(`plugin entry '${main}' must have a default export`);
  }
  if (typeof (def as { activate?: unknown }).activate !== 'function') {
    throw new Error(`plugin entry '${main}' default export must have an activate() function`);
  }
  const deactivate = (def as { deactivate?: unknown }).deactivate;
  if (deactivate !== undefined && typeof deactivate !== 'function') {
    throw new Error(`plugin entry '${main}' deactivate must be a function when present`);
  }
  return def as SwarmPlugin;
}
