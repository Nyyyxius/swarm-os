# Step 16 (Phase D.16) — Spawn animation `spawningIds`

> Lié au plan global `docs/ui-redesign-desktop.md` §3.3 (MapView ligne
> *Spawn animation*), §5.1 step 16 (Phase D), §5.4 risque #5 (tests).
> Pré-requis : **Step 1** (keyframe `node-spawn` + classe `.node.spawning`
> dans `desktop-theme.css`) **et** **Step 6** (squelette du diff polling
> sur `spawningIds` déjà esquissé dans `06_mapview-data-binding.md` §7).
> Sources de vérité : `prototypes/v2/map.jsx:79-138` (consommation),
> `prototypes/v2/app.jsx:154/483-497/512-513` (production),
> `prototypes/Swarm OS v2.html:359-368` (CSS keyframe).

---

## 1. Objectif

Faire apparaître chaque nouveau Node (lead ou worker) sur la map avec une
animation `scale-in` + flash de 700 ms quand le serveur signale (event
`session.created` du WS `/ws/events`) ou révèle (diff entre deux snapshots
`useOrchestrators`) un sessionId jamais vu. Le rendu purement visuel
(opacité + scale) est porté par la classe CSS `.node.spawning` du
prototype v2 ; le seul code TS à écrire vit dans `DesktopShell` et
maintient un `Set<string> spawningIds` qui se vide après 700 ms.

---

## 2. CSS animation — extrait littéral du HTML v2

Bloc copié-collé de `prototypes/Swarm OS v2.html:359-368` (déjà censé
être dans `packages/web/src/styles/desktop-theme.css` après Step 1 — cf.
`01_design-system-v2.md` §3.4 ligne 212 et checklist §5.7 / §7.1 qui
liste `node-spawn` parmi les 9 keyframes attendues) :

```css
/* node spawn animation */
.node.spawning {
  animation: node-spawn 600ms cubic-bezier(.2,.7,.2,1) forwards;
  transform-origin: center;
  transform-box: fill-box;
}
@keyframes node-spawn {
  from { opacity: 0; transform: scale(0); }
  to   { opacity: 1; transform: scale(1); }
}
```

Notes :
- L'animation dure **600 ms** côté CSS, mais le brief / Step 6 cleanup
  utilise une fenêtre **700 ms** (`setTimeout(..., 700)`) pour avoir une
  marge de 100 ms avant de retirer la classe. → on garde **700 ms** côté
  JS pour rester aligné avec `prototypes/v2/app.jsx:497`.
- `forwards` fige l'état final (`opacity: 1; scale(1)`) ; retirer la
  classe `.spawning` ne fait donc pas "sauter" le node — c'est une
  no-op visuelle puisque le node sans classe est déjà rendu identique.
- `transform-box: fill-box` est crucial dans le contexte SVG : sans
  lui, `transform-origin: center` se réfère au coin haut-gauche du
  viewport SVG et le node "vole" depuis l'origine au lieu de scaler
  sur place. **À vérifier** dans `desktop-theme.css` que la copie
  n'a pas perdu cette ligne (le bug est subtil et purement visuel).
- Pas de `@media (prefers-reduced-motion)` dans le proto — dette
  d'accessibilité documentée par Step 1 §11.9, à traiter plus tard.

Vérification rapide :

```sh
grep -A 7 "@keyframes node-spawn\|\.node\.spawning" \
  packages/web/src/styles/desktop-theme.css
```

Si absent → reporter au Step 1 (pas au Step 16 : c'est un copier-coller
du CSS, pas une nouvelle règle).

---

## 3. Détection des nouvelles sessions

Trois sources possibles ; on recommande **(c) hybride event-first +
diff-fallback** :

### 3.1 (a) Event `session.created` (WS `/ws/events`)

Le serveur émet déjà ce frame (cf. `ui-redesign-desktop.md` §2.1 ligne
148 : `session.{created,status_changed,exited}`). Payload type-inféré
depuis `SwarmEvent` (`useEvents.ts:17-23`) :

```ts
{
  kind: 'session.created',
  ts: string,
  orchestratorId: string,
  sessionId: string,
  payload?: { type?: 'lead'|'worker'; role?: string; … }
}
```

Avantages :
- Latence sub-100 ms (push WS direct).
- Couvre **toutes** les origines de création : `POST /orchestrators`
  (lead seed), `team.spawn_worker` MCP (worker côté lead),
  `session.restart` (si le restart crée un nouveau sessionId — cf. S5).

