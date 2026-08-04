# Step 4 (Phase B.4) — Binder `TopBar.tsx` aux vraies données

> Lié au plan global `docs/ui-redesign-desktop.md` §3.1 + §5.1 step 4.
> Pré-requis : Step 2 (skeleton `desktop/TopBar.tsx`) doit avoir produit le
> composant typé décrit dans `02_desktop-skeleton.md` §3.16 (props :
> `teams: TopBarTeam[]`, `info: TopBarInfo`, callbacks `onNewTeam` /
> `onOpenRoles` / `onOpenSettings` / `onSelectTeam`, `totalAgents`,
> `selectedTeamId`, `flashTeamId`). Step 3 a déjà câblé `DesktopShell`
> derrière `#/` et `useOrchestrators()` y est déjà appelé.
>
> Ce step **ne crée aucun nouveau composant** : il consomme les hooks et
> endpoints existants pour fabriquer les props attendues par la `TopBar`
> et les passer depuis `DesktopShell`. Aucune modification serveur.

---

## 1. Objectif

Brancher `TopBar.tsx` (squelette livré en Step 2) sur les vraies sources :
`useOrchestrators()` (poll 3 s), `api.info()` + `api.health()` (one-shot au
boot, rafraîchis à intervalle court), avec un tick local 1 s pour l'horloge
et l'uptime. Calculer le statut visuel de chaque `team-pill`
(`HEALTHY | DEGRADED | WAITING | STARTING | OFFLINE | BAD`) à partir de
`orch.status`, `orch.health` (S7) et `sessions[].status`. Brancher les
boutons (NEW / ROLES / cog → callbacks vers `DesktopShell`) et le clic sur
une pill (sélection lead + route `#/orchestrators/:id`).

> **Obsolète depuis Step 20** — la rangée de boutons décrite ici (NEW / ROLES /
> cog, puis les 9 destinations accumulées ensuite) a été remplacée par
> `+ NEW TEAM` + `MENU` (panneau ⌘K). Les callbacks `onOpen*` sont inchangés,
> mais ils sont désormais routés par `CommandLauncher` → `onPick`.
> Cf. `20_command-launcher.md`. Le reste de cette note (binding des données,
> statut des pills, horloge/uptime) reste exact.

---

## 2. Données nécessaires

| Donnée | Source | Cadence | Vivacité |
|---|---|---|---|
| Liste des orchestrators (1 par pill) | `useOrchestrators()` (poll REST `GET /orchestrators`) | 3 s | re-render du `DesktopShell` à chaque snapshot |
| `info.project_name`, `info.version`, `info.started_at` | `api.info()` (`GET /info`, token-free) | 1 fois au mount, **+** refresh toutes les 60 s pour ne pas trop charger | seulement si le backend redémarre (`started_at` change) |
| `health.sessions_active` (count "N AGENTS") | `api.health()` (`GET /health`, token-free) | toutes les 3 s (aligné avec `useOrchestrators`) — alternatif : recalcul client `Σ orchestrators[i].sessions.length` (évite un appel HTTP supplémentaire) | re-render à chaque refresh |
| Uptime (`Xh Xm`) | dérivé de `info.started_at` + `Date.now()` | tick 1 s local | local |
| Horloge `HH:MM:SS` | `new Date()` | tick 1 s local | local |
| `flashTeamId` (animation pill nouvellement créée) | local state dans `DesktopShell`, set après création réussie via `NewOrchestratorDialog` (Phase C, Step 9) | one-shot, clear via `setTimeout(1700)` | local |
| `selectedTeamId` | dérivé de `selectedSessionId` (lift `DesktopShell`) — `teams.find(t => t.leadId === selectedSessionId || t.workerIds.includes(selectedSessionId))?.id` | re-render à chaque sélection | local |

### 2.1 Recommandation : `health.sessions_active` vs somme client

Deux options pour le compteur `N AGENTS` :

1. **`api.health().sessions_active`** : valeur canonique serveur (S8). Avantage :
   inclut les sessions encore en `starting` que `useOrchestrators` n'a pas
   forcément en vue dans un snapshot fraîchement re-rendered. Coût : un GET
   HTTP supplémentaire toutes les 3 s.
2. **`Σ orch.sessions.length`** : recalcul pur en client à partir de
   `useOrchestrators()`. Avantage : 0 appel supplémentaire, déjà rafraîchi
   par le poll 3 s. Compatible parfaitement avec la formule v2
   `1 + t.workers.length` agrégée.

**Décision** : utiliser **option 2** (somme client) par défaut, et garder
`api.health()` uniquement pour le `SettingsDrawer` (About). Cohérent avec
l'esprit "1 source = 1 hook" et évite la divergence transitoire entre
les deux. La somme se fait dans `DesktopShell` :

```ts
const totalAgents = useMemo(
  () => orchestrators.reduce((s, o) => s + o.sessions.length, 0),
  [orchestrators],
);
```

### 2.2 Cadence `api.info()`

`info.started_at` ne change que si le backend redémarre — ce qui est
détectable via l'event `session.status_changed → interrupted` côté
`useEvents`. En pratique : appeler `api.info()` une fois au mount du
`DesktopShell`, **puis** réappeler quand `useEvents` détecte un
`server-restart`. Pour Step 4 (sans wire useEvents), on garde un simple
refresh toutes les 60 s — c'est assez fréquent pour rattraper un restart,
assez rare pour ne pas peser.

```ts
useEffect(() => {
  let alive = true;
  void api.info().then((i) => { if (alive) setInfo(i); }).catch(() => {});
  const t = setInterval(
    () => { void api.info().then((i) => { if (alive) setInfo(i); }).catch(() => {}); },
    60_000,
  );
  return () => { alive = false; clearInterval(t); };
}, []);
```

---

## 3. Mapping `OrchestratorView` → `'HEALTHY' | 'DEGRADED' | 'WAITING' | 'STARTING' | 'OFFLINE' | 'BAD'`

C'est le cœur du step. La règle (figée par §3.1) :

1. **OFFLINE** si `orch.health === 'stopped'` (S7 — recouvre `status` ∈
   `{stopped, exited, killed}` côté server).
