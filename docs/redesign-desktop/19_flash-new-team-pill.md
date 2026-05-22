# Step 19 (Phase D.19) — `flash-new` animation sur team-pill après création

> Référence brief : `docs/ui-redesign-desktop.md` §3.1 (ligne 180 :
> `flash-new` = pure UI) et §5.1 step 19. CSS source : keyframe déjà
> porté en Step 1 (`01_design-system-v2.md` §3.4 + §3.5, bloc
> `.team-pill.flash-new`). State `flashTeamId` mentionné par Steps 2 et 4
> (props passées à `TopBar`, init à `null` côté `DesktopShell`).
> Préreq exécutés : Steps 1 (CSS keyframe), 2 (squelette `TopBar` qui
> reçoit `flashTeamId: string | null`), 4 (state stub dans
> `DesktopShell`, déjà à `null`), 9 (`NewOrchestratorDialog` qui appelle
> `useOrchestrators().create()`).

---

## 1. Objectif

Donner un signal visuel bref (~1.6 s) sur la team-pill nouvellement
apparue dans la TopBar après un `POST /orchestrators` réussi (manuel via
dialog OU déclenché à distance par un autre client / event bus). Effet :
fond ambré pulsant via la classe `.flash-new` déjà définie dans le
design system. Aucune nouvelle keyframe, aucun nouvel endpoint — c'est
de la pure UI déclenchée par diff d'identifiants ou event WS.

---

## 2. CSS keyframe — extrait littéral HTML v2

Déjà porté en Step 1 dans `packages/web/src/styles/desktop-theme.css`
(bloc `.team-pill`, cf. `01_design-system-v2.md` §3.5 lignes 234-256 du
doc Step 1, qui copient le HTML v2 source lignes 74-96) :

```css
.team-pill.flash-new { animation: flash-new 1.6s ease-out 1; }
@keyframes flash-new {
  0%   { background: rgba(255, 176, 96, 0.0); }
  20%  { background: rgba(255, 176, 96, 0.30); }
  100% { background: rgba(255, 176, 96, 0.07); }
}
```

Notes :
- Le brief parle de « glow ambré + scale subtil » et « ~800 ms ».
  Le proto v2 fait `1.6s ease-out 1` (single shot, fade-in à 20 %, retour
  à la teinte de la pill `active`) sans `transform: scale()`. **On garde
  le proto** (durée + courbe + propriétés animées) pour ne pas diverger
  visuellement du design validé. Le `setTimeout(1700)` côté JS (cf. §4)
  laisse 100 ms de marge pour que la classe soit retirée *après* la fin
  de l'anim — sinon le navigateur replay au prochain render si l'élément
  est démonté/remonté.
- Pas de variante `prefers-reduced-motion` dans le proto. Dette
  d'accessibilité connue (cf. `01_design-system-v2.md` §6 risque 9).
  Pour Step 19 on copie tel quel ; un wrap `@media
  (prefers-reduced-motion: reduce) { .team-pill.flash-new { animation:
  none; } }` peut être ajouté dans `desktop-theme.css` en suivi.
- Si le brief « scale subtil » est tenu pour important, ajouter à la
  keyframe une seconde propriété (hors scope du présent step) :
  ```css
  @keyframes flash-new {
    0%   { background: rgba(255,176,96,0); transform: scale(1); }
    20%  { background: rgba(255,176,96,0.30); transform: scale(1.02); }
    100% { background: rgba(255,176,96,0.07); transform: scale(1); }
  }
  ```
  À discuter en revue design ; non implémenté ici pour rester fidèle
  au proto.

Application JSX (déjà câblée en Step 2 + 4) :

