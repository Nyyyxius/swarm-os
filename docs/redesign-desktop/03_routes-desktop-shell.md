# Step 3 — Wire `DesktopShell` behind hash routes

> Phase A.3 du plan `docs/ui-redesign-desktop.md` (§5.1, étape 3 et §5.2 du
> tableau "Composants à supprimer / réécrire"). Cette étape clôt la mise en
> place du squelette desktop : `DesktopShell` (créé en A.2) devient l'écran
> principal et remplace `OrchestratorList`. La RolesPage reste accessible en
> overlay, et le deep-link `#/orchestrators/:id` pré-sélectionne le lead
> correspondant.

---

## 1. Objectif

Brancher `DesktopShell` derrière la route `#/`, conserver
`#/orchestrators/:id` comme alias qui ouvre la même grille mais avec un
`selectedSessionId` initialisé sur le lead de l'orchestrator demandé, et
conserver `#/roles` comme overlay plein écran (`RolesPage`) ouvrable aussi
depuis le bouton **ROLES** de la `TopBar`. Supprimer `OrchestratorList` du
graphe de rendu ; conserver `OrchestratorView` momentanément (mort, non
référencé) si besoin pour comparer en cours de migration, sinon supprimer
directement.

---

## 2. Routing actuel (`packages/web/src/App.tsx`)

### 2.1 Modèle de route

```ts
type Route = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'roles' };
```

- Parsing dans `parseHash()` (lignes 25-31). Trois patterns :
  - `#/orchestrators/<id>` (regex `/^#\/orchestrators\/([a-zA-Z0-9-]+)$/`) → `{ kind: 'detail', id }`
  - `#/roles` (égalité stricte) → `{ kind: 'roles' }`
  - reste (`#/`, vide, etc.) → `{ kind: 'list' }`
- Sérialisation `setHashRoute(route)` (lignes 33-41) : compose la chaîne et
  l'assigne à `window.location.hash` **seulement si elle diffère** (évite
  les rerenders en boucle).

### 2.2 État `route` (App.tsx)

- `useState<Route>(() => parseHash())` (ligne 44) — init au boot depuis le
  hash courant.
- `useEffect([route])` (ligne 86-88) — applique `setHashRoute(route)`
  à chaque changement d'état → garde le hash sync.
- `useEffect([])` (lignes 90-96) — écoute `hashchange` (back/forward
  browser) et fait `setRoute(parseHash())`.

### 2.3 Où chaque composant est monté

Bloc `<main>` (lignes 183-194) :

| Route | Composant monté | Props |
|---|---|---|
| `list` | `OrchestratorList` | `onSelect={(id) => setRoute({ kind: 'detail', id })}` |
| `roles` | `RolesPage` | aucune |
| `detail` | `OrchestratorView` | `orchestratorId={route.id}`, `onBack={() => setRoute({ kind: 'list' })}` |

Globaux hors `<main>` :

- Header inline (lignes 100-133) : brand + info + health + boutons
  Orchestrators / Roles / Settings. Les boutons appellent
  `setRoute({ kind: 'list' | 'roles' })` directement.
- Settings drawer inline (lignes 135-181) : panneau token + warning
  `authState`.
- `NotificationPanel` (lignes 196-198) : monté toujours, reçoit
  `onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}`.

### 2.4 État annexe à conserver hors routing

`App.tsx` porte aussi : `token`, `showSettings`, `health`, `info`,
`authState`, `probeAuth()`. Ces états ne sont **pas liés au routing** —
ils survivront tels quels (la TopBar v2 et le SettingsDrawer v2
consommeront ces mêmes valeurs en B/C). Step 3 ne les touche pas.

---

## 3. Routing cible

### 3.1 Mêmes 3 routes, sémantique légèrement différente

Le type `Route` reste identique. La table de montage change :