2. **BAD** si `orch.health === 'bad'` (S7 — `status === 'failed'` ou
   `lastError` présent).
3. **WAITING** si au moins une session est en `status === 'waiting'`
   (attend input humain). Prioritaire sur STARTING (un agent qui attend
   un input est plus important visuellement qu'un agent qui boote).
4. **STARTING** si `orch.status === 'starting'` (lead en train de booter).
5. **DEGRADED** si `orch.health === 'warn'` (S7 — un worker `warn` ou
   `failed` mais la team n'est pas complètement perdue).
6. **HEALTHY** sinon (`orch.health === 'ok'` et aucun signal négatif).

### 3.1 Fonction TypeScript (littérale, à coller dans `src/lib/topBarStatus.ts`)

> Choix d'emplacement : `src/lib/topBarStatus.ts` (nouveau fichier
> dédié). On **n'étend pas** `sessionStatus.ts` car celui-là gère les
> buckets visuels session-level (5 valeurs `idle/running/warn/bad/stopped`),
> alors que la TopBar a son propre vocabulaire à 6 valeurs avec
> `WAITING/STARTING` qui sont des états transverses (statut session +
> orch). Garder les deux séparés évite la pollution. Fichier nouveau,
> petite surface, testable isolément (recommandé : `topBarStatus.test.ts`).

```ts
// packages/web/src/lib/topBarStatus.ts
//
// Mapping orchestrator → pill visuel pour la TopBar v2 (cf.
// docs/ui-redesign-desktop.md §3.1 et docs/redesign-desktop/04_topbar-data-binding.md).
//
// Le bucket retourné pilote :
//  - la classe CSS du dot (`stopped|bad|waiting|starting|warn|ok`)
//  - le label affiché (`OFFLINE|BAD|WAITING|STARTING|DEGRADED|HEALTHY`)
//  - la largeur de la pill-bar (cf. derivePillBarPct)
//
// Cette fonction n'a pas vocation à modifier le state serveur ; elle
// dérive uniquement de `orch.status`, `orch.health` (S7), et de la liste
// `orch.sessions`. WAITING est *prioritaire* sur STARTING (un agent qui
// attend une réponse opérateur est plus urgent qu'un agent qui boote).

import type { OrchestratorView } from '../api/client';

export type PillStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'WAITING'
  | 'STARTING'
  | 'OFFLINE'
  | 'BAD';

export function deriveTopBarPillStatus(orch: OrchestratorView): PillStatus {
  // 1. OFFLINE : team complètement arrêtée (S7 'stopped' couvre
  //              status ∈ {stopped, exited, killed} côté server).
  if (orch.health === 'stopped') return 'OFFLINE';

  // 2. BAD : team en échec (failed, lastError persistant).
  if (orch.health === 'bad') return 'BAD';

  // 3. WAITING : au moins une session attend un input humain. On scanne
  //              toutes les sessions (lead + workers) — un seul `waiting`
  //              suffit.
  if (orch.sessions.some((s) => s.status === 'waiting')) return 'WAITING';

  // 4. STARTING : la team est en cours de démarrage côté orchestrator-level.
  //               (On pourrait aussi regarder `sessions.some(s => s.status
  //               === 'starting')` mais `orch.status` est l'autorité S7.)
  if (orch.status === 'starting') return 'STARTING';

  // 5. DEGRADED : health server dit "warn" — au moins un signal négatif
  //               sans atteindre le seuil 'bad'.
  if (orch.health === 'warn') return 'DEGRADED';

  // 6. HEALTHY : tout va bien.
  return 'HEALTHY';
}

/**
 * Mapping pill → classe CSS du dot (warm-black theme).
 * Cf. `src/styles/desktop-theme.css` (Step 1).
 */
export function pillDotClass(p: PillStatus): string {
  switch (p) {
    case 'OFFLINE':  return 'stopped';
    case 'BAD':      return 'bad';
    case 'WAITING':  return 'waiting';
    case 'STARTING': return 'starting';
    case 'DEGRADED': return 'warn';
    case 'HEALTHY':  return 'ok';
  }
}

/**
 * Mapping pill → classe CSS de la barre de progression (pill-bar).
 * WAITING surcharge la couleur (orange pulsant).
 */
export function pillBarClass(p: PillStatus): 'stopped' | 'bad' | 'waiting' | 'warn' | 'ok' {
  switch (p) {
    case 'OFFLINE':  return 'stopped';
    case 'BAD':      return 'bad';
    case 'WAITING':  return 'waiting';
    case 'STARTING': return 'ok';       // bar verte courte le temps du boot
    case 'DEGRADED': return 'warn';
    case 'HEALTHY':  return 'ok';
  }
}

/**
 * Pourcentage de remplissage de la pill-bar.
 * - OFFLINE/BAD → 0% (barre vide)
 * - DEGRADED → 60% (warn)
 * - HEALTHY/WAITING/STARTING → 85% (ok-équivalent)
 *
 * Aligné v2 `app.jsx:82` (formule originale `health === 'warn' ? 0.6 : 0.85`).
 */
export function derivePillBarPct(p: PillStatus): number {
  if (p === 'OFFLINE' || p === 'BAD') return 0;
  if (p === 'DEGRADED') return 60;
  return 85;
}
```

### 3.2 Différences vs `mapOrchestratorStatusToVisual` (S3)

`src/lib/sessionStatus.ts:101-123` fournit déjà
`mapOrchestratorStatusToVisual(status: OrchestratorStatus)` qui retourne
un `VisualDescriptor` à 5 buckets (`idle/running/warn/bad/stopped`).
**Insuffisant** pour la TopBar parce que :

- il ne prend que `status`, pas `health` (S7) ;
- il ne sait rien des sessions (donc WAITING impossible à dériver) ;
- il a 5 buckets, la TopBar en a 6.

→ Conclusion : créer `deriveTopBarPillStatus` à part, **ne pas** réutiliser
`mapOrchestratorStatusToVisual`. Les deux co-existent et restent
spécialisés.

---

## 4. Formatters

Tous portés dans `src/lib/format.ts` (livré en Step 2, §3.2 du Step 2
analysis). Pour Step 4 on **étend** ce fichier avec deux helpers :
`formatMsgCount` et `formatUptimeShort` (le `formatUptime` existant
renvoie `HH:MM:SS`, la TopBar veut `Xh Xm`). `formatClock(d)` (HH:MM:SS)
existe déjà — réutilisé tel quel.

### 4.1 `formatMsgCount(n: number): string`

```ts
/**
 * Format compact du compteur de messages pour la pill TopBar.
 *  - n ≤ 999            → "N"          (ex: "42")
 *  - 1_000 ≤ n < 1_000_000  → "X.Yk"   (1 décimale ex: "1.2k", "12.3k", "999.9k")
 *  - n ≥ 1_000_000      → "X.YM"      (au cas où ; pas attendu en v1)
 *
 * Aligné v2 `app.jsx:105` (`t.msgCount > 999 ? (t.msgCount/1000).toFixed(1) + "k" : t.msgCount`).
 * On garde la convention v2 (point décimal, pas de séparateur de milliers
 * en dessous du seuil) pour ne pas casser l'identité visuelle.
 */
export function formatMsgCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n > 999_999) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n > 999)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

