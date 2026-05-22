# Étape 1 (Phase A.1) — Import du design system v2 dans `packages/web/`

> **Périmètre exact** : extraire les fondations visuelles du prototype v2
> (variables CSS warm-black ambré, fonts Geist / Geist Mono, classes
> utilitaires de base) et les rendre disponibles dans le bundle React via
> un nouveau fichier `packages/web/src/styles/desktop-theme.css` importé
> depuis `main.tsx`. **Aucun composant** n'est porté à cette étape — on
> n'ajoute que le moteur de design pour que les phases suivantes (B, C, D)
> puissent utiliser les classes `.team-pill`, `.pr-tab`, etc. immédiatement.

---

## 1. Objectif

Faire entrer dans le bundle React les **variables CSS warm-black**, les
**polices Geist / Geist Mono** et la **bibliothèque de classes utilitaires**
du prototype v2 (`Swarm OS v2.html`) de manière à ce que tous les
composants `desktop/*` à créer aux phases ultérieures puissent référencer
ces classes (`.team-pill`, `.pr-tab`, `.pr-cfgline`, `.console-line`,
`.node-inbox-bg`, `.node-ring-pulse`, `.center-hub`, `.toast`, `.modal`,
`.drawer`, `.cfg-*`, …) sans dépendre de Tailwind. Tailwind 4 reste actif
pour les composants legacy (`OrchestratorList`, `OrchestratorView`,
`NotificationPanel`, etc.) jusqu'à leur démantèlement progressif.

---

## 2. État actuel

### 2.1 Stack frontend

- React 19 + Vite 6 + TypeScript 5.7, point d'entrée `packages/web/src/main.tsx`.
- **Tailwind 4** via le plugin officiel Vite `@tailwindcss/vite` (cf.
  `packages/web/vite.config.ts:3,10`). Tailwind 4 est en mode "CSS-first
  config" : pas de `tailwind.config.{js,ts}`, pas de `postcss.config.*`.
  Tout passe par `@import 'tailwindcss'` dans `src/index.css:1`.
- xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
  pour la console.
- PWA : service worker enregistré depuis `main.tsx:21-29` (prod uniquement).

### 2.2 `packages/web/src/main.tsx` (état actuel)

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';                       // ← seul CSS importé aujourd'hui
// … StrictMode + service worker
```

L'import du CSS se fait *avant* le render via `import './index.css'`.
C'est le point d'injection naturel pour `desktop-theme.css`.

### 2.3 `packages/web/src/index.css` (état actuel, 43 lignes)

```css
@import 'tailwindcss';   /* Tailwind 4 CSS-first config */

html, body, #root { height: 100%; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

/* S3 — keyframes swarm-status-pulse (pulse box-shadow ambre #e8b04a) */
@keyframes swarm-status-pulse { … }
.status-pulse { animation: swarm-status-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .status-pulse { animation: none; } }
```

Notes :
- Le `body` impose `font-family: system-ui` — on devra **soit le retirer
  soit le surcharger** dans `desktop-theme.css` (qui veut `"Geist", system-ui, sans-serif`).
- Une keyframe `swarm-status-pulse` existe déjà (utilisée par S3 sur
  `StatusBadge`). Elle est conceptuellement équivalente au
  `@keyframes pulse-fade` du prototype v2 (même hue `#e8b04a`). À garder
  pour ne pas casser les composants legacy ; les nouveaux composants
  utiliseront `pulse-fade` / `ring-pulse` du prototype.

### 2.4 Tailwind 4 — pas de fichier de config

```
$ find packages/web -maxdepth 3 -name "tailwind*" -o -name "postcss*"
packages/web/node_modules/tailwindcss   ← rien d'autre
```

Tailwind 4 lit la configuration depuis le CSS lui-même (directives
`@theme`, `@source`, `@layer`, `@utility`). Par défaut, **le scan
des classes** opéré par le plugin Vite parcourt automatiquement tous les
fichiers `*.{js,jsx,ts,tsx,html}` du projet (heuristique built-in,
configurable via `@source`). Conséquence pratique pour notre étape :
**les classes CSS custom déclarées dans `desktop-theme.css` ne sont pas
visées par le purge** — Tailwind ne purge que **ses propres** classes
(génératives). Tout ce qui vient d'un fichier `.css` importé reste tel
quel dans le bundle final. Aucune `safelist` n'est nécessaire.

### 2.5 `packages/web/index.html` — chargement des fonts

Aucun `<link>` Google Fonts dans l'HTML actuel. La balise `<head>`
contient uniquement manifest PWA, theme-color, icônes. Le mécanisme
recommandé pour les fonts est :
- **option A (préférée)** : ajouter les `<link rel="preconnect">` +
  `<link rel="stylesheet">` Google Fonts dans `index.html` (chargement
  parallèle au JS, pas de FOIT) ;
