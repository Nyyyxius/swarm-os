// Step 6 (Phase B.6) — unit tests for `toMapViewTeams`.

import { describe, it, expect } from 'vitest';
import { toMapViewTeams, toNodeAgent } from './mapTeams';
import type { OrchestratorView, SessionView } from '../../api/client';

const TAU = Math.PI * 2;

function sess(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    orchestratorId: 'o1',
    name: 'SCOUT-01',
    role: 'RESEARCHER',
    type: 'lead',
    cwd: '/tmp',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    status: 'running',
    pid: 123,
    startedAt: '2026-05-22T10:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/var/log',
    lastActivityAt: '2026-05-22T10:00:00.000Z',
    ...over,
  };
}

function orch(over: Partial<OrchestratorView> = {}): OrchestratorView {
  const lead = sess({ id: 'lead-1', type: 'lead', role: 'ORCHESTRATOR' });
  return {
    id: 'o1',
    name: 'ATLAS',
    role: 'ORCHESTRATOR',
    roleId: null,
    status: 'running',
    leadSessionId: lead.id,
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-05-22T09:00:00.000Z',
    endedAt: null,
    lastError: null,
    sessions: [lead],
    msgCount: 0,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
    ...over,
  };
}

describe('toMapViewTeams', () => {
  it('returns [] when input is empty', () => {
    expect(toMapViewTeams([], 0, new Map())).toEqual([]);
  });

  it('skips orchestrators without a leadSessionId', () => {
    const o = orch({ leadSessionId: null });
    expect(toMapViewTeams([o], 0, new Map())).toEqual([]);
  });

  it('skips ended orchestrators (history rows)', () => {
    const o = orch({ endedAt: '2026-05-22T11:00:00.000Z' });
    expect(toMapViewTeams([o], 0, new Map())).toEqual([]);
  });

  it('skips orchestrators with empty sessions array', () => {
    const o = orch({ sessions: [] });
    expect(toMapViewTeams([o], 0, new Map())).toEqual([]);
  });

  it('skips orchestrators where leadSessionId is not in sessions', () => {
    // Pathological case: leadSessionId set but the corresponding session
    // hasn't surfaced yet (transient between create + first list snapshot).
    const wk = sess({ id: 'wk-1', type: 'worker' });
    const o = orch({ leadSessionId: 'ghost', sessions: [wk] });
    expect(toMapViewTeams([o], 0, new Map())).toEqual([]);
  });

  it('computes the correct angle for N=1 (top, -π/2)', () => {
    const o = orch();
    const teams = toMapViewTeams([o], 0, new Map());
    expect(teams).toHaveLength(1);
    expect(teams[0]?.angle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('computes 4 angles equally spaced for N=4', () => {
    const teams = toMapViewTeams(
      [
        orch({ id: 'a', leadSessionId: 'la', sessions: [sess({ id: 'la' })] }),
        orch({ id: 'b', leadSessionId: 'lb', sessions: [sess({ id: 'lb' })] }),
        orch({ id: 'c', leadSessionId: 'lc', sessions: [sess({ id: 'lc' })] }),
        orch({ id: 'd', leadSessionId: 'ld', sessions: [sess({ id: 'ld' })] }),
      ],
      0,
      new Map(),
    );
    expect(teams).toHaveLength(4);
    expect(teams[0]?.angle).toBeCloseTo(-Math.PI / 2, 6);
    expect(teams[1]?.angle).toBeCloseTo(-Math.PI / 2 + TAU / 4, 6);
    expect(teams[2]?.angle).toBeCloseTo(-Math.PI / 2 + TAU / 2, 6);
    expect(teams[3]?.angle).toBeCloseTo(-Math.PI / 2 + 3 * TAU / 4, 6);
  });

  it('maps role → shape (diamond for ORCHESTRATOR, triangle for BUILDER)', () => {
    const lead = sess({ id: 'l1', type: 'lead', role: 'ORCHESTRATOR' });
    const worker = sess({ id: 'w1', type: 'worker', role: 'BUILDER' });
    const o = orch({ leadSessionId: lead.id, sessions: [lead, worker] });
    const teams = toMapViewTeams([o], 0, new Map());
    expect(teams[0]?.lead.shape).toBe('diamond');
    expect(teams[0]?.workers[0]?.shape).toBe('triangle');
  });

  it('falls back to circle for unknown roles', () => {
    const lead = sess({ id: 'l1', type: 'lead', role: 'HUNTER' });
    const o = orch({ leadSessionId: lead.id, sessions: [lead] });
    const teams = toMapViewTeams([o], 0, new Map());
    expect(teams[0]?.lead.shape).toBe('circle');
  });

  it('partitions workers by type=worker (lead is always pulled from leadSessionId)', () => {
    const lead = sess({ id: 'l1', type: 'lead' });
    const w1 = sess({ id: 'w1', type: 'worker', role: 'BUILDER' });
    const w2 = sess({ id: 'w2', type: 'worker', role: 'ANALYST' });
    const o = orch({ leadSessionId: lead.id, sessions: [lead, w1, w2] });
    const teams = toMapViewTeams([o], 0, new Map());
    expect(teams[0]?.workers.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(teams[0]?.lead.id).toBe('l1');
  });

  it('injects inbox counts from the map (missing → 0)', () => {
    const lead = sess({ id: 'l1', type: 'lead' });
    const w1 = sess({ id: 'w1', type: 'worker' });
    const o = orch({ leadSessionId: lead.id, sessions: [lead, w1] });
    const counts = new Map<string, number>([['l1', 3]]);
    const teams = toMapViewTeams([o], 0, counts);
    expect(teams[0]?.lead.inbox).toBe(3);
    expect(teams[0]?.workers[0]?.inbox).toBe(0);
  });

  it('downgrades running → idle after 30 s of silence (enrichWithIdle)', () => {
    const lastActivityAt = '2026-05-22T10:00:00.000Z';
    const lead = sess({ id: 'l1', type: 'lead', status: 'running', lastActivityAt });
    const o = orch({ leadSessionId: lead.id, sessions: [lead] });
    const before = new Date(lastActivityAt).getTime() + 10_000; // 10 s
    const after = new Date(lastActivityAt).getTime() + 35_000;  // 35 s
    expect(toMapViewTeams([o], before, new Map())[0]?.lead.status).toBe('running');
    expect(toMapViewTeams([o], after, new Map())[0]?.lead.status).toBe('idle');
  });

  it('does NOT downgrade non-running statuses to idle (waiting stays waiting)', () => {
    const lastActivityAt = '2026-05-22T10:00:00.000Z';
    const lead = sess({ id: 'l1', type: 'lead', status: 'waiting', lastActivityAt });
    const o = orch({ leadSessionId: lead.id, sessions: [lead] });
    const t = new Date(lastActivityAt).getTime() + 60_000;
    expect(toMapViewTeams([o], t, new Map())[0]?.lead.status).toBe('waiting');
  });

  it('passes through team status from the orchestrator', () => {
    const o = orch({ status: 'failed' });
    const teams = toMapViewTeams([o], 0, new Map());
    expect(teams[0]?.status).toBe('failed');
  });
});

describe('toNodeAgent', () => {
  it('produces a NodeAgent with the expected primitives', () => {
    const s = sess({ id: 'x', name: 'FOO', role: 'MEMORY', status: 'running' });
    const n = toNodeAgent(s, 0, 7);
    expect(n).toEqual({
      id: 'x',
      name: 'FOO',
      role: 'MEMORY',
      shape: 'dot',
      status: 'running',
      inbox: 7,
    });
  });
});
