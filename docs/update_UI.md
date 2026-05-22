# update_UI.md — Fonctionnalités à ajouter au prototype

**Étape 2 du plan d'intégration UI.** Ce document liste les fonctionnalités
existantes du système swarm-os qui n'ont pas d'équivalent visuel dans le
prototype et qu'il faut **ajouter au design** avant d'intégrer dans le
code React. Le but est que le prototype mis à jour soit une cible visuelle
complète : aucune feature critique du système ne devrait être perdue dans
la refonte.

Cf. `update_system.md` pour le sens inverse et `ui-redesign-desktop.md`
pour le plan d'ensemble.

Tout est ordonné par criticité : **U0** = ne peut pas être perdu sans
régression fonctionnelle, **U1** = à ajouter pour cohérence, **U2** =
polish.

---

## Backend v1 disponible (2026-05-22)

Les 12 lots S1-S12 d'`update_system.md` sont livrés. Voici le catalogue
exact des endpoints / champs / helpers à brancher côté UI ; les noms
ci-dessous sont à reprendre tels quels dans le code React.

### Champs nouvellement exposés (REST `/orchestrators[/:id]`)

- `OrchestratorView.msgCount: number` — total cumulé messages bus de la
  team (S1). Alimente `team-pill.msg` + colonne "Per-team traffic".
- `OrchestratorView.health: 'ok' | 'warn' | 'bad' | 'stopped'` —
  calculé côté serveur (S7). Alimente le statut HEALTHY/DEGRADED/OFFLINE
  de la team-pill. Source : `modules/orchestrator/health.ts`
  (`computeOrchestratorHealth`).
- `SessionView.status` peut désormais valoir `'paused'` (S5). À ajouter
  au mapping visuel (cf. helper `mapSessionStatusToVisual`).

### Nouvelles routes REST

- `POST /sessions/:id/stop` — termine la session (workers seulement,
  409 sur lead).
- `POST /sessions/:id/pause` — `SIGSTOP`, statut → `paused`.
- `POST /sessions/:id/resume` — `SIGCONT`, statut → `running`.
- `POST /sessions/:id/restart` — kill puis nouvelle session (l'ancienne
  passe en `interrupted`, le nouvel id diffère).
  Routes définies dans `packages/server/src/http/routes/sessions.ts:117-180`.
- `GET /metrics/messages` — `{ global: number[60], per_orchestrator: {…[8]} }`.
  Sparklines msg/min (S9). Source : `modules/metrics/aggregator.ts`.
- `GET /metrics/bus` — `{ latency_ms, throughput_msg_per_s, queue_depth,
  err_rate_pct, window_seconds }` (S8). Source :
  `modules/metrics/busMetrics.ts`. Alimente le panneau BUS HEALTH.

### Nouvel event WebSocket `/ws/events`

- `kind: 'mailbox.message'` avec payload
  `{ from: string, to: string | 'broadcast', orchestratorId: string }`
  (S2). Émis par toutes les fonctions de livraison du bus. Alimente les
  pulses animés du `MapView`. Throttle/dedupe à la charge du client.

### Helpers frontend déjà livrés (à importer)

| Module | Exports utiles | Usage |
|---|---|---|
| `packages/web/src/lib/sessionStatus.ts` | `mapSessionStatusToVisual`, `mapOrchestratorStatusToVisual`, `enrichWithIdle`, `VISUAL_CLASSES`, `IDLE_VISUAL_THRESHOLD_MS` | Mapping statut serveur → `'idle'\|'running'\|'warn'\|'bad'\|'stopped'` (S3) + dérivation `idle` côté front (S6, seuil 30 s sur `lastActivityAt`). |
| `packages/web/src/lib/useNow.ts` | `useNow(intervalMs = 5_000)` | Re-render périodique pour faire vieillir les "x s ago" et déclencher `enrichWithIdle`. |
| `packages/web/src/lib/messageStats.ts` | `useGlobalMessageStats`, `computeGlobalMessageStats`, `sumMsgCount`, `HISTORY_SIZE`, `DEFAULT_TICK_MS` | Ring buffer 60 pts côté client (S4, alt low-effort, perdu au reload). Bascule possible vers `GET /metrics/messages` en v2. |
| `packages/web/src/lib/loadPercent.ts` | `formatLoadPercent(value)`, `LOAD_PLACEHOLDER` | Formate `LOAD: 62%` ou em-dash si `null/undefined/NaN` (S10). |
| `packages/web/src/lib/mailBubble.ts` | `classifyBubble(msg, currentSessionId)`, `BubbleKind = 'me'\|'them'\|'system'\|'other-team'`, `SYSTEM_FROM_VALUES` | Détermine le style de bulle dans la tab MESSAGES (S12). `MailMessageView` côté client est déjà étendu. |