- **option B (fallback)** : `@import url(...)` en tête de
  `desktop-theme.css` (bloque le render jusqu'à téléchargement).

L'option A est celle utilisée par le prototype v2 (cf. lignes 7-9 du HTML),
et c'est la pratique standard côté perf. À adopter ici.

---

## 3. Source v2 — où sont les variables / fonts / classes

Le fichier source **n'existe pas dépaqueté** sur le disque : `prototypes/v2/`
ne contient que les `.jsx`. Le HTML v2 vit **dans l'archive**
`prototypes/swarm-os-prototypes_v2.zip` (entrée `Swarm OS v2.html`,
1049 lignes, 40 336 octets, mtime 2026-05-22 02:42).

Pour le développeur :
```sh
unzip -p /home/ubuntu/projets/swarm-os/prototypes/swarm-os-prototypes_v2.zip \
  "Swarm OS v2.html" > /tmp/swarm-os-v2.html
# ou extraction durable :
unzip -o /home/ubuntu/projets/swarm-os/prototypes/swarm-os-prototypes_v2.zip \
  "Swarm OS v2.html" -d /home/ubuntu/projets/swarm-os/prototypes/v2/
```

> Recommandation pour la suite : **dépaqueter** `Swarm OS v2.html` à côté
> des `.jsx` (`prototypes/v2/Swarm OS v2.html`) pour qu'il devienne la
> source de vérité versionnée, comme indiqué dans le doc parent
> `ui-redesign-desktop.md` §1.2 + §5.3.

Le `<style>` couvre les **lignes 10 → 1031** du HTML. Découpage logique
(à recopier intégralement dans `desktop-theme.css`) :

### 3.1 Polices (lignes 7-9 du HTML)

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&family=Geist:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
```

Geist : poids 300, 400, 500, 600, 700.
Geist Mono : poids 300, 400, 500, 600.

### 3.2 Variables CSS `:root` (lignes 11-31, palette warm-black ambré + 6 états)

```css
:root {
  --bg: #0d0a08;
  --bg-2: #16110d;
  --panel: rgba(20, 15, 11, 0.78);
  --panel-solid: #14100c;
  --panel-elev: #1a140e;
  --border: rgba(255, 200, 140, 0.10);
  --border-strong: rgba(255, 200, 140, 0.22);
  --border-hot: rgba(255, 176, 96, 0.55);
  --text: #f3e9dc;
  --text-dim: #b6a48b;
  --text-mute: #6b5b48;
  --amber: #ffb060;
  --amber-soft: #d98a3a;
  --amber-deep: #8b4a18;
  --ok: #6ec48a;
  --warn: #e8b04a;
  --bad: #e0654a;
  --stopped: #5a4d3f;
  --info: #8ab6e0;
}
```

> **États couverts** : `ok` (`#6ec48a`), `warn` (`#e8b04a`), `bad`
> (`#e0654a`), `stopped` (`#5a4d3f`), `waiting` (= `--amber #ffb060`,
> animation `pulse-fade`), `starting` (= `--amber-soft #d98a3a`, animation
> `pulse-fade 0.9s`). Les 4 premiers sont des variables dédiées ; les 2
> derniers réutilisent `--amber` / `--amber-soft`.

### 3.3 Reset + body (lignes 32-42)

```css
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: "Geist", system-ui, sans-serif;
  font-size: 13px;
  overflow: hidden;
  user-select: none;
}
.mono { font-family: "Geist Mono", ui-monospace, monospace; }
.app { position: fixed; inset: 0; display: grid; grid-template-rows: 56px 1fr; }
```

⚠ `body { overflow: hidden; user-select: none; }` — choix de design SPA
desktop full-screen. À copier tel quel (mais voir §6.4 : risque
d'incompatibilité avec les composants legacy qui scrollent dans le body).

### 3.4 Classes utilitaires critiques (recensement complet)

Toutes les classes ci-dessous **doivent** se retrouver dans
`desktop-theme.css`. Le tableau les groupe par section visuelle pour
faciliter la revue. Chaque ligne du HTML est donnée en référence
(numérotation du HTML v2 extrait dans `/tmp/v2-extract/Swarm OS v2.html`).

| Section | Classes / keyframes | Lignes HTML |
|---|---|---|
| **Topbar** | `.topbar`, `.brand`, `.brand-mark`, `.brand-text`, `.brand-text .sub`, `.health-strip`, `.team-pill`, `.team-pill.active`, `.team-pill.flash-new`, `@keyframes flash-new`, `.pill-head`, `.pill-name`, `.pill-name .waiting-flag`, `.pill-status`, `.dot` + variants `.warn/.bad/.stopped/.ok/.waiting/.starting`, `.pill-body`, `.pill-meta`, `.pill-bar`, `.pill-bar > i` + variants, `.topbar-right`, `.tb-action` + media queries, `.tb-action.primary`, `.tb-clock` | 46-165 |
| **Main grid** | `.main`, `.panel-left`, `.panel-right`, `.panel-right.closed`, `.canvas-wrap`, `.canvas-wrap.panning` | 168-188 |
| **Left panel** | `.pl-section` (+ `.grow`, `.cap`), `.pl-section h3`, `.tag`, `.count`, `.big-number`, `.delta`, `.big-sub`, `.graph`, `.team-list`, `.team-row`, `.tr-name`, `.swatch`, `.tr-count`, `.tr-meta`, `.tr-spark`, `.ended-row`, `.ended-name`, `.ended-time`, `.ended-meta`, `.badge-reason` (+ `.failed`, `.killed`) | 191-266 |
| **Canvas (map)** | `.grid-bg`, `.canvas-svg`, `.canvas-overlay`, `.canvas-hud`, `.canvas-zoom`, `.node`, `.node-ring` (+ `.lead/.selected/.stopped/.failed/.starting/.interrupted`), **`.node-ring-pulse` + `@keyframes ring-pulse`**, `@keyframes pulse-fade`, `.node-glow` (+ variants), `.node-label`, `.node-role`, `.node-svr-restart`, `.node-shape`, `.node-status-dot`, **`.node-inbox-bg`, `.node-inbox-txt`**, `.node.spawning` + `@keyframes node-spawn`, `.edge` (+ variants), **`.center-hub`** (+ hover), `@keyframes pulse-travel`, `.pulse-dot` (+ `.human`, `.broadcast`), `.canvas-tooltip` | 269-722 |
| **Right panel head** | `.pr-head`, `.pr-top`, `.pr-id`, `.pr-close`, `.pr-name`, `.pr-name .badge`, `.pr-role`, `.discord-chip`, **`.pr-cfgline`** (+ `.sep`, `.lbl`, `.edit`), **`.pr-cwd`** (+ `.lbl`), `.pr-stats`, `.pr-stat`, `.pr-meta`, `.pr-actions`, `.pr-action` (+ `.danger/.go/.primary`, `[disabled]`) | 397-500 |
| **Right panel tabs/body** | `.pr-tabs`, **`.pr-tab` + `.pr-tab.active`**, `.pr-tabs-meta`, `.pr-body`, `.console`, **`.console-line`** (+ `.t`, `.lv` + niveaux `INFO/OK/WARN/ERR/SEND/RECV`, `.msg`, `.ref`), `.messages`, `.bubble` (+ `.me/.them`, `.who`), `.pr-empty`, `.pr-empty-inner` | 502-685 |
| **Config tab** | **`.cfg`**, **`.cfg-section`**, `.cfg-h` (+ `.h-edit`), **`.cfg-kv`** (+ `.k`, `.v`), **`.cfg-pre`** | 568-604 |
| **Composer** | `.composer`, `.composer textarea` (+ `.mailbox`), `.composer-toolbar`, `.composer-toggles`, `.seg`, `.seg button` (+ `.on`), `.composer-helper`, `.composer-row`, `.send-btn`, `.send-target` (+ `.broadcast`) | 606-670 |
| **Chip statut** | `.chip` (+ `.ok/.warn/.waiting/.stopped/.bad/.starting/.reader/.writer`) | 688-701 |
| **Scrollbars** | `::-webkit-scrollbar`, `::-webkit-scrollbar-thumb`, `::-webkit-scrollbar-track` | 704-706 |
| **Modal/overlay** | `.modal-backdrop` + `@keyframes backdrop-in`, **`.modal`**, `.modal.wide`, `@keyframes modal-in`, `.modal-head`, `.modal-title`, `.modal-body`, `.modal-foot`, `.field` (+ `.field-row`, `.field-3`, `label`, `input`, `textarea`, `select`, focus, `.field-help`, `.field-warn`), `.seg-radio` (+ `button`, `.on`), `.btn` (+ `.primary/.ghost/.danger`) | 724-824 |
| **Roles overlay** | `.roles-overlay`, `.roles-side`, `.roles-side-head` (+ `.back`, `.title`, `.sub`), `.roles-list`, `.role-item` (+ `.active`, `.r-name`, `.r-id`, `.r-tags`), `.tag-pill` (+ `.discord`, `.model`), `.roles-add`, `.roles-main` (+ `h2`, `.role-id`), `.role-section` (+ `h3`, `.h-edit`) | 827-917 |
| **Drawer (settings)** | `.drawer-backdrop`, **`.drawer`** + `@keyframes drawer-in`, `.drawer-head`, `.drawer-body`, `.drawer-section` (+ `.h`) | 920-950 |
| **Toasts** | **`.toasts`**, **`.toast`** + `@keyframes toast-in`, `.toast .t-head/.t-title/.t-time/.t-id/.t-reason/.t-foot`, `.toast button.open/.dismiss`, `.toasts-older`, `.events-pip` | 953-1027 |
| **Icon helper** | `.icon-sm` | 1030 |

> Les classes en **gras** sont celles citées explicitement dans le brief
> de l'étape — toutes sont présentes ; le tableau exhaustif est donné
> parce qu'on doit copier le `<style>` **dans son entièreté**, pas un
> sous-ensemble.

### 3.5 Blocs CSS littéraux — extraits clés à conserver mot-pour-mot

**`.team-pill`** (lignes 74-96)

```css
.team-pill {
  flex: 1 0 130px; min-width: 130px;
  display: grid; grid-template-rows: auto 1fr;
  padding: 8px 14px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  transition: background 120ms ease;
  position: relative;
}
.team-pill:hover { background: rgba(255, 176, 96, 0.04); }
.team-pill.active { background: rgba(255, 176, 96, 0.07); }
.team-pill.active::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
  background: var(--amber);
}
.team-pill.flash-new { animation: flash-new 1.6s ease-out 1; }
@keyframes flash-new {
  0%   { background: rgba(255, 176, 96, 0.0); }
  20%  { background: rgba(255, 176, 96, 0.30); }
  100% { background: rgba(255, 176, 96, 0.07); }
}
```

**`.pr-tab`** (lignes 506-515)

```css
.pr-tab {
  flex: 1; background: none; border: none; color: var(--text-mute);
  padding: 11px 4px;
  font-family: "Geist Mono", monospace; font-size: 10px;
  letter-spacing: 0.14em;
  cursor: pointer;
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
}
.pr-tab.active { color: var(--amber); border-bottom-color: var(--amber); }
```

**`.pr-cfgline` + `.pr-cwd`** (lignes 436-455)

```css
.pr-cfgline {
  font-family: "Geist Mono", monospace; font-size: 10px;
  letter-spacing: 0.10em; color: var(--text-dim);
  display: flex; align-items: center; gap: 8px;
}
.pr-cfgline .sep { color: var(--text-mute); }
.pr-cfgline .lbl { color: var(--text-mute); }
.pr-cfgline .edit {
  margin-left: auto;
  background: none; border: 1px solid var(--border);
  color: var(--text-mute); width: 22px; height: 22px;
  cursor: pointer; display: grid; place-items: center;
}
.pr-cfgline .edit:hover { color: var(--amber); border-color: var(--border-strong); }
.pr-cfgline .edit svg { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 1.4; }
.pr-cwd {
  font-family: "Geist Mono", monospace; font-size: 10px;
  letter-spacing: 0.08em; color: var(--text-dim);
}
.pr-cwd .lbl { color: var(--text-mute); }
```

**`.console-line`** (lignes 530-540)

```css
.console-line { display: grid; grid-template-columns: 64px 50px 1fr; gap: 10px; padding: 2px 0; color: var(--text-dim); }
.console-line .t { color: var(--text-mute); }
.console-line .lv { font-size: 9.5px; letter-spacing: 0.14em; }
.console-line .lv.INFO { color: var(--text-dim); }
.console-line .lv.OK { color: var(--ok); }
.console-line .lv.WARN { color: var(--warn); }
.console-line .lv.ERR { color: var(--bad); }
.console-line .lv.SEND { color: var(--amber); }
.console-line .lv.RECV { color: var(--info); }
.console-line .msg { color: var(--text); white-space: pre-wrap; word-break: break-word; }
.console-line .msg .ref { color: var(--amber); }
```

**`.node-inbox-bg`, `.node-inbox-txt`, `.node-ring-pulse`** (lignes 316-357)

```css
.node-ring-pulse {
  fill: none; stroke: var(--amber); stroke-width: 1.2;
  transform-origin: center;
  transform-box: fill-box;
  animation: ring-pulse 1.6s ease-in-out infinite;
}
@keyframes ring-pulse {
  0%, 100% { opacity: 0.25; stroke-width: 1.2; }
  50%      { opacity: 0.95; stroke-width: 1.8; }
}
.node-inbox-bg { fill: var(--amber); }
.node-inbox-txt {
  font-family: "Geist Mono", monospace; font-size: 8px; font-weight: 600;
  fill: #1a0e04; text-anchor: middle; pointer-events: none; letter-spacing: 0;
}
```

**`.center-hub`** (lignes 377-394)

```css
.center-hub { cursor: pointer; }
.center-hub circle.outer { fill: none; stroke: rgba(255, 200, 140, 0.35); }
.center-hub circle.inner { fill: rgba(255, 176, 96, 0.18); stroke: var(--amber); }
.center-hub:hover circle.outer { stroke: rgba(255, 200, 140, 0.65); }
.center-hub:hover circle.inner { fill: rgba(255, 176, 96, 0.30); }
.center-hub text {
  font-family: "Geist Mono", monospace;
  font-size: 8px; letter-spacing: 0.18em;
  fill: var(--text-dim); text-anchor: middle;
  pointer-events: none;
}
@keyframes pulse-travel {
  from { offset-distance: 0%; opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  to { offset-distance: 100%; opacity: 0; }
}
```

**`.toast`** (lignes 960-1009, extrait)

```css
.toast {
  pointer-events: auto;
  background: var(--panel-solid);
  border: 1px solid rgba(232, 176, 74, 0.45);
  border-left: 3px solid var(--warn);
  padding: 10px 12px;
  display: grid; gap: 4px;
  width: 320px;
  animation: toast-in 240ms cubic-bezier(.2,.7,.2,1);
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}
@keyframes toast-in {
  from { transform: translateX(20px); opacity: 0; }
  to   { transform: translateX(0); opacity: 1; }
}
```

**`.modal`** (lignes 736-749)

```css
.modal {
  background: var(--panel-solid);
  border: 1px solid var(--border-strong);
  box-shadow: 0 30px 80px rgba(0,0,0,0.5);
  width: 540px; max-width: calc(100vw - 80px);
  max-height: calc(100vh - 80px);
  display: flex; flex-direction: column;
  animation: modal-in 200ms cubic-bezier(.2,.7,.2,1);
}
.modal.wide { width: 720px; }
@keyframes modal-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

**`.drawer`** (lignes 926-938)

```css
.drawer {
  position: fixed; top: 56px; bottom: 0; right: 0;
  width: 420px; max-width: calc(100vw - 40px);
  background: var(--panel-solid);
  border-left: 1px solid var(--border-strong);
  z-index: 71;
  display: flex; flex-direction: column;
  animation: drawer-in 220ms cubic-bezier(.2,.7,.2,1);
}
@keyframes drawer-in {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
```

**`.cfg-section`, `.cfg-kv`, `.cfg-pre`** (lignes 574-604)

```css
.cfg-section { display: grid; gap: 8px; }
.cfg-h {
  font-family: "Geist Mono", monospace; font-size: 9.5px;
  letter-spacing: 0.18em; color: var(--text-mute);
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--border); padding-bottom: 6px;
}
.cfg-kv {
  display: grid; grid-template-columns: 100px 1fr; gap: 4px 14px;
  font-family: "Geist Mono", monospace; font-size: 10.5px;
  letter-spacing: 0.06em;
}
.cfg-kv .k { color: var(--text-mute); }
.cfg-kv .v { color: var(--text); word-break: break-all; }
.cfg-pre {
  background: #14100c;
  border: 1px solid var(--border);
  padding: 10px 12px;
  font-family: "Geist Mono", monospace; font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
```

---

## 4. Stratégie d'intégration

### 4.1 Emplacement du nouveau fichier

**Cible** : `packages/web/src/styles/desktop-theme.css` (nouveau dossier
`styles/` à créer).

Rationale : isole les imports purement visuels du reste du code applicatif ;
prépare l'arrivée des futurs `desktop-tokens.css`, `desktop-overrides.css`,
etc., qui complèteront le système de design.

### 4.2 Point d'import (`main.tsx`)

Modifier `packages/web/src/main.tsx` pour importer le nouveau CSS
**après** `./index.css` :

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import './styles/desktop-theme.css';   // ← NEW
// … reste inchangé (root, render, service worker)
```

### 4.3 Ordre de cascade — crucial

L'ordre **`index.css` puis `desktop-theme.css`** garantit que :

1. Tailwind 4 (`@import 'tailwindcss'`) émet ses **preflight** (reset) en
   premier (priorité la plus basse).
2. Les keyframes et utilitaires legacy (`swarm-status-pulse`,
   `.status-pulse`) sont chargés (priorité moyenne).
3. **Le design system v2 vient ensuite** — ses sélecteurs custom (`.team-pill`,
   `.pr-tab`, etc.) n'entrent jamais en conflit avec les classes
   utilitaires Tailwind (préfixées `bg-*`, `text-*`, `flex-*`, etc.), donc
   l'ordre est neutre pour ces classes. En revanche, les sélecteurs **génériques
   du proto** (`body`, `html`, `*`, `::-webkit-scrollbar`) surcharent
   le preflight Tailwind et le `body { font-family: system-ui }` de
   `index.css` — ce qui est l'effet voulu.

> **Ne pas inverser l'ordre.** Si `desktop-theme.css` était chargé avant
> `index.css`, le `body { font-family: system-ui }` de `index.css`
> réécraserait la `"Geist", system-ui, sans-serif` du proto.

### 4.4 Chargement des fonts Geist

**Option A — `index.html` (recommandée)** : ajouter dans `<head>` les 3
balises Google Fonts (copie littérale du HTML v2 lignes 7-9), juste avant
`<link rel="manifest">` :

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&family=Geist:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
```

Avantages : téléchargement parallèle au JS, `preconnect` ouvre les
sockets dès le parse HTML, pas de FOIT (`display=swap`). Le PWA service
worker (`sw.js`) n'aura pas à mettre en cache les fonts côté shell — le
navigateur s'en charge via son cache HTTP.

**Option B (alternative, à éviter sauf contrainte)** : `@import` en tête
de `desktop-theme.css`. Inconvénients : bloque le parse CSS, retarde le
First Paint d'un round-trip.

**Décision** : option A. Le développeur **doit** modifier `index.html`
en plus de créer le CSS.

### 4.5 Cohabitation avec Tailwind 4 (cf. risque §5.4-1 du doc parent)

- **Pas de purge à craindre** : Tailwind 4 ne supprime que ses propres
  classes générées dynamiquement (heuristique `@source` sur les `*.tsx`).
  Les classes statiques d'un fichier `.css` importé restent intactes dans
  le bundle final.
- **Pas de besoin de `safelist`** : la `safelist` n'existe que pour les
  classes Tailwind qu'on construit dynamiquement (ex. `bg-${color}-500`).
  Aucune classe du proto v2 n'est de cette forme.
- **Collisions possibles** :
  - `.dot` est un nom court, susceptible d'apparaître ailleurs. Audit
    rapide : `grep -rn "className=.*\bdot\b" packages/web/src/` — vérifier
    qu'aucun composant legacy n'utilise déjà `.dot`. À la date du
    présent doc : **aucune occurrence**. RAS.
  - `.chip`, `.bubble`, `.badge` — idem, aucun usage existant dans
    `packages/web/src/`.
  - Surcharge du `body` : `index.css` impose
    `font-family: system-ui, ...` ; `desktop-theme.css` impose
    `"Geist", system-ui, sans-serif`. Vu l'ordre choisi (§4.3), c'est
    Geist qui gagne, conformément à l'intention.
  - `* { box-sizing: border-box }` du proto — Tailwind preflight applique
    déjà la même règle. Aucune régression.
  - `html, body { height: 100% }` est dupliqué entre `index.css` et le
    proto — règles identiques, pas de problème.
  - `body { overflow: hidden; user-select: none }` du proto **peut
    casser les composants legacy** (`OrchestratorList`, `OrchestratorView`,
    etc.) qui s'attendent à pouvoir scroller le body et sélectionner du
    texte. **Mitigation** : laisser ces 2 propriétés dans
    `desktop-theme.css` mais **ne pas** les activer tant que la phase B
    n'est pas livrée. Concrètement, deux options :
    - **(a)** envelopper les règles globales dans un sélecteur racine
      (`.desktop-app body { … }`) appliqué seulement quand `DesktopShell`
      est monté — solution propre mais qui demande d'éditer chaque
      sélecteur global du proto ;
    - **(b)** garder le CSS tel quel, accepter que `body` perde le
      scroll et la sélection dès que `desktop-theme.css` est importé.
      Les composants legacy continueront de fonctionner mais perdront
      leur ergonomie. Cette dégradation est **transitoire** (jusqu'à la
      bascule complète) et c'est la voie qu'a choisie le doc parent
      (§5.4).

  **Décision** : **option (b)** — copie littérale, on assume la
  dégradation pendant la transition. L'étape 1 est un préalable visuel,
  pas un produit final.

- **Ordre de cascade**: déjà couvert §4.3.

### 4.6 Récapitulatif des fichiers touchés à l'étape 1

| Fichier | Action |
|---|---|
| `packages/web/src/styles/desktop-theme.css` | **Créer** (~1020 lignes) |
| `packages/web/src/main.tsx` | **Éditer** — ajouter `import './styles/desktop-theme.css';` après l'import de `index.css` |
| `packages/web/index.html` | **Éditer** — insérer les 3 balises Google Fonts dans `<head>` |
| `prototypes/v2/Swarm OS v2.html` | **Créer** (extraction du zip) pour servir de source de vérité versionnée |

Aucun composant React n'est créé ni modifié à cette étape.

---

## 5. Plan d'implémentation détaillé

### Étape 5.1 — Dépaqueter le HTML v2 (source de vérité)

```sh
cd /home/ubuntu/projets/swarm-os
unzip -o prototypes/swarm-os-prototypes_v2.zip "Swarm OS v2.html" -d prototypes/v2/
ls prototypes/v2/   # devrait inclure "Swarm OS v2.html"
```

### Étape 5.2 — Créer le dossier `styles/`

```sh
mkdir -p /home/ubuntu/projets/swarm-os/packages/web/src/styles
```

### Étape 5.3 — Créer `desktop-theme.css`

Copier **intégralement** le contenu du `<style>` du fichier
`prototypes/v2/Swarm OS v2.html` (lignes 11 → 1030 inclus,
**sans** les balises `<style>` / `</style>`) dans
`packages/web/src/styles/desktop-theme.css`.

Ajouter en tête du fichier un commentaire d'attribution :

```css
/*
 * Swarm OS — Desktop design system (v2)
 *
 * Source: prototypes/v2/Swarm OS v2.html (<style> block, lines 11-1030).
 * Imported from src/main.tsx AFTER src/index.css so that:
 *   1) Tailwind 4 preflight applies first;
 *   2) Legacy keyframes (swarm-status-pulse) remain available;
 *   3) Warm-black v2 tokens, fonts and utility classes win the cascade
 *      on the body/html selectors and on every custom class
 *      (.team-pill, .pr-tab, .console-line, .node-ring-pulse, .center-hub,
 *      .toast, .modal, .drawer, .cfg-section, .cfg-kv, .cfg-pre, …).
 *
 * Do NOT edit this file by hand for design changes — first update the
 * prototype HTML, then re-copy the <style> block here.
 */
```

**Vérification immédiate** : ouvrir le fichier et confirmer qu'il
commence par `:root { --bg: #0d0a08; … }` et finit par `.icon-sm
{ width: 12px; height: 12px; stroke: currentColor; fill: none;
stroke-width: 1.5; }`.

> ⚠ Ne **pas** transformer en `@layer` Tailwind, ne **pas** convertir
> en custom properties Tailwind v4 `@theme`, ne **pas** essayer de
> minifier. Cette étape vise la reproduction fidèle.

### Étape 5.4 — Modifier `main.tsx`

Ajouter une seule ligne d'import après `./index.css` :

```tsx
import './index.css';
import './styles/desktop-theme.css';
```

### Étape 5.5 — Modifier `index.html`

Dans `<head>`, **avant** `<link rel="manifest">`, insérer :

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&family=Geist:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
```

### Étape 5.6 — Build + smoke test

```sh
cd /home/ubuntu/projets/swarm-os/packages/web
pnpm run build          # ou npm run build, selon le workspace
# attendu : tsc OK, vite build OK, asset CSS final = index.css legacy + desktop-theme.css concaténés
```

Inspecter `packages/web/dist/assets/index-*.css` (ou équivalent) :
- doit contenir `:root { --bg: #0d0a08;` (preuve que les vars sont
  bundlées) ;
- doit contenir `.team-pill`, `.pr-tab`, `.console-line`, `.modal`,
  `.drawer`, `.toast`, `.cfg-section` (preuve que rien n'a été purgé) ;
- doit contenir `@keyframes pulse-fade`, `@keyframes ring-pulse`,
  `@keyframes pulse-travel`, `@keyframes flash-new`, `@keyframes node-spawn`,
  `@keyframes modal-in`, `@keyframes drawer-in`, `@keyframes toast-in`,
  `@keyframes backdrop-in`.

### Étape 5.7 — Smoke test runtime (dev)

```sh
cd /home/ubuntu/projets/swarm-os/packages/web
pnpm run dev
# ouvrir http://127.0.0.1:5173
```

Dans la DevTools console :

```js
getComputedStyle(document.body).getPropertyValue('--bg')
//  → "#0d0a08"
getComputedStyle(document.body).fontFamily
//  → contient "Geist"
```

Dans la DevTools Network → Fonts : `Geist` et `Geist Mono` doivent
apparaître chargées (status 200, type `font/woff2`).

> Note : l'apparence des composants legacy (OrchestratorList,
> OrchestratorView) **va changer** — couleurs warm-black héritées du
> `body`, et perte du scroll body. C'est attendu et transitoire.

---

## 6. Risques & pièges

1. **Purge Tailwind** : non applicable. Tailwind 4 ne purge que ses
   classes utilitaires générées dynamiquement, jamais ce qui vient d'un
   `.css` brut importé. Aucun besoin de `safelist`.
2. **Ordre d'import** : critique. `desktop-theme.css` **doit** venir
   après `index.css` dans `main.tsx`, sinon le `body { font-family:
   system-ui }` de `index.css` annule la police Geist. Vérifier avec
   `getComputedStyle(document.body).fontFamily` en runtime.
3. **`body { overflow: hidden; user-select: none }`** — incompatible
   avec le scroll des composants legacy. Dégradation acceptée et
   transitoire (cf. §4.5). Si gênant pour les démos, créer en
   complément un fichier `desktop-theme.overrides.css` qui restaure
   `body { overflow: auto; user-select: auto }` tant que `DesktopShell`
   n'est pas monté, et l'importer **après** `desktop-theme.css`.
4. **Conflits de noms de classes** : audit `grep "className=.*\b(dot|chip|bubble|badge|toast|modal|drawer|node|edge)\b" packages/web/src/`
   à exécuter avant la première PR de phase B. À la date d'aujourd'hui,
   `packages/web/src/components/*.tsx` n'utilise aucune de ces classes
   nues (toutes les classes existantes sont Tailwind, donc préfixées).
   RAS pour l'étape 1.
5. **`@keyframes` doublons** : `swarm-status-pulse` (legacy, dans
   `index.css`) et `pulse-fade` (proto, dans `desktop-theme.css`) sont
   conceptuellement équivalents (même hue, durée proche) mais distincts
   — le doublon n'est pas un problème CSS (noms différents), juste un
   tag à éliminer plus tard quand `StatusBadge` legacy disparaîtra.
6. **`box-sizing: border-box` global du proto** : déjà appliqué par le
   preflight Tailwind, redondant mais inoffensif.
7. **Police Geist 404** : Google Fonts garantit la dispo. En cas de
   coupure réseau (env Docker offline, CI sans accès Internet), le
   `font-family` retombe sur `system-ui` (fallback dans la déclaration
   `font-family: "Geist", system-ui, sans-serif;`). L'app reste
   utilisable, juste moins jolie. **À documenter** pour le pipeline CI
   et pour l'image Docker (`docker compose -f docker-compose.test.yml`
   doit avoir accès au réseau Google Fonts ou les fonts doivent être
   self-hostées — cf. mémoire `project_docker_redeploy.md`).
8. **Service worker en prod (PWA)** : `sw.js` (Phase 6) met en cache
   les assets buildés ; le CSS final inclura `desktop-theme.css`. La
   ressource Google Fonts (cross-origin) **n'est pas** mise en cache
   par défaut par `sw.js` (à vérifier dans `packages/web/public/sw.js`).
   Hors scope de cette étape — mentionné pour mémoire.
9. **`prefers-reduced-motion`** : le proto v2 utilise plusieurs
   `animation`s (`pulse-fade`, `flash-new`, `ring-pulse`, `pulse-travel`,
   `node-spawn`, `modal-in`, `drawer-in`, `toast-in`, `backdrop-in`).
   Aucun n'est gardé par `@media (prefers-reduced-motion)`. Le legacy
   `.status-pulse` l'est. Pour l'étape 1, **on copie tel quel** ; un
   pass d'accessibilité ultérieur ajoutera les media queries (à
   tracker comme dette).
10. **PostCSS / @import circular** : non applicable (pas de
    `@import` dans `desktop-theme.css`).
11. **Hot Module Reload** : un `.css` importé par `main.tsx` est
    HMR-friendly avec le plugin Vite React. Modifier `desktop-theme.css`
    en dev rafraîchit instantanément sans reload — à confirmer en smoke
    test.

---

## 7. Tests / vérification

### 7.1 Vérifications statiques (sans rien lancer)

| Vérif | Commande |
|---|---|
| Le fichier existe | `test -f /home/ubuntu/projets/swarm-os/packages/web/src/styles/desktop-theme.css` |
| Il contient les variables | `grep -c "^\s*--bg:" packages/web/src/styles/desktop-theme.css` ≥ 1 |
| Il contient `.team-pill` | `grep -c "^\.team-pill" …` ≥ 1 |
| Il contient `.pr-tab` | `grep -c "^\.pr-tab" …` ≥ 1 |
| Il contient `.console-line` | `grep -c "^\.console-line" …` ≥ 1 |
| Il contient `.node-ring-pulse` | `grep -c "node-ring-pulse" …` ≥ 1 |
| Il contient `.center-hub` | `grep -c "center-hub" …` ≥ 1 |
| Il contient `.modal` `.drawer` `.toast` | `grep -cE "^\.(modal|drawer|toast)\b" …` ≥ 3 |
| Il contient les keyframes proto | `grep -c "@keyframes pulse-fade\|ring-pulse\|pulse-travel\|flash-new\|node-spawn\|modal-in\|drawer-in\|toast-in\|backdrop-in" …` ≥ 9 |
| `main.tsx` importe le fichier | `grep -c "styles/desktop-theme.css" packages/web/src/main.tsx` = 1 |
| `index.html` charge Geist | `grep -c "Geist" packages/web/index.html` ≥ 1 |

### 7.2 Build TypeScript + Vite

```sh
cd /home/ubuntu/projets/swarm-os/packages/web
pnpm run build
```

Critères :
- `tsc -b` passe sans erreur (aucun changement TS, on n'ajoute qu'un
  import CSS) ;
- `vite build` passe sans erreur ;
- l'asset CSS dans `dist/assets/*.css` pèse **significativement plus
  lourd** qu'avant (de ~5 KB à ~25-30 KB minifié), preuve que tout le
  proto est inclus ;
- `grep -c "team-pill" dist/assets/*.css` ≥ 1 (la classe survit au
  build) ;
- `grep -c "0d0a08" dist/assets/*.css` ≥ 1 (la var `--bg` survit).

### 7.3 Vérification runtime (dev server)

```sh
cd /home/ubuntu/projets/swarm-os/packages/web
pnpm run dev
# ouvrir http://127.0.0.1:5173 dans Chrome/Firefox
```

DevTools → Console :

```js
// 1) variables CSS visibles
['--bg','--amber','--ok','--warn','--bad','--stopped'].forEach(v =>
  console.log(v, getComputedStyle(document.body).getPropertyValue(v))
);
// → --bg "#0d0a08", --amber "#ffb060", --ok "#6ec48a",
//   --warn "#e8b04a", --bad "#e0654a", --stopped "#5a4d3f"

// 2) police Geist appliquée
getComputedStyle(document.body).fontFamily
// → contient "Geist"

// 3) classe utilitaire injectable
const el = document.createElement('div');
el.className = 'team-pill';
document.body.appendChild(el);
getComputedStyle(el).cursor       // → "pointer"
getComputedStyle(el).minWidth     // → "130px"
el.remove();
```

DevTools → Network → Fonts : `Geist` et `Geist Mono` doivent être
téléchargées (status 200, ressources `*.woff2`).

DevTools → Elements → `<body>` : le calcul des styles doit montrer
`background-color: rgb(13, 10, 8)` (= `#0d0a08`).

### 7.4 Vérification visuelle dégradée des composants legacy (sanity)

Le frontend doit **continuer à fonctionner** (créer un orchestrator,
afficher la liste) même si les couleurs / fontes sont décalées. Les
boutons doivent rester cliquables. Si un composant devient invisible
ou inutilisable, c'est un signe de conflit non anticipé — investiguer
en priorité.

### 7.5 Vitest

```sh
cd /home/ubuntu/projets/swarm-os/packages/web
pnpm run test    # si script existe ; sinon: pnpm exec vitest run
```

Critère : **0 régression**. Cette étape ne touche aucune logique JSX/TS
ni aucun selector de test. Si un test échoue, c'est une régression de
configuration (vitest qui n'arrive plus à parser `desktop-theme.css`
par exemple) — auquel cas vérifier la config `vitest.config.ts` (le
parseur CSS de jsdom ignore le contenu, donc ça ne devrait pas casser).

### 7.6 Docker redeploy (rappel mémoire)

D'après la mémoire utilisateur (`project_docker_redeploy.md`), les
changements doivent passer par :

```sh
cd /home/ubuntu/projets/swarm-os
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
```

…avant d'être visibles dans l'image runtime. À effectuer après la phase
locale validée, pour qu'un éventuel test d'acceptation sur l'env Docker
voie bien le nouveau CSS.

---

## 8. Done criteria de l'étape 1

- [ ] `prototypes/v2/Swarm OS v2.html` extrait et présent.
- [ ] `packages/web/src/styles/desktop-theme.css` créé (≈1020 lignes,
      contient toutes les variables, classes, keyframes énumérées au §3.4).
- [ ] `packages/web/src/main.tsx` importe `./styles/desktop-theme.css`
      après `./index.css`.
- [ ] `packages/web/index.html` charge Geist + Geist Mono via 3 `<link>`
      Google Fonts.
- [ ] `pnpm run build` passe ; l'asset CSS de `dist/` contient
      `:root { --bg: #0d0a08;`, `.team-pill`, `.pr-tab`, `.modal`, etc.
- [ ] `pnpm run dev` : `getComputedStyle(document.body)` rend
      `--bg = #0d0a08` et `font-family contains "Geist"`.
- [ ] Vitest reste vert (aucune régression).
- [ ] Aucun composant React créé ni modifié — l'étape est strictement
      "design system primitives".

---

## 9. Références croisées

- Doc parent : `/home/ubuntu/projets/swarm-os/docs/ui-redesign-desktop.md`
  - §1.2 — Système de design (à porter)
  - §5.1 step 1 — Phase A.1
  - §5.3 — Fichiers à porter du prototype v2 (mention `Swarm OS v2.html`
    `<style>` → `src/styles/desktop-theme.css`)
  - §5.4 risque #1 — Tailwind 4 vs CSS custom
- Source de vérité visuelle :
  `/home/ubuntu/projets/swarm-os/prototypes/v2/Swarm OS v2.html` (à
  extraire ; aujourd'hui dans
  `/home/ubuntu/projets/swarm-os/prototypes/swarm-os-prototypes_v2.zip`)
- Cibles modifiées :
  - `/home/ubuntu/projets/swarm-os/packages/web/src/styles/desktop-theme.css` (nouveau)
  - `/home/ubuntu/projets/swarm-os/packages/web/src/main.tsx`
  - `/home/ubuntu/projets/swarm-os/packages/web/index.html`
- Fichiers de contexte (lecture seule pour l'étape 1) :
  - `/home/ubuntu/projets/swarm-os/packages/web/src/index.css`
  - `/home/ubuntu/projets/swarm-os/packages/web/vite.config.ts`
  - `/home/ubuntu/projets/swarm-os/packages/web/package.json`
