# S4 — Compteur global de messages + delta/min

> Analyse en profondeur du lot **S4** de `docs/internal/ui-redesign/update_system.md`. Aucun
> code de production produit ici. À lire après
> `01_compteur_messages_orchestrator.md` (S1) — S4 dans son alternative
> low-effort consomme directement le `msgCount` introduit par S1.

---

## 1. Résumé du besoin

Le LeftPanel de la nouvelle UI desktop (cf. `prototypes/panels.jsx:58-71`)
affiche dans sa section **MESSAGE FLOW** :

- un **big number** : total cumulé de messages échangés sur tout le bus ;
- une **delta** `+<n>/min` à droite du big number ;
- une **sparkline 60 points** (`BigGraph`, area amber, cf.
  `prototypes/panels.jsx:25-56`) représentant les 60 dernières minutes
  glissantes de débit (msg/min).

Aujourd'hui rien côté serveur n'agrège un total bus à l'échelle du
process et il n'existe pas de ring buffer historique. Le brief propose
deux options : v1 low-effort (frontend dérive tout) ou v2 endpoint
dédié (`GET /metrics/messages` avec ring buffer serveur).

---

## 2. État du code existant

### 2.1 `/health` — possible point de greffe mais limité

`/home/ubuntu/projets/swarm-os/packages/server/src/http/main.ts:69-79` :

```ts
app.get('/health', (_req, res) => {
  const c = spawner.counters();
  res.json({ status, project_name, orchestrators_active, sessions_active,
             sessions_waiting, uptime_seconds });
});
```

`/health` est **monté avant** `makeAuthMiddleware` (ligne 130) → public,
non authentifié. Type miroir côté client : `HealthView` à
`/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts:79-86`.

### 2.2 Aucun préfixe `/metrics/*` n'existe

`grep -rn "metrics" packages/server/src/` → 0 match. Routers actuels
montés dans `http/main.ts` : hooks (Bearer), orchestrators, sessions,
ws-ticket, roles (X-Auth-Token). **Un nouveau fichier** dans
`packages/server/src/http/routes/` est requis pour v2.

### 2.3 Aucun tick métrique périodique

`grep -n "setInterval" packages/server/src/` → 0 match. Le seul timer
global est un guard shutdown (`index.ts:168`). v2 implique un nouveau
`setInterval` global, à placer dans une classe dédiée (
`MessagesAggregator`) instanciée dans `index.ts` aux côtés du Spawner.

### 2.4 Où agréger le total

Naturel : **somme des `msgCount` par orch vivant** via
`spawner.list()` (méthode existante à
`packages/server/src/modules/spawner/index.ts:174-176`, retourne TOUS
les orchs y compris stopped/failed). Vérifié dans le code :
`spawner.orchestrators.delete(id)` n'est appelé **nulle part** — les
orchs morts restent dans la Map jusqu'au shutdown, donc leur
`msgCount` reste agrégeable. Bonne nouvelle, l'agrégation est stable
sur la vie du process.

### 2.5 Le frontend ne consomme aucune métrique agrégée

`grep -rn "metrics" packages/web/src/` → 0 match. Pas de
`useMessageFlow()`. Tout est à créer côté web. Composants cibles dans
le proto : `prototypes/panels.jsx:25-71` (`BigGraph` + `LeftPanel`),
`prototypes/app.jsx:96` (`useState(window.AGG_HISTORY)`).

### 2.6 S1 — prérequis confirmé

`Mailbox` (`packages/server/src/modules/orchestrator/mailbox.ts`)
n'expose pas encore `messagesTotal`. `OrchestratorView`
(`.../orchestrator/index.ts:35-53`) n'a pas `msgCount`. **S1 est
strictement prérequis** pour S4 v1 (le frontend a besoin de
`msgCount` pour sommer).

---

## 3. Décision recommandée : v1 low-effort

### 3.1 Comparatif

