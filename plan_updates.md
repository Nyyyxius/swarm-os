# Système de mise à jour automatique — swarm-os

## Context

swarm-os tourne 24/7 dans un conteneur Docker et n'a aujourd'hui **aucune
conscience de sa propre version ni de l'existence d'une version plus récente**.
La mise à jour est manuelle et hors-produit : le mainteneur pousse un tag
`vX.Y.Z` → GHCR publie `:X.Y.Z` + `:latest` → l'opérateur va sur l'hôte et
relance `./install.sh` (`install.sh:77` `docker pull`, `:86` `compose up -d`),
documenté dans `docs/deploy/install.en.md:152-157`. Rien dans l'UI ne signale
qu'une version existe, ne montre ce qu'elle change, ni ne permet de l'appliquer.

Deux dettes bloquent toute comparaison de version :

1. **La version affichée est fausse.** Codée en dur à `config.ts:655`
   (`'0.6.0-phase6'`) alors que la racine `package.json:3` dit `0.5.0`. Les
   commits `Release:` ne touchent jamais `config.ts`. L'UI (`TopBar.tsx:83`,
   `SettingsDrawer.tsx:202`) affiche `0.6.0-phase6` depuis la Phase 6.
2. **L'état publié ≠ l'état local.** `origin` ne connaît que `v0.1.0`→`v0.3.0` ;
   `v0.4.0`/`v0.5.0` sont des tags **locaux**, `master` est **9 commits en
   avance**, et le repo n'a **aucune GitHub Release**. GHCR `:latest` est encore
   en 0.3.0. La détection ne servira à rien tant que la release n'est pas poussée.

Objectif : un indicateur dans l'UI dès qu'une version (système ou plugin) est
disponible, les nouveautés lisibles **avant** d'installer, et une application en
un clic — immédiate ou planifiée — sans jamais surprendre une équipe au travail.

## Décisions

| Sujet | Choix |
|---|---|
| Périmètre v1 | Complet : détection + indicateur + notes + application + planification |
| Exécution hôte | Job SSH **détaché** via `spawnHostJob` (`ssh-exec.ts:483`) |
| **Application** | **Réécriture de la ligne `SWARM_OS_IMAGE=` du `.env` du déploiement**, puis `compose --env-file … up -d`. **Pas de retag** (voir §D.2) |
| Notes de version | GitHub Releases, PAT via `SWARM_OS_GITHUB_TOKEN` (env uniquement) |
| Avertissement | **Obligatoire**, ≥120 s (défaut 300), armé sur la frontière d'idle de chaque lead, deadline globale, on procède à l'échéance |
| Échec | Rollback = restauration de la ligne `.env` d'origine (durable, survit à un reboot) |
| Plugins | Même surface que l'existant (`PluginsPage`), MAJ groupée |

### Éligibilité — aucun déploiement ne qualifie aujourd'hui

`canSelfUpdate` n'est **pas** un booléen mais une raison, chacune avec son
message « voici la seule chose à changer » :

`ok` · `transport_not_ssh` · `image_not_registry` · `image_not_interpolated` ·
`env_file_not_found` · `env_file_not_writable` · `registry_auth_missing`

| Déploiement | Transport ssh | Image registry | `image:` interpolée | Éligible |
|---|---|---|---|---|
| `swarm-os-test` / `stiix` | oui | non (build local) | non — `swarm-os:latest` en dur | non |
| `swarm-os-trader` | oui | non | non — `swarm-os:0.5.0` en dur | non |
| `examples/docker-compose.dist.yml` | **non** | oui | oui — `${SWARM_OS_IMAGE:-…}` | non |

**On n'ajoute PAS le bloc SSH au compose distribué** : ce serait livrer à tout
tiers un conteneur avec exécution arbitraire sur l'hôte par défaut. Le
non-`ssh` obtient la détection + la commande à copier-coller. Le 1-clic est un
opt-in délibéré (basculer le transport + fournir une clé).

---

# Lot A — une version qui veut dire quelque chose

