# S1 — Compteur de messages bus par orchestrator

Analyse en profondeur du lot **S1** de `docs/update_system.md`. Ce
document décrit ce qui doit être modifié, où, comment, et quels pièges
guetter. Aucun code de production n'est produit ici — uniquement le plan.

---

## 1. Résumé du besoin

La nouvelle UI desktop (cf. `prototypes/data.jsx`, champ `msgCount`) a
besoin d'un compteur cumulé du trafic bus par team pour alimenter :

- la **team-pill** de la TopBar (badge `msg`) ;
- la colonne **"Per-team traffic"** du LeftPanel.

Le compteur doit refléter **toutes** les opérations d'écriture en
mailbox d'un orchestrator donné, être **monotone strictement croissant**
(jamais reset), et être exposé sur la `OrchestratorView` (REST `GET
/orchestrators` + `GET /orchestrators/:id`). Pas de persistance — la
mailbox elle-même est in-memory (plan §11), donc le compteur repart à 0
au redémarrage serveur, ce qui est cohérent.

---

## 2. État du code existant — décalages avec `update_system.md`

### 2.1 Pas de `deliver()` ni `broadcast()` dans `Mailbox`

`update_system.md` parle d'incrémenter "à chaque `deliver()` et
`broadcast()`" dans `mailbox.ts`. **Ces méthodes n'existent pas.** La
classe `Mailbox`
(`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/mailbox.ts`)
expose uniquement :

- `push(to, msg)` → ligne 74, point d'entrée **unique** d'écriture.
- `read(sid)` → drain.
- `peek(sid)` → snapshot non destructif.
- `size(sid)`, `removeSession(sid)`, `clearAll()`.

Les notions `deliver` / `broadcast` vivent **un cran plus haut**, dans
`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.ts` :

- `sendMessage()` → ligne 131 (appelle `deps.mailbox.push(toSid, ...)`).
- `broadcast()` → ligne 195 (boucle qui appelle `deps.mailbox.push(s.id, ...)`).
- `sendMessageToLead()` → ligne 270 (cross-team, appelle `targetOrch.mailbox.push(...)`).
- `broadcastToLeads()` → ligne 364 (cross-team, idem).

Conséquence : **incrémenter à la source unique (`Mailbox.push`)
capture l'ensemble** des sites — sendMessage, broadcast, send_to_lead,
broadcast_to_leads, ET le push "system" de l'anomalie de worker
(`index.ts` ligne 560). C'est la bonne couche.

### 2.2 `OrchestratorView` n'a pas de champ `msgCount`

- Côté serveur : interface définie à
  `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/index.ts:35-53`.
- Côté client : interface définie à
  `/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts:15-33`.
- `toView()` est à
  `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/index.ts:403-422`.

### 2.3 Le proto attend bien `msgCount`

`prototypes/data.jsx` :
- ligne 11 : `msgCount: 1842,` (ATLAS)
- ligne 36 : `msgCount: 2410,` (FORGE)
- ligne 62 : `msgCount: 968,` (SENTRY)
- ligne 86 : `msgCount: 412,` (ORACLE)

Le nom de champ retenu côté UI est bien **`msgCount`**, c'est ce que S1
demande d'exposer. Cohérent.

---

## 3. Fichiers à modifier

