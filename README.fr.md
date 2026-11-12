# swarm-os

**Faites tourner des équipes persistantes d'agents de code IA sur votre propre machine, et supervisez-les depuis votre téléphone.**

[![Release](https://img.shields.io/github/v/release/Nyyyxius/swarm-os)](https://github.com/Nyyyxius/swarm-os/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Nyyyxius/swarm-os/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyyyxius/swarm-os/actions/workflows/ci.yml)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Fnyyyxius%2Fswarm--os-blue)](https://github.com/Nyyyxius/swarm-os/pkgs/container/swarm-os)

[English](README.md)

swarm-os est une console web auto-hébergée. Elle lance les vrais CLI d'agents (Claude Code, Codex,
Gemini CLI, OpenCode) dans des terminaux sur votre serveur, les regroupe en équipes d'un **lead** et de
plusieurs **workers** qui s'échangent des messages, et vous permet d'observer chaque agent, de lui écrire
et de le piloter depuis un navigateur ou un téléphone.

## Pourquoi swarm-os

- **Vos abonnements, votre machine.** Les agents sont les CLI officiels, connectés avec vos propres
  comptes. swarm-os ne fournit aucune clé d'API ; les appels aux modèles passent par ces CLI.
- **Des équipes qui continuent de tourner.** Équipes, rôles, messages et planifications vivent dans
  SQLite et reviennent après un redémarrage. Les crons envoient du travail planifié aux équipes en cours ;
  Discord vous prévient quand un agent a besoin de vous.
- **Fournisseurs mélangés.** Choisissez le CLI par équipe et par agent : un lead Claude avec des workers
  Codex, c'est possible.
- **Supervision de partout.** Un terminal en direct pour chaque agent, des jauges de coût et de contexte,
  des approbations, le tout dans une application web adaptée au mobile, accessible via Tailscale ou votre
  propre proxy.

swarm-os s'adresse aux développeurs qui utilisent déjà ces CLI et veulent en faire travailler plusieurs
sur un projet pendant des heures, sans rester devant un terminal.

**Ce qui le distingue.** Les sous-agents et équipes d'agents intégrés aux CLI vivent dans une seule
session et s'arrêtent avec elle. Les frameworks d'agents (bibliothèques SDK) vous font écrire la boucle
de l'agent et payer au token d'API. swarm-os ne fait ni l'un ni l'autre : il pilote les CLI interactifs
non modifiés, maintient les équipes en vie comme des processus de longue durée, et ajoute une interface
de supervision par-dessus.

## Fonctionnalités

- **Équipes et rôles** — un lead plus N workers par équipe ; des rôles réutilisables portent prompts,
  modèle, effort, mode de permission et budget ([guide d'utilisation](docs/deploy/usage.fr.md#concepts)).
- **Terminal en direct** — attachez-vous au PTY de n'importe quel agent (xterm.js) et tapez directement,
  sur ordinateur comme sur mobile.
- **Crons d'agents** — des réveils planifiés par rôle, mis en pause, modifiés ou lancés immédiatement
  depuis `#/crons` ; crons script également ([guide d'utilisation](docs/deploy/usage.fr.md#crons),
  [exemple](examples/crons/)).
- **Skills** — importez des Agent Skills (`SKILL.md`) depuis un répertoire, un upload, npm ou git, et
  activez-les par rôle, par équipe ou par agent ([exemple](examples/skills/hello-skill/)).
- **Mémoire partagée** — une base de connaissances à liens wiki que tous les agents lisent et écrivent,
  consultable sur `#/memory` ([notes de conception](docs/memoire-partagee.md)).
- **Tableau de tâches** — des cartes durables par équipe, avec assignations et dépendances, pilotées par
  les agents (`#/board`, [doc](docs/tableau-de-taches.md)).
- **Approbations humaines** — les équipes Claude dans un mode de permission autre que bypass peuvent
  vous demander d'approuver ou de refuser depuis le web ou Discord (`#/approvals`,
  [doc](docs/garde-fous-approbation.md)).
- **Monitoring** — usage du contexte, messages, inbox et compact/clear en un clic par agent ; coût estimé
  par équipe avec budget optionnel par rôle (`#/monitoring`, [doc](docs/monitoring-agents.md)).
- **Auto-compact du contexte** — un lead qui dépasse un seuil de contexte est compacté quand il est
  inactif ([doc](docs/auto-compact.md)).
- **Graphe de code** — un graphe de connaissances du code du workspace, construit hors ligne avec
  Graphify (`#/graph`, [doc](docs/graphify-integration.md)).
- **IDE web** — VS Code dans le navigateur, servi sous `/ide` sur le même port.
- **Plugins** — des modules JavaScript installables qui ajoutent outils MCP, routes, panneaux et
  passerelles de messagerie ([docs/plugins.md](docs/plugins.md), en anglais).
- **Fonctionnalités intégrées désactivables** — graphe de code, monitoring, approbations, tableau,
  mémoire et IDE peuvent être désactivés ou désinstallés à chaud ([doc](docs/builtin-features.md)).
- **Sauvegardes et mises à jour en un clic** — instantanés SQLite à chaud toutes les 6 h ; mise à jour
  depuis l'interface avec le transport `ssh`.

## Démarrage rapide

Il vous faut :

- un hôte Linux x86_64 (arm64 à partir de la release qui suit la 0.10.4) avec Docker et Compose v2 (l'installeur peut installer Docker) ;
- un compte Claude Code avec le CLI `claude` connecté sur cet hôte (l'installeur vous guide) ;
- environ 2 à 4 vCPU et 4 à 8 Go de RAM par équipe active.

Linux :

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
```

Windows (PowerShell, Docker Desktop) :

```powershell
irm https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/install.ps1 | iex
```

La commande Linux télécharge le kit de déploiement dans `~/swarm-os` et lance `install.sh`, un assistant
en neuf étapes (prérequis, chemins du projet, image, transport des agents, fournisseurs, accès distant,
notifications, réglages avancés, récapitulatif). L'installeur Windows compte huit étapes : il utilise
toujours le transport `local` et n'a pas d'étape fournisseurs. Les deux écrivent `.env`, démarrent le
conteneur et affichent l'URL et le token d'accès. Pour lire le script avant de l'exécuter, voir le
[guide d'installation](docs/deploy/install.fr.md).

Ouvrez ensuite `http://127.0.0.1:8787`, collez le token dans le panneau qui s'ouvre, et créez une équipe
avec **New Orchestrator**. Sur un serveur distant, le port est lié au loopback : ouvrez d'abord un tunnel
avec `ssh -L 8787:127.0.0.1:8787 user@host`, ou voyez [Accès distant](#accès-distant).

Plateformes : Linux est le chemin testé. Windows fonctionne via Docker Desktop, avec Claude seulement
(utilisez WSL 2 et `install.sh` pour les autres fournisseurs). macOS n'est pas testé. Les images jusqu'à la 0.10.4
sont `linux/amd64` uniquement ; les releases suivantes fournissent aussi `linux/arm64`. D'ici là, sur
arm64, construisez l'image depuis un clone de ce dépôt.

## Fonctionnement

```
 navigateur / téléphone ── HTTPS (Tailscale, reverse proxy ou tunnel SSH)
        │
        ▼
 ┌─────────────────────── conteneur swarm-os ───────────────────────┐
 │  UI web + REST + WebSocket          127.0.0.1:8787               │
 │  serveur : équipes, rôles, crons, mailbox, SQLite dans /data     │
 │  serveur MCP "team-comms"           loopback :8788               │
 │        │ lance un PTY par agent                                  │
 │        ▼                                                         │
 │  transport local : le CLI claude tourne ici                      │
 └────────┬─────────────────────────────────────────────────────────┘
          │ transport ssh : ssh -tt vers l'hôte (port MCP renvoyé)
          ▼
   compte hôte : claude / codex / gemini / opencode, avec vos connexions
```

Chaque agent communique avec son équipe via des outils MCP (`team.send_message`, `team.read_inbox`,
`team.spawn_worker`, …) ; le serveur remet les messages dans le terminal du destinataire quand il est
inactif.

| Terme | Sens |
|---|---|
| Instance | Un conteneur, un projet (le montage `/workspace`), un opérateur. |
| Équipe | Aussi appelée orchestrateur : un lead qui planifie et décide, plus des workers qui exécutent. |
| Rôle | Un modèle d'équipe réutilisable : prompts, fournisseur, modèle, effort, budget ; les crons ciblent un rôle. |
| Mailbox | La file de messages entre les agents d'une équipe (en mémoire, répliquée dans SQLite). |
| Transport | L'endroit où tournent les CLI : `local` (dans le conteneur) ou `ssh` (sur l'hôte). |

## Fournisseurs d'agents

| CLI | Authentification | Limites |
|---|---|---|
| `claude` (Anthropic) | connexion OAuth `claude` sur l'hôte | Seul CLI présent dans l'image ; fonctionne avec les deux transports. |
| `codex` (OpenAI) | `codex login` sur l'hôte | Transport `ssh` uniquement. |
| `gemini` (Google) | compte Google ou clé d'API sur l'hôte | `ssh` uniquement ; pas de réglage d'effort, pas de jauge de contexte ; jamais testé contre un vrai modèle. |
| `opencode` (OpenRouter) | clé OpenRouter dans SETTINGS ▸ OPENROUTER | `ssh` uniquement ; pas de réglage d'effort ; le passage par OpenRouter n'est pas prouvé de bout en bout. |

`codex`, `gemini` et `opencode` ne signalent jamais d'état « waiting ». Les listes de modèles se mettent
à jour depuis [models.dev](https://models.dev) toutes les 6 h.
Détails : [docs/providers.md](docs/providers.md) (en anglais).

## Configuration

L'installeur écrit `.env` ; on l'édite rarement à la main. Les variables essentielles :

| Variable | Rôle |
|---|---|
| `SWARM_OS_IMAGE` | Image à exécuter, par ex. `ghcr.io/nyyyxius/swarm-os:latest`. |
| `SWARM_OS_PROJECT_NAME` | Nom affiché dans l'interface et les notifications. |
| `WORKSPACE_PATH` | Répertoire hôte du projet sur lequel travaillent les agents. |
| `DATA_PATH` | Répertoire hôte de l'état : base de données, tokens, logs, sauvegardes. |
| `CLAUDE_DIR` | Votre `~/.claude` connecté, monté en lecture seule. |
| `SWARM_OS_PORT` | Port hôte de l'interface (défaut `8787`, lié à `127.0.0.1`). |
| `SWARM_OS_AGENT_TRANSPORT` | `local` (défaut du compose) ou `ssh` (présélectionné par `install.sh` quand un serveur SSH tourne). |
| `SWARM_OS_DISCORD_WEBHOOK_URL` | Notifications Discord, optionnelles. |

Tout le reste est documenté dans [.env.example](.env.example).

## Accès distant

L'interface n'écoute que sur `127.0.0.1` et le conteneur ne fait pas de TLS. Accédez-y via Tailscale
(recommandé pour le téléphone), un reverse proxy qui transmet les WebSockets, ou un tunnel SSH. Voir le
[guide d'installation §6](docs/deploy/install.fr.md#6-accès-distant).

## Sécurité et modèle de confiance

swarm-os donne un shell à des agents IA. Lisez [SECURITY.md](SECURITY.md) (en anglais) avant de
l'exposer. En bref :

- **Le token d'accès donne le contrôle total.** C'est un token statique unique, sans utilisateurs ni
  rôles ; qui le détient peut piloter les agents, installer des plugins et ouvrir l'IDE, ce qui revient à
  exécuter du code sur la machine.
- **Par défaut, les agents tournent sans demande de permission** (`bypassPermissions` pour Claude ;
  Codex, Gemini et OpenCode ne supportent que ce mode). Traitez chaque prompt que vous leur donnez comme
  du code que vous exécutez.
- **Transport `local` :** les agents tournent dans le conteneur, sous son utilisateur non root. Ils
  peuvent lire ce que le serveur lit : le workspace, `/data` (tokens compris) et les variables
  d'environnement du serveur. Le conteneur limite ce qu'ils atteignent sur l'hôte.
- **Transport `ssh` :** les agents tournent **sur l'hôte, sous votre compte utilisateur**, avec tout ce
  que ce compte peut faire. Dans ce mode, le conteneur n'est pas un bac à sable. Utilisez un compte dédié
  si cela compte pour vous. L'installeur Linux présélectionne `ssh` quand un serveur SSH tourne ;
  choisissez `local` à l'étape 4 si vous voulez que le conteneur soit la limite.
- **Bonnes bases :** ports liés au loopback, comparaison du token en temps constant, tickets WebSocket à
  courte durée de vie, MCP sur le loopback, conteneur non root. Les plugins sont du code de confiance,
  pas un bac à sable.

Signalez les vulnérabilités en privé via les
[GitHub security advisories](https://github.com/Nyyyxius/swarm-os/security/advisories/new).

## Plugins

Les plugins sont des modules JavaScript (ESM) chargés dans le serveur, activés ou désactivés depuis
`#/plugins` sans redémarrage. Ils peuvent ajouter des outils MCP pour les agents, des routes HTTP et des
webhooks, des panneaux d'interface, des crons et des connecteurs de messagerie ; l'opérateur accorde
chaque capacité déclarée. Installation depuis un répertoire, un `.tgz`, npm ou git. Des exemples sont
dans [examples/plugins](examples/plugins/) ; le guide est [docs/plugins.md](docs/plugins.md) (en anglais).

## Mise à jour

Relancez `./install.sh` dans le répertoire du kit : il récupère l'image indiquée dans `.env` et recrée
le conteneur ; `/data` est conservé. Avec le transport `ssh`, SETTINGS ▸ SYSTEM UPDATE peut le faire
depuis l'interface, après avoir prévenu les équipes en cours. Voir le
[guide d'installation §7](docs/deploy/install.fr.md#7-mise-à-jour).

## Coût

swarm-os lui-même est gratuit. Les agents consomment vos propres abonnements ou clés d'API, et plusieurs
agents qui travaillent pendant des heures les consomment vite. Les nouvelles équipes démarrent par défaut
sur le Claude Opus le plus récent en effort `xhigh` ; baissez `SWARM_OS_DEFAULT_MODEL` /
`SWARM_OS_DEFAULT_EFFORT` pour des exécutions moins chères et fixez des budgets par rôle.

## Dépannage

- **L'interface se charge mais reste vide, ou chaque appel renvoie 401** — le token manque ou est faux.
  Récupérez-le avec `docker exec <container> cat /data/token` et collez-le à nouveau.
- **Une équipe ne démarre jamais ou une session se fige** — Claude n'est pas connecté sur l'hôte :
  `~/.claude/.credentials.json` doit exister et `CLAUDE_DIR` doit pointer dessus.
- **`EACCES` sur `/data` ou le conteneur redémarre en boucle** — le répertoire de données n'appartient
  pas à l'uid du conteneur (1000 par défaut).
- **Un fournisseur est grisé** — survolez-le pour voir la raison. En `local`, seul `claude` peut tourner.
- **L'IDE ou le terminal reste vide derrière un proxy** — le proxy doit transmettre les WebSockets.

Plus de cas dans le [guide d'installation §8](docs/deploy/install.fr.md#8-dépannage).

## Développement

```sh
pnpm install
pnpm dev     # serveur sur :8787 + Vite sur :5173
pnpm test
```

Node 22+ et pnpm sont nécessaires. Hors conteneur, pointez d'abord `SWARM_OS_DATA_DIR` (défaut `/data`)
et `SWARM_OS_WORKSPACE_ROOT` (défaut `/workspace`) vers des répertoires accessibles en écriture. Lisez
[CONTRIBUTING.md](CONTRIBUTING.md) (en anglais) avant d'ouvrir une pull request.

## État du projet

swarm-os est jeune (version 0.x) et maintenu par une seule personne. Il fait tourner de vraies charges
24 h sur 24, mais attendez-vous à des aspérités et à des changements incompatibles entre versions
mineures. Les changements sont listés dans [CHANGELOG.md](CHANGELOG.md).

## Contribuer

Les issues et pull requests sont les bienvenues. Voir [CONTRIBUTING.md](CONTRIBUTING.md) et le
[code de conduite](CODE_OF_CONDUCT.md).

## Licence

[MIT](LICENSE). L'image Docker contient aussi des outils tiers (Claude Code CLI, VS Code CLI, Graphify,
dépendances npm) sous leurs propres licences.
