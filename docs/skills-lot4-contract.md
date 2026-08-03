# Skills — Lot 4a : source `market` (agentskills.io) — contrat HTTP **FIGÉ** (pour Lot 4b web)

Backend livré sur `feat/skills-library`. Ce document fige le contrat que le
worker web (Lot 4b) consomme pour `web/api/client.ts`, le modal d'import et
(optionnellement) un onglet « Marketplace ». Tout est **additif** aux contrats
Lot 1b/2b/3b.

## 0. Réalité d'agentskills.io (investigation Lot 4a, 2026-08-03)

> ⚠️ **`agentskills.io` n'expose AUCUNE API de registre / téléchargement / recherche.**

C'est le site de **spécification** du format ouvert *Agent Skills* + une vitrine
de clients. Un skill = un dossier avec `SKILL.md` (frontmatter YAML + corps),
distribué **par dépôt GitHub** : `SKILL.md` à la racine, ou en mono-repo sous
`skills/<name>/SKILL.md` (vérifié : `github.com/anthropics/skills` contient
`skills/pdf/`, `skills/docx/`, `skills/xlsx/`, …).

**Conséquence de conception** : l'hypothèse du plan (§5.1 « index HTTP → tarball »)
ne correspond pas à la réalité. La source `market` **n'invente pas d'API** : elle
**résout** une référence de skill en **coordonnées git** puis **délègue à la
source `git` existante** (`stage.ts stageGit`, qui gère déjà le `subdir`
mono-repo). Tout reste **data-first** (le fetch final est un `git clone`) ; aucun
code de skill n'est exécuté ; le trust d'un import market reste `community` et le
**gate de revue Lot 3 s'applique** à tout `assets/` exécutable.

## 1. Formats de `ref` acceptés par la source `market`

Un `ref` market est **soit** une coordonnée GitHub, **soit** un nom de skill nu.

| `ref` | Résolution | Réseau |
|---|---|---|
| `owner/repo` | `https://github.com/owner/repo.git` | non |
| `owner/repo/sub/dir` | idem + `subdir=sub/dir` | non |
| `owner/repo@ref` | idem + `ref=<ref>` (branche/tag) | non |
| `owner/repo@ref/sub/dir` | idem + `ref` + `subdir` | non |
| `github:owner/repo` | idem shorthand | non |
| `https://github.com/owner/repo[/tree/<branch>/<subpath>]` | URL web GitHub | non |
| `pdf` (**nom nu**) | endpoint (si configuré) **sinon** catalogue → `{repo, subdir:<prefix>/pdf}` | endpoint seulement |

- Un `ref` avec `://` ou `/` qui **n'est pas** une coordonnée GitHub → **422**
  (« pour un autre hôte git, utilise `source:'git'` »).