**Piège vérifié** : le `package.json` embarqué dans l'image est
`server@0.0.0` (`Dockerfile:83` `pnpm --filter=server deploy`, `:157`), pas la
racine `0.5.0`. Un fallback naïf réintroduirait la dérive ailleurs.

- `Dockerfile` : `ARG APP_VERSION` + `ARG GIT_SHA` → `ENV SWARM_OS_VERSION` /
  `SWARM_OS_COMMIT` + labels OCI `org.opencontainers.image.version`/`.revision`.
- `config.ts:655` : `process.env.SWARM_OS_VERSION` en production ; fallback dev
  = lecture explicite de la **racine** `package.json` ; sinon `'dev'`.
- Test anti-dérive comparant à ce **même** fichier racine.
- `release-image.yml` : `build-args: APP_VERSION=${{ steps.meta.outputs.version }}`,
  `GIT_SHA=${{ github.sha }}` ; idem `scripts/push-image.sh:24`.
- Release notes : `softprops/action-gh-release` avec `generate_release_notes: true`
  (pas de CHANGELOG à tenir à la main). ⚠️ le workflow déclare
  `permissions: contents: read` → **passer à `contents: write`**, sinon 403.
- Corriger le commentaire d'en-tête du workflow : il prétend que
  `workflow_dispatch` publie `:latest`, alors que
  `enable=${{ github.ref_type == 'tag' }}` dit le contraire.
- Docs : la release n'est effective qu'après `git push origin master --follow-tags`.

---

# Lot B — détection, sans nouveau moteur

**Le changement en amont qui supprime le problème** : la SPA poll **déjà**
`/info` toutes les 60 s, sans auth (`SwarmController.tsx:442-453`,
`client.ts:404`). On ajoute au payload de `/info` (`http/main.ts:138`) :

```
commit, image, update: { available: boolean, latest: string | null }
```

Conséquence : **pas** de `update_checks`, **pas** de boucle `setInterval`, **pas**
de `POST /updates/check`, **pas** de hook `useUpdates`, **pas** de nouveau kind
WS (qui obligerait à élargir le type publié du SDK — `events.ts:8` **et**
`plugin-sdk/src/index.ts:159` + son `dist/index.d.ts` commité). Servir `/info`
déclenche un rafraîchissement d'arrière-plan *si et seulement si* le verdict en
cache a dépassé son TTL (6 h) — fire-and-forget, jamais bloquant. Un onglet
ouvert est son propre heartbeat ; sans onglet, personne n'a besoin de badge.
`/info` étant public, il n'expose **que** le booléen + le tag ; les diffs, notes
et état de run restent derrière l'auth dans `GET /updates`.

**Sources**

| Composant | Source |
|---|---|
| Système | `GET /repos/luminis1986/swarm-os/releases` + PAT. **Filtrer `draft === false`** et prendre le max via le comparateur maison — la liste est ordonnée par date de création et inclut les brouillons |
| Système (pré-vol) | `docker manifest inspect` sur l'hôte : l'image doit exister ET `docker login ghcr.io` doit être valide → sinon `registry_auth_missing` |
| Plugin `git` | `git ls-remote <url> <ref>` vs le **commit installé** (voir Lot F) |
| Plugin `npm` | `registry.npmjs.org` `dist-tags.latest` vs `plugins.version` |
| Plugin `dir`/`upload` | non vérifiable — « source locale » |

Comparateur semver maison (~20 lignes), pas de dépendance.

**PAT** : `SWARM_OS_GITHUB_TOKEN` dans `.env`, **c'est tout**. Pas de route
d'écriture, pas de masquage, pas de lecture de `~/.docker/config.json` de l'hôte
(scope `read:packages` ≠ `contents:read`, et siphonner le fichier d'un autre
outil est une surprise, pas une fonctionnalité). L'opérateur a déjà créé un PAT
pour `docker pull` (`install.sh:79-80`).

**Ignorer une version** : `dismissedUpdateVersion` dans `instance_settings`
(`schema.sql:131`) ; `available = latest > current && latest !== dismissed`.
Sans ça, l'opérateur qui choisit de rester en 0.5.0 fixe un badge à vie.

