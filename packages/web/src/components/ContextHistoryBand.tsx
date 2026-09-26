// packages/web/src/components/ContextHistoryBand.tsx
//
// CONTEXT HISTORY — the full-width band that opens under the MONITORING KPI
// row when the operator clicks an agent. `docs/monitoring-agents.md`, Lot 9.
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ CONTEXT HISTORY  api-worker-2  SQUAD-A · ⬡ CLAUDE 72% 144K/200K ·$5.61│
//   │                                              [1H|24H|3D]      ×    │
//   │ 100% ┊                                                            │
//   │  90% ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ 90%    │
//   │  70% ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈╱▔▔▔╲┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈╱▔▔▔▔▔▔▔┈┈┈┈┈ 70%    │
//   │      ╱▔▔▔▔▔▔▔▔▔▔▔▔▔╱      ╲COMPACT╱▔▔▔▔▔▔▔▔╱                      │
//   │  0%  └──────────────────────────────────────────────────────       │
//   │      08:00              13:20                            NOW      │
//   │ IN-MEMORY · LAST 3 DAYS · CLEARED ON SERVER RESTART                │
//   └────────────────────────────────────────────────────────────────────┘
//
// Why the band and not a modal: the operator is comparing agents. A dialog
// would hide the table it was opened from, so switching agent would mean
// close → find the row → open. The band keeps both on screen and re-targets
// on the next row click.
//
// Network: ONE request per open + per window change + a 30 s refresh, and
// only while mounted. The parent renders this component solely when a row is
// selected AND the page is open, so unmounting is the polling gate (the same
// discipline as `useApprovals(orchId, ms, open)` — see MonitoringPage).
//
// Failure policy: an error is a console warning and an empty band. No toast,
// no red box. A backend predating Lot 9 answers 404 for every session, and a
// monitoring page that shouts on every poll about a feature the server has
// not shipped yet is worse than one that quietly shows no curve.

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  api, apiErrorMessage,
  type ContextHistoryView, type ContextHistoryWindow,
} from '../api/client';
import { ICON } from './desktop/icons';
import {
  CONTEXT_PLACEHOLDER, contextColorVar, contextLevel,
  formatContextPercent, formatContextTokens, formatTokensShort,
  CONTEXT_RESET_TITLE, contextResetTag,
} from '../lib/contextPercent';
import {
  buildContextChart, contextFraction, CONTEXT_HISTORY_REFRESH_MS,
  CONTEXT_HISTORY_WINDOWS, DEFAULT_CONTEXT_WINDOW, formatSampleTime,
  nearestSampleIndex,
} from '../lib/contextHistory';
import type { AgentContextRow } from '../lib/agentContext';
import { costBasisTitle, formatUsd } from '../lib/tokenCost';
import { useElementBox } from '../hooks/useElementBox';
import AgentCallsSection from './AgentCallsSection';

interface Props {
  row: AgentContextRow;
  onClose: () => void;
}

