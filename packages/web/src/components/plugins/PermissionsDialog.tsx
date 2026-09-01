import { useEffect, useState } from 'react';

/**
 * Capability-grant dialog. Shown at the first enable of a plugin (all
 * declared capabilities checked by default) and reused to edit the grant from
 * a plugin's detail card. The operator decides which of the manifest's
 * requested capabilities the plugin actually gets — `buildPluginApi` only
 * materialises `manifest ∩ granted`.
 */

interface Props {
  pluginName: string;
  title: string;
  confirmLabel: string;
  /** Every capability the manifest declares. */
  capabilities: string[];
  /** Currently granted (null = first enable → default everything checked). */
  granted: string[] | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}

/** One-line explanation per capability shown next to each checkbox. */
const CAP_HELP: Record<string, string> = {
  events: 'observe the swarm event bus',
  'events-emit': 'emit plugin.<name>.* events',
  messaging: 'send messages to teams / leads',
  teams: 'create / destroy teams and workers',
  roles: 'read and mutate roles',
  'mcp-tools': 'expose MCP tools to agents',
  'http-routes': 'register authenticated HTTP routes',
  'http-public': 'register public (webhook) HTTP routes',
  'agent-assets': 'ship scripts to agents',
  'db-kv': 'private key/value storage',
  'db-tables': 'private SQL tables',
  notify: 'send operator notifications',
  schedule: 'run intervals / cron jobs',
  connectors: 'register channel connectors',
  'settings-read': 'read instance settings',
  'host-exec': 'run commands on the host (ssh) — full trust',
  crons: 'read and mutate agent crons',
};

export function PermissionsDialog({
  pluginName,
  title,
  confirmLabel,
  capabilities,
  granted,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    // First enable (granted === null) → default everything ON; otherwise seed
    // from the current grant.
    const seed = granted == null ? capabilities : capabilities.filter((c) => granted.includes(c));
    setSelected(new Set(seed));
  }, [pluginName, granted, capabilities]);

  function toggle(cap: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  }

  return (
    <div
      className="plugin-perm-backdrop"
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
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        style={{
          background: 'var(--panel-solid, var(--panel))',
          border: '1px solid var(--border-strong, var(--border))',
          borderRadius: 8,
          padding: 22,
          width: 'min(480px, 92vw)',
          maxHeight: '86vh',
          overflowY: 'auto',
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ margin: '0 0 4px', color: 'var(--amber)' }}>{title}</h3>
        <div className="field-help" style={{ marginBottom: 16 }}>
          {pluginName} — check the capabilities to grant.
        </div>

        {capabilities.length === 0 && (
          <div className="field-help" style={{ marginBottom: 16 }}>
            This plugin declares no capabilities.
          </div>
        )}

        <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
          {capabilities.map((cap) => (
            <label
              key={cap}
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={selected.has(cap)}
                onChange={() => toggle(cap)}
                disabled={busy}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{cap}</span>
                <span className="field-help" style={{ display: 'block' }}>
                  {CAP_HELP[cap] ?? '—'}
                </span>
              </span>
            </label>
          ))}
        </div>

        {error && (
          <div
            className="field-warn"
            role="alert"
            style={{
              color: 'var(--bad)',
              borderLeftColor: 'var(--bad)',
              background: 'rgba(224, 101, 74, 0.06)',
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel} disabled={busy}>
            CANCEL
          </button>
          <button
            className="btn"
            style={{ color: 'var(--amber)' }}
            onClick={() => onConfirm([...selected])}
            disabled={busy}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
