# S9 — Endpoint `/metrics/messages` (sparklines)

> Analyse en profondeur du lot **S9** de `docs/update_system.md`
> (lignes 189-208). À lire après `01_compteur_messages_orchestrator.md`
> (S1) et **surtout** `04_compteur_global_messages.md` (S4) — ces
> deux lots partagent le même nom d'endpoint. Aucun code de production
> produit ici.

---

## 1. Résumé du besoin

L'UI desktop affiche deux séries temporelles de débit bus
(`prototypes/panels.jsx:58-101`) : (a) un `BigGraph` 60 pts msg/min
sur 60 min glissantes pour le débit **global** (LeftPanel MESSAGE
FLOW) ; (b) une `Sparkline` 8 pts msg/min par team sur les 8
dernières minutes (colonne PER-TEAM TRAFFIC). S9 centralise les deux
via `GET /metrics/messages` avec ring buffers en mémoire alimentés
par un tick 60 s qui snapshot les `msgCount` (S1). Perdu au restart
serveur, acceptable.

---

## 2. État du code existant

- **Aucun `/metrics/*`.** `grep -rn "metrics" packages/server/src/`
  → 0 match. Seul endpoint adjacent : `/health`
  (`packages/server/src/http/main.ts:69-79`) qui expose 4 compteurs
  ponctuels (`orchestrators_active`, `sessions_active`,
  `sessions_waiting`, `uptime_seconds`), sans série temporelle.
- **Aucun tick périodique applicatif.** `grep -n "setInterval"
  packages/server/src/` → 0 match. Seul `setTimeout` global = guard
  shutdown (`index.ts:168`). S9 **impose** un nouveau
  `setInterval(60_000)` câblé dans `index.ts` (start après Spawner,
  stop dans `shutdown()`).
- **Aucun ring buffer applicatif réutilisable.** L'unique
  `ringBuffer` (`session.ts:193`) stocke les lignes PTY pour xterm —
  sémantique sans rapport. Nouveau composant requis.
- **Source de vérité du débit : S1.** `Mailbox.messagesTotal`
  (introduit par S1, cf. `01_compteur_messages_orchestrator.md`) sera
  exposé via `OrchestratorView.msgCount`. **S1 est prérequis dur** de
  S9.
- **`spawner.list()` ne purge jamais.** `grep -rn
  "orchestrators.delete" packages/server/src/` → 0 match. La Map
  `Spawner.orchestrators` n'est jamais nettoyée durant la vie du
  process. Un orch `stopped`/`failed` reste avec `messagesTotal` figé
  (cf. `Orchestrator.stop()` ligne 367-369 qui clear le mailbox mais
  pas le compteur). Conséquence : l'agrégation est stable sur toute
  la vie du process — un orch ne disparaît pas brutalement de
  `per_orchestrator`.
- **Frontend vide.** `grep -rn "metrics\|sparkline" packages/web/src/`
  → 0 match. Aucun hook, aucun composant. Tout à créer
  (`useMessagesMetrics`, `BigGraph`, `Sparkline`, intégration
  `LeftPanel`). Le proto a des données simulées
  (`prototypes/data.jsx:104-122`) — référence visuelle uniquement.

---

## 3. Lien explicite avec S4 — fusion recommandée

### 3.1 Chevauchement

| Critère | S4 spec | S9 spec |
|---|---|---|
| Endpoint | `GET /metrics/messages` | `GET /metrics/messages` |
| Payload `total` / `per_minute` | Oui | Implicite |
| History 60 pts global | `history` | `global` |
| Sparklines 8 pts per-orch | Non | Oui |
| Tick 60 s | Oui (v2) | Oui |
| Source de vérité | Σ msgCount | Σ msgCount |
| Perdu au restart | Oui | Oui |

**Tout S4 v2 est un sous-ensemble strict de S9.** Les deux décrivent
**le même endpoint**, S9 = évolution naturelle de S4 (S4 §7.7).

### 3.2 Décision : un seul endpoint fusionné

Schéma final (cf. §12) : `{ total, per_minute, global,
per_orchestrator }`. `global` remplace `history` du brief S4 — un
seul nom clarifie vs `per_orchestrator`.

Cas pratiques :

1. **S4 livre l'alternative low-effort** (recommandée par S4) :
   aucun endpoint serveur n'existe encore → S9 introduit les 4
   champs en une fois, pas de migration.
2. **S4 v2 livré isolément avec `history`** : S9 enrichit avec
   `per_orchestrator`, renommer `history` → `global` est un breaking
   change pour un seul consommateur.
