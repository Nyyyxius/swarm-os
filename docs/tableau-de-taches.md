# Tableau de tâches durable SwarmOS — coordination d'état persistante ("Kanban")

> Recherche & analyse — 2026-08-01. Établi à partir d'une cartographie du code
> de ce repo (`packages/server`, `packages/web`) et du comparatif
> `docs/comparatif-hermes-agent.md` (§2). Calqué sur la feature **mémoire
> partagée** déjà livrée (`docs/memoire-partagee.md`), qui sert de patron éprouvé
> à chaque couche.
>
> **But** : combler le manque « coordination d'état durable » de SwarmOS face à
> Hermes Agent — un **tableau de tâches** (cartes, assignations, dépendances,
> journal d'audit, reprise après crash), **par équipe**, **consultable en web**
> dans SwarmOS et **piloté par les agents** eux-mêmes.

---

## 1. Le gap à combler (recadré après vérification du code)

`docs/comparatif-hermes-agent.md` (§2) : coordination d'état = **« Mailbox
volatile + état SQLite des sessions »** vs Hermes = **« Kanban SQLite (cartes,
assignee, dépendances, audit log, reprise après crash) »**.

**Correctif important** après lecture du code : la mailbox **n'est PAS** volatile
au sens strict. Depuis la Phase 8, `mailbox_messages` est une table SQLite en
**write-through** (`orchestrator/mailbox-persistence.ts:35-61`), **réhydratée au
boot** avec `autoResume=true` (`index.ts:585`, `mailbox-persistence.ts:105-201`).
Les messages en attente survivent donc à un redémarrage.

Le vrai manque est plus précis, et plus fort : **il n'existe aucune entité
durable de *tâche* dans SwarmOS.** La coordination est du **passage de messages
transitoire** — un message est consommé une fois (`team.read_inbox` le draine et
le tamponne `delivered_at`, `tools.ts:391-399`) puis oublié. Vérifié dans le
schéma : les seules tables sont `orchestrators`, `sessions`, `mailbox_messages`,
`roles`, `instance_settings` (plus les tables des stores mémoire/plugins/updates).
**Aucune table `tasks`/`cards`/`board`.** Il n'existe nulle part de notion
persistante de *qui fait quoi, dans quel état, bloqué par quoi, avec quel
historique*.

Concrètement : aujourd'hui un lead qui `/clear` perd tout son modèle mental de
« ce qui est assigné à qui et où ça en est » — il ne lui reste qu'un `NOTES.md`
bricolé (exactement ce que fait l'agent Discord actuel). Le tableau de tâches
remplace ce journal ad hoc par un **état structuré, requêtable, visible en web et
partagé par toute l'équipe**, qui survit au `/clear`, au crash et au resume.

## 2. Vision cible

- **Un tableau de tâches par équipe** (par orchestrateur) : colonnes = statuts,
  cartes = tâches. C'est l'unité de travail naturelle (1 lead + N workers = 1
  mission = 1 tableau).
- **Cartes durables** : titre, description, statut (colonne), assigné (une
  session — lead ou worker — ou personne), priorité, labels, **dépendances**
  (carte → carte, DAG) et un **journal d'audit append-only** (créée, déplacée,
  assignée, commentée, bloquée, fermée…). C'est le « audit log + reprise » de
  Hermes.
- **Piloté par les agents** : le lead crée et assigne les cartes ; chaque worker
  déplace *ses* cartes (`doing` → `review`/`done`), commente le résultat, signale
  un blocage. Les outils MCP `board.*` sont le canal ; le préambule impose l'usage
  (comme pour la mémoire).
- **Reprise après crash** : le tableau est reconstruit depuis SQLite au boot ;
  une passe marque les cartes dont l'assigné n'existe plus comme **orphelines**
  (à réassigner) → le lead ressuscité voit exactement ce qui était en vol.
- **Consultable en web dans SwarmOS** : une page « Board » affiche le Kanban
  (colonnes + cartes déplaçables), le détail d'une carte et son journal d'audit,
  en direct — **sans app externe**.
- **Vue cross-équipe réservée aux leads** (miroir de `swarm.list_teams`) pour
  consulter les tableaux voisins. **Pas** un tableau global unique (bruit ; un
  worker n'a pas besoin des cartes des autres équipes). Côté web, l'opérateur
  humain peut basculer d'un tableau d'équipe à l'autre via un sélecteur.

**Contraste avec la mémoire** : la mémoire est **partagée par tous** (savoir long
terme, global à l'instance) ; le tableau est **par équipe** (état opérationnel
d'une mission). Les deux sont complémentaires — la mémoire dit *ce qu'on sait*, le
tableau dit *ce qu'on fait*.

## 3. Décision d'architecture : **core**, pas plugin

Même raisonnement que la mémoire (`memoire-partagee.md` §3) : le tableau doit être
toujours actif, scoppé par équipe côté serveur, et surtout **auto-consulté** par
chaque agent (le worker doit trouver *sa* carte au démarrage, le lead doit voir
l'état au resume). Or seul le **préambule core** (`default-lead.md` /
`default-worker.md`) délivre proprement cette directive, **durable au `/clear`**
via `--append-system-prompt`. Les outils d'un plugin sont bien exposés à tous les
agents, mais l'annonce préambule d'un plugin est générique et ne peut pas injecter
« consulte ton tableau au démarrage ».

→ **Core.** (Un plugin `taskboard` reste un bon moyen de *spiker* vite les outils
sans toucher au serveur — voir Phase 0.)

## 4. Modèle de stockage : **SQLite seul** (plus simple que la mémoire)

La mémoire a retenu un hybride *fichiers-vérité + index SQLite* **uniquement** pour
la compatibilité Obsidian (vault portable, git-friendly). **Le tableau n'a aucune
exigence de portabilité externe** : c'est de l'état opérationnel. Donc **SQLite
seul**, ce qui est plus simple, transactionnel et directement requêtable.

Le store `TaskboardStore` **possède ses propres tables** via
`CREATE TABLE IF NOT EXISTS` sur le handle brut `swarmDb.db` dans son constructeur
— **exactement** comme `MemoryStore` (`memory/store.ts:473-511`), `PluginStore`
(`plugins/store.ts:158-186`) et `UpdateStore`. **Ne PAS** déclarer les tables dans
`schema.sql` : ce fichier n'est pas embarqué dans l'image Docker (`tsc` ne le
copie pas) et `applySchema()` retombe silencieusement sur `INLINE_SCHEMA`
(`db/index.ts:563-577`) → une table déclarée seulement dans `schema.sql`
n'existerait jamais en prod. Migrations additives idempotentes via un
`applyMigrations()` local (`ALTER TABLE … ADD COLUMN` en try/catch, patron
`db/index.ts:506-561`).

Le tout est **couvert par le backup à chaud** sans effort : il snapshote le
fichier `swarm-os.db` entier (`backup/index.ts`, online backup API, `/data`).

### Schéma des tables

```sql
-- Cartes (l'unité). Scoppée à une équipe via orchestrator_id (FK ON DELETE CASCADE,
-- même précédent que mailbox_messages). Verrou optimiste via version.
CREATE TABLE IF NOT EXISTS taskboard_cards (
  id                  TEXT PRIMARY KEY,          -- UUIDv4
  orchestrator_id     TEXT NOT NULL,             -- équipe (stable au resume)
  title               TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',  -- description markdown
  status              TEXT NOT NULL DEFAULT 'todo', -- todo|doing|blocked|review|done
  assignee_session_id TEXT,                       -- NULL = non assignée (soft-ref sessions.id)
  priority            INTEGER NOT NULL DEFAULT 0, -- 0 normal, +1/+2 haute…
  labels              TEXT,                       -- JSON array de chaînes
  order_key           TEXT NOT NULL,              -- rang lexicographique dans la colonne
  created_by          TEXT NOT NULL,              -- provenance (session id | 'web')
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1, -- concurrence optimiste
  closed_at           INTEGER,                    -- carte terminée
  orphaned_at         INTEGER,                    -- assigné disparu (flag + base du TTL)
  auto_created        INTEGER NOT NULL DEFAULT 0, -- 1 = carte créée au spawn du worker
  hidden_at           INTEGER,                    -- soft-delete (house style)
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tb_cards_orch_status ON taskboard_cards(orchestrator_id, status);
CREATE INDEX IF NOT EXISTS idx_tb_cards_assignee    ON taskboard_cards(assignee_session_id);

-- Dépendances : card_id est bloquée par depends_on_id (arêtes d'un DAG).
CREATE TABLE IF NOT EXISTS taskboard_deps (
  card_id       TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (card_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_tb_deps_depends_on ON taskboard_deps(depends_on_id);

-- Journal d'audit append-only (le "audit log + reprise" de Hermes).
CREATE TABLE IF NOT EXISTS taskboard_events (
  id                TEXT PRIMARY KEY,             -- UUIDv4
  card_id           TEXT NOT NULL,
  orchestrator_id   TEXT NOT NULL,
  actor_session_id  TEXT,                          -- qui a agi (NULL = 'web'/system)
  kind              TEXT NOT NULL,                 -- created|updated|moved|assigned|
                                                   -- dep_added|dep_removed|comment|closed|reopened|orphaned
  data              TEXT,                          -- JSON: {from,to,assignee,text,…}
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tb_events_card ON taskboard_events(card_id, ts);
```

Notes de conception :
- **Statuts** : enum fixe en Phase 1 (`todo|doing|blocked|review|done`) ; colonnes
  personnalisables par tableau = Phase 5 (table `taskboard_columns`).
- **`assignee_session_id`** : **soft-ref, PAS de FK cascade** — on garde la carte
  même si la session disparaît, et on la marque orpheline. Ne **jamais** utiliser
  `sessionSecret` comme clé d'assigné (régénéré à chaque construction,
  `session.ts:418`, non persisté) — utiliser `session.id` (stable au resume).
- **`order_key`** : rang lexicographique (façon LexoRank) pour réordonner sans
  réécrire toutes les cartes d'une colonne.
- **Cycle guard** sur `taskboard_deps` : refuser une arête qui fermerait un cycle
  (parcours au moment du `board.link`).

## 5. Outils MCP (core) — exposés à chaque agent

À écrire dans `registerTaskboardTools(server, ctxResolver)`
(`modules/mcp/taskboard-tools.ts`), calqué sur `registerMemoryTools`
(`modules/mcp/memory-tools.ts:35`), monté dans `modules/mcp/server.ts`
**juste après** `registerMemoryTools` (server.ts:233). Réutilise `ok()`,
`requireLead()`, `logCall()` (`modules/mcp/tools.ts:131/147/162`) et **stampe la
provenance depuis la session** (`createdBy: ctx.session.id`, scope
`ctx.orchestrator.id`), jamais depuis les args — comme
`memory-tools.ts:154-155`. Le contexte fournit le store via `spawner.taskboard`
(`resolveContext`, server.ts:329).

| Outil | Rôle | Accès |
|---|---|---|
| `board.list({status?, assignee?, mine?})` | cartes du tableau de MON équipe ; `mine:true` = assignées à moi | tous |
| `board.get({id})` | carte + dépendances + fin du journal d'audit | tous |
| `board.create({title, body?, status?, assignee?, priority?, labels?, dependsOn?})` | créer une carte sur ce tableau | tous |
| `board.update({id, expectedVersion, title?, body?, priority?, labels?})` | éditer (verrou optimiste) | assigné **ou** lead |
| `board.move({id, status, expectedVersion?})` | changer de colonne (l'action Kanban clé) | assigné **ou** lead |
| `board.assign({id, assignee})` | (ré)assigner | **lead** (ou auto-assignation si `assignee=self`) |
| `board.comment({id, text})` | commenter (append au journal) | tous |
| `board.link({from, to})` / `board.unlink({from, to})` | ajouter/retirer une dépendance (cycle guard) | tous |
| `board.close({id})` / `board.reopen({id})` | fermer / rouvrir | assigné **ou** lead |
| `board.teams()` / `board.list({team})` | lire le tableau d'une **autre** équipe | **lead** (cross-équipe) |
| `board.delete({id})` | supprimer | **lead** (`requireLead`) |

**Modèle de permissions** (à confirmer, §11) :
- Lire son tableau + créer/commenter/lier une carte : **tous**.
- Éditer / déplacer / fermer une carte : **l'assigné ou le lead** (self-service
  worker sur ses cartes, orchestration par le lead) → nouveau petit helper
  `requireLeadOrAssignee(ctx, card)`.
- Assigner à autrui, supprimer, lire cross-équipe : **lead** (`requireLead`).

Concurrence gérée par `version`/`expectedVersion` + un `TaskboardConflictError`
(code `VERSION_CONFLICT`) **jeté** et traduit en erreur MCP `InvalidRequest` /
HTTP 409, exactement comme `MemoryConflictError` (`memory/store.ts:151-162`,
`memory-tools.ts:163-168`). Le journal d'audit est append-only (aucun conflit).

## 6. Injection préambule (la pièce qui impose le core)

Ajouter une section « Tableau de tâches » à `modules/preambles/default-lead.md` et
`default-worker.md` :

- **Lead** : au **démarrage d'une mission**, créer les cartes du plan et les
  assigner ; orchestrer via `board.move`/`board.assign` (au lieu d'un `NOTES.md`
  ad hoc) ; au **resume**, `board.list` pour voir l'en-cours et les cartes
  orphelines avant d'agir.
- **Worker** : à la réception d'une tâche, trouver sa carte (`board.list({mine})`)
  et la passer en `doing` ; en fin, la passer en `review`/`done` et
  `board.comment` le résultat ; si bloqué, `board.move` → `blocked` + commentaire.
- Ajouter les noms d'outils à `TEAM_TOOL_LOGICAL_NAMES` (`orchestrator/preamble.ts:72`)
  pour le renommage codex/gemini/opencode, **et** mettre à jour `preamble.test.ts`
  (il vérifie la synchro avec les outils réellement enregistrés).

C'est exactement le mécanisme de la section « Shared memory » — patron éprouvé.

## 7. Vue web « Board » (le Kanban intégré, sans app externe)

Page overlay `BoardPage.tsx`, **toujours montée, gaté par `open`** (patron
`MemoryPage`/`RolesPage`). **Contrairement à la mémoire, pas de canvas SVG
force-directed** : un simple **grid/flex de colonnes** (une par statut), cartes en
tuiles **déplaçables** (drag-and-drop HTML5). Points à toucher (identiques au
patron overlay de la mémoire) :

- **Route** : membre `{kind:'board'}` de l'union `Route`, `#/board` dans
  `parseHash`/`setHashRoute`, rendu `<BoardPage open={route.kind==='board'} …/>`
  dans `packages/web/src/App.tsx` (voir memoire : App.tsx:16/37/47/122).
- **Nav** : bouton `BOARD` `.tb-action` dans `components/desktop/TopBar.tsx`
  (prop optionnelle `onOpenBoard?`), threadé via
  `controller/SwarmController.tsx` (`onOpenBoard` + `boardRev`) et
  `components/desktop/DesktopShell.tsx`.
- **Sélecteur d'équipe** : le tableau étant par équipe, la page a un **dropdown
  d'orchestrateurs** (réutiliser la liste `useOrchestrators`) ; l'opérateur
  choisit l'équipe dont il voit le tableau.
- **Données** : hook `useBoard(orchId, 3000, open)` (copie de `useMemoryNotes`,
  même shape poll + dégradation 404 `unavailable`) + méthodes/types dans
  `api/client.ts` ; live via nouveaux events `taskboard.*` sur le bus
  (`hooks/useEvents.ts`, branche `ev.kind.startsWith('taskboard.')` →
  `boardRev++`), diffusés par l'`EventsHub` existant sur `/ws/events` (aucun
  nouveau WS).
- **Colonnes + cartes** : `board-col` par statut, `board-card` déplaçable ; drop
  sur une colonne → `board.move` (REST). Panneau latéral **détail de carte** :
  description, assigné, dépendances, et **timeline du journal d'audit** ; édition
  inline → REST → même `TaskboardStore` → visible par les agents.
- **Mobile** : pas d'entrée dans le dock aujourd'hui (plein) — mobile = Phase 5
  optionnelle, comme la mémoire.

## 8. REST + temps réel (backend web)

- `packages/server/src/http/routes/taskboard.ts` →
  `createTaskboardRouter(taskboardStore)`, monté avec les autres routers
  **authentifiés** dans `http/main.ts` (~ligne 325, après `app.use(auth)`).
  Endpoints : `GET /api/board?orch=&status=&assignee=`,
  `GET /api/board/card/:id`, `POST /api/board/card`, `PUT /api/board/card/:id`
  (409 sur conflit de version), `PATCH /api/board/card/:id/move`,
  `POST /api/board/card/:id/comment`, `POST|DELETE /api/board/card/:id/deps`,
  `DELETE /api/board/card/:id`, `GET /api/board/teams`. Écritures web =
  provenance `created_by:'web'` (comme la mémoire, `routes/memory.ts:119-121`).
- Events `taskboard.card_created|card_updated|card_moved|card_assigned|
  comment_added|dep_changed|card_closed|card_deleted|card_orphaned` ajoutés à
  l'union `SwarmEventKind` (`events.ts:35-38`, union ouverte → non-cassant), émis
  par le store via le `eventBus` injecté ; servis par `/ws/events`
  (`http/ws/events.ts`) **gratuitement**.

## 9. Points d'insertion (récap chirurgical)

| Pièce | Fichier(s) |
|---|---|
| Tables + store | `packages/server/src/modules/taskboard/store.ts` (possède ses tables via `CREATE TABLE IF NOT EXISTS` sur `swarmDb.db`, `applyMigrations`, verrou `version`, `TaskboardConflictError`, cycle-guard deps, émission events) ; instancié dans `src/index.ts` (~l.148, à côté de `memoryStore`, en try/catch, `eventBus` injecté), threadé dans le `spawner` (dep `taskboard?`, comme `memory`) + `startServer` |
| Outils MCP | `modules/mcp/taskboard-tools.ts` → `registerTaskboardTools()`, appelé dans `modules/mcp/server.ts` (~l.233, après `registerMemoryTools`) ; ctx via `spawner.taskboard` (`resolveContext` ~l.329) |
| Directive préambule | `modules/preambles/default-lead.md` + `default-worker.md` ; `TEAM_TOOL_LOGICAL_NAMES` (`orchestrator/preamble.ts:72`) ; `preamble.test.ts` |
| REST | `http/routes/taskboard.ts`, monté dans `http/main.ts` (~l.325) |
| Temps réel | kinds `taskboard.*` dans `events.ts`, émis via `eventBus` ; servis par `/ws/events` |
| Reprise crash | passe boot dans `src/index.ts` (après `runAutoResume`) : marquer orphelines les cartes dont `assignee_session_id` n'est plus une session vivante → event `taskboard.card_orphaned` |
| Page web | `packages/web/src/App.tsx` (route), `components/desktop/TopBar.tsx` (nav), `controller/SwarmController.tsx` + `components/desktop/DesktopShell.tsx` (threading), `components/BoardPage.tsx`, `hooks/useBoard.ts`, `hooks/useEvents.ts` (branche), `api/client.ts` ; colonnes en CSS grid/flex (pas de `d3-force`) |

## 10. Plan d'intégration incrémental ("tranquillement")

- **Phase 0 — spike (optionnel, jetable)** : plugin `taskboard`
  (`api.storage.defineTable` + `api.mcp.registerTool`) pour valider l'ergonomie des
  outils `board.*` avec de vrais agents, **zéro** changement serveur. Jetable une
  fois l'API validée.
- **Phase 1 — store + outils MCP (backend)** : `TaskboardStore` (tables SQLite +
  verrou `version` + journal d'audit + DAG de dépendances + cycle-guard),
  `registerTaskboardTools` (list/get/create/update/move/assign/comment/link/
  close/delete), tests. → les agents coordonnent déjà via un tableau **durable**
  en MCP, **avant toute UI**.
- **Phase 2 — préambule** : sections « Tableau de tâches » (lead + worker) +
  `TEAM_TOOL_LOGICAL_NAMES` + test. → chaque agent utilise le tableau
  **automatiquement** (le lead assigne, les workers mettent à jour leurs cartes),
  en remplacement du suivi ad hoc dans `NOTES.md`.
- **Phase 3 — REST (lecture seule) + events + reprise crash + auto-carte** :
  `routes/taskboard.ts` **en lecture seule** (GET) + une DELETE opérateur ; kinds
  `taskboard.*` ; passe boot marquant les cartes **orphelines** (assigné disparu)
  avec `orphaned_at` + **janitor TTL** qui les purge après un délai ; **hook
  auto-carte au `spawn_worker`** (`Orchestrator.addWorker`, index.ts:~823) : chaque
  worker spawné crée automatiquement une carte qui lui est assignée. → données
  atteignables par le web en direct, tableau conscient du resume, et l'utilisateur
  voit **toujours** les tâches en cours.
- **Phase 4 — page web Board (lecture seule)** : overlay Kanban (colonnes + cartes
  + sélecteur d'équipe + détail carte avec timeline d'audit), **observabilité en
  lecture seule** — aucune écriture depuis le web sauf **supprimer une carte**
  (nettoyage opérateur, surtout les orphelines). Les agents restent seuls à muter
  l'état via MCP. → le **Kanban dans SwarmOS, sans app externe**.
- **Phase 5 — plus tard** : colonnes personnalisables par tableau/rôle ; **vue
  cross-équipe agrégée** (dashboard opérateur/lead) ; **pont carte ↔ mémoire**
  (archiver le tableau d'une mission close en note mémoire) ; limites WIP + indices
  de scheduling ; mise en évidence de l'âge/SLA des cartes ; templates de cartes par
  rôle ; tableau mobile.

## 11. Décisions (confirmées par @eleodas01 le 2026-08-01)

- ✅ **Portée** : **par équipe** (primaire) + **lecture cross-équipe réservée aux
  leads**. **Pas** de tableau global unique.
- ✅ **Auto-carte au spawn** : **OUI** — `team.spawn_worker` crée automatiquement une
  carte assignée au worker, *« afin que l'utilisateur sache toujours les tâches en
  cours »*. Hook dans `Orchestrator.addWorker` (index.ts:~823, après persistance de
  la session). Titre dérivé du rôle/nom/prompt du worker ; statut initial `todo`.
- ✅ **Autorité web** : **lecture seule**. Le web est un tableau de bord
  d'observabilité ; les agents sont seuls à muter l'état via MCP `board.*`. **Seule
  écriture opérateur : supprimer une carte** (nettoyage, surtout les orphelines).
- ✅ **Carte orpheline** (assigné disparu après `kill_worker`+`spawn` ⇒ nouvelle
  `session.id`) : **gardée + flaggée** (`orphaned_at`), **conservée un temps limité**
  puis purgée par un **janitor TTL** (délai configurable, défaut à fixer — p.ex. 7 j) ;
  **l'utilisateur peut l'effacer** manuellement (DELETE web). Pas d'auto-réassignation.
- ✅ **Tableau vs mailbox** : le tableau **complète**, ne remplace pas, le passage de
  messages. Message = signal transitoire ; carte = état durable. Garder les deux.
- ✅ **Stockage** : **SQLite seul** (pas de vault markdown) — état opérationnel, pas
  savoir portable. Couvert par le backup à chaud. Export markdown éventuel = Phase 5.
- ✅ **Permissions MCP** : create/comment/link = tous ; update/move/close = assigné ou
  lead ; assign/delete/cross-équipe = lead.
- **Reste à trancher pendant l'implémentation** : le délai exact du TTL orphelines ;
  le format du titre auto-généré des cartes de spawn.