| Chemin absolu | Modification |
|---|---|
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/mailbox.ts` | Ajouter `private _messagesTotal = 0;` + getter `get messagesTotal(): number`. Incrémenter dans `push()` (avant ou après le drop-oldest — voir §5). |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/mailbox.test.ts` | Étendre la suite : compteur incrémenté à chaque push, incrémente aussi quand drop-oldest, indépendant du destinataire (cumul global mailbox), pas reset par `removeSession`/`clearAll`/`read`. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/index.ts` | (a) Ajouter `msgCount: number;` dans `OrchestratorView` (ligne 35-53). (b) Dans `toView()` (ligne 403-422), peupler `msgCount: this.mailbox.messagesTotal`. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/persistence.ts` | Dans `rowToOrchView()` (ligne 168-189) ajouter `msgCount: 0` — les rows historiques DB n'ont jamais eu de mailbox vivante, donc 0 est le défaut sémantiquement correct. Pas de migration SQL nécessaire (le compteur n'est PAS persisté). |
| `/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts` | Ajouter `msgCount: number;` dans l'interface `OrchestratorView` (ligne 15-33). |
| `/home/ubuntu/projets/swarm-os/packages/server/test/integration/rest-orchestrator.test.ts` | Ajouter un test e2e (cf. §6). |

**Non-modifications confirmées** :

- `messaging.ts` : **rien à changer** — le compteur est en aval de `mailbox.push`, donc capturé naturellement.
- `index.ts:560` (push "system" pour anomalie worker) : **rien à changer** — passe par `mailbox.push`, compté automatiquement.
- DB schema (`packages/server/src/modules/db/`) : **pas de migration** — `msgCount` est in-memory, jamais persisté.
- Routes REST `orchestrators.ts` : **rien à changer côté code** — `toView()` est appelé par les routes existantes (`GET /orchestrators`, `GET /orchestrators/:id`).

---

## 4. Plan d'implémentation détaillé

### Étape 1 — Augmenter `Mailbox`

Dans `mailbox.ts` :

```ts
export class Mailbox {
  private readonly inboxes = new Map<string, Message[]>();
  private readonly maxSize: number;
  private _messagesTotal = 0;

  // ... constructor inchangé ...

  /**
   * Cumulative count of messages pushed into this mailbox since the
   * orchestrator started. Monotonic, NEVER reset (mailbox.clearAll(),
   * read(), removeSession() leave it untouched). Wraparound at
   * Number.MAX_SAFE_INTEGER (~9e15) is a non-issue at human pace
   * (>100k msg/sec for 2900 years).
   */
  get messagesTotal(): number {
    return this._messagesTotal;
  }

  push(to, msg): PushResult {
    // ... corps actuel ...
    q.push(full);
    this._messagesTotal++;  // <-- INCRÉMENT ICI, après l'écriture effective
    let dropped = false;
    if (q.length > this.maxSize) {
      // drop-oldest existant — NE PAS décrémenter (le message a bien
      // transité, le drop est une éviction par cap, pas une annulation).
      ...
    }
    return { dropped, queueSize: q.length };
  }
}
```

**Point clé** : l'incrément se fait **par appel à `push()`**, pas par
destinataire. Dans `broadcast()` (messaging.ts:213-227), N appels à
`mailbox.push(s.id, ...)` produisent N incréments — c'est la sémantique
attendue (cf. §5 ci-dessous).

### Étape 2 — Exposer sur `OrchestratorView`

Dans `index.ts` :

```ts
export interface OrchestratorView {
  // ... champs existants ...
  /** Phase update_system S1 : nombre cumulé de messages bus poussés
   * dans la mailbox depuis le démarrage de l'orchestrator. Monotone,
   * jamais reset, in-memory (repart à 0 au restart serveur). */
  msgCount: number;
  stopReason?: string | null;
}

// toView() :
return {
  // ... champs existants ...
  msgCount: this.mailbox.messagesTotal,
  stopReason: this._stopReason,
};
```

### Étape 3 — Adapter `rowToOrchView` pour l'historique DB

Dans `persistence.ts:168-189`, ajouter `msgCount: 0` dans le retour.
Justification : les rows historiques sont restituées après un
redémarrage serveur ; leur mailbox n'existe plus. 0 reflète l'état réel
("on n'observe aucun trafic actuel sur cet orchestrator terminé").

### Étape 4 — Mirror côté client

Dans `client.ts:15-33` ajouter `msgCount: number;`. Aucune lecture
optionnelle (`msgCount?:`) — le serveur l'expose toujours après ce
patch, donc obligatoire côté contrat.

