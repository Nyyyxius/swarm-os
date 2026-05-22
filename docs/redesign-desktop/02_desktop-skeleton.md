# Step 2 (Phase A.2) — Squelette des composants `src/components/desktop/`

> Lié au plan global `docs/ui-redesign-desktop.md` §5.1 step 2 + §5.3 mapping.
> Pré-requis : Step 1 (Phase A.1) doit avoir été exécuté avant — i.e. le
> fichier `src/styles/desktop-theme.css` doit être importé depuis
> `src/main.tsx` et exposer les variables CSS (`--amber`, `--amber-soft`,
> `--amber-deep`, `--bg`, `--bg-2`, `--panel-solid`, etc.) ainsi que les
> classes utilitaires (`.topbar`, `.team-pill`, `.pr-tab`, `.pr-cfgline`,
> `.pr-cwd`, `.console-line`, `.node-inbox-bg`, `.node-ring-pulse`,
> `.center-hub`, `.toast`, `.modal`, `.drawer`, `.cfg-section`, `.cfg-kv`,
> `.cfg-pre`, `.events-pip`, `.canvas-wrap`, etc.). Les composants ci-dessous
> consomment ces classes par `className`.

## 1. Objectif

Créer la structure de fichiers TSX dans `packages/web/src/components/desktop/`
correspondant aux composants visuels du prototype v2 (`prototypes/v2/`), avec
toutes les interfaces de props typées, les imports nécessaires et un rendu
JSX minimal qui compile (`tsc --noEmit`) et passe `pnpm build`. **Aucune
donnée n'est branchée à ce stade** — les hooks (`useOrchestrators`,
`useEvents`, etc.) seront câblés en Step 4-8 (Phase B). On accepte que les
composants reçoivent des props pour l'instant non utilisées (TS strict
oblige : on les préfixe `_` ou on les marque comme `// TODO Step N`).

---

## 2. Liste exhaustive des fichiers à créer

Tous sous `packages/web/src/components/desktop/` (création du dossier
incluse). 14 fichiers de composants + 1 fichier d'icônes + 1 fichier
d'utilitaire layout + 1 fichier d'utilitaire courbe = **17 fichiers**,
plus 2 helpers à déplacer dans `src/lib/` (`format.ts` + `roleShape.ts`),
total **19 fichiers nouveaux**.

| # | Fichier | Source v2 | Rôle | Export |
|---|---|---|---|---|
| 1 | `desktop/icons.tsx` | `v2/icons.jsx` | Lib SVG inline partagée (plus, cog, template, pencil, stop, start, pause, kill, reload, fork, send, bcast, back, copy, link, inbox, trash) | named `ICON` |
| 2 | `desktop/curveBetween.ts` | `v2/map.jsx:140-151` | Helper SVG path d'une courbe quadratique entre deux points | named `curveBetween` |
| 3 | `desktop/layoutTeams.ts` | `v2/map.jsx:9-33` | Calcul des positions x/y des leads (orbite) et workers (arc autour du lead) à partir de la liste `Team[]` | named `layoutTeams` + constantes `VBW/VBH/CENTER/LEAD_RADIUS/WORKER_RADIUS/WORKER_SPREAD` + type `NodePosition` |
| 4 | `desktop/NodeShape.tsx` | `v2/map.jsx:35-55` | Rendu SVG d'une forme (diamond/diamondS/triangle/square/dot/halfmoon/circle) selon `role` | default `NodeShape` |
| 5 | `desktop/Node.tsx` | `v2/map.jsx:79-138` | `<g>` SVG d'un node : glow + ring + shape + status-dot + inbox badge + label + role | default `Node` |
| 6 | `desktop/MapView.tsx` | `v2/map.jsx:153-449` | Canvas SVG avec pan/zoom/pinch, hub central clickable, edges, pulses, nodes, tooltip, HUD | default `MapView` |
| 7 | `desktop/Sparkline.tsx` | `v2/panels.jsx:15-34` | Mini-graphe SVG (path line + area) pour une série de nombres | default `Sparkline` |
| 8 | `desktop/BigGraph.tsx` | `v2/panels.jsx:36-65` | Gros graphe SVG (gradient amber + grid lines + dot final) pour l'historique MESSAGE FLOW | default `BigGraph` |
| 9 | `desktop/LeftPanel.tsx` | `v2/panels.jsx:67-154` | Panneau gauche 320px : MESSAGE FLOW + PER-TEAM TRAFFIC + RECENTLY ENDED + BUS HEALTH | default `LeftPanel` |
| 10 | `desktop/ConfigTab.tsx` | `v2/panels.jsx:472-535` | Tab CONFIG du RightPanel : RUNTIME / LEAD PROMPT / LEAD PREAMBLE / WORKER PREAMBLE / CONNECTORS | default `ConfigTab` |
| 11 | `desktop/Composer.tsx` | `v2/panels.jsx:407-470` | Composer du RightPanel : toolbar (PTY/INBOX + AGENT/TEAM), textarea, helper, send button | default `Composer` |
| 12 | `desktop/ConfirmModal.tsx` | `v2/panels.jsx:537-557` | Modale de confirmation (KILL/STOP) avec backdrop + body + CANCEL/CONFIRM | default `ConfirmModal` |
| 13 | `desktop/RightPanel.tsx` | `v2/panels.jsx:158-405` | Panneau droit 380px : head + cfgline + cwd + stats + meta + 5 actions + 3 tabs (CONSOLE/MESSAGES/CONFIG) + composer | default `RightPanel` |
| 14 | `desktop/TopBar.tsx` | `v2/app.jsx:43-130` | Header 56px : brand + sub-line live + health-strip team-pills + NEW/ROLES/cog/clock | default `TopBar` |
| 15 | `desktop/Toasts.tsx` | `v2/toasts.jsx:9-45` | Stack bas-droite SESSION WAITING (max 5 visible + `+N older`) | default `Toasts` |
| 16 | `desktop/EventsPip.tsx` | `v2/toasts.jsx:48-55` | Petit pip `events :: live` / `reconnecting…` quand aucun toast | default `EventsPip` |
| 17 | `desktop/DesktopShell.tsx` | `v2/app.jsx:133-693` (uniquement orchestration, sans logique mock) | Grid 56px / 320px-1fr-380px ; instancie TopBar + LeftPanel + MapView + RightPanel + zone overlays + Toasts/EventsPip | default `DesktopShell` |

À créer dans `packages/web/src/lib/` (helpers partagés) :

| # | Fichier | Source v2 | Rôle |
|---|---|---|---|
| 18 | `lib/format.ts` | `v2/data.jsx:459-503` | Helpers `formatUptime`, `formatRelative`, `formatClockShort`, `statusLabel`, `statusChipClass`, `pad` |
| 19 | `lib/roleShape.ts` | `v2/data.jsx:117-127` | `ROLE_SHAPE: Record<string, Shape>` + type `Shape` |

---

## 3. Détail composant par composant

### 3.1 `lib/roleShape.ts`

**Source v2** : `prototypes/v2/data.jsx:117-127` (objet `ROLE_SHAPE`).

```ts
// packages/web/src/lib/roleShape.ts
// Mapping figé role → forme SVG du node sur la MapView. Cf.
// docs/ui-redesign-desktop.md §1.3.

export type Shape =
  | 'diamond'
  | 'diamondS'
  | 'triangle'
  | 'square'
  | 'dot'
  | 'halfmoon'
  | 'circle';

export const ROLE_SHAPE: Record<string, Shape> = {
  ORCHESTRATOR: 'diamond',
  RESEARCHER: 'circle',
  BUILDER: 'triangle',
  CRITIC: 'diamondS',
  ANALYST: 'halfmoon',
  MEMORY: 'dot',
  TOOLS: 'square',
};

export function shapeForRole(role: string): Shape {
  return ROLE_SHAPE[role] ?? 'circle';
}
```

---

### 3.2 `lib/format.ts`

**Source v2** : `prototypes/v2/data.jsx:459-503` (helpers + statusLabel /
statusChipClass).

```ts
// packages/web/src/lib/format.ts
// Helpers de formatage portés du prototype v2.

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/**
 * Format "HH:MM:SS" d'un uptime depuis un timestamp ms ou ISO string.
 * Renvoie "—" si invalide.
 */
export function formatUptime(startedAt: number | string | null | undefined): string {
  if (startedAt == null) return '—';
  const ts = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  if (!Number.isFinite(ts)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago". */
export function formatRelative(ts: number | string): string {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return '—';
  const dt = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (dt < 60) return `${dt}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

