# Crons des agents — écran dédié, pause/édition/création, crons script

Plan de la fonctionnalité. Maquettes (Claude Design, canvas 3 planches) :
<https://claude.ai/code/artifact/afe65511-0709-4174-9432-f013dfcd1d1d>

Statut : **Lots 1-5 livrés (2026-08-31) — fonctionnalité complète.** Serveur
(entité crons, scheduler généralisé, migration de la cadence par rôle, runner
script + historique), UI (écran `#/crons`, élément par agent, mobile), exemple
(`examples/crons/`) et docs opérateur. Plan passé par une validation
adversariale (3 relecteurs : serveur/données, UI, sécurité+design) ; les
corrections sont intégrées ci-dessous.

---

## 1. Constat (état actuel)

Le scheduling existe déjà mais sous une forme minimale : **une cadence par
rôle**, portée par deux colonnes du rôle.

- Modèle : `role.schedule` (cron 5 champs) + `role.scheduleMessage`
  (template `{{fire}}` / `{{now}}` / `{{window:Nh|Nm}}`) —
  `packages/server/src/modules/roles/index.ts:245-258`, colonnes ajoutées par
  migration additive (`packages/server/src/modules/db/index.ts:880-882`).
- Scheduler : `RoleScheduler` in-process (croner),
  `packages/server/src/modules/schedule/index.ts`. `reload()` reconstruit tout
  le jeu de crons au boot et après chaque mutation de rôle (hook
  `onRolesChanged`). `fireRole()` rend le template et le livre via
  `sendMessage(..., 'system', lead.id, ..., { skipRecipientCheck })` au lead
  de **chaque instance vivante** du rôle.
- UI : `CadenceSection` dans `RolesPage.tsx:883-982`, et les champs cadence du
  `RoleDialog` (atteignable depuis la modale NEW TEAM via « + create new
  role… », `NewOrchestratorDialog.tsx:496-509`). Rien d'autre.

Manques par rapport au besoin :

| Besoin | État |
|---|---|
| Liste dédiée des crons | absent (ni écran, ni route `/crons`) |
| Pause / reprise | absent (seule option : effacer la cadence) |
| Plusieurs crons par rôle | impossible (1 colonne) |
| Prochain tir visible | absent (calculé seulement dans les logs `schedule.reload`) |
| Tir manuel | absent (`fireRole` public mais aucun appelant) |
| Historique des ticks | absent |
| Cron → script (réveil conditionnel) | absent |

## 2. Cible

Une entité **cron de première classe** : N crons, chacun ciblant un **rôle**
(fan-out vers les leads des instances vivantes — sémantique actuelle
conservée), avec deux actions possibles :

- **`message`** : comportement actuel — livrer un template dans l'inbox du
  lead à chaque tick.
- **`script`** : exécuter un script local (ex. `jira_dev.py`) ; le script
  décide s'il faut réveiller l'agent et avec quel message.

Côté UI : un écran dédié `#/crons` (même pattern que ROLES) + un élément par
agent dans le panneau droit. Actions : créer, modifier, mettre en
pause/reprendre, supprimer, exécuter maintenant.

### 2.1 Décisions d'architecture

1. **Généralisation, pas duplication.** Le `RoleScheduler` devient un
   `CronScheduler` armé depuis la nouvelle table `crons` ; il n'y a **qu'un
   seul** système de cadence à la fin. Les colonnes `roles.schedule` /
   `schedule_message` sont migrées au boot (§Lot 1) et **neutralisées dans
   `RoleStore` lui-même** (écriture forcée à NULL dans `create`/`update`) —
   le 400 de route ne suffit pas : la façade plugin transmet le `RoleInit`
   brut (`plugins/api.ts:472-486`) et ré-alimenterait la migration à chaque
   boot sinon.
2. **Cible = rôle, pas session.** Les sessions sont éphémères ; le rôle est
   l'identité durable (déjà le modèle du scheduler actuel). « Les crons d'un
   agent » dans l'UI = les crons du rôle de l'équipe sélectionnée.