export default function ContextHistoryBand({ row, onClose }: Props) {
  const [win, setWin] = useState<ContextHistoryWindow>(DEFAULT_CONTEXT_WINDOW);
  const [data, setData] = useState<ContextHistoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const box = useElementBox(plotRef);

  const sessionId = row.sessionId;

  // Fetch on open, on window change, then every 30 s. `cancelled` guards the
  // two races that matter: a response landing after the band closed (React
  // state on an unmounted tree) and — the sneakier one — a response for the
  // PREVIOUS agent landing after the operator clicked another row.
  useEffect(() => {
    let cancelled = false;
    // Clearing first is deliberate: showing agent A's curve under agent B's
    // name for one network round-trip is a monitoring lie.
    setData(null);
    setLoading(true);
    const fetchOnce = async () => {
      try {
        const view = await api.contextHistory(sessionId, win);
        if (!cancelled) {
          setData(view);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
        // Console only — see the header note on 404s from an older backend.
        console.warn(
          `[monitoring] context history unavailable for ${sessionId}: ${apiErrorMessage(err)}`,
        );
      }
    };
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), CONTEXT_HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, win]);

  const chart = useMemo(
    () => (data
      ? buildContextChart({
        points: data.points,
        resets: data.resets,
        limitTokens: data.limitTokens,
        width: box.w,
        height: box.h,
        window: win,
      })
      : null),
    [data, box.w, box.h, win],
  );

  // Current reading — from the 3 s snapshot, NOT from the history: the table
  // row next to the band shows the same number from the same source, and two
  // slightly different "now" values on one screen is a bug report waiting to
  // happen.
  const level = contextLevel(row.pct);
  const stale = !!row.usage?.stale;
  const tokens = row.usage
    ? formatContextTokens(row.usage.usedTokens, row.usage.limitTokens)
    : null;

  // Lot 13 — what this agent has cost so far, next to what it is holding.
  // The curve below is a story about compacts and clears; the money is what
  // that story costs, and the two belong in one glance (a `/clear` re-creates
  // the whole cache, which this figure is where the operator sees).
  //
  // Straight off `row` — the SAME prop the header, the gauge and the table
  // row all read. No second prop and, above all, no request of its own: an
  // amount fetched here could disagree with the one two lines below in the
  // table, and there is no way for the operator to tell which is right.
  const cost = row.tokens ? formatUsd(row.tokens.costUsd) : null;

  return (
    <section className="mon-hist" aria-label={`Context history — ${row.name}`}>
      <header className="mon-hist-head">
        <div className="mon-hist-id">
          <span className="mon-hist-label">CONTEXT HISTORY</span>
          <span className="mon-hist-agent">{row.name}</span>
          <span className="mon-hist-sub">
            {row.teamName}
            {row.provider ? ` · ⬡ ${row.provider.toUpperCase()}` : ''}
          </span>
        </div>

        <div className="mon-hist-now">
          <span
            className="mon-hist-now-pct"
            style={{ color: stale ? 'var(--text-mute)' : contextColorVar(level) }}
          >
            {formatContextPercent(row.pct)}
          </span>
          {tokens && <span className="mon-hist-now-tokens">{tokens}</span>}
          {contextResetTag(row.usage) && (
            <span className="mon-tag stale" title={CONTEXT_RESET_TITLE}>{contextResetTag(row.usage)}</span>
          )}
          {cost && row.tokens && (
            <span
              className="mon-hist-now-cost"
              title={`cumulative spend — ${costBasisTitle(row.tokens.costBasis)}`}
            >{cost}</span>
          )}
        </div>

        <div className="seg mon-hist-seg" role="group" aria-label="history window">
          {CONTEXT_HISTORY_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              className={w.key === win ? 'on' : undefined}
              aria-pressed={w.key === win}
              onClick={() => setWin(w.key)}
            >{w.label}</button>
          ))}
        </div>

        <button
          type="button"
          className="icon-btn mon-hist-close"
          title="close context history"
          aria-label="close context history"
          onClick={onClose}
        >{ICON.kill}</button>
      </header>

      <div className="mon-hist-plot" ref={plotRef}>
        {chart
          ? <ContextChartSvg chart={chart} width={box.w} height={box.h}
              limitTokens={data?.limitTokens ?? null} window={win} />
          : (
            <div className="mon-hist-state">
              {loading ? 'LOADING…' : '— no history yet —'}
            </div>
          )}
      </div>

      <footer className="mon-hist-foot">
        IN-MEMORY · LAST 3 DAYS · CLEARED ON SERVER RESTART
      </footer>

      <AgentCallsSection sessionId={sessionId} provider={row.provider} />
    </section>
  );
}

// ── the plot ─────────────────────────────────────────────────────────────────

interface ChartProps {
  chart: NonNullable<ReturnType<typeof buildContextChart>>;
  width: number;
  height: number;
  limitTokens: number | null;
  window: ContextHistoryWindow;
}

