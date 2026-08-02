import { describe, it, expect } from 'vitest';
import {
  buildEgoSubgraph,
  codegraphToGraphModel,
  FULL_GRAPH_MAX_NODES,
  DEFAULT_MAX_NEIGHBORS,
} from './codeGraphView';
import type { CodegraphGraph, CodegraphNode, CodegraphLink } from '../api/client';

// selected = 'a'; neighbours = b (out), c (in); b↔c edge exists; d is unrelated.
const GRAPH: CodegraphGraph = {
  nodes: [
    { id: 'a', label: 'A()' },
    { id: 'b', label: 'B()' },
    { id: 'c', label: 'C()' },
    { id: 'd', label: 'D()' },
  ],
  links: [
    { source: 'a', target: 'b', relation: 'calls' },
    { source: 'c', target: 'a', relation: 'imports_from' },
    { source: 'b', target: 'c', relation: 'calls' }, // neighbour↔neighbour
    { source: 'd', target: 'a' }, // makes d a neighbour too
  ],
};

describe('FULL_GRAPH_MAX_NODES', () => {
  it('is exported as 200', () => {
    expect(FULL_GRAPH_MAX_NODES).toBe(200);
  });
});

describe('buildEgoSubgraph', () => {
  it('keeps the selected node + its direct neighbours (in ∪ out)', () => {
    const ego = buildEgoSubgraph(GRAPH, 'a');
    const ids = ego.nodes.map((n) => n.id).sort();
    // a (self) + b, c, d (neighbours)
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
    expect(ego.truncated).toBe(false);
    expect(ego.totalNeighbors).toBe(3);
  });

  it('keeps ALL edges between kept nodes, including neighbour↔neighbour', () => {
    const ego = buildEgoSubgraph(GRAPH, 'a');
    const pairs = ego.links.map((l) => `${l.source}>${l.target}`).sort();
    expect(pairs).toEqual(['a>b', 'b>c', 'c>a', 'd>a']);
    // The b→c edge (neither endpoint is the selected node) is retained.
    expect(pairs).toContain('b>c');
  });

  it('returns just the selected node when it is isolated', () => {
    const g: CodegraphGraph = { nodes: [{ id: 'solo' }, { id: 'other' }], links: [] };
    const ego = buildEgoSubgraph(g, 'solo');
    expect(ego.nodes.map((n) => n.id)).toEqual(['solo']);
    expect(ego.links).toEqual([]);
    expect(ego.totalNeighbors).toBe(0);
    expect(ego.truncated).toBe(false);
  });

  it('returns empty when the selected id is absent from the graph', () => {
    const ego = buildEgoSubgraph(GRAPH, 'ghost');
    expect(ego.nodes).toEqual([]);
    expect(ego.links).toEqual([]);
    expect(ego.totalNeighbors).toBe(0);
  });

  it('returns empty for a null graph or falsy selection (never throws)', () => {
    expect(buildEgoSubgraph(null, 'a').nodes).toEqual([]);
    expect(buildEgoSubgraph(undefined, 'a').nodes).toEqual([]);
    expect(buildEgoSubgraph(GRAPH, null).nodes).toEqual([]);
    expect(buildEgoSubgraph(GRAPH, '').nodes).toEqual([]);
  });

  it('caps neighbours deterministically to maxNeighbors (alpha-ascending)', () => {
    // hub 'h' linked to 50 neighbours n00..n49.
    const nodes: CodegraphNode[] = [{ id: 'h' }];
    const links: CodegraphLink[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `n${String(i).padStart(2, '0')}`;
      nodes.push({ id });
      links.push({ source: 'h', target: id });
    }
    const ego = buildEgoSubgraph({ nodes, links }, 'h', { maxNeighbors: 10 });
    expect(ego.truncated).toBe(true);
    expect(ego.totalNeighbors).toBe(50);
    // 10 neighbours + the selected hub.
    expect(ego.nodes).toHaveLength(11);
    const kept = ego.nodes.map((n) => n.id).filter((id) => id !== 'h').sort();
    expect(kept).toEqual([
      'n00', 'n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09',
    ]);
    // Deterministic: same input → same output.
    const ego2 = buildEgoSubgraph({ nodes, links }, 'h', { maxNeighbors: 10 });
    expect(ego2.nodes.map((n) => n.id)).toEqual(ego.nodes.map((n) => n.id));
  });

  it('defaults maxNeighbors to DEFAULT_MAX_NEIGHBORS', () => {
    const nodes: CodegraphNode[] = [{ id: 'h' }];
    const links: CodegraphLink[] = [];
    for (let i = 0; i < DEFAULT_MAX_NEIGHBORS + 5; i++) {
      const id = `n${String(i).padStart(3, '0')}`;
      nodes.push({ id });
      links.push({ source: 'h', target: id });
    }
    const ego = buildEgoSubgraph({ nodes, links }, 'h');
    expect(ego.truncated).toBe(true);
    expect(ego.nodes).toHaveLength(DEFAULT_MAX_NEIGHBORS + 1);
  });
});

describe('codegraphToGraphModel', () => {
  it('maps id→name, file_type→type, label→description', () => {
    const model = codegraphToGraphModel(
      [
        { id: 'x', label: 'X()', file_type: 'code' },
        { id: 'y', label: null, file_type: 'document' },
        { id: 'z' }, // no file_type, no label
      ],
      [],
    );
    expect(model.nodes).toEqual([
      { name: 'x', type: 'code', description: 'X()' },
      { name: 'y', type: 'document', description: 'y' },
      { name: 'z', type: 'code', description: 'z' },
    ]);
  });

  it('maps links to edges and preserves relation', () => {
    const model = codegraphToGraphModel(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: 'a', target: 'b', relation: 'calls' }],
    );
    expect(model.edges).toEqual([{ from: 'a', to: 'b', relation: 'calls' }]);
  });

  it('omits relation when the link has none', () => {
    const model = codegraphToGraphModel([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }]);
    expect(model.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect('relation' in model.edges[0]!).toBe(false);
  });

  it('drops dangling edges (endpoint missing from the node set)', () => {
    const model = codegraphToGraphModel(
      [{ id: 'a' }, { id: 'b' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'missing' },
        { source: 'nobody', target: 'b' },
      ],
    );
    expect(model.edges).toEqual([{ from: 'a', to: 'b' }]);
  });
});
