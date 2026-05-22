// packages/web/src/components/desktop/MapView.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CENTER, VBW, VBH,
  layoutTeams,
  type MapTeam, type NodePosition,
} from './layoutTeams';
import Node, { type NodeAgent } from './Node';
import { curveBetween } from './curveBetween';
import { statusLabel } from '../../lib/format';

/** Forme attendue d'une équipe complète pour le MapView. Sur-ensemble de
 *  MapTeam : on ajoute `status` + nodes complets (lead + workers typés
 *  `NodeAgent`). */
export interface MapViewTeam extends MapTeam {
  status: string;
  lead: NodeAgent;
  workers: NodeAgent[];
}

/** Type d'un pulse animé sur la carte. */
export interface MapPulse {
  id: number | string;
  from: string;            // session id OR '__center__'
  to: string;              // session id OR '__center__'
  kind: 'intra' | 'cross' | 'human' | 'broadcast';
  /** Step 6 — wall-clock ms used by the dedupe window in `pushPulse`. */
  ts?: number;
}

interface Props {
  teams: readonly MapViewTeam[];
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  onBroadcast: () => void;
  pulses: readonly MapPulse[];
  spawningIds: ReadonlySet<string>;
  showIntra?: boolean;
}

interface Tip {
  x: number;
  y: number;
  name: string;
  role: string;
  team?: string;
  status: string;
  inbox?: number;
}

interface ViewBox { x: number; y: number; w: number; h: number; }

