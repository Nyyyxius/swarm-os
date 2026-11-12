# Skills — Lot 5a : export & packs — contrat HTTP **FIGÉ** (pour Lot 5b web)

Backend livré sur `feat/skills-library`. Ce document fige le contrat que le
worker web (Lot 5b) consomme pour `web/api/client.ts`, les boutons **Export**
(un skill), **Export pack** (sélection multiple) et **Import pack**. Tout est
**additif** aux contrats Lot 1b/2b/3b/4x — aucune route existante ne change.

Symétrie de l'import : l'export permet de **sortir** un ou plusieurs skills pour
les partager, et le pack d'en **réimporter** un lot d'un coup. Comme le reste du
sous-système, c'est **data-first** : l'export n'exécute **aucun** code de skill,
et l'import de pack passe par le **même chemin installer** que les autres sources
(donc le **gate de revue Lot 3 s'applique par skill**).

## 0. Format d'échange `.tgz`

| Artefact | Layout de l'archive | Réimport |
|---|---|---|
| **Skill unique** (`GET …/export`) | **un seul** dossier racine `<name>/` : `<name>/SKILL.md` (+ `<name>/assets/…`) | via `POST /skills/upload` (`tar --strip-components=1` restitue `SKILL.md` à la racine) |
| **Pack** (`POST /skills/pack/export`) | **plat** : `pack.json` à la racine + un dossier `<name>/` par skill (`<name>/SKILL.md` + `<name>/assets/…`) | via `POST /skills/pack/install` (extraction verbatim, **sans** strip) |

- **Round-trip garanti** : l'archive d'un skill unique se réimporte proprement
  par `POST /skills/upload` (même `SKILL.md`, mêmes `assets/`, **même checksum**
  d'arbre).
- **`pack.json`** (manifeste racine, informatif — l'install se fait en scannant
  les dossiers `<name>/SKILL.md`, pas en lisant `pack.json`) :
  ```jsonc
  { "version": 1,
    "skills": [ { "name": "pdf", "description": "…", "trust": "community" }, … ] }
  ```

## 1. `GET /skills/:name/export` — exporter un skill

```
GET /skills/hello-skill/export
  200 application/gzip
      Content-Disposition: attachment; filename="<name>.tgz"
      corps = .tgz (dossier racine <name>/, ré-importable par POST /skills/upload)
  404 { error }   skill inconnu
```

- Exporter un skill qui embarque des `assets/` **exécutables** est **autorisé**
  (l'export n'active rien, ne stage rien dans un workspace d'agent).
- **Flux UI (5b)** : un bouton « Export » par ligne de skill → déclenche un
  téléchargement de `<name>.tgz` (un simple `window.location = …/export` ou un
  `fetch` → `blob` → download suffit).

## 2. `POST /skills/pack/export` — exporter plusieurs skills (pack)

```
POST /skills/pack/export
  Content-Type: application/json
  { "names": ["pdf", "docx", …] }        // ≥ 1 nom

  200 application/gzip
      Content-Disposition: attachment; filename="skills-pack-<N>.tgz"   (N = nb inclus)
      X-Skills-Pack-Included: pdf,docx        // noms RÉELLEMENT inclus (noms de skills validés → sûrs)
      X-Skills-Pack-Skipped-Count: 1          // nb de noms demandés introuvables (ignorés)
      corps = .tgz pack (pack.json + <name>/… , cf. §0)
  400 { error }   `names` absent / vide / non-tableau, OU aucun nom valide (tous inconnus)
```

- **Noms inconnus ignorés** (pas d'erreur) tant qu'**au moins un** est valide ;
  `400` **seulement** si aucun ne résout. Les inconnus sont comptés dans
  `X-Skills-Pack-Skipped-Count` (jamais ré-émis en clair dans un header, pour
  éviter toute injection d'en-tête via une entrée utilisateur).
- Doublons dédupliqués. `trust`/`description` de chaque skill sont recopiés dans
  `pack.json`.
- **Flux UI (5b)** : cases à cocher / sélection multiple dans la liste des skills
  → bouton « Export pack (N) » → POST `{names}` → download du blob.

## 3. `POST /skills/pack/install` — installer un pack

```
POST /skills/pack/install
  Content-Type: application/gzip        // .tgz brut, comme POST /skills/upload (PAS multipart)
  corps = .tgz pack

  200 { installed: SkillView[], errors: [ { name, error } ] }
  415 { error, code:'UNSUPPORTED_MEDIA_TYPE' }   corps vide / pas un buffer
  422 { error }   archive corrompue / illisible / chemin non sûr (traversal) / pas un pack
```

```ts
interface PackInstallResponse {
  installed: SkillView[];                 // skills installés (forme SkillView Lot 3, inchangée)
  errors: { name: string; error: string }[]; // échecs PAR skill (nom = dossier du pack)
}
```

- **Succès partiel autorisé** : un skill KO (SKILL.md invalide, nom réservé, …)
  n'annule **pas** les autres — il apparaît dans `errors`, les autres dans
  `installed`. Réponse **200** dès que l'archive est un pack lisible et sûr.
- **Détection de pack** : présence d'au moins un `<dir>/SKILL.md` à la racine de
  l'archive (`pack.json` est advisory, pas requis). Un `.tgz` de skill **unique**
  (dossier racine `<name>/SKILL.md`) est donc aussi accepté ici et installé comme
  un membre — mais l'UI orientera plutôt un skill unique vers `POST /skills/upload`.
- **Trust par membre = comme un upload** : chaque membre est installé via le
  chemin **upload** → `source_kind:'upload'`, `trust:'community'`, et le
  **gate de revue Lot 3** s'applique par skill (un membre avec `assets/`
  exécutables devra être revu avant activation — l'install réussit, l'activation
  reste gatée).
- **Jamais de 5xx** : une archive corrompue/illisible, un chemin non sûr
  (absolu ou `..`), ou une archive qui n'est pas un pack → **422** propre (pas de
  crash). Les échecs par-skill → `errors`, réponse 200.
- **Flux UI (5b)** : bouton « Import pack » → sélection d'un `.tgz` → POST brut
  (`Content-Type: application/gzip`, comme l'upload d'un skill) → afficher
  `installed` (toast/liste) + `errors` (par skill).

## 4. Configuration & bornes

| Élément | Valeur | Note |
|---|---|---|
| Limite corps `POST /skills/pack/install` | **100 MB** | Plus haute que l'upload d'un skill (25 MB) car un pack agrège plusieurs skills. |
| Limite corps `POST /skills/upload` (round-trip d'un skill) | 25 MB (inchangé) | L'export d'un skill unique doit donc rester < 25 MB pour se réimporter par upload. |
| Types acceptés (pack install) | `application/gzip`, `application/octet-stream` | Identique à `POST /skills/upload`. |

## 5. Sécurité

- **Aucun code exécuté** : export = `tar` de fichiers ; install de pack =
  `tar -x` + parse `SKILL.md` (data-first). Pas de `npm install`, pas d'`import()`.
- **Garde traversal** : avant extraction, la liste des membres de l'archive
  (`tar -tzf`) est vérifiée — tout chemin **absolu** ou contenant `..` → **422**.
  Défense en profondeur au-dessus du comportement par défaut de `tar`.
- **Gate de revue Lot 3 conservé** : un skill de pack qui embarque des `assets/`
  exécutables s'installe mais **son activation reste gatée** (`reviewRequired`
  dans `SkillView`) jusqu'à revue explicite par l'opérateur.

## 6. Notes d'implémentation (backend, pour info)

- `install-core/fetch.ts` : primitives tar pures partagées —
  `createTgz` (dossier unique → nid `<top>/`), `createTgzDir` (contenu → racine),
  `extractTgzFlat` (extraction verbatim), `listTgzEntries`, `firstUnsafeTarEntry`
  (garde traversal). Mêmes `tar`/`gzip` que l'upload.
- `modules/skills/installer.ts` : `exportSkill(name) → Buffer`,
  `exportPack(names) → { tgz, included, skipped }`, `installPack(tgz) →
  { installed: SkillRow[], errors }`. `EmptyPackError` (→400),
  `PACK_MANIFEST_FILE = 'pack.json'`. Un membre de pack est ré-empaqueté sous
  `<name>/` puis installé via `install({kind:'upload'})` (trust + sémantique
  d'upgrade identiques à un upload).
- `modules/skills/index.ts` (SkillsSubsystem) : façade `exportSkill` /
  `exportPack` / `installPack` (mappe `SkillRow → SkillView`).
- `http/routes/skills.ts` : routes §1–§3 (`GET /skills/:name/export`,
  `POST /skills/pack/export`, `POST /skills/pack/install`). Les routes `pack/*`
  (POST) sont enregistrées avant les routes paramétrées `/skills/:name/*` — pas
  de collision de `:name` avec `pack`.
- Tests : `modules/skills/installer.test.ts` (round-trip export→upload avec
  assets+checksum, pack export→install, skip inconnus, `EmptyPackError`, succès
  partiel, archive corrompue, chemin non sûr, `firstUnsafeTarEntry`) ;
  `http/routes/skills.test.ts` (export 200+headers+404, pack export 200+400,
  pack install 200/415/422).

## 7. Différé (hors Lot 5a)

- **Signature / vérification d'intégrité** d'un pack (checksum global signé).
- **Sélection de skills à l'install d'un pack** (installer un sous-ensemble) —
  actuellement tout membre présent est installé.
- **Matérialisation `SKILL.md` native du CLI** / auto-sélection par triggers.
