# gemini-api — l'API Gemini de Google depuis les agents du swarm

Plugin qui expose l'**API Gemini** aux agents du swarm sous forme d'outils MCP.
L'agent n'a jamais à manipuler de clé, d'URL, d'encodage base64 ni de format
binaire : l'opérateur saisit **une seule clé d'API** dans l'UI, et le plugin
s'occupe de l'authentification, des délais, des reprises, du téléversement des
gros fichiers et de l'écriture des médias au bon endroit.

| Outil | Ce qu'il fait |
|---|---|
| `gemini-api.generate_text` | génère du texte, du JSON strict (`json_schema`), avec recherche Google optionnelle |
| `gemini-api.analyze_media` | **VISION** — décrit/lit/transcrit/résume une image, un audio, une vidéo, un PDF |
| `gemini-api.text_to_speech` | synthétise la voix (30 voix, 100+ langues) et **écrit un WAV dans le workspace** |
| `gemini-api.generate_image` | **crée ou édite** une image (Nano Banana) et l'écrit dans le workspace |
| `gemini-api.generate_music` | compose un morceau (Lyria) et l'écrit dans le workspace |
| `gemini-api.generate_video` | lance une génération vidéo (Veo) — **asynchrone**, rend un `job_id` |
| `gemini-api.video_status` | récupère la vidéo terminée et l'écrit dans le workspace |
| `gemini-api.list_models` | liste les modèles réellement disponibles pour cette clé |
| `gemini-api.guide` | renvoie le mode d'emploi complet (aucun appel réseau) |

---

## Prérequis

- Une **clé d'API Gemini**, gratuite à créer sur
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- Le **palier gratuit suffit pour le texte et la vision**, avec des quotas par
  minute et par jour. **L'image, la musique et surtout la vidéo sont payantes** :
  il faut alors activer la facturation sur le projet Google Cloud associé à la
  clé. Sans cela, ces outils répondent `code: "rate_limited"` ou
  `code: "forbidden"`.
- Aucune dépendance runtime : `fetch` natif, ESM pur, aucun `npm install`.

## Obtenir la clé