| Route | Composant monté | Comportement |
|---|---|---|
| `list` (`#/`) | `DesktopShell` | RightPanel **fermé** (selectedSessionId === null) |
| `detail` (`#/orchestrators/:id`) | `DesktopShell` | RightPanel **ouvert** sur le lead de l'orchestrator `:id` |
| `roles` (`#/roles`) | `DesktopShell` + overlay `RolesPage` au-dessus | grille en arrière-plan, overlay plein écran |

Le `parseHash()` et `setHashRoute()` sont **inchangés** — c'est uniquement
la couche de rendu qui mute.

### 3.2 Pré-sélection du lead à partir de `:id`

Le hash `#/orchestrators/:id` référence un **orchestratorId** (le champ
`OrchestratorView.id`), pas un sessionId. La `MapView` et la `RightPanel`
travaillent au niveau **sessionId** (cf. `selectedId` dans
`prototypes/v2/app.jsx`). Il faut donc dériver le sessionId du lead à partir
de l'orchestratorId :

1. `DesktopShell` poll déjà `useOrchestrators()` (déjà fait en B.4) →
   liste `OrchestratorView[]`.
2. Dériver `leadSessionId` : `orchestrators.find(o => o.id === route.id)?.leadSessionId`.
3. Lift l'état `selectedSessionId: string | null` au niveau de
   `DesktopShell` (voir §6.3).
4. **Une fois** la liste chargée et la route changée, si
   `route.kind === 'detail'` et `selectedSessionId !== leadSessionId`,
   appeler `setSelectedSessionId(leadSessionId ?? null)`.
5. Ne **pas** boucler : ce setter ne doit pas réécrire le hash (sinon
   on récrée une boucle hashchange ↔ state). Voir §3.4.

Cas particuliers à gérer :

- **Orchestrator non trouvé** (id inconnu, ou pas encore arrivé par le poll
  3 s) : `leadSessionId` undefined → ne pas ouvrir le RightPanel ; afficher
  la grille seule. À mesure que le poll revient, la pré-sélection se fera
  automatiquement.
- **Orchestrator terminé** (`endedAt != null`) : on ouvre quand même le
  RightPanel, mais le `Composer` devra être désactivé en mode read-only
  (logique déjà prévue en §3.2 du plan global, hors scope step 3).

### 3.3 Ouverture / fermeture de la RolesPage overlay

Deux entrées possibles :

1. Bouton **ROLES** dans la `TopBar` (clic UI) → `setRoute({ kind: 'roles' })`
   → hash devient `#/roles`.
2. Navigation directe `#/roles` (URL collée) → `parseHash` retourne
   `{ kind: 'roles' }` au boot.

Sortie :

- Bouton **×** ou **back** dans le header de la RolesPage overlay →
  `setRoute({ kind: 'list' })` (retour à la grille pure).
- Si l'utilisateur clique sur un team-pill / un node depuis la grille en
  arrière-plan, ce serait `setRoute({ kind: 'detail', id })`. **À éviter
  en step 3** : l'overlay est plein écran, donc les clics sous l'overlay
  ne sont normalement pas accessibles. Si on garde un `pointer-events`
  permissif, documenter le comportement (préférer bloquer).

