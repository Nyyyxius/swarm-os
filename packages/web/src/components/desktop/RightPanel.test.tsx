// packages/web/src/components/desktop/RightPanel.test.tsx
//
// Lot 4 — the CRONS affordance of the agent panel (docs/crons-agents.md §2.4).
//
// The three visibility rules are the point of this file: the header line is
// LEAD-only (a tick lands in the lead's inbox, never in a worker's), needs a
// roleId (a free-form-role team can hold no cron at all), and needs at least
// one cron (`pr-head` does not scroll — an empty "CRONS :: 0" would cost a
// line for nothing). Getting any of them wrong makes the panel state
// something untrue about the schedule.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import RightPanel, { type RightPanelAgent, type RightPanelTeam } from './RightPanel';
import type { ConfigTabCron } from './ConfigTab';

// The CONSOLE tab mounts a real xterm terminal; every test below renders the
// CONFIG tab, but the module graph is loaded either way — stub it out so the
// suite never depends on a canvas-capable DOM.
vi.mock('../Terminal', () => ({
  Terminal: () => <div data-testid="terminal-stub" />,
}));

const agent: RightPanelAgent = {
  id: 'sess_lead0001',
  name: 'lead-1',
  role: 'PLANNER',
  status: 'running',
  pid: 4242,
  startedAt: '2026-08-31T10:00:00Z',
  lastActivityAt: '2026-08-31T10:05:00Z',
  logLines: 0,
};

const team: RightPanelTeam = {
  id: 'orch-1',
  name: 'ATLAS',
  roleId: 'role_dev',
  leadId: 'sess_lead0001',
  workerCount: 0,
  model: 'claude-opus-4-7',
  effort: 'high',
  permissionMode: 'default',
  cwd: '/work/atlas',
  leadPrompt: null,
  leadPreamble: null,
  workerPreamble: null,
};

/** `nextRun` is always in the future so the row never renders as overdue. */
function cron(over: Partial<ConfigTabCron> = {}): ConfigTabCron {
  return {
    id: 'cron_a1b2c3d4',
    name: 'daily-standup',
    schedule: '0 9 * * 1-5',
    action: 'message',
    nextRun: new Date(Date.now() + 3_600_000).toISOString(),
    paused: false,
    ...over,
  };
}

function renderPanel(over: {
  isLead?: boolean;
  team?: RightPanelTeam;
  crons?: readonly ConfigTabCron[];
  onOpenCrons?: (roleId?: string) => void;
  onOpenCron?: (cronId: string) => void;
} = {}) {
  return render(
    <RightPanel
      selected={agent}
      team={over.team ?? team}
      isLead={over.isLead ?? true}
      messages={[]}
      activeTab="config"
      setActiveTab={() => {}}
      onClose={() => {}}
      onAction={() => {}}
      onSend={() => {}}
      onSpawnWorker={() => {}}
      onEditConfig={() => {}}
      crons={over.crons}
      onOpenCrons={over.onOpenCrons}
      onOpenCron={over.onOpenCron}
    />,
  );
}

describe('RightPanel — pr-crons header line', () => {
  it('renders count, next fire and paused count for a lead with crons', () => {
    const { container } = renderPanel({
      crons: [
        cron({ id: 'cron_1', name: 'late-one', nextRun: new Date(Date.now() + 7_200_000).toISOString() }),
        cron({ id: 'cron_2', name: 'soon-one', nextRun: new Date(Date.now() + 600_000).toISOString() }),
        cron({ id: 'cron_3', name: 'off-one', nextRun: null, paused: true }),
      ],
    });
    const line = container.querySelector('.pr-crons');
    expect(line).not.toBeNull();
    expect(line).toHaveTextContent('CRONS ::');
    expect(line).toHaveTextContent('3');
    // The EARLIEST upcoming fire wins, not the first in the list.
    expect(line).toHaveTextContent('SOON-ONE');
    expect(line).not.toHaveTextContent('LATE-ONE');
    expect(line).toHaveTextContent('1 PAUSED');
  });

  it('omits the NEXT segment when every cron is paused', () => {
    // A paused cron carries `nextRun: null` from the server. Painting a fire
    // time here would advertise a tick that will not happen.
    const { container } = renderPanel({
      crons: [cron({ nextRun: null, paused: true })],
    });
    const line = container.querySelector('.pr-crons');
    expect(line).not.toBeNull();
    expect(line).not.toHaveTextContent('NEXT');
    expect(line).toHaveTextContent('1 PAUSED');
  });

  it('is absent on a worker panel', () => {
    const { container } = renderPanel({ isLead: false, crons: [cron()] });
    expect(container.querySelector('.pr-crons')).toBeNull();
  });

  it('is absent for a team with no roleId (free-form role)', () => {
    const { container } = renderPanel({
      team: { ...team, roleId: null },
      crons: [cron()],
    });
    expect(container.querySelector('.pr-crons')).toBeNull();
  });

  it('is absent when the role has no cron', () => {
    const { container } = renderPanel({ crons: [] });
    expect(container.querySelector('.pr-crons')).toBeNull();
  });

  it('ALL → opens the crons screen filtered on this team role', () => {
    const onOpenCrons = vi.fn();
    renderPanel({ crons: [cron()], onOpenCrons });
    fireEvent.click(screen.getByText('ALL →'));
    expect(onOpenCrons).toHaveBeenCalledWith('role_dev');
  });
});

describe('RightPanel — CRONS section of the CONFIG tab', () => {
  it('lists one row per cron and deep-links it on click', () => {
    const onOpenCron = vi.fn();
    const { container } = renderPanel({
      crons: [cron({ id: 'cron_9', name: 'jira-sweep', action: 'script' })],
      onOpenCron,
    });
    // Scoped to the CONFIG tab: the header line renders the same cron name,
    // so an unscoped query would match twice.
    const cfg = within(container.querySelector('.cfg') as HTMLElement);
    expect(cfg.getByText('CRONS')).toBeInTheDocument();
    expect(cfg.getByText('0 9 * * 1-5')).toBeInTheDocument();
    expect(cfg.getByText('SCRIPT')).toBeInTheDocument();
    fireEvent.click(cfg.getByText('JIRA-SWEEP'));
    expect(onOpenCron).toHaveBeenCalledWith('cron_9');
  });

  it('hides the whole section when the role has no cron', () => {
    // Deliberate: hidden, not an empty "— (none) —" row. The section would
    // otherwise add a permanent line of noise to a tab read for the runtime
    // config, and it would contradict the header line, which is also silent.
    const { container } = renderPanel({ crons: [] });
    const cfg = within(container.querySelector('.cfg') as HTMLElement);
    expect(cfg.queryByText('CRONS')).toBeNull();
  });
});
