/**
 * Skills control-plane REST (docs/plan-skills-importables.md §8.4).
 *
 * FROZEN CONTRACT (Lot 1b/2b/3b web client builds `web/api/client.ts` on this):
 *   GET    /skills                 → { skills: SkillView[] }
 *   GET    /skills/:name           → { skill: SkillView, body: string }
 *   GET    /skills/:name/activations → { activations:[{scope,scopeId,enabled}] }
 *   POST   /skills/install         { source:'dir', dir:string } → { skill }
 *   POST   /skills/upload?name=    raw .tgz (application/gzip)  → { skill }
 *   POST   /skills/:name/upgrade   → { skill, drift:{checksumChanged,previousChecksum,previousBody} }
 *   DELETE /skills/:name           → 204
 *   POST   /skills/:name/activate  { scope?, orchestratorId, sessionId?, reviewed? }
 *                                  → 200 { name,scope,found,persisted,injected }
 *                                  | 409 { error, code:'REVIEW_REQUIRED', review } when gated
 *   POST   /skills/:name/deactivate (same body, no gate) → { name,scope,... }
 *   GET    /skills/:name/review    → { review: SkillReviewInfo }   (Lot 3b dialog)
 *   POST   /skills/:name/review    { reviewed:boolean } → { name, reviewed }
 *   GET    /skills/:name/asset?path=<rel> → { asset: SkillAssetContent } | 404
 * Role-scoped activation is also done through the roles router (PATCH /roles/:id
 * { skills:[{name,mode}] }); runtime lead activation is the `skills.*` MCP tools.
 *
 * Error mapping: SkillValidationError → 422, SkillStageError → 502,
 * UploadRequiresNewUploadError → 409, SkillNotFoundError → 404,
 * review-gated activation → 409 (code REVIEW_REQUIRED).
 */

import express, { Router, type Request, type Response } from 'express';
import type { SkillsSubsystem, SkillScope } from '../../modules/skills/index.js';
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

  // Provenance: every orch/session activation of a skill (for the management UI).
  // Role-scope provenance is read from the roles API.
  router.get('/skills/:name/activations', (req: Request<{ name: string }>, res: Response) => {
    if (!skills.getView(req.params.name)) {
      res.status(404).json({ error: `skill '${req.params.name}' not found` });
      return;
    }
    res.json({ activations: skills.activationsForSkill(req.params.name) });
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
      .then(({ skill, drift }) => res.json({ skill, drift }))
      .catch((err: unknown) => {
        if (sendSkillError(res, err)) return;
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.delete('/skills/:name', (req: Request<{ name: string }>, res: Response) => {
    skills.remove(req.params.name);
    res.status(204).end();
  });

  // ---- review surface (Lot 3b SkillReviewDialog) ------------------------

  // Review payload: metadata + requires.plugins status + the assets file list.
  router.get('/skills/:name/review', (req: Request<{ name: string }>, res: Response) => {
    const review = skills.reviewInfo(req.params.name);
    if (!review) {
      res.status(404).json({ error: `skill '${req.params.name}' not found` });
      return;
    }
    res.json({ review });
  });

  // Record (or clear) an operator's review of a risky skill.
  router.post('/skills/:name/review', (req: Request<{ name: string }>, res: Response) => {
    const body = (req.body ?? {}) as { reviewed?: unknown };
    if (typeof body.reviewed !== 'boolean') {
      res.status(400).json({ error: 'body must be { reviewed: boolean }' });
      return;
    }
    const result = skills.setReviewed(req.params.name, body.reviewed);
    if (!result) {
      res.status(404).json({ error: `skill '${req.params.name}' not found` });
      return;
    }
    res.json({ name: req.params.name, reviewed: result.reviewed });
  });

  // One asset file's content (traversal-guarded), so the dialog can show scripts.
  router.get('/skills/:name/asset', (req: Request<{ name: string }>, res: Response) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (rel === '') {
      res.status(400).json({ error: 'query ?path=<relative asset path> is required' });
      return;
    }
    if (!skills.getView(req.params.name)) {
      res.status(404).json({ error: `skill '${req.params.name}' not found` });
      return;
    }
    const asset = skills.assetContent(req.params.name, rel);
    if (!asset) {
      res.status(404).json({ error: `asset '${rel}' not found in skill '${req.params.name}'` });
      return;
    }
    res.json({ asset });
  });

  // Scope activation. `scope` defaults to 'orch'; 'role' derives the roleId from
  // the live orchestrator, 'session' requires `sessionId`. The hot channel fires
  // when the orchestrator is live. Body: { scope?, orchestratorId, sessionId? }.
  router.post('/skills/:name/activate', (req: Request<{ name: string }>, res: Response) => {
    handleScope(skills, 'activate', req, res);
  });
  router.post('/skills/:name/deactivate', (req: Request<{ name: string }>, res: Response) => {
    handleScope(skills, 'deactivate', req, res);
  });

  return router;
}

function handleScope(
  skills: SkillsSubsystem,
  action: 'activate' | 'deactivate',
  req: Request<{ name: string }>,
  res: Response,
): void {
  const body = (req.body ?? {}) as {
    scope?: unknown;
    orchestratorId?: unknown;
    sessionId?: unknown;
    reviewed?: unknown;
  };
  const scope: SkillScope =
    body.scope === 'role' || body.scope === 'session' ? body.scope : 'orch';
  if (typeof body.orchestratorId !== 'string' || body.orchestratorId === '') {
    res.status(400).json({ error: 'orchestratorId is required' });
    return;
  }
  if (scope === 'session' && (typeof body.sessionId !== 'string' || body.sessionId === '')) {
    res.status(400).json({ error: "sessionId is required for scope 'session'" });
    return;
  }
  const opts = {
    name: req.params.name,
    scope,
    orchestratorId: body.orchestratorId,
    ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
    ...(action === 'activate' && body.reviewed === true ? { reviewed: true } : {}),
  };
  const result = action === 'activate' ? skills.activate(opts) : skills.deactivate(opts);
  if (!result.found) {
    res.status(404).json({ error: `skill '${req.params.name}' not found` });
    return;
  }
  // Review-gated activation: refuse with 409 + the review payload so the UI can
  // open the SkillReviewDialog and retry with { reviewed: true }.
  if (result.blocked) {
    res.status(409).json({
      error: `skill '${req.params.name}' requires an operator review before activation`,
      code: 'REVIEW_REQUIRED',
      review: skills.reviewInfo(req.params.name),
    });
    return;
  }
  res.json({ name: req.params.name, scope, ...result });
}