```tsx
<div className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ${flashTeamId === t.id ? 'flash-new' : ''}`}>
```

Cf. `prototypes/v2/app.jsx:86` — copie littérale dans `TopBar.tsx`.

---

## 3. Détection — `orchestrator.created` (préféré) ou diff `useOrchestrators`

Deux sources possibles, **non exclusives**. La règle : déclencher au
**plus tôt** (event WS instantané) avec un **fallback** sur le diff du
prochain snapshot REST (3 s) pour les cas où la WS est down ou l'event
a été manqué. Dedup côté state pour ne pas flasher deux fois le même id.

### 3.1 Source primaire — event `orchestrator.created`

Backend émet déjà cet event (`packages/server/src/events.ts:4` et
`packages/server/src/modules/spawner/index.ts:118`) avec `payload =
orch.toView()`. Le hook `useEvents` doit l'exposer.

État actuel de `useEvents.ts` (cf.
`packages/web/src/hooks/useEvents.ts:104-130`) : seul
`session.status_changed → waiting` est surfacé (en `WaitingNotice[]`).
Pour Step 19 on **étend** `useEvents` afin qu'il expose en plus une
liste éphémère d'ids fraîchement créés, OU on ajoute un callback prop
`onOrchestratorCreated?: (id: string) => void` que `DesktopShell`
fournit. Le second est plus propre (pas d'accumulation d'état dans le
hook), c'est la voie retenue.

**Diff `useEvents.ts`** (≈8 lignes) :

```ts
// signature
export function useEvents(opts?: {
  onOrchestratorCreated?: (id: string) => void;
}): { connected: boolean; waiting: WaitingNotice[]; dismiss: ...; clear: ... }

// dans ws.onmessage, après le bloc waiting :
if (ev.kind === 'orchestrator.created' && ev.orchestratorId) {
  opts?.onOrchestratorCreated?.(ev.orchestratorId);
}
```

Le callback est lu via une ref interne (pattern habituel pour éviter de
re-créer la WS à chaque render du parent), mais une simple fermeture
suffit si le parent mémoïse le callback avec `useCallback`. **Cf. §4
pour le pattern complet.**

### 3.2 Source de secours — diff `orchestrators`

Si la WS est cassée (TLS bricolé, ticket expiré non re-fetch, etc.),
on rattrape via la diff entre deux snapshots successifs de
`useOrchestrators()`. Pattern :

```ts
const prevIdsRef = useRef<Set<string>>(new Set());
useEffect(() => {
  const nextIds = new Set(orchestrators.map((o) => o.id));
  for (const id of nextIds) {
    if (!prevIdsRef.current.has(id)) {
      // nouvel id apparu depuis le dernier snapshot
      triggerFlash(id);
    }
  }
  prevIdsRef.current = nextIds;
}, [orchestrators]);
```

⚠ Premier render : `prevIdsRef.current` est vide, donc **tous** les
orchs existants seraient marqués nouveaux. Solution : initialiser
`prevIdsRef` au **premier snapshot non vide** (skip le premier diff),
ou conserver un flag `bootSeen` :

```ts
const bootSeen = useRef(false);
useEffect(() => {
  if (!bootSeen.current) {
    prevIdsRef.current = new Set(orchestrators.map((o) => o.id));
    if (orchestrators.length > 0 || /* useOrchestrators.loading === false */) {
      bootSeen.current = true;
    }
    return;
  }
  const nextIds = new Set(orchestrators.map((o) => o.id));
  for (const id of nextIds) {
    if (!prevIdsRef.current.has(id)) triggerFlash(id);
  }
  prevIdsRef.current = nextIds;
}, [orchestrators]);
```

### 3.3 Dedup entre les deux sources

L'event WS arrive typiquement < 200 ms après le `POST`, le poll REST
3 s plus tard verra le même id. Sans dedup, on déclencherait deux
`triggerFlash(id)` — le second tomberait pendant que la classe est
encore appliquée, ce qui n'a pas d'effet visuel notable (la keyframe
est `1`-shot et redémarre seulement si la classe est retirée puis
remise). Pour être propre :

```ts
function triggerFlash(id: string) {
  setFlashIds((prev) => {
    if (prev.has(id)) return prev;             // déjà flashé / en cours
    const next = new Set(prev);
    next.add(id);
    return next;
  });
  setTimeout(() => {
    setFlashIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, FLASH_MS);
}
```

Bonus : si on veut éviter qu'un orch créé puis détruit puis recréé soit
re-flashé pendant un long délai, on peut tenir un `Set<string>` des
ids « déjà vus à vie » (`everSeenRef`). Pas indispensable v1 — un
recreate quasi-instantané d'un même id est un edge case rare (les ids
sont des UUID/slugs uniques côté serveur).

---

## 4. State — `flashTeamId` vs `flashTeamIds`

Le proto v2 utilise **un seul id** (`flashTeamId: string | null`,
`app.jsx:153`). Suffisant pour le cas nominal (l'utilisateur crée une
team à la fois via le dialog). Mais Step 19 doit aussi gérer le cas
**multi-clients** : si un opérateur crée 2 teams en rafale depuis 2
onglets, ou si un backend test seed N orchestrators au démarrage, le
single-id écrase le précédent.

### 4.1 Décision : `Set<string>`

On choisit `Set<string>` pour permettre N flashs simultanés sans perte.
Diff vs Step 4 (qui déclarait `useState<string | null>(null)`) — c'est
une **migration de signature** côté `DesktopShell` et côté `TopBar` :

```ts
// avant (Step 4)
const [flashTeamId, setFlashTeamId] = useState<string | null>(null);

// après (Step 19)
const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
```

Et la prop `TopBar` :

```ts
// avant
flashTeamId: string | null;

// après
flashIds: ReadonlySet<string>;
```

JSX `TopBar` :

```tsx
<div className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ${flashIds.has(t.id) ? 'flash-new' : ''}`}>
```

> Choix alternatif (si on veut éviter la migration de signature) :
> garder `flashTeamId: string | null` et accepter qu'une création en
> rafale écrase la précédente. Acceptable v1 si l'UX multi-création
> n'est pas une priorité. Recommandation : faire la migration Set
> maintenant — c'est 4 lignes de diff et ça évite une refacto future.

### 4.2 Où vit le state

Dans `DesktopShell.tsx`. C'est là que vit déjà :
- `useOrchestrators()` (Step 3/4) → source de la diff,
- la prop `flashTeamId` passée au `<TopBar />` (Step 4),
- le `useEvents()` hook (Step 8 — `onOrchestratorCreated` callback à
  rajouter).

Aucun autre composant n'a besoin de cet état. Pas de Context, pas de
lift plus haut.

### 4.3 Durée

`FLASH_MS = 1700` (proto v2 `app.jsx:480`). 100 ms de marge au-dessus
des `1600` ms de l'anim CSS. Ce léger overlap évite que la classe
disparaisse pile au moment où la transition s'arrête et ne provoque un
flash visuel ; en pratique invisible mais aligné avec le proto.

> Le brief mentionne « ~800ms ». C'est en désaccord avec la keyframe
> proto (`1.6s`). On suit la **keyframe** comme source de vérité
> (visuel signé en design review). Si le designer veut basculer à 800 ms,
> il faut modifier en parallèle la keyframe CSS (`animation: flash-new
> 0.8s …`) **et** `FLASH_MS` à ~900. Step 19 n'effectue PAS ce
> changement ; il reste fidèle au proto.

---

## 5. Application — câblage `.flash-new` sur la pill dans TopBar

### 5.1 Côté `DesktopShell.tsx` — état + déclenchement

Ajouts (à insérer dans le fragment Step 4) :

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useEvents } from '../../hooks/useEvents';