### Étape 5 — Tests (cf. §6)

---

## 5. Sémantique : compte-t-on par message logique ou par livraison ?

**Décision recommandée : par push** (1 incrément = 1 entrée dans une
inbox).

Conséquences concrètes :

| Action | Incrément `messagesTotal` |
|---|---|
| `team.send_message A → B` | +1 |
| `team.broadcast` par lead, 3 workers actifs | +3 (un par recipient) |
| `swarm.send_to_lead` (cross-team) | +1 sur la mailbox **cible** uniquement |
| `swarm.broadcast_to_leads` | +1 par lead distant atteint, **chacun sur sa propre mailbox** |
| Push "system" abnormal-worker-exit | +1 (lead reçoit) |
| Drop-oldest (cap dépassé) | +1 quand même (le message a transité avant éviction) |
| `mailbox.read()` ou `clearAll()` | 0 (lectures/wipes non comptés) |

**Pourquoi par push et pas par "message logique"** :

1. La couche `Mailbox` n'a pas la notion de "message logique" — elle
   voit des pushes indépendants. Compter au niveau `messaging.ts`
   demanderait du code en double dans 4 fonctions (`sendMessage`,
   `broadcast`, `sendMessageToLead`, `broadcastToLeads`) + l'appel
   direct `index.ts:560`.
2. La sémantique UI "trafic bus" est **par-team**. Un broadcast vers 5
   workers correspond bien à 5 unités de trafic visibles sur cette team
   (5 PTY signaux possibles, 5 lectures `team.read_inbox`).
3. Le proto utilise `msgCount` pour un BADGE numérique (TopBar pill +
   colonne LeftPanel) — pas pour des analytics fines. La granularité
   "par push" est intuitive pour un opérateur.

**À documenter dans le JSDoc** du getter et dans `update_UI.md` pour
qu'un dev frontend ne se demande pas pourquoi broadcast vers 5 workers
ajoute 5 et pas 1.

---

## 6. Tests à écrire / modifier

### 6.1 Tests unitaires `mailbox.test.ts`

Nouveau bloc `describe('Mailbox.messagesTotal', () => { ... })` à
ajouter dans
`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/mailbox.test.ts`
:

