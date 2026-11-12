# swarm-os — Guide d'utilisation (FR)

Comment opérer une instance en marche. Pour l'install / l'accès distant, voir
[install.fr.md](install.fr.md).

---

## Concepts

- **Instance** — un conteneur, un projet (le montage `/workspace`), un opérateur.
- **Orchestrateur (équipe)** — **1 lead + N workers**. Le lead coordonne et décide ;
  les workers exécutent les tâches et rapportent via une mailbox en mémoire et un
  serveur MCP. Les workers sont des feuilles — ils ne créent pas de sous-équipes.
- **Rôles** — définitions réutilisables : prompts système lead/worker (preambles),
  modèle et effort par défaut, connecteur Discord optionnel.
- **Crons** — réveils programmés, visant un **rôle**. Un rôle peut en porter
  autant qu'il veut ; voir [Crons](#crons) plus bas.
- **Permissions** — par défaut, les agents tournent avec leurs demandes de
  permission coupées (`bypassPermissions` pour claude ; codex, gemini et
  opencode tournent toujours sans demande). Ce qu'ils atteignent dépend du
  transport : en `local`, le conteneur et ses montages ; en `ssh`, ils tournent
  **sur l'hôte** sous le compte SSH, et le conteneur n'isole plus rien. Lis
  [SECURITY.md](../../SECURITY.md) (en anglais) avant de choisir.
- **Approbations humaines** — une équipe claude dans un mode qui questionne
  (`default`, `plan`, `acceptEdits`, réglé par rôle ou par équipe) transforme
  chaque demande de permission en approbation que tu accordes ou refuses depuis
  l'UI ou Discord.

---

## L'UI en un coup d'œil

- **New Orchestrator** — créer une équipe : nom, rôle/preset, modèle, effort, et le
  prompt initial qui lance le lead.
- **Superviser** — le bureau liste chaque équipe et session. Ouvre une session pour
  attacher un **terminal live** (xterm) et écrire directement à l'agent.
- **Console / events** — un flux d'activité global (agrandissable en overlay plein
  écran), avec toasts / picture-in-picture pour les notifications.
- **IDE** — un overlay VS Code Web ouvre le dossier `/workspace` dans le navigateur.
  Activable/désactivable depuis l'écran Plugins (fonctionnalité intégrée — voir
  [../builtin-features.md](../builtin-features.md)) ; `SWARM_OS_IDE_ENABLED` n'en
  fixe que l'état initial au premier boot.
- **Restart team** — relance une équipe morte **en place** (même id/config). C'est
  un démarrage neuf, pas un resume Claude.

---

## Notifications (Discord)

Définis `SWARM_OS_DISCORD_WEBHOOK_URL` pour recevoir une notification quand une
session devient inactive (elle attend ta saisie) ou qu'un orchestrateur se termine.
Définis `SWARM_OS_PUBLIC_URL` pour que les liens des embeds pointent vers ton URL
accessible — **aucun token n'est inclus**. Sans webhook, les notifications sont
simplement journalisées.

---

## Crons

Un **cron** réveille un rôle selon un horaire. Il a son écran dédié —
`#/crons`, accessible depuis le launcher ⌘K (WORKSPACE ▸ CRONS), le badge
`🕐 N CRONS` d'un rôle, ou la ligne CRONS du panneau d'un agent. En mobile,
l'accès est dans la feuille STATS.

Chaque cron vise un **rôle**, pas une session : au tir, il est livré au lead de
**chaque instance vivante** de ce rôle. Aucune instance vivante → un `noop`
journalisé — un cron ne redémarre jamais une équipe éteinte.

Depuis l'écran : **+ NEW CRON**, **PAUSE / RESUME**, édition de la cadence ou de
l'action en place, **DELETE**, et **RUN NOW** (autorisé même sur un cron en
pause, ou avec la planification désactivée globalement — c'est un geste
opérateur explicite). **LAST RUNS** conserve les 20 derniers tirs de chaque
cron avec leur issue, code de sortie, durée et un extrait de sortie tronqué.

Deux actions possibles :

- **MESSAGE** — livrer un template dans l'inbox du lead à chaque tick. Mêmes
  tokens qu'avant : `{{fire}}`, `{{now}}`, `{{window:6h}}`.
- **SCRIPT** — exécuter un script dans le conteneur ; **c'est le script qui
  décide** s'il faut réveiller quelqu'un. La dernière ligne non vide de son
  stdout doit être du JSON : `{"wake": true, "message": "…"}` livre ce message,
  `{"wake": false}` ne dérange personne. Un exit ≠ 0, une dernière ligne
  illisible ou un timeout donnent un run `error` et ne réveillent personne.

Un script reçoit un environnement explicite et minimal (`SWARM_OS_CRON_ID`,
`SWARM_OS_CRON_NAME`, `SWARM_OS_FIRE`, `TZ`, `UV_CACHE_DIR`, proxies — **ni
token serveur, ni clé provider**), un interpréteur explicite (`python3`, `bash`
ou `node`), un timeout dur (60 s par défaut, 240 s au maximum), et doit vivre
sous `/workspace` ou `/data` — des chemins **conteneur**.

> Préfère `/data/crons/` pour tout ce qui porte un secret. Les agents écrivent
> `/workspace` : un script qui s'y trouve peut être réécrit par les agents-mêmes
> que le cron réveille — soit une exécution récurrente sans supervision de
> session.

