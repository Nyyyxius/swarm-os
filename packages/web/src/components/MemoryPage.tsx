// packages/web/src/components/MemoryPage.tsx
//
// The "Memory" overlay — a shared, Obsidian-style knowledge graph rendered
// inside SwarmOS (no external app). Built on the RolesPage overlay pattern
// (`position: fixed; inset: 56px 0 0 0`), it has three regions:
//
//   ┌───────────────┬───────────────────────────┬──────────────────┐
//   │ .roles-side   │ .mem-main (graph canvas)   │ .mem-note-panel  │
//   │  search box   │  force-directed graph      │  markdown + edit │
//   │  note list    │  (MemoryGraph)             │  (only when a    │
//   │  + NEW NOTE   │                            │   note is open)  │
//   └───────────────┴───────────────────────────┴──────────────────┘
//
// Data comes from `useMemoryNotes` (3 s poll) + live `memory.*` events surfaced
// by the shared controller (`memoryRev`). It degrades gracefully: if the
// backend memory surface is absent (404), the canvas shows an empty state
// instead of crashing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSwarmController } from '../controller/SwarmController';
import { useMemoryNotes } from '../hooks/useMemoryNotes';
import {
  api,
  apiErrorMessage,
  HttpError,
  type MemoryNote,
  type MemoryNoteType,
  type SearchHit,
} from '../api/client';
import MarkdownView from './memory/MarkdownView';
import MemoryGraph, { accentForType } from './memory/MemoryGraph';

interface Props {
  open: boolean;
  onClose: () => void;
}

