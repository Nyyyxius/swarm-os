import * as fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import type { GraphStore } from '../../modules/codegraph/store.js';
import { graphJsonPath, graphHtmlPath } from '../../modules/codegraph/graphify.js';
import { searchNodes } from '../../modules/codegraph/query.js';

/**
 * Read-only REST surface for the code graph (docs/graphify-integration.md, P3).
 * Backs the P4 web `#/graph` page. Mounted with the AUTHENTICATED routers in
 * `http/main.ts` (behind X-Auth-Token). Live updates ride `/ws/events` via the
 * `code.graph.*` events the store emits.
 *
 * Endpoints:
 *   GET /api/codegraph                       -> { scopes: [...] }
 *   GET /api/codegraph/:scopeId/graph        -> the scope's graph.json (404 if none)
 *   GET /api/codegraph/:scopeId/search?q=&limit= -> { ok, results | reason }
 *
 * Never throws: unknown scope / missing graph / bad query → a clean 404/400 JSON.
 */
export function createCodegraphRouter(graph: GraphStore): Router {
  const router = Router();

  // List every known scope (the web decides how to present enabled/disabled).
  router.get('/api/codegraph', (_req: Request, res: Response) => {
    const scopes = graph.listScopes().map((s) => ({
      id: s.id,
      kind: s.kind,
      path: s.path,
      enabled: s.enabled,
      status: s.status,
      nodeCount: s.nodeCount,
      edgeCount: s.edgeCount,
      lastIndexedAt: s.lastIndexedAt,
      lastError: s.lastError,
    }));
    res.json({ scopes });
  });

  // Serve the scope's NetworkX graph.json straight from disk (full graph — fine
  // for P4 to start). 404 when the scope is unknown or has never been indexed.
  router.get('/api/codegraph/:scopeId/graph', (req: Request, res: Response) => {
    const scopeId = String(req.params.scopeId ?? '');
    const scope = graph.getScope(scopeId);
    if (!scope) {
      res.status(404).json({ error: `unknown scope '${scopeId}'` });
      return;
    }
    const file = graphJsonPath(graph.indexDirFor(scopeId));
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      res.status(404).json({ error: `scope '${scopeId}' has no graph yet` });
      return;
    }
    res.type('application/json').send(raw);
  });

  // Serve graphify's self-contained interactive `graph.html` (sibling of
  // graph.json) so the web can open the WHOLE graph in a new tab for scopes
  // too big to render into d3-force. 404 when the scope is unknown or the html
  // was never emitted. Never throws (try/catch around the disk read).
  router.get('/api/codegraph/:scopeId/graph.html', (req: Request, res: Response) => {
    const scopeId = String(req.params.scopeId ?? '');
    const scope = graph.getScope(scopeId);
    if (!scope) {
      res.status(404).json({ error: `unknown scope '${scopeId}'` });
      return;
    }
    const file = graphHtmlPath(graph.indexDirFor(scopeId));
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      res.status(404).json({ error: 'scope has no graph.html yet' });
      return;
    }
    res.type('text/html').send(raw);
  });

  // Node search over the scope's graph.json (reuses the MCP search core).
  router.get('/api/codegraph/:scopeId/search', (req: Request, res: Response) => {
    const scopeId = String(req.params.scopeId ?? '');
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 15;
    if (!q) {
      res.status(400).json({ ok: false, reason: 'query parameter `q` is required' });
      return;
    }
    const scope = graph.getScope(scopeId);
    if (!scope) {
      res.status(404).json({ ok: false, reason: `unknown scope '${scopeId}'` });
      return;
    }
    const result = searchNodes(graphJsonPath(graph.indexDirFor(scopeId)), q, limit);
    if (!result.ok) {
      res.status(404).json({ ok: false, reason: result.reason });
      return;
    }
    res.json({ ok: true, scope: scopeId, results: result.results });
  });

  return router;
}
