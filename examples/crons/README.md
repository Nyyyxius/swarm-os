# Crons `script` — exemples

Un cron swarm-os a deux actions possibles (`#/crons` dans l'UI) :

- **`message`** — livrer un template dans l'inbox du lead à chaque tick ;
- **`script`** — exécuter un script dans le conteneur ; **c'est le script qui
  décide** s'il faut réveiller l'agent, et avec quel message.

Ce dossier documente la seconde et en donne un exemple complet :
[`jira_dev.py`](jira_dev.py) — réveille une équipe quand Jira a des tickets
« À développer » en attente.

---

## Le contrat de sortie

Le serveur lit **la dernière ligne non vide de stdout**, et rien d'autre :

| Sortie | Effet |
|---|---|
| `{"wake": true, "message": "…"}` | `message` est livré au lead de **chaque instance vivante** du rôle visé, avec `from = cron:<nom-du-cron>` |
| `{"wake": true}` (sans `message`) | réveil avec un message par défaut `[cron:<nom>] wake requested` |
| `{"wake": false}` | rien ne se passe, aucun agent n'est dérangé |
| exit ≠ 0, dernière ligne illisible, timeout | run `error`, aucun réveil |

Conséquences pratiques :

- **Les logs de progression vont sur stderr.** stdout ne porte que la décision.
  (Ce n'est pas une obligation stricte — seule la *dernière* ligne compte —
  mais c'est la règle qui évite les surprises.)
- Un run qui casse le contrat est **visible**, pas silencieux : il apparaît en
  `error` dans LAST RUNS avec un extrait de sortie (2 000 octets max).
- Aucune instance vivante du rôle au moment du tir → run `noop`. Un cron ne
  redémarre pas une équipe éteinte.
- Si un run est encore en vol au tick suivant, le tick est **sauté** et
  enregistré en `overlap` — un script systématiquement plus lent que sa cadence
  se voit dans l'historique.

---

## L'environnement fourni par le runner

L'env est une **allowlist explicite**, construite à partir de rien : ni token
serveur, ni clé provider n'y entrent (un script opérateur n'a pas besoin des
secrets de l'instance, et un script compromis ne doit pas les récupérer).

| Variable | Contenu |
|---|---|
| `SWARM_OS_CRON_ID` | id du cron tiré (`cron_3f9a1c04`) |
| `SWARM_OS_CRON_NAME` | son slug unique (`jira-dev`) |
| `SWARM_OS_FIRE` | instant du tir, ISO-8601 UTC |
| `HOME`, `PATH` | `PATH` inclut `$HOME/.local/bin`, où vit `uv` |
| `LANG`, `LC_ALL` | `C.UTF-8` — sinon python3 écrit en `ascii` et meurt sur le premier accent |
| `TZ` | la timezone `SWARM_OS_SCHEDULE_TZ` du serveur, celle qui évalue la cadence |
| `UV_CACHE_DIR` | `<dataDir>/crons/uv-cache` (voir « avec des dépendances ») |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (+ minuscules) | recopiées **si** le déploiement les définit |

Autres faits d'exécution :

- **cwd = le dossier du script** — un script peut lire ses fichiers de données
  par chemin relatif.
- **argv fixe** : `[interpréteur, chemin réel du script, ...args]`. Pas de
  shell, donc pas d'expansion de glob ni de `|` dans les arguments.
- **Interpréteur explicite**, à choisir dans `python3 | bash | node`. Il n'y a
  pas de repli « fichier exécutable » : le bit `+x` d'un fichier créé dans le
  conteneur ou monté depuis l'hôte n'est pas fiable, et l'UI n'offre pas de
  `chmod`.
- **Timeout dur** — 60 s par défaut, 240 s au maximum. Au dépassement, c'est
  tout le **groupe de processus** qui est tué : un petit-fils (`uv run`, un
  `curl`…) ne survit pas au timeout de son parent.

---

## Où poser le script

Le chemin saisi dans l'UI est un chemin **conteneur**, et il doit vivre sous
l'une des deux racines autorisées :

| Racine conteneur | Qui écrit dedans | Verdict |
|---|---|---|
| `/workspace` | **les agents** | à éviter pour tout ce qui porte un secret |
| `/data` | l'opérateur seul | **recommandé** — `/data/crons/` |

C'est le point important de cette page. Un agent qui écrit `/workspace` peut
réécrire un script de cron qui s'y trouve, et obtenir ainsi une exécution
récurrente **hors supervision de session** : ni budget, ni approvals, ni
console. Poser les scripts sensibles — et *a fortiori* leurs fichiers de
config — sous `/data/crons/` supprime ce chemin d'attaque.

Les symlinks qui sortent des deux racines sont refusés, à la création **et** à
chaque exécution (une vérification faite une seule fois ne serait pas une
propriété de sécurité).

> Sous le transport `ssh`, l'UI accepte aussi un chemin relatif au workspace,
> qu'elle préfixe pour toi. Attention : les agents, eux, affichent des chemins
> **hôte** — `/home/toi/projet/x.py` côté agent, c'est `/workspace/x.py` ici.

---

## L'exemple : `jira_dev.py`

Stdlib uniquement (`urllib`), donc il tourne sous le `python3` nu de l'image.

```
CRON NAME     jira-dev
SCHEDULE      */15 8-19 * * 1-5      (toutes les 15 min, en semaine, 8h→19h)
ROLE          <ton rôle dev>
ACTION        SCRIPT
SCRIPT PATH   /data/crons/jira_dev.py
INTERPRETER   python3
TIMEOUT (S)   60
```

Les identifiants ne sont **jamais** en dur dans le script ni passés par l'env :
ils sont lus dans un fichier JSON, `/data/crons/jira_dev.json` par défaut
(surchargeable par `JIRA_DEV_CONFIG`, un chemin conteneur lui aussi).

```jsonc
{
  "baseUrl":  "https://acme.atlassian.net",
  "email":    "toi@acme.com",
  "apiToken": "<token API Atlassian>",
  "project":  "DEV",
  "status":   "À développer",
  "maxResults": 20,
  "timeoutSeconds": 20
}
```

- `jql` remplace `project` + `status` pour toute recherche plus élaborée.
- `searchPath` (défaut `/rest/api/3/search/jql`) est l'échappatoire pour Jira
  Server / Data Center, dont l'endpoint est `/rest/api/2/search`.
- Pose le fichier en `chmod 600` : il porte un token.

Le script sort `{"wake": true, "message": "3 tickets à développer: DEV-1,
DEV-2, DEV-3"}` s'il y a des tickets, `{"wake": false}` sinon. Il sort en
erreur avec un message stderr explicite si la config manque (`exit 2`) ou si
Jira ne répond pas / répond 401 / 404 (`exit 1`).

---

## Avec des dépendances (`uv`)

L'image porte `python3` (3.11), `uv` et `node` — **mais pas `pip`**. Pour un
script qui veut `requests`, la voie est `uv run --with`.

L'interpréteur du cron étant restreint à `python3 | bash | node`, on ne peut
pas mettre `uv` en argv[0] : on passe par un petit wrapper `bash`.

```bash
#!/usr/bin/env bash
# /data/crons/jira_dev_uv.sh   —   INTERPRETER: bash
set -euo pipefail
exec uv run --with requests /data/crons/jira_dev_requests.py "$@"
```

`exec` n'est pas décoratif : il remplace le shell par `uv`, donc stdout et
stderr passent tels quels et le code de sortie est celui du script Python.

À propos du cache : `UV_CACHE_DIR` est **déjà positionné par le runner** sur
`<dataDir>/crons/uv-cache`, et le dossier est créé au premier run. Sans ça,
`uv run --with requests` retéléchargerait ses paquets à *chaque* tick — le
cache par défaut d'uv vit dans la couche éphémère du conteneur. Il n'y a donc
rien à configurer, mais prévois un timeout confortable pour le **premier**
tir, celui qui remplit le cache.

`uv` écrit sa résolution et ses installs sur stderr, pas sur stdout. Et de
toute façon seule la **dernière** ligne non vide de stdout est lue : tant que
ton script imprime sa décision en dernier, un bavardage antérieur est sans
conséquence.

---

## Tester

1. Copie le script (et sa config) sous `/data/crons/` dans le conteneur.
2. Crée le cron dans `#/crons` → **+ NEW CRON**, action **SCRIPT**. Le chemin
   est vérifié dès la création : un chemin hors des racines autorisées est
   refusé dans le formulaire, pas trois heures plus tard dans l'historique.
3. **PAUSE** le cron le temps de la mise au point — un cron en pause reste
   tirable à la main.
4. **RUN NOW** dans l'en-tête du détail. La réponse est immédiate (202) et
   **asynchrone** : le résultat n'est pas dans le bouton, il arrive dans
   **LAST RUNS** au rafraîchissement suivant.
5. Lis **LAST RUNS** : issue (`wake` / `skip` / `noop` / `overlap` / `error`),
   code de sortie, durée, destinataires du réveil, et l'extrait de sortie
   tronqué. C'est là que se lit un contrat cassé.
6. Quand c'est bon, **RESUME**.

En local, avant même de toucher à l'UI, un script se teste comme n'importe quel
programme — il suffit de lui donner l'env que le runner lui donnerait :

```sh
SWARM_OS_CRON_ID=cron_test \
SWARM_OS_CRON_NAME=jira-dev \
SWARM_OS_FIRE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
JIRA_DEV_CONFIG=/data/crons/jira_dev.json \
python3 /data/crons/jira_dev.py
```

La dernière ligne affichée est exactement ce que le serveur lira.

---

## Sécurité, dit franchement

Cette fonctionnalité donne à quiconque possède le `X-Auth-Token` l'exécution de
code arbitraire **dans le conteneur**. C'est le niveau de pouvoir que ce token
donne déjà par ailleurs (créer une équipe `bypassPermissions` sur `/workspace`
exécute aussi du code arbitraire) — mais le dire évite de le découvrir.

La recommandation `/data/crons/` ci-dessus est le seul garde-fou qui distingue
un script de cron d'un script que les agents peuvent réécrire. Utilise-la.

Détail du modèle et des décisions : [`docs/crons-agents.md`](../../docs/crons-agents.md).
