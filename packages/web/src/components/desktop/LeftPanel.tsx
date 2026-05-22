// packages/web/src/components/desktop/LeftPanel.tsx
//
// Phase B.5 — wired LeftPanel. Owns its own polling (MESSAGE FLOW + BUS
// HEALTH + per-orchestrator sparklines) and adapts the canonical
// `OrchestratorView[]` (passed down from `DesktopShell`'s single
// `useOrchestrators` poll) into the row models. Cf.
// `docs/redesign-desktop/05_leftpanel-data-binding.md`.

import { useEffect, useRef, useState } from 'react';
import Sparkline from './Sparkline';
import BigGraph from './BigGraph';
import { formatRelative } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import {
  api,
  type BusMetricsSnapshot,
  type OrchestratorView,
} from '../../api/client';
import {
  ENDED_DISPLAY_CAP,
  filterActive,
  filterEnded,
  toLeftPanelEnded,
  useMessageFlow,
  useServerMessagesMetrics,
  type MessageFlowSource,
} from '../../lib/leftPanelAdapters';

/** Forme minimale d'une équipe pour la liste PER-TEAM TRAFFIC. */
export interface LeftPanelTeam {
  id: string;
  name: string;
  purpose: string;
  msgCount: number;
  status: string;
  leadId: string;
  workerCount: number;
  /** Spark per-team 8 pts (S9 `/metrics/messages.per_orchestrator[id]`). */
  spark?: readonly number[];
}

/** Forme minimale d'un orchestrator terminé (RECENTLY ENDED). */
export interface LeftPanelEnded {
  id: string;
  name: string;
  purpose: string;
  endedAt: string;
  reason: string;
  agentCount: number;
}

interface Props {
  /** Snapshot live des orchestrators (depuis `useOrchestrators` au-dessus). */
  orchestrators: readonly OrchestratorView[];
  /**
   * Clic sur une team active → reçoit le `sessionId` du lead (utile pour
   * `DesktopShell.selectedSessionId`).
   */
  onSelectTeam: (sessionId: string) => void;
  /**
   * Clic sur une team terminée → reçoit l'`OrchestratorView.id`. Le parent
   * route vers `#/orchestrators/:id` ; le `RightPanel` détecte
   * `endedAt != null` et passe son composer en read-only.
   */
  onSelectEnded: (orchestratorId: string) => void;
  /** Source du big graph MESSAGE FLOW. Default : `'s4-client'`. */
  messageFlowSource?: MessageFlowSource;
}

