# Étape 11 (Phase C.11) — Port de `SettingsDrawer` v2

> **Périmètre exact** : remplacer la zone de réglages inline du header
> `App.tsx` (lignes 135-181) par un side-drawer dédié, ouvrable depuis le
> bouton cog de la nouvelle `TopBar` (Étape 3). Trois sections : (1)
> **X-Auth-Token** (input password + SHOW/HIDE + SAVE/CLEAR, persistance
> `localStorage 'swarm-os.token'`), (2) **About** (project_name, version,
> uptime live, started_at via `GET /info` + sessions_active via `GET
> /health`), (3) **Events** (pip WS state dérivé de `useEvents.connected`).
> Source de vérité visuelle : `prototypes/v2/modals.jsx:221-310` + CSS
> `Swarm OS v2.html:919-950`.
> Backend : aucun changement — `api.info()` / `api.health()` déjà câblés ;
> `getToken/setToken` déjà exposés par `api/client.ts`.

---

## 1. Objectif

Extraire l'UI de configuration disséminée dans `App.tsx` (banner amber
"Token required", input password, boutons Save/Clear) vers un composant
dédié `SettingsDrawer` à thème warm-black, ouvrable via overlay
slide-from-right depuis la TopBar. Conserver à 100 % la logique métier
existante (validation du token via `probeAuth`, états
`missing|invalid|ok|unknown`, auto-ouverture si missing/invalid) tout en
adoptant la charte v2 (`drawer-backdrop`, `drawer`, `drawer-section`,
typography Geist Mono). Ajouter en bonus l'**uptime live** (tick 1 s
client-side via `useNow(1000)`) et le **statut WS** branché sur
`useEvents().connected`, deux affordances absentes de l'inline actuel.

---

## 2. Existant à extraire de `App.tsx` (repérage ligne par ligne)

