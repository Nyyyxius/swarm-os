# S8 — Endpoint `/metrics/bus`

> Analyse en profondeur du lot **S8** de `docs/internal/ui-redesign/update_system.md`. Aucun
> code de production produit ici. À lire après
> `01_compteur_messages_orchestrator.md` (S1 = prérequis pour le
> throughput) et `04_compteur_global_messages.md` (S4 = chevauchement
> sur l'agrégation globale). Préfigure S9 (`/metrics/messages`) qui
> partagera la même infrastructure de tick et le même router
> `/metrics/*`.

---

## 1. Résumé du besoin

La section **BUS HEALTH** du LeftPanel desktop (cf.
`prototypes/panels.jsx`) doit afficher 4 KPIs rafraîchis
périodiquement : `latency_ms` (moyenne RTT MCP request→response sur
60 s), `throughput_msg_per_s` (débit moyen mailbox sur 60 s),
`queue_depth` (somme instantanée des inboxes), `err_rate_pct` (%
d'erreurs MCP sur 60 s).

Aucun de ces signaux n'existe aujourd'hui. Il faut (a) instrumenter le
serveur MCP pour mesurer latence et erreurs, (b) agréger les mailboxes
en temps réel, (c) exposer un endpoint REST `GET /metrics/bus`
authentifié. Le brief autorise une livraison en deux temps : v1 avec
latency + queue_depth (faciles), v2 avec throughput + err_rate
(nécessite ring buffer et compteurs).

---

## 2. État du code existant

### 2.1 Aucun endpoint `/metrics/*` et aucun router à étendre

`grep -rn "/metrics" packages/server/src/` → 0 match. Routers actuels
montés dans `packages/server/src/http/main.ts:131-134` : orchestrators,
sessions, ws-ticket, roles. **Un nouveau router** dans
`packages/server/src/http/routes/metrics.ts` est requis. Il sera monté
**après** `makeAuthMiddleware` (`http/main.ts:130`), donc protégé par
`X-Auth-Token` — cohérent avec orchestrators/sessions.

### 2.2 `mcp/server.ts` — point d'instrumentation latency + errors

Fichier réel : `packages/server/src/modules/mcp/server.ts` (323
lignes). La méthode privée `handle(req, res)` (lignes 155-258) est LA
fonction qui ceinture chaque appel MCP. Schéma actuel : (1) parse URL
`/mcp/:orch_id/:secret` ; (2) `resolveContext()` → `null` ⇒ 404 (pas
un appel MCP comptable) ; (3) `readJsonBody()` ; (4) construction
`SdkMcpServer` + `StreamableHTTPServerTransport` ; (5)
`transport.handleRequest()` (l. 247) — l'appel qui exécute la tool ;
(6) `catch` (l. 248) qui logge `mcp.transport_failed` et renvoie 500.

C'est entre l'avant-3 et la sortie de 5 (avec le catch 6) qu'on
instrumente. Important : seuls les chemins qui passent l'auth (étape
2 OK) doivent être comptés. Compter les 404 d'auth gonflerait
artificiellement `err_rate_pct` à chaque tentative de probe. Le SDK
exporte aussi `isInitializeRequest()` (utilisé l. 237) — on saura
distinguer un appel `initialize` d'un appel de tool si besoin.

### 2.3 `Mailbox.size()` — confirmé, mais signature par session

`packages/server/src/modules/orchestrator/mailbox.ts:137-139` :

```ts
size(sid: string): number {
  return this.inboxes.get(sid)?.length ?? 0;
}
```

**Attention** : `size(sid)` retourne la profondeur de l'inbox d'**une**
session. Le brief parle de "somme des `Mailbox.size()` sur tous les
orchestrators" — il faut itérer toutes les inboxes de tous les orchs.
La Map interne `inboxes` est privée. Deux options : (a) ajouter
`totalSize(): number` à `Mailbox` qui somme toutes les valeurs (1
ligne, propre) ; (b) itérer via
`orch.listSessions().reduce((acc, s) => acc + orch.mailbox.size(s.id), 0)`
— fonctionne mais fait fuiter le détail d'implémentation.
**Recommandation** : option (a), symétrique à `clearAll()` (l. 152).

### 2.4 Aucun tick global pour l'instant

`grep -n "setInterval" packages/server/src/` → 0 match. Le seul timer
de fond est le `gracefulShutdownTimer` (`index.ts`). v2 (throughput +
err_rate) nécessite un tick périodique. La même infrastructure
pourra servir S4 v2 et S9 (cf. §8).

### 2.5 `Spawner.list()` — accès stable aux orchs

`packages/server/src/modules/spawner/index.ts:174-176` retourne TOUS
les orchs. `Spawner.orchestrators.delete()` n'est jamais appelé (cf.
S4 §2.4). Pour `queue_depth` on filtre `listActive()` (l. 178) par
discipline — `mailbox.clearAll()` est appelé dans `orch.stop()` (l.
369) donc en pratique les orchs stoppés somment à 0 mais l'itération
reste inutile.

