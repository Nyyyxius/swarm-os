// packages/web/src/components/mobile/StatsSheet.tsx
//
// Mobile GLOBAL :: STATS bottom-sheet — Slice 1. Real data only: the
// prototype's window.SPARK_DATA / AGG_HISTORY mocks are gone. Reuses the
// exact desktop data hooks/components (useMessageFlow, useServerMessagesMetrics,
// useBusHealth, BigGraph, Sparkline, filterActive/Ended) so the mobile and
// desktop monitoring numbers can never diverge.
import Sheet from './Sheet';
import BigGraph from '../desktop/BigGraph';
import Sparkline from '../desktop/Sparkline';
import { formatRelative } from '../../lib/format';
import {
  ENDED_DISPLAY_CAP,
  filterActive,
  filterEnded,
  toLeftPanelEnded,
  useMessageFlow,
  useServerMessagesMetrics,
} from '../../lib/leftPanelAdapters';
import { useBusHealth } from '../../hooks/useBusHealth';
import { useSwarmController } from '../../controller/SwarmController';

interface StatsSheetProps {
  open: boolean;
  onClose: () => void;
}

function busCell(value: number | undefined, decimals: number): string {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(decimals);
}

export default function StatsSheet({ open, onClose }: StatsSheetProps) {
  const c = useSwarmController();
  const flow = useMessageFlow(c.orchestrators, 's4-client');
  const serverMsgs = useServerMessagesMetrics();
  const perOrchSparks = serverMsgs?.per_orchestrator ?? null;
  const activeTeams = filterActive(c.orchestrators);
  const ended = filterEnded(c.orchestrators).slice(0, ENDED_DISPLAY_CAP);
  const bus = useBusHealth(3_000);

  function pickTeam(targetSessionId: string) {
    onClose();
    c.handleSelectTeam(targetSessionId);
  }
  function pickEnded(orchId: string) {
    onClose();
    c.handleLeftSelectEnded(orchId);
  }
  // The dock is FULL (6 buttons, cf. MobileShell) and a 7th does not fit on a
  // phone, so MONITORING is reached from here — this sheet is already the
  // "everything about the swarm at a glance" surface, and the page is its
  // per-agent drill-down.
  function openMonitoring() {
    onClose();
    c.onOpenMonitoring();
  }
  // Same reasoning for CRONS, plus one that is specific to it: the ⌘K launcher
  // — the desktop way in — DOES NOT EXIST on mobile. Without this row the
  // crons screen would be unreachable from a phone altogether.
  function openCrons() {
    onClose();
    c.onOpenCrons();
  }

  const busCells: Array<{ k: string; v: string; u: string; warn?: boolean }> = [
    { k: 'LATENCY', v: busCell(bus?.latency_ms, 0), u: 'ms' },
    { k: 'THROUGHPUT', v: busCell(bus?.throughput_msg_per_s, 1), u: '/s' },
    { k: 'QUEUE', v: busCell(bus?.queue_depth, 0), u: '' },
    { k: 'ERR RATE', v: busCell(bus?.err_rate_pct, 1), u: '%', warn: true },
  ];

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="m-sheet-head">
        <div className="m-sheet-title-row">
          <span className="m-sheet-id">GLOBAL :: STATS</span>
          <button className="m-sheet-close" onClick={onClose} aria-label="close">×</button>
        </div>
        <div className="m-sheet-title">Message flow</div>
        <div className="m-sheet-sub">live · all teams</div>
      </div>

      <div className="m-sheet-body">
        <div className="m-big-number">
          {flow.total.toLocaleString()}
          <span className="m-delta">+{flow.perMinute}/min</span>
        </div>
        <div className="m-big-sub">TOTAL EXCHANGED · LAST 60 MIN</div>
        <div className="m-graph"><BigGraph data={flow.history} /></div>

        <h3 className="m-sec">Agents</h3>
        <button type="button" className="m-team-row mon-link-row" onClick={openMonitoring}>
          <div className="m-tr-name">MONITORING</div>
          <div className="m-tr-count">→</div>
          <div className="m-tr-meta">
            <span>CONTEXT · THROUGHPUT · INBOX PER AGENT</span>
          </div>
        </button>
        <button type="button" className="m-team-row mon-link-row" onClick={openCrons}>
          <div className="m-tr-name">CRONS</div>
          <div className="m-tr-count">→</div>
          <div className="m-tr-meta">
            <span>SCHEDULED WAKE-UPS PER ROLE</span>
          </div>
        </button>

        <h3 className="m-sec">Per-team traffic <span className="m-count">{activeTeams.length}</span></h3>
        {activeTeams.length === 0 && <div className="m-stat-empty">— no active teams —</div>}
        {activeTeams.map((orch) => {
          const offline =
            orch.health === 'stopped' || orch.status === 'stopped' || orch.status === 'failed';
          const tag = orch.status === 'starting' ? 'STARTING' : offline ? 'OFFLINE' : 'ONLINE';
          const color = offline ? '#5a4d3f' : 'var(--amber)';
          const spark = perOrchSparks?.[orch.id] ?? [];
          const workers = Math.max(0, orch.sessions.length - 1);
          const targetSessionId = orch.leadSessionId ?? orch.id;
          return (
            <button
              key={orch.id}
              type="button"
              className="m-team-row"
              onClick={() => pickTeam(targetSessionId)}
            >
              <div className="m-tr-name">
                <span className="m-sw" style={{ background: color }} />
                {orch.name}
              </div>
              <div className="m-tr-count">{(orch.msgCount ?? 0).toLocaleString()}</div>
              <div className="m-tr-meta">
                <span>{(orch.role || '—').toUpperCase().slice(0, 16)}</span>
                <span>·</span>
                <span>{1 + workers} AGT</span>
                <span>·</span>
                <span style={{ color: offline ? 'var(--text-mute)' : tag === 'STARTING' ? 'var(--amber-soft)' : 'var(--ok)' }}>
                  {tag}
                </span>
              </div>
              <div className="m-tr-spark"><Sparkline values={spark} color={color} /></div>
            </button>
          );
        })}

        {ended.length > 0 && (
          <>
            <h3 className="m-sec">Recently ended <span className="m-count">{ended.length}</span></h3>
            {ended.map((orch) => {
              const e = toLeftPanelEnded(orch);
              return (
                <button
                  key={e.id}
                  type="button"
                  className="m-ended-row"
                  onClick={() => pickEnded(orch.id)}
                >
                  <div className="m-ended-top">
                    <span className="m-ended-name">{e.name}</span>
                    <span className="m-ended-time">{formatRelative(e.endedAt)}</span>
                  </div>
                  <div className="m-ended-meta">
                    <span>{e.purpose}</span>
                    <span>·</span>
                    <span>{e.agentCount} AGT</span>
                    <span className="m-spacer" />
                    <span className={`m-badge-reason ${e.reason}`}>{e.reason.toUpperCase()}</span>
                  </div>
                </button>
              );
            })}
          </>
        )}

        <h3 className="m-sec">Bus health</h3>
        <div className="m-bus-grid">
          {busCells.map((cell) => (
            <div key={cell.k} className="m-bus-cell">
              <div className="m-bus-k">{cell.k}</div>
              <div
                className="m-bus-v"
                style={{ color: cell.warn && cell.v !== '—' && Number(cell.v) > 0 ? 'var(--warn)' : 'var(--text)' }}
              >
                {cell.v}
                {cell.u && cell.v !== '—' && <span className="m-bus-u">{cell.u}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