const FLASH_MS = 1700;

// ... à l'intérieur du composant DesktopShell ...

const { orchestrators } = useOrchestrators();
const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());

// Helper : trigger flash avec dedup + auto-clear
const triggerFlash = useCallback((id: string) => {
  setFlashIds((prev) => {
    if (prev.has(id)) return prev;
    const next = new Set(prev);
    next.add(id);
    return next;
  });
  setTimeout(() => {
    setFlashIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, FLASH_MS);
}, []);

// Source primaire : event WS
useEvents({ onOrchestratorCreated: triggerFlash });

// Source de secours : diff `orchestrators` (latence ≤ 3 s)
const prevIdsRef = useRef<Set<string>>(new Set());
const bootSeen = useRef(false);
useEffect(() => {
  if (!bootSeen.current) {
    prevIdsRef.current = new Set(orchestrators.map((o) => o.id));
    bootSeen.current = true;
    return;
  }
  const nextIds = new Set(orchestrators.map((o) => o.id));
  for (const id of nextIds) {
    if (!prevIdsRef.current.has(id)) triggerFlash(id);
  }
  prevIdsRef.current = nextIds;
}, [orchestrators, triggerFlash]);

// ... dans le JSX ...
<TopBar
  teams={topBarTeams}
  selectedTeamId={selectedTeamId}
  flashIds={flashIds}             // ← migration de la prop (cf. §4.1)
  totalAgents={totalAgents}
  info={topBarInfo}
  onSelectTeam={handleSelectTeam}
  onNewTeam={() => setShowNew(true)}
  onOpenRoles={() => setShowRoles(true)}
  onOpenSettings={() => setShowSettings(true)}
/>
```

### 5.2 Côté `TopBar.tsx` — consommation

Diff de la prop (cf. §4.1) + diff du `className` :

```diff
- flashTeamId: string | null;
+ flashIds: ReadonlySet<string>;
```

```diff
- className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ${flashTeamId === t.id ? 'flash-new' : ''}`}
+ className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ${flashIds.has(t.id) ? 'flash-new' : ''}`}
```

Aucun autre changement dans `TopBar.tsx`.

### 5.3 Édition `useEvents.ts`

```diff
+ export interface UseEventsOptions {
+   onOrchestratorCreated?: (id: string) => void;
+ }
- export function useEvents(): { ... } {
+ export function useEvents(opts: UseEventsOptions = {}): { ... } {
+   const optsRef = useRef(opts);
+   useEffect(() => { optsRef.current = opts; }, [opts]);
    // ... existant ...
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(...) as SwarmEvent;
+       if (ev.kind === 'orchestrator.created' && ev.orchestratorId) {
+         optsRef.current.onOrchestratorCreated?.(ev.orchestratorId);
+       }
        if (ev.kind === 'session.status_changed' && ...) { /* existant */ }
      } catch { /* drop */ }
    };
