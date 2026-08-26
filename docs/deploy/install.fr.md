# swarm-os — Installation & déploiement (FR)

swarm-os orchestre des équipes de sessions Claude Code autonomes. **Un conteneur =
un projet.** Ce guide mène d'un hôte vierge à une instance fonctionnelle et
accessible.

---

## Installation en une commande

Sur un hôte vierge, tout ce document tient en une ligne :

```sh
T=<TON_PAT_GITHUB>; curl -fsSL -H "Authorization: Bearer $T" \
  https://raw.githubusercontent.com/luminis1986/swarm-os/master/bootstrap.sh | SWARM_OS_PAT=$T bash
```

`bootstrap.sh` télécharge le kit (installeur, fichiers compose, docs) dans
`~/swarm-os`, puis lance l'assistant guidé ([§4](#4-installer--lassistant-guidé))
qui pose les questions une par une : Docker, login Claude, chemins, image,
transport, providers, accès distant, notifications.

Pourquoi le token apparaît deux fois : le dépôt est **privé**, donc le premier
`curl` doit s'authentifier pour lire `bootstrap.sh`, et le script réutilise la
même valeur (`SWARM_OS_PAT`) pour récupérer le reste du kit — puis la propose
comme token de détection des mises à jour. Un PAT **en lecture seule** suffit
(classique : scope `repo` ; fine-grained : `Contents: Read` sur swarm-os).

Sans token dans l'environnement, le script le demande (saisie masquée) : c'est
la forme à utiliser si tu publies `bootstrap.sh` sur une URL publique (gist,
domaine à toi), auquel cas le premier `curl` n'a plus besoin d'en-tête :

```sh
curl -fsSL https://<url-publique>/bootstrap.sh | bash
```

Options, après `bash -s --` : `--dir <chemin>` (défaut `~/swarm-os`),
`--ref <branche|tag>`, `--token <pat>`, `--fetch-only` (télécharge sans rien
lancer). Relancer la commande **met à jour le kit** sans jamais toucher au
`.env`.

Piper un script distant dans `bash` est un acte de confiance ; pour le lire
d'abord :

```sh
curl -fsSL -H "Authorization: Bearer $T" \
  https://raw.githubusercontent.com/luminis1986/swarm-os/master/bootstrap.sh -o bootstrap.sh
less bootstrap.sh && bash bootstrap.sh
```

Les sections 1 à 3 restent la référence de ce que fait l'assistant, et la voie
manuelle. La suite du guide vaut dans les deux cas.

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

### Optionnel — les autres providers d'agents

