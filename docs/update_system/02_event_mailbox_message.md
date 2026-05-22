# S2 — Évènement `mailbox.message` sur `/ws/events`

> Analyse détaillée du lot **S2** de `docs/update_system.md`. À lire après `01_msg_count.md` (S1) car les deux touchent le même chemin critique : chaque message livré devra **à la fois** incrémenter `messagesTotal` (S1) **et** émettre l'event `mailbox.message` (S2).

---

## 1. Résumé du besoin

Le `MapView` du nouveau dashboard affiche des "pulses" animés entre les nœuds (orchestrators / sessions) à chaque échange de messages sur le bus. Aujourd'hui, le seul signal temps réel disponible côté frontend est `session.status_changed` — insuffisant car un agent peut envoyer/recevoir des dizaines de messages sans changer de statut. Il faut donc un nouvel évènement WebSocket `mailbox.message` émis à **chaque livraison effective** (`deliver` direct, `broadcast` intra-team, `swarm.send_to_lead`, `swarm.broadcast_to_leads`, et message synthétique `from: 'system'` du superviseur d'exit anormal), portant un payload léger `{ from, to, orchestratorId }`. Le throttle/dédup éventuel reste à la charge du frontend (cap 24 pulses simultanés dans le proto).

---

## 2. État actuel

### 2.1 `events.ts` — bus d'évènements global

Fichier : `/home/ubuntu/projets/swarm-os/packages/server/src/events.ts`

```ts
export type SwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited';

export interface SwarmEvent {
  kind: SwarmEventKind;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  payload?: unknown;
}

class SwarmEventBus extends EventEmitter {
  emitEvent(ev: Omit<SwarmEvent, 'ts'>): void {
    const full: SwarmEvent = { ...ev, ts: new Date().toISOString() };
    this.emit('event', full);
  }
  onEvent(cb: (ev: SwarmEvent) => void): () => void { ... }
}

export const eventBus = new SwarmEventBus();
eventBus.setMaxListeners(100);
```

**Constat important** : le bus est un **singleton module-level**, pas un objet injecté. Tous les sites d'émission existants l'importent directement (`import { eventBus } from '../../events.js'`). Le wording du brief « via le eventBus injecté » est donc une **inexactitude légère** : il n'y a pas (encore) d'injection — on continuera simplement à importer le singleton, conformément au pattern existant.

### 2.2 Mailbox (couche basse) — pas de `deliver()`/`broadcast()`

Fichier : `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/mailbox.ts`

La classe `Mailbox` ne contient **que** des primitives de stockage : `push`, `read`, `peek`, `size`, `removeSession`, `clearAll`. **Aucune méthode `deliver()` ni `broadcast()` n'existe dans `mailbox.ts`** — contrairement à ce que suggère le brief S2.

