// Render tests for the MONITORING page's Lot 9 surfaces — the SPARK column
// and the CONTEXT HISTORY band (docs/monitoring-agents.md).
//
// Three things are worth a test here, and they are all about what the page
// does NOT do:
//
//   1. It does not fabricate a trend. No series → the em-dash, never a flat
//      line at the current percentage.
//   2. It does not fetch history until someone asks for it, and it asks for
//      exactly the window shown as selected.
//   3. A row click and an ACTION click do not collide. COMPACT arms a reset
//      and leaves the chart alone; the row opens the chart and arms nothing.
//      Getting this wrong swaps the chart under the operator at the exact
//      moment they trigger an irreversible CLEAR.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MonitoringPage } from './MonitoringPage';
// Value import — the module is mocked below, but `importOriginal` keeps the
// real `HttpError` class, which is what the EXPORT suite rejects with.
import { HttpError } from '../api/client';
import type {
  CallUsageView, ContextHistoryView, OrchestratorView, SessionCallsView, SessionCostRow,
  SessionView, TeamCostRow, TokenUsageView,
} from '../api/client';

const hoisted = vi.hoisted(() => ({
  orchestrators: [] as unknown[],
  onContextReset: vi.fn(async () => undefined),
  selectAgent: vi.fn(),
  pushNotice: vi.fn(),
  contextHistory: vi.fn(),
  getMetricsSystem: vi.fn(),
  getMetricsCosts: vi.fn(),
  getOrchestratorCost: vi.fn(),
  exportCosts: vi.fn(),
  sessionCalls: vi.fn(),
  getMetricsCallUsage: vi.fn(),
  getOrchestratorCallUsage: vi.fn(),
}));

vi.mock('../controller/SwarmController', () => ({
  useSwarmController: () => ({
    orchestrators: hoisted.orchestrators,
    onContextReset: hoisted.onContextReset,
    selectAgent: hoisted.selectAgent,
    // Lot 15 — the EXPORT block reports its own failures on the notice
    // channel the controller owns.
    pushNotice: hoisted.pushNotice,
  }),
}));

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      getMetricsMessages: vi.fn(async () => ({
        total: 10,
        per_minute: 3,
        global: new Array(60).fill(0),
        per_orchestrator: {},
      })),
      // Lot 10 — without this the gauges' poll would reach the real `request`
      // helper and spray warnings through every test in this file.
      getMetricsSystem: hoisted.getMetricsSystem,
      // Lot 12 — same reason: the TEAM COSTS poll and its drill-down would
      // otherwise reach the real `request` helper from every test here.
      getMetricsCosts: hoisted.getMetricsCosts,
      getOrchestratorCost: hoisted.getOrchestratorCost,
      // Lot 15 — the EXPORT buttons; unmocked it would reach `fetch` itself.
      exportCosts: hoisted.exportCosts,
      contextHistory: hoisted.contextHistory,
      // Per-call ledger — the band's API CALLS strip and the CALL USAGE panel.
      sessionCalls: hoisted.sessionCalls,
      getMetricsCallUsage: hoisted.getMetricsCallUsage,
      getOrchestratorCallUsage: hoisted.getOrchestratorCallUsage,
    },
  };
});

// ── fixtures ────────────────────────────────────────────────────────────────

function sess(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    orchestratorId: 'o1',
    name: 'AGENT-1',
    role: 'BUILDER',
    type: 'worker',
    cwd: '/tmp',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    provider: 'claude',
    status: 'running',
    pid: 1,
    startedAt: '2026-08-30T09:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/var/log',
    lastActivityAt: '2026-08-30T10:00:00.000Z',
    contextUsage: {
      usedTokens: 140_000,
      limitTokens: 200_000,
      pct: 0.7,
      basis: 'transcript',
      updatedAt: '2026-08-30T10:00:00.000Z',
      stale: false,
    },
    ...over,
  };
}

function tokens(over: Partial<TokenUsageView> = {}): TokenUsageView {
  return {
    in: 18_200_000,
    out: 141_000,
    cacheRead: 1_204_556,
    cacheWrite: 88_120,
    costUsd: 5.61,
    costBasis: 'estimated',
    ...over,
  };
}

function teamCost(over: Partial<TeamCostRow> = {}): TeamCostRow {
  return {
    orchId: 'o1',
    name: 'ATLAS',
    live: 3,
    total: {
      in: 18_200_000, out: 141_000, cacheRead: 1_204_556, cacheWrite: 88_120,
      costUsd: 50.07,
    },
    removed: { count: 0, costUsd: null },
    burnPerHour: 1.84,
    ...over,
  };
}

function sessionCost(over: Partial<SessionCostRow> = {}): SessionCostRow {
  return {
    id: 'w1',
    name: 'WORKER-1',
    type: 'worker',
    status: 'killed',
    removed: true,
    tokens: { in: 1_000, out: 200, cacheRead: 3_000, cacheWrite: 50 },
    costUsd: 0.42,
    ...over,
  };
}

function orch(sessions: SessionView[]): OrchestratorView {
  return {
    id: 'o1',
    name: 'ATLAS',
    role: 'ORCHESTRATOR',
    roleId: null,
    status: 'running',
    leadSessionId: 'lead-1',
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-08-30T09:00:00.000Z',
    endedAt: null,
    lastError: null,
    sessions,
    msgCount: 0,
    stopReason: null,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
  } as OrchestratorView;
}

const T0 = Date.parse('2026-08-30T10:00:00.000Z');

function history(over: Partial<ContextHistoryView> = {}): ContextHistoryView {
  return {
    limitTokens: 200_000,
    points: [
      { t: new Date(T0).toISOString(), min: 100_000, max: 110_000, last: 105_000 },
      { t: new Date(T0 + 60_000).toISOString(), min: 120_000, max: 140_000, last: 140_000 },
    ],
    resets: [{ t: new Date(T0 + 30_000).toISOString(), cmd: 'compact' }],
    ...over,
  };
}

function calls(over: Partial<SessionCallsView> = {}): SessionCallsView {
  const since = new Date(T0 - 24 * 3_600_000).toISOString();
  return {
    window: '24h',
    since,
    until: new Date(T0 + 60_000).toISOString(),
    aggregated: false,
    bucketMs: null,
    calls: [
      {
        t: new Date(T0 - 60_000).toISOString(), n: 1, model: 'claude-opus-5-5',
        input: 3, cacheWrite: 2_000, cacheRead: 100_000, output: 800, context: 102_003,
        sidechain: false,
      },
      {
        t: new Date(T0).toISOString(), n: 1, model: 'claude-opus-5-5',
        input: 1, cacheWrite: 500, cacheRead: 102_800, output: 300, context: 103_301,
        sidechain: false,
      },
    ],
    hourly: [{ t: new Date(T0 - 3_600_000).toISOString(), calls: 1 }, { t: new Date(T0).toISOString(), calls: 1 }],
    totals: {
      calls: 2, input: 4, cacheWrite: 2_500, cacheRead: 202_800, output: 1_100, maxContext: 103_301,
    },
    ...over,
  };
}

