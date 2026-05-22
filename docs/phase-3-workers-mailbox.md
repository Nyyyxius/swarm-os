# Phase 3 — Workers, mailbox & team-comms

## 1. Livrable

Phase 3 ferme la boucle multi-agents. Les six outils MCP `team.*` laissés en
placeholder Phase 2 sont implémentés (send/read messages, broadcast,
spawn/kill workers), une **mailbox en mémoire bornée** par orchestrateur sert
de transport, et un **signal PTY passif** réveille les destinataires idle. Un
worker qui meurt anormalement injecte une note synthétique dans la boîte du
lead. Côté humain : `POST /orchestrators/:id/broadcast` et
`GET /orchestrators/:id/sessions/:sid/inbox` (peek), plus une vue web
drill-down qui liste les sessions, poll les compteurs d'inbox, expose une
quick-reply par session. Référence : plan §6 Phase 3, §10 (outils MCP), §11
(modèle mailbox + signal).

## 2. Module map

```
packages/server/src/
├── modules/
│   ├── orchestrator/
│   │   ├── mailbox.ts        # Map<sid, Message[]> bornée, drop-oldest
│   │   ├── messaging.ts      # sendMessage / broadcast / readInbox + signal PTY
│   │   ├── preamble.ts       # buildPreamble — substitue {{name|role|sessionId|orchName}}
│   │   ├── session.ts        # +idleSince, +ringBuffer 200 lignes, +notifySignal
│   │   └── index.ts          # +mailbox, +addWorker, +killWorker/All, +_onWorkerExit
│   ├── mcp/tools.ts          # 8 outils team.* implémentés (3 lead-only via requireLead)
│   └── preambles/
│       ├── default-lead.md   # Discipline mailbox + outils lead
│       └── default-worker.md # Idem côté worker (pas de spawn/kill_*)
├── http/routes/orchestrators.ts   # +POST /broadcast, +GET /sessions/:sid/inbox
└── config.ts                       # +maxInboxSize, +maxMessageSizeBytes,
                                    #  +maxWorkersPerOrch, +idleThresholdMs

packages/web/src/
├── App.tsx                          # routing #/orchestrators/<id>
└── components/
    ├── OrchestratorView.tsx         # drill-down + sessions list + inbox poll
    └── BroadcastBar.tsx             # broadcast global vers tous les actifs

packages/server/scripts/verify-phase-3.ts   # 23 checks bout-en-bout
```

Référence structure : plan §7.

## 3. Outils MCP team.* (final)

| Outil | Visibilité | Params | Retour | Notes |
|---|---|---|---|---|
| `team.whoami` | tous | `{}` | `{ session_id, name, role, type, is_lead }` | `is_lead` = la session appelante est le lead de l'orch (plan §10) |
| `team.list` | tous | `{}` | `{ members: [{ session_id, name, role, type }] }` | Sessions actives uniquement, scopées à l'orch |
| `team.send_message` | tous | `{ to, content }` | `{ delivered, queue_size, dropped }` | Push mailbox + signal idle ; `MESSAGE_TOO_LARGE` au-delà de `maxMessageSizeBytes` |
| `team.read_inbox` | tous | `{}` | `{ messages: [{ id, from, content, ts }] }` | **Vide** la queue — pop, pas peek |
| `team.broadcast` | tous | `{ content }` | `{ delivered_to: string[] }` | Push à toutes les sessions actives sauf l'appelant |
| `team.spawn_worker` | **lead** | `{ name, role, prompt, cwd?, model?, effort?, permissionMode? }` | `{ session: { id, name, role, type, status, cwd, model, effort, permissionMode } }` | `cwd` validé via realpath sous `/workspace` ; defaults hérités de l'orch |
| `team.kill_worker` | **lead** | `{ id }` | `{ killed: boolean }` | SIGTERM, grace 5 s, SIGKILL ; idempotent (id inconnu → `false`) |
| `team.kill_all_workers` | **lead** | `{}` | `{ killed: string[] }` | Sweep des workers ; lead épargné |

