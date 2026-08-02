import { useRef, useState } from 'react';
import { HttpError, type SkillInstallInput, type SkillInstallResult } from '../../api/client';

/**
 * Import-a-skill modal — two tabs mirroring the server's MVP import sources:
 *   - dir    → `{ source:'dir', dir }` (local folder path)
 *   - upload → raw `.tgz` to `POST /skills/upload`
 *
 * On success it closes and the caller refreshes the list. 422 (SKILL.md
 * invalid) and 502 (tar) errors are surfaced verbatim.
 */

interface Props {
  install: (source: SkillInstallInput) => Promise<SkillInstallResult>;
  upload: (file: File | Blob, name?: string) => Promise<SkillInstallResult>;
  onClose: () => void;
  onImported: (result: SkillInstallResult) => void;
}

type Tab = 'dir' | 'upload';

function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { last_error?: string; error?: string } | undefined;
    return body?.last_error || body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function SkillImportModal({ install, upload, onClose, onImported }: Props) {
  const [tab, setTab] = useState<Tab>('dir');
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const canSubmit =
    !busy &&
    ((tab === 'dir' && dir.trim() !== '') ||
      (tab === 'upload' && file != null));

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      let result: SkillInstallResult;
      if (tab === 'dir') {
        result = await install({ source: 'dir', dir: dir.trim() });
      } else {
        if (!file) return;
        result = await upload(file);
      }
      onImported(result);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

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
          width: 'min(520px, 92vw)',
          maxHeight: '86vh',
          overflowY: 'auto',
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ margin: '0 0 4px', color: 'var(--amber)' }}>IMPORT SKILL</h3>
        <div className="field-help" style={{ marginBottom: 16 }}>
          Import a skill from a local folder or a .tgz archive (SKILL.md required).
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          {(['dir', 'upload'] as Tab[]).map((t) => (
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
              {t === 'dir' ? 'FOLDER' : 'UPLOAD .TGZ'}
            </button>
          ))}
        </div>

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