> Edge cases :
> - `n === 0` → `'0'`
> - `n === 1000` → `'1.0k'`
> - `n === 12345` → `'12.3k'`
> - `n === undefined / null / NaN` → `'0'` (défensif, car les history rows
>   SQLite ont `msgCount: 0` mais on protège contre les drift de shape).

### 4.2 `formatUptime(startedAt: string | number): string` — variante "Xh Xm"

Le `formatUptime` existant (Step 2) retourne `'HH:MM:SS'` — adapté pour la
tab CONFIG, **pas** pour la TopBar qui demande `Xh Xm`. On ajoute donc une
seconde fonction (en gardant la première pour les autres call sites).

```ts
/**
 * Format uptime compact pour la TopBar brand-sub. Renvoie :
 *   "0m"          si < 1 min
 *   "Xm"          si < 1 h
 *   "Xh Ym"       si < 24 h
 *   "Xd Yh"       au-delà
 *   "—"           si invalide / null
 *
 * Aligné v2 `data.jsx:462-473` (helper proto `formatUptime`).
 */
export function formatUptimeShort(startedAt: string | number | null | undefined): string {
  if (startedAt == null) return '—';
  const ts = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  if (!Number.isFinite(ts)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return '0m';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  const hrem = hrs % 24;
  return `${days}d ${hrem}h`;
}
```

### 4.3 `formatClock(d: Date): string`

**Existe déjà** dans `src/lib/format.ts` après Step 2 (§3.2) :

```ts
export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

Pas de changement. C'est ce que la TopBar utilise pour l'horloge à droite.

---

## 5. Squelette du composant TopBar avec data binding

Deux niveaux :

- **`TopBar.tsx`** : reste **inchangé** par rapport au squelette Step 2
  (§3.16). C'est un composant "présentational" qui prend des props déjà
  cuits (`teams: TopBarTeam[]`, `info: TopBarInfo`, …). Toute la logique
  de binding vit **dans le parent** (`DesktopShell.tsx`).
- **`DesktopShell.tsx`** : ajoute les hooks, calcule les props, branche
  les callbacks.

### 5.1 Fragment de `DesktopShell.tsx` — section TopBar data binding

```tsx
// packages/web/src/components/desktop/DesktopShell.tsx
// — Fragment ajouté en Step 4 (Phase B.4) —
import { useEffect, useMemo, useState } from 'react';
import { api, type InfoView, type OrchestratorView } from '../../api/client';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import TopBar, { type TopBarTeam, type TopBarInfo } from './TopBar';
import {
  deriveTopBarPillStatus,
  type PillStatus,
} from '../../lib/topBarStatus';
import { formatMsgCount, formatUptimeShort } from '../../lib/format';

// — Hooks & state —
const { orchestrators, refresh: refreshOrchestrators } = useOrchestrators(); // 3 s poll
const [info, setInfo] = useState<InfoView | null>(null);
const [now, setNow] = useState<number>(() => Date.now());

// — Overlays state (déjà existants en squelette Step 2) —
const [showNew, setShowNew] = useState(false);
const [showRoles, setShowRoles] = useState(false);
const [showSettings, setShowSettings] = useState(false);

// — Route / selection state (déjà existants Step 3) —
// routeOrchestratorId vient des props
// selectedSessionId est lifté ici

// — Info fetch (one-shot + refresh 60 s) —
useEffect(() => {
  let alive = true;
  const fetchInfo = () => {
    void api.info()
      .then((i) => { if (alive) setInfo(i); })
      .catch(() => {/* silent — token-free endpoint, retried next tick */});
  };
  fetchInfo();
  const t = setInterval(fetchInfo, 60_000);
  return () => { alive = false; clearInterval(t); };
}, []);

// — Tick 1 s pour uptime + horloge (re-render local seulement) —
useEffect(() => {
  const t = setInterval(() => setNow(Date.now()), 1000);
  return () => clearInterval(t);
}, []);

// — Build TopBarTeam[] (côté parent) —
const topBarTeams: TopBarTeam[] = useMemo(
  () => orchestrators
    // On affiche uniquement les actifs dans la TopBar
    // (les ended/historiques vont dans LeftPanel RECENTLY ENDED).
    .filter((o) => o.endedAt == null)
    .map<TopBarTeam>((o) => {
      const pill: PillStatus = deriveTopBarPillStatus(o);
      const hasWaiting = pill === 'WAITING'; // déjà encapsulé dans deriveTopBarPillStatus
      return {
        id: o.id,
        name: o.name,
        purpose: o.role,
        leadId: o.leadSessionId ?? '', // edge case : si null, clic = no-op
        workerCount: Math.max(0, o.sessions.length - 1),
        msgCount: o.msgCount,
        status: o.status,
        health: o.health,
        hasWaiting,
      };
    }),
  [orchestrators],
);

