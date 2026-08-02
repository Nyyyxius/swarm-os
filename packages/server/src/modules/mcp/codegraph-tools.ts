import * as fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, logCall, type ToolContext } from './tools.js';
import type { GraphStore, CodegraphScope } from '../codegraph/store.js';
import { graphJsonPath, runExplain, runPath } from '../codegraph/graphify.js';
import { searchNodes } from '../codegraph/query.js';

/**
 * MCP codegraph tools (docs/graphify-integration.md, P2) — the agent-facing
 * query surface over the live, auto-maintained code graph. Exposed to EVERY
 * agent on the same `team-comms` server, right after the memory/board sets.
 *
 * This is where the token saving lands: instead of grepping or reading whole
 * files, an agent asks `codegraph.search` / `explain` / `path` and gets a
 * compressed subgraph with `file:line` citations.
 *
 * All tools are READ-ONLY and open to leads and workers alike. Unlike the
 * memory tools they NEVER throw for an unavailable/unindexed condition — they
 * return a clean `{ ok:false, reason }` so an agent can react in-band (the graph
 * is a best-effort accelerator, not a hard dependency).
 */

/** Default binary when the (test) config carries none. */
function graphBin(ctx: ToolContext): string {
  return (ctx.config as { codegraphBin?: string })?.codegraphBin ?? 'graphify';
}

type ResolveOk = { ok: true; scope: CodegraphScope; graphPath: string };
type ResolveErr = { ok: false; reason: string };

/** Enabled scopes whose graph.json exists on disk (i.e. actually queryable). */
function queryableScopes(store: GraphStore): Array<{ scope: CodegraphScope; graphPath: string }> {
  const out: Array<{ scope: CodegraphScope; graphPath: string }> = [];
  for (const scope of store.listScopes()) {
    if (!scope.enabled) continue;
    const graphPath = graphJsonPath(store.indexDirFor(scope.id));
    if (fs.existsSync(graphPath)) out.push({ scope, graphPath });
  }
  return out;
}

/**
 * Resolve the target scope: explicit id when given, else the sole queryable
 * scope. Ambiguity / absence / not-yet-indexed all come back as a clean reason
 * that lists the available scope ids so the agent can retry.
 */
function resolveScope(store: GraphStore | undefined, scopeArg: string | undefined): ResolveOk | ResolveErr {
  if (!store) return { ok: false, reason: 'CODEGRAPH_UNAVAILABLE: the code graph is not enabled on this deployment' };
  const queryable = queryableScopes(store);
  const ids = queryable.map((q) => q.scope.id);

  if (scopeArg) {
    const hit = queryable.find((q) => q.scope.id === scopeArg);
    if (hit) return { ok: true, scope: hit.scope, graphPath: hit.graphPath };
    // Distinguish "exists but not indexed" from "unknown".
    const known = store.getScope(scopeArg);
    if (known) {
      return { ok: false, reason: `scope '${scopeArg}' is not indexed yet (status: ${known.status}). Indexed scopes: ${ids.join(', ') || '(none)'}` };
    }
    return { ok: false, reason: `unknown scope '${scopeArg}'. Indexed scopes: ${ids.join(', ') || '(none)'}` };
  }

  if (queryable.length === 0) return { ok: false, reason: 'no indexed code scope is available yet' };
  const only = queryable[0];
  if (queryable.length === 1 && only) return { ok: true, scope: only.scope, graphPath: only.graphPath };
  return { ok: false, reason: `multiple scopes indexed — pass one of: ${ids.join(', ')}` };
}

