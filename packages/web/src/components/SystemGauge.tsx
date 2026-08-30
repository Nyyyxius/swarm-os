// packages/web/src/components/SystemGauge.tsx
//
// One 180° arc gauge — the CPU / MEMORY pair at the head of the MONITORING
// KPI band (docs/monitoring-agents.md § Lot 10; design canvas artboard
// "System Gauges").
//
//   ╭───────────────╮
//   │    ◜◝  57%    │  CPU              ← label, `.k` register of the KPIs
//   │               │  1.4 / 4.0 CORES  ← sub-line, always a text token
//   │               │  [HOST BASIS]     ← only when the denominator is the box
//   ╰───────────────╯
//
// Two rules the design is explicit about, and which the code enforces rather
// than merely following:
//
//   1. The ARC ALONE carries status colour. The sub-line and the label stay in
//      text tokens; only the percentage joins the arc, and only once it has
//      left `ok` (see `gaugeTextColor`). A cell where four elements all turn
//      red at once reads as an alarm state rather than a reading.
//   2. No measurement means NO ARC — the track renders alone under a muted
//      `—`. There is no "0 %" fallback anywhere in this component: an empty
//      gauge and an idle container must not look the same.
//
// Stateless and request-free by construction: the parent owns the poll, so
// this can be dropped into the mobile stats sheet later without dragging a
// network call along with it.

import {
  GAUGE_ARC_LENGTH, GAUGE_ARC_PATH, GAUGE_PLACEHOLDER, GAUGE_VIEWBOX,
  NO_CGROUP_DATA, formatGaugePercent, gaugeArcColor, gaugeArcDash,
  gaugeTextColor,
} from '../lib/systemGauge';
import { contextLevel } from '../lib/contextPercent';

interface Props {
  /** `CPU` / `MEMORY` — rendered as-is, in the KPI `.k` register. */
  label: string;
  /** Fraction `0..1`, or `null` for "no reading". */
  pct: number | null;
  /**
   * Absolute reading under the label (`1.4 / 4.0 CORES`, `6.2G / 8.0G`).
   * `null` when nothing at all could be read — the component then says
   * {@link NO_CGROUP_DATA} rather than leaving a blank line, because a
   * silently empty gauge is indistinguishable from a broken layout.
   */
  sub: string | null;
  /** `'host'` earns the `HOST BASIS` tag; `'cgroup'`/`null` do not. */
  basis: 'cgroup' | 'host' | null;
}

export default function SystemGauge({ label, pct, sub, basis }: Props) {
  const level = contextLevel(pct);
  const dash = gaugeArcDash(pct);
  const text = formatGaugePercent(pct);

  return (
    <div
      className="mon-gauge"
      // The gauge is a reading, not a control: one label for the whole cell
      // beats a screen reader walking an SVG path and two spans.
      role="img"
      aria-label={`${label} ${pct === null ? 'unavailable' : text}${sub ? `, ${sub}` : ''}`}
    >
      <svg className="mon-gauge-arc" viewBox={GAUGE_VIEWBOX} aria-hidden="true">
        {/* Track — always drawn, so an unreadable gauge still has a shape. */}
        <path
          className="mon-gauge-track"
          d={GAUGE_ARC_PATH}
          fill="none"
          strokeWidth={5}
          strokeLinecap="round"
        />
        {dash !== null && (
          <path
            className="mon-gauge-value"
            d={GAUGE_ARC_PATH}
            fill="none"
            stroke={gaugeArcColor(level)}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={dash}
            // Belt and braces with the dasharray gap: guarantees the arc can
            // never wrap past its right cap, whatever the server sends.
            strokeDashoffset={0}
            pathLength={GAUGE_ARC_LENGTH}
          />
        )}
        <text
          className="mon-gauge-pct"
          x={42}
          y={41}
          textAnchor="middle"
          fill={gaugeTextColor(level)}
        >
          {pct === null ? GAUGE_PLACEHOLDER : text}
        </text>
      </svg>

      <div className="mon-gauge-meta">
        <div className="k">{label}</div>
        <div className="mon-gauge-sub">{sub ?? NO_CGROUP_DATA}</div>
        {basis === 'host' && (
          <div
            className="mon-gauge-basis"
            title="no cgroup limit — measured against the whole host"
          >
            HOST BASIS
          </div>
        )}
      </div>
    </div>
  );
}