export default function LeftPanel({
  orchestrators,
  onSelectTeam,
  onSelectEnded,
  messageFlowSource = 's4-client',
}: Props) {
  // ── MESSAGE FLOW (S4 client par défaut, S9 server si demandé) ──────────
  const flow = useMessageFlow(orchestrators, messageFlowSource);

  // ── PER-TEAM TRAFFIC sparklines (S9 per-orchestrator). Indépendant du
  //    choix MESSAGE FLOW : S4 n'expose pas le per-orch. ────────────────
  const serverMsgs = useServerMessagesMetrics();
  const perOrchSparks = serverMsgs?.per_orchestrator ?? null;

  // ── Listes dérivées ───────────────────────────────────────────────────
  const activeTeams = filterActive(orchestrators);
  const ended = filterEnded(orchestrators).slice(0, ENDED_DISPLAY_CAP);

  // Re-render toutes les 30 s pour rafraîchir "Ns ago" / "Nm ago" sur les
  // ended rows. Pas besoin de garder la valeur ; l'effet de bord suffit.
  useNow(30_000);

  // ── BUS HEALTH (S8, 3 s) ──────────────────────────────────────────────
  const busHealth = useBusHealth(3_000);

  return (
    <aside className="panel-left">
      {/* ============ MESSAGE FLOW ============ */}
      <div className="pl-section">
        <h3>MESSAGE FLOW <span className="tag">// LIVE</span></h3>
        <div className="big-number">
          {flow.total.toLocaleString()}
          <span className="delta">+{flow.perMinute}/min</span>
        </div>
        <div className="big-sub">TOTAL EXCHANGED · LAST 60 MIN</div>
        <div className="graph"><BigGraph data={flow.history} /></div>
      </div>

      {/* ============ PER-TEAM TRAFFIC ============ */}
      <div className="pl-section grow">
        <h3>PER-TEAM TRAFFIC <span className="count">{activeTeams.length}</span></h3>
        <div className="team-list">
          {activeTeams.map((orch) => {
            const offline =
              orch.health === 'stopped' ||
              orch.status === 'stopped' ||
              orch.status === 'failed';
            const tag =
              orch.status === 'starting'
                ? 'STARTING'
                : offline
                  ? 'OFFLINE'
                  : 'ONLINE';
            const sparkColorVal = offline ? '#5a4d3f' : 'var(--amber)';
            const spark = perOrchSparks?.[orch.id] ?? [];
            const workers = Math.max(0, orch.sessions.length - 1);
            const purpose = (orch.role || '—').toUpperCase().slice(0, 16);
            const targetSessionId = orch.leadSessionId ?? orch.id;
            return (
              <div
                key={orch.id}
                className="team-row"
                onClick={() => onSelectTeam(targetSessionId)}
              >
                <div className="tr-name">
                  <span className="swatch" style={{ background: sparkColorVal }} />
                  {orch.name}
                </div>
                <div className="tr-count">{(orch.msgCount ?? 0).toLocaleString()}</div>
                <div className="tr-meta">
                  <span>{purpose}</span>
                  <span>·</span>
                  <span>{1 + workers} AGT</span>
                  <span>·</span>
                  <span
                    style={{
                      color: offline
                        ? 'var(--text-mute)'
                        : tag === 'STARTING'
                          ? 'var(--amber-soft)'
                          : 'var(--ok)',
                    }}
                  >
                    {tag}
                  </span>
                </div>
                <div className="tr-spark">
                  <Sparkline values={spark} color={sparkColorVal} />
                </div>
              </div>
            );
          })}
          {activeTeams.length === 0 && (
            <div
              style={{
                color: 'var(--text-mute)',
                fontFamily: 'Geist Mono, monospace',
                fontSize: 10,
                padding: '8px 0',
              }}
            >
              — no active teams —
            </div>
          )}
        </div>
      </div>

      {/* ============ RECENTLY ENDED (conditionnel) ============ */}
      {ended.length > 0 && (
        <div className="pl-section cap">
          <h3>RECENTLY ENDED <span className="count">{ended.length}</span></h3>
          <div className="team-list">
            {ended.map((orch) => {
              const e = toLeftPanelEnded(orch);
              return (
                <div
                  key={e.id}
                  className="ended-row"
                  onClick={() => onSelectEnded(orch.id)}
                >
                  <div className="ended-name">{e.name}</div>
                  <div className="ended-time">{formatRelative(e.endedAt)}</div>
                  <div className="ended-meta">
                    <span>{e.purpose}</span>
                    <span>·</span>
                    <span>{e.agentCount} AGT</span>
                    <span style={{ flex: 1 }} />
                    <span className={`badge-reason ${e.reason}`}>
                      {e.reason.toUpperCase()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============ BUS HEALTH (S8, refresh 3 s) ============ */}
      <div className="pl-section">
        <h3>BUS HEALTH</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            fontFamily: 'Geist Mono, monospace',
            fontSize: 10,
            letterSpacing: '0.10em',
          }}
        >
          <BusHealthCell
            label="LATENCY"
            value={busHealth?.latency_ms}
            suffix="ms"
            decimals={0}
          />
          <BusHealthCell
            label="THROUGHPUT"
            value={busHealth?.throughput_msg_per_s}
            suffix="/s"
            decimals={1}
          />
          <BusHealthCell
            label="QUEUE"
            value={busHealth?.queue_depth}
            decimals={0}
          />
          <BusHealthCell
            label="ERR RATE"
            value={busHealth?.err_rate_pct}
            suffix="%"
            decimals={1}
            warnColor
          />
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BusHealthCellProps {
  label: string;
  value: number | undefined;
  suffix?: string;
  decimals?: number;
  warnColor?: boolean;
}

function BusHealthCell({
  label,
  value,
  suffix,
  decimals = 0,
  warnColor = false,
}: BusHealthCellProps) {
  const formatted =
    value === undefined || !Number.isFinite(value)
      ? '—'
      : value.toFixed(decimals);
  const isMissing = formatted === '—';
  const valueColor =
    !isMissing && warnColor && Number(formatted) > 0
      ? 'var(--warn)'
      : 'var(--text)';
  return (
    <div>
      <div style={{ color: 'var(--text-mute)' }}>{label}</div>
      <div style={{ color: valueColor, fontSize: 14, marginTop: 2 }}>
        {formatted}
        {suffix && !isMissing && (
          <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>{suffix}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Poll `/metrics/bus` every `intervalMs`. Returns the latest successful
 * snapshot, or `null` until the first response arrives. Tolerates errors
 * (404 if server built without `BusMetricsCollector`, 401 token expired,
 * etc.) — cells stay at `—`.
 */
function useBusHealth(intervalMs: number): BusMetricsSnapshot | null {
  const [snap, setSnap] = useState<BusMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsBus();
        if (!cancelledRef.current) setSnap(s);
      } catch {
        /* keep previous, transient errors OK */
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return snap;
}