| Cas | Attendu |
|---|---|
| Mailbox neuve | `m.messagesTotal === 0` |
| 1 push | `messagesTotal === 1` |
| 3 pushes vers 3 destinataires différents | `messagesTotal === 3` |
| 3 pushes vers le **même** destinataire | `messagesTotal === 3` (pas dédupliqué) |
| Push qui déclenche un drop-oldest (cap=2, 3 pushes) | `messagesTotal === 3` (le drop ne décrémente PAS) |
| `read()` après N pushes | `messagesTotal === N` (lecture n'affecte pas) |
| `clearAll()` après N pushes | `messagesTotal === N` (clear n'affecte pas le compteur cumulé) |
| `removeSession(sid)` après N pushes | `messagesTotal === N` |
| 1000 pushes en boucle | `messagesTotal === 1000` (sanity / perf gross check) |

### 6.2 Tests d'intégration `messaging.test.ts` (optionnels mais utiles)

Dans
`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.test.ts`
:

- Vérifier que `sendMessage` → `mailbox.messagesTotal` incrémenté de 1.
- Vérifier que `broadcast` vers N actifs → `messagesTotal` incrémenté
  de N (pas N+1 si sender skippé).

Ces tests valident le câblage `messaging → mailbox`, pas la logique du
compteur (déjà couverte unitairement).

### 6.3 Test e2e REST `rest-orchestrator.test.ts`

Dans
`/home/ubuntu/projets/swarm-os/packages/server/test/integration/rest-orchestrator.test.ts`
ajouter un nouveau `it(...)` :

```text
it('exposes msgCount on GET /orchestrators and GET /orchestrators/:id', async () => {
  const { orchestratorId, leadId } = createOrch();

  // État initial : msgCount === 0
  const r0 = await fetch(`.../orchestrators/${orchestratorId}`, ...);
  const v0 = await r0.json();
  expect(v0.msgCount).toBe(0);

  // Pousser N messages via le canal le plus simple : POST .../broadcast
  // (déjà testé dans le fichier — pas besoin d'instancier un MCP client).
  // Note : sender = 'human', donc TOUS les actifs sont destinataires,
  // ici juste le lead → +1 par broadcast.
  const N = 5;
  for (let i = 0; i < N; i++) {
    await fetch(`.../orchestrators/${orchestratorId}/broadcast`, {
      method: 'POST', body: JSON.stringify({ content: `m${i}` }), ...
    });
  }

  // Vérifier via /orchestrators/:id
  const r1 = await fetch(`.../orchestrators/${orchestratorId}`, ...);
  const v1 = await r1.json();
  expect(v1.msgCount).toBe(N);

  // Vérifier aussi via la liste
  const r2 = await fetch(`.../orchestrators`, ...);
  const v2 = await r2.json();
  expect(v2.orchestrators.find(o => o.id === orchestratorId).msgCount).toBe(N);
});
```

**Variante** plus complète (si on veut couvrir le compte par-recipient
d'un broadcast) : créer 2 workers (`spawner.addWorker` avec
`skipSpawn: true`), faire 1 broadcast, et vérifier `msgCount === 2`
(les 2 workers, pas le lead car sender='human' broadcast pousse vers
**tous** les actifs y compris le lead — relire `messaging.ts:213-227`
pour confirmer ; un broadcast `from: 'human'` doit toucher lead +
workers, donc 3 pour 1 lead + 2 workers).

**Vérification du comportement broadcast `from: 'human'`** : dans
`messaging.ts` broadcast skippe uniquement `s.id === fromSid`. `human`
n'étant l'id d'aucune session, **aucun skip** → tous les actifs sont
destinataires. Donc avec lead + 2 workers : `msgCount += 3` par
broadcast.

### 6.4 Test négatif

- Vérifier qu'un broadcast sur un orch SANS workers actifs (lead seul)
  pousse 1 message (lead destinataire) → `msgCount === 1`.
- Vérifier qu'un broadcast sur un orch arrêté ne pousse rien (lead
  non-actif au sens `isActive`) → `msgCount === 0`.

---

## 7. Gotchas / pièges

### 7.1 Concurrence

Node est mono-thread. `Mailbox.push` est **synchrone et ne fait aucun
`await`**. `this._messagesTotal++` est donc atomique de fait. Aucune
mutex / atomic nécessaire.

Vérifié sur `mailbox.ts` actuel : aucun `await` entre l'entrée de
`push` et son `return`. ✓

### 7.2 Wraparound

`Number.MAX_SAFE_INTEGER` = 2^53−1 ≈ 9×10^15. À 1000 msg/seconde
soutenu, 24/7, on atteint la limite en **~285 000 années**. Le doc S1
le dit explicitement : "le wraparound n'est pas un problème pratique".
À documenter dans le JSDoc du getter, ne pas wrapper en BigInt.

### 7.3 Drop-oldest n'efface PAS l'incrément

Important pour ne pas créer de confusion : si la mailbox sature et drop
un message ancien, le compteur a DÉJÀ pris +1 pour le drop, et prend
+1 pour le nouveau push. **Le total est cohérent avec "nombre
d'opérations bus tentées"**, pas avec "nombre de messages livrés et
non évincés". Le drop est un effet de cap, pas un échec de bus.

Si une UI future veut "messages effectivement délivrés à un agent",
c'est une **autre métrique** (à ajouter en v2 si besoin, hors S1).

### 7.4 `clearAll()` à `stop()`

Voir `index.ts:367-369` : `Orchestrator.stop()` appelle
`mailbox.clearAll()`. **Le compteur n'est PAS reset** — c'est voulu :
même après stop, `msgCount` reflète l'activité totale de la team
pendant sa vie, et `GET /orchestrators` (qui mêle live + history)
exposerait un orch en `stopped` avec son dernier `msgCount`.

Toutefois : en pratique, le `GET /orchestrators` ré-instancie les rows
historiques via `rowToOrchView()` (persistence.ts), pas via `toView()`
de l'instance vivante. Donc pour un orch terminé recouvré depuis SQLite
au prochain démarrage serveur, on **perd** le `msgCount` (→ 0 dans
`rowToOrchView`). C'est documenté et acceptable v1 (cf. update_system.md
fin du document : "compteurs en mémoire repartent à 0 au restart
serveur — acceptable").

**Question implicite** : faut-il persister `messagesTotal` dans la row
au `stop()` ? Hors scope S1 (le doc dit "pas de persistance"). À
discuter si le besoin émerge.

### 7.5 Le `from: 'system'` push de l'anomalie worker (index.ts:560)

Ce push contribue au compteur. C'est sémantiquement correct (c'est bien
un message bus livré au lead), mais à mentionner dans la doc :
`msgCount` n'est PAS strictement = "nombre d'appels MCP
team.send_message + team.broadcast". Il inclut aussi les messages
système.