**Conventions :**

- `is_lead` est porté par `whoami` ; pas d'outil dédié `team.am_i_lead`
  (plan §10).
- Permissions lead-only : `requireLead(ctx)` dans `mcp/tools.ts` lève une
  `McpError(InvalidRequest, "PERMISSION_DENIED: ...")`. Le SDK 1.29 n'a pas
  de code dédié — on utilise donc `ErrorCode.InvalidRequest` et un préfixe
  textuel `PERMISSION_DENIED:` que le client peut pattern-matcher sans
  inspecter le numéro.
- Aucune réponse ne contient `session_secret` (plan §14).

## 4. Mailbox + signal-PTY model

Référence canonique : plan §11.

La mailbox vit au niveau de l'orchestrateur dans une `Map<sessionId,
Message[]>` strictement en mémoire (`mailbox.ts`). Chaque queue est bornée
par `SWARM_OS_MAX_INBOX_SIZE` (défaut 100, plan §11/§13) ; au-delà du cap, le
plus **ancien** est évincé (`shift`) et un warning
`{ event: 'mail.dropped', to, evictedId, maxSize }` est loggé sans le body.
Le `PushResult` porte `dropped: true`, propagé au champ `dropped` de la
réponse `team.send_message`.

`messaging.ts:sendMessage` valide la taille (`maxMessageSizeBytes`, 16 KiB
défaut → `MESSAGE_TOO_LARGE` mappée HTTP 413 / MCP `InvalidParams`),
contrôle que le destinataire est **actif** (`running`/`starting`/`waiting`),
push dans la mailbox, log `{ event: 'mail.send', from, to, len, queueSize,
dropped }`, puis évalue l'idleness : si
`now - session.idleSince ≥ idleThresholdMs` (défaut 2000 ms, plan §11),
injecte dans le PTY le payload exact :

```
\n[swarm-os] new message in inbox — call team.read_inbox to fetch\n
```

(constante `SIGNAL_TEXT`, encadrée par `\n…\n` pour atterrir sur sa propre
ligne quel que soit l'état du curseur). Le signal **ne bumpe pas**
`idleSince` : `Session.notifySignal` écrit dans le PTY et appende au log
mais ne touche pas le champ — sinon une cascade de messages remettrait le
destinataire en "busy" et empêcherait les signaux suivants.

`team.read_inbox` appelle `Mailbox.read(sid)` qui retourne la queue **et la
supprime** (sémantique pop, pas peek) ; queue absente/vide → `[]`. Les
boîtes sont vidées par `Orchestrator.stop()` (`mailbox.clearAll()`) et par
`_onWorkerExit` (`mailbox.removeSession(workerId)`). **Aucune persistance**
(plan §11/§17) : un restart serveur tue les PTY, donc persister les
messages n'aurait aucun consommateur.

## 5. Cycle de vie worker

`team.spawn_worker` (lead-only) → `Orchestrator.addWorker(spec)` :

- refuse si l'orch est en `stopping`/`stopped`/`failed` ;
- refuse au-delà de `maxWorkersPerOrch` (`WorkerCapError` → MCP
  `InvalidRequest` `MAX_WORKERS_PER_ORCH`) ;
- hérite `cwd` du lead par défaut, sinon revalide via `realpath` sous
  `/workspace` ;
- construit le préambule worker, mint `sessionSecret`, écrit `mcp.json`
  (mode 0600, dirs 0700) ; identique à la voie lead (Phase 2).

`team.kill_worker({ id })` → `Orchestrator.killWorker` : `SIGTERM`, timer 5 s
puis `SIGKILL`, idempotent (id inconnu / lead / déjà terminé → `false`).
`team.kill_all_workers` itère sur les workers — lead épargné.

**Exit anormal** (`Orchestrator._onWorkerExit`) : si le worker termine en
status `failed` ou `exited` avec un `exitCode` non-nul **et** que
`_stopRequested` est faux (la sortie n'est pas un kill demandé), on push
dans la boîte du lead un message synthétique
`from: 'system'` :

```
worker <name> (<sid>) exited abnormally with exit_code=<n>; status=<...>;
last 20 lines:
<dernières lignes du ring buffer 200>
```

Le ring buffer est maintenu par `Session._appendLog` (200 lignes, en
mémoire seulement). Le corps est cappé défensivement à
`maxMessageSizeBytes - 256` bytes en gardant la **queue** (lignes les plus
récentes), préfixé `…[truncated]…\n`. Le lead est ensuite signalé
**si idle**, par `lead.notifySignal(SIGNAL_TEXT)` (cf. §11 plan).

**Lead exit cascades** : `_onLeadExit` → `Orchestrator.stop('lead-stopped')`
qui SIGTERM/SIGKILL tous les workers (extension du comportement Phase 1).

## 6. Surface REST ajoutée

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/orchestrators/:id/broadcast` | Body `{ content }` ; envoie un message `from: 'human'` à toutes les sessions actives via `messaging.broadcast` (mêmes validations + signal idle que `team.broadcast`). Réponse `{ delivered_to: string[] }`. Auth standard `X-Auth-Token`. |
| `GET` | `/orchestrators/:id/sessions/:sid/inbox` | **Peek non destructif** via `Mailbox.peek` (shallow copy). Retourne `{ count, messages }`. Utilisé par l'UI pour le badge "N unread" par session. Auth `X-Auth-Token`. |

