/**
 * codegraph — server-side code-knowledge-graph indexer (Graphify integration, P1).
 *
 * Owns a registry of indexable SCOPES (workspace projects + installed plugins),
 * a periodic janitor that runs graphify's AST-only `update` ONLY when a scope's
 * first-party code actually changed, and keeps every artifact under
 * `<dataDir>/codegraph/<scopeId>/` — never inside the user's source dirs.
 *
 * Invisible to agents in P1: no MCP tools / REST / web (those are P2–P4).
 */

export { GraphStore } from './store.js';
export type {
  CodegraphScope,
  CodegraphScopeKind,
  CodegraphScopeStatus,
  UpsertScopeInput,
} from './store.js';
export {
  discoverScopes,
  slugifyScopeName,
  projectScopeId,
  pluginScopeId,
  WORKSPACE_ROOT_SCOPE_ID,
} from './discovery.js';
export type { DiscoveredScope, PluginLister } from './discovery.js';
export {
  probeGraphify,
  runUpdate,
  parseCounts,
  runExplain,
  runPath,
  graphJsonPath,
  QUERY_TIMEOUT_MS,
} from './graphify.js';
export type { GraphifyAvailability, CodegraphEngine, RunUpdateResult, QueryResult } from './graphify.js';
export { searchNodes, readGraphJson, parseLine } from './query.js';
export type { GraphNodeHit, SearchResult } from './query.js';
export { startCodegraphJanitor } from './lifecycle.js';
export type { CodegraphJanitorHandle, CodegraphJanitorDeps } from './lifecycle.js';
export { hasCodeFiles, sourceFingerprint, isCodeExtension } from './scan.js';