Autrement dit, quiconque possède le `X-Auth-Token` peut exécuter du code
arbitraire **dans le conteneur** — et sous le transport `ssh`, le conteneur
détient une clé qui ouvre une session sur l'hôte. C'est le pouvoir que ce token
donne déjà par ailleurs (une équipe `bypassPermissions` exécute aussi du code
arbitraire, un plugin aussi), mais ça mérite d'être dit. Voir
[SECURITY.md](../../SECURITY.md#the-auth-token).

Exemple complet, contrat de sortie détaillé et variante `uv run --with
requests` : [examples/crons/](../../examples/crons/).

`SWARM_OS_SCHEDULE_ENABLED` (actif par défaut) et `SWARM_OS_SCHEDULE_TZ` (UTC
par défaut) sont l'interrupteur général et la timezone de tous les crons. Planification désactivée : les crons ne tictaquent
plus (l'écran le dit), mais RUN NOW fonctionne toujours.

**Note de migration.** La cadence par rôle a disparu : les champs `schedule` /
`scheduleMessage` d'un rôle n'existent plus, et la section cadence de l'éditeur
de rôle avec eux. Au premier démarrage après la mise à jour, chaque rôle qui
portait une cadence est converti en cron `message` nommé `<rôle>-cadence`, et
les colonnes du rôle sont vidées — rien à faire à la main, et rien ne tire deux
fois. `POST` / `PATCH /roles` avec un `schedule` ou un `scheduleMessage` **non
nul** répond désormais **400** (`SCHEDULE_MOVED`) ; les clés envoyées à `null`
restent acceptées, donc les clients existants continuent de marcher.

---

## État, sauvegardes, restauration

Tout l'état vit dans le volume `/data` (`DATA_PATH` côté hôte) :

- `swarm-os.db` — SQLite (équipes, sessions, rôles, réglages, mailbox).
- `token`, `hook-token`, `ide-token` — secrets d'auth (mode 0600).
- `logs/` — logs par session. `backups/` — snapshots SQLite.
- `.claude-runtime/` — la copie inscriptible de ton `~/.claude`.

Comportement (les variables entre parenthèses sont lues par le serveur mais
pas transmises par le compose fourni : pour en changer une, ajoute-la à
`environment:` du service ; même chose pour les deux `SWARM_OS_SCHEDULE_*`
ci-dessus) :

- **Sauvegardes** — snapshots SQLite à chaud toutes les 6 h, 14 conservés
  (`SWARM_OS_BACKUP_INTERVAL_MS`, `SWARM_OS_BACKUP_KEEP`).
- **Auto-resume** — au démarrage, les équipes qui tournaient sont restaurées
  (`SWARM_OS_AUTO_RESUME`).
- **Restaurer** — arrête le conteneur, remplace `/data/swarm-os.db` par un snapshot
  de `/data/backups/`, puis redémarre.

> Conserve le répertoire `DATA_PATH` — le supprimer efface équipes, historique et
> tokens.

---

## Maîtrise des coûts

Une nouvelle équipe démarre sur le Claude **Opus** le plus récent à l'effort
`xhigh` — puissant mais coûteux. L'identifiant exact n'est pas figé dans le
build : le serveur rafraîchit la liste de modèles de chaque provider depuis
models.dev, donc une équipe créée aujourd'hui démarre sur l'Opus du jour
(`GET /providers`, ou la liste déroulante, dit lequel). Baisse
`SWARM_OS_DEFAULT_MODEL` et/ou `SWARM_OS_DEFAULT_EFFORT` dans `.env` pour des
exécutions moins chères, puis `./install.sh` pour appliquer.

La liste déroulante affiche le prix au million de tokens de chaque modèle — ça
vaut un coup d'œil : à génération égale, un modèle peut coûter le double d'un
autre pour un usage différent. Les équipes existantes ne changent jamais de
modèle toutes seules ; seules les nouvelles prennent le défaut le plus récent.

---

## Mettre à jour

**SETTINGS ▸ SYSTEM UPDATE** affiche la version en cours et la dernière
release publiée, lue dans les releases GitHub publiques sans aucun token.
`SWARM_OS_GITHUB_TOKEN` est optionnel et ne fait que relever la limite de débit
de GitHub — voir install.fr.md §7.4.

Si le déploiement est éligible (transport SSH + un `SWARM_OS_IMAGE` de
registry), le même panneau applique la mise à jour lui-même : il réécrit la
ligne `SWARM_OS_IMAGE=` de ton `.env` (en laissant un `.bak`), recrée le
conteneur et vérifie le nouveau sur `/health` jusqu'à `boot_complete` — avec
retour à la ligne d'origine si la vérification échoue. `/data` persiste.

**Tes équipes sont interrompues par tout ça, et l'UI le dit franchement.**
Chaque lead vivant est prévenu dans sa propre session et la mise à jour attend
une fenêtre d'au moins **120 secondes** (300 par défaut ; le serveur refuse plus
court). Le compte à rebours nomme les leads qui n'ont pas lu l'avis et annonce
*"Applying anyway"* : l'échéance ne se négocie pas. Ensuite, le panneau liste
les équipes qui ne sont pas revenues et ce que la coupure a fait à leur travail ;
RESTART TEAMS est un redémarrage à froid sur place — rien n'est repris là où
ça s'était arrêté.

Détail complet, raisons d'inéligibilité et dépannage :
[install.fr.md §7](install.fr.md).

---

## Commandes de cycle de vie

```sh
# logs
docker compose --env-file .env -f examples/docker-compose.dist.yml logs -f
# arrêt (conserve /data)
docker compose --env-file .env -f examples/docker-compose.dist.yml down
# mise à jour vers un nouveau tag (édite .env d'abord), puis
./install.sh
# reconfigurer (assistant guidé, valeurs actuelles en défauts)
./install.sh --reconfigure
```

Sous le transport `ssh`, ajoute `-f examples/docker-compose.ssh.yml` aux deux
premières commandes — `install.sh` le fait tout seul, et affiche la ligne exacte
à la fin de chaque déploiement.