```

Le pattern `optsRef` évite de recréer la WS chaque fois que
`onOrchestratorCreated` change d'identité côté parent (sinon le
`useEffect([], …)` de `useEvents` se reconnecterait à chaque render).

---

## 6. Plan d'implémentation pas-à-pas

1. **Étendre `useEvents.ts`** (≈12 lignes) :
   - ajouter `UseEventsOptions` exporté ;
   - signature `useEvents(opts: UseEventsOptions = {})` ;
   - `optsRef` + effect de sync ;
   - dans `ws.onmessage`, surface `orchestrator.created` via
     `optsRef.current.onOrchestratorCreated?.(ev.orchestratorId)`.
   - Pas d'impact sur les call sites existants (opts par défaut `{}`).

2. **Modifier `TopBar.tsx`** :
   - changer la prop `flashTeamId: string | null` →
     `flashIds: ReadonlySet<string>` ;
   - remplacer `flashTeamId === t.id` par `flashIds.has(t.id)` dans le
     `className` de chaque `team-pill`.

3. **Modifier `DesktopShell.tsx`** :
   - importer `useCallback`, `useEffect`, `useRef`, `useState` ;
   - importer `useEvents` (déjà fait Step 8 — sinon, ajouter) ;
   - déclarer la constante `FLASH_MS = 1700` au top du fichier ;
   - remplacer `const [flashTeamId, setFlashTeamId] = useState<string | null>(null);`
     par `const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());` ;
   - ajouter le helper `triggerFlash(id)` mémoïsé avec `useCallback` ;
   - appeler `useEvents({ onOrchestratorCreated: triggerFlash })` ;
   - ajouter le `useEffect` de diff sur `orchestrators` avec
     `prevIdsRef` + `bootSeen` ;
   - changer la prop passée à `<TopBar />` : `flashIds={flashIds}` ;
   - supprimer (si encore présent) le `setTimeout(setFlashTeamId(null),
     1700)` du handler `handleCreateTeam` (Step 9) — c'est désormais
     géré par la diff ou l'event WS, plus besoin de set manuel.

4. **Vérifier `NewOrchestratorDialog`** (Step 9) : si son handler
   `onCreate` setait `flashTeamId` directement, c'est obsolète →
   supprimer. Le flash arrivera automatiquement via l'event/diff.

5. **Tests** (cf. §7).

6. **Build + smoke** :
   ```sh
   cd packages/web && pnpm tsc --noEmit && pnpm build && pnpm test
   ```
   puis rebuild Docker (`docker build -t swarm-os:latest . && docker
   compose -f docker-compose.test.yml up -d`) pour smoke runtime.

### 6.1 Surface modifiée

| Fichier | Nature | Lignes |
|---|---|---|
| `packages/web/src/hooks/useEvents.ts` | edit | +12 |
| `packages/web/src/components/desktop/TopBar.tsx` | edit | +2 / -2 (signature + className) |
| `packages/web/src/components/desktop/DesktopShell.tsx` | edit | +35 (state + 2 effects + handler + JSX) |
| `packages/web/src/components/desktop/NewOrchestratorDialog.tsx` | edit (cleanup) | -3 (suppression setFlash manuel) |
| (test) `useEvents.test.ts` | edit | +20 |
| (test) `DesktopShell.test.tsx` | edit | +30 |

Aucun nouveau fichier. Aucun changement serveur. Pas de modif CSS
(la keyframe vit déjà dans `desktop-theme.css` depuis Step 1).

### 6.2 Risques

1. **Double déclenchement** event + diff : couvert par `triggerFlash`
   qui ignore les ids déjà présents dans `flashIds` (§3.3).
2. **Boot flash** : risque que tous les orchs existants au mount soient
   marqués « nouveaux » par la diff → mitigé par `bootSeen` (§3.2).
3. **Memory leak setTimeout** : si l'utilisateur navigue ailleurs
   pendant l'anim, le `setTimeout` continue et appelle `setFlashIds`
   sur un composant démonté. React 19 tolère (warning console au pire),
   mais on peut tracker les timers dans un `Map<string,
   ReturnType<typeof setTimeout>>` et les clear au cleanup. Acceptable
   v1 sans tracker.
4. **WS re-connect** = events manqués pendant la coupure : la diff
   REST 3 s rattrape, donc pas de régression visible.
5. **Multi-onglets** : 2 onglets verront la création — chacun déclenche
   son propre flash local. Cohérent.
6. **`endedAt != null` filter en TopBar** (Step 4) : si la team est
   déjà créée endedAt-null, OK. Si elle naît déjà ended (impossible en
   pratique), elle est filtrée et la classe n'apparaît jamais → flash
   silencieux. Pas de bug, mais pas d'effet non plus. Edge case
   ignorable.

---

## 7. Tests de fumée

### 7.1 Unit — `useEvents.test.ts`

Étendre les tests existants avec :

```ts
it('calls onOrchestratorCreated when ws emits orchestrator.created', async () => {
  const spy = vi.fn();
  // monter useEvents avec opts.onOrchestratorCreated = spy via une test rig
  // (mock WS — déjà en place pour les tests waiting).
  mockWs.emit('message', JSON.stringify({
    kind: 'orchestrator.created',
    ts: '2026-05-22T10:00:00Z',
    orchestratorId: 'orch-abc',
    payload: { /* OrchestratorView minimal */ },
  }));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('orch-abc'));
});