`POST /broadcast` partage les codes erreur de `messaging.broadcast` :
`MESSAGE_TOO_LARGE` → 413, body manquant → 400. La route est volontairement
sans rate-limit en MVP — accès loopback + token.

## 7. Web UI

`App.tsx` parse l'URL fragment : `#/orchestrators/<id>` → route détail,
sinon liste. Navigation back/forward suivie via l'event `hashchange` —
deep-links partageables sans rewrite serveur.

`OrchestratorView.tsx` :

- liste les sessions de l'orch avec `StatusBadge` (Phase 1) ;
- poll l'orch (sessions list, statuts) toutes les **2 s** ;
- poll en parallèle un `GET /orchestrators/:id/sessions/:sid/inbox` par
  session toutes les **3 s**, agrège les counts dans une `Map<sid, number>`
  → badge rouge "N unread" à côté de chaque ligne ;
- `BroadcastBar` en haut → `POST /orchestrators/:id/broadcast` ;
- chaque session dispose d'un quick-reply textarea qui POST
  `POST /sessions/:id/input` (endpoint Phase 1, pas de nouvelle route) ;
- clic sur une session monte un `Terminal.tsx` (xterm.js) attaché par WS.

## 8. Configuration ajoutée

Référence plan §13.

| Var | Défaut | Notes |
|---|---|---|
| `SWARM_OS_MAX_INBOX_SIZE` | `100` | Cap par mailbox de session ; drop-oldest au-delà |
| `SWARM_OS_MAX_WORKERS_PER_ORCH` | `20` | Refuse `team.spawn_worker` au-delà |
| `SWARM_OS_MAX_MESSAGE_SIZE_KB` | `16` | Plafond `team.send_message` / `broadcast` (UTF-8 bytes) |
| `SWARM_OS_IDLE_THRESHOLD_MS` | `2000` | Délai d'inactivité au-delà duquel le signal PTY est injecté |

## 9. Recette de validation

```
pnpm --filter server verify:phase3
```

`packages/server/scripts/verify-phase-3.ts` boote Spawner + McpServer sur les
ports `18790/18791`, crée un orchestrateur `skipSpawn=true` (les workers
sont réels du point de vue mailbox/MCP, mais sans subprocess `claude`),
puis ouvre **deux clients** SDK MCP — l'un en tant que lead, l'autre en tant
que worker — et exerce **23 checks** :

