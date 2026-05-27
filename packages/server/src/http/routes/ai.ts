import { Router, type Request, type Response } from 'express';
import type { Config } from '../../config.js';
import {
  improveTextViaSsh,
  type ImproveField,
} from '../../modules/ai/improve-via-ssh.js';

const VALID_FIELDS: ReadonlySet<ImproveField> = new Set([
  'leadPrompt',
  'leadPreamble',
  'workerPreamble',
]);

const MAX_TEXT_BYTES = 16 * 1024;
const TIMEOUT_MS = 60_000;

export function createAiRouter(config: Config): Router {
  const router = Router();

  router.post('/ai/improve-text', async (req: Request, res: Response) => {
    const body = req.body as { field?: unknown; text?: unknown };
    if (typeof body.field !== 'string' || !VALID_FIELDS.has(body.field as ImproveField)) {
      res.status(400).json({ error: 'INVALID_FIELD', message: 'field must be one of leadPrompt, leadPreamble, workerPreamble' });
      return;
    }
    if (typeof body.text !== 'string') {
      res.status(400).json({ error: 'INVALID_TEXT', message: 'text must be a string' });
      return;
    }
    if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) {
      res.status(413).json({ error: 'TEXT_TOO_LARGE', message: `text exceeds ${MAX_TEXT_BYTES} bytes` });
      return;
    }
    if (config.agentTransport !== 'ssh' || !config.sshTarget) {
      res.status(503).json({
        error: 'AI_TRANSPORT_UNAVAILABLE',
        message: 'AI improve-text requires SWARM_OS_AGENT_TRANSPORT=ssh with SWARM_OS_SSH_TARGET set',
      });
      return;
    }

    try {
      const improved = await improveTextViaSsh(
        config,
        body.field as ImproveField,
        body.text,
        AbortSignal.timeout(TIMEOUT_MS),
      );
      res.json({ text: improved });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'AI_TIMEOUT') {
        res.status(504).json({ error: 'AI_TIMEOUT', message: `claude did not respond within ${TIMEOUT_MS} ms` });
        return;
      }
      res.status(502).json({ error: 'AI_UPSTREAM_FAILED', message });
    }
  });

  return router;
}
