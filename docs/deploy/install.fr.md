# swarm-os — Installation & déploiement (FR)

swarm-os orchestre des équipes de sessions Claude Code autonomes. **Un conteneur =
un projet.** Ce guide mène d'un hôte vierge à une instance fonctionnelle et
accessible.

---

## 1. Prérequis

- **Docker** + **Docker Compose v2** (`docker compose version` répond).
- **Un compte Claude Code et le CLI, connecté sur cet hôte** — le prérequis
  critique, voir ci-dessous.
- Dimensionnement : environ **2–4 vCPU et 4–8 Go de RAM par équipe active**, plus
  l'espace disque du workspace et du répertoire d'état `/data`.
- Accès Internet sortant depuis le conteneur (API Claude, téléchargement initial
  de VS Code, webhook Discord, git/npm lancés par les agents).
- (Optionnel) Tailscale ou un reverse proxy pour l'accès distant.

### Le prérequis critique — identifiants Claude Code

swarm-os ne contient **aucune clé API**. Chaque agent lance le CLI Claude Code,
qui s'authentifie depuis `~/.claude`. Le conteneur monte ce répertoire en lecture
seule et le recopie en zone inscriptible au démarrage.

Avant tout, sur l'hôte :

```sh
npm i -g @anthropic-ai/claude-code     # installe le CLI
claude                                  # effectue le login OAuth une fois
ls ~/.claude/.credentials.json          # ce fichier DOIT exister ensuite
```

Sans `~/.claude/.credentials.json`, aucun agent ne démarre — une session lancée se
fige sur le sélecteur de thème du premier lancement.

---

## 2. Récupérer l'image (GHCR)

L'image est dans un package **privé** du GitHub Container Registry. Il te faut un
**Personal Access Token (classic)** GitHub avec le scope `read:packages`, et le
mainteneur doit avoir autorisé ton compte sur le package.

```sh
echo <TON_PAT> | docker login ghcr.io -u <ton-user-github> --password-stdin
docker pull ghcr.io/luminis1986/swarm-os:latest      # ou un tag figé :X.Y.Z
```

---

## 3. Configurer

Depuis la racine du kit (dépôt) :

```sh
cp .env.example .env
```

Édite `.env` — au minimum :

- `SWARM_OS_IMAGE` — le tag que tu viens de puller. **Renseigne-le
  explicitement** : le compose a un repli `${SWARM_OS_IMAGE:-…:latest}` qui
  démarre quand même un conteneur, et laisser la variable vide est exactement ce
  qui désactive la mise à jour en un clic (§7.2) — c'est cette ligne qu'une mise
  à jour réécrit.
- `WORKSPACE_PATH` — le projet sur lequel les agents travaillent.
- `DATA_PATH` — où l'état persistant est stocké.
- `CLAUDE_DIR` — ton `~/.claude` (défaut correct sur une install standard).
- `SWARM_OS_PROJECT_NAME` — un libellé pour l'UI / les logs / Discord.
- `SWARM_OS_GITHUB_TOKEN` — optionnel ; sans lui, swarm-os ne t'annoncera jamais
  une nouvelle version (§7.4).

Le même fichier, à côté de `examples/docker-compose.dist.yml`, est
[`examples/.env.example`](../../examples/.env.example).

---

## 4. Installer (mode facile)

```sh
./install.sh
```

Le script vérifie Docker, vérifie tes identifiants Claude, pulle l'image, démarre
le conteneur, attend `/health`, puis affiche ton **token d'accès** et l'URL.
Relance-le après toute modif de `.env`, ou pour mettre à jour vers un nouveau tag.

> **Équivalent manuel** (si tu préfères ne pas utiliser le script) :
> ```sh
> set -a && source .env && set +a
> docker compose -f examples/docker-compose.dist.yml up -d
> docker exec "$SWARM_OS_CONTAINER_NAME" cat /data/token
> ```
> L'étape `set -a && source .env` étend `${HOME}` dans tes chemins avant que
> Compose ne les lise.

