import { useEffect, useRef, useState } from 'react';
import {
  HttpError,
  type MarketSearchResult,
  type SkillInstallInput,
  type SkillInstallResult,
} from '../../api/client';

/**
 * Import-a-skill modal — tabs covering all install sources:
 *   - dir    → `{ source:'dir', dir }` (local folder path)
 *   - upload → raw `.tgz` to `POST /skills/upload`
 *   - market → `{ source:'market', ref }` (name or owner/repo coordinate)
 *   - git    → `{ source:'git', url, ref?, subdir? }` (bonus — Lot 4b)
 *
 * On success it closes and the caller refreshes the list. 422/502 errors are
 * surfaced verbatim.
 */

interface Props {
  install: (source: SkillInstallInput) => Promise<SkillInstallResult>;
  upload: (file: File | Blob, name?: string) => Promise<SkillInstallResult>;
  marketSearch?: (q: string) => Promise<MarketSearchResult>;
  onClose: () => void;
  onImported: (result: SkillInstallResult) => void;
}

type Tab = 'dir' | 'upload' | 'market' | 'git';

const TAB_LABELS: Record<Tab, string> = {
  dir: 'FOLDER',
  upload: 'UPLOAD .TGZ',
  market: 'MARKETPLACE',
  git: 'GIT',
};

function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { last_error?: string; error?: string } | undefined;
    return body?.last_error || body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Compact marketplace search results section. */
