# update_system.md — Fonctionnalités à ajouter au système

**Étape 1 du plan d'intégration UI.** Ce document liste les fonctionnalités
à ajouter au backend (et à quelques endroits du frontend technique) pour
que tout ce que le prototype desktop affiche soit alimenté par des données
réelles. Cf. `update_UI.md` pour le sens inverse, et
`ui-redesign-desktop.md` pour le plan d'ensemble.

Tout est ordonné par priorité : **P0** bloque la v1 utile de la nouvelle
UI, **P1-P2** sont du polish, **P3** est optionnel.

---

## Status v1 — implémenté le 2026-05-22

**Tous les lots S1 → S12 sont livrés** (working tree, tests 367/367 verts).
Chaque lot a une analyse détaillée dans `docs/update_system/`. La section
ci-dessous est conservée comme spec d'origine ; lire le tableau récap
pour l'état réel et les choix faits.

| Lot | Statut | Analyse | Choix livré |
|---|---|---|---|
| **S1** Compteur messages par orch | livré | [01_compteur_messages_orchestrator.md](update_system/01_compteur_messages_orchestrator.md) | `Mailbox.messagesTotal` cumulatif + `OrchestratorView.msgCount` exposé via REST. |
| **S2** Event `mailbox.message` | livré | [02_event_mailbox_message.md](update_system/02_event_mailbox_message.md) | Émis depuis les 5 sites de livraison (`sendMessage`, `broadcast`, `sendMessageToLead`, `broadcastToLeads`, worker-exit synthétique). |
| **S3** Mapping visuel `waiting` | livré | [03_statut_waiting.md](update_system/03_statut_waiting.md) | Module `lib/sessionStatus.ts` + pulsation CSS + état `bad` rouge ajouté au design. |
| **S4** Compteur global + history | livré | [04_compteur_global_messages.md](update_system/04_compteur_global_messages.md) | **Option low-effort frontend** : `lib/messageStats.ts` (ring buffer 60 pts, perdu au reload). Endpoint serveur livré en parallèle dans S9. |
| **S5** Actions per-session ×4 | livré | [05_actions_session.md](update_system/05_actions_session.md) | 4 routes REST `POST /sessions/:id/{stop,pause,resume,restart}` + ajout de `paused` à l'enum `SessionStatus`. **Restart = nouvelle session** (l'ancienne devient `interrupted`). |
| **S6** Statut `idle` dérivé | livré | [06_statut_idle.md](update_system/06_statut_idle.md) | **Option frontend** (recommandée v1) : `enrichWithIdle` + hook `useNow` (5 s, seuil 30 s). Aucun changement serveur. |
| **S7** `health` agrégé orch | livré | [07_health_agrege.md](update_system/07_health_agrege.md) | Fonction pure `computeOrchestratorHealth` (`modules/orchestrator/health.ts`) branchée dans `toView()`. |
| **S8** `/metrics/bus` | livré | [08_metrics_bus.md](update_system/08_metrics_bus.md) | `BusMetricsCollector` (latency MCP / queue depth / throughput / err rate, fenêtre 60 s). |
| **S9** `/metrics/messages` | livré | [09_metrics_messages.md](update_system/09_metrics_messages.md) | `MessagesAggregator` (global 60 pts, per-orchestrator 8 pts). En pratique S4 reste calcul client en v1 ; S9 est servi en parallèle pour les futurs consommateurs. |
| **S10** Load % | livré | [10_load_percent.md](update_system/10_load_percent.md) | **Option (a) élider** : helper `formatLoadPercent(null) → '—'` (em-dash). Pas de mesure CPU/PTY pour l'instant. |
| **S11** Console structurée | livré | [11_console_structuree.md](update_system/11_console_structuree.md) | **Option (a) xterm conservé** v1, docstring ajoutée. Aucun parseur côté serveur. |
| **S12** Mapping `from` → bulle | livré | [12_mapping_from.md](update_system/12_mapping_from.md) | Helper `classifyBubble` (`lib/mailBubble.ts`) — kinds `me / them / system / other-team`. `MailMessageView` côté client étendu. |

**Surface API ajoutée** :
- `Mailbox.messagesTotal: number` ; `OrchestratorView.msgCount`, `OrchestratorView.health`.
- `SessionStatus` : `paused` ajouté à l'enum (server + mirror client).
- `SwarmEventKind` : `'mailbox.message'` (`{ from, to, orchestratorId }`).
- Routes : `POST /sessions/:id/{stop,pause,resume,restart}`,
  `GET /metrics/messages`, `GET /metrics/bus`.
