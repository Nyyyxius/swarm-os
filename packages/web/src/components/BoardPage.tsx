// packages/web/src/components/BoardPage.tsx
//
// Durable task board (Kanban) — read-only web overlay (Phase 4).
//
// Layout (mirrors MemoryPage's sidebar + main pattern):
//
//   ┌──────────────┬────────────────────────────────────────────┬─────────────────┐
//   │ .board-side  │ .board-main (5 columns: Kanban grid)        │ .board-detail   │
//   │  team select │  todo | doing | blocked | review | done     │  card detail    │
//   │  filter      │  card tiles                                  │  + audit trail  │
//   └──────────────┴────────────────────────────────────────────┴─────────────────┘
//
// Data: useBoard (poll 5 s) + live boardRev from SwarmController (taskboard.* WS).
// Writes: DELETE only (soft-delete orphaned/stale cards). No drag, no edit, no create.

import { useCallback, useEffect, useState } from 'react';
import { useSwarmController } from '../controller/SwarmController';
import { useBoard } from '../hooks/useBoard';
import {
  api,
  apiErrorMessage,
  type BoardCard,
  type BoardCardDetail,
  type BoardStatus,
} from '../api/client';
import { ICON } from './desktop/icons';

interface Props {
  open: boolean;
  onClose: () => void;
}

const COLUMNS: { status: BoardStatus; label: string }[] = [
  { status: 'todo', label: 'TO DO' },
  { status: 'doing', label: 'DOING' },
  { status: 'blocked', label: 'BLOCKED' },
  { status: 'review', label: 'REVIEW' },
  { status: 'done', label: 'DONE' },
];

function priorityLabel(p: number): string {
  if (p <= 1) return 'P1';
  if (p === 2) return 'P2';
  if (p === 3) return 'P3';
  return 'P' + String(p);
}

function priorityCls(p: number): string {
  if (p <= 1) return 'board-prio p1';
  if (p === 2) return 'board-prio p2';
  return 'board-prio p3';
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}