| Critère | v1 (frontend dérive) | v2 (ring buffer serveur) |
|---|---|---|
| Code serveur nouveau | 0 (consomme S1) | ~80 lignes |
| Code client nouveau | ~50 lignes (hook + ring) | ~30 lignes (fetch + display) |
| Cohérence inter-onglets | Non (chaque tab a sa history) | Oui |
| Survie au reload de page | **Non** (sparkline repart vide 60 min) | Oui |
| Survie au restart serveur | Non (total reset aussi) | Non non plus |
| Délai remplissage initial | Immédiat pour `total`, 60 min pour history | Idem |
| Cohérence `total = Σ msgCount` | Trivialement vraie (somme directe) | À discipliner (snapshot indépendant possible) |
| Authentification | Hérite de `/orchestrators` (X-Auth-Token) | À choisir (recommandé X-Auth-Token) |

### 3.2 Recommandation : **v1**

Raisons :

1. **S1 livre 95 % du besoin** — un `reduce` côté client donne `total`.
2. **La sparkline est cosmétique** — donne un sens visuel "ça bouge".
   Un opérateur qui recharge accepte 60 min de remplissage progressif ;
   le gradient amber masque le vide initial.
3. **Le big number `total` est la vraie info** — visible
   immédiatement, indépendant du ring buffer.
4. **Évite le double point de vérité** : v2 avec snapshot indépendant
   risque de désynchroniser `metrics.total` et `Σ team.msgCount`
   (mauvaise UX). v1 garantit l'égalité à tout instant.
5. **Recoupement fort avec S9** (§7.6) — si on lance v2, autant le
   coupler avec S9. Faire S4 v2 isolé est sous-optimal.

v2 reste valable si plus tard l'opérateur se plaint des sparklines
qui se vident, ou si S9 est implémenté en même temps.

---

## 4. Fichiers à modifier

### 4.1 Option recommandée (v1)

| Chemin absolu | Modification |
|---|---|
| **Aucun fichier serveur** | Précondition : S1 mergé (`msgCount` exposé sur `OrchestratorView`). |
| `/home/ubuntu/projets/swarm-os/packages/web/src/hooks/useMessageFlow.ts` (**nouveau**) | Hook qui consomme `useOrchestrators()`, calcule `total = Σ msgCount`, maintient un ring buffer 60-pts via `useRef`+`useState`, tick interne `setInterval` 60 s qui snapshot `total` et push `delta` dans le ring. |
| `/home/ubuntu/projets/swarm-os/packages/web/src/components/LeftPanel.tsx` (**nouveau**) | Adapte `prototypes/panels.jsx:58-71`. Consomme `useMessageFlow()`. |
| `/home/ubuntu/projets/swarm-os/packages/web/src/components/BigGraph.tsx` (**nouveau** — ou inline dans LeftPanel) | SVG sparkline 60-pts gradient amber + end-dot. Copie quasi 1:1 de `prototypes/panels.jsx:25-56`. |
| `/home/ubuntu/projets/swarm-os/packages/web/src/hooks/useMessageFlow.test.ts` (**nouveau**) | Tests Vitest : rotation ring buffer, calcul delta, robustesse total décroissant, comportement après >60 ticks. |

### 4.2 Option v2 (pour référence — si S9 est couplé)

| Chemin absolu | Modification |
|---|---|
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/metrics/aggregator.ts` (**nouveau**) | Classe `MessagesAggregator(spawner)` : `start()`, `stop()`, `tick()` (interne, exposé pour tests), `snapshot()`. Tient `_history: number[60]` et `_lastSnapshotTotal`. `computeTotal()` = somme directe via `spawner.list()` à chaque appel (cf. §7.3). |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/metrics/aggregator.test.ts` (**nouveau**) | Tests unitaires : init, tick, rotation, clamp delta négatif, idempotence start/stop. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/http/routes/metrics.ts` (**nouveau**) | `createMetricsRouter(aggregator)` exporte `GET /metrics/messages` → `res.json(aggregator.snapshot())`. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/http/main.ts` | Importer + monter `createMetricsRouter` **après** l'auth middleware (X-Auth-Token comme les autres routes métier). |
| `/home/ubuntu/projets/swarm-os/packages/server/src/index.ts` | `const aggregator = new MessagesAggregator(spawner); aggregator.start();` après le Spawner. `aggregator.stop()` dans `shutdown()`. |
| `/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts` | Type `MessagesMetricsView { total, per_minute, history }` + `api.metricsMessages()`. |
| `/home/ubuntu/projets/swarm-os/packages/web/src/hooks/useMessageFlow.ts` (**nouveau**, v2) | Fetch `api.metricsMessages()` toutes les 5-10 s. Pas de ring buffer côté client. |
| `/home/ubuntu/projets/swarm-os/packages/server/test/integration/rest-metrics.test.ts` (**nouveau**) | E2e : créer orch, broadcast N, `aggregator.tick()` injecté, `GET /metrics/messages` → `total === N`, `history[59] === N`. Auth 401 sans token. |

