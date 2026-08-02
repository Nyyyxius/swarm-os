# Plan d'implémentation — Bibliothèque de skills importable

> Plan de mise en œuvre (étape 1 : **plan, pas de code**). Fait suite à
> `docs/analyse-skills-importables.md` (analyse validée) et aux décisions gelées
> par l'humain le 2026-08-02. Toutes les citations `fichier:ligne` sont sous
> `/home/ubuntu/projets/swarm-os` ; `packages/server/src/…` abrégé en `…`,
> `packages/web/src/…` en `web/…`.
>
> **Discipline git** : branche `feat/skills-library` (partagée, ne pas changer/
> merger/push) ; commits par chemin explicite ; **ne jamais toucher**
> `docs/comparatif-hermes-agent.md`.

---

## 0. Décisions GELÉES (contrat de conception)

| # | Décision | Conséquence |
|---|---|---|
| **(a)** | **Data-first / Option C** : un skill = **donnée** (instructions + fichiers), **zéro JS serveur** exécuté à l'import/activation. Tout code ou nouvel outil passe par une **dépendance plugin** (`requires.plugins`). | Pas de `npm install` ni d'`import()` dans le chemin skill. Le chemin « code » reste celui des plugins (capabilities + quarantaine). |
| **(b)** | **Activation à CHAUD** : activer/désactiver un skill affecte **aussi les sessions vivantes**, pas seulement les prochains spawns. | Mécanisme double canal (§2). |
| **(c)** | **Injection SEULE** au MVP : **pas** de matérialisation `SKILL.md` native dans le CLI. | **Parité stricte des 4 providers** (claude/codex/gemini/opencode) via le préambule. La matérialisation native est repoussée en Lot 4 (précédent `graphify-integration.md §5/P5`). |
| **(+)** | **Mise à jour par RÉ-IMPORT** (versioning / upgrade en place). | Réutilise `PluginInstaller.upgrade` (`plugins/installer.ts:201-257`). |
| **(+)** | **UI COMPLÈTE** : liste, import, ré-import/upgrade, activation par portée, suppression, diff/trust. | Page `#/skills` + composants (§8). |

**Invariant transverse** (hérité du préambule) : un skill est **ajouté, jamais
substitué** — la discipline mailbox/approbation survit toujours
(`orchestrator/preamble.ts:387-390`).

---

## 1. Rappel du modèle (2 couches)

- **L1 — skill swarm-os** : l'unité **cataloguée / importée / activée** par
  rôle-équipe-worker. C'est **tout** ce qu'on construit ici.
- **L2 — skill natif du CLI** (`SKILL.md` + Skill tool) : **hors scope MVP**
  (décision c). Le format d'échange reste `SKILL.md`+YAML (§6) pour une
  compat future L2 **sans transcodage**, mais l'activation MVP = **injection
  préambule uniquement**.

---

## 2. Design de l'activation à chaud (résolution de la tension)

**Tension** : le préambule est **figé au spawn** — passé via
`--append-system-prompt` et **immuable pour la durée de vie du process**
(`providers/claude.ts:102`, consommé `session.ts:1329`). Il **survit au `/clear`**
mais **n'est jamais reconstruit** tant que la session n'est pas relancée/resumée.
Donc une activation runtime ne peut pas, seule, modifier le system-prompt d'une
session déjà vivante.

**Solution — double canal :**

### 2.1 Canal DURABLE (tous futurs spawns/resume)
L'activation est **persistée** (§3 : `roles.skills_json` pour la portée rôle,
`skill_activations` pour orch/session). À **chaque** construction de session, la
résolution des skills alimente `buildPreamble` via une nouvelle section
`buildSkillsSection()` (calquée sur `buildPluginToolsSection`,
`preamble.ts:252-296`). Points d'injection — les **3 sites** `buildPreamble` :
- lead `start` : `index.ts:489-500` → `new Session({preamble})` `index.ts:502-538` (champ `:510`)
- lead `resume` : `index.ts:634-645` → `:657`
- worker `addWorker` : `index.ts:801-814` → `:825`

⇒ Tout nouveau worker/lead, **et toute session resumée**, reçoit le skill dans
son system-prompt de façon **durable**.