- Un nom nu invalide (majuscules, `_`, …) → **422**.
- Un nom nu sans endpoint **ni** catalogue configuré → **422** (message
  d'orientation).

## 2. Configuration (env, dégradation gracieuse)

| Var | Défaut | Rôle |
|---|---|---|
| `SWARM_OS_SKILLS_MARKET_ENDPOINT` | *(vide)* | Base URL d'un registre `name→git` + `/search`. Vide ⇒ **convention seule**. |
| `SWARM_OS_SKILLS_MARKET_CATALOG` | `anthropics/skills` | Dépôt(s) catalogue pour la résolution d'un nom nu (`owner/repo` **ou** url git complète). Vide ⇒ désactive la convention. |
| `SWARM_OS_SKILLS_MARKET_PREFIX` | `skills` | Préfixe de sous-dossier d'un nom nu dans le dépôt catalogue (`skills/<name>`). Vide ⇒ racine. |
| `SWARM_OS_SKILLS_MARKET_TIMEOUT_MS` | `8000` | Timeout réseau des appels endpoint. |

**Le serveur tourne 24/7 et ne crashe JAMAIS** : endpoint absent ⇒ résolution
par coordonnées + convention ; endpoint injoignable ⇒ **502** propre à l'import,
et `search` renvoie `{available:true, results:[], error}`.

## 3. `POST /skills/install` — **généralisé** à `dir | git | npm | market`

> Le contrat MVP « `dir` seulement » (Lot 1b) est **remplacé**. La route accepte
> désormais toutes les sources que l'installer sait traiter depuis Lot 2a — le
> message d'erreur promettait déjà « git/npm/market arrive in a later lot » ;
> c'est ce lot. `upload` reste sur sa route raw (`POST /skills/upload`).

```
POST /skills/install
  { source:'dir',    dir:string }                         → 200 { skill: SkillView }
  { source:'git',    url:string, ref?:string, subdir?:string } → 200 { skill }
  { source:'npm',    spec:string }                        → 200 { skill }
  { source:'market', ref:string }                         → 200 { skill }
  400 { error } body invalide (source inconnue / champ requis manquant/vide)
  422 { error } SKILL.md invalide / ref market non résoluble / traversal
  502 { error } fetch (git/npm/endpoint market) échoué
```

`ref` market = un nom de skill **ou** une coordonnée GitHub (voir §1).
Exemples : `{source:'market', ref:'pdf'}`, `{source:'market', ref:'anthropics/skills/skills/pdf'}`.

## 4. `GET /skills/market/search?q=<texte>` — browse (nouveau)

```
GET /skills/market/search?q=pdf
  200 { available:boolean, results: MarketSearchEntry[], error?:string }
  400 { error }   query ?q= manquante/vide
```

```ts
interface MarketSearchEntry {
  name: string;
  description?: string;
  ref?: string;   // ré-injectable tel quel dans POST /skills/install {source:'market', ref}
}
```

- **`available:false`** ⇒ aucun endpoint configuré : le browse n'est pas
  supporté ; l'UI doit inviter à importer **par coordonnée** (`owner/repo[/subdir]`)
  ou un nom nu résolu par le catalogue. **Ce n'est pas une erreur.**
- **`available:true, error:<msg>`** ⇒ endpoint configuré mais injoignable/invalide
  (non-fatal : afficher un état dégradé, pas une modale d'erreur).
- **Toujours 200** sauf `q` absente (400). Jamais de 5xx.

**Flux UI recommandé (Lot 4b)** : ajouter une source `market` au modal d'import
existant (champ `ref` = « skill name or owner/repo »). Un onglet/section
« Marketplace » n'a de sens que si un endpoint est configuré : conditionner son
affichage à `available` (par ex. un premier `search` à vide, ou un futur
`GET /skills/market` de statut — non fourni en 4a).

## 5. `SkillView` — champs (inchangés, rappel)

Un skill market apparaît avec `sourceKind:'market'`, `sourceRef:<le ref original>`
(pour que `upgrade` re-résolve), `sourceCommit:<HEAD du clone résolu>`,
`trust:'community'`. Les champs Lot 3 (`reviewed`, `reviewRequired`,
`pluginStatus`, `warnings`, `checksum`) sont **identiques** — le gate de revue
s'applique donc à un skill market qui embarque des `assets/` exécutables.

`POST /skills/:name/upgrade` d'un skill market **re-résout** `ref` (récupère le
HEAD courant du dépôt + re-classe le trust sous la politique du moment) ; la
réponse `drift` est inchangée (Lot 3b).

## 6. Ce qui est **différé** (hors Lot 4a)

- **Résolution d'un tarball URL arbitraire** par l'endpoint (l'endpoint doit
  renvoyer des **coordonnées git** en 4a : `{source:'git', url, ref?, subdir?}`).
- **Multi-catalogue avec sondage** : seul le **premier** dépôt catalogue est
  essayé pour un nom nu (pas de probe HTTP `raw` multi-repo).
- **Trust `verified` pour market** : un skill market est toujours `community`
  (importer via `source:'git'` d'un dépôt allowlisté pour obtenir `verified`).
- Skill packs / export-partage / matérialisation `SKILL.md` native / auto-sélection
  par triggers → Lot 5 éventuel.

## 7. Notes d'implémentation (backend, pour info)

- `modules/skills/market.ts` : `resolveMarket(ref, policy, deps) → {url,ref?,subdir?}`,
  `searchMarket(q, policy, deps)`, `marketPolicyFromEnv(env)`. `deps.fetchImpl`
  injectable (tests sans réseau).
- `stage.ts` : variante `{kind:'market', ref}` ajoutée à `SkillInstallSource` ;
  **non stagée ici** — l'installer résout puis appelle `stageGit`.
- `installer.ts` : `case 'market'` (install + upgrade) ; `SkillInstaller.marketSearch(q)`.
- `SkillsSubsystem.marketSearch(q)` ; route `GET /skills/market/search`.
- Tests : `market.test.ts` (résolveur + search, fetch mocké), `installer.test.ts`
  (market end-to-end via un dépôt `file://`), `skills.test.ts` (install
  généralisé + search dégradé).
