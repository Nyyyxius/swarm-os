// packages/web/src/components/desktop/SettingsDrawer.tsx
//
// Phase C — Step 11 : side-drawer SETTINGS porté depuis prototypes/v2.
// Trois sections : AUTHENTICATION (X-Auth-Token + SHOW/HIDE + SAVE/CLEAR),
// ABOUT (project_name, version, uptime live, started_at, sessions_active),
// EVENTS (pip WS state).
//
// Notes d'implémentation (cf. docs/redesign-desktop/11_settings-drawer.md) :
//  - On utilise `setToken` / `getToken` de `api/client.ts` (clé
//    `'swarm-os.token'`) — **pas** de manipulation directe de
//    `localStorage`. Toute évolution future de la clé reste centralisée.
//  - On NE CONSOMME PAS `useEvents()` ici : le shell le fait une seule fois
//    et propage `wsConnected` en prop (régression-guard du fix 584d9ec
//    « events WS loop spawning duplicate connections »).
//  - Escape ferme le drawer ; le clic dans le backdrop ferme aussi (l'aside
//    fait `stopPropagation` pour ne pas capturer ses propres clics).
//  - Auto-focus sur l'input token au mount (accessibilité minimale, pas de
//    focus-trap strict — follow-up si besoin).
//  - `useNow(1000)` (tick 1 s) pour le compteur UPTIME live. Coût : 1
//    re-render/s **uniquement quand le drawer est ouvert** (composant
//    unmount sinon).

import { useEffect, useRef, useState } from 'react';
import {
  getToken,
  setToken,
  type HealthView,
  type InfoView,
} from '../../api/client';
import { useNow } from '../../lib/useNow';
import { formatUptime, formatClockShort } from '../../lib/format';
import { AppearanceSection } from './AppearanceSection';
import { MaintenanceSection } from './MaintenanceSection';
import { type ShellMode } from '../../hooks/useShellMode';

export type AuthState = 'unknown' | 'ok' | 'missing' | 'invalid';

export interface SettingsDrawerProps {
  /** `/info` snapshot (project_name, version, started_at). Null pendant le 1er fetch. */
  info: InfoView | null;
  /** `/health` snapshot — on n'utilise que `sessions_active`. Null pendant le 1er fetch. */
  health: HealthView | null;
  /** Verdict de la dernière `probeAuth` (App-level). Drive les banners warn. */
  authState: AuthState;
  /** Statut WS `/ws/events` (propagé depuis le `useEvents()` unique du shell). */
  wsConnected: boolean;
  /** Ferme le drawer (unmount immédiat, pas d'animation de sortie v1). */
  onClose: () => void;
  /** Appelé après un SAVE réussi → le shell re-probe pour passer authState à 'ok'. */
  onTokenSaved?: () => void;
  /** Appelé après un CLEAR → le shell repasse à `authState='missing'`. */
  onTokenCleared?: () => void;
  /** Shell-mode override (auto|desktop|mobile). When provided, a SHELL
   *  section is rendered with an Auto/Desktop/Mobile toggle — the escape
   *  hatch from the responsive aiguillage. */
  shellMode?: ShellMode;
  setShellMode?: (m: ShellMode) => void;
}

