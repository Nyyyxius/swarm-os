// packages/web/src/components/CallUsagePanel.tsx
//
// CALL USAGE — API calls and tokens per hour for one team or for the whole
// fleet, lead and workers stacked apart, on the MONITORING page. Served by the
// persisted ledger (`GET /orchestrators/:id/call-usage`, `GET
// /metrics/call-usage`, aggregated in SQL), so killed and removed workers are
// in it: on a 24/7 swarm they are most of the calls.
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ CALL USAGE  [ALL TEAMS ▾]          [CALLS|TOKENS]  [1H|24H|3D|14D] │
//   │ ■ LEAD 1 204 CALLS · 88M TOK   ■ WORKERS 8 870 CALLS · 610M TOK    │
//   │  900 ┊              ▆▇█▇▅▃▂                     ▃▅▇█▆▄              │
//   │    0 └──────────────────────────────────────────────────────       │
//   │ SQUAD-A 4 102 · SQUAD-B 2 950 · INFRA 1 881 · …                    │
//   └────────────────────────────────────────────────────────────────────┘
//
// One request per open / selection change, then every 60 s — only while the
// page is open (the overlay is always mounted; `open` is the polling gate).

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  api, apiErrorMessage,
  type CallUsageView, type CallWindow, type OrchestratorView,
} from '../api/client';
import { formatTokensShort } from '../lib/contextPercent';
import {
  buildSeriesChart, CALL_USAGE_REFRESH_MS, CALL_WINDOWS, callTokenSum, callUsageBucketFor,
  formatCallTime, nearestBarIndex, seriesValue, type SeriesMetric,
} from '../lib/callUsage';
import { useElementBox } from '../hooks/useElementBox';

/** Sentinel for "every team" in the selector. */
const ALL = '';

interface Props {
  open: boolean;
  orchestrators: readonly OrchestratorView[];
}