### Pulsation CSS (S3)

Classe `.swarm-pulse-warn` (cf. styles globaux) à appliquer aux nodes
`MapView` quand `visual === 'warn'`. Déjà câblée dans `StatusBadge` v1.

### Console structurée (S11)

Pas de structuration côté serveur en v1 : xterm.js reste consommateur du
flux PTY brut. La docstring de `Terminal.tsx` documente la décision et
les voies d'évolution.

---

## U0 — Critique (perte = régression fonctionnelle)

### U0.1 Bouton "+ NEW ORCHESTRATOR" + dialog de création

**Backend support** : déjà en place (`POST /orchestrators` avec name +
role + cwd + prompt + preamble + model/effort/perm).

**Manque côté proto** : pas de bouton "New", les teams sont en dur.

**À ajouter au design** :
- Bouton `+ NEW` dans la TopBar, à droite des team-pills ou à gauche
  de l'horloge. Style aligné `pr-action` (icône `+` + label
  "NEW TEAM").
- Modal overlay reprenant les champs actuels de `NewOrchestratorDialog` :
  `name`, `role` (dropdown depuis Roles + option "create new role"),
  `cwd`, `prompt` (textarea), `preamble` (textarea optionnel),
  `model` (dropdown Opus/Sonnet/Haiku), `effort` (segmented), `permission mode`
  (dropdown avec warning sur `bypassPermissions`).
- Style modal cohérent avec `bubble` / `pr-stat` du proto (palette
  warm-black ambré, fond `panel-solid`, border ambre).
- Confirmation visuelle : après création, focus auto sur la nouvelle
  team-pill + animation flash sur le node lead qui apparaît dans le
  `MapView`.

### U0.2 Page "ROLES" (templates réutilisables)

**Backend support** : déjà en place (CRUD `/roles`).

**Manque côté proto** : aucune notion de role.

**À ajouter au design** :
- Bouton/icône dans la TopBar (icône "stacked layers" ou "template")
  qui ouvre une vue plein écran ou un side-drawer "ROLES".
- Liste verticale des rôles avec :
  - label, id mono small ;
  - tags (worker count, model, effort, "has Discord webhook", "has lead prompt") ;
  - actions edit / delete.
- Dialog edit/create avec les champs : `label`, `leadPrompt`,
  `leadPreamble`, `workerPreamble`, `workerCount`, `defaultModel`,
  `defaultEffort`, `defaultPermissionMode`, `connectors` (Discord
  webhook URL).
- Visuel cohérent : panneau plein écran avec retour ← vers la vue map.

**Note** : ce n'est PAS une vue du shell principal (TopBar + Left +
Map + Right). C'est une vue secondaire accessible depuis un bouton, qui
remplace temporairement le contenu central. Le côté gauche peut rester
visible (Bus health / Per-team traffic) ou être masqué — choix design
à arrêter.

### U0.3 Panneau "SETTINGS / TOKEN"

**Backend support** : auth `X-Auth-Token` + WS tickets.

**Manque côté proto** : auth invisible.