| Lignes | Bloc | Devenir |
|---|---|---|
| `App.tsx:9` | import `getToken, setToken, type HealthView, type InfoView` | identique (réimport depuis `SettingsDrawer.tsx`) |
| `App.tsx:11` | import `HttpError` | conservé dans `App.tsx` pour `probeAuth` (auth state remonte) |
| `App.tsx:45` | `const [token, setTokenState] = useState<string>(getToken());` | déplacé dans `SettingsDrawer` (state local au drawer) |
| `App.tsx:46` | `const [showSettings, setShowSettings] = useState(false);` | déplacé / renommé `const [settingsOpen, setSettingsOpen]` dans `DesktopShell` (puisque le bouton cog est dans `TopBar`, lift de l'état au shell) |
| `App.tsx:47-48` | `health, info` state | reste sur le shell (consommé aussi par TopBar) ; passé en prop `info` + `health` au drawer |
| `App.tsx:54` | `authState` state + `probeAuth` | **reste sur le shell** — c'est une préoccupation d'app, pas de drawer. Passé en prop au drawer (badge "token rejected") + callback `onTokenSaved` qui re-probe |
| `App.tsx:56-68` | `probeAuth` callback | reste sur shell, exposé via prop `onTokenSaved: () => void` |
| `App.tsx:70-74` | `useEffect` boot (info/health/probe) | reste sur shell |
| `App.tsx:76-78` | `useEffect` re-sync `token` quand `showSettings` change | **supprimé** — le drawer gère son state local, init à `getToken()` au mount |
| `App.tsx:80-83` | `useEffect` auto-open settings si missing/invalid | reste sur shell, manipule `settingsOpen` au lieu de `showSettings` |
| `App.tsx:113-132` | bouton "Settings" du header | remplacé par bouton cog dans `TopBar.tsx` (Étape 3) |
| `App.tsx:135-181` | bloc `{showSettings && <div…>}` complet | **supprimé**, ré-implémenté dans `SettingsDrawer.tsx` |
| `App.tsx:137-149` | banner "Token required / rejected" | porté dans `SettingsDrawer` section AUTH sous forme `field-warn` v2 (encadré ambré, même message + `docker exec swarm cat /data/token`) |
| `App.tsx:150-157` | label + input password X-Auth-Token | porté `<label>X-AUTH-TOKEN</label> <input type={show?'text':'password'}>` |
| `App.tsx:158-179` | boutons Save / Clear | portés (`btn primary` + `btn ghost`), Save ajoute le toggle `✓ SAVED` pendant 1.5 s du prototype |

**À noter** : le `localStorage` key utilisée par `api/client.ts:4` est
`'swarm-os.token'`. Le prototype `modals.jsx:223,229,233` utilise
`'swarm.token'` (différent). On garde **`'swarm-os.token'`** (clé du
système, déjà persistée chez les opérateurs) — c'est pour ça qu'on ne
manipule pas `localStorage` en direct mais qu'on passe par `setToken()`
/ `getToken()` de `api/client.ts`. Cette indirection est **importante** :
toute évolution future de la clé reste centralisée.

---

## 3. Drawer mechanics

### 3.1 Markup overall

```tsx
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
      <button className="pr-close" onClick={onClose} aria-label="Close settings">×</button>
    </div>
    <div className="drawer-body">
      {/* sections */}
    </div>
  </aside>
</>
```

### 3.2 CSS (déjà importé via `desktop-theme.css`, Étape 1)

Extraites de `prototypes/v2/Swarm OS v2.html:919-950` :

```css
.drawer-backdrop {
  position: fixed; inset: 56px 0 0 0;   /* commence sous TopBar 56px */
  background: rgba(8, 6, 4, 0.45);
  z-index: 70;
  animation: backdrop-in 160ms ease-out;
}
.drawer {
  position: fixed; top: 56px; bottom: 0; right: 0;
  width: 420px; max-width: calc(100vw - 40px);
  background: var(--panel-solid);  /* #14100c */
  border-left: 1px solid var(--border-strong);
  z-index: 71;
  display: flex; flex-direction: column;
  animation: drawer-in 220ms cubic-bezier(.2,.7,.2,1);
}
@keyframes drawer-in {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
@keyframes backdrop-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.drawer-head {
  padding: 18px 22px; border-bottom: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: center;
}
.drawer-body { padding: 18px 22px; overflow: auto; display: grid; gap: 20px; }
.drawer-section { display: grid; gap: 8px; }
.drawer-section .h {
  font-family: "Geist Mono", monospace; font-size: 10px;
  letter-spacing: 0.18em; color: var(--text-mute);
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px; margin-bottom: 4px;
}
```

### 3.3 Animation slide-in

Le keyframe `drawer-in` translate de `100%` à `0` sur l'axe X, courbe
cubic-bezier(.2,.7,.2,1) (out-expo style). 220 ms — assez rapide pour ne
pas freiner l'usage répété, assez ample pour signaler clairement
l'apparition. Le backdrop fade en parallèle sur 160 ms (`backdrop-in`).
**Pas d'animation de sortie** dans le prototype : on retire le composant
du DOM (unmount), ce qui suffit visuellement. Si on veut une sortie en
slide, ce sera un follow-up (state `closing` + `setTimeout(unmount,
220ms)`).

### 3.4 Backdrop click → close

`drawer-backdrop` capture `onClick={onClose}`. L'`<aside class="drawer">`
appelle `e.stopPropagation()` sur son `onClick` pour éviter qu'un clic à
l'intérieur du drawer ne le ferme. Identique au pattern v2.

### 3.5 Focus trap + Escape

Le prototype n'implémente **ni** trap **ni** Escape. On rajoute ces deux
améliorations standards car le drawer est modal :

```tsx
const drawerRef = useRef<HTMLElement>(null);
const firstFocusableRef = useRef<HTMLInputElement>(null);

// Escape pour fermer
useEffect(() => {
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [onClose]);

// Auto-focus input token au mount
useEffect(() => {
  firstFocusableRef.current?.focus();
}, []);
```

**Focus trap minimaliste** : on s'appuie sur `aria-modal="true"` + le
backdrop qui bloque l'accès aux éléments derrière (cliquage). Pour un
trap clavier complet (Tab cycle), on s'appuiera sur l'ordre naturel du
DOM (input → SHOW → SAVE → CLEAR → close) qui est borné — implémenter un
vrai trap (`focus-trap-react` ou maison) est un follow-up si besoin
d'accessibilité stricte. **Décision v1** : Escape + auto-focus = OK.

---

## 4. Section X-Auth-Token

### 4.1 État local

```tsx
const [token, setTokenLocal] = useState<string>(() => getToken());
const [show, setShow] = useState(false);
const [saved, setSaved] = useState(false);
```

`token` est le state contrôlé de l'input. On lit la valeur réelle via
`getToken()` au mount (et au remount du drawer). `show` toggle le
`type="password"` / `type="text"`. `saved` est le flag transitoire
"✓ SAVED" 1.5 s post-save.

### 4.2 Input + bouton SHOW/HIDE

```tsx
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
```

### 4.3 Warning "no token" / "rejected"

```tsx
{(authState === 'missing' || !token) && (
  <div className="field-warn">
    ⚠ No token set. Most endpoints will reject. Retrieve via<br />
    <span className="mono" style={{ color: 'var(--text-dim)' }}>
      docker exec &lt;container&gt; cat /data/token
    </span>
  </div>
)}
{authState === 'invalid' && token && (
  <div className="field-warn">
    ⚠ Token rejected (HTTP 401). Verify the value matches the server's
    <code> SWARM_OS_TOKEN</code> (or <code>/data/token</code> at first boot).
  </div>
)}
```

### 4.4 Boutons SAVE / CLEAR

```tsx
function handleSave() {
  setToken(token.trim());          // api/client.ts persists to localStorage 'swarm-os.token'
  setSaved(true);
  setTimeout(() => setSaved(false), 1500);
  onTokenSaved?.();                // triggers App-level probeAuth re-check
}

function handleClear() {
  setToken('');                    // removes 'swarm-os.token' from localStorage
  setTokenLocal('');
  onTokenCleared?.();              // triggers App-level setAuthState('missing')
}

<div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
  <button className="btn primary" onClick={handleSave}>
    {saved ? '✓ SAVED' : 'SAVE'}
  </button>
  <button className="btn ghost" onClick={handleClear}>CLEAR</button>
</div>
```

**Important** : on appelle `setToken()` du module `api/client.ts` —
**jamais** `localStorage.setItem` direct. Ça garantit (a) la clé reste
centralisée (`TOKEN_KEY = 'swarm-os.token'`), (b) si demain on ajoute un
hook `onTokenChange` (par ex. pour invalider les WS ouverts), il
suffira de l'ajouter dans `setToken`.

**Side-effect critique** : changer le token **n'invalide pas
automatiquement** les WS déjà ouverts (event WS + session WS). Pour la
v1 acceptable : la prochaine reconnexion (auto-reconnect 1-30 s
backoff dans `useEvents`) refera `getEventsTicket` avec le nouveau
token. Si l'opérateur veut un reset immédiat, il refresh la page. À
documenter dans la `field-help`.

---

## 5. Section About

### 5.1 Données sources

| Champ | Source | Type | Format |
|---|---|---|---|
| PROJECT | `info.project_name` | string | tel quel (`'swarm-os'`) |
| VERSION | `info.version` | string | tel quel (`'0.1.0'`) |
| UPTIME | dérivé de `info.started_at` + `useNow(1000)` | string | `HH:MM:SS` via `formatUptime` |
| STARTED | `info.started_at` | ISO string | `formatClockShort` (`HH:MM`) ou full ISO |
| SESSIONS | `health.sessions_active` | number | `N` |

### 5.2 `formatUptime` (live tick 1 s)

Porter le helper de `prototypes/v2/data.jsx:459-466` dans
`src/lib/format.ts` (créer le fichier, étape 1 de la phase A le prévoit
déjà). Signature TypeScript :

```ts
// src/lib/format.ts
export function formatUptime(startedAt: string | number | null | undefined, now: number = Date.now()): string {
  if (!startedAt) return '—';
  const startMs = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  if (!Number.isFinite(startMs)) return '—';
  const secs = Math.max(0, Math.floor((now - startMs) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
function pad2(n: number): string { return n.toString().padStart(2, '0'); }

export function formatClockShort(ts: string | number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
```

Le tick 1 s : on appelle `useNow(1000)` dans `SettingsDrawer` (la cadence
par défaut de 5 s n'est pas assez fine pour un compteur HH:MM:SS visible).
Coût : 1 re-render/s **uniquement quand le drawer est ouvert** (le
composant est unmount sinon). Acceptable.

### 5.3 Markup About

Réutilise la grille `.pr-stats` (déjà définie pour le RightPanel,
`Swarm OS v2.html:456-469`) avec override `gridTemplateColumns: '1fr
1fr'` pour passer de 3 cols à 2×2 (4 cellules) :

```tsx
const now = useNow(1000);
const uptime = info ? formatUptime(info.started_at, now) : '—';
const started = info ? formatClockShort(info.started_at) : '—';
const sessionsActive = health?.sessions_active ?? 0;

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
      <div className="v" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
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
        {sessionsActive} <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>active</span>
      </div>
      <div className="k">SESSIONS</div>
    </div>
  </div>
</div>
```

**Note design** : `fontVariantNumeric: 'tabular-nums'` sur la cellule
UPTIME pour éviter le « jitter » des chiffres qui changent chaque
seconde (les chiffres prennent la même largeur en tabular).

**Note refresh** : `info` est figé (project + version + started_at ne
bougent pas en runtime). On le fetch **une seule fois** au boot du
shell. `health.sessions_active`, en revanche, bouge. On laisse le
parent (shell) le rafraîchir (par ex. via le même poll 3 s que
`useOrchestrators`) et le passer en prop.

---

## 6. Section Events

### 6.1 Pip vert / jaune

`useEvents.connected: boolean` (déjà exposé,
`packages/web/src/hooks/useEvents.ts:91-101`). Quand `true` → pip vert
"LIVE". Quand `false` → pip jaune "RECONNECTING…".

```tsx
const { connected } = useEvents();

<div className="drawer-section">
  <div className="h">EVENTS</div>
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
    <div className="field-help" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className={`dot ${connected ? 'ok' : 'warn'}`} />
      WS connection ::
      <span style={{ color: 'var(--text-dim)' }}>
        {connected ? 'LIVE' : 'RECONNECTING…'}
      </span>
    </div>
    <div className="field-help" style={{ textAlign: 'right' }}>/ws/events</div>
  </div>
  <div className="field-help">
    Server-pushed events: orchestrator lifecycle, mailbox traffic,
    waiting signals.
  </div>
</div>
```

**Attention double WS** : `useEvents()` instancie **une connexion WS au
mount** (cf. `useEvents.ts:66-154`, `useEffect` sans deps). Si on
l'appelle dans `SettingsDrawer` ET dans le shell (pour `Toasts`),
on aurait **deux WS** ouvertes en parallèle (régression du fix
584d9ec « events WS loop spawning duplicate connections »). **Solution
v1** : ne **pas** appeler `useEvents()` dans le drawer. Le shell
appelle `useEvents()` une fois et **passe `connected` en prop** au
drawer (et au `EventsPip` global). Schéma :

```
DesktopShell
├─ const { connected, waiting, dismiss } = useEvents();
├─ <TopBar onOpenSettings={() => setSettingsOpen(true)} />
├─ <Toasts waiting={waiting} onDismiss={dismiss} />
├─ <EventsPip connected={connected} />
└─ {settingsOpen && (
     <SettingsDrawer
       info={info}
       health={health}
       authState={authState}
       wsConnected={connected}       ← passé en prop
       onClose={() => setSettingsOpen(false)}
       onTokenSaved={probeAuth}
       onTokenCleared={() => setAuthState('missing')}
     />
   )}
```

### 6.2 Latence optionnelle (follow-up)

Si on veut afficher une latence WS (round-trip ping), il faut une frame
PING applicative dans `useEvents` (pas dispo aujourd'hui). Hors scope
v1, on note dans `field-help` mais on ne l'affiche pas.

### 6.3 Classes CSS `.dot.ok / .dot.warn`

À ajouter dans `desktop-theme.css` si pas déjà présent (étape 1) :

```css
.dot {
  display: inline-block; width: 8px; height: 8px;
  border-radius: 50%; flex-shrink: 0;
}
.dot.ok { background: var(--ok, #5ec27a); box-shadow: 0 0 6px var(--ok, #5ec27a); }
.dot.warn { background: var(--warn); box-shadow: 0 0 6px var(--warn); animation: pulse-fade 1.6s ease-in-out infinite; }
.dot.bad { background: var(--bad, #d96a5a); }
```

(`pulse-fade` keyframe est défini ligne 326 du HTML v2.)

---

## 7. Composant complet (JSX final)

```tsx
// packages/web/src/components/desktop/SettingsDrawer.tsx
import { useEffect, useRef, useState } from 'react';
import {
  getToken,
  setToken,
  type HealthView,
  type InfoView,
} from '../../api/client';
import { useNow } from '../../lib/useNow';
import { formatUptime, formatClockShort } from '../../lib/format';

export type AuthState = 'unknown' | 'ok' | 'missing' | 'invalid';

export interface SettingsDrawerProps {
  info: InfoView | null;
  health: HealthView | null;
  authState: AuthState;
  wsConnected: boolean;
  onClose: () => void;
  onTokenSaved?: () => void;
  onTokenCleared?: () => void;
}

export function SettingsDrawer({
  info,
  health,
  authState,
  wsConnected,
  onClose,
  onTokenSaved,
  onTokenCleared,
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

  // Auto-focus token input at mount
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
        </div>
      </aside>
    </>
  );
}
```

---

## 8. Plan d'implémentation pas-à-pas

1. **Pré-requis** : Étape 1 (`desktop-theme.css` avec `.drawer*`, `.btn`,
   `.field-warn`, `.pr-stats`, `.dot`, `.pr-close`, `.modal-title`,
   keyframes `drawer-in`, `backdrop-in`, `pulse-fade`) et Étape 3
   (`TopBar.tsx` avec bouton cog qui appelle `onOpenSettings` du shell).
2. **Créer `packages/web/src/lib/format.ts`** :
   - `formatUptime(startedAt, now?) → 'HH:MM:SS'`
   - `formatClockShort(ts) → 'HH:MM'`
   - `formatRelative(ts) → 'Ns ago' | 'Nm ago' | 'Nh ago' | 'Nd ago'`
     (utile aussi pour `RECENTLY ENDED` et `pr-meta last_activity`, donc
     on fait tout en une passe)
   - Petit `pad2` interne ; pas de dep externe.
3. **Créer `packages/web/src/lib/format.test.ts`** :
   - `formatUptime(null) === '—'`
   - `formatUptime('invalid') === '—'`
   - `formatUptime(now - 3661*1000, now) === '01:01:01'`
   - `formatClockShort('2026-05-22T08:05:00Z')` selon fuseau (utiliser
     `new Date(...).getHours()` directement, donc tester un timestamp
     local fixe).
4. **Créer `packages/web/src/components/desktop/SettingsDrawer.tsx`** :
   code du §7.
5. **Créer `packages/web/src/components/desktop/SettingsDrawer.test.tsx`** :
   tests du §9 ci-dessous.
6. **Migrer `App.tsx`** :
   - Supprimer les lignes 135-181 (bloc inline settings).
   - Supprimer le bouton "Settings" du header lignes 126-131 (déplacé
     dans `TopBar`).
   - Supprimer `useEffect` lignes 76-78 (sync `token` quand
     `showSettings` change — plus nécessaire car drawer init local).
   - Conserver `health, info, authState, probeAuth, showSettings` (à
     renommer `settingsOpen`) — ils restent au niveau shell.
   - Brancher `<SettingsDrawer>` conditionnellement quand
     `settingsOpen`, passer toutes les props (cf. §6.1).
   - **Note** : en pratique, après Étape 3 (DesktopShell), tout ce code
     migre dans `DesktopShell.tsx`. Si on enchaîne 11 directement sans
     attendre la complétion de la grille shell, on patch d'abord
     `App.tsx` puis on déplace.
7. **Vérifier `api/client.ts`** : aucune modification — `getToken` /
   `setToken` / `api.info` / `api.health` déjà OK (lignes 6-13, 190-191).
   La clé `'swarm-os.token'` reste **inchangée** (rétro-compat avec les
   tokens persistés chez les opérateurs).
8. **Vérifier `useEvents.ts`** : aucune modification. On consomme juste
   `connected` au niveau shell et on le passe en prop. **Important** :
   ne **pas** importer `useEvents` directement dans `SettingsDrawer`
   pour éviter une seconde connexion (régression bug 584d9ec).
9. **Smoke** : lancer la stack docker (cf. `project_docker_redeploy.md`
   en mémoire) et vérifier les tests du §9.
10. **Suppression banner d'`App.tsx`** : OK car la même information
    (warning token missing/invalid) est rendue dans le drawer, et
    `authState !== 'ok'` déclenche `setSettingsOpen(true)`
    automatiquement (auto-open du drawer = équivalent fonctionnel du
    banner permanent).

---

## 9. Tests de fumée

### 9.1 Tests Vitest (`SettingsDrawer.test.tsx`)

| # | Scénario | Assertion |
|---|---|---|
| T1 | Mount avec `authState='missing'` et token vide | rend `field-warn` "No token set", input vide, bouton SAVE présent |
| T2 | Mount avec `authState='invalid'` et token "abc" | rend `field-warn` "Token rejected (HTTP 401)" |
| T3 | Mount avec `authState='ok'` et token "abc" | aucun `field-warn`, bouton CLEAR présent |
| T4 | Click sur SHOW puis HIDE | l'input passe `type=text` puis `type=password` |
| T5 | Type "xyz123" puis click SAVE | `setToken` (api/client) appelé avec `'xyz123'`, label devient "✓ SAVED" pendant 1.5 s, `onTokenSaved` appelé |
| T6 | Click CLEAR | `setToken` appelé avec `''`, input vidé, `onTokenCleared` appelé |
| T7 | Escape keydown | `onClose` appelé |
| T8 | Click sur backdrop | `onClose` appelé |
| T9 | Click à l'intérieur du drawer (input) | `onClose` **non** appelé (stopPropagation) |
| T10 | `info={project_name:'swarm-os', version:'0.1.0', started_at: <fixed>}` | section ABOUT rend PROJECT, VERSION, STARTED corrects ; UPTIME format `HH:MM:SS` |
| T11 | UPTIME tick : avancer `vi.useFakeTimers()` de 1 s | la cellule UPTIME se met à jour (re-render via `useNow(1000)`) |
| T12 | `wsConnected=true` | rend `<span class="dot ok">`, label "LIVE" |
| T13 | `wsConnected=false` | rend `<span class="dot warn">`, label "RECONNECTING…" |
| T14 | Auto-focus input au mount | `document.activeElement === <input id='x-auth-token-input'>` |
| T15 | `info=null, health=null` | sections About / Events rendent fallback "—" et `0 active` sans crash |

### 9.2 Tests manuels (dans la stack docker)

1. **Build + redeploy** :
   `docker build -t swarm-os:latest .`
   `docker compose -f docker-compose.test.yml up -d`
2. **Auto-open** : ouvrir l'app sans token en `localStorage` → le
   drawer s'ouvre automatiquement (auto-open via `authState='missing'`).
   Vérifier que la banner "No token set" + `docker exec...` est visible.
3. **Paste + save** : récupérer le token (`docker exec swarm-os cat
   /data/token`), le coller, click SAVE → label "✓ SAVED" 1.5 s, drawer
   reste ouvert (différence vs. legacy qui fermait), authState passe à
   `'ok'`, la banner disparaît.
4. **Clear** : click CLEAR → input vidé, `field-warn` réapparaît, `localStorage` ne contient plus `swarm-os.token`.
5. **Escape close** : drawer ouvert, presser Échap → drawer ferme.
6. **Backdrop close** : drawer ouvert, click dans la zone sombre à
   gauche du drawer → ferme.
7. **Click input** : drawer ouvert, click dans l'input → drawer **ne
   ferme pas**.
8. **About live** : laisser le drawer ouvert 10 s → la cellule UPTIME
   incrémente chaque seconde (HH:MM:SS).
9. **WS pip** : drawer ouvert, killer le serveur (`docker compose stop`)
   → le pip Events passe de vert "LIVE" à jaune "RECONNECTING…" dans la
   seconde.
10. **WS pip recover** : redémarrer (`docker compose start`) → pip
    revient à vert "LIVE".
11. **SHOW/HIDE** : taper du texte, click SHOW → texte visible, click
    HIDE → texte masqué (•••).
12. **Vitesse animation** : ouverture < 250 ms, fluide (slide depuis la
    droite + fade backdrop).
13. **Pas de double WS** : ouvrir DevTools → onglet Network → WS, ouvrir
    /fermer le drawer 5×, vérifier qu'il **n'y a toujours qu'une seule**
    connexion `/ws/events` (régression-guard pour le bug 584d9ec).
14. **Rétro-compat token** : si l'opérateur avait déjà un token persisté
    avec l'ancienne UI (clé `'swarm-os.token'`), il doit être pré-rempli
    à l'ouverture du drawer (pas de reset silencieux).

### 9.3 Tests d'accessibilité (manuel)

- Tab depuis la TopBar → focus va sur le cog → Enter → drawer ouvre,
  focus va automatiquement sur l'input token (`firstFocusableRef`).
- Tab dans le drawer : input → SHOW → SAVE → CLEAR → close (×). Pas de
  fuite vers les éléments derrière le drawer (acceptable v1 : pas de
  trap strict, on s'appuie sur l'unmount à la fermeture).
- Lecteur d'écran : annonce "dialog, settings" (via `role=dialog`,
  `aria-modal`, `aria-labelledby="settings-drawer-title"`).

---

## 10. Récapitulatif des fichiers touchés

| Fichier | Action |
|---|---|
| `packages/web/src/components/desktop/SettingsDrawer.tsx` | **créer** (§7) |
| `packages/web/src/components/desktop/SettingsDrawer.test.tsx` | **créer** (§9.1) |
| `packages/web/src/lib/format.ts` | **créer** (`formatUptime`, `formatClockShort`, `formatRelative`) |
| `packages/web/src/lib/format.test.ts` | **créer** |
| `packages/web/src/App.tsx` | **éditer** — supprimer lignes 113-132 (bouton header) et 135-181 (inline settings) ; ajouter `<SettingsDrawer>` conditionnel + state `settingsOpen` ; supprimer `useEffect` lignes 76-78 |
| `packages/web/src/api/client.ts` | **inchangé** — `getToken` / `setToken` / `api.info` / `api.health` déjà OK |
| `packages/web/src/hooks/useEvents.ts` | **inchangé** — `connected` déjà exposé, ne **pas** appeler depuis le drawer (régression-guard 584d9ec) |
| `packages/web/src/styles/desktop-theme.css` | **vérifier** que `.drawer-backdrop`, `.drawer`, `@keyframes drawer-in`, `@keyframes backdrop-in`, `@keyframes pulse-fade`, `.drawer-head`, `.drawer-body`, `.drawer-section`, `.dot.ok`, `.dot.warn`, `.pr-stats`, `.pr-stat`, `.modal-title`, `.pr-close`, `.btn`, `.btn.primary`, `.btn.ghost`, `.field`, `.field label`, `.field input`, `.field-warn`, `.field-help` sont présents (l'Étape 1 les a portés depuis `Swarm OS v2.html:919-950` + co.) |
| `packages/web/src/components/desktop/TopBar.tsx` | **(Étape 3)** ajouter `onOpenSettings: () => void` prop + bouton cog (icon `cog` de `v2/icons.jsx`) qui appelle ce callback |
| `packages/web/src/components/desktop/DesktopShell.tsx` | **(Étape 2/3)** state `settingsOpen`, lift de `info`/`health`/`authState`/`probeAuth` (migrés depuis `App.tsx`), passe les props au drawer |

---

## 11. Notes & pièges

1. **Clé localStorage** : prototype = `'swarm.token'`, système =
   `'swarm-os.token'`. Garder la clé système (rétro-compat). Toujours
   passer par `setToken/getToken` de `api/client.ts`.
2. **Double WS interdite** : ne **jamais** appeler `useEvents()` dans
   `SettingsDrawer`. Le shell consomme une fois, propage `connected` en
   prop. C'est documenté dans le commit 584d9ec.
3. **`useNow(1000)`** : 1 re-render/s côté drawer pour le compteur
   UPTIME. Coût négligeable car le drawer est unmount quand fermé.
4. **Animation de sortie absente v1** : on unmount direct, le drawer
   disparaît sans slide-out. Si l'UX semble brusque, follow-up =
   `closing` state + `setTimeout(unmount, 220)` + keyframe `drawer-out`.
5. **`info` figé** : `project_name`, `version`, `started_at` ne bougent
   pas en runtime → fetch une fois au boot du shell. Pas besoin de poll.
6. **`health.sessions_active` dynamique** : refresh via le même `useEffect`
   3 s que `useOrchestrators` côté shell (ou directement via
   `useHealth()` à factoriser si besoin).
7. **Tests CSS** : si on conserve Tailwind 4 en parallèle, vérifier le
   safelist pour `.drawer*`, `.pr-stats`, `.pr-stat`, `.dot`,
   `.field-warn` etc. (sinon purge sauvage). Cf. risque §5.4.1 du
   doc principal.
8. **Bouton cog dans la TopBar** (Étape 3) : `<button
   onClick={onOpenSettings}><ICON name="cog"/></button>`. Le drawer est
   piloté par le shell qui possède le state `settingsOpen`.
9. **Auto-open si `authState='missing'|'invalid'`** : conserver la
   logique existante (`App.tsx:81-83`). Le drawer reste **fermable** par
   l'utilisateur ; il se rouvrira au prochain probe si toujours
   missing/invalid. Pas de loop : `setSettingsOpen(true)` n'est appelé
   qu'à la transition de `authState`, pas à chaque render.
10. **`pr-close`** : la classe existe déjà dans le proto v2 (réutilisée
    par tous les `modal-head`). Vérifier que `desktop-theme.css` la
    porte avec `background: transparent; color: var(--text-mute);
    font-size: 18px; cursor: pointer;` etc.
