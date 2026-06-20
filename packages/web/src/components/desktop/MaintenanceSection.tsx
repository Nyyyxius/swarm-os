/**
 * MAINTENANCE — operator backup controls.
 *
 * Mounted in `SettingsDrawer` after ABOUT. "BACKUP NOW" forces an online
 * SQLite snapshot via `POST /backup` (the same mechanics + retention as the
 * 6-hourly scheduler), then refreshes the snapshot list (`GET /backups`).
 *
 * State/feedback pattern mirrors `AppearanceSection`: a `busy` button label
 * and an inline `field-warn` on error. The list is fetched on mount and after
 * each manual backup.
 */
import { useEffect, useState } from 'react';
import { api, HttpError } from '../../api/client';

interface BackupEntry {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function MaintenanceSection() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const { backups: list } = await api.listBackups();
      setBackups(list);
    } catch (err) {
      // Non-fatal: leave the list as-is, surface nothing (the button still works).
      console.error('listBackups failed:', err);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleBackup(): Promise<void> {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const r = await api.triggerBackup();
      if (r.ok) {
        setLastResult(
          `✓ ${r.file}${r.pruned > 0 ? ` · ${r.pruned} pruned` : ''}`,
        );
      } else {
        setError('backup failed — check server logs');
      }
      await refresh();
    } catch (err) {
      const msg =
        err instanceof HttpError
          ? `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-section">
      <div className="h">MAINTENANCE</div>

      <div className="field">
        <button
          type="button"
          className="btn ghost"
          onClick={() => void handleBackup()}
          disabled={busy}
        >
          {busy ? 'BACKING UP…' : 'BACKUP NOW'}
        </button>
        <div className="field-help">
          forces an online SQLite snapshot into <code>/data/backups</code> ·
          retained alongside the 6-hourly automatic ones
        </div>
      </div>

      {lastResult && (
        <div className="field-help" style={{ color: 'var(--ok)' }}>
          {lastResult}
        </div>
      )}
      {error && <div className="field-warn">⚠ {error}</div>}

      <div className="field">
        <label>SNAPSHOTS ({backups.length})</label>
        {backups.length === 0 ? (
          <div className="field-help">no snapshots yet</div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {backups.map((b) => (
              <div
                key={b.name}
                className="field-help"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--text-dim)',
                  }}
                  title={`${b.name} · ${new Date(b.mtimeMs).toLocaleString()}`}
                >
                  {b.name}
                </span>
                <span style={{ flexShrink: 0 }}>{formatBytes(b.sizeBytes)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
