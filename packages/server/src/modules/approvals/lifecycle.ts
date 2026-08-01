import { withModule } from '../../logger.js';
import type { ApprovalStore } from './store.js';

const log = withModule('approvals.lifecycle');

export interface ApprovalJanitorHandle {
  stop(): void;
}

/**
 * Approval-gate TTL janitor (docs/garde-fous-approbation.md, P5) — a periodic
 * sweep that flags every still-`pending` approval older than `ttlMs` as
 * `expired` (`store.expireOlderThan`). This is STRICTLY a cleanup flag so the
 * pending queue does not accumulate ghosts forever after a session dies without
 * anyone answering its prompt.
 *
 * Crucially this is NEVER an auto-decision: the timeout policy is "leave
 * pending" (docs §9.3), so an `expired` approval is not `denied` and no PTY
 * keystroke is ever replayed. The store owns the flip + its `expired` journal
 * entry + `approval.resolved` event atomically; the janitor only schedules it.
 *
 * Patterned on `startTaskboardJanitor` / the backup scheduler: an unref'd
 * interval, every tick wrapped in try/catch so a bad sweep can never crash the
 * 24/7 server. Fires one sweep immediately (to catch requests stranded by a
 * PREVIOUS boot) then every `intervalMs`. `ttlMs <= 0` or `intervalMs <= 0`
 * disables it.
 */
export function startApprovalJanitor(
  store: ApprovalStore,
  opts: { ttlMs: number; intervalMs: number },
): ApprovalJanitorHandle {
  const { ttlMs, intervalMs } = opts;
  if (ttlMs <= 0 || intervalMs <= 0) {
    log.info({ event: 'approvals.janitor_disabled', ttlMs, intervalMs });
    return { stop: () => undefined };
  }

  const sweep = (): void => {
    try {
      const expired = store.expireOlderThan(ttlMs);
      if (expired > 0) {
        log.info({ event: 'approvals.janitor', expired, ttlMs });
      }
    } catch (err) {
      // `expireOlderThan` is already non-throwing, but the 24/7 loop must
      // survive anything the sweep might do.
      log.warn({
        event: 'approvals.janitor_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  log.info({ event: 'approvals.janitor_started', ttlMs, intervalMs });
  return {
    stop: () => clearInterval(timer),
  };
}