### 2.6 Pas de compteur de requêtes MCP, pas de consommateur frontend

`grep -n "requestCount\|mcp_requests\|metrics" packages/server/src/modules/mcp/` → 0 match.
`grep -rn "BusMetricsView\|metrics_bus" packages/web/src/` → 0 match.
Tout est à créer, type + hook frontend (`useBusHealth()`) inclus.

---

## 3. Décision recommandée : v1 partiel ou full ?

**Recommandation : livrer la v1 complète avec les 4 métriques**, pas
le subset latency + queue_depth proposé en alternative. Justifications :

1. **Coût marginal des 2 métriques manquantes faible** : une fois le
   tick 1 s en place pour le throughput (qui dépend lui-même de S1
   `msgCount`), exposer `err_rate_pct` à partir des compteurs MCP
   déjà instrumentés pour la latency est ~10 lignes en plus
   (incrémenter `errorsLast60s` sur `transport_failed`). On ne gagne
   pas une session de dev en l'élidant.
2. **UI mensongère sans les 4** : afficher `THRPT: —` à côté de
   `LATENCY: 42` envoie un signal incohérent — la section s'appelle
   "BUS HEALTH" et perd son sens si la moitié des indicateurs sont
   vides. Mieux vaut tout afficher ou tout retarder.
3. **Cohérence avec S1/S4** : le throughput *doit* être serveur-side
   parce qu'il est fenêtré sur 60 s et ne peut pas être recalculé à
   partir d'un seul snapshot — donc on fait l'effort une fois, dans
   S8, et S9 réutilisera la même structure de ring buffer.

**Garde-fou** : si le délai serré impose un choix, v1 = latency +
queue_depth + throughput (sans err_rate), pas latency + queue_depth
seuls. Throughput est LA métrique demandée par l'opérateur.

---

## 4. Fichiers à créer / modifier

### À créer

- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/metrics/bus.ts`
  — classe `BusMetricsCollector` : ring buffer latency, ring buffer
  messages_total, compteurs requests/errors, méthode `snapshot()`
  retournant le payload `/metrics/bus`.
- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/metrics/bus.test.ts`
  — tests unitaires des calculs (moyenne, throughput, err_rate).
- `/home/ubuntu/projets/swarm-os/packages/server/src/http/routes/metrics.ts`
  — router Express : `router.get('/metrics/bus', ...)`. Prêt à
  accueillir `/metrics/messages` (S9).
- `/home/ubuntu/projets/swarm-os/packages/server/test/integration/rest-metrics.test.ts`
  — e2e : create orch, instrumenter quelques calls MCP, GET
  `/metrics/bus`, assertions sur les champs.

### À modifier

- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/mcp/server.ts` —
  instrumenter `handle()` : timer `process.hrtime.bigint()` autour de
  `transport.handleRequest()`, hooks `collector.recordRequest(ms, ok)`.
  Le constructeur `McpServer` accepte un nouveau paramètre
  `collector?: BusMetricsCollector` (optionnel pour rétro-compat tests).
- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/mailbox.ts` —
  ajouter `totalSize(): number` (1 ligne).
