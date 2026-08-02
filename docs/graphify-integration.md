# Intégration de Graphify à swarm-os — plan & proposition de fonctionnement

> Statut : **proposition** (2026-08-02). Aucune ligne de code écrite. Demandé par @eleodas01 :
> « intègre graphify à swarm-os, fais un plan et une proposition de fonctionnement ».
> Grounding code vérifié fichier:ligne par un agent d'exploration + inspection runtime du déploiement `test`.
> Docs sœurs à suivre comme modèle d'exécution : `docs/memoire-partagee.md`, `docs/tableau-de-taches.md`, `docs/garde-fous-approbation.md`.

---

## 0. Décisions figées & résultats du spike P0 (2026-08-02)

**Décisions @eleodas01 (6/6 tranchées)** :
1. **« packages » = dépendances exclues** (`node_modules`, `.venv`, libs vendorisées) ; on n'indexe que le code de 1re partie.
2. **Intégration mémoire = Option A** (séparé mais relié) : graphe = source de vérité hors SQLite + note mémoire auto par scope + outil MCP `codegraph.*` + page web. **Pas** d'ingestion complète dans le graphe mémoire (option B écartée).
3. **Moteur = AST-only gratuit par défaut** ; `extract` LLM en opt-in.
4. **Scopes = sous-dossiers de 1er niveau du workspace + racine du workspace (si code) + plugins installés**, avec **curation guidée par un agent/LLM** (pas une règle purement mécanique).
5. **Fraîcheur = watcher + janitor** ; **surface web = page séparée `#/graph`** (pas un onglet sur `#/memory`).
6. **Oui** à déposer *aussi* la skill Graphify dans les CLI (P5) — et elle couvre **tous nos providers** (claude, codex, gemini, opencode, hermes…), pas seulement claude.