### 2.2 Canal À CHAUD (sessions déjà vivantes)
Au moment de `skills.activate`, pour **chaque session vivante ciblée** :
1. **Stage immédiat des assets** dans le workspace de la session :
   `<agentCwd>/.swarm-skills/<name>/` où `agentCwd = session._paths.workspace(session.cwd)`
   (`session.ts:1338`), garanti **sous** `config.workspaceRoot`
   (`config.ts:96`/`:695` ; validation `http/validation.ts:27`). Réutilise la
   mécanique `copyAgentAssets` (`plugins/agent-assets.ts:61-94`, bit exécutable
   préservé, base-path transport-aware `:43-53`).
2. **Injection inbox** : `orch.mailbox.push(sessionId, { from: 'system', content })`
   (`orchestrator/mailbox.ts:192-259` ; exemple `from:'system'` `index.ts:1477` ;
   variante multi-cible `pushBatch` `mailbox.ts:270-334`). `content` = annonce
   synthétique : nom du skill + **corps du `SKILL.md`** (les instructions) +
   chemins d'assets stagés.
3. **Signal PTY idle** : `orch.getSession(sessionId)?.notifySignal(SIGNAL_TEXT)`
   (`session.ts:672-712` ; `SIGNAL_TEXT` `messaging.ts:63` ; gate idle
   `messaging.ts:230-231`). C'est **exactement** le patron du rehydrate
   (`orchestrator/mailbox-persistence.ts:120-123, 170-183`).

Énumération des cibles vivantes : `orch.listSessions()` (`index.ts:1222-1224`)
filtré par `_isActive` (`index.ts:1299-1310`). Cross-équipe : via le Spawner
(`spawner/index.ts:223, 561-566`).

**Désactivation** : symétrique — retrait de l'activation persistée, `mailbox.push`
d'une **notice de retrait** (`from:'system'`) + suppression des assets stagés.

### 2.3 Limites documentées & réconciliation
- L'injection inbox est **éphémère** : c'est un message système dans la
  conversation *courante*. Il **disparaît au `/clear`** de cette session, et le
  préambule figé **ne contient pas** le skill (la session a été spawnée *avant*
  l'activation). ⇒ **Après un `/clear` sur une session hot-activée, le skill n'est
  plus présent** dans cette session tant qu'elle n'est pas resumée.
- Le canal **durable** rattrape systématiquement au **prochain spawn/resume**
  (le préambule est alors reconstruit depuis l'activation persistée).
- **Option de « promotion en durable » d'une session vivante** (post-MVP,
  opt-in) : déclencher un `resume` de la session (`index.ts:634`), qui reconstruit
  le préambule — au prix de réinitialiser le PTY. **Non retenu au MVP** (trop
  intrusif) ; on documente le comportement au lieu de le masquer.
- **Résumé du contrat** : *durable = garanti à partir du prochain spawn/resume ;
  hot = best-effort immédiat sur la conversation vivante.* Les deux sont
  cohérents et non-destructifs.

---

## 3. Modèle de données SQLite

Fichiers : schéma inline **et** externe à tenir synchro —
`INLINE_SCHEMA` (`db/index.ts:1049-1063` pour `roles`) **et** `db/schema.sql`
(chargé par `applySchema()` `db/index.ts:576-583`). Migrations additives via
`applyMigrations()` (`db/index.ts:513-574`, tableau `additions` `:514-555`,
try/catch « duplicate column » `:556-565`).

### 3.1 Table `skills` (registre, per-instance — patron `plugins`)
```sql
CREATE TABLE IF NOT EXISTS skills (
  name             TEXT PRIMARY KEY,      -- slug ^[a-z][a-z0-9-]{1,40}$, hors RESERVED_NAMES
  version          TEXT NOT NULL,
  display_name     TEXT,
  description      TEXT,
  source_kind      TEXT NOT NULL,         -- dir|upload|git|npm|market
  source_ref       TEXT,                  -- adresse de re-fetch (git: url#ref#subdir encodé)
  source_commit    TEXT,                  -- HEAD git, sinon NULL
  checksum         TEXT,                  -- sha256 de l'arbre importé (provenance)
  trust            TEXT NOT NULL DEFAULT 'community', -- first-party|verified|community|local
  requires_json    TEXT,                  -- {plugins:[], capabilities:[]}
  assets_present   INTEGER NOT NULL DEFAULT 0, -- 1 = ship un dossier assets/ (revue si exécutable)
  config_json      TEXT,                  -- valeurs de config (réutilise config-schema)
  body_md          TEXT,                  -- corps SKILL.md (cache pour build préambule rapide)
  frontmatter_json TEXT,                  -- frontmatter YAML parsé (name/description/triggers)
  installed_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_error       TEXT
);
```
- **Fichier = vérité** (dossier importé `<skillsDir>/<name>/`, patron `pluginsDir`) ;
  `body_md`/`frontmatter_json` = **cache** rebâti à l'import/ré-import (le spawn est
  chaud, on évite un `readFileSync` par session — cf. `preamble.ts` memoize).