`RolesPage` (l'overlay v2) sera porté en C.10 du plan global. En step 3,
on consomme la version actuelle (`packages/web/src/components/RolesPage.tsx`)
**telle quelle** — c'est juste un composant plein page. On le rendra
au-dessus de `DesktopShell` via un wrapper :

```tsx
{route.kind === 'roles' && (
  <div className="fixed inset-0 z-50 bg-slate-950 overflow-y-auto">
    <RolesPage />
    {/* TODO step C.10 : remplacer par overlay v2 avec bouton close */}
  </div>
)}
```

Important : en step 3, **rendre la RolesPage actuelle ainsi est suffisant**.
Le polish overlay (animation, bouton close stylisé) vient en C.10.

### 3.4 Garde-fou contre boucle hashchange ↔ state

Le pattern actuel d'`App.tsx` est sûr : `setHashRoute` compare avant
écriture, et `parseHash` est déterministe. **Le ré-utiliser inchangé**.

L'état nouveau `selectedSessionId` (lifté dans `DesktopShell`) **ne doit
pas être stocké dans le hash** en step 3 (le prototype v2 ne le fait pas
non plus). Conséquences :

- Refresh sur `#/orchestrators/:id` → pré-sélection du lead.
- Clic sur un worker dans la map → met à jour `selectedSessionId` local,
  **ne change pas le hash**.
- Clic sur un autre team-pill dans la TopBar → on peut soit garder le
  hash sur `:id` du lead (cohérent avec le prototype v2 qui fait
  `setHashRoute({ kind: 'detail', id: team.id })`), soit garder
  `selectedSessionId` local. **Recommandation step 3** : on synchronise
  le hash sur l'orchestrator du lead sélectionné, comme aujourd'hui, ainsi
  un share-link `#/orchestrators/:id` reste l'orchestrator-de-référence.

---

## 4. Migration progressive

### 4.1 Suppression de `OrchestratorList`

`OrchestratorList` n'est utilisé **qu'à un seul endroit** :
`App.tsx:185`. Aucun test ne l'instancie (`grep -r "OrchestratorList"`
remonte uniquement l'import dans `App.tsx` et le fichier source lui-même).

Plan :

1. Supprimer l'import `import { OrchestratorList } from './components/OrchestratorList';` dans `App.tsx`.
2. Supprimer le rendu conditionnel ligne 184-186.
3. **Supprimer le fichier** `packages/web/src/components/OrchestratorList.tsx`
   à la fin de step 3 (après que les tests Vitest passent toujours et
   qu'un smoke navigation passe).

### 4.2 Statut de `OrchestratorView`

`OrchestratorView` est utilisé à un seul endroit : `App.tsx:188-193`.
Aucun test ne le monte.

Question posée : **faut-il le garder en fallback temporaire ?**

**Recommandation : NON.** Raisons :

- `DesktopShell` doit absorber sa fonctionnalité (sessions list → map,
  Terminal → tab CONSOLE, BroadcastBar → composer du RightPanel). Garder
  les deux côte-à-côte créerait deux sources de vérité pour
  l'orchestrator-detail UX.
- `OrchestratorView` a un `useEffect` qui polle `getOrchestrator(:id)`
  toutes les 2 s ; le garder monté en parallèle de `useOrchestrators()`
  (qui polle 3 s sur la liste complète) gaspille de la bande passante
  serveur.
- Personne ne le référence en dehors de `App.tsx`.

**Toutefois** : si la `DesktopShell` n'est pas complètement câblée en
fin de step 3 (Phase B/C pas encore livrés), on perd la capacité de
piloter une session via Terminal. **Compromis pragmatique** :

- En step 3 strict : on supprime `OrchestratorView` du graphe (sortie
  d'`App.tsx`) **mais on garde le fichier sur disque** pour pouvoir
  copier-coller des morceaux (Terminal binding, inbox polling, etc.) en
  Phase B.7.
- Une fois les Phases B+C livrées et fonctionnelles, supprimer
  `packages/web/src/components/OrchestratorView.tsx` et
  `packages/web/src/components/BroadcastBar.tsx` (utilisé uniquement
  par `OrchestratorView`).

Autres composants à NE PAS supprimer en step 3 :

- `Terminal.tsx` : indispensable, sera re-monté dans la tab CONSOLE du
  `RightPanel` (Phase B.7).
- `NewOrchestratorDialog.tsx` : reste utilisé par `OrchestratorList`
  aujourd'hui et le sera par `TopBar.NEW TEAM` (Phase B/C). Une version
  v2 le remplacera, mais en step 3 on garde l'actuel.
- `RoleDialog.tsx` : référencé par `RolesPage.tsx`. Intact en step 3.
- `NotificationPanel.tsx` : sera remplacé par `Toasts.tsx` en Phase B.8.
  En step 3 on **garde** son rendu global dans `App.tsx` (cf. §6.4),
  pour ne pas régresser sur les toasts pendant la transition.

### 4.3 Header inline d'`App.tsx`

Le header inline (`<header>` lignes 100-133) doublonne ce que fera la
`TopBar` v2 (déjà créée en step A.2, à câbler en B.4). En step 3 strict,
on a deux options :

- **(a) Conserver le header inline** : sécurise les boutons Settings et
  les indicateurs `info`/`health` jusqu'à ce que la TopBar v2 soit
  pleinement câblée (B.4). Le `DesktopShell` rend alors la **grille
  v2 (TopBar v2 + LeftPanel + MapView + RightPanel)** _en dessous_ du
  header inline → on aura deux barres horizontales superposées pendant
  la transition.
- **(b) Retirer le header inline** : déléguer entièrement à la `TopBar`
  v2 (interne au `DesktopShell`). Settings est inaccessible jusqu'à
  ce que le SettingsDrawer (Phase C.11) soit câblé.

**Recommandation : (a) pendant step 3**, puis basculer en (b) une fois
B.4 + C.11 livrés. C'est la migration progressive la plus sûre : on
n'enlève pas la capacité de saisir un token. Documenter qu'on aura
visuellement deux headers pendant 1-2 PRs.

### 4.4 Settings drawer inline

Idem : le bloc settings (lignes 135-181) sera porté en C.11 dans
`SettingsDrawer`. En step 3, on le **laisse en place** — c'est la seule
façon pour l'opérateur de saisir / corriger le token jusqu'à C.11.

---

## 5. Effet de bord sur les tests

Inventaire `find packages/web -name "*.test.*"` :

```
src/components/StatusBadge.test.tsx
src/components/NewOrchestratorDialog.test.tsx
src/api/client.test.ts
src/lib/loadPercent.test.ts
src/lib/sessionStatus.test.ts
src/lib/mailBubble.test.ts
src/lib/useNow.test.ts
src/lib/messageStats.test.ts
```

- **Aucun test ne monte `App.tsx`** (vérifié : `grep -rn "from '.*App'\|from \"./App\"" packages/web/src` retourne 0 résultat hors `main.tsx`).
- **Aucun test ne monte `OrchestratorList`, `OrchestratorView`, `RolesPage`**.
- `messageStats.test.ts` importe uniquement le **type** `OrchestratorView`
  depuis `api/client` (pas le composant). Aucun impact.

→ **Conclusion : aucun test à modifier en step 3.** Lancer
`pnpm --filter @swarm-os/web test` après les modifs doit rester vert sans
intervention.

À noter pour les steps futurs :

- Quand la `DesktopShell` aura ses propres tests (smoke navigation, ouverture
  RightPanel sur `#/orchestrators/:id`, etc.), les ajouter dans
  `src/components/desktop/`.
- `NewOrchestratorDialog.test.tsx` reste valide car le composant est inchangé.
  Si on le remplace en C.9, mettre à jour les selectors à ce moment-là.

---

## 6. Plan d'implémentation pas-à-pas

### 6.1 Pré-requis

`DesktopShell` doit déjà exister à `packages/web/src/components/desktop/DesktopShell.tsx`
(livré par step A.2). Si ce n'est pas le cas, step 3 doit attendre, ou
inclure la création d'un squelette minimal :

```tsx
// packages/web/src/components/desktop/DesktopShell.tsx
import { useState, useEffect } from 'react';
import { useOrchestrators } from '../../hooks/useOrchestrators';

interface Props {
  /** Orchestrator id from #/orchestrators/:id, or null on #/ */
  routeOrchestratorId: string | null;
  /** Sync hash when user picks a different team */
  onOpenOrchestrator: (id: string) => void;
  /** Sync hash to #/ when user closes the RightPanel */
  onCloseRightPanel: () => void;
}

export function DesktopShell({
  routeOrchestratorId,
  onOpenOrchestrator,
  onCloseRightPanel,
}: Props) {
  const { orchestrators } = useOrchestrators();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Pre-select the lead when the route points to a specific orchestrator.
  useEffect(() => {
    if (!routeOrchestratorId) {
      setSelectedSessionId(null);
      return;
    }
    const orch = orchestrators.find((o) => o.id === routeOrchestratorId);
    if (orch?.leadSessionId) {
      setSelectedSessionId(orch.leadSessionId);
    }
  }, [routeOrchestratorId, orchestrators]);

  // Placeholder until TopBar / LeftPanel / MapView / RightPanel are wired (B).
  return (
    <div className="grid grid-cols-[320px_1fr_380px] grid-rows-[56px_1fr] h-full">
      {/* TopBar (B.4) */}
      <div className="col-span-3 border-b border-slate-800 px-3 flex items-center">
        <span className="text-xs text-slate-400 font-mono">
          desktop shell — {orchestrators.length} orchestrator(s)
        </span>
      </div>
      {/* LeftPanel (B.5) */}
      <aside className="border-r border-slate-800 p-2 text-xs text-slate-500">
        LeftPanel TODO
      </aside>
      {/* MapView (B.6) */}
      <main className="p-2 text-xs text-slate-500">MapView TODO</main>
      {/* RightPanel (B.7) — open when selectedSessionId != null */}
      <aside
        className={`border-l border-slate-800 p-2 text-xs text-slate-500 transition-transform ${
          selectedSessionId ? '' : 'translate-x-full'
        }`}
      >
        {selectedSessionId ? (
          <>
            RightPanel TODO — session {selectedSessionId}
            <button
              className="block mt-2 text-amber-400 underline"
              onClick={() => {
                setSelectedSessionId(null);
                onCloseRightPanel();
              }}
            >
              close
            </button>
          </>
        ) : (
          'no selection'
        )}
      </aside>
    </div>
  );
}
```

Ce squelette est un placeholder. Il satisfait l'objectif de step 3 (route
câblée, pré-sélection live, callbacks vers App). Les phases B/C
remplaceront chaque sous-bloc.

### 6.2 Modifications dans `packages/web/src/App.tsx`

#### 6.2.1 Imports (lignes 1-13)

**Supprimer :**

```ts
import { OrchestratorList } from './components/OrchestratorList';
import { OrchestratorView } from './components/OrchestratorView';
```

**Ajouter :**

```ts
import { DesktopShell } from './components/desktop/DesktopShell';
```

**Conserver** : `RolesPage`, `NotificationPanel`, `api`, `getToken`,
`setToken`, `HttpError`, types `HealthView` / `InfoView`.

#### 6.2.2 Type `Route` (ligne 15)

**Inchangé** :

```ts
type Route = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'roles' };
```

Les fonctions `parseHash()` et `setHashRoute()` (lignes 25-41) restent
**inchangées**.

#### 6.2.3 State App (lignes 43-54)

Inchangé. Le state `selectedSessionId` est **lifté dans `DesktopShell`**,
pas dans `App` (voir §6.1).

#### 6.2.4 Bloc `<main>` (lignes 183-194)

Avant :

```tsx
<main className="flex-1 p-4 min-h-0">
  {route.kind === 'list' && (
    <OrchestratorList onSelect={(id) => setRoute({ kind: 'detail', id })} />
  )}
  {route.kind === 'roles' && <RolesPage />}
  {route.kind === 'detail' && (
    <OrchestratorView
      orchestratorId={route.id}
      onBack={() => setRoute({ kind: 'list' })}
    />
  )}
</main>
```

Après :

```tsx
<main className="flex-1 min-h-0 relative">
  <DesktopShell
    routeOrchestratorId={route.kind === 'detail' ? route.id : null}
    onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}
    onCloseRightPanel={() => {
      if (route.kind === 'detail') setRoute({ kind: 'list' });
    }}
  />
  {route.kind === 'roles' && (
    <div className="fixed inset-0 z-50 bg-slate-950 overflow-y-auto p-4">
      <div className="flex justify-end mb-2">
        <button
          className="px-3 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600"
          onClick={() => setRoute({ kind: 'list' })}
        >
          Close
        </button>
      </div>
      <RolesPage />
    </div>
  )}
</main>
```

Notes :

- Le `p-4` du `<main>` est retiré : `DesktopShell` gère son propre layout
  (grille pleine hauteur, padding interne par panel).
- `relative` ajouté pour que les overlays internes éventuels du
  `DesktopShell` puissent se positionner correctement. Le `fixed inset-0`
  de la RolesPage reste sur le viewport (pas affecté par `relative`).
- L'overlay `RolesPage` step 3 = un wrapper sombre simple avec bouton
  Close. C.10 le remplacera par l'overlay v2 stylé.

#### 6.2.5 Boutons header (lignes 113-132)

Le bouton "Orchestrators" (lignes 114-119) appelle
`setRoute({ kind: 'list' })`. En step 3, ce comportement reste valide
mais devient sémantiquement "fermer le RightPanel et revenir à la grille
vide". On peut **garder le bouton tel quel** (label inchangé) ou le
renommer ; pour minimiser la diff, **garder tel quel**. La sélection
visuelle `route.kind === 'list'` reste correcte.

Le bouton "Roles" (lignes 120-125) : inchangé.
Le bouton "Settings" (lignes 126-131) : inchangé.

#### 6.2.6 `NotificationPanel` (lignes 196-198)

**Conserver tel quel.** Le callback `onOpenOrchestrator` fait déjà
`setRoute({ kind: 'detail', id })` — c'est exactement ce qu'on veut.

### 6.3 État `selectedSessionId` lifté dans `DesktopShell`

Voir squelette §6.1. Points-clés :

1. `useState<string | null>(null)` à l'init.
2. `useEffect([routeOrchestratorId, orchestrators])` : quand la route ou
   la liste change, recalculer le lead à pré-sélectionner.
3. Quand l'utilisateur clique sur un node (futur MapView) ou un team-pill
   (futur TopBar) :
   - Mettre à jour `selectedSessionId` local.
   - Appeler `onOpenOrchestrator(orch.id)` pour synchroniser le hash.
4. Quand l'utilisateur ferme le RightPanel (bouton ×) :
   - Mettre à jour `selectedSessionId = null` local.
   - Appeler `onCloseRightPanel()` → `App` repasse la route à `list`.

### 6.4 Suppression d'`OrchestratorList`

Une fois `App.tsx` modifié et les tests verts :

```bash
git rm packages/web/src/components/OrchestratorList.tsx
```

Vérifier qu'aucune référence ne reste :

```bash
grep -rn "OrchestratorList" packages/web/src/
```

(devrait retourner 0 résultat).

### 6.5 Sort d'`OrchestratorView.tsx` et `BroadcastBar.tsx`

**Step 3** : on retire `OrchestratorView` de l'import dans `App.tsx`
mais on **garde les fichiers sur disque** pour copy-paste futur.

**Plus tard** (après Phase B.7 livrée) :

```bash
git rm packages/web/src/components/OrchestratorView.tsx
git rm packages/web/src/components/BroadcastBar.tsx
```

(à scoper hors step 3).

### 6.6 Build & docker redeploy

D'après la mémoire utilisateur (`project_docker_redeploy.md`) : code → image
→ stack.

```bash
cd /home/ubuntu/projets/swarm-os
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
```

(à exécuter uniquement si on veut tester contre un backend live ; le dev
front Vite seul suffit pour valider le routing).

---

## 7. Vérification

### 7.1 Tests automatisés

```bash
pnpm --filter @swarm-os/web test
```

Attendu : tous verts (8 fichiers de test, aucun ne dépend du routing).

```bash
pnpm --filter @swarm-os/web typecheck
```

Attendu : pas d'erreur TS. Surveiller :

- Import retiré de `OrchestratorList` / `OrchestratorView` → si jamais
  une autre référence existait, TS la signalerait.
- Type des props de `DesktopShell` (`routeOrchestratorId: string | null`).

### 7.2 Navigation manuelle (dev server)

```bash
pnpm --filter @swarm-os/web dev
```

Checklist :

1. **`http://localhost:5173/#/`** → grille desktop affichée, RightPanel
   fermé (ou translation hors écran).
2. **`http://localhost:5173/#/orchestrators/<id>`** avec un id valide
   d'un orchestrator actif :
   - Grille desktop affichée.
   - Après ~1 cycle de poll (3 s max), RightPanel ouvert sur le lead
     correspondant.
   - L'URL reste `#/orchestrators/<id>` (pas de boucle hashchange).
3. **`http://localhost:5173/#/orchestrators/nonexistent-id`** :
   - Grille desktop affichée, RightPanel fermé (lead introuvable).
   - Pas d'erreur console.
4. **`http://localhost:5173/#/roles`** :
   - Overlay plein écran avec la `RolesPage` actuelle.
   - Bouton "Close" ferme l'overlay → hash devient `#/`.
   - La grille desktop est rendue derrière l'overlay (vérifier via
     devtools que `DesktopShell` est bien dans le DOM sous l'overlay).
5. **Back/forward browser** :
   - Naviguer `#/` → `#/orchestrators/:id` → `#/roles` → back back back.
   - À chaque retour, l'UI reflète l'état attendu.
6. **Bouton "Orchestrators"** du header inline (à conserver en step 3) :
   - Clic → hash devient `#/`, RightPanel se ferme.
7. **Bouton "Roles"** du header inline :
   - Clic → hash devient `#/roles`, overlay s'ouvre.
8. **Bouton "Settings"** du header inline :
   - Clic → panneau settings inline s'ouvre (token visible). Comportement
     identique à avant step 3.

### 7.3 Modals existantes (régression)

- **NewOrchestratorDialog** : aujourd'hui ouvert depuis
  `OrchestratorList`. Avec sa suppression, **plus aucun point d'entrée
  en step 3**. À noter pour Phase B.4 (le bouton "NEW TEAM" de la `TopBar`
  v2 le rebranchera). En step 3, c'est un trou fonctionnel **temporaire**
  pour la création d'orchestrators. Si bloquant, ajouter en step 3 un
  bouton temporaire dans le header inline d'`App.tsx` :

  ```tsx
  <button onClick={() => setShowNewDialog(true)}>+ NEW (temp)</button>
  ```

  ⚠ **À documenter dans le PR** : "create orchestrator UI temporarily
  routed via header until B.4 lands the TopBar NEW TEAM button".

- **RolesPage** : ouverture testée ci-dessus, le `RoleDialog` (créer/éditer
  un rôle) est accessible depuis l'intérieur de la `RolesPage` actuelle —
  non régressé.

- **NotificationPanel** : reste monté globalement. Test : déclencher un
  `session.waiting` côté backend (ou simuler via debug WS) → toast doit
  apparaître bas-droite ; clic sur "open" doit naviguer à
  `#/orchestrators/:id` → RightPanel doit s'ouvrir sur le lead (via la
  pré-sélection §3.2).

### 7.4 Smoke check production-like

Si docker est lancé (`docker compose -f docker-compose.test.yml up -d`) :

- `curl http://localhost:8080/` → HTML servi.
- Ouvrir le navigateur sur l'URL prod (avec token) → vérifier que la
  navigation hash est identique.

### 7.5 Critères de succès step 3

- [ ] `App.tsx` n'importe plus `OrchestratorList` ni `OrchestratorView`.
- [ ] `DesktopShell` rendu pour les routes `list` et `detail`.
- [ ] `#/orchestrators/:id` ouvre le RightPanel sur le lead correspondant
      dès que `useOrchestrators` a chargé la liste.
- [ ] `#/roles` rend la `RolesPage` actuelle en overlay au-dessus de
      `DesktopShell`.
- [ ] Fichier `OrchestratorList.tsx` supprimé.
- [ ] Vitest reste vert.
- [ ] Typecheck propre.
- [ ] Header inline + settings drawer inline + `NotificationPanel`
      toujours fonctionnels (transition douce vers TopBar v2 / SettingsDrawer
      en Phase B/C).
- [ ] PR description documente le trou temporaire "création orchestrator"
      si pas de bouton temp ajouté.