### 4.3 Alternative rejetée : `messages_total` dans `/health`

Pourquoi non : `/health` est public (exposer le débit à des scans) ;
healthchecks Docker à 1 req/5s ajouteraient une boucle `spawner.list()`
à chaque hit ; mélange "is alive ?" vs "métriques applicatives". Si on
veut un endpoint dédié, mieux vaut v2.

---

## 5. Plan d'implémentation (v1)

### Étape 1 — Vérifier que S1 est mergé

`OrchestratorView.msgCount: number` doit être exposé par
`GET /orchestrators` et `GET /orchestrators/:id`. Sinon **bloquer S4**.

### Étape 2 — Hook `useMessageFlow` (squelette)

```ts
// packages/web/src/hooks/useMessageFlow.ts
const HISTORY_SIZE = 60;
const TICK_MS = 60_000;

export function useMessageFlow() {
  const { orchestrators } = useOrchestrators();
  const total = orchestrators.reduce((acc, o) => acc + (o.msgCount ?? 0), 0);

  // Pattern ref-suit-état : le setInterval lit la dernière valeur sans
  // qu'on recrée l'interval à chaque changement de `total`.
  const totalRef = useRef(total);
  useEffect(() => { totalRef.current = total; }, [total]);

  const lastSnapshotRef = useRef<number>(total);
  const [history, setHistory] = useState<number[]>(() => new Array(HISTORY_SIZE).fill(0));

  useEffect(() => {
    const id = setInterval(() => {
      const t = totalRef.current;
      const delta = Math.max(0, t - lastSnapshotRef.current);
      lastSnapshotRef.current = t;
      setHistory((h) => [...h.slice(1), delta]);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  return { total, perMinute: history[HISTORY_SIZE - 1], history };
}
```

### Étape 3 — `LeftPanel.tsx` + `BigGraph.tsx`

Adaptation TS 1:1 de `prototypes/panels.jsx:25-71`. Pur rendu.

### Étape 4 — Tests (§6) + câblage dans le shell desktop

---

## 5bis. Plan v2 — squelette aggregator

```ts
// packages/server/src/modules/metrics/aggregator.ts
export class MessagesAggregator {
  private static readonly HISTORY_SIZE = 60;
  private static readonly TICK_MS = 60_000;
  private _history = new Array(60).fill(0);
  private _lastSnapshotTotal = 0;
  private _interval: NodeJS.Timeout | null = null;
  constructor(private readonly spawner: Spawner) {}

  /** @internal — exposed for tests. */
  tick(): void {
    const total = this.computeTotal();
    const delta = Math.max(0, total - this._lastSnapshotTotal);
    this._lastSnapshotTotal = total;
    this._history.shift();
    this._history.push(delta);
  }
  start(): void {
    if (this._interval) return;
    this._lastSnapshotTotal = this.computeTotal();  // §7.5 choix b
    this._interval = setInterval(() => this.tick(), 60_000);
    this._interval.unref?.();
  }
  stop(): void { if (this._interval) { clearInterval(this._interval); this._interval = null; } }
  snapshot(): MessagesSnapshot {
    return { total: this.computeTotal(),
             per_minute: this._history[this._history.length - 1],
             history: [...this._history] };
  }
  private computeTotal(): number {
    let acc = 0;
    for (const o of this.spawner.list()) acc += o.mailbox.messagesTotal;
    return acc;
  }
}
```

