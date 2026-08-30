/**
 * Dead-worker session reaper.
 *
 * A killed / exited / failed worker stays in the orchestrator's in-memory
 * session map (and in the DB with `hidden_at = NULL`) until something calls
 * `hideSession` — the web "REMOVE" button being the only trigger today. Left
 * alone they pile up in the visual forever. This reaper is a periodic janitor
 * (patterned on modules/taskboard/lifecycle) that, PER ROLE (the toggle lives
 * on the role), soft-deletes terminal workers once they have been terminal for
 * longer than the role's configured delay.
 *
 * Hard invariants:
 *   - only WORKERS are ever touched (never a lead);
 *   - only TERMINAL statuses `killed | exited | failed` are eligible (a
 *     server-restart `interrupted` is deliberately NOT reaped, matching the
 *     feature spec's terminal set);
 *   - a role that did not opt in (`autoRemoveDeadWorkers = false`, the default)
 *     is never swept;
 *   - every orchestrator / session is wrapped so one bad row can't stop the
 *     timer or skip the rest of the sweep.
 *
 * "Terminal age" is measured from `Session.endedAt`, which `_handleExit` /
 * `stop()` set to `now()` at the exact terminal transition and which is
 * persisted (`sessions.ended_at`) — so no new timestamp field is needed.
 */

import { withModule } from '../../logger.js';
import type { Spawner } from '../spawner/index.js';
import type { RoleStore } from '../roles/index.js';
import type { SessionStatus } from './session.js';

const log = withModule('orchestrator.reaper');

/**
 * Statuses that make a worker eligible for reaping. Intentionally EXCLUDES
 * `interrupted` (server-restart) — the spec's terminal set for this feature is
 * exactly killed/exited/failed.
 */
const TERMINAL_WORKER_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'killed',
  'exited',
  'failed',
]);

/** The minimal session shape the reaper reads. `Session` satisfies it. */
export interface ReapableSession {
  id: string;
  type: 'lead' | 'worker';
  status: SessionStatus;
  /** ISO timestamp of the terminal transition (null while still running). */
  endedAt: string | null;
}

/** The minimal orchestrator shape the reaper reads. `Orchestrator` satisfies it. */
export interface ReapableOrchestrator {
  id: string;
  roleId: string | null;
  listSessions(): ReapableSession[];
  /** Soft-delete a session (drops it from the map + mailbox + flips hidden_at). */
  hideSession(id: string): boolean;
}

/** The two role fields the reaper consults. `Role` satisfies it. */
export interface DeadWorkerReapPolicy {
  autoRemoveDeadWorkers: boolean;
  autoRemoveDeadWorkersDelayMs: number;
}

export interface ReapDeps {
  /** Live orchestrators to sweep. */
  orchestrators: () => Iterable<ReapableOrchestrator>;
  /** Resolve a role id to its reap policy (null = no role / unknown role). */
  policyForRole: (roleId: string | null) => DeadWorkerReapPolicy | null;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run one reap pass. Pure with respect to the injected deps (the only side
 * effect is `hideSession`). Returns the number of workers hidden this pass.
 *
 * Exported for the unit test — the logic (terminal + opted-in + age>delay →
 * hide; else skip) lives here so it can be exercised without a real timer,
 * Spawner, or DB.
 */
export function reapDeadWorkersOnce(deps: ReapDeps): number {
  const now = deps.now ? deps.now() : Date.now();
  let removed = 0;
  for (const orch of deps.orchestrators()) {
    try {
      const policy = deps.policyForRole(orch.roleId);
      // Role opted out (or has no role) → this whole team is off-limits.
      if (!policy || !policy.autoRemoveDeadWorkers) continue;
      const delayMs = policy.autoRemoveDeadWorkersDelayMs;
      for (const session of orch.listSessions()) {
        try {
          if (session.type !== 'worker') continue; // never a lead
          if (!TERMINAL_WORKER_STATUSES.has(session.status)) continue; // non-terminal
          if (!session.endedAt) continue; // can't measure age without a terminal ts
          const terminalAt = Date.parse(session.endedAt);
          if (!Number.isFinite(terminalAt)) continue; // unparseable ts — leave it
          if (now - terminalAt < delayMs) continue; // not old enough yet
          if (orch.hideSession(session.id)) removed++;
        } catch (err) {
          log.warn({
            event: 'session_reaper.session_failed',
            orchId: orch.id,
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn({
        event: 'session_reaper.orch_failed',
        orchId: orch.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (removed > 0) {
    log.info({ event: 'session_reaper.swept', removed });
  }
  return removed;
}

export interface SessionReaperHandle {
  stop(): void;
}

/**
 * Start the periodic reaper. Unref'd interval, every tick guarded — a bad sweep
 * can never crash the 24/7 loop. `intervalMs <= 0` disables it (returns a no-op
 * handle). Mirrors `startTaskboardJanitor`.
 */
export function startSessionReaper(
  spawner: Spawner,
  roleStore: RoleStore,
  opts: { intervalMs: number },
): SessionReaperHandle {
  const { intervalMs } = opts;
  if (intervalMs <= 0) {
    log.info({ event: 'session_reaper.disabled', intervalMs });
    return { stop: () => undefined };
  }

  const deps: ReapDeps = {
    orchestrators: () => spawner.list(),
    policyForRole: (roleId) => {
      if (!roleId) return null;
      const role = roleStore.get(roleId);
      if (!role) return null;
      return {
        autoRemoveDeadWorkers: role.autoRemoveDeadWorkers,
        autoRemoveDeadWorkersDelayMs: role.autoRemoveDeadWorkersDelayMs,
      };
    },
  };

  const tick = (): void => {
    try {
      reapDeadWorkersOnce(deps);
    } catch (err) {
      log.warn({
        event: 'session_reaper.tick_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log.info({ event: 'session_reaper.started', intervalMs });
  return { stop: () => clearInterval(timer) };
}