Les agents peuvent aussi tourner sur `codex` (OpenAI), `gemini` (Google) ou
`opencode` (n'importe quel modèle joignable via OpenRouter), au choix par équipe
et par agent. Rien de tout cela n'est requis pour une install standard et rien
ne change dans les étapes ci-dessous — mais deux faits côté hôte décident si ces
providers sont utilisables :

- **L'image ne contient que le CLI Claude Code.** Sous le transport `local` par
  défaut (ce que met en place `examples/docker-compose.dist.yml`), les trois
  autres se déclarent *indisponibles*. C'est le comportement correct, pas une
  erreur de configuration. Ils deviennent utilisables quand le déploiement passe
  au transport **`ssh`**, où le process de l'agent tourne sur l'hôte.
- **Chaque CLI doit être installé *et connecté* sur cet hôte.** swarm-os ne
  contient aucune clé API pour aucun provider ; l'agent hérite des identifiants
  de l'hôte, exactement comme pour Claude Code.

```sh
npm i -g @openai/codex      && codex login    # → ~/.codex/auth.json
npm i -g @google/gemini-cli && gemini         # login OAuth une fois → ~/.gemini/oauth_creds.json
npm i -g opencode-ai                          # pas de login : la clé se saisit dans l'UI
```

`opencode` s'authentifie avec une **clé API OpenRouter**, saisie dans l'UI web
sous **SETTINGS ▸ OPENROUTER** (stockée côté serveur, masquée, appliquée au
prochain spawn d'agent sans redémarrage). Sans elle, opencode apparaît *installé
mais indisponible*.

Un CLI installé sur l'hôte devient sélectionnable au prochain sondage de
disponibilité (60 s) — sans redémarrer le conteneur. Guide complet, avec ce que
chaque CLI sait et ne sait pas exprimer : [../providers.md](../providers.md).

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

Optionnel, et utile uniquement si tu utilises un provider autre que Claude (§1) :

- `SWARM_OS_DEFAULT_PROVIDER` — `claude` (défaut), `codex`, `gemini` ou
  `opencode` ; ce que reçoit une équipe quand ni la requête ni le rôle n'en
  nomme un. Une valeur inconnue arrête le boot au lieu de retomber
  silencieusement sur un défaut. C'est aussi lui qui détermine
  `SWARM_OS_DEFAULT_MODEL` quand celui-ci n'est pas renseigné : le défaut de
  l'instance devient le modèle par défaut *de ce provider*, jamais un
  identifiant claude sur un CLI étranger.
- `SWARM_OS_HOST_CODEX_DIR` / `SWARM_OS_HOST_GEMINI_DIR` /
  `SWARM_OS_HOST_OPENCODE_DIR` — le répertoire d'état de chaque CLI sur l'hôte,
  frères de `SWARM_OS_HOST_CLAUDE_DIR` et nécessaires pour la même raison.
  **À renseigner explicitement sous le transport `ssh`** : leur défaut dérive du
  home du *conteneur* (`/home/node/.codex`…), un chemin qui n'existe pas sur
  l'hôte — les liens symboliques d'identifiants par session pendouillent alors,
  et l'agent échoue sur une erreur d'authentification au premier tour sans que
  rien ne se voie au spawn.
- `SWARM_OS_OPENROUTER_API_KEY` — repli dev/CI uniquement. Le chemin normal est
  **SETTINGS ▸ OPENROUTER** dans l'UI ; une clé enregistrée là gagne toujours.

Comme pour `SWARM_OS_GITHUB_TOKEN`, une variable n'atteint le processus que si
le service compose la nomme dans `environment:` — ce bloc est une liste blanche
explicite (§7.4).

### Le choix qui compte — le transport des agents

`SWARM_OS_AGENT_TRANSPORT` décide **où tourne le process de l'agent**. C'est la
seule variable qui change trois choses à la fois, et l'assistant la pose comme
une vraie question (étape 4) :

| | `local` (défaut) | `ssh` |
|---|---|---|
| Où tourne l'agent | dans le conteneur | sur l'hôte, via `ssh -tt` |
| Providers utilisables | `claude` seul — l'image ne contient que lui | les quatre, avec les logins de l'hôte |
| Mise à jour en un clic | non (`TRANSPORT IS NOT SSH`) | oui |
| `host-exec` des plugins | non | oui |
| Course sur le refresh OAuth | possible (hôte + conteneur écrivent le même fichier) | impossible |
| Ce que ça coûte | rien | une clé SSH lisible par le conteneur, et des agents qui tournent avec les droits de l'utilisateur hôte |

Le transport `ssh` a besoin d'un **overlay compose** en plus du fichier de base :

```sh
docker compose -f examples/docker-compose.dist.yml \
               -f examples/docker-compose.ssh.yml up -d
```

`./install.sh` ajoute ce `-f` tout seul dès que le fichier d'env dit `ssh` — tu
n'as pas à t'en souvenir. L'overlay monte le répertoire de la clé sur
`/host-ssh`, ajoute l'alias `host.docker.internal` et transmet les variables
`SWARM_OS_SSH_*` / `SWARM_OS_HOST_*` (son en-tête documente chacune).

---

## 4. Installer — l'assistant guidé

```sh
./install.sh
```

Sur un hôte sans `.env`, `install.sh` ouvre un **assistant en neuf étapes** : il
pose chaque question, vérifie chaque réponse contre l'hôte, écrit `.env`, puis
déploie. Les valeurs entre `[crochets]` sont des réponses qui marchent — entrée
les accepte. **Rien n'est installé ni écrit sans une confirmation qui nomme la
commande exacte**, et chaque proposition peut être refusée : il reste alors la
voie manuelle décrite dans les sections précédentes.

| # | Étape | Ce qu'elle fait |
|---|---|---|
| 1 | Prérequis | Docker + Compose (propose l'install officielle, le `usermod -aG docker`, le démarrage du daemon) ; CLI claude (`npm i -g`) ; **le login OAuth** — l'assistant lance `claude` pour toi et attend ; crée `~/.claude.json` s'il manque, parce qu'un bind mount vers un fichier absent fait créer un *répertoire* à sa place, et la première session gèle sur le sélecteur de thème |
| 2 | Projet | nom, workspace (le crée, et propose un `git clone` s'il est vide), répertoire d'état, nom du conteneur, port — un port déjà pris est détecté et un port libre proposé ; si `/data` n'appartient pas à l'uid 1000, il propose le `chown` (le conteneur tourne en `node`, uid 1000, et sinon n'écrit pas sa base) |
| 3 | Image | GHCR ou build local. Il **teste le `docker pull` tout de suite** et, s'il échoue, propose le `docker login ghcr.io` en demandant le PAT en saisie masquée |
| 4 | Transport | `local` ou `ssh` (§3). En `ssh` : génère une clé ed25519 dédiée dans son propre répertoire, l'ajoute à `authorized_keys`, teste la connexion **et** vérifie que `claude` est résolu par le *login shell* — l'agent tourne sous `bash -lc`, donc un CLI qui n'existe que dans la branche interactive de `~/.bashrc` lui est invisible |
| 5 | Providers | détecte codex / gemini / opencode, propose l'install et le login de chacun, choisit le provider par défaut parmi ceux réellement présents, et épingle `oauth-personal` si le login Google de gemini est détecté |
| 6 | Accès distant | loopback/tunnel SSH, **Tailscale** (install, `tailscale up`, `tailscale serve`, URL publique déduite du tailnet) ou reverse proxy |
| 7 | Notifs & MAJ | webhook Discord ; PAT GitHub de détection des releases — **testé en direct** contre l'API, donc tu sais immédiatement si c'est 200, 401 ou 404 (le cas « token valide mais aucun accès au dépôt ») |
| 8 | Avancé | modèle et effort par défaut, plafonds d'équipes et de workers, niveau de log, éditeur VS Code. Sautable d'une touche |
| 9 | Revue | récapitulatif complet, secrets masqués, confirmation. L'ancien `.env` est sauvegardé en `.env.backup-<horodatage>`, le nouveau est écrit en 0600 (il contient tes tokens) |

Le déploiement qui suit pulle (ou construit) l'image, lance le conteneur, attend
`/health` **jusqu'à `boot_complete`** — pas seulement le premier 200 —, affiche le
token, puis **ce que l'instance pense de chaque provider**, avec la raison quand
il est indisponible. C'est la question qui suit toujours l'installation ; elle
est répondue avant d'être posée.

### Options

| Commande | Effet |
|---|---|
| `./install.sh` | assistant s'il n'y a pas de `.env` ; sinon un menu : déployer / reconfigurer / quitter |
| `./install.sh --reconfigure` | rejoue l'assistant, tes valeurs actuelles servant de défauts |
| `./install.sh --yes` | aucune question : déploie le `.env` existant (CI, cron, script) |
| `./install.sh --env-file <chemin>` | utilise un autre fichier d'env |

Relance-le après toute modif de `.env`, ou pour passer à un nouveau tag d'image.

> **Équivalent manuel** (si tu préfères ne pas utiliser le script) :
> ```sh
> set -a && source .env && set +a
> docker compose -f examples/docker-compose.dist.yml up -d
> # transport ssh : ajouter -f examples/docker-compose.ssh.yml
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
```

Une seule ligne : l'éditeur VS Code est reverse-proxifié par swarm-os lui-même
sous `/ide`, sur ce port. Accès via `https://<hôte>.<tailnet>.ts.net:8787`. Mets
`SWARM_OS_PUBLIC_URL` dans `.env` à cette URL pour que les liens Discord
résolvent. Aucun port public ouvert. (L'assistant, étape 6, propose de faire tout
ça — jusqu'au nom de tailnet, qu'il lit lui-même.)

### B. Reverse proxy + TLS (domaine public)

Termine le TLS sur Caddy/nginx devant `127.0.0.1:8787`. Exigences :

- le proxy **doit relayer les WebSockets** (le terminal live et le flux d'events
  en dépendent) ;
- **un seul vhost suffit.** L'éditeur VS Code n'a plus de port à exposer :
  `serve-web` écoute en loopback *dans* le conteneur et swarm-os le
  reverse-proxifie sous `/ide` sur le même port, même origine. Ce qui sert l'UI
  sert l'éditeur, sans second certificat ni iframe en HTTP simple.
  `SWARM_OS_IDE_ENABLED=false` le désactive complètement.

Exemple Caddy :

```
swarm.example.com {
    reverse_proxy 127.0.0.1:8787
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
- **Un provider est grisé à la création d'une équipe** — survole-le : la raison
  vient d'une sonde en direct. `not on PATH` signifie que le CLI manque *sur
  l'hôte qui exécute les agents* (§1) ; installe-le et il s'allume en moins de
  60 s, sans redémarrage. Sous le transport `local`, tout sauf `claude` est
  indisponible par construction.
- **Un agent codex/gemini démarre, n'affiche aucune erreur, puis échoue à
  l'authentification** — soit le CLI n'est pas connecté sur l'hôte, soit
  `SWARM_OS_HOST_CODEX_DIR` / `_GEMINI_DIR` n'est pas renseigné et les liens
  d'identifiants par session pointent vers un chemin du conteneur (§3).
- **Une équipe codex/gemini/opencode semble muette et n'affiche jamais
  `waiting`** — c'est attendu : ces CLI n'ont aucun signal « bloqué sur un
  humain », donc `SWARM_OS_COMPACT_ON_WAITING` est sans effet pour elles. Voir
  [../providers.md](../providers.md).
- **Iframe IDE vide** — l'éditeur est servi sous `/ide` sur le port de l'UI
  (aucun port à publier). Vérifie que `SWARM_OS_IDE_ENABLED` n'est pas `false`,
  et que ton reverse proxy relaie bien les WebSockets sous ce chemin.
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
