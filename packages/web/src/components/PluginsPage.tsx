import { useEffect, useMemo, useState } from 'react';
import { usePlugins } from '../hooks/usePlugins';
import { useShellMode } from '../hooks/useShellMode';
import { useSwarmController } from '../controller/SwarmController';
import { HttpError, type PluginView, type PluginStatus } from '../api/client';
import { PermissionsDialog } from './plugins/PermissionsDialog';
import { PluginConfigForm } from './plugins/PluginConfigForm';
import { InstallPluginModal } from './plugins/InstallPluginModal';

/**
 * Plugins management overlay — modeled on RolesPage. Lists installed plugins
 * (dropped under `/data/plugins`, discovered via SCAN), shows status/error/
 * quarantine badges, toggles enable/disable, edits granted capabilities, and
 * uninstalls. Reuses the `roles-*` overlay styling.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

const STATUS_COLOR: Record<PluginStatus, string> = {
  enabled: 'var(--ok)',
  disabled: 'var(--text-dim)',
  error: 'var(--bad)',
  crashed: 'var(--bad)',
  quarantined: 'var(--warn)',
};

function StatusBadge({ status }: { status: PluginStatus }) {
  return (
    <span
      className="tag-pill"
      style={{
        color: STATUS_COLOR[status],
        borderColor: STATUS_COLOR[status],
      }}
    >
      {status.toUpperCase()}
    </span>
  );
}

/** Extract a server-provided error message (422 activation, etc.). */
function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { last_error?: string; error?: string } | undefined;
    return body?.last_error || body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function PluginsPage({ open, onClose }: Props) {
  const c = useSwarmController();
  const {
    plugins,
    loading,
    error,
    scan,
    enable,
    disable,
    setPermissions,
    uninstall,
    install,
    upload,
    upgrade,
  } = usePlugins(c.pluginsRev);
  const { isMobile } = useShellMode();

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Permission dialog: 'enable' (first turn-on) or 'edit' (change grant).
  const [permMode, setPermMode] = useState<'enable' | 'edit' | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);

  useEffect(() => {
    if (open) setMobileView('list');
  }, [open]);

  useEffect(() => {
    if (selectedName == null && plugins.length > 0) {
      setSelectedName(plugins[0]?.name ?? null);
      return;
    }
    if (selectedName != null && !plugins.find((p) => p.name === selectedName)) {
      setSelectedName(plugins[0]?.name ?? null);
    }
  }, [plugins, selectedName]);

  const plugin = useMemo(
    () => plugins.find((p) => p.name === selectedName) ?? null,
    [plugins, selectedName],
  );

  function tryClose(): void {
    onClose();
  }

  function trySelect(name: string): void {
    setSelectedName(name);
    setOpError(null);
    if (isMobile) setMobileView('detail');
  }

  async function doScan(): Promise<void> {
    setOpError(null);
    setBusy(true);
    try {
      await scan();
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDisable(p: PluginView): Promise<void> {
    setOpError(null);
    setBusy(true);
    try {
      await disable(p.name);
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doUninstall(p: PluginView): Promise<void> {
    if (
      !confirm(
        `Uninstall "${p.name}"?\n\nRemoves the plugin folder and purges its stored data (kv + config). This cannot be undone.`,
      )
    ) {
      return;
    }
    setOpError(null);
    setBusy(true);
    try {
      await uninstall(p.name, true);
      setSelectedName(null);
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doUpgrade(p: PluginView): Promise<void> {
    setOpError(null);
    setBusy(true);
    try {
      const r = await upgrade(p.name);
      // An upgrade that requests NEW capabilities re-presents them for approval
      // rather than granting silently — open the edit-grant dialog.
      if (r.newCapabilities.length > 0) {
        setPermError(
          `New capabilities requested by v${r.plugin.version}: ${r.newCapabilities.join(', ')} — review the grant.`,
        );
        setPermMode('edit');
      }
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPermissions(selected: string[]): Promise<void> {
    if (!plugin) return;
    setPermError(null);
    setBusy(true);
    try {
      if (permMode === 'enable') await enable(plugin.name, selected);
      else await setPermissions(plugin.name, selected);
      setPermMode(null);
    } catch (e) {
      setPermError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className={`roles-overlay${isMobile ? ` m-roles m-roles-${mobileView}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <aside className="roles-side">
        <div className="roles-side-head">
          <button className="back" onClick={tryClose}>
            ← BACK TO MAP
          </button>
          <div className="title">PLUGINS</div>
          <div className="sub">installable extensions — drop in /data/plugins</div>
        </div>

        <div className="roles-list">
          {loading && plugins.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              loading…
            </div>
          )}
          {error && (
            <div className="field-warn" style={{ margin: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && plugins.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              No plugins yet — drop one in /data/plugins and click SCAN.
            </div>
          )}
          {plugins.map((p) => (
            <div
              key={p.name}
              className={`role-item ${selectedName === p.name ? 'active' : ''}`}
              onClick={() => trySelect(p.name)}
            >
              <div className="r-name">{(p.displayName ?? p.name).toUpperCase()}</div>
              <div className="r-id">
                {p.name} · v{p.version}
              </div>
              <div className="r-tags">
                <StatusBadge status={p.status} />
                {p.enabled && <span className="tag-pill">ON</span>}
                {p.failCount > 0 && (
                  <span className="tag-pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
                    {p.failCount} FAIL
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="roles-add" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            style={{ flex: 1, color: 'var(--amber)' }}
            onClick={() => setInstallOpen(true)}
            disabled={busy}
          >
            INSTALL
          </button>
          <button className="btn" style={{ flex: 1 }} onClick={() => void doScan()} disabled={busy}>
            {busy ? '…' : 'SCAN'}
          </button>
        </div>
      </aside>

      <main className="roles-main">
        {isMobile && (
          <button type="button" className="m-roles-back" onClick={() => setMobileView('list')}>
            ← PLUGINS
          </button>
        )}
        {plugin ? (
          <>
            <h2>{(plugin.displayName ?? plugin.name).toUpperCase()}</h2>
            <div className="role-id">
              {plugin.name} · v{plugin.version} · {plugin.sourceKind}
              {plugin.sourceCommit ? ` · ${plugin.sourceCommit.slice(0, 7)}` : ''}
            </div>

            {opError && (
              <div
                className="field-warn"
                role="alert"
                style={{
                  color: 'var(--bad)',
                  borderLeftColor: 'var(--bad)',
                  background: 'rgba(224, 101, 74, 0.06)',
                  marginBottom: 20,
                }}
              >
                {opError}
              </div>
            )}

            <div className="role-section">
              <h3>
                <span>STATUS</span>
              </h3>
              <div className="cfg-kv">
                <span className="k">state</span>
                <span className="v">
                  <StatusBadge status={plugin.status} /> {plugin.enabled ? '(enabled)' : '(disabled)'}
                </span>
                <span className="k">apiVersion</span>
                <span className="v">{plugin.apiVersion}</span>
                {plugin.failCount > 0 && (
                  <>
                    <span className="k">failCount</span>
                    <span className="v">{plugin.failCount}</span>
                  </>
                )}
                {plugin.quarantinedUntil && (
                  <>
                    <span className="k">quarantined until</span>
                    <span className="v">{plugin.quarantinedUntil}</span>
                  </>
                )}
                {plugin.lastError && (
                  <>
                    <span className="k">last error</span>
                    <span className="v" style={{ color: 'var(--bad)' }}>
                      {plugin.lastError}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="role-section">
              <h3>
                <span>CAPABILITIES</span>
                {plugin.enabled && (
                  <button className="h-edit" onClick={() => { setPermError(null); setPermMode('edit'); }}>
                    EDIT
                  </button>
                )}
              </h3>
              <div className="r-tags" style={{ marginBottom: 8 }}>
                {plugin.capabilities.length === 0 && (
                  <span className="field-help">no capabilities declared</span>
                )}
                {plugin.capabilities.map((cap) => {
                  const gr = plugin.grantedCapabilities;
                  const grantedCap = gr == null ? false : gr.includes(cap);
                  return (
                    <span
                      key={cap}
                      className="tag-pill"
                      style={grantedCap ? { color: 'var(--amber)', borderColor: 'var(--amber)' } : undefined}
                      title={grantedCap ? 'granted' : 'requested (not granted)'}
                    >
                      {cap}
                      {grantedCap ? ' ✓' : ''}
                    </span>
                  );
                })}
              </div>
              <div className="field-help">
                {plugin.grantedCapabilities == null
                  ? 'not yet granted — set on first enable'
                  : `${plugin.grantedCapabilities.length}/${plugin.capabilities.length} granted`}
              </div>
            </div>

            {/* Panels (feature B.3) — the server only populates `uiPanels` for
                an ENABLED plugin, so this section appears only when there is at
                least one live panel to open. */}
            {plugin.uiPanels.length > 0 && (
              <div className="role-section">
                <h3>
                  <span>PANELS</span>
                </h3>
                <div className="r-tags" style={{ marginBottom: 8, gap: 8 }}>
                  {plugin.uiPanels.map((panel) => (
                    <button
                      key={panel.id}
                      className="btn"
                      onClick={() => c.onOpenPanel(plugin.name, panel.id)}
                    >
                      {panel.title}
                    </button>
                  ))}
                </div>
                <div className="field-help">
                  Opens the plugin page in a sandboxed iframe (v1).
                </div>
              </div>
            )}

            {/* Config form (rendered only when the manifest declares a configSchema). */}
            <PluginConfigForm pluginName={plugin.name} rev={c.pluginsRev} />

            <div style={{ display: 'flex', gap: 10, marginTop: 30 }}>
              {plugin.enabled ? (
                <button className="btn" onClick={() => void doDisable(plugin)} disabled={busy}>
                  DISABLE
                </button>
              ) : (
                <button
                  className="btn"
                  style={{ color: 'var(--amber)' }}
                  onClick={() => { setPermError(null); setPermMode('enable'); }}
                  disabled={busy}
                >
                  ENABLE
                </button>
              )}
              {/* Upgrade re-fetches the recorded source; upload plugins need a
                  fresh upload (server returns 409), so it is disabled for them. */}
              <button
                className="btn"
                onClick={() => void doUpgrade(plugin)}
                disabled={busy || plugin.sourceKind === 'upload'}
                title={
                  plugin.sourceKind === 'upload'
                    ? 'Upload-source plugins require a new upload (use INSTALL)'
                    : `Re-fetch from ${plugin.sourceKind} source`
                }
              >
                UPGRADE
              </button>
              {/* Update indicator — next to the button that acts on it, not a
                  second list. Only `available` lights up: `unknown` means "not
                  checked", and claiming freshness we have not verified is how
                  an operator stops trusting the badge. */}
              {plugin.updateStatus === 'available' && (
                <span
                  className="field-help"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  title={
                    plugin.latestVersion
                      ? `v${plugin.latestVersion} is available at the ${plugin.sourceKind} source`
                      : `a newer commit is available at the ${plugin.sourceKind} source`
                  }
                >
                  <span className="dot warn" />
                  {plugin.latestVersion ? `v${plugin.latestVersion} available` : 'update available'}
                </span>
              )}
              <button className="btn danger" onClick={() => void doUninstall(plugin)} disabled={busy}>
                UNINSTALL
              </button>
            </div>
          </>
        ) : (
          <div className="field-help">No plugin selected.</div>
        )}
      </main>

      {installOpen && (
        <InstallPluginModal
          install={install}
          upload={upload}
          onClose={() => setInstallOpen(false)}
          onInstalled={(r) => {
            setInstallOpen(false);
            setSelectedName(r.plugin.name);
            if (isMobile) setMobileView('detail');
          }}
        />
      )}

      {permMode && plugin && (
        <PermissionsDialog
          pluginName={plugin.name}
          title={permMode === 'enable' ? 'Grant capabilities' : 'Edit capabilities'}
          confirmLabel={permMode === 'enable' ? 'ENABLE' : 'SAVE'}
          capabilities={plugin.capabilities}
          granted={permMode === 'enable' ? plugin.grantedCapabilities : plugin.grantedCapabilities ?? []}
          busy={busy}
          error={permError}
          onConfirm={(sel) => void confirmPermissions(sel)}
          onCancel={() => setPermMode(null)}
        />
      )}
    </div>
  );
}
