// S3 — Status badge.
//
// The component is a thin wrapper around the `lib/sessionStatus` mapping.
// It accepts both `SessionStatus` and `OrchestratorStatus` (the two
// consumer sites — orch header & session list) and falls back gracefully
// for unknown strings (in case the server adds a status before the UI is
// rebuilt).

import {
  mapSessionStatusToVisual,
  mapOrchestratorStatusToVisual,
  enrichWithIdle,
  VISUAL_CLASSES,
  type SessionStatus,
  type OrchestratorStatus,
  type VisualDescriptor,
} from '../lib/sessionStatus';
import { useNow } from '../lib/useNow';

interface Props {
  status: string;
  /**
   * S6 — optional ISO timestamp of the session's last PTY output. When
   * provided AND `status === 'running'`, the badge downgrades to `IDLE`
   * (muted) once `now - lastActivityAt > 30 s`. Pass it for session
   * badges; leave undefined for orchestrator badges (no per-orch
   * activity timestamp).
   */
  lastActivityAt?: string;
}

const SESSION_STATUSES = new Set<SessionStatus>([
  'starting',
  'running',
  'paused',
  'waiting',
  'exited',
  'killed',
  'interrupted',
  'failed',
]);

const ORCH_STATUSES = new Set<OrchestratorStatus>([
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
]);

function describe(status: string, now: number, lastActivityAt?: string): VisualDescriptor {
  if (SESSION_STATUSES.has(status as SessionStatus)) {
    const sessionStatus = status as SessionStatus;
    // S6 — only session badges can become `idle`; the override is a no-op
    // when `lastActivityAt` is absent (orch badges) or when `status` is
    // not `running` (`enrichWithIdle` short-circuits).
    if (lastActivityAt !== undefined) {
      return enrichWithIdle({ status: sessionStatus, lastActivityAt }, now);
    }
    return mapSessionStatusToVisual(sessionStatus);
  }
  if (ORCH_STATUSES.has(status as OrchestratorStatus)) {
    return mapOrchestratorStatusToVisual(status as OrchestratorStatus);
  }
  return {
    visual: 'idle',
    label: status.toUpperCase(),
    pulse: false,
  };
}

export function StatusBadge({ status, lastActivityAt }: Props) {
  // `useNow` is invoked unconditionally to obey the Rules of Hooks; the
  // value is only consulted by `describe` when `lastActivityAt` was
  // actually supplied. Orch badges still pay the cost of a 5 s
  // re-render but the work done per render is trivial.
  const now = useNow();
  const descriptor = describe(status, now, lastActivityAt);
  const cls = VISUAL_CLASSES[descriptor.visual];
  const pulseCls = descriptor.pulse ? 'status-pulse' : '';
  return (
    <span
      className={`inline-block text-xs font-mono px-2 py-0.5 rounded border ${cls} ${pulseCls}`.trim()}
      title={descriptor.tooltip}
      data-visual={descriptor.visual}
      data-pulse={descriptor.pulse ? 'true' : undefined}
    >
      {descriptor.label}
    </span>
  );
}
