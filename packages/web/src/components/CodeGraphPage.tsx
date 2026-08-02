// packages/web/src/components/CodeGraphPage.tsx
//
// Code knowledge graph overlay — `#/graph`. Search-first UX:
//
//   ┌──────────────────────┬──────────────────────────────────────────┐
//   │ .cg-side             │ .cg-main                                 │
//   │  scope selector      │  (empty) prompt to search or pick scope  │
//   │  scope status        │  (node selected) label + file:line       │
//   │  search box          │    + outgoing neighbors                  │
//   │  search results      │    + incoming neighbors                  │
//   │  (click → select)    │    (click neighbor → navigate)           │
//   └──────────────────────┴──────────────────────────────────────────┘
//
// The full graph.json is fetched ONCE per scope (cached in useCodeGraph),
// and neighbors are computed client-side — no extra backend round-trip.
// Live updates ride `graphRev` from `code.graph.*` WS events.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSwarmController } from '../controller/SwarmController';
import { useCodeGraph, computeNeighbors, nodeFileLabel, parseLine } from '../hooks/useCodeGraph';
import type { CodegraphHit, CodegraphNode } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CodeGraphPage({ open, onClose }: Props) {
  const { graphRev } = useSwarmController();
  const { scopes, loading, unavailable, graph, graphLoading, loadGraph, search } = useCodeGraph(
    graphRev,
    10_000,
    open,
  );

  const [selectedScopeId, setSelectedScopeId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CodegraphHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-select first enabled scope when the page opens and scopes load.
  useEffect(() => {
    if (!open) return;
    if (scopes.length === 0) return;
    if (selectedScopeId && scopes.some((s) => s.id === selectedScopeId)) return;
    const first = scopes.find((s) => s.enabled) ?? scopes[0];
    if (first) setSelectedScopeId(first.id);
  }, [open, scopes, selectedScopeId]);

  // Load graph.json when scope changes.
  useEffect(() => {
    if (!selectedScopeId || !open) return;
    void loadGraph(selectedScopeId);
  }, [selectedScopeId, open, loadGraph, graphRev]);

  // Reset selection when scope or query changes.
  useEffect(() => {
    setSelectedNodeId(null);
  }, [selectedScopeId]);

  // Debounced search.
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!selectedScopeId || !query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(() => {
      void search(selectedScopeId, query).then((hits) => {
        setResults(hits);
        setSearching(false);
      });
    }, 250);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, selectedScopeId, search]);

  // Pick a node: select it and (if graph not loaded yet) trigger load.
  const selectNode = useCallback(
    (hit: CodegraphHit) => {
      setSelectedNodeId(hit.id);
      if (!graph && selectedScopeId) void loadGraph(selectedScopeId);
    },
    [graph, selectedScopeId, loadGraph],
  );

  const selectNeighborNode = useCallback(
    (node: CodegraphNode) => {
      // Build a synthetic hit from the raw node so we can navigate to it.
      const hit: CodegraphHit = {
        id: node.id,
        label: node.label ?? node.id,
        file: node.source_file ?? null,
        line: parseLine(node.source_location),
        fileType: node.file_type ?? null,
        community: node.community_name ?? null,
      };
      selectNode(hit);
    },
    [selectNode],
  );

  if (!open) return null;

  // Determine display for the selected node.
  const selectedHit = results.find((r) => r.id === selectedNodeId) ?? null;
  const selectedNodeRaw = graph?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const neighbors =
    selectedNodeId && graph ? computeNeighbors(selectedNodeId, graph) : null;

  const selectedScope = scopes.find((s) => s.id === selectedScopeId);

  return (
    <div className="cg-overlay" style={{ gridTemplateColumns: '300px 1fr' }}>
      {/* ── left sidebar ── */}
      <aside className="cg-side">
        <div className="cg-side-head">
          <span className="cg-side-title">CODE GRAPH</span>
          <button className="cg-close" onClick={onClose}>✕ CLOSE</button>
        </div>

        {/* scope selector */}
        <div className="cg-scope-select">
          <label className="board-label">SCOPE</label>
          <select
            className="board-select"
            value={selectedScopeId}
            onChange={(e) => {
              setSelectedScopeId(e.target.value);
              setQuery('');
              setResults([]);
              setSelectedNodeId(null);
            }}
          >
            {scopes.length === 0 && (
              <option value="">— no scopes —</option>
            )}
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.path} ({s.kind}){s.enabled ? '' : ' [disabled]'}
              </option>
            ))}
          </select>
        </div>

        {/* scope status */}
        {selectedScope && (
          <div className="cg-scope-info">
            <span className={`dot ${selectedScope.enabled ? 'ok' : 'stopped'}`} style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 6, background: selectedScope.enabled ? 'var(--ok)' : 'var(--stopped)' }} />
            <span style={{ color: selectedScope.enabled ? 'var(--ok)' : 'var(--text-mute)' }}>
              {selectedScope.status}
            </span>
            {selectedScope.nodeCount > 0 && (
              <span style={{ marginLeft: 10 }}>
                {selectedScope.nodeCount} nodes · {selectedScope.edgeCount} edges
              </span>
            )}
            {selectedScope.lastError && (
              <div style={{ color: 'var(--bad)', marginTop: 4, fontSize: 11 }}>
                {selectedScope.lastError}
              </div>
            )}
          </div>
        )}

        {/* search box */}
        <div className="cg-search">
          <input
            type="text"
            placeholder="search nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!selectedScopeId}
          />
        </div>

        {/* results list */}
        <div className="cg-results">
          {loading && (
            <div className="cg-result" style={{ cursor: 'default', color: 'var(--text-mute)' }}>
              loading scopes…
            </div>
          )}
          {!loading && unavailable && (
            <div className="cg-result" style={{ cursor: 'default', color: 'var(--text-mute)' }}>
              code graph not available on this server
            </div>
          )}
          {!loading && !unavailable && scopes.length === 0 && (
            <div style={{ padding: '16px 18px', color: 'var(--text-mute)', fontSize: 12 }}>
              No code scope indexed yet.
            </div>
          )}
          {searching && (
            <div className="cg-result" style={{ cursor: 'default', color: 'var(--text-mute)' }}>
              searching…
            </div>
          )}
          {!searching && query.trim() && results.length === 0 && selectedScopeId && (
            <div style={{ padding: '12px 18px', color: 'var(--text-mute)', fontSize: 12 }}>
              No results for <em>{query}</em>
            </div>
          )}
          {results.map((hit) => (
            <div
              key={hit.id}
              className={`cg-result${selectedNodeId === hit.id ? ' selected' : ''}`}
              onClick={() => selectNode(hit)}
            >
              <span className="cg-result-label">{hit.label}</span>
              {(hit.file || hit.line) && (
                <span className="cg-result-meta">
                  {hit.file ?? ''}{hit.line ? `:${hit.line}` : ''}
                </span>
              )}
              {hit.community && (
                <span className="cg-result-community">{hit.community}</span>
              )}
            </div>
          ))}
          {!query.trim() && !loading && !unavailable && selectedScopeId && (
            <div style={{ padding: '12px 18px', color: 'var(--text-mute)', fontSize: 11 }}>
              Type to search nodes by name, file, or community.
            </div>
          )}
        </div>
      </aside>

      {/* ── main area ── */}
      <div className="cg-main">
        {!selectedNodeId && (
          <div className="cg-empty">
            <div className="cg-empty-title">
              {unavailable ? 'GRAPH UNAVAILABLE' : scopes.length === 0 ? 'NO SCOPES INDEXED' : 'SELECT A NODE'}
            </div>
            <div className="cg-empty-sub">
              {unavailable
                ? 'The code graph backend is not available on this server.'
                : scopes.length === 0
                ? 'No code scope has been indexed yet. Run graphify on a workspace directory to populate the graph.'
                : 'Search for a node in the sidebar and click it to explore its connections.'}
            </div>
          </div>
        )}

        {selectedNodeId && (
          <>
            {/* node header */}
            <div className="cg-main-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cg-main-title">
                  {selectedHit?.label ?? selectedNodeRaw?.label ?? selectedNodeId}
                </div>
                <div className="cg-main-file">
                  {selectedHit
                    ? (selectedHit.file
                      ? `${selectedHit.file}${selectedHit.line ? `:${selectedHit.line}` : ''}`
                      : '')
                    : selectedNodeRaw
                    ? nodeFileLabel(selectedNodeRaw)
                    : ''}
                </div>
              </div>
              {(selectedHit?.community ?? selectedNodeRaw?.community_name) && (
                <span className="cg-main-community">
                  {selectedHit?.community ?? selectedNodeRaw?.community_name}
                </span>
              )}
              {graphLoading && (
                <span style={{ color: 'var(--text-mute)', fontSize: 11, fontFamily: 'Geist Mono, monospace' }}>
                  loading graph…
                </span>
              )}
            </div>

            {/* neighbors */}
            <div className="cg-neighbors">
              {!graph && !graphLoading && (
                <div className="cg-empty-sub" style={{ textAlign: 'left' }}>
                  Graph not yet available for this scope.
                </div>
              )}

              {neighbors && (
                <>
                  <div className="cg-section-title">
                    OUTGOING — {neighbors.outgoing.length} CONNECTION{neighbors.outgoing.length !== 1 ? 'S' : ''}
                  </div>
                  {neighbors.outgoing.length === 0 ? (
                    <div style={{ color: 'var(--text-mute)', fontSize: 12, marginBottom: 20 }}>
                      No outgoing connections.
                    </div>
                  ) : (
                    <div className="cg-neighbor-list">
                      {neighbors.outgoing.map((nb, i) => (
                        <div
                          key={`out-${nb.node.id}-${i}`}
                          className="cg-neighbor"
                          onClick={() => selectNeighborNode(nb.node)}
                        >
                          <span className="cg-neighbor-dir">→</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="cg-neighbor-label">
                              {nb.node.label ?? nb.node.id}
                            </div>
                            {nodeFileLabel(nb.node) && (
                              <div className="cg-neighbor-file">{nodeFileLabel(nb.node)}</div>
                            )}
                          </div>
                          {nb.relation && (
                            <span className="cg-neighbor-rel">{nb.relation}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="cg-section-title">
                    INCOMING — {neighbors.incoming.length} CONNECTION{neighbors.incoming.length !== 1 ? 'S' : ''}
                  </div>
                  {neighbors.incoming.length === 0 ? (
                    <div style={{ color: 'var(--text-mute)', fontSize: 12 }}>
                      No incoming connections.
                    </div>
                  ) : (
                    <div className="cg-neighbor-list">
                      {neighbors.incoming.map((nb, i) => (
                        <div
                          key={`in-${nb.node.id}-${i}`}
                          className="cg-neighbor"
                          onClick={() => selectNeighborNode(nb.node)}
                        >
                          <span className="cg-neighbor-dir">←</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="cg-neighbor-label">
                              {nb.node.label ?? nb.node.id}
                            </div>
                            {nodeFileLabel(nb.node) && (
                              <div className="cg-neighbor-file">{nodeFileLabel(nb.node)}</div>
                            )}
                          </div>
                          {nb.relation && (
                            <span className="cg-neighbor-rel">{nb.relation}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
