import { describe, it, expect } from 'vitest';
import { computeOrchestratorHealth, type HealthInput } from './health.js';
import type { SessionView, SessionStatus, SessionType } from './session.js';
import type { OrchestratorStatus } from './index.js';

/**
 * S7 — table-driven tests for the pure `computeOrchestratorHealth`
 * function. Each case is an explicit `HealthInput` literal and the
 * expected verdict.
 *
 * Covers the 14 cases listed in `docs/update_system/07_health_agrege.md`
 * §5 plus a couple of priority / edge cases (lead-failed wins over
 * lastError; orch-failed wins over lead-running; lead-disappeared while
 * running).
 */

let counter = 0;
function makeSession(opts: {
  type: SessionType;
  status: SessionStatus;
  id?: string;
}): SessionView {
  const id = opts.id ?? `s-${++counter}`;
  return {
    id,
    orchestratorId: 'orch-1',
    name: id,
    role: 'role',
    type: opts.type,
    cwd: '/tmp',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    status: opts.status,
    pid: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/tmp/log',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  };
}

function input(opts: {
  status: OrchestratorStatus;
  lead?: SessionView | null;
  workers?: SessionView[];
  lastError?: string | null;
}): HealthInput {
  const lead = opts.lead ?? null;
  const workers = opts.workers ?? [];
  const sessions: SessionView[] = lead ? [lead, ...workers] : [...workers];
  return {
    status: opts.status,
    leadSessionId: lead?.id ?? null,
    lastError: opts.lastError ?? null,
    sessions,
  };
}

describe('computeOrchestratorHealth', () => {
  it('case 1 — running team, all sessions running → ok', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'running' });
    const w2 = makeSession({ type: 'worker', status: 'running' });
    expect(
      computeOrchestratorHealth(input({ status: 'running', lead, workers: [w1, w2] })),
    ).toBe('ok');
  });

  it('case 2 — running team with lastError → warn', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    expect(
      computeOrchestratorHealth(
        input({ status: 'running', lead, lastError: 'spawn failed' }),
      ),
    ).toBe('warn');
  });

  it('case 3 — running team with ≥1 worker failed → warn', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'running' });
    const w2 = makeSession({ type: 'worker', status: 'failed' });
    expect(
      computeOrchestratorHealth(input({ status: 'running', lead, workers: [w1, w2] })),
    ).toBe('warn');
  });

  it('case 4 — lead waiting → warn', () => {
    const lead = makeSession({ type: 'lead', status: 'waiting' });
    expect(computeOrchestratorHealth(input({ status: 'running', lead }))).toBe('warn');
  });

  it('case 5 — lead failed → bad', () => {
    const lead = makeSession({ type: 'lead', status: 'failed' });
    expect(computeOrchestratorHealth(input({ status: 'running', lead }))).toBe('bad');
  });

  it('case 6 — orch stopped → stopped (even with workers still in the list)', () => {
    const lead = makeSession({ type: 'lead', status: 'killed' });
    const w1 = makeSession({ type: 'worker', status: 'failed' });
    expect(
      computeOrchestratorHealth(input({ status: 'stopped', lead, workers: [w1] })),
    ).toBe('stopped');
  });

  it('case 7 — orch failed → bad (overrides lead status)', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    expect(computeOrchestratorHealth(input({ status: 'failed', lead }))).toBe('bad');
  });

  it('case 8 — orch stopping → stopped (teardown in progress)', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    expect(computeOrchestratorHealth(input({ status: 'stopping', lead }))).toBe(
      'stopped',
    );
  });

  it('case 9 — starting, no lead resolved yet → ok (transient window)', () => {
    expect(
      computeOrchestratorHealth({
        status: 'starting',
        leadSessionId: null,
        lastError: null,
        sessions: [],
      }),
    ).toBe('ok');
  });

  it('case 10 — worker waiting does NOT escalate (lead running) → ok', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'waiting' });
    expect(
      computeOrchestratorHealth(input({ status: 'running', lead, workers: [w1] })),
    ).toBe('ok');
  });

  it('case 11 — workers exited / killed / interrupted do NOT escalate → ok', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'exited' });
    const w2 = makeSession({ type: 'worker', status: 'killed' });
    const w3 = makeSession({ type: 'worker', status: 'interrupted' });
    expect(
      computeOrchestratorHealth(
        input({ status: 'running', lead, workers: [w1, w2, w3] }),
      ),
    ).toBe('ok');
  });

  it('case 12 — worker starting (lead running) → ok', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'starting' });
    expect(
      computeOrchestratorHealth(input({ status: 'running', lead, workers: [w1] })),
    ).toBe('ok');
  });

  it('case 13 — lastError + worker failed simultaneously → warn (idempotent)', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'failed' });
    expect(
      computeOrchestratorHealth(
        input({
          status: 'running',
          lead,
          workers: [w1],
          lastError: 'spawn failed',
        }),
      ),
    ).toBe('warn');
  });

  it('case 14 — lead failed + lastError → bad (lead wins over warn)', () => {
    const lead = makeSession({ type: 'lead', status: 'failed' });
    expect(
      computeOrchestratorHealth(
        input({ status: 'running', lead, lastError: 'spawn failed' }),
      ),
    ).toBe('bad');
  });

  it('paused worker (post-S5) does NOT escalate → ok', () => {
    const lead = makeSession({ type: 'lead', status: 'running' });
    const w1 = makeSession({ type: 'worker', status: 'paused' });
    expect(
      computeOrchestratorHealth(input({ status: 'running', lead, workers: [w1] })),
    ).toBe('ok');
  });

  it('paused lead (post-S5) is not waiting/failed → ok', () => {
    const lead = makeSession({ type: 'lead', status: 'paused' });
    expect(computeOrchestratorHealth(input({ status: 'running', lead }))).toBe('ok');
  });
});
