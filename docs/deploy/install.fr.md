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

- `SWARM_OS_IMAGE` — le tag que tu viens de puller.
- `WORKSPACE_PATH` — le projet sur lequel les agents travaillent.
- `DATA_PATH` — où l'état persistant est stocké.
- `CLAUDE_DIR` — ton `~/.claude` (défaut correct sur une install standard).
- `SWARM_OS_PROJECT_NAME` — un libellé pour l'UI / les logs / Discord.

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

```sh
# change le tag dans .env (ou garde :latest), puis :
./install.sh        # pull + recrée le conteneur ; /data (DB, tokens, équipes) persiste
```

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
- **Logs** — `docker compose -f examples/docker-compose.dist.yml logs -f`.

Voir aussi : [usage.fr.md](usage.fr.md).
