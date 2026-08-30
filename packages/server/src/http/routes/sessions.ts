import * as fs from 'node:fs';
import * as path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { Spawner } from '../../modules/spawner/index.js';
import { SessionActionError } from '../../modules/orchestrator/index.js';
import type { ContextResetCommand } from '../../modules/orchestrator/session.js';
import {
  contextHistoryWindowMs,
  downsampleContextHistory,
  parseContextHistoryWindow,
} from '../../modules/orchestrator/context-usage.js';
import { rowToSessionView } from '../../modules/orchestrator/persistence.js';
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
    if (found) {
      res.json(found.session.toView());
      return;
    }
    // Fallback to SQLite — needed so the RightPanel can open on terminal
    // sessions whose orchestrator parent is no longer held in memory (server
    // restart, history-only orchestrators). Hidden rows are filtered by the
    // prepared statement.
    try {
      const row = spawner.persistence.db.getSession(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      // Lot 11 — a terminated agent's cost is priced here: its live `Session`,
      // which held the rate-card thunk, is gone.
      res.json(
        rowToSessionView(
          row,
          (providerId, modelId) =>
            spawner.modelCatalogue?.costRates(providerId, modelId) ?? null,
        ),
      );
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  router.post('/sessions/:id/input', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = req.body ?? {};
    const data = body.data;
    if (typeof data !== 'string') {
      res.status(400).json({ error: 'body.data must be a string' });
      return;
    }
    // `submit: true` → type the line and fire Enter as a standalone CR on the
    // next tick (Ink needs the CR in its own write, not pasted with the text;
    // see Session.submitInput). Otherwise forward bytes verbatim — raw
    // keystroke pass-through for the xterm console.
    if (body.submit === true) {
      found.session.submitInput(data);
    } else {
      found.session.writeInput(data);
    }
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
    // Optional `{ hideAfterExit: true }` — KILL UI flow. The worker exit
    // handler will soft-delete the session from the map once the PTY dies.
    const hideAfterExit = (req.body ?? {}).hideAfterExit === true;
    try {
      const s = found.orchestrator.stopSession(
        req.params.id,
        undefined,
        { hideAfterExit },
      );
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

  /**
   * Monitoring (docs/monitoring-agents.md) — operator compact/clear.
   *
   * `{ cmd: 'compact' | 'clear', instructions?: string }`. The wire vocabulary
   * is bare words, not the provider slash commands: what claude spells
   * `/clear` codex spells `/new`, and the mapping is the adapter's business
   * (`AgentProvider.contextResetLine`), never the client's.
   *
   * A 200 means SCHEDULED, not done: the command is armed and fires at the
   * agent's next idle boundary, because injecting mid-turn garbles the turn.
   */
  router.post('/sessions/:id/context-reset', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    const body = req.body ?? {};
    // Strict whitelist rather than a lookup table: `body.cmd` is attacker-shaped
    // input and this way no prototype key can ever resolve to a command.
    let cmd: ContextResetCommand;
    if (body.cmd === 'compact') cmd = '/compact';
    else if (body.cmd === 'clear') cmd = '/clear';
    else {
      res.status(400).json({ error: "body.cmd must be 'compact' or 'clear'" });
      return;
    }
    let instructions: string | undefined;
    if (body.instructions != null) {
      if (typeof body.instructions !== 'string') {
        res.status(400).json({ error: 'body.instructions must be a string' });
        return;
      }
      // Same cap as a spawn prompt: the text is typed into the PTY as one
      // line, so an unbounded string is an unbounded paste into a live agent.
      const bytes = Buffer.byteLength(body.instructions, 'utf8');
      if (bytes > config.maxPromptSizeBytes) {
        res.status(413).json({
          error: `instructions too large: ${bytes} bytes > ${config.maxPromptSizeBytes}`,
        });
        return;
      }
      if (body.instructions.length > 0) instructions = body.instructions;
    }
    try {
      found.orchestrator.requestContextReset(req.params.id, cmd, instructions);
      res.status(200).json({ scheduled: true });
    } catch (err) {
      if (err instanceof SessionActionError) return sendActionError(res, err);
      throw err;
    }
  });

  /**
   * Monitoring (docs/monitoring-agents.md, Lot 9) — the context graph.
   *
   * `?window=1h|24h|3d` (default `1h`). Answers what one panel needs and
   * nothing else: the denominator, the folded samples, and the resets that
   * actually fired, all read from the in-memory rings of the session's tracker.
   *
   * Three normal outcomes, only one of which is an error:
   *
   *   - an unknown `window` is a 400. The set is closed on purpose — a
   *     client-supplied span would be a client-supplied point count;
   *   - an unknown session is a 404 (no DB fallback: the history is memory-only
   *     and a row could not answer this);
   *   - a session with no tracker (gemini) or no history yet is a 200 with
   *     empty arrays. The panel then says "no history", which is the truth,
   *     rather than rendering an error for a healthy agent.
   */
  router.get('/sessions/:id/context-history', (req: Request<{ id: string }>, res: Response) => {
    const window = parseContextHistoryWindow(req.query.window);
    if (window === null) {
      res.status(400).json({ error: "query.window must be '1h', '24h' or '3d'" });
      return;
    }
    const found = spawner.findSession(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    const history = found.session.contextHistory;
    const now = Date.now();
    const since = now - contextHistoryWindowMs(window);
    res.json({
      limitTokens: history?.limitTokens ?? null,
      points: history ? downsampleContextHistory(history.samples, window, now) : [],
      // Markers are never bucketed: two resets 30 s apart are two events, and
      // the graph labels each one.
      resets: (history?.resets ?? [])
        .filter((r) => r.t >= since)
        .map((r) => ({ t: new Date(r.t).toISOString(), cmd: r.cmd })),
    });
  });

  // Soft-delete from the map. Session must be terminal (killed/exited/failed).
  // If the session is the orchestrator's lead, delegates to hiding the whole
  // orchestrator (cascading to all its sessions).
  router.post('/sessions/:id/hide', (req: Request<{ id: string }>, res: Response) => {
    const found = spawner.findSession(req.params.id);
    if (found) {
      const { orchestrator: orch, session } = found;
      const terminal =
        session.status === 'killed' ||
        session.status === 'exited' ||
        session.status === 'failed';
      if (!terminal) {
        res.status(409).json({
          error: 'NOT_TERMINAL',
          message: `cannot hide session in status '${session.status}'`,
        });
        return;
      }
      if (session.id === orch.leadSessionId) {
        // Lead removal cascades the whole team — but the orchestrator itself
        // must already be terminal (stopped/failed). If the lead is killed
        // but the orchestrator is still mid-stop, refuse.
        if (orch.status !== 'stopped' && orch.status !== 'failed') {
          res.status(409).json({
            error: 'NOT_TERMINAL',
            message: `cannot hide lead while orchestrator is '${orch.status}'`,
          });
          return;
        }
        spawner.hideOrchestrator(orch.id);
        res.status(204).end();
        return;
      }
      orch.hideSession(session.id);
      res.status(204).end();
      return;
    }
    // Fallback to SQLite — needed for sessions whose orchestrator parent is no
    // longer held in memory (server restart, history-only orchestrators).
    const row = spawner.persistence.db.getSession(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'SESSION_UNKNOWN' });
      return;
    }
    const terminal =
      row.status === 'killed' || row.status === 'exited' || row.status === 'failed';
    if (!terminal) {
      res.status(409).json({
        error: 'NOT_TERMINAL',
        message: `cannot hide session in status '${row.status}'`,
      });
      return;
    }
    const parentRow = spawner.persistence.db.getOrchestrator(row.orchestrator_id);
    if (parentRow && parentRow.lead_session_id === row.id) {
      // Lead of a history-only orchestrator → cascade-hide the whole team.
      spawner.hideOrchestrator(parentRow.id);
      res.status(204).end();
      return;
    }
    spawner.persistence.db.hideSession(row.id);
    res.status(204).end();
  });

  return router;
}