**Résultats du spike P0 (mesurés en local, graphify 0.9.32, host, sur copies — rien déployé)** — verdict **GO** :
- Install `uv tool install graphifyy` → binaires `graphify` + **`graphify-mcp`**, **100 % offline**, ~25 grammaires tree-sitter embarquées (bakeable dans l'image).
- Perf : `storyforge` (63 fichiers 1re-partie ; corpus vu par graphify = 213 fichiers dont docs/Dart) → **4,9 s, 0 token** (3272 nœuds / 5186 arêtes / 193 communautés). Un plugin (9 fichiers) → **0,55 s**.
- **Exclusion (C1) validée** : plugin avec **1834** fichiers `node_modules` → via `.graphifyignore`, **0** occurrence de `node_modules` dans `graph.json`.
- Sortie `graphify-out/` : `graph.json` (~3,4 Mo pour storyforge), `GRAPH_REPORT.md` (hubs/communautés/stats), `graph.html` (~2,9 Mo viz D3), `cache/`, `manifest.json` ; total ~9,4 Mo.
- Requêtes **offline** OK : `graphify explain <nœud>` → nœud + liens typés (`imports_from`, `contains`) + **citations fichier:ligne** ; `graphify path A B` → plus court chemin.

**⚠️ 3 corrections empiriques vs les §2/§6 rédigés depuis des sources secondaires** (le spike les a invalidées) :
- **(a) Le `GRAPH_REPORT.md` n'émet PAS de `[[wikilinks]]` Obsidian** en 0.9.32 (listes markdown simples). ⇒ **c'est swarm-os qui génère les wikilinks** vers la mémoire quand il écrit la note de scope (Option A) ; on ne dépend pas de graphify pour ça.
- **(b) Pas de commande `graphify query`** : l'interface CLI = `path` / `explain` (+ `diagnose`, `cluster-only`, `watch`, `update`, `merge-graphs`…). La requête sémantique/NL passe par **`graphify-mcp`** (serveur MCP stdio/HTTP, `--api-key`, une instance par `graph.json`) ou la **skill**. ⇒ `codegraph.*` = wrapper de `explain`/`path` + recherche de nœuds maison, **ou** proxy vers `graphify-mcp`.
- **(c)** graphify graphe **aussi les docs** (.md/.dart…), pas seulement le code ⇒ **le garde « code détecté » (C3) doit être le nôtre** (scan d'extensions de code AVANT d'invoquer graphify), sinon un dossier docs-only produirait un graphe.

**Raffinement de fraîcheur (mesuré)** : un `graphify update` **sans changement coûte quand même ~4,4 s** (il refait clustering + report + viz à chaque fois). ⇒ le janitor **ne doit pas** lancer graphify à l'aveugle à chaque passe : swarm-os fait **sa propre détection de changement** (mtime/hash des fichiers du scope) et n'invoque `graphify update` **que si du code a bougé**. (Le `--no-viz` n'existe pas sur `update` — c'est `cluster-only --no-viz` / `update --no-cluster` ; tuning P1.)

**Nouvelle option d'archi ouverte par le spike** : `graphify-mcp` peut servir un `graph.json` en **MCP HTTP** (`--transport http --api-key`). Deux voies pour exposer aux agents : (i) **wrapper `codegraph.*` sur le serveur team-comms** (recommandé — provider-agnostique, unifié avec `memory.*`/`board.*`) ; (ii) lancer un `graphify-mcp` par scope et le brancher (plus de process, mais requête NL native). Défaut = (i), (ii) en évolution.

> Le reste du document (§1–§11) est la proposition d'origine. Les points corrigés ci-dessus **priment** sur les formulations de §2/§6.

---

## 1. Objectif

swarm-os possède déjà une **mémoire longue partagée façon Obsidian** (`modules/memory/`) : des notes markdown + wikilinks, écrites par les agents, indexées en SQLite (FTS + vecteurs), consultables en web (`#/memory`). C'est la couche **wiki** : *pourquoi*, décisions, contexte, entités — du savoir **rédigé**.

Il manque la couche **structure** : une **carte automatique du code** (fonctions, classes, imports, appels), tenue à jour toute seule, interrogeable par **sous-graphes compressés** au lieu de lire/grepper des fichiers entiers. C'est exactement ce que fait **Graphify**.

Les deux couches sont **complémentaires** et se rejoignent dans la mémoire :

| Couche | Source | Contenu | Qui l'écrit |
|---|---|---|---|
| **Wiki (déjà livré)** | notes markdown | décisions, contexte, entités | agents & humains |
| **Code graph (ce doc)** | graphify (tree-sitter) | fonctions/classes/imports/appels + communautés | automatique |

Bénéfice principal côté agents : au lieu de charger des fichiers bruts pour comprendre un code, un agent interroge un **sous-graphe ciblé** → Graphify annonce **-70 à -90 % de tokens d'entrée par tour**, avec des réponses citant `fichier:ligne`.

---

## 2. Ce qu'est Graphify (mécanique vérifiée)

- **CLI open-source, Apache-2.0, 100 % on-device** (pas de compte, pas de clé API, pas de télémétrie). Installation : `uv tool install graphifyy` puis `graphify install`.
- **Parsing tree-sitter local**, 40+ langages (Python, TypeScript, Rust, Go, Terraform…). **Zéro coût LLM** pour l'extraction du code (l'AST est gratuit).
- **Commandes clés** :
  - `graphify update <dir>` — mise à jour **incrémentale** (hash **SHA256** par fichier, cache dans `graphify-out/cache/`) : seuls les fichiers modifiés sont reparsés → quasi-instantané quand rien ne change ; **~10 s** sur un vrai monorepo lors d'un gros changement.
  - `graphify update <dir> --force` — rebuild complet.
  - `graphify extract <dir>` — extraction **enrichie par des sous-agents Claude** (⚠️ nécessite une clé API, consomme des tokens). Optionnel.
  - `graphify query "<concept>" --graph graphify-out/graph.json` — renvoie un **sous-graphe** `{nodes, reasoning, answer, summary}`.
  - `graphify path "A" "B" --graph …` — chemin entre deux entités.
  - `graphify explain "<symbol>" --graph …` — explication d'un symbole.
  - `graphify hook install` — pose des **git hooks** `post-commit`/`post-checkout` (⚠️ inutilisable ici, cf. §4 : nos workspaces ne sont pas des dépôts git).
- **Sortie** (dossier `graphify-out/`) :
  - `graph.json` — graphe **NetworkX** requêtable (source de vérité).
  - **`GRAPH_REPORT.md` — rapport markdown avec communautés + wikilinks Obsidian** ← **pont naturel vers notre mémoire**.
  - `graph.html` — visualisation D3 interactive autonome.
  - `cache/` — hashes SHA256 par fichier (moteur incrémental).
