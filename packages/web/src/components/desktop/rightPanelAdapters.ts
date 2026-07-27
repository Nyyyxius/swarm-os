// packages/web/src/components/desktop/rightPanelAdapters.ts
//
// Step 7 — Pure adapters that derive the `RightPanelTeam` and
// `RightPanelAgent` shapes consumed by `RightPanel.tsx` from the raw
// backend views (`OrchestratorView`, `RoleView`, `SessionView`). Kept
// outside the component so they're trivially testable in isolation
// (no React, no I/O, no hooks).
//
// See `docs/redesign-desktop/07_rightpanel-data-binding.md` §3.

import {
  isDiscordConnectorView,
  type OrchestratorView,
  type RoleView,
  type SessionView,
} from '../../api/client';
import { type RightPanelAgent, type RightPanelTeam } from './RightPanel';

/**
 * Build the `RightPanelTeam` consumed by RightPanel from a raw
 * `OrchestratorView` + its role definition + the cwd we want to display
 * (typically the selected session's cwd — workers can diverge from the
 * lead's, so we pick the most relevant value at the call site).
 *
 * `role` may be `null` if the orchestrator was created with a free-form
 * `role` string instead of a `roleId` — in that case `leadPrompt` is
 * `null` (the prompt was inlined into the lead's PTY at start time) and
 * `discordWebhook` is `null` (no role-level connector list to read).
 */
export function buildRightPanelTeam(
  orch: OrchestratorView,
  role: RoleView | null,
  leadCwd: string,
): RightPanelTeam {
  // Discord chip : derived from role.connectors. Multiple Discord
  // webhooks per role aren't surfaced individually by the UI v1; we
  // pick the first one.
  const discordWebhook =
    role?.connectors.find(isDiscordConnectorView)?.webhookUrl ?? null;

  return {
    id: orch.id,
    name: orch.name,
    leadId: orch.leadSessionId ?? '',
    workerCount: orch.sessions.filter((s) => s.type === 'worker').length,
    model: orch.defaultModel,
    effort: orch.defaultEffort,
    permissionMode: orch.defaultPermissionMode,
    // Multi-provider Lot 3 — the team default, used to flag an agent that
    // diverges from it.
    provider: orch.defaultProvider,
    cwd: leadCwd,
    leadPrompt: role?.leadPrompt ?? null,
    leadPreamble: orch.leadPreamble,
    workerPreamble: orch.workerPreamble,
    discordWebhook,
    // Phase 8 — surface auto-resume audit for the "RESUMED N×" chip.
    resumeCount: orch.resumeCount,
    lastResumedAt: orch.lastResumedAt,
  };
}

/**
 * Build the `RightPanelAgent` consumed by RightPanel from a raw
 * `SessionView` + the live `logLines` accumulator + the current writer
 * flag (both derived in `DesktopShell` from `Terminal.tsx` callbacks).
 *
 * `load` is hard-wired to `undefined` (S10 by-design — no signal exists
 * server-side). The numeric branch is reserved for a future option (b)
 * implementation, cf. `lib/loadPercent.ts`.
 */
export function buildRightPanelAgent(
  session: SessionView,
  logLines: number,
  writer: boolean | undefined,
): RightPanelAgent {
  return {
    id: session.id,
    name: session.name,
    role: session.role,
    status: session.status,
    pid: session.pid,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    load: undefined,
    logLines,
    writer,
    provider: session.provider,
    exitCode: session.exitCode,
    stopReason: session.stopReason,
    lastError: session.lastError,
  };
}