/** "HH:MM" — clock court (pour pr-meta started). */
export function formatClockShort(ts: number | string): string {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "HH:MM:SS" — clock long (pour TopBar). */
export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Map un status (SessionStatus côté backend + variantes mock du proto) vers
 * un label uppercase. Les buckets serveur (S3 `mapSessionStatusToVisual`)
 * restent la source de vérité ; cette fonction est utilisée par les chips
 * et tooltips qui veulent le texte brut.
 */
export function statusLabel(s: string): string {
  const table: Record<string, string> = {
    running: 'RUNNING',
    waiting: 'WAITING',
    warn: 'DEGRADED',
    idle: 'IDLE',
    starting: 'STARTING',
    paused: 'PAUSED',
    stopped: 'STOPPED',
    exited: 'EXITED',
    killed: 'KILLED',
    interrupted: 'INTERRUPTED',
    failed: 'FAILED',
  };
  return table[s] ?? s.toUpperCase();
}

/**
 * Map un status vers la classe CSS de chip (warm-black theme).
 * Buckets : ok | warn | bad | stopped | waiting | starting.
 */
export type ChipClass = 'ok' | 'warn' | 'bad' | 'stopped' | 'waiting' | 'starting';

export function statusChipClass(s: string): ChipClass {
  if (s === 'stopped' || s === 'exited' || s === 'killed' || s === 'interrupted') return 'stopped';
  if (s === 'failed') return 'bad';
  if (s === 'warn') return 'warn';
  if (s === 'waiting') return 'waiting';
  if (s === 'starting') return 'starting';
  return 'ok';
}
```

---

### 3.3 `desktop/icons.tsx`

**Source v2** : `prototypes/v2/icons.jsx` (intégrale, 17 icônes).

```tsx
// packages/web/src/components/desktop/icons.tsx
// Lib d'icônes SVG inline (currentColor). Cf. v2/icons.jsx.

import type { ReactElement } from 'react';

export const ICON: Record<string, ReactElement> = {
  send:     <svg viewBox="0 0 24 24"><path d="M3 12 L21 4 L17 21 L11 13 Z"/><path d="M11 13 L3 12"/></svg>,
  stop:     <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>,
  start:    <svg viewBox="0 0 24 24"><path d="M6 4 L20 12 L6 20 Z"/></svg>,
  pause:    <svg viewBox="0 0 24 24"><rect x="7" y="5" width="3" height="14"/><rect x="14" y="5" width="3" height="14"/></svg>,
  kill:     <svg viewBox="0 0 24 24"><path d="M5 5 L19 19"/><path d="M19 5 L5 19"/></svg>,
  reload:   <svg viewBox="0 0 24 24"><path d="M3 12 a9 9 0 0 1 15-6.7 L21 8"/><path d="M21 3 V8 H16"/><path d="M21 12 a9 9 0 0 1 -15 6.7 L3 16"/><path d="M3 21 V16 H8"/></svg>,
  fork:     <svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7 V12 a3 3 0 0 0 3 3 H15 a3 3 0 0 0 3-3 V7"/><path d="M12 15 V17"/></svg>,
  plus:     <svg viewBox="0 0 24 24"><path d="M12 5 V19"/><path d="M5 12 H19"/></svg>,
  cog:      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.5 4.5 L6.5 6.5 M17.5 17.5 L19.5 19.5 M4.5 19.5 L6.5 17.5 M17.5 6.5 L19.5 4.5"/></svg>,
  template: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5"/><rect x="3" y="11" width="18" height="5"/><rect x="3" y="18" width="18" height="3"/></svg>,
  pencil:   <svg viewBox="0 0 24 24"><path d="M4 20 L8 19 L20 7 L17 4 L5 16 Z"/><path d="M14 7 L17 10"/></svg>,
  trash:    <svg viewBox="0 0 24 24"><path d="M5 7 H19"/><path d="M9 7 V4 H15 V7"/><path d="M7 7 L8 20 H16 L17 7"/></svg>,
  inbox:    <svg viewBox="0 0 24 24"><path d="M3 13 L7 5 H17 L21 13 V20 H3 Z"/><path d="M3 13 H8 L10 16 H14 L16 13 H21"/></svg>,
  bcast:    <svg viewBox="0 0 24 24"><path d="M12 4 V20"/><path d="M5 9 a7 7 0 0 0 0 6"/><path d="M3 7 a10 10 0 0 0 0 10"/><path d="M19 9 a7 7 0 0 1 0 6"/><path d="M21 7 a10 10 0 0 1 0 10"/></svg>,
  back:     <svg viewBox="0 0 24 24"><path d="M14 6 L8 12 L14 18"/></svg>,
  copy:     <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12"/><path d="M16 8 V4 H4 V16 H8"/></svg>,
  link:     <svg viewBox="0 0 24 24"><path d="M10 14 a4 4 0 0 0 5.66 0 L19 11 a4 4 0 0 0 -5.66 -5.66 L12 7"/><path d="M14 10 a4 4 0 0 0 -5.66 0 L5 13 a4 4 0 0 0 5.66 5.66 L12 17"/></svg>,
};

export type IconName = keyof typeof ICON;
```

> NB : la `key="…"` n'est pas nécessaire ici (pas de `.map`), JSX inline.
> Tous les `<svg>` héritent de `currentColor` via le CSS du Step 1.

---

### 3.4 `desktop/curveBetween.ts`

**Source v2** : `prototypes/v2/map.jsx:140-151`.

```ts
// packages/web/src/components/desktop/curveBetween.ts

export interface Point {
  x: number;
  y: number;
}

/**
 * Renvoie un attribut SVG `d` pour une courbe quadratique de Bézier reliant
 * `a` à `b`, avec contrôle perpendiculaire à `curve` × longueur.
 *
 * Utilisé pour les edges (lead-link / team / intra) et les `offsetPath` des
 * pulses sur la MapView.
 */
export function curveBetween(a: Point, b: Point, curve = 0.16): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = -dy;
  const ny = dx;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  const cx = mx + (nx / len) * curve * Math.sqrt(dx * dx + dy * dy);
  const cy = my + (ny / len) * curve * Math.sqrt(dx * dx + dy * dy);
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}
```

---

### 3.5 `desktop/layoutTeams.ts`

**Source v2** : `prototypes/v2/map.jsx:1-33` (constantes + `layoutTeams`).

**Note importante** : le proto consomme une structure `Team` (`v2/data.jsx`)
avec `team.lead`, `team.workers`, `team.angle`. Au Step 6, on remplacera ces
mocks par `OrchestratorView` ; pour ce squelette on définit un type local
intermédiaire `MapTeam` qui sera adapté plus tard. Pour l'angle, le proto le
stocke en dur sur chaque team — en Step 6 on le calculera côté shell
(`angle = (i / N) * 2π - π/2`).

```ts
// packages/web/src/components/desktop/layoutTeams.ts

export const VBW = 1200;
export const VBH = 900;
export const CENTER: { x: number; y: number } = { x: VBW / 2, y: VBH / 2 };
export const LEAD_RADIUS = 320;
export const WORKER_RADIUS = 150;
export const WORKER_SPREAD = 1.55;

/** Forme minimale exigée par `layoutTeams`. Sera satisfaite plus tard par un
 * adapter `OrchestratorView` → `MapTeam` (Step 6). */
export interface MapAgent {
  id: string;
}

export interface MapTeam {
  id: string;
  angle: number;
  lead: MapAgent;
  workers: MapAgent[];
}

export interface NodePosition {
  x: number;
  y: number;
  teamId: string;
  leadId?: string;
}

export function layoutTeams(teams: readonly MapTeam[]): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};
  teams.forEach((team) => {
    const lx = CENTER.x + Math.cos(team.angle) * LEAD_RADIUS;
    const ly = CENTER.y + Math.sin(team.angle) * LEAD_RADIUS;
    positions[team.lead.id] = { x: lx, y: ly, teamId: team.id };
    const n = team.workers.length;
    team.workers.forEach((w, i) => {
      const outward = team.angle;
      const offset = n === 1 ? 0 : (i / (n - 1) - 0.5) * WORKER_SPREAD;
      const a = outward + offset;
      const wx = lx + Math.cos(a) * WORKER_RADIUS;
      const wy = ly + Math.sin(a) * WORKER_RADIUS;
      positions[w.id] = { x: wx, y: wy, teamId: team.id, leadId: team.lead.id };
    });
  });
  return positions;
}
```

---

### 3.6 `desktop/NodeShape.tsx`

**Source v2** : `prototypes/v2/map.jsx:35-55`.

```tsx
// packages/web/src/components/desktop/NodeShape.tsx
import type { Shape } from '../../lib/roleShape';

interface Props {
  shape: Shape;
  r: number;
  stopped?: boolean;
}

export default function NodeShape({ shape, r, stopped = false }: Props) {
  const fill = stopped ? '#3a3128' : '#f3e9dc';
  const s = r * 0.55;
  if (shape === 'diamond') {
    return (
      <rect className="node-shape" x={-s / 1.4} y={-s / 1.4}
        width={s * 1.4} height={s * 1.4} fill={fill} transform="rotate(45)" />
    );
  }
  if (shape === 'diamondS') {
    return (
      <rect className="node-shape" x={-s / 1.8} y={-s / 1.8}
        width={s * 1.1} height={s * 1.1} fill="none" stroke={fill}
        strokeWidth="1" transform="rotate(45)" />
    );
  }
  if (shape === 'triangle') {
    const p = s * 0.95;
    return (
      <polygon className="node-shape"
        points={`0,${-p} ${p * 0.866},${p * 0.5} ${-p * 0.866},${p * 0.5}`}
        fill={fill} />
    );
  }
  if (shape === 'square') {
    return (
      <rect className="node-shape" x={-s * 0.7} y={-s * 0.7}
        width={s * 1.4} height={s * 1.4} fill={fill} />
    );
  }
  if (shape === 'dot') {
    return <circle className="node-shape" r={s * 0.55} fill={fill} />;
  }
  if (shape === 'halfmoon') {
    return (
      <g>
        <circle className="node-shape" r={s * 0.8} fill="none"
          stroke={fill} strokeWidth="1" />
        <path className="node-shape"
          d={`M 0,${-s * 0.8} A ${s * 0.8} ${s * 0.8} 0 0 1 0,${s * 0.8} Z`}
          fill={fill} />
      </g>
    );
  }
  // fallback "circle"
  return <circle r={s * 0.6} fill={fill} />;
}
```

---

### 3.7 `desktop/Node.tsx`

**Source v2** : `prototypes/v2/map.jsx:79-138`.

Les fonctions `statusDotColor` et `ringClass` (lignes 57-77 de `map.jsx`) sont
incluses ici car internes au Node — pas besoin de les exporter.

```tsx
// packages/web/src/components/desktop/Node.tsx
import NodeShape from './NodeShape';
import type { Shape } from '../../lib/roleShape';
import type { NodePosition } from './layoutTeams';

/** Forme minimale d'un agent pour rendre un Node — sera satisfaite par
 * SessionView (+ shape dérivé via `shapeForRole(session.role)`). */
export interface NodeAgent {
  id: string;
  name: string;
  role: string;
  shape: Shape;
  status: string;
  inbox?: number;
}

interface Props {
  agent: NodeAgent;
  pos: NodePosition;
  isLead?: boolean;
  selected?: boolean;
  spawning?: boolean;
  onClick: (agent: NodeAgent) => void;
  onHover?: (agent: NodeAgent | null, pos: NodePosition | null) => void;
}

function statusDotColor(status: string): string {
  if (status === 'running')  return '#6ec48a';
  if (status === 'warn')     return '#e8b04a';
  if (status === 'waiting')  return '#ffb060';
  if (status === 'idle')     return '#b6a48b';
  if (status === 'starting') return '#d98a3a';
  if (status === 'failed')   return '#e0654a';
  if (
    status === 'stopped' || status === 'exited' ||
    status === 'killed'  || status === 'interrupted'
  ) return '#5a4d3f';
  return '#b6a48b';
}

function ringClass(status: string, isLead: boolean, selected: boolean): string {
  let cls = 'node-ring';
  if (isLead) cls += ' lead';
  if (selected) cls += ' selected';
  if (status === 'stopped' || status === 'exited' || status === 'killed') cls += ' stopped';
  if (status === 'failed') cls += ' failed';
  if (status === 'starting') cls += ' starting';
  if (status === 'interrupted') cls += ' interrupted';
  return cls;
}

export default function Node({
  agent, pos, isLead = false, selected = false, spawning = false,
  onClick, onHover,
}: Props) {
  const r = isLead ? 26 : 20;
  const status = agent.status;
  const stopped =
    status === 'stopped' || status === 'exited' ||
    status === 'killed'  || status === 'interrupted';
  const waiting = status === 'waiting';
  const failed = status === 'failed';
  const inboxCount = agent.inbox ?? 0;

  return (
    <g
      className={`node ${spawning ? 'spawning' : ''}`}
      transform={`translate(${pos.x}, ${pos.y})`}
      onClick={(e) => { e.stopPropagation(); onClick(agent); }}
      onMouseEnter={() => onHover?.(agent, pos)}
      onMouseLeave={() => onHover?.(null, null)}
    >
      <circle
        className={`node-glow ${isLead ? 'lead' : ''} ${stopped ? 'stopped' : ''} ${waiting ? 'waiting' : ''} ${failed ? 'failed' : ''}`}
        r={r + 8}
      />
      {waiting && <circle className="node-ring-pulse" r={r + 5} />}
      <circle className={ringClass(status, isLead, selected)} r={r} />
      <NodeShape shape={agent.shape} r={r} stopped={stopped} />
      <circle
        className="node-status-dot"
        cx={r * 0.78} cy={-r * 0.78} r={2.6}
        fill={statusDotColor(status)}
      />
      {inboxCount > 0 && (
        <g>
          <circle className="node-inbox-bg" cx={-r * 0.82} cy={-r * 0.82} r={6} />
          <text className="node-inbox-txt" x={-r * 0.82} y={-r * 0.82 + 2.6}>
            {inboxCount > 9 ? '9+' : inboxCount}
          </text>
        </g>
      )}
      <text className="node-label" y={r + 16}>{agent.name}</text>
      <text className="node-role" y={r + 28}>{agent.role}</text>
      {status === 'interrupted' && (
        <text className="node-svr-restart" y={r + 40}>·· SVR-RESTART ··</text>
      )}
      {status === 'starting' && (
        <text className="node-svr-restart" y={r + 40}>·· STARTING ··</text>
      )}
    </g>
  );
}
```

---

### 3.8 `desktop/MapView.tsx`

**Source v2** : `prototypes/v2/map.jsx:153-449` (tout le `MapView` + le
helper `tooltipStyle`).

Squelette pour Step 2 : on reçoit `teams: MapTeam[]` et on rend la carte
SVG. Les pulses sont passées en props (vide tableau pour l'instant). La
logique pan/zoom/pinch est portée telle quelle car self-contained.

```tsx
// packages/web/src/components/desktop/MapView.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CENTER, VBW, VBH,
  layoutTeams,
  type MapTeam, type NodePosition,
} from './layoutTeams';
import Node, { type NodeAgent } from './Node';
import { curveBetween } from './curveBetween';
import { statusLabel } from '../../lib/format';