**À ajouter au design** :
- Icône cog dans la TopBar (à droite, près de l'horloge).
- Click → side-drawer ou overlay :
  - Champ password "X-Auth-Token" (stocké localStorage) ;
  - Boutons Save / Clear ;
  - Banner d'aide si token absent/invalide (récupération via
    `docker exec ... cat /data/token`) — style `chip.warn` du proto ;
  - Sous-section "About" : project_name, version, uptime — alimentés
    par `/info` et `/health`. Cohérent avec le style `pr-stat` (3
    colonnes V/K).

### U0.4 Toasts "session waiting" (notifications)

**Backend support** : `/ws/events` + `useEvents` hook + Notification
hook de Claude.

**Manque côté proto** : zéro représentation des "agents en attente
d'input humain". C'est pourtant **le signal le plus important pour
l'opérateur mobile** (toute la raison d'être du composant Discord
embed).

**À ajouter au design** :
- Toasts coin bas-droite, fond `panel-solid` + border `chip.warn`
  ambre, max 5 visibles + bouton `+N older` :
  - Titre "SESSION WAITING" ;
  - id session mono small ;
  - reason (optionnel) ;
  - timestamp ;
  - bouton "→ OPEN" qui sélectionne l'agent dans le MapView + ouvre
    le RightPanel.
- Auto-dismiss 30 s.
- Pastille de connexion `events: live / reconnecting…` quand pas de
  toast actif (en bas-droite, opacity-60).
- **Représentation simultanée sur le node `MapView`** : ring
  ambre pulsant + status-dot ambre vif (distinct de `running` vert).
  C'est complémentaire des toasts, pas redondant.

### U0.5 Broadcast humain "to all in team"

**Backend support** : `POST /orchestrators/:id/broadcast`,
`from: 'human'` injecté dans les mailboxes.

**Manque côté proto** : le composer du RightPanel cible toujours un
agent unique.

**À ajouter au design** : trois options possibles, à arbitrer :
- **(a)** Clic sur le hub central "SWARM // BUS" du MapView ouvre un
  RightPanel en mode "broadcast" (target = orchestrator entier, pas un
  agent). Composer pré-rempli "BROADCAST → ALL AGENTS".
- **(b)** Toggle dans le composer existant : "MODE: agent / team".
- **(c)** Bouton "BROADCAST" séparé en pied de RightPanel quand un
  lead est sélectionné.

**Recommandation** : (a) — le hub a déjà la sémantique "bus
cross-team", c'est cohérent. + toggle (b) pour la team courante depuis
le RightPanel d'un lead.

### U0.6 Statuts session fins (lifecycle complet)

**Backend support** : enum
`starting | running | waiting | exited | killed | interrupted | failed`.

**Manque côté proto** : seulement `running / idle / warn / stopped`.

**À ajouter au design** :
- `waiting` (= attente input humain) → distinct visuellement de `idle` :
  ring ambre pulsant + status-dot ambre vif. Cf. U0.4.
- `failed` → distinct de `stopped` : ring rouge `--bad`, status-dot
  rouge, ne ressuscite pas tout seul.
- `starting` → fugace, ring tirets ambres + label "STARTING".
- `interrupted` (server-restart) → ring tireté gris avec petit badge
  "SVR-RESTART" sous le label.
- `exited` vs `killed` : différenciables dans le `pr-stats` via une
  ligne `EXIT REASON` (à ajouter).

**Mapping résumé à figer côté code** :
| Backend | Visual proto |
|---|---|
| starting | idle + tirets ambres |
| running | running (vert) |
| waiting | warn pulsant (ambre vif) |
| exited | stopped (gris) |
| killed | stopped (gris) + tooltip "killed" |
| interrupted | stopped (gris) + badge "SVR-RESTART" |
| failed | bad (rouge) |

### U0.7 Distinction "input PTY" vs "message mailbox" dans le composer

**Backend support** : deux chemins distincts
(`POST /sessions/:id/input` vs `team.send_message` via MCP).

**Manque côté proto** : composer sémantiquement ambigu.

