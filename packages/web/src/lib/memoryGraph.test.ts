import { describe, it, expect } from 'vitest';
import {
  runForceLayout,
  boundingBox,
  buildGraphModel,
  mulberry32,
  GRAPH_W,
  GRAPH_H,
} from './memoryGraph';
import type { GraphNode, GraphEdge } from '../api/client';

const NODES: GraphNode[] = [
  { name: 'alpha', type: 'project' },
  { name: 'beta', type: 'entity' },
  { name: 'gamma', type: 'reference' },
  { name: 'delta', type: 'decision' },
];
const EDGES: GraphEdge[] = [
  { from: 'alpha', to: 'beta' },
  { from: 'beta', to: 'gamma' },
  { from: 'gamma', to: 'delta' },
  { from: 'delta', to: 'alpha' },
];

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces values in [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('runForceLayout', () => {
  it('handles empty input without throwing', () => {
    const out = runForceLayout([], []);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.positions).toEqual({});
  });

  it('returns a finite position for every node', () => {
    const out = runForceLayout(NODES, EDGES, { iterations: 120 });
    expect(out.nodes).toHaveLength(NODES.length);
    for (const n of NODES) {
      const p = out.positions[n.name];
      expect(p).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
  });

  it('is deterministic — same input + seed yields identical positions', () => {
    const a = runForceLayout(NODES, EDGES, { iterations: 150, seed: 7 });
    const b = runForceLayout(NODES, EDGES, { iterations: 150, seed: 7 });
    expect(a.positions).toEqual(b.positions);
  });

  it('drops edges whose endpoints are not present nodes', () => {
    const out = runForceLayout(NODES, [
      ...EDGES,
      { from: 'alpha', to: 'ghost' },
      { from: 'nobody', to: 'beta' },
    ]);
    expect(out.edges).toHaveLength(EDGES.length);
    expect(out.edges.every((e) => e.from !== 'ghost' && e.to !== 'ghost')).toBe(true);
  });

  it('terminates on a single isolated node (no coincident-node blow-up)', () => {
    const out = runForceLayout([{ name: 'solo', type: 'user' }], []);
    const p = out.positions['solo'];
    expect(p).toBeDefined();
    expect(Number.isFinite(p!.x)).toBe(true);
    expect(Number.isFinite(p!.y)).toBe(true);
  });

  it('preserves node type/description on the positioned output', () => {
    const withDesc: GraphNode[] = [{ name: 'x', type: 'project', description: 'hi' }];
    const out = runForceLayout(withDesc, []);
    expect(out.nodes[0]).toMatchObject({ name: 'x', type: 'project', description: 'hi' });
  });
});

describe('boundingBox', () => {
  it('falls back to the nominal canvas for empty input', () => {
    expect(boundingBox([])).toEqual({ x: 0, y: 0, w: GRAPH_W, h: GRAPH_H });
  });

  it('frames a set of points with padding', () => {
    const box = boundingBox([{ x: 0, y: 0 }, { x: 400, y: 300 }], 100);
    expect(box.x).toBe(-100);
    expect(box.y).toBe(-100);
    expect(box.w).toBe(600);
    expect(box.h).toBe(500);
  });

  it('enforces a minimum extent for a single point', () => {
    const box = boundingBox([{ x: 100, y: 100 }], 0);
    expect(box.w).toBeGreaterThanOrEqual(240);
    expect(box.h).toBeGreaterThanOrEqual(240);
  });
});

describe('buildGraphModel', () => {
  it('drops dangling edges', () => {
    const model = buildGraphModel(NODES, [
      { from: 'alpha', to: 'beta' },
      { from: 'alpha', to: 'missing' },
    ]);
    expect(model.edges).toEqual([{ from: 'alpha', to: 'beta' }]);
    expect(model.nodes).toHaveLength(NODES.length);
  });
});
