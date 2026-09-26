// packages/web/src/components/MonitoringPage.tsx
//
// Per-agent monitoring overlay (`#/monitoring`) — docs/monitoring-agents.md,
// Lot 5.
//
// Layout (structural clone of ApprovalsPage / BoardPage):
//
//   ┌──────────────┬──────────────────────────────────────────────────────┐
//   │ .mon-side    │ .mon-main                                            │
//   │  team select │  KPI band (CPU + MEMORY gauges, then 6 cells)        │
//   │  ctx counts  │  CONTEXT HISTORY band (only with a row selected)     │
//   │  quota chip  │  agent table, ranked by CTX or COST desc             │
//   │  ACTIVE ONLY │   AGENT · PROVIDER · STATUS · CONTEXT · SPARK ·      │
//   │  SORT CTX/$  │   TOKENS·COST · MSGS · INBOX · LAST ACT · UPTIME ·   │
//   │              │   COMPACT/CLEAR                                      │
//   └──────────────┴──────────────────────────────────────────────────────┘
//
// Data: ZERO polling of its own for the table. Every field it shows —
// context usage, its ~20-point SPARK series, cumulative token spend and its
// estimated cost, inbox depth, messages processed, armed reset — rides on
// the `/orchestrators` snapshot the
// controller already polls every 3 s and hands out through
// `useSwarmController()`. Only three network calls exist here and all are
// gated: the message-flow metric behind the MESSAGES/MIN KPI (by `open`),
// the container CPU/memory behind the two arc gauges (by `open` too — Lot
// 10), and the context history behind the band (by the band being mounted at
// all — Lot 9).
//
// Writes: `onContextReset(sessionId, cmd)` — the controller callback that is
// deliberately DECOUPLED from the current selection, because every row here
// is actionable and the selected agent is usually somewhere else entirely.

import { useEffect, useMemo, useState } from 'react';
import { useSwarmController } from '../controller/SwarmController';
import { api, apiErrorMessage, HttpError, type CostExportFormat } from '../api/client';
import ConfirmModal from './desktop/ConfirmModal';
import Sparkline from './desktop/Sparkline';
import ContextHistoryBand from './ContextHistoryBand';
import SystemGauge from './SystemGauge';
import TeamCostsSection from './TeamCostsSection';
import CallUsagePanel from './CallUsagePanel';
import { ICON } from './desktop/icons';
import {
  formatRelative, formatUptime, statusChipClass, statusLabel,
} from '../lib/format';
import {
  contextBarWidth, contextColorVar, contextLevel,
  formatContextPercent, formatContextTokens, CONTEXT_PLACEHOLDER,
  CONTEXT_RESET_TITLE, contextResetTag,
} from '../lib/contextPercent';
import {
  AGENT_SORT_OPTIONS, buildAgentContextRows, sortAgentRows,
  type AgentContextRow, type AgentSortKey,
} from '../lib/agentContext';
import {
  aggregateCostUsd, costBasisTitle, formatCostKpi, formatCostLine,
  formatTokenIoLine, tokenBreakdownTitle,
} from '../lib/tokenCost';
import { providerQuotaLines } from '../lib/providerQuota';
import { overBudgetTeamIds, OVER_BUDGET_BADGE } from '../lib/budget';
import { cpuSubLabel, memorySubLabel } from '../lib/systemGauge';
import { COST_EXPORT_DAYS, COST_EXPORT_TITLE, saveCostExport } from '../lib/costExport';
import { useMessageFlow } from '../lib/leftPanelAdapters';
import { useSystemMetrics } from '../hooks/useSystemMetrics';
import { useTeamCosts } from '../hooks/useTeamCosts';
import { useNow } from '../lib/useNow';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Sentinel for the "no team filter" option of the TEAM select. */
const ALL_TEAMS = '';