1. Lead `team.spawn_worker` retourne une session worker ; le `mcp.json` du
   nouveau worker existe en `0600`.
2. Lead → worker : `send_message` (`delivered: true, dropped: false`),
   `worker.read_inbox` retourne le message, deuxième `read_inbox` vide.
3. Worker → lead : `send_message` réciproque, `lead.read_inbox` retrouve la
   réponse.
4. `lead.broadcast` → la queue du worker contient le payload (peek via
   `Mailbox.peek`).
5. **PERMISSION_DENIED** : worker tente `team.spawn_worker` → erreur MCP avec
   message préfixé `PERMISSION_DENIED:`.
6. `lead.kill_worker` → `killed: true` ; la mailbox du worker est vidée
   (`Mailbox.size(worker.id) === 0`).
7. `lead.kill_worker` sur id inconnu → `killed: false` (idempotent).
8. **Mailbox bornée** : 105 sends successifs sur la même boîte → 5 warnings
   `mail.dropped` ; `queueSize` plafonne à 100 ; les 5 plus anciens sont
   évincés.
9. Message de taille `> maxMessageSizeBytes` → erreur MCP `MESSAGE_TOO_LARGE`.
10. **Worker exit anomaly** : worker forcé en `failed` → message synthétique
    dans la boîte du lead avec `exit_code` et la queue du ring buffer.
11. Sanity Mailbox unitaire : `removeSession` / `clearAll`.
12. **REST broadcast** : `POST /orchestrators/:id/broadcast` → toutes les
    boîtes actives reçoivent un message `from: 'human'`.
13. **REST inbox peek** : `GET /orchestrators/:id/sessions/:sid/inbox`
    retourne `{ count, messages }` cohérents.

Le script tourne en `SWARM_OS_IDLE_THRESHOLD_MS=50` pour ne pas attendre 2 s
à chaque assertion de signal.

## 10. Préambules

Sources : `packages/server/src/modules/preambles/{default-lead,default-worker}.md`.
Chargés une fois au boot par `preamble.ts` (memoization), substitués via
`{{name}}` / `{{role}}` / `{{sessionId}}` / `{{orchName}}` puis concaténés au
prompt initial. Un override per-orch (`leadPreamble` / `workerPreamble`,
plan §8) est appendé après le défaut sous `## Project-specific instructions`
— jamais en remplacement, pour garantir que la discipline mailbox survit.

**Disciplines communes** : identité en tête ; catalogue des outils `team.*` ;
règle "jamais de réponse en écrivant dans son propre terminal — toujours
`team.send_message` / `team.broadcast`" ; modèle mailbox + signal
(idle vs busy) avec **obligation d'appeler `team.read_inbox()` après chaque
tâche significative** — le signal est un *hint*, pas une garantie ; chaîne
exacte du signal citée verbatim.

**Lead** : reçoit la note synthétique sur exit anormal d'un worker ; doit
appeler `team.kill_all_workers()` + sortir proprement en fin de mission.
**Worker** : pas d'accès à `spawn_worker` / `kill_*` (rappel
`PERMISSION_DENIED`), doit envoyer un **rapport final** au lead via
`team.send_message` avant d'exit.

## 11. Limites à reprendre Phase 4+

- **Phase 4** : Discord webhook, persistance SQLite des `orchestrators` /
  `sessions`, endpoint `/hooks/notification` + `HOOK_TOKEN`, pino structured
  (les logs `mail.send` / `mcp.call` / `mail.dropped` sortent encore en
  `console.log(JSON.stringify(...))`).
- **Phase 5** : Dockerfile multi-stage, `CLAUDE_CONFIG_DIR` per-session,
  copie au boot de `/claude-source` → `/data/.claude-runtime`.
