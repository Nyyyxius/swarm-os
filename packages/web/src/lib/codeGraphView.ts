// packages/web/src/lib/codeGraphView.ts
//
// Pure graph maths for the CODE GRAPH visual view. Two responsibilities:
//
//   1. buildEgoSubgraph — bound a potentially huge scope (storyforge is 3272
//      nodes / 5186 links) down to a renderable neighbourhood: the selected
//      node + its direct neighbours (in ∪ out) + ALL edges between the kept
//      nodes (neighbour↔neighbour edges included, not just a star). The
//      neighbour set is deterministically capped so d3-force never chokes.
//
//   2. codegraphToGraphModel — map the NetworkX-shaped codegraph payload onto
//      the {GraphNode, GraphEdge} model that `runForceLayout` (lib/memoryGraph)
//      already understands, so the layout engine is reused verbatim.
//
// Everything here is pure and deterministic (no Date.now / Math.random) so the
// same input yields the same output — a hard requirement for the memoised,
// jitter-free layout in CodeGraphCanvas.

import type {
  CodegraphGraph,
  CodegraphNode,
  CodegraphLink,
  GraphNode,
  GraphEdge,
} from '../api/client';

/**
 * Node-count threshold below which the whole scope is rendered without a
 * selection. Above it, the UI asks the user to search + click a node so the
 * ego-subgraph keeps the force layout bounded.
 */
export const FULL_GRAPH_MAX_NODES = 200;

/** Default cap on the number of direct neighbours kept around a selection. */
export const DEFAULT_MAX_NEIGHBORS = 120;

export interface EgoSubgraph {
  nodes: CodegraphNode[];
  links: CodegraphLink[];
  /** True when the neighbour set was capped by `maxNeighbors`. */
  truncated: boolean;
  /** Number of distinct direct neighbours before the cap. */
  totalNeighbors: number;
}

/**
 * Build the bounded ego-subgraph around `selectedId`:
 *   - the selected node (always included, if present in the graph),
 *   - its direct neighbours (incoming ∪ outgoing),
 *   - ALL links whose BOTH endpoints are kept nodes.
 *
 * The neighbour set is capped deterministically: neighbour ids are sorted
 * ascending and the first `maxNeighbors` are kept. When capped, `truncated`
 * is true and `totalNeighbors` reports the pre-cap count.
 *
 * If `selectedId` is missing from the graph (or falsy), returns an empty
 * subgraph. If the node exists but is isolated, returns just that node. Never
 * throws — tolerates a null/malformed graph.
 */
export function buildEgoSubgraph(
  graph: CodegraphGraph | null | undefined,
  selectedId: string | null | undefined,
  opts: { maxNeighbors?: number } = {},
): EgoSubgraph {
  const empty: EgoSubgraph = { nodes: [], links: [], truncated: false, totalNeighbors: 0 };
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return empty;
  if (!selectedId) return empty;

  const nodeById = new Map<string, CodegraphNode>();
  for (const n of graph.nodes) {
    if (n && typeof n.id === 'string') nodeById.set(n.id, n);
  }

  // selectedId absent from the graph → nothing to show.
  if (!nodeById.has(selectedId)) return empty;

  // Direct neighbours (in ∪ out), excluding self, endpoint must be a real node.
  const neighborIds = new Set<string>();
  for (const l of graph.links) {
    if (!l) continue;
    if (l.source === selectedId && l.target !== selectedId && nodeById.has(l.target)) {
      neighborIds.add(l.target);
    }
    if (l.target === selectedId && l.source !== selectedId && nodeById.has(l.source)) {
      neighborIds.add(l.source);
    }
  }

  const totalNeighbors = neighborIds.size;
  const maxNeighbors = Math.max(0, opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS);

  // Deterministic cap: alpha-ascending, keep the first N.
  let keptNeighbors = [...neighborIds].sort();
  let truncated = false;
  if (keptNeighbors.length > maxNeighbors) {
    keptNeighbors = keptNeighbors.slice(0, maxNeighbors);
    truncated = true;
  }

  const kept = new Set<string>(keptNeighbors);
  kept.add(selectedId); // always include the selected node

  const nodes: CodegraphNode[] = [];
  for (const n of graph.nodes) {
    if (n && typeof n.id === 'string' && kept.has(n.id)) nodes.push(n);
  }

  // ALL links between kept nodes — keeps neighbour↔neighbour edges, not a star.
  const links: CodegraphLink[] = [];
  for (const l of graph.links) {
    if (!l) continue;
    if (kept.has(l.source) && kept.has(l.target)) links.push(l);
  }

  return { nodes, links, truncated, totalNeighbors };
}

/**
 * Map a codegraph node/link list onto the layout's {GraphNode, GraphEdge}
 * model:
 *   - node.name = node.id, node.type = node.file_type ?? 'code',
 *     node.description = node.label ?? node.id,
 *   - edge.from = link.source, edge.to = link.target,
 *     edge.relation = link.relation (omitted when absent — GraphEdge.relation
 *     is optional, so a nullish relation is simply left off).
 *
 * Edges with a missing endpoint (dangling) are dropped so the layout and the
 * renderer never dereference an absent node.
 */
export function codegraphToGraphModel(
  nodes: readonly CodegraphNode[],
  links: readonly CodegraphLink[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const present = new Set<string>();
  const outNodes: GraphNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') continue;
    present.add(n.id);
    outNodes.push({
      name: n.id,
      // file_type is a free-form Graphify tag ('code' | 'document' | …); the
      // layout only keys on `name`, so this cast is purely to satisfy the
      // shared GraphNode.type union without inventing a note type.
      type: (n.file_type ?? 'code') as GraphNode['type'],
      description: n.label ?? n.id,
    });
  }

  const edges: GraphEdge[] = [];
  for (const l of links) {
    if (!l) continue;
    if (!present.has(l.source) || !present.has(l.target)) continue; // drop dangling
    const edge: GraphEdge = { from: l.source, to: l.target };
    if (l.relation != null) edge.relation = l.relation;
    edges.push(edge);
  }

  return { nodes: outNodes, edges };
}