// — N AGENTS : somme client (cf. §2.1) —
const totalAgents = useMemo(
  () => orchestrators.reduce((s, o) => s + o.sessions.length, 0),
  [orchestrators],
);

// — TopBarInfo : project_name + version + uptime live —
const topBarInfo: TopBarInfo = useMemo(
  () => ({
    projectName: info?.project_name ?? '—',
    version: info?.version ?? '—',
    // `now` est lu pour forcer le re-calcul à chaque tick 1 s.
    // formatUptimeShort recalcule `Date.now() - startedAt` en interne ;
    // on liste `now` dans les deps pour la lisibilité.
    uptime: info?.started_at
      ? (void now, formatUptimeShort(info.started_at))
      : '—',
  }),
  [info, now],
);

// — selectedTeamId dérivé du selectedSessionId lifté (Step 3) —
const selectedTeamId = useMemo<string | null>(
  () => {
    if (!selectedSessionId) return null;
    const found = orchestrators.find((o) =>
      o.sessions.some((s) => s.id === selectedSessionId),
    );
    return found?.id ?? null;
  },
  [orchestrators, selectedSessionId],
);

// — flashTeamId : alimenté après création réussie (Phase C Step 9) —
const [flashTeamId, setFlashTeamId] = useState<string | null>(null);
// Note : cette state est seulement set depuis le handler du
// NewOrchestratorDialog (Phase C). En Step 4, elle reste à null.

// — Handlers TopBar —
function handleSelectTeam(leadSessionId: string) {
  if (!leadSessionId) return;
  setSelectedSessionId(leadSessionId);
  // sync route (déjà fait via le callback prop `onOpenOrchestrator` du
  // parent App.tsx — cf. Step 3 §6.3). On remonte l'orchestratorId
  // depuis la session sélectionnée.
  const orch = orchestrators.find((o) =>
    o.sessions.some((s) => s.id === leadSessionId),
  );
  if (orch) onOpenOrchestrator(orch.id);
}

// — JSX — placé à l'intérieur du DesktopShell return —
<TopBar
  teams={topBarTeams}
  selectedTeamId={selectedTeamId}
  flashTeamId={flashTeamId}
  totalAgents={totalAgents}
  info={topBarInfo}
  onSelectTeam={handleSelectTeam}
  onNewTeam={() => setShowNew(true)}
  onOpenRoles={() => setShowRoles(true)}
  onOpenSettings={() => setShowSettings(true)}
/>
```

### 5.2 Le composant `TopBar.tsx` lui-même (référence Step 2 — non modifié)

Cf. `02_desktop-skeleton.md` §3.16 — le composant est déjà prêt à recevoir
les props ci-dessus sans modification. Le seul ajustement souhaitable est
d'extraire la formule `msgLabel` pour réutiliser `formatMsgCount` :

```diff
- const msgLabel = t.msgCount > 999
-   ? `${(t.msgCount / 1000).toFixed(1)}k`
-   : String(t.msgCount);
+ const msgLabel = formatMsgCount(t.msgCount);
```

avec l'import `import { formatClock, formatMsgCount } from '../../lib/format';`.

C'est la seule diff sur `TopBar.tsx` en Step 4. La couleur, les classes,
le layout : tous préservés du squelette Step 2.

> NB : la formule de label dans le squelette utilise déjà `t.hasWaiting`
> pour le dot + label, ce qui matche `deriveTopBarPillStatus` qui renvoie
> `'WAITING'` au même cas. Si on veut être plus rigoureux, on peut remplacer
> la cascade de `if (offline) … else if (hasWaiting) …` par un simple
> `switch (pill)` après avoir typé `TopBarTeam.pill: PillStatus`. C'est une
> refacto cosmétique optionnelle ; le binding fonctionne avec la formule
> actuelle. Suggestion : ajouter `pill: PillStatus` à `TopBarTeam` pour
> éviter la re-dérivation, et garder `hasWaiting` comme champ dérivé
> redondant pour la lisibilité du JSX. Voir §10.

---

## 6. Brand-sub live — tick 1 s sans fuite, sans re-render global

### 6.1 Choix d'architecture

Deux approches possibles pour faire vivre l'uptime à la seconde :

1. **Tick global dans `DesktopShell`** : un seul `setInterval(1000)` qui
   set un `now: number` state, propagé à la `TopBar` via `topBarInfo.uptime`.
   - Avantage : 1 timer total, simple.
   - **Inconvénient** : re-render de `DesktopShell` chaque seconde →
     **re-calcule `topBarTeams`** (useMemo n'aide pas si `orchestrators`
     a la même référence — il aidera, mais le shell se re-render quand
     même, et avec lui MapView + LeftPanel + RightPanel). Effet de bord
     possiblement coûteux sur la MapView (avec pulses animées).

2. **Tick local dans `TopBar`** : `useState(new Date())` interne à
   `TopBar.tsx` avec son propre `setInterval(1000)`. Seul `TopBar`
   re-render. C'est ce que fait le squelette Step 2 et c'est ce que fait
   le proto v2 (`app.jsx:48-52`).
   - Avantage : isolation. Re-render confiné à 56 px de header.
   - Inconvénient : `uptime` doit alors être recalculé **dans la TopBar**
     à partir de `info.started_at` brut, pas d'un `info.uptime` pré-cuit
     côté parent.

### 6.2 Décision

**Approche 2 (tick local dans `TopBar`).** Modifier la signature des props
`TopBarInfo` :

```ts
// Avant (Step 2 §3.16) :
export interface TopBarInfo {
  projectName: string;
  version: string;
  uptime: string;           // déjà formaté
}

// Après (Step 4) :
export interface TopBarInfo {
  projectName: string;
  version: string;
  startedAt: string | null;  // ISO du backend, formatage local
}
```

Et `TopBar.tsx` calcule `uptime` à chaque tick :

```tsx
// dans TopBar.tsx
import { formatClock, formatUptimeShort } from '../../lib/format';

