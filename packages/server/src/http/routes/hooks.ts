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
 *     "kind":      "session.waiting" (default) | "session.transcript",
 *     "message":   "<raw stdin from Claude — opaque>"
 *   }
 *
 * SECOND KIND — `session.transcript` (docs/monitoring-agents.md, Lot 2). Claude
 * Code's `SessionStart` hook, which fires at boot and after every `/clear` and
 * `/compact`, and whose payload carries the path of the transcript `.jsonl`
 * this agent is writing. It is the ONLY reliable source of context usage (the
 * TUI's stdout is a repainting terminal). It shares this endpoint, this auth and
 * this envelope on purpose: one hook command builder, one production-critical
 * quoting, one place where a provider's callback is given a meaning. The branch
 * answers 200 unconditionally — see below.
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
 *   200 { ok: true, transcript: bool }      — `session.transcript`: `false` means
 *                                             the payload carried no readable
 *                                             `transcript_path`, which costs one
 *                                             poll cycle of gauge and nothing else
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
 * TWO PAYLOAD FIELDS THIS ROUTE READS FOR THE AUTO-COMPACT FEATURE
 * (docs/auto-compact.md). Both are single field reads with a single call each;
 * neither changes a status, a response or a notification.
 *
 *  - `notification_type` on the `needs-human` branch (D5). It is what separates
 *    "a dialog is on screen waiting for a human" from "the agent has been idle
 *    for 60 seconds" — two things this endpoint could not tell apart before, and
 *    which need OPPOSITE handling: the first must freeze every server-side
 *    injection into that PTY (a line typed into a permission dialog validates
 *    the highlighted option), the second must not. It raises / lowers
 *    `Session.dialogPending`; see the three type tables below for the
 *    vocabulary and where it was read from.
 *
 *  - `source` on the `session.transcript` branch (D4). `compact` / `clear` mean
 *    the CLI restarted its session because the context was thrown away — most
 *    importantly by Claude Code's OWN internal auto-compact, which fires
 *    mid-turn with no server involvement. The gauge is marked stale so the
 *    auto-compact decision does not act on a figure describing a context that
 *    no longer exists.
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
import type { FeatureRegistry } from '../../modules/features/registry.js';
import {
  approvalDiscordEnabled,
  classifyCategory,
  isPromptingMode,
  shouldArmApproval,
  summarizeRequest,
} from '../../modules/approvals/prompting.js';
import type { RoleApprovalSettings } from '../../modules/roles/index.js';
import { notifyApprovalRequested } from '../../modules/approvals/discord-notify.js';

const log = withModule('hooks');

/**
 * docs/auto-compact.md D5 — what claude's `notification_type` means for the
 * dialog guard.
 *
 * The `Notification` hook payload is
 * `{hook_event_name, message, title?, notification_type}`. The three sets below
 * were read out of the two binaries this deployment actually runs — 2.1.142
 * (pinned in the image, `Dockerfile`) and 2.1.270 (the host CLI) — by grepping
 * their bundled `cli.js`; both carry the field, so the untyped fallback further
 * down is a legacy path, not the normal one.
 *
 * The stake is asymmetric, which is why this is three explicit tables and not
 * one heuristic. Missing a BLOCKING type means the server types into a live
 * permission dialog and validates whatever option is highlighted. Over-claiming
 * one means an agent's mail signals, context resets and operator notices freeze
 * until a human types something. So: blocking when we know it blocks, clearing
 * when the CLI says the dialog is over, nothing at all for the informational
 * ones — and for a type we have never seen, fail closed ONLY where a dialog is
 * possible at all (see `isPromptingMode` at the callsite).
 */

/** A dialog is now on screen, waiting for a human. */
const BLOCKING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt',
  'worker_permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

/**
 * The dialog is over. The only automatic way the flag ever comes down without a
 * keystroke — which is what rescues an MCP elicitation cancelled on a timeout,
 * where nobody types anything and the guard would otherwise stand for the rest
 * of the session's life.
 */
const DIALOG_DONE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'elicitation_complete',
  'elicitation_response',
]);

/**
 * Informational — the CLI is telling us something, nobody is blocked. Notably
 * `idle_prompt` ("Claude is waiting for your input", fired after 60 s of
 * inactivity): treating THAT as a dialog would freeze every idle agent in the
 * fleet, which is the exact opposite of what this feature is for.
 */
const INFORMATIONAL_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'idle_prompt',
  'auth_success',
  'agent_completed',
  'push_notification',
  'computer_use_enter',
  'computer_use_exit',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
]);