Inconvénients :
- Si le frame se perd (WS drop pendant le `connect()` backoff de
  `useEvents.ts:82-141`), la session apparaît "silencieusement" au
  prochain poll `useOrchestrators` sans déclencher l'anim.
- Requiert un patch de `useEvents` pour exposer un callback
  `onSessionCreated` (même pattern qu'`onMailboxMessage` du Step 6
  §5.2).

### 3.2 (b) Diff polling sur `useOrchestrators`

Algorithme déjà esquissé dans `06_mapview-data-binding.md` §7 : à
chaque snapshot, calculer l'ensemble des sessionIds courants, comparer
au snapshot précédent (mémorisé dans un `useRef<Set<string>>`), et
mettre les nouveaux dans `spawningIds`.

Avantages :
- Robuste : aucune dépendance sur l'event ; couvre les pertes de
  frames WS.
- Zéro modification de `useEvents`.

Inconvénients :
- Latence 0-3 s (cadence de `useOrchestrators(3000)`).
- Premier snapshot doit **prime** `knownIds` sans déclencher l'anim
  (sinon **toutes** les sessions existantes flashent au mount —
  comportement indésirable au rechargement de la page).

### 3.3 (c) **Recommandé** — hybride event + diff fallback

```
event session.created   ─┐
                         ├──► add(sessionId) to spawningIds
diff polling (3 s)       ─┘    setTimeout(remove, 700)
```

Les deux sources convergent dans le même `setSpawningIds(prev => …)`,
qui est **idempotent** (un même id ajouté deux fois reste un seul
élément du `Set`). Le cleanup `setTimeout(700)` retire l'id même
si les deux sources le réajoutent (le cleanup le plus récent gagne ;
voir §6.2 sur la gestion des timers).

Cette stratégie donne la **latence event** (sub-100 ms typique) sans
sacrifier la **robustesse diff** (le diff rattrape les frames perdus).

Coût : un patch `useEvents` (~15 lignes) + le diff polling déjà
spécifié Step 6 (~25 lignes). Total ≈ 40 lignes nettes au-dessus du
squelette.

---

## 4. State management — `spawningIds: Set<string>`

### 4.1 Où vit le state

Dans `DesktopShell.tsx` (et **non** dans `MapView.tsx`). Justification :

- `DesktopShell` détient déjà `orchestrators`, `selectedSessionId`,
  `inboxCounts`, `pulses` (cf. `06_mapview-data-binding.md` §9.1) — le
  pattern "tout le data binding remonte au shell" est l'invariant
  d'architecture posé par Step 3.
- `MapView` reste un composant **présentationnel** : il reçoit
  `spawningIds: ReadonlySet<string>` en prop (déjà déclaré dans le
  squelette Step 2 et confirmé Step 6 §9 ligne 695).
- Si on déplace plus tard `spawningIds` au niveau `MapView` interne, on
  perd l'event lien `useEvents.onSessionCreated` (un seul WS par page,
  partagé). À éviter.

### 4.2 Déclaration

```ts
// packages/web/src/components/desktop/DesktopShell.tsx
const [spawningIds, setSpawningIds] = useState<Set<string>>(() => new Set());
const knownIdsRef = useRef<Set<string>>(new Set());
const spawnTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
```

Le `knownIdsRef` mémorise le précédent snapshot pour le diff. Le
`spawnTimersRef` permet d'annuler / re-démarrer le cleanup par id (cas
où une session est ajoutée par event puis re-vue par diff : on **reset**
le timer à 700 ms pour que l'animation soit visible si le diff arrive
tard).

### 4.3 Effect 1 — diff polling

```ts
useEffect(() => {
  const cur = new Set<string>();
  for (const o of orchestrators)
    for (const s of o.sessions) cur.add(s.id);

  // First snapshot: prime knownIds sans déclencher l'anim. Crucial pour
  // éviter le "flash global" au chargement initial (toutes les sessions
  // existantes seraient considérées "nouvelles" sinon).
  if (knownIdsRef.current.size === 0) {
    knownIdsRef.current = cur;
    return;
  }

  const fresh: string[] = [];
  for (const id of cur) {
    if (!knownIdsRef.current.has(id)) fresh.push(id);
  }
  knownIdsRef.current = cur;

  if (fresh.length === 0) return;
  for (const id of fresh) triggerSpawn(id);
}, [orchestrators]);
```

