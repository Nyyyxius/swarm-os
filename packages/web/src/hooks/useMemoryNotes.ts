import { useCallback, useEffect, useState } from 'react';
import {
  api,
  HttpError,
  type MemoryNoteMeta,
  type GraphNode,
  type GraphEdge,
} from '../api/client';

/**
 * Shared-memory poll hook — same shape as `useOrchestrators` (a 3 s interval
 * that hydrates a snapshot). It fetches BOTH the note list and the graph in
 * one refresh so the sidebar and the canvas stay consistent.
 *
 * Feature-detection: if `/api/memory` answers 404, the backend predates this
 * surface — we flag `unavailable` and render a graceful empty state rather
 * than an error (the whole point of building the frontend ahead of the API).
 * If only the graph endpoint fails, we derive isolated nodes from the note
 * list so the canvas still shows something.
 */
export interface MemoryGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface State {
  notes: MemoryNoteMeta[];
  graph: MemoryGraphData;
  loading: boolean;
  error: string | null;
  /** True when the backend memory surface is absent (404). */
  unavailable: boolean;
}

const EMPTY_GRAPH: MemoryGraphData = { nodes: [], edges: [] };

export function useMemoryNotes(
  refreshMs = 3000,
  enabled = true,
): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>({
    notes: [],
    graph: EMPTY_GRAPH,
    loading: true,
    error: null,
    unavailable: false,
  });

  const refresh = useCallback(async () => {
    try {
      const notesRes = await api.listMemory();
      let graph: MemoryGraphData;
      try {
        const g = await api.getMemoryGraph();
        graph = { nodes: g.nodes, edges: g.edges };
      } catch {
        // Graph endpoint missing/erroring but notes present — derive isolated
        // nodes from the list so the canvas is not blank.
        graph = {
          nodes: notesRes.notes.map((n) => ({
            name: n.name,
            type: n.type,
            description: n.description,
          })),
          edges: [],
        };
      }
      setState({ notes: notesRes.notes, graph, loading: false, error: null, unavailable: false });
    } catch (err) {
      const is404 = err instanceof HttpError && err.status === 404;
      setState({
        notes: [],
        graph: EMPTY_GRAPH,
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
  }, [refresh, refreshMs, enabled]);

  return { ...state, refresh };
}