- Helpers frontend : `lib/sessionStatus.ts` (`mapSessionStatusToVisual`,
  `enrichWithIdle`, `IDLE_VISUAL_THRESHOLD_MS`, `VISUAL_CLASSES`),
  `lib/useNow.ts`, `lib/messageStats.ts` (`useGlobalMessageStats`,
  `computeGlobalMessageStats`), `lib/loadPercent.ts` (`formatLoadPercent`,
  `LOAD_PLACEHOLDER`), `lib/mailBubble.ts` (`classifyBubble`, `BubbleKind`).

Le reste du document ci-dessous est la spec initiale, conservée pour
référence historique.

---

## P0 — Bloque la v1 (sans ça la nouvelle UI affiche des placeholders partout)

### S1. Compteur de messages bus par orchestrator

**Pourquoi** : alimente `team-pill.msg` dans la TopBar et la colonne
"Per-team traffic" du LeftPanel.

**Changements** :
- `modules/orchestrator/mailbox.ts` : ajouter un compteur cumulé
  `messagesTotal: number`, incrémenté à chaque `deliver()` et
  `broadcast()`. **Jamais reset** (le wraparound n'est pas un problème
  pratique).
- `OrchestratorView` (côté serveur + client) : ajouter `msgCount: number`
  exposé via `GET /orchestrators` et `GET /orchestrators/:id`.

**Tests** : étendre les tests existants de la mailbox pour vérifier
l'incrémentation + un test e2e qui crée un orch, envoie N messages,
vérifie le compteur via REST.

### S2. Évènement `mailbox.message` sur `/ws/events`

**Pourquoi** : alimente les pulses animés du `MapView`. Sans ça les
pulses sont soit random (perdent leur sens), soit limités aux
transitions de statut (insuffisant — un agent peut échanger beaucoup
sans changer de statut).

**Changements** :
- `events.ts` : nouveau `SwarmEventKind` `'mailbox.message'` avec
  payload `{ from: string, to: string | 'broadcast', orchestratorId: string }`.
- `mailbox.ts` : émettre cet event depuis `deliver()` et `broadcast()`,
  via le `eventBus` injecté.
- Garder le throttle/dedupe à la charge du frontend (pulses animés
  capés à 24 simultanés dans le proto).

**Tests** : vérifier que send_message → 1 event ; broadcast → 1 event
avec `to: 'broadcast'`.

### S3. Statut session `waiting` distinctement visible

**Pourquoi** : le proto a `running / idle / warn / stopped`. L'enum
serveur a `starting | running | waiting | exited | killed | interrupted | failed`.
**Aucun changement serveur nécessaire** mais formalisation du mapping
côté frontend pour préserver `waiting` (= signal opérateur le plus
important).

**Mapping recommandé** (à figer dans `update_UI.md` aussi) :
- `starting → idle` (couleur muted, fugace)
- `running → running` (vert)
- `waiting → warn` + pulsation visuelle (le signal qui justifie les toasts)
- `exited / killed / interrupted → stopped` (gris)
- `failed → bad` (rouge — état distinct de stopped, à ajouter au design)

**Changements** : aucun côté serveur. Documenter le mapping dans le
code frontend pour qu'il ne se perde pas.

### S4. Compteur global de messages + delta/min

**Pourquoi** : alimente le big number "Message flow" + sparkline 60-pts
du LeftPanel.

**Changements** :
- `GET /metrics/messages` (ou inclus dans `/health`) :
  ```json
  { "total": 12345, "per_minute": 42, "history": [80, 92, 88, ...] }
  ```
  `history` = ring buffer 60 entiers (1 par minute glissante).
- Implémentation : tick toutes les 60 s qui snapshot le `total`
  courant, calcule le delta vs le snapshot précédent, push dans le
  ring buffer.
- **Alternative low-effort** : exposer juste `total`, laisser le
  frontend calculer le delta/min et maintenir son ring buffer en
  mémoire (perdu au reload). Acceptable en v1 si on documente que le
  graphe se vide au refresh.

**Recommandation** : alternative low-effort en v1, endpoint dédié en
v2 si l'opérateur recharge souvent.

---

## P1 — Animations crédibles et actions fonctionnelles

### S5. Actions per-session : stop / pause / restart / kill

**Pourquoi** : les 4 boutons `pr-actions` du RightPanel. Aujourd'hui
seul "STOP orchestrator" existe (via `destroyOrchestrator`, qui agit
sur le lead → toute la team).