1. Ouvrir [Google AI Studio](https://aistudio.google.com/apikey) et se
   connecter.
2. **Get API key** → créer une clé (dans un projet existant ou nouveau).
3. Coller la clé dans le champ **Cle d'API Gemini** de la configuration du
   plugin.

> Une clé Gemini **n'expire pas** : elle est révoquée à la main. Il n'y a donc
> pas d'alerte d'expiration à surveiller — contrairement au plugin `novelai` et
> à son token de 30 jours. Ce qui casse silencieusement, en revanche, c'est tout
> ce qu'il y a autour : clé révoquée, facturation suspendue, quota consommé par
> une autre charge, modèle retiré. C'est exactement ce que teste la **sonde
> quotidienne** (voir « Diagnostic »).

**La clé porte la facturation du projet.** Un swarm de huit agents qui génèrent
des vidéos consomme un budget réel. Voir « Ce que ça coûte » plus bas.

## Installation

**1. Déposer le plugin**

- **copie de dossier** — copier `examples/plugins/gemini-api/` dans
  `<DATA_PATH>/plugins/` (soit `/data/plugins/gemini-api/` vu du conteneur),
  puis déclencher un scan :

  ```bash
  cp -r examples/plugins/gemini-api ~/.swarm-os/<instance>/plugins/
  curl -s -X POST 127.0.0.1:<port>/plugins/scan -H "X-Auth-Token: $TOKEN"
  ```

  (le bouton **Scan** de la page `#/plugins` fait la même chose) ;
- **installation depuis l'UI** — dialogue **Install** de la page `#/plugins`
  (archive `.tgz`, paquet npm ou dépôt git).

**2. Accorder les capacités**

| Capacité | À quoi elle sert |
|---|---|
| `mcp-tools` | **indispensable** — c'est ce qui expose les outils aux agents |
| `agent-assets` | copie `GUIDE.md` dans le workspace |
| `db-kv` | suivi des travaux vidéo, throttle du balayage de rétention, anti-spam des notifications |
| `http-routes` | route de diagnostic `GET /plugin-api/gemini-api/status` |
| `notify` | alerte l'opérateur sur clé révoquée / quota épuisé / modèle retiré |
| `schedule` | sonde quotidienne de la clé |

Seule `mcp-tools` est structurante : si `http-routes` ou `schedule` est refusée,
le plugin s'active quand même et les outils restent disponibles — il perd
seulement le diagnostic ou la sonde. **`db-kv` mérite une mention à part** :
sans elle, `generate_video` fonctionne mais ne peut plus retrouver un travail par
`job_id` ; le plugin le dit dans sa réponse et bascule sur le nom d'opération
Google comme clé de reprise.

**3. Coller la clé puis cliquer sur Enable.**

### ⚠ Après l'enable, redémarrer ou reprendre la session du lead

Une session d'agent **déjà lancée a mis en cache sa liste d'outils MCP** au
démarrage : elle ne verra pas `gemini-api.*` tant qu'elle n'est pas redémarrée
ou reprise. Le serveur envoie l'avertissement aux leads des équipes actives.

### ⚠ Mettre à jour le code du plugin exige un redémarrage du serveur

Le loader n'invalide le cache ESM que sur **`index.js`** : il y ajoute une query
de version (`loader.ts:29-30`), mais `new URL('./lib/gemini.js', '…index.js?v=abc')`
**perd cette query**. Les modules de `lib/` restent donc en cache Node d'une
activation à l'autre — un `scan` + `disable`/`enable` ne suffit pas si `lib/` a
changé :

```bash
cp -r examples/plugins/gemini-api ~/.swarm-os/<instance>/plugins/
docker compose -f docker-compose.<instance>.yml restart   # vide le cache ESM
curl -s -X POST 127.0.0.1:<port>/plugins/scan -H "X-Auth-Token: $TOKEN"
```

Un **rebuild d'image reste inutile** : le plugin est du contenu de
`/data/plugins`, pas du code serveur.

### ⚠ Modifier la configuration interrompt une génération en cours

Le plugin **ne souscrit volontairement pas** à `api.config.onChange`. En
l'absence de souscripteur, tout `PUT` de configuration provoque un
**hot-restart** du plugin (`host.ts:670-681`) : les outils sont retirés puis
réenregistrés, et un appel en vol est perdu. C'est le comportement voulu — la
clé, les modèles et le répertoire de sortie sont lus dans `activate()`.

**Exception délibérée : une génération vidéo survit.** Le travail vit chez Google
et son enregistrement vit en KV, donc `video_status` le récupère après le
redémarrage. C'est précisément pourquoi le suivi n'est pas en mémoire.

## Configuration

| Clé | Défaut | Rôle |
|---|---|---|
| `apiKey` | — (**requis**) | clé d'API Gemini, masquée en lecture |
| `textModel` | `gemini-3.7-flash` | modèle texte et analyse multimodale — **liste déroulante**, voir ci-dessous |
| `imageModel` | `gemini-3.1-flash-image` | modèle image (Nano Banana) |
| `ttsModel` | `gemini-3.1-flash-tts-preview` | modèle de synthèse vocale |
| `musicModel` | `lyria-3-clip-preview` | modèle musique (`clip` = 30 s, `pro` = morceau complet) |
| `videoModel` | `veo-3.1-generate-preview` | modèle vidéo |
| `defaultVoice` | `Kore` | voix TTS par défaut |
| `outputDir` | `gemini` | dossier de sortie, **relatif** à la racine du workspace (un chemin absolu ou contenant `..` est rejeté) |
| `retentionDays` | `7` | purge des médias plus vieux que N jours ; `0` = ne jamais purger |
| `requestTimeoutSec` | `120` | délai maximal d'un appel HTTP (borné 10–600) |
| `maxConcurrent` | `2` | appels Gemini simultanés, tous agents confondus (borné 1–8) |

### Les cinq champs de modèle sont des listes déroulantes que le plugin tient à jour

Google renomme et retire des modèles **sans préavis** — `gemini-3.7-flash`,
`gemini-3.1-flash-image` et `lyria-3` sont tous postérieurs à la première
rédaction de ce plugin. Une liste figée dans `plugin.json` serait donc fausse
avant la fin du trimestre ; un champ de saisie libre, lui, laisse recopier un
identifiant périmé d'un billet de blog et n'échoue qu'au premier appel d'agent.

Le plugin **réécrit donc l'`enum` de son propre manifeste** à partir des modèles
que *votre* clé peut réellement appeler. Les champs deviennent des `<select>`
remplis à la source.

**Pourquoi ça marche sans redémarrage :** `GET /plugins/:name` relit
`plugin.json` **depuis le disque à chaque requête**
(`http/routes/plugins.ts:294-305`) — seuls `version` et `api_version` sont en
base. À la prochaine ouverture de la page du plugin, le formulaire est généré à
partir du nouveau schéma. Pas de scan, pas de reload, pas de restart.
`PUT /plugins/:name/config` relit le même fichier, donc validation et rendu ne
peuvent pas diverger.

**Quand la liste est rafraîchie :**

| Déclencheur | Détail |
|---|---|
| 15 s après l'activation | juste après que vous ayez collé la clé et cliqué sur Enable |
| chaque jour à 04:00 UTC | en même temps que la sonde de la clé |
| `GET …/status` | la liste est déjà en main, le rafraîchissement ne coûte rien de plus |
| `gemini-api.list_models` | un agent qui demande la liste rafraîchit la vôtre au passage |

Les appels sont **limités à un toutes les 10 minutes** ; `?refresh=models` sur la
route `/status` force la reconstruction immédiate et retourne le nombre d'entrées
par champ.

**Quatre garde-fous**, chacun correspondant à une panne autrement silencieuse :

1. **Jamais d'`enum` vide.** Le serveur ignore un tableau vide
   (`config-schema.ts:66`) mais **le formulaire web, non**
   (`PluginConfigForm.tsx:44-48`) : il afficherait un `<select>` ne contenant que
   le libellé désactivé, et le champ deviendrait impossible à renseigner. Quand
   un champ n'a aucun candidat, l'`enum` est **retiré** et le champ redevient une
   saisie libre.
2. **La valeur configurée reste toujours sélectionnable**, même retirée par
   Google. `validateConfig` refuse une valeur hors `enum`
   (`config-schema.ts:137-142`) et un `PUT` envoie **tous** les champs : un seul
   identifiant périmé rendrait le formulaire entier insauvegardable — y compris
   pour corriger la clé d'API. Le hint « modèle absent de la liste Google » de
   `/status` continue, lui, de le signaler.
3. **L'écriture est atomique et vérifiée.** Un `plugin.json` tronqué n'est pas un
   défaut cosmétique : `loadManifest` lèverait, le formulaire disparaîtrait, les
   capacités se liraient vides et le prochain enable échouerait. Le nouveau
   manifeste est donc écrit dans un fichier temporaire voisin, relu, reparsé,
   puis seulement renommé par-dessus.
4. **Échouer est toujours une option.** Répertoire en lecture seule, clé absente,
   API injoignable : le manifeste reste intact et les champs restent en saisie
   libre. **Rendre le répertoire du plugin en lecture seule est donc une manière
   supportée de désactiver ce comportement** (une ligne de log le dit, rien ne
   casse).

Les modèles proposés sont ceux que **ce plugin sait piloter**, pas tout ce que
Google sert : les modèles `*-realtime*` / `*-live*` (protocole WebSocket
bidirectionnel) et `imagen-*` (endpoint `:predict`) sont écartés — les proposer
reviendrait à laisser choisir un échec garanti.

Enfin, l'argument `model` des outils MCP **reste libre** : un agent peut toujours
appeler un modèle absent de la liste pour un essai ponctuel.

## Où atterrissent les fichiers

```
<workspace>/<outputDir>/<AAAA-MM-JJ>/<HHMMSS>-<slug>-<rand4>-<index>.<ext>
```

Les 4 caractères aléatoires ne sont pas décoratifs : deux agents générant le même
prompt dans la même seconde s'écraseraient sinon mutuellement.

Un `.gitignore` contenant `*` est créé dans le dossier de sortie : le workspace
est un dépôt Git bind-monté dans lequel les agents font `git add .`, et une vidéo
de 40 Mo n'a rien à y faire.

Chaque fichier est retourné sous **trois chemins**, et ce n'est pas de la
redondance : sous le transport `ssh`, le processus `claude` tourne sur l'**hôte**
tandis que le plugin tourne dans le **conteneur**, si bien qu'un fichier a
légitimement deux noms absolus.

| Champ | Pour qui |
|---|---|
| `path` | l'**agent** — c'est celui que `Read`/`ls` comprennent |
| `workspace_relative` | la forme **portable**, à passer à un autre outil ou agent |
| `container_path` | ce que voit le serveur ; l'écart avec `path` rend un bug de traduction diagnosticable |

### Limites des fichiers joints

| Limite | Valeur | Pourquoi |
|---|---|---|
| fichiers par appel | 16 | au-delà, c'est un bug d'agent, pas un cas d'usage |
| taille d'un fichier | 50 Mo | les octets transitent par le **tas du serveur**, pas par un flux ; l'API accepterait 2 Go, ce processus non |
| inline par fichier | 6 Mo | au-delà, le fichier part par la Files API et revient sous forme d'URI |
| inline cumulé | 12 Mo | l'API plafonne la **requête entière** à 20 Mo, et le base64 gonfle d'un tiers ; dix fichiers de 5 Mo passeraient tous une vérification par fichier |

Un fichier téléversé vit **48 h** chez Google puis disparaît de lui-même ; le
plugin n'en supprime aucun.

## Ce que ça coûte

| Outil | Ordre de grandeur |
|---|---|
| `generate_text`, `analyze_media` | facturé au token ; négligeable, gratuit dans les quotas du palier libre |
| `text_to_speech` | facturé au token audio ; faible |
| `generate_image` | facturé à l'image ; quelques centimes |
| `generate_music` | facturé au morceau |
| `generate_video` | **facturé à la seconde de vidéo — de loin le plus cher** |

Deux garde-fous existent côté plugin, et ils sont volontairement modestes parce
que le seul plafond qui compte est celui de la console Google :

- `maxConcurrent` (défaut **2**) borne les appels simultanés, tous agents
  confondus. Le quota Gemini se compte **par minute et par projet** : cinq
  agents lançant chacun une image produisent des `429` en cascade que les
  reprises aggravent. Au-delà du budget d'attente, un appel reçoit
  `code: "busy"` — une condition normale, jamais une exception.
- Le `GUIDE.md` livré aux agents leur dit explicitement de **demander
  confirmation avant de générer des vidéos en série**.

**Il n'y a pas de plafond de dépense dans ce plugin.** Pour en poser un, utilisez
les quotas et les alertes de budget de votre projet Google Cloud — c'est le seul
endroit où un plafond est réellement opposable.

## Diagnostic — `GET /plugin-api/gemini-api/status`

```bash
curl -s 127.0.0.1:<port>/plugin-api/gemini-api/status -H "X-Auth-Token: $TOKEN" | jq
```

Retourne : la clé **présente ou non** (jamais la clé elle-même — seulement un
booléen et une empreinte `AIza...1234`), les modèles configurés, **la liste des
modèles réellement disponibles**, le dossier de sortie sous ses deux formes, la
file d'attente, les derniers travaux vidéo, la dernière erreur rencontrée par un
agent, et des `hints` en français.

Le hint qui vaut à lui seul la route : **« Modèle configuré absent de la liste
Google »**. C'est la panne la plus fréquente de ce plugin, et elle est visible
ici avant qu'un agent ne la rencontre.

**`?refresh=models`** reconstruit immédiatement les listes déroulantes des cinq
champs de modèle et retourne le nombre d'entrées par champ (voir « Les cinq
champs de modèle… »).