/** Forme attendue d'une équipe complète pour le MapView. Sur-ensemble de
 *  MapTeam : on ajoute `status` + nodes complets (lead + workers typés
 *  `NodeAgent`). */
export interface MapViewTeam extends MapTeam {
  status: string;
  lead: NodeAgent;
  workers: NodeAgent[];
}

/** Type d'un pulse animé sur la carte. */
export interface MapPulse {
  id: number | string;
  from: string;            // session id OR '__center__'
  to: string;              // session id OR '__center__'
  kind: 'intra' | 'cross' | 'human' | 'broadcast';
}

interface Props {
  teams: readonly MapViewTeam[];
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  onBroadcast?: () => void;
  pulses?: readonly MapPulse[];
  showIntra?: boolean;
  spawningIds?: ReadonlySet<string>;
}

interface Tip {
  x: number;
  y: number;
  name: string;
  role: string;
  team?: string;
  status: string;
  inbox?: number;
}

interface ViewBox { x: number; y: number; w: number; h: number; }

export default function MapView({
  teams, selectedId, onSelect, onBroadcast,
  pulses = [], showIntra = true, spawningIds,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [vb, setVb] = useState<ViewBox>({ x: 0, y: 0, w: VBW, h: VBH });
  const [panning, setPanning] = useState(false);

  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    panStart: { vbX: number; vbY: number; px: number; py: number } | null;
    pinchStart: { dist: number; midSvg: { x: number; y: number }; vb: ViewBox } | null;
    didDrag: boolean;
  }>({ pointers: new Map(), panStart: null, pinchStart: null, didDrag: false });

  const clientToSvg = useCallback((cx: number, cy: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const drawW = vb.w * scale;
    const drawH = vb.h * scale;
    const offX = (rect.width - drawW) / 2;
    const offY = (rect.height - drawH) / 2;
    return {
      x: vb.x + (cx - rect.left - offX) / scale,
      y: vb.y + (cy - rect.top - offY) / scale,
    };
  }, [vb]);

  const zoomAt = useCallback((focusSvg: { x: number; y: number }, factor: number) => {
    setVb((v) => {
      const newW = Math.max(VBW * 0.25, Math.min(VBW * 4, v.w * factor));
      const newH = Math.max(VBH * 0.25, Math.min(VBH * 4, v.h * factor));
      const k = newW / v.w;
      const newX = focusSvg.x - (focusSvg.x - v.x) * k;
      const newY = focusSvg.y - (focusSvg.y - v.y) * k;
      return { x: newX, y: newY, w: newW, h: newH };
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const focus = clientToSvg(e.clientX, e.clientY);
      const factor = Math.exp(e.deltaY * 0.0018);
      zoomAt(focus, factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clientToSvg, zoomAt]);

  // Pointer handlers : port direct du v2 — voir map.jsx:205-258.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as Element).closest('.canvas-zoom')) return;
    wrapRef.current?.setPointerCapture(e.pointerId);
    const g = gestureRef.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.didDrag = false;
    if (g.pointers.size === 1) {
      g.panStart = { vbX: vb.x, vbY: vb.y, px: e.clientX, py: e.clientY };
      g.pinchStart = null;
    } else if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midClient = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.pinchStart = { dist, midSvg: clientToSvg(midClient.x, midClient.y), vb: { ...vb } };
      g.panStart = null;
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1 && g.panStart) {
      const dx = e.clientX - g.panStart.px;
      const dy = e.clientY - g.panStart.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        g.didDrag = true;
        if (!panning) setPanning(true);
      }
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
      const panStart = g.panStart;
      setVb((v) => ({ ...v, x: panStart.vbX - dx / scale, y: panStart.vbY - dy / scale }));
    } else if (g.pointers.size === 2 && g.pinchStart) {
      const [a, b] = [...g.pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = g.pinchStart.dist / Math.max(1, dist);
      g.didDrag = true;
      const start = g.pinchStart;
      const newW = Math.max(VBW * 0.25, Math.min(VBW * 4, start.vb.w * factor));
      const newH = Math.max(VBH * 0.25, Math.min(VBH * 4, start.vb.h * factor));
      const k = newW / start.vb.w;
      const newX = start.midSvg.x - (start.midSvg.x - start.vb.x) * k;
      const newY = start.midSvg.y - (start.midSvg.y - start.vb.y) * k;
      setVb({ x: newX, y: newY, w: newW, h: newH });
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.pinchStart = null;
    if (g.pointers.size === 0) g.panStart = null;
    setPanning(false);
  }

  function handleCanvasClick() {
    if (gestureRef.current.didDrag) { gestureRef.current.didDrag = false; return; }
    onSelect(null);
  }

  const positions = useMemo(() => layoutTeams(teams), [teams]);

  function handleHover(agent: NodeAgent | null, pos: NodePosition | null) {
    if (!agent || !pos) { setTip(null); return; }
    const teamId = positions[agent.id]?.teamId;
    const team = teams.find((t) => t.id === teamId);
    setTip({
      x: pos.x, y: pos.y,
      name: agent.name, role: agent.role, team: team?.id,
      status: statusLabel(agent.status), inbox: agent.inbox,
    });
  }

  // Build edges arrays
  const leadLinks: Array<{ a: typeof CENTER; b: NodePosition; teamId: string; status: string }> = [];
  const teamEdges: Array<{ a: NodePosition; b: NodePosition; teamId: string; status: string }> = [];
  const intraEdges: Array<{ a: NodePosition; b: NodePosition; teamId: string; status: string }> = [];
  teams.forEach((team) => {
    const leadPos = positions[team.lead.id];
    if (!leadPos) return;
    leadLinks.push({ a: CENTER, b: leadPos, teamId: team.id, status: team.status });
    team.workers.forEach((w, i) => {
      const wPos = positions[w.id];
      if (!wPos) return;
      teamEdges.push({ a: leadPos, b: wPos, teamId: team.id, status: team.status });
      if (i < team.workers.length - 1) {
        const next = team.workers[i + 1];
        const nPos = next ? positions[next.id] : undefined;
        if (nPos) intraEdges.push({ a: wPos, b: nPos, teamId: team.id, status: team.status });
      }
    });
  });

  const selectedTeam = (() => {
    for (const t of teams) {
      if (t.lead.id === selectedId) return t;
      if (t.workers.some((w) => w.id === selectedId)) return t;
    }
    return null;
  })();
  const selectedTeamId = selectedTeam?.id;

  return (
    <div
      className={`canvas-wrap ${panning ? 'panning' : ''}`}
      ref={wrapRef}
      onClick={handleCanvasClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="grid-bg" />
      <svg
        className="canvas-svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="hub-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%"  style={{ stopColor: 'var(--amber)', stopOpacity: 0.35 }} />
            <stop offset="60%" style={{ stopColor: 'var(--amber)', stopOpacity: 0.08 }} />
            <stop offset="100%" style={{ stopColor: 'var(--amber)', stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        <circle cx={CENTER.x} cy={CENTER.y} r={420} fill="url(#hub-glow)" />

        <g>
          {leadLinks.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'exited' || e.status === 'killed';
            const cls = `edge lead-link ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''} ${selectedTeamId === e.teamId ? 'highlight' : ''}`;
            return <path key={`L${i}`} className={cls} d={curveBetween(e.a, e.b, 0.04)} />;
          })}
          {teamEdges.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'exited' || e.status === 'killed';
            const cls = `edge ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''} ${selectedTeamId === e.teamId ? 'highlight' : ''}`;
            return <path key={`T${i}`} className={cls} d={curveBetween(e.a, e.b, 0.10)} />;
          })}
          {showIntra && intraEdges.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'exited' || e.status === 'killed';
            const cls = `edge intra ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''}`;
            return <path key={`I${i}`} className={cls} d={curveBetween(e.a, e.b, 0.30)} />;
          })}
        </g>

        <g>
          {pulses.map((p) => {
            const from = p.from === '__center__' ? CENTER : positions[p.from];
            const to   = p.to   === '__center__' ? CENTER : positions[p.to];
            if (!from || !to) return null;
            const kind = p.kind;
            const cls = `pulse-dot ${kind === 'human' ? 'human' : kind === 'broadcast' ? 'broadcast' : ''}`;
            const style: CSSProperties = {
              offsetPath: `path("${curveBetween(from, to, 0.10)}")`,
              animation: `pulse-travel ${kind === 'broadcast' ? '1800ms' : '1400ms'} linear forwards`,
            };
            return (
              <circle key={p.id} className={cls}
                r={kind === 'broadcast' ? 2.8 : 2.4} style={style} />
            );
          })}
        </g>

        <g className="center-hub"
          onClick={(e) => { e.stopPropagation(); onBroadcast?.(); }}>
          <circle className="outer" cx={CENTER.x} cy={CENTER.y} r={42} />
          <circle className="outer" cx={CENTER.x} cy={CENTER.y} r={26} opacity="0.55" />
          <circle className="inner" cx={CENTER.x} cy={CENTER.y} r={10} />
          <text x={CENTER.x} y={CENTER.y + 62}>SWARM // BUS</text>
          <text x={CENTER.x} y={CENTER.y + 76} opacity="0.6">
            click :: broadcast to all leads
          </text>
        </g>

        <g>
          {teams.map((team) => {
            const leadPos = positions[team.lead.id];
            if (!leadPos) return null;
            return (
              <g key={team.id}>
                <Node
                  agent={team.lead}
                  pos={leadPos}
                  isLead
                  selected={selectedId === team.lead.id}
                  spawning={spawningIds?.has(team.lead.id)}
                  onClick={(a) => onSelect(a.id)}
                  onHover={handleHover}
                />
                {team.workers.map((w) => {
                  const wPos = positions[w.id];
                  if (!wPos) return null;
                  return (
                    <Node
                      key={w.id}
                      agent={w}
                      pos={wPos}
                      selected={selectedId === w.id}
                      spawning={spawningIds?.has(w.id)}
                      onClick={(a) => onSelect(a.id)}
                      onHover={handleHover}
                    />
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div className="canvas-tooltip" style={tooltipStyle(tip, wrapRef.current, vb)}>
          {tip.name}
          <div className="sub">
            {tip.team} :: {tip.role} :: {tip.status}
            {tip.inbox !== undefined && tip.inbox > 0 && (
              <span style={{ color: 'var(--amber)' }}> · INBOX {tip.inbox}</span>
            )}
          </div>
        </div>
      )}

      <div className="canvas-hud">
        <span><span className="k">FRAME</span> :: SWARM-MAP/02</span>
        <span><span className="k">ZOOM</span> :: {(VBW / vb.w).toFixed(2)}x</span>
        <span><span className="k">VIEW</span> :: ORBIT</span>
      </div>
      <div className="canvas-zoom">
        <button title="zoom out"
          onClick={(e) => { e.stopPropagation(); zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1.18); }}>−</button>
        <button title="reset"
          onClick={(e) => { e.stopPropagation(); setVb({ x: 0, y: 0, w: VBW, h: VBH }); }}>◇</button>
        <button title="zoom in"
          onClick={(e) => { e.stopPropagation(); zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1 / 1.18); }}>+</button>
      </div>
    </div>
  );
}

function tooltipStyle(tip: Tip, wrap: HTMLDivElement | null, vb: ViewBox): CSSProperties {
  if (!wrap) return { left: 0, top: 0 };
  const rect = wrap.getBoundingClientRect();
  const scaleX = rect.width / vb.w;
  const scaleY = rect.height / vb.h;
  const scale = Math.min(scaleX, scaleY);
  const drawW = vb.w * scale;
  const drawH = vb.h * scale;
  const offX = (rect.width - drawW) / 2;
  const offY = (rect.height - drawH) / 2;
  const left = offX + (tip.x - vb.x) * scale;
  const top  = offY + (tip.y - vb.y) * scale;
  return { left, top };
}
```

> **Notes TS strict** : `noUncheckedIndexedAccess` est activé. Le proto fait
> beaucoup d'accès directs `positions[id].x` qui deviennent `undefined`
> possibles — j'ai ajouté les `if (!pos) return null` correspondants. Toute
> destructuration `const [a, b] = [...map.values()]` est suivie d'un
> `if (!a || !b) return;`.

---

### 3.9 `desktop/Sparkline.tsx`

**Source v2** : `prototypes/v2/panels.jsx:15-34`.

```tsx
// packages/web/src/components/desktop/Sparkline.tsx

interface Props {
  values: readonly number[];
  color?: string;
  strokeOpacity?: number;
  fillOpacity?: number;
  height?: number;
}

export default function Sparkline({
  values, color = 'var(--amber)',
  strokeOpacity = 0.9, fillOpacity = 0.12, height = 16,
}: Props) {
  if (!values || values.length === 0) return null;
  const w = 100;
  const h = height;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map<[number, number]>((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={fillOpacity} />
      <path d={line} fill="none" stroke={color}
        strokeOpacity={strokeOpacity} strokeWidth="1"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
```

---

### 3.10 `desktop/BigGraph.tsx`

**Source v2** : `prototypes/v2/panels.jsx:36-65`.

```tsx
// packages/web/src/components/desktop/BigGraph.tsx

interface Props {
  data: readonly number[];
}

export default function BigGraph({ data }: Props) {
  const w = 100;
  const h = 100;
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const pts = data.map<[number, number]>((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / max) * h;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      style={{ width: '100%', height: '100%' }}>
      <defs>
        <linearGradient id="bg-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   style={{ stopColor: 'var(--amber)', stopOpacity: 0.4 }} />
          <stop offset="100%" style={{ stopColor: 'var(--amber)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((y) => (
        <line key={y} x1="0" y1={y} x2={w} y2={y}
          stroke="rgba(255, 200, 140, 0.06)" strokeWidth="0.4"
          vectorEffect="non-scaling-stroke" />
      ))}
      <path d={area} fill="url(#bg-fill)" />
      <path d={line} fill="none" style={{ stroke: 'var(--amber)' }}
        strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {last && (
        <circle cx={last[0]} cy={last[1]} r="1.5"
          style={{ fill: 'var(--amber)' }} />
      )}
    </svg>
  );
}
```

---

### 3.11 `desktop/LeftPanel.tsx`

**Source v2** : `prototypes/v2/panels.jsx:67-154`.

Squelette : on définit les interfaces des données qui seront branchées en
Step 5. Le composant rend les 4 sections (MESSAGE FLOW / PER-TEAM TRAFFIC /
RECENTLY ENDED / BUS HEALTH) avec les valeurs reçues en props.

```tsx
// packages/web/src/components/desktop/LeftPanel.tsx
import Sparkline from './Sparkline';
import BigGraph from './BigGraph';
import { formatRelative } from '../../lib/format';

/** Forme minimale d'une équipe pour la liste PER-TEAM TRAFFIC. */
export interface LeftPanelTeam {
  id: string;
  name: string;
  purpose: string;      // texte court (ex "RESEARCH", dérivable du role)
  msgCount: number;
  status: string;       // serveur OrchestratorStatus
  leadId: string;       // pour onSelectTeam
  workerCount: number;
  /** Spark per-team 8 pts (Step 5 = `/metrics/messages.per_orchestrator[id]`). */
  spark?: readonly number[];
}

/** Forme minimale d'un orchestrator terminé (RECENTLY ENDED). */
export interface LeftPanelEnded {
  id: string;
  name: string;
  purpose: string;
  endedAt: string;         // ISO
  reason: string;          // exited | killed | failed | server-restart
  agentCount: number;
}

interface Props {
  teams: readonly LeftPanelTeam[];
  ended: readonly LeftPanelEnded[];
  /** Historique 60 pts pour BigGraph (Step 5 = useGlobalMessageStats). */
  history: readonly number[];
  totalMessages: number;
  deltaPerMin: number;
  /** Bus health (Step 5 = `/metrics/bus`). Tous optionnels v1. */
  busHealth?: {
    latencyMs?: number;
    throughputPerSec?: number;
    queueDepth?: number;
    errRatePct?: number;
  };
  onSelectTeam: (sessionId: string) => void;
  onSelectEnded: (ended: LeftPanelEnded) => void;
}

export default function LeftPanel({
  teams, ended, history, totalMessages, deltaPerMin, busHealth,
  onSelectTeam, onSelectEnded,
}: Props) {
  return (
    <aside className="panel-left">
      <div className="pl-section">
        <h3>MESSAGE FLOW <span className="tag">// LIVE</span></h3>
        <div className="big-number">
          {totalMessages.toLocaleString()}
          <span className="delta">+{deltaPerMin}/min</span>
        </div>
        <div className="big-sub">TOTAL EXCHANGED · LAST 60 MIN</div>
        <div className="graph"><BigGraph data={history} /></div>
      </div>

      <div className="pl-section grow">
        <h3>PER-TEAM TRAFFIC <span className="count">{teams.length}</span></h3>
        <div className="team-list">
          {teams.map((t) => {
            const offline =
              t.status === 'stopped' || t.status === 'exited' ||
              t.status === 'killed' || t.status === 'failed';
            const sparkColor = offline ? '#5a4d3f' : 'var(--amber)';
            return (
              <div key={t.id} className="team-row" onClick={() => onSelectTeam(t.leadId)}>
                <div className="tr-name">
                  <span className="swatch" style={{ background: sparkColor }} />
                  {t.name}
                </div>
                <div className="tr-count">{t.msgCount.toLocaleString()}</div>
                <div className="tr-meta">
                  <span>{t.purpose}</span>
                  <span>·</span>
                  <span>{1 + t.workerCount} AGT</span>
                  <span>·</span>
                  <span style={{
                    color: offline
                      ? 'var(--text-mute)'
                      : t.status === 'starting'
                        ? 'var(--amber-soft)'
                        : 'var(--ok)',
                  }}>
                    {offline ? 'OFFLINE' : t.status === 'starting' ? 'STARTING' : 'ONLINE'}
                  </span>
                </div>
                <div className="tr-spark">
                  <Sparkline values={t.spark ?? []} color={sparkColor} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {ended.length > 0 && (
        <div className="pl-section cap">
          <h3>RECENTLY ENDED <span className="count">{ended.length}</span></h3>
          <div className="team-list">
            {ended.map((e) => (
              <div key={e.id} className="ended-row" onClick={() => onSelectEnded(e)}>
                <div className="ended-name">{e.name}</div>
                <div className="ended-time">{formatRelative(e.endedAt)}</div>
                <div className="ended-meta">
                  <span>{e.purpose}</span>
                  <span>·</span>
                  <span>{e.agentCount} AGT</span>
                  <span style={{ flex: 1 }} />
                  <span className={`badge-reason ${e.reason}`}>
                    {e.reason.toUpperCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pl-section">
        <h3>BUS HEALTH</h3>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          fontFamily: 'Geist Mono, monospace', fontSize: 10, letterSpacing: '0.10em',
        }}>
          <div>
            <div style={{ color: 'var(--text-mute)' }}>LATENCY</div>
            <div style={{ color: 'var(--text)', fontSize: 14, marginTop: 2 }}>
              {busHealth?.latencyMs ?? '—'}
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>ms</span>
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-mute)' }}>THROUGHPUT</div>
            <div style={{ color: 'var(--text)', fontSize: 14, marginTop: 2 }}>
              {busHealth?.throughputPerSec ?? '—'}
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>/s</span>
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-mute)' }}>QUEUE</div>
            <div style={{ color: 'var(--text)', fontSize: 14, marginTop: 2 }}>
              {busHealth?.queueDepth ?? '—'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-mute)' }}>ERR RATE</div>
            <div style={{ color: 'var(--warn)', fontSize: 14, marginTop: 2 }}>
              {busHealth?.errRatePct ?? '—'}
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>%</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
```

---

### 3.12 `desktop/ConfigTab.tsx`

**Source v2** : `prototypes/v2/panels.jsx:472-535`.

```tsx
// packages/web/src/components/desktop/ConfigTab.tsx
import { formatClockShort } from '../../lib/format';

/** Forme partielle d'un team/orch nécessaire pour la tab CONFIG. */
export interface ConfigTabTeam {
  model: string;
  effort: string;
  permissionMode: string;
  cwd: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  discordWebhook?: string | null;
}

/** Forme partielle d'un agent (session). */
export interface ConfigTabAgent {
  pid: number | null;
  startedAt: string | number | null;
  status: string;
  exitCode?: number | null;
}

interface Props {
  team: ConfigTabTeam;
  agent: ConfigTabAgent;
  isLead: boolean;
  onEdit: () => void;
}

export default function ConfigTab({ team, agent, isLead: _isLead, onEdit }: Props) {
  const stopped =
    agent.status === 'exited' || agent.status === 'killed' || agent.status === 'failed';

  return (
    <div className="cfg">
      <div className="cfg-section">
        <div className="cfg-h">
          <span>RUNTIME CONFIG</span>
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        </div>
        <div className="cfg-kv">
          <span className="k">MODEL</span><span className="v">{team.model}</span>
          <span className="k">EFFORT</span><span className="v">{team.effort}</span>
          <span className="k">PERMISSION</span>
          <span className="v" style={{
            color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'var(--text)',
          }}>
            {team.permissionMode}
            {team.permissionMode === 'bypassPermissions' && (
              <span style={{ marginLeft: 8, color: 'var(--text-mute)' }}>
                // danger: agent runs unattended
              </span>
            )}
          </span>
          <span className="k">CWD</span><span className="v">{team.cwd}</span>
          <span className="k">PID</span><span className="v">{agent.pid ?? '—'}</span>
          <span className="k">STARTED</span>
          <span className="v">
            {agent.startedAt ? formatClockShort(agent.startedAt) : '—'}
          </span>
          {stopped && (
            <>
              <span className="k">EXIT REASON</span>
              <span className="v" style={{
                color: agent.status === 'failed' ? 'var(--bad)' : 'var(--text-dim)',
              }}>
                {agent.status.toUpperCase()}
                {agent.exitCode != null ? ` :: code=${agent.exitCode}` : ''}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>LEAD PROMPT</span></div>
        <div className="cfg-pre">{team.leadPrompt ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>LEAD PREAMBLE</span></div>
        <div className="cfg-pre">{team.leadPreamble ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>WORKER PREAMBLE</span></div>
        <div className="cfg-pre">{team.workerPreamble ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>CONNECTORS</span></div>
        {team.discordWebhook ? (
          <div className="cfg-kv">
            <span className="k">DISCORD</span>
            <span className="v" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <span className="discord-chip" style={{
                fontSize: 8.5, padding: '1px 6px',
                border: '1px solid rgba(255,176,96,0.4)',
                color: 'var(--amber)', letterSpacing: '0.14em',
              }}>ENABLED</span>
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>
                {team.discordWebhook.length > 40
                  ? `${team.discordWebhook.slice(0, 38)}…`
                  : team.discordWebhook}
              </span>
            </span>
          </div>
        ) : (
          <div className="field-help">
            No connectors configured for this role. Edit the role to add a Discord webhook.
          </div>
        )}
      </div>
    </div>
  );
}
```

---

### 3.13 `desktop/Composer.tsx`

**Source v2** : `prototypes/v2/panels.jsx:407-470`.

```tsx
// packages/web/src/components/desktop/Composer.tsx
import type { KeyboardEvent } from 'react';

export type ComposerMode = 'pty' | 'mailbox';
export type ComposerAudience = 'agent' | 'team';

interface Props {
  selectedName: string;
  teamName: string;
  isLead: boolean;
  stopped: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  composerMode: ComposerMode;
  setComposerMode: (m: ComposerMode) => void;
  audience: ComposerAudience;
  setAudience: (a: ComposerAudience) => void;
}

export default function Composer({
  selectedName, teamName, isLead, stopped,
  draft, setDraft, onKey, onSend,
  composerMode, setComposerMode,
  audience, setAudience,
}: Props) {
  const helper = composerMode === 'mailbox'
    ? "MAILBOX :: queued in agent inbox · agent gets 'you have mail' signal on next idle"
    : 'PTY :: bytes written direct to terminal · unblocks an agent waiting on input';
  const teamHelper = audience === 'team'
    ? "Audience: every active session of this team will receive your message as from='human'."
    : 'Audience: this single session only.';

  return (
    <div className="composer">
      <div className="composer-toolbar">
        <div className="composer-toggles">
          <div className="seg" role="group" aria-label="composer mode">
            <button
              className={composerMode === 'pty' ? 'on' : ''}
              onClick={() => setComposerMode('pty')}
              title="write to PTY (raw keystrokes)"
            >→ PTY</button>
            <button
              className={composerMode === 'mailbox' ? 'on' : ''}
              onClick={() => setComposerMode('mailbox')}
              title="enqueue in mailbox (you-have-mail signal)"
            >→ INBOX</button>
          </div>
          {isLead && (
            <div className="seg" role="group" aria-label="audience">
              <button
                className={audience === 'agent' ? 'on' : ''}
                onClick={() => setAudience('agent')}
                title="single session"
              >AGENT</button>
              <button
                className={audience === 'team' ? 'on' : ''}
                onClick={() => setAudience('team')}
                title="broadcast to team"
              >TEAM</button>
            </div>
          )}
        </div>
        <span style={{ color: 'var(--text-mute)' }}>⌘+↵ to send</span>
      </div>

      <div className="composer-row">
        <span className={`send-target ${audience === 'team' ? 'broadcast' : ''}`}>
          {audience === 'team' ? 'BROADCAST' : 'CHANNEL'} <span className="arrow">→</span>{' '}
          {audience === 'team' ? `ALL OF ${teamName}` : selectedName}
          <span style={{ color: 'var(--text-mute)', marginLeft: 8 }}>
            :: {composerMode === 'pty' ? 'PTY' : 'MAILBOX'}
          </span>
        </span>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        className={composerMode === 'mailbox' ? 'mailbox' : ''}
        placeholder={
          stopped
            ? 'agent stopped — reactivate to send'
            : audience === 'team'
              ? 'compose broadcast directive to the entire team…'
              : composerMode === 'mailbox'
                ? 'compose mailbox message (agent will be notified on next idle)…'
                : 'compose PTY input (sent as raw keystrokes)…'
        }
        disabled={stopped}
      />
      <div className="composer-helper">
        {helper}
        {isLead && <div style={{ marginTop: 2 }}>{teamHelper}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="send-btn"
          disabled={stopped || !draft.trim()}
          onClick={onSend}
        >
          {audience === 'team' ? 'BROADCAST →' : 'SEND →'}
        </button>
      </div>
    </div>
  );
}
```

---

### 3.14 `desktop/ConfirmModal.tsx`

**Source v2** : `prototypes/v2/panels.jsx:537-557`.

```tsx
// packages/web/src/components/desktop/ConfirmModal.tsx

interface Props {
  label: string;
  body: string;
  cls?: 'danger' | 'primary' | 'ghost';
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmModal({
  label, body, cls = 'danger', onCancel, onConfirm,
}: Props) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{label}</div>
          <button className="pr-close" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body">
          <div className="field-help"
            style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
            {body}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>CANCEL</button>
          <button className={`btn ${cls}`} onClick={onConfirm}>CONFIRM</button>
        </div>
      </div>
    </div>
  );
}
```

---

### 3.15 `desktop/RightPanel.tsx`

**Source v2** : `prototypes/v2/panels.jsx:158-405`.

Le composant est dense : head + cfgline + cwd + stats + meta + 5 actions +
3 tabs + composer + ConfirmModal interne. On le découpe en sous-rendus
inline (pas de sous-composants — on garde fidèle au proto).

Pour le squelette : la tab CONSOLE rend une zone vide (xterm viendra plus
tard via `Terminal.tsx`) ; la tab MESSAGES rend une liste de `Bubble[]`
passée en props (Step 7 = `peekInbox` + `classifyBubble`).

```tsx
// packages/web/src/components/desktop/RightPanel.tsx
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ICON } from './icons';
import ConfigTab, { type ConfigTabTeam } from './ConfigTab';
import Composer, { type ComposerAudience, type ComposerMode } from './Composer';
import ConfirmModal from './ConfirmModal';
import {
  formatUptime, formatClockShort, formatRelative,
  statusChipClass, statusLabel,
} from '../../lib/format';

/** Action déclenchable depuis le panneau droit. */
export type AgentAction = 'stop' | 'start' | 'pause' | 'resume' | 'kill' | 'restart';

/** Forme partielle d'un agent (session) attendue par le RightPanel. */
export interface RightPanelAgent {
  id: string;
  name: string;
  role: string;
  status: string;          // SessionStatus
  pid: number | null;
  startedAt: string | number | null;
  lastActivityAt: string | number | null;
  /** load (0..1) — pour l'instant `undefined` ; affichera "—" via formatLoadPercent. */
  load?: number;
  /** Compteur log lines (xterm gérera plus tard). */
  logLines?: number;
  /** WRITER/READER pip — dérivé du hello frame WS dans Terminal.tsx. */
  writer?: boolean;
}

/** Forme partielle d'un team (orchestrator) attendue. */
export interface RightPanelTeam extends ConfigTabTeam {
  id: string;
  name: string;
  leadId: string;
  workerCount: number;
  discordWebhook?: string | null;
}

/** Bulle dans la tab MESSAGES. */
export interface MessageBubble {
  from: 'me' | 'them' | 'system' | 'other-team';
  who: string;             // libellé affiché
  text: string;
  ts?: string | number;
  via?: string;
}

export type RightPanelTab = 'console' | 'chat' | 'config';

interface Props {
  selected: RightPanelAgent | null;
  team: RightPanelTeam | null;
  isLead: boolean;
  /** Bulles classifiées (Step 7). */
  messages: readonly MessageBubble[];
  /** Tab active (lift to parent pour persister entre re-mounts). */
  activeTab: RightPanelTab;
  setActiveTab: (t: RightPanelTab) => void;
  onClose: () => void;
  onAction: (agentId: string, action: AgentAction) => void;
  onSend: (
    agentId: string,
    text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) => void;
  onSpawnWorker: (team: RightPanelTeam) => void;
  onEditConfig: (team: RightPanelTeam) => void;
}

export default function RightPanel({
  selected, team, isLead, messages,
  activeTab, setActiveTab,
  onClose, onAction, onSend, onSpawnWorker, onEditConfig,
}: Props) {
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [composerMode, setComposerMode] = useState<ComposerMode>('pty');
  const [audience, setAudience] = useState<ComposerAudience>('agent');
  const [confirm, setConfirm] = useState<
    { action: AgentAction; label: string; body: string; cls: 'danger' } | null
  >(null);

  useEffect(() => {
    setDraft('');
    setComposerMode('pty');
    setAudience('agent');
  }, [selected?.id]);

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [selected?.id, activeTab]);

  if (!selected || !team) {
    return (
      <aside className="panel-right closed">
        <div className="pr-empty"><div className="pr-empty-inner">no agent selected</div></div>
      </aside>
    );
  }

  const status = selected.status;
  const stopped =
    status === 'exited' || status === 'killed' || status === 'interrupted';
  const isFailed = status === 'failed';
  const writer = selected.writer !== false;
  const hasDiscord = !!team.discordWebhook;

  function doSend() {
    const txt = draft.trim();
    if (!txt || !selected) return;
    onSend(selected.id, txt, { mode: composerMode, audience });
    setDraft('');
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSend();
    }
  }

  function askConfirm(action: AgentAction) {
    if (!selected || !team) return;
    if (action === 'kill') {
      setConfirm({
        action,
        label: 'KILL SESSION',
        body: isLead
          ? `KILL ${selected.name} will terminate the whole ${team.name} team. All ${team.workerCount} workers will exit immediately. This cannot be undone.`
          : `KILL ${selected.name} will terminate this worker session. Lead will be notified.`,
        cls: 'danger',
      });
      return;
    }
    if (action === 'stop') {
      setConfirm({
        action,
        label: 'STOP SESSION',
        body: isLead
          ? `STOP ${selected.name} will gracefully shut down the entire ${team.name} team and its ${team.workerCount} workers.`
          : `STOP ${selected.name} will gracefully shut down this worker.`,
        cls: 'danger',
      });
      return;
    }
    onAction(selected.id, action);
  }

  return (
    <aside className="panel-right">
      <div className="pr-head">
        <div className="pr-top">
          <div>
            <div className="pr-id">
              {team.name} :: {isLead ? 'LEAD' : 'WORKER'} :: {selected.id.toUpperCase()}
            </div>
          </div>
          <button className="pr-close" onClick={onClose} title="close">×</button>
        </div>
        <div className="pr-name">
          {selected.name}
          {isLead && <span className="badge">LEAD</span>}
          <span style={{ flex: 1 }} />
          <span className={`chip ${statusChipClass(status)}`}>
            <span className={`dot ${statusChipClass(status)}`} />
            {statusLabel(status)}
          </span>
        </div>
        <div className="pr-role">
          <span>{selected.role}</span>
          {hasDiscord && (
            <span className="discord-chip" title={team.discordWebhook ?? ''}>◇ DISCORD</span>
          )}
        </div>

        <div className="pr-cfgline">
          <span className="lbl">M</span>
          <span>{team.model.replace('claude-', '')}</span>
          <span className="sep">·</span>
          <span className="lbl">E</span>
          <span>{team.effort}</span>
          <span className="sep">·</span>
          <span className="lbl">P</span>
          <span style={{
            color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'inherit',
          }}>{team.permissionMode}</span>
          <button className="edit"
            title="rotate model / effort / permission"
            onClick={() => onEditConfig(team)}>
            {ICON.pencil}
          </button>
        </div>

        <div className="pr-cwd" title="workspace-relative path">
          <span className="lbl">CWD ::</span> {team.cwd}
        </div>

        <div className="pr-stats">
          <div className="pr-stat">
            <div className="v">
              {stopped || selected.load === undefined
                ? '—'
                : `${Math.round(selected.load * 100)}%`}
            </div>
            <div className="k">LOAD</div>
          </div>
          <div className="pr-stat">
            <div className="v">{stopped ? '—' : formatUptime(selected.startedAt)}</div>
            <div className="k">UPTIME</div>
          </div>
          <div className="pr-stat">
            <div className="v">{(selected.logLines ?? 0).toLocaleString()}</div>
            <div className="k">LOG LINES</div>
          </div>
        </div>

        <div className="pr-meta">
          <span><b>pid</b>={selected.pid ?? '—'}</span>
          <span className="sep">·</span>
          <span>
            <b>started</b>={selected.startedAt ? formatClockShort(selected.startedAt) : '—'}
          </span>
          <span className="sep">·</span>
          <span>
            <b>last_activity</b>=
            {selected.lastActivityAt ? formatRelative(selected.lastActivityAt) : '—'}
          </span>
        </div>
      </div>

      <div className="pr-actions">
        {(stopped || isFailed) ? (
          <button className="pr-action go" onClick={() => onAction(selected.id, 'start')}>
            {ICON.start}<span>REACTIVATE</span>
          </button>
        ) : (
          <button className="pr-action danger" onClick={() => askConfirm('stop')}>
            {ICON.stop}<span>STOP</span>
          </button>
        )}
        <button className="pr-action"
          disabled={stopped || isFailed}
          onClick={() => onAction(selected.id, 'pause')}>
          {ICON.pause}<span>PAUSE</span>
        </button>
        <button className="pr-action primary"
          disabled={stopped || isFailed}
          onClick={() => onAction(selected.id, 'restart')}>
          {ICON.reload}<span>RESTART</span>
        </button>
        <button className="pr-action danger" onClick={() => askConfirm('kill')}>
          {ICON.kill}<span>KILL</span>
        </button>
        <button className="pr-action primary"
          disabled={!isLead || stopped || isFailed}
          onClick={() => onSpawnWorker(team)}
          title={isLead ? 'spawn worker' : 'lead-only action'}>
          {ICON.fork}<span>+ WORKER</span>
        </button>
      </div>

      <div className="pr-tabs">
        <button className={`pr-tab ${activeTab === 'console' ? 'active' : ''}`}
          onClick={() => setActiveTab('console')}>CONSOLE</button>
        <button className={`pr-tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}>MESSAGES</button>
        <button className={`pr-tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}>CONFIG</button>
        <div className="pr-tabs-meta">
          {activeTab === 'console' && !stopped && !isFailed && (
            <span className={`chip ${writer ? 'writer' : 'reader'}`}
              title={writer
                ? 'PTY writer — keystrokes will reach the agent'
                : 'PTY reader — passive view, no writes'}>
              <span className={`dot ${writer ? 'ok' : 'stopped'}`} />
              {writer ? 'WRITER' : 'READER'}
            </span>
          )}
        </div>
      </div>

      <div className="pr-body">
        {activeTab === 'console' && (
          <div className="console" ref={consoleRef}>
            {/* Step 7 : xterm.js (Terminal.tsx) sera monté ici, theme background = '#0d0a08'. */}
            <div style={{ color: 'var(--text-mute)', padding: '8px 0' }}>
              {stopped
                ? '— agent stopped, no log output —'
                : isFailed
                  ? '— agent failed — see EXIT REASON below —'
                  : '— console mounting point (Step 7) —'}
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="messages">
            {messages.length === 0 && (
              <div style={{
                color: 'var(--text-mute)', textAlign: 'center', marginTop: 30,
                fontFamily: 'Geist Mono, monospace', fontSize: 11, letterSpacing: '0.10em',
              }}>
                {stopped ? '— agent stopped —' : '— no messages yet —'}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.from === 'me' ? 'me' : 'them'}`}>
                <div className="who">
                  {m.who}
                  {m.via && <span style={{ marginLeft: 8, color: 'var(--text-mute)' }}>· via {m.via}</span>}
                </div>
                <div>{m.text}</div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'config' && (
          <ConfigTab
            team={team}
            agent={selected}
            isLead={isLead}
            onEdit={() => onEditConfig(team)}
          />
        )}

        {activeTab !== 'config' && (
          <Composer
            selectedName={selected.name}
            teamName={team.name}
            isLead={isLead}
            stopped={stopped || isFailed}
            draft={draft}
            setDraft={setDraft}
            onKey={onKey}
            onSend={doSend}
            composerMode={composerMode}
            setComposerMode={setComposerMode}
            audience={audience}
            setAudience={setAudience}
          />
        )}
      </div>

      {confirm && (
        <ConfirmModal
          label={confirm.label}
          body={confirm.body}
          cls={confirm.cls}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            onAction(selected.id, confirm.action);
            setConfirm(null);
          }}
        />
      )}
    </aside>
  );
}
```

---

### 3.16 `desktop/TopBar.tsx`

**Source v2** : `prototypes/v2/app.jsx:43-130`.

```tsx
// packages/web/src/components/desktop/TopBar.tsx
import { useEffect, useState } from 'react';
import { ICON } from './icons';
import { formatClock } from '../../lib/format';

/** Forme attendue par la TopBar pour chaque team-pill. */
export interface TopBarTeam {
  id: string;
  name: string;
  purpose: string;
  leadId: string;
  workerCount: number;
  msgCount: number;
  status: string;          // OrchestratorStatus
  health: 'ok' | 'warn' | 'bad' | 'stopped';
  /** true si une session de la team est en `waiting`. */
  hasWaiting?: boolean;
}

/** Sub-line live affichée sous le brand. */
export interface TopBarInfo {
  projectName: string;
  version: string;
  uptime: string;          // déjà formaté (formatUptime(info.started_at))
}

interface Props {
  teams: readonly TopBarTeam[];
  selectedTeamId?: string | null;
  flashTeamId?: string | null;
  totalAgents: number;
  info: TopBarInfo;
  onSelectTeam: (sessionId: string) => void;
  onNewTeam: () => void;
  onOpenRoles: () => void;
  onOpenSettings: () => void;
}

export default function TopBar({
  teams, selectedTeamId, flashTeamId, totalAgents, info,
  onSelectTeam, onNewTeam, onOpenRoles, onOpenSettings,
}: Props) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-text">
          SWARM<span style={{ color: 'var(--amber)' }}>·</span>OS
          <div className="sub">
            <b>{info.projectName}</b> · {info.version} · {info.uptime} up
          </div>
        </div>
      </div>

      <div className="health-strip">
        {teams.map((t) => {
          const offline = t.health === 'stopped';
          const starting = t.status === 'starting';
          const cls = offline ? 'stopped'
            : t.health === 'warn' ? 'warn'
            : t.health === 'bad'  ? 'bad'
            : 'ok';
          let dotCls: string;
          let label: string;
          if (offline)             { dotCls = 'stopped';  label = 'OFFLINE'; }
          else if (t.hasWaiting)   { dotCls = 'waiting';  label = 'WAITING'; }
          else if (starting)       { dotCls = 'starting'; label = 'STARTING'; }
          else if (t.health === 'warn') { dotCls = 'warn'; label = 'DEGRADED'; }
          else                     { dotCls = 'ok';       label = 'HEALTHY'; }
          const barPct = offline ? 0 : Math.round((t.health === 'warn' ? 0.6 : 0.85) * 100);
          const msgLabel = t.msgCount > 999
            ? `${(t.msgCount / 1000).toFixed(1)}k`
            : String(t.msgCount);
          return (
            <div
              key={t.id}
              className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ${flashTeamId === t.id ? 'flash-new' : ''}`}
              onClick={() => onSelectTeam(t.leadId)}
              title={`${t.name} — ${t.purpose}`}
            >
              <div className="pill-head">
                <span className="pill-name">
                  {t.name}
                  {t.hasWaiting && (
                    <span className="waiting-flag"
                      title="agent waiting for human input">●</span>
                  )}
                </span>
                <span className="pill-status">
                  <span className={`dot ${dotCls}`} />
                  {label}
                </span>
              </div>
              <div className="pill-body">
                <span className="pill-meta">{1 + t.workerCount} agt</span>
                <div className="pill-bar">
                  <i className={t.hasWaiting ? 'waiting' : cls}
                    style={{ width: `${barPct}%` }} />
                </div>
                <span className="pill-meta">{msgLabel} msg</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="topbar-right">
        <button className="tb-action primary" onClick={onNewTeam}
          title="create new orchestrator">
          {ICON.plus}<span className="label">NEW TEAM</span>
        </button>
        <button className="tb-action" onClick={onOpenRoles} title="manage roles">
          {ICON.template}<span className="label">ROLES</span>
        </button>
        <button className="tb-action" onClick={onOpenSettings} title="settings / token">
          {ICON.cog}
        </button>
        <div className="tb-clock">
          <span className="agents">{totalAgents} AGENTS</span>
          <span className="agents-sep">·</span>
          <span className="clock">{formatClock(now)}</span>
        </div>
      </div>
    </header>
  );
}
```

---

### 3.17 `desktop/Toasts.tsx`

**Source v2** : `prototypes/v2/toasts.jsx:9-45`.

```tsx
// packages/web/src/components/desktop/Toasts.tsx
import { formatRelative } from '../../lib/format';

const TOAST_MAX_VISIBLE = 5;

export interface WaitingToast {
  id: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  agentName: string;
  reason?: string;
  at: number | string;         // ms epoch ou ISO
}

interface Props {
  items: readonly WaitingToast[];
  onOpen: (t: WaitingToast) => void;
  onDismiss: (id: string) => void;
}

export default function Toasts({ items, onOpen, onDismiss }: Props) {
  const visible = items.slice(0, TOAST_MAX_VISIBLE);
  const olderCount = items.length - visible.length;
  const firstOlder = items[TOAST_MAX_VISIBLE];

  return (
    <div className="toasts">
      {olderCount > 0 && firstOlder && (
        <div className="toasts-older" onClick={() => onOpen(firstOlder)}>
          + {olderCount} older waiting →
        </div>
      )}
      {visible.map((t) => (
        <div className="toast" key={t.id}>
          <div className="t-head">
            <span className="t-title">SESSION WAITING</span>
            <span className="t-time">{formatRelative(t.at)}</span>
          </div>
          <div className="t-id">{t.teamName} :: {t.agentName}</div>
          {t.reason && <div className="t-reason">{t.reason}</div>}
          <div className="t-foot">
            <span style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 9, letterSpacing: '0.14em',
              color: 'var(--text-mute)',
            }}>
              {t.sessionId}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="dismiss" onClick={() => onDismiss(t.id)} title="dismiss">×</button>
              <button className="open" onClick={() => onOpen(t)}>→ OPEN</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

### 3.18 `desktop/EventsPip.tsx`

**Source v2** : `prototypes/v2/toasts.jsx:48-55`.

```tsx
// packages/web/src/components/desktop/EventsPip.tsx

interface Props {
  connected: boolean;
}

export default function EventsPip({ connected }: Props) {
  return (
    <div className="events-pip">
      <span className={`dot ${connected ? 'ok' : 'warn'}`} />
      events :: {connected ? 'live' : 'reconnecting…'}
    </div>
  );
}
```

---

### 3.19 `desktop/DesktopShell.tsx`

**Source v2** : `prototypes/v2/app.jsx:558-693` (le JSX du composant `App`,
sans la logique mock du ticker).

Pour ce Step 2 SQUELETTE, `DesktopShell` ne câble RIEN aux hooks. Il
expose la structure (grid + assemblage) avec des **données fictives par
défaut** stockées en state local trivial (`useState([])`). Les hooks
(`useOrchestrators`, `useEvents`, `useGlobalMessageStats`, etc.) seront
plombés en Phase B (Steps 4-8).

Les 5 overlays (`NewOrchestratorDialog`, `RolesPage`, `SettingsDrawer`,
`SpawnWorkerDialog`, `EditConfigDialog`, `BroadcastModal`) ne sont **pas
encore créés** (ils sont l'objet de la Phase C, Steps 9-13). Pour Step 2,
on définit les states de visibilité + on rend des placeholders commentés
`{/* TODO Step 9 ... */}`. Les boutons NEW/ROLES/cog déclenchent les
setters mais aucun composant n'est monté.

```tsx
// packages/web/src/components/desktop/DesktopShell.tsx
import { useMemo, useState } from 'react';
import TopBar, { type TopBarTeam, type TopBarInfo } from './TopBar';
import LeftPanel, {
  type LeftPanelTeam, type LeftPanelEnded,
} from './LeftPanel';
import MapView, { type MapViewTeam, type MapPulse } from './MapView';
import RightPanel, {
  type RightPanelAgent, type RightPanelTeam, type MessageBubble,
  type RightPanelTab, type AgentAction,
} from './RightPanel';
import Toasts, { type WaitingToast } from './Toasts';
import EventsPip from './EventsPip';
import type { ComposerAudience, ComposerMode } from './Composer';

/**
 * Phase A.2 — squelette. Ce composant assemble la grille desktop mais ne
 * câble aucune source de données. Les hooks viendront en Phase B :
 *   - Step 4 : TopBar  ← useOrchestrators + api.info + api.health
 *   - Step 5 : LeftPanel ← useGlobalMessageStats + api.getMetricsBus + filter ended
 *   - Step 6 : MapView  ← useOrchestrators + useEvents (pulses)
 *   - Step 7 : RightPanel ← useSession + Terminal + peekInbox + classifyBubble
 *   - Step 8 : Toasts/EventsPip ← useEvents waiting + connected
 *
 * Les 6 overlays (NewOrchestratorDialog/RolesPage/SettingsDrawer/Spawn/Edit/Broadcast)
 * ne sont pas montés en Step 2 ; on stocke leur état d'ouverture et on
 * laisse des placeholders pour Phase C (Steps 9-13).
 */
export default function DesktopShell() {
  // ── données (vides en Step 2) ──────────────────────────────────────────
  const [teams] = useState<readonly TopBarTeam[]>([]);
  const [leftTeams] = useState<readonly LeftPanelTeam[]>([]);
  const [ended] = useState<readonly LeftPanelEnded[]>([]);
  const [mapTeams] = useState<readonly MapViewTeam[]>([]);
  const [history] = useState<readonly number[]>(new Array(60).fill(0));
  const [pulses] = useState<readonly MapPulse[]>([]);
  const [waitingToasts] = useState<readonly WaitingToast[]>([]);
  const [spawningIds] = useState<ReadonlySet<string>>(new Set());

  // ── selection ──────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('console');

  // ── overlays (Phase C) ─────────────────────────────────────────────────
  const [, setShowNew] = useState(false);
  const [, setShowRoles] = useState(false);
  const [, setShowSettings] = useState(false);
  const [, setSpawnFor] = useState<RightPanelTeam | null>(null);
  const [, setEditConfigFor] = useState<RightPanelTeam | null>(null);
  const [, setShowBroadcast] = useState(false);

  // ── info (Phase B Step 4 : api.info() + uptime live) ──────────────────
  const info: TopBarInfo = {
    projectName: '—',
    version: '—',
    uptime: '—',
  };

  // ── derived ────────────────────────────────────────────────────────────
  const totalAgents = useMemo(
    () => teams.reduce((s, t) => s + 1 + t.workerCount, 0),
    [teams],
  );
  const totalMessages = useMemo(
    () => leftTeams.reduce((s, t) => s + t.msgCount, 0),
    [leftTeams],
  );

  // ── selected agent/team for RightPanel ────────────────────────────────
  // Step 7 : ces lookups viendront de useOrchestrators / useSession.
  const selectedAgent: RightPanelAgent | null = null;
  const selectedTeam: RightPanelTeam | null = null;
  const isLead = false;
  const messages: readonly MessageBubble[] = [];

  // ── handlers placeholders ─────────────────────────────────────────────
  function selectAgent(id: string | null) {
    setSelectedId(id);
  }
  function onAction(_agentId: string, _action: AgentAction) {
    // Step 7 : api.stopSession / pauseSession / resumeSession / restartSession / destroyOrchestrator
  }
  function onSend(
    _agentId: string,
    _text: string,
    _opts: { mode: ComposerMode; audience: ComposerAudience },
  ) {
    // Step 7 : api.postSessionInput | api.broadcastToOrchestrator
  }

  return (
    <div className="app">
      <TopBar
        teams={teams}
        selectedTeamId={selectedTeam?.id}
        onSelectTeam={selectAgent}
        onNewTeam={() => setShowNew(true)}
        onOpenRoles={() => setShowRoles(true)}
        onOpenSettings={() => setShowSettings(true)}
        totalAgents={totalAgents}
        info={info}
      />
      <div className="main">
        <LeftPanel
          teams={leftTeams}
          ended={ended}
          history={history}
          totalMessages={totalMessages}
          deltaPerMin={0}
          onSelectTeam={selectAgent}
          onSelectEnded={() => { /* Step 9: drill-down read-only */ }}
        />
        <MapView
          teams={mapTeams}
          selectedId={selectedId}
          onSelect={selectAgent}
          onBroadcast={() => setShowBroadcast(true)}
          pulses={pulses}
          spawningIds={spawningIds}
        />
        <RightPanel
          selected={selectedAgent}
          team={selectedTeam}
          isLead={isLead}
          messages={messages}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onClose={() => selectAgent(null)}
          onAction={onAction}
          onSend={onSend}
          onSpawnWorker={(team) => setSpawnFor(team)}
          onEditConfig={(team) => setEditConfigFor(team)}
        />
      </div>

      {/* Phase C — Step 9 : NewOrchestratorDialog overlay */}
      {/* Phase C — Step 10 : RolesPage overlay */}
      {/* Phase C — Step 11 : SettingsDrawer */}
      {/* Phase C — Step 12 : BroadcastModal */}
      {/* Phase C — Step 13 : SpawnWorkerDialog / EditConfigDialog */}

      {waitingToasts.length > 0 ? (
        <Toasts
          items={waitingToasts}
          onOpen={(t) => selectAgent(t.sessionId)}
          onDismiss={() => { /* Step 8 : useEvents.dismiss */ }}
        />
      ) : (
        <EventsPip connected={false} />
      )}
    </div>
  );
}
```

> **TS strict** : `noUnusedLocals` + `noUnusedParameters` sont activés. Les
> states/handlers non utilisés au Step 2 sont préfixés `_` (params) ou
> simplement destructurés sans le getter (`const [, setShowNew] = useState(false)`).
> Les imports non utilisés doivent être supprimés — j'ai gardé ici ceux qui
> serviront dès le premier branchement. Si `pnpm tsc --noEmit` se plaint,
> retirer momentanément les imports non consommés (ils reviendront en Phase B).

---

## 4. Helpers / utilitaires à porter — emplacement final

| Source v2 | Cible | Notes |
|---|---|---|
| `v2/data.jsx:117-127` `ROLE_SHAPE` + type `Shape` | `packages/web/src/lib/roleShape.ts` (nouveau) | Mapping figé, source de vérité pour la MapView. Helper `shapeForRole(role)` avec fallback `'circle'`. |
| `v2/data.jsx:459-481` `formatUptime`/`formatRelative`/`formatClockShort` + `pad` | `packages/web/src/lib/format.ts` (nouveau) | Acceptent number ms OU ISO string ; renvoient `'—'` si invalide (le proto crash si `null`). |
| `v2/app.jsx:38-40` `formatClock` (HH:MM:SS) | idem `lib/format.ts` | Utilisé par TopBar pour l'horloge. |
| `v2/data.jsx:482-503` `statusLabel`/`statusChipClass` | idem `lib/format.ts` | Co-exist avec `mapSessionStatusToVisual` (S3) : ces helpers donnent label + chip class pour le warm-black theme, vs S3 qui donne les buckets visuels Tailwind. **Ne pas fusionner** — les deux ont des sorties différentes. |
| `v2/map.jsx:9-33` `layoutTeams` + constantes `VBW/VBH/CENTER/LEAD_RADIUS/WORKER_RADIUS/WORKER_SPREAD` | `packages/web/src/components/desktop/layoutTeams.ts` (nouveau) | Local au sous-dossier — pas réutilisé ailleurs. |
| `v2/map.jsx:140-151` `curveBetween` | `packages/web/src/components/desktop/curveBetween.ts` (nouveau) | Local. Pourrait remonter dans `lib/` si réutilisé hors `desktop/`. |
| `v2/map.jsx:35-55` `NodeShape` | `packages/web/src/components/desktop/NodeShape.tsx` (nouveau) | Composant React, pas un util. |
| `v2/map.jsx:57-77` `statusDotColor` + `ringClass` | inline dans `desktop/Node.tsx` | Internes au Node, pas besoin de les exporter. |
| `v2/icons.jsx` `ICON` | `packages/web/src/components/desktop/icons.tsx` (nouveau) | Re-typé en `Record<string, ReactElement>`. |

> **Helpers explicitement non portés au Step 2** (réservés Step 7+) :
> `genLog`, `genMessages`, `LOG_TEMPLATES` (mocks de logs). `formatLoadPercent`
> existe déjà dans `src/lib/loadPercent.ts` (S10) — utilisé tel quel par
> `RightPanel.tsx` en Step 7 (à câbler avec `selected.load` qui sera toujours
> `undefined` → `'—'`).

---

## 5. Conventions

### 5.1 Nommage des fichiers
- Composants : `PascalCase.tsx` (`DesktopShell.tsx`, `RightPanel.tsx`…)
- Helpers / utilitaires non-React : `camelCase.ts` (`layoutTeams.ts`,
  `curveBetween.ts`, `format.ts`, `roleShape.ts`)
- Icônes : `icons.tsx` (consensus du proto)

### 5.2 Exports
- **Default export** pour chaque composant React (1 composant = 1 fichier).
  Cohérent avec `Terminal.tsx`, `NewOrchestratorDialog.tsx` du codebase
  existant (default export sur App.tsx, named ailleurs — on suit la
  convention "1 composant principal → default" pour rester homogène).
- **Named exports** pour les types/interfaces de props, les sous-types
  utilitaires (`MapTeam`, `NodePosition`, `MessageBubble`, `WaitingToast`…)
  et les helpers (`formatUptime`, `ICON`, `layoutTeams`, `curveBetween`,
  `ROLE_SHAPE`, `shapeForRole`).

### 5.3 Imports
- React 19 : `import { useState, useEffect, ... } from 'react'` (pas de
  `import React from 'react'` inutile — `jsx: react-jsx` dans la config TS).
- Types : `import type { ... } from '...'` systématiquement pour les
  imports purement types (le bundler les drop, et c'est compatible avec
  `verbatimModuleSyntax` si activé un jour).
- Imports relatifs : 2 niveaux max (`../../lib/format`, `../../api/client`).
  Pas d'alias TS configuré (`baseUrl` absent) — on reste sur les paths
  relatifs.
- Imports tiers : `@xterm/xterm` etc. — réservés pour Step 7 (Terminal),
  pas nécessaires en Step 2.

### 5.4 TypeScript strict
La config (`tsconfig.app.json`) active :
- `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`.

Conséquences concrètes pour ce Step :
- **Tous les accès indexés** sur `positions[id]`, `pulses[i]`, `pts[pts.length-1]`
  retournent `T | undefined` — guard explicite obligatoire
  (`if (!pos) return null`).
- **Params non utilisés** doivent être préfixés `_` (`isLead: _isLead`)
  ou retirés.
- **Cases switch exhaustifs** : pas applicable ici, on délègue à
  `mapSessionStatusToVisual` (S3) pour ça.

### 5.5 Style CSS
- Le proto utilise des `className` warm-black (cf. `desktop-theme.css` du
  Step 1). On les recopie **strictement à l'identique** dans le TSX —
  toute modif d'orthographe casserait le style.
- Les `style={{ ... }}` inline sont conservés tels quels (le proto les
  utilise pour des micro-overrides). Acceptable en v1.

---

## 6. Plan d'implémentation pas-à-pas (ordre — évite les cycles)

Ordre topologique des imports (du moins-dépendant au plus-dépendant) :

1. **`lib/roleShape.ts`** — autonome, 0 import du code app.
2. **`lib/format.ts`** — autonome, 0 import du code app.
3. **`desktop/icons.tsx`** — autonome, dépend uniquement de `react`.
4. **`desktop/curveBetween.ts`** — autonome.
5. **`desktop/layoutTeams.ts`** — autonome.
6. **`desktop/NodeShape.tsx`** — dépend de `lib/roleShape` (type `Shape`).
7. **`desktop/Node.tsx`** — dépend de `NodeShape` + `layoutTeams` (type) + `roleShape` (type).
8. **`desktop/Sparkline.tsx`** — autonome (SVG pur).
9. **`desktop/BigGraph.tsx`** — autonome (SVG pur).
10. **`desktop/MapView.tsx`** — dépend de `Node`, `layoutTeams`,
    `curveBetween`, `lib/format` (statusLabel).
11. **`desktop/LeftPanel.tsx`** — dépend de `Sparkline`, `BigGraph`,
    `lib/format` (formatRelative).
12. **`desktop/ConfigTab.tsx`** — dépend de `lib/format` (formatClockShort).
13. **`desktop/Composer.tsx`** — autonome (types React).
14. **`desktop/ConfirmModal.tsx`** — autonome.
15. **`desktop/RightPanel.tsx`** — dépend de `ConfigTab`, `Composer`,
    `ConfirmModal`, `icons`, `lib/format`.
16. **`desktop/TopBar.tsx`** — dépend de `icons`, `lib/format` (formatClock).
17. **`desktop/Toasts.tsx`** — dépend de `lib/format` (formatRelative).
18. **`desktop/EventsPip.tsx`** — autonome.
19. **`desktop/DesktopShell.tsx`** — dépend de TOUS les composants ci-dessus
    (top-level orchestration).

Après chaque création (ou par lot de 3-5), lancer `pnpm tsc --noEmit`
depuis `packages/web/` pour valider qu'aucune erreur de type n'est
introduite.

**`DesktopShell` n'est PAS encore monté dans `App.tsx` en Step 2.**
L'intégration au routeur (`#/` → `DesktopShell`) est l'objet du Step 3
(Phase A.3). En Step 2, on se contente de valider que tous les fichiers
compilent isolément.

---

## 7. Vérification

À exécuter depuis `packages/web/` après création de l'ensemble des fichiers :

```bash
pnpm tsc --noEmit       # doit passer : 0 erreur
pnpm build              # doit passer : produit dist/ sans erreur Vite
```

Test additionnel (sanity check) :

```bash
pnpm test               # doit rester vert — aucun composant existant n'est touché en Step 2
```

### Checklist d'acceptation Step 2

- [ ] Dossier `packages/web/src/components/desktop/` créé (17 fichiers).
- [ ] `packages/web/src/lib/format.ts` créé (named exports listés).
- [ ] `packages/web/src/lib/roleShape.ts` créé (`ROLE_SHAPE`, `Shape`, `shapeForRole`).
- [ ] `pnpm tsc --noEmit` : 0 erreur depuis `packages/web/`.
- [ ] `pnpm build` : succès (Vite ne se plaint d'aucune classe CSS
      manquante car elles seront résolues au runtime via
      `desktop-theme.css` du Step 1).
- [ ] `pnpm test` : tests existants restent verts (aucun fichier touché
      hors `src/components/desktop/` et `src/lib/{format,roleShape}.ts`).
- [ ] `App.tsx` n'est **pas** modifié (intégration au routeur = Step 3).
- [ ] `OrchestratorList.tsx`, `OrchestratorView.tsx`, `NotificationPanel.tsx`
      etc. ne sont **pas** modifiés (refonte = Steps 3, 9-13).
- [ ] Aucun composant ne dépend de `data.jsx` (mocks) — tous les `window.*`
      du proto sont éliminés et remplacés par des imports propres ou des
      props.

### Garde-fous

1. **Ne pas importer depuis `prototypes/v2/`** dans le code app — le
   prototype reste source de vérité hors-arbre, jamais build.
2. **Ne pas dupliquer `mapSessionStatusToVisual`** (déjà dans
   `src/lib/sessionStatus.ts`). Les helpers `statusLabel`/`statusChipClass`
   de `format.ts` produisent un libellé et une classe CSS warm-black,
   pas un bucket visuel — les deux co-existent (Step 6 utilisera
   `enrichWithIdle` pour la map, `statusChipClass` pour le chip du
   RightPanel).
3. **Ne pas porter les composants `TweaksPanel` / `TweakSection` /
   `TweakColor` / `TweakRadio` / `TweakToggle` / `TweakButton`** —
   outils design-time exclus (cf. ui-redesign-desktop.md §1.1, dernière
   ligne du tableau).
4. **Ne pas porter `genLog`, `genMessages`, `SPARK_DATA`, `AGG_HISTORY`,
   `TEAMS_INIT`, `ENDED_INIT`, `WAITING_INIT`, `ROLES_INIT`, `SERVER_INFO`**
   — tous des mocks remplacés par les vrais endpoints en Phase B.
5. **`writer` sur l'agent** : le proto stocke `writer: boolean` dans le
   mock. Le vrai backend ne l'expose pas (gap §4-4) ; on garde le champ
   optionnel sur `RightPanelAgent.writer?` et on dérivera de
   `Terminal.tsx` (hello frame WS) en Step 7. Pour Step 2, `writer` reste
   `undefined` → l'affichage par défaut sera `WRITER` (cf. la ligne
   `const writer = selected.writer !== false` dans `RightPanel.tsx`).

---

## 8. Récapitulatif — arborescence finale après Step 2

```
packages/web/src/
├── App.tsx                          (inchangé en Step 2)
├── main.tsx                         (inchangé en Step 2)
├── index.css                        (inchangé)
├── api/
│   └── client.ts                    (inchangé)
├── hooks/                           (inchangés)
│   ├── useEvents.ts
│   ├── useOrchestrators.ts
│   ├── useRoles.ts
│   └── useSession.ts
├── lib/
│   ├── format.ts                    ← NOUVEAU (helpers proto)
│   ├── roleShape.ts                 ← NOUVEAU (ROLE_SHAPE + Shape)
│   ├── loadPercent.ts               (existe — utilisé en Step 7)
│   ├── mailBubble.ts                (existe — utilisé en Step 7)
│   ├── messageStats.ts              (existe — utilisé en Step 5)
│   ├── sessionStatus.ts             (existe — utilisé en Step 6)
│   ├── useNow.ts                    (existe)
│   └── *.test.*                     (inchangés)
├── components/
│   ├── BroadcastBar.tsx             (existant, supprimé en Step 3)
│   ├── NewOrchestratorDialog.tsx    (existant, remplacé en Step 9)
│   ├── NotificationPanel.tsx        (existant, remplacé en Step 8)
│   ├── OrchestratorList.tsx         (existant, supprimé en Step 3)
│   ├── OrchestratorView.tsx         (existant, supprimé en Step 3)
│   ├── RoleDialog.tsx               (existant)
│   ├── RolesPage.tsx                (existant, refondu en Step 10)
│   ├── StatusBadge.tsx              (existant)
│   ├── Terminal.tsx                 (existant, theme adjusté en Step 7)
│   └── desktop/                     ← NOUVEAU dossier (17 fichiers)
│       ├── BigGraph.tsx
│       ├── Composer.tsx
│       ├── ConfigTab.tsx
│       ├── ConfirmModal.tsx
│       ├── curveBetween.ts
│       ├── DesktopShell.tsx
│       ├── EventsPip.tsx
│       ├── icons.tsx
│       ├── layoutTeams.ts
│       ├── LeftPanel.tsx
│       ├── MapView.tsx
│       ├── Node.tsx
│       ├── NodeShape.tsx
│       ├── RightPanel.tsx
│       ├── Sparkline.tsx
│       ├── Toasts.tsx
│       └── TopBar.tsx
└── styles/
    └── desktop-theme.css            (créé en Step 1, prérequis)
```

19 nouveaux fichiers, 0 fichier supprimé/modifié en Step 2.

---

## 9. Annexe — Lignes de référence du proto v2 par composant

| Composant cible | Fichier source | Lignes |
|---|---|---|
| `DesktopShell.tsx` (JSX assembly) | `v2/app.jsx` | 558-693 (App return) |
| `TopBar.tsx` | `v2/app.jsx` | 43-130 |
| `LeftPanel.tsx` | `v2/panels.jsx` | 67-154 |
| `Sparkline.tsx` | `v2/panels.jsx` | 15-34 |
| `BigGraph.tsx` | `v2/panels.jsx` | 36-65 |
| `MapView.tsx` | `v2/map.jsx` | 153-434 (+ tooltipStyle 436-449) |
| `Node.tsx` | `v2/map.jsx` | 79-138 |
| `NodeShape.tsx` | `v2/map.jsx` | 35-55 |
| `layoutTeams.ts` | `v2/map.jsx` | 9-33 |
| `curveBetween.ts` | `v2/map.jsx` | 140-151 |
| `RightPanel.tsx` | `v2/panels.jsx` | 158-405 |
| `ConfigTab.tsx` | `v2/panels.jsx` | 472-535 |
| `Composer.tsx` | `v2/panels.jsx` | 407-470 |
| `ConfirmModal.tsx` | `v2/panels.jsx` | 537-557 |
| `Toasts.tsx` | `v2/toasts.jsx` | 9-45 |
| `EventsPip.tsx` | `v2/toasts.jsx` | 48-55 |
| `icons.tsx` | `v2/icons.jsx` | 3-21 |
| `lib/format.ts` | `v2/data.jsx` | 459-503 (+ pad 387) + `v2/app.jsx:37-40` (formatClock) |
| `lib/roleShape.ts` | `v2/data.jsx` | 117-127 |

— FIN du document analyse Step 2 —
