# Utiliser l'API Gemini depuis le swarm — mode d'emploi

Ce fichier est la source unique du mode d'emploi. `gemini-api.guide` renvoie
exactement ce texte ; il est aussi copié dans ton workspace quand le plugin est
activé.

## Quel outil pour quel besoin

| Tu veux… | Outil | Ce que tu récupères |
|---|---|---|
| un texte, un avis, du JSON strict, un fait récent | `gemini-api.generate_text` | le texte, dans la réponse |
| **comprendre** une image, un audio, une vidéo, un PDF | `gemini-api.analyze_media` | le texte, dans la réponse |
| une voix qui lit un texte | `gemini-api.text_to_speech` | un fichier `.wav` dans le workspace |
| **créer ou retoucher** une image | `gemini-api.generate_image` | un fichier `.png`/`.jpg` dans le workspace |
| un morceau de musique | `gemini-api.generate_music` | un fichier `.mp3`/`.wav` dans le workspace |
| une vidéo | `gemini-api.generate_video` puis `gemini-api.video_status` | un fichier `.mp4` dans le workspace |
| savoir quels modèles existent | `gemini-api.list_models` | la liste, dans la réponse |

Le piège classique : **`generate_image` crée une image, `analyze_media` en lit
une.** Le premier ne sait pas décrire, le second ne sait pas dessiner.

## Les fichiers générés : trois chemins, un seul à utiliser

Chaque fichier écrit revient sous trois noms :

- **`path`** — résolu dans **ton** espace de noms. C'est celui-là que tu passes à
  `Read`, `ls`, `ffmpeg`, ou à un script. **Utilise celui-ci par défaut.**
- **`workspace_relative`** — la forme portable, relative à la racine du
  workspace. À utiliser pour transmettre le fichier à un autre agent, à un autre
  outil, ou pour l'écrire dans un message.
- **`container_path`** — ce que voit le serveur. Utile uniquement pour
  diagnostiquer.

Les fichiers sont écrits dans `<outputDir>/<AAAA-MM-JJ>/`, ils portent un
`.gitignore` (ils ne polluent pas `git status`), et ils sont **purgés au bout de
quelques jours** (rétention configurée par l'opérateur). Si un média doit
survivre, **copie-le** ailleurs dans le workspace.

## Écrire un prompt d'image

Décris **le résultat voulu**, pas la manipulation.

- ✅ « La même pièce, en fin d'après-midi, lumière rasante par la fenêtre de
  gauche, ambiance chaude. »
- ❌ « Augmente la luminosité de 20 % et mets un filtre orange. »

Une phrase riche bat une liste de mots-clés. Nomme dans l'ordre : le **sujet**,
le **cadrage** (gros plan, plan large, vue de dessus), la **lumière**, le
**style** (photo argentique, aquarelle, rendu 3D, schéma technique), et
l'**ambiance**.

Le texte dans les images est correctement rendu : affiches, schémas légendés,
maquettes d'interface avec de vrais libellés — c'est un usage viable.

**Édition** : passe les images sources dans `input_images` (jusqu'à 14). Avec
plusieurs références, dis explicitement le rôle de chacune : « prends le canapé
de la première image et pose-le dans la pièce de la deuxième ».

Itère : si le résultat est presque bon, relance en décrivant **seulement** ce qui
doit changer, avec l'image précédente en `input_images`.

## Écrire un prompt de vidéo — et ce qu'il coûte

**La vidéo est facturée à la seconde générée. C'est, de loin, l'outil le plus
cher du plugin.** N'en génère jamais en boucle pour « voir ce que ça donne », et
demande confirmation à ton lead ou à l'utilisateur avant une série.

`generate_video` est **asynchrone** : il rend un `job_id` tout de suite, la
génération prend 1 à 6 minutes. Fais autre chose, puis appelle
`gemini-api.video_status(job_id)`. Tant que `status` vaut `running`, rappelle
plus tard. Quand il vaut `done`, le fichier est déjà écrit.

Un bon prompt de plan décrit : le **sujet**, son **action**, le **mouvement de
caméra** (travelling avant, plan fixe, drone qui monte), la **lumière** et
l'**ambiance sonore**. Le son est généré nativement : les dialogues entre
guillemets sont joués. `first_frame` fige la première image — c'est ainsi qu'on
anime une image existante.

## Écrire un prompt de musique

Donne le **genre**, les **instruments**, le **BPM**, la **tonalité** et
l'**ambiance**. Tu peux structurer le morceau avec des balises `[Intro]`,
`[Verse]`, `[Chorus]`, `[Outro]` et des repères de temps `[0:00-0:10]`.

Le modèle « clip » produit environ 30 secondes ; le modèle « pro » un morceau
complet — donc plusieurs minutes d'attente dans un seul appel.

## La voix (TTS)

Le **ton se pilote en langage naturel, dans le texte lui-même** :

> `Dis ceci sur un ton inquiet, en chuchotant : le couloir était vide.`

Plus de 100 langues, détectées automatiquement — le français est correctement
prononcé, tu n'as pas besoin de traduire.

Pour un dialogue : passe `speakers` (2 locuteurs maximum) et préfixe chaque
réplique par le nom déclaré.

```
Joe: Comment ça va aujourd'hui ?
Jane: Pas trop mal, et toi ?
```

Le fichier produit est un **WAV** (24 kHz, mono). Aucun réencodage n'est possible
depuis le plugin — il n'y a pas de ffmpeg dans l'image du serveur.

## Analyser des fichiers

`analyze_media` accepte des **chemins du workspace** (relatifs ou absolus, y
compris ceux que te renvoient les autres outils) et des **URL http(s)**, dont les
URL YouTube.

Formats : images (png, jpeg, webp, heic), audio (wav, mp3, ogg, flac, m4a),
vidéo (mp4, mov, webm), PDF, texte. Les gros fichiers sont téléversés
automatiquement — tu n'as rien à faire.

Sois précis dans la question : « transcris mot à mot », « liste les erreurs
visibles dans cette capture », « extrais le tableau page 3 en JSON ». Avec
`json_schema`, la réponse est du JSON conforme, directement parsable.

## Les codes d'erreur, et quoi en faire

| `code` | Ce qui se passe | Ce que TU fais |
|---|---|---|
| `not_configured` | pas de clé d'API | préviens l'opérateur ; n'insiste pas |
| `unauthorized` / `forbidden` | clé invalide, révoquée ou restreinte | préviens l'opérateur ; n'insiste pas |
| `rate_limited` | quota Google épuisé | attends une minute, puis un seul nouvel essai |
| `busy` | trop d'appels simultanés dans le swarm | réessaie dans quelques secondes |
| `model_not_found` | le modèle n'existe plus | `gemini-api.list_models`, puis repasse un `model` valide |
| `blocked` | filtre de sécurité de Google | reformule ; ne relance pas à l'identique |
| `bad_request` | argument invalide | lis le message : il nomme le paramètre fautif |
| `timeout` | trop long | **regarde d'abord le dossier de sortie** : la génération a pu aboutir |
| `no_output` | réponse vide | réessaie, éventuellement avec un autre modèle |

Règle générale : **un échec `unauthorized`, `forbidden` ou `not_configured` ne se
réessaie pas.** Rien de ce que tu peux faire ne le corrigera ; seul l'opérateur
le peut.

## Bonnes manières dans un swarm

Le quota Google se compte **par minute et par projet** : il est partagé par tous
les agents de toutes les équipes. Le plugin limite déjà le nombre d'appels
simultanés, mais un agent qui lance vingt images d'affilée fait échouer les
autres. Génère ce dont tu as besoin, pas ce que tu pourrais vouloir.