- **Exclusion** : fichier `.graphifyignore` (syntaxe gitignore : `node_modules/`, `dist/`, `build/`, `*.lock`, `.env*`…).
- **Entités** : functions, classes, files, imports, concepts, terms. **Relations** : calls, checks, depends-on, references, conceptual-links. Analyse de **communautés / hubs**.
- **Pas de serveur MCP** : Graphify est une **CLI pure** (résultats JSON sur stdout). Explicitement **pas fait pour tourner dans un hook de session synchrone** (trop lent, ~10 s → risque de blocage/CPU) : réservé aux git hooks / arrière-plan.

> Conséquence d'architecture : swarm-os pilote Graphify comme une **CLI en tâche de fond** (jamais dans le chemin bloquant d'un tour d'agent) et **expose lui-même** le graphe aux agents via un outil MCP (puisque Graphify n'a pas de serveur). C'est cohérent avec le reste de la plateforme.

---

## 3. Les contraintes posées par @eleodas01 (et leur traduction)

> « Cet outil doit être exécuté uniquement sur du code du workspace appartenant au projet (pas de packages) ou du code contenu dans les plugins installés (sans les packages). Il doit être maintenu à jour sur modification du code dans le workspace ou d'un plugin et ne doit pas être activé si aucun code n'est détecté. J'aimerais qu'il s'intègre au système de mémoire actuel d'une manière ou d'une autre. »

| # | Contrainte | Traduction technique |
|---|---|---|
| C1 | **Uniquement** le code du **workspace appartenant au projet (pas de packages)** ou le code des **plugins installés (sans les packages)** | Deux périmètres autorisés : (a) chaque **projet du workspace** = sous-dossier de `config.workspaceRoot` ; (b) chaque **plugin installé** = `<dataDir>/plugins/<nom>`. Dans les deux cas, **exclure les dépendances** (`node_modules/`, dossiers de packages vendorisés, `dist`/`build`, lockfiles) via un `.graphifyignore` géré par swarm-os. **On n'indexe que le code de 1re partie.** |
| C2 | **Maintenu à jour** sur modification | Re-index **incrémental** déclenché par (a) un **watcher débouncé** sur les dossiers actifs + (b) l'event `plugin.host.changed` déjà émis à l'install/enable d'un plugin + (c) un **janitor périodique** de secours (balaye aussi les projets/plugins ajoutés ou retirés). `graphify update` incrémental = quasi-gratuit quand rien ne bouge. |
| C3 | **Désactivé si aucun code détecté** | Avant de créer/activer un graphe pour un scope, **scan des extensions de code** parsables par tree-sitter. **0 fichier de code → pas de graphe**, le scope reste désactivé (réévalué à chaque passage). Le workspace du déploiement `test` contient beaucoup de dossiers **docs-only** (histoires, plans) → cette porte est essentielle, pas cosmétique. |
| C4 | **S'intègre à la mémoire actuelle** | Le graphe de code devient **découvrable et navigable dans la mémoire Obsidian** : une **note mémoire auto-gérée par scope** (dérivée du `GRAPH_REPORT.md`, avec wikilinks) + un **outil MCP `codegraph.*`** exposé aux côtés de `memory.*` + une **surface web** partagée. Détail §6. |

> **Interprétation de « packages » à confirmer** (Q1, §10) : je lis « packages » = **dépendances installées** (`node_modules`, libs vendorisées), pas le code de 1re partie. Justification : (a) l'utilisateur oppose « code appartenant au projet » (1re partie) à « packages » ; (b) chaque plugin installé contient un `node_modules/` (vérifié : `~/.swarm-os/test/plugins/discord-agent/{index.js, lib/, node_modules/, plugin.json}`) → « sans les packages » = sans ce `node_modules`. **Nuance monorepo** : dans un dépôt type pnpm, un dossier `packages/` peut être du code 1re-partie (c'est le cas de swarm-os lui-même). La règle par défaut proposée exclut **les dossiers de dépendances** (`node_modules`, `.pnpm`, `vendor`), pas un dossier nommé `packages/` s'il contient du code du projet — à confirmer.

---

