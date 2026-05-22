import * as fs from 'node:fs';
import * as path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { Spawner } from '../../modules/spawner/index.js';
import { SessionActionError } from '../../modules/orchestrator/index.js';
import type { Config } from '../../config.js';

/**
 * S5 — convert a `SessionActionError` raised by the orchestrator into the
 * matching HTTP response. Kept inline rather than middleware so each route
 * stays explicit about what it returns.
 */
function sendActionError(res: Response, err: SessionActionError): void {
  res.status(err.httpStatus).json({ error: err.code, message: err.message });
}

export function createSessionsRouter(spawner: Spawner, config: Config): Router {
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

  /**
   * Phase 4 — `GET /sessions/:id/log` (plan §6 Phase 4 + §9). Streams the
   * raw session log file as `text/plain`. The log lives at
   * `<dataDir>/logs/<orch_id>/<session_id>.log` and is the verbatim PTY
   * output (plus the synthetic `[swarm-os] ...` markers from `notifySignal`).
   *
   * Resolves the path two ways:
   *
   *   1. If the session is in-memory (live or recently terminated), use
   *      `session.logPath` directly.
   *   2. Otherwise (after restart, history-only), look it up in the SQLite
   *      `sessions` table.
   *
   * 404 if neither path resolves OR the file doesn't exist.
   */
  router.get('/sessions/:id/log', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    let logPath: string | null = null;
    let derivedFromDb = false;
    if (found) {
      logPath = found.session.logPath;
    } else {
      // History fallback: search the persistence layer.
      try {
        const orchs = spawner.persistence.db.listOrchestrators();
        for (const o of orchs) {
          const sessions = spawner.persistence.db.listSessions(o.id);
          const s = sessions.find((x) => x.id === req.params.id);
          if (s) {
            logPath = s.log_path;
            derivedFromDb = true;
            break;
          }
        }
      } catch {
        /* ignore — fall through to 404 */
      }
    }

    if (!logPath) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Defence-in-depth: even when derivedFromDb=true, ensure the resolved
    // path is under <dataDir>/logs (no path traversal via DB tampering).
    const logsRoot = path.resolve(config.logsDir);
    const resolved = path.resolve(logPath);
    const rel = path.relative(logsRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(resolved)}"`,
    );
    if (derivedFromDb) res.setHeader('X-Swarm-Os-Source', 'history');
    fs.createReadStream(resolved).pipe(res);
  });

  // S5 — per-session lifecycle actions. Mirror the RightPanel buttons
  // (STOP / PAUSE / RESUME / RESTART). Each handler is intentionally tiny:
  // input validation lives in the orchestrator method (typed errors), the
  // route just maps them onto HTTP status codes.

  router.post('/sessions/:id/stop', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    try {
      const s = found.orchestrator.stopSession(req.params.id);
      // 200 immediately; the actual `killed` transition happens after the
      // SIGTERM grace window via _handleExit (clients should poll
      // GET /sessions/:id or listen on /ws/events).
      res.status(200).json({ stopped: true, status: s.status });
    } catch (err) {
      if (err instanceof SessionActionError) return sendActionError(res, err);
      throw err;
    }
  });

  router.post('/sessions/:id/pause', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    try {
      const s = found.orchestrator.pauseSession(req.params.id);
      res.status(200).json({ paused: true, status: s.status });
    } catch (err) {
      if (err instanceof SessionActionError) return sendActionError(res, err);
      throw err;
    }
  });

  router.post('/sessions/:id/resume', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    try {
      const s = found.orchestrator.resumeSession(req.params.id);
      res.status(200).json({ resumed: true, status: s.status });
    } catch (err) {
      if (err instanceof SessionActionError) return sendActionError(res, err);
      throw err;
    }
  });

  router.post('/sessions/:id/restart', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    try {
      const { oldSession, newSession } = found.orchestrator.restartSession(req.params.id);
      res.status(201).json({
        oldSession: oldSession.toView(),
        newSession: newSession.toView(),
        // Documented in plan §7.7 — surfaced to the caller so the UI can
        // disclaim the lost PTY history (the new session starts fresh).
        note: 'PTY history of the previous session was lost; the new session starts with a fresh context.',
      });
    } catch (err) {
      if (err instanceof SessionActionError) return sendActionError(res, err);
      throw err;
    }
  });

  return router;
}
