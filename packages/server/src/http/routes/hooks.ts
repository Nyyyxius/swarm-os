/**
 * Phase 4 — `/hooks/notification` endpoint (plan §6 Phase 4 + §13/§14).
 *
 * Receives the Claude Code `Notification` hook callback. The hook command
 * lives in each session's `<dataDir>/.claude-runtime/sessions/<id>/settings.json`
 * (see `Session._maybeWriteSessionSettings`). It POSTs JSON of the form:
 *
 *   {
 *     "orch_id":   "<UUID>",
 *     "session_id":"<UUID>",
 *     "kind":      "session.waiting" | optional,
 *     "message":   "<raw stdin from Claude — opaque>"
 *   }
 *
 * Auth:
 *
 *   Header: `Authorization: Bearer <HOOK_TOKEN>`
 *
 * The HOOK_TOKEN is **distinct** from the user-facing `SWARM_OS_TOKEN`
 * (X-Auth-Token). Plan §14 mandates this — the hook token lives in
 * `settings.json` files on disk that the claude subprocess reads, while the
 * user token stays out of any subprocess context.
 *
 * Response:
 *
 *   200 { ok: true }                        — accepted (mailbox+notify fired)
 *   200 { ok: true, ignored: '...' }        — orch/session unknown (per spike H6:
 *                                             Claude must not crash on hook
 *                                             failures, so we never return 4xx
 *                                             on unknown ids; we just log a
 *                                             warning and tell the hook
 *                                             everything is fine)
 *   400 { error: ... }                      — body invalid
 *   401 { error: 'unauthorized' }           — missing/wrong bearer
 *
 * Logging: NEVER includes the bearer token, NEVER includes the message body
 * (it could carry tool transcripts). Only orch_id/session_id/kind.
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'node:crypto';
import { Spawner } from '../../modules/spawner/index.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';
import type { Notifier } from '../../modules/notify/index.js';

const log = withModule('hooks');

interface HookBody {
  orch_id?: unknown;
  session_id?: unknown;
  kind?: unknown;
  message?: unknown;
}

function safeEqualBytes(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface HooksRouterOptions {
  /** Safety net: arm a /compact when a session reports it is waiting. */
  compactOnWaiting: boolean;
  /** Idle window the armed /compact waits for before firing. */
  idleThresholdMs: number;
}

export function createHooksRouter(
  spawner: Spawner,
  hookToken: string,
  notifier: Notifier,
  options: HooksRouterOptions,
): Router {
  const router = Router();

  router.post('/hooks/notification', async (req: Request, res: Response) => {
    // ---- Auth (Bearer) -------------------------------------------------
    const authHeader = req.header('authorization') ?? req.header('Authorization') ?? '';
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      res.status(401).json({ error: 'unauthorized' });
      log.warn({ event: 'hooks.auth_fail', reason: 'malformed' });
      return;
    }
    if (!safeEqualBytes(parts[1], hookToken)) {
      res.status(401).json({ error: 'unauthorized' });
      log.warn({ event: 'hooks.auth_fail', reason: 'token-mismatch' });
      return;
    }

    // ---- Body validation ----------------------------------------------
    const body = (req.body ?? {}) as HookBody;
    if (typeof body.orch_id !== 'string' || body.orch_id.length === 0) {
      res.status(400).json({ error: 'orch_id required' });
      return;
    }
    if (typeof body.session_id !== 'string' || body.session_id.length === 0) {
      res.status(400).json({ error: 'session_id required' });
      return;
    }
    const message = typeof body.message === 'string' ? body.message : '';
    const kind = typeof body.kind === 'string' ? body.kind : 'session.waiting';
    if (kind !== 'session.waiting') {
      // Phase 4 only handles waiting today; future kinds can map here.
      res.status(400).json({ error: `unsupported kind: ${kind}` });
      return;
    }

    // ---- Resolve target -----------------------------------------------
    // Per spike H6: a non-2xx response from a hook can crash the calling
    // claude process. Unknown orch/session ids are an inevitable race after a
    // server restart (the in-memory map is empty but the per-session
    // settings.json still references the previous boot's ids). We log a
    // warning, return 200, and skip the side effects.
    const orch = spawner.get(body.orch_id);
    if (!orch) {
      log.warn({ event: 'hooks.orch_unknown', orchId: body.orch_id });
      res.status(200).json({ ok: true, ignored: 'orch_unknown' });
      return;
    }
    const session = orch.getSession(body.session_id);
    if (!session) {
      log.warn({ event: 'hooks.session_unknown', orchId: body.orch_id, sessionId: body.session_id });
      res.status(200).json({ ok: true, ignored: 'session_unknown' });
      return;
    }

    // ---- Fire side effects --------------------------------------------
    log.info({
      event: 'hooks.notification',
      kind,
      orchId: orch.id,
      sessionId: session.id,
      msgLen: message.length,
    });

    // Emit a status_changed event so the UI badge flips to 'waiting'
    // immediately. We DO NOT actually mutate the SessionStatus here — the
    // session is still 'running' from the PTY's POV — we just want the UI to
    // reflect the human-attention need.
    eventBus.emitEvent({
      kind: 'session.status_changed',
      orchestratorId: orch.id,
      sessionId: session.id,
      payload: { status: 'waiting', reason: 'notification-hook' },
    });

    // Context-management safety net (opt-in): a "waiting" session is paused
    // on a blocker, so arm a /compact to keep its context from growing while
    // it idles. The agent-driven `team.context_compact` is the primary path;
    // this only catches agents that pause without calling it. The command
    // fires at the next idle boundary and is a no-op if one is already armed.
    if (options.compactOnWaiting) {
      const armed = session.requestContextReset('/compact', {
        idleMs: options.idleThresholdMs,
      });
      if (armed) {
        log.info({
          event: 'hooks.auto_compact_armed',
          orchId: orch.id,
          sessionId: session.id,
        });
      }
    }

    // Discord notification — fire-and-forget (Notifier swallows internally).
    void notifier
      .notify({
        kind: 'session.waiting',
        orchestrator: {
          id: orch.id,
          name: orch.name,
          role: orch.role,
          status: orch.status,
        },
        session: {
          id: session.id,
          name: session.name,
          role: session.role,
          type: session.type,
          status: session.status,
          exitCode: session.exitCode,
          stopReason: session.stopReason,
        },
        message: message || `${session.name} is waiting for attention`,
      })
      .catch((err) => {
        log.warn({
          event: 'notify.dispatch_failed',
          kind: 'session.waiting',
          orchId: orch.id,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    res.status(200).json({ ok: true });
  });

  return router;
}
