// packages/web/src/components/desktop/LeftPanel.test.tsx
//
// Phase B.5 — render-level smoke tests for the wired LeftPanel.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LeftPanel from './LeftPanel';
import type { OrchestratorView } from '../../api/client';

// We mock the metrics endpoints so the polling hooks resolve deterministically.
// `listOrchestrators` is not used here (the parent passes the snapshot down)
// but we still hand back a stub for safety.
vi.mock('../../api/client', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...actual,
    api: {
      ...actual.api,
      getMetricsMessages: vi.fn(async () => ({
        total: 1000,
        per_minute: 12,
        global: new Array(60).fill(0),
        per_orchestrator: { 'orch-1': [0, 0, 1, 2, 3, 4, 5, 6] },
      })),
      getMetricsBus: vi.fn(async () => ({
        latency_ms: 42,
        throughput_msg_per_s: 1.2,
        queue_depth: 7,
        err_rate_pct: 0.5,
        window_seconds: 60,
      })),
    },
  };
});

const mkOrch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({
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
  sessions: [
    { id: 'sess-lead-1', type: 'lead' } as never,
    { id: 'sess-w-1', type: 'worker' } as never,
  ],
  msgCount: 42,
  stopReason: null,
  health: 'ok',
  ...over,
});

describe('LeftPanel rendering (smoke)', () => {
  beforeEach(() => {
    // Real timers — the polling intervals are long enough not to fire
    // during the synchronous render assertions, and using fake timers
    // breaks `await` of the mocked fetches in some React 19 paths.
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the 4 sections with one active team', () => {
    render(
      <LeftPanel
        orchestrators={[mkOrch()]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText(/MESSAGE FLOW/i)).toBeInTheDocument();
    expect(screen.getByText(/PER-TEAM TRAFFIC/i)).toBeInTheDocument();
    expect(screen.getByText(/BUS HEALTH/i)).toBeInTheDocument();
    // RECENTLY ENDED is absent when no ended orch exists.
    expect(screen.queryByText(/RECENTLY ENDED/i)).toBeNull();
    // Active team is rendered with the ONLINE tag.
    expect(screen.getByText('TEAM-A')).toBeInTheDocument();
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
  });

  it('renders RECENTLY ENDED when an orchestrator has endedAt', () => {
    render(
      <LeftPanel
        orchestrators={[
          mkOrch({
            id: 'orch-ended',
            endedAt: '2026-05-22T09:00:00Z',
            stopReason: 'killed',
          }),
        ]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText(/RECENTLY ENDED/i)).toBeInTheDocument();
    expect(screen.getByText('KILLED')).toBeInTheDocument();
  });

  it('invokes onSelectTeam with the lead sessionId on row click', () => {
    const onSelectTeam = vi.fn();
    render(
      <LeftPanel
        orchestrators={[mkOrch()]}
        onSelectTeam={onSelectTeam}
        onSelectEnded={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('TEAM-A'));
    expect(onSelectTeam).toHaveBeenCalledWith('sess-lead-1');
  });

  it('invokes onSelectEnded with the orchestratorId on ended row click', () => {
    const onSelectEnded = vi.fn();
    render(
      <LeftPanel
        orchestrators={[
          mkOrch({ id: 'orch-ended', endedAt: '2026-05-22T09:00:00Z' }),
        ]}
        onSelectTeam={vi.fn()}
        onSelectEnded={onSelectEnded}
      />,
    );
    fireEvent.click(screen.getByText('TEAM-A'));
    expect(onSelectEnded).toHaveBeenCalledWith('orch-ended');
  });

  it('renders OFFLINE tag when health=stopped', () => {
    render(
      <LeftPanel
        orchestrators={[mkOrch({ health: 'stopped', status: 'stopped' })]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
  });

  it('renders STARTING tag when status=starting', () => {
    render(
      <LeftPanel
        orchestrators={[mkOrch({ status: 'starting' })]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText('STARTING')).toBeInTheDocument();
  });

  it('renders "no active teams" when orchestrators is empty', () => {
    render(
      <LeftPanel
        orchestrators={[]}
        onSelectTeam={vi.fn()}
        onSelectEnded={vi.fn()}
      />,
    );
    expect(screen.getByText(/no active teams/i)).toBeInTheDocument();
  });

  it('falls back to orchId when leadSessionId is null on active row click', () => {
    const onSelectTeam = vi.fn();
    render(
      <LeftPanel
        orchestrators={[mkOrch({ leadSessionId: null })]}
        onSelectTeam={onSelectTeam}
        onSelectEnded={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('TEAM-A'));
    expect(onSelectTeam).toHaveBeenCalledWith('orch-1');
  });

  // Touch `act` to silence the React linter (it is the canonical wrapper
  // around effect flushes; we keep it imported for future async assertions).
  it('imports act helper (sanity)', () => {
    expect(typeof act).toBe('function');
  });
});