/**
 * One `hooks.notification_type_unknown` warning per unrecognised type for the
 * life of the process — a new CLI release adds a handful at most, so this set
 * is bounded by the vocabulary, not by traffic.
 */
const unknownNotificationTypesWarned = new Set<string>();

/**
 * docs/auto-compact.md D5 — raise or lower `Session.dialogPending` from one
 * `Notification` payload.
 *
 * Extracted from the route body so the decision is one readable table lookup
 * and so its failure mode is one `try/catch` at the callsite (spike H6: this
 * endpoint never answers anything but 2xx). Takes the narrow slice of the
 * session it needs, which is also the slice the route's own tests double.
 */
function applyDialogGuard(
  session: {
    id: string;
    permissionMode: string;
    markDialogPending(notificationType: string): void;
    clearDialogPending(source: 'input' | 'elicitation'): void;
    dialogPendingUntypedWarned: boolean;
  },
  payload: Record<string, unknown> | null,
  providerId: string,
  orchId: string,
): void {
  const notificationType = readStringField(payload, 'notification_type');
  if (notificationType !== null) {
    if (BLOCKING_NOTIFICATION_TYPES.has(notificationType)) {
      session.markDialogPending(notificationType);
      log.info({
        event: 'hooks.dialog_pending',
        orchId,
        sessionId: session.id,
        notificationType,
      });
    } else if (DIALOG_DONE_NOTIFICATION_TYPES.has(notificationType)) {
      session.clearDialogPending('elicitation');
    } else if (!INFORMATIONAL_NOTIFICATION_TYPES.has(notificationType)) {
      // A type neither binary we checked emits. Fail closed, but ONLY where a
      // dialog is possible at all: freezing a whole bypassPermissions fleet's
      // mail on a future informational type would be the real regression, and
      // those sessions show no permission dialog to type into anyway.
      const couldPrompt = isPromptingMode(providerId, session.permissionMode);
      if (!unknownNotificationTypesWarned.has(notificationType)) {
        unknownNotificationTypesWarned.add(notificationType);
        log.warn({
          event: 'hooks.notification_type_unknown',
          orchId,
          sessionId: session.id,
          notificationType,
          provider: providerId,
          blocking: couldPrompt,
        });
      }
      if (couldPrompt) {
        session.markDialogPending(notificationType);
        log.info({
          event: 'hooks.dialog_pending',
          orchId,
          sessionId: session.id,
          notificationType,
        });
      }
    }
  } else if (isPromptingMode(providerId, session.permissionMode)) {
    // Field ABSENT — a CLI older than both binaries we checked. The question
    // here is "does this mode show dialogs", which is `isPromptingMode`, NOT
    // "does this role want approvals" (`shouldArmApproval`): a role may list
    // `bypassPermissions` in its `armingModes`, and that would have frozen a
    // whole bypass fleet on a single untyped `idle_prompt`.
    session.markDialogPending('untyped');
    log.info({
      event: 'hooks.dialog_pending',
      orchId,
      sessionId: session.id,
      notificationType: 'untyped',
    });
    if (!session.dialogPendingUntypedWarned) {
      session.dialogPendingUntypedWarned = true;
      // Never silent: if this path is taken, a prompting session receiving an
      // untyped `idle_prompt` after 60 s of inactivity freezes its signal, its
      // resets and its notices until someone types — a regression against
      // today's behaviour that an operator must be able to find.
      log.warn({
        event: 'hooks.dialog_pending_untyped',
        orchId,
        sessionId: session.id,
        provider: providerId,
        permissionMode: session.permissionMode,
      });
    }
  }
}

interface HookBody {
  orch_id?: unknown;
  session_id?: unknown;
  kind?: unknown;
  message?: unknown;
}

/**
 * The raw hook payload as an object, or `null`.
 *
 * The hook command re-stringifies the CLI's stdin into `message` (one shell
 * pipeline, shared by all three providers — `providers/session-config.ts`), so
 * what arrives here is a JSON document inside a JSON string. Everything about
 * this is untrusted: a `message` that is a plain sentence, a truncated body, an
 * array where an object was expected. All of it answers `null`.
 */