export function MonitoringPage({ open, onClose }: Props) {
  const {
    orchestrators, onContextReset, selectAgent, pushNotice,
  } = useSwarmController();

  const [teamFilter, setTeamFilter] = useState<string>(ALL_TEAMS);
  // ON by default: a long-running instance accumulates dozens of terminated
  // sessions that carry no telemetry at all (nothing is serialised for them),
  // and they would push the agents that DO matter off the first screen.
  const [activeOnly, setActiveOnly] = useState(true);
  // Lot 13 — CTX or COST, page-local and defaulting to CTX. Not persisted:
  // context pressure is the question this page exists to answer first (an
  // agent about to overflow needs an action NOW, a dear agent needs a
  // decision later), so every visit opens on it.
  const [sort, setSort] = useState<AgentSortKey>('ctx');
  const [confirmClear, setConfirmClear] = useState<AgentContextRow | null>(null);
  // Lot 15 — the format whose export is in flight, or `null`. Not a boolean:
  // it both disables the pair (one download at a time, so a double click
  // cannot save the same window twice) and says WHICH button is working.
  const [exporting, setExporting] = useState<CostExportFormat | null>(null);
  // Session whose CONTEXT HISTORY band is open, or `null` for none. An ID
  // rather than a row snapshot: the row is re-derived from every 3 s poll, so
  // the band's header stays live instead of freezing the reading it opened on.
  const [historyId, setHistoryId] = useState<string | null>(null);

  // Drives the UPTIME column. 1 s so the counter reads like a clock rather
  // than jumping in five-second steps next to a live console — but ONLY while
  // the page is open. Hooks cannot be called conditionally and this overlay
  // is always mounted, so a flat `useNow(1_000)` would re-render a
  // null-rendering component once a second behind every other screen; the
  // long interval is the same gate `enabled` gives the polling hooks.
  const now = useNow(open ? 1_000 : 3_600_000);

  // The ONE network poll this page adds — gated by `open`, same idiom as
  // `useApprovals(orchId, 5000, open)`. The overlay is always mounted (it
  // renders null while closed), so without the gate it would poll forever in
  // the background of every other screen.
  //
  // `'s9-server'` rather than the LeftPanel's `'s4-client'`, for two reasons:
  // the server's `/metrics/messages` aggregate is authoritative and correct
  // on the FIRST render, whereas the client ring buffer starts at zero and
  // only produces a rate after a full 60 s tick (and resets on every reload)
  // — a monitoring KPI that reads 0/min for a minute is worse than useless.
  // And it means the request we just paid for is actually consumed: under
  // `'s4-client'` the hook still mounts the poll and then discards its
  // result. When the backend has no such endpoint the hook keeps returning
  // null and `useMessageFlow` falls back to the client-side count.
  const flow = useMessageFlow(orchestrators, 's9-server', open);

  // Lot 10 — container CPU / memory, same 3 s cadence as the controller's
  // `/orchestrators` poll and gated on `open` for the same reason as `flow`
  // above. This is host-level telemetry, not per-agent: it answers "is the
  // box the swarm runs on the thing that is struggling?", which no amount of
  // context percentages can. `null` (older server, unreadable cgroups) leaves
  // both gauges at `—`; nothing here fabricates a reading.
  const system = useSystemMetrics(3_000, open);

  // Lot 12 — cost per team, straight from the DB (removed workers included),
  // so it is deliberately NOT derived from `orchestrators` like everything
  // else on this page: an agent that was killed an hour ago is not in that
  // snapshot and its spend is still on the bill. 15 s rather than 3 s because
  // these are cumulative aggregates that move slowly, and one request feeds
  // both the BURN /H cell below and the TEAM COSTS section under the band.
  const costs = useTeamCosts(15_000, open);

  // A confirm modal must not survive the page being closed: the row it holds
  // is a snapshot, and reopening `#/monitoring` later would resurrect a CLEAR
  // dialog for an agent the operator is no longer even looking at. Same for
  // the history band — and closing it also stops its 30 s poll, which is the
  // whole point of gating the request on the band being open.
  useEffect(() => {
    if (!open) {
      setConfirmClear(null);
      setHistoryId(null);
    }
  }, [open]);

  const allRows = useMemo(
    () => buildAgentContextRows(orchestrators),
    [orchestrators],
  );

  // Teams offered by the filter, following the ACTIVE ONLY toggle: with it
  // off the table shows terminated sessions, so their teams must be
  // selectable too — otherwise an ended team is visible under ALL TEAMS but
  // impossible to isolate.
  const selectableOrchestrators = useMemo(
    () => (activeOnly ? orchestrators.filter((o) => o.endedAt == null) : orchestrators),
    [orchestrators, activeOnly],
  );

  // The applied filter is DERIVED, never stored-and-reconciled. A team can
  // end (or be hidden) at any 3 s poll while it is the current filter; a
  // `<select>` whose value has no matching `<option>` renders blank, and the
  // table would keep filtering on a team the operator can no longer see
  // selected — visible state and applied state silently disagreeing. Falling
  // back to ALL TEAMS during render makes that impossible by construction.
  const effectiveTeam = useMemo(
    () => (
      teamFilter === ALL_TEAMS
      || selectableOrchestrators.some((o) => o.id === teamFilter)
        ? teamFilter
        : ALL_TEAMS
    ),
    [teamFilter, selectableOrchestrators],
  );

  // WHICH agents are on screen, before deciding in what ORDER. Split from the
  // ranking below so that flipping SORT — which changes the order and nothing
  // else — cannot invalidate the KPI aggregates or the quota chip derived
  // from this set. (It also keeps the EST. COST Σ summing its addends in one
  // fixed order, rather than in whichever order the table happens to be in.)
  const filtered = useMemo(
    () => allRows.filter((r) => {
      if (effectiveTeam !== ALL_TEAMS && r.teamId !== effectiveTeam) return false;
      if (activeOnly && !r.active) return false;
      return true;
    }),
    [allRows, effectiveTeam, activeOnly],
  );

  const rows = useMemo(() => sortAgentRows(filtered, sort), [filtered, sort]);

  // Lot 13 — the provider ACCOUNT quotas backing the agents on screen,
  // collapsed to one line per account. Derived from the filtered rows rather
  // than from every orchestrator, so the chip describes what the operator is
  // actually looking at and disappears on a claude-only team.
  //
  // LIVE agents only, whatever ACTIVE ONLY says: a worker killed three days
  // ago still carries the last quota it ever read, and a three-day-old
  // percentage next to an already-elapsed reset time would be rendered
  // identically to a current one. An account budget has no "including dead
  // agents" version.
  const quotas = useMemo(
    () => providerQuotaLines(filtered.filter((r) => r.active)),
    [filtered],
  );

  // ── sidebar buckets + KPI band ────────────────────────────────────────
  const stats = useMemo(() => {
    let ok = 0, warn = 0, high = 0, noTelemetry = 0, armed = 0;
    let inboxSum = 0, inboxKnown = 0;
    let maxPct: number | null = null;
    let pctSum = 0, pctCount = 0;
    let activeAgents = 0;
    for (const r of rows) {
      if (r.active) activeAgents += 1;
      if (r.resetPending) armed += 1;
      if (r.inbox !== null) { inboxSum += r.inbox; inboxKnown += 1; }
      const level = contextLevel(r.pct);
      if (level === null) {
        noTelemetry += 1;
        continue;
      }
      const pct = r.pct as number;
      if (level === 'ok') ok += 1;
      else if (level === 'warn') warn += 1;
      else high += 1;
      maxPct = maxPct === null ? pct : Math.max(maxPct, pct);
      pctSum += pct;
      pctCount += 1;
    }
    // Lot 11 — Σ of the estimated costs of the agents ON SCREEN, so the KPI
    // always answers the question the current filter asked ("what is this
    // team costing me?"), never a different one. Agents whose cost we cannot
    // see are counted as unknown, which is what flips the total to `≥`: a
    // bare number next to a gemini agent would quietly under-report the bill.
    const cost = aggregateCostUsd(rows.map((r) => r.tokens?.costUsd ?? null));
    return {
      ok, warn, high, noTelemetry, armed,
      maxPct, activeAgents, cost,
      // `null` when NOT ONE row reported a queue depth — a backend predating
      // Lot 1 omits the field entirely, and a bold `0` backlog there would be
      // a fabricated reassurance. A partial rollout still sums what it knows.
      inboxTotal: inboxKnown > 0 ? inboxSum : null,
      // Averaged over the agents we can actually SEE. Folding the
      // untelemetered ones in as zeros would drag the mean down and read as
      // "the swarm has plenty of headroom" when half of it is simply unread.
      avgPct: pctCount > 0 ? pctSum / pctCount : null,
    };
  }, [rows]);

  // Lot 12 — what the swarm is burning right now, Σ of the per-team rates.
  // Same aggregate machinery as EST. COST, because it is the same statement
  // about a sum with unknown addends: a team whose cost ring holds fewer than
  // two points cannot be rated, and its absence turns the total into a lower
  // bound (`≥`) rather than a number that quietly under-reports.
  //
  // It deliberately ignores the TEAM / ACTIVE ONLY filters, unlike every
  // other cell in this band: those filter the AGENT TABLE, while this figure
  // and the section under it come from the server's own team aggregate. The
  // question it answers ("what is this instance burning per hour") has no
  // filtered version — the money is spent either way.
  const burn = useMemo(
    () => aggregateCostUsd((costs?.teams ?? []).map((t) => t.burnPerHour)),
    [costs],
  );

  // Lot 14 — which teams are over budget, as a lookup the table can apply per
  // row. The table is built from `/orchestrators` and knows a session's
  // `teamId`; the verdict lives in the cost snapshot beside it, which is why
  // this is a join rather than another field on the row. Empty set on a
  // server predating Lot 14 — no badges, nothing else changes.
  const overBudget = useMemo(
    () => overBudgetTeamIds(costs?.teams),
    [costs],
  );

  // DERIVED, like `effectiveTeam` above: an agent can end, be filtered out or
  // vanish from the snapshot while its band is open. Looking the row up in the
  // rendered list every pass means the band can never outlive the row it
  // annotates (and never shows a stale copy of it).
  const historyRow = useMemo(
    () => rows.find((r) => r.sessionId === historyId) ?? null,
    [rows, historyId],
  );

  if (!open) return null;

  function fireReset(row: AgentContextRow, cmd: 'compact' | 'clear') {
    void onContextReset(row.sessionId, cmd);
  }

  // Lot 15 — fetch the daily cost table and save it. The whole point of doing
  // it here rather than through a link is that BOTH outcomes are handled: a
  // document reaches the disk, or the operator is told why it did not. A
  // plain `<a href>` would open an unauthenticated tab onto a 404 page.
  //
  // The two failures are reported differently on purpose. A 404 is not a
  // malfunction — it is a server predating this lot, and the fix is a deploy,
  // not a retry; anything else is a real error and the server's own words are
  // the useful part, so they go in the body verbatim.
  async function runExport(format: CostExportFormat) {
    if (exporting) return;
    setExporting(format);
    try {
      const text = await api.exportCosts(format, COST_EXPORT_DAYS);
      saveCostExport(text, format);
    } catch (err) {
      const tooOld = err instanceof HttpError && err.status === 404;
      pushNotice(
        'error',
        tooOld ? 'EXPORT UNAVAILABLE — server too old' : 'EXPORT FAILED',
        tooOld ? undefined : apiErrorMessage(err),
      );
    } finally {
      setExporting(null);
    }
  }

  return (
    <div
      className="board-overlay mon-overlay"
      role="dialog"
      aria-label="Monitoring"
    >
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="board-side mon-side">
        <div className="board-side-head">
          <span className="board-side-title">MONITORING</span>
          <button className="icon-btn" onClick={onClose} title="close">{ICON.kill}</button>
        </div>

        <div className="board-team-select">
          <label className="board-label" htmlFor="mon-team">TEAM</label>
          <select
            id="mon-team"
            className="board-select"
            value={effectiveTeam}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            <option value={ALL_TEAMS}>ALL TEAMS</option>
            {selectableOrchestrators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}{o.endedAt != null ? ' (ended)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="board-col-counts">
          <div className="board-count-row">
            <span className="mon-dot ok" />
            <span className="board-count-label">OK</span>
            <span className="board-count-num">{stats.ok}</span>
          </div>
          <div className="board-count-row">
            <span className="mon-dot warn" />
            <span className="board-count-label">WARN</span>
            <span className="board-count-num">{stats.warn}</span>
          </div>
          <div className="board-count-row">
            <span className="mon-dot bad" />
            <span className="board-count-label">HIGH</span>
            <span className="board-count-num">{stats.high}</span>
          </div>
          <div className="board-count-row">
            <span className="mon-dot armed" />
            <span className="board-count-label">RESET ARMED</span>
            <span className="board-count-num">{stats.armed}</span>
          </div>
          <div className="board-count-row">
            <span className="mon-dot none" />
            <span className="board-count-label">NO TELEMETRY</span>
            <span className="board-count-num">{stats.noTelemetry}</span>
          </div>
        </div>

        {/* PROVIDER QUOTA (Lot 13) — only when a displayed session actually
            reports one, so a claude-only swarm never sees an empty block.
            Under the context counts because it is the same kind of reading —
            a budget filling up — one level above the agent: the counts say
            how full the WINDOWS are, this says how full the ACCOUNT is. */}
        {quotas.length > 0 && (
          <div className="mon-quota" role="group" aria-label="Provider account quota">
            <div className="board-label">PROVIDER QUOTA</div>
            {quotas.map((q) => (
              // The `title` carries the account-wide claim for a mouse, and
              // `aria-label` carries it for everyone else: a `title` on a
              // non-focusable div is unreachable by keyboard and announced
              // inconsistently, and "this is the ACCOUNT's budget, not this
              // agent's" is the one thing the chip must not fail to say.
              <div
                className="mon-quota-line"
                key={q.key}
                title={q.title}
                aria-label={`${q.text} — ${q.title}`}
              >
                {q.segments.map((seg, i) => (
                  // Keyed by position: the segments are a fixed-length
                  // sequence, and their TEXT is provider-controlled (a plan
                  // named after its own provider would collide).
                  <span key={i}>
                    {i > 0 && <span className="mon-quota-sep"> · </span>}
                    <span
                      className="mon-quota-val"
                      style={seg.tint ? { color: seg.tint } : undefined}
                    >{seg.text}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="mon-side-opts">
          <label className="mon-toggle">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            <span>ACTIVE ONLY</span>
          </label>
          {/* SORT — the same `.seg` control as the history band's window
              picker, because it is the same gesture (pick one of N views of
              the data below). Both options are descending; a four-way
              asc/desc control would double the width for a question nobody
              asks ("which agent is cheapest?"). */}
          <div className="mon-side-sort">
            <span className="board-label">SORT</span>
            <div className="seg mon-sort-seg" role="group" aria-label="sort agents">
              {AGENT_SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={opt.key === sort ? 'on' : undefined}
                  aria-pressed={opt.key === sort}
                  title={opt.title}
                  onClick={() => setSort(opt.key)}
                >{opt.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* EXPORT (Lot 15) — under the VIEW controls because it is one step
            further out: those two change what is on SCREEN, this one takes
            what the server has been recording for weeks OFF the screen
            entirely. The rest of this page is a live instrument (nothing here
            survives a refresh); the daily table is the only durable record of
            what the swarm has cost, and a spreadsheet is where that question
            actually gets answered.

            One row, two formats, no options: the window is a query parameter
            away for anyone who needs 90 days (the `title` says so), and a
            second control for it would double the sidebar's controls for a
            once-a-quarter gesture. */}
        <div className="mon-export" role="group" aria-label="Export cost data">
          <div className="board-label">EXPORT</div>
          <div className="mon-export-row">
            <span className="mon-export-what">COSTS {COST_EXPORT_DAYS}D</span>
            <div className="mon-export-btns">
              {(['csv', 'json'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  className="mon-export-btn"
                  // The pair is disabled together: two concurrent downloads of
                  // the same window is never what a second click meant.
                  disabled={exporting !== null}
                  title={COST_EXPORT_TITLE}
                  onClick={() => { void runExport(format); }}
                >{format.toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* ── main ────────────────────────────────────────────────────────── */}
      <main className="mon-main">
        {/* Phone-only header: the sidebar (which carries the close button on
            desktop) is hidden below 820 px coarse-pointer, and an overlay you
            cannot close is a trap. */}
        <div className="mon-mobile-head">
          <span className="board-side-title">MONITORING</span>
          <button className="icon-btn" onClick={onClose} title="close">{ICON.kill}</button>
        </div>

        {/* KPI band — the two system gauges lead, then the five swarm cells.
            Order is the diagnostic order an operator actually reads in: the
            machine first (is the container out of CPU or memory?), then what
            the swarm on it is doing. On a phone the grid collapses to two
            columns and the gauges take the whole first row on their own. */}
        <div className="pr-stats mon-kpis">
          <SystemGauge
            label="CPU"
            pct={system?.cpu.pct ?? null}
            sub={cpuSubLabel(system?.cpu)}
            basis={system?.cpu.basis ?? null}
          />
          <SystemGauge
            label="MEMORY"
            pct={system?.memory.pct ?? null}
            sub={memorySubLabel(system?.memory)}
            basis={system?.memory.basis ?? null}
          />
          <div className="mon-kpi">
            <div className="v">{stats.activeAgents}</div>
            <div className="k">ACTIVE AGENTS</div>
          </div>
          <div className="mon-kpi">
            <div
              className="v"
              style={
                stats.inboxTotal !== null && stats.inboxTotal > 0
                  ? { color: 'var(--amber)' }
                  : undefined
              }
            >
              {stats.inboxTotal === null ? CONTEXT_PLACEHOLDER : stats.inboxTotal}
            </div>
            <div className="k">INBOX BACKLOG</div>
          </div>
          <div className="mon-kpi">
            <div className="v" style={{ color: contextColorVar(contextLevel(stats.maxPct)) }}>
              {formatContextPercent(stats.maxPct)}
            </div>
            <div className="k">MAX CONTEXT</div>
          </div>
          <div className="mon-kpi">
            <div className="v" style={{ color: contextColorVar(contextLevel(stats.avgPct)) }}>
              {formatContextPercent(stats.avgPct)}
            </div>
            <div className="k">AVG CONTEXT</div>
          </div>
          <div className="mon-kpi">
            <div className="v">{flow.perMinute}</div>
            <div className="k">MESSAGES /MIN</div>
          </div>
          {/* Money closes the band — two cells that are a consequence of
              everything to their left. No threshold colour: there is no
              "dangerous" dollar amount to encode, and the only red on this
              page should mean "an agent is about to overflow its window".
              Stock then flow: what has been spent, then how fast. */}
          <div
            className="mon-kpi mon-kpi-cost"
            title={
              stats.cost.partial
                ? 'lower bound — some of the agents shown report no cost'
                : undefined
            }
          >
            <div className="v">{formatCostKpi(stats.cost)}</div>
            <div className="k">EST. COST</div>
          </div>
          <div
            className="mon-kpi mon-kpi-cost mon-kpi-burn"
            title={
              burn.partial
                ? 'lower bound — some teams have no measurable rate yet'
                : 'spend per hour across every team, removed workers excluded (they burn nothing)'
            }
          >
            <div className="v">{formatCostKpi(burn)}</div>
            <div className="k">BURN /H</div>
          </div>
        </div>

        {/* TEAM COSTS (Lot 12) — directly under the two money KPIs it
            explains: EST. COST and BURN /H are swarm-wide single figures, and
            this is where they break down per team. Above the CONTEXT HISTORY
            band on purpose: the band annotates a TABLE ROW and belongs next
            to the table, while this section belongs to the KPI band. It stays
            mounted whatever the backend answers, so nothing on the page
            shifts when the endpoint appears. */}
        <TeamCostsSection snapshot={costs} />

        {/* CALL USAGE — API calls and tokens per hour, lead and workers apart,
            for one team or all of them (persisted ledger, 14 days). Next to
            TEAM COSTS because it is the same question at a finer grain: what
            the money above was spent ON, hour by hour. Its own team selector,
            independent of the table filter: the ledger includes teams and
            workers the table no longer shows. */}
        <CallUsagePanel open={open} orchestrators={orchestrators} />

        {/* CONTEXT HISTORY — under the KPI band on desktop, which is also
            above the table on a phone (the column collapses, the order
            holds). Rendered ONLY when a row is selected: mounting is what
            starts its poll, unmounting is what stops it. */}
        {historyRow && (
          <ContextHistoryBand
            key={historyRow.sessionId}
            row={historyRow}
            onClose={() => setHistoryId(null)}
          />
        )}

        {rows.length === 0 ? (
          <div className="board-empty">
            <div className="board-empty-title">No agents to monitor</div>
            <div className="board-empty-sub">
              {activeOnly
                ? 'No live agent matches this filter. Untick ACTIVE ONLY to include terminated sessions.'
                : 'No agent matches this filter.'}
            </div>
          </div>
        ) : (
          <div className="mon-table-wrap">
            <table className="mon-table">
              <thead>
                <tr>
                  <th>AGENT</th>
                  <th>PROVIDER</th>
                  <th>STATUS</th>
                  <th className="mon-col-ctx">CONTEXT</th>
                  <th className="mon-col-spark">SPARK</th>
                  <th className="mon-col-tokens">TOKENS · COST</th>
                  <th className="mon-num">MSGS</th>
                  <th className="mon-num">INBOX</th>
                  <th>LAST ACT</th>
                  <th>UPTIME</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <MonitoringRow
                    key={r.sessionId}
                    row={r}
                    now={now}
                    overBudget={overBudget.has(r.teamId)}
                    historyOpen={r.sessionId === historyId}
                    onToggleHistory={() => setHistoryId(
                      (cur) => (cur === r.sessionId ? null : r.sessionId),
                    )}
                    onSelect={() => selectAgent(r.sessionId)}
                    onCompact={() => fireReset(r, 'compact')}
                    onClear={() => setConfirmClear(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {confirmClear && (
        <ConfirmModal
          label={confirmClear.isLead ? 'CLEAR LEAD CONTEXT' : 'CLEAR WORKER CONTEXT'}
          body={`CLEAR ${confirmClear.name} (${confirmClear.teamName}) will wipe its entire conversation context at the next idle. Its role preamble is restored through the durable channel and its inbox is re-signalled, but everything it currently holds in-context — plans, findings, half-finished reasoning — is lost. Use COMPACT to summarise instead.`}
          cls="danger"
          onCancel={() => setConfirmClear(null)}
          onConfirm={() => {
            fireReset(confirmClear, 'clear');
            setConfirmClear(null);
          }}
        />
      )}
    </div>
  );
}

// ── one table row ────────────────────────────────────────────────────────────

interface RowProps {
  row: AgentContextRow;
  now: number;
  /** Lot 14 — this agent's TEAM has crossed its budget (not this agent). */
  overBudget: boolean;
  /** This row's CONTEXT HISTORY band is the one currently open. */
  historyOpen: boolean;
  onToggleHistory: () => void;
  onSelect: () => void;
  onCompact: () => void;
  onClear: () => void;
}

function MonitoringRow({
  row, now, overBudget, historyOpen, onToggleHistory, onSelect, onCompact, onClear,
}: RowProps) {
  const level = contextLevel(row.pct);
  const stale = !!row.usage?.stale;
  const tokens = row.usage
    ? formatContextTokens(row.usage.usedTokens, row.usage.limitTokens)
    : null;
  const resetTag = contextResetTag(row.usage);

  // Same matrix as the RightPanel buttons: a paused agent never reaches the
  // idle point the reset fires at, a terminated one has no PTY left, and an
  // already-armed reset would just earn a 409 RESET_ALREADY_PENDING.
  const disabled = !row.active || row.status === 'paused' || row.resetPending;
  // A paused agent's curve stops where it was suspended, and a stale reading
  // may already be wrong at its right edge: both keep the line, greyed.
  const dimmedSpark = stale || row.status === 'paused' || !row.active;
  const actionTitle = row.resetPending
    ? 'reset armed — fires at next idle'
    : disabled
      ? 'agent is not running — nothing to reset'
      : undefined;

  // The whole row opens the history band — but every INTERACTIVE descendant
  // stops the click first. Without that, COMPACT would both arm a reset and
  // swap the chart underneath the operator, and the AGENT button would lose
  // its own meaning (select this agent everywhere else in the app).
  const rowClasses = [
    row.active ? null : 'mon-row-inactive',
    historyOpen ? 'mon-row-open' : null,
  ].filter(Boolean).join(' ');

  return (
    <tr
      className={rowClasses || undefined}
      // `tabIndex` + Enter/Space, but deliberately NO `role="button"`: an
      // overridden role on a `<tr>` costs the whole table its row/cell
      // relationships in a screen reader, which is a far bigger loss than
      // the row not announcing itself as a control. `aria-expanded` still
      // says what the key press does.
      tabIndex={0}
      aria-expanded={historyOpen}
      title={historyOpen ? 'hide context history' : 'show context history'}
      onClick={onToggleHistory}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onToggleHistory();
      }}
    >
      <td>
        <button
          type="button"
          className="mon-agent"
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
        >
          <span className="mon-agent-name">{row.name}</span>
          {row.isLead && <span className="badge">LEAD</span>}
        </button>
        <div className="mon-agent-sub">{row.teamName} · {row.role}</div>
      </td>
      <td>
        {row.provider
          ? <span className="discord-chip">⬡ {row.provider.toUpperCase()}</span>
          : <span className="mon-muted">{CONTEXT_PLACEHOLDER}</span>}
      </td>
      {/* STATUS, plus the team's budget verdict when there is one. Next to the
          status rather than next to the agent NAME on purpose: this says
          nothing about who the agent is, and everything about whether it is
          allowed to keep running — which is exactly what the chip beside it
          is about. The badge is per-TEAM, so every row of a paused team
          carries it; its `title` is what says so. */}
      <td>
        <span className={`chip ${statusChipClass(row.status)}`}>
          <span className={`dot ${statusChipClass(row.status)}`} />
          {statusLabel(row.status)}
        </span>
        {overBudget && (
          <span
            className="badge-budget"
            title={`${row.teamName} has exceeded its cost budget`}
          >{OVER_BUDGET_BADGE}</span>
        )}
      </td>
      <td className="mon-col-ctx">
        <div className="mon-ctx-head">
          <span
            className="mon-ctx-pct"
            style={{ color: stale ? 'var(--text-mute)' : contextColorVar(level) }}
          >
            {formatContextPercent(row.pct)}
          </span>
          {tokens && <span className="mon-ctx-tokens">{tokens}</span>}
          {resetTag
            ? <span className="mon-tag stale" title={CONTEXT_RESET_TITLE}>{resetTag}</span>
            : stale && <span className="mon-tag stale">STALE</span>}
          {row.resetPending && <span className="mon-tag armed">RESET ARMED</span>}
        </div>
        <div className="pill-bar mon-ctx-bar" style={{ opacity: stale ? 0.45 : 1 }}>
          <i className={level ?? 'stopped'} style={{ width: `${contextBarWidth(row.pct)}%` }} />
        </div>
      </td>
      {/* SPARK — the last ~20 readings, free of any request of its own (the
          series rides on the same 3 s snapshot as the gauge). Dimmed rather
          than recoloured when the reading is stale or the agent is paused:
          the shape is still true, only its last point is not news. */}
      <td className="mon-col-spark">
        {row.contextSpark ? (
          <div className="mon-spark">
            <Sparkline
              values={row.contextSpark}
              color="var(--amber)"
              strokeOpacity={dimmedSpark ? 0.45 : 0.9}
              fillOpacity={dimmedSpark ? 0.05 : 0.12}
              height={18}
            />
          </div>
        ) : (
          <span className="mon-muted">{CONTEXT_PLACEHOLDER}</span>
        )}
      </td>
      {/* TOKENS · COST — cumulative spend, so it keeps climbing across the
          compacts and clears that reset the gauge two columns to the left.
          The two lines answer two different questions (how much traffic, how
          much money) and the tooltip carries the cache split, which is
          usually the largest bucket and the least interesting one. */}
      <td className="mon-col-tokens">
        {row.tokens ? (
          <div className="mon-tok" title={tokenBreakdownTitle(row.tokens)}>
            <div className="mon-tok-io">{formatTokenIoLine(row.tokens)}</div>
            {/* Its own `title`, overriding the cell's ventilation on this line
                only: the amount is where the EST/RPT suffix needs explaining,
                and the ventilation stays one hover away on the line above. */}
            <div className="mon-tok-cost" title={costBasisTitle(row.tokens.costBasis)}>
              {formatCostLine(row.tokens)}
            </div>
          </div>
        ) : (
          <span className="mon-muted">{CONTEXT_PLACEHOLDER}</span>
        )}
      </td>
      <td className="mon-num">
        {row.messagesProcessed === null
          ? <span className="mon-muted">{CONTEXT_PLACEHOLDER}</span>
          : row.messagesProcessed.toLocaleString()}
      </td>
      <td className="mon-num">
        {row.inbox === null
          ? <span className="mon-muted">{CONTEXT_PLACEHOLDER}</span>
          : row.inbox > 0
            ? <span className="mon-inbox">{row.inbox}</span>
            : <span className="mon-muted">0</span>}
      </td>
      <td className="mon-when">
        {row.lastActivityAt ? formatRelative(row.lastActivityAt) : CONTEXT_PLACEHOLDER}
      </td>
      <td className="mon-when">
        {row.active ? formatUptime(row.startedAt, now) : CONTEXT_PLACEHOLDER}
      </td>
      <td>
        <div className="mon-actions">
          <button
            type="button"
            className="mon-btn"
            disabled={disabled}
            title={actionTitle ?? 'summarise this agent\'s context at its next idle'}
            onClick={(e) => { e.stopPropagation(); onCompact(); }}
          >COMPACT</button>
          <button
            type="button"
            className="mon-btn danger"
            disabled={disabled}
            title={actionTitle ?? 'wipe this agent\'s context at its next idle'}
            onClick={(e) => { e.stopPropagation(); onClear(); }}
          >CLEAR</button>
        </div>
      </td>
    </tr>
  );
}