export default function TopBar({ teams, info, ... }: Props) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);

  const uptime = info.startedAt ? formatUptimeShort(info.startedAt) : '—';
  // `now` est lu (implicitement via formatUptimeShort qui lit Date.now())
  // mais on l'expose comme dep effective pour signal d'intention :
  // void now; (no-op, juste pour que ESLint ne marque pas `now` unused)
  ...
}
```

Voilà la propriété recherchée : **seule la TopBar re-render à chaque seconde**.
`DesktopShell.tsx` ne tient PAS de `now` state ; il passe juste
`startedAt` (string ISO immuable tant que le backend tourne).

### 6.3 Garde-fous contre fuite

- `clearInterval` dans le cleanup du `useEffect` — déjà dans le squelette
  Step 2, vérifier qu'il y est.
- Pas de `setInterval` global hors composant.
- `formatUptimeShort` lit `Date.now()` à chaque appel ; le seul état React
  qui change est `now` (Date). Pas de risque d'accumuler des timers
  multiples car le `useEffect` a une dep array vide `[]` — il se monte
  une fois, se démonte une fois.

### 6.4 Recap

Ce changement (passer de `uptime: string` pré-cuit à `startedAt: string | null`)
**est** la modif principale du Step 4 sur `TopBar.tsx`. Combiné avec
l'usage de `formatMsgCount`, ce sont les 2 vraies diffs sur le composant ;
tout le reste vit dans `DesktopShell`.

---

## 7. Interactions

### 7.1 Boutons NEW / ROLES / cog → callbacks vers `DesktopShell`

Les props `onNewTeam`, `onOpenRoles`, `onOpenSettings` du `TopBar` ne
sont pas changées (existantes Step 2). En Step 4, `DesktopShell` les
implémente comme suit :

| Bouton | Handler dans `DesktopShell` | Effet | Composant ouvert (Phase C) |
|---|---|---|---|
| `+ NEW TEAM` | `() => setShowNew(true)` | flag local `showNew = true` | `NewOrchestratorDialog` (Step 9) |
| `ROLES` | `() => setShowRoles(true)` | flag local `showRoles = true` **ET** route hash `#/roles` via `onOpenRoles` prop remontée à `App.tsx` | `RolesPage` overlay (Step 10) |
| cog | `() => setShowSettings(true)` | flag local `showSettings = true` | `SettingsDrawer` (Step 11) |

En Step 4, **les composants overlays n'existent pas encore** (Phase C).
On câble juste les flags ; le rendu des overlays reste un commentaire
`{/* TODO Step 9 / 10 / 11 */}`. Les boutons sont fonctionnels (clic →
flag set), pas d'effet visuel hors clic (mais aussi : pas de régression).

### 7.2 Clic sur team-pill → `selectAgent(team.leadId)` + route

Détail dans §5.1, fonction `handleSelectTeam`. Récapitulé :

1. `setSelectedSessionId(leadSessionId)` — lifte la sélection dans
   `DesktopShell`, propagée au `RightPanel` (qui va l'ouvrir, Step 7).
2. `onOpenOrchestrator(orch.id)` — callback remonté à `App.tsx` qui fait
   `setRoute({ kind: 'detail', id })` → hash devient
   `#/orchestrators/:id` (Step 3 §6.2.4).

Edge case : si `orch.leadSessionId === null` (orch sans lead actif,
ce qui ne devrait pas arriver pour un orch actif mais peut survenir en
transitoire après création), le clic est **no-op** (`if (!leadSessionId) return;`
en début de handler). On peut afficher un cursor pas-allowed côté CSS, mais
ce n'est pas indispensable v1.

### 7.3 Effet de `flashTeamId`

`flashTeamId` n'est **pas** set en Step 4 (ça arrivera en Step 9 dans le
handler `onCreateTeam` du `NewOrchestratorDialog`). En Step 4 on prépare
juste le state (`const [flashTeamId, setFlashTeamId] = useState<string | null>(null);`)
et on le passe au `TopBar`. Aucun feedback visuel jusqu'à Phase C.

### 7.4 Aucun click handler sur la sub-line ou le brand

Le proto v2 ne fait rien de spécial au clic sur "SWARM·OS" ou la sub-line.
Step 4 idem.

---

## 8. Plan d'implémentation pas-à-pas

Ordre des modifs (chacune autonome, testable en intermédiaire) :

1. **Créer `packages/web/src/lib/topBarStatus.ts`** (cf. §3.1) avec
   `deriveTopBarPillStatus`, `pillDotClass`, `pillBarClass`,
   `derivePillBarPct`, type `PillStatus`. Test unitaire associé en §9.1
   (`topBarStatus.test.ts`).

2. **Étendre `packages/web/src/lib/format.ts`** avec `formatMsgCount`
   et `formatUptimeShort` (cf. §4.1 et §4.2). Garder l'existant
   (`formatUptime`, `formatRelative`, `formatClockShort`, `formatClock`,
   `pad`, `statusLabel`, `statusChipClass`). Test unitaire en §9.2.

3. **Modifier `packages/web/src/components/desktop/TopBar.tsx`** (2 diffs) :
   - changer `TopBarInfo.uptime: string` → `TopBarInfo.startedAt: string | null` ;
   - calculer `uptime` localement dans le composant via `formatUptimeShort(info.startedAt)`
     dans le render, en gardant le `useState(new Date())` + `setInterval(1000)` existant ;
   - remplacer la formule inline `t.msgCount > 999 ? ... : ...` par
     `formatMsgCount(t.msgCount)` (import depuis `lib/format`).
   - **Optionnel** (recommandé §10) : remplacer `hasWaiting?: boolean` par
     `pill: PillStatus` dans `TopBarTeam` et utiliser un switch propre.
     Si on garde la signature actuelle, c'est OK aussi — `deriveTopBarPillStatus`
     produit `'WAITING'` qui correspond à `hasWaiting = true`.

