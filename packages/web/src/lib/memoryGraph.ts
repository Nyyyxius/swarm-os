// packages/web/src/lib/memoryGraph.ts
//
// Pure graph maths for the Memory view: a deterministic, BOUNDED force-directed
// layout that replaces MapView's hub-and-spoke `layoutTeams`.
//
// Why d3-force here and not an animation loop: the layout is computed once,
// synchronously, by ticking the simulation a fixed number of times and then
// reading the settled positions. No `requestAnimationFrame`, no `simulation.on
// ('tick')` — so the same code runs identically in a Vitest/jsdom test as in
// the browser, and never spins forever.
//
// Determinism: d3-force's Barnes-Hut charge + link forces jiggle coincident
// nodes using a random source. We (a) seed initial positions on a ring so no
// two nodes start coincident, and (b) install a seeded PRNG as the simulation's
// random source, so `runForceLayout(x)` twice yields byte-identical output.

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphEdge } from '../api/client';

/** Nominal layout canvas — matches MapView's VBW/VBH so the shell feels alike. */
export const GRAPH_W = 1200;
export const GRAPH_H = 900;

export interface XY {
  x: number;
  y: number;
}

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

export interface LayoutResult {
  /** name → position, for O(1) edge endpoint lookup. */
  positions: Record<string, XY>;
  /** Nodes with settled coordinates (same order as input). */
  nodes: PositionedNode[];
  /** Edges whose BOTH endpoints exist in `nodes` (dangling edges dropped). */
  edges: GraphEdge[];
}

export interface ForceLayoutOptions {
  width?: number;
  height?: number;
  /** Number of simulation ticks. Bounded on purpose — never an RAF loop. */
  iterations?: number;
  /** Seed for the PRNG so layouts are reproducible. */
  seed?: number;
  /** Charge strength (negative = repulsion). */
  charge?: number;
  /** Target link length. */
  linkDistance?: number;
}

/** Mulberry32 — a tiny, fast, deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimNode extends SimulationNodeDatum {
  name: string;
  index: number;
}
type SimLink = SimulationLinkDatum<SimNode>;

/**
 * Compute a settled force-directed layout for `nodes`/`edges`.
 *
 * Returns a position for EVERY node (finite coordinates guaranteed), plus the
 * subset of edges that actually connect two present nodes. Safe on empty input.
 */
export function runForceLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  opts: ForceLayoutOptions = {},
): LayoutResult {
  const width = opts.width ?? GRAPH_W;
  const height = opts.height ?? GRAPH_H;
  const iterations = Math.max(0, opts.iterations ?? 300);
  const seed = opts.seed ?? 0x5eed;
  const charge = opts.charge ?? -320;
  const linkDistance = opts.linkDistance ?? 100;
  const cx = width / 2;
  const cy = height / 2;

  if (nodes.length === 0) {
    return { positions: {}, nodes: [], edges: [] };
  }

  const rng = mulberry32(seed);

  // Deterministic ring seeding — distinct start positions avoid the coincident
  // -node jiggle path entirely on tick 0.
  const ringR = Math.min(width, height) * 0.32;
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    return {
      name: n.name,
      index: i,
      x: cx + Math.cos(angle) * ringR,
      y: cy + Math.sin(angle) * ringR,
      vx: 0,
      vy: 0,
    };
  });

  const byName = new Map<string, SimNode>(simNodes.map((n) => [n.name, n]));
  const validEdges = edges.filter((e) => byName.has(e.from) && byName.has(e.to));
  const simLinks: SimLink[] = validEdges.map((e) => ({ source: e.from, target: e.to }));

  const sim = forceSimulation<SimNode>(simNodes)
    // Seed the random source BEFORE adding forces so each force initialises
    // with our PRNG (d3 re-initialises forces on `.force()` add).
    .randomSource(rng)
    .force('charge', forceManyBody<SimNode>().strength(charge))
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.name)
        .distance(linkDistance)
        .strength(0.55),
    )
    .force('center', forceCenter<SimNode>(cx, cy))
    .force('collide', forceCollide<SimNode>(36))
    .stop();

  for (let i = 0; i < iterations; i++) sim.tick();

  const positions: Record<string, XY> = {};
  const positioned: PositionedNode[] = [];
  for (const sn of simNodes) {
    const x = Number.isFinite(sn.x) ? (sn.x as number) : cx;
    const y = Number.isFinite(sn.y) ? (sn.y as number) : cy;
    positions[sn.name] = { x, y };
    const orig = nodes[sn.index]!;
    positioned.push({ ...orig, x, y });
  }

  return { positions, nodes: positioned, edges: validEdges };
}

/**
 * Axis-aligned bounding box of a set of points, padded. Used to derive the
 * initial SVG viewBox so the whole graph is framed on first paint. Falls back
 * to the nominal canvas for empty input, and enforces a minimum extent so a
 * single node is not framed at zero width.
 */
export function boundingBox(
  points: readonly XY[],
  pad = 140,
): { x: number; y: number; w: number; h: number } {
  if (points.length === 0) return { x: 0, y: 0, w: GRAPH_W, h: GRAPH_H };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const MIN = 240;
  let w = maxX - minX;
  let h = maxY - minY;
  if (w < MIN) {
    const cx = (minX + maxX) / 2;
    minX = cx - MIN / 2;
    w = MIN;
  }
  if (h < MIN) {
    const cy = (minY + maxY) / 2;
    minY = cy - MIN / 2;
    h = MIN;
  }
  return { x: minX - pad, y: minY - pad, w: w + pad * 2, h: h + pad * 2 };
}

/**
 * Build a `{nodes, edges}` graph model from the loose list of note metas and a
 * server graph payload. When the server graph is unavailable, callers can pass
 * `nodes` derived from the note list and `edges` derived from `[[wikilinks]]`.
 * Dangling edges (endpoint missing from `nodes`) are dropped so the layout and
 * the renderer never dereference an absent node.
 */
export function buildGraphModel(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const present = new Set(nodes.map((n) => n.name));
  return {
    nodes: nodes.slice(),
    edges: edges.filter((e) => present.has(e.from) && present.has(e.to)),
  };
}