---

# Lot C — UI, en étendant l'existant

- **Badge** : un point sur un bouton `tb-action` dans `TopBar.tsx:148-169`, peint
  dans le **même** `setInfo` que le numéro de version voisin (`TopBar.tsx:83`) —
  donc aucun flash. Sur serveur froid le badge est simplement absent puis
  apparaît au tick suivant.
- **Pas de nouvelle page.** Le système va dans le **Settings drawer**, qui
  affiche déjà la version (`SettingsDrawer.tsx:202`), en copiant
  `MaintenanceSection.tsx` (busy/error/lastResult + action 1 clic).
- **Les plugins restent dans `PluginsPage.tsx`**, qui rend déjà
  `v{version} · {sourceKind}` (`:267`) et **a déjà** un bouton Upgrade
  (`:398-407`). On ajoute `latestVersion` + `updateStatus` à `PluginView`
  (`api-types.ts:183-205`) et un point à côté du bouton. Écrire un second écran
  produirait une deuxième surface listant les mêmes plugins avec le même bouton.
- **Notes** : texte préformaté + lien vers la Release. Aucun rendu markdown
  maison (rien n'en fait dans `packages/web/src` aujourd'hui, et rendre du
  markdown distant est une surface d'injection pour un écran lu une fois par mois).
- Client REST : méthodes ajoutées à l'objet `api` (`client.ts:402`).

---

# Lot D — application

## D.1 Machine à états

```
(aucune ligne non terminale = idle)
   scheduled → warning_teams → preflight → applying → verifying → success
        │            │             │                      ├→ rolled_back
     cancelled   cancelled      refused                   ├→ failed
                             (rien touché)                └→ abandoned
```

`refused` = rien n'a été touché (transport, labels, `.env` introuvable, image non
interpolée, `/data` divergent, registry non authentifié). `abandoned` = run non
terminé + heartbeat périmé + pas de `result.json` (hôte redémarré en plein run).

## D.2 Pourquoi le `.env` et pas le retag

Scénario vérifié sur cette machine : pull `:0.6.0` → retag sur `swarm-os:latest`
→ recreate de `test` → health KO → le rollback veut `swarm-os-rollback:$RUN_ID`,
jamais créé car l'image en cours (`sha256:4aad81d1b90b…`) est **déjà prunée**
(`docker image inspect` → « No such image ») → `swarm-os:latest` reste sur la
0.6.0 cassée → **`swarm-os-stiix` partage ce tag littéral**
(`docker-compose.stiix.yml:21`) et casse à son prochain `up -d`. Une MAJ ratée en
test sabote une prod non impliquée. Second disqualifiant : après un retag, tag et
contenu se contredisent **définitivement** — on bâtirait une comparaison de
version sur un mécanisme dont le métier est de rendre les références fausses.