4. **Modifier `packages/web/src/components/desktop/DesktopShell.tsx`** :
   - importer `useOrchestrators`, `api`, `InfoView`, `OrchestratorView` ;
   - importer `deriveTopBarPillStatus`, `PillStatus` depuis `lib/topBarStatus` ;
   - importer `formatMsgCount`, `formatUptimeShort` (en réalité seul le
     binding `startedAt` est nécessaire ici, le format est dans TopBar) ;
   - ajouter le hook `useOrchestrators()` (déjà fait Step 3 — vérifier qu'il
     est encore là, sinon le réintroduire) ;
   - ajouter l'effect `api.info()` one-shot + refresh 60 s ;
   - construire `topBarTeams` via `useMemo` (cf. §5.1) ;
   - construire `totalAgents` via `useMemo` ;
   - construire `topBarInfo` simple object literal (pas besoin de useMemo
     car shallow et le coût est trivial — mais `useMemo` recommandé pour
     la stabilité de ref si TopBar a `React.memo`) ;
   - construire `selectedTeamId` via `useMemo` ;
   - ajouter `flashTeamId` state (init `null`, set viendra Phase C) ;
   - implémenter `handleSelectTeam` ;
   - passer toutes ces props au `<TopBar />` qui était déjà rendu (squelette
     avec props vides) ;
   - vérifier que les boutons (NEW/ROLES/cog) sont câblés sur les flags
     `setShowNew/Roles/Settings` (déjà fait Step 2 squelette — pas de
     nouveau composant à monter en Step 4).

5. **Vérifier `App.tsx`** : le bouton "Settings" du header inline (qui
   existait déjà avant la refonte) reste fonctionnel — il ne disparaît
   qu'au moment où la `SettingsDrawer` v2 sera complète (Phase C Step 11).
   En Step 4, la cog de la TopBar set juste `showSettings = true` dans
   `DesktopShell` mais ne monte rien — c'est cohérent avec Phase C en
   chantier. Donc rien à toucher dans `App.tsx`.

6. **Lancer la vérification** :
   ```bash
   cd packages/web
   pnpm tsc --noEmit
   pnpm build
   pnpm test
   ```

7. **Smoke test manuel** (cf. §9).

### 8.1 Diff size estimée

| Fichier | Type | Lignes ajoutées |
|---|---|---|
| `lib/topBarStatus.ts` | nouveau | ~85 |
| `lib/topBarStatus.test.ts` | nouveau | ~70 |
| `lib/format.ts` | edit | +35 |
| `lib/format.test.ts` | edit | +30 |
| `components/desktop/TopBar.tsx` | edit | +5 / -5 (signature props + 2 inline replacements) |
| `components/desktop/DesktopShell.tsx` | edit | +60 (binding) |

Total : ~285 lignes, dont ~150 de tests. Step compact, isolé, sans
modification du backend.

### 8.2 Risques

- **Risque 1** : `useOrchestrators()` est aussi appelé par d'autres
  composants ailleurs (LeftPanel viendra Step 5, MapView Step 6).
  Aujourd'hui c'est appelé 1 fois dans `OrchestratorList` (sera supprimé
  Step 3) et 1 fois dans le `DesktopShell` (Step 3 placeholder).
  **Garder un seul appel dans `DesktopShell`** et passer `orchestrators`
  en prop aux sous-composants — sinon on aurait N polls 3 s simultanés.
  Pour Step 4, l'unique appel est dans `DesktopShell` ; `TopBar` reçoit
  déjà des props pré-cuits.

- **Risque 2** : `info` qui n'arrive jamais (backend ne répond pas, ou
  token-free endpoint cassé). Affichage `'—'` partout — pas bloquant
  visuellement. Pas de retry agressif (le 60 s du `setInterval` couvre).

- **Risque 3** : `endedAt != null` filter. Aujourd'hui `useOrchestrators`
  renvoie la liste complète (actifs + history). Si on n'exclut pas les
  ended dans `topBarTeams`, on aura des pills OFFLINE pour des orchs
  historiques — pollue la TopBar. **Filtrer explicitement**
  `o.endedAt == null` dans le `useMemo`.

- **Risque 4** : le re-render à chaque tick 1 s **dans TopBar**.
  Re-calcule tous les pills à chaque seconde même si rien n'a changé. C'est
  acceptable (5-10 pills, du SVG inline trivial). Si profilé comme
  bottleneck plus tard, mémoïser chaque pill via `React.memo` sur un
  sous-composant `TeamPill`. Pas une priorité v1.

---

## 9. Tests de fumée

### 9.1 Unit tests `topBarStatus.test.ts`

Couvrir toutes les branches de `deriveTopBarPillStatus`. Squelette :

```ts
import { describe, it, expect } from 'vitest';
import { deriveTopBarPillStatus, type PillStatus } from './topBarStatus';
import type { OrchestratorView, SessionView } from '../api/client';

function mkOrch(p: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1', name: 'team-x', role: 'BUILDER', roleId: null,
    status: 'running', leadSessionId: 's1',
    defaultModel: 'opus', defaultEffort: 'medium', defaultPermissionMode: 'default',
    leadPreamble: null, workerPreamble: null,
    createdAt: '2026-01-01T00:00:00Z', endedAt: null, lastError: null,
    sessions: [], msgCount: 0, health: 'ok',
    ...p,
  };
}
function mkSession(status: SessionView['status']): SessionView {
  return {
    id: 's1', orchestratorId: 'o1', name: 'lead', role: 'ORCHESTRATOR',
    type: 'lead', cwd: '/tmp', model: 'opus', effort: 'medium',
    permissionMode: 'default', status, pid: 1, startedAt: 'now',
    endedAt: null, exitCode: null, lastError: null, stopReason: null,
    logPath: '/log', lastActivityAt: 'now',
  };
}

describe('deriveTopBarPillStatus', () => {
  it('OFFLINE when health === "stopped"', () => {
    expect(deriveTopBarPillStatus(mkOrch({ health: 'stopped' }))).toBe<PillStatus>('OFFLINE');
  });
  it('BAD when health === "bad"', () => {
    expect(deriveTopBarPillStatus(mkOrch({ health: 'bad' }))).toBe<PillStatus>('BAD');
  });
  it('WAITING when any session is waiting (overrides STARTING/DEGRADED/HEALTHY)', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'starting', health: 'warn',
      sessions: [mkSession('running'), mkSession('waiting')],
    }))).toBe<PillStatus>('WAITING');
  });
  it('STARTING when orch.status === "starting" and no waiting session', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'starting', sessions: [mkSession('starting')],
    }))).toBe<PillStatus>('STARTING');
  });
  it('DEGRADED when health === "warn" and no waiting session', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'running', health: 'warn', sessions: [mkSession('running')],
    }))).toBe<PillStatus>('DEGRADED');
  });
  it('HEALTHY when health === "ok" and no waiting session', () => {
    expect(deriveTopBarPillStatus(mkOrch({
      status: 'running', health: 'ok', sessions: [mkSession('running')],
    }))).toBe<PillStatus>('HEALTHY');
  });
  it('OFFLINE takes priority over BAD if both possible', () => {
    // (impossible en réalité car health est exclusif, mais test défensif)
    expect(deriveTopBarPillStatus(mkOrch({ health: 'stopped' }))).toBe<PillStatus>('OFFLINE');
  });
});
```