**À ajouter au design** :
- Toggle dans le composer-row : `MODE: PTY / MAILBOX`.
- Mode `PTY` (par défaut pour les leads/workers actifs) = bytes au PTY,
  raccourci pour débloquer un agent. Label composer "→ PTY".
- Mode `MAILBOX` = pousser dans la mailbox de l'agent, déclenche le
  signal "vous avez du courrier". Label composer "→ INBOX".
- Helper texte sous le composer pour clarifier la différence.

**Note** : MAILBOX humain → agent n'est pas exposé aujourd'hui via une
route REST individuelle ; il existe le broadcast et le PTY input. Cf.
`update_system.md` S5 si on veut formaliser un `POST /sessions/:id/mail`.

---

## U1 — Important (cohérence avec le système)

### U1.1 Affichage Modèle / Effort / Permission mode

**Backend support** : `defaultModel`, `defaultEffort`,
`defaultPermissionMode` sur orch + même triplet par session.

**Manque côté proto** : invisible.

**À ajouter au design** :
- Dans le `pr-head` du RightPanel, sous la ligne de rôle (`pr-role`) :
  une ligne mono small `M:opus-4-7 · E:xhigh · P:bypass` (style
  `pill-meta` du proto).
- Bouton edit (icône crayon) ouvrant un dialog "ROTATE MODEL/EFFORT"
  qui restart la session avec une nouvelle config (cf.
  `update_system.md` S5 pour le restart endpoint).

### U1.2 Affichage Cwd / workspace

**Backend support** : chaque orch a un `cwd` workspace-relatif.

**Manque côté proto** : invisible.

**À ajouter au design** :
- Dans le `pr-head`, ligne sous le rôle :
  `CWD :: /mon-projet` en mono small.
- Tooltip sur hover : "workspace-relative path".

### U1.3 Préambules (lead / worker)

**Backend support** : `leadPreamble`, `workerPreamble` sur l'orch.

**Manque côté proto** : invisible.

**À ajouter au design** :
- Dans le RightPanel, ajouter un 3e tab `CONFIG` à côté de
  `CONSOLE` / `MESSAGES` :
  - Affiche les préambules en mono (lecture seule) ;
  - Affiche le `leadPrompt` initial ;
  - Affiche la config complète (model, effort, perm, cwd) avec bouton
    edit ;
  - Affiche les connectors (Discord webhook URL truncated) avec un
    chip "ENABLED".

### U1.4 Inbox count par session (badge non-lus sur le node MapView)

**Backend support** : `peekInbox` polled toutes les 3 s, déjà utilisé
dans l'UI actuelle (badge ambre par session).

**Manque côté proto** : pas représenté.

**À ajouter au design** :
- Petit chiffre près du status-dot de chaque node MapView (quand >0).
- Stylé `chip.warn` mini : pastille ambre avec chiffre noir, ~10px.
- Disparaît à 0.
- Représente "messages non lus côté agent" — utile pour repérer un
  agent submergé.

### U1.5 Historique des orchestrators terminés

**Backend support** : `OrchestratorList` actuel affiche "Recently
ended" en bas avec badge `server-restart`.

**Manque côté proto** : pas de section historique. L'orchestrator
stoppé (ORACLE) apparaît dans la TopBar mais sans distinction
"terminé récemment" vs "actif mais OFFLINE".

**À ajouter au design** :
- Section dans le LeftPanel ou panneau pliable accessible depuis
  TopBar : "RECENTLY ENDED" avec liste compacte (name + endedAt +
  reason chip si `server-restart`).
- Clic sur une entrée historique → RightPanel en lecture seule
  (composer désactivé, actions désactivées sauf "REACTIVATE" si le
  back implémente ça).

### U1.6 Spawn worker dynamique (action lead-only)

