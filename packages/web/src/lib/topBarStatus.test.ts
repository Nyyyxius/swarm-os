// Unit tests for the TopBar pill status derivation.

import { describe, it, expect } from 'vitest';
import {
  deriveTopBarPillStatus,
  pillDotClass,
  pillBarClass,
  derivePillBarPct,
  type PillStatus,
} from './topBarStatus';
import type { OrchestratorView, SessionView } from '../api/client';

function mkOrch(p: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1',
    name: 'team-x',
    role: 'BUILDER',
    roleId: null,
    status: 'running',
    leadSessionId: 's1',
    defaultModel: 'opus',
    defaultEffort: 'medium',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount: 0,
    health: 'ok',
    ...p,
  };
}

function mkSession(status: SessionView['status'], id = 's1'): SessionView {
  return {
    id,
    orchestratorId: 'o1',
    name: 'lead',
    role: 'ORCHESTRATOR',
    type: 'lead',
    cwd: '/tmp',
    model: 'opus',
    effort: 'medium',
    permissionMode: 'default',
    status,
    pid: 1,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/log',
    lastActivityAt: '2026-01-01T00:00:00Z',
  };
}

describe('deriveTopBarPillStatus', () => {
  it('OFFLINE when health === "stopped"', () => {
    expect(deriveTopBarPillStatus(mkOrch({ health: 'stopped' })))
      .toBe<PillStatus>('OFFLINE');
  });

  it('BAD when health === "bad"', () => {
    expect(deriveTopBarPillStatus(mkOrch({ health: 'bad' })))
      .toBe<PillStatus>('BAD');
  });

  it('WAITING when any session is waiting (overrides STARTING/DEGRADED/HEALTHY)', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'starting',
      health: 'warn',
      sessions: [mkSession('running', 'a'), mkSession('waiting', 'b')],
    }))).toBe<PillStatus>('WAITING');
  });

  it('STARTING when orch.status === "starting" and no waiting session', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'starting',
      sessions: [mkSession('starting')],
    }))).toBe<PillStatus>('STARTING');
  });

  it('DEGRADED when health === "warn" and no waiting session', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'running',
      health: 'warn',
      sessions: [mkSession('running')],
    }))).toBe<PillStatus>('DEGRADED');
  });

  it('HEALTHY when health === "ok" and no waiting session', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'running',
      health: 'ok',
      sessions: [mkSession('running')],
    }))).toBe<PillStatus>('HEALTHY');
  });

  it('OFFLINE takes priority over BAD if both possible', () => {
    // (impossible en réalité car health est exclusif, mais test défensif)
    expect(deriveTopBarPillStatus(mkOrch({ health: 'stopped' })))
      .toBe<PillStatus>('OFFLINE');
  });

  it('BAD takes priority over WAITING (failed team trumps waiting session)', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      health: 'bad',
      sessions: [mkSession('waiting')],
    }))).toBe<PillStatus>('BAD');
  });
});

describe('pillDotClass', () => {
  it('maps all 6 pill values to a CSS class', () => {
    expect(pillDotClass('HEALTHY')).toBe('ok');
    expect(pillDotClass('DEGRADED')).toBe('warn');
    expect(pillDotClass('WAITING')).toBe('waiting');
    expect(pillDotClass('STARTING')).toBe('starting');
    expect(pillDotClass('OFFLINE')).toBe('stopped');
    expect(pillDotClass('BAD')).toBe('bad');
  });
});

describe('pillBarClass', () => {
  it('maps STARTING to "ok" (green bar during boot)', () => {
    expect(pillBarClass('STARTING')).toBe('ok');
  });
  it('maps WAITING to "waiting" (pulsing orange)', () => {
    expect(pillBarClass('WAITING')).toBe('waiting');
  });
  it('maps OFFLINE/BAD/DEGRADED/HEALTHY correctly', () => {
    expect(pillBarClass('OFFLINE')).toBe('stopped');
    expect(pillBarClass('BAD')).toBe('bad');
    expect(pillBarClass('DEGRADED')).toBe('warn');
    expect(pillBarClass('HEALTHY')).toBe('ok');
  });
});

describe('derivePillBarPct', () => {
  it('returns 0 for OFFLINE/BAD', () => {
    expect(derivePillBarPct('OFFLINE')).toBe(0);
    expect(derivePillBarPct('BAD')).toBe(0);
  });
  it('returns 60 for DEGRADED', () => {
    expect(derivePillBarPct('DEGRADED')).toBe(60);
  });
  it('returns 85 for HEALTHY/WAITING/STARTING', () => {
    expect(derivePillBarPct('HEALTHY')).toBe(85);
    expect(derivePillBarPct('WAITING')).toBe(85);
    expect(derivePillBarPct('STARTING')).toBe(85);
  });
});