function readHookPayload(message: string): Record<string, unknown> | null {
  if (typeof message !== 'string' || message.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string field, or `null`. */
function readStringField(
  payload: Record<string, unknown> | null,
  ...keys: readonly string[]
): string | null {
  if (payload === null) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * `transcript_path` out of a hook payload — claude's `SessionStart` and
 * `Notification` both carry it (docs/monitoring-agents.md, Lot 2).
 */
function readTranscriptPath(payload: Record<string, unknown> | null): string | null {
  return readStringField(payload, 'transcript_path');
}

/**
 * `thread-id` out of a codex `notify` payload (docs/monitoring-agents.md, Lot 6).
 *
 * codex hands its notification JSON to `notify.sh` as a single argv, which the
 * shared POST pipeline pipes here verbatim: `{"type":"agent-turn-complete",
 * "thread-id":"019f…","turn-id":"019f…","cwd":…}` (spike `verify-codex` C5). That
 * uuid is exactly the one in the rollout filename the tracker has to find, and
 * it CHANGES on `/new` and `/clear` — which is what makes it the one reliable
 * key for a context reset (`verify-codex-rollout` R5/R6).
 *
 * The snake_case spelling is accepted too: nothing costs less than reading both,
 * and a CLI renaming a hyphenated JSON key is exactly the kind of change that
 * would otherwise degrade the gauge silently.
 */
function readThreadId(payload: Record<string, unknown> | null): string | null {
  return readStringField(payload, 'thread-id', 'thread_id');
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

/**
 * Fail-safe read of a team's OPTIONAL per-role approval override (P5). Returns
 * `null` (→ built-in default arming + Discord ON) when the team has no role, the
 * role store is unavailable, the role is gone, or anything throws. The approval
 * gate runs on the `/hooks/notification` path, so this MUST never throw — a
 * bad/absent setting silently degrades to the pre-P5 default.
 */
function readRoleApprovalSettings(
  spawner: Spawner,
  roleId: string | null | undefined,
): RoleApprovalSettings | null {
  try {
    if (!roleId) return null;
    const role = spawner.roleStore?.get(roleId);
    return role?.approval ?? null;
  } catch {
    return null;
  }
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
  /**
   * Built-in feature registry (docs/builtin-features.md D9). Optional — when
   * absent the gate FAILS OPEN (approvals behave as enabled), matching the rest
   * of the codebase's `!features || features.isEnabled(...)` convention. When
   * present it gates the SINGLE approval-creation site below: with `approvals`
   * disabled the whole request still runs the pre-approvals fallback (the
   * `waiting` badge event, Discord legacy ping, auto-compact) — only the
   * persisted approval + its actionable notification are skipped.
   */
  features?: FeatureRegistry,
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
    if (kind !== 'session.waiting' && kind !== 'session.transcript') {
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

    // ---- Where does this agent write its transcript? -------------------
    // Monitoring (docs/monitoring-agents.md, Lot 2). Belt-and-braces: EVERY
    // payload is inspected, not just the `SessionStart` one, because a claude
    // `Notification` payload carries `transcript_path` too — so an agent that
    // somehow never fired `SessionStart` still gets its tracker pointed at the
    // right file. `Session.setTranscriptPath` is the one place that decides
    // whether a provider has a readable transcript at all; here we only hand
    // over what we found. Guarded because this must never cost a 4xx (H6).
    const payload = readHookPayload(message);
    const transcriptPath = readTranscriptPath(payload);
    let transcriptAdopted = false;
    if (transcriptPath !== null) {
      try {
        session.setTranscriptPath(transcriptPath);
        transcriptAdopted = true;
      } catch (err) {
        log.warn({
          event: 'hooks.transcript_failed',
          orchId: orch.id,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ---- Which codex thread is this agent on? --------------------------
    // Monitoring (docs/monitoring-agents.md, Lot 6). Same belt-and-braces
    // treatment, same guard, same "never a 4xx": codex's `notify` fires once per
    // completed turn and carries the `thread-id` whose uuid names the rollout
    // file the tracker tails. `Session.setAgentThreadId` is the one place that
    // decides which provider has threads at all.
    const threadId = readThreadId(payload);
    if (threadId !== null) {
      try {
        session.setAgentThreadId(threadId);
      } catch (err) {
        log.warn({
          event: 'hooks.thread_id_failed',
          orchId: orch.id,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ---- SessionStart: nothing else to do ------------------------------
    // ALWAYS 200, even on a payload we could not read: this hook runs
    // synchronously as the CLI boots, and its only job was to tell us a path.
    // A body we cannot parse means one poll cycle without a gauge, never a
    // failed agent startup.
    if (kind === 'session.transcript') {
      // docs/auto-compact.md D4 — `SessionStart` carries WHY the CLI restarted
      // its session, and two of those reasons mean the context we are gauging
      // no longer exists: `compact` (Claude Code's OWN internal auto-compact,
      // which fires mid-turn entirely behind the server's back, and a `/compact`
      // typed by hand in the console) and `clear`. Without this, the premise the
      // auto-compact decision rests on — "the context only grows between two
      // resets" — is false for exactly those cases, and a snapshot inherited
      // from before such a compaction would arm a redundant `/compact` on a
      // context that is already fresh. For a reset the SERVER armed this is a
      // harmless second bump (already stale, floor already null).
      const startSource = readStringField(payload, 'source');
      let contextMarkedStale = false;
      if (startSource === 'compact' || startSource === 'clear') {
        try {
          session.markContextStale();
          contextMarkedStale = true;
        } catch (err) {
          // Same rule as everything else on this path: never a 4xx, never a
          // failed agent startup, for a gauge.
          log.warn({
            event: 'hooks.context_stale_failed',
            orchId: orch.id,
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      log.info({
        event: 'hooks.transcript',
        orchId: orch.id,
        sessionId: session.id,
        adopted: transcriptAdopted,
        source: startSource,
        contextMarkedStale,
        msgLen: message.length,
      });
      res.status(200).json({ ok: true, transcript: transcriptAdopted });
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

    // ---- Is a DIALOG waiting for a human? (docs/auto-compact.md D5) ----
    //
    // Deliberately the FIRST thing this branch does — before the `waiting`
    // event (an automation listening on the bus must not be able to answer
    // before the flag exists) and therefore before the `compactOnWaiting`
    // backstop below, which is then held from the start instead of arming a
    // `/compact` that would be typed into the dialog.
    //
    // Rejected alternative: reading the approval store. `createRequest` fires
    // for EVERY `needs-human` notification of a prompting session, `idle_prompt`
    // included, with no type filter and no deduplication, and nothing resolves
    // those — the guard would have answered "blocked" for the rest of the
    // session's life.
    //
    // The speed of this guard is the latency of the hook's POST (a curl on the
    // agent's host), far under the 2 s idle window — and the dialog's own
    // rendering IS PTY output, so no reset can slip into a dialog whose hook
    // has not landed yet.
    // Guarded like every other side effect on this path: spike H6 — a hook that
    // answers anything but 2xx can crash the calling agent, so a bug in the
    // dialog guard costs the guard, never the session.
    try {
      applyDialogGuard(session, payload, providerId, orch.id);
    } catch (err) {
      log.warn({
        event: 'hooks.dialog_guard_failed',
        orchId: orch.id,
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
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
    // and MUST never produce an approval — the default `isPromptingMode` enforces
    // that, so a bypass team's behaviour is byte-identical to before this branch
    // existed. P5: a role MAY override the arming set (or disable the guard
    // entirely) via `RoleApprovalSettings`; absent → the same default. Reading
    // the role is fail-safe (any error → default, `roleSettings` stays null).
    // Fully best-effort: `createRequest` never throws (it runs in the hook path),
    // and the whole block is guarded so an approval-subsystem hiccup can never
    // turn into a non-2xx that crashes the calling agent (spike H6). The event is
    // emitted by the store (same pattern as memory/taskboard), atomically with
    // the audit journal — nothing else to emit here.
    // D9 gate: the approval-CREATION site is the ONLY thing behind the feature
    // toggle. When approvals is disabled the request has ALREADY emitted the
    // `waiting` badge event above and STILL runs the Discord-legacy ping +
    // auto-compact below — the exact pre-approvals behaviour. Fail-open when no
    // registry is wired (tests / boot-degraded), consistent with the HTTP gates.
    const approvalsFeatureOn = !features || features.isEnabled('approvals');
    const roleSettings = readRoleApprovalSettings(spawner, orch.roleId);
    if (
      approvals &&
      approvalsFeatureOn &&
      shouldArmApproval(providerId, session.permissionMode, roleSettings)
    ) {
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
          // P5 (Volet 3): a role can suppress this embed (`discordNotify: false`)
          // — absent/true → ON. The approval itself + web/API/console are
          // unaffected; only the Discord post is skipped.
          // Fire-and-forget — the helper swallows its own errors and is
          // timeout-bounded; the extra `.catch` is belt-and-braces so nothing on
          // the hook path can ever throw (spike H6).
          if (approvalDiscordEnabled(roleSettings)) {
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
