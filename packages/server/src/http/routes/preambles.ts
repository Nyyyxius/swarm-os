import { Router, type Request, type Response } from 'express';
import { getLeadDefault, getWorkerDefault } from '../../modules/orchestrator/preamble.js';

export function createPreamblesRouter(): Router {
  const router = Router();

  router.get('/preambles/defaults', (_req: Request, res: Response) => {
    res.json({
      lead: getLeadDefault(),
      worker: getWorkerDefault(),
    });
  });

  return router;
}
