import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  HttpError,
  type CodegraphScope,
  type CodegraphGraph,
  type CodegraphHit,
  type CodegraphNode,
  type CodegraphLink,
} from '../api/client';

interface State {
  scopes: CodegraphScope[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
}

const EMPTY_STATE: State = { scopes: [], loading: true, error: null, unavailable: false };

/** One neighbor of a node (incoming or outgoing). */
export interface CodegraphNeighbor {
  node: CodegraphNode;
  relation: string | null;
}

/** Incoming + outgoing neighbors for a selected node, computed client-side. */
export interface CodegraphNeighbors {
  incoming: CodegraphNeighbor[];
  outgoing: CodegraphNeighbor[];
}

/** Parse `source_location` ("L3", "L3-L9") to a 1-based line, or null. */
export function parseLine(loc: string | null | undefined): number | null {
  if (!loc) return null;
  const m = /(\d+)/.exec(loc);
  return m ? Number(m[1]) : null;
}

/** Format a node's file:line for display. */
export function nodeFileLabel(node: CodegraphNode): string {
  const file = node.source_file ?? null;
  const line = parseLine(node.source_location);
  if (!file) return '';
  return line ? `${file}:${line}` : file;
}

/**
 * Compute the immediate neighbors of `nodeId` from the graph's link set.
 * Runs entirely client-side — no backend round-trip — because the full
 * graph.json is cached once per scope selection.
 */
export function computeNeighbors(nodeId: string, graph: CodegraphGraph): CodegraphNeighbors {
  const nodeMap = new Map<string, CodegraphNode>(graph.nodes.map((n) => [n.id, n]));
  const incoming: CodegraphNeighbor[] = [];
  const outgoing: CodegraphNeighbor[] = [];
  for (const link of graph.links as CodegraphLink[]) {
    if (link.source === nodeId) {
      const n = nodeMap.get(link.target);
      if (n) outgoing.push({ node: n, relation: link.relation ?? null });
    }
    if (link.target === nodeId) {
      const n = nodeMap.get(link.source);
      if (n) incoming.push({ node: n, relation: link.relation ?? null });
    }
  }
  return { incoming, outgoing };
}

/**
 * Code-graph hook — mirrors `useBoard` in structure.
 * Polls the scope list; caches each scope's full graph.json in a ref so
 * selecting a node shows neighbors instantly. `graphRev` bumps force a
 * re-poll (driven by `code.graph.*` WS events from the controller).
 */
export function useCodeGraph(
  graphRev = 0,
  refreshMs = 10_000,
  enabled = true,
): State & {
  refresh: () => Promise<void>;
  graph: CodegraphGraph | null;
  graphLoading: boolean;
  loadGraph: (scopeId: string) => Promise<void>;
  search: (scopeId: string, q: string) => Promise<CodegraphHit[]>;
} {
  const [state, setState] = useState<State>(EMPTY_STATE);
  const [graph, setGraph] = useState<CodegraphGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  // Cache: scopeId → graph. Cleared when graphRev bumps (re-index happened).
  const graphCacheRef = useRef<Map<string, CodegraphGraph>>(new Map());

  // Clear the graph cache on re-index so stale data is never shown.
  const prevRevRef = useRef(graphRev);
  useEffect(() => {
    if (graphRev !== prevRevRef.current) {
      graphCacheRef.current.clear();
      setGraph(null);
    }
    prevRevRef.current = graphRev;
  }, [graphRev]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listCodegraphScopes();
      setState({ scopes: res.scopes, loading: false, error: null, unavailable: false });
    } catch (err) {
      const is404 = err instanceof HttpError && err.status === 404;
      setState({
        scopes: [],
        loading: false,
        error: is404 ? null : err instanceof Error ? err.message : String(err),
        unavailable: is404,
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(t);
  }, [refresh, refreshMs, enabled, graphRev]);

  const loadGraph = useCallback(async (scopeId: string) => {
    const cached = graphCacheRef.current.get(scopeId);
    if (cached) {
      setGraph(cached);
      return;
    }
    setGraphLoading(true);
    try {
      const g = await api.getCodegraphGraph(scopeId);
      graphCacheRef.current.set(scopeId, g);
      setGraph(g);
    } catch {
      // keep existing graph; error is not surfaced (scope may not be indexed)
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const search = useCallback(async (scopeId: string, q: string): Promise<CodegraphHit[]> => {
    if (!q.trim()) return [];
    try {
      const res = await api.searchCodegraph(scopeId, q, 30);
      if (!res.ok) return [];
      return res.results;
    } catch {
      return [];
    }
  }, []);

  return { ...state, refresh, graph, graphLoading, loadGraph, search };
}