La route `.env` résout les trois structurellement : le tag résolu **est** celui
qu'on a écrit (assertable en relisant `docker compose config`), les `.env` sont
par déploiement (stiix hors d'atteinte), et le rollback restaure une **chaîne**
et non un objet image local — donc le prune est sans effet et le retour arrière
**survit à un reboot** au lieu de re-appliquer silencieusement la version cassée.

**Contreparties, assumées** : l'`image:` doit être une interpolation `${VAR}`
pleine et `VAR` doit être réellement **présente** dans un fichier localisable et
inscriptible — un `${SWARM_OS_IMAGE:-ghcr.io/…:latest}` dont la variable est
absente retomberait silencieusement sur `:latest`. Localiser le fichier
(`<working_dir>/.env` puis `<working_dir>/../.env`), **jamais deviner**, refuser
sinon, et **toujours** invoquer compose avec `--env-file <chemin résolu>` (ce qui
supprime au passage toute divergence d'environnement entre la passe d'application
et celle de rollback). Écriture **atomique et chirurgicale** : seule la ligne
`SWARM_OS_IMAGE=` est réécrite (temp + `rename(2)` dans le même répertoire),
tout le reste — commentaires, ordre — préservé, `.bak` laissé à côté, contenu
d'origine archivé en base pour un rollback à l'octet près. Le **diff littéral**
est affiché dans l'UI avant la première application.

## D.3 Script hôte

Livré dans l'image (`scripts/host-update.sh`), copié atomiquement au boot dans
`<dataDir>/updater/host-update.sh` (dir 0700, fichier 0600), invoqué
`bash <chemin>` (pas de bit exec, survit à un `noexec`). Permissions : conteneur
uid 1000 (`Dockerfile:151`) = hôte `ubuntu` uid 1000 — c'est déjà ce sur quoi
repose `spawnHostJob`. Le serveur refuse de lancer si le sha256 sur disque ne
correspond pas à celui embarqué. Sécurité : aucun privilège nouveau, le conteneur
a **déjà** l'exécution arbitraire sur l'hôte via SSH.

Étapes :

1. `flock -w` (jamais bloquant) — une seule MAJ à la fois.
2. Identifier son conteneur : hint `/etc/hostname`, **validé** par
   `Mounts[/data].Source == $HOST_DATA_DIR` ; sinon balayage de `docker ps` sur
   ce critère. Labels compose ; `config_files` peut contenir plusieurs chemins
   séparés par virgule → autant de `-f`. Toujours `--project-name` issu du label,
   **jamais** `docker compose ls` (test et stiix partagent le projet `swarm-os`).
   Pas de labels (`docker run`) ⇒ refus : reconstruire l'argv est lossy.
3. **Jamais `--remove-orphans`** — vérifié en `--dry-run` : compose annonce
   `Found orphan containers ([swarm-os-stiix])`, le flag le **supprimerait**.
4. Préflight : `docker compose --env-file … config --format json` doit résoudre ;
   le `/data` monté doit être **exactement** `$HOST_DATA_DIR` (sinon le nouveau
   conteneur démarrerait sur une base vide) ; refuser un `@sha256:` épinglé.
   Hasher la config résolue pour la re-vérifier identique avant chaque `up`.
5. `docker pull <target>` puis écriture atomique de la ligne `.env`, puis
   **relecture de `compose config`** pour asserter que l'image résolue est
   exactement la cible, octet pour octet.
6. `docker compose --env-file … up -d --no-deps --wait --wait-timeout …`.
   **Jamais `--pull always`.**
7. Vérification : `docker exec <cid> curl 127.0.0.1:<port>/health` jusqu'à
   `boot_complete` (cf. §Plomberie), **≥ 300 s** — sous SSH chaque équipe est
   respawnée avec `resumeStaggerMs` (`config.ts:527`) et un timeout trop court
   déclarerait échouée une bonne MAJ, tuant les équipes une seconde fois.
   « Healthy mais pas `boot_complete` » ⇒ `unknown`/revue manuelle, **jamais** un
   rollback automatique.
8. Échec ⇒ restauration de la ligne `.env` d'origine + `up -d --force-recreate`.
   Codes de sortie distincts : 0 succès / 10 rolled_back / 20 failed / 30 refusé.
9. Chaque étape longue porte son **propre** `timeout` : le `timeout(1)` de
   `hostExec` ne borne que le lanceur de 15 s, pas le job détaché.

## D.4 Observabilité et reprise — fichiers, pas SSH

**Défaut trouvé dans le mécanisme existant** : `hostJobStatus` calcule
`running = !timedOut && code === 0` (`ssh-exec.ts:553-558`), or `hostExec`
**résout** quand ssh échoue à se connecter (code 255, `:227-231`). « Hôte
injoignable » est donc indistinguable de « job mort » — faux au premier sondage
après un recreate, où le mux est froid par construction.

Donc, tout en `fs` sur le bind mount, **zéro SSH** :
- `<runDir>/heartbeat` — touché toutes les 5 s par un sous-shell tué dans le
  `trap`. Vivant = `mtime > now - 30 s`. Immunisé au 255, insensible au mux froid.
- `<runDir>/result.json` — écrit atomiquement, **fait foi** quand présent.
- `<runDir>/events.ndjson` — une `phase` après chaque étape ; le handler
  `abandoned` restaure la ligne `.env` si la phase indique « écrite mais pas
  déployée ».
- Le `runId` (et donc `<runDir>`) est choisi **avant** le spawn : c'est la clé de
  corrélation. `spawnHostJob` mintant son `jobId` en interne (`ssh-exec.ts:493`),
  le persister « avant le spawn » est **impossible** — il est écrit
  best-effort dans `<runDir>/job.json` *après*, et cesse d'être porteur. Cela
  supprime le handshake et sa contrainte d'ordre.
- GC : `<dataDir>/host-jobs/` n'a aucun ménage (référencé nulle part ailleurs que
  dans `ssh-exec.ts`) ; le service purge `_system/` et `updater/runs/`.

