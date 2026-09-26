// packages/web/src/components/AgentCallsSection.tsx
//
// API CALLS — the lower half of the agent band on the MONITORING page: every
// API call the agent made, one bar per call, from the persisted ledger
// (`GET /sessions/:id/calls`, `session_calls`, 14 days, claude only).
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ API CALLS  412 CALLS · 38/H · PEAK CTX 141K        [1H|24H|3D|14D] │
//   │ ■ NEW IN ■ CACHE WRITE ■ CACHE READ ■ OUTPUT ─ CONTEXT             │
//   │ 150K ┊      ▂▃▅▆█ ▂▃▄▅▆▇█                ▂▃▄▅▆▇█▇                  │
//   │   0  └──────────────────────────────────────────────────────       │
//   │ CALLS/H ▁▂▅▇▃ ▁                 ▂▆▇▅                               │
//   │ IN 2.1K · CACHE W 310K · CACHE R 44M · OUT 520K                    │
//   │ PERSISTED · 14 DAYS · CLAUDE ONLY                                  │
//   └────────────────────────────────────────────────────────────────────┘
//
// Same network discipline as the context band above it: one request on open,
// per window change and every 30 s, only while mounted; a failure is a console
// warning and an empty strip (a server predating the ledger answers 404).

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  api, apiErrorMessage,
  type CallWindow, type SessionCallsView,
} from '../api/client';
import { formatTokensShort } from '../lib/contextPercent';
import {
  activeHourRate, buildCallChart, buildSeriesChart, CALL_REFRESH_MS, CALL_SEGMENTS,
  CALL_WINDOWS, DEFAULT_CALL_WINDOW, densifyHourly, formatBucket, formatCallTime,
  nearestBarIndex, barValues,
} from '../lib/callUsage';
import { useElementBox } from '../hooks/useElementBox';

interface Props {
  sessionId: string;
  /** `SessionView.provider`; the ledger only has claude agents. */
  provider: string | null;
}

export default function AgentCallsSection({ sessionId, provider }: Props) {
  const [win, setWin] = useState<CallWindow>(DEFAULT_CALL_WINDOW);
  const [data, setData] = useState<SessionCallsView | null>(null);
  const [loading, setLoading] = useState(true);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const box = useElementBox(plotRef, { w: 880, h: 170 });
  const strip = useElementBox(stripRef, { w: 880, h: 46 });
  // `null` provider = a backend predating multi-provider, i.e. claude.
  const supported = provider === null || provider === 'claude';

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    // Cleared first, like the context band: agent A's calls under agent B's
    // name for one round-trip would be a monitoring lie.
    setData(null);
    setLoading(true);
    const fetchOnce = async () => {
      try {
        const view = await api.sessionCalls(sessionId, win);
        if (!cancelled) {
          setData(view);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
        console.warn(`[monitoring] call ledger unavailable for ${sessionId}: ${apiErrorMessage(err)}`);
      }
    };
    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), CALL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, win, supported]);

  const chart = useMemo(
    () => (data
      ? buildCallChart({
        calls: data.calls,
        aggregated: data.aggregated,
        since: data.since,
        until: data.until,
        width: box.w,
        height: box.h,
        window: win,
        bucketMs: data.bucketMs,
      })
      : null),
    [data, box.w, box.h, win],
  );

  // Calls per hour, dense over the window. Pointless on 1H (one or two bars),
  // where the header's rate says the same thing.
  const hourly = useMemo(() => {
    if (!data || win === '1h') return null;
    const series = densifyHourly(data.hourly, data.since, data.until);
    const chart = buildSeriesChart({
      lead: series, workers: [], metric: 'calls', width: strip.w, height: strip.h, window: win,
      // Same time axis as the chart above, so an hour's bar sits under its calls.
      span: { since: data.since, until: data.until, bucketMs: 3_600_000 },
    });
    return chart ? { chart, series } : null;
  }, [data, win, strip.w, strip.h]);

  const rate = data ? activeHourRate(data.hourly) : null;
  const totals = data?.totals;

  return (
    <section className="mon-calls" aria-label="API calls">
      <header className="mon-hist-head">
        <div className="mon-hist-id">
          <span className="mon-hist-label">API CALLS</span>
          {totals && (
            <span className="mon-calls-kpi">
              {totals.calls} CALLS
              {rate !== null && ` · ${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/H ACTIVE`}
              {totals.calls > 0 && ` · PEAK CTX ${formatTokensShort(totals.maxContext)}`}
            </span>
          )}
        </div>
        <div className="seg mon-hist-seg mon-calls-seg" role="group" aria-label="calls window">
          {CALL_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              className={w.key === win ? 'on' : undefined}
              aria-pressed={w.key === win}
              disabled={!supported}
              onClick={() => setWin(w.key)}
            >{w.label}</button>
          ))}
        </div>
      </header>

      {supported && (
        <div className="mon-calls-legend" aria-hidden="true">
          {CALL_SEGMENTS.map((s) => (
            <span key={s.key} className="mon-calls-legend-item">
              <i className={`mon-calls-swatch ${s.key}`} />{s.label}
            </span>
          ))}
          <span className="mon-calls-legend-item">
            <i className="mon-calls-swatch context" />CONTEXT SENT
          </span>
        </div>
      )}

      <div className="mon-calls-plot" ref={plotRef}>
        {!supported
          ? <div className="mon-hist-state">— CLAUDE AGENTS ONLY —</div>
          : chart && data
            ? <CallChartSvg chart={chart} data={data} width={box.w} height={box.h} window={win} />
            : (
              <div className="mon-hist-state">
                {loading ? 'LOADING…' : '— no call in this window —'}
              </div>
            )}
      </div>

      {supported && win !== '1h' && (
        <div className="mon-calls-strip" ref={stripRef}>
          <span className="mon-calls-strip-label">CALLS / H</span>
          {hourly && (
            <svg
              className="mon-hist-svg"
              width={strip.w}
              height={strip.h}
              viewBox={`0 0 ${strip.w} ${strip.h}`}
              role="img"
              aria-label="calls per hour"
            >
              {hourly.chart.bars.map((b) => b.lead && (
                <rect
                  key={b.index}
                  className="mon-calls-hour"
                  x={b.x - b.w / 2} y={b.lead.y} width={b.w} height={b.lead.h}
                >
                  <title>{`${formatCallTime(b.t, win, false)} — ${hourly.series[b.index]?.calls ?? 0} calls`}</title>
                </rect>
              ))}
              <text
                className="mon-hist-axis"
                x={hourly.chart.plot.x - 7} y={hourly.chart.plot.y + 6} textAnchor="end"
              >{Math.round(hourly.chart.yMax)}</text>
            </svg>
          )}
        </div>
      )}

      {supported && totals && totals.calls > 0 && (
        <div className="mon-calls-totals">
          <span>NEW IN <b>{formatTokensShort(totals.input)}</b></span>
          <span>CACHE WRITE <b>{formatTokensShort(totals.cacheWrite)}</b></span>
          <span>CACHE READ <b>{formatTokensShort(totals.cacheRead)}</b></span>
          <span>OUTPUT <b>{formatTokensShort(totals.output)}</b></span>
        </div>
      )}

      <footer className="mon-hist-foot">
        PERSISTED · 14 DAYS · CLAUDE ONLY
        {data?.aggregated && data.bucketMs !== null
          && ` · ${formatBucket(data.bucketMs)} BUCKETS · BAR = MEAN CALL, LINE = PEAK CONTEXT`}
      </footer>
    </section>
  );
}