Ce qui ressemble à `deliver()`/`broadcast()` se trouve dans `messaging.ts` (cf. §2.3). C'est là que la logique d'émission `mailbox.message` doit aller (cohérent avec l'organisation actuelle : `mailbox.ts` reste un container passif, `messaging.ts` orchestre les effets de bord).

### 2.3 Couche de messagerie — sites de livraison effectifs

Fichier : `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.ts`

Cinq sites poussent dans une mailbox :

| # | Fonction | Ligne | Cible | Sémantique |
|---|---|---|---|---|
| 1 | `sendMessage(deps, fromSid, toSid, content)` | l. 165 | `deps.mailbox.push(toSid, ...)` | `team.send_message` (1→1 intra-team) |
| 2 | `broadcast(deps, fromSid, content)` | l. 222 (dans for-loop) | `deps.mailbox.push(s.id, ...)` | `team.broadcast` (1→N intra-team) |
| 3 | `sendMessageToLead(spawner, sourceOrch, sourceSid, toOrchId, content, defaults)` | l. 324 | `targetOrch.mailbox.push(targetLead.id, ...)` | `swarm.send_to_lead` (cross-team, 1→1 vers lead distant) |
| 4 | `broadcastToLeads(spawner, sourceOrch, sourceSid, content, defaults)` | l. 388 (dans for-loop) | `orch.mailbox.push(lead.id, ...)` | `swarm.broadcast_to_leads` (cross-team, 1→N leads) |
| 5 | `Orchestrator._onWorkerExit(worker)` | `index.ts:560` | `this.mailbox.push(lead.id, { from: 'system', ... })` | Synthétique : worker mort → notice au lead |

Tous les sites poussent en **synchrone** ; pas d'async/await dans le chemin chaud. Bon pour la cohérence d'ordre des events.

### 2.4 Routeur WS `/ws/events`

Fichiers :
- `/home/ubuntu/projets/swarm-os/packages/server/src/http/ws/events.ts` (la classe `EventsHub`).
- `/home/ubuntu/projets/swarm-os/packages/server/src/http/main.ts` (lignes 200-215 : upgrade WS + ticket).

Mécanique : un singleton `EventsHub` s'abonne à `eventBus.onEvent(...)` et **diffuse l'event JSON-stringifié à tous les clients WS connectés**. Aucune logique de filtrage / topic / ACK : c'est un fanout brut. Ajouter un nouveau `SwarmEventKind` ne demande **aucune modification de `EventsHub`** — c'est purement additif.

Le `useEvents` côté client (`/home/ubuntu/projets/swarm-os/packages/web/src/hooks/useEvents.ts`) ne filtre actuellement que sur `kind === 'session.status_changed'` et **ignore silencieusement les kinds inconnus** (try/catch + switch). Donc **rétro-compatible** : pas de cassure.

### 2.5 `SwarmEventKind` existants (inventaire complet)

Émissions actives :

| Kind | Sites d'émission |
|---|---|
| `orchestrator.created` | `spawner/index.ts:118` |
| `orchestrator.updated` | `orchestrator/index.ts:433` (`_setStatus`), `orchestrator/index.ts:501` (`_onLeadExit`) |
| `orchestrator.destroyed` | `spawner/index.ts:192` |
| `session.created` | `orchestrator/index.ts:217` (lead), `orchestrator/index.ts:289` (worker) |
| `session.status_changed` | `session.ts:828`, `session.ts:846` (et `hooks.ts:131` pour le hook Notification) |
| `session.exited` | `session.ts:757` |

---

## 3. Fichiers à modifier

Liste exhaustive (chemins absolus) :

1. **`/home/ubuntu/projets/swarm-os/packages/server/src/events.ts`** — ajouter `'mailbox.message'` à `SwarmEventKind` + optionnellement un type explicite du payload.
2. **`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.ts`** — émettre l'event depuis les 4 fonctions de livraison (`sendMessage`, `broadcast`, `sendMessageToLead`, `broadcastToLeads`). Importer `eventBus`.
3. **`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/index.ts`** — émettre l'event depuis `_onWorkerExit` (push synthétique `from: 'system'`). Déjà importe `eventBus`.
4. **`/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.test.ts`** — nouveaux tests vérifiant l'émission (mock `eventBus.onEvent`).
5. *(optionnel)* `/home/ubuntu/projets/swarm-os/packages/web/src/hooks/useEvents.ts` — élargir `SwarmEvent.kind` (chaîne libre aujourd'hui : aucune modif strictement nécessaire). Le câblage frontal des pulses du MapView vit dans `update_UI.md`, hors scope ici.

**Fichiers à NE PAS toucher** :
- `mailbox.ts` reste un container passif (cohérence d'architecture).
- `EventsHub` (`http/ws/events.ts`) — relais agnostique.
- Tests REST/e2e existants — l'évènement est additif, aucun ne fait `expect()` sur la liste des kinds.

---

## 4. Plan d'implémentation détaillé

### Étape 1 — Étendre le type côté `events.ts`

```ts
// packages/server/src/events.ts
export type SwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited'
  | 'mailbox.message';            // <-- nouveau

export interface MailboxMessagePayload {
  from: string;                   // session id, 'human' ou 'system'
  to: string | 'broadcast';       // session id du destinataire ou littéral 'broadcast'
  orchestratorId: string;         // orch du destinataire (pas du sender pour cross-team)
}
```

Note : on garde `payload?: unknown` sur `SwarmEvent` plutôt que de spécialiser — cohérent avec les autres kinds existants. Le type `MailboxMessagePayload` sert juste de référence partagée.

### Étape 2 — Helper interne dans `messaging.ts`

Pour éviter de répéter 5 fois le même appel, ajouter un helper privé :

```ts
// packages/server/src/modules/orchestrator/messaging.ts
import { eventBus } from '../../events.js';

function emitMailboxMessage(
  orchestratorId: string,
  from: string,
  to: string | 'broadcast',
): void {
  eventBus.emitEvent({
    kind: 'mailbox.message',
    orchestratorId,
    payload: { from, to, orchestratorId },
  });
}
```

Pourquoi dupliquer `orchestratorId` dans le payload alors qu'il est déjà au niveau racine de `SwarmEvent` ? Pour que le frontend ait un payload **autosuffisant** sans devoir merger top-level + payload (cohérent avec les autres kinds : `session.status_changed` met `status` dans `payload`, pas en root).

### Étape 3 — Câbler les 5 sites de livraison

**a) `sendMessage`** (après le `mailbox.push` réussi, l. 165) :

```ts
const result = deps.mailbox.push(toSid, { from: fromSid, content });
emitMailboxMessage(deps.orchestrator.id, fromSid, toSid);
log.info({ event: 'mail.send', ... });
```

**b) `broadcast`** — choix critique : 1 event par destinataire ou 1 seul avec `to: 'broadcast'` ?

Le brief tranche : **1 seul event avec `to: 'broadcast'`** (« broadcast → 1 event avec `to: 'broadcast'` »). On l'émet **une fois après la boucle**, si `delivered.length > 0` (pas d'event si broadcast vide, ça évite des pulses fantômes sur un orch à un seul agent) :