export default function SettingsDrawer({
  info,
  health,
  authState,
  wsConnected,
  onClose,
  onTokenSaved,
  onTokenCleared,
  shellMode,
  setShellMode,
}: SettingsDrawerProps) {
  const [token, setTokenLocal] = useState<string>(() => getToken());
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const firstFocusableRef = useRef<HTMLInputElement>(null);
  const now = useNow(1_000);

  // Escape → close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-focus token input at mount.
  useEffect(() => {
    firstFocusableRef.current?.focus();
  }, []);

  function handleSave() {
    const trimmed = token.trim();
    setToken(trimmed);
    setTokenLocal(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 1_500);
    onTokenSaved?.();
  }

  function handleClear() {
    setToken('');
    setTokenLocal('');
    onTokenCleared?.();
  }

  const uptime = info ? formatUptime(info.started_at, now) : '—';
  const started = info ? formatClockShort(info.started_at) : '—';
  const sessionsActive = health?.sessions_active ?? 0;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div className="modal-title" id="settings-drawer-title">SETTINGS</div>
          <button
            type="button"
            className="pr-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div className="drawer-body">
          {/* ── AUTHENTICATION ─────────────────────────── */}
          <div className="drawer-section">
            <div className="h">AUTHENTICATION</div>
            <div className="field">
              <label htmlFor="x-auth-token-input">X-AUTH-TOKEN</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                <input
                  id="x-auth-token-input"
                  ref={firstFocusableRef}
                  type={show ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setTokenLocal(e.target.value)}
                  placeholder="paste server token…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShow((s) => !s)}
                  style={{ padding: '6px 10px' }}
                  aria-label={show ? 'Hide token' : 'Show token'}
                >
                  {show ? 'HIDE' : 'SHOW'}
                </button>
              </div>
              <div className="field-help">
                stored locally only · sent as <code>X-Auth-Token</code> header on all
                REST + WS handshakes
              </div>
            </div>

            {(authState === 'missing' || !token) && (
              <div className="field-warn">
                ⚠ No token set. Most endpoints will reject. Retrieve via<br />
                <span className="mono" style={{ color: 'var(--text-dim)' }}>
                  docker exec &lt;container&gt; cat /data/token
                </span>
              </div>
            )}
            {authState === 'invalid' && !!token && (
              <div className="field-warn">
                ⚠ Token rejected (HTTP 401). Verify it matches the server's
                <code> SWARM_OS_TOKEN</code> (or <code>/data/token</code> at first boot).
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn primary" onClick={handleSave}>
                {saved ? '✓ SAVED' : 'SAVE'}
              </button>
              <button type="button" className="btn ghost" onClick={handleClear}>
                CLEAR
              </button>
            </div>
          </div>

          {/* ── ABOUT ───────────────────────────────────── */}
          <div className="drawer-section">
            <div className="h">ABOUT</div>
            <div
              className="pr-stats"
              style={{ gridTemplateColumns: '1fr 1fr', borderColor: 'var(--border)' }}
            >
              <div className="pr-stat">
                <div className="v" style={{ fontSize: 13 }}>{info?.project_name ?? '—'}</div>
                <div className="k">PROJECT</div>
              </div>
              <div className="pr-stat">
                <div className="v" style={{ fontSize: 13 }}>{info?.version ?? '—'}</div>
                <div className="k">VERSION</div>
              </div>
              <div className="pr-stat">
                <div
                  className="v"
                  style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
                >
                  {uptime}
                </div>
                <div className="k">UPTIME</div>
              </div>
              <div className="pr-stat">
                <div className="v" style={{ fontSize: 13 }}>{started}</div>
                <div className="k">STARTED</div>
              </div>
              <div className="pr-stat" style={{ gridColumn: '1 / -1' }}>
                <div className="v" style={{ fontSize: 13 }}>
                  {sessionsActive}{' '}
                  <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>active</span>
                </div>
                <div className="k">SESSIONS</div>
              </div>
            </div>
          </div>

          {/* ── MAINTENANCE ─────────────────────────────── */}
          <MaintenanceSection />

          {/* ── EVENTS ──────────────────────────────────── */}
          <div className="drawer-section">
            <div className="h">EVENTS</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div
                className="field-help"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span className={`dot ${wsConnected ? 'ok' : 'warn'}`} />
                WS connection ::
                <span style={{ color: 'var(--text-dim)' }}>
                  {wsConnected ? 'LIVE' : 'RECONNECTING…'}
                </span>
              </div>
              <div className="field-help" style={{ textAlign: 'right' }}>/ws/events</div>
            </div>
            <div className="field-help">
              Server-pushed events: orchestrator lifecycle, mailbox traffic,
              waiting signals.
            </div>
          </div>

          {/* ── SHELL (responsive override) ─────────────── */}
          {shellMode && setShellMode && (
            <div className="drawer-section">
              <div className="h">SHELL</div>
              <div className="seg" role="group" aria-label="shell mode">
                {(['auto', 'desktop', 'mobile'] as const).map((m) => (
                  <button
                    key={m}
                    className={shellMode === m ? 'on' : ''}
                    onClick={() => setShellMode(m)}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="field-help">
                AUTO follows the device (touch + ≤820px → mobile). A manual
                override persists locally and survives reloads.
              </div>
            </div>
          )}

          {/* ── APPEARANCE ──────────────────────────────── */}
          <AppearanceSection />
        </div>
      </aside>
    </>
  );
}
