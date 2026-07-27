# novelai — accès à l'API NovelAI depuis les agents du swarm

Plugin d'exemple qui expose l'API NovelAI aux agents Claude Code du swarm sous
forme de deux outils MCP. L'agent n'a jamais à manipuler de token, d'URL ni de
format binaire : le token est saisi une fois dans l'UI de configuration du
plugin, et le plugin s'occupe de l'authentification, des timeouts, des retries
et de l'écriture des fichiers audio au bon endroit.

| Outil | Ce qu'il fait |
|---|---|
| `novelai.generate_text` | génère de la prose (**Erato**, **Xialong**, **GLM**) et la retourne dans la réponse ; assemble le contexte d'une histoire |
| `novelai.generate_voice` | synthétise du texte en audio (**TTS**) et **écrit le fichier dans le workspace** |
| `novelai.writing_guide` | retourne la méthode pour écrire une histoire complète (aucun appel réseau) |

**Périmètre v1 : texte + voix uniquement. Pas de génération d'images** — voir
[Repoussé en v2](#repoussé-en-v2).

---

## Prérequis

- Un **abonnement NovelAI actif** (Tablet / Scroll / Opus). Sans abonnement,
  l'API répond `402` et le plugin retourne `code: "payment_required"`.
- **Ni le texte ni la voix ne consomment d'Anlas.** Les Anlas sont la monnaie
  interne de la **génération d'images** ; les endpoints utilisés ici
  (`/ai/generate` et `/ai/generate-voice`) sont couverts par l'abonnement. Il n'y
  a donc aucun garde-fou de quota à configurer en v1.

## Obtenir le token

1. Se connecter sur [novelai.net](https://novelai.net).
2. Menu **Account** → **Get Persistent API Token**.
3. Copier le token et le coller dans le champ **API Token** de la configuration
   du plugin.

> **Un token persistant NovelAI finit par expirer** (NovelAI annonce 30 jours).
> Passé ce délai, tous les appels échouent en `401`.

> ⚠ **Vérifié sur un token réel : la surveillance locale de l'expiration ne
> fonctionne pas.** Les tokens émis aujourd'hui sont de la forme `pst-…`, un
> jeton **opaque** — pas un JWT. Il n'y a donc aucune date à y lire :
> `/status` renvoie `token_expires_at: null` et **l'alerte J-3 ne se déclenche
> jamais.** La détection reste réactive, sur le `401`. Prévoyez une rotation au
> calendrier plutôt que de compter sur l'avertissement.

Le mécanisme est conservé pour les tokens au format JWT, s'il en existe encore :
la date est lue **localement** (aucune requête réseau, aucune dépendance, et le
payload décodé n'est jamais journalisé), affichée sur `/status`
(`token_expires_at`), et une sonde quotidienne prévient à J-3. Quand le token n'a
pas cette forme — le cas normal aujourd'hui — le plugin ne devine rien : pas de
date, et un `hint` sur `/status` le dit explicitement.

## Installation

**1. Déposer le plugin**

Deux chemins possibles :

- **copie de dossier** — copier `examples/plugins/novelai/` dans
  `<DATA_PATH>/plugins/` (c'est-à-dire `/data/plugins/novelai/` vu du
  conteneur), puis déclencher un scan :

  ```bash
  cp -r examples/plugins/novelai ~/.swarm-os/<instance>/plugins/
  curl -s -X POST 127.0.0.1:<port>/plugins/scan -H "X-Auth-Token: $TOKEN"
  ```

  (le bouton **Scan** de la page `#/plugins` fait la même chose) ;
- **installation depuis l'UI** — dialogue **Install** de la page `#/plugins`
  (archive `.tgz`, paquet npm ou dépôt git).

Aucun `npm install` n'est nécessaire : le plugin n'a **aucune dépendance
runtime** (`fetch` natif, ESM pur).

**2. Accorder les capacités**

Sur la fiche du plugin, cocher les six capacités demandées :

| Capacité | À quoi elle sert |
|---|---|
| `mcp-tools` | **indispensable** — c'est ce qui expose les outils aux agents |
| `agent-assets` | copie `GUIDE.md` dans le workspace (`.swarm-plugins/novelai/`) |
| `db-kv` | anti-spam des notifications et throttle du balayage de rétention |
| `http-routes` | route de diagnostic `GET /plugin-api/novelai/status` |
| `notify` | alerte l'opérateur sur `401` (l'alerte d'expiration anticipée ne peut pas se déclencher, voir « Obtenir le token ») |
| `schedule` | sonde quotidienne d'expiration du token |

Seule `mcp-tools` est structurante : si `http-routes` ou `schedule` est refusée,
le plugin s'active quand même et les outils restent disponibles — il perd
seulement le diagnostic ou la sonde.

**3. Coller le token puis cliquer sur Enable.**

### ⚠ Après l'enable, redémarrer ou reprendre la session du lead

Une session d'agent **déjà lancée a mis en cache sa liste d'outils MCP** au
démarrage : elle ne verra pas `novelai.*` tant qu'elle n'est pas redémarrée ou
reprise. Le serveur envoie déjà l'avertissement aux leads des équipes actives
(`packages/server/src/modules/plugins/host.ts:546-570`) :

```
[swarm-os] Plugin 'novelai' MCP tools are now available.
Restart or resume your session to refresh the available tools.
```

### ⚠ Mettre à jour le code du plugin exige un redémarrage du serveur

Le loader n'invalide le cache ESM que sur **`index.js`** : il y ajoute une query
de version (`loader.ts:29-30`), mais `new URL('./lib/nai.js', '…index.js?v=abc')`
**perd cette query**. Les modules de `lib/` restent donc en cache Node d'une
activation à l'autre.

Conséquence : après avoir recopié le dossier, un `scan` + `disable`/`enable` ne
suffit pas si `lib/` a changé. Le nouveau `index.js` est chargé face à
**l'ancien** `lib/`, et un export ajouté depuis produit une erreur d'activation
franche :

```
lastError: "The requested module './lib/tools.js' does not provide an export
            named 'buildGuideToolDef'"
```

La procédure de mise à jour est donc :

```bash
cp -r examples/plugins/novelai ~/.swarm-os/<instance>/plugins/
docker compose -f docker-compose.<instance>.yml restart   # vide le cache ESM
curl -s -X POST 127.0.0.1:<port>/plugins/scan   -H "X-Auth-Token: $TOKEN"
curl -s -X POST 127.0.0.1:<port>/plugins/novelai/enable -H "X-Auth-Token: $TOKEN" \
     -H 'Content-Type: application/json' -d '{"grantedCapabilities":[...]}'
```

Un **rebuild d'image reste inutile** : le plugin est du contenu de
`/data/plugins`, pas du code serveur. Seul le redémarrage compte.

### ⚠ Modifier la configuration interrompt une génération en cours

Le plugin **ne souscrit volontairement pas** à `api.config.onChange`. En
l'absence de souscripteur, tout `PUT` de configuration provoque un
**hot-restart** du plugin (`host.ts:670-681`) : les outils sont retirés puis
réenregistrés, et un appel en vol est perdu.

C'est le comportement voulu — le token et le répertoire de sortie sont lus dans
`activate()`, un rechargement à chaud garantit qu'ils sont à jour. Souscrire à
`onChange` supprimerait ce redémarrage et laisserait une configuration périmée
capturée en closure. Conséquence pratique : **changer la config pendant qu'un
agent génère du texte ou de l'audio interrompt cette génération.**

## Configuration

| Clé | Défaut | Rôle |
|---|---|---|
| `apiToken` | — (**requis**) | token persistant NovelAI, masqué en lecture |
| `textModel` | `llama-3-erato-v1` | modèle texte par défaut — **champ libre**, voir « Modèles » ci-dessous |
| `defaultVoice` | `Aini` | voix TTS par défaut |
| `defaultMaxLength` | `150` | tokens générés par défaut |
| `defaultTemperature` | `1.0` | plus haut = plus créatif et plus instable |
| `outputDir` | `novelai` | dossier de sortie audio, **relatif** à la racine du workspace (un chemin absolu ou contenant `..` est rejeté) |
| `ttsFormat` | `opus` | `opus` produit un OGG/Opus envoyable tel quel comme message vocal Discord ; `mp3` sinon |
| `retentionDays` | `7` | purge des fichiers audio plus vieux que N jours ; `0` = ne jamais purger |
| `requestTimeoutSec` | `45` | délai maximal d'un appel NovelAI |

## Modèles — deux API NovelAI, ensembles disjoints

NovelAI sert le texte par **deux API mutuellement exclusives**, sur le même hôte.
Un modèle envoyé à la mauvaise répond `403` — le même statut qu'un token expiré,
d'où un diagnostic trompeur si le plugin ne le distinguait pas.

| Modèles | API | Endpoint |
|---|---|---|
| `llama-3-erato-v1`, `kayra-v1`, `clio-v1` | historique | `POST /ai/generate` |
| `xialong-v1`, `glm-4-6`, et les suivants | OpenAI-compatible | `POST /oa/v1/completions` |

NovelAI le dit lui-même quand on se trompe :

```
403  model 'xialong-v1' is only available via OpenAI-compatible API
400  Model 'llama-3-erato-v1' not available via OpenAI-compatible API. Use main NovelAI API.
```

**`textModel` est un champ libre, volontairement.** Une liste fermée n'aurait pas
seulement caché les nouveaux modèles : la validation réécrivait silencieusement
une valeur inconnue vers le défaut, donc un opérateur qui saisissait un modèle
valide obtenait Erato **sans aucune erreur**. Désormais un identifiant inconnu
est routé vers l'API OpenAI-compatible (c'est là que NovelAI ajoute ses modèles),
et si le pari est mauvais le plugin **bascule tout seul** sur l'autre API en
lisant le message d'erreur — une table de routage périmée coûte un aller-retour,
pas un outil cassé.

La liste à jour est dans `GET /plugin-api/novelai/status`, champ `models`
(historique en dur + OpenAI-compatible interrogé via `GET /oa/v1/models`).

> **À éviter : `/oa/v1/chat/completions`.** Sans `stream:true` elle répond `200`
> avec `text:""` et un tableau `token_ids[]` brut, sans `message.content` — sept
> paramètres candidats (`use_string`, `skip_special_tokens`,
> `return_token_ids`…) ont été essayés, aucun ne la détokenise. Le plugin utilise
> `/oa/v1/completions`, qui renvoie de la prose.

## Les outils

> **NovelAI continue un texte, il ne répond pas à une consigne.**
> C'est un modèle de **continuation**, pas un chat. Donnez un début de scène, pas
> une instruction.
>
> - ✔ `"The wizard raised his staff and"`
> - ✘ `"Écris-moi une histoire de sorcier"` — le modèle continuera littéralement
>   cette phrase-là.

### `novelai.generate_text`

Le texte est retourné **en ligne** dans la réponse de l'outil. Deux modes, **exclusifs**.

#### Mode histoire (recommandé) — le plugin assemble le contexte

L'API NovelAI n'a pas de champ « instruction » : elle reçoit une seule chaîne et
en écrit la suite. Diriger une histoire, c'est donc placer la direction **dans**
cette chaîne, à l'endroit où elle pèse — juste avant la fin. Plutôt que de
demander à chaque agent de refaire cet assemblage, le plugin le fait :

```jsonc
// appel
{ "story":        "<tout le texte déjà écrit — le plugin garde la fin utile>",
  "memory":       "Elara est archiviste. Cort ment sur son accent.",
  "authors_note": "Elara le confronte. Il ne nie pas. Ton sec.",
  "attg":         "Titre: Le Dernier Messager; Genre: fantasy",
  "opening":      "Elle leva les yeux vers le messager et",
  "max_length":   110 }

// réponse
{ "ok": true,
  "text": " vit à quel point il était pâle...",
  "model": "llama-3-erato-v1",
  "prompt_chars": 1284,
  "context_trimmed": 0,
  "duration_ms": 8412 }
```

| Champ | Rôle |
|---|---|
| `story` | tout le texte déjà écrit ; le plugin garde la fin qui tient dans la fenêtre du modèle et **coupe le début** |
| `memory` | faits permanents, remis en tête à **chaque** appel — sans lui, tout ce qui sort de la fenêtre est oublié |
| `authors_note` | ce qui doit arriver **maintenant**, en une phrase : le levier de direction |
| `attg` | registre global, placé tout en haut |
| `opening` | amorce coupée en plein milieu d'une phrase — un contexte qui finit sur un point invite le modèle à changer de sujet |

Un contexte mal formé n'échoue pas : la réponse porte un tableau `warnings`
expliquant le défaut précis (pas de `memory`, note trop longue, contexte tronqué,
amorce fermée). C'est le canal pédagogique le moins coûteux — il ne dit rien tant
que tout va bien.

La méthode complète est derrière l'outil **`novelai.writing_guide`** et dans
`.swarm-plugins/novelai/GUIDE.md`.

#### Mode brut — vous assemblez

```jsonc
{ "prompt": "The wizard raised his staff and", "max_length": 120 }
```

`prompt` ne peut **pas** être combiné avec les champs structurés : l'appel est
refusé plutôt qu'arbitré silencieusement.

Paramètres communs : `max_length`, `min_length` (≤ `max_length`, ignoré sur les
modèles OpenAI-compatibles), `temperature`, `top_p`, `top_k`,
`repetition_penalty`, `stop_sequences` (≤ 8 chaînes), `model`.

### `novelai.writing_guide`

Sans paramètre, sans appel réseau : retourne la marche à suivre pour écrire une
histoire complète (les 8 étapes, l'ordre du contexte, les 4 erreurs qui font
dérailler un texte long) et le chemin du même guide sur disque.

### `novelai.generate_voice`

Le fichier audio est **écrit dans le workspace** ; l'outil retourne son chemin.

```jsonc
// appel
{ "text": "Bonjour, ceci est un test.", "voice": "Aini" }

// réponse
{ "ok": true,
  "files": [{
    "path": "/home/ubuntu/projets/fyrel/novelai/2026-07-27/143205-bonjour-ceci-a7f3-0.ogg",
    "workspace_relative": "novelai/2026-07-27/143205-bonjour-ceci-a7f3-0.ogg",
    "container_path": "/workspace/novelai/2026-07-27/143205-bonjour-ceci-a7f3-0.ogg",
    "bytes": 18422, "chars": 26 }],
  "voice": "Aini", "format": "opus", "chunks": 1, "duration_ms": 3120 }
```

Trois formes de chemin sont retournées, et **ce n'est pas de la redondance** :

- `path` est résolu dans **l'espace de noms de l'agent** — c'est celui sur lequel
  l'agent fait `Read` ou `ls`. En transport SSH, c'est un chemin **hôte** ;
- `workspace_relative` est la forme **portable**, à utiliser pour passer le
  fichier à un autre outil ou à un autre plugin ;
- `container_path` est le chemin vu **depuis le serveur** — utile aux plugins qui
  tournent dans le conteneur (`discord-agent` par exemple), et au diagnostic.

Paramètres optionnels : `voice`, `seed_mix` (mélange de voix, numérique),
`format` (`opus` / `mp3`), `filename_hint`.

**Découpage** — NovelAI plafonne à environ 1000 caractères par appel. Au-delà, le
texte est découpé sur les frontières de phrases et **plusieurs fichiers ordonnés**
sont retournés dans `files[]` (12 au maximum). Aucune concaténation audio n'est
faite : l'image runtime ne contient pas de ffmpeg.

### Voix disponibles

| | |
|---|---|
| **Féminines** | Ligeia, Aini, Orea, Claea, Lim, Aurae, Naia |
| **Masculines** | Aulon, Elei, Ogma, Raid, Pega, Lam |

## Où atterrissent les fichiers audio

```
<racine du workspace>/<outputDir>/<AAAA-MM-JJ>/<HHMMSS>-<slug>-<rand4>-<i>.<ext>
```

Le suffixe aléatoire évite qu'un fichier soit silencieusement écrasé quand deux
agents génèrent le même texte dans la même seconde. L'extension est déduite du
`Content-Type` de la réponse NovelAI, jamais supposée.

**`.gitignore` automatique.** Le workspace est un dépôt Git bind-monté dans
lequel des agents font des `git add .`. Le plugin crée le dossier de sortie et y
écrit un `.gitignore` contenant `*` s'il est absent — y compris si quelqu'un le
supprime plus tard.

**Rétention : 7 jours** par défaut (`retentionDays`). Le balayage est asynchrone
et limité à une passe par heure ; il ne touche que les `*.ogg`, `*.webm` et
`*.mp3` du dossier résolu, sans suivre les liens symboliques. `retentionDays: 0`
désactive la purge.

## Diagnostic — `GET /plugin-api/novelai/status`

Route **destinée à l'opérateur**, pas aux agents (elle exige le token
d'authentification du serveur) :

```bash
curl -s 127.0.0.1:<port>/plugin-api/novelai/status -H "X-Auth-Token: $TOKEN"
```

Elle retourne `token_set` (un booléen — **jamais** le token),
`token_expires_at`, `text_model`, `output_dir` (chemin agent **et** chemin
conteneur : l'écart entre les deux rend un bug de traduction immédiatement
visible), `queue: {inflight, waiting}`, `last_error`, l'état de l'abonnement, et
une liste de `hints` actionnables.

### Sonde de voix — `?probe=voice`

```bash
curl -s '127.0.0.1:<port>/plugin-api/novelai/status?probe=voice' -H "X-Auth-Token: $TOKEN"
```

La sonde synthétise un même texte court avec **deux voix opposées** (`Aini` et
`Aulon`) et compare les octets produits. **Des fichiers identiques signifient que
le paramètre de voix est ignoré par l'API** — l'audio est valide, la réponse est
un `200`, mais la voix demandée n'est pas respectée.

C'est le seul moyen de détecter ce mode de défaillance : il ne produit aucune
erreur. La documentation publique de l'API NovelAI diverge sur le nom du
paramètre de voix (`voice` en v1, `seed` en v2 portant le nom de la voix) ; le
plugin envoie les deux, et cette sonde vérifie que l'un des deux prend. À relancer
après toute dérive suspecte de l'API. Deux appels TTS, aucun Anlas, déclenchée
uniquement par un humain — jamais sur le chemin chaud.

## Sécurité

- **Le token est stocké en clair** dans la base SQLite de `/data`
  (`plugins.config_json`), qui n'est pas chiffrée. Il est donc **présent dans les
  sauvegardes** de `/data`.
- **Utiliser un token dédié** à cette instance, jamais un token partagé avec
  d'autres usages, et faites-le tourner au calendrier : son expiration n'est
  pas détectable à l'avance.
- Le plugin tourne **in-process, avec les droits du serveur** : il n'y a pas de
  bac à sable. C'est vrai de tous les plugins swarm-os.
- Atténuations en place : masquage `•••` en lecture HTTP de la configuration,
  redaction du champ `apiToken` dans les logs pino, `/status` ne renvoie qu'un
  booléen et une date, et le payload JWT décodé n'est jamais journalisé.

## Codes d'erreur

Un handler ne lève **jamais** d'exception : il retourne `{ ok: false, code,
error, hint }`.

| `code` | Signification |
|---|---|
| `not_configured` | aucun token saisi |
| `unauthorized` | token invalide ou expiré — notifie l'opérateur |
| `payment_required` | abonnement NovelAI requis ou expiré |
| `rate_limited` | trop de requêtes côté compte NovelAI |
| `bad_request` | message NovelAI remonté verbatim (l'API n'est pas documentée publiquement) |
| `wrong_surface` | modèle envoyé à la mauvaise API NovelAI — le plugin rebascule tout seul et ne remonte ce code que si les deux surfaces refusent |
| `upstream` | NovelAI indisponible, déjà réessayé une fois |
| `timeout` | dépassement de `requestTimeoutSec`, **sans retry** |
| `bad_response` | `200` avec un corps inattendu (JSON sans `output` ni `choices[0].text`, HTML de CDN) |
| `tokenized_output` | tokens encodés au lieu de prose (`use_string` non honoré, ou `token_ids[]` sans texte) |
| `oversized` | réponse au-delà du plafond de taille |
| `busy` | file d'attente saturée — **condition normale**, il suffit de réessayer |

Une seule génération à la fois : NovelAI limite la concurrence au niveau du
compte, et sans file série plusieurs workers en parallèle produisent des `429` en
cascade. Un `busy` n'est donc pas une anomalie.

## Repoussé en v2

- **Génération d'images** (`/ai/generate-image`) — la capacité phare de NovelAI :
  seule à consommer des **Anlas**, seule à exiger un lecteur ZIP. Elle
  s'accompagnera d'un garde-fou de quota, des presets de résolution et des
  prompts de personnages v4/v4.5.
- `/ai/upscale`, `/ai/augment-image`, `suggest-tags`.
- `/ai/generate-stream` (streaming SSE).
- Un panneau UI galerie pour parcourir les fichiers générés.