---

## 5. Première connexion

1. Ouvre `http://127.0.0.1:8787`.
2. Le panneau Token/Réglages s'ouvre seul (aucun token enregistré).
3. Colle le token affiché par `install.sh` (ou `docker exec <conteneur> cat
   /data/token`).
4. Enregistre — il est conservé dans le `localStorage` du navigateur. C'est fait.

---

## 6. Accès distant

L'UI n'écoute que sur `127.0.0.1` et il n'y a **aucun TLS dans le conteneur**.
Choisis une méthode.

### A. Tailscale (recommandé)

Mets l'hôte sur ton tailnet, puis expose le loopback en HTTPS :

```sh
tailscale serve --bg --https=8787 http://127.0.0.1:8787
tailscale serve --bg --https=8790 http://127.0.0.1:8790   # seulement si l'IDE est actif
```

Accès via `https://<hôte>.<tailnet>.ts.net:8787`. Mets `SWARM_OS_PUBLIC_URL` dans
`.env` à cette URL pour que les liens Discord résolvent. Aucun port public ouvert.

### B. Reverse proxy + TLS (domaine public)

Termine le TLS sur Caddy/nginx devant `127.0.0.1:8787`. Exigences :

- le proxy **doit relayer les WebSockets** (le terminal live et le flux d'events
  en dépendent) ;
- l'éditeur VS Code (port 8790) a besoin de **son propre hôte/port** : `serve-web`
  ne peut pas vivre sous un sous-chemin, et une page HTTPS ne peut pas embarquer
  une iframe en HTTP simple. Donne-lui son propre vhost TLS, ou désactive l'éditeur
  avec `SWARM_OS_IDE_ENABLED=false`.

Exemple Caddy :

