import { Router, type Request, type Response } from 'express';
import { Spawner } from '../../modules/spawner/index.js';
import { issueTicket } from '../auth.js';

export function createWsTicketRouter(spawner: Spawner): Router {
  const router = Router();

  router.get('/ws-ticket', (req: Request, res: Response) => {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : null;
    const events = req.query.events === '1' || req.query.events === 'true';

    if (events && !sessionId) {
      const t = issueTicket('events', '');
      res.json({ ticket: t, ttlMs: 10_000, kind: 'events' });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ error: 'session query param required (or events=1)' });
      return;
    }
    const found = spawner.findSession(sessionId);
    if (!found) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const t = issueTicket('terminal', sessionId);
    res.json({ ticket: t, ttlMs: 10_000, kind: 'terminal', sessionId });
  });

  return router;
}
