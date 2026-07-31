import { Router, type Request, type Response } from 'express';
import {
  MemoryConflictError,
  MemoryError,
  MEMORY_NOTE_TYPES,
  type MemoryStore,
} from '../../modules/memory/store.js';

/**
 * REST surface for the shared knowledge graph (docs/memoire-partagee.md §8).
 *
 * Mounted with the AUTHENTICATED routers in `http/main.ts` (behind
 * X-Auth-Token). Paths live under `/api/memory` per the shared DTO contract —
 * the same shapes the web client consumes. Live updates ride the existing
 * `/ws/events` stream via the `memory.*` events the store emits.
 *
 * Endpoints:
 *   GET    /api/memory                 -> { notes: MemoryNoteMeta[] }
 *   GET    /api/memory/graph           -> { nodes: GraphNode[], edges: GraphEdge[] }
 *   GET    /api/memory/search?q=&type=&limit= -> { results: SearchHit[] }
 *   GET    /api/memory/:name           -> MemoryNote (404 if absent)
 *   PUT    /api/memory/:name           -> MemoryNote (409 on version conflict)
 *   DELETE /api/memory/:name           -> { ok: true }
 */

const VALID_TYPES: ReadonlySet<string> = new Set(MEMORY_NOTE_TYPES);

export function createMemoryRouter(memory: MemoryStore): Router {
  const router = Router();

  // List note metadata. `type`/`prefix` optional query filters (handy for the UI).
  router.get('/api/memory', (req: Request, res: Response) => {
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : null;
    res.json({ notes: memory.list(type, prefix) });
  });

  // Whole graph — declared BEFORE `/:name` so it isn't captured as a note name.
  router.get('/api/memory/graph', (_req: Request, res: Response) => {
    res.json(memory.graph());
  });

  // FTS search. `q` is the query; `type` narrows; `limit` caps (default 20).
  router.get('/api/memory/search', (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    res.json({ results: memory.search(q, type, limit) });
  });

  router.get('/api/memory/:name', (req: Request<{ name: string }>, res: Response) => {
    const note = memory.readNote(req.params.name);
    if (!note) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(note);
  });

  router.put('/api/memory/:name', (req: Request<{ name: string }>, res: Response) => {
    const body = (req.body ?? {}) as {
      description?: unknown;
      type?: unknown;
      body?: unknown;
      expectedVersion?: unknown;
    };
    if (typeof body.type !== 'string' || !VALID_TYPES.has(body.type)) {
      res
        .status(400)
        .json({ error: `type must be one of ${[...VALID_TYPES].join('|')}` });
      return;
    }
    if (body.description != null && typeof body.description !== 'string') {
      res.status(400).json({ error: 'description must be a string' });
      return;
    }
    if (body.body != null && typeof body.body !== 'string') {
      res.status(400).json({ error: 'body must be a string' });
      return;
    }
    let expectedVersion: number | undefined;
    if (body.expectedVersion != null) {
      if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
        res.status(400).json({ error: 'expectedVersion must be an integer' });
        return;
      }
      expectedVersion = body.expectedVersion;
    }

    try {
      memory.upsertNote({
        name: req.params.name,
        description: typeof body.description === 'string' ? body.description : '',
        type: body.type,
        body: typeof body.body === 'string' ? body.body : '',
        // Provenance for an operator/web write — no session behind a REST call.
        createdBy: 'web',
        team: null,
        expectedVersion,
      });
      const note = memory.readNote(req.params.name);
      if (!note) {
        // Should not happen (we just wrote it) — surface honestly rather than 200.
        res.status(500).json({ error: 'note written but could not be read back' });
        return;
      }
      res.json(note);
    } catch (err) {
      if (err instanceof MemoryConflictError) {
        res.status(409).json({
          error: err.message,
          code: err.code,
          currentVersion: err.currentVersion,
        });
        return;
      }
      if (err instanceof MemoryError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'MEMORY_WRITE_FAILED',
      });
    }
  });

  router.delete('/api/memory/:name', (req: Request<{ name: string }>, res: Response) => {
    memory.deleteNote(req.params.name);
    res.json({ ok: true });
  });

  return router;
}