- `/home/ubuntu/projets/swarm-os/packages/server/src/http/main.ts` —
  `createApp()` accepte un `BusMetricsCollector`, monte le router
  metrics après l'auth (l. 130).
- `/home/ubuntu/projets/swarm-os/packages/server/src/index.ts` —
  instancier `BusMetricsCollector` au boot, le passer à `McpServer`
  + `createApp`, l'arrêter dans le shutdown.
- `/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts` —
  type `BusMetricsView` + fonction `getBusMetrics()`.
- `/home/ubuntu/projets/swarm-os/packages/web/src/hooks/useBusHealth.ts`
  (nouveau) — poll 5 s avec abort sur unmount.

---

## 5. Plan d'implémentation détaillé

### 5.1 Structure interne `BusMetricsCollector`

Ring buffer 60 slots, 1 par seconde glissante. Chaque slot =
`{ requests, errors, latencySumMs, latencyCount }`. Plus un ring
buffer `msgTotals: number[60]` aligné sur les mêmes ticks.

**Pourquoi 60 slots de 1 s plutôt que 1 slot de 60 s** : permet une
moyenne glissante propre au lieu d'un saut brutal toutes les minutes.
Coût mémoire : 60 × ~40 bytes = négligeable.

**Tick** : un seul `setInterval(this.advance, 1000)` qui (1) avance
`cursor = (cursor + 1) % 60` ; (2) réinitialise le nouveau slot à 0 ;
(3) snapshot `messagesTotalNow = sum(orch.msgCount)` et l'écrit dans
`msgTotals[cursor]`.

**Cleanup** : `stop()` qui `clearInterval`. Appelé par
`ServerHandle.close()` (`http/main.ts:242`).

### 5.2 Mesure de la latency dans `mcp/server.ts`

Dans `handle()`, autour des l. 227-257 :

```ts
// PSEUDOCODE — NE PAS COPIER
const t0 = process.hrtime.bigint();
let ok = true;
try {
  await sdkServer.connect(transport);
  await transport.handleRequest(req, res, bodyForTransport);
} catch (err) {
  ok = false;
  // ... gestion existante (log + 500)
} finally {
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
  this.collector?.recordRequest(latencyMs, ok);
}
```

**À ne pas compter** : les 404 d'auth (`resolveContext` retourne
`null`, on return avant l'instrumentation, naturellement exclues),
les body parse errors (400 retourné l. 200 avant le `try`), les
`payload too large`. **À discuter** (cf. §7) : les requêtes
`initialize` doivent-elles compter ? v1 = oui, sans filtre.

### 5.3 Calcul des champs `snapshot()`

```text
latency_ms       = sum(slot.latencySumMs) / max(1, sum(slot.latencyCount))
throughput_msg/s = (msgTotals[cursor] - msgTotals[(cursor+1) % 60]) / window
queue_depth      = sum(orch.mailbox.totalSize() for orch in listActive())
err_rate_pct     = sum(slot.errors) / max(1, sum(slot.requests)) * 100
window_seconds   = 60
```

**Edge cases** : (a) throughput pré-buffer-plein — pendant les 60
premières secondes le slot `(cursor+1) % 60` =0, ce qui surestime le
débit ; corriger en divisant par `secondsSinceBoot = min(60,
floor((Date.now() - bootTs) / 1000))` ; (b) 0 requête sur la fenêtre
→ `latency_ms = 0` et `err_rate_pct = 0.0` (pas `null`, pas `NaN`).

### 5.4 Hookup au boot (`index.ts`)

```text
const collector = new BusMetricsCollector(spawner);
collector.start();
const mcp = new McpServer(spawner, config.mcpPort, config, collector);
const handle = startServer(config, spawner, roleStore, collector);
// shutdown : collector.stop();
```

### 5.5 Handler REST

`router.get('/metrics/bus', (_req, res) => res.json(collector.snapshot()))`.
Aucun param à valider. Auth héritée du middleware parent.

---

## 6. Tests à écrire

### 6.1 Unitaires (`modules/metrics/bus.test.ts`)

1. **Ring buffer latency** : 10× `recordRequest(100, true)` →
   `latency_ms === 100`. Mix 5×100 + 5×200 → 150.