```
swarm.example.com {
    reverse_proxy 127.0.0.1:8787
}
ide.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

Ce que tu exposes reste protégé par le X-Auth-Token, mais c'est toi qui assumes le
patching et les abus. Préfère Tailscale sauf besoin réel d'une URL publique.

### C. Localhost / tunnel SSH (le plus simple et le plus sûr)

Laisse sur le loopback et forward un port à la demande :

```sh
ssh -L 8787:127.0.0.1:8787 user@host
# puis ouvre http://127.0.0.1:8787 sur ton portable
```

---

## 7. Mise à jour

Deux chemins. Le shell de l'hôte marche toujours ; la mise à jour en un clic
depuis l'UI marche si le déploiement est éligible (§7.2).

### 7.1 Depuis le shell de l'hôte

```sh
# change le tag dans .env (ou garde :latest), puis :
./install.sh        # pull + recrée le conteneur ; /data (DB, tokens, équipes) persiste
```

### 7.2 En un clic, depuis RÉGLAGES ▸ SYSTEM UPDATE

Le panneau affiche la version en cours, la dernière release publiée, et une
ligne qui dit si ce déploiement peut se mettre à jour lui-même. Il n'offre
jamais un bouton que l'hôte refuserait — il nomme la raison, une seule :

| Intitulé | Signification | Ce qu'il faut changer |
|---|---|---|
| `ELIGIBLE` / `HOST CHECKS PENDING` | transport et image conviennent ; le reste est tranché sur l'hôte, au préflight | rien |
| `TRANSPORT IS NOT SSH` | `SWARM_OS_AGENT_TRANSPORT=local` — les agents tournent dans le conteneur, donc swarm-os n'a aucun moyen de lancer `docker` sur l'hôte | passer le transport en `ssh` et monter une clé |
| `IMAGE TAG IS HARDCODED` | `SWARM_OS_IMAGE` n'est pas défini : le compose fige son propre tag, il n'y a aucune variable à réécrire | mettre `image: ${SWARM_OS_IMAGE}` dans le compose et définir la variable dans `.env` |
| `IMAGE IS LOCALLY BUILT` | `SWARM_OS_IMAGE` n'a pas de chemin de registry (`swarm-os:latest`) — rien à puller | pointer `ghcr.io/luminis1986/swarm-os:<tag>` |
| `NO .env FOUND` / `.env IS NOT WRITABLE` | l'updater n'a pas trouvé de fichier d'env inscriptible à côté du compose | le créer / corriger ses droits (l'utilisateur du conteneur est uid 1000) |
| `REGISTRY LOGIN MISSING` | l'hôte n'est pas authentifié sur GHCR | `docker login ghcr.io` avec un PAT `read:packages` |

Les trois derniers sont des **faits d'hôte** : ils sont tranchés par le préflight
de l'updater, sur l'hôte, avant la moindre écriture. Un run qui tombe dessus se
termine en `REFUSED — NOTHING WAS TOUCHED` : aucun `.env` modifié, aucun
conteneur recréé, aucune équipe interrompue.

**Ce qu'une mise à jour écrit — exactement une ligne.** swarm-os réécrit la
ligne `SWARM_OS_IMAGE=` de *ton* `.env` de déploiement (celui trouvé à côté du
compose) et rien d'autre dans ce fichier :

- le fichier est copié en `<fichier>.bak` **avant** l'écriture : l'ancienne ligne
  reste récupérable à la main ;
- l'écriture elle-même est un fichier temporaire + `rename(2)` — le `.env` n'est
  jamais laissé à moitié écrit ;
- ensuite `docker compose up -d` recrée le conteneur, et le nouveau est
  interrogé sur `/health` jusqu'à ce qu'il annonce `boot_complete` ;
- si cette vérification échoue, la ligne d'origine est remise, le conteneur est
  redéployé sur la version précédente et le run finit en `ROLLED BACK`. Le
  `.bak` n'est **pas** rafraîchi par le rollback : il contient toujours l'état
  d'avant la mise à jour.

`/data` (base SQLite, tokens, équipes, logs) survit à tout ça — c'est le
conteneur qui est remplacé, pas le répertoire d'état.

### 7.3 Ce que reçoivent les équipes — la garantie des 120 s

Une mise à jour recrée le conteneur, donc tue toutes les sessions en cours.
Avant la moindre écriture, chaque lead vivant reçoit un avis dans sa propre
session et le run attend une **fenêtre d'avertissement** (300 s par défaut).

- **Cette fenêtre ne descend jamais sous 120 s.** Tu peux demander moins ; le
  serveur plafonne par le bas. Sous deux minutes, un lead en plein tour n'a
  aucune chance d'atteindre une frontière d'inactivité, de lire l'avis et de
  conclure : ce n'est plus un avertissement, c'est une annonce.
- Le panneau affiche le compte à rebours, une ligne par équipe (`read` ·
  `displayed, unread` · `never available` · `no lead` · `no answer yet`) et une
  phrase volontairement brutale : *"3 teams warned — 1 lead (stiix-infra) has
  not read it yet (busy for 4m31). **Applying anyway** in 01:12."* L'échéance ne
  se négocie pas.
- `APPLY NOW` écourte la fenêtre — mais seulement une fois les 120 s écoulées ;
  en dessous le serveur refuse (409) en indiquant les secondes restantes.
- Pendant `applying`/`verifying`, un écran plein remplace l'UI, piloté par
  `/health` (public) : tous les appels authentifiés échouent tant que le
  conteneur est remplacé. Il peut être fermé au bout de cinq minutes ; le run
  continue sans lui.
- Ensuite, le panneau dit qui est revenu. Pour une équipe qui ne l'est pas, il
  dit ce que l'interruption a fait à son travail — *"notice delivered but never
  read, the lead was busy for the whole window. Its work was interrupted at an
  arbitrary point."* `RESTART TEAMS` est un **redémarrage à froid sur place** :
  la session repart du début, pas de là où le lead en était. Il est vérifié
  contre la liste des équipes vivantes, donc une équipe déjà repartie est
  ignorée plutôt que tuée.

### 7.4 Détection des mises à jour — `SWARM_OS_GITHUB_TOKEN`

swarm-os lit les **GitHub Releases** de `luminis1986/swarm-os` pour savoir qu'une
version plus récente existe. Ce dépôt est privé : un appel non authentifié
répond 404. Sans token, le statut du check reste `no_token`, le badge ne
s'allume jamais et aucune mise à jour n'est proposée. Rien d'autre ne casse —
c'est un état sain, qui veut dire « ne me parle jamais des releases ».

Pour activer la détection :

1. Crée un PAT GitHub **en lecture seule** ayant accès au dépôt swarm-os — PAT
   classique : scope `repo` ; PAT fine-grained : permission **`Contents: Read`**.
   Ce n'est *pas* le token `read:packages` de `docker login` : celui-là sait
   puller des images, pas lire des releases.
2. Mets-le dans le `.env` du déploiement :
   ```sh
   SWARM_OS_GITHUB_TOKEN=github_pat_xxxxxxxx
   ```
3. Vérifie que le service compose le transmet. `environment:` est une **liste
   blanche explicite** : une variable qui n'y figure pas n'atteint jamais le
   processus, quoi que dise le `.env`. Tous les compose livrés ont déjà la ligne :
   ```yaml
   environment:
     SWARM_OS_GITHUB_TOKEN: ${SWARM_OS_GITHUB_TOKEN:-}
   ```
4. `./install.sh` (ou `docker compose up -d`) pour recréer le conteneur.

Le token n'est envoyé qu'à `api.github.com`, en lecture. Aucune route ne
l'écrit, ne le renvoie ni ne le stocke en base.

### 7.5 Publier une release (mainteneur)

Le checker lit les *releases GitHub publiées*, et la release est créée par le
workflow `release-image` quand un tag `v*` **arrive sur GitHub** :

```sh
# bump package.json, commit ("Release: vX.Y.Z"), tag, puis :
git push origin master --follow-tags
```

Un tag qui n'existe qu'en local ne publie rien. C'est `--follow-tags` qui rend
la release effective : sans lui le commit part, le workflow ne se déclenche
jamais, et aucune instance ne verra la nouvelle version. Un `workflow_dispatch`
manuel publie seulement `:<short-sha>` — il ne déplace **pas** `:latest` et ne
crée aucune release.

---

## 8. Dépannage

- **L'UI charge mais tout renvoie 401** — token erroné/vide. Recopie-le :
  `docker exec <conteneur> cat /data/token`.
- **Une équipe ne démarre jamais / une session se fige** — identifiants Claude
  absents ou non connectés. Vérifie `~/.claude/.credentials.json` et que
  `CLAUDE_DIR` dans `.env` pointe dessus.
- **`pull access denied` / `unauthorized`** — connecte-toi à GHCR avec un PAT
  `read:packages` et vérifie que le mainteneur a autorisé ton compte sur le package.
- **Iframe IDE vide** — vérifie que le port 8790 est publié et (en distant) servi
  en HTTPS cohérent avec le schéma de l'UI.
- **SYSTEM UPDATE dit « no SWARM_OS_GITHUB_TOKEN » alors que tu en as mis un** —
  la variable est dans `.env` mais pas dans la liste blanche `environment:` du
  service : elle n'atteint jamais le processus. Ajoute
  `SWARM_OS_GITHUB_TOKEN: ${SWARM_OS_GITHUB_TOKEN:-}` et recrée le conteneur
  (§7.4).
- **Tout répond 503 juste après une mise à jour** — c'est le boot gate :
  l'auto-resume rejoue les équipes et les routes métier l'attendent. `/health` et
  `/info` restent verts ; le panneau propose CHECK AGAIN.
- **Logs** — `docker compose -f examples/docker-compose.dist.yml logs -f`.

Voir aussi : [usage.fr.md](usage.fr.md).
