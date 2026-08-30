/**
 * Phase 4 — Notifier interface (plan §12).
 *
 * The orchestrator/Spawner code calls a single `Notifier.notify({...})` for
 * the three event kinds the human cares about:
 *
 *  - `session.waiting`        — Claude's `Notification` hook fired (the
 *                               session needs a human, e.g. to approve a
 *                               permission, to read a clarifying question).
 *  - `session.approval_requested` — a non-bypass session recorded a pending
 *                               approval (docs/garde-fous-approbation.md, P3).
 *                               ADDITIVE to `session.waiting` (both fire): the
 *                               enriched, per-orch embed that names WHAT is
 *                               requested and how to answer (web toast/page, or
 *                               open the console). Response routing is P4.
 *  - `orchestrator.ended`     — the orchestrator transitioned to `stopped`
 *                               or `failed`. Carries the lead's exit code.
 *  - `session.exit_anomaly`   — a worker exited abnormally (already wired in
 *                               Phase 3 to push a synthetic mail to the lead).
 *  - `session.budget_exceeded` — the team crossed its role's cost budget
 *                               (docs/monitoring-agents.md, Lot 14). ONE-SHOT
 *                               per crossing, emitted by the budget janitor. It
 *                               carries no session: the budget belongs to the
 *                               TEAM, and under `pause` every session of it —
 *                               lead included — was just SIGSTOPped.
 *
 * Plugins additionally reach `Notifier.notifyCustom({...})` through the
 * capability-gated `api.notify.custom` façade — a free-form title/message/level
 * embed prefixed `[plugin:<name>]`, with no orchestrator snapshot.
 *
 * Wiring is identical regardless of the implementation:
 *
 *   - `DiscordWebhookNotifier`  → `discord.ts`
 *   - `NoOpNotifier`            → `null.ts` (fallback when no webhook URL)
 *
 * Plan invariants:
 *
 *  - Discord must NEVER block the orchestrator. Implementations MUST be
 *    timeout-bounded and swallow errors (logging a warning).
 *  - URLs in the Discord embed NEVER carry a token (plan §12).
 *  - No coalescing in MVP — 1 event → 1 post (plan §12, §17).
 */

import type { OrchestratorView } from '../orchestrator/index.js';
import type { SessionView } from '../orchestrator/session.js';

export type NotificationKind =
  | 'session.waiting'
  | 'session.approval_requested'
  | 'orchestrator.ended'
  | 'session.exit_anomaly'
  | 'session.budget_exceeded';

/** Severity of a plugin-originated custom notification (`api.notify.custom`). */
export type NotificationLevel = 'info' | 'warn' | 'critical';

/**
 * Free-form notification emitted by a PLUGIN via `api.notify.custom`.
 * Unlike `NotificationInput` it carries no orchestrator/session snapshot —
 * the plugin façade injects `pluginName` so the embed title is always
 * prefixed `[plugin:<name>]` (the caller cannot forge it).
 */
export interface CustomNotificationInput {
  /** Injected by the plugin façade — never supplied by the caller. */
  pluginName: string;
  title: string;
  message: string;
  level: NotificationLevel;
}

export interface NotificationInput {
  kind: NotificationKind;
  /** Snapshot of the orchestrator at notification time. */
  orchestrator: Pick<
    OrchestratorView,
    'id' | 'name' | 'role' | 'status'
  >;
  /** Optional — present for all `session.*` kinds, omitted for orch-only events. */
  session?: Pick<
    SessionView,
    'id' | 'name' | 'role' | 'type' | 'status' | 'exitCode' | 'stopReason'
  >;
  /** Human-readable message — shown in the Discord description. */
  message: string;
  /** Anything else worth carrying alongside (logged but not necessarily rendered). */
  extra?: Record<string, unknown>;
}

export interface Notifier {
  notify(input: NotificationInput): Promise<void>;
  /**
   * Plugin-originated free-form notification (`api.notify.custom`). Same
   * invariants as `notify()`: timeout-bounded, never throws, no-op fallback
   * when no webhook is configured.
   */
  notifyCustom(input: CustomNotificationInput): Promise<void>;
  /**
   * Phase 8 — optional mute window. When set to a future epoch ms, the
   * notifier returns immediately without sending. Used by the boot sequence
   * to suppress the `session.waiting` storm that occurs when N teams are
   * auto-resumed and each lead asks for input within seconds.
   *
   * Implementations not interested in muting can omit the property — the
   * caller does a duck-typed check `(notifier as any).muteUntil`.
   */
  muteUntil?: number;
}

export { DiscordWebhookNotifier } from './discord.js';
export { NoOpNotifier } from './null.js';