### 7.6 Tests existants

Aucun test n'est **cassé** par l'ajout du champ et du getter — les
tests `mailbox.test.ts` actuels ne lisent jamais `messagesTotal` et ne
spécifient pas la forme exhaustive du retour de `push`. Les tests
e2e/REST utilisent un body parse qui ignore les champs inconnus. Pas de
régression attendue.

### 7.7 Type côté client

Le typage TS strict du frontend va faire échouer le build si une page
construit un `OrchestratorView` sans `msgCount`. Vérifier les mocks /
fixtures de tests web s'il y en a (grep `OrchestratorView` dans
`packages/web/src` retourne 2 fichiers : `client.ts` et
`hooks/useOrchestrators.ts` — ce dernier ne construit pas le view, il
le passe). À sanity-checker au moment du patch.

---

## 8. Dépendances avec d'autres lots

### 8.1 S2 — Event `mailbox.message` sur `/ws/events`

**Couplage fort.** S2 demande d'émettre un event WS depuis `deliver()`
et `broadcast()`. Comme S1 va déjà toucher `mailbox.push()`, il est
**rentable d'implémenter S1 et S2 dans le même patch** :

- S1 : `this._messagesTotal++`
- S2 : `eventBus.emitEvent({ kind: 'mailbox.message', payload: { from, to, orchestratorId } })`

Mais S2 nécessite que `Mailbox` connaisse son `orchestratorId` (pas le
cas aujourd'hui — la mailbox est instanciée sans connaître son
parent). Cela demande soit :
- un constructeur enrichi (`new Mailbox({ orchestratorId, maxSize })`) ;
- soit l'émission **côté `messaging.ts`** (qui a accès à
  `deps.orchestrator.id`) — ce qui découple S1/S2 et garde
  `Mailbox` ignorante de l'event bus.

L'option "émettre dans messaging.ts" introduit la même duplication
qu'on évite pour S1 (4 sites). L'option "passer orchestratorId à
Mailbox" est plus propre. **Recommandation : faire S1 d'abord, puis
S2 avec injection de `orchestratorId` dans le constructeur de Mailbox.**

### 8.2 S4 — Compteur global de messages + delta/min

S4 propose un total global + history. L'alternative low-effort de S4
(recommandée en v1) calcule le total comme **somme des `msgCount` par
orch** côté frontend. Donc S1 est un **prérequis** de S4 dans son
alternative low-effort.

### 8.3 S8 — `/metrics/bus`