**Nouveaux endpoints** :
- `POST /sessions/:id/stop` (workers seulement ; sur un lead → 409 ou
  alias vers `destroyOrchestrator`). Implémentation : `session.kill()`
  + statut → `killed`.
- `POST /sessions/:id/pause` → envoie `SIGSTOP` au PTY ; statut →
  nouveau `paused`. **Implique d'étendre l'enum `SessionStatus`** avec
  `paused`.
- `POST /sessions/:id/resume` → `SIGCONT` ; statut → `running`.
- `POST /sessions/:id/restart` → `session.kill()` puis respawn via le
  spawner avec la même config (model/effort/preamble/cwd). Conserve
  l'`id` de session ? Probablement non, plus simple de créer une
  nouvelle session et marquer l'ancienne `interrupted`.

**Gotchas** :
- Le `permissionMode: bypassPermissions` doit être réinjecté au restart.
- Le PTY perd son état conversationnel — Claude doit redémarrer une
  conversation. À documenter (le bouton n'est pas une "pause de
  l'agent", c'est un "redémarrage propre").

**Tests** : ajouter une suite verify-phase qui couvre les 4 transitions.

### S6. Statut session `idle` (détection)

**Pourquoi** : le proto a `idle` (gris clair) en plus de `running`
(vert). Sémantiquement = agent en vie mais sans activité PTY récente.

**Changements** :
- Tick périodique (toutes les 5 s) côté serveur : si
  `now - session.lastActivityAt > 30 s` et statut = `running` →
  passer en `idle` (sans émettre `session.exited`, mais émettre
  `session.status_changed` pour que le frontend rafraîchisse).
