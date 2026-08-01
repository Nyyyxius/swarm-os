/**
 * Approval-gate P2 — the RESOLUTION CHANNEL for human-in-the-loop approvals
 * (docs/garde-fous-approbation.md, Phase 2). Backend + REST only; no UI here
 * (that is P3). Mounted with the AUTHENTICATED routers in `http/main.ts` (behind
 * X-Auth-Token), next to `createTaskboardRouter` — so "who may approve" is
 * "anyone holding the global token", the decision recorded in §9.4.
 *
 * Endpoints:
 *   GET  /api/approvals?orch=&status=   -> { approvals: ApprovalRequest[] }
 *   GET  /api/approvals/:id             -> ApprovalRequest + { events } (404 if absent)
 *   POST /api/approvals/:id/resolve     -> resolve a pending approval
 *        body { decision: 'approve'|'deny', dontAskAgain?: boolean, by?: string }
 *
 * Resolving a pending approval (a) replays the operator's KEYSTROKE to the
 * blocked session's PTY (`modules/approvals/keystrokes.ts` → `submitInput` /
 * `writeInput`, the same primitives the xterm console uses) and (b) records the
 * decision in the store (`resolveRequest`, which emits `approval.resolved`
 * atomically with its audit journal — same store-owns-emission pattern as P1).
 *
 * Idempotence & races (docs §10). The operator may also answer straight in the
 * console, and the `needs-human` hook does not re-fire when the prompt vanishes,
 * so a request can be "no longer pending" by the time a resolve lands:
 *   - already resolved            -> 409 ALREADY_RESOLVED (no keystroke sent).
 *   - session gone (prompt gone)  -> record `answered_in_console`, 200, nothing typed.
 *   - `resolveRequest` is itself idempotent, so a double resolve never
 *     re-decides or double-emits.
 * The keystroke replay is best-effort (§10): the UI always keeps an "open the
 * console" fallback, and the store record is the source of truth regardless.
 */

import { Router, type Request, type Response } from 'express';
import { Spawner } from '../../modules/spawner/index.js';
import { APPROVAL_STATUSES, type ApprovalStore, type ApprovalResolution } from '../../modules/approvals/store.js';
import { keystrokeFor, type ApprovalDecisionInput } from '../../modules/approvals/keystrokes.js';
import { withModule } from '../../logger.js';

const log = withModule('approvals.route');

const VALID_STATUSES: ReadonlySet<string> = new Set(APPROVAL_STATUSES);

export function createApprovalsRouter(spawner: Spawner, approvals: ApprovalStore): Router {
  const router = Router();

  // List a team's approvals; `orch` is REQUIRED (the queue is per-team, like the
  // board), `status` is an optional filter mirroring the store's own statuses.
  router.get('/api/approvals', (req: Request, res: Response) => {
    const orch = typeof req.query.orch === 'string' ? req.query.orch : '';
    if (!orch) {
      res.status(400).json({ error: 'query param `orch` is required', code: 'ORCH_REQUIRED' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status != null && !VALID_STATUSES.has(status)) {
      res
        .status(400)
        .json({ error: `status must be one of ${[...VALID_STATUSES].join('|')}`, code: 'INVALID_STATUS' });
      return;
    }
    res.json({ approvals: approvals.listByOrchestrator(orch, status) });
  });

  // One approval + the tail of its audit journal (404 if absent).
  router.get('/api/approvals/:id', (req: Request<{ id: string }>, res: Response) => {
    const request = approvals.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ ...request, events: approvals.listEvents(req.params.id) });
  });

  // Resolve a pending approval: replay the keystroke to the PTY, record the
  // decision. See the module header for the idempotence / race contract.
  router.post('/api/approvals/:id/resolve', (req: Request<{ id: string }>, res: Response) => {
    const body = (req.body ?? {}) as {
      decision?: unknown;
      dontAskAgain?: unknown;
      by?: unknown;
    };
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'deny') {
      res
        .status(400)
        .json({ error: "body.decision must be 'approve' or 'deny'", code: 'INVALID_DECISION' });
      return;
    }
    const dontAskAgain = body.dontAskAgain === true;
    const by = typeof body.by === 'string' && body.by.length > 0 ? body.by : 'web';

    const request = approvals.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      return;
    }

    // Already resolved (by another operator, or answered in the console and
    // reconciled): do NOT send a keystroke, report the current terminal state.
    if (request.status !== 'pending') {
      res.status(409).json({
        error: `approval already resolved (${request.status})`,
        code: 'ALREADY_RESOLVED',
        status: request.status,
        request,
      });
      return;
    }

    // The blocked session must still be live to receive the keystroke. If it is
    // gone, the prompt is gone with it — take the request out of `pending`
    // cleanly as `answered_in_console` (docs §10) rather than leave a phantom.
    const found = spawner.findSession(request.sessionId);
    if (!found) {
      const resolved = approvals.resolveRequest(req.params.id, {
        decision: 'answered_in_console',
        by,
      });
      res.status(200).json({
        ok: true,
        delivered: false,
        reason: 'session_gone',
        decision: 'answered_in_console',
        status: resolved?.status ?? 'answered_in_console',
        request: resolved ?? request,
      });
      return;
    }

    const provider = found.session.toView().provider;
    const plan = keystrokeFor(provider, decision as ApprovalDecisionInput, dontAskAgain);
    const storeDecision: ApprovalResolution = decision === 'approve' ? 'approved' : 'denied';

    // (a) Replay the keystroke (best-effort — never let a PTY write failure 500
    // the resolve; the store record below is the source of truth regardless).
    let delivered = false;
    if (plan) {
      try {
        if (plan.submit) found.session.submitInput(plan.data);
        else found.session.writeInput(plan.data);
        delivered = true;
      } catch (err) {
        log.warn({
          event: 'approvals.keystroke_failed',
          approvalId: request.id,
          sessionId: request.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (b) Record the decision (emits `approval.resolved` via the store).
    const resolved = approvals.resolveRequest(req.params.id, {
      decision: storeDecision,
      by,
      dontAskAgain,
    });

    log.info({
      event: 'approvals.resolved',
      approvalId: request.id,
      orchId: request.orchestratorId,
      sessionId: request.sessionId,
      decision: storeDecision,
      dontAskAgain,
      delivered,
      keystroke: plan?.label ?? null,
      by,
    });

    res.status(200).json({
      ok: true,
      delivered,
      keystroke: plan?.label ?? null,
      // Non-fatal note when the provider has no keystroke mapping yet (P5): the
      // decision is still recorded, but nothing was typed into the PTY.
      ...(plan ? {} : { reason: 'no_keystroke_mapping' }),
      decision: storeDecision,
      dontAskAgain,
      status: resolved?.status ?? storeDecision,
      request: resolved ?? request,
    });
  });

  return router;
}
