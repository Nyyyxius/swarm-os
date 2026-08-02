# Analyse — Bibliothèque de skills importable pour swarm-os

> Analyse de faisabilité & de conception (en amont, **aucun code**). Établie le
> 2026-08-02 par lecture du source `master`. Répond au point 2 de la §7 « À faire »
> de `docs/comparatif-hermes-agent.md` : offrir un **catalogue de skills activables
> par rôle/équipe, importables** (marketplaces type `agentskills.io`, dépôts git,
> ajout utilisateur), pour combler le gap « Skills / marketplace : Non » (§3).
>
> Chemins cités : absolus sous `/home/ubuntu/projets/swarm-os`. Sauf mention
> contraire, `packages/server/src/…` est abrégé en `…`.

---

## 1. Résumé exécutif

Un « skill » swarm-os est une **unité de connaissance/outillage versionnée et
importable** qui se situe **entre le rôle** (template d'équipe) **et le plugin**
(extension de code) : plus léger qu'un plugin (souvent **zéro code exécuté côté
serveur**, juste des instructions + des fichiers), plus partageable qu'un
préambule de rôle brut. Concrètement : `métadonnées + fragment(s) de préambule +
(optionnel) assets outillage + (optionnel) dépendance plugin`.

**La bonne nouvelle : presque toute la mécanique existe déjà.** L'import
multi-source (dossier / `.tgz` / npm / git) est un pipeline durci et testé dans
`plugins/installer.ts` ; le staging de fichiers-outillage dans le workspace de
l'agent existe (`plugins/agent-assets.ts` → `.swarm-plugins/<name>/`) ;
l'injection d'instructions par session passe par `--append-system-prompt`
(`orchestrator/preamble.ts`, provider `providers/claude.ts:102`) et **survit au
`/clear`** ; les rôles portent déjà `lead_preamble`/`worker_preamble` en base.

**Reco principale — Option C (hybride « data-first »)** : un **sous-système
`skills` dédié et léger** qui (1) **réutilise le pipeline de fetch/stage/validation
de `installer.ts`** pour l'import (toutes sources + marketplace), (2) traite un
skill comme **de la donnée** (instructions + fichiers + métadonnées, **pas de JS
serveur arbitraire par défaut**), (3) **active** via l'injection de préambule +
le staging d'assets déjà en place, (4) **matérialise en option** le skill comme
un `SKILL.md` natif du CLI (claude/codex) comme accélérateur token-cheap, et (5)
**délègue au système de plugins** (capabilities + quarantaine) dès qu'un skill a
besoin de *code* ou de *nouveaux outils MCP*. On adopte le format
**`SKILL.md` + frontmatter YAML** comme **format d'échange canonique** : compat
directe avec `agentskills.io` **et** avec le Skill tool natif des CLI.

Effort estimé : **MVP en ~1 lot (S–M)** (table + import dossier/tgz + attache au
rôle + injection préambule + UI minimale), complet en ~4 lots.

---

## 2. État actuel — ce qui existe et sur quoi s'appuyer

### 2.1 Système de plugins ESM in-process (la brique d'import est déjà là)

- **Manifeste** `plugin.json` validé par zod : `name` (regex URL/SQL-safe,
  `manifest.ts:22`), `version`, `main`, `apiVersion`, `capabilities[]`,
  `configSchema`, **`agentAssets: { dir }`**, `connectors[]`, `uiPanels[]`
  (`plugins/manifest.ts:97-132`). Noms réservés refusés à l'install ET au load
  (`manifest.ts:28-46`). Anti-traversal sur `main`/`path` (`manifest.ts:52-59`).
- **Import multi-source**, un seul pipeline `PluginInstaller.install()` →
  `.staging/<uuid>` → `stageInto()` → `commitInstall()` (`plugins/installer.ts:176`,
  dispatch `installer.ts:261-377`) :
  - **dossier local** `dir` : `installer.ts:269-281` (`fs.cpSync`, purge `node_modules`).
  - **tarball `.tgz`** `upload` : `installer.ts:282-287` → `tar -xzf --strip-components=1`
    (`installer.ts:393-395`, format `npm pack`).
  - **npm** : `npm pack <spec>` puis extraction (`installer.ts:288-300`, `398-408`).
  - **git** : `git clone --depth 1 [--branch ref]`, `rev-parse HEAD` mémorisé,
    `.git` supprimé ; variante **sous-dossier** avec anti-traversal
    (`installer.ts:301-348`, `65-72`).
  - Normalisation commune : `npm install --omit=dev --ignore-scripts` seulement si
    deps déclarées (`installer.ts:445-460`), `apiVersion ≤ HOST_API_VERSION`, `main`
    existe (`installer.ts:356-370`). Exec borné 180 s, `GIT_TERMINAL_PROMPT=0`.
  - REST : `POST /plugins/install` (npm/git/dir), `POST /plugins/upload`
    (`express.raw`, 50 MB), `POST /plugins/:name/upgrade`
    (`http/routes/plugins.ts:213-284`).
