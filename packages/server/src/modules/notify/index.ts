/**
 * Phase 4 — Notifier interface (plan §12).
 *
 * The orchestrator/Spawner code calls a single `Notifier.notify({...})` for
 * the three event kinds the human cares about:
 *
 *  - `session.waiting`        — Claude's `Notification` hook fired (the
 *                               session needs a human, e.g. to approve a
 *                               permission, to read a clarifying question).
 *  - `orchestrator.ended`     — the orchestrator transitioned to `stopped`
 *                               or `failed`. Carries the lead's exit code.
 *  - `session.exit_anomaly`   — a worker exited abnormally (already wired in
 *                               Phase 3 to push a synthetic mail to the lead).
 *
 * The interface is **single-method** so wiring is identical regardless of
 * the implementation:
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
  | 'orchestrator.ended'
  | 'session.exit_anomaly';

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
