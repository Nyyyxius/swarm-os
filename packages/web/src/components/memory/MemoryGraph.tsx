// packages/web/src/components/memory/MemoryGraph.tsx
//
// The Memory knowledge-graph canvas. It reuses MapView's proven SVG pan/zoom
// shell (viewBox state + wheel/pointer gestures), `curveBetween` for Bézier
// edges and `NodeShape` for the node glyphs — but swaps the hub-and-spoke
// `layoutTeams` for the deterministic force-directed layout in
// `lib/memoryGraph.ts`. Node positions are computed with `useMemo`, so a poll
// that returns an identical graph yields identical positions (no jitter).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GraphNode, GraphEdge, MemoryNoteType } from '../../api/client';
import { runForceLayout, boundingBox, GRAPH_W, GRAPH_H } from '../../lib/memoryGraph';
import type { Shape } from '../../lib/roleShape';
import NodeShape from '../desktop/NodeShape';
import { curveBetween } from '../desktop/curveBetween';

interface Props {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  selectedName: string | null;
  onSelect: (name: string | null) => void;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Tip {
  x: number;
  y: number;
  name: string;
  type: string;
  description?: string;
}

/** Memory note type → reused MapView node shape. */
const TYPE_SHAPE: Record<string, Shape> = {
  user: 'halfmoon',
  feedback: 'diamondS',
  project: 'triangle',
  reference: 'square',
  entity: 'dot',
  decision: 'diamond',
};
export function shapeForType(type: MemoryNoteType): Shape {
  return TYPE_SHAPE[type] ?? 'circle';
}

/** Type → accent, drawn strictly from desktop-theme.css tokens (no new colors). */
const TYPE_ACCENT: Record<string, string> = {
  user: 'var(--info)',
  feedback: 'var(--warn)',
  project: 'var(--amber)',
  reference: 'var(--text-dim)',
  entity: 'var(--ok)',
  decision: 'var(--bad)',
};
export function accentForType(type: MemoryNoteType): string {
  return TYPE_ACCENT[type] ?? 'var(--text-mute)';
}

/** Stable signature so the layout memo only recomputes on a real graph change. */
function graphSignature(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const n = nodes.map((x) => `${x.name}:${x.type}`).join('|');
  const e = edges.map((x) => `${x.from}>${x.to}`).join('|');
  return `${n}##${e}`;
}

export default function MemoryGraph({ nodes, edges, selectedName, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [panning, setPanning] = useState(false);

  const sig = useMemo(() => graphSignature(nodes, edges), [nodes, edges]);
  const layout = useMemo(
    () => runForceLayout(nodes, edges, { iterations: 300 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );

  // Set of node names — used to decide when to re-fit the viewBox (a new/removed
  // node reframes; a pure position refresh of the same set does not).
  const nameSig = useMemo(() => layout.nodes.map((n) => n.name).sort().join('|'), [layout]);

  const initialBox = useMemo(() => {
    const b = boundingBox(layout.nodes);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }, [layout]);

  const [vb, setVb] = useState<ViewBox>(initialBox);
  const fitRef = useRef<string>('');

  // Re-fit only when the node-name set changes (first paint, add/remove node).
  useEffect(() => {
    if (fitRef.current !== nameSig) {
      fitRef.current = nameSig;
      setVb(initialBox);
    }
  }, [nameSig, initialBox]);

  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    panStart: { vbX: number; vbY: number; px: number; py: number } | null;
    pinchStart: { dist: number; midSvg: { x: number; y: number }; vb: ViewBox } | null;
    didDrag: boolean;
  }>({ pointers: new Map(), panStart: null, pinchStart: null, didDrag: false });

  const clientToSvg = useCallback(
    (cx: number, cy: number) => {
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
    },
    [vb],
  );

  const zoomAt = useCallback((focusSvg: { x: number; y: number }, factor: number) => {
    setVb((v) => {
      const minW = 120;
      const maxW = GRAPH_W * 6;
      const newW = Math.max(minW, Math.min(maxW, v.w * factor));
      const newH = Math.max(minW * (GRAPH_H / GRAPH_W), Math.min(maxW, v.h * factor));
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
      const newW = Math.max(120, Math.min(GRAPH_W * 6, start.vb.w * factor));
      const newH = Math.max(90, Math.min(GRAPH_H * 6, start.vb.h * factor));
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
    if (gestureRef.current.didDrag) {
      gestureRef.current.didDrag = false;
      return;
    }
    onSelect(null);
  }

  const positions = layout.positions;
  const zoomLevel = GRAPH_W / vb.w;

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
        <g>
          {layout.edges.map((e, i) => {
            const a = positions[e.from];
            const b = positions[e.to];
            if (!a || !b) return null;
            const active = selectedName === e.from || selectedName === e.to;
            // Server omits `relation` for plain `[[wikilinks]]` (relation
            // 'links'); anything present here is a typed relation worth labelling.
            const typed = !!e.relation && e.relation !== 'links';
            return (
              <path
                key={`E${i}`}
                className={`mem-edge ${typed ? 'typed' : ''} ${active ? 'active' : ''}`}
                d={curveBetween(a, b, 0.14)}
              />
            );
          })}
        </g>

        {/* Relation labels — drawn above the edges so they read on top. */}
        <g>
          {layout.edges.map((e, i) => {
            if (!e.relation || e.relation === 'links') return null;
            const a = positions[e.from];
            const b = positions[e.to];
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const active = selectedName === e.from || selectedName === e.to;
            const label = e.relation;
            // Cheap width estimate for the readability backdrop (monospace 8px).
            const w = label.length * 5.2 + 8;
            return (
              <g key={`L${i}`} transform={`translate(${mx}, ${my})`} pointerEvents="none">
                <rect className="mem-edge-label-bg" x={-w / 2} y={-6} width={w} height={11} rx={2} />
                <text className={`mem-edge-label ${active ? 'active' : ''}`} y={2.5}>
                  {label}
                </text>
              </g>
            );
          })}
        </g>

        <g>
          {layout.nodes.map((n) => {
            const p = positions[n.name];
            if (!p) return null;
            const r = 22;
            const selected = selectedName === n.name;
            const accent = accentForType(n.type);
            return (
              <g
                key={n.name}
                className="mem-node"
                transform={`translate(${p.x}, ${p.y})`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect(n.name);
                }}
                onMouseEnter={() =>
                  setTip({ x: p.x, y: p.y, name: n.name, type: n.type, description: n.description })
                }
                onMouseLeave={() => setTip(null)}
              >
                <circle className="mem-node-glow" r={r + 8} style={{ fill: accent }} />
                <circle
                  className={`mem-node-ring ${selected ? 'selected' : ''}`}
                  r={r}
                  style={{ stroke: accent }}
                />
                <NodeShape shape={shapeForType(n.type)} r={r} />
                <text className="mem-node-label" y={r + 16}>
                  {n.name}
                </text>
                <text className="mem-node-type" y={r + 28} style={{ fill: accent }}>
                  {String(n.type).toUpperCase()}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div className="canvas-tooltip" style={tooltipStyle(tip, wrapRef.current, vb)}>
          {tip.name}
          <div className="sub">
            {tip.type.toUpperCase()}
            {tip.description ? ` :: ${tip.description}` : ''}
          </div>
        </div>
      )}

      <div className="canvas-hud">
        <span>
          <span className="k">GRAPH</span> :: MEMORY/01
        </span>
        <span>
          <span className="k">NODES</span> :: {layout.nodes.length}
        </span>
        <span>
          <span className="k">ZOOM</span> :: {zoomLevel.toFixed(2)}x
        </span>
      </div>
      <div className="canvas-zoom">
        <button
          title="zoom out"
          onClick={(e) => {
            e.stopPropagation();
            zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1.18);
          }}
        >
          −
        </button>
        <button
          title="fit graph"
          onClick={(e) => {
            e.stopPropagation();
            setVb(initialBox);
          }}
        >
          ◇
        </button>
        <button
          title="zoom in"
          onClick={(e) => {
            e.stopPropagation();
            zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1 / 1.18);
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}

function tooltipStyle(tip: Tip, wrap: HTMLDivElement | null, vb: ViewBox): CSSProperties {
  if (!wrap) return { left: 0, top: 0 };
  const rect = wrap.getBoundingClientRect();
  const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
  const drawW = vb.w * scale;
  const drawH = vb.h * scale;
  const offX = (rect.width - drawW) / 2;
  const offY = (rect.height - drawH) / 2;
  const left = offX + (tip.x - vb.x) * scale;
  const top = offY + (tip.y - vb.y) * scale;
  return { left, top };
}