it('does not call onOrchestratorCreated for unrelated kinds', async () => {
  const spy = vi.fn();
  mockWs.emit('message', JSON.stringify({
    kind: 'session.created',
    ts: '...',
    orchestratorId: 'orch-abc',
  }));
  await new Promise((r) => setTimeout(r, 50));
  expect(spy).not.toHaveBeenCalled();
});
```

### 7.2 Unit — `DesktopShell.test.tsx` (diff fallback)

```ts
it('flashes team-pill when a new orchestrator id appears in snapshot', async () => {
  const { rerender } = render(<DesktopShell />, { /* test rig avec
    useOrchestrators mocké */ });
  // 1er snapshot — 1 orch
  setOrchestrators([{ id: 'a', name: 'team-a', ... }]);
  // bootSeen flip → pas de flash sur 'a'
  expect(screen.queryByText('team-a')?.closest('.team-pill'))
    .not.toHaveClass('flash-new');
  // 2e snapshot — 1 nouvel orch 'b'
  setOrchestrators([{ id: 'a', ... }, { id: 'b', name: 'team-b', ... }]);
  await waitFor(() => {
    expect(screen.getByText('team-b').closest('.team-pill'))
      .toHaveClass('flash-new');
  });
  // Après FLASH_MS, classe retirée
  await new Promise((r) => setTimeout(r, 1750));
  expect(screen.getByText('team-b').closest('.team-pill'))
    .not.toHaveClass('flash-new');
});

