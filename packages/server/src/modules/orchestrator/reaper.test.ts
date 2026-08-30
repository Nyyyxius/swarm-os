import { describe, it, expect } from 'vitest';
import {
  reapDeadWorkersOnce,
  type ReapableOrchestrator,
  type ReapableSession,
  type DeadWorkerReapPolicy,
} from './reaper.js';
import type { SessionStatus } from './session.js';

/**
 * Unit tests for the dead-worker reaper LOGIC (no timer, no Spawner, no DB).
 * Truth table the reaper must honour:
 *   terminal worker · role ON  · age > delay  → HIDDEN
 *   terminal worker · role ON  · age < delay  → kept (not yet)
 *   terminal worker · role OFF                → kept (never)
 *   NON-terminal worker (any age)             → kept (never)
 *   LEAD (even terminal, aged, role ON)       → kept (never)
 *   terminal worker · no endedAt              → kept (can't measure)
 */

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const DELAY_MS = 600_000; // 10 min

/** Build a session; `agoMs` sets endedAt to NOW - agoMs (null → still running). */
function session(
  id: string,
  type: 'lead' | 'worker',
  status: SessionStatus,
  agoMs: number | null,
): ReapableSession {
  return {
    id,
    type,
    status,
    endedAt: agoMs == null ? null : new Date(NOW - agoMs).toISOString(),
  };
}

/**
 * Build a single-team fake plus a recorder of hidden ids. `policy` is what the
 * reaper resolves for this team's role; `null` = role opted out / unknown.
 */
function makeFixture(
  sessions: ReapableSession[],
  policy: DeadWorkerReapPolicy | null,
): { deps: Parameters<typeof reapDeadWorkersOnce>[0]; hidden: string[] } {
  const hidden: string[] = [];
  const orch: ReapableOrchestrator = {
    id: 'orch-1',
    roleId: policy ? 'role-1' : null,
    listSessions: () => sessions,
    hideSession: (id: string) => {
      // Mimic Orchestrator.hideSession: succeeds once, drops from the map.
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) return false;
      sessions.splice(idx, 1);
      hidden.push(id);
      return true;
    },
  };
  return {
    hidden,
    deps: {
      orchestrators: () => [orch],
      policyForRole: (roleId) => (roleId ? policy : null),
      now: () => NOW,
    },
  };
}

const ON: DeadWorkerReapPolicy = { autoRemoveDeadWorkers: true, autoRemoveDeadWorkersDelayMs: DELAY_MS };
const OFF: DeadWorkerReapPolicy = { autoRemoveDeadWorkers: false, autoRemoveDeadWorkersDelayMs: DELAY_MS };

describe('reapDeadWorkersOnce', () => {
  it('hides a terminal worker when the role is ON and age > delay', () => {
    for (const status of ['killed', 'exited', 'failed'] as SessionStatus[]) {
      const { deps, hidden } = makeFixture(
        [session('w1', 'worker', status, DELAY_MS + 60_000)],
        ON,
      );
      expect(reapDeadWorkersOnce(deps)).toBe(1);
      expect(hidden).toEqual(['w1']);
    }
  });

  it('keeps a terminal worker whose age is still below the delay', () => {
    const { deps, hidden } = makeFixture(
      [session('w1', 'worker', 'killed', DELAY_MS - 1_000)],
      ON,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(0);
    expect(hidden).toEqual([]);
  });

  it('never touches workers when the role opted out (OFF)', () => {
    const { deps, hidden } = makeFixture(
      [session('w1', 'worker', 'killed', DELAY_MS * 10)],
      OFF,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(0);
    expect(hidden).toEqual([]);
  });

  it('never touches a role with no policy (roleId null / unknown)', () => {
    const { deps, hidden } = makeFixture(
      [session('w1', 'worker', 'killed', DELAY_MS * 10)],
      null,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(0);
    expect(hidden).toEqual([]);
  });

  it('never touches non-terminal workers, however old', () => {
    for (const status of ['starting', 'running', 'paused', 'waiting', 'interrupted'] as SessionStatus[]) {
      const { deps, hidden } = makeFixture(
        [session('w1', 'worker', status, DELAY_MS * 100)],
        ON,
      );
      expect(reapDeadWorkersOnce(deps)).toBe(0);
      expect(hidden).toEqual([]);
    }
  });

  it('never touches a lead, even terminal + aged + role ON', () => {
    const { deps, hidden } = makeFixture(
      [session('lead-1', 'lead', 'exited', DELAY_MS * 10)],
      ON,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(0);
    expect(hidden).toEqual([]);
  });

  it('skips a terminal worker with no endedAt (age unmeasurable)', () => {
    const { deps, hidden } = makeFixture(
      [session('w1', 'worker', 'killed', null)],
      ON,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(0);
    expect(hidden).toEqual([]);
  });

  it('reaps only the eligible workers in a mixed team', () => {
    const { deps, hidden } = makeFixture(
      [
        session('lead-1', 'lead', 'running', null), // lead → never
        session('w-old', 'worker', 'killed', DELAY_MS + 5_000), // eligible
        session('w-young', 'worker', 'failed', 1_000), // too young
        session('w-live', 'worker', 'running', null), // non-terminal
        session('w-old2', 'worker', 'exited', DELAY_MS * 3), // eligible
      ],
      ON,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(2);
    expect(hidden.sort()).toEqual(['w-old', 'w-old2']);
  });

  it('honours the exact boundary (age === delay is old enough)', () => {
    const { deps, hidden } = makeFixture(
      [session('w1', 'worker', 'killed', DELAY_MS)],
      ON,
    );
    expect(reapDeadWorkersOnce(deps)).toBe(1);
    expect(hidden).toEqual(['w1']);
  });
});
