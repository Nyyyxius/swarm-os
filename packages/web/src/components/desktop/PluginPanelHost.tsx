// packages/web/src/components/desktop/PluginPanelHost.tsx
import { useEffect, useMemo, useState } from 'react';
import { api, HttpError, syncPanelCookie, type UiPanel } from '../../api/client';
import { ICON } from './icons';

/**
 * Feature B.3 — full-panel host for a plugin UI panel (uiPanels v1).
 *
 * Fullscreen overlay (same family as IdeOverlay / RolesPage) that renders a
 * plugin-declared panel inside an iframe. The panel is served by the plugin
 * under its AUTHENTICATED zone `/plugin-api/<name>/<path>` on the SAME origin as
 * the app, so we build a same-origin URL and let the browser send the
 * `swarm_os_token` cookie (primed from localStorage via `syncPanelCookie`) —
 * the iframe cannot send the `X-Auth-Token` header the REST client uses.
 *
 * Sandbox: `allow-scripts allow-same-origin allow-forms`. `allow-same-origin`
 * is required for the panel's own `/plugin-api` fetches to carry the cookie;
 * combined with `allow-scripts` it means the panel runs with same-origin
 * privileges — acceptable because plugins are already fully-trusted in-process
 * code (see docs/plugins.md). No `allow-popups` / `allow-top-navigation`.
 */
interface Props {
  pluginName: string;
  panelId: string;
  onClose: () => void;
}

export default function PluginPanelHost({ pluginName, panelId, onClose }: Props) {
  const [panel, setPanel] = useState<UiPanel | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Escape-to-close — mirrors IdeOverlay / ConsoleOverlay convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setPanel(null);
    setError(null);
    api
      .getPlugin(pluginName)
      .then(({ plugin }) => {
        if (cancelled) return;
        // Panels are surfaced ONLY for an enabled plugin (server-side); a
        // disabled/unknown plugin therefore has none matching the id.
        const found = plugin.uiPanels.find((p) => p.id === panelId) ?? null;
        if (!found) {
          setError(
            plugin.enabled
              ? `panel "${panelId}" is not declared by ${pluginName}`
              : `plugin "${pluginName}" is disabled — its panels are unavailable`,
          );
          return;
        }
        // Prime the cookie the gate accepts for the iframe (Path=/plugin-api/)
        // BEFORE the iframe is rendered with its src, so its first request is
        // authenticated.
        syncPanelCookie();
        setPanel(found);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && err.status === 404) {
          setError(`plugin "${pluginName}" not found`);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pluginName, panelId]);

  const src = useMemo(() => {
    if (!panel) return null;
    // Same-origin: resolve the plugin-relative `path` under the plugin's
    // authenticated zone. `panel.path` is server-validated (no absolute, no
    // `..`), so it can never escape the zone.
    const base = `${window.location.origin}/plugin-api/${pluginName}/`;
    return new URL(panel.path, base).toString();
  }, [panel, pluginName]);

  return (
    <div className="ide-overlay" role="dialog" aria-modal="true">
      <div className="ide-head">
        <div className="ide-title">
          {ICON.link}
          <span>{(panel?.title ?? pluginName).toUpperCase()}</span>
        </div>
        <button className="ide-close" onClick={onClose} title="close (Esc)">
          {ICON.collapse}
          <span>CLOSE</span>
        </button>
      </div>
      <div className="ide-body">
        {error ? (
          <div className="ide-msg">Panel unavailable — {error}</div>
        ) : src ? (
          <iframe
            className="ide-frame"
            src={src}
            title={panel?.title ?? pluginName}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="ide-msg">Loading panel…</div>
        )}
      </div>
    </div>
  );
}