- Colonnes calquées 1:1 sur `plugins` (`plugins/store.ts:162-177`) : `source_kind`/
  `source_ref`/`source_commit` (`store.ts:127`), `installed_at` non écrasé au ré-import.

### 3.2 Portée d'activation
- **Rôle (MVP)** : colonne **`roles.skills_json`** = JSON array de
  `{ name, mode:'inject' }`. **Exactement** le patron `connectors_json`
  (`db/schema.sql:65` ; parse `roles/index.ts:224-235` ; serialize `:268`).
  Migration : ajouter au tableau `additions` (`db/index.ts:514-555`), à côté de
  `roles.approval_json` (`:554`) :
  `{ table:'roles', column:'skills_json', ddl:'ALTER TABLE roles ADD COLUMN skills_json TEXT' }`.
- **Orch + session (Lot 2)** : table dédiée
```sql
CREATE TABLE IF NOT EXISTS skill_activations (
  id          TEXT PRIMARY KEY,           -- uuid
  skill_name  TEXT NOT NULL,              -- → skills.name
  scope_type  TEXT NOT NULL,              -- 'role' | 'orch' | 'session'
  scope_id    TEXT NOT NULL,              -- role.id | orchestrator.id | session.id
  mode        TEXT NOT NULL DEFAULT 'inject',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE(skill_name, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_activations_scope ON skill_activations(scope_type, scope_id);
```
- **Précédence de résolution** (session donnée) :
  `skills(session) ∪ skills(orch) ∪ skills(rôle)`, dédupliqué par `name` (le scope
  le plus spécifique gagne pour `mode`/`enabled`). Au MVP seule la portée rôle
  existe (via `roles.skills_json`) ; `skill_activations` généralise en Lot 2.

### 3.3 Impacts row-types / statements roles
`RoleRow` (`db/index.ts:112-135`) + `insertRoleStmt` (`:438-450`) + `updateRoleStmt`
(`:451-468`) : ajouter `skills_json`. Côté store : `Role`/`RoleInit`/`RolePatch`
(`roles/index.ts:165-220`), `rowToRole`/`roleToRow` (`:222-275`, serialize comme
`connectors_json` `:268`).

---

## 4. Layout du module `modules/skills/`

Miroir allégé de `modules/plugins/` (data-first ⇒ **pas** de host/loader/capabilities).

| Fichier | Rôle | S'inspire de |
|---|---|---|
| `manifest.ts` | Parse+valide `SKILL.md` (frontmatter YAML + corps) et `skill.json` optionnel ; réutilise `PLUGIN_NAME_RE`/`RESERVED_NAMES` ; anti-traversal `assets.dir` | `plugins/manifest.ts`, `agent-assets.ts:69-71` |
| `store.ts` | `SkillStore` (upsert/get/list/delete) sur `skills` (+ `skill_activations` en Lot 2), handle brut | `plugins/store.ts:161-241` |
| `stage.ts` | Fetch/stage par source (dir/upload → MVP ; git/npm/market → Lot 2) ; checksum ; **aucun** `npm install`/`import()` | `plugins/installer.ts:261-460` |
| `installer.ts` | `SkillInstaller.install(source)` / `upgrade(name)` (ré-import) → parse `SKILL.md` → commit (swap dossier + upsert row) | `plugins/installer.ts:176-257` |
| `assets.ts` | `stageSkillAssets(cfg, skillDir, name, agentCwd)` → `<agentCwd>/.swarm-skills/<name>/` ; `removeSkillAssets` | `plugins/agent-assets.ts:24-109` |
| `activation.ts` | `resolveForSession(...) → SkillFragment[]` ; `activateHot(orch, name, targets)` / `deactivateHot(...)` (stage + `mailbox.push` + `notifySignal`) | `mailbox-persistence.ts:120-183` |
| `index.ts` | `SkillsSubsystem` (façade store+installer+activation), exposée sur le **Spawner** (`spawner.skills`) comme `taskboard`/`memory`/`graph` | `spawner/index.ts` |
| `trust.ts` | Niveaux de confiance + gating revue (§9) | (nouveau) |