**`?probe=text`** fait un vrai appel d'un token sur le modèle configuré. Il
couvre quatre régressions d'un coup — clé révoquée, quota épuisé, modèle retiré,
API non activée sur le projet — là où vérifier que la clé est non vide n'en
couvre aucune.

La **sonde quotidienne** (04:00 UTC) fait le même appel et notifie l'opérateur
via le notifieur configuré, au plus une fois par heure et par type de problème.

## Sécurité

- **La clé ne sort jamais du serveur.** Elle est masquée en lecture par le
  mécanisme `format: 'password'` du host, envoyée dans un en-tête (jamais dans
  une URL, qui finirait dans les journaux), absente de `/status` et absente des
  journaux.
- **Les chemins des agents sont confinés au workspace.** Le plugin tourne
  in-process avec les droits du serveur : un chemin qui sort du workspace n'est
  pas seulement le mauvais fichier, c'est un fichier **téléversé chez Google**.
  Tout chemin fourni par un agent passe par `toContainerPath`, qui refuse
  `..`, un chemin absolu hors workspace, et un répertoire frère partageant le
  préfixe. La vérification est **lexicale** : un lien symbolique interne au
  workspace pointant à l'extérieur n'est pas détecté (limite documentée,
  identique à celle de `resolveOutputDir`).