// ── the plot ─────────────────────────────────────────────────────────────────

interface ChartProps {
  chart: NonNullable<ReturnType<typeof buildCallChart>>;
  data: SessionCallsView;
  width: number;
  height: number;
  window: CallWindow;
}

function CallChartSvg({ chart, data, width, height, window: win }: ChartProps) {
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
  const point = active ? data.calls[active.index] : undefined;

  return (
    <>
      <svg
        ref={svgRef}
        className="mon-hist-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="tokens per API call"
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
          <g key={b.index} className={hover === i ? 'mon-calls-bar on' : 'mon-calls-bar'}>
            {b.segments.map((s) => (
              <rect
                key={s.key}
                className={`mon-calls-seg-${s.key}`}
                x={b.x - b.w / 2} y={s.y} width={b.w} height={s.h}
              />
            ))}
          </g>
        ))}

        {bars.length > 1
          ? <path className="mon-calls-context" d={chart.contextPath} />
          : bars[0] && <circle className="mon-hist-dot" cx={bars[0].x} cy={bars[0].yContext} r={2.4} />}

        {chart.xLabels.map((l) => (
          <text
            key={`x-${l.label}-${l.x}`}
            className="mon-hist-axis"
            x={l.x} y={plot.y + plot.h + 13}
            textAnchor={l.anchor}
          >{l.label}</text>
        ))}

        {active && (
          <line
            className="mon-hist-crosshair"
            x1={active.x} x2={active.x} y1={plot.y} y2={plot.y + plot.h}
          />
        )}
      </svg>

      {active && point && (
        <CallTip point={point} x={active.x} top={plot.y} width={width}
          aggregated={data.aggregated} window={win} />
      )}
    </>
  );
}

function CallTip({ point, x, top, width, aggregated, window: win }: {
  point: SessionCallsView['calls'][number];
  x: number;
  top: number;
  width: number;
  aggregated: boolean;
  window: CallWindow;
}) {
  const single = point.n <= 1;
  const mean = barValues(point, aggregated);
  return (
    <div
      className="mon-hist-tip mon-calls-tip"
      style={{ left: Math.max(90, Math.min(width - 90, x)), top }}
    >
      <div className="mon-hist-tip-time">
        {formatCallTime(Date.parse(point.t), win, single)}
        {single ? '' : ` · ${point.n} CALLS`}
        {point.sidechain ? ' · SUB-AGENT' : ''}
      </div>
      <div className="mon-calls-tip-model">{point.model ?? (single ? '—' : 'MIXED MODELS')}</div>
      <div className="mon-calls-tip-grid">
        <span>{single ? 'CONTEXT' : 'PEAK CTX'}</span><b>{formatTokensShort(point.context)}</b>
        {CALL_SEGMENTS.map((s) => (
          <FragmentRow
            key={s.key}
            label={s.label}
            value={point[s.key]}
            mean={single ? null : mean[s.key]}
            swatch={s.key}
          />
        ))}
      </div>
    </div>
  );
}

function FragmentRow({ label, value, mean, swatch }: {
  label: string;
  value: number;
  mean: number | null;
  swatch: string;
}) {
  return (
    <>
      <span><i className={`mon-calls-swatch ${swatch}`} />{label}</span>
      <b>
        {formatTokensShort(value)}
        {mean !== null && <em> ({formatTokensShort(mean)}/call)</em>}
      </b>
    </>
  );
}
