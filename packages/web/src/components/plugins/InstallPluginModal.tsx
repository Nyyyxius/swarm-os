import { useRef, useState } from 'react';
import { HttpError, type InstallSourceInput, type PluginInstallResult } from '../../api/client';

/**
 * Install-a-plugin modal — three tabs mirroring the server's install sources:
 *   - npm    → `{ source:'npm', spec }`
 *   - git    → `{ source:'git', url, ref? }`
 *   - upload → raw `.tgz` (npm pack format) to `POST /plugins/upload`
 *
 * On success it closes and the caller refreshes the list; 422 (validation) and
 * 502 (npm/git fetch) errors are surfaced verbatim with the server's
 * `last_error`. The upload tab sends the file as raw bytes (NOT JSON).
 */

interface Props {
  install: (source: InstallSourceInput) => Promise<PluginInstallResult>;
  upload: (file: File | Blob, name?: string) => Promise<PluginInstallResult>;
  onClose: () => void;
  onInstalled: (result: PluginInstallResult) => void;
}

type Tab = 'npm' | 'git' | 'upload';

/** Pull the server's message (422 last_error, 502 stderr, …) out of an error. */
function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { last_error?: string; error?: string } | undefined;
    return body?.last_error || body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function InstallPluginModal({ install, upload, onClose, onInstalled }: Props) {
  const [tab, setTab] = useState<Tab>('npm');
  const [spec, setSpec] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const canSubmit =
    !busy &&
    ((tab === 'npm' && spec.trim() !== '') ||
      (tab === 'git' && gitUrl.trim() !== '') ||
      (tab === 'upload' && file != null));

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      let result: PluginInstallResult;
      if (tab === 'npm') {
        result = await install({ source: 'npm', spec: spec.trim() });
      } else if (tab === 'git') {
        result = await install({
          source: 'git',
          url: gitUrl.trim(),
          ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
        });
      } else {
        if (!file) return;
        result = await upload(file);
      }
      onInstalled(result);
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
        aria-label="Install plugin"
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
        <h3 style={{ margin: '0 0 4px', color: 'var(--amber)' }}>INSTALL PLUGIN</h3>
        <div className="field-help" style={{ marginBottom: 16 }}>
          Install from a source. Enable + grant capabilities afterwards.
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          {(['npm', 'git', 'upload'] as Tab[]).map((t) => (
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
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        {tab === 'npm' && (
          <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            <label className="field-help">npm package spec (name, name@version, or a file: path)</label>
            <input
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder="my-plugin@1.2.3"
              disabled={busy}
              spellCheck={false}
              style={{ width: '100%' }}
            />
          </div>
        )}

        {tab === 'git' && (
          <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            <label className="field-help">git repository URL (compiled JS must be committed)</label>
            <input
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/acme/swarm-plugin.git"
              disabled={busy}
              spellCheck={false}
              style={{ width: '100%' }}
            />
            <label className="field-help">branch / tag (optional)</label>
            <input
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
              disabled={busy}
              spellCheck={false}
              style={{ width: '100%' }}
            />
          </div>
        )}

        {tab === 'upload' && (
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <label className="field-help">plugin tarball (.tgz, npm pack format — max 50 MB)</label>
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
            {busy ? 'INSTALLING…' : 'INSTALL'}
          </button>
        </div>
      </div>
    </div>
  );
}
