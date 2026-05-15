import { Router, type Request, type Response } from 'express';
import { Spawner, SpawnerError } from '../../modules/spawner/index.js';
import { validateCwdUnderWorkspace } from '../validation.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMS: ReadonlySet<string> = new Set([
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

interface CreateBody {
  name?: unknown;
  role?: unknown;
  lead?: {
    cwd?: unknown;
    prompt?: unknown;
    preamble?: unknown;
  };
  workerPreamble?: unknown;
  defaults?: {
    model?: unknown;
    effort?: unknown;
    permissionMode?: unknown;
  };
}

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function bytesOf(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function createOrchestratorsRouter(spawner: Spawner, config: Config): Router {
  const router = Router();

  router.post('/orchestrators', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateBody;

    if (!isString(body.name)) {
      res.status(400).json({ error: 'name is required and must be a non-empty string' });
      return;
    }
    if (!isString(body.role)) {
      res.status(400).json({ error: 'role is required and must be a non-empty string' });
      return;
    }
    const lead = body.lead ?? {};
    if (!isString(lead.cwd)) {
      res.status(400).json({ error: 'lead.cwd is required and must be a non-empty string' });
      return;
    }
    if (!isString(lead.prompt)) {
      res.status(400).json({ error: 'lead.prompt is required and must be a non-empty string' });
      return;
    }
    if (lead.preamble != null && typeof lead.preamble !== 'string') {
      res.status(400).json({ error: 'lead.preamble must be a string if provided' });
      return;
    }
    if (body.workerPreamble != null && typeof body.workerPreamble !== 'string') {
      res.status(400).json({ error: 'workerPreamble must be a string if provided' });
      return;
    }

    const promptBytes = bytesOf(lead.prompt) + (isString(lead.preamble) ? bytesOf(lead.preamble) : 0);
    if (promptBytes > config.maxPromptSizeBytes) {
      res.status(413).json({
        error: `prompt+preamble too large: ${promptBytes} bytes > ${config.maxPromptSizeBytes}`,
      });
      return;
    }

    // Validate defaults
    let model = config.defaultModel;
    let effort: EffortLevel = config.defaultEffort;
    let permissionMode: PermissionMode = config.defaultPermissionMode;
    if (body.defaults) {
      if (body.defaults.model != null) {
        if (!isString(body.defaults.model)) {
          res.status(400).json({ error: 'defaults.model must be a non-empty string' });
          return;
        }
        model = body.defaults.model;
      }
      if (body.defaults.effort != null) {
        if (!isString(body.defaults.effort) || !VALID_EFFORTS.has(body.defaults.effort)) {
          res.status(400).json({ error: 'defaults.effort must be one of low|medium|high|xhigh|max' });
          return;
        }
        effort = body.defaults.effort as EffortLevel;
      }
      if (body.defaults.permissionMode != null) {
        if (!isString(body.defaults.permissionMode) || !VALID_PERMS.has(body.defaults.permissionMode)) {
          res.status(400).json({ error: 'defaults.permissionMode invalid' });
          return;
        }
        permissionMode = body.defaults.permissionMode as PermissionMode;
      }
    }

    // cwd realpath validation under workspace root
    let resolvedCwd: string;
    try {
      resolvedCwd = await validateCwdUnderWorkspace(lead.cwd, config.workspaceRoot);
    } catch (err) {
      res.status(400).json({
        error: 'lead.cwd validation failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      const { orchestrator, lead: leadSession } = spawner.create({
        name: body.name,
        role: body.role,
        defaultModel: model,
        defaultEffort: effort,
        defaultPermissionMode: permissionMode,
        leadPreamble: isString(lead.preamble) ? lead.preamble : null,
        workerPreamble: isString(body.workerPreamble) ? body.workerPreamble : null,
        lead: {
          cwd: resolvedCwd,
          prompt: lead.prompt,
          preamble: isString(lead.preamble) ? lead.preamble : null,
        },
      });
      res.status(201).json({
        orchestrator: orchestrator.toView(),
        lead: leadSession.toView(),
      });
    } catch (err) {
      if (err instanceof SpawnerError) {
        res.status(err.httpStatus).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: 'failed to create orchestrator',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/orchestrators', (_req: Request, res: Response) => {
    res.json({ orchestrators: spawner.listActive().map((o) => o.toView()) });
  });

  router.get('/orchestrators/:id', (req: Request<{ id: string }>, res: Response) => {
    const orch = spawner.get(req.params.id);
    if (!orch) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(orch.toView());
  });

  router.delete('/orchestrators/:id', (req: Request<{ id: string }>, res: Response) => {
    // Idempotent: 204 whether it existed or not.
    spawner.destroy(req.params.id, 'user');
    res.status(204).end();
  });

  router.get('/orchestrators/:id/sessions', (req: Request<{ id: string }>, res: Response) => {
    const orch = spawner.get(req.params.id);
    if (!orch) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ sessions: orch.listSessions().map((s) => s.toView()) });
  });

  return router;
}
