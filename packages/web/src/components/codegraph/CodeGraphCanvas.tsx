// packages/web/src/components/codegraph/CodeGraphCanvas.tsx
//
// The CODE GRAPH visual canvas — nodes + links, pan/zoom/pinch. It reuses the
// exact same proven pieces as the Memory graph:
//   - `runForceLayout` / `boundingBox` (lib/memoryGraph) for a deterministic,
//     BOUNDED, synchronous force layout (no RAF, no jitter on poll),
//   - `curveBetween` for Bézier edges,
//   - MapView's SVG pan/zoom shell (viewBox state + wheel/pointer gestures) and
//     its `.canvas-*` CSS classes.
//
// The input is always a BOUNDED subgraph (ego-subgraph or a small full scope) —
// see lib/codeGraphView — so we never feed 3000+ nodes into d3-force. Node
// positions are memoised on a stable signature, so an identical graph (e.g. a
// re-render from a WS poll) yields byte-identical positions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CodegraphNode, CodegraphLink } from '../../api/client';
import { runForceLayout, boundingBox, GRAPH_W, GRAPH_H } from '../../lib/memoryGraph';
import { codegraphToGraphModel } from '../../lib/codeGraphView';
import { nodeFileLabel } from '../../hooks/useCodeGraph';
import { curveBetween } from '../desktop/curveBetween';

interface Props {
  nodes: readonly CodegraphNode[];
  links: readonly CodegraphLink[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Optional HUD note, e.g. "120/512 voisins" when the neighbourhood is capped. */
  hudNote?: string | null;
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
  label: string;
  sub: string;
}

/**
 * file_type → accent, drawn strictly from existing desktop-theme.css tokens
 * (no new colours). 'document' reads dim; code (and anything else) reads as
 * the info accent.
 */
export function accentForFileType(fileType?: string | null): string {
  if (fileType === 'document') return 'var(--text-dim)';
  return 'var(--info)';
}

/** Truncate a label to ~24 chars for the on-node caption. */
export function truncateLabel(label: string, max = 24): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

/** Stable signature so the layout memo only recomputes on a real graph change. */
function graphSignature(nodes: readonly CodegraphNode[], links: readonly CodegraphLink[]): string {
  const n = nodes.map((x) => x.id).join('|');
  const e = links.map((x) => `${x.source}>${x.target}`).join('|');
  return `${n}##${e}`;
}

/** Short display sub-line for a node: file:line, else community, else ''. */
function nodeSubLabel(node: CodegraphNode): string {
  return nodeFileLabel(node) || node.community_name || '';
}

export default function CodeGraphCanvas({ nodes, links, selectedId, onSelect, hudNote }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [panning, setPanning] = useState(false);

  const sig = useMemo(() => graphSignature(nodes, links), [nodes, links]);
  const layout = useMemo(
    () => {
      const model = codegraphToGraphModel(nodes, links);
      return runForceLayout(model.nodes, model.edges, { iterations: 300 });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );

  // Raw-node lookup for label / file:line / community / file_type rendering.
  const metaById = useMemo(() => {
    const m = new Map<string, CodegraphNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Set of node ids — used to decide when to re-fit the viewBox (a new/removed
  // node reframes; a pure position refresh of the same set does not).
  const nameSig = useMemo(() => layout.nodes.map((n) => n.name).sort().join('|'), [layout]);

  const initialBox = useMemo(() => {
    const b = boundingBox(layout.nodes);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }, [layout]);

  const [vb, setVb] = useState<ViewBox>(initialBox);
  const fitRef = useRef<string>('');

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
    // A pan gesture must not deselect — the didDrag guard swallows that click.
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
            const active = selectedId === e.from || selectedId === e.to;
            return (
              <path
                key={`E${i}`}
                className={`cgc-edge ${active ? 'active' : ''}`}
                d={curveBetween(a, b, 0.14)}
              />
            );
          })}
        </g>

        <g>
          {layout.nodes.map((n) => {
            const p = positions[n.name];
            if (!p) return null;
            const meta = metaById.get(n.name);
            const label = truncateLabel(meta?.label ?? n.name);
            const sub = meta ? nodeSubLabel(meta) : '';
            const r = 22;
            const selected = selectedId === n.name;
            const accent = accentForFileType(meta?.file_type);
            const tipLabel = meta?.label ?? n.name;
            const tipSub = meta ? nodeFileLabel(meta) : '';
            return (
              <g
                key={n.name}
                className="cgc-node"
                data-id={n.name}
                transform={`translate(${p.x}, ${p.y})`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect(n.name);
                }}
                onMouseEnter={() => setTip({ x: p.x, y: p.y, label: tipLabel, sub: tipSub })}
                onMouseLeave={() => setTip(null)}
              >
                <circle className="cgc-node-glow" r={r + 8} style={{ fill: accent }} />
                <circle
                  className={`cgc-node-ring ${selected ? 'selected' : ''}`}
                  r={r}
                  style={{ stroke: accent }}
                />
                <circle className="cgc-node-dot" r={r * 0.34} style={{ fill: accent }} />
                <text className="cgc-node-label" y={r + 15}>
                  {label}
                </text>
                {sub && (
                  <text className="cgc-node-sub" y={r + 26}>
                    {truncateLabel(sub, 30)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div className="canvas-tooltip" style={tooltipStyle(tip, wrapRef.current, vb)}>
          {tip.label}
          {tip.sub && <div className="sub">{tip.sub}</div>}
        </div>
      )}

      <div className="canvas-hud">
        <span>
          <span className="k">GRAPH</span> :: CODE
        </span>
        <span>
          <span className="k">NODES</span> :: {layout.nodes.length}
        </span>
        <span>
          <span className="k">ZOOM</span> :: {zoomLevel.toFixed(2)}x
        </span>
        {hudNote && (
          <span className="cgc-hud-note">
            <span className="k">◭</span> {hudNote}
          </span>
        )}
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