Le ring buffer ne stocke **que les deltas**, jamais le total — c'est ce
qui garantit `snapshot().total === Σ msgCount` à tout instant (§7.3).

---

## 6. Tests à écrire

### 6.1 v1 — `useMessageFlow.test.ts` (unitaires Vitest)

| Cas | Attendu |
|---|---|
| 0 orch | `total === 0`, `perMinute === 0`, `history.length === 60`, tous 0 |
| 3 orchs `msgCount` = 100, 200, 300 | `total === 600` |
| 1er tick avec total === total init (600) | `delta === 0` (lastSnapshot init à `total`) |
| Tick après `total` passé de 600 à 642 | `history[59] === 42` |
| 65 ticks delta=1 chacun | `history.length === 60`, somme 60 (5 oldest droppés) |
| Total décroît (orch retiré théorique) | `delta` clampé à 0 |
| Modif `total` sans tick | `history` inchangé, `total` à jour, `perMinute` = dernière valeur |

`vi.useFakeTimers()` + `vi.advanceTimersByTime(60_000)`. Vérifier que
l'interval est à 60 s, pas 60 ms.

### 6.2 v2 — `aggregator.test.ts`

| Cas | Attendu |
|---|---|
| Aggregator neuf, `snapshot()` immédiat | `total === Σ msgCount initial`, `per_minute === 0`, history full 0 |
| `tick()` après init, total inchangé | history toujours 0, `per_minute === 0` |
| `tick()` après total grimpé de 0 à 42 | `history[59] === 42`, `per_minute === 42` |
| 60 ticks delta=1 chacun | `history === [1,1,...]`, length 60 |
| 61 ticks delta=1 | length 60 (shift OK), pas de fuite mémoire |
| 1000 ticks | length 60 (sanity perf) |
| `stop()` après `start()` | Plus de tick |
| `start()` 2× sans `stop()` | Idempotent (1 seul timer) |
| Total décroît (Map réorganisée) | `delta` clampé à 0, `_lastSnapshotTotal` recalé |

Injection : exposer `tick()` `@internal` et appeler directement,
sans dépendre du vrai `setInterval`.

### 6.3 v2 — `rest-metrics.test.ts` (e2e)

- `GET /metrics/messages` initial → `total === 0`, `history.length === 60`,
  tous 0.
- Broadcast N messages, appeler `aggregator.tick()` injecté (via le
  handle de serveur de test), `GET /metrics/messages` → `total === N`,
  `history[59] === N`, `per_minute === N`.
- 401 sans X-Auth-Token (l'endpoint est derrière l'auth middleware).

### 6.4 Non-régression

- `/health` réponse inchangée (v1 et v2).
- `/orchestrators` retourne toujours `msgCount` (couvert par S1).

---

## 7. Gotchas / pièges

### 7.1 Reset au restart serveur — assumé

`msgCount` (S1) et ring buffer (v2) sont in-memory. Au restart : total
= 0, history = 0. Cohérent avec la sémantique des mailboxes
(non-persistées par design, plan §11). À documenter dans l'UI : la
sparkline représente le process courant, pas un historique long terme.

### 7.2 Persistance optionnelle au shutdown propre

Question implicite : dumper le ring buffer à disque au SIGTERM et le
recharger au boot ? **Non en v1/v2** : ne couvre pas les crashes,
sémantique douteuse quand le process a été éteint 3 jours.
Compromis le moins coûteux : badge "data since process start" à côté
de la sparkline.

### 7.3 Cohérence S4 ↔ S1 — somme directe vs snapshot indépendant

**Risque concret v2** : si `MessagesAggregator` maintient un `_total`
indépendant (par exemple via un listener `eventBus` sur S2), alors :

- La pill per-team peut afficher `msgCount = 100` (S1) et `metrics.total
  = 97` (snapshot du dernier tick) → écart visible.
- Un orch créé entre 2 ticks décale le calcul.

