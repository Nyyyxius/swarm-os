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
  modèle et effort par défaut, connecteur Discord optionnel, cadence cron
  optionnelle.
- Toutes les sessions tournent en `bypassPermissions`. **L'isolation vient du
  conteneur, pas du runtime — ne jamais lancer swarm-os hors Docker.**

---

## L'UI en un coup d'œil

- **New Orchestrator** — créer une équipe : nom, rôle/preset, modèle, effort, et le
  prompt initial qui lance le lead.
- **Superviser** — le bureau liste chaque équipe et session. Ouvre une session pour
  attacher un **terminal live** (xterm) et écrire directement à l'agent.
- **Console / events** — un flux d'activité global (agrandissable en overlay plein
  écran), avec toasts / picture-in-picture pour les notifications.
- **IDE** — un overlay VS Code Web ouvre le dossier `/workspace` dans le navigateur.
  Activable via `SWARM_OS_IDE_ENABLED`.
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

## Planificateur (cron par rôle)

Un rôle peut porter une cadence cron pour réveiller un agent selon un horaire.
Contrôlé par `SWARM_OS_SCHEDULE_ENABLED` (actif par défaut) et `SWARM_OS_SCHEDULE_TZ`
(UTC par défaut).

---

## État, sauvegardes, restauration

Tout l'état vit dans le volume `/data` (`DATA_PATH` côté hôte) :

- `swarm-os.db` — SQLite (équipes, sessions, rôles, réglages, mailbox).
- `token`, `hook-token`, `ide-token` — secrets d'auth (mode 0600).
- `logs/` — logs par session. `backups/` — snapshots SQLite.
- `.claude-runtime/` — la copie inscriptible de ton `~/.claude`.

Comportement :

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

**RÉGLAGES ▸ SYSTEM UPDATE** affiche la version en cours et, si un
`SWARM_OS_GITHUB_TOKEN` est configuré, la dernière release publiée. Sans ce
token, rien n'est jamais annoncé — voir install.fr.md §7.4.

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
