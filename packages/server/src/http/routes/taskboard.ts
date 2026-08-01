import { Router, type Request, type Response } from 'express';
import {
  TaskboardError,
  TASKBOARD_STATUSES,
  type TaskboardStore,
} from '../../modules/taskboard/store.js';

/**
 * REST surface for the durable task board (docs/tableau-de-taches.md §7/§8).
 *
 * Mounted with the AUTHENTICATED routers in `http/main.ts` (behind
 * X-Auth-Token), next to `createMemoryRouter`. Live updates ride the existing
 * `/ws/events` stream via the `taskboard.*` events the store emits.
 *
 * The web board is READ-ONLY (confirmed decision §11): the agents mutate the
 * board through the `board.*` MCP tools; the browser only observes it. The one
 * operator write is DELETE — a cleanup lever, chiefly for orphaned cards —
 * stamped with provenance `web` (there is no session behind a REST call).
 *
 * Endpoints:
 *   GET    /api/board?orch=&status=&assignee=  -> { cards: TaskboardCard[] }
 *   GET    /api/board/teams                     -> { teams: TaskboardTeam[] }
 *   GET    /api/board/card/:id                  -> TaskboardCardDetail (404 if absent)
 *   DELETE /api/board/card/:id                  -> { ok: true, deleted: boolean }
 */

const VALID_STATUSES: ReadonlySet<string> = new Set(TASKBOARD_STATUSES);

export function createTaskboardRouter(taskboard: TaskboardStore): Router {
  const router = Router();

  // List a team's cards. `orch` is REQUIRED (the board is per-team); `status`
  // and `assignee` are optional filters mirroring `board.list`.
  router.get('/api/board', (req: Request, res: Response) => {
    const orch = typeof req.query.orch === 'string' ? req.query.orch : '';
    if (!orch) {
      res.status(400).json({ error: 'query param `orch` is required', code: 'ORCH_REQUIRED' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status != null && !VALID_STATUSES.has(status)) {
      res
        .status(400)
        .json({ error: `status must be one of ${[...VALID_STATUSES].join('|')}`, code: 'INVALID_STATUS' });
      return;
    }
    const assignee = typeof req.query.assignee === 'string' ? req.query.assignee : undefined;
    const cards = taskboard.listCards({ orchestratorId: orch, status, assignee });
    res.json({ cards });
  });

  // Teams (orchestrators) with cards — the web board's team selector. Declared
  // BEFORE `/api/board/card/:id` (no collision — distinct path) and kept
  // parameter-free so the selector needs no prior orch context.
  router.get('/api/board/teams', (_req: Request, res: Response) => {
    res.json({ teams: taskboard.listTeams() });
  });

  // One card + its dependencies + the tail of its audit journal.
  router.get('/api/board/card/:id', (req: Request<{ id: string }>, res: Response) => {
    const detail = taskboard.getCard(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      return;
    }
    res.json(detail);
  });

  // Operator cleanup — the ONLY web write (soft-delete). Idempotent: `deleted`
  // is false when the card was already hidden. Provenance is `web` (no session).
  router.delete('/api/board/card/:id', (req: Request<{ id: string }>, res: Response) => {
    try {
      const deleted = taskboard.deleteCard({ id: req.params.id, actorSessionId: null });
      res.json({ ok: true, deleted });
    } catch (err) {
      if (err instanceof TaskboardError) {
        const status = err.code === 'NOT_FOUND' ? 404 : 400;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'TASKBOARD_DELETE_FAILED',
      });
    }
  });

  return router;
}