```ts
for (const s of deps.orchestrator.listSessions()) { ... }
if (delivered.length > 0) {
  emitMailboxMessage(deps.orchestrator.id, fromSid, 'broadcast');
}
```

**c) `sendMessageToLead`** (cross-team, après `targetOrch.mailbox.push(...)`, l. 324) :

```ts
const result = targetOrch.mailbox.push(targetLead.id, { ... });
emitMailboxMessage(targetOrch.id, sourceSid, targetLead.id);
```

⚠ Subtilité : `orchestratorId` = **celui du destinataire** (`targetOrch.id`), pas du sender. Justification : le MapView dessine une pulse **arrivant** sur la team destination. Pour qu'il puisse également afficher l'origine cross-team, on **étendra** le payload (variant ci-dessous, §5).

**d) `broadcastToLeads`** (cross-team broadcast, après la boucle) :

```ts
for (const orch of spawner.listActive()) { ... }
for (const target of delivered) {
  emitMailboxMessage(target.orchestrator_id, sourceSid, target.session_id);
}
```

Décision différente du cas intra-team broadcast : ici **1 event par destinataire**, car chaque event a un `orchestratorId` distinct (différentes teams). Un seul event avec `to: 'broadcast'` n'aurait pas de sens — `orchestratorId` est singulier.

**e) `_onWorkerExit` dans `Orchestrator`** (push synthétique `from: 'system'`, `index.ts:560`) :

```ts
this.mailbox.push(lead.id, { from: 'system', content });
eventBus.emitEvent({
  kind: 'mailbox.message',
  orchestratorId: this.id,
  payload: { from: 'system', to: lead.id, orchestratorId: this.id },
});
```