## D.5 Avertissement des leads — l'exigence non négociable

**Le mécanisme naïf est un no-op précisément quand il compte** :
`broadcastToLeadsFromExternal` n'injecte le signal que si `isIdle`
(`messaging.ts:575-590`), soit 2 s sans octet PTY (`config.ts:425`), `idleSince`
étant remis à zéro à **chaque** octet — et il n'y a **aucun retry**. Un lead en
plein tour reçoit une ligne de mailbox et rien d'autre.

**Implémentation**

- Nouveau `Session.armNotice(text, {idleMs, deadlineMs})`, copiant la boucle de
  `_scheduleContextReset` (`session.ts:1007-1027`) : un timer dimensionné sur
  l'écart d'idle restant, re-vérifié au réveil, re-armé si toujours occupé. Pas
  de polling. Injection par `notifySignal` (`session.ts:935-970`) — **ne pas**
  réécrire sa cadence, le `text` puis `\r` 150 ms plus tard est structurel pour
  le TUI Ink.
- **Champs propres** `_pendingNotice`/`_pendingNoticeTimer` : le slot
  `_pendingContextReset` est simple-occupant (`session.ts:990`) et déjà disputé
  par l'auto-compact (`:1090-1103`) et `compactOnWaiting` (`routes/hooks.ts:155-166`).
  Garde d'ordonnancement : ne pas tirer si `hasPendingContextReset`, re-armer.
- **Observer la lecture pour de vrai** : pré-minter l'id (`push()` accepte un id
  fourni, `mailbox.ts:164-168`), puis `!peek(leadId).some(m => m.id === warnId)`.
  Seul un **agent** peut consommer la file : `read()` est destructif
  (`mailbox.ts:314-323`) et n'est appelé qu'en production par l'outil MCP
  `team.read_inbox` (`mcp/tools.ts:369`) et `plugins/api.ts:488` — l'UI utilise
  `peek()`. Gérer le cap de 100 avec drop-oldest via `PushResult.dropped` et
  re-pousser. Ne **pas** se fier au `delivered_at` en base : `clearAll()` l'estampe
  aussi (`mailbox.ts:378-391`).
- **Deadline globale**, armement par équipe. Le `up -d` est un événement global :
  toutes les équipes sont interrompues au même instant. `max(120, demandé)`,
  défaut 300 s. Aucune équipe active ⇒ 0 s.
- **On procède à l'échéance, toujours.** Bloquer donnerait à un agent vivant un
  veto sur une action opérateur. `teams_warned` devient un **tableau JSON**
  `{orch_id, orch_name, lead_id, signalled, read, state}` avec
  `state ∈ read | queued_unread | never_idle` — `broadcastToLeadsFromExternal` ne
  renvoie que « poussé dans une mailbox », un compteur bâti dessus ne veut rien dire.
- Formulations à livrer : *« 3 équipes averties — tous les leads ont lu. Application dans 01:12. »* /
  *« …1 lead (stiix-infra) n'a pas encore lu (occupé depuis 4m31). Application quand même dans 01:12. [Annuler] [Appliquer maintenant] »* /
  et, sur l'écran post-MAJ : *« stiix-infra — avis déposé mais jamais lu, le lead a été occupé toute la fenêtre. Son travail a été interrompu à un point arbitraire. »*