- **Tout ce qui est envoyé part chez Google** et peut être retenu selon les
  conditions du palier utilisé. Ne faites pas analyser au plugin des fichiers que
  vous ne confieriez pas à un tiers.

## Codes d'erreur

| `code` | Sens | Qui peut agir |
|---|---|---|
| `not_configured` | pas de clé | l'opérateur |
| `unauthorized` | clé invalide ou révoquée (Google répond **400**, pas 401) | l'opérateur |
| `forbidden` | clé restreinte, API non activée, modèle indisponible dans la région | l'opérateur |
| `rate_limited` | quota par minute ou par jour dépassé | l'opérateur (facturation) / l'agent (attendre) |
| `busy` | `maxConcurrent` atteint dans le swarm | l'agent (réessayer) |
| `model_not_found` | modèle renommé ou retiré | l'opérateur (config) / l'agent (`model`) |
| `blocked` | filtre de sécurité de Google | l'agent (reformuler) |
| `bad_request` | argument invalide ; le message nomme le paramètre | l'agent |
| `not_found` | fichier joint introuvable dans le workspace | l'agent |
| `oversized` | fichier ou réponse au-delà des limites | l'agent |
| `timeout` | délai dépassé — **regarder le dossier de sortie avant de relancer** | l'agent |
| `no_output` | réponse vide sans raison déclarée | l'agent |
| `bad_response` | Google a répondu hors schéma | personne — signaler |
| `generation_failed` | l'opération vidéo a échoué côté Google | l'agent |