**Refactor DRY (recommandé, Lot 1 minimal → Lot 2 complet)** : extraire les
primitives de staging de `plugins/installer.ts` (`extractTgzFile` `:393-395`,
copie dossier `:269-281`, puis `gitClone`/`npmPack`/`encodeGitRef`/`decodeGitRef`)
vers un module partagé `modules/install-core/stage.ts`, consommé par
`plugins/installer.ts` **et** `skills/stage.ts`. MVP : extraire seulement
dir+upload (simples : `fs.cpSync`, `tar -xzf --strip-components=1`) ; garder
`plugins/installer.test.ts` vert. Git/npm/market : extraction complète en Lot 2.

---

## 5. Pipeline d'import + ré-import/upgrade

### 5.1 Sources (mêmes que plugins)
| Source | Format | Réutilisation |
|---|---|---|
| **dossier** `dir` | dossier avec `SKILL.md` (+ `skill.json`) | `installer.ts:269-281` |
| **`.tgz`** `upload` | tarball `npm pack`-style, `SKILL.md` à la racine | `installer.ts:282-287, 393-395` |
| **git** | repo public (+ `ref`, + `subdir` monorepo) | `installer.ts:301-348` |
| **npm** | package npm = skill | `installer.ts:288-300` |
| **market** | index HTTP (`agentskills.io`) → tarball | nouveau (Lot 4) |

### 5.2 Commit d'import (data-first)
`stageInto` (staging isolé `.staging/<uuid>`, anti-traversal, purge boot
`installer.ts:162-171`) → **valider `SKILL.md`** → **calculer checksum** →
**swap dossier** en place → **upsert row** (`SkillStore`). **Différence clé vs
plugin** : **aucun** `npm install`/`import()`/activation host — on ne fait que
copier des fichiers et indexer.

### 5.3 Ré-import / upgrade (mise à jour)
Miroir de `PluginInstaller.upgrade(name)` (`installer.ts:201-257`) : re-fetch du
`source_ref` mémorisé (dir/git/npm ; `upload` ⇒ nouveau tarball requis, 409
`installer.ts:218-219`), re-stage, **vérif nom identique** (`:239-243`), swap +
upsert (`installed_at` préservé). En plus : **re-parse `SKILL.md`** (maj
`body_md`) et **re-broadcast à chaud** aux sessions vivantes qui l'ont actif
(§2.2, corps mis à jour). L'UI montre un **diff du corps** avant confirmation
(§8/§9).

---

## 6. Format canonique `SKILL.md` + frontmatter YAML

```
---
name: my-skill                 # slug, PK (PLUGIN_NAME_RE, hors RESERVED_NAMES)
version: 0.1.0
description: Une ligne — sert au surfacing et (futur L2) à l'auto-sélection.
triggers: [mot-cle-1, mot-cle-2]   # optionnel
requires:                          # optionnel
  plugins: [novelai]               # dépendances plugin (si le skill s'appuie sur des outils)
  capabilities: []                 # UNIQUEMENT si assets exécutables/host → revue opérateur
assets: { dir: assets }            # optionnel : dossier stagé dans le workspace
---
<corps markdown = les instructions injectées dans le préambule (canal durable)
 et poussées en inbox (canal chaud)>
```
- **Une seule source de vérité** : le corps sert à la fois d'injection L1 et (plus
  tard) de `SKILL.md` natif L2 — **pas de transcodage**, compat directe
  `agentskills.io` + Skill tool des CLI.
- `skill.json` = **sur-ensemble optionnel** swarm-os (trust hints, `configSchema`
  réutilisant `plugins/config-schema.ts`) pour ce que le frontmatter ne porte pas.
