import { withModule } from '../../logger.js';
import type { Spawner } from '../spawner/index.js';
import type { TaskboardStore } from './store.js';

const log = withModule('taskboard.lifecycle');

/**
 * Session statuses that count as STILL ALIVE for the crash-resume orphan pass.
 * Everything else (`exited|killed|interrupted|failed`) means the assignee is
 * gone. Mirrors the `isActive` predicate used elsewhere (spawner counters).
 */
const LIVE_SESSION_STATUSES = new Set(['running', 'starting', 'waiting', 'paused']);

/**
 * Phase 3 crash-resume pass — run once at boot, AFTER `runAutoResume` has
 * rebuilt the live teams. For every live orchestrator, any open (non-closed)
 * card whose `assignee_session_id` is no longer a live session is flagged
 * ORPHANED (`store.markOrphaned`, which stamps `orphaned_at`, audits it, and
 * emits `taskboard.card_orphaned`). This is how a resurrected lead sees exactly
 * which in-flight work lost its worker to the restart.
 *
 * Wholly defensive: wrapped so a board hiccup can NEVER break the boot, and it
 * only ever reads live spawner state + calls the idempotent `markOrphaned`
 * (already orphaned / hidden / missing cards are skipped). Returns how many
 * cards it newly orphaned (for the boot log / tests).
 */
export function markOrphanedCardsAtBoot(
  spawner: Spawner,
  taskboard: TaskboardStore,
): { orphaned: number } {
  let orphaned = 0;
  try {
    for (const orch of spawner.list()) {
      try {
        const liveIds = new Set(
          orch
            .listSessions()
            .filter((s) => LIVE_SESSION_STATUSES.has(s.status))
            .map((s) => s.id),
        );
        for (const card of taskboard.listCards({ orchestratorId: orch.id })) {
          if (card.closedAt != null) continue; // finished work isn't orphaned
          if (card.orphanedAt != null) continue; // already flagged
          const assignee = card.assigneeSessionId;
          if (!assignee) continue; // unassigned cards have no ghost to flag
          if (liveIds.has(assignee)) continue; // assignee came back — fine
          if (taskboard.markOrphaned(card.id)) orphaned++;
        }
      } catch (err) {
        log.warn({
          event: 'taskboard.orphan_pass_orch_failed',
          orchId: orch.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.warn({
      event: 'taskboard.orphan_pass_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (orphaned > 0) {
    log.info({ event: 'taskboard.orphan_pass', orphaned });
  }
  return { orphaned };
}

export interface TaskboardJanitorHandle {
  stop(): void;
}

/**
 * Phase 3 TTL janitor — a periodic sweep that purges (soft-deletes) orphaned
 * cards whose `orphaned_at` is older than `ttlMs`. Recent orphans are kept so
 * the operator can still see (and manually delete) what a restart stranded;
 * stale ones are cleaned so the board doesn't accumulate ghosts forever.
 *
 * Patterned on `mailboxJanitor` / the backup scheduler: an unref'd interval,
 * every tick wrapped in try/catch so a bad sweep can't crash the 24/7 server.
 * Fires one sweep immediately (to catch orphans stranded by a PREVIOUS boot)
 * then every `intervalMs`. `ttlMs <= 0` or `intervalMs <= 0` disables it.
 */
export function startTaskboardJanitor(
  taskboard: TaskboardStore,
  opts: { ttlMs: number; intervalMs: number },
): TaskboardJanitorHandle {
  const { ttlMs, intervalMs } = opts;
  if (ttlMs <= 0 || intervalMs <= 0) {
    log.info({ event: 'taskboard.janitor_disabled', ttlMs, intervalMs });
    return { stop: () => undefined };
  }

  const sweep = (): void => {
    try {
      const cutoff = Date.now() - ttlMs;
      const purged = taskboard.purgeOrphanedBefore(cutoff);
      if (purged > 0) {
        log.info({ event: 'taskboard.janitor', purged, ttlMs });
      }
    } catch (err) {
      log.warn({
        event: 'taskboard.janitor_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  log.info({ event: 'taskboard.janitor_started', ttlMs, intervalMs });
  return {
    stop: () => clearInterval(timer),
  };
}
