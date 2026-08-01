/**
 * Phase 4 — `/hooks/notification` endpoint (plan §6 Phase 4 + §13/§14).
 *
 * ⚠️ ONE ENDPOINT, THREE PROVIDER SEMANTICS. Read this before adding a side
 * effect here.
 *
 * The endpoint was written for Claude Code's `Notification` hook, which fires
 * when the agent is BLOCKED ON A HUMAN. Codex and gemini reach the same URL with
 * a callback that fires at EVERY TURN BOUNDARY instead (codex `notify` ⇒
 * `{"type":"agent-turn-complete"}`, spike S1 C5; gemini `hooks.AfterAgent`,
 * which fires even on a failed turn, spike S2 C5). Firing all three side effects
 * on every callback therefore meant: a codex lead running twenty turns produced
 * twenty `waiting` badges, twenty Discord alerts and twenty armed compactions —
 * for an agent nobody was waiting on.
 *
 * So the side effects are gated on the SESSION'S PROVIDER
 * (`ProviderCapabilities.notificationHook`, `modules/providers/types.ts`):
 *
 *   `'needs-human'`   badge → `waiting`, Discord notification, armed `/compact`.
 *   `'turn-complete'` LOGGED, and nothing else. See below — this is the one
 *                     branch whose emptiness is a decision, not an omission.
 *   `false`           nothing at all, not even a log at info level. The provider
 *                     declares it sends no callback we consume, so a POST
 *                     claiming otherwise is a stale config file and is ignored
 *                     rather than trusted.
 *
 * WHY `'turn-complete'` ARMS NO `/compact`, having been considered and rejected.
 * A finished turn IS a real inactivity boundary, so arming the context-management
 * safety net there looks natural. It is redundant and unsafe:
 *
 *  1. **Redundant.** `Session._maybeAutoCompact` already arms `/compact` for ANY
 *     provider once a session has produced `SWARM_OS_AUTO_COMPACT_BYTES` of
 *     output since its last reset, with the SAME `idleMs` — so a
 *     volume-driven compaction already lands on exactly the same idle boundary,
 *     hook or no hook. The only thing this branch could add is compaction
 *     UNCONDITIONALLY, on every turn, however small the context.
 *  2. **Lossy and expensive at that cadence.** `/compact` summarises the
 *     conversation: doing it after every turn spends a model call to degrade the
 *     agent's own working memory, on a schedule nobody asked for.
 *  3. **It can feed itself.** The compaction is itself agent activity, and both
 *     providers fire on *every* turn (gemini's `AfterAgent` even on a failed
 *     one). A callback after the compaction turn would arm the next `/compact`,
 *     which fires at the next idle boundary, which fires the callback again — a
 *     session that compacts forever and merely looks busy. Nothing in the spikes
 *     rules that out, and `compactOnWaiting`'s own contract ("a *waiting* session
 *     is paused on a blocker") is not what a finished turn is.
 *
 * The cost of this decision, stated rather than hidden: for codex/gemini,
 * `SWARM_OS_COMPACT_ON_WAITING` does nothing. That is the honest consequence of
 * a provider that cannot report "blocked on a human" at all, and it is what
 * `capabilities.notificationHook` exists to make visible in the UI (plan Risk 8)
 * — volume-driven compaction via `SWARM_OS_AUTO_COMPACT_BYTES` is the knob that
 * works for every provider.
 *
 * The hook command itself is IDENTICAL for every provider (one shell string,
 * `providers/session-config.ts`), and deliberately so: it is production-critical
 * quoting that was paid for in incidents. The meaning is resolved here, where we
 * know which provider the session runs, rather than by making each adapter
 * invent its own payload.
 *
 * The hook command lives in each session's per-provider config dir (claude:
 * `settings.json`; gemini: `.gemini/settings.json`; codex: `notify.sh` +
 * `config.toml`). It POSTs JSON of the form:
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
 *   200 { ok: true }                        — accepted (side effects fired,
 *                                             filtered by provider semantics)
 *   200 { ok: true, ignored: '...' }        — orch/session unknown, or a provider
 *                                             that declares no consumed callback
 *                                             (per spike H6: Claude must not
 *                                             crash on hook failures, so we never
 *                                             return 4xx on unknown ids; we just
 *                                             log a warning and tell the hook
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
import type { ApprovalStore } from '../../modules/approvals/store.js';
import { classifyCategory, isPromptingMode, summarizeRequest } from '../../modules/approvals/prompting.js';
import { notifyApprovalRequested } from '../../modules/approvals/discord-notify.js';

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
  /**
   * Approval-gate queue (docs/garde-fous-approbation.md, Phase 1). Optional so
   * the route still works when the store failed to open at boot (approvals are
   * then simply not recorded — the legacy `waiting`/Discord path is untouched).
   */
  approvals?: ApprovalStore,
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

    // ---- Resolve what this callback MEANS for this provider ------------
    // The three CLIs POST the same body from different events; only the
    // session's own adapter knows which. See the module header.
    const semantics = session.providerCapabilities.notificationHook;
    const providerId = session.toView().provider;

    log.info({
      event: 'hooks.notification',
      kind,
      orchId: orch.id,
      sessionId: session.id,
      // Both fields, because they answer different questions: `provider` is what
      // an operator greps, `semantics` is why the side effects below did or did
      // not fire.
      provider: providerId,
      semantics: semantics === false ? 'none' : semantics,
      msgLen: message.length,
    });

    if (semantics === false) {
      // The adapter declares that nothing we consume calls back. Either a stale
      // per-session config file from a previous provider assignment, or an
      // adapter whose declaration is wrong. Trusting the POST over the
      // declaration is how a provider that cannot report `waiting` starts
      // reporting it — 200 (H6) and drop it.
      log.warn({
        event: 'hooks.notification_unexpected',
        orchId: orch.id,
        sessionId: session.id,
        provider: providerId,
      });
      res.status(200).json({ ok: true, ignored: 'provider_sends_no_notification' });
      return;
    }

    // ---- Turn boundary: recorded, never acted on ----------------------
    // See the module header for why this branch is deliberately empty. The
    // response says so explicitly, so an operator curling the endpoint can tell
    // "filtered by design" from "Discord is broken".
    if (semantics !== 'needs-human') {
      res.status(200).json({ ok: true, notified: false, semantics });
      return;
    }

    // ---- A human is needed --------------------------------------------
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

    // ---- Approval gate (P1): record a pending approval, non-bypass only ----
    // The gate arms ONLY for sessions whose permission mode actually PROMPTS the
    // human (docs §9.5). A bypassPermissions/dontAsk/auto session emits no prompt
    // and MUST never produce an approval — `isPromptingMode` enforces that, so a
    // bypass team's behaviour is byte-identical to before this branch existed.
    // Fully best-effort: `createRequest` never throws (it runs in the hook path),
    // and the whole block is guarded so an approval-subsystem hiccup can never
    // turn into a non-2xx that crashes the calling agent (spike H6). The event is
    // emitted by the store (same pattern as memory/taskboard), atomically with
    // the audit journal — nothing else to emit here.
    if (approvals && isPromptingMode(providerId, session.permissionMode)) {
      try {
        const category = classifyCategory(message);
        const requestedSummary = summarizeRequest(
          message,
          `${session.name} needs approval`,
        );
        const approval = approvals.createRequest({
          orchestratorId: orch.id,
          sessionId: session.id,
          category,
          requestedSummary,
          rawMessage: message,
          permissionMode: session.permissionMode,
          provider: providerId,
        });
        if (approval) {
          log.info({
            event: 'hooks.approval_requested',
            orchId: orch.id,
            sessionId: session.id,
            approvalId: approval.id,
            category: approval.category,
            permissionMode: session.permissionMode,
          });

          // ---- P3/P4: actionable Discord notification -----------------------
          // Additive to the legacy `session.waiting` ping below (both fire).
          // Prefers the PER-ORCH BOT (captures the posted message id so a native
          // Discord *reply* can be routed back to this approval — P4) and falls
          // back to the P3 per-orch webhook embed when no bot is wired. Both are
          // informational: they name what is requested and point the operator at
          // the reply-text protocol, the web toast/page, or the console.
          // Fire-and-forget — the helper swallows its own errors and is
          // timeout-bounded; the extra `.catch` is belt-and-braces so nothing on
          // the hook path can ever throw (spike H6).
          void notifyApprovalRequested({
            spawner,
            orch,
            session,
            approval,
            store: approvals,
          }).catch((err) => {
            log.warn({
              event: 'notify.dispatch_failed',
              kind: 'session.approval_requested',
              orchId: orch.id,
              sessionId: session.id,
              approvalId: approval.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        // Defence in depth — createRequest is already non-throwing, but the hook
        // path must survive anything (classification, summary, logging).
        log.warn({
          event: 'hooks.approval_failed',
          orchId: orch.id,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
