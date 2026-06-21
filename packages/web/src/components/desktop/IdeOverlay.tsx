// packages/web/src/components/desktop/IdeOverlay.tsx
import { useEffect, useState } from 'react';
import { api, HttpError } from '../../api/client';
import { ICON } from './icons';

/**
 * Fullscreen overlay (below the 56px top bar, same family as RolesPage /
 * ConsoleOverlay) hosting the official Microsoft VS Code web (`code serve-web`)
 * in an iframe, opened on the deployment's `/workspace`.
 *
 * The editor is reverse-proxied under `basePath` (e.g. `/ide`) on the SAME
 * origin as the app, so we build a same-origin iframe URL:
 *   `${basePath}/?folder=${folder}&tkn=${token}`
 * This inherits the app's existing TLS / ingress (no second port, works over
 * Tailscale automatically). The `tkn` query primes serve-web's connection-token
 * cookie; subsequent asset + WebSocket requests carry it.
 */
interface Props {
  onClose: () => void;
}

export default function IdeOverlay({ onClose }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Escape-to-close — mirrors ConsoleOverlay / SettingsDrawer convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .getIdeInfo()
      .then((info) => {
        if (cancelled) return;
        // Same-origin: resolve `${basePath}/` against the current origin so the
        // editor rides on the app's existing host/port/TLS.
        const u = new URL(`${info.basePath}/`, window.location.origin);
        u.searchParams.set('folder', info.folder);
        u.searchParams.set('tkn', info.token);
        setSrc(u.toString());
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && err.status === 404) {
          setError("L'IDE est désactivé sur cette instance (SWARM_OS_IDE_ENABLED=false).");
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="ide-overlay" role="dialog" aria-modal="true">
      <div className="ide-head">
        <div className="ide-title">
          {ICON.code}
          <span>WORKSPACE · VS&nbsp;CODE</span>
        </div>
        <button className="ide-close" onClick={onClose} title="collapse (Esc)">
          {ICON.collapse}
          <span>COLLAPSE</span>
        </button>
      </div>
      <div className="ide-body">
        {error ? (
          <div className="ide-msg">IDE indisponible — {error}</div>
        ) : src ? (
          <iframe
            className="ide-frame"
            src={src}
            title="VS Code"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="ide-msg">{"Chargement de l'éditeur…"}</div>
        )}
      </div>
    </div>
  );
}