**Mitigation** : `computeTotal()` **toujours** `Σ
orch.mailbox.messagesTotal` à chaque appel. Le ring buffer ne stocke
que les **deltas**. Avec cette discipline,
`metrics.total === Σ team.msgCount` à tout instant. v1 n'a pas ce
risque (somme directe trivialement cohérente).

### 7.4 Concurrence — N/A en Node mono-thread

`setInterval` et `mailbox.push()` ne peuvent s'entrelacer (event loop
unique). Aucune mutex.

### 7.5 Premier tick : delta = total courant ou delta = 0 ?

Deux interprétations :

- (a) `_lastSnapshotTotal` init à 0 → 1er tick a `delta = total entier`
  (énorme si le process tourne depuis longtemps avant le start).
- (b) `_lastSnapshotTotal` init à `computeTotal()` dans `start()` →
  1er tick reflète **uniquement les 60 dernières secondes**.

**Recommandation : (b)** — sémantiquement correct pour un msg/min. v1
suit le même principe (`lastSnapshotRef.current = total` à l'init).

### 7.6 Exposition via `/health` vs endpoint dédié

Voir §2.1 et §4.3. Si on capitule sur l'auth pour simplifier : renommer
en `messages_total`, ne PAS ajouter `per_minute` ni `history`. Verdict :
si on en arrive là, autant choisir v2 endpoint dédié.

### 7.7 Recoupement avec S9 (CRITIQUE)

S9 (`/metrics/messages` sparklines per_orchestrator) **a exactement le
même nom d'endpoint** que S4-v2. Ce n'est pas un hasard — S9 est
l'évolution naturelle de S4-v2. Schéma S9 fusionné :

```json
{
  "total": 12345,
  "per_minute": 42,
  "history": [80, 92, ...],
  "per_orchestrator": { "atlas": [12, 18, ..., 42], ... }
}
```

**Conséquence** : si v2, faire S4 et S9 **dans le même patch** (mêmes
ticks, même router, même `aggregator.ts`). Le ring buffer per-orch
(`Map<orchId, number[8]>`) s'ajoute trivialement au même tick. Faire
S4-v2 isolé puis S9 plus tard = double travail.

Pour v1, aucun problème de naming (pas d'endpoint). Quand S9
arrivera, le hook v1 sera simplement remplacé par un hook v2.
Migration douce.

### 7.8 Tick aligné sur l'horloge système ?

Non — intervalle simple de 60 s depuis le start. Alignement absolu
n'apporte rien et complique le code.

### 7.9 Performance de `computeTotal()`

O(N orchs). À N=100 → 100 lectures de champ, µs. Aucun cache nécessaire.

### 7.10 `useOrchestrators()` en cours de chargement

v1 dépend du polling 3 s de `useOrchestrators` (cf.
`hooks/useOrchestrators.ts:10`). En phase de loading initial,
`orchestrators = []` → `total = 0`. Le 1er tick écrirait `delta = 0` :
OK. Si on veut être plus propre, ne pas démarrer le tick avant le 1er
`loading: false`.

### 7.11 Le proto utilise des valeurs simulées

`prototypes/data.jsx:113-122` borne artificiellement `v ∈ [20, 180]`.
**Simulation pure**, ne pas reproduire. Le SVG `BigGraph` gère
`max = Math.max(...data, 1)` → fonctionne quand toutes les valeurs
sont 0 (sparkline plate, OK visuellement).

---

## 8. Dépendances avec d'autres lots

| Lot | Lien |
|---|---|
| **S1** Compteur par orch | **Prérequis dur** — sans `OrchestratorView.msgCount`, v1 n'a rien à sommer. |
| **S2** Event `mailbox.message` | Aucune dépendance directe. v1 polle REST ; v2 a son tick local. L'event S2 sert aux pulses MapView (temps réel), pas à la sparkline (granularité minute). |
| **S8** `/metrics/bus` (`throughput_msg_per_s`) | S8 peut réutiliser `aggregator._history` (v2). Sinon recalcul indépendant côté serveur. |
| **S9** `/metrics/messages` (sparklines per-orch) | **Chevauchement majeur** (§7.7). Mêmes endpoint, mêmes ticks. Faire les deux ensemble si v2. |

Schéma :

```
S1 ── (prérequis dur) ──→ S4 v1 et v2
S4 v2 ── (fusionnable) ──→ S9
S4 v2 ── (alimente) ──→ S8 (throughput)
```

---

## 9. Critères d'acceptation vérifiables

### 9.1 v1 (recommandée)

1. Hook `useMessageFlow()` exporté depuis `packages/web/src/hooks/`.
2. Retourne `{ total: number, perMinute: number, history: number[60] }`.
3. Initialement, `history.length === 60` et tous éléments à 0.
4. `total === Σ orchestrators.msgCount` à chaque rendu.
5. Après 1 tick simulé (60 s), `history[59]` contient `delta`
   clampé `[0, +∞[`.
6. Après 61 ticks, `history.length === 60` (rotation correcte).
7. Tests Vitest verts (§6.1).
8. `LeftPanel.tsx` affiche `total.toLocaleString()` + `+{perMinute}/min`
   + `<BigGraph data={history} />`.
9. `pnpm -w test`, `pnpm -w lint`, `pnpm -w typecheck` passent.
10. `docker build -t swarm-os:latest .` + `docker compose -f
    docker-compose.test.yml up -d` démarrent la nouvelle UI sans erreur.

### 9.2 Additionnels v2

11. `GET /metrics/messages` retourne `{ total, per_minute, history }`
    avec X-Auth-Token (401 sans token).
12. `aggregator.tick()` appelable depuis les tests pour forcer un
    snapshot sans attendre 60 s.
13. **Invariant** : `aggregator.snapshot().total === Σ spawner.list()
    .map(o => o.mailbox.messagesTotal)` à tout instant.
14. `aggregator.start()` / `aggregator.stop()` idempotents.
15. Tick `setInterval` `unref()` (ne tient pas le process Node éveillé).
16. Test e2e `rest-metrics.test.ts` vert (§6.3).
17. `aggregator.stop()` bien appelé depuis `shutdown()` dans
    `packages/server/src/index.ts`.

---

## 10. Estimation d'effort

| Version | Lignes nettes | Temps |
|---|---|---|
| **v1** (hook + LeftPanel/BigGraph + tests Vitest) | ~250 | 1-2 h |
| **v2** (aggregator + router + main + index + client + hook + LeftPanel + tests unit + e2e) | ~490 | 3-4 h |

Cohérent avec `update_system.md` qui classe S4 en `S→M` (S pour v1,
M pour v2).

---

## 11. Ordre d'application recommandé

### 11.1 v1

1. Vérifier que S1 est mergé (`msgCount` exposé). Sinon attendre.
2. Patch `useMessageFlow.ts` + tests.
3. `pnpm -F web test`.
4. Patch `LeftPanel.tsx` + `BigGraph.tsx`.
5. Câbler `<LeftPanel />` dans le shell desktop (idéalement même PR que S2).
6. `pnpm -w test && pnpm -w typecheck && pnpm -w lint`.
7. `docker build -t swarm-os:latest . && docker compose -f
   docker-compose.test.yml up -d`.
8. Vérif manuelle : créer 1 orch, envoyer 5 broadcasts, big number
   doit afficher `5`, sparkline doit montrer un point à 5 après 60 s.

### 11.2 v2 (à coupler avec S9)

1. S1 mergé.
2. `aggregator.ts` + tests unitaires.
3. `routes/metrics.ts`.
4. Câblage `http/main.ts` + `index.ts` (start/stop).
5. `client.ts` (type + API).
6. `useMessageFlow.ts` v2 + tests.
7. `LeftPanel.tsx` + `BigGraph.tsx`.
8. Tests e2e `rest-metrics.test.ts`.
9. **Anticiper S9** : ajouter `per_orchestrator` au snapshot dès ce
   patch pour éviter un breaking change immédiat.
10. `pnpm -w test && pnpm -w typecheck && pnpm -w lint`.
11. `docker build` + `docker compose up -d`.
