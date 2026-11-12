# Skills — Lot 3a : contrat HTTP trust/review **FIGÉ** (pour Lot 3b web)

Backend livré sur `feat/skills-library`. Ce document fige le contrat que le
worker web (Lot 3b) consomme pour `web/api/client.ts`, la page `#/skills` et le
`SkillReviewDialog`. Tout est **additif** au contrat Lot 1b/2b.

## 1. `SkillView` — champs AJOUTÉS (les champs Lot 1b/2b restent inchangés)

```ts
interface SkillView {
  // … champs existants (name, version, trust, requires, assetsPresent, checksum, sourceCommit, …)
  reviewed: boolean;          // un opérateur a explicitement revu ce skill risqué
  reviewRequired: boolean;    // activation gatée tant que non revu (voir §4)
  pluginStatus: Array<{ name: string; installed: boolean; enabled: boolean }>;
  warnings: string[];         // messages non-fatals (plugin manquant/désactivé, revue requise)
}
```

`trust` ∈ `first-party | verified | community | local`. Badge suggéré :
first-party/verified = « vérifié » (vert), community = neutre, local = « local ».

## 2. Modèle trust (rappel, backend)

| trust | source | activation d'un skill **risqué** |
|---|---|---|
| `first-party` | allowlist `SWARM_OS_SKILLS_FIRST_PARTY` (git/npm) | **sans revue** |
| `verified` | allowlist `SWARM_OS_SKILLS_VERIFIED` (git/npm) | **sans revue** |
| `community` (défaut) | git/npm/upload/market non-allowlisté | **revue requise** |
| `local` | source `dir` (fs opérateur) | **revue requise** |

**Risqué** = `assetsPresent === true` **OU** `requires.capabilities` non vide.
Un skill non-risqué (instructions seules) n'est **jamais** gaté.

## 3. Endpoints AJOUTÉS

```
GET  /skills/:name/review
     → 200 { review: SkillReviewInfo } | 404
POST /skills/:name/review        { reviewed: boolean }
     → 200 { name, reviewed } | 400 (body invalide) | 404
GET  /skills/:name/asset?path=<rel>
     → 200 { asset: SkillAssetContent } | 400 (path manquant) | 404 (skill ou asset absent / traversal refusé)
```

```ts
interface SkillReviewInfo {
  name; version; trust; checksum: string | null;
  reviewed: boolean; reviewRequired: boolean;
  requires: { plugins: string[]; capabilities: string[] };
  pluginStatus: Array<{ name; installed; enabled }>;
  warnings: string[];
  assets: Array<{ path: string; size: number; executable: boolean; isText: boolean }>;
}
interface SkillAssetContent {
  path; size; executable; isText;
  content: string;   // UTF-8, plafonné à 256 KiB ; vide si binaire
  truncated: boolean;
  binary: boolean;
}
```

## 4. Gate d'activation (endpoints EXISTANTS étendus)

`POST /skills/:name/activate` accepte désormais `reviewed?: boolean` dans le body
(en plus de `scope?`, `orchestratorId`, `sessionId?`).

- Skill non gaté → **200** `{ name, scope, found, persisted, injected }` (inchangé).
- Skill gaté (`reviewRequired`) **sans** `reviewed:true` →
  **409** `{ error, code: "REVIEW_REQUIRED", review: SkillReviewInfo }`.
- Skill gaté **avec** `reviewed:true` → enregistre la revue **et** active → **200**.

`deactivate` n'est **jamais** gaté.

**Flux UI recommandé** : au 409 `REVIEW_REQUIRED`, ouvrir le `SkillReviewDialog`
avec `body.review` (liste + contenu des assets via `GET /asset`), puis soit
`POST /review {reviewed:true}` puis ré-`activate`, soit `activate {reviewed:true}`
directement.

## 5. Re-import / diff — `POST /skills/:name/upgrade`

Réponse enrichie (additif) :
```
200 { skill: SkillView, drift: { checksumChanged: boolean; previousChecksum: string|null; previousBody: string|null } }
```
`previousBody` alimente le diff SKILL.md (le composant diff de Lot 2b). Le
`checksum` est désormais un **hash de l'arbre entier** (SKILL.md + assets), donc
tout changement d'un script `assets/` fait `checksumChanged:true` **et réinitialise
`reviewed`** (l'opérateur doit re-valider un contenu modifié).

## 6. Notes d'activation par rôle

La portée `role` via `PATCH /roles {skills:[…]}` (RoleDialog) n'est PAS gatée par
la route roles elle-même. Recommandation web : masquer/désactiver dans le
multiselect les skills `reviewRequired:true` (badge « revue requise »), ou router
leur ajout via `POST /skills/:name/activate {scope:'role', reviewed:true}` après
passage dans le `SkillReviewDialog`. Filet de sécurité backend : les **assets**
d'un skill risqué non-revu ne sont **pas** stagés au spawn même si ajoutés au rôle
(seul le corps d'instructions s'injecte) — donc pas de fuite de code exécutable.

## 7. MCP (pour info, pas web)

`skills.activate` accepte `reviewed?: boolean` ; sans revue sur un skill gaté →
erreur `REVIEW_REQUIRED`. `skills.list`/`skills.show` renvoient les nouveaux
champs `SkillView`.