function callUsage(over: Partial<CallUsageView> = {}): CallUsageView {
  const pt = (t: number, n: number) => ({
    t: new Date(t).toISOString(), calls: n, input: n, cacheWrite: 10 * n, cacheRead: 1_000 * n, output: 5 * n,
  });
  return {
    window: '24h',
    bucket: 'hour',
    bucketMs: 3_600_000,
    since: new Date(T0 - 2 * 3_600_000).toISOString(),
    until: new Date(T0 + 60_000).toISOString(),
    lead: [pt(T0 - 2 * 3_600_000, 2), pt(T0 - 3_600_000, 0), pt(T0, 4)],
    workers: [pt(T0 - 2 * 3_600_000, 5), pt(T0 - 3_600_000, 1), pt(T0, 9)],
    totals: {
      lead: { calls: 6, input: 6, cacheWrite: 60, cacheRead: 6_000, output: 30 },
      workers: { calls: 15, input: 15, cacheWrite: 150, cacheRead: 15_000, output: 75 },
    },
    teams: [
      { orchestratorId: 'o1', name: 'ATLAS', calls: 21, input: 21, cacheWrite: 210, cacheRead: 21_000, output: 105 },
    ],
    ...over,
  };
}

const renderPage = () => render(<MonitoringPage open onClose={() => undefined} />);
const firstRow = (container: HTMLElement) =>
  container.querySelector('tbody tr') as HTMLElement;

beforeEach(() => {
  hoisted.orchestrators = [orch([sess({ contextSpark: [10, 40, 70] })])];
  hoisted.contextHistory.mockReset();
  hoisted.contextHistory.mockResolvedValue(history());
  hoisted.getMetricsSystem.mockReset();
  hoisted.getMetricsSystem.mockResolvedValue({
    cpu: { pct: 0.35, cores: 4, basis: 'cgroup' },
    memory: {
      usedBytes: 6.2 * 1024 ** 3,
      limitBytes: 8 * 1024 ** 3,
      pct: 0.775,
      basis: 'cgroup',
    },
  });
  // Default: a server that HAS the Lot 12 endpoint but nothing to report —
  // the quiet state, so the existing suites see no TEAM COSTS rows and no
  // console noise. The Lot 12 suite below overrides per test.
  hoisted.getMetricsCosts.mockReset();
  hoisted.getMetricsCosts.mockResolvedValue({ teams: [] });
  hoisted.getOrchestratorCost.mockReset();
  hoisted.getOrchestratorCost.mockResolvedValue({ sessions: [] });
  hoisted.exportCosts.mockReset();
  hoisted.exportCosts.mockResolvedValue('day,orchestrator_id\n2026-08-30,o1\n');
  hoisted.sessionCalls.mockReset();
  hoisted.sessionCalls.mockResolvedValue(calls());
  hoisted.getMetricsCallUsage.mockReset();
  hoisted.getMetricsCallUsage.mockResolvedValue(callUsage());
  hoisted.getOrchestratorCallUsage.mockReset();
  hoisted.getOrchestratorCallUsage.mockResolvedValue(callUsage({ teams: undefined }));
  hoisted.pushNotice.mockClear();
  hoisted.onContextReset.mockClear();
  hoisted.selectAgent.mockClear();
  window.localStorage.setItem('swarm-os.token', 'test-token');
});

afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

// ── SPARK column ────────────────────────────────────────────────────────────

describe('MONITORING · SPARK column', () => {
  it('sits between CONTEXT and TOKENS · COST', () => {
    renderPage();
    const heads = Array.from(document.querySelectorAll('.mon-table thead th'))
      .map((th) => th.textContent);
    expect(heads.slice(3, 7)).toEqual(['CONTEXT', 'SPARK', 'TOKENS · COST', 'MSGS']);
  });

  it('draws a sparkline when the session carries a series', () => {
    const { container } = renderPage();
    expect(container.querySelector('.mon-spark svg')).toBeTruthy();
  });

  it('renders the em-dash — not a flat line — when there is no series', () => {
    hoisted.orchestrators = [orch([sess()])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-spark')).toBeNull();
    const cell = container.querySelector('.mon-table tbody td.mon-col-spark');
    expect(cell?.textContent).toBe('—');
  });
});

// ── the band ────────────────────────────────────────────────────────────────

describe('MONITORING · CONTEXT HISTORY band', () => {
  it('fetches nothing until a row is clicked', () => {
    renderPage();
    expect(screen.queryByText('CONTEXT HISTORY')).toBeNull();
    expect(hoisted.contextHistory).not.toHaveBeenCalled();
  });

  it('opens on a row click and asks for the default 24H window', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText('CONTEXT HISTORY')).toBeTruthy();
    expect(hoisted.contextHistory).toHaveBeenCalledWith('s1', '24h');
  });

  it('names the agent, its team and its provider in the header', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    const band = await screen.findByLabelText(/^Context history — /i);
    expect(band.textContent).toContain('AGENT-1');
    expect(band.textContent).toContain('ATLAS');
    expect(band.textContent).toContain('⬡ CLAUDE');
  });

  it('plots the series, its amplitude band and the reset marker', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await waitFor(() => expect(container.querySelector('.mon-hist-line')).toBeTruthy());
    expect(container.querySelector('.mon-hist-area')).toBeTruthy();
    expect(container.querySelector('.mon-hist-band')).toBeTruthy();
    expect(container.querySelector('.mon-hist-reset')).toBeTruthy();
    expect(screen.getByText('COMPACT', { selector: 'text' })).toBeTruthy();
  });

  it('labels both thresholds when the model window is known', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await waitFor(() => expect(container.querySelector('.mon-hist-line')).toBeTruthy());
    const labels = Array.from(container.querySelectorAll('.mon-hist-threshold-label'))
      .map((n) => n.textContent);
    expect(labels).toEqual(['70%', '90%']);
  });

  it('drops the threshold lines when the window is unknown', async () => {
    hoisted.contextHistory.mockResolvedValue(history({ limitTokens: null }));
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await waitFor(() => expect(container.querySelector('.mon-hist-line')).toBeTruthy());
    expect(container.querySelectorAll('.mon-hist-threshold-label')).toHaveLength(0);
  });

  it('says so — quietly — when the server has no history yet', async () => {
    hoisted.contextHistory.mockResolvedValue({
      limitTokens: 200_000, points: [], resets: [],
    });
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText('— no history yet —')).toBeTruthy();
    expect(container.querySelector('.mon-hist-line')).toBeNull();
  });

  it('shows the same empty band (no toast, no red) when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.contextHistory.mockRejectedValue(new Error('HTTP 404'));
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText('— no history yet —')).toBeTruthy();
    expect(container.querySelector('.toast')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refetches on a window change', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    // Scoped: the API CALLS strip and the CALL USAGE panel have a 1H too.
    const seg = screen.getByRole('group', { name: 'history window' });
    fireEvent.click(within(seg).getByRole('button', { name: '1H' }));
    await waitFor(() => expect(hoisted.contextHistory).toHaveBeenCalledWith('s1', '1h'));
  });

  it('closes on a second click of the same row', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    fireEvent.click(firstRow(container));
    await waitFor(() => expect(screen.queryByText('CONTEXT HISTORY')).toBeNull());
  });

  it('closes on the × button', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    fireEvent.click(screen.getByLabelText('close context history'));
    await waitFor(() => expect(screen.queryByText('CONTEXT HISTORY')).toBeNull());
  });

  it('re-targets when another row is clicked', async () => {
    hoisted.orchestrators = [orch([
      sess({ id: 's1', name: 'AGENT-1' }),
      sess({ id: 's2', name: 'AGENT-2', contextUsage: null }),
    ])];
    const { container } = renderPage();
    const rows = container.querySelectorAll('tbody tr');
    fireEvent.click(rows[0] as HTMLElement);
    await screen.findByText('CONTEXT HISTORY');
    expect(hoisted.contextHistory).toHaveBeenLastCalledWith('s1', '24h');
    fireEvent.click(rows[1] as HTMLElement);
    await waitFor(() =>
      expect(hoisted.contextHistory).toHaveBeenLastCalledWith('s2', '24h'));
    const band = screen.getByLabelText(/^Context history — /i);
    expect(band.textContent).toContain('AGENT-2');
  });

  it('opens by keyboard too (Enter on the focused row)', async () => {
    const { container } = renderPage();
    fireEvent.keyDown(firstRow(container), { key: 'Enter' });
    expect(await screen.findByText('CONTEXT HISTORY')).toBeTruthy();
  });

  it('renders the in-memory disclaimer', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText(/IN-MEMORY · LAST 3 DAYS · CLEARED ON SERVER RESTART/))
      .toBeTruthy();
  });
});