- **Parseur YAML** : réutiliser la dépendance YAML déjà présente si le lockfile en
  a une (à vérifier dans `pnpm-lock.yaml` : `yaml`/`js-yaml`) ; sinon un
  splitter frontmatter minimal (`---\n…\n---\n`) + parse — **pas de nouvelle
  dépendance lourde**.

---

## 7. Outils MCP `skills.*`

Nouveau fichier `modules/mcp/skills-tools.ts` :
`export function registerSkillsTools(server: McpServer, ctxResolver: () => ToolContext): void`
(signature identique à `registerTaskboardTools` `mcp/taskboard-tools.ts:107` /
`registerMemoryTools` `memory-tools.ts:35`). Chaque outil = un
`server.registerTool(name, {title, description, inputSchema, outputSchema}, handler)`
(patron `board.list` `taskboard-tools.ts:109-141`), enveloppe `ok()`
(`tools.ts:147-155`), erreurs `McpError` via un `throwSkillError` (patron
`taskboard-tools.ts:77-89`), garde de disponibilité `skillsOf(ctx)` (patron
`taskboardOf` `:36-45`), log `logCall` (`tools.ts:178-187`).

| Outil | Accès | Effet |
|---|---|---|
| `skills.list` | tous | catalogue installé + état d'activation pour l'équipe/rôle du caller |
| `skills.activate` | **lead** (`requireLead` `tools.ts:163-171`) | persiste l'activation (portée `role`/`team`/`session`) **et** broadcast à chaud (§2.2) ; renvoie ce qui a été injecté |
| `skills.deactivate` | **lead** | retire l'activation + notice de retrait à chaud |
| `skills.show` *(Lot 2)* | tous | corps complet d'un skill à la demande |

**Wiring** :
- `mcp/server.ts:241` — ajouter `registerSkillsTools(sdkServer, () => ctx);` (après
  `registerGraphTools`, avant `this.pluginTools?.registerAll`) ; import à côté de
  `server.ts:8-11`.
- `ToolContext` (`tools.ts:58-86`) — ajouter `skills?: SkillsSubsystem` (patron
  `taskboard?`).
- `resolveContext` (`server.ts:307-347`) — `...(this.spawner.skills ? { skills: this.spawner.skills } : {})` (patron `taskboard` `:340-341`).
- **Renommage multi-provider** : ajouter `skills.list/activate/deactivate[/show]`
  à `TEAM_TOOL_LOGICAL_NAMES` (`preamble.ts:74-120`) **et** au garde
  `preamble.test.ts` (sinon un provider non-claude nommerait mal l'outil).

**Note « effet au prochain spawn »** (comme les outils de plugins,
`host.ts:552-570`) : `skills.activate` en mode `inject` est durable **dès le
prochain spawn** ; sur les sessions vivantes, seul le canal chaud (§2.2)
s'applique, avec la limite §2.3. Le handler l'indique dans sa réponse.

---

## 8. UI (complète) — `packages/web`

### 8.1 Routage & navigation
`web/App.tsx` : `Route` union `:15-25` (+`{ kind:'skills' }`), `parseHash` `:35-50`
(+`#/skills` `:42`), `setHashRoute` `:52-67` (`:55`), callbacks provider `:109-125`
(+`onOpenSkills` `:112`), montage overlay `:130-133` (`<SkillsPage open=… />`).
Nav : `web/components/desktop/TopBar.tsx` (props `:56-69`, destructure `:81`,
boutons `:174-198`), `web/components/mobile/MobileShell.tsx` (`:134-139`),
`web/controller/SwarmController.tsx` (relayer `onOpenSkills`).

### 8.2 Composants
- `web/components/SkillsPage.tsx` — catalogue (name, version, source, **trust**,
  portées actives) ; actions : Import, Ré-import/Upgrade, Activer (sélecteur de
  portée), Désactiver, Supprimer, Voir (corps + **diff** au ré-import).
- `web/components/skills/SkillImportModal.tsx` — **clone** de
  `plugins/InstallPluginModal.tsx` (`:18-19, 33, 34-40, 49-66, 87, 201`), onglets
  dir/upload/git/npm/market ; callbacks d'action **injectés** (le modal n'appelle
  pas `api.*` directement, patron existant).