## Détails d'implémentation qui ont une raison d'être

**Le WAV est fabriqué ici.** L'API TTS renvoie du **PCM brut** (24 kHz, 16 bits,
mono) sans conteneur. Écrit tel quel dans `out.wav`, le fichier a une taille
plausible, un `200` sur le fil, et **aucun lecteur ne l'ouvre**. Le plugin
inspecte donc les **octets** (`RIFF`, `ID3`, sync MPEG, `OggS`) et n'ajoute
l'en-tête WAV que si nécessaire — la réciproque, envelopper un WAV déjà valide,
est un bug tout aussi silencieux.

**Trois schémas de réponse sont lus.** L'API Interactions est passée de
`outputs[]` à `steps[]` en mai 2026, et `:generateContent` existe toujours. Les
lecteurs acceptent les trois, plus les champs de commodité `output_text` /
`output_image` / `output_audio`. Aucun en-tête `Api-Revision` n'est envoyé :
épingler une révision que le service a déjà retirée est pire que ne rien
envoyer.

**La vidéo est asynchrone parce qu'elle ne peut pas être synchrone.** Veo prend
1 à 6 minutes ; un appel MCP bloquant est abandonné par le client bien avant.
`generate_video` rend donc un `job_id` immédiatement (`wait_seconds` permet de
bloquer volontairement, borné à 240 s), et la vidéo est **streamée directement
sur le disque**, jamais bufferisée : ce code tourne dans le processus qui sert
les WebSockets de toutes les équipes.

**Un échec de téléchargement ne marque pas le travail comme échoué.** La vidéo
existe chez Google et a déjà été facturée ; le travail reste `running` pour qu'un
appel ultérieur la récupère.

## Périmètre de la v1

Volontairement **hors périmètre**, faute d'un usage clair dans un swarm :

- **les embeddings** — un vecteur de 3072 flottants rendu à un agent ne lui sert
  à rien ; utile seulement adossé à une base vectorielle, qui n'existe pas ici ;
- **le streaming** (`stream: true`) — un outil MCP rend une valeur, pas un flux ;
- **l'API Live** (audio bidirectionnel temps réel) — c'est un connecteur de canal,
  pas un outil : le précédent est `examples/plugins/discord-agent/` ;
- **le maintien d'une conversation** (`previous_interaction_id`) — l'agent EST
  déjà la mémoire de la conversation ;
- **la suppression des fichiers téléversés** — Google les purge après 48 h.

## Tests

```bash
pnpm test -- examples/plugins/gemini-api
```

193 tests, sans réseau : `fetch` est simulé. Ils couvrent le confinement des
chemins, l'enveloppe WAV dans les deux sens, les trois schémas de réponse, la
cartographie des erreurs (dont le 400 qui veut dire « clé invalide »), le
sémaphore et le budget d'attente, le cycle de vie complet d'un travail vidéo, la
réécriture du manifeste (y compris sur un répertoire en lecture seule), et le
fait qu'**aucun handler ne lève jamais d'exception** — parce qu'une exception
compte pour la mise en quarantaine du plugin.

Les tests d'intégration chargent le plugin depuis une **copie** du répertoire,
comme en production — et parce que le plugin réécrit son propre `plugin.json` :
les faire pointer sur l'arbre du dépôt rendrait la suite salissante pour le
dépôt lui-même.