// ── row click vs row actions ────────────────────────────────────────────────

describe('MONITORING · row click never collides with the actions', () => {
  it('COMPACT arms a reset and does NOT open the band', async () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'COMPACT' }));
    expect(hoisted.onContextReset).toHaveBeenCalledWith('s1', 'compact');
    expect(screen.queryByText('CONTEXT HISTORY')).toBeNull();
    expect(hoisted.contextHistory).not.toHaveBeenCalled();
    expect(container.querySelector('.mon-hist')).toBeNull();
  });

  it('CLEAR opens its confirm modal and does NOT open the band', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'CLEAR' }));
    expect(screen.getByText('CLEAR WORKER CONTEXT')).toBeTruthy();
    expect(screen.queryByText('CONTEXT HISTORY')).toBeNull();
  });

  it('the AGENT name keeps selecting the agent, without opening the band', () => {
    const { container } = renderPage();
    fireEvent.click(container.querySelector('.mon-agent') as HTMLElement);
    expect(hoisted.selectAgent).toHaveBeenCalledWith('s1');
    expect(screen.queryByText('CONTEXT HISTORY')).toBeNull();
  });
});

// ── Lot 10 system gauges in the KPI band ────────────────────────────────────

describe('MONITORING · system gauges', () => {
  it('leads the KPI band with CPU then MEMORY, ahead of the seven cells', async () => {
    // Order is load-bearing: the CSS track is `168px 168px repeat(7, 1fr)`,
    // so a gauge moved out of the first two slots lands in an elastic cell.
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.mon-gauge-value')).toBeTruthy());
    const cells = Array.from(container.querySelectorAll('.mon-kpis > *'));
    expect(cells).toHaveLength(9);
    expect(cells[0]?.className).toContain('mon-gauge');
    expect(cells[1]?.className).toContain('mon-gauge');
    expect(cells[0]?.getAttribute('aria-label')).toMatch(/^CPU /);
    expect(cells[1]?.getAttribute('aria-label')).toMatch(/^MEMORY /);
    expect(cells[2]?.textContent).toContain('ACTIVE AGENTS');
  });

  it('shows the container reading the server sent', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.mon-gauge-value')).toBeTruthy());
    const [cpu, mem] = Array.from(container.querySelectorAll('.mon-gauge'));
    expect(cpu?.querySelector('.mon-gauge-pct')?.textContent).toBe('35%');
    expect(cpu?.querySelector('.mon-gauge-sub')?.textContent).toBe('1.4 / 4.0 CORES');
    expect(mem?.querySelector('.mon-gauge-pct')?.textContent).toBe('78%');
    expect(mem?.querySelector('.mon-gauge-sub')?.textContent).toBe('6.2G / 8.0G');
  });

  it('falls back to silent em-dashes when the endpoint 404s (older server)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.getMetricsSystem.mockRejectedValue(new Error('HTTP 404 GET /metrics/system'));
    const { container } = renderPage();
    await waitFor(() => expect(hoisted.getMetricsSystem).toHaveBeenCalled());

    const gauges = Array.from(container.querySelectorAll('.mon-gauge'));
    expect(gauges).toHaveLength(2);
    for (const g of gauges) {
      // Track only — no value arc, no fabricated 0 %.
      expect(g.querySelector('.mon-gauge-track')).toBeTruthy();
      expect(g.querySelector('.mon-gauge-value')).toBeNull();
      expect(g.querySelector('.mon-gauge-pct')?.textContent).toBe('—');
      expect(g.querySelector('.mon-gauge-sub')?.textContent).toBe('NO CGROUP DATA');
    }
    // The rest of the page is untouched by the missing endpoint.
    expect(container.querySelector('.mon-table')).toBeTruthy();
    warn.mockRestore();
  });

  it('does not poll /metrics/system while the page is closed', async () => {
    render(<MonitoringPage open={false} onClose={() => undefined} />);
    await waitFor(() => expect(hoisted.getMetricsSystem).not.toHaveBeenCalled());
  });

  it('tags HOST BASIS when the container has no cgroup limit', async () => {
    hoisted.getMetricsSystem.mockResolvedValue({
      cpu: { pct: 0.1, cores: 16, basis: 'host' },
      memory: {
        usedBytes: 3 * 1024 ** 3, limitBytes: 32 * 1024 ** 3, pct: 0.09375, basis: 'host',
      },
    });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelectorAll('.mon-gauge-basis')).toHaveLength(2));
    expect(container.querySelector('.mon-gauge-basis')?.textContent).toBe('HOST BASIS');
  });
});

// ── Lot 11 · TOKENS · COST column + EST. COST KPI ───────────────────────────
//
// The column and the KPI are held to the same standard as everything else on
// this page: what is measured is shown, what is not is an em-dash, and a
// total that cannot see every agent says so out loud.

// Both money cells share `.mon-kpi-cost` (same typography); the `:not` is
// what keeps this helper pointing at EST. COST after Lot 12 added BURN /H.
const costKpi = (container: HTMLElement) =>
  container.querySelector('.mon-kpi-cost:not(.mon-kpi-burn) .v')?.textContent;
const burnKpi = (container: HTMLElement) =>
  container.querySelector('.mon-kpi-burn .v')?.textContent;