function MarketSearch({
  marketSearch,
  onUse,
}: {
  marketSearch: (q: string) => Promise<MarketSearchResult>;
  onUse: (ref: string) => void;
}) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<MarketSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResult(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSearching(true);
      marketSearch(q.trim())
        .then((r) => setResult(r))
        .catch(() => setResult(null))
        .finally(() => setSearching(false));
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, marketSearch]);

  const unavailable = result && !result.available;

  return (
    <div style={{ marginBottom: 14 }}>
      <label className="field-help" style={{ display: 'block', marginBottom: 4 }}>
        search marketplace
      </label>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="pdf, docx, …"
        spellCheck={false}
        style={{ width: '100%' }}
        aria-label="marketplace search"
      />
      {searching && (
        <div className="field-help" style={{ marginTop: 4 }}>
          searching…
        </div>
      )}
      {unavailable && (
        <div className="field-help" style={{ marginTop: 6, color: 'var(--text-dim)' }}>
          Marketplace search not configured on this server — enter a name or{' '}
          <code>owner/repo</code> ref directly below.
        </div>
      )}
      {result?.available && result.error && (
        <div className="field-help" style={{ marginTop: 6, color: 'var(--amber)' }}>
          Search degraded: {result.error}
        </div>
      )}
      {result?.available && !result.error && result.results.length === 0 && q.trim().length >= 2 && !searching && (
        <div className="field-help" style={{ marginTop: 6 }}>
          No results for &ldquo;{q.trim()}&rdquo;
        </div>
      )}
      {result?.available && result.results.length > 0 && (
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          {result.results.map((entry) => (
            <div
              key={entry.name}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '6px 8px',
                background: 'var(--surface, rgba(0,0,0,0.2))',
                borderRadius: 4,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{entry.name}</div>
                {entry.description && (
                  <div className="field-help" style={{ marginTop: 2 }}>
                    {entry.description}
                  </div>
                )}
              </div>
              <button
                className="btn"
                style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
                onClick={() => onUse(entry.ref ?? entry.name)}
                type="button"
              >
                USE
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillImportModal({ install, upload, marketSearch, onClose, onImported }: Props) {
  const [tab, setTab] = useState<Tab>('dir');
  // dir tab
  const [dir, setDir] = useState('');
  // upload tab
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // market tab
  const [marketRef, setMarketRef] = useState('');
  // git tab
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitSubdir, setGitSubdir] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !busy &&
    ((tab === 'dir' && dir.trim() !== '') ||
      (tab === 'upload' && file != null) ||
      (tab === 'market' && marketRef.trim() !== '') ||
      (tab === 'git' && gitUrl.trim() !== ''));

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      let result: SkillInstallResult;
      if (tab === 'dir') {
        result = await install({ source: 'dir', dir: dir.trim() });
      } else if (tab === 'upload') {
        if (!file) return;
        result = await upload(file);
      } else if (tab === 'market') {
        result = await install({ source: 'market', ref: marketRef.trim() });
      } else {
        const body: SkillInstallInput = { source: 'git', url: gitUrl.trim() };
        if (gitRef.trim()) (body as { ref?: string }).ref = gitRef.trim();
        if (gitSubdir.trim()) (body as { subdir?: string }).subdir = gitSubdir.trim();
        result = await install(body);
      }
      onImported(result);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const tabs: Tab[] = ['dir', 'upload', 'market', 'git'];

  return (
    <div
      className="plugin-install-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Import skill"
        style={{
          background: 'var(--panel-solid, var(--panel))',
          border: '1px solid var(--border-strong, var(--border))',
          borderRadius: 8,
          padding: 22,
          width: 'min(560px, 92vw)',
          maxHeight: '86vh',
          overflowY: 'auto',
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ margin: '0 0 4px', color: 'var(--amber)' }}>IMPORT SKILL</h3>
        <div className="field-help" style={{ marginBottom: 16 }}>
          Import a skill from a local folder, archive, marketplace, or git repository (SKILL.md required).
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
          {tabs.map((t) => (
            <button
              key={t}
              className="btn"
              onClick={() => {
                setTab(t);
                setError(null);
              }}
              disabled={busy}
              style={
                tab === t ? { color: 'var(--amber)', borderColor: 'var(--amber)' } : undefined
              }
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/* ── FOLDER tab ── */}
        {tab === 'dir' && (
          <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            <label className="field-help">absolute path to the skill folder (must contain SKILL.md)</label>
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="/data/skills/my-skill"
              disabled={busy}
              spellCheck={false}
              style={{ width: '100%' }}
            />
          </div>
        )}

        {/* ── UPLOAD tab ── */}
        {tab === 'upload' && (
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <label className="field-help">skill tarball (.tgz, npm pack format — max 25 MB, SKILL.md at root)</label>
            <input
              ref={fileInput}
              type="file"
              accept=".tgz,.gz,application/gzip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            {file && (
              <div className="field-help">
                {file.name} — {(file.size / 1024).toFixed(0)} KB
              </div>
            )}
          </div>
        )}

        {/* ── MARKETPLACE tab ── */}
        {tab === 'market' && (
          <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
            {marketSearch && (
              <MarketSearch
                marketSearch={marketSearch}
                onUse={(ref) => { setMarketRef(ref); }}
              />
            )}
            <div>
              <label className="field-help" style={{ display: 'block', marginBottom: 4 }}>
                skill name or coordinate
              </label>
              <input
                value={marketRef}
                onChange={(e) => setMarketRef(e.target.value)}
                placeholder="pdf  or  anthropics/skills/skills/pdf  or  owner/repo@tag"
                disabled={busy}
                spellCheck={false}
                style={{ width: '100%' }}
                aria-label="marketplace ref"
              />
              <div className="field-help" style={{ marginTop: 4 }}>
                Examples:{' '}
                <code>pdf</code> · <code>owner/repo</code> · <code>owner/repo/sub/dir</code> ·{' '}
                <code>owner/repo@tag</code>
              </div>
              <div className="field-help" style={{ marginTop: 2, color: 'var(--text-dim)' }}>
                Skills from the marketplace arrive with <em>community</em> trust — assets require review before activation.
              </div>
            </div>
          </div>
        )}

        {/* ── GIT tab ── */}
        {tab === 'git' && (
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <div>
              <label className="field-help" style={{ display: 'block', marginBottom: 4 }}>git URL (required)</label>
              <input
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git"
                disabled={busy}
                spellCheck={false}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label className="field-help" style={{ display: 'block', marginBottom: 4 }}>branch / tag / commit (optional)</label>
              <input
                value={gitRef}
                onChange={(e) => setGitRef(e.target.value)}
                placeholder="main"
                disabled={busy}
                spellCheck={false}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label className="field-help" style={{ display: 'block', marginBottom: 4 }}>sub-directory (optional)</label>
              <input
                value={gitSubdir}
                onChange={(e) => setGitSubdir(e.target.value)}
                placeholder="skills/pdf"
                disabled={busy}
                spellCheck={false}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            className="field-warn"
            role="alert"
            style={{
              color: 'var(--bad)',
              borderLeftColor: 'var(--bad)',
              background: 'rgba(224, 101, 74, 0.06)',
              marginBottom: 16,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            CANCEL
          </button>
          <button
            className="btn"
            style={{ color: 'var(--amber)' }}
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? 'IMPORTING…' : 'IMPORT'}
          </button>
        </div>
      </div>
    </div>
  );
}