export function BoardPage({ open, onClose }: Props) {
  const { boardRev, orchestrators } = useSwarmController();

  // ── team selector ────────────────────────────────────────────────────────
  const [selectedOrchId, setSelectedOrchId] = useState<string | null>(null);

  const { cards, teams, loading, error, unavailable, refresh } = useBoard(
    selectedOrchId,
    5000,
    open,
  );

  // Re-fetch when a live taskboard.* WS event fires.
  useEffect(() => {
    if (!open || boardRev === 0) return;
    void refresh();
  }, [boardRev, open, refresh]);

  // Auto-select first team that has cards.
  useEffect(() => {
    if (!open) return;
    if (selectedOrchId) return;
    if (teams.length === 0) return;
    setSelectedOrchId(teams[0]?.orchestratorId ?? null);
  }, [open, teams, selectedOrchId]);

  // ── card detail panel ────────────────────────────────────────────────────
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BoardCardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const d = await api.getBoardCard(id);
      setDetail(d);
    } catch (err) {
      setDetailError(apiErrorMessage(err));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedCardId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    void loadDetail(selectedCardId);
  }, [selectedCardId, loadDetail]);

  // Refresh detail when board refreshes.
  useEffect(() => {
    if (!selectedCardId || !open) return;
    void loadDetail(selectedCardId);
  }, [boardRev, open, selectedCardId, loadDetail]);

  // ── delete (soft) ────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<BoardCard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteBoardCard(deleteTarget.id);
      setDeleteTarget(null);
      if (selectedCardId === deleteTarget.id) {
        setSelectedCardId(null);
        setDetail(null);
      }
      await refresh();
    } catch (err) {
      setDeleteError(apiErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, selectedCardId, refresh]);

  // ── orchestrator name lookup ──────────────────────────────────────────────
  function orchName(orchId: string): string {
    const o = orchestrators.find((x) => x.id === orchId);
    return o?.name ?? shortId(orchId);
  }

  if (!open) return null;

  // Columns: split cards by status (excludes hidden).
  const cardsByStatus = (status: BoardStatus): BoardCard[] =>
    cards.filter((c) => c.status === status && !c.hiddenAt);

  const gridTemplate = detail
    ? '220px 1fr 340px'
    : '220px 1fr';

  return (
    <div
      className="board-overlay"
      style={{ gridTemplateColumns: gridTemplate }}
      role="dialog"
      aria-label="Task Board"
    >
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="board-side roles-side">
        <div className="board-side-head">
          <span className="board-side-title">BOARD</span>
          <button className="icon-btn" onClick={onClose} title="close">{ICON.kill}</button>
        </div>

        {/* Team selector */}
        <div className="board-team-select">
          <label className="board-label">TEAM</label>
          <select
            className="board-select"
            value={selectedOrchId ?? ''}
            onChange={(e) => {
              setSelectedOrchId(e.target.value || null);
              setSelectedCardId(null);
              setDetail(null);
            }}
          >
            <option value="">— choose team —</option>
            {teams.map((t) => (
              <option key={t.orchestratorId} value={t.orchestratorId}>
                {orchName(t.orchestratorId)} ({t.open} open / {t.total})
              </option>
            ))}
          </select>
        </div>

        {/* Card count per column */}
        {selectedOrchId && !unavailable && (
          <div className="board-col-counts">
            {COLUMNS.map(({ status, label }) => {
              const n = cardsByStatus(status).length;
              return (
                <div key={status} className="board-count-row">
                  <span className={`board-status-dot ${status}`} />
                  <span className="board-count-label">{label}</span>
                  <span className="board-count-num">{n}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Info / errors */}
        {unavailable && (
          <div className="board-unavail">
            <div className="board-unavail-title">Not available</div>
            <div className="board-unavail-sub">
              The taskboard surface is absent on this backend.
            </div>
          </div>
        )}
        {error && <div className="board-error">{error}</div>}
      </aside>

      {/* ── main (Kanban columns) ────────────────────────────────────────── */}
      <main className="board-main">
        {loading && !cards.length && (
          <div className="board-loading">Loading…</div>
        )}

        {!loading && !unavailable && !selectedOrchId && (
          <div className="board-empty">
            <div className="board-empty-title">Select a team to view its board</div>
          </div>
        )}

        {!loading && !unavailable && selectedOrchId && !cards.filter((c) => !c.hiddenAt).length && (
          <div className="board-empty">
            <div className="board-empty-title">No cards</div>
            <div className="board-empty-sub">
              Cards are created by agents through the <code>board.*</code> MCP tools.
            </div>
          </div>
        )}

        {selectedOrchId && !unavailable && (
          <div className="board-columns">
            {COLUMNS.map(({ status, label }) => {
              const col = cardsByStatus(status);
              return (
                <div key={status} className={`board-col board-col-${status}`}>
                  <div className="board-col-head">
                    <span className={`board-status-dot ${status}`} />
                    <span className="board-col-label">{label}</span>
                    <span className="board-col-count">{col.length}</span>
                  </div>
                  <div className="board-col-cards">
                    {col.map((card) => (
                      <button
                        key={card.id}
                        className={[
                          'board-card',
                          card.orphanedAt ? 'orphaned' : '',
                          selectedCardId === card.id ? 'selected' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() =>
                          setSelectedCardId(
                            selectedCardId === card.id ? null : card.id,
                          )
                        }
                        title={card.orphanedAt ? 'Orphaned — assignee disconnected' : undefined}
                      >
                        <div className="board-card-head">
                          <span className={priorityCls(card.priority)}>
                            {priorityLabel(card.priority)}
                          </span>
                          {card.orphanedAt && (
                            <span className="board-orphan-badge" title="orphaned">ORPHAN</span>
                          )}
                          {card.autoCreated && (
                            <span className="board-auto-badge" title="auto-created at spawn">AUTO</span>
                          )}
                        </div>
                        <div className="board-card-title">{card.title}</div>
                        {card.assigneeSessionId && (
                          <div className="board-card-assignee">
                            {shortId(card.assigneeSessionId)}
                          </div>
                        )}
                        {card.labels.length > 0 && (
                          <div className="board-card-labels">
                            {card.labels.map((l) => (
                              <span key={l} className="board-label-chip">{l}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* ── detail panel ────────────────────────────────────────────────── */}
      {detail && (
        <aside className="board-detail">
          <div className="board-detail-head">
            <span className="board-detail-title">CARD DETAIL</span>
            <button
              className="icon-btn"
              onClick={() => {
                setSelectedCardId(null);
                setDetail(null);
              }}
              title="close detail"
            >
              {ICON.kill}
            </button>
          </div>

          {detailLoading && <div className="board-loading">Loading…</div>}

          {!detailLoading && (
            <div className="board-detail-body">
              <h2 className="board-detail-card-title">{detail.title}</h2>

              <div className="board-detail-meta">
                <span className={`board-status-dot ${detail.status}`} />
                <span className="board-detail-meta-val">{detail.status.toUpperCase()}</span>
                <span className="board-detail-sep">·</span>
                <span className={priorityCls(detail.priority)}>
                  {priorityLabel(detail.priority)}
                </span>
                {detail.orphanedAt && (
                  <>
                    <span className="board-detail-sep">·</span>
                    <span className="board-orphan-badge">ORPHAN</span>
                  </>
                )}
              </div>

              {detail.assigneeSessionId && (
                <div className="board-detail-row">
                  <span className="board-detail-key">Assignee</span>
                  <span className="board-detail-val">{detail.assigneeSessionId}</span>
                </div>
              )}

              {detail.labels.length > 0 && (
                <div className="board-detail-row">
                  <span className="board-detail-key">Labels</span>
                  <div className="board-card-labels">
                    {detail.labels.map((l) => (
                      <span key={l} className="board-label-chip">{l}</span>
                    ))}
                  </div>
                </div>
              )}

              {detail.body && (
                <div className="board-detail-section">
                  <div className="board-detail-section-title">Description</div>
                  <pre className="board-detail-body-text">{detail.body}</pre>
                </div>
              )}

              {detail.dependsOn.length > 0 && (
                <div className="board-detail-section">
                  <div className="board-detail-section-title">Depends on</div>
                  <ul className="board-dep-list">
                    {detail.dependsOn.map((dep) => (
                      <li key={dep} className="board-dep-item">
                        <button
                          className="board-dep-link"
                          onClick={() => setSelectedCardId(dep)}
                        >
                          {dep}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {detail.blocks.length > 0 && (
                <div className="board-detail-section">
                  <div className="board-detail-section-title">Blocks</div>
                  <ul className="board-dep-list">
                    {detail.blocks.map((dep) => (
                      <li key={dep} className="board-dep-item">
                        <button
                          className="board-dep-link"
                          onClick={() => setSelectedCardId(dep)}
                        >
                          {dep}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Audit timeline */}
              {detail.events.length > 0 && (
                <div className="board-detail-section">
                  <div className="board-detail-section-title">Timeline</div>
                  <ol className="board-timeline">
                    {detail.events.map((ev) => (
                      <li key={ev.id} className={`board-tl-item board-tl-${ev.kind}`}>
                        <div className="board-tl-dot" />
                        <div className="board-tl-content">
                          <span className="board-tl-kind">{ev.kind}</span>
                          {ev.actorSessionId && (
                            <span className="board-tl-actor">
                              {' '}by {shortId(ev.actorSessionId)}
                            </span>
                          )}
                          <span className="board-tl-ts">{fmtTs(ev.ts)}</span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Delete button — primarily for orphaned cards */}
              <div className="board-detail-actions">
                {deleteTarget?.id === detail.id ? (
                  <div className="board-delete-confirm">
                    <span className="board-delete-confirm-msg">Delete this card?</span>
                    {deleteError && <span className="board-delete-err">{deleteError}</span>}
                    <div className="board-delete-confirm-btns">
                      <button
                        className="board-btn danger"
                        onClick={confirmDelete}
                        disabled={deleting}
                      >
                        {deleting ? 'Deleting…' : 'Confirm'}
                      </button>
                      <button
                        className="board-btn"
                        onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                        disabled={deleting}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className={`board-btn danger${detail.orphanedAt ? ' prominent' : ''}`}
                    onClick={() => setDeleteTarget(detail)}
                    title="Soft-delete this card"
                  >
                    {ICON.trash}
                    <span>Delete card</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {detailError && <div className="board-error">{detailError}</div>}
        </aside>
      )}

      {/* Delete confirmation for cards deleted without opening detail */}
      {deleteTarget && deleteTarget.id !== detail?.id && (
        <div className="board-delete-modal">
          <div className="board-delete-confirm">
            <span className="board-delete-confirm-msg">
              Delete &ldquo;{deleteTarget.title}&rdquo;?
            </span>
            {deleteError && <span className="board-delete-err">{deleteError}</span>}
            <div className="board-delete-confirm-btns">
              <button className="board-btn danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Confirm'}
              </button>
              <button
                className="board-btn"
                onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                disabled={deleting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