describe('MONITORING · TOKENS · COST column', () => {
  it('stacks the IN/OUT counts over the estimated cost', () => {
    hoisted.orchestrators = [orch([sess({ tokenUsage: tokens() })])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-tok-io')?.textContent)
      .toBe('IN 18.2M · OUT 141K');
    expect(container.querySelector('.mon-tok-cost')?.textContent)
      .toBe('$5.61 EST');
  });

  it('carries the full cache ventilation in the native title', () => {
    hoisted.orchestrators = [orch([sess({ tokenUsage: tokens() })])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-tok')?.getAttribute('title')).toBe(
      'IN 18,200,000 · OUT 141,000 · CACHE READ 1,204,556 '
      + '· CACHE WRITE 88,120 · CACHE HIT 6% · EST $5.61',
    );
  });

  it('keeps the counts and drops only the amount when the model is unpriced', () => {
    hoisted.orchestrators = [orch([sess({ tokenUsage: tokens({ costUsd: null }) })])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-tok-io')?.textContent)
      .toBe('IN 18.2M · OUT 141K');
    expect(container.querySelector('.mon-tok-cost')?.textContent).toBe('— EST');
  });

  it('renders a silent em-dash when the server reports no spend at all', () => {
    // gemini, a backend predating Lot 11, a session with no turn yet — the
    // cell must not fall back to a zero that reads as "this agent is free".
    hoisted.orchestrators = [orch([sess()])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-tok')).toBeNull();
    const cell = container.querySelector('.mon-table tbody td.mon-col-tokens');
    expect(cell?.textContent).toBe('—');
  });
});

describe('MONITORING · EST. COST KPI', () => {
  it('closes the KPI band with the money pair, after MESSAGES', async () => {
    // Stock then flow (Lot 12 appended BURN /H): both money cells live at the
    // end of the band, and MESSAGES /MIN stays the last non-money cell.
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.mon-gauge-value')).toBeTruthy());
    const cells = Array.from(container.querySelectorAll('.mon-kpis > *'));
    expect(cells[cells.length - 3]?.textContent).toContain('MESSAGES /MIN');
    expect(cells[cells.length - 2]?.textContent).toContain('EST. COST');
    expect(cells[cells.length - 1]?.textContent).toContain('BURN /H');
  });

  it('sums the displayed agents when every one of them is priced', () => {
    hoisted.orchestrators = [orch([
      sess({ id: 's1', name: 'A1', tokenUsage: tokens({ costUsd: 5.61 }) }),
      sess({ id: 's2', name: 'A2', tokenUsage: tokens({ costUsd: 2.39 }) }),
    ])];
    const { container } = renderPage();
    expect(costKpi(container)).toBe('$8.00');
  });

  it('prefixes ≥ when at least one displayed agent reports no cost', () => {
    hoisted.orchestrators = [orch([
      sess({ id: 's1', name: 'A1', tokenUsage: tokens({ costUsd: 5.61 }) }),
      // gemini: counted by the table, invisible to the bill.
      sess({ id: 's2', name: 'A2', provider: 'gemini', tokenUsage: undefined }),
    ])];
    const { container } = renderPage();
    expect(costKpi(container)).toBe('≥$5.61');
    expect(container.querySelector('.mon-kpi-cost')?.getAttribute('title'))
      .toMatch(/lower bound/i);
  });

  it('renders the em-dash — not $0.00 — when nothing is priced', () => {
    hoisted.orchestrators = [orch([sess()])];
    const { container } = renderPage();
    expect(costKpi(container)).toBe('—');
    expect(container.querySelector('.mon-kpi-cost')?.getAttribute('title')).toBeNull();
  });

  it('follows the table filters instead of billing hidden agents', () => {
    // ACTIVE ONLY is on by default, so the terminated agent is neither in the
    // table nor in the total — and, crucially, its absence does not make the
    // remaining total partial either.
    hoisted.orchestrators = [orch([
      sess({ id: 's1', name: 'A1', tokenUsage: tokens({ costUsd: 5.61 }) }),
      sess({
        id: 's2', name: 'A2', status: 'exited', endedAt: '2026-08-30T09:30:00.000Z',
        tokenUsage: tokens({ costUsd: 100 }),
      }),
    ])];
    const { container } = renderPage();
    expect(container.querySelectorAll('.mon-table tbody tr')).toHaveLength(1);
    expect(costKpi(container)).toBe('$5.61');
  });
});

// ── Lot 12 · TEAM COSTS section + BURN /H KPI ───────────────────────────────
//
// The section's whole reason to exist is the spend the table above it cannot
// see: agents that were killed or reaped are gone from the `/orchestrators`
// snapshot and still on the bill. So the tests are mostly about ABSENCE —
// what it shows when the endpoint is missing, when nobody was removed, and
// when a removed worker predates the counters entirely.

const teamRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.mon-costs-line'));
/**
 * Row `i` of the costs table. Throws rather than handing back `undefined`,
 * so a row that never rendered fails on the row instead of somewhere further
 * down the assertion it was fed to.
 */
const teamRow = (container: HTMLElement, i = 0): Element => {
  const row = teamRows(container)[i];
  if (!row) throw new Error(`no team cost row at index ${i}`);
  return row;
};
const teamCell = (row: Element, cls: string) =>
  row.querySelector(cls)?.textContent;

describe('MONITORING · TEAM COSTS section', () => {
  it('sits between the KPI band and the agent table', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.mon-costs')).toBeTruthy());
    const main = Array.from(container.querySelectorAll('.mon-main > *'));
    const band = main.findIndex((n) => n.classList.contains('mon-kpis'));
    const costs = main.findIndex((n) => n.classList.contains('mon-costs'));
    const table = main.findIndex((n) => n.classList.contains('mon-table-wrap'));
    expect(band).toBeLessThan(costs);
    expect(costs).toBeLessThan(table);
  });

  it('keeps its header and says so quietly when the endpoint is missing', async () => {
    // A server predating Lot 12 404s on every tick: no toast, no red, and —
    // crucially — no section that appears and disappears under the operator.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.getMetricsCosts.mockRejectedValue(new Error('HTTP 404 GET /metrics/costs'));
    const { container } = renderPage();
    await waitFor(() => expect(hoisted.getMetricsCosts).toHaveBeenCalled());

    expect(screen.getByText('TEAM COSTS')).toBeTruthy();
    expect(screen.getByText('DB TOTALS · REMOVED WORKERS INCLUDED')).toBeTruthy();
    expect(screen.getByText('— no cost data yet —')).toBeTruthy();
    // No Σ at all rather than a `Σ — EST` that reads like a broken number.
    expect(container.querySelector('.mon-costs-sum')).toBeNull();
    expect(container.querySelector('.toast')).toBeNull();
    // And the rest of the page is untouched.
    expect(container.querySelector('.mon-table')).toBeTruthy();
    warn.mockRestore();
  });

  it('heads the section with the Σ of the team totals', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'o1', total: { ...teamCost().total, costUsd: 50.07 } }),
        teamCost({ orchId: 'o2', name: 'NOVA', total: { ...teamCost().total, costUsd: 9.93 } }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.mon-costs-sum')).toBeTruthy());
    expect(container.querySelector('.mon-costs-sum')?.textContent).toBe('Σ $60.00 EST');
  });

  it('marks the Σ as a lower bound when a team cannot be priced', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'o1', total: { ...teamCost().total, costUsd: 50.07 } }),
        teamCost({ orchId: 'o2', name: 'NOVA', total: { ...teamCost().total, costUsd: null } }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('.mon-costs-sum')).toBeTruthy());
    expect(container.querySelector('.mon-costs-sum')?.textContent).toBe('Σ ≥$50.07 EST');
  });

  it('sorts the teams by cost desc', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'o1', name: 'CHEAP', total: { ...teamCost().total, costUsd: 1 } }),
        teamCost({ orchId: 'o2', name: 'DEAR', total: { ...teamCost().total, costUsd: 90 } }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(2));
    expect(teamRows(container).map((r) => teamCell(r, '.mon-costs-name')))
      .toEqual(['DEAR', 'CHEAP']);
  });

  it('renders a team with nothing removed — em-dash, not a zero', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ live: 4, burnPerHour: 1.84, removed: { count: 0, costUsd: null } })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    const row = teamRow(container);
    expect(teamCell(row, '.mon-costs-name')).toBe('ATLAS');
    expect(teamCell(row, '.mon-costs-live')).toBe('4 LIVE');
    expect(teamCell(row, '.mon-costs-burn')).toBe('$1.84');
    expect(teamCell(row, '.mon-costs-total')).toBe('$50.07');
    expect(teamCell(row, '.mon-costs-removed')).toBe('—');
  });

  it('names the removed workers folded into the total', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ removed: { count: 4, costUsd: 12.4 } })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    expect(teamCell(teamRow(container), '.mon-costs-removed'))
      .toBe('INCL. 4 REMOVED · $12.40');
  });

  it('em-dashes an unmeasurable burn without hiding the team', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ burnPerHour: null })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    expect(teamCell(teamRow(container), '.mon-costs-burn')).toBe('—');
  });

  it('tints ONLY the team burning several times the median', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'o1', name: 'CALM-A', burnPerHour: 0.2, total: { ...teamCost().total, costUsd: 3 } }),
        teamCost({ orchId: 'o2', name: 'CALM-B', burnPerHour: 0.4, total: { ...teamCost().total, costUsd: 2 } }),
        teamCost({ orchId: 'o3', name: 'RUNAWAY', burnPerHour: 9, total: { ...teamCost().total, costUsd: 1 } }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(3));
    const tinted = teamRows(container)
      .filter((r) => (r.querySelector('.mon-costs-burn') as HTMLElement)
        ?.style.color === 'var(--warn)')
      .map((r) => teamCell(r, '.mon-costs-name'));
    expect(tinted).toEqual(['RUNAWAY']);
  });

  it('fetches no detail until a team row is clicked', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    expect(hoisted.getOrchestratorCost).not.toHaveBeenCalled();
  });

  it('expands to the REMOVED workers only, with their cache hit', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ removed: { count: 1, costUsd: 0.42 } })],
    });
    hoisted.getOrchestratorCost.mockResolvedValue({
      sessions: [
        sessionCost({ id: 'w1', name: 'WORKER-1' }),
        sessionCost({ id: 'live', name: 'WORKER-LIVE', removed: false, status: 'running' }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    fireEvent.click(teamRow(container));

    await waitFor(() => expect(hoisted.getOrchestratorCost).toHaveBeenCalledWith('o1'));
    await waitFor(() => expect(container.querySelectorAll('.mon-costs-sess')).toHaveLength(1));
    const sessRow = container.querySelector('.mon-costs-sess') as HTMLElement;
    expect(sessRow.textContent).toContain('WORKER-1');
    expect(sessRow.textContent).not.toContain('WORKER-LIVE');
    expect(sessRow.querySelector('.mon-costs-sess-tok')?.textContent)
      .toBe('IN 1K · OUT 200 · CACHE HIT 75%');
    expect(sessRow.querySelector('.mon-costs-sess-cost')?.textContent).toBe('$0.42');
  });

  it('badges a deliberate kill muted and any other exit in the warn register', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    hoisted.getOrchestratorCost.mockResolvedValue({
      sessions: [
        sessionCost({ id: 'w1', name: 'W1', status: 'killed', costUsd: 1 }),
        sessionCost({ id: 'w2', name: 'W2', status: 'failed', costUsd: 0.5 }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    fireEvent.click(teamRow(container));
    await waitFor(() => expect(container.querySelectorAll('.mon-costs-sess')).toHaveLength(2));

    const badges = Array.from(container.querySelectorAll('.badge-reason'));
    expect(badges.map((b) => b.textContent)).toEqual(['KILLED', 'REMOVED']);
    expect(badges[0]?.className).toBe('badge-reason killed');
    expect(badges[1]?.className).toBe('badge-reason');
  });

  it('says PRE-COUNTERS rather than inventing zeros for an old session', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ removed: { count: 1, costUsd: null } })],
    });
    hoisted.getOrchestratorCost.mockResolvedValue({
      sessions: [sessionCost({ id: 'old', name: 'OLD-WORKER', tokens: null, costUsd: null })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    // The team line already warns that the share cannot be attributed.
    expect(teamCell(teamRow(container), '.mon-costs-removed'))
      .toBe('INCL. 1 REMOVED · —');

    fireEvent.click(teamRow(container));
    await waitFor(() => expect(container.querySelector('.mon-costs-sess')).toBeTruthy());
    const sessRow = container.querySelector('.mon-costs-sess') as HTMLElement;
    expect(sessRow.querySelector('.mon-costs-sess-tok')?.textContent)
      .toBe('PRE-COUNTERS SESSION — NO DATA');
    expect(sessRow.querySelector('.mon-costs-sess-cost')?.textContent).toBe('—');
  });

  it('re-reads the detail on every re-expand instead of caching it', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    hoisted.getOrchestratorCost.mockResolvedValue({ sessions: [sessionCost()] });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));

    fireEvent.click(teamRow(container));
    await waitFor(() => expect(container.querySelector('.mon-costs-sess')).toBeTruthy());
    fireEvent.click(teamRow(container));
    await waitFor(() => expect(container.querySelector('.mon-costs-sess')).toBeNull());
    fireEvent.click(teamRow(container));
    await waitFor(() => expect(hoisted.getOrchestratorCost).toHaveBeenCalledTimes(2));
  });

  it('shows a quiet state — not a toast — when the detail request fails', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    hoisted.getOrchestratorCost.mockRejectedValue(new Error('HTTP 500'));
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    fireEvent.click(teamRow(container));
    expect(await screen.findByText('— detail unavailable —')).toBeTruthy();
    expect(container.querySelector('.toast')).toBeNull();
  });

  it('folds the body away while keeping the header on screen', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /TEAM COSTS/ }));
    expect(container.querySelector('.mon-costs-body')).toBeNull();
    expect(screen.getByText('TEAM COSTS')).toBeTruthy();
    expect(container.querySelector('.mon-costs-sum')?.textContent).toBe('Σ $50.07 EST');
  });

  it('does not poll /metrics/costs while the page is closed', async () => {
    render(<MonitoringPage open={false} onClose={() => undefined} />);
    await waitFor(() => expect(hoisted.getMetricsCosts).not.toHaveBeenCalled());
  });
});