### 9.2 Unit tests `format.test.ts` (extensions Step 4)

```ts
import { describe, it, expect } from 'vitest';
import { formatMsgCount, formatUptimeShort } from './format';

describe('formatMsgCount', () => {
  it('returns "0" for 0', () => expect(formatMsgCount(0)).toBe('0'));
  it('returns plain int below threshold', () => {
    expect(formatMsgCount(42)).toBe('42');
    expect(formatMsgCount(999)).toBe('999');
  });
  it('formats Nk above 999', () => {
    expect(formatMsgCount(1000)).toBe('1.0k');
    expect(formatMsgCount(1234)).toBe('1.2k');
    expect(formatMsgCount(12345)).toBe('12.3k');
    expect(formatMsgCount(999_999)).toBe('1000.0k');  // boundary
  });
  it('formats NM above 999_999', () => {
    expect(formatMsgCount(1_000_000)).toBe('1.0M');
  });
  it('handles non-finite gracefully', () => {
    expect(formatMsgCount(NaN)).toBe('0');
    expect(formatMsgCount(-5)).toBe('0');
  });
});

describe('formatUptimeShort', () => {
  it('returns "—" for null/undefined/invalid', () => {
    expect(formatUptimeShort(null)).toBe('—');
    expect(formatUptimeShort(undefined)).toBe('—');
    expect(formatUptimeShort('not-a-date')).toBe('—');
  });
  it('returns "0m" for < 1 min', () => {
    expect(formatUptimeShort(Date.now() - 30_000)).toBe('0m');
  });
  it('returns "Xm" for minutes only', () => {
    expect(formatUptimeShort(Date.now() - 15 * 60_000)).toBe('15m');
  });
  it('returns "Xh Ym" for hours + minutes', () => {
    expect(formatUptimeShort(Date.now() - (3 * 60 + 25) * 60_000)).toBe('3h 25m');
  });
  it('returns "Xd Yh" beyond 24h', () => {
    expect(formatUptimeShort(Date.now() - (2 * 24 + 5) * 3600_000)).toBe('2d 5h');
  });
});
```

### 9.3 Smoke test manuel (browser)

Workflow Docker recommandé (cf. mémoire utilisateur — Docker redeploy
workflow) :

```bash
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
# puis ouvrir http://localhost:8080 (ou port configuré) avec token valide
```

**Checklist visuelle** :

- [ ] Au boot, la TopBar affiche brand "SWARM·OS" + sub-line
      `<project_name> · v<version> · Xm up`.
- [ ] L'uptime s'incrémente toutes les secondes (passe de `0m` à `1m` au
      bout de 60s sans recharger).
- [ ] L'horloge à droite tick chaque seconde au format `HH:MM:SS`.
- [ ] Si 0 orchestrator actif : aucune pill, mais brand + sub + clock OK.
- [ ] Après `POST /orchestrators` (via curl ou Phase C dialog) : nouvelle
      pill apparaît dans les 3 s (poll cadence). Statut `STARTING`.
- [ ] Quand l'orch passe en `running` côté serveur : pill bascule sur
      `HEALTHY`, barre verte à 85%.
- [ ] Si on force un worker en `waiting` (envoyer un PTY prompt qui
      attend confirmation) : pill bascule sur `WAITING`, dot orange,
      petit `●` à côté du nom de la team.
- [ ] Si on stoppe l'orch (`DELETE /orchestrators/:id`) : pill bascule sur
      `OFFLINE` puis disparaît au cycle suivant (filter `endedAt != null`).
- [ ] Clic sur une pill : URL devient `#/orchestrators/:id`, la pill
      reçoit la classe `.active`. (Step 7 ouvrira le RightPanel sur le lead
      — pour Step 4 il suffit de vérifier la route.)