2. **Avance temporelle** : enregistrer slot 0, avancer via
   `_tickForTest()`, réenregistrer ; moyenne couvre les 2 slots.
3. **Évacuation après 60 s** : slot 0 à 1000 ms + 60 ticks → slot 0
   réinitialisé.
4. **err_rate** : 10 requêtes dont 2 errors → 20.0. 0 requête → 0.0.
5. **throughput pré-buffer-plein** : 10 ticks, delta=100 → 10 msg/s
   (pas 100/60). Buffer plein : 60 ticks, delta=600 → 10 msg/s.
6. **queue_depth** : Spawner mock 3 orchs (5/3/7) → 15.

### 6.2 Unitaire `Mailbox.totalSize()`

Dans `mailbox.test.ts` existant : push 3 messages à `sidA`, 2 à
`sidB` → `totalSize() === 5`. Vider `sidA` via `read()` → `=== 2`.

### 6.3 e2e REST (`test/integration/rest-metrics.test.ts`)

- POST création orch ;
- 5 × `team.whoami` via le client MCP de test (réutiliser
  `mcp-swarm-tools.test.ts`) ;
- GET `/metrics/bus` → `latency_ms > 0`, `err_rate_pct === 0`,
  `window_seconds === 60`, structure complète ;
- 3 × `team.send_message` non lus → GET → `queue_depth >= 3`.

### 6.4 Auth

GET `/metrics/bus` sans header → 401. Bon token → 200. (Réutiliser
helper d'auth de `rest-orchestrator.test.ts`.)

---

## 7. Gotchas

### 7.1 Overhead de l'instrumentation MCP

`process.hrtime.bigint()` coûte ~50 ns. À ~hundreds of req/s c'est
< 0.01 % CPU — négligeable. L'écriture dans le ring buffer (1 lookup
+ 4 incréments) coûte ~200 ns. **Pas besoin de benchmark dédié**.

### 7.2 Latence "init" vs "tool" — biais possible

Un client MCP en mode stateless (le cas actuel, sessionIdGenerator
undefined l. 216) génère 1 init + 1 tool par requête. Si les init
sont à 1 ms et les tools à 50 ms, la moyenne tombe à 25 ms — peu
représentatif. **Solution** : si l'opérateur trouve ça trompeur,
ajouter un champ optionnel `kind` à `recordRequest` et exposer
`latency_ms_tool` séparément en v2.

### 7.3 Cohérence avec S1 et S4

`throughput` repose sur la somme `messagesTotal` exposée par S1. Si
S1 n'est pas mergé, S8 ne peut pas livrer ce champ. **Dépendance
dure**. S4 partage potentiellement le tick — voir §8.

### 7.4 Fenêtre glissante vs snapshot — sémantique

`latency_ms`, `throughput`, `err_rate` sont **glissants** sur 60 s.
`queue_depth` est un **snapshot instantané**. Le brief mélange les
deux — c'est intentionnel mais à documenter dans le commentaire du
handler : la profondeur n'a pas de sens "moyen" pour l'opérateur, il
veut savoir si ça déborde MAINTENANT.

### 7.5 Sécurité — endpoint public ou auth ?