3. **Exécution script in-container, jamais host-exec.** `execFile`/`spawn`
   sans shell, env explicite **minimal** (rupture assumée avec
   `graphify.ts:116-121` et `install-core/fetch.ts:51-60` qui étalent
   `...process.env` : on garde les tokens serveur et clés provider hors d'un
   script opérateur), timeout dur, sortie bornée, ne throw jamais. Fonctionne
   en transport `local` comme `ssh` (contrairement à `api.host.*`). Le
   conteneur a `python3` (3.11), `uv`, `node` (pas de pip) — deps Python via
   `uv run` ou venv sous `/data`.
4. **Contrat de sortie du script** : dernière ligne non vide de stdout, JSON
   `{"wake": true, "message": "..."}` → message livré au lead de chaque
   instance vivante du rôle ; `{"wake": false}` ou exit ≠ 0 → aucun réveil,
   run journalisé. Pas d'instance vivante → `outcome='noop'` (pas de
   redémarrage d'équipe en v1 — §6.1).
5. **Une seule primitive de livraison pour les deux actions** :
   `from = "cron:<name>"`, boucle sur les instances avec try/catch par
   orchestrateur (patron `broadcastToLeadsFromExternal`,
   `messaging.ts:570-588`), échec par instance → compté, jamais de throw.
   Deux prérequis découverts en relecture, à livrer **dans le même commit** :
   - `mailbox-persistence.ts:239-245` (`isSenderTerminal`) n'exempte que
     `system`/`human`/`plugin:` — sans l'exemption `cron:`, tout message de
     cron non lu est **supprimé au redémarrage** (rejeu du bug « plan §J2
     fix B-1 » documenté dans ce fichier).
   - côté web, `mailBubble.ts:43` (`SYSTEM_FROM_VALUES`) et
     `pulses.ts:29-49` (`deriveKind`, qui traite déjà `plugin:`) doivent
     apprendre le préfixe `cron:`, sinon bulle mal classée et pulse perdue
     (`positions['cron:x']` inexistant).
6. **Historique borné en DB** (`cron_runs`, 20 derniers par cron), alimenté
   pour **toutes** les actions — c'est ce qui rend les crons débogables
   depuis l'UI (LAST RUNS).
7. **DDL dans le store, pas dans `schema.sql`** — patron
   `approvals/store.ts:211-254` : `tsc` ne copie pas les `.sql` dans l'image,
   et l'`INLINE_SCHEMA` de `db/index.ts:1575-1589` a déjà divergé de
   `schema.sql` sur les colonnes schedule. Et comme **tous** les stores
   propriétaires de DDL (`index.ts:188-586`), instanciation sous `try/catch`
   avec mode dégradé (crons désactivés ce boot) — un constructeur qui throw
   s'exécute avant le listener HTTP.

### 2.2 Modèle de données

```sql
CREATE TABLE IF NOT EXISTS crons (
  id            TEXT PRIMARY KEY,          -- cron_<8 hex> ; migration : cron_role_<roleId> (déterministe)
  name          TEXT NOT NULL UNIQUE,      -- slug affichable
  role_id       TEXT NOT NULL,             -- cible (rôle supprimé => cron orphelin, §6.2)
  schedule      TEXT NOT NULL,             -- cron 5 champs, TZ = SWARM_OS_SCHEDULE_TZ
  action        TEXT NOT NULL,             -- 'message' | 'script'
  message       TEXT,                      -- action=message : template (tokens existants)
  script_path   TEXT,                      -- action=script : voir §2.5
  script_args   TEXT,                      -- JSON array de strings
  interpreter   TEXT,                      -- 'python3' | 'bash' | 'node' (pas de fallback +x, §2.5)
  timeout_ms    INTEGER,                   -- défaut 60_000, plafond 240_000 (< requestTimeout Node)
  paused        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crons_role ON crons(role_id);
CREATE TABLE IF NOT EXISTS cron_runs (
  id             TEXT PRIMARY KEY,
  cron_id        TEXT NOT NULL REFERENCES crons(id) ON DELETE CASCADE,
  fired_at       TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- 'tick' | 'manual'
  outcome        TEXT NOT NULL,            -- 'wake' | 'skip' | 'noop' | 'overlap' | 'error'
  exit_code      INTEGER,
  duration_ms    INTEGER,
  output_excerpt TEXT,                     -- stdout/stderr tronqués (2 000 octets)
  delivered_to   TEXT                      -- JSON array d'orchestrator ids
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_cron ON cron_runs(cron_id, fired_at DESC);
-- tri LAST RUNS : ORDER BY fired_at DESC, rowid DESC (tie-break, patron approvals/store.ts:279-283)
```