- `web/components/skills/SkillReviewDialog.tsx` — revue (assets exécutables /
  `requires`), patron `plugins/PermissionsDialog.tsx`.
- Activation par rôle : multiselect skills dans `RoleDialog.tsx` ; par worker :
  dans `SpawnWorkerDialog.tsx` (Lot 2).

### 8.3 Client API
`web/api/client.ts` : types `SkillView`/`SkillInput` (patron `RoleView`
`:210-242`, `RoleInput` `:261`) ; endpoints `listSkills/getSkill/importSkill/
uploadSkill/upgradeSkill/activateSkill/deactivateSkill/deleteSkill` (patron roles
`:1161-1167`, helper `request` `:1039-1062`, objet `api` `:1100`). Un champ
`skills` ajouté à `RoleView` circule automatiquement dans `RoleInput`.

### 8.4 Routes HTTP serveur
`http/routes/skills.ts` — `createSkillsRouter(store, config, onSkillsChanged?, spawner?)`
(patron `roles.ts:340-362`) : `GET /skills`, `POST /skills/install` (dir/git/npm),
`POST /skills/upload` (`express.raw` 50 MB, patron `plugins.ts:240-267`),
`POST /skills/:name/upgrade`, `POST /skills/:name/activate`,
`POST /skills/:name/deactivate`, `DELETE /skills/:name`. Monté dans
`http/main.ts` près de `createRolesRouter` (`main.ts:322-330`).

---

## 9. Modèle trust / sécurité

| Niveau `trust` | Source | Traitement |
|---|---|---|
| `first-party` | curé/shipé avec swarm-os | activable sans revue |
| `verified` | publisher connu / signé (Lot 3+) | badge, activable |
| `community` (défaut) | git/market public | **non privilégié** ; revue si assets exécutables |
| `local` | dossier de l'opérateur | confiance opérateur |

- **Surface serveur quasi nulle** : data-first ⇒ **aucun** code serveur exécuté à
  l'import (pas de `npm install`/`import()`).
- **Vrai risque = l'agent en `bypassPermissions`** dans le container : (1)
  **prompt-injection** via le corps `SKILL.md` (mitigé par l'invariant « ajouté,
  jamais substitué » `preamble.ts:387-390` + import explicite + `trust`) ; (2)
  **scripts d'`assets/`** qu'un agent peut lancer = **code arbitraire container**
  ⇒ tout skill `assets_present` **exécutable** ou déclarant
  `requires.capabilities` exige **revue + grant opérateur** avant activation
  (`SkillReviewDialog`, affiche la liste + le contenu des assets).
- **`requires.plugins`** : à l'activation, vérifier que le plugin est
  installé+enabled (sinon avertir) — le skill **n'apporte pas** d'outils lui-même.
- **Provenance** : `source_kind`/`source_ref`/`source_commit` + **`checksum` sha256** ;
  ré-import affiche le **diff** du corps.
- Anti-traversal noms/chemins : `PLUGIN_NAME_RE`/`RESERVED_NAMES`
  (`plugins/manifest.ts:22, 28-46`), `agent-assets.ts:69-71`.
- Secrets de `configSchema` : `PASSWORD_SENTINEL` + redaction
  (`plugins/config-schema.ts:158-195`).

---

## 10. Découpage en lots

### Lot 0 — Spike *(S)* — figer le format & prouver l'injection
Tâches **niveau fichier** :
1. `modules/skills/manifest.ts` — `parseSkillMd(dir): { frontmatter, body }` +
   validation `name`/`version` (réutilise `PLUGIN_NAME_RE`/`RESERVED_NAMES` de
   `plugins/manifest.ts`, importés ou recopiés). Vérifier la dépendance YAML dans
   `pnpm-lock.yaml` ; sinon splitter frontmatter minimal.
2. `examples/skills/hello-skill/SKILL.md` — skill exemple (corps + frontmatter).
3. `orchestrator/preamble.ts` — `SkillFragment` type + `buildSkillsSection(skills, {isLead, namer})`
   (miroir `buildPluginToolsSection` `:252-296`) + branchement dans `buildPreamble`
   (`:365-394`, après plugin-tools, avant override) ; test dans
   `orchestrator/preamble.test.ts` (rendu + invariant non-substitution).