(On n'utilise pas l'helper `emitMailboxMessage` car il vit dans `messaging.ts` ; soit on l'exporte, soit on inline ici. Solution propre : **exporter** `emitMailboxMessage` depuis `messaging.ts`, ou bien dupliquer la ligne — 6 LOC, acceptable.)

### Étape 4 — Ordering vis-à-vis de S1

Si S1 (`messagesTotal`) est implémenté en parallèle : faire **les deux** dans le même bloc :

```ts
const result = deps.mailbox.push(toSid, { from: fromSid, content });
deps.orchestrator.incrementMessageCount();   // S1
emitMailboxMessage(deps.orchestrator.id, fromSid, toSid);   // S2
```

L'ordre est important pour la cohérence : **incrément AVANT émission**, pour que `GET /orchestrators` appelé en réaction à l'event WS reflète bien le nouveau total (race-free).

---

## 5. Schéma du payload final + variants

### 5.1 Schéma de base

```ts
{
  kind: 'mailbox.message',
  ts: '2026-05-22T14:32:10.123Z',     // ajouté par emitEvent
  orchestratorId: string,             // top-level — orch du destinataire
  payload: {
    from: string,                     // sender (sid, 'human', 'system')
    to: string | 'broadcast',         // destinataire ou littéral
    orchestratorId: string,           // dup orchestratorId pour payload autosuffisant
  }
}
```

### 5.2 Variants par origine

| Origine | `from` | `to` | `orchestratorId` (top + payload) | Notes |
|---|---|---|---|---|
| `team.send_message` (intra) | `<sender-sid>` | `<recipient-sid>` | orch émetteur (= destinataire, même orch) | 1 event |
| `team.broadcast` (intra) | `<sender-sid>` | `'broadcast'` | orch émetteur | **1 event** total (pas N) |
| Human → broadcast REST | `'human'` | `'broadcast'` | orch ciblé | idem broadcast |
| `swarm.send_to_lead` (cross) | `<sender-sid>` (lead source) | `<target-lead-sid>` | orch **destinataire** (cible) | 1 event ; voir §5.3 pour cross-team enrichi |
| `swarm.broadcast_to_leads` (cross) | `<sender-sid>` (lead source) | `<target-lead-sid>` | orch **destinataire** | **N events**, un par destinataire |
| `_onWorkerExit` (système) | `'system'` | `<lead-sid>` | orch émetteur | 1 event |

### 5.3 Extension recommandée pour cross-team (optionnelle, v1.1)

Pour permettre au MapView de dessiner une flèche **inter-team**, le payload des deux cas cross-team peut être enrichi :

```ts
payload: {
  from: string,
  to: string,
  orchestratorId: string,              // destinataire
  fromOrchestratorId?: string,         // présent SI cross-team
}
```

**À discuter** : faut-il dès la v1 ? Le compteur (S1) ne le requiert pas, mais le rendu MapView oui (sinon les flèches inter-team apparaissent comme intra-team avec un sender non listé dans l'orch). **Recommandation** : inclure dès la v1 (coût marginal, économise un breaking change ultérieur). Aligné avec ce que `Mailbox.Message` stocke déjà via `fromOrchestratorId`/`fromOrchestratorName` pour les vrais messages.

---

## 6. Tests à écrire / modifier

### 6.1 Tests unitaires (`messaging.test.ts`)

Fichier : `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.test.ts`

Cas à couvrir :

1. **`sendMessage` émet 1 event `mailbox.message`** avec `from`, `to`, `orchestratorId` corrects.
2. **`sendMessage` n'émet PAS l'event** si l'erreur précède le push (MESSAGE_TOO_LARGE, RECIPIENT_UNKNOWN, RECIPIENT_NOT_ACTIVE).
3. **`broadcast` émet exactement 1 event** avec `to: 'broadcast'` (et non N).
4. **`broadcast` n'émet PAS l'event** si `delivered.length === 0` (orch à 1 seul agent = sender exclu).
5. **`sendMessageToLead` émet 1 event** avec `orchestratorId === targetOrch.id` (pas sourceOrch.id).
6. **`broadcastToLeads` émet N events**, 1 par orch destinataire.

**Pattern recommandé** (capture via abonnement) :

```ts
import { eventBus } from '../../events.js';
import type { SwarmEvent } from '../../events.js';

let captured: SwarmEvent[] = [];
let unsub: () => void;

beforeEach(() => {
  captured = [];
  unsub = eventBus.onEvent((ev) => captured.push(ev));
});
afterEach(() => unsub());

it('emits mailbox.message on sendMessage', () => {
  sendMessage(deps, sender.id, recv.id, 'hi');
  const ev = captured.find((e) => e.kind === 'mailbox.message');
  expect(ev).toBeDefined();
  expect(ev?.payload).toMatchObject({
    from: sender.id, to: recv.id, orchestratorId: deps.orchestrator.id,
  });
});
```

⚠ **Le stub `StubOrchestrator` actuel n'expose pas `id`**. À étendre :

```ts
interface StubOrchestrator extends Pick<Orchestrator, 'getSession' | 'listSessions'> {
  readonly id: string;   // <-- requis pour les tests d'event
}
function makeStubOrchestrator(id: string, sessions: Session[]): StubOrchestrator { ... }
```

### 6.2 Test du push synthétique (`_onWorkerExit`)

Fichier candidat : `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.test.ts` ou un nouveau `index.test.ts` orchestrator (vérifier ce qui existe — il y a `agent-process.test.ts`, `session.test.ts`, `messaging.test.ts`, `persistence.test.ts`, mais **pas** `index.test.ts`). Le plus simple : **étendre `messaging.test.ts`** avec un mini-test orchestrator-level OU laisser ce cas en e2e (cf. §6.3).

### 6.3 Test e2e WS `/ws/events`

Vérifier si un test e2e WS existe déjà :

```
grep -rln '/ws/events' /home/ubuntu/projets/swarm-os/packages/server/test/
```

Si oui, étendre. Sinon, scénario :

1. Démarrer le serveur via le harness e2e existant.
2. Ouvrir un orch + 2 workers (`skipSpawn` + `FakeAgentProcess`).
3. S'abonner à `/ws/events` (avec ticket).
4. Déclencher `team.send_message` via MCP → vérifier qu'un frame `{ kind: 'mailbox.message', ... }` arrive.
5. Déclencher `team.broadcast` → 1 seul frame avec `to: 'broadcast'`.
6. Déclencher `swarm.send_to_lead` → 1 frame avec `orchestratorId === target.id`.

---

## 7. Gotchas

### 7.1 1 event par destinataire en broadcast, ou 1 seul ?

**Tranche** : **1 seul** pour `team.broadcast`, `to: 'broadcast'` (suivant le brief).

Conséquences :
- Le MapView devra interpréter `to: 'broadcast'` comme « pulse depuis le sender vers tous les autres nœuds visibles de la même team ». Logique dérivable du contexte (le client a déjà la liste des sessions via `GET /orchestrators`).
- **Économie** : évite N events sur une team de 8 workers.
- **Cohérence S1** : `messagesTotal` doit s'incrémenter **N fois** (1 par destinataire effectif), mais l'event reste unique. Bien aligner les deux : `incrementMessageCount(delivered.length)` côté S1, **après** la boucle.

Pour `swarm.broadcast_to_leads` (cross-team) : **N events**. Justification : `orchestratorId` change à chaque itération, on ne peut pas le compresser. Le MapView dessine N flèches sortantes — c'est sémantiquement correct.

### 7.2 Cohérence avec S1 (compteur `messagesTotal`)

S1 propose d'incrémenter `messagesTotal` à chaque `deliver()`/`broadcast()`. Le compteur doit refléter **les livraisons individuelles**, pas les "appels". Donc :
- `sendMessage` → +1
- `broadcast` (N destinataires) → +N (et 1 event)
- `sendMessageToLead` → +1 (sur l'orch destinataire)
- `broadcastToLeads` (N orchs) → +1 sur chacun des N orchs destinataires (et N events)
- `_onWorkerExit` synthétique → +1

Donc **`messagesTotal` ≠ count(events `mailbox.message`)** dans le cas broadcast intra-team. À documenter explicitement dans S1.

### 7.3 Rétro-compatibilité

- `useEvents` (frontend actuel) **ignore les kinds inconnus** : aucune cassure (les anciens clients voient juste plus de frames qu'avant, qu'ils ignorent).
- `EventsHub` (serveur) : fanout brut, aucune modif.
- Le contrat d'`OrchestratorView` reste inchangé (S2 ne touche pas le shape REST, contrairement à S1).

### 7.4 Volume / spam

Un agent en boucle peut envoyer 100 msg/s. À 100 listeners (cap `setMaxListeners(100)`), chaque event = 100 JSON.stringify + 100 ws.send. Mesure :
- 100 msg/s × 100 clients = 10 000 sends/s. Acceptable mais non négligeable.
- **Pas de throttle backend** (selon brief). Si problème, instrumenter `setInterval` 100 ms qui flush par batch. À chiffrer en prod ; **pas v1**.

Le frontend cap déjà 24 pulses simultanés → DoS visuel évité.

### 7.5 Ordre des effets dans `sendMessage`

Actuellement :
1. validation → 2. `mailbox.push` → 3. `log.info` → 4. (peut-être) `injectSignal`.

S2 doit s'insérer **après push, avant ou après log** (peu importe), **avant** le signal PTY (pour que l'event WS arrive idéalement avant le réveil de l'agent, mais c'est cosmétique).

### 7.6 Source-of-truth de `orchestratorId` pour cross-team

Bien différencier `orchestratorId` (destinataire) de `fromOrchestratorId` (source, optionnel) — sinon le MapView dessine la pulse au mauvais endroit. Le wording du brief « orchestratorId: string » est ambigu : trancher dans le code que c'est **toujours le destinataire**, conformément au pattern des autres events (top-level `orchestratorId` = entité concernée).

### 7.7 Cas `messagesTotal` du REST broadcast `from: 'human'`

`POST /orchestrators/:id/broadcast` utilise `'human'` comme sender. L'event aura donc `from: 'human'`, `to: 'broadcast'`. Le MapView devra représenter une origine "human" (icône opérateur). À documenter côté UI.

### 7.8 `_onWorkerExit` : émettre même si `stopping` ?

Code actuel : `if (this._status === 'stopping' || 'stopped') return;` — donc le push synthétique **ne se produit pas** pendant un shutdown. L'event suit la même logique, c'est implicite.

---

## 8. Dépendances avec d'autres lots

| Lot | Lien | Action |
|---|---|---|
| **S1** (msgCount par orch) | Co-localisé sur les mêmes 5 sites. **Implémenter ensemble** pour éviter deux passes sur `messaging.ts` | Coordonner |
| **S4** (compteur global + delta/min) | Si endpoint serveur retenu (option dédiée), il agrège `messagesTotal` de S1. S2 (events) reste indépendant | Indépendant |
| **S8** (`/metrics/bus`) | Throughput = somme `messagesTotal` snapshot. Indépendant de S2 mais consomme S1 | Indépendant |
| **S12** (mapping `from`) | Le frontend doit gérer `from === 'human'` / `'system'` / `<sid>`. Cohérent avec le payload S2 | À documenter ensemble |

**Recommandation d'ordre** : S1 puis S2 dans le même PR (les diffs se chevauchent sur les 5 lignes de push). S4/S8 dans un PR séparé.

---

## 9. Critères d'acceptation

Vérifiables automatiquement (tests) :

- [ ] **AC1** : `SwarmEventKind` inclut `'mailbox.message'`. Type compile-check.
- [ ] **AC2** : `sendMessage(deps, A, B, "hi")` provoque exactement 1 event `mailbox.message` avec `payload = { from: A, to: B, orchestratorId: deps.orchestrator.id }`.
- [ ] **AC3** : `broadcast(deps, A, "hi")` sur un orch [A, B, C] provoque exactement 1 event avec `payload.to === 'broadcast'`. **Pas** N events.
- [ ] **AC4** : `broadcast(deps, A, "hi")` sur un orch [A] (sender seul) provoque **0 event** `mailbox.message`.
- [ ] **AC5** : `sendMessageToLead(sourceOrch, sourceSid, targetOrch.id, "hi")` émet 1 event avec `orchestratorId === targetOrch.id` (et non sourceOrch.id).
- [ ] **AC6** : `broadcastToLeads(sourceOrch, ...)` vers N orchs émet **N events**, chacun avec son propre `orchestratorId`.
- [ ] **AC7** : `_onWorkerExit` avec `failed` worker provoque 1 event `mailbox.message` avec `from: 'system'`, `to: lead.id`.
- [ ] **AC8** : Aucune émission si le `mailbox.push` ne se produit pas (validation rejetée).
- [ ] **AC9** : Un client WS connecté à `/ws/events` reçoit le frame JSON ; les frames préexistants (`session.created`, etc.) restent inchangés.
- [ ] **AC10** : Les tests existants de `messaging.test.ts` (sendMessage delivers, broadcast excludes sender, etc.) **passent toujours** sans modification fonctionnelle.

Vérifiable manuellement :

- [ ] **AC11** : Le MapView (prototype `prototypes/`) affiche un pulse animé entre deux nœuds quand `team.send_message` est exécuté via MCP.

---

## 10. Synthèse — effort estimé

- **Code de prod** : ~40 LOC réparties sur 3 fichiers (events.ts, messaging.ts, index.ts).
- **Tests** : ~80 LOC (6 cas unitaires + 1 e2e WS optionnel).
- **Diff conceptuel** : strictement additif, pas de refactor.
- **Effort** : conforme à la grille S du brief (`S`).
- **Risque** : très faible si bundle avec S1 (les conflits portent sur les mêmes lignes).