Invariants (validés par la route ET le store) : `action=message` ⇒ `message`
non nul ; `action=script` ⇒ `script_path` + `interpreter` non nuls ;
`schedule` validé par `isValidCron` **et restreint à 5 champs** (croner
accepte les expressions à la seconde — refusées : un script à la seconde est
une fork-bomb bornée par le seul garde d'overlap). `name` UNIQUE (le
`from = "cron:<name>"` doit être discriminant).

### 2.3 API HTTP

Nouveau routeur `packages/server/src/http/routes/crons.ts` (patron
`routes/backup.ts`), monté **après** `app.use(auth)` dans `http/main.ts` —
protégé par `X-Auth-Token`, soumis au `bootGate` 503.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/crons` | liste + `nextRun` + `lastRun` + flag global `schedulingEnabled` |
| POST | `/crons` | création |
| GET | `/crons/:id` | détail |
| PATCH | `/crons/:id` | édition partielle, dont `{paused}` |
| DELETE | `/crons/:id` | suppression (runs en cascade FK) |
| POST | `/crons/:id/fire` | tir manuel → **202 + `{runId}`** (jamais synchrone : un run peut durer plus que le `requestTimeout` Node de 300 s) ; 409 si un run est en vol |
| GET | `/crons/:id/runs` | historique (20) |

- `nextRun` est lu sur le `Cron` **déjà armé** par le scheduler
  (`cron.nextRun()`, comme `schedule/index.ts:111`) — jamais recalculé par un
  `new Cron(expr)` nu, qui évaluerait en TZ locale du process au lieu de
  `SWARM_OS_SCHEDULE_TZ`. Cron en pause ou scheduling désactivé →
  `nextRun: null` (l'UI ne doit pas afficher un tir qui n'arrivera pas).
- Tir manuel : **autorisé** cron en pause et scheduling désactivé (geste
  opérateur explicite — c'est déjà le comportement de fait de `fireRole`,
  non gardé par `_enabled`).
- Chaque mutation appelle `scheduler.reload()` (même patron que
  `onRolesChanged`, déclenché par la route).
- `GET /roles` renvoie en plus un `cronCount` par rôle (jointure serveur) —
  c'est ce qui alimente le badge de `RolesPage` sans nouveau poll (§2.4).

### 2.4 UI

- **Écran `#/crons`** : overlay plein écran, squelette copié de
  `RolesPage.tsx` (`roles-overlay` / `roles-side` / `roles-main`, classes
  réutilisées comme le font `SkillsPage` et `PluginsPage`). Liste à gauche
  (nom, pills `SCRIPT|MESSAGE`, `→ RÔLE`, expression, `PAUSED`, prochain
  tir), détail à droite en sections inline (`SCHEDULE`, `ACTION`,
  `LAST RUNS`). `RUN NOW` / `PAUSE` près de l'en-tête du détail ; `DELETE`
  **seul en bas** (convention `RolesPage.tsx:420-427`), via `ConfirmModal`.
  Garde d'édition `tryClose`/`trySelect` (convention des overlays,
  `RolesPage.tsx:143-159`). Bandeau « SCHEDULING DISABLED » quand
  `schedulingEnabled: false`.