const NOTE_TYPES: MemoryNoteType[] = [
  'user',
  'feedback',
  'project',
  'reference',
  'entity',
  'decision',
];

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function MemoryPage({ open, onClose }: Props) {
  const { memoryRev } = useSwarmController();
  const { notes, graph, loading, error, unavailable, refresh } = useMemoryNotes(3000, open);

  // ── sidebar search ─────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  // ── selected note ──────────────────────────────────────────────────────
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [note, setNote] = useState<MemoryNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteMissing, setNoteMissing] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // ── inline editor ──────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draftDesc, setDraftDesc] = useState('');
  const [draftType, setDraftType] = useState<MemoryNoteType>('reference');
  const [draftBody, setDraftBody] = useState('');
  const [opError, setOpError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Debounced search: empty query → show the full note list.
  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      let cancelled = false;
      api
        .searchMemory(q, { limit: 30 })
        .then((r) => {
          if (!cancelled) {
            setResults(r.results);
            setSearching(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearching(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }, 250);
    return () => clearTimeout(t);
  }, [search, open, memoryRev]);

  // Load the full note whenever the selection (or a reload trigger) changes.
  useEffect(() => {
    if (!selectedName) {
      setNote(null);
      setNoteMissing(false);
      setNoteError(null);
      return;
    }
    let cancelled = false;
    setNoteLoading(true);
    setNoteError(null);
    setNoteMissing(false);
    api
      .getMemoryNote(selectedName)
      .then((n) => {
        if (cancelled) return;
        setNote(n);
        setNoteLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setNoteLoading(false);
        if (err instanceof HttpError && err.status === 404) {
          setNote(null);
          setNoteMissing(true);
        } else {
          setNoteError(apiErrorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName, reloadKey]);

  // Live refresh on memory.* events (does not clobber an in-flight edit).
  useEffect(() => {
    if (!open) return;
    void refresh();
    if (selectedName && !editingRef.current) setReloadKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryRev]);

  const openNote = useCallback((name: string) => {
    if (editingRef.current && !confirm('Discard unsaved changes in this note?')) return;
    setEditing(false);
    setOpError(null);
    setSelectedName(name);
  }, []);

  function startEdit() {
    setDraftDesc(note?.description ?? '');
    setDraftType(note?.type ?? 'reference');
    setDraftBody(note?.body ?? '');
    setOpError(null);
    setEditing(true);
  }

  function newNote() {
    const raw = prompt('New note name (kebab-case slug):');
    if (!raw || !raw.trim()) return;
    const slug = slugify(raw);
    if (!slug) return;
    if (editingRef.current) setEditing(false);
    setSelectedName(slug);
    // Seed an empty editor immediately; the load effect will mark it missing.
    setNote(null);
    setNoteMissing(true);
    setDraftDesc('');
    setDraftType('reference');
    setDraftBody('');
    setOpError(null);
    setEditing(true);
  }

  async function save() {
    if (!selectedName || saving) return;
    setSaving(true);
    setOpError(null);
    try {
      const saved = await api.putMemoryNote(selectedName, {
        description: draftDesc,
        type: draftType,
        body: draftBody,
        ...(note ? { expectedVersion: note.version } : {}),
      });
      setNote(saved);
      setNoteMissing(false);
      setEditing(false);
      await refresh();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        setOpError(
          'Version conflict — this note was modified by another agent. Reload to see the latest, then re-apply your edit.',
        );
      } else {
        setOpError(apiErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    if (!selectedName) return;
    if (!confirm(`Delete note "${selectedName}"? This cannot be undone.`)) return;
    setOpError(null);
    try {
      await api.deleteMemoryNote(selectedName);
      setSelectedName(null);
      setNote(null);
      setEditing(false);
      await refresh();
    } catch (err) {
      setOpError(apiErrorMessage(err));
    }
  }

  function tryClose() {
    if (editingRef.current && !confirm('Discard unsaved changes in this note?')) return;
    setEditing(false);
    onClose();
  }

  const listNotes = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
    [notes],
  );

  if (!open) return null;

  const notePanelOpen = selectedName != null;

  return (
    <div
      className="mem-overlay"
      style={{ gridTemplateColumns: notePanelOpen ? '300px 1fr 380px' : '300px 1fr' }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="roles-side">
        <div className="roles-side-head">
          <button className="back" onClick={tryClose}>
            ← BACK TO MAP
          </button>
          <div className="title">MEMORY</div>
          <div className="sub">shared knowledge graph · all agents read + write</div>
        </div>

        <div className="mem-search">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search notes…"
            aria-label="search memory notes"
          />
        </div>

        <div className="roles-list">
          {loading && notes.length === 0 && !unavailable && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              loading…
            </div>
          )}
          {error && (
            <div className="field-warn" style={{ margin: 12 }}>
              {error}
            </div>
          )}

          {results !== null ? (
            <>
              {searching && (
                <div className="field-help" style={{ padding: '10px 20px' }}>
                  searching…
                </div>
              )}
              {!searching && results.length === 0 && (
                <div className="field-help" style={{ padding: '14px 20px' }}>
                  no matches for “{search.trim()}”.
                </div>
              )}
              {results.map((h) => (
                <div
                  key={h.name}
                  className={`role-item ${selectedName === h.name ? 'active' : ''}`}
                  onClick={() => openNote(h.name)}
                >
                  <div className="r-name">{h.name}</div>
                  <div className="r-id" style={{ color: accentForType(h.type) }}>
                    {String(h.type).toUpperCase()}
                  </div>
                  {h.snippet && (
                    <div className="mem-snippet">{h.snippet}</div>
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              {!loading && !error && notes.length === 0 && (
                <div className="field-help" style={{ padding: '14px 20px' }}>
                  {unavailable
                    ? 'Memory backend not available yet.'
                    : 'No notes yet — click "+ NEW NOTE" below.'}
                </div>
              )}
              {listNotes.map((n) => (
                <div
                  key={n.name}
                  className={`role-item ${selectedName === n.name ? 'active' : ''}`}
                  onClick={() => openNote(n.name)}
                >
                  <div className="r-name">{n.name}</div>
                  <div className="r-id" style={{ color: accentForType(n.type) }}>
                    {String(n.type).toUpperCase()}
                  </div>
                  {n.description && <div className="mem-snippet">{n.description}</div>}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="roles-add">
          <button
            className="btn"
            style={{ flex: 1 }}
            onClick={newNote}
            disabled={unavailable}
            title={unavailable ? 'memory backend unavailable' : 'create a new note'}
          >
            + NEW NOTE
          </button>
        </div>
      </aside>

      {/* ── Graph canvas ────────────────────────────────────────────────── */}
      <main className="mem-main">
        {unavailable ? (
          <div className="mem-empty">
            <div className="mem-empty-title">MEMORY OFFLINE</div>
            <div className="mem-empty-sub">
              The shared-memory backend is not available on this server yet. Once
              <code> /api/memory </code> is live, the knowledge graph appears here.
            </div>
          </div>
        ) : graph.nodes.length === 0 ? (
          <div className="mem-empty">
            <div className="mem-empty-title">EMPTY GRAPH</div>
            <div className="mem-empty-sub">
              No notes yet. Agents (and you) build the graph by writing notes and
              linking them with <code>[[wikilinks]]</code>.
            </div>
          </div>
        ) : (
          <MemoryGraph
            nodes={graph.nodes}
            edges={graph.edges}
            selectedName={selectedName}
            onSelect={(name) => (name ? openNote(name) : setSelectedName(null))}
          />
        )}
      </main>

      {/* ── Note panel ──────────────────────────────────────────────────── */}
      {notePanelOpen && (
        <section className="mem-note-panel">
          <div className="mem-note-head">
            <div className="mem-note-title">{selectedName}</div>
            <button
              className="h-edit"
              onClick={() => {
                setSelectedName(null);
                setEditing(false);
              }}
              title="close note"
            >
              ✕
            </button>
          </div>

          {noteError && (
            <div className="field-warn" style={{ margin: '0 0 12px', color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}>
              {noteError}
            </div>
          )}
          {opError && (
            <div className="field-warn" role="alert" style={{ margin: '0 0 12px', color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}>
              {opError}
            </div>
          )}

          {editing ? (
            <div className="mem-editor">
              <label className="mem-field">
                <span className="k">DESCRIPTION</span>
                <input
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  placeholder="one-line description (used for recall)"
                />
              </label>
              <label className="mem-field">
                <span className="k">TYPE</span>
                <select value={draftType} onChange={(e) => setDraftType(e.target.value as MemoryNoteType)}>
                  {NOTE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mem-field">
                <span className="k">BODY (markdown, [[wikilinks]])</span>
                <textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder="The fact, with [[links]] to neighbouring notes."
                  spellCheck={false}
                />
              </label>
              <div className="mem-note-actions">
                <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
                  CANCEL
                </button>
                <button
                  className="btn"
                  style={{ color: 'var(--amber)', borderColor: 'var(--border-strong)' }}
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? '… SAVING' : 'SAVE'}
                </button>
              </div>
            </div>
          ) : noteLoading ? (
            <div className="field-help">loading…</div>
          ) : noteMissing ? (
            <div className="mem-missing">
              <div className="field-help" style={{ marginBottom: 12 }}>
                Note <b>{selectedName}</b> does not exist yet.
              </div>
              <button className="btn" onClick={startEdit} disabled={unavailable}>
                + CREATE THIS NOTE
              </button>
            </div>
          ) : note ? (
            <>
              <div className="mem-note-meta">
                <span className="pill" style={{ color: accentForType(note.type), borderColor: 'var(--border-strong)' }}>
                  {String(note.type).toUpperCase()}
                </span>
                <span className="mem-note-sub">v{note.version}</span>
                {note.team && <span className="mem-note-sub">team {note.team}</span>}
                {note.createdBy && <span className="mem-note-sub">by {note.createdBy}</span>}
              </div>
              {note.description && <div className="mem-note-desc">{note.description}</div>}

              <div className="mem-note-body">
                <MarkdownView source={note.body} onOpenNote={openNote} />
              </div>

              {(note.outLinks.length > 0 || note.inLinks.length > 0) && (
                <div className="mem-links">
                  {note.outLinks.length > 0 && (
                    <div className="mem-links-row">
                      <span className="k">LINKS →</span>
                      <span className="mem-links-chips">
                        {note.outLinks.map((l) => (
                          <button key={l} className="mem-chip" onClick={() => openNote(l)}>
                            {l}
                          </button>
                        ))}
                      </span>
                    </div>
                  )}
                  {note.inLinks.length > 0 && (
                    <div className="mem-links-row">
                      <span className="k">← BACKLINKS</span>
                      <span className="mem-links-chips">
                        {note.inLinks.map((l) => (
                          <button key={l} className="mem-chip" onClick={() => openNote(l)}>
                            {l}
                          </button>
                        ))}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="mem-note-actions">
                <button className="btn" onClick={startEdit}>
                  EDIT
                </button>
                <button className="btn danger" onClick={() => void destroy()}>
                  DELETE
                </button>
              </div>
            </>
          ) : (
            <div className="field-help">—</div>
          )}
        </section>
      )}
    </div>
  );
}