4. `modules/skills/manifest.test.ts` — parse OK/KO.
**Sortie** : format validé, section préambule prouvée, **zéro** DB/UI.

### Lot 1 — MVP *(M)* — import local + activation rôle, injectée, à chaud
Tâches **niveau fichier** :
- **DB** — `db/schema.sql` + `INLINE_SCHEMA` (`db/index.ts` bloc `:1049-1063`) :
  `CREATE TABLE skills (...)`. `applyMigrations()` additions (`:514-555`) :
  `roles.skills_json` (à côté de `approval_json` `:554`). `RoleRow` (`:112-135`),
  `insertRoleStmt`/`updateRoleStmt` (`:438-468`) : +`skills_json`.
- **Store** — `modules/skills/store.ts` (`SkillStore`, tables sur handle brut,
  patron `plugins/store.ts:161-241`).
- **Import** — `modules/skills/stage.ts` (dir `:269-281` + upload `:282-287,393-395`
  extraits de `plugins/installer.ts`) ; `modules/skills/installer.ts`
  (`install`/`upgrade` data-first, checksum, parse `SKILL.md`, swap+upsert).
- **Assets** — `modules/skills/assets.ts` (`stageSkillAssets`/`removeSkillAssets`,
  adaptation `agent-assets.ts:61-109` vers `.swarm-skills/<name>/`).
- **Activation** — `modules/skills/activation.ts` :
  `resolveForSession(roleSkills) → SkillFragment[]` (portée rôle via
  `roles.skills_json`) ; `activateHot`/`deactivateHot` (stage + `mailbox.push`
  `mailbox.ts:192` + `notifySignal` `session.ts:672`, cibles `orch.listSessions()`
  `index.ts:1222` filtré `_isActive` `:1299`).
- **Façade** — `modules/skills/index.ts` (`SkillsSubsystem`) exposée `spawner.skills`
  (patron taskboard/graph sur `spawner/index.ts`).
- **Spawn wiring** — `orchestrator/index.ts` : aux **3** sites `buildPreamble`
  (`:489, :634, :801`), résoudre les skills du rôle et passer `skills`. La façade
  est accessible via le Spawner/Orchestrator (comme la mailbox).
- **Roles** — `modules/roles/index.ts` (`Role.skills`/`RoleInit`/`RolePatch`/
  `rowToRole`/`roleToRow` `:165-275`, serialize comme `connectors_json` `:268`) ;
  `http/routes/roles.ts` (POST assembly `:476-490` + PATCH `:578-604` gèrent `skills`).
- **MCP** — `modules/mcp/skills-tools.ts` (`skills.list/activate/deactivate`,
  `requireLead` `tools.ts:163`) ; wire `mcp/server.ts:241` + import `:10` ;
  `ToolContext.skills?` (`tools.ts:58-86`) ; `resolveContext` (`server.ts:340`) ;
  `TEAM_TOOL_LOGICAL_NAMES` (`preamble.ts:74-120`) + garde `preamble.test.ts`.
- **HTTP skills** — `http/routes/skills.ts` (`createSkillsRouter`, patron
  `roles.ts:340-362` + upload `plugins.ts:240-267`) ; monté `http/main.ts:~322`.
- **Web** — `web/api/client.ts` (types `SkillView`/`SkillInput` + endpoints,
  patrons `:210-261, :1039-1067, :1100, :1161-1167`) ; `web/App.tsx` (route/nav
  wiring `:15, :42, :55, :112, :130`) ; `web/components/SkillsPage.tsx` +
  `web/components/skills/SkillImportModal.tsx` (clone `InstallPluginModal.tsx`) ;
  nav `desktop/TopBar.tsx:174-198`, `mobile/MobileShell.tsx:134`,
  `controller/SwarmController.tsx` ; multiselect skills dans `RoleDialog.tsx`.
- **Tests** — `modules/skills/{store,installer,activation}.test.ts`,
  `http/routes/skills.test.ts`, maj `orchestrator/preamble.test.ts`.
**Sortie livrable** : importer un skill local (dir/tgz), l'activer par rôle
(injecté en préambule, **4 providers**), activation à chaud sur sessions vivantes,
ré-import, UI de gestion, suppression.