- **Création via modale `.modal.wide`** (bascule seg-radio MESSAGE ↔ SCRIPT).
  Choix justifié : contrairement à ROLES (POST d'un item vierge puis édition
  inline), un cron ne peut pas naître vide — trois champs NOT NULL à la
  naissance ; le précédent modale existe (`SkillImportModal`, INSTALL de
  `PluginsPage`). Défaut connu reproduit et assumé : ⌘K passe au-dessus des
  modales rendues dans un overlay (même schéma que `SkillImportModal`).
- **Deep-link** : forme **path**, pas de query — le routeur hash compare par
  égalité stricte et réécrirait `#/crons?role=x` en `#/` (`App.tsx:39-75`).
  Donc : `#/crons` et `#/crons/<cronId>` (regex `[a-zA-Z0-9_-]+` — le tiret
  bas des ids `cron_*` n'est pas couvert par la classe de la route
  orchestrators). Le filtre par rôle passe par le callback
  `onOpenCrons(roleId?)` (état du composant), pas par l'URL.
- **Branchement route — liste complète** (la relecture a montré que le
  `switch` de TopBar ne casse PAS la compilation : les handlers y sont
  optionnels, `TopBar.tsx:58-75` — un câblage oublié = no-op silencieux) :
  1. union `Route` + `parseHash` + `setHashRoute` (`App.tsx:17-75`) ;
  2. montage `<CronsPage open=…>` + prop vers le provider (`App.tsx:117-199`) ;
  3. `SwarmController` : Props, destructuring, callback résolu, interface
     `SwarmControllerApi`, objet `value` (5 éditions, `SwarmController.tsx`) ;
  4. `TopBar` : Props + destructuring + `case 'crons'` ;
  5. `DesktopShell.tsx:27-54` : `onOpenCrons={…}` (le seul call-site TopBar) ;
  6. `CommandLauncher` : `LauncherActionId` + item dans le groupe WORKSPACE,
     placé **en fin de groupe** (après `ide`) pour ne pas casser le test
     d'ordre ↓↓+↵ ;
  7. `CommandLauncher.test.tsx:235-245` : liste d'ids en dur à mettre à jour ;
  8. icône horloge à ajouter à `icons.tsx`.