it('dedups ws event + snapshot diff (single flash)', async () => {
  // event WS fire pour 'c' → flashIds contient 'c'
  // puis snapshot diff voit 'c' apparaître → triggerFlash no-op
  // → la classe reste appliquée pour 1 seule fenêtre FLASH_MS, pas re-déclenchée.
});
```

### 7.3 Smoke manuel (browser)

Workflow Docker (cf. mémoire `project_docker_redeploy.md`) :

```bash
cd /home/ubuntu/projets/swarm-os
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
# ouvrir http://localhost:8080 avec token valide
```

Checklist :

- [ ] **Création via UI** : cliquer `+ NEW TEAM`, remplir, valider.
      La pill apparaît dans la TopBar avec un fond ambré qui s'éteint
      en ~1.6 s.
- [ ] **Création via curl** (bypass UI) :
      ```bash
      curl -X POST -H "X-Auth-Token: $TOK" http://localhost:8080/orchestrators \
        -d '{"name":"smoke-test","roleId":"builder"}' -H 'Content-Type: application/json'
      ```
      → la pill apparaît dans la TopBar avec `.flash-new` en < 500 ms
      (event WS). Si la WS est down, elle apparaît en ≤ 3 s (diff REST).
- [ ] **Création en rafale** : exécuter 3 curl POST en parallèle (xargs
      -P 3). Les 3 pills flashent simultanément (preuve du Set vs
      single-id).
- [ ] **Boot** : recharger la page avec N orchs déjà présents → AUCUNE
      pill ne flashe au mount (`bootSeen` fonctionne).
- [ ] **Recreate-rapide** : créer, supprimer immédiatement, recréer
      avec même name → si même id, flash redéclenche (acceptable). Si
      id différent (nouveau slug), flash sur le nouvel id seulement.
- [ ] **WS down** : couper le WS côté Docker (`docker compose restart
      swarm-os-server`), créer un orch via curl pendant la coupure →
      après reconnexion ou poll suivant, le flash s'applique via la
      diff.
- [ ] **Cas dégradé `prefers-reduced-motion`** : activer dans le browser
      → flash visuel disparaît mais aucun crash (la classe est toujours
      appliquée, juste la keyframe n'anime pas). Si on ajoute la
      `@media` recommandée §2, c'est OK ; sinon, la pill « pulse »
      quand même.

### 7.4 Vérif inspection DOM

DevTools → Elements :
- juste après création, le `<div class="team-pill flash-new">` est
  présent ;
- ~1.7 s plus tard, `.flash-new` disparaît automatiquement, la `<div>`
  reste avec ses autres classes (potentiellement `.active` si
  sélectionnée).

DevTools → Console :
```js
performance.getEntriesByType('animation') // (si AnimationEvent observé)
// ou observer manuellement :
new MutationObserver(m => m.forEach(r => console.log(r.target.className)))
  .observe(document.querySelector('.health-strip'),
           { subtree: true, attributes: true, attributeFilter: ['class'] });
```

Puis créer une team → observer l'apparition puis le retrait de
`flash-new`.

---

## 8. Récap one-liner

Step 19 = wire `orchestrator.created` (event WS) → `triggerFlash(id)`
→ `setFlashIds(Set.add(id))` → `<div className="team-pill flash-new">`
→ `setTimeout(setFlashIds(Set.delete(id)), 1700)`. Fallback diff
`useOrchestrators` snapshot pour rattrapage. CSS et JSX déjà en place
depuis Steps 1, 2 et 4. Diff total ≈ 50 lignes prod + ~50 tests.

---

## 9. Annexe — Références

| Élément | Fichier | Lignes |
|---|---|---|
| Keyframe `.team-pill.flash-new` + `@keyframes flash-new` | `prototypes/v2/Swarm OS v2.html` (`<style>`) | 74-96 |
| Bloc CSS porté en Step 1 (référence) | `docs/redesign-desktop/01_design-system-v2.md` §3.5 | 234-256 |
| Proto JSX className | `prototypes/v2/app.jsx` | 86 |
| Proto state `flashTeamId` | `prototypes/v2/app.jsx` | 153 |
| Proto trigger (création) | `prototypes/v2/app.jsx` | 478-480 |
| Prop `flashTeamId` passée au TopBar | `prototypes/v2/app.jsx` | 568 |
| Backend event `orchestrator.created` | `packages/server/src/events.ts` | 4 |
| Backend émission | `packages/server/src/modules/spawner/index.ts` | 117-121 |
| `useEvents` actuel (waiting only) | `packages/web/src/hooks/useEvents.ts` | 104-130 |
| `useOrchestrators` (poll 3 s, source diff) | `packages/web/src/hooks/useOrchestrators.ts` | 1-56 |
| Plan global — ligne brief | `docs/ui-redesign-desktop.md` | 180, 399 |
| TopBar wiring (state `flashTeamId` stub) | `docs/redesign-desktop/04_topbar-data-binding.md` | 39, 431-434, 619-622 |

— FIN du document analyse Step 19 —
