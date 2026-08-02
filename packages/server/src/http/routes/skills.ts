/**
 * Skills control-plane REST (docs/plan-skills-importables.md §8.4).
 *
 * FROZEN CONTRACT (Lot 1b web client builds `web/api/client.ts` on this):
 *   GET    /skills                 → { skills: SkillView[] }
 *   GET    /skills/:name           → { skill: SkillView, body: string }
 *   POST   /skills/install         { source:'dir', dir:string } → { skill }
 *   POST   /skills/upload?name=    raw .tgz (application/gzip)  → { skill }
 *   POST   /skills/:name/upgrade   → { skill }
 *   DELETE /skills/:name           → 204
 * Role-scoped activation is done through the roles router (PATCH /roles/:id
 * { skills:[{name,mode}] }); runtime lead activation is the `skills.*` MCP tools.
 *
 * Error mapping: SkillValidationError → 422, SkillStageError → 502,
 * UploadRequiresNewUploadError → 409, SkillNotFoundError → 404.
 */

import express, { Router, type Request, type Response } from 'express';
import type { SkillsSubsystem } from '../../modules/skills/index.js';
import { SkillNotFoundError, UploadRequiresNewUploadError } from '../../modules/skills/installer.js';
import { SkillValidationError, SkillStageError } from '../../modules/skills/stage.js';

/** Map a known skill error onto its HTTP status. Returns true when handled. */
function sendSkillError(res: Response, err: unknown): boolean {
  if (err instanceof SkillValidationError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  if (err instanceof SkillStageError) {
    res.status(502).json({ error: err.message });
    return true;
  }
  if (err instanceof UploadRequiresNewUploadError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof SkillNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  return false;
}

export function createSkillsRouter(skills: SkillsSubsystem): Router {
  const router = Router();

  router.get('/skills', (_req: Request, res: Response) => {
    res.json({ skills: skills.list() });
  });

  router.get('/skills/:name', (req: Request<{ name: string }>, res: Response) => {
    const view = skills.getView(req.params.name);
    if (!view) {
      res.status(404).json({ error: `skill '${req.params.name}' not found` });
      return;
    }
    res.json({ skill: view, body: skills.getBody(req.params.name) ?? '' });
  });

  router.post('/skills/install', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { source?: string; dir?: string };
    if (body.source !== 'dir' || typeof body.dir !== 'string' || body.dir.trim() === '') {
      res.status(400).json({
        error: "install expects { source: 'dir', dir: '<path>' } — git/npm/market arrive in a later lot",
      });
      return;
    }
    void skills
      .import({ kind: 'dir', dir: body.dir.trim() })
      .then((skill) => res.json({ skill }))
      .catch((err: unknown) => {
        if (sendSkillError(res, err)) return;
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.post(
    '/skills/upload',
    express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '25mb' }),
    (req: Request, res: Response) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(415).json({
          error: 'upload body must be a .tgz sent as application/gzip',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });
        return;
      }
      const name = typeof req.query.name === 'string' ? req.query.name : undefined;
      void skills
        .import({ kind: 'upload', tgz: req.body, name })
        .then((skill) => res.json({ skill }))
        .catch((err: unknown) => {
          if (sendSkillError(res, err)) return;
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    },
  );

  router.post('/skills/:name/upgrade', (req: Request<{ name: string }>, res: Response) => {
    void skills
      .upgrade(req.params.name)
      .then((skill) => res.json({ skill }))
      .catch((err: unknown) => {
        if (sendSkillError(res, err)) return;
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.delete('/skills/:name', (req: Request<{ name: string }>, res: Response) => {
    skills.remove(req.params.name);
    res.status(204).end();
  });

  return router;
}