- **Élément par agent (RightPanel)** — revu après relecture design :
  - dans `pr-head`, une **ligne unique non wrappante**
    `CRONS :: 3 · NEXT 14:15  [ALL →]`, affichée **seulement si
    `isLead && roleId != null`** (les crons ciblent le lead ; un panneau
    worker n'affiche rien ; `role` peut être null pour une équipe à rôle
    libre, `rightPanelAdapters.ts:26-39`). Pas de puces par cron : le
    `pr-head` n'est pas scrollable et la place est comptée (`panel-right`
    400 px, `overflow: hidden`).
  - la **liste détaillée** vit dans l'onglet CONFIG : nouvelle `cfg-section`
    `CRONS` (patron CONNECTORS, `ConfigTab.tsx:111-134`) — un rang par cron
    (nom, expression, prochain tir, PAUSED), clic → `#/crons/<id>`.
  - plomberie : `roleId` ajouté à `buildRightPanelTeam` (donnée statique,
    légitime dans l'adaptateur pur + son test) ; les crons passent en **prop
    séparée** depuis `SwarmController` — jamais fondus dans le memo
    `selectedTeam`, sinon re-render du panneau entier à chaque poll.
- **Data** : `api/client.ts` (types `CronView`, `CronRunView` + méthodes) et
  `hooks/useCrons.ts` avec **garde `enabled`** — calqué sur
  `useApprovals`/`useBoard`, PAS sur `useRoles` (qui polle inconditionnellement
  et est déjà instancié 3× dans des composants toujours montés ; cf. le
  commentaire de `MonitoringPage.tsx:107-110`). `enabled = open` dans
  `CronsPage`, `enabled = panelOpen && isLead` dans le controller. Mutations
  non optimistes (`await refresh()`, comme le reste du code).
- **Validation client** : `croner` ajouté aux deps de `packages/web` — même
  moteur que le serveur (`isValidCron`), et permet d'afficher les prochains
  tirs dans la modale de création.
- **Badge rôles** : `RolesPage` remplace la pill `🕐 {r.schedule}` par
  `🕐 N CRONS` dérivée du `cronCount` de `GET /roles` (zéro fetch neuf) ;
  clic → écran filtré, avec `stopPropagation` (la pill vit dans un
  `role-item` cliquable).
- **Mobile** : `useShellMode()` + `mobileView 'list'|'detail'` dans
  `CronsPage` (CSS `m-roles` déjà générique). Le launcher **n'existe pas en
  mobile** et le dock est plein (6) : l'accès est une **link-row CRONS dans
  la StatsSheet** — le précédent exact de MONITORING
  (`StatsSheet.tsx:49-91`), livrée au Lot 3 (sinon l'écran est injoignable
  sur téléphone). Rangée CRONS de l'`AgentSheet` au Lot 5, qui doit appeler
  `closeRightPanel()` avant de naviguer (la feuille est z-index 81, l'overlay
  60).
- **Langue** : labels structurels EN ALL CAPS mono (convention), prose des
  erreurs/aides en français (convention des validations existantes, ex.
  `RolesPage.tsx:910`).
- **CSS neuf** (assumé, écrit à la main dans `desktop-theme.css` malgré le
  rituel prototype-d'abord de son en-tête — précédent `.appr-*`) :
  `.pr-crons`, variantes `.tag-pill.script`/`.paused`.
- Navigation depuis le panneau : ouvrir `#/crons` **désélectionne l'agent**
  (`SwarmController.tsx:341-362` + `onClose` câblés sur `{kind:'list'}`) —
  assumé en v1, documenté ici plutôt que d'introduire une pile de routes.

### 2.5 Runner script (action=script)

`packages/server/src/modules/crons/runner.ts` :

- **Chemins** : helper `resolveUnderRoots(p, roots)` extrait de
  `validateCwdUnderWorkspace` (`http/validation.ts:27-58` — realpath des deux
  côtés, rejet des symlinks sortants), racines = `workspaceRoot` et
  `dataDir` ; vérifié à la création ET à chaque exécution, et **l'argv
  utilise le realpath retourné** (sinon la revérification est décorative —
  TOCTOU sur le lien). En transport `ssh`, le champ accepte un chemin
  workspace-relatif (`normalizeWorkspaceRelativeCwd`,
  `http/validation.ts:13-19`) et l'aide précise que c'est le chemin
  **conteneur** (les agents affichent des chemins hôte).
- **Interpréteur explicite** (colonne `interpreter`, allowlist
  `python3|bash|node`) — pas de fallback « fichier exécutable » : les bits de
  mode d'un bind hôte ou d'un fichier créé dans le conteneur (umask 0644,
  uid 1000) rendent le `+x` non fiable, et l'UI n'offre pas de chmod. `bash`
  ajouté à la liste apt du Dockerfile (il n'y est aujourd'hui que par
  héritage Debian).
- **Lancement** : `spawn` `detached: true` (groupe de processus), argv fixe
  `[interpreter, realpath, ...args]`, `cwd` = dossier du script, timer maison
  → `process.kill(-pid, 'SIGKILL')` au timeout — le `timeout` d'`execFile`
  n'envoie qu'un SIGTERM au seul enfant direct, or `uv run` spawn un
  petit-fils (patron `setsid` de `ssh-exec.ts:383-411`). `maxBuffer`
  32 MiB (aligné sur `graphify.ts:33` et `fetch.ts:64`), dépassement
  distingué du timeout via `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` **avant** le
  prédicat `killed/SIGTERM` (piège présent dans `graphify.ts:131`). `ENOENT`
  → « interpreter not found », `EACCES` → « script is not executable »
  (mappés avant troncature de l'excerpt). Ne throw jamais.
- **Env minimal explicite** : `HOME`, `PATH` (+`$HOME/.local/bin`),
  `LANG`/`LC_ALL=C.UTF-8`, `TZ=<scheduleTimezone>`, passthrough
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`,
  `UV_CACHE_DIR=<dataDir>/crons/uv-cache` (sinon `uv run --with` retélécharge
  à chaque tick — le cache par défaut est dans la couche éphémère), et
  `SWARM_OS_CRON_ID` / `SWARM_OS_CRON_NAME` / `SWARM_OS_FIRE` (ISO). Pas de
  token serveur, pas de clés provider.
- **Parsing** : dernière ligne non vide de stdout, JSON `{wake, message?}`.
  `wake:true` sans `message` → `"[cron:<name>] wake requested"`. JSON
  invalide → `outcome='error'`.
- **Anti-chevauchement** : `Set<cronId>` **au niveau du scheduler**, jamais
  touché par `reload()` (un PATCH pendant un run long ne doit pas réarmer un
  second run), libéré en `finally`, partagé par le tick ET le fire manuel
  (409 côté route) ; tick sauté → run `outcome='overlap'` enregistré (un cron
  systématiquement plus lent que sa cadence doit se voir dans LAST RUNS).
- **Shutdown** : registre des enfants en vol ; `stop()` tue les pgid et écrit
  `outcome='error'` (raison `shutdown`) **avant** `db.close()` — sans ça, un
  SIGTERM laisse un orphelin et aucun run en base.
- **Livraison** : primitive unique §2.1.5.

Sécurité, dit clairement : cette feature donne à quiconque possède le
`X-Auth-Token` l'exécution de code arbitraire **dans le conteneur** — le
niveau de pouvoir que ce token donne déjà (créer une équipe
`bypassPermissions` sur `/workspace` exécute aussi du code arbitraire). Point
supplémentaire relevé en relecture : un **agent** (qui écrit `/workspace`)
peut modifier le fichier d'un cron existant et obtenir une exécution
récurrente hors supervision de session (ni budget, ni approvals). Assumé en
v1 et documenté ; recommandation opérateur : poser les scripts sensibles sous
`/data/crons/` (non accessible aux agents). Empreinte SHA-256 épinglée à la
création : suivi possible, hors v1 (§6.5).

---

## 3. Lots

### Lot 0 — Maquettes + plan *(livré avec ce document)*

Canvas Claude Design (3 planches : écran dédié, panneau agent, dialog de
création) + ce plan.

### Lot 1 — Serveur : entité crons + scheduler généralisé *(livré)*

- `modules/crons/store.ts` : DDL §2.2 auto-créé (patron `approvals/store.ts`),
  CRUD, `listRuns` (tri `fired_at DESC, rowid DESC`), `recordRun` + rétention
  (DELETE au-delà de 20 par cron). Instanciation sous try/catch avec mode
  dégradé (patron `index.ts:188-586`).
- **Migration** au boot, dans le store, **en transaction better-sqlite3**
  (`db.transaction`, comme `approvals/store.ts:492`) : pour chaque rôle avec
  `schedule` non nul → `INSERT OR IGNORE` d'un cron à **id déterministe**
  `cron_role_<roleId>` (rejouable après crash entre INSERT et UPDATE),
  `name = <label>-cadence` + suffixe roleId en cas de collision (les labels
  de rôles ne sont pas uniques), `action='message'` ; puis SQL brut
  `UPDATE roles SET schedule=NULL, schedule_message=NULL` (pas
  `RoleStore.update` — ne pas toucher `updated_at`). Migration dans son
  propre try/catch.
- **Neutralisation** : `RoleStore.create/update` forcent
  `schedule`/`scheduleMessage` à NULL (§2.1.1).
- `modules/crons/scheduler.ts` : `CronScheduler` — reprend le
  `RoleScheduler` (armement croner par cron non pausé, `reload()` wholesale,
  timezone, `enabled`), + garde d'overlap §2.5, + `fire(cronId, kind)`.
  **Armé après la bascule du `bootGate`** (aujourd'hui `start()` est appelé à
  `index.ts:548`, bien avant la fin de l'auto-resume — avec `cron_runs`, les
  ticks de cette fenêtre écriraient des `noop` persistants). `template.ts`
  déplacé dans `crons/` ; `modules/schedule/` supprimé (importeurs vérifiés :
  `index.ts:23`, `routes/roles.ts:14`, ses propres tests — rien d'autre).
- Routes `routes/crons.ts` (§2.3) + câblage `index.ts` (start/stop, reload) +
  `http/main.ts` (paramètres de `createApp`/`startServer`) + mise à jour de
  `test/integration/helpers.ts:249-262` (sinon 404 dans les tests
  d'intégration).
- Routes roles : 400 « moved to /crons » **seulement sur valeur non nulle**
  de `schedule`/`scheduleMessage` — les trois call-sites web existants
  postent toujours les clés (à `null`) : `duplicateRole`
  (`RolesPage.tsx:202-203`), `RoleDialog.onSubmit`, `CadenceSection.save`.
  Le hook `onRolesChanged` est retiré (il n'existait que pour réarmer le
  scheduler de rôles ; contrat `PluginHost` mis à jour).
- **Retrait UI cadence dans le même lot** (sinon master est cassé entre
  deux lots) : `CadenceSection` + champs cadence de `RoleDialog` +
  `duplicateRole` (v1 : la duplication de rôle ne copie pas les crons —
  documenté dans l'UI, cf. §5) ; types `api/client.ts:361-365` ; fixtures
  `RoleDialog.test.tsx:33-34` ; tests d'intégration
  `roles.test.ts:138-190` (réécrits : les 4 assertions portent sur le
  comportement supprimé).
- Exemption `cron:` dans `mailbox-persistence.ts` (§2.1.5) — même commit que
  le changement de `from`.
- Tests : reprise de `schedule/index.test.ts` + `template.test.ts` sur le
  nouveau module ; intégration `crons.test.ts` (CRUD, validation — dont rejet
  6 champs —, pause qui désarme + `nextRun: null`, fire manuel 202/409,
  migration depuis rôle legacy — dont rejeu après crash simulé, collision de
  labels, et re-migration impossible après neutralisation).

### Lot 2 — Runner script + historique *(livré)*

- `modules/crons/runner.ts` (§2.5) + branchement dans `fire()` +
  `cron_runs` alimenté pour toutes les actions.
- Dockerfile : `bash` épinglé ; `mkdir` de `<dataDir>/crons/uv-cache` géré au
  premier run.
- Tests : faux scripts (wake, skip, exit≠0, timeout avec petit-fils qui
  survit à SIGTERM, JSON invalide, stdout > maxBuffer distingué du timeout,
  ENOENT/EACCES, chemin hors allowlist, symlink sortant), overlap
  (tick+manuel), shutdown avec run en vol, excerpt tronqué.

### Lot 3 — UI : écran `#/crons` *(livré)*

- `api/client.ts` (types + 7 méthodes), `hooks/useCrons.ts` (garde
  `enabled`), `croner` en dépendance web.
- Routing : les 8 points de §2.4. Deep-link `#/crons/<cronId>`.
- `components/CronsPage.tsx` : liste + détail sections inline +
  `tryClose`/`trySelect` + modale de création + `ConfirmModal` (delete) +
  bandeau scheduling désactivé + support mobile `m-roles` + **link-row CRONS
  dans `StatsSheet`** (accès mobile).
- Classification web du `from` `cron:` (`mailBubble.ts`, `pulses.ts`).
- CSS : variantes `.tag-pill.script`/`.paused`.
- Tests : `CronsPage.test.tsx` (patron `SkillsPage.test.tsx` — rendu liste,
  empty state, back ; « après PATCH pause, la liste rafraîchie montre
  PAUSED » — non optimiste ; validation cron côté client avant POST via
  croner) + mise à jour `CommandLauncher.test.tsx`.

### Lot 4 — UI : élément par agent (RightPanel) *(livré)*

- `roleId` dans `buildRightPanelTeam` (+ test adaptateur) ; crons du rôle en
  prop séparée depuis `SwarmController` (`useCrons` gaté
  `panelOpen && isLead`).
- Ligne `pr-crons` (unique, non wrappante, lead-only) dans `pr-head` ;
  section `CRONS` dans `ConfigTab` (patron CONNECTORS).
- CSS `.pr-crons`.
- Consoles : rien à faire de plus (la classification `cron:` est faite au
  Lot 3).

### Lot 5 — Mobile, exemple, docs *(livré)*

- `AgentSheet.tsx` : rangée CRONS (préfixe `m-as-`), `closeRightPanel()`
  avant navigation.
- `examples/crons/jira_dev.py` : exemple complet du contrat (env
  `SWARM_OS_*`, token JIRA lu depuis un fichier sous `/data`, sortie
  `{wake, message}`), README court (`uv run --with requests`, cache §2.5).
- Docs : section « Crons » dans `docs/deploy/usage.en.md` + `usage.fr.md`
  (remplace « Scheduler (cron per role) ») ; note de migration dans le
  changelog ; balayage des références restantes à `modules/schedule`
  (`docs/auto-amelioration.md:74`, commentaires `schema.sql:50-52`,
  `db/index.ts:880`, `roles/index.ts:246-247`).

---

## 4. Ce qui ne change pas

- La sémantique de livraison message (template, tokens, fan-out vers les
  leads vivants, idempotence downstream par `{{fire}}`) — la seule différence
  observable est le `from` (`cron:<name>` au lieu de `system`), traité §2.1.5.
- `SWARM_OS_SCHEDULE_ENABLED` / `SWARM_OS_SCHEDULE_TZ` (mêmes noms, mêmes
  défauts — champs simples de `Config`, `config.ts:753-754`).
- La capacité plugin `api.schedule.cron` (croner indépendant,
  `plugins/api.ts:314`) — orthogonale, non touchée.

## 5. Compat / ruptures assumées

- `POST/PATCH /roles` avec `schedule`/`scheduleMessage` **non nuls** → 400
  « moved to /crons » (les clés à `null` restent acceptées — les clients
  existants les envoient toujours).
- `plugin-sdk` : `Role.schedule`/`scheduleMessage` marqués `@deprecated`
  (lus à `null`, écritures neutralisées par le store). Suivi possible :
  façade `api.crons.*`.
- `RolesPage.CadenceSection` et champs cadence de `RoleDialog` retirés
  (Lot 1) ; badge `🕐 N CRONS` via `cronCount` de `GET /roles`.
- La duplication de rôle ne copie pas les crons (documenté dans l'UI).

## 6. Points ouverts (tranchés en v1, réouvrables)

1. **Réveil d'une équipe éteinte** : v1 = `noop` journalisé. Option
   `wake_policy: 'if-running' | 'restart'` en suivi
   (`Spawner.restartOrchestrator` existe déjà).
2. **Rôle supprimé** : cron orphelin → tick `noop` + badge rouge dans l'UI
   (pas de cascade delete de config opérateur).
3. **Secrets des scripts** (token JIRA…) : v1 = fichier sous `/data` lu par
   le script. Suivi possible : `env_passthrough` par cron (allowlist de noms
   de variables) ou intégration au store de connecteurs.
4. **TZ** : une seule TZ serveur, pas de TZ par cron.
5. **Intégrité des scripts** : pas d'épinglage SHA-256 en v1 (risque agent →
   §2.5 sécurité) ; le patron existe (`assertInstalledScriptMatches`,
   `updates/runner.ts:771-781`) si le besoin se confirme.
6. **Sélection perdue en naviguant panneau → écran crons** : assumé v1
   (§2.4) ; une pile de routes serait le vrai fix.