export default function MapView({
  teams, selectedId, onSelect, onBroadcast,
  pulses, spawningIds, showIntra = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [vb, setVb] = useState<ViewBox>({ x: 0, y: 0, w: VBW, h: VBH });
  const [panning, setPanning] = useState(false);

  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    panStart: { vbX: number; vbY: number; px: number; py: number } | null;
    pinchStart: { dist: number; midSvg: { x: number; y: number }; vb: ViewBox } | null;
    didDrag: boolean;
  }>({ pointers: new Map(), panStart: null, pinchStart: null, didDrag: false });

  const clientToSvg = useCallback((cx: number, cy: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const drawW = vb.w * scale;
    const drawH = vb.h * scale;
    const offX = (rect.width - drawW) / 2;
    const offY = (rect.height - drawH) / 2;
    return {
      x: vb.x + (cx - rect.left - offX) / scale,
      y: vb.y + (cy - rect.top - offY) / scale,
    };
  }, [vb]);

  const zoomAt = useCallback((focusSvg: { x: number; y: number }, factor: number) => {
    setVb((v) => {
      const newW = Math.max(VBW * 0.25, Math.min(VBW * 4, v.w * factor));
      const newH = Math.max(VBH * 0.25, Math.min(VBH * 4, v.h * factor));
      const k = newW / v.w;
      const newX = focusSvg.x - (focusSvg.x - v.x) * k;
      const newY = focusSvg.y - (focusSvg.y - v.y) * k;
      return { x: newX, y: newY, w: newW, h: newH };
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const focus = clientToSvg(e.clientX, e.clientY);
      const factor = Math.exp(e.deltaY * 0.0018);
      zoomAt(focus, factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clientToSvg, zoomAt]);

  // Pointer handlers : adaptés du v2 (map.jsx:205-258). Différence clé :
  // setPointerCapture n'est PAS appelé sur le pointerdown 1-pointeur. Si on
  // le faisait, la spec W3C Pointer Events ré-route `click` vers l'élément
  // capturé (le wrap), pas vers la cible originale (<g class="node">), et
  // l'onClick des Nodes ne fire jamais. On capture seulement quand le drag
  // est avéré (mouvement > 3 px) ou en pinch (2 pointeurs, pas de click
  // attendu).
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as Element).closest('.canvas-zoom')) return;
    const g = gestureRef.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.didDrag = false;
    if (g.pointers.size === 1) {
      g.panStart = { vbX: vb.x, vbY: vb.y, px: e.clientX, py: e.clientY };
      g.pinchStart = null;
    } else if (g.pointers.size === 2) {
      wrapRef.current?.setPointerCapture(e.pointerId);
      const [a, b] = [...g.pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midClient = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.pinchStart = { dist, midSvg: clientToSvg(midClient.x, midClient.y), vb: { ...vb } };
      g.panStart = null;
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1 && g.panStart) {
      const dx = e.clientX - g.panStart.px;
      const dy = e.clientY - g.panStart.py;
      if (!g.didDrag && Math.abs(dx) + Math.abs(dy) > 3) {
        g.didDrag = true;
        wrapRef.current?.setPointerCapture(e.pointerId);
        if (!panning) setPanning(true);
      }
      if (!g.didDrag) return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
      const panStart = g.panStart;
      setVb((v) => ({ ...v, x: panStart.vbX - dx / scale, y: panStart.vbY - dy / scale }));
    } else if (g.pointers.size === 2 && g.pinchStart) {
      const [a, b] = [...g.pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = g.pinchStart.dist / Math.max(1, dist);
      g.didDrag = true;
      const start = g.pinchStart;
      const newW = Math.max(VBW * 0.25, Math.min(VBW * 4, start.vb.w * factor));
      const newH = Math.max(VBH * 0.25, Math.min(VBH * 4, start.vb.h * factor));
      const k = newW / start.vb.w;
      const newX = start.midSvg.x - (start.midSvg.x - start.vb.x) * k;
      const newY = start.midSvg.y - (start.midSvg.y - start.vb.y) * k;
      setVb({ x: newX, y: newY, w: newW, h: newH });
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.pinchStart = null;
    if (g.pointers.size === 0) g.panStart = null;
    setPanning(false);
  }

  function handleCanvasClick() {
    if (gestureRef.current.didDrag) { gestureRef.current.didDrag = false; return; }
    onSelect(null);
  }

  const positions = useMemo(() => layoutTeams(teams), [teams]);

  function handleHover(agent: NodeAgent | null, pos: NodePosition | null) {
    if (!agent || !pos) { setTip(null); return; }
    const teamId = positions[agent.id]?.teamId;
    const team = teams.find((t) => t.id === teamId);
    setTip({
      x: pos.x, y: pos.y,
      name: agent.name, role: agent.role, team: team?.id,
      status: statusLabel(agent.status), inbox: agent.inbox,
    });
  }

  // Build edges arrays (Step 6 — memoized to avoid O(N·M) rebuild on every
  // `setPulses` re-render. Re-derived only when teams/positions change.)
  const leadLinks = useMemo(() => {
    const out: Array<{ a: typeof CENTER; b: NodePosition; teamId: string; status: string }> = [];
    teams.forEach((t) => {
      const lp = positions[t.lead.id];
      if (lp) out.push({ a: CENTER, b: lp, teamId: t.id, status: t.status });
    });
    return out;
  }, [teams, positions]);

  const teamEdges = useMemo(() => {
    const out: Array<{ a: NodePosition; b: NodePosition; teamId: string; status: string }> = [];
    teams.forEach((t) => {
      const lp = positions[t.lead.id];
      if (!lp) return;
      t.workers.forEach((w) => {
        const wp = positions[w.id];
        if (!wp) return;
        out.push({ a: lp, b: wp, teamId: t.id, status: t.status });
      });
    });
    return out;
  }, [teams, positions]);

  const intraEdges = useMemo(() => {
    const out: Array<{ a: NodePosition; b: NodePosition; teamId: string; status: string }> = [];
    teams.forEach((t) => {
      for (let i = 0; i < t.workers.length - 1; i++) {
        const w = t.workers[i];
        const nx = t.workers[i + 1];
        if (!w || !nx) continue;
        const a = positions[w.id];
        const b = positions[nx.id];
        if (!a || !b) continue;
        out.push({ a, b, teamId: t.id, status: t.status });
      }
    });
    return out;
  }, [teams, positions]);

  const selectedTeamId = useMemo<string | null>(() => {
    for (const t of teams) {
      if (t.lead.id === selectedId) return t.id;
      if (t.workers.some((w) => w.id === selectedId)) return t.id;
    }
    return null;
  }, [teams, selectedId]);

  return (
    <div
      className={`canvas-wrap ${panning ? 'panning' : ''}`}
      ref={wrapRef}
      onClick={handleCanvasClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="grid-bg" />
      <svg
        className="canvas-svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="hub-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%"  style={{ stopColor: 'var(--amber)', stopOpacity: 0.35 }} />
            <stop offset="60%" style={{ stopColor: 'var(--amber)', stopOpacity: 0.08 }} />
            <stop offset="100%" style={{ stopColor: 'var(--amber)', stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        <circle cx={CENTER.x} cy={CENTER.y} r={420} fill="url(#hub-glow)" />

        <g>
          {leadLinks.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'exited' || e.status === 'killed';
            const cls = `edge lead-link ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''} ${selectedTeamId === e.teamId ? 'highlight' : ''}`;
            return <path key={`L${i}`} className={cls} d={curveBetween(e.a, e.b, 0.04)} />;
          })}
          {teamEdges.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'exited' || e.status === 'killed';
            const cls = `edge ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''} ${selectedTeamId === e.teamId ? 'highlight' : ''}`;
            return <path key={`T${i}`} className={cls} d={curveBetween(e.a, e.b, 0.10)} />;
          })}
          {showIntra && intraEdges.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'exited' || e.status === 'killed';
            const cls = `edge intra ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''}`;
            return <path key={`I${i}`} className={cls} d={curveBetween(e.a, e.b, 0.30)} />;
          })}
        </g>

        <g>
          {pulses.map((p) => {
            const from = p.from === '__center__' ? CENTER : positions[p.from];
            const to   = p.to   === '__center__' ? CENTER : positions[p.to];
            if (!from || !to) return null;
            const kind = p.kind;
            const cls = `pulse-dot ${kind === 'human' ? 'human' : kind === 'broadcast' ? 'broadcast' : ''}`;
            const style: CSSProperties = {
              offsetPath: `path("${curveBetween(from, to, 0.10)}")`,
              animation: `pulse-travel ${kind === 'broadcast' ? '1800ms' : '1400ms'} linear forwards`,
            };
            return (
              <circle key={p.id} className={cls}
                r={kind === 'broadcast' ? 2.8 : 2.4} style={style} />
            );
          })}
        </g>

        <g className="center-hub"
          onClick={(e) => { e.stopPropagation(); onBroadcast(); }}>
          <circle className="outer" cx={CENTER.x} cy={CENTER.y} r={42} />
          <circle className="outer" cx={CENTER.x} cy={CENTER.y} r={26} opacity="0.55" />
          <circle className="inner" cx={CENTER.x} cy={CENTER.y} r={10} />
          <text x={CENTER.x} y={CENTER.y + 62}>SWARM // BUS</text>
          <text x={CENTER.x} y={CENTER.y + 76} opacity="0.6">
            click :: broadcast to all leads
          </text>
        </g>

        <g>
          {teams.map((team) => {
            const leadPos = positions[team.lead.id];
            if (!leadPos) return null;
            return (
              <g key={team.id}>
                <Node
                  agent={team.lead}
                  pos={leadPos}
                  isLead
                  selected={selectedId === team.lead.id}
                  spawning={spawningIds.has(team.lead.id)}
                  onClick={(a) => onSelect(a.id)}
                  onHover={handleHover}
                />
                {team.workers.map((w) => {
                  const wPos = positions[w.id];
                  if (!wPos) return null;
                  return (
                    <Node
                      key={w.id}
                      agent={w}
                      pos={wPos}
                      selected={selectedId === w.id}
                      spawning={spawningIds.has(w.id)}
                      onClick={(a) => onSelect(a.id)}
                      onHover={handleHover}
                    />
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div className="canvas-tooltip" style={tooltipStyle(tip, wrapRef.current, vb)}>
          {tip.name}
          <div className="sub">
            {tip.team} :: {tip.role} :: {tip.status}
            {tip.inbox !== undefined && tip.inbox > 0 && (
              <span style={{ color: 'var(--amber)' }}> · INBOX {tip.inbox}</span>
            )}
          </div>
        </div>
      )}

      <div className="canvas-hud">
        <span><span className="k">FRAME</span> :: SWARM-MAP/02</span>
        <span><span className="k">ZOOM</span> :: {(VBW / vb.w).toFixed(2)}x</span>
        <span><span className="k">VIEW</span> :: ORBIT</span>
      </div>
      <div className="canvas-zoom">
        <button title="zoom out"
          onClick={(e) => { e.stopPropagation(); zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1.18); }}>−</button>
        <button title="reset"
          onClick={(e) => { e.stopPropagation(); setVb({ x: 0, y: 0, w: VBW, h: VBH }); }}>◇</button>
        <button title="zoom in"
          onClick={(e) => { e.stopPropagation(); zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1 / 1.18); }}>+</button>
      </div>
    </div>
  );
}

function tooltipStyle(tip: Tip, wrap: HTMLDivElement | null, vb: ViewBox): CSSProperties {
  if (!wrap) return { left: 0, top: 0 };
  const rect = wrap.getBoundingClientRect();
  const scaleX = rect.width / vb.w;
  const scaleY = rect.height / vb.h;
  const scale = Math.min(scaleX, scaleY);
  const drawW = vb.w * scale;
  const drawH = vb.h * scale;
  const offX = (rect.width - drawW) / 2;
  const offY = (rect.height - drawH) / 2;
  const left = offX + (tip.x - vb.x) * scale;
  const top  = offY + (tip.y - vb.y) * scale;
  return { left, top };
}
