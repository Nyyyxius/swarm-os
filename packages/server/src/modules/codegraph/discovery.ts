/**
 * Scope discovery — decides WHAT gets a code graph, and whether it's currently
 * eligible (the C3 "code detected" gate).
 *
 * Two families (docs §4.1, decisions Q1/Q4):
 *   - Workspace PROJECTS: every top-level subdir of `workspaceRoot`, PLUS the
 *     workspace root itself (root-level first-party code counts).
 *   - PLUGINS: each installed plugin at `<dataDir>/plugins/<name>`.
 *
 * For every candidate we run the C3 gate (`hasCodeFiles`, dependency/build/VCS
 * dirs excluded). A candidate with zero first-party code files is still returned
 * but with `hasCode:false` so the caller records it as `disabled` (re-evaluated
 * each sweep) — a docs-only dir never produces a graph.
 *
 * Pure and side-effect-free: it reads the filesystem + plugin registry and
 * returns descriptors. Reconciling them into the store is the janitor's job.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { CodegraphScopeKind } from './store.js';
import { hasCodeFiles } from './scan.js';
import { IGNORED_DIR_NAMES } from './constants.js';

const log = withModule('codegraph.discovery');

export interface DiscoveredScope {
  id: string;
  kind: CodegraphScopeKind;
  /** Absolute source directory to hand to graphify. */
  path: string;
  /** C3 gate result: at least one first-party code file present. */
  hasCode: boolean;
}

/** Minimal shape of the plugin registry we consume (keeps discovery testable). */
export interface PluginLister {
  list(): Array<{ name: string }>;
}

export interface DiscoverScopesInput {
  workspaceRoot: string;
  dataDir: string;
  pluginStore?: PluginLister | null;
}

/**
 * Turn an arbitrary project/plugin name into a stable, filesystem-safe slug
 * segment. The scopeId doubles as the on-disk index dir name
 * (`<dataDir>/codegraph/<id>/`), so it must contain no path separators or
 * surprises. Collisions between differently-cased names are acceptable here —
 * two dirs `Foo` and `foo` sharing an index is far less likely in practice than
 * the safety win of a predictable slug.
 */
export function slugifyScopeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

export function projectScopeId(name: string): string {
  return `project__${slugifyScopeName(name)}`;
}

export function pluginScopeId(name: string): string {
  return `plugin__${slugifyScopeName(name)}`;
}

/** Root-of-workspace scope id (decision Q4: the workspace root itself). */
export const WORKSPACE_ROOT_SCOPE_ID = 'project__root';

function safeReaddirDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name);
  } catch (err) {
    log.debug({ event: 'codegraph.discovery_readdir_failed', dir, error: String(err) });
    return [];
  }
}

export function discoverScopes(input: DiscoverScopesInput): DiscoveredScope[] {
  const scopes: DiscoveredScope[] = [];
  const seen = new Set<string>();

  const push = (id: string, kind: CodegraphScopeKind, dir: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    let hasCode = false;
    try {
      hasCode = hasCodeFiles(dir);
    } catch (err) {
      log.debug({ event: 'codegraph.gate_failed', id, dir, error: String(err) });
    }
    scopes.push({ id, kind, path: dir, hasCode });
  };

  // --- Workspace: the root itself + each top-level subdir --------------------
  const workspaceRoot = path.resolve(input.workspaceRoot);
  if (fs.existsSync(workspaceRoot)) {
    push(WORKSPACE_ROOT_SCOPE_ID, 'project', workspaceRoot);
    for (const name of safeReaddirDirs(workspaceRoot)) {
      // Skip dependency/build/VCS dirs sitting at the workspace root — they are
      // not "projects" (and one may literally be `node_modules`).
      if (IGNORED_DIR_NAMES.has(name)) continue;
      push(projectScopeId(name), 'project', path.join(workspaceRoot, name));
    }
  } else {
    log.debug({ event: 'codegraph.workspace_root_missing', workspaceRoot });
  }

  // --- Plugins: each installed plugin dir ------------------------------------
  const pluginsDir = path.join(path.resolve(input.dataDir), 'plugins');
  if (input.pluginStore) {
    let rows: Array<{ name: string }> = [];
    try {
      rows = input.pluginStore.list();
    } catch (err) {
      log.warn({ event: 'codegraph.plugin_list_failed', error: String(err) });
    }
    for (const row of rows) {
      if (!row?.name) continue;
      const dir = path.join(pluginsDir, row.name);
      if (!fs.existsSync(dir)) continue;
      push(pluginScopeId(row.name), 'plugin', dir);
    }
  }

  return scopes;
}
