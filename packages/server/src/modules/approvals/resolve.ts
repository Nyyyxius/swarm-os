/**
 * Approval-gate — the SHARED resolution core (docs/garde-fous-approbation.md
 * §6 "Backend — file d'approbations + résolution", §10 idempotence/races).
 *
 * Resolving a pending approval is TWO effects, and both the P2 REST route
 * (`http/routes/approvals.ts`) and the P4 Discord-reply path (`bot.ts` via the
 * spawner) must do EXACTLY the same thing — so the logic lives here once, called
 * by both, rather than duplicated:
 *
 *   (a) replay the operator's KEYSTROKE to the blocked session's PTY
 *       (`keystrokes.ts` → `submitInput`/`writeInput`, the same primitives the
 *       xterm console uses), then
 *   (b) record the decision in the store (`resolveRequest`, which emits
 *       `approval.resolved` atomically with its audit journal).
 *
 * Order is keystroke-first (unblock the agent), record-second — the store record
 * is the source of truth regardless of whether the PTY write landed. The
 * keystroke is best-effort (§10): a write failure never fails the resolution.
 *
 * Idempotence / races (§10): the operator may also answer straight in the
 * console, and the `needs-human` hook does not re-fire when the prompt vanishes,
 * so a request can be non-pending by the time a resolve lands. The outcomes:
 *   - `not_found`        — no such approval.
 *   - `already_resolved` — terminal already (another operator / reconciled). No
 *                          keystroke sent; the current terminal record returned.
 *   - `session_gone`     — the blocked session is gone (prompt gone with it):
 *                          recorded as `answered_in_console`, nothing typed.
 *   - `resolved`         — recorded approved/denied; `delivered` says whether a
 *                          keystroke was actually replayed (`noMapping` when the
 *                          provider has no keystroke mapping yet — P5).
 */

import type { Spawner } from '../spawner/index.js';
import { keystrokeFor, type ApprovalDecisionInput } from './keystrokes.js';
import type { ApprovalRequest, ApprovalResolution, ApprovalStore } from './store.js';
import { withModule } from '../../logger.js';

const log = withModule('approvals.resolve');

export interface ResolveApprovalOptions {
  /** Operator intent. */
  decision: ApprovalDecisionInput;
  /** claude's "approve AND don't ask again" (prompt option 2). */
  dontAskAgain?: boolean;
  /** Provenance recorded in the audit journal (`'web'`, `'discord:<user>'`, …). */
  by?: string | null;
}

export type ResolveApprovalOutcome =
  | { outcome: 'not_found'; request: null; delivered: false; keystroke: null; noMapping: false }
  | { outcome: 'already_resolved'; request: ApprovalRequest; delivered: false; keystroke: null; noMapping: false }
  | { outcome: 'session_gone'; request: ApprovalRequest; delivered: false; keystroke: null; noMapping: false }
  | {
      outcome: 'resolved';
      request: ApprovalRequest;
      delivered: boolean;
      keystroke: string | null;
      /** true → the provider has no keystroke mapping yet (decision still recorded). */
      noMapping: boolean;
    };

/**
 * Resolve approval `id` with `opts`. Channel-agnostic: the REST route and the
 * Discord reply router both call this. Never throws — the store methods are
 * defensive and the keystroke replay is guarded.
 */
export function resolveApproval(
  spawner: Spawner,
  store: ApprovalStore,
  id: string,
  opts: ResolveApprovalOptions,
): ResolveApprovalOutcome {
  const by = opts.by ?? null;
  const request = store.getRequest(id);
  if (!request) {
    return { outcome: 'not_found', request: null, delivered: false, keystroke: null, noMapping: false };
  }

  // Already terminal (another operator, or answered in the console and
  // reconciled): do NOT send a keystroke, report the current terminal state.
  if (request.status !== 'pending') {
    return {
      outcome: 'already_resolved',
      request,
      delivered: false,
      keystroke: null,
      noMapping: false,
    };
  }

  // The blocked session must still be live to receive the keystroke. If it is
  // gone, the prompt is gone with it — take the request out of `pending` cleanly
  // as `answered_in_console` (§10) rather than leave a phantom.
  const found = spawner.findSession(request.sessionId);
  if (!found) {
    const resolved = store.resolveRequest(id, { decision: 'answered_in_console', by });
    return {
      outcome: 'session_gone',
      request: resolved ?? request,
      delivered: false,
      keystroke: null,
      noMapping: false,
    };
  }

  const provider = found.session.toView().provider;
  const plan = keystrokeFor(provider, opts.decision, opts.dontAskAgain);
  const storeDecision: ApprovalResolution = opts.decision === 'approve' ? 'approved' : 'denied';

  // (a) Replay the keystroke (best-effort — a PTY write failure must not fail the
  // resolution; the store record below is authoritative).
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
  const resolved = store.resolveRequest(id, {
    decision: storeDecision,
    by,
    dontAskAgain: opts.dontAskAgain,
  });

  return {
    outcome: 'resolved',
    request: resolved ?? request,
    delivered,
    keystroke: plan?.label ?? null,
    noMapping: !plan,
  };
}