## 4. Architecture proposée

### 4.1 Découverte des scopes (quoi indexer)

Un **scope** = une unité indexable indépendante, avec son propre `graphify-out/`. Deux familles :

1. **Projets du workspace** : chaque **sous-dossier de 1er niveau** de `config.workspaceRoot` (`/workspace` en conteneur = host `~/projets/test`). Ex. `discord-agent/`, `storyforge/`, `credtest/`… (les `.md` à la racine du workspace ne sont pas du code → ignorés par C3).
   - *Alternative discutée* (Q4) : au lieu de « tous les sous-dossiers », se limiter aux **cwd réellement utilisés** par les orchestrateurs/leads (un « projet » n'a pas d'entité 1re classe dans swarm-os — c'est un `cwd` sous le workspace, cf. `http/routes/orchestrators.ts` + `http/validation.ts`). Par défaut je propose **par sous-dossier de 1er niveau contenant du code**, plus simple et prévisible.
2. **Plugins installés** : chaque `<dataDir>/plugins/<nom>` listé par `pluginStore.list()` (`modules/plugins/store.ts:285`). On indexe le code 1re partie (`index.js` + `lib/` + tout `.ts/.js` hors deps) et on **exclut `node_modules/`**.

**Porte « code détecté » (C3)** : pour chaque scope candidat, on scanne récursivement (hors dossiers exclus) la présence d'au moins un fichier d'extension parsable (`.ts .tsx .js .jsx .py .rs .go .java .rb .php .c .cpp .cs .tf …`). Si zéro → scope **désactivé**, aucun `graphify-out/` créé.

**`.graphifyignore` géré par swarm-os** : écrit/mis à jour par le serveur dans chaque scope (ou passé en flag). Contenu par défaut : `node_modules/`, `.pnpm/`, `vendor/`, `dist/`, `build/`, `.git/`, `*.lock`, `.env*`, `graphify-out/`, `.swarm-os/`. C'est le mécanisme concret qui matérialise C1 « pas de packages ».

### 4.2 Fraîcheur (C2) — sans dépendre des git hooks

Nos workspaces **ne sont pas des dépôts git** (vérifié : pas de `.git` à la racine de `~/projets/test`) → les git hooks natifs de Graphify sont **hors-jeu**. swarm-os pilote lui-même la fraîcheur, en **3 déclencheurs** :

1. **Watcher débouncé** (déclencheur réactif principal) : `fs.watch(dir, { recursive: true })` (built-in Node — le conteneur tourne **Node 24**, `recursive` supporté sous Linux, **aucune dépendance à ajouter**) sur chaque scope actif, en ignorant les dossiers exclus. À la moindre écriture → on **débounce** (~2-5 s) puis on **enqueue** un re-index de ce scope. (Alternative robuste si `fs.watch` récursif pose souci en volume : ajouter `chokidar` — non présent aujourd'hui.)
2. **Event `plugin.host.changed`** (déjà émis, `events.ts:16`) : install/enable/disable d'un plugin → re-scan des scopes plugins.
3. **Janitor périodique** (filet de sécurité + découverte) : balaye tous les scopes toutes les N minutes (défaut proposé **court**, ex. 5 min, réglable), lance `graphify update` (incrémental → quasi-gratuit si rien n'a changé), et **découvre les scopes ajoutés/retirés** (nouveau projet, plugin installé, projet devenu docs-only, etc.). Modèle exact = `startTaskboardJanitor` (`modules/taskboard/lifecycle.ts:84-116` : `setInterval` + `.unref()` + try/catch + sweep immédiat + `stop()`), knobs env façon `config.ts:640-657`.

**Garde-fous d'exécution** (repris de l'esprit Graphify + du pattern `installer.run`) : une seule ré-indexation à la fois par scope (lock en mémoire), `timeout`, `maxBuffer`, refus si charge CPU/mémoire trop haute. Le re-index ne **bloque jamais** un tour d'agent (tâche de fond pure).

### 4.3 Moteur : AST-only (gratuit) par défaut

Par défaut swarm-os utilise **`graphify update` (AST-only, on-device, sans clé API)** — cohérent avec l'éthique « on-device » de Graphify et avec notre mémoire sémantique par défaut offline. Le mode **`graphify extract` (enrichi LLM, coûte des tokens + clé API)** est **opt-in par déploiement** via env (`SWARM_OS_CODEGRAPH_ENGINE=ast|extract`, défaut `ast`). (Q3)

### 4.4 Stockage

- Sortie Graphify sous **`<dataDir>/codegraph/<scope-id>/graphify-out/`** (`/data/codegraph/…` = **volume persistant**, survit au recreate, comme le vault `memory/`). `<scope-id>` = slug stable dérivé du chemin (ex. `ws__discord-agent`, `plugin__novelai`).
- **`GraphStore`** (nouveau `modules/codegraph/store.ts`) — **possède ses propres tables** `codegraph_*` sur le handle SQLite partagé (idiome `MemoryStore`, `store.ts:14-18` / `473-507` : `CREATE TABLE IF NOT EXISTS`, jamais toucher `schema.sql`). Tables :
  - `codegraph_scopes` : `id, kind(project|plugin), path, enabled, status, node_count, edge_count, last_indexed_at, last_hash, last_error`.
  - (option, plus tard) `codegraph_symbols` : miroir FTS `name → file:line, node_type, scope` pour une recherche native rapide sans relire `graph.json`.
- **`graph.json` reste la source de vérité** du code — **on n'ingère PAS** le graphe entier dans SQLite (un monorepo = des dizaines de milliers de nœuds → noierait le wiki humain et gonflerait la DB). Voir §6 pour ce qu'on ingère (juste un résumé).

### 4.5 Exécution de la CLI Graphify

- Wrapper `execFile` (jamais de shell), `env` explicite, `timeout`, `maxBuffer`, stderr capturé — **calqué sur `modules/plugins/installer.ts:470-503`** (`run(bin,args,cwd)`), le template maison pour lancer un binaire.
- **Sonde de présence** au boot via `spawnSync('graphify', ['--version'])` — modèle `modules/providers/probe.ts:21`. Si absent → feature **désactivée proprement** (log `codegraph.unavailable`, comme `MEMORY_UNAVAILABLE`), le serveur boote quand même.

### 4.6 Déploiement / packaging

- **Graphify n'est installé nulle part** aujourd'hui (ni host, ni conteneur ; `uv`/`graphify` absents ; Python présent : host 3.13, conteneur 3.11 Debian bookworm). Le re-indexeur tourne **dans le conteneur** (côté serveur), lisant `/workspace` (bind-mount) et `/data/plugins`, écrivant `/data/codegraph`.
- ⇒ **Baker Graphify dans l'image** : ajout au `Dockerfile` d'une étape `uv` (ou `pipx`) + `uv tool install graphifyy` + `graphify install` (télécharge les grammaires tree-sitter au build). À surveiller : **taille d'image** et **temps de build** en hausse ; valider que l'install est offline-friendly. (P0 = spike de faisabilité.)
- Pas de traduction de chemin host↔conteneur pour l'indexeur (elle ne concerne que les PTY agents en transport ssh) : `/workspace` et `/data` sont montés dans le conteneur, le job les lit directement.

---

## 5. Pourquoi pas juste « installer la skill Graphify dans chaque CLI claude » ?

Graphify se distribue aussi comme **skill + hook `smart-grep-hook`** pour Claude Code (intercepte `grep`/`find` → requête le graphe). Tentant car nos workers **sont** des CLI claude. Mais :

- swarm-os est **multi-provider** (claude / codex / gemini / opencode). Une skill+hook **claude-only** ne couvrirait pas les autres providers.
- Ça ne serait **ni géré centralement ni tenu à jour** par la plateforme, et **pas relié à la mémoire ni au web**.

⇒ **Reco : indexation gérée côté serveur + exposition par outil MCP** (marche pour **tous** les providers, branchée mémoire + web). On peut **en plus**, en bonus, déposer la skill/`smart-grep-hook` dans les CLI claude comme accélérateur local (Q6, optionnel P5).

---

## 6. Intégration à la mémoire (le cœur de la demande C4)

Trois degrés possibles ; je recommande un **hybride (A + C + web)**.

### Option A — Découvrable via la mémoire (note auto-gérée par scope) — **recommandé**
Pour chaque scope actif, le janitor **écrit/rafraîchit une note mémoire** de type `reference` (ou nouveau type `code`), slug `codegraph-<scope>`, dont le corps est **distillé du `GRAPH_REPORT.md`** de Graphify : top communautés/hubs, compteurs (fichiers, fonctions, classes), date d'index, et surtout des **wikilinks Obsidian vers les entités clés** (Graphify **émet déjà** ces wikilinks → ça tombe pile dans notre graphe wiki). La note porte un flag `managed:true` (ni l'humain ni les agents ne l'éditent à la main ; supprimée si le scope est désactivé/plus de code).
- Effet : un agent qui fait `memory.search("validation du token")` **trouve la carte de code** et peut plonger dedans ; la page web `#/memory` **affiche** le nœud du code lié au wiki.
- Léger, non-bloquant, **ne gonfle pas la DB** (une note par scope, pas des dizaines de milliers de nœuds).

### Option C — Requête à la demande (outil MCP `codegraph.*`) — **recommandé**
Nouveau jeu d'outils MCP, exposé à **tous les agents** via le serveur team-comms unique (comme `memory.*` / `board.*`), enregistré à `modules/mcp/server.ts:234` via `registerGraphTools(server, () => ctx)` + champ `graph` sur `ToolContext` (`modules/mcp/tools.ts`) :
- `codegraph.list()` — scopes indexés (+ statut, compteurs).
- `codegraph.query({ scope, q })` — délègue à `graphify query` → renvoie le **sous-graphe compressé** (c'est ici que se gagnent les **-70/-90 % de tokens**).
- `codegraph.path({ scope, from, to })`, `codegraph.explain({ scope, symbol })`.
- Directive de préambule (`default-lead.md` + `default-worker.md`, + noms logiques dans `TEAM_TOOL_LOGICAL_NAMES`, cf. le patron mémoire/taskboard) : *« tu disposes d'une carte de code vivante — interroge-la avant de lire/greper des fichiers »*.

### Option B — Ingestion unifiée dans le graphe mémoire — **écarté par défaut** (proposé en Q2)
Ingérer `graph.json` comme **nœuds/arêtes de 1re classe** dans le store mémoire (namespace/type `code-entity`), pour un **graphe unique** wiki+code. Le plus « intégré » visuellement, mais : volume (bloat SQLite + bruit dans le wiki), et couplage fort. **Réservé au futur** si l'utilisateur veut vraiment un seul graphe. (La mémoire a déjà des DTO `GraphNode`/`GraphEdge` réutilisables — `store.ts:103/109` — donc faisable, mais je ne le mets pas par défaut.)

### Surface web
Une **surface « CODE GRAPH »** : soit un **2e onglet** sur la page `#/memory`, soit un **overlay frère `#/graph`**. Sélecteur de scope (projet/plugin) + recherche + vue sous-graphe. On **réutilise** le composant de rendu de graphe de la mémoire, ou on **embarque** le `graph.html` autonome de Graphify. Wiring identique aux overlays existants (§7). (Q5 : onglet vs page séparée.)

> **Résumé C4** : le code graph **vit à côté** du wiki (source de vérité = `graphify-out/`, hors SQLite), mais **entre dans la mémoire** par (A) des notes auto-gérées avec wikilinks, (C) un outil `codegraph.*` à côté de `memory.*`, et une surface web commune. « Intégré à la mémoire », sans la noyer.

---

## 7. Points d'insertion vérifiés (fichier:ligne)

**Backend — `packages/server/src/`**
- **Store** : nouveau `modules/codegraph/store.ts` (`class GraphStore(swarmDb, { dataDir, eventBus })`, tables `codegraph_*` sur `swarmDb.db`) — idiome `modules/memory/store.ts:14-18` / `421-607` / DDL `473-507` / reindex boot `722-760`.
- **Runner CLI** : `modules/codegraph/graphify.ts` (`execFile` + probe) — modèle `modules/plugins/installer.ts:470-503` (run) & `modules/providers/probe.ts:21` (probe).
- **Découverte scopes** : lit `config.workspaceRoot` (`config.ts:96/662`) + `pluginStore.list()` (`modules/plugins/store.ts:285`) ; plugins dir `<dataDir>/plugins` (`config.ts:671`).
- **Janitor + watcher** : `modules/codegraph/lifecycle.ts` — modèle `modules/taskboard/lifecycle.ts:84-116` ; knobs env `config.ts:640-657` (`SWARM_OS_CODEGRAPH_*`).
- **Instanciation** : `src/index.ts` à côté du bloc mémoire (`152-175`), try/catch (feature optionnelle), exposé au spawner (`331-333`) et au serveur HTTP (`642`) ; janitor démarré (~`372-391`) et `stop()` au shutdown (~`766-768`).
- **MCP** : `modules/mcp/codegraph-tools.ts` (`registerGraphTools`) appelé dans `modules/mcp/server.ts:234` ; `ctx.graph` peuplé depuis `spawner.graph` (~`server.ts:333`) ; type dans `modules/mcp/tools.ts`.
- **REST** : `http/routes/codegraph.ts` (`createGraphRouter`) monté derrière auth dans `http/main.ts:337` (à côté de memory/taskboard/approvals).
- **Events** : `code.graph.indexed | scope_enabled | scope_disabled` ajoutés à l'union ouverte `events.ts:23-27` (additif, rebroadcast `/ws/events`).
- **Préambule** : sections dans `modules/preambles/default-lead.md` + `default-worker.md` + noms logiques `orchestrator/preamble.ts` `TEAM_TOOL_LOGICAL_NAMES` (+ `preamble.test.ts`).

**Frontend — `packages/web/src/`** (patron overlay mémoire/board)
- `App.tsx` : union `Route` (14-23) + `parseHash` (`#/graph`) + prop `onOpenGraph` (105-119) + overlay monté (125-160, template `MemoryPage` 132-135).
- `components/desktop/TopBar.tsx` : bouton `CODE GRAPH` (décls 59-65, rendu 178-186), icône stroke-only dans `icons.tsx`.
- `controller/SwarmController.tsx` : `graphRev` + `onGraphEvent` (modèle `memoryRev` 476-481), passthrough props (64-84).
- `hooks/useEvents.ts` : branche `ev.kind.startsWith('code.graph.')` (modèle `memory.` ligne 370).
- `api/client.ts` : DTO + `listCodeGraph`/`queryCodeGraph`/… (modèle memory 1450-1489) ; `hooks/useCodeGraph.ts` + `components/CodeGraphPage.tsx` (clone `MemoryPage.tsx`/`BoardPage.tsx`).

**Déploiement**
- `Dockerfile` : étape d'install Graphify (uv + `uv tool install graphifyy` + `graphify install`).
- Procédure de mise en ligne = celle des features backend (rebuild image `swarm-os:latest` + recreate `docker-compose.test.yml`) ; **sync plugin JS** seulement si on ajoute aussi la skill claude (P5).

---

## 8. Plan phasé

Exécution séquentielle, 1 worker par phase, branche dédiée `feat/codegraph`, verts exigés (build tsc server + web, tests ciblés + suite, seul flake toléré = `persistence.test.ts` ENOENT préexistant), rapport au lead à chaque phase, je vérifie chaque phase (recette §RECETTE des docs sœurs). **Pas de déploiement sans l'aval explicite de @eleodas01.**

- **P0 — Spike de faisabilité** (pas de code produit final) : installer Graphify dans l'image, lancer `graphify update` **à la main** sur 1 projet workspace (ex. `storyforge`) + 1 plugin (ex. `novelai`), vérifier `graph.json` + `GRAPH_REPORT.md`, valider l'exclusion `node_modules`, **mesurer le temps** et la taille de sortie. Valider AVANT de bâtir l'infra. Livrable = note de faisabilité + décision go/no-go sur le packaging.
- **P1 — Indexeur cœur + store** : `modules/codegraph/` (découverte scopes + porte C3 « code détecté » + `.graphifyignore` géré + runner `execFile` + probe + `GraphStore` + stockage `/data/codegraph`) ; **janitor + watcher débouncé** ; instanciation `index.ts` (try/catch, optionnel) ; config knobs. Tests. **À ce stade le graphe existe et se maintient, invisible pour les agents.**
- **P2 — Outils MCP + préambule** : `codegraph.list/query/path/explain` (délègue à la CLI), enregistrement `mcp/server.ts:234`, `ToolContext.graph`, directive préambule lead/worker + `TEAM_TOOL_LOGICAL_NAMES`. Tests. **Les agents peuvent interroger le graphe (gain tokens).**
- **P3 — Intégration mémoire (C4)** : note mémoire `reference` auto-gérée par scope, dérivée du `GRAPH_REPORT.md` (wikilinks), réécrite à chaque re-index, `managed:true`, supprimée si scope désactivé. REST `createGraphRouter` + events `code.graph.*`. **Le code graph entre dans la mémoire Obsidian + temps réel web.**
- **P4 — Surface web** : page/onglet CODE GRAPH (sélecteur de scope, recherche, vue sous-graphe ; réutilise le rendu graphe mémoire ou embarque `graph.html`). Wiring App/TopBar/SwarmController/useEvents/client.
- **P5 — Extras (sur demande)** : mode `extract` LLM opt-in ; réglages par rôle/projet (exclusions custom, on/off) ; skill + `smart-grep-hook` claude comme accélérateur local ; option B (ingestion unifiée) ; git-hook fast-path pour un projet qui *serait* un dépôt git ; export.

---

## 9. Risques & points d'attention

- **Packaging Graphify dans l'image** (poids, temps de build, grammaires tree-sitter au build offline) → dé-risqué en **P0**.
- **`fs.watch` récursif** sous forte volumétrie (beaucoup de fichiers) : fallback `chokidar` (nouvelle dépendance) si nécessaire. Le janitor périodique reste le filet.
- **Volume du graphe** d'un gros repo → **ne pas** ingérer dans SQLite (option B écartée par défaut).
- **Coût CPU** des re-index → garde-fous (lock par scope, timeout, seuils charge, débounce). `graphify update` incrémental = quasi-nul si rien ne change.
- **Latence de fraîcheur** : quelques secondes (watcher) à quelques minutes (janitor). « À jour » ≠ « instantané ». (Q5 confirme le compromis.)
- **Où est « le projet »** : pas d'entité 1re classe → je propose « sous-dossier de 1er niveau du workspace contenant du code ». (Q4.)
- **Sécurité** : `execFile` sans shell (pas d'injection), scopes strictement bornés au workspace/plugins (réutilise `validateCwdUnderWorkspace`, `http/validation.ts:27`).

---

## 10. Décisions à trancher (questions)

1. **« packages »** = exclure les dépendances (`node_modules`, libs vendorisées) et n'indexer que le code de 1re partie — OK ? (défaut proposé) Un dossier littéralement nommé `packages/` mais contenant du code du projet doit-il être indexé ou exclu ?
2. **Profondeur d'intégration mémoire** : hybride **A+C+web** (note résumé auto + outil `codegraph.*` + surface web ; source de vérité = `graphify-out/` hors SQLite) — **ma reco**. Ou tu veux la structure du code comme **nœuds de 1re classe dans le MÊME graphe mémoire** (option B, plus lourd) ?
3. **Moteur** : **AST-only gratuit** par défaut, `extract` LLM (clé API, tokens) en **opt-in** — OK ?
4. **Granularité des scopes** : **par sous-dossier de 1er niveau du workspace** + **par plugin installé** — OK ? (vs un seul graphe pour tout le workspace, ou par cwd d'orchestrateur.)
5. **Fraîcheur & web** : watcher débouncé + janitor périodique (latence quelques s→min) acceptable ? Surface web = **onglet sur `#/memory`** ou **page séparée `#/graph`** ?
6. **Bonus** : déposer *aussi* la skill Graphify + `smart-grep-hook` dans les CLI claude (accélérateur claude-only, P5) — souhaité ou non ?

---

## 11. Sources (Graphify)

- Site officiel — https://graphify.com/ (Apache-2.0, on-device, graph tracé/cité).
- Mécanique self-update + git hooks + resource guards + stockage `graphify-out/` — https://dev.to/mir_mursalin_ankur/graphify-code-review-graph-build-a-self-updating-knowledge-graph-for-claude-code-and-other-ai-j1m
- UX de requête / sous-graphes / économie 70-90 % tokens — https://www.mindstudio.ai/blog/how-to-use-graphify-skill-knowledge-graph-ai-agents
- Aperçu tree-sitter / 40+ langages / intégrations AI — https://www.mindstudio.ai/blog/graphify-knowledge-graph-ai-agent