describe('MONITORING · BURN /H KPI', () => {
  it('sums the team rates the server can measure', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'o1', burnPerHour: 1.84 }),
        teamCost({ orchId: 'o2', name: 'NOVA', burnPerHour: 0.16 }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(burnKpi(container)).toBe('$2.00'));
  });

  it('prefixes ≥ when a team has no measurable rate yet', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'o1', burnPerHour: 1.84 }),
        teamCost({ orchId: 'o2', name: 'NOVA', burnPerHour: null }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(burnKpi(container)).toBe('≥$1.84'));
    expect(container.querySelector('.mon-kpi-burn')?.getAttribute('title'))
      .toMatch(/lower bound/i);
  });

  it('renders the em-dash — not $0.00 — with no endpoint at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.getMetricsCosts.mockRejectedValue(new Error('HTTP 404'));
    const { container } = renderPage();
    await waitFor(() => expect(hoisted.getMetricsCosts).toHaveBeenCalled());
    expect(burnKpi(container)).toBe('—');
    warn.mockRestore();
  });
});

// ── Lot 13 · SORT control, cost basis, quota chip ───────────────────────────

const agentNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.mon-agent-name')).map((n) => n.textContent);

describe('MONITORING · SORT control', () => {
  const mixed = () => [orch([
    sess({
      id: 'hot', name: 'HOT',
      contextUsage: { ...sess().contextUsage!, pct: 0.94 },
      tokenUsage: tokens({ costUsd: 0.1 }),
    }),
    sess({
      id: 'rich', name: 'RICH',
      contextUsage: { ...sess().contextUsage!, pct: 0.1 },
      tokenUsage: tokens({ costUsd: 90 }),
    }),
    sess({
      id: 'blind', name: 'BLIND', provider: 'gemini',
      contextUsage: null, tokenUsage: undefined,
    }),
  ])];

  it('opens on CTX, with COST offered next to it', () => {
    renderPage();
    const ctx = screen.getByRole('button', { name: 'CTX' });
    const cost = screen.getByRole('button', { name: 'COST' });
    expect(ctx.getAttribute('aria-pressed')).toBe('true');
    expect(cost.getAttribute('aria-pressed')).toBe('false');
  });

  it('re-ranks the table by cost desc, unpriced agents last', () => {
    hoisted.orchestrators = mixed();
    const { container } = renderPage();
    expect(agentNames(container)).toEqual(['HOT', 'RICH', 'BLIND']);

    fireEvent.click(screen.getByRole('button', { name: 'COST' }));
    expect(agentNames(container)).toEqual(['RICH', 'HOT', 'BLIND']);
    expect(screen.getByRole('button', { name: 'COST' }).getAttribute('aria-pressed'))
      .toBe('true');
  });

  it('goes back to context pressure on CTX', () => {
    hoisted.orchestrators = mixed();
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'COST' }));
    fireEvent.click(screen.getByRole('button', { name: 'CTX' }));
    expect(agentNames(container)).toEqual(['HOT', 'RICH', 'BLIND']);
  });

  it('keeps the open history band pointed at the same agent across a re-sort', async () => {
    // The band is looked up by session id, not by row index — flipping the
    // ranking under it must not re-target it at whatever now sits in slot 0.
    hoisted.orchestrators = mixed();
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    fireEvent.click(screen.getByRole('button', { name: 'COST' }));
    expect(screen.getByLabelText(/^Context history — /i).textContent).toContain('HOT');
  });
});