export default function CallUsagePanel({ open, orchestrators }: Props) {
  const [team, setTeam] = useState<string>(ALL);
  const [win, setWin] = useState<CallWindow>('24h');
  const [metric, setMetric] = useState<SeriesMetric>('calls');
  const [data, setData] = useState<CallUsageView | null>(null);
  const [fleetTeams, setFleetTeams] = useState<CallUsageView['teams']>(undefined);
  const [loading, setLoading] = useState(true);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const box = useElementBox(plotRef, { w: 880, h: 160 });

  // Teams offered: the live snapshot, plus any team the fleet view saw calls
  // from (an ended team keeps its history for 14 days).
  const options = useMemo(() => {
    const out = new Map<string, string>();
    for (const o of orchestrators) out.set(o.id, `${o.name}${o.endedAt != null ? ' (ended)' : ''}`);
    for (const t of fleetTeams ?? []) {
      if (!out.has(t.orchestratorId)) out.set(t.orchestratorId, t.name ?? t.orchestratorId.slice(0, 8));
    }
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orchestrators, fleetTeams]);

  // A selected team that vanished from the options falls back to ALL during
  // render — same rule as the page's TEAM filter.
  const effectiveTeam = team === ALL || options.some(([id]) => id === team) ? team : ALL;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    setLoading(true);
    const bucket = callUsageBucketFor(win);
    const fetchOnce = async () => {
      try {
        const view = effectiveTeam === ALL
          ? await api.getMetricsCallUsage(win, bucket)
          : await api.getOrchestratorCallUsage(effectiveTeam, win, bucket);
        if (!cancelled) {
          setData(view);
          setLoading(false);
          if (view.teams) setFleetTeams(view.teams);
        }
      } catch (err) {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
        console.warn(`[monitoring] call usage unavailable: ${apiErrorMessage(err)}`);
      }
    };
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), CALL_USAGE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, effectiveTeam, win]);

  const chart = useMemo(
    () => (data
      ? buildSeriesChart({
        lead: data.lead, workers: data.workers, metric, width: box.w, height: box.h, window: win,
        span: { since: data.since, until: data.until, bucketMs: data.bucketMs },
      })
      : null),
    [data, metric, box.w, box.h, win],
  );
  const empty = data !== null && data.totals.lead.calls + data.totals.workers.calls === 0;

  return (
    <section className="mon-costs mon-callusage" aria-label="Call usage">
      <header className="mon-callusage-head">
        <span className="mon-costs-label">CALL USAGE</span>
        <select
          className="board-select mon-callusage-team"
          aria-label="team"
          value={effectiveTeam}
          onChange={(e) => setTeam(e.target.value)}
        >
          <option value={ALL}>ALL TEAMS</option>
          {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <span className="mon-costs-sub" />
        <div className="seg" role="group" aria-label="metric">
          {(['calls', 'tokens'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={m === metric ? 'on' : undefined}
              aria-pressed={m === metric}
              onClick={() => setMetric(m)}
            >{m.toUpperCase()}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="call usage window">
          {CALL_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              className={w.key === win ? 'on' : undefined}
              aria-pressed={w.key === win}
              onClick={() => setWin(w.key)}
            >{w.label}</button>
          ))}
        </div>
      </header>

      {data && (
        <div className="mon-callusage-totals">
          <span>
            <i className="mon-calls-swatch lead" />LEAD <b>{data.totals.lead.calls}</b> CALLS
            {' · '}<b>{formatTokensShort(callTokenSum(data.totals.lead))}</b> TOK
          </span>
          <span>
            <i className="mon-calls-swatch workers" />WORKERS <b>{data.totals.workers.calls}</b> CALLS
            {' · '}<b>{formatTokensShort(callTokenSum(data.totals.workers))}</b> TOK
          </span>
          <span className="mon-callusage-bucket">
            PER {data.bucket === '5m' ? '5 MIN' : data.bucket.toUpperCase()}
          </span>
        </div>
      )}

      <div className="mon-callusage-plot" ref={plotRef}>
        {chart && data && !empty
          ? <SeriesSvg chart={chart} data={data} metric={metric} width={box.w} height={box.h} window={win} />
          : (
            <div className="mon-hist-state">
              {loading ? 'LOADING…' : data ? '— no call in this window —' : '— unavailable —'}
            </div>
          )}
      </div>

      {effectiveTeam === ALL && data?.teams && data.teams.length > 0 && (
        <div className="mon-callusage-teams">
          {data.teams.slice(0, 8).map((t) => (
            <button
              key={t.orchestratorId}
              type="button"
              className="mon-callusage-teamchip"
              title={`${formatTokensShort(callTokenSum(t))} tokens — show this team`}
              onClick={() => setTeam(t.orchestratorId)}
            >
              {t.name ?? t.orchestratorId.slice(0, 8)} <b>{t.calls}</b>
            </button>
          ))}
          {data.teams.length > 8 && <span className="mon-muted">+{data.teams.length - 8}</span>}
        </div>
      )}
    </section>
  );
}

function SeriesSvg({ chart, data, metric, width, height, window: win }: {
  chart: NonNullable<ReturnType<typeof buildSeriesChart>>;
  data: CallUsageView;
  metric: SeriesMetric;
  width: number;
  height: number;
  window: CallWindow;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { plot, bars } = chart;

  const onMove = useCallback((e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * width;
    if (x < plot.x - 8 || x > plot.x + plot.w + 8) {
      setHover(null);
      return;
    }
    const i = nearestBarIndex(bars, x);
    setHover(i >= 0 ? i : null);
  }, [bars, plot.x, plot.w, width]);

  const active = hover !== null ? bars[hover] : undefined;
  const lead = active ? data.lead[active.index] : undefined;
  const workers = active ? data.workers[active.index] : undefined;
  const fmt = (v: number) => (metric === 'calls' ? String(v) : formatTokensShort(v));

  return (
    <>
      <svg
        ref={svgRef}
        className="mon-hist-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${metric} per bucket, lead and workers`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {chart.yTicks.map((tick) => (
          <g key={`y-${tick.y}`}>
            <line className="mon-hist-grid" x1={plot.x} x2={plot.x + plot.w} y1={tick.y} y2={tick.y} />
            <text className="mon-hist-axis" x={plot.x - 7} y={tick.y + 3} textAnchor="end">{tick.label}</text>
          </g>
        ))}
        {bars.map((b, i) => (
          <g key={b.index} className={hover === i ? 'mon-callusage-bar on' : 'mon-callusage-bar'}>
            {b.lead && <rect className="mon-callusage-lead" x={b.x - b.w / 2} y={b.lead.y} width={b.w} height={b.lead.h} />}
            {b.workers && <rect className="mon-callusage-workers" x={b.x - b.w / 2} y={b.workers.y} width={b.w} height={b.workers.h} />}
          </g>
        ))}
        {chart.xLabels.map((l) => (
          <text key={`x-${l.label}`} className="mon-hist-axis" x={l.x} y={plot.y + plot.h + 13} textAnchor={l.anchor}>
            {l.label}
          </text>
        ))}
        {active && (
          <line className="mon-hist-crosshair" x1={active.x} x2={active.x} y1={plot.y} y2={plot.y + plot.h} />
        )}
      </svg>
      {active && (
        <div
          className="mon-hist-tip mon-calls-tip"
          style={{ left: Math.max(90, Math.min(width - 90, active.x)), top: plot.y }}
        >
          <div className="mon-hist-tip-time">{formatCallTime(active.t, win, false)}</div>
          <div className="mon-calls-tip-grid">
            <span><i className="mon-calls-swatch lead" />LEAD</span>
            <b>{lead?.calls ?? 0} calls · {formatTokensShort(lead ? callTokenSum(lead) : 0)} tok</b>
            <span><i className="mon-calls-swatch workers" />WORKERS</span>
            <b>{workers?.calls ?? 0} calls · {formatTokensShort(workers ? callTokenSum(workers) : 0)} tok</b>
            <span>TOTAL</span>
            <b>{fmt(seriesValue(lead, metric) + seriesValue(workers, metric))}{metric === 'calls' ? ' calls' : ' tok'}</b>
          </div>
        </div>
      )}
    </>
  );
}