- **Cycle de vie à chaud** (`plugins/host.ts`) : `enable`/`disable`/`reload`
  sérialisés par nom (`host.ts:472-642`), activation `import()` cache-busté
  (`plugins/loader.ts:23-45`), teardown en ordre inverse via `DisposableStore`
  (`api-types.ts:93-128`).
- **Capabilities accordées par l'opérateur** : 16 capabilities
  (`plugins/api-types.ts:57-74`) ; grant = `manifeste ∩ demandé` (`host.ts:491-494`),
  stocké `plugins.granted_capabilities_json`, **enforced** par `requireCap()`
  (`plugins/api.ts:152-158`). Nouvelles capabilities d'un upgrade **non
  auto-accordées** (`host.ts:780-781`).
- **Isolation de crash** : `guard()` enveloppe **tout** callback plugin
  (`host.ts:265-288`) ; **5 crashes / 60 s → quarantaine** avec backoff exponentiel
  (`host.ts:61-64`, `341-363`) ; boot per-plugin isolé (`host.ts:891-929`).
- **Stockage** (tables détenues par le module plugin, hors `schema.sql`) :
  `plugins` (registre, `store.ts:162-177`) + `plugin_kv` (`store.ts:178-181`) +
  tables privées `plugin_<name>_*` via `defineTable` (`store.ts:469-516`).
- **Outils MCP publiés par un plugin** : `api.mcp.registerTool` → nom qualifié
  `<plugin>.<tool>` (`plugins/mcp-registry.ts:80`), **montés dans le MÊME serveur
  team-comms** (`mcp/server.ts:242`), handler passé au `guard` du host
  (`mcp-registry.ts:161-170`). Ex. réel : `novelai.generate_text`.