- Sortie de `idle` : à la prochaine ligne PTY reçue, repasser en
  `running` (déjà géré par le `lastActivityAt` qui est mis à jour à
  chaque write PTY, il suffit d'ajouter le retour à `running`).

**Alternative** : laisser le frontend dériver `idle` depuis
`lastActivityAt` (qui est déjà exposé) — pas de changement serveur.
Recommandé pour la v1.

### S7. Champ `health` agrégé au niveau orchestrator

**Pourquoi** : la team-pill affiche `HEALTHY / DEGRADED / OFFLINE`.
Calculable côté front mais formalisation évite duplication
front/back.

**Règle** :
- `health: 'ok'` si tous les workers `running` et lead `running` et pas de
  `lastError`.
- `health: 'warn'` si au moins un worker `failed` OU lastError non null
  OU lead en `waiting`.
- `health: 'bad'` si lead `failed`.
- `health: 'stopped'` si orchestrator stoppé.

**Changements** : ajouter `health` calculé à la volée dans
`OrchestratorView`. Aucune persistance.

---

## P2 — Vraies métriques bus

### S8. Endpoint `/metrics/bus`

**Pourquoi** : alimente la section "BUS HEALTH" du LeftPanel
(latency, throughput, queue, err rate).

**Spec** :
```json
GET /metrics/bus
{
  "latency_ms": 42,
  "throughput_msg_per_s": 1200,
  "queue_depth": 118,
  "err_rate_pct": 0.4,
  "window_seconds": 60
}
```

**Mesures** :
- `latency_ms` : moyenne RTT MCP request→response sur fenêtre 60 s.
  Instrumenter `mcp/server.ts` (timer autour de chaque tool call).
- `throughput_msg_per_s` : `messages_total_60s_ago - messages_total_now`
  / 60.
- `queue_depth` : somme des `Mailbox.size()` sur tous les orchestrators.
- `err_rate_pct` : (MCP errors / MCP requests) × 100 sur 60 s.

**Alternatives** : ne livrer que `latency_ms` + `queue_depth` en v1
(faciles), les deux autres en v2.

### S9. Endpoint `/metrics/messages` (sparklines)

**Pourquoi** : alimente le `BigGraph` 60-pts du LeftPanel ET les
sparklines 8-pts de chaque team.

**Spec** :
```json
GET /metrics/messages
{
  "global": [80, 92, 88, ...],   // 60 points, msg/min
  "per_orchestrator": {
    "atlas": [12, 18, 9, 22, 31, 24, 38, 42],   // 8 points, msg/min
    ...
  }
}
```

**Implémentation** : ring buffers en mémoire, tick 60 s qui snapshot.
Perdu au restart serveur (acceptable, c'est métrique).

### S10. Heuristique "load %" par session

**Pourquoi** : `pr-stats` affiche `LOAD: 62%`. Sans source aujourd'hui.

**Options** :
- **(a) Élider** : afficher `—` en v1. Recommandé.
- **(b) Débit PTY** : bytes/sec sur 30 s glissantes, normalisé sur un
  max observé. Imprécis mais visuel.
- **(c) CPU%** : lire `/proc/<pid>/stat` toutes les 5 s. Linux-only
  (OK puisque container Linux). Plus juste mais coût d'implémentation
  non trivial.

**Recommandation** : (a) en v1, (b) en v2 si demandé.

---

## P3 — Console structurée et améliorations qualité

### S11. Console structurée avec niveaux

**Pourquoi** : le proto colore les lignes par niveau
`INFO / OK / WARN / ERR / SEND / RECV`. Aujourd'hui xterm.js affiche le
flux PTY brut.

**Deux voies** :
- **(a) Garder xterm** dans la tab CONSOLE — perte de la coloration
  fine mais zéro travail backend. **Recommandé v1.**
- **(b) Parseur côté serveur** :
  - Nouvelle frame WS `{ type: 'structured', ts, lv, msg }` en plus de
    `{ type: 'data', data: '...' }`.
  - Parseur regex sur les patterns Claude (timestamps, niveaux). Le
    format Claude n'est **pas stable** (pinned 2.1.142 mais bouge avec
    les updates), maintenance non négligeable.
  - Alternative cleaner : exposer un endpoint dédié `/ws/sessions/:id/log`
    qui sort des entrées structurées issues du fichier log persisté
    (cap 50 MB, déjà existant).

**Recommandation** : (a) en v1, (b) comme chantier ultérieur si la
console riche est demandée par l'opérateur.

### S12. Mapping `MailMessageView.from` → bulle `me/them/system`

**Pourquoi** : MESSAGES tab du RightPanel.

**Constat** : pas de changement serveur nécessaire. Le mapping est :
- `from === 'human'` → bulle `me` (l'opérateur)
- `from === sessionId` → bulle `them` (l'agent destinataire)
- `from === 'system'` → bulle `system` (réservé pour de futurs
  messages système ; à introduire si besoin)

**Changements** : documenter dans `client.ts` + ajouter une fonction
helper côté frontend.

---

## Récap (priorités)

| Lot | Effort | Bloque la nouvelle UI ? |
|---|---|---|
| **S1** Compteur messages par orch | S | Oui |
| **S2** Event `mailbox.message` | S | Oui (animations) |
| **S3** Mapping `waiting` (frontend seul) | XS | Non, mais critique pour l'opérateur |
| **S4** Compteur global + history | S→M | Oui (LeftPanel) |
| **S5** Actions per-session ×4 | M | Non bloquant si on désactive les boutons en v1 |
| **S6** Statut `idle` (frontend dérivable) | XS | Non |
| **S7** `health` agrégé orch | S | Non bloquant |
| **S8** `/metrics/bus` | M | Non (placeholders OK) |
| **S9** `/metrics/messages` | M | Non (calcul client OK en v1) |
| **S10** Load % | XS-M | Non (`—` en v1) |
| **S11** Console structurée | M-L | Non (xterm OK) |
| **S12** Mapping `from` (helper) | XS | Non |

**Sprint minimal pour débloquer l'UI** : S1 + S2 + S3 + S4 (alt
low-effort) = ~1 session de dev backend.

**Sprint complet (toutes priorités sauf S11)** : ~2-3 sessions.

---

## Pas de cassure de contrat existant

Toutes les additions ci-dessus sont **purement additives** :
- Nouveaux endpoints `/metrics/*` sans toucher aux existants.
- Nouveau champ `msgCount`, `health` sur `OrchestratorView` — les
  clients existants ignorent les champs inconnus.
- Nouveau `SwarmEventKind` `'mailbox.message'` — les anciens clients
  ignorent les events de kind inconnu (`useEvents` fait déjà un
  switch/match).
- Nouvelles routes `POST /sessions/:id/{stop,pause,resume,restart}` —
  pas de modification des routes existantes.
- Nouveau statut `paused` dans l'enum `SessionStatus` — à
  ajouter au type union côté client, défaut frontend = grisé.

Pas de migration DB nécessaire (les nouveaux champs sont calculés en
mémoire et exposés en lecture seule via API). Les compteurs étant en
mémoire, ils repartent à 0 au restart serveur — acceptable, c'est
cohérent avec la sémantique des mailboxes (non persistées par design,
cf. `composants.md` §3.3).