export function registerGraphTools(server: McpServer, ctxResolver: () => ToolContext): void {
  // ---- codegraph.list ---------------------------------------------------
  server.registerTool(
    'codegraph.list',
    {
      title: 'List indexed code-graph scopes',
      description:
        'List the code-graph scopes (workspace projects + installed plugins) that swarm-os maintains. Each entry carries id, kind (project|plugin), path, status, nodeCount, edgeCount and lastIndexedAt. Use a returned `id` as the `scope` argument to codegraph.search / explain / path. Returns `{ ok:false, reason }` when the code graph is unavailable.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        scopes: z
          .array(
            z.object({
              id: z.string(),
              kind: z.string(),
              path: z.string(),
              status: z.string(),
              nodeCount: z.number(),
              edgeCount: z.number(),
              lastIndexedAt: z.number().nullable(),
            }),
          )
          .optional(),
      },
    },
    () => {
      const ctx = ctxResolver();
      if (!ctx.graph) {
        logCall('codegraph.list', ctx, false, 'CODEGRAPH_UNAVAILABLE');
        return ok({ ok: false, reason: 'CODEGRAPH_UNAVAILABLE: the code graph is not enabled on this deployment' });
      }
      const scopes = ctx.graph
        .listScopes()
        .filter((s) => s.enabled)
        .map((s) => ({
          id: s.id,
          kind: s.kind,
          path: s.path,
          status: s.status,
          nodeCount: s.nodeCount,
          edgeCount: s.edgeCount,
          lastIndexedAt: s.lastIndexedAt,
        }));
      logCall('codegraph.list', ctx, true);
      return ok({ ok: true, scopes });
    },
  );

  // ---- codegraph.search -------------------------------------------------
  server.registerTool(
    'codegraph.search',
    {
      title: 'Search the code graph for symbols',
      description:
        'Find code entities (files, functions, classes) whose name/label matches `query` (case-insensitive; exact & prefix matches rank first). Returns the top matches with their `file:line` and community — a compressed, cited answer to reach for BEFORE grepping or reading whole files. `scope` selects which project/plugin graph to search (omit it when only one scope is indexed; codegraph.list shows the ids). `limit` defaults to 15. Returns `{ ok:false, reason }` when unavailable / scope ambiguous.',
      inputSchema: {
        query: z.string().min(1),
        scope: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        scope: z.string().optional(),
        results: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              file: z.string().nullable(),
              line: z.number().nullable(),
              fileType: z.string().nullable(),
              community: z.string().nullable(),
            }),
          )
          .optional(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as { query: string; scope?: string; limit?: number };
      const resolved = resolveScope(ctx.graph, a.scope);
      if (!resolved.ok) {
        logCall('codegraph.search', ctx, false, resolved.reason);
        return ok({ ok: false, reason: resolved.reason });
      }
      const res = searchNodes(resolved.graphPath, a.query, a.limit ?? 15);
      if (!res.ok) {
        logCall('codegraph.search', ctx, false, res.reason);
        return ok({ ok: false, reason: res.reason, scope: resolved.scope.id });
      }
      logCall('codegraph.search', ctx, true);
      return ok({ ok: true, scope: resolved.scope.id, results: res.results });
    },
  );

  // ---- codegraph.explain ------------------------------------------------
  server.registerTool(
    'codegraph.explain',
    {
      title: 'Explain a code-graph node and its neighbours',
      description:
        'Explain one node (a function/class/file — pass its label or id from codegraph.search) and its typed edges (imports, calls, contains…) with `file:line` citations. This is the compressed subgraph around a symbol. `scope` selects the project/plugin (omit when only one is indexed). Returns `{ ok:false, reason }` when unavailable.',
      inputSchema: {
        node: z.string().min(1),
        scope: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        scope: z.string().optional(),
        node: z.string().optional(),
        explanation: z.string().optional(),
      },
    },
    async (args) => {
      const ctx = ctxResolver();
      const a = args as { node: string; scope?: string };
      const resolved = resolveScope(ctx.graph, a.scope);
      if (!resolved.ok) {
        logCall('codegraph.explain', ctx, false, resolved.reason);
        return ok({ ok: false, reason: resolved.reason });
      }
      const res = await runExplain(graphBin(ctx), resolved.graphPath, a.node);
      if (!res.ok) {
        logCall('codegraph.explain', ctx, false, res.error);
        return ok({ ok: false, reason: res.error, scope: resolved.scope.id });
      }
      logCall('codegraph.explain', ctx, true);
      return ok({ ok: true, scope: resolved.scope.id, node: a.node, explanation: res.text });
    },
  );

  // ---- codegraph.path ---------------------------------------------------
  server.registerTool(
    'codegraph.path',
    {
      title: 'Shortest path between two code-graph nodes',
      description:
        'Trace the shortest dependency/call path between two nodes (`from` → `to`, each a label or id from codegraph.search). Answers "how does X reach Y?" without reading the files in between. `scope` selects the project/plugin (omit when only one is indexed). Returns `{ ok:false, reason }` when unavailable.',
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1),
        scope: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string().optional(),
        scope: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async (args) => {
      const ctx = ctxResolver();
      const a = args as { from: string; to: string; scope?: string };
      const resolved = resolveScope(ctx.graph, a.scope);
      if (!resolved.ok) {
        logCall('codegraph.path', ctx, false, resolved.reason);
        return ok({ ok: false, reason: resolved.reason });
      }
      const res = await runPath(graphBin(ctx), resolved.graphPath, a.from, a.to);
      if (!res.ok) {
        logCall('codegraph.path', ctx, false, res.error);
        return ok({ ok: false, reason: res.error, scope: resolved.scope.id });
      }
      logCall('codegraph.path', ctx, true);
      return ok({ ok: true, scope: resolved.scope.id, from: a.from, to: a.to, path: res.text });
    },
  );
}