### Lot 2 — Sources & portées *(M)* *(esquisse)*
git+npm+market ; extraction complète de `install-core/stage.ts` ; table
`skill_activations` (portées orch+session) + précédence de résolution ; staging
assets au **spawn** pour toutes portées ; activation worker dans
`SpawnWorkerDialog.tsx` ; `skills.show` ; **diff** au ré-import dans l'UI.

### Lot 3 — Trust & sécurité *(M)* *(esquisse)*
Niveaux `trust` + gating UI ; `SkillReviewDialog` pour assets exécutables ;
résolution `requires.plugins` + avertissements ; vérif checksum ; signature
(optionnel).

### Lot 4 — Écosystème *(M–L)* *(esquisse)*
Source `market` (`agentskills.io`) ; skill packs ; export/partage ;
**matérialisation native `SKILL.md`** (revisiter décision c, claude/codex) ;
auto-sélection via `triggers`.

---

## 11. Points de vigilance / dépendances inter-lots

1. **Schéma en 3 endroits** : toute nouvelle table/colonne va dans
   `INLINE_SCHEMA` **et** `schema.sql` **et** (si colonne) `applyMigrations`
   (note `db/index.ts:530-535`). Oublier l'un casse soit les DB neuves soit les
   DB existantes.
2. **`spawner.skills`** doit être instancié **avant** le premier spawn et le MCP
   (comme taskboard/graph) — vérifier l'ordre d'init dans `spawner/index.ts`.
3. **Renommage d'outils** : sans l'ajout à `TEAM_TOOL_LOGICAL_NAMES`, les workers
   codex/gemini/opencode appelleraient `skills.activate` sous un mauvais nom.
4. **Refactor `install-core`** : garder `plugins/installer.test.ts` vert à chaque
   extraction (c'est du code testé qu'on déplace).
5. **Limite `/clear`** (§2.3) : à surfacer dans la doc utilisateur et la réponse
   de `skills.activate`, pas à masquer.

---

### Annexe — carte des ancrages (citations réutilisées)

- Préambule / injection : `orchestrator/preamble.ts:74-120, 252-296, 298-337, 365-394` ; consume provider `providers/claude.ts:102`, `session.ts:1329`.
- Sites `buildPreamble` : `orchestrator/index.ts:489-500, 634-645, 801-814` (import `:9`).
- Mailbox / hot : `mailbox.ts:192-259, 270-334` ; `from:'system'` `index.ts:1477` ; persist `mailbox-persistence.ts:35-85, 120-183` ; signal `messaging.ts:63, 164-176, 230-231` ; `session.notifySignal` `session.ts:672-712`.
- Sessions vivantes : `index.ts:320, 1218-1224, 1299-1310` ; spawner `spawner/index.ts:223, 557-566, 662`.
- Workspace/cwd : `config.ts:96, 357, 695, 833` ; `session.ts:302, 423, 518-531, 1338, 1366` ; validation `http/validation.ts:13, 27`, `mcp/tools.ts:594, 603`.
- Installer plugin (réutilisé) : `plugins/installer.ts:176-257, 261-460` ; upgrade `:201-257`.
- Store/manifest/assets/config plugin : `plugins/store.ts:161-241` ; `manifest.ts:22, 28-46, 97-132` ; `agent-assets.ts:24-109` ; `config-schema.ts:158-195`.
- MCP registration : `mcp/taskboard-tools.ts:36-45, 57-74, 77-89, 107-141` ; `tools.ts:58-86, 147-155, 163-171, 178-187` ; wiring `mcp/server.ts:8-11, 232-242, 307-347`.
- Roles : `roles/index.ts:165-275` ; `http/routes/roles.ts:340-362, 403-630` ; `http/main.ts:322-330`.
- DB migrations : `db/index.ts:112-135, 438-468, 513-574, 576-583, 1049-1063`.
- Web : `web/App.tsx:15-25, 35-67, 109-133` ; `desktop/TopBar.tsx:56-69, 174-198` ; `mobile/MobileShell.tsx:134-139` ; `api/client.ts:210-261, 1039-1067, 1100, 1161-1167` ; `plugins/InstallPluginModal.tsx:18-66, 87, 201`.
- Décisions/contexte : `docs/analyse-skills-importables.md` ; `plan_plugins.md:357` ; `docs/graphify-integration.md §5, P5`.