- [ ] Clic sur `+ NEW TEAM` : pas de visuel encore (Phase C Step 9), mais
      `console.log` du flag `showNew = true` (insérer un `useEffect`
      d'observation pour valider).
- [ ] Clic sur `ROLES` : idem (Phase C Step 10).
- [ ] Clic sur cog : idem (Phase C Step 11).
- [ ] "N AGENTS" à droite : somme correcte de tous les `sessions.length`.

**Pour tester WAITING sans dispositif manuel** : injecter via console
navigateur :

```js
// dans la DevTools console, après auth :
fetch('/orchestrators', { headers: {'X-Auth-Token': localStorage.getItem('swarm-os.token')} })
  .then(r => r.json()).then(console.log);
```

ou utiliser un seed mock côté backend.

### 9.4 Smoke unitaire (no-mock)

Le composant `TopBar` lui-même reste testable en isolation avec
`@testing-library/react` (renderer minimal). Squelette `TopBar.test.tsx` :

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TopBar, { type TopBarTeam, type TopBarInfo } from './TopBar';

const info: TopBarInfo = {
  projectName: 'swarm-fyrel',
  version: 'v1.0.3',
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const team: TopBarTeam = {
  id: 'a', name: 'team-a', purpose: 'BUILDER', leadId: 'sa',
  workerCount: 2, msgCount: 1234, status: 'running', health: 'ok',
  hasWaiting: false,
};

describe('TopBar', () => {
  it('renders brand, version and uptime', () => {
    render(<TopBar
      teams={[team]}
      totalAgents={3}
      info={info}
      onSelectTeam={() => {}}
      onNewTeam={() => {}}
      onOpenRoles={() => {}}
      onOpenSettings={() => {}}
    />);
    expect(screen.getByText('swarm-fyrel')).toBeInTheDocument();
    expect(screen.getByText(/v1\.0\.3/)).toBeInTheDocument();
    expect(screen.getByText(/5m up/)).toBeInTheDocument();
    expect(screen.getByText('team-a')).toBeInTheDocument();
    expect(screen.getByText('1.2k msg')).toBeInTheDocument();
    expect(screen.getByText('3 agt')).toBeInTheDocument(); // 1 lead + 2 workers
    expect(screen.getByText('3 AGENTS')).toBeInTheDocument();
  });

  it('shows waiting flag when hasWaiting is true', () => {
    render(<TopBar
      teams={[{ ...team, hasWaiting: true }]}
      totalAgents={3} info={info}
      onSelectTeam={() => {}} onNewTeam={() => {}}
      onOpenRoles={() => {}} onOpenSettings={() => {}}
    />);
    // le marqueur waiting est un span `●` à côté du nom
    expect(screen.getByTitle('agent waiting for human input')).toBeInTheDocument();
    expect(screen.getByText('WAITING')).toBeInTheDocument();
  });
});
```

---

## 10. Refacto optionnelle — typer `TopBarTeam.pill: PillStatus`

Pour réduire la duplication entre `deriveTopBarPillStatus` (Shell) et la
cascade `if (offline) ... else if (hasWaiting) ...` (TopBar), il est
recommandé de :

- ajouter `pill: PillStatus` à `TopBarTeam` ;
- supprimer `hasWaiting?: boolean` (déduisible de `pill === 'WAITING'`) ;
- remplacer la cascade dans `TopBar.tsx` par un `switch (t.pill)` qui
  set `dotCls` + `label` + `barCls` (via `pillDotClass`, `pillBarClass`).

Diff suggérée du `TopBarTeam` :

```ts
export interface TopBarTeam {
  id: string;
  name: string;
  purpose: string;
  leadId: string;
  workerCount: number;
  msgCount: number;
  pill: PillStatus;          // ← nouveau, source de vérité unique
  // status: string;          // ← optionnel, plus nécessaire si on a `pill`
  // health: ...;             // ← idem
  // hasWaiting?: boolean;    // ← supprimé
}
```

et dans `TopBar.tsx` :

```tsx
{teams.map((t) => {
  const dotCls = pillDotClass(t.pill);
  const barCls = pillBarClass(t.pill);
  const barPct = derivePillBarPct(t.pill);
  const showWaitingFlag = t.pill === 'WAITING';
  return (
    <div className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ...`}>
      ...
      <span className="pill-status">
        <span className={`dot ${dotCls}`} />
        {t.pill}        {/* HEALTHY | WAITING | STARTING | DEGRADED | OFFLINE | BAD */}
      </span>
      ...
      <div className="pill-bar">
        <i className={barCls} style={{ width: `${barPct}%` }} />
      </div>
      ...
    </div>
  );
})}
```

Cette refacto est **recommandée** mais pas indispensable au Step 4 ; on
peut la faire dans la PR Step 4 ou la pousser en pré-PR Step 5/6 quand
les autres consommateurs de `useOrchestrators` arrivent et que le mapping
sera de plus en plus partagé. À l'arbitrage de l'implémenteur.

---

## 11. Récapitulatif — surface modifiée

| Fichier | Nature | Pourquoi |
|---|---|---|
| `packages/web/src/lib/topBarStatus.ts` | **nouveau** | Source de vérité du mapping orch → pill (6 valeurs) |
| `packages/web/src/lib/topBarStatus.test.ts` | **nouveau** | Couverture des 6 branches |
| `packages/web/src/lib/format.ts` | edit (extensions) | `formatMsgCount`, `formatUptimeShort` |
| `packages/web/src/lib/format.test.ts` | edit (extensions) | Tests des deux helpers |
| `packages/web/src/components/desktop/TopBar.tsx` | edit | `startedAt` au lieu de `uptime`, utilise `formatMsgCount` |
| `packages/web/src/components/desktop/DesktopShell.tsx` | edit | Hooks + binding + props passées au `<TopBar />` |

Aucun fichier supprimé. Aucun fichier serveur touché.

---

## 12. Annexe — Référence des lignes source

| Élément | Fichier source | Lignes |
|---|---|---|
| `TopBar` proto v2 (JSX + formule pill) | `prototypes/v2/app.jsx` | 43-130 |
| Formule `health === 'warn' ? 0.6 : 0.85` (pill-bar) | `prototypes/v2/app.jsx` | 82 |
| Formule `t.msgCount > 999 ? Nk : N` | `prototypes/v2/app.jsx` | 105 |
| `formatClock` proto | `prototypes/v2/app.jsx` | 37-40 |
| `formatUptime` proto (Xh Xm style) | `prototypes/v2/data.jsx` | 459-481 |
| `useOrchestrators` hook (3 s poll) | `packages/web/src/hooks/useOrchestrators.ts` | 1-56 |
| `api.info()` / `api.health()` REST | `packages/web/src/api/client.ts` | 189-192 |
| Types `OrchestratorView.health` (S7) | `packages/web/src/api/client.ts` | 40-48 |
| Types `SessionView.status` (8 valeurs) | `packages/web/src/api/client.ts` | 84-92 |
| `mapOrchestratorStatusToVisual` (référence, **non utilisé** ici) | `packages/web/src/lib/sessionStatus.ts` | 101-123 |
| Plan global TopBar | `docs/ui-redesign-desktop.md` | §3.1, §5.1 step 4 |
| Squelette TopBar (Step 2) | `docs/redesign-desktop/02_desktop-skeleton.md` | §3.16 |

— FIN du document analyse Step 4 —