describe('MONITORING · cost basis', () => {
  it('suffixes a provider-reported amount RPT instead of EST', () => {
    hoisted.orchestrators = [orch([sess({
      provider: 'opencode',
      tokenUsage: tokens({ costUsd: 5.61, costBasis: 'reported' }),
    })])];
    const { container } = renderPage();
    const cell = container.querySelector('.mon-tok-cost');
    expect(cell?.textContent).toBe('$5.61 RPT');
    expect(cell?.getAttribute('title')).toBe('reported by the provider');
  });

  it('explains the estimate on the amount itself', () => {
    hoisted.orchestrators = [orch([sess({ tokenUsage: tokens() })])];
    const { container } = renderPage();
    const cell = container.querySelector('.mon-tok-cost');
    expect(cell?.textContent).toBe('$5.61 EST');
    expect(cell?.getAttribute('title')).toBe('estimated from catalogue rates');
  });
});

describe('MONITORING · PROVIDER QUOTA chip', () => {
  const quota = (over = {}) => ({
    usedPercent: 62, resetsAt: '2026-08-30T18:00:00.000Z', plan: 'pro', ...over,
  });
  const quotaLines = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.mon-quota-line'));

  it('stays out of the sidebar entirely when nothing reports one', () => {
    const { container } = renderPage();
    expect(container.querySelector('.mon-quota')).toBeNull();
    expect(screen.queryByText('PROVIDER QUOTA')).toBeNull();
  });

  it('renders ONE line for the account, however many agents draw on it', () => {
    // Staggered per-session reads of one codex account: 58/62/65 % are three
    // readings of one budget, not three budgets. The freshest (highest) wins.
    hoisted.orchestrators = [orch([
      sess({ id: 'c1', name: 'C1', provider: 'codex', providerQuota: quota({ usedPercent: 58 }) }),
      sess({ id: 'c2', name: 'C2', provider: 'codex', providerQuota: quota({ usedPercent: 65 }) }),
      sess({ id: 'c3', name: 'C3', provider: 'codex', providerQuota: quota({ usedPercent: 62 }) }),
      sess({ id: 'c4', name: 'C4', provider: 'claude' }),
    ])];
    const { container } = renderPage();
    expect(screen.getByText('PROVIDER QUOTA')).toBeTruthy();
    const lines = quotaLines(container);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toMatch(/^CODEX · 65% USED · RESETS \d\d:\d\d · PRO$/);
  });

  it('carries the account-wide claim to assistive tech, not only to a hover', () => {
    hoisted.orchestrators = [orch([
      sess({ provider: 'codex', providerQuota: quota() }),
    ])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-quota')?.getAttribute('role')).toBe('group');
    expect(quotaLines(container)[0]?.getAttribute('aria-label'))
      .toContain('shared across every codex agent');
  });

  it('names it an ACCOUNT quota in the native title', () => {
    hoisted.orchestrators = [orch([
      sess({ provider: 'codex', providerQuota: quota() }),
    ])];
    const { container } = renderPage();
    expect(quotaLines(container)[0]?.getAttribute('title'))
      .toBe('codex account quota — shared across every codex agent');
  });

  it('tints the percentage warn past 80 and bad past 95', () => {
    // `.mon-quota-val` 0 is the provider, 1 is the percentage — the only
    // segment the chip is ever allowed to colour.
    const tintOf = (container: HTMLElement) => {
      const vals = container.querySelectorAll<HTMLElement>('.mon-quota-line .mon-quota-val');
      expect(vals[1]?.textContent).toMatch(/% USED$/);
      return vals[1]?.style.color;
    };

    hoisted.orchestrators = [orch([
      sess({ provider: 'codex', providerQuota: quota({ usedPercent: 62 }) }),
    ])];
    expect(tintOf(renderPage().container)).toBe('');

    hoisted.orchestrators = [orch([
      sess({ provider: 'codex', providerQuota: quota({ usedPercent: 84 }) }),
    ])];
    expect(tintOf(renderPage().container)).toBe('var(--warn)');

    hoisted.orchestrators = [orch([
      sess({ provider: 'codex', providerQuota: quota({ usedPercent: 97 }) }),
    ])];
    expect(tintOf(renderPage().container)).toBe('var(--bad)');
  });

  it('omits the segments the provider did not report', () => {
    hoisted.orchestrators = [orch([
      sess({
        provider: 'codex',
        providerQuota: quota({ resetsAt: null, plan: null }),
      }),
    ])];
    const { container } = renderPage();
    expect(quotaLines(container)[0]?.textContent).toBe('CODEX · 62% USED');
  });

  it('follows the table filter — a quota nobody on screen draws from is gone', () => {
    // ACTIVE ONLY is on by default: the terminated codex agent is out of the
    // table, so the account it was billing is out of the chip too.
    hoisted.orchestrators = [orch([
      sess({ id: 'live', name: 'LIVE', provider: 'claude' }),
      sess({
        id: 'dead', name: 'DEAD', provider: 'codex', status: 'exited',
        endedAt: '2026-08-30T09:30:00.000Z', providerQuota: quota(),
      }),
    ])];
    const { container } = renderPage();
    expect(container.querySelector('.mon-quota')).toBeNull();
  });

  it('ignores a dead agent\'s stale quota even with ACTIVE ONLY off', () => {
    // Unticking ACTIVE ONLY is a request to see terminated AGENTS, not a
    // request to be told that a three-day-old percentage and an elapsed reset
    // time are the account's current budget.
    hoisted.orchestrators = [orch([
      sess({ id: 'live', name: 'LIVE', provider: 'codex', providerQuota: quota({ usedPercent: 62 }) }),
      sess({
        id: 'dead', name: 'DEAD', provider: 'codex', status: 'exited',
        endedAt: '2026-08-30T09:30:00.000Z',
        providerQuota: quota({ usedPercent: 91 }),
      }),
    ])];
    const { container } = renderPage();
    fireEvent.click(screen.getByLabelText('ACTIVE ONLY', { selector: 'input' }));
    expect(container.querySelectorAll('.mon-table tbody tr')).toHaveLength(2);
    const lines = quotaLines(container);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain('62% USED');
  });
});

// ── Lot 14 · OVER BUDGET badges ─────────────────────────────────────────────
//
// The badge is the page's half of a guard rail the SERVER enforces, so the
// only thing it may ever do is repeat the server's verdict. Three states, and
// only one of them draws anything: flagged, not flagged, and no budget at all
// (a role without one, or a server predating Lot 14 — indistinguishable here,
// deliberately).

const budgetBadges = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.badge-budget'));

describe('MONITORING · OVER BUDGET badge', () => {
  it('badges the team row the server flagged', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ budget: { usd: 50, action: 'pause', exceeded: true } })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));

    const badge = teamRow(container).querySelector('.badge-budget');
    expect(badge?.textContent).toBe('OVER BUDGET');
    // Inside the name cell, so the six-track grid keeps its columns.
    expect(teamCell(teamRow(container), '.mon-costs-name')).toBe('ATLAS');
  });

  it('carries the pair and the consequence on the TOTAL cell', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({
        total: { ...teamCost().total, costUsd: 52.1 },
        budget: { usd: 50, action: 'pause', exceeded: true },
      })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));

    const total = teamRow(container).querySelector('.mon-costs-total');
    // The amount itself is unchanged — no invented tint, no cramped pair.
    expect(total?.textContent).toBe('$52.10');
    expect(total?.getAttribute('title'))
      .toBe('$52.10 / $50.00 — budget exceeded · TEAM PAUSED');
  });

  it('draws nothing for a team under its budget', async () => {
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ budget: { usd: 500, action: 'notify', exceeded: false } })],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    expect(budgetBadges(container)).toHaveLength(0);
    expect(teamRow(container).querySelector('.mon-costs-total')?.getAttribute('title'))
      .toBeNull();
  });

  it('draws nothing when the server sends no budget at all', async () => {
    // A role with no ceiling and a server predating Lot 14 are the same page.
    hoisted.getMetricsCosts.mockResolvedValue({ teams: [teamCost()] });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(1));
    expect(budgetBadges(container)).toHaveLength(0);
  });

  it('repeats the badge on every agent row of that team, beside the status', async () => {
    hoisted.orchestrators = [orch([
      sess({ id: 's1', name: 'A1' }),
      sess({ id: 's2', name: 'A2' }),
    ])];
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [teamCost({ orchId: 'o1', budget: { usd: 50, action: 'pause', exceeded: true } })],
    });
    const { container } = renderPage();
    await waitFor(() =>
      expect(container.querySelectorAll('.mon-table tbody .badge-budget')).toHaveLength(2));

    // Third cell = STATUS: the badge sits with the chip that says whether the
    // agent may run, not with the name that says who it is.
    const cells = container.querySelectorAll('.mon-table tbody tr:first-child td');
    expect(cells[2]?.querySelector('.badge-budget')).toBeTruthy();
    expect(cells[2]?.querySelector('.badge-budget')?.getAttribute('title'))
      .toBe('ATLAS has exceeded its cost budget');
  });

  it('badges no agent of a team that is not over budget', async () => {
    hoisted.orchestrators = [orch([sess({ id: 's1', name: 'A1' })])];
    hoisted.getMetricsCosts.mockResolvedValue({
      teams: [
        teamCost({ orchId: 'other', name: 'NOVA', budget: { usd: 5, action: 'pause', exceeded: true } }),
        teamCost({ orchId: 'o1', budget: { usd: 500, action: 'notify', exceeded: false } }),
      ],
    });
    const { container } = renderPage();
    await waitFor(() => expect(teamRows(container)).toHaveLength(2));
    // NOVA's row is badged; the agent table (all of it team `o1`) is not.
    expect(budgetBadges(container)).toHaveLength(1);
    expect(container.querySelectorAll('.mon-table tbody .badge-budget')).toHaveLength(0);
  });
});