`/health` est public mais ne révèle que des compteurs grossiers.
`/metrics/bus` exposerait latence MCP, profondeur de queue, taux
d'erreur — info exploitable pour profiler le bus côté attaquant
(timing d'une attaque DoS). **Recommandation** : monter **après**
`makeAuthMiddleware` → X-Auth-Token requis. Aligné avec l'invariant
plan §14.

### 7.6 Reset au shutdown — perte acceptée

Le collector est en mémoire. Restart → métriques à 0 + 60 s pour
re-remplir le buffer. **Acceptable**, cohérent avec la sémantique
des mailboxes non persistées.

### 7.7 Divergence si un orch disparaît

Si on calcule `messagesTotalNow = spawner.list().reduce((a,o) =>
a + o.msgCount, 0)` et qu'entre deux ticks un orch est supprimé, le
delta peut être artificiellement négatif. Solutions : (a) clamper
`throughput = max(0, ...)` ; (b) ne jamais supprimer un orch de la
Map (déjà le cas, cf. §2.5). **Recommandation** : (a) **et** (b).

### 7.8 Tick drift

`setInterval(1000)` peut drift de quelques ms par jour. Pas un
problème pour des moyennes glissantes sur 60 s.

---

## 8. Dépendances et coordination avec autres lots

### 8.1 Prérequis dur — S1

`throughput_msg_per_s` exige le compteur `messagesTotal` par orch
introduit en S1. Si on livre S8 en partiel (latency + queue_depth
seulement) on peut shipper avant S1, mais pas recommandé (§3).

### 8.2 Chevauchement — S4

S4 alternative low-effort = "frontend calcule le delta à partir du
total exposé". S4 v2 = "endpoint dédié avec ring buffer 60 entrées
par minute glissante". **S8 v1 complète chevauche déjà partiellement
S4** puisqu'il maintient un ring buffer de `messagesTotal` (à la
seconde, pas à la minute). Deux stratégies :
- (a) **livrer S8 d'abord, S4 plus tard** : `/metrics/bus` expose
  déjà `throughput_msg_per_s` ; S4 v2 ajoute une vue historique.
- (b) **factoriser** : un seul module `metrics/` avec deux ring
  buffers (60×1s pour S8, 60×1min pour S4) partageant le tick.

**Recommandation** : (b). Nommer le module et le router `metrics/`
(pas `bus-metrics/`) pour préparer S9 sans rebaptiser.

### 8.3 Lien — S9 (sparklines)

S9 a besoin de série globale 60×1min + per-orch 8×1min. Le collector
de S8 fournit la charpente — S9 ajoute des ring buffers à la minute
et un Map `orchId → ring buffer 8×1min`. Tick partagé. Mêmes routes
`/metrics/*`.

### 8.4 Indépendance — S7

S7 (`health` agrégé orch) n'interagit pas avec `/metrics/bus`. Ordre
de livraison libre.

---

## 9. Critères d'acceptation vérifiables

1. **Endpoint** : `GET /metrics/bus` avec header `X-Auth-Token` retourne
   200 + JSON conforme au schéma du brief (5 champs).
2. **Sans token** : 401.
3. **`window_seconds === 60`** sur toutes les réponses (constante).
4. **Au boot, avant 60 s** : `latency_ms === 0` si aucune requête MCP ;
   `throughput` rapporté au temps écoulé, pas à 60 (cf. §5.3).
5. **Après 5 appels MCP réussis** : `latency_ms > 0`,
   `err_rate_pct === 0`.
6. **Après 10 appels dont 2 erreurs MCP forcées** : `err_rate_pct`
   entre 19 et 21 (tolérance arrondi).
7. **Avec 3 messages non lus dans 2 inboxes** : `queue_depth === 3`.
8. **Après lecture d'inbox** : `queue_depth` diminue d'autant.
9. **Pas de crash** sur 10000 messages dans une inbox (totalSize
   reste O(N orchs × N sessions), linéaire en sessions pas en
   messages).
10. **Test e2e** `test/integration/rest-metrics.test.ts` vert dans la CI.
11. **Pas de régression** : `pnpm test` complet vert, en particulier
    `mcp-swarm-tools.test.ts` (instrumentation ne casse pas le flux MCP).
12. **Pas de fuite d'interval** : `ServerHandle.close()` appelle
    `collector.stop()`, vérifié dans le teardown des tests intégration.

---

## 10. Synthèse — recommandation finale

**Livrer S8 en une fois, les 4 métriques**. Bloqué seulement par S1
(prérequis throughput). Effort estimé : ~1 session de dev backend
(collector + instrumentation + router + tests) + ~½ session frontend
(`useBusHealth` + intégration LeftPanel). Le module `metrics/` sera
réutilisé tel quel par S9 — investissement partagé sur 2 lots.

Si la session disponible est plus courte : v1 partiel = latency +
queue_depth + throughput (sans err_rate). v1 strict du brief (latency
+ queue_depth seuls) n'est pas recommandé : l'UI résultante est
trompeuse.