- **Phase 7** : suite de tests proprement dite. Les scripts `verify:phase*`
  sont des harnesses spike-style (sortie `[PASS]/[FAIL]`, exit code), pas
  des unit tests vitest/jest.
- Le message synthétique d'exit anormal **bypasse** `messaging.sendMessage`
  (skip de la check active-recipient et **pas** de ligne `mail.send` dans
  l'audit log — il y a `worker.exit_anomaly` à la place). Mineur, à
  uniformiser quand on factorisera la couche audit Phase 4.

## 12. Déviations du plan

- **`SWARM_OS_IDLE_THRESHOLD_MS`** ajouté (défaut 2000 ms). Plan §11 fige la
  valeur canonique mais ne nomme pas de variable — la rendre overrideable
  laisse le harness verify tourner en 50 ms sans race.
- **`PERMISSION_DENIED` via `ErrorCode.InvalidRequest` + préfixe textuel.**
  Le SDK MCP 1.29 n'a pas de code dédié pour les permissions, le préfixe
  permet au client de pattern-matcher de manière stable.
- **`team.spawn_worker` retourne un sous-ensemble du `SessionView`** : ni
  `sessionSecret` (déjà invariant Phase 2), ni `pid`, ni `logPath`, ni
  `startedAt`. Ces champs sont des internes serveur sans valeur pour
  l'agent appelant.
- **Quick-reply per-session** réutilise `POST /sessions/:id/input` (Phase 1)
  plutôt qu'une nouvelle route — la sémantique est strictement la même
  (pousse du texte humain dans le PTY).

## 13. Extension post-MVP — cross-équipe (`swarm.*`, lead-only)

Ajout post-Phase-7 : les leads d'orchestrateurs distincts peuvent se
parler. Les workers restent **strictement enfermés** dans leur équipe
(`team.*` only). Référence canonique : plan §10 (table d'outils) et §11
(modèle de mailbox / tagging). Préambule lead à jour côté
`default-lead.md` ("Cross-team coordination (lead-only)"). Le préambule
worker reste inchangé : les workers n'ont pas besoin de savoir que
`swarm.*` existe.

### Surface MCP ajoutée

| Outil | Visibilité | Params | Retour |
|---|---|---|---|
| `swarm.list_teams` | **lead** | `{}` | `{ teams: [{ orchestrator_id, name, role, status, worker_count, lead: { session_id, name, role } }] }` |
| `swarm.send_to_lead` | **lead** | `{ orchestrator_id, content }` | `{ delivered, to_session_id, to_orchestrator_id, queue_size, dropped }` |
| `swarm.broadcast_to_leads` | **lead** | `{ content }` | `{ delivered_to: [{ orchestrator_id, session_id }] }` |

`requireLead(ctx, '<tool>')` est appelé **avant** toute lookup → un worker
qui sonde n'obtient même pas la confirmation qu'un autre orch existe.
`swarm.list_teams` exclut l'orch appelant et ceux sans lead actif ; les
**workers d'autres équipes ne sont jamais exposés** (seul le lead l'est) —
frontière inter-équipes préservée par construction.

### Mailbox : extension du `Message`

`packages/server/src/modules/orchestrator/mailbox.ts` — 3 champs
optionnels ajoutés, dénormalisés au push (le destinataire les lit même si
l'orch source disparaît) :

```ts
fromOrchestratorId?: string;
fromOrchestratorName?: string;
fromSessionName?: string;
```

Intra-équipe : ces champs sont absents → wire format `team.read_inbox`
inchangé pour les messages historiques. Cross-équipe : sérialisés en
`from_orchestrator: { id, name, lead_name }` côté `team.read_inbox`
(champ optionnel sur l'output schema).

### Helpers messaging

`packages/server/src/modules/orchestrator/messaging.ts` ajoute deux
helpers parallèles aux `sendMessage` / `broadcast` existants — la couche
intra-équipe est **intacte** (clarté de contrat et de logs) :

- `sendMessageToLead(spawner, sourceOrch, sourceSid, toOrchId, content, defaults)` :
  size check → self-target rejection → `spawner.get` → status check
  (stopped/failed/**stopping**) → **re-read `targetOrch.lead` juste avant
  le push** (fenêtre lead-flip) → mailbox push tagué → idle-signal → log
  `mail.cross_send`.
- `broadcastToLeads(...)` : itère `spawner.listActive()`, exclut le self,
  skip les orchs sans lead actif. Per-recipient failures loggées mais
  n'avortent pas la boucle (best-effort). Log `mail.cross_broadcast`.

Codes d'erreur (`MessageError`) en plus de `MESSAGE_TOO_LARGE` :

| Code | HTTP | Trigger |
|---|---|---|
| `INVALID_RECIPIENT` | 400 | `orchestrator_id` vide ou `=== sourceOrch.id` |
| `ORCH_UNKNOWN` | 404 | `spawner.get` retourne `undefined` |
| `ORCH_NOT_ACTIVE` | 404 | `status ∈ { stopped, failed, stopping }` — **`stopping` inclus** car `Orchestrator.stop()` passe en `stopping` synchroniquement avant l'async vers `stopped` (le lead est déjà killé) |
| `RECIPIENT_NOT_ACTIVE` | 404 | Lead null ou inactif au moment du re-read (race lead-flip) |

Côté MCP les `MessageError` sont mappées via `throwAsMcp` (préfixe
textuel `CODE:` que le client peut pattern-matcher). Pas de leak de
`session_secret` dans les logs (même invariant que Phase 2/3).

### Tests

`packages/server/test/integration/mcp-swarm-tools.test.ts` — 9 checks
end-to-end via `bootTestStack` + clients MCP réels :

1. `swarm.list_teams` retourne les autres orchs actifs, **exclut**
   l'appelant ET un orch stoppé. `worker_count` reflète les workers
   actifs uniquement.
2. Worker → `swarm.list_teams` → `PERMISSION_DENIED`.
3. Lead A → `swarm.send_to_lead(B, content)` : le message atterrit dans
   `team.read_inbox` de B avec `from_orchestrator: { id, name, lead_name }`.
4. Worker → `swarm.send_to_lead` → `PERMISSION_DENIED`, **rien** n'arrive
   dans la mailbox cible.
5. Lead → `swarm.send_to_lead(unknown_id, ...)` → `ORCH_UNKNOWN`.
6. Lead → `swarm.send_to_lead(self.id, ...)` → `INVALID_RECIPIENT`.
7. Lead → `swarm.send_to_lead(stopped.id, ...)` → `ORCH_NOT_ACTIVE`.
8. Lead A → `swarm.broadcast_to_leads(content)` (3 équipes actives) →
   arrive aux 2 autres leads (mailbox/`from_orchestrator` corrects),
   **pas** dans l'inbox de A.
9. Worker → `swarm.broadcast_to_leads` → `PERMISSION_DENIED`.

Test suite complète : 174/174 PASS. Pas de régression sur les tests
intra-équipe (`team.*` inchangé).

### Hors-scope (à reprendre si besoin)

- **Pas d'`eventBus`** dédié pour la topologie cross-équipe — le log
  structuré `mail.cross_*` suffit côté observabilité, pas de consommateur
  UI aujourd'hui.
- **Pas de quota cross-team** — un lead bavard peut saturer la mailbox
  bornée (100) d'un autre lead. Le champ `dropped: true` du retour
  alerte au moins le sender. À durcir si problème observé.
- **Pas d'affichage UI** du tag `from_orchestrator` — l'inbox UI compte
  les messages, ne rend pas leur contenu. À traiter quand le client
  rendra le contenu des messages.
- **Pas de persistance** — comme l'intra-équipe, in-memory uniquement.
  Cohérent avec plan §11 ("Survie au restart : aucune").
