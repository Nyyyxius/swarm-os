// packages/web/src/lib/leftPanelAdapters.test.ts
//
// Pure-adapter coverage for `lib/leftPanelAdapters.ts`. Hooks
// (`useServerMessagesMetrics`, `useMessageFlow`) are covered indirectly
// by `components/desktop/LeftPanel.test.tsx`.

import { describe, expect, it } from 'vitest';
import {
  deriveTag,
  derivePurpose,
  filterActive,
  filterEnded,
  toLeftPanelEnded,
  toLeftPanelTeam,
  sparkColor,
  ENDED_DISPLAY_CAP,
} from './leftPanelAdapters';
import type { OrchestratorView } from '../api/client';

const baseOrch: OrchestratorView = {
  id: 'orch-1',
  name: 'TEAM-A',
  role: 'RESEARCHER',
  roleId: null,
  status: 'running',
  leadSessionId: 'sess-lead-1',
  defaultModel: 'claude-opus-4-7',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  leadPreamble: null,
  workerPreamble: null,
  createdAt: '2026-05-22T10:00:00Z',
  endedAt: null,
  lastError: null,
  sessions: [],
  msgCount: 42,
  stopReason: null,
  health: 'ok',
};

describe('deriveTag', () => {
  it('returns ONLINE for healthy running orchestrator', () => {
    expect(deriveTag(baseOrch)).toBe('ONLINE');
  });
  it('returns STARTING when status=starting', () => {
    expect(deriveTag({ ...baseOrch, status: 'starting' })).toBe('STARTING');
  });
  it('returns OFFLINE when health=stopped', () => {
    expect(deriveTag({ ...baseOrch, health: 'stopped' })).toBe('OFFLINE');
  });
  it('returns OFFLINE for status=failed regardless of health', () => {
    expect(deriveTag({ ...baseOrch, status: 'failed', health: 'bad' })).toBe('OFFLINE');
  });
  it('returns OFFLINE for status=stopping (graceful shutdown)', () => {
    expect(deriveTag({ ...baseOrch, status: 'stopping' })).toBe('OFFLINE');
  });
  it('returns OFFLINE for status=stopped', () => {
    expect(deriveTag({ ...baseOrch, status: 'stopped' })).toBe('OFFLINE');
  });
});

describe('derivePurpose', () => {
  it('uppercases the role', () => {
    expect(derivePurpose(baseOrch)).toBe('RESEARCHER');
  });
  it('truncates long roles to 16 chars (with ellipsis)', () => {
    const out = derivePurpose({ ...baseOrch, role: 'VERY-LONG-CUSTOM-ROLE' });
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out).toContain('…');
  });
  it('falls back to em-dash when role is empty', () => {
    expect(derivePurpose({ ...baseOrch, role: '' })).toBe('—');
  });
});

describe('filterActive / filterEnded', () => {
  const a = { ...baseOrch, id: 'a', endedAt: null };
  const b = { ...baseOrch, id: 'b', endedAt: '2026-05-22T09:00:00Z' };
  const c = { ...baseOrch, id: 'c', endedAt: '2026-05-22T09:30:00Z' };
  const list = [a, b, c];

  it('filterActive keeps endedAt == null', () => {
    expect(filterActive(list).map((o) => o.id)).toEqual(['a']);
  });
  it('filterEnded keeps endedAt != null', () => {
    const ids = filterEnded(list).map((o) => o.id);
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(ids).not.toContain('a');
  });
  it('filterEnded sorts desc on endedAt (most recent first)', () => {
    expect(filterEnded(list).map((o) => o.id)).toEqual(['c', 'b']);
  });
  it('filterEnded tolerates unparseable endedAt (goes to tail)', () => {
    const bad = { ...baseOrch, id: 'bad', endedAt: 'not-a-date' };
    const out = filterEnded([bad, c]).map((o) => o.id);
    expect(out[0]).toBe('c');
    expect(out).toContain('bad');
  });
});

describe('toLeftPanelTeam', () => {
  it('maps active orchestrator with all expected fields', () => {
    const team = toLeftPanelTeam(
      {
        ...baseOrch,
        sessions: [
          { id: 'sess-lead-1' } as never,
          { id: 'sess-w-1' } as never,
          { id: 'sess-w-2' } as never,
        ],
      },
      { 'orch-1': [1, 2, 3] },
    );
    expect(team.id).toBe('orch-1');
    expect(team.name).toBe('TEAM-A');
    expect(team.purpose).toBe('RESEARCHER');
    expect(team.msgCount).toBe(42);
    expect(team.leadId).toBe('sess-lead-1');
    expect(team.workerCount).toBe(2);
    expect(team.spark).toEqual([1, 2, 3]);
  });
  it('falls back to orch.id when leadSessionId is null', () => {
    const team = toLeftPanelTeam({ ...baseOrch, leadSessionId: null }, null);
    expect(team.leadId).toBe('orch-1');
  });
  it('returns empty spark when per-orch ring is absent', () => {
    expect(toLeftPanelTeam(baseOrch, null).spark).toEqual([]);
    expect(toLeftPanelTeam(baseOrch, { other: [1, 2] }).spark).toEqual([]);
  });
  it('clamps workerCount to ≥ 0 when sessions is empty', () => {
    expect(toLeftPanelTeam(baseOrch, null).workerCount).toBe(0);
  });
});

describe('toLeftPanelEnded', () => {
  it('uses stopReason when present', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      stopReason: 'server-restart',
    });
    expect(e.reason).toBe('server-restart');
  });
  it('falls back to "failed" when status=failed and no stopReason', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      status: 'failed',
      stopReason: null,
    });
    expect(e.reason).toBe('failed');
  });
  it('falls back to "exited" otherwise', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      status: 'stopped',
      stopReason: null,
    });
    expect(e.reason).toBe('exited');
  });
  it('lower-cases stopReason for CSS class consistency', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      stopReason: 'KILLED',
    });
    expect(e.reason).toBe('killed');
  });
  it('maps endedAt + agentCount + purpose', () => {
    const e = toLeftPanelEnded({
      ...baseOrch,
      endedAt: '2026-05-22T09:00:00Z',
      sessions: [
        { id: 'a' } as never,
        { id: 'b' } as never,
      ],
    });
    expect(e.endedAt).toBe('2026-05-22T09:00:00Z');
    expect(e.agentCount).toBe(2);
    expect(e.purpose).toBe('RESEARCHER');
  });
});

describe('sparkColor', () => {
  it('returns amber for healthy running orch', () => {
    expect(sparkColor(baseOrch)).toBe('var(--amber)');
  });
  it('returns muted ochre for offline orch', () => {
    expect(sparkColor({ ...baseOrch, health: 'stopped' })).toBe('#5a4d3f');
    expect(sparkColor({ ...baseOrch, status: 'failed' })).toBe('#5a4d3f');
    expect(sparkColor({ ...baseOrch, status: 'stopped' })).toBe('#5a4d3f');
  });
});

describe('ENDED_DISPLAY_CAP', () => {
  it('is a positive integer matching the documented value', () => {
    expect(Number.isInteger(ENDED_DISPLAY_CAP)).toBe(true);
    expect(ENDED_DISPLAY_CAP).toBeGreaterThan(0);
  });
});