### 4.4 Effect 2 — subscription event (via `useEvents` patch)

```ts
useEvents({
  onMailboxMessage: (ev) => { /* Step 6 §5 */ },
  onSessionCreated: (ev) => {
    if (ev.sessionId) triggerSpawn(ev.sessionId);
  },
});
```

Patch `useEvents.ts` requis (additif, ne casse pas l'existant) :

```ts
export interface UseEventsOptions {
  onMailboxMessage?: (ev: MailboxMessageEvent) => void;
  onSessionCreated?: (ev: SessionCreatedEvent) => void;   // ← nouveau
}
export interface SessionCreatedEvent {
  kind: 'session.created';
  ts: string;
  orchestratorId: string;
  sessionId: string;
  type?: 'lead' | 'worker';
  role?: string;
}

// ... dans ws.onmessage, après le bloc mailbox.message (cf. Step 6 §5.2)
if (ev.kind === 'session.created' && ev.sessionId && ev.orchestratorId) {
  const p = (ev.payload as { type?: 'lead'|'worker'; role?: string } | undefined);
  onCreatedRef.current?.({
    kind: 'session.created',
    ts: ev.ts,
    orchestratorId: ev.orchestratorId,
    sessionId: ev.sessionId,
    type: p?.type,
    role: p?.role,
  });
}
```

Comme pour `onMailboxMessage`, mirrorer le callback dans un `useRef`
pour ne pas retear-down la connexion WS à chaque parent render.

### 4.5 Helper `triggerSpawn`

Centralise l'ajout + le cleanup pour les deux sources :

```ts
const triggerSpawn = useCallback((sessionId: string) => {
  setSpawningIds((prev) => {
    if (prev.has(sessionId)) return prev;   // idempotent
    const next = new Set(prev);
    next.add(sessionId);
    return next;
  });
  // Reset/replace timer si déjà présent (cas event + diff qui se
  // chevauchent — on veut la *dernière* fenêtre de 700 ms pour que
  // l'animation reste visible).
  const existing = spawnTimersRef.current.get(sessionId);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    spawnTimersRef.current.delete(sessionId);
    setSpawningIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, 700);
  spawnTimersRef.current.set(sessionId, t);
}, []);
```

### 4.6 Cleanup au unmount

```ts
useEffect(() => () => {
  for (const t of spawnTimersRef.current.values()) clearTimeout(t);
  spawnTimersRef.current.clear();
}, []);
```

Sinon les timers en vol après navigation `#/` → `#/roles` appellent
`setSpawningIds` sur un composant démonté (warning React).

---

## 5. Application au Node — classe `.spawning`

Aucune modification supplémentaire à `Node.tsx` : le squelette Step 2
expose déjà la prop `spawning: boolean` (cf. `prototypes/v2/map.jsx:79`
`function Node({ agent, pos, isLead, selected, onClick, onHover,
spawning })`), et applique :

```tsx
<g className={`node ${spawning ? 'spawning' : ''}`} transform={…}>
```

Le wiring depuis `MapView.tsx` (déjà acté Step 6 §9 lignes 871/883) :

```tsx
<Node
  agent={team.lead}
  pos={lp}
  isLead
  selected={selectedId === team.lead.id}
  spawning={spawningIds.has(team.lead.id)}
  onClick={(a) => onSelect(a.id)}
  onHover={handleHover}
/>
{team.workers.map((w) => (
  <Node
    key={w.id}
    agent={w}
    pos={wp}
    selected={selectedId === w.id}
    spawning={spawningIds.has(w.id)}
    …
  />
))}
```

L'invariant `spawningIds.has(id)` est un O(1) sur `Set<string>` — pas
de souci perf même avec 100 nodes (1 lookup par node par render).

### 5.1 Réinitialisation de l'animation CSS (cas rare)

Si la même classe `.spawning` est retirée puis ré-ajoutée au même
`<g>` SVG en < 600 ms, le browser ne **redémarre pas** l'animation
(elle est déjà en cours / terminée pour cette instance d'élément). Le
cas se produit si une session est `restart` (= même id, status repasse
`starting`) — mais alors `session.created` n'est **pas** ré-émis (S5
préserve l'id), donc `triggerSpawn` n'est pas appelé non plus. Pas
d'action à prévoir.

Si on voulait forcer le redémarrage (futur, pas v1), pattern standard :

```tsx
<g key={`${agent.id}-${spawningTick}`} className={…}>
```

Hors scope v1.

---

## 6. Cleanup — `setTimeout(700)` vs `onAnimationEnd`

### 6.1 Approche retenue : `setTimeout(700)`

Choisie pour **5 raisons** :

1. **Conforme au proto** (`prototypes/v2/app.jsx:490-497, 513`) — on
   reproduit le comportement existant 1:1.
2. **Source unique** : un seul mécanisme de cleanup, peu importe que
   l'animation soit visible (le node existe et est rendu) ou pas
   (sélection masquée, navigation, etc.).
3. **Découplé du DOM** : le Set vit dans React state, pas dans le
   composant Node. Si Node est démonté pendant l'animation, le timer
   continue et finit par nettoyer le Set proprement (pas de fuite).
4. **Testable** : un test peut `vi.advanceTimersByTime(700)` et
   asserter que le Set est vide. `onAnimationEnd` requiert un DOM
   réel + un browser réel (jsdom n'émet pas les events CSS animation).
5. **Marge sur la durée CSS** : 700 ms > 600 ms de l'anim, donc on
   est sûr que la classe n'est retirée qu'**après** la fin visuelle
   (même si elle est `forwards`, retirer la classe avant la fin
   couperait l'easing).

### 6.2 Pourquoi pas `onAnimationEnd`

- Coupling fort entre le Node React et le timing du shell.
- Bubble propagation : si Node est démonté avant que l'event remonte,
  le state du shell reste pollué.
- Pas testable sans browser réel.

Variante hybride (overkill v1) : `onAnimationEnd` sur le `<g>` qui
remonte un callback au shell **+** `setTimeout(1000)` de sécurité.
On peut l'ajouter en dette si on observe des cas de leak.

---

## 7. Plan d'implémentation pas-à-pas

> Step 6 a déjà commencé : un brouillon de diff polling est documenté
> dans `06_mapview-data-binding.md` §7. Step 16 **consolide** cette
> ébauche, ajoute le canal event, et factorise via `triggerSpawn`.

1. **Vérification CSS** : `grep "@keyframes node-spawn\|node\.spawning"
   packages/web/src/styles/desktop-theme.css`. Si absent → ouvrir un
   ticket Step 1 (pas un patch Step 16) pour ré-importer le bloc
   `prototypes/Swarm OS v2.html:359-368`. Confirmer la présence de
   `transform-box: fill-box`.

2. **Patch `useEvents.ts`** : ajouter `onSessionCreated` à
   `UseEventsOptions` + `SessionCreatedEvent` type. Mêmes patterns que
   le patch `onMailboxMessage` du Step 6 §5.2 (ref miroir, ne pas
   re-tear-down le WS). Tester :
   - `useEvents({ onSessionCreated })` appelle le callback sur un
     frame `session.created` ;
   - frame avec `sessionId` manquant → pas d'appel ;
   - frame `session.status_changed` continue de produire son toast
     (invariant existant).

3. **Étendre `DesktopShell.tsx`** :
   - ajouter states/refs : `spawningIds`, `knownIdsRef`,
     `spawnTimersRef` (§4.2) ;
   - implémenter `triggerSpawn` en `useCallback` (§4.5) ;
   - effet diff polling sur `[orchestrators]` (§4.3) ;
   - branchement event via `useEvents({ onMailboxMessage,
     onSessionCreated })` (§4.4) ;
   - cleanup global au unmount (§4.6) ;
   - passer `spawningIds={spawningIds}` au `<MapView />`.

4. **Vérifier `MapView.tsx`** : la prop `spawningIds: ReadonlySet<string>`
   doit déjà être déclarée (Step 2 / Step 6 §9). Si absente (régression),
   l'ajouter et la propager aux Node.

5. **Unit tests** (à ajouter) :
   - `DesktopShell.spawn.test.tsx` (avec `vi.useFakeTimers()`) :
     - premier snapshot prime `knownIds` sans déclencher anim ;
     - second snapshot avec un nouveau sessionId → `spawningIds`
       contient l'id ;
     - après `vi.advanceTimersByTime(700)` → `spawningIds` est vide ;
     - event `session.created` + diff sur le même id en < 700 ms →
       1 seule entrée dans le Set, timer réinitialisé.
   - `useEvents.test.ts` : nouveau test
     `triggers onSessionCreated on session.created frame`.

6. **Smoke test manuel** (§8 ci-dessous).

7. **Documentation** : marquer Step 16 ✅ dans
   `docs/ui-redesign-desktop.md` §5.1.

Effort total estimé : **S** (1 demi-session de dev, dont ~30 % de
tests). Le squelette Step 6 fait déjà 80 % du job ; Step 16 ajoute
surtout le canal event et la factorisation `triggerSpawn`.

---

## 8. Tests de fumée

À exécuter après docker rebuild (cf. memory :
`docker build -t swarm-os:latest .` puis
`docker compose -f docker-compose.test.yml up -d`).

| # | Geste | Attendu |
|---|-------|---------|
| 1 | Au chargement initial avec N orchestrators existants | **Aucune** anim spawn (knownIds primé sur le 1er snapshot). |
| 2 | Créer un nouveau orchestrator `ATLAS` via NewTeam | Lead diamond apparaît avec scale-in 600 ms + opacité 0→1. Latence ≤ 300 ms après le clic Submit (event-driven). |
| 3 | ATLAS spawn 2 workers initiaux | Les 2 workers triangle/circle apparaissent avec la même anim, simultanément ou décalés selon l'ordre des frames `session.created`. |
| 4 | Sur ATLAS (lead), appeler MCP `team.spawn_worker` | Le nouveau worker apparaît avec spawn anim (event-driven). |
| 5 | Couper le WS (DevTools → Network → offline 5 s) puis créer une team | Au reconnect, l'anim se déclenche via le **diff polling** (latence 0-3 s) plutôt que l'event (perdu). |
| 6 | Restart une session (`POST /sessions/:id/restart`) | **Pas** d'anim spawn (même sessionId conservé par S5 ; cf. §5.1). Le label `STARTING` apparaît à la place via `node-svr-restart`. |
| 7 | Naviguer `#/` → `#/roles` → `#/` pendant qu'un spawn est en cours | Pas de warning React "setState on unmounted". Le Set se vide au unmount via cleanup. |
| 8 | Spam 10 `team.spawn_worker` en < 1 s | 10 anims se déclenchent quasi-simultanément (event-driven), chacune dure 600 ms ; pas de drop frames visible (le browser GPU-compose chaque `transform: scale`). |
| 9 | Open DevTools → React DevTools → inspecter `<MapView />` props | `spawningIds: Set(N)` mute correctement entre les snapshots. |
| 10 | `prefers-reduced-motion: reduce` (DevTools → Rendering) | Anim toujours visible (dette doc Step 1 §11.9 — à fixer plus tard). |

### 8.1 Tests de régression à ne pas casser

- Step 6 `mailbox.message` callback fonctionne toujours (toasts +
  pulses pas affectés).
- Step 8 toasts `waiting` continuent de s'afficher pour
  `session.status_changed`.
- Nodes sans la classe `.spawning` rendus identiques à avant (pas de
  fuite de style — la classe est ajoutée/retirée proprement).

---

## Annexe — Récapitulatif des fichiers touchés

| Fichier | Type | Origine |
|---|---|---|
| `packages/web/src/styles/desktop-theme.css` | **vérification** | s'assurer que `.node.spawning` + `@keyframes node-spawn` (+ `transform-box: fill-box`) sont présents |
| `packages/web/src/hooks/useEvents.ts` | **modifié** | ajout `UseEventsOptions.onSessionCreated` + `SessionCreatedEvent` |
| `packages/web/src/hooks/useEvents.test.ts` | **modifié** | nouveau test `session.created → callback` |
| `packages/web/src/components/desktop/DesktopShell.tsx` | **modifié** | états `spawningIds`/`knownIdsRef`/`spawnTimersRef`, `triggerSpawn`, effets diff + event, cleanup unmount, prop `spawningIds` passée à `<MapView />` |
| `packages/web/src/components/desktop/DesktopShell.spawn.test.tsx` | **nouveau** | tests prime, diff, event, dedupe, cleanup |
| `packages/web/src/components/desktop/MapView.tsx` | **vérification** | prop `spawningIds: ReadonlySet<string>` déjà déclarée (Step 2/6) — propagée à `<Node spawning={…} />` |

Aucun changement serveur. L'event `session.created` est déjà émis par
le bus (`ui-redesign-desktop.md` §2.1 ligne 148, livré S2/S5).
