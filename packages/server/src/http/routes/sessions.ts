import { Router, type Request, type Response } from 'express';
import { Spawner } from '../../modules/spawner/index.js';

export function createSessionsRouter(spawner: Spawner): Router {
  const router = Router();

  router.get('/sessions/:id', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(found.session.toView());
  });

  router.post('/sessions/:id/input', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const data = (req.body ?? {}).data;
    if (typeof data !== 'string') {
      res.status(400).json({ error: 'body.data must be a string' });
      return;
    }
    found.session.writeInput(data);
    res.json({ ok: true, bytes: Buffer.byteLength(data, 'utf8') });
  });

  return router;
}
