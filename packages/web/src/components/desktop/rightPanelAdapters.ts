// packages/web/src/components/desktop/rightPanelAdapters.ts
//
// Step 7 — Pure adapters that derive the `RightPanelTeam` and
// `RightPanelAgent` shapes consumed by `RightPanel.tsx` from the raw
// backend views (`OrchestratorView`, `RoleView`, `SessionView`). Kept
// outside the component so they're trivially testable in isolation
// (no React, no I/O, no hooks).
//
// See `docs/internal/ui-redesign/redesign-desktop/07_rightpanel-data-binding.md` §3.

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
    // Agent crons target a ROLE, not a session (docs/crons-agents.md §2.1.2):
    // sessions are ephemeral, the role is the durable identity. Carried here
    // as static data so the panel can decide whether to show its CRONS line —
    // a free-form-`role` team has no roleId and therefore no cadences.
    roleId: orch.roleId,
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
 * The dead `load` field is gone: the stat-bar cell it fed was an S10
 * placeholder that could only ever render `—`, and its own guard-rail file
 * asked for the label to change the day a real signal landed. That signal is
 * `contextUsage` (docs/monitoring-agents.md), so the cell is now `CTX` and
 * carries a measurement instead of a promise. Both context fields are
 * forwarded verbatim — including `null`/`undefined`, which the panel renders
 * as `—` rather than inventing a number.
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
    logLines,
    writer,
    provider: session.provider,
    contextUsage: session.contextUsage ?? null,
    contextResetPending: session.contextResetPending ?? false,
    exitCode: session.exitCode,
    stopReason: session.stopReason,
    lastError: session.lastError,
  };
}