describe('MONITORING · cost in the history band header', () => {
  it('follows the current context reading with the cumulative spend', async () => {
    hoisted.orchestrators = [orch([sess({ tokenUsage: tokens({ costUsd: 5.61 }) })])];
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    const now = container.querySelector('.mon-hist-now') as HTMLElement;
    // The `·` is drawn by CSS (`.mon-hist-now-cost::before`) so the flex gap
    // sits on one side of it and a margin on the other; the DOM text is the
    // amount alone, right after the context pair.
    expect(now.textContent).toBe('70%140K/200K$5.61');
    expect(container.querySelector('.mon-hist-now-cost')?.textContent).toBe('$5.61');
    expect(container.querySelector('.mon-hist-now-cost')?.getAttribute('title'))
      .toMatch(/cumulative spend — estimated from catalogue rates/);
  });

  it('adds nothing at all when the agent carries no priced spend', async () => {
    hoisted.orchestrators = [orch([sess({ tokenUsage: tokens({ costUsd: null }) })])];
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    expect(container.querySelector('.mon-hist-now-cost')).toBeNull();
    expect((container.querySelector('.mon-hist-now') as HTMLElement).textContent)
      .toBe('70%140K/200K');
  });

  it('says RPT in the tooltip when the provider reported the amount', async () => {
    hoisted.orchestrators = [orch([sess({
      tokenUsage: tokens({ costUsd: 5.61, costBasis: 'reported' }),
    })])];
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('CONTEXT HISTORY');
    expect(container.querySelector('.mon-hist-now-cost')?.getAttribute('title'))
      .toBe('cumulative spend — reported by the provider');
  });
});

// ── EXPORT block (Lot 15) ───────────────────────────────────────────────────
//
// The one control on this page that produces a FILE. What matters is the pair
// of outcomes: a click either puts the server's document on the operator's
// disk under a name they can tell from the next one, or it says why it could
// not. The failure mode this whole design exists to avoid — a link that opens
// an unauthenticated tab onto a 404 — must never be reachable, so the button
// is a button and both branches are pinned here.