**Backend support** : MCP tool `team.spawn_worker` (exposé à l'agent
lead, pas via REST aujourd'hui). Possible d'ajouter un endpoint REST
pour l'opérateur — cf. `update_system.md` (chantier).

**Manque côté proto** : aucun bouton "SPAWN WORKER" dans le
RightPanel d'un lead.

**À ajouter au design** :
- 5e bouton dans `pr-actions` quand lead sélectionné :
  `+ WORKER` (icône `fork`) qui ouvre un mini-dialog
  (nom + role + worker preamble override).
- Animation : apparition du nouveau worker dans le MapView (fade in
  + scale du 0 vers 1, edge dessiné progressivement).

### U1.7 Compteur ligne logs / Uptime / PID

**Backend support** : `lastActivityAt`, `startedAt`, `pid`, `exitCode`,
`logPath` sur `SessionView`.

**Manque côté proto** : juste un `UPTIME` placeholder.

**À ajouter au design** :
- `pr-stats` reste à 3 colonnes mais avec valeurs réelles :
  - LOAD : `—` (v1) ou % (v2)
  - UPTIME : `now - startedAt` formaté `HH:MM:SS`
  - LOG LINES : compteur live
- Sous-ligne `pr-meta` ajoutée sous le `pr-stats` :
  `pid=12345 · started=04:11:32 · last_activity=2m ago`
  En mono small style `pill-meta`.

### U1.8 Project name / version / uptime serveur dans la TopBar

**Backend support** : `/info` (`project_name`, `version`,
`started_at`) + `/health` (`uptime_seconds`).

**Manque côté proto** : "v0.4 // ORBIT" en dur.

**À ajouter au design** :
- Sous le brand, remplacer `v0.4 // ORBIT` par les vraies valeurs :
  `swarm-fyrel · v1.0.3 · 04:11:18 up` en mono small letterspacing
  `0.16em`.
- Couleur muted, ne distrait pas du health-strip principal.

### U1.9 Boutons KILL / REACTIVATE / PAUSE / RESTART per-session

**Backend support** : nécessite `update_system.md` S5 (en P1).

**Manque côté proto** : présents visuellement mais pas câblés.

**À ajouter au design** :
- Déjà présents dans `pr-actions` (STOP, PAUSE, RESTART, KILL,
  REACTIVATE). Confirmer :
  - States disabled stylés (opacity 0.35) tant que les endpoints
    n'existent pas ;
  - Tooltip "available in v2" sur les disabled ;
  - Active : style amber-soft, hover amber-vif.
- Confirmation modale avant KILL et avant STOP (lead → toute la team
  s'éteint, conséquence importante).

---

## U2 — Polish

### U2.1 Reader/Writer mode du WS terminal

**Backend support** : un seul writer par session, N readers passifs.
Le `Terminal.tsx` affiche déjà "role: writer/reader".

**Manque côté proto** : non représenté.

**À ajouter au design** :
- Petite pastille en haut à droite de la tab CONSOLE :
  `WRITER` (ambre) ou `READER` (gris). Tooltip explicatif.

### U2.2 Connecteurs Discord (par role)

**Backend support** : webhook Discord par role, override le global.

**Manque côté proto** : non représenté.

**À ajouter au design** :
- Tab `CONFIG` (cf. U1.3) ou icône Discord petite près du nom du
  rôle dans la team-pill / le `pr-head`.
- Indicateur "DISCORD" chip ambre dans le `pr-head` du lead si la
  team a un webhook actif.

### U2.3 Mailbox dropped flag (bus saturé)

**Backend support** : la mailbox est bornée à 100 messages, drop-oldest,
flag `dropped: true` retourné au sender.

**Manque côté proto** : non représenté.

**À ajouter au design** :
- Si dropped detected (via un futur event WS), faire flasher
  rapidement la team-pill correspondante en rouge ;
- Status-dot du node MapView passe rouge le temps que la mailbox se
  vide.

### U2.4 Pulses colorés par type MCP

**Backend support** : si on enrichit l'event `mailbox.message` avec un
champ `kind` (`intra_team`, `cross_team`, `broadcast`, `human`).

**Manque côté proto** : tous les pulses sont ambre uniformes.

**À ajouter au design** :
- intra_team : ambre `--amber`
- cross_team (lead↔lead via hub) : ambre vif + traînée plus longue
- broadcast : multi-pulse en éventail depuis le sender
- human : pulse blanc (`--text`)

### U2.5 Animation worker spawn / kill

**À ajouter au design** :
- Apparition worker : node fade-in + scale 0→1 (300 ms), edge
  dessinée progressivement.
- Disparition worker : ring tirets gris + fade-out (500 ms) puis
  collapse.

### U2.6 Pan-to-fit + minimap (MapView)

**Manque côté proto** : pan/zoom déjà présents mais pas de "recentrer
sur la sélection" ni de minimap.

**À ajouter au design** :
- Double-click sur un node : zoom-to-fit sur la team.
- Bouton `◇` (déjà présent dans `canvas-zoom`) qui reset déjà la vue —
  OK.
- Minimap optionnelle bas-gauche (overlay 120×90 px) qui montre la
  vue globale + viewport courant. v3 possiblement.

---

## Récap

| Lot | Effort design | Backend prérequis |
|---|---|---|
| **U0.1** Bouton + dialog NEW | M | déjà OK |
| **U0.2** Page ROLES | L | déjà OK |
| **U0.3** Settings/Token panel | S | déjà OK |
| **U0.4** Toasts waiting + ring pulsant | S | déjà OK |
| **U0.5** Broadcast humain via hub | S | déjà OK |
| **U0.6** Statuts fins | S | déjà OK (juste mapping) |
| **U0.7** Toggle PTY/MAILBOX composer | S | déjà OK (PTY) ; partiel (MAILBOX) |
| **U1.1** Model/Effort/Perm affichés | XS | déjà OK |
| **U1.2** Cwd affiché | XS | déjà OK |
| **U1.3** Tab CONFIG (préambules) | M | déjà OK |
| **U1.4** Inbox badges sur nodes | S | déjà OK |
| **U1.5** Historique ended | M | déjà OK |
| **U1.6** Spawn worker dynamique | M | nécessite endpoint REST |
| **U1.7** Stats réelles (uptime/log lines) | S | déjà OK |
| **U1.8** Project info dans TopBar | XS | déjà OK |
| **U1.9** Boutons per-session câblés | S | nécessite `update_system.md` S5 |
| **U2.1** Reader/Writer badge | XS | déjà OK |
| **U2.2** Discord indicators | S | déjà OK |
| **U2.3** Mailbox dropped warning | S | nécessite event WS |
| **U2.4** Pulses colorés | S | nécessite `update_system.md` S2 enrichi |
| **U2.5** Animations spawn/kill | M | déjà OK |
| **U2.6** Pan-to-fit + minimap | M | déjà OK |

**Sprint design minimal (U0)** : ~1 session — toutes les fonctionnalités
critiques du système ont un emplacement dans la nouvelle UI.

**Sprint design complet (U0 + U1)** : ~2 sessions — la nouvelle UI
représente fidèlement toute la richesse du backend actuel.

---

## Livrable design

Pour chacun des lots U0 + U1, produire :
1. **Mockup statique** (HTML/JSX dans `prototypes/`, suivant la
   convention existante) — au moins la team-pill mise à jour, le
   RightPanel avec tab CONFIG, la TopBar avec icônes Roles/Settings,
   les toasts.
2. **Mini-doc** sur les flux modaux (NEW dialog, Roles dialog,
   confirmation KILL, etc.) — soit dans le HTML, soit dans
   `prototypes/flows.md`.
3. **Mapping role→shape** figé : tableau qui dit pour chaque role
   string (libre, exemples du seed actuel : `researcher`, `builder`,
   `critic`…) quelle forme géométrique utilise le node MapView.

Une fois ces livrables prêts ET les lots `update_system.md` (au moins
P0) livrés, l'étape 3 (intégration code) peut démarrer en suivant
`ui-redesign-desktop.md`.