3. **Recommandation forte** : livrer S4 v2 et S9 dans le **même
   patch**. Aggregator, route, tests communs (cf. S4 §11.2).
   2 endpoints distincts doublerait tick/router/tests et créerait une
   dérive possible entre `metrics.total` et
   `Σ per_orchestrator.last_point`. Aucun bénéfice.

---

## 4. Fichiers à modifier

Liste exhaustive (option fusion S4+S9 recommandée) :

| Chemin absolu | Modification |
|---|---|
| `packages/server/src/modules/metrics/aggregator.ts` (**nouveau**) | Classe `MessagesAggregator(spawner)` : `start()`, `stop()`, `tick()` (`@internal`), `snapshot()`. État : `_global: number[60]`, `_perOrch: Map<id, number[8]>`, `_lastTotalsByOrch`, `_lastGlobalTotal`. |
| `packages/server/src/modules/metrics/aggregator.test.ts` (**nouveau**) | Tests Vitest avec `vi.useFakeTimers()` (§6.1). |
| `packages/server/src/http/routes/metrics.ts` (**nouveau**) | `createMetricsRouter(aggregator)` exporte `GET /metrics/messages`. |
| `packages/server/src/http/main.ts` | Monter le router **après** `auth` (ligne 130). Étendre `createApp`/`startServer` pour propager `aggregator`. |
| `packages/server/src/index.ts` | Instancier `aggregator` après `Spawner` (ligne 98), `aggregator.start()`. `aggregator.stop()` dans `shutdown()` (lignes 124-142) **avant** `spawner.shutdownAll`. |
| `packages/web/src/api/client.ts` | Ajouter type `MessagesMetricsView` + méthode `api.metricsMessages()` (lignes 136-193). |
| `packages/web/src/hooks/useMessagesMetrics.ts` (**nouveau**) | Polling 5-10 s de `api.metricsMessages()`. Pas de ring client. |
| `packages/web/src/components/LeftPanel.tsx` (**nouveau** ou enrichi) | Consomme le hook. `BigGraph data={global}` + map teams `<Sparkline data={per_orchestrator[t.id]} />`. |
| `packages/web/src/components/BigGraph.tsx` (**nouveau**) | SVG 60 pts gradient amber (proto `panels.jsx:25-56`). |
| `packages/web/src/components/Sparkline.tsx` (**nouveau**) | SVG 8 pts (proto). |
| `packages/server/test/integration/rest-metrics.test.ts` (**nouveau**) | E2e §6.2. |

(Tous les chemins sous `/home/ubuntu/projets/swarm-os/`.)