function ContextChartSvg({ chart, width, height, limitTokens, window: win }: ChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { plot, samples } = chart;

  // The hover target is the WHOLE plot, not the 1.6 px line: the operator
  // points at a moment in time, and the chart answers with the bucket
  // nearest in X whatever the pointer's Y.
  const onMove = useCallback((e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * width;
    if (x < plot.x - 8 || x > plot.x + plot.w + 8) {
      setHover(null);
      return;
    }
    const i = nearestSampleIndex(samples, x);
    setHover(i >= 0 ? i : null);
  }, [samples, plot.x, plot.w, width]);

  const active = hover !== null ? samples[hover] : undefined;
  const activeFraction = active ? contextFraction(active.last, limitTokens) : null;
  const loneSample = samples.length === 1 ? samples[0] : undefined;

  return (
    <>
      <svg
        ref={svgRef}
        className="mon-hist-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="context usage over time"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid + Y axis. Recessive on purpose: the reading is the curve. */}
        {chart.yTicks.map((tick) => (
          <g key={`y-${tick.label}`}>
            <line
              className="mon-hist-grid"
              x1={plot.x} x2={plot.x + plot.w} y1={tick.y} y2={tick.y}
            />
            <text
              className="mon-hist-axis"
              x={plot.x - 7} y={tick.y + 3} textAnchor="end"
            >{tick.label}</text>
          </g>
        ))}

        {/* Thresholds — dashed AND labelled, never colour alone. Absent in
            token mode, where there is no window to be 70% of. */}
        {chart.thresholds.map((th) => (
          <g key={`th-${th.label}`}>
            <line
              className={`mon-hist-threshold ${th.level}`}
              x1={plot.x} x2={plot.x + plot.w} y1={th.y} y2={th.y}
            />
            <text
              className={`mon-hist-threshold-label ${th.level}`}
              x={plot.x + plot.w} y={th.y - 4} textAnchor="end"
            >{th.label}</text>
          </g>
        ))}

        {/* Intra-bucket amplitude, then the `last` series on top of it. */}
        {chart.bandPath && <path className="mon-hist-band" d={chart.bandPath} />}
        <path className="mon-hist-area" d={chart.areaPath} />
        <path className="mon-hist-line" d={chart.linePath} />
        {/* A single bucket draws no line — a lone dot is the honest render of
            "one reading so far", and beats an empty plot. */}
        {loneSample && (
          <circle className="mon-hist-dot" cx={loneSample.x} cy={loneSample.y} r={2.4} />
        )}

        {/* Resets: a tick is always drawn, the tag only when it fits. */}
        {chart.resets.map((r, i) => (
          <g key={`reset-${r.t}-${i}`}>
            <line
              className="mon-hist-reset"
              x1={r.x} x2={r.x} y1={plot.y} y2={plot.y + plot.h}
            />
            {r.labelled && (
              <text className="mon-hist-reset-label" x={r.x + 3} y={plot.y + 8}>
                {r.label}
              </text>
            )}
          </g>
        ))}

        {/* X labels. */}
        {chart.xLabels.map((l, i) => (
          <text
            key={`x-${i}-${l.label}`}
            className="mon-hist-axis"
            x={l.x} y={plot.y + plot.h + 13}
            textAnchor={l.anchor}
          >{l.label}</text>
        ))}

        {/* Crosshair. */}
        {active && (
          <g>
            <line
              className="mon-hist-crosshair"
              x1={active.x} x2={active.x} y1={plot.y} y2={plot.y + plot.h}
            />
            <circle className="mon-hist-cursor" cx={active.x} cy={active.y} r={3} />
          </g>
        )}
      </svg>

      {active && (
        <div
          className="mon-hist-tip"
          style={{
            left: Math.max(4, Math.min(width - 4, active.x)),
            top: plot.y,
          }}
        >
          <div className="mon-hist-tip-time">{formatSampleTime(active.t, win)}</div>
          <div className="mon-hist-tip-val">
            <span
              style={{ color: contextColorVar(contextLevel(activeFraction)) }}
            >{formatContextPercent(activeFraction)}</span>
            <span className="mon-hist-tip-tokens">
              {formatTokensShort(active.last)}
              {' / '}
              {limitTokens === null ? CONTEXT_PLACEHOLDER : formatTokensShort(limitTokens)}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
