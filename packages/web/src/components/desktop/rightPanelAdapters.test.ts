// packages/web/src/components/desktop/rightPanelAdapters.test.ts
//
// Step 7 — Pure-adapter coverage for `rightPanelAdapters.ts`. We test
// the two derivations the RightPanel consumes:
//   1. `buildRightPanelTeam` — with/without a role, with/without Discord.
//   2. `buildRightPanelAgent` — `load` always undefined (S10 guard-rail),
//      `writer` undefined fall-through, terminal-state fields propagated.

import { describe, expect, it } from 'vitest';
import {
  buildRightPanelTeam,
  buildRightPanelAgent,
} from './rightPanelAdapters';
import type {
  OrchestratorView,
  RoleView,
  SessionView,
} from '../../api/client';

const baseSession: SessionView = {
  id: 'sess_abc12345',
  orchestratorId: 'orch-1',
  name: 'lead-1',
  role: 'PLANNER',
  type: 'lead',
  cwd: '/work/atlas',
  model: 'claude-opus-4-7',
  effort: 'high',
  permissionMode: 'default',
  status: 'running',
  pid: 4242,
  startedAt: '2026-05-22T10:00:00Z',
  endedAt: null,
  exitCode: null,
  lastError: null,
  stopReason: null,
  logPath: '/var/log/sess.log',
  lastActivityAt: '2026-05-22T10:05:00Z',
};

const baseOrch: OrchestratorView = {
  id: 'orch-1',
  name: 'ATLAS',
  role: 'PLANNER',
  roleId: 'role-abc',
  status: 'running',
  leadSessionId: 'sess_abc12345',
  defaultModel: 'claude-opus-4-7',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  leadPreamble: 'be careful',
  workerPreamble: 'follow the lead',
  createdAt: '2026-05-22T10:00:00Z',
  endedAt: null,
  lastError: null,
  sessions: [baseSession],
  msgCount: 0,
  stopReason: null,
  health: 'ok',
};

const baseRole: RoleView = {
  id: 'role-abc',
  label: 'PLANNER',
  leadPrompt: 'You are the planner.',
  leadPreamble: null,
  workerPreamble: null,
  workerCount: null,
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  connectors: [],
  createdAt: '2026-05-22T10:00:00Z',
  updatedAt: '2026-05-22T10:00:00Z',
};

describe('buildRightPanelTeam', () => {
  it('builds the basic shape from an orch + role + leadCwd', () => {
    const t = buildRightPanelTeam(baseOrch, baseRole, '/work/atlas');
    expect(t.id).toBe('orch-1');
    expect(t.name).toBe('ATLAS');
    expect(t.leadId).toBe('sess_abc12345');
    expect(t.model).toBe('claude-opus-4-7');
    expect(t.effort).toBe('high');
    expect(t.permissionMode).toBe('default');
    expect(t.cwd).toBe('/work/atlas');
    expect(t.leadPrompt).toBe('You are the planner.');
    expect(t.leadPreamble).toBe('be careful');
    expect(t.workerPreamble).toBe('follow the lead');
    expect(t.discordWebhook).toBeNull();
  });

  it('counts only workers (lead is excluded from workerCount)', () => {
    const orch: OrchestratorView = {
      ...baseOrch,
      sessions: [
        baseSession,
        { ...baseSession, id: 'w1', type: 'worker' },
        { ...baseSession, id: 'w2', type: 'worker' },
      ],
    };
    const t = buildRightPanelTeam(orch, baseRole, '/work/atlas');
    expect(t.workerCount).toBe(2);
  });

  it('handles a null role: leadPrompt and discordWebhook fall back to null', () => {
    const t = buildRightPanelTeam(baseOrch, null, '/work/atlas');
    expect(t.leadPrompt).toBeNull();
    expect(t.discordWebhook).toBeNull();
    // Orch-level preambles are unaffected.
    expect(t.leadPreamble).toBe('be careful');
    expect(t.workerPreamble).toBe('follow the lead');
  });

  it('picks the first Discord webhook from role.connectors', () => {
    const role: RoleView = {
      ...baseRole,
      connectors: [
        { type: 'discord', webhookUrl: 'https://discord.example/hook-1' },
      ],
    };
    const t = buildRightPanelTeam(baseOrch, role, '/work/atlas');
    expect(t.discordWebhook).toBe('https://discord.example/hook-1');
  });

  it('coerces a null leadSessionId to an empty string (transient post-create)', () => {
    const orch: OrchestratorView = { ...baseOrch, leadSessionId: null };
    const t = buildRightPanelTeam(orch, baseRole, '/work/atlas');
    expect(t.leadId).toBe('');
  });
});

describe('buildRightPanelAgent', () => {
  it('builds the basic shape with load undefined (S10 guard-rail)', () => {
    const a = buildRightPanelAgent(baseSession, 0, undefined);
    expect(a.id).toBe('sess_abc12345');
    expect(a.name).toBe('lead-1');
    expect(a.role).toBe('PLANNER');
    expect(a.status).toBe('running');
    expect(a.pid).toBe(4242);
    expect(a.load).toBeUndefined();
    expect(a.logLines).toBe(0);
    expect(a.writer).toBeUndefined();
  });

  it('propagates the logLines counter and writer flag', () => {
    const a = buildRightPanelAgent(baseSession, 1234, true);
    expect(a.logLines).toBe(1234);
    expect(a.writer).toBe(true);
  });

  it('forwards terminal-state fields (exitCode, stopReason, lastError) for CONFIG tab', () => {
    const s: SessionView = {
      ...baseSession,
      status: 'failed',
      exitCode: 137,
      stopReason: 'interrupted',
      lastError: 'pty crashed',
    };
    const a = buildRightPanelAgent(s, 50, false);
    expect(a.status).toBe('failed');
    expect(a.exitCode).toBe(137);
    expect(a.stopReason).toBe('interrupted');
    expect(a.lastError).toBe('pty crashed');
  });
});