**Non-modifications confirmées** : `Mailbox` / `Orchestrator` (S1
fait le travail) ; `messaging.ts` (S9 lit, n'écrit pas) ; DB /
`persistence.ts` (métrique in-memory) ; event bus (S9 tick
indépendant).

---

## 5. Plan d'implémentation détaillé

### 5.1 Service singleton `MessagesAggregator`

Classe instanciée 1× par process, possédée par `index.ts`. État
interne déjà résumé en §4. API publique :

- `constructor(spawner)` — pas de démarrage.
- `start()` (idempotent) : initialise `_lastGlobalTotal` à
  `Σ messagesTotal` courant (pas 0, sinon 1er tick = total entier ;
  cf. S4 §7.5) et `_lastTotalsByOrch` pour chaque orch vivant. Lance
  `setInterval(tick, 60_000)` avec `unref()`.
- `stop()` (idempotent) : `clearInterval` et reset du handle.
- `tick()` (`@internal`, exposé pour tests) : (1) calcule
  `dGlobal = max(0, computeGlobalTotal() - _lastGlobalTotal)`,
  shift/push dans `_global` ; (2) pour chaque orch de `spawner.list()`,
  calcule `d = max(0, messagesTotal - _lastTotalsByOrch[id])`,
  shift/push dans son ring (init `[0]*8` si nouveau, §7.1) ; (3)
  branche défensive pour orchs disparus de `spawner.list()` (n'arrive
  pas aujourd'hui — Map jamais purgée — push 0).
- `snapshot()` : `total` recalculé à la demande via `Σ
  orch.mailbox.messagesTotal` (pas via `_lastGlobalTotal` — invariant
  §7.4), copie des rings, retourne `{ total, per_minute, global,
  per_orchestrator }`.

**Points-clés** : (1) le ring ne stocke **que des deltas** ; `total`
recalculé à chaque `snapshot()` (invariant §7.4) ; (2) pré-allocation
des rings à `0` (boot `global=[0]*60`, nouvel orch ring `[0]*8`, §7.1) ;
(3) itération sur `spawner.list()` (tous orchs y compris stopped), pas
`listActive()` — un orch stoppé voit ses 8 points décroître vers 0 sur
8 min (§7.2).

### 5.2 Route REST

`createMetricsRouter(aggregator)` exporte une seule route :
`GET /metrics/messages` → `res.json(aggregator.snapshot())`. Montée
dans `http/main.ts` **après** `app.use(auth)` (ligne 130). Auth :
X-Auth-Token (hérité comme `/orchestrators`).

### 5.3 Câblage `index.ts`

Après `new Spawner(...)` ligne 98, avant `startServer(...)` :
instancier l'aggregator, appeler `start()`. Étendre `createApp` /
`startServer` pour propager l'instance au router (4ème paramètre).
Dans `shutdown()` (lignes 124-142), appeler `aggregator.stop()`
**avant** `spawner.shutdownAll(...)`.

### 5.4 Client web

Ajouter dans `client.ts` :

```ts
export interface MessagesMetricsView {
  total: number;
  per_minute: number;
  global: number[];                            // length 60
  per_orchestrator: Record<string, number[]>;  // chaque value length 8
}
// api.metricsMessages: () => request(...)
```

Hook `useMessagesMetrics` : polling `setInterval(10_000)` qui appelle
`api.metricsMessages()`. Pas de ring côté client (le serveur en tient
un).

### 5.5 Composants visuels

`BigGraph` et `Sparkline` : adaptation TS 1:1 du proto
(`prototypes/panels.jsx:25-56` + Sparkline 8-pts). Gérer
`data.length === 0` (pas encore reçu) → ligne plate. `max =
Math.max(...data, 1)` évite la division par zéro.

---

## 6. Tests à écrire

### 6.1 `aggregator.test.ts` (unitaires)

`vi.useFakeTimers()` + `vi.advanceTimersByTime(60_000)`. Faux spawner
qui retourne `{ id, mailbox: { messagesTotal } }`.

| Cas | Attendu |
|---|---|
| Neuf sans `start()`, `snapshot()` | `total=0`, `global.length=60` tous 0, `per_orchestrator={}` |
| `start()` + `snapshot()` immédiat | identique (pas de tick) |
| 1 tick, totaux inchangés | `global[59]=0`, `per_minute=0` |
| 1 tick, 1 orch 0 → 42 | `global[59]=42`, `per_orchestrator[id][7]=42` |
| 2 orchs A=10, B=30, 1 tick | `global[59]=40`, `[A][7]=10`, `[B][7]=30` |
| 8 ticks delta=1 | ring `[1]*8` |
| 9 / 60 / 61 / 1000 ticks | longueurs ring stables (8 et 60) |
| Orch créé après N ticks | apparaît avec ring `[0,0,0,0,0,0,0,delta]` (§7.1) |
| `messagesTotal` décroît (théorique) | delta clampé à 0 |
| `start()` 2× | idempotent (1 seul timer) |
| `stop()` avant/après | no-op / plus de tick |
| Init avec orchs déjà à 500 msg, 1er tick inchangé | `delta=0` (pas 500) |

### 6.2 `rest-metrics.test.ts` (e2e)

Pattern existant : `test/integration/rest-orchestrator.test.ts`.
Injection du `tick()` : exposer `aggregator` sur le `ServerHandle` de
test pour ne pas attendre 60 s.

| Cas | Attendu |
|---|---|
| Sans token | 401 |
| Boot, 0 orch | `{ total:0, per_minute:0, global:[0]×60, per_orchestrator:{} }` |
| 1 orch + broadcast N + tick | `total=N`, `global[59]=N`, `per_orchestrator[id][7]=N` |
| 2 orchs A/B + broadcasts différenciés + tick | 2 clés dans `per_orchestrator` |
| Stop orch A, 8 ticks | `per_orchestrator[A]` reste, ring → `[0]*8` |
| Invariant croisé | `metrics.total === Σ /orchestrators[].msgCount` |

### 6.3 Non-régression

`/orchestrators` retourne toujours `msgCount` (S1) ; `/health`
réponse inchangée ; pas d'effet de bord sur le bus (tick lit, n'écrit
pas).

---

## 7. Gotchas / pièges

### 7.1 Orchs créés en cours de vie — ring vide ou 0 ?

7 points historiques manquants pour un orch créé entre 2 ticks.
Options : (a) `null` → complique typage et rendu, à éviter ; (b) `0`
→ sparkline part "à plat", **choix recommandé** ; (c) ne pas exposer
tant que ring incomplet → aberrant UX. L'aggregator initialise
`[0]*8` à la découverte d'un nouvel `orch.id`. **À documenter UI** :
un orch créé il y a 3 min affiche `[0,0,0,0,0,12,18,9]` — c'est
attendu.

### 7.2 Orchs supprimés — garder l'historique ?

`spawner.list()` retourne **tous** les orchs (jamais purgés, §2). Un
orch `stopped` reste avec `messagesTotal` figé → delta 0 à chaque
tick → sparkline se vide vers `[0]*8` sur 8 min (la team "s'éteint"
visuellement, comportement souhaité).

Si un jour `Spawner` purge les orchs morts, la branche défensive de
§5.1 (`for (const id of this._perOrch.keys())`) gère le cas. Pour
v1, garder la clé `per_orchestrator[id]` indéfiniment — un ring 8-pts
est trivial en mémoire. Test inclus : stop orch, tick × 10, ring →
`[0]*8`.

### 7.3 Reset au restart serveur — assumé

`messagesTotal` (S1) et toutes les structures de l'aggregator sont
in-memory. Restart → tout part à 0. Au restart, `start()` peuple
`_lastTotalsByOrch` à partir de `Σ messagesTotal` (= 0 — les orchs
ressuscités via `persistence.recoverFromCrash()` ont une nouvelle
Mailbox). Cohérent. **À documenter UI** : badge "data since process
start" (cf. S4 §7.2).

### 7.4 Cohérence S1/S4/S9 — invariant à maintenir

Risque : un `_total` indépendant (par ex. incrément sur event
`mailbox.message` de S2) pourrait diverger de `Σ msgCount`.
Mitigation : `snapshot().total` toujours recalculé via
`Σ orch.mailbox.messagesTotal`. Le ring ne stocke que des **deltas**.
Invariant testable (§6.2) :

```
snapshot.total === Σ spawner.list().map(o => o.mailbox.messagesTotal)
              === Σ orchestrators[].msgCount  (via /orchestrators)
```

Et par construction (deltas calculés au même tick depuis la même
source) :  `Σ per_orchestrator[*][7] === global[59]`.

### 7.5 Granularité, drift, performance, concurrence

`setInterval(60_000)` non aligné horloge (indifférent UI). Event loop
saturé peut driver de quelques secondes sur 24 h (60 pts couvrent
60 min ± 30 s). `_computeGlobalTotal()` O(N orchs), µs à 100 orchs.
100 orchs × 8 entiers + 60 globaux = ~7 KB en mémoire. Node
mono-thread → callbacks `setInterval`/`snapshot()` ne s'entrelacent
pas, aucune mutex.

### 7.6 Migration depuis S4-v2 isolé

Si S4-v2 livré avant S9 avec `history` : soft = garder
`history`+`global` puis déprécier ; hard = renommer brutalement
(risque casser un dashboard). Raison de plus pour livrer S4-v2 et S9
dans le même patch.

### 7.7 Pollage client, clés JSON, auth, proto

- À 1 s de poll, le snapshot reste identique entre 2 fetches tant
  qu'aucun tick 60 s n'a eu lieu. **5-10 s = bon réglage.**
  Alternative future : event WS `metrics.tick` (hors scope v1).
- `per_orchestrator: Record<string, number[]>` utilise l'UUID
  (`OrchestratorView.id`), **pas le `name`** (collisions/mutations).
- Endpoint **authentifié X-Auth-Token** comme `/orchestrators` (cf.
  S4 §4.3). Pas dans `/health` public.
- `prototypes/data.jsx:104-122` simule (sinus + bruit). Ne pas
  reproduire — les vrais deltas sont 0 au boot et montent
  organiquement.

---

## 8. Dépendances avec d'autres lots

- **S1** (compteur par orch) : **prérequis dur** — sans
  `Mailbox.messagesTotal`, rien à lire.
- **S2** (event `mailbox.message`) : **indépendant.** S2 = pulses
  MapView (temps réel), S9 = tick minute. Aucun couplage.
- **S4** (`/metrics/messages` global) : **chevauchement majeur**
  (§3). Même endpoint, mêmes ticks, même ring buffer global. À livrer
  **dans le même patch**.
- **S8** (`/metrics/bus`) : recoupement partiel
  (`throughput_msg_per_s = global[59] / 60`). L'aggregator S9 est
  réutilisable par S8. Planning **indépendant**.

```
S1 ── (prérequis dur) ──→ S9
S4 v2 ──── (FUSION recommandée) ──── S9
S9  ── (matériau de) ──→ S8 (throughput)
```

---

## 9. Critères d'acceptation vérifiables

Le patch S9 (fusionné S4+S9) est complet si tous les critères passent :

1. Nouveau module `packages/server/src/modules/metrics/aggregator.ts`
   exporte `MessagesAggregator`.
2. `start()` / `stop()` idempotents (2 appels → no-op).
3. `start()` initialise `_lastGlobalTotal` à `Σ messagesTotal` courant
   (pas 0). `tick()` exposé `@internal` pour les tests.
4. `snapshot()` retourne `{ total, per_minute, global, per_orchestrator }`
   avec `global.length === 60` et chaque ring `per_orchestrator[*].length === 8`.
5. **Invariant** : `snapshot().total === Σ
   spawner.list().map(o => o.mailbox.messagesTotal)` à tout instant.
6. **Invariant** : `Σ per_orchestrator[*][7] === global[59]` à tout
   instant (sauf bord pour un orch créé entre 2 ticks).
7. Nouvel orch créé entre 2 ticks → ring `[0,0,0,0,0,0,0,delta]`.
8. Orch stoppé reste dans `per_orchestrator`, ring tend vers `[0]*8`
   après 8 ticks.
9. Deltas clampés `≥ 0`.
10. `GET /metrics/messages` retourne le snapshot en JSON ; 401 sans
    X-Auth-Token.
11. `aggregator.stop()` appelé dans `shutdown()` de `index.ts`.
12. `setInterval` interne fait `unref()`.
13. Hook `useMessagesMetrics()` exporté côté web ; `LeftPanel.tsx`
    consomme le hook, rend `BigGraph` + sparklines per-team.
14. Tests `aggregator.test.ts` verts (§6.1), e2e `rest-metrics.test.ts`
    vert (§6.2).
15. `pnpm -w test && pnpm -w typecheck && pnpm -w lint` passent.
16. `docker build -t swarm-os:latest .` + `docker compose -f
    docker-compose.test.yml up -d` démarrent sans erreur.
17. Aucune régression sur `/orchestrators`, `/sessions`, `/health`.

---

## 10. Estimation d'effort

~480 lignes nettes au total : `aggregator.ts` (~80) +
`aggregator.test.ts` (~150) + `routes/metrics.ts` (~15) + câblage
(~10) + `client.ts` (~10) + hook (~25) + `BigGraph.tsx` +
`Sparkline.tsx` (~80) + `LeftPanel.tsx` (~30) + `rest-metrics.test.ts`
(~80). Cohérent avec `update_system.md` qui classe S9 en effort `M`
(Medium). Combiné S4-v2 + S9 dans le même patch : ~500 lignes (tout
partagé) au lieu de ~490 + ~250 = ~740 si livrés séparés.

---

## 11. Ordre d'application recommandé

1. Vérifier S1 mergé (`Mailbox.messagesTotal` présent). Sinon bloquer.
2. `aggregator.ts` + `aggregator.test.ts` (Vitest fake timers).
   `pnpm -F server test`.
3. `routes/metrics.ts`, câblage `http/main.ts` (après auth) +
   `index.ts` (start/stop). Propager l'aggregator via
   `createApp`/`startServer`.
4. `test/integration/rest-metrics.test.ts`. Faire tourner.
5. Web : `client.ts` + `useMessagesMetrics.ts` + `BigGraph.tsx` +
   `Sparkline.tsx` + intégration `LeftPanel.tsx`.
6. `pnpm -w test && pnpm -w typecheck && pnpm -w lint`.
7. `docker build -t swarm-os:latest . && docker compose -f
   docker-compose.test.yml up -d`.
8. Vérif manuelle : boot → `total=0`, `global=[0]*60` ; 2 orchs +
   broadcasts → 60 s plus tard `total`, `global[59]`,
   `per_orchestrator[*][7]` cohérents ; UI affiche `BigGraph` +
   sparklines.

---

## 12. Schéma payload final retenu

```json
{
  "total": 12345,
  "per_minute": 42,
  "global": [0, 0, 0, ..., 12, 18, 42],
  "per_orchestrator": {
    "11111111-...": [0, 0, 0, 0, 0, 12, 18, 9],
    "22222222-...": [4, 7, 5, 9, 6, 11, 8, 10]
  }
}
```

`total`/`per_minute` : compat S4. `global` (length 60) et
`per_orchestrator` (values length 8) : cœur S9. Compteurs entiers ≥
0. Clés de `per_orchestrator` = UUID `OrchestratorView.id` (pas le
`name`).