**Notice post-redémarrage.** Ne pas compter sur le message pré-MAJ : il est
**délibérément effacé** au shutdown (`orchestrator/index.ts:935` → `clearAll()`).
Le canal fiable existe déjà : `buildResumeNotice(logPath)`
(`log-tail-reader.ts:89-119`) est injecté dans l'**argv positionnel** au spawn
(`session.ts:266-268`) — donc dans le tout premier tour du lead relancé, sans
mailbox ni fenêtre d'idle. Quatre changements additifs à paramètre optionnel :
lire le run en cours au boot (après `new SwarmDb`, avant `runAutoResume`) →
`resumeFromDb(rows, {resumeBanner})` (`spawner/index.ts:461`, fil jusqu'à `:527`)
→ `Orchestrator.resume({banner})` (`orchestrator/index.ts:419`, `:429`) →
`buildResumeNotice(logPath, banner?)`. **Leads uniquement** — laisser l'appel
worker de `:517` intact.

## D.6 Survie des équipes

**Un resume échoué est définitif** : `loadResumableState` bascule tous les
candidats en `interrupted` **avant** de retourner (`persistence.ts:147-161`),
`listResumableOrchestrators` ne sélectionne que `starting|running`, et un échec
laisse la ligne `interrupted` (`spawner/index.ts:545-557`). L'auto-resume dépense
son unique tentative sur le boot le plus susceptible d'échouer.

Donc : **snapshoter la liste des équipes vivantes dans le run AVANT de
déclencher**, et réconcilier contre ce snapshot en `verifying` — ne pas lire les
lignes DB, elles sont déjà `interrupted`. C'est ce snapshot qui alimente l'écran
post-MAJ et son bouton « Redémarrer les équipes » (démarrage frais en place).

---

# Lot E — planification

`POST /updates/schedule { at: <ISO> }` : **un `setTimeout` one-shot**, ré-armé au
boot depuis la base. Pas de croner : le scheduler de cadences (aujourd'hui
`CronScheduler`, `modules/crons/scheduler.ts`)
modélise une cadence *récurrente* lue en table, alors qu'une mise à jour est un
one-shot à une date — chaque version est une décision distincte.

---

# Lot F — plugins

- Réutilise **tel quel** `POST /plugins/:name/upgrade` (`routes/plugins.ts:180`)
  → `PluginInstaller.upgrade()` (`installer.ts:198-253`) : re-fetch depuis
  `source_ref`, staging, validation, `commitInstall` sous verrou, et **l'ancienne
  version continue de tourner** si le fetch échoue (`:225-234`). Rien à réécrire.
- **Trou à combler** : `installer.ts` clone en `--depth 1` puis **supprime
  `.git`** (`:299`, `:329`) et n'enregistre jamais le SHA ; `encodeGitRef`
  (`:80`) ne stocke que `url#ref#subdir`. Il faut capturer `git rev-parse HEAD`
  avant le `rm`, ajouter une colonne `source_commit` à la table `plugins`
  (créée dans `store.ts:151-171`) par un `ALTER TABLE` idempotent, et la
  propager dans `CommitInstallInput` (`host.ts:88-98`) et `commitInstall` (`:747`).
  Sans SHA (plugins déjà installés) ⇒ statut « inconnu », bouton
  « Réinstaller depuis la source ».
- « Tout mettre à jour » : plugins d'abord (à chaud, sans redémarrage), **puis**
  le cycle système avec son délai de grâce. Jamais mélangés dans un même job.
- `upload` ⇒ 409 déjà géré (`installer.ts:111`) : « re-uploadez le .tgz ».
- Nouvelles capacités : `commitInstall` renvoie déjà `newCapabilities`
  (`host.ts:770`) → `PermissionsDialog` pour la ré-approbation. Config et grants
  sont préservés à l'upgrade (`host.ts:748-754`, `:775-779`).

---

# Persistance

**`schema.sql` n'est PAS dans l'image** — vérifié en direct :
`dist/modules/db/` ne contient que `index.js`, `tsc` ne copie pas les `.sql`, et
`SwarmDb` retombe silencieusement sur `INLINE_SCHEMA` (`db/index.ts:502-516`,
`:946`). Pire, les erreurs d'écriture sont **avalées en warn** (`:518-528`) :
des tables déclarées uniquement là n'existeraient jamais en production et rien
ne le signalerait.

Donc, comme la table `plugins` : DDL dans **`modules/updates/store.ts`**
(`CREATE TABLE IF NOT EXISTS` dans le constructeur), plus une assertion de boot
que la table existe. `schema.sql` reste réservé aux tables du domaine cœur.

```sql
CREATE TABLE IF NOT EXISTS update_runs (
  id TEXT PRIMARY KEY,            -- runId, = nom du répertoire de run
  kind TEXT NOT NULL,             -- 'system' | 'plugins'
  state TEXT NOT NULL,
  target_version TEXT,
  scheduled_for TEXT, warned_at TEXT, started_at TEXT, finished_at TEXT,
  run_dir TEXT NOT NULL,
  env_file TEXT, env_line_before TEXT,   -- rollback à l'octet près
  teams_snapshot_json TEXT,              -- équipes vivantes AVANT la MAJ
  teams_warned_json TEXT,                -- [{orch_id, lead_id, signalled, read, state}]
  error TEXT, log_tail TEXT
);
```

# API — `http/routes/updates.ts`

Monté **après** `app.use(auth)` (`http/main.ts:239-240`), sur le modèle de
`routes/backup.ts:18`.

| Route | Rôle |
|---|---|
| `GET /updates` | état complet : système, plugins, run courant, `canSelfUpdate` (raison) |
| `POST /updates/apply` | `{kind, targetVersion?, graceSeconds?}` → 202 + runId ; 409 si occupé |
| `POST /updates/schedule` / `DELETE` | `{at}` one-shot / annulation |
| `POST /updates/cancel` | annule pendant la fenêtre de grâce |
| `POST /updates/dismiss` | ignore une version |
| `GET /updates/:id` | détail d'un run + tail |

# Plomberie à extraire dans un PR séparé, **maintenant**

Ce sont des bugs réels qui font mal à chaque redémarrage, MAJ ou pas — enterrés
dans le lot D, ils ne sortiraient jamais.

- **`/health` répond 200 pendant le bootGate** (`main.ts:123-136`, gate monté à
  `:214-224`) : un conteneur qui démarre puis se bloque en auto-resume passe pour
  sain. Ajouter `boot_complete`.
- **`stop_grace_period: 30s`** dans les composes. ⚠️ *pas* pour la raison que je
  croyais : `shutdownAll` est **synchrone** (`spawner/index.ts:399-411`) et aucune
  écriture voulue n'est perdue à 10 s. C'est du confort pour les PTY, pas une
  correction de corruption.
- Janitor pour `<dataDir>/host-jobs/` (dette pré-existante de la v0.5.0).

---

# Ordre d'exécution

1. **Plomberie** (`boot_complete`, grace period, janitor) — PR indépendant.
2. **Lot A** — version juste + Release CI. Rien d'autre n'a de sens avant.
3. **Lot F** — détection plugins : marche sur **tous** les déploiements
   immédiatement, sur une surface qui existe déjà.
4. **Lot B + C** — `/info.update`, `GET /updates`, badge, notes.
5. **Lot D** — application. Le lot risqué ; à valider sur le déploiement jetable
   avant `stiix`/`trader`.
6. **Lot E** — planification + écran post-MAJ.

# Vérification

**Unitaires (Vitest)** : comparateur semver ; client GitHub mocké (200/401/404/
réseau coupé/aucune release/brouillons) ; détection plugins mockée dont « pas de
`source_commit` » ; parsing des labels compose (chemin unique, liste à virgules,
absent) ; localisation + réécriture atomique de la ligne `.env` (préservation des
commentaires, `.bak`, restauration à l'octet) ; machine à états (plancher 120 s,
`cancel` seulement dans la fenêtre) ; `armNotice` (re-armement, deadline,
`never_idle`, non-collision avec `_pendingContextReset`) ; assertion de présence
des tables au boot.

**Manuel de bout en bout, sur un déploiement jetable** — jamais sur
`stiix`/`trader` :

0. **Prouver la prémisse d'abord** : `spawnHostJob` d'un `for i in $(seq 1 60)`,
   `docker restart swarm-os-test`, puis vérifier que le heartbeat et le tail sont
   toujours lisibles après le redémarrage. Si ça échoue, rien d'autre ne compte.
1. `docker-compose.updtest.yml` : conteneur et port dédiés, `/data` dédié,
   **nom de projet distinct** (pas `swarm-os`), `image: ${SWARM_OS_IMAGE}` avec
   la variable réellement présente dans un `.env` voisin, après `docker login ghcr.io`.
2. Publier deux tags GHCR successifs, démarrer sur l'ancien.
3. Détection : la nouvelle version et ses notes apparaissent.
4. Lancer une équipe, `POST /updates/apply` : le lead reçoit l'avis **et le lit**
   (vérifier la disparition de l'id pré-minté), le compte à rebours ≥120 s
   s'affiche, « Annuler » marche.
5. Sans annuler : le `.env` est réécrit (diff + `.bak`), le conteneur recréé,
   `/info` affiche la nouvelle version, le run conclut `success`, et le lead
   relancé porte la bannière post-MAJ dans son premier tour.
6. **Refus** : retirer le `.env`, mettre une `image:` en dur, pointer `DATA_PATH`
   ailleurs, lancer en `docker run` sans labels → chacun doit sortir en 30,
   `refused`, conteneur intact.
7. **Rollback** : `docker tag busybox:latest` sur le tag cible → le conteneur ne
   répond jamais → la ligne `.env` d'origine est restaurée, le service revient,
   statut `rolled_back`, et un reboot ne réapplique pas la version cassée.
8. **Hôte mort en plein run** : `kill -9 -<pgid>` pendant le pull → `abandoned`,
   proposition de réessai, ligne `.env` cohérente.
9. **Concurrence** : deux `POST` d'affilée → 409 ; deux scripts lancés à la main
   → le second sort en 30 sur le `flock`.
10. **Rayon d'action** : après chaque étape, `swarm-os-test` et `swarm-os-stiix`
    ont des ids de conteneur inchangés et sont `healthy`.

Rappel : après toute modif, `docker build -t swarm-os:latest .` puis
`docker compose -f docker-compose.test.yml up -d`, sinon rien n'est réellement testé.

# Risques

- **Aucun déploiement n'est éligible aujourd'hui.** Le lot D n'est testable que
  sur le jetable tant qu'un compose n'est pas converti au format interpolé.
- **Les équipes ne survivent probablement pas au recreate** (lead repris qui meurt
  en SSH) et un resume échoué est **définitif**. C'est la raison d'être de
  l'avertissement, du snapshot et de l'écran post-MAJ. *Le vrai déblocage de cette
  fonctionnalité est la correction de ce bug amont* — sans elle, le bouton reste
  un piège à retardement, quelle que soit la qualité du reste.
- **Le script qui met à jour la version N est celui de la version N** : un bug de
  l'updater de N ne peut pas être corrigé par N+1. D'où : script minimal,
  `SCRIPT_VERSION` estampillé dans chaque ligne de log et dans `result.json`,
  refus si le sha256 sur disque diverge.
- **swarm-os écrit dans un fichier de l'opérateur.** Diff affiché avant la
  première application, `.bak`, contenu d'origine archivé en base.
- **Le PAT GitHub vit sur l'instance** : scope `contents:read` strict, jamais
  relu par l'API.
- **La détection ne montrera rien tant que la release n'est pas poussée** —
  le lot A doit être terminé et `master` + tags poussés.