**Exemple concret déjà « skill-like »** : `examples/plugins/novelai/` embarque
`agent-assets/GUIDE.md` (un **guide d'agent en markdown** — exactement le corps
d'un skill), des outils MCP (`novelai.generate_text`), et un `configSchema`. Le
plugin `novelai` **est déjà** un « skill » dans tout sauf le nom.

### 2.2 Rôles & préambules (la brique d'activation est déjà là)

- **Rôle = preset versionné** : `RoleStore` sur la table `roles` avec
  `leadPrompt`, **`leadPreamble`**, **`workerPreamble`**, `defaultModel`/`Effort`/
  `PermissionMode`/`Provider`, `workerCount`, `connectors[]`, `schedule`, `approval`
  (`roles/index.ts:165-202`, `277-345`). Connecteurs sérialisés en JSON dans une
  colonne unique `connectors_json` (`schema.sql:65`) — **patron directement
  réutilisable** pour un futur `skills_json`.
- **Construction du préambule par session** : `buildPreamble()` concatène
  `défaut (lead|worker) + section « Plugin tools » + note de renommage d'outils +
  override du rôle` (`orchestrator/preamble.ts:365-394`). Points clés :
  - **Délivré via `--append-system-prompt`** → **durable, survit au `/clear`**
    (`preamble.ts:347-352` ; push effectif `providers/claude.ts:102-103`).
  - Il existe **déjà** une section auto-générée qui **annonce des capacités
    tierces** aux agents : `buildPluginToolsSection()` liste les outils de plugins
    (`preamble.ts:252-296`). **Un skill s'y insère exactement de la même façon.**
  - Le renommage d'outils MCP par provider est appliqué à tout le texte
    (`renderMcpToolNames`, `preamble.ts:178-183`) — à réappliquer au texte des skills.
  - L'override du rôle est **ajouté, jamais substitué** (`preamble.ts:387-390`) :
    la discipline mailbox n'est jamais perdue. Même invariant à respecter pour les skills.
- **Staging d'outillage dans le workspace de l'agent** :
  `copyAgentAssets()` copie `agentAssets.dir` → `<workspaceRoot>/.swarm-plugins/<name>/`
  (bind-mount, visible même en SSH, bit exécutable préservé), retiré au disable
  (`plugins/agent-assets.ts:61-109`, sous-dir `:24`, base-path transport-aware `:43-53`).

### 2.3 Comment le CLI piloté gère les skills natifs (2 couches à ne pas confondre)

- **swarm-os ne touche aujourd'hui à AUCUN skill natif claude.** Le CLI est
  configuré par un **`CLAUDE_CONFIG_DIR` par session** (`providers/claude.ts:603`,
  préparé `claude.ts:276-405`) dans lequel swarm-os écrit `settings.json`
  (`claude.ts:374-395`) et **symlinke un sous-ensemble de `~/.claude`** via
  `CLAUDE_SHARED_ENTRIES` (`claude.ts:153-171`) — **cette liste n'inclut ni
  `skills` ni `commands`.** Aucun `.claude/`, `CLAUDE.md` ou skill n'est écrit
  dans le workspace de l'agent.
- **Le provider Codex, lui, symlinke déjà `skills`** (`CODEX_SHARED_ENTRIES`,
  `providers/codex.ts:110` ; cf. `docs/providers.md:82`). Donc la couche
  « skill natif » **existe côté codex** mais pas côté claude.
- **Rappel des couches** (à garder distinctes dans tout le doc) :
  - **L1 — skill swarm-os** : l'unité cataloguée / importée / activée par
    rôle-équipe-worker (ce qu'on construit).
  - **L2 — skill natif du CLI** : le `.../skills/<name>/SKILL.md` (frontmatter
    YAML `name`/`description`, corps = instructions, dossier = scripts/refs) que
    le **Skill tool** du CLI expose en *progressive disclosure* (seule la desc
    est chargée ; le corps est tiré à la demande). Différent des *slash commands*
    (macros `/name` déclenchées par l'humain) et des *plugins* CLI (packaging).
  - Un skill **L1 peut se matérialiser en L2** (bonus, claude/codex uniquement).
    Sinon la voie **cross-provider** = injection préambule (marche pour les 4).

### 2.4 Points d'intégration UI / MCP / SQLite déjà en place

- **SPA React** (`packages/web`) : routing par hash `#/roles`, `#/plugins`,
  `#/memory`, `#/board`, `#/graph`, `#/ide`, panneaux plugin `#/panel/<plugin>/<id>`
  (`web/src/App.tsx:15-62`). Modale d'install plugin à **3 onglets npm/git/upload**
  (`web/src/components/plugins/InstallPluginModal.tsx:5-11, 110`), `RoleDialog.tsx`,
  `RolesPage.tsx`, `PluginsPage.tsx`, `PermissionsDialog.tsx` — **tous des gabarits
  directement clonables** pour un `#/skills`.
- **MCP** : outils montés sur le serveur team-comms (`mcp/server.ts`), vocabulaire
  logique listé dans `preamble.ts:74-120` (team/swarm/discord/memory/board/codegraph).
- **SQLite** : `orchestrators`, `roles`, `sessions`, `mailbox_messages`,
  `instance_settings` (`db/schema.sql`) + `plugins`/`plugin_kv` (module plugin).
  Migrations additives par `SwarmDb.applyMigrations()` (patron `ALTER TABLE`).

### 2.5 Contrainte historique à réconcilier (important)

`plan_plugins.md:357` acte explicitement, pour le **système de plugins** :
> « Pas d'injection de préambule/skills (option **explicitement écartée par
> l'utilisateur**) » — un plugin annonce ses scripts aux leads via
> `messaging.broadcastToLeads` à l'activate, pas via le préambule.

Et `docs/graphify-integration.md §5 / P5` a déjà tranché le débat « installer la
skill Graphify dans chaque CLI claude » : **skill+hook = claude-only**, donc la
couverture multi-provider passe par un **outil MCP côté serveur**, la skill claude
restant un **bonus optionnel (P5)**.

**Conséquence de conception** : la feature « skills » est précisément **l'endroit
sanctionné** où (ré)introduire une injection d'instructions **contrôlée et
opt-in** — mais elle doit rester **cohérente** avec ces deux décisions
(injection = choix explicite de l'opérateur par rôle ; parité multi-provider par
défaut, matérialisation native en bonus). **À confirmer avec l'humain** (Q7 §10).

---

## 3. Définition d'un « skill » dans swarm-os

### 3.1 Format proposé — `skill.json` + `SKILL.md` (format d'échange canonique)

On aligne le format sur l'écosystème (`agentskills.io`) **et** sur les CLI natifs :
un skill = **un dossier** contenant

```
<skill>/
  skill.json          # métadonnées swarm-os (voir ci-dessous) — OPTIONNEL si SKILL.md suffit
  SKILL.md            # frontmatter YAML {name, description, ...} + corps = instructions
  assets/             # (optionnel) scripts/CLI/refs → stagés dans le workspace
  references/         # (optionnel) docs lourdes tirées à la demande (progressive disclosure)
```

`skill.json` (sur-ensemble swarm-os, tolérant aux champs inconnus comme le
manifeste plugin) :

| Champ | Rôle | Analogue existant |
|---|---|---|
| `name` | slug URL/SQL-safe, PK | `manifest.ts:22` |
| `version` | semver | `manifest.ts:105` |
| `displayName`, `description` | UI + desc L2 | manifeste |
| `apiVersion` | contrat host | `manifest.ts:19` |
| `preamble` | `{ lead?, worker?, shared? }` — fragments injectés | `roles.lead_preamble` |
| `assets.dir` | dossier outillage à stager | `agentAssets.dir` (`agent-assets.ts`) |
| `nativeSkill` | `{ materialize: bool, path: 'SKILL.md' }` | (nouveau, bonus L2) |
| `triggers` | mots-clés/desc pour l'auto-sélection L2 | frontmatter SKILL.md |
| `requires.plugins[]` | dépendances plugin (si outils/code) | (nouveau) |
| `requires.capabilities[]` | **seulement** si `assets` exécutables/host | `PLUGIN_CAPABILITIES` |
| `trust` | `first-party \| verified \| community \| local` | (nouveau, §8) |
| `configSchema` | knobs simples (token, toggles) | `config-schema.ts` (réutilisable) |

**Principe « data-first »** : par défaut un skill **n'exécute aucun JS côté
serveur**. Il porte des *instructions* + des *fichiers*. Le corps de `SKILL.md`
sert **à la fois** de fragment de préambule (injection L1) **et** de skill natif
(matérialisation L2) — une seule source de vérité.

### 3.2 Rapport aux skills natifs du CLI (L1 ↔ L2)

- **Baseline (tous providers)** : le corps du skill est **injecté dans le
  préambule** (`--append-system-prompt`) via une nouvelle section
  `buildSkillsSection()` calquée sur `buildPluginToolsSection()`
  (`preamble.ts:252-296`). Toujours-actif, coûte des tokens en continu, mais
  marche pour claude **et** codex **et** gemini **et** opencode.
- **Bonus (claude/codex)** : le même dossier est **matérialisé en `SKILL.md`**
  dans le `skills/` du CLI (écrire dans `CLAUDE_CONFIG_DIR/skills/<name>/` pour
  claude — hook `_prepareConfigDir`, `claude.ts:276-405` — ; s'appuyer sur le
  symlink `skills` déjà présent pour codex, `codex.ts:110`). Gain : *progressive
  disclosure* — seule la description pèse en contexte, le corps est tiré par le
  Skill tool à la demande → **contexte bien moins cher** pour de gros skills.
- **Deux modes d'activation, un seul format.** L'opérateur choisit par skill :
  `inject` (garanti, universel) et/ou `native` (économe, claude/codex). Défaut
  proposé : `inject` pour les petits skills « discipline/procédure », `native`
  pour les gros skills « référence/outillage ».

---

## 4. Sources d'import

### 4.1 Réutiliser le pipeline plugin (recommandé)

Le pipeline `installer.ts` couvre déjà **dossier / tgz / npm / git** avec staging
isolé, validation, anti-traversal et purge au boot. Un **`SkillInstaller`** peut
soit réutiliser directement `PluginInstaller.stageInto()` (extraction dans
`.staging/`), soit en être une copie amincie (car un skill « data-first » n'a
**pas** besoin de `npm install` ni d'`import()`).

| Source | Format d'échange | Réutilisation |
|---|---|---|
| **dossier local** | dossier avec `SKILL.md` (+ `skill.json`) | `installer.ts:269-281` |
| **`.tgz`** | tarball `npm pack`-style, `SKILL.md` à la racine | `installer.ts:282-287, 393-395` |
| **npm** | package npm dont le contenu = skill | `installer.ts:288-300` |
| **git** | repo public (+ `ref`, + `subdir` pour un monorepo de skills) | `installer.ts:301-348` |
| **marketplace** (`agentskills.io`) | **index HTTP** listant des skills `SKILL.md` | nouveau : source `market` = fetch d'un `.tgz`/dossier via l'index |

**Format d'échange = `SKILL.md` + frontmatter YAML.** C'est déjà le format
`agentskills.io` et celui des CLI natifs → un skill importé du marketplace est
**directement** (a) injectable en préambule et (b) déposable tel quel en L2. Pas
de transcodage.

### 4.2 Marketplace — deux options d'implémentation

1. **Source built-in `market`** : swarm-os connaît l'URL d'index (réglage
   instance), résout `name[@version]` → URL de tarball, puis passe la main au
   staging tgz. Simple, centralisé, mais couple swarm-os à un fournisseur.
2. **Marketplace via un plugin-connector** : le catalogue est fourni par un
   **plugin** (capability `http-routes` + un futur point d'extension « source de
   skills »). Découplé, extensible à plusieurs marketplaces, mais plus de plomberie.

Reco : **built-in `market` pour le MVP** (comme npm/git le sont pour les plugins),
plugin-connector plus tard si multi-marketplace.

### 4.3 Sécurité de l'import — code arbitraire ?

- **Skill « data-first » (défaut)** : **aucun code serveur exécuté** à l'import ni
  à l'activation → surface d'attaque *serveur* quasi nulle. On **n'exécute pas**
  `npm install`/`import()` pour ce type (contrairement au plugin).
- **MAIS** un skill peut embarquer des **scripts dans `assets/`** que **l'agent**
  peut lancer, et l'agent tourne en `bypassPermissions` dans le container → un
  script malveillant = **code arbitraire dans le container**. C'est le vrai risque
  (cf. §8). Donc : un skill qui **ship des assets exécutables** ou qui **déclare
  `requires.plugins`/`requires.capabilities`** doit passer par une **revue +
  grant opérateur**, exactement comme un plugin.
- **Provenance** : mémoriser `source_kind` / `source_ref` / `source_commit`
  (patron `plugins.source_*`, `store.ts:127`) + **checksum** du tarball.
- **Confiance / signature** : niveaux `trust` (first-party/verified/community/
  local). Signature cryptographique = *nice-to-have* post-MVP ; checksum + revue
  du diff suffisent au MVP.

---

## 5. Modèle d'activation

### 5.1 Portées (scopes) d'activation

Trois granularités, par ordre de priorité de résolution (la plus spécifique gagne,
patron « override ajouté » du préambule) :

1. **Par rôle** (persistant) : le skill s'applique à **toute équipe** créée sous
   ce rôle. Stockage : colonne `roles.skills_json` (patron `connectors_json`,
   `schema.sql:65`) **ou** table de liaison `skill_activations` (cf. §7).
2. **Par équipe/orchestrateur** (ad hoc) : activer un skill sur une équipe vivante.
3. **Par worker au spawn** : le lead passe un jeu de skills à `spawn_worker`
   (champ à ajouter, cf. `SpawnWorkerDialog.tsx`).

Union résolue au spawn = `skills(rôle) ∪ skills(orch) ∪ skills(worker)`, dédupliquée.

### 5.2 Comment l'activation injecte le skill (préambule ? outils ? plugin ?)

Au **spawn d'une session**, la résolution du jeu de skills contribue à **3 canaux
déjà existants** :

- **(a) Préambule** — pour chaque skill en mode `inject`, ajouter son corps via
  une section `buildSkillsSection()` (nouvelle entrée `skills?: SkillFragment[]`
  dans `BuildPreambleInput`, `preamble.ts:298-337`), appendée comme la section
  plugin-tools, **après** le défaut, **avant** l'override — invariant « ajouté,
  jamais substitué » préservé, renommage d'outils appliqué.
- **(b) Assets outillage** — `copyAgentAssets()` réutilisé (ou clone
  `copySkillAssets()`) pour stager `assets/` dans `<workspace>/.swarm-skills/<name>/`
  (`agent-assets.ts:61-94`), retiré au désassignement.
- **(c) Matérialisation native L2** (mode `native`, claude/codex) — écrire
  `SKILL.md` dans le `skills/` du CLI de la session (hook `_prepareConfigDir`
  côté claude, `claude.ts:276-405` ; symlink existant côté codex).
- **(d) Outils/plugins** — si le skill **déclare `requires.plugins`**, l'activation
  **vérifie** que le plugin est installé+enabled (sinon avertit l'opérateur). Le
  skill **n'apporte pas** d'outils lui-même : les outils MCP restent le domaine
  des plugins (déjà annoncés par `buildPluginToolsSection`).

**Contrainte importante (à souligner)** : le préambule est **figé au spawn**
(`--append-system-prompt`). Donc une activation *runtime* (par un outil MCP
`skills.activate`) **ne prend effet qu'aux prochains spawns / resume**, exactement
comme les outils de plugins (« restart to refresh », `host.ts:552-570`). Le
`SKILL.md` natif L2, en revanche, **peut** être lu à chaud par le Skill tool si
écrit dans le config-dir vivant — nuance à exploiter si on veut de l'activation
à chaud (Q2 §10).

---

## 6. Options de conception & recommandation

### Option A — Skill = pure donnée (préambule + assets), **hors** système plugin

Un module `skills` autonome ; import = fetch d'un dossier `SKILL.md`+`assets/` ;
activation = injection préambule + staging assets (+ matérialisation L2 optionnelle).
**Aucune** exécution de code, **aucune** capability.

- ➕ Le plus simple, le plus sûr, le plus fidèle à l'écosystème `agentskills.io`
  (leurs skills **sont** de la donnée). Friction d'import minimale.
- ➖ Réimplémente le fetch/stage (git/tgz/npm) au lieu de réutiliser `installer.ts`.
  Ne peut **pas** ajouter d'outils MCP par lui-même.

### Option B — Skill = sous-type de plugin (« plugin-lite »)

Un `kind: 'skill'` dans le manifeste plugin ; on réutilise **tout** (installer,
host, capabilities, quarantaine, store) ; le skill ship surtout préambule +
`agentAssets` (+ éventuels outils MCP).

- ➕ Réutilisation maximale de la machinerie durcie (multi-source, grants,
  isolation crash, upgrade).
- ➖ Traîne la **surface d'exécution de code** et les **grants de capabilities**
  dans ce qui devrait être un import « juste des instructions » à faible friction.
  Lourd pour le cas 80 %.

### Option C — Hybride « data-first » : registre `skills` dédié, **réutilisant** les briques plugin/rôle *(recommandé)*

Module `skills` **dédié et léger** qui :
- **importe** en réutilisant le pipeline **fetch/stage/validation** de
  `installer.ts` (git/tgz/npm/dir/market) **sans** exécuter de code pour un skill
  data-first ;
- **active** via l'**injection préambule** + le **staging d'assets** existants,
  + **matérialisation L2** en bonus (claude/codex) ;
- **délègue au système de plugins** (capabilities + quarantaine) **dès qu'un skill
  a besoin de code/outils** — via `requires.plugins`. Un skill « lourd » = un skill
  data-first + une dépendance plugin déjà durcie.

- ➕ Faible friction pour le cas courant, réutilise l'import multi-source éprouvé,
  confine l'exécution de code au chemin plugin déjà sécurisé, respecte les
  décisions historiques (§2.5). Format `SKILL.md` unifié L1/L2.
- ➖ Un peu de duplication (un module de plus, une table de plus) vs Option B ;
  frontière skill/plugin à documenter clairement.

**Recommandation : Option C.** Elle donne l'UX « catalogue d'instructions
activables » voulue par la §7, réutilise 80 % de l'existant, et garde la porte
« code » derrière la barrière plugin (grants + quarantaine) plutôt que de l'ouvrir
par défaut.

---

## 7. Points d'intégration

### 7.1 SQLite

- **`skills`** (registre, patron `plugins`, `store.ts:162-177`) :
  `name PK, version, source_kind, source_ref, source_commit, checksum,
  trust, native_materialize INTEGER, assets_present INTEGER, requires_json,
  config_json, installed_at, updated_at, last_error`.
- **Activation** : deux choix —
  (a) **colonne `roles.skills_json`** (JSON array de `{name, mode}` ; patron
  `connectors_json`, `schema.sql:65`) — le plus simple, couvre la portée « rôle » ;
  (b) **table `skill_activations`** `(skill_name, scope_type ['role'|'orch'|'session'],
  scope_id, mode ['inject'|'native'|'both'], enabled)` — nécessaire pour les portées
  orch/worker. Reco : **(a) au MVP**, **(b)** ajoutée au Lot 2.
- Migrations : `SwarmDb.applyMigrations()` (`ALTER TABLE` additif), tables `skills*`
  créées par le module `skills` sur le handle brut (patron `store.ts:161-182`).

### 7.2 Préambule

- Nouveau champ `skills?: readonly SkillFragment[]` dans `BuildPreambleInput`
  (`preamble.ts:298-337`) + `buildSkillsSection()` calqué sur
  `buildPluginToolsSection()` (`preamble.ts:252-296`) : titre `## Skills actifs`,
  un bloc par skill (`inject`), renommage d'outils appliqué, **appendé avant
  l'override**. Test de garde symétrique à `preamble.test.ts`.

### 7.3 Nouveaux outils MCP (montés sur team-comms, `mcp/server.ts:242`)

- `skills.list` (tous) — catalogue installé + état d'activation par portée.
- `skills.activate` / `skills.deactivate` (**lead-only**, `requireLead`) — sur
  rôle/équipe/worker ; **note** l'effet-au-prochain-spawn pour le mode `inject`.
- Ajouter les noms au vocabulaire logique `TEAM_TOOL_LOGICAL_NAMES`
  (`preamble.ts:74-120`) pour le renommage multi-provider.

### 7.4 UI (SPA React, `packages/web`)

- Page **`#/skills`** (route dans `App.tsx:15-62`) : catalogue, état, import.
- **Modale d'import** clonée de `InstallPluginModal.tsx` (onglets dir/tgz/git/npm/
  market).
- **Sélecteur de skills** dans `RoleDialog.tsx` (portée rôle), `SpawnWorkerDialog.tsx`
  (portée worker), `NewOrchestratorDialog.tsx` (portée équipe).
- Écran de **revue/grant** (si assets exécutables / `requires`) réutilisant le
  patron `PermissionsDialog.tsx`.

### 7.5 Wiring session (spawn)

Au spawn (`orchestrator/session.ts`, `providers/claude.ts` / `codex.ts`) : résoudre
l'union des skills, (b) stager les assets, (c) matérialiser les `SKILL.md` natifs
dans le config-dir, (a) passer les fragments à `buildPreamble`.

---

## 8. Risques & sécurité

| Risque | Détail | Mitigation |
|---|---|---|
| **Code tiers exécuté (serveur)** | Un skill « plugin-lite » (Option B) ou `requires.plugins` fait tourner du JS in-process | Data-first par défaut (**aucun** `import()`/`npm install` pour un skill) ; tout code passe par le **chemin plugin** (grants + quarantaine `host.ts:341-363`) |
| **Scripts d'assets exécutés par l'agent** | L'agent tourne en `bypassPermissions` dans le container → un script d'`assets/` = **code arbitraire container** | Marquer `assets_present` ; **revue + grant opérateur** pour tout skill à assets exécutables ; afficher le contenu des assets à l'import |
| **Prompt-injection / instructions malveillantes** | Le corps `SKILL.md` **est** du texte injecté dans le system-prompt → un skill hostile peut détourner l'agent (exfiltration, contournement mailbox) | Invariant « **ajouté, jamais substitué** » (`preamble.ts:387-390`) : la discipline mailbox/approbation survit ; **revue du diff** à l'import ; niveaux `trust` ; import marketplace **explicite** |
| **Confiance de la source** | Marketplace/git public = contenu non vérifié | `trust` (first-party/verified/community/local) ; provenance `source_*` + `checksum` ; défaut = community non-privilégié |
| **Traversal / collision de noms** | Chemins d'assets, noms qualifiés | Réutiliser anti-traversal (`manifest.ts:52-59`, `agent-assets.ts:69-71`) + `RESERVED_NAMES` (`manifest.ts:28-46`) |
| **Dérive multi-provider** | `SKILL.md` natif = claude/codex only | Baseline = **injection préambule (4 providers)** ; L2 = bonus ; ne jamais faire dépendre une capacité *critique* du seul L2 (précédent graphify §2.5) |
| **Fuite de secrets** | `configSchema` peut porter un token | Réutiliser le `PASSWORD_SENTINEL` + redaction (`config-schema.ts:158-195`) |

**Angle « défensif » à garder** : le point le plus dangereux n'est pas le serveur
(data-first le neutralise) mais **l'agent en bypass** face à des instructions/scripts
importés. La revue opérateur + les niveaux de confiance + l'injection non-destructive
sont les trois garde-fous centraux.

---

## 9. Effort estimé & découpage en lots

| Lot | Contenu | Effort |
|---|---|---|
| **Lot 0 — Spike** | Figer le schéma `skill.json`/`SKILL.md` ; 1 skill exemple ; valider la matérialisation L2 claude (écrire un `SKILL.md` dans `CLAUDE_CONFIG_DIR/skills/` et vérifier que le Skill tool le voit) | **S** |
| **Lot 1 — MVP** | Table `skills` + module `skills` ; import **dossier + tgz** (réutilise `stageInto`) ; portée **rôle** (`roles.skills_json`) ; **injection préambule** (`buildSkillsSection`) ; page `#/skills` + modale import + sélecteur dans `RoleDialog` ; provenance + checksum | **M** |
| **Lot 2 — Sources & portées** | Import **git + npm** ; **staging assets** (`.swarm-skills/`) ; portées **équipe + worker-au-spawn** (table `skill_activations`) ; outils MCP `skills.list/activate/deactivate` | **M** |
| **Lot 3 — Natif & marketplace** | Matérialisation **L2 `SKILL.md`** (claude via config-dir, codex via symlink) ; source **`market`** (`agentskills.io`) ; niveaux **trust** + revue diff ; upgrade/versioning (réutilise `installer.ts:201-257`) | **M–L** |
| **Lot 4 — Écosystème** | Résolution **skill ↔ plugin** (`requires.plugins`) ; **skill packs** ; export/partage ; signature | **M** |

**MVP livrable au Lot 1** (utile en soi : importer un skill local et l'activer par
rôle, injecté en préambule pour tous les providers).

---

## 10. Questions ouvertes pour l'humain

1. **Data-first vs plugin-lite ?** Confirmer l'Option C (skill = donnée ; code
   uniquement via `requires.plugins`) plutôt que l'Option B (skill = sous-type de
   plugin). *Reco : Option C.*
2. **Activation à chaud ou au prochain spawn ?** Le préambule est figé au spawn
   (`--append-system-prompt`). Accepte-t-on que `inject` ne prenne effet qu'aux
   nouveaux spawns (patron plugin « restart to refresh ») ? Veut-on exploiter le
   L2 natif pour une prise d'effet à chaud ?
3. **Matérialisation native L2** : la faire dès le Lot 3 (bonus token-cheap
   claude/codex) ou rester **injection-only** pour parité stricte des 4 providers
   (précédent graphify) ?
4. **Format canonique** : on adopte bien **`SKILL.md` + frontmatter YAML** (compat
   `agentskills.io` + CLI natifs) comme format d'échange, `skill.json` en
   sur-ensemble optionnel ? Confirmer.
5. **Marketplace** : quelle(s) source(s) par défaut, et quel niveau de confiance
   accordé automatiquement à un import `agentskills.io` / git public ? Source
   built-in `market` ou plugin-connector ?
6. **Granularité de portée au MVP** : rôle suffit-il, ou faut-il worker dès le
   Lot 1 ?
7. **Réconciliation historique** : confirmer que la feature « skills » est bien
   l'endroit sanctionné pour (ré)introduire l'injection d'instructions —
   `plan_plugins.md:357` l'avait **explicitement écartée pour les plugins**. Les
   skills = injection **opt-in par rôle**, distincte de l'auto-annonce des plugins.
8. **Signature** : checksum + revue suffisent au MVP, ou signature crypto exigée
   pour les imports community dès le départ ?

---

### Annexe — carte des fichiers clés (citations)

- Import multi-source : `packages/server/src/modules/plugins/installer.ts:176, 261-377`
- Cycle de vie / crash-isolation : `.../plugins/host.ts:472-642, 61-64, 341-363`
- Capabilities : `.../plugins/api-types.ts:57-74` ; enforcement `.../plugins/api.ts:152-158`
- Manifeste : `.../plugins/manifest.ts:97-132` ; config schema `.../plugins/config-schema.ts`
- Assets outillage : `.../plugins/agent-assets.ts:24, 43-53, 61-109`
- Store plugin : `.../plugins/store.ts:162-181, 469-516`
- Outils MCP plugin : `.../plugins/mcp-registry.ts:80, 139-181` ; montage `.../mcp/server.ts:242`
- Rôles : `.../modules/roles/index.ts:165-202, 277-345` ; table `.../db/schema.sql:54-70`
- Préambule : `.../orchestrator/preamble.ts:74-120, 252-296, 298-337, 365-394`
- Provider claude (config-dir, flags, skills absents) : `.../providers/claude.ts:102-103, 153-171, 276-405, 603`
- Provider codex (skills symlinké) : `.../providers/codex.ts:110` ; cf. `docs/providers.md:82`
- MCP config session : `.../orchestrator/mcp-config.ts:59-94`
- UI : `packages/web/src/App.tsx:15-62` ; `.../components/plugins/InstallPluginModal.tsx:5-11`
- Décisions historiques : `plan_plugins.md:357` ; `docs/graphify-integration.md §5, P5`
- Exemple « skill-like » : `examples/plugins/novelai/` (`agent-assets/GUIDE.md` + outils MCP + configSchema)
