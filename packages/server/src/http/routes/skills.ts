/**
 * Skills control-plane REST (docs/internal/skills/plan-skills-importables.md §8.4).
 *
 * FROZEN CONTRACT (Lot 1b/2b/3b web client builds `web/api/client.ts` on this):
 *   GET    /skills                 → { skills: SkillView[] }
 *   GET    /skills/:name           → { skill: SkillView, body: string }
 *   GET    /skills/:name/activations → { activations:[{scope,scopeId,enabled}] }
 *   GET    /skills/market/search?q= → { available, results:[{name,description?,ref?,url?}], error? }
 *   POST   /skills/install         { source:'dir'|'git'|'npm'|'market', … } → { skill }
 *                                    dir:{dir} git:{url,ref?,subdir?} npm:{spec} market:{ref}
 *   POST   /skills/upload?name=    raw .tgz (application/gzip)  → { skill }
 *   GET    /skills/:name/export    → 200 application/gzip (.tgz, round-trips via upload) | 404
 *   POST   /skills/pack/export     { names:string[] } → 200 application/gzip (pack .tgz) | 400
 *   POST   /skills/pack/install    raw .tgz (application/gzip) → { installed:SkillView[], errors:[{name,error}] }
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
import {
  SkillNotFoundError,
  UploadRequiresNewUploadError,
  EmptyPackError,
} from '../../modules/skills/installer.js';
import { SkillValidationError, SkillStageError, type SkillInstallSource } from '../../modules/skills/stage.js';

/** A Content-Disposition-safe filename stem (skill names are already this shape). */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'skill';
}

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

/**
 * Validate + narrow a `POST /skills/install` body to a {@link SkillInstallSource}
 * (mirrors the plugins route's `parseInstallSource`). `upload` is a separate
 * raw-body route; `market` resolves to git coordinates in the installer.
 */
function parseSkillInstallSource(
  body: unknown,
): { ok: true; value: SkillInstallSource } | { ok: false; error: string } {
  if (body == null || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  switch (b.source) {
    case 'dir': {
      if (typeof b.dir !== 'string' || b.dir.trim() === '') {
        return { ok: false, error: "dir source requires a non-empty 'dir'" };
      }
      return { ok: true, value: { kind: 'dir', dir: b.dir.trim() } };
    }
    case 'git': {
      if (typeof b.url !== 'string' || b.url.trim() === '') {
        return { ok: false, error: "git source requires a non-empty 'url'" };
      }
      const ref = typeof b.ref === 'string' && b.ref.trim() !== '' ? b.ref.trim() : undefined;
      const subdir =
        typeof b.subdir === 'string' && b.subdir.trim() !== '' ? b.subdir.trim() : undefined;
      return { ok: true, value: { kind: 'git', url: b.url.trim(), ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) } };
    }
    case 'npm': {
      if (typeof b.spec !== 'string' || b.spec.trim() === '') {
        return { ok: false, error: "npm source requires a non-empty 'spec'" };
      }
      return { ok: true, value: { kind: 'npm', spec: b.spec.trim() } };
    }
    case 'market': {
      // A market ref is a bare skill name or a GitHub 'owner/repo[/subdir][@ref]'.
      if (typeof b.ref !== 'string' || b.ref.trim() === '') {
        return {
          ok: false,
          error: "market source requires a non-empty 'ref' (a skill name or GitHub 'owner/repo[/subdir]')",
        };
      }
      return { ok: true, value: { kind: 'market', ref: b.ref.trim() } };
    }
    default:
      return { ok: false, error: "source must be one of 'dir' | 'git' | 'npm' | 'market'" };
  }
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

  // Export one skill as a round-trippable .tgz (re-imports via POST /skills/upload).
  // 404 for an unknown skill. Exporting a skill with executable assets is allowed
  // (export activates nothing). `:name` here never collides with `pack/*` (those
  // are POST routes registered above).
  router.get('/skills/:name/export', (req: Request<{ name: string }>, res: Response) => {
    void skills
      .exportSkill(req.params.name)
      .then((tgz) => {
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(req.params.name)}.tgz"`);
        res.send(tgz);
      })
      .catch((err: unknown) => {
        if (sendSkillError(res, err)) return; // SkillNotFoundError → 404
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  // Browse a configured market registry (agentskills.io ecosystem). This
  // 3-segment path never collides with the 2-segment `/skills/:name` route.
  // Always 200 (graceful degradation) except a missing query; a
  // configured-but-unreachable endpoint yields { available:true, results:[],
  // error } rather than a 5xx.
  router.get('/skills/market/search', (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q === '') {
      res.status(400).json({ error: 'query ?q=<text> is required' });
      return;
    }
    void skills
      .marketSearch(q)
      .then((result) => res.json(result))
      .catch((err: unknown) => {
        // searchMarket is already fail-safe; this is defence in depth so a browse
        // never surfaces as a 500.
        res.json({ available: true, results: [], error: err instanceof Error ? err.message : String(err) });
      });
  });

  // Export several skills as one mono-repo pack .tgz (+ pack.json). This
  // 3-segment literal path is registered before the `/skills/:name/*` param
  // routes so `:name` never captures 'pack'. Unknown names are skipped; 400 only
  // when NONE resolve. Included/skipped are surfaced via safe response headers.
  router.post('/skills/pack/export', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { names?: unknown };
    const names = Array.isArray(body.names)
      ? body.names.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      : null;
    if (!names || names.length === 0) {
      res.status(400).json({ error: 'body must be { names: string[] } with at least one name' });
      return;
    }
    void skills
      .exportPack(names)
      .then(({ tgz, included, skipped }) => {
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="skills-pack-${included.length}.tgz"`);
        // Included names are validated skill names (header-safe); skipped is a
        // count only, never echoing untrusted request strings into a header.
        res.setHeader('X-Skills-Pack-Included', included.map((e) => e.name).join(','));
        res.setHeader('X-Skills-Pack-Skipped-Count', String(skipped.length));
        res.send(tgz);
      })
      .catch((err: unknown) => {
        if (err instanceof EmptyPackError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (sendSkillError(res, err)) return;
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  // Install a .tgz pack (raw application/gzip, like /skills/upload but larger).
  // Each member is installed via the normal path (Lot 3 gate per skill); partial
  // success is allowed. A corrupt/unsafe/non-pack archive is a 422, never a 5xx.
  router.post(
    '/skills/pack/install',
    express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '100mb' }),
    (req: Request, res: Response) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(415).json({
          error: 'pack body must be a .tgz sent as application/gzip',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });
        return;
      }
      void skills
        .installPack(req.body)
        .then((result) => res.json(result))
        .catch((err: unknown) => {
          if (sendSkillError(res, err)) return;
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    },
  );

  router.post('/skills/install', (req: Request, res: Response) => {
    const parsed = parseSkillInstallSource(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    void skills
      .import(parsed.value)
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