describe('MONITORING · EXPORT block', () => {
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let downloads: string[];
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    downloads = [];
    URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    // Spied rather than let through: a real anchor click would try to
    // navigate the test document.
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      },
    );
  });

  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    clickSpy.mockRestore();
  });

  const exportBtn = (label: 'CSV' | 'JSON') =>
    Array.from(document.querySelectorAll('.mon-export-btn'))
      .find((b) => b.textContent === label) as HTMLButtonElement;

  it('offers one row of two formats under an EXPORT label', () => {
    const { container } = renderPage();
    const block = container.querySelector('.mon-export') as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.querySelector('.board-label')?.textContent).toBe('EXPORT');
    expect(block.querySelector('.mon-export-what')?.textContent).toBe('COSTS 30D');
    expect(Array.from(block.querySelectorAll('.mon-export-btn')).map((b) => b.textContent))
      .toEqual(['CSV', 'JSON']);
  });

  it('points at the 90-day ceiling in the title, since no control does', () => {
    renderPage();
    expect(exportBtn('CSV').getAttribute('title'))
      .toBe('daily cost rows, last 30 days (?days=90 for more)');
  });

  it('CSV asks for 30 days and saves a dated .csv', async () => {
    renderPage();
    fireEvent.click(exportBtn('CSV'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(hoisted.exportCosts).toHaveBeenCalledWith('csv', 30);
    expect(downloads[0]).toMatch(/^swarm-costs-\d{4}-\d{2}-\d{2}\.csv$/);
    // A successful export is silent: the file appearing IS the feedback.
    expect(hoisted.pushNotice).not.toHaveBeenCalled();
  });

  it('JSON saves the same window under the other extension', async () => {
    hoisted.exportCosts.mockResolvedValue('{"days":30,"rows":[]}');
    renderPage();
    fireEvent.click(exportBtn('JSON'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(hoisted.exportCosts).toHaveBeenCalledWith('json', 30);
    expect(downloads[0]).toMatch(/^swarm-costs-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('a 404 says the server is too old — and saves NOTHING', async () => {
    hoisted.exportCosts.mockRejectedValue(
      new HttpError('HTTP 404 GET /metrics/costs/export', 404, undefined),
    );
    renderPage();
    fireEvent.click(exportBtn('CSV'));
    await waitFor(() => expect(hoisted.pushNotice).toHaveBeenCalled());
    expect(hoisted.pushNotice).toHaveBeenCalledWith(
      'error',
      'EXPORT UNAVAILABLE — server too old',
      undefined,
    );
    // No empty file, no blank tab: the two things a link would have produced.
    expect(downloads).toHaveLength(0);
  });

  it('any OTHER failure carries the server’s own words instead', async () => {
    hoisted.exportCosts.mockRejectedValue(
      new HttpError('HTTP 500 GET /metrics/costs/export', 500, { error: 'db locked' }),
    );
    renderPage();
    fireEvent.click(exportBtn('JSON'));
    await waitFor(() => expect(hoisted.pushNotice).toHaveBeenCalled());
    const [kind, title, body] = hoisted.pushNotice.mock.calls[0] as [string, string, string];
    expect(kind).toBe('error');
    // NOT "server too old": a 500 is a malfunction, and telling the operator
    // to upgrade would send them away from the reason.
    expect(title).toBe('EXPORT FAILED');
    expect(body).toContain('db locked');
    expect(downloads).toHaveLength(0);
  });

  it('disables the pair while one export is in flight', async () => {
    let release: (v: string) => void = () => undefined;
    hoisted.exportCosts.mockReturnValue(new Promise<string>((res) => { release = res; }));
    renderPage();
    fireEvent.click(exportBtn('CSV'));
    await waitFor(() => expect(exportBtn('JSON').disabled).toBe(true));
    expect(exportBtn('CSV').disabled).toBe(true);
    // A second click while disabled must not queue a second request.
    fireEvent.click(exportBtn('CSV'));
    expect(hoisted.exportCosts).toHaveBeenCalledTimes(1);
    release('day\n');
    await waitFor(() => expect(exportBtn('CSV').disabled).toBe(false));
  });
});

// ── API CALLS strip (per-call ledger) ──────────────────────────────────────

describe('MONITORING · API CALLS strip in the agent band', () => {
  it('fetches nothing until a row is clicked, then the default 24H window', async () => {
    const { container } = renderPage();
    expect(hoisted.sessionCalls).not.toHaveBeenCalled();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText('API CALLS')).toBeTruthy();
    expect(hoisted.sessionCalls).toHaveBeenCalledWith('s1', '24h');
  });

  it('draws one stacked bar per call and the context line over them', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await waitFor(() => expect(container.querySelectorAll('.mon-calls-bar')).toHaveLength(2));
    const strip = screen.getByLabelText('API calls');
    const firstBar = strip.querySelector('.mon-calls-bar') as Element;
    // NEW IN / CACHE WRITE / CACHE READ / OUTPUT, bottom to top.
    expect(Array.from(firstBar.querySelectorAll('rect')).map((r) => r.getAttribute('class'))).toEqual([
      'mon-calls-seg-input', 'mon-calls-seg-cacheWrite', 'mon-calls-seg-cacheRead', 'mon-calls-seg-output',
    ]);
    expect(strip.querySelector('.mon-calls-context')).toBeTruthy();
    expect(strip.textContent).toContain('2 CALLS');
    expect(strip.textContent).toContain('PERSISTED · 14 DAYS · CLAUDE ONLY');
  });

  it('refetches on its own window selector, which offers 14D', async () => {
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    await screen.findByText('API CALLS');
    const seg = screen.getByRole('group', { name: 'calls window' });
    fireEvent.click(within(seg).getByRole('button', { name: '14D' }));
    await waitFor(() => expect(hoisted.sessionCalls).toHaveBeenCalledWith('s1', '14d'));
  });

  it('says it when the server folded the window into buckets', async () => {
    hoisted.sessionCalls.mockResolvedValue(calls({ aggregated: true, bucketMs: 300_000 }));
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText(/5 MIN BUCKETS · BAR = MEAN CALL/)).toBeTruthy();
  });

  it('does not ask for a non-claude agent', async () => {
    hoisted.orchestrators = [orch([sess({ provider: 'codex' })])];
    const { container } = renderPage();
    fireEvent.click(firstRow(container));
    expect(await screen.findByText('— CLAUDE AGENTS ONLY —')).toBeTruthy();
    expect(hoisted.sessionCalls).not.toHaveBeenCalled();
  });
});

// ── CALL USAGE panel ───────────────────────────────────────────────────────

describe('MONITORING · CALL USAGE panel', () => {
  it('opens on every team, per hour over 24H, lead and workers stacked', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(hoisted.getMetricsCallUsage).toHaveBeenCalledWith('24h', 'hour'));
    await waitFor(() => expect(container.querySelectorAll('.mon-callusage-workers')).toHaveLength(3));
    expect(container.querySelectorAll('.mon-callusage-lead')).toHaveLength(2);
    const panel = screen.getByLabelText('Call usage');
    expect(panel.textContent).toContain('LEAD 6 CALLS');
    expect(panel.textContent).toContain('WORKERS 15 CALLS');
  });

  it('switches to one team from the selector or a team chip', async () => {
    renderPage();
    const chip = await screen.findByRole('button', { name: /ATLAS\s*21/ });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(hoisted.getOrchestratorCallUsage).toHaveBeenCalledWith('o1', '24h', 'hour'));
  });

  it('asks for 5-minute buckets on the 1H window', async () => {
    renderPage();
    const seg = await screen.findByRole('group', { name: 'call usage window' });
    fireEvent.click(within(seg).getByRole('button', { name: '1H' }));
    await waitFor(() => expect(hoisted.getMetricsCallUsage).toHaveBeenCalledWith('1h', '5m'));
  });

  it('does not poll while the page is closed', () => {
    render(<MonitoringPage open={false} onClose={() => undefined} />);
    expect(hoisted.getMetricsCallUsage).not.toHaveBeenCalled();
  });
});

describe('MONITORING · gauge after a reset (v0.10.3)', () => {
  it('shows the reset state — never the old figure — until the next call', () => {
    hoisted.orchestrators = [orch([sess({
      contextUsage: {
        usedTokens: null, limitTokens: 200_000, pct: null, basis: 'transcript',
        updatedAt: '2026-08-30T10:00:00.000Z', stale: true, awaitingCall: 'compact',
      },
    })])];
    const { container } = renderPage();
    const row = firstRow(container);
    expect(row.textContent).toContain('COMPACTED · NEXT CALL');
    expect(row.textContent).not.toContain('STALE');
    expect(row.querySelector('.mon-ctx-pct')?.textContent).toBe('—');
    expect(row.querySelector('.mon-ctx-tokens')).toBeNull();
  });
});