`throughput_msg_per_s` de S8 = `messages_total_60s_ago -
messages_total_now / 60`. Suppose un compteur global serveur ; peut
être dérivé en sommant les `messagesTotal` par orch (= S1) à chaque
tick. Donc S1 facilite S8 sans le débloquer formellement.

### 8.4 S9 — `/metrics/messages` (sparklines)

S9 expose un `per_orchestrator` (8 points msg/min). L'implémentation
naturelle : tick 60s qui snapshot `orch.msgCount` et calcule le delta.
**S1 est le matériau de base de S9.**

### 8.5 Synthèse des dépendances

```
S1 ── (rend possible) ──→ S2 (event mailbox.message)
   ╰─ (matériau de) ──→ S4 (total global)
                  ──→ S8 (throughput bus)
                  ──→ S9 (sparkline per-orch)
```

S1 est bien un **prérequis P0** pour l'écosystème métriques entier.

---

## 9. Critères d'acceptation vérifiables

Le patch S1 est complet si **tous** les critères suivants passent :

1. `Mailbox#messagesTotal` est exposé en getter public en TS.
2. Une nouvelle `Mailbox()` a `messagesTotal === 0`.
3. Après 1 `push()`, `messagesTotal === 1`.
4. Après 1 `push()` qui déclenche un drop-oldest (cap dépassé),
   `messagesTotal === <ancienne valeur> + 1`.
5. `read()`, `peek()`, `removeSession()`, `clearAll()` ne modifient
   pas `messagesTotal`.
6. `OrchestratorView` (côté server `index.ts` ET côté web `client.ts`)
   déclare `msgCount: number;`.
7. `Orchestrator.toView().msgCount === orch.mailbox.messagesTotal`.
8. `GET /orchestrators` renvoie chaque orch avec un champ `msgCount`
   présent (live ET history, history = 0).
9. `GET /orchestrators/:id` renvoie `msgCount`.
10. Test e2e : créer un orch, envoyer N messages (via REST broadcast
    ou MCP team.send_message), `GET /orchestrators/:id` retourne
    `msgCount === N`.
11. Test unitaire mailbox.test.ts vert pour les cas listés en §6.1.
12. `pnpm -w test` passe sans régression sur l'ensemble du repo.
13. `pnpm -w lint` et `pnpm -w typecheck` passent.
14. La build Docker (`docker build -t swarm-os:latest .`) passe et
    `docker compose -f docker-compose.test.yml up -d` démarre.
15. Aucune régression sur les fixtures web (`hooks/useOrchestrators.ts`
    consomme les nouveaux champs sans broncher).
16. Documentation : JSDoc sur `messagesTotal` clarifie (a) jamais
    reset, (b) wraparound non géré (et pourquoi), (c) un push = un
    incrément (même un broadcast à N produit N incréments).

---

## 10. Estimation d'effort

- **Diff de code** : ~25 lignes nettes (mailbox + index + persistence + client + jsdoc).
- **Tests unitaires** : ~50 lignes.
- **Test e2e** : ~30 lignes.
- **Total** : ~100 lignes, ~30-60 min de codage + 15 min de tests CI.

Cohérent avec le tableau récapitulatif de `update_system.md` qui classe
S1 en effort `S` (Small).

---

## 11. Ordre d'application recommandé

1. Patch `mailbox.ts` (compteur + JSDoc).
2. Patch `mailbox.test.ts` (nouveau describe). Faire tourner.
3. Patch `index.ts` (interface + `toView()`).
4. Patch `persistence.ts` (`rowToOrchView` → `msgCount: 0`).
5. Patch `client.ts` (interface miroir).
6. Patch `rest-orchestrator.test.ts` (e2e). Faire tourner.
7. `pnpm -w test && pnpm -w typecheck && pnpm -w lint`.
8. `docker build` + `docker compose up -d` pour vérifier le run.
9. Enchaîner S2 (event WS) dans un PR séparé pour découpler la review.
