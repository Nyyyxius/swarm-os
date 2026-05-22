// S3 — Session lifecycle visual mapping.
//
// The server exposes a rich `SessionStatus` union (8 values including
// `paused` added in S5). The UI groups them into 5 visual buckets so that
// operationally-important states (`waiting`, `failed`) stand out without
// inventing one colour per backend value.
//
// The exhaustive `switch` (no `default`) is intentional: when a new variant
// is added to `SessionStatus` upstream, TypeScript breaks the build here —
// surfacing the missing mapping immediately rather than silently bucketing
// it into "unknown".

import type { SessionView, OrchestratorView } from '../api/client';

/**
 * Visual bucket used by the UI to colour status indicators. Stable across
 * the app — the design system (badges, map dots, rings, chips) only needs
 * to handle these five values.
 */
export type VisualStatus = 'idle' | 'running' | 'warn' | 'bad' | 'stopped';

export type SessionStatus = SessionView['status'];
export type OrchestratorStatus = OrchestratorView['status'];

export interface VisualDescriptor {
  /** Visual bucket — drives colour. */
  visual: VisualStatus;
  /** Short uppercase label shown inside the badge. */
  label: string;
  /** Whether the badge should pulse to grab attention (waiting only today). */
  pulse: boolean;
  /** Optional hover tooltip — used to disambiguate stopped sub-states. */
  tooltip?: string;
}

/**
 * Map a backend `SessionStatus` to a visual descriptor. Exhaustive switch:
 * adding a new variant to `SessionStatus` (e.g. `paused` from S5, or a
 * future one) MUST extend this function — TS will complain otherwise.
 */
export function mapSessionStatusToVisual(status: SessionStatus): VisualDescriptor {
  switch (status) {
    case 'starting':
      return { visual: 'idle', label: 'STARTING', pulse: false };
    case 'running':
      return { visual: 'running', label: 'RUNNING', pulse: false };
    case 'waiting':
      return {
        visual: 'warn',
        label: 'WAITING',
        pulse: true,
        tooltip: 'Attente input humain',
      };
    case 'paused':
      return {
        visual: 'warn',
        label: 'PAUSED',
        pulse: false,
        tooltip: 'Session pausée (SIGSTOP)',
      };
    case 'exited':
      return {
        visual: 'stopped',
        label: 'EXITED',
        pulse: false,
        tooltip: 'Process terminé normalement',
      };
    case 'killed':
      return {
        visual: 'stopped',
        label: 'KILLED',
        pulse: false,
        tooltip: 'Killed by operator',
      };
    case 'interrupted':
      return {
        visual: 'stopped',
        label: 'INTERRUPTED',
        pulse: false,
        tooltip: 'Server restart',
      };
    case 'failed':
      return {
        visual: 'bad',
        label: 'FAILED',
        pulse: false,
        tooltip: 'Erreur process',
      };
  }
  // Unreachable when SessionStatus is fully covered — guarded by the
  // `never` cast so future additions break the build.
  const _exhaustive: never = status;
  return _exhaustive;
}

/**
 * Map a backend `OrchestratorStatus` to the same visual buckets. Shares
 * colours with the session mapping so badges look consistent across the
 * orch header and the session list.
 */
export function mapOrchestratorStatusToVisual(
  status: OrchestratorStatus,
): VisualDescriptor {
  switch (status) {
    case 'starting':
      return { visual: 'idle', label: 'STARTING', pulse: false };
    case 'running':
      return { visual: 'running', label: 'RUNNING', pulse: false };
    case 'stopping':
      return { visual: 'idle', label: 'STOPPING', pulse: false };
    case 'stopped':
      return { visual: 'stopped', label: 'STOPPED', pulse: false };
    case 'failed':
      return {
        visual: 'bad',
        label: 'FAILED',
        pulse: false,
        tooltip: 'Erreur orchestrator',
      };
  }
  const _exhaustive: never = status;
  return _exhaustive;
}

/**
 * Tailwind class strings per visual bucket. Kept here (not in the badge)
 * so other components (map dots, rings, chips) can import the same source
 * of truth.
 */
export const VISUAL_CLASSES: Record<VisualStatus, string> = {
  idle: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  running: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  warn: 'bg-amber-500/20 text-amber-200 border-amber-500/50',
  bad: 'bg-red-500/20 text-red-300 border-red-500/50',
  stopped: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
};

// ---------------------------------------------------------------------------
// S6 — derived `idle` visual.
//
// `idle` is NOT a backend status: the server's `SessionStatus` enum has no
// such value (see `packages/server/src/modules/orchestrator/session.ts`).
// It's a purely visual override applied client-side when a session is
// nominally `running` but its PTY has produced nothing for a while —
// useful UX signal ("alive but silent") without changing the wire format,
// the DB schema, or any other consumer (notify/Discord, /metrics, …).
//
// Rule: only `running` is ever downgraded to `idle`. Other states
// (`waiting`, `paused`, `failed`, `starting`, `exited`, …) pass through
// untouched — they carry meaning of their own that idle would obscure.
// ---------------------------------------------------------------------------

/**
 * Default age, in milliseconds, after which a silent `running` session is
 * shown as `idle`. Chosen at 30 s: short enough to feel responsive when an
 * agent truly stops producing output, long enough to absorb the natural
 * blanks between tool calls (5-20 s during a build, a slow bash, etc.).
 */
export const IDLE_VISUAL_THRESHOLD_MS = 30_000;

/**
 * Derive a `VisualDescriptor` from a session, optionally downgrading
 * `running` to `idle` when the session has been silent for longer than
 * `thresholdMs`.
 *
 * - `status !== 'running'` → returns the canonical mapping untouched.
 *   Idle never shadows `waiting` (human input expected), `paused`
 *   (operator pause, S5), `failed`, or any terminal state.
 * - Unparsable `lastActivityAt` (missing field, garbage string, future
 *   timestamp) is treated as "fresh" and the session stays `running` —
 *   we'd rather miss an idle bucket than mis-render a healthy agent as
 *   silent.
 */
export function enrichWithIdle(
  view: Pick<SessionView, 'status' | 'lastActivityAt'>,
  now: number,
  thresholdMs: number = IDLE_VISUAL_THRESHOLD_MS,
): VisualDescriptor {
  const base = mapSessionStatusToVisual(view.status);
  if (view.status !== 'running') return base;
  const ts = Date.parse(view.lastActivityAt);
  if (!Number.isFinite(ts)) return base;
  const age = now - ts;
  // Strict `>` matches the spec ("silent for *longer than* threshold").
  // Future timestamps (`age < 0`, clock skew) naturally fall through to
  // `base` here.
  if (!Number.isFinite(age) || age <= thresholdMs) return base;
  const ageSec = Math.max(0, Math.floor(age / 1000));
  return {
    visual: 'idle',
    label: 'IDLE',
    pulse: false,
    tooltip: `No PTY output for ${ageSec} s`,
  };
}
