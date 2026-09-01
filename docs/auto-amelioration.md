# Auto-amélioration — learning loop, skills auto-écrits, optimiseur réflexif

> Statut : **plan validé, non implémenté**. Découpage en lots au §8.
> Branche cible : à créer depuis `master` après merge de `feat/skills-library`.

## 1. Contexte

`docs/comparatif-hermes-agent.md:53` porte la dernière ligne rouge de la comparaison avec Hermes Agent :

> | Auto-amélioration | **Aucune** | Learning loop, création autonome de skills, GEPA, pipeline RL Atropos |

Et le §6 le redit : « swarm-os n'a pas encore d'agent auto-améliorant ni de skills auto-générés (il délègue au CLI) ».

Trois écarts majeurs ont été comblés en 2026-08 (mémoire partagée Obsidian, Kanban durable, garde-fous d'approbation) et la bibliothèque de skills vient de se terminer (`3892302`, Lot 4b). Il reste ce pilier — et c'est le seul qui transforme swarm-os d'un orchestrateur en un système qui s'améliore avec l'usage.

**Le problème concret** : swarm-os produit déjà tous les signaux nécessaires et n'en consomme aucun. Les codes de sortie de session, les cartes rouvertes, les refus d'approbation, les transcripts PTY, le verdict `computeOrchestratorHealth` — tout est écrit, rien n'est lu. Une équipe qui se plante sur un piège du dépôt se replantera dessus demain. La mémoire partagée existe bien, mais elle ne se remplit que si un agent pense à écrire, et personne ne vérifie que ce qu'il a écrit était vrai.

**Le résultat visé** : une boucle fermée — capturer le signal des runs, le distiller en connaissance vérifiée, la réinjecter, et mesurer si ça a marché.

Nommage retenu : module `modules/learning/`, préfixe env `SWARM_OS_LEARNING_*`, événements `learning.*`.

**Règle de branche** : ne pas toucher `docs/comparatif-hermes-agent.md` depuis une branche de feature (réservé, cf. `docs/plan-skills-importables.md:12`). La mise à jour de la ligne §3 se fait séparément, une fois les lots livrés.

---

## 2. Décisions de cadrage

Quatre points arbitrés avant la conception ; ils changent la forme du plan.

### 2.1 Atropos est écarté

Atropos est un framework d'entraînement de *poids* : les environnements postent des `ScoredDataGroup` (tokens + masks + scores) sur une API, un trainer tire des batches sur `/batch` et rétropropage. Trois raisons de ne pas le suivre :

1. **Les agents swarm-os tournent sur des poids non entraînables** — `claude`, `codex`, `gemini` sont des CLI sur modèles fermés. Faire du RL supposerait de basculer sur un open-weights local, donc d'entraîner un petit modèle à devenir une version médiocre de ce qu'on a déjà.
2. **Le coût de rollout est prohibitif** — un rollout ici est une mission agentique complète (minutes à heures, workspace isolé), là où le RL en exige des milliers par groupe, plus GPU, serveur d'inférence et trainer.
3. **Blocage technique dur** — `packages/server/src/modules/providers/opencode.ts:138` est câblé sur OpenRouter (`OPENCODE_MODEL_PREFIX = 'openrouter/'`, clé API requise). Aucun provider ne peut pointer sur un vLLM/SGLang local. Ce chantier « provider OpenAI-compatible » est valable en soi (modèles locaux, Ollama, LM Studio — cf. le gap « backends LLM » du §3 du comparatif), mais il est indépendant de ce plan.

**Ce qui est conservé** : le registre d'épisodes scorés, et un export JSONL au format `ScoredDataGroup` (Lot 8a). Si le besoin réapparaît, la donnée sera là.

### 2.2 GEPA est remplacé par un optimiseur réflexif maison

GEPA a raison sur le fond : la « policy » de swarm-os est du texte (préambules, prompts de rôle, `body_md` des skills), et son papier (arXiv 2507.19457) revendique de battre GRPO de 6 à 20 % avec jusqu'à 35× moins de rollouts, précisément parce qu'il fait muter du texte en lisant les traces plutôt qu'en écrasant tout en un scalaire.

Mais la lib est Python, et son contrat `evaluate(batch, candidate, capture_traces) -> EvaluationBatch{outputs, scores, trajectories}` suppose de **ré-exécuter le système** sur un lot de tâches. Chez nous, un jeu de tâches ré-exécutables (snapshot de dépôt figé + vérification objective) est un chantier à lui seul.

Le Lot 7 reprend donc le mécanisme central de GEPA — mutation réflexive à partir des traces textuelles d'échec — et remplace l'évaluation hors-ligne par un **A/B en production** sur les épisodes réels. Délibérément abandonnés : la sélection sur front de Pareto, le crossover/merge, la comptabilité de budget de rollouts. Le dataset réflexif est néanmoins produit à la forme `{Inputs, Generated Outputs, Feedback}` attendue par GEPA, pour laisser la porte ouverte.

### 2.3 Création de skills : proposition + revue humaine, sans exception

La machine rédige, l'humain active. **Aucune variable d'environnement ne peut supprimer la porte de revue.**

### 2.4 Les quatre sources de signal sont retenues

Runtime automatique, retour humain explicite, LLM-juge, rétro post-mission.

---

## 3. La frontière d'épisode

**Un épisode est le cycle de vie d'une carte du task-board.** C'est la décision structurante.

La durée de vie de l'orchestrateur ne convient pas : une équipe swarm-os est *persistante* par conception (`resume_count`/`last_resumed_at` sur `orchestrators`, auto-resume au boot via `modules/orchestrator/persistence.ts loadResumableState`), elle vit des jours, et sa fin est un événement rare et souvent accidentel — quelques dizaines d'échantillons par an.

La carte est déjà l'unité de travail du produit : `board.create` porte l'énoncé (`title` + `body`, c'est-à-dire le prompt), `assignee_session_id` porte l'acteur, `todo→doing→review→done` porte la trajectoire, `closed_at`/`reopened` portent l'issue, et `taskboard_events` (`modules/taskboard/store.ts:339`) est un **journal append-only déjà écrit** — une trajectoire gratuite. Le préambule lead impose déjà d'en créer une par sous-tâche.

Trois genres dans une seule table, discriminés par `kind` :

| kind | `scope_id` | ouvre sur | ferme sur |
|---|---|---|---|
| `card` (**primaire**) | `taskboard_cards.id` | `taskboard.card_created` | `taskboard.card_closed` |
| `session` (filet hors carte, workers seulement) | `sessions.id` | `session.created` | `session.exited` |
| `orchestration` (conteneur, `parent_episode_id` des autres) | `orchestrators.id` | `orchestrator.created` | `orchestrator.destroyed` |

Corollaire : comme les équipes ne meurent presque jamais, **la rétro ne peut pas être déclenchée par `orchestrator.destroyed` seul**. Elle opère sur une fenêtre — « les épisodes fermés et scorés depuis la dernière rétro de cette équipe » — déclenchée par l'un de : destruction, cron (patron `CronScheduler`, `modules/crons/scheduler.ts`), seuil de N épisodes non distillés, ou appel manuel.

---

## 4. Modèle de données

Cinq tables possédées par `packages/server/src/modules/learning/store.ts`, créées via `CREATE TABLE IF NOT EXISTS` sur le handle brut `SwarmDb.db` — convention dure du dépôt (`modules/memory/store.ts:14-24`, `modules/skills/store.ts:88-121`). **Aucune touche à `db/schema.sql` ni à `INLINE_SCHEMA`, aucune colonne nouvelle sur les tables cœur, donc `applyMigrations` (`db/index.ts:520`) n'est pas modifié.**

**Divergence délibérée, à justifier dans l'en-tête du fichier : pas de `FOREIGN KEY`.** `taskboard_cards` déclare `ON DELETE CASCADE` vers `orchestrators` (`taskboard/store.ts:325`) avec `PRAGMA foreign_keys = ON`. Un CASCADE ici détruirait le jeu de données au moment où l'opérateur supprime une équipe — l'inverse exact du besoin. Ids en TEXT nu, résolus best-effort à la lecture ; **un épisode survit à son orchestrateur**.

```sql
CREATE TABLE IF NOT EXISTS learning_episodes (
  id                  TEXT PRIMARY KEY,     -- ep_<uuid>
  schema_version      INTEGER NOT NULL DEFAULT 1,
  kind                TEXT NOT NULL,        -- card | session | orchestration | manual
  scope_id            TEXT NOT NULL,
  parent_episode_id   TEXT,
  orchestrator_id     TEXT, session_id TEXT, role_id TEXT,
  state               TEXT NOT NULL,        -- open|closed|scored|distilled|discarded

  -- ENTRÉE (l'énoncé = le "prompt" du dataset)
  task_title          TEXT,
  task_input          TEXT,
  task_hash           TEXT,                 -- sha256(task_input normalisé) — clé de groupe
  attempt             INTEGER NOT NULL DEFAULT 1,

  -- IDENTITÉ DE POLITIQUE (ce que l'optimiseur fait varier)
  provider TEXT, model TEXT, effort TEXT, permission_mode TEXT,
  preamble_hash       TEXT,                 -- sha256 du préambule résolu au spawn
  preamble_ref        TEXT,                 -- <dataDir>/learning/preambles/<hash>.md
  skills_json         TEXT,                 -- [{name,version,scope}] actifs au spawn
  insights_json       TEXT,                 -- [insightId] injectés au spawn
  policy_json         TEXT,                 -- {textVersions:{leadPreamble:'tv_…'}} — bras A/B

  -- TRAJECTOIRE
  trajectory_path     TEXT,                 -- <dataDir>/learning/episodes/<id>/trajectory.ndjson
  trajectory_steps    INTEGER NOT NULL DEFAULT 0,
  trajectory_bytes    INTEGER NOT NULL DEFAULT 0,
  artifacts_json      TEXT,                 -- {logPaths,cardIds,memoryNotes,approvalIds}

  -- ISSUE + RÉCOMPENSE
  outcome             TEXT,                 -- success|partial|failure|aborted|unknown
  reward              REAL,                 -- [-1,1] ; NULL = non scoré
  reward_components_json TEXT,              -- {runtime:{p,w},human:{p,w},judge:{p,w},retro:{p,w}}
  reward_source       TEXT, confidence REAL,

  -- TEMPS / COÛT
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  tokens_in INTEGER, tokens_out INTEGER,
  tokens_cache_read INTEGER, tokens_cache_write INTEGER,
  cost_usd REAL, cost_basis TEXT,           -- estimated | reported (jamais deviné)

  signal_count INTEGER NOT NULL DEFAULT 0,
  scored_at TEXT, distilled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_le_state    ON learning_episodes(state);
CREATE INDEX IF NOT EXISTS idx_le_scope    ON learning_episodes(kind, scope_id);
CREATE INDEX IF NOT EXISTS idx_le_orch     ON learning_episodes(orchestrator_id, started_at);
CREATE INDEX IF NOT EXISTS idx_le_group    ON learning_episodes(task_hash);
CREATE INDEX IF NOT EXISTS idx_le_unscored ON learning_episodes(state, ended_at);

CREATE TABLE IF NOT EXISTS learning_signals (
  id TEXT PRIMARY KEY, episode_id TEXT NOT NULL,
  source TEXT NOT NULL,      -- runtime | human | judge | retro
  kind TEXT NOT NULL,        -- session.exited | card.closed | approval.denied | thumb | judge.score …
  polarity REAL,             -- [-1,1] ; NULL = descriptif
  weight REAL NOT NULL DEFAULT 1,
  value_json TEXT, actor TEXT,
  dedupe_key TEXT UNIQUE,    -- 'runtime:session.exited:<sessionId>' — idempotence au replay
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ls_episode ON learning_signals(episode_id, ts);

CREATE TABLE IF NOT EXISTS learning_insights (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL, scope_id TEXT,       -- global | role | orchestrator
  title TEXT NOT NULL, body TEXT NOT NULL,  -- instruction impérative, <= 600 car.
  category TEXT,                            -- pitfall|procedure|convention|tool-usage|anti-pattern
  state TEXT NOT NULL,                      -- proposed | active | retired | rejected
  evidence_json TEXT,                       -- {episodeIds, orchIds, skillsActive}
  support INTEGER NOT NULL DEFAULT 1,
  contradiction INTEGER NOT NULL DEFAULT 0,
  distinct_orchs INTEGER NOT NULL DEFAULT 1,
  score REAL, memory_note TEXT, promoted_skill TEXT, run_id TEXT,
  fingerprint TEXT UNIQUE,                  -- sha256(scope|scope_id|titre normalisé)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_li_active ON learning_insights(state, scope, scope_id);

-- exécutions modèle : juge | rétro | auteur | optimiseur
CREATE TABLE IF NOT EXISTS learning_runs (
  id TEXT PRIMARY KEY,                      -- lrun_<iso>_<short> — trié par construction
  kind TEXT NOT NULL, state TEXT NOT NULL,  -- scheduled|preparing|calling|parsing|success|failed|refused|cancelled
  trigger TEXT NOT NULL,                    -- event|cron|threshold|manual
  scope_json TEXT, run_dir TEXT NOT NULL,   -- <dataDir>/learning/runs/<id>/
  provider TEXT, model TEXT, episode_count INTEGER NOT NULL DEFAULT 0,
  input_bytes INTEGER, output_bytes INTEGER, cost_usd REAL,
  started_at TEXT, finished_at TEXT, error TEXT, log_tail TEXT
);
CREATE INDEX IF NOT EXISTS idx_lr_state ON learning_runs(state);

CREATE TABLE IF NOT EXISTS learning_skill_drafts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
  display_name TEXT, description TEXT,
  body_md TEXT NOT NULL, frontmatter_json TEXT,
  rationale TEXT, evidence_json TEXT,
  cluster_key TEXT,                         -- sha256(insightIds triés) — clé de cooldown
  state TEXT NOT NULL,                      -- proposed|approved|installed|rejected|superseded
  run_id TEXT, installed_skill TEXT, reject_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT,
  UNIQUE(name, version)
);
```

Le Lot 7 ajoute une sixième table `learning_text_versions` (voir §7).

**Robustesse** : chaque méthode du store en try/catch → `null`/`[]`/`0` + `log.warn`, jamais de throw (style `MemoryStore`/`SkillStore`, et non `UpdateStore` qui throw parce qu'il gère des jetons de rollback — pas notre cas : perdre un épisode est acceptable, tomber ne l'est pas). Plus un `assertReady()` au boot façon `updates/store.ts:196` : perdre silencieusement chaque écriture pendant six mois est le mode de défaillance exact qu'on veut rendre bruyant **au boot**.

### 4.1 Jointures avec l'existant

| Colonne learning | Table cœur | Accès |
|---|---|---|
| `scope_id` (kind=card) | `taskboard_cards.id` | `TaskboardStore.getCard` |
| `scope_id` (kind=session) / `session_id` | `sessions.id` | `SwarmDb.listSessions(orchId)` |
| `scope_id` (kind=orchestration) | `orchestrators.id` | `SwarmDb.getOrchestrator` |
| `role_id` | `roles.id` | `RoleStore.get` |
| `artifacts_json.logPaths[]` | `sessions.log_path` | `readLogTail` (`log-tail-reader.ts:23`) |
| `artifacts_json.approvalIds[]` | `approval_requests.id` | `ApprovalStore` |
| `skills_json[].name` | `skills.name` | `SkillsSubsystem.activeForSession` |
| `learning_insights.memory_note` | `memory_nodes.name` | `MemoryStore.readNote` |
| `learning_skill_drafts.installed_skill` | `skills.name` (`source_ref='learning:<draftId>'`) | jointure bidirectionnelle |

### 4.2 Ce qui existe explicitement pour un export d'entraînement

- **Dataset d'éval** : `task_input`/`task_title` (entrée), `provider`/`model`/`effort`/`permission_mode`/`preamble_hash`/`preamble_ref`/`skills_json`/`insights_json`/`policy_json` (le programme de prompt complet, **reconstructible byte-exact** via `preamble_ref`), `outcome`+`reward` (label), `artifacts_json` (sorties vérifiables).
- **Rollout scoré** : `trajectory_path` (NDJSON ordonné), `reward` borné `[-1,1]`, `reward_components_json` (récompense **décomposée** — indispensable pour diagnostiquer le reward hacking et re-pondérer sans re-collecter), `confidence`.
- **Groupement type GRPO** : `task_hash` + `attempt` (N tentatives du même énoncé = un groupe) ; `parent_episode_id` pour le groupe hiérarchique.
- **Versionnage** : `schema_version` par épisode, pour qu'un dataset exporté reste lisible après un changement de forme.

Un pas de trajectoire (NDJSON) :

```json
{"t":"2026-08-03T12:00:01.234Z","step":7,"type":"card.moved","actor":"<sessionId>","data":{"from":"doing","to":"review"}}
```

`type` ∈ `card.*` | `session.*` | `mailbox` | `approval.*` | `memory.write` | `transcript` (ce dernier uniquement si `SWARM_OS_LEARNING_CAPTURE_TRANSCRIPT=true`, cf. §9).

---

## 5. Collecte des signaux

Un module `modules/learning/collector.ts` avec **un seul** `eventBus.onEvent` (`packages/server/src/events.ts:177`) — **zéro modification du chemin chaud** : `session.ts`, `orchestrator/index.ts` et `persistence.ts` restent intacts. Le bus est un `EventEmitter` synchrone (un handler lent bloque l'émetteur), donc le collecteur **met en file en mémoire et vide sur timer `unref()`** (patron `metrics/aggregator.ts`) ; aucune I/O disque ni SQLite dans le handler.

### 5.1 Source (a) — runtime automatique

| Événement du bus | Effet | polarité / poids |
|---|---|---|
| `orchestrator.created` / `session.created` / `taskboard.card_created` | ouvre l'épisode, renseigne l'identité de politique | — |
| `taskboard.card_closed` | **ferme** l'épisode carte | +0.5 / 1.0 |
| `taskboard.card_reopened` | **rouvre**, `attempt++` | −0.4 / 1.5 |
| `taskboard.card_moved → blocked` | signal | −0.15 / 0.5 |
| `taskboard.card_orphaned` | assignee mort | −0.3 / 1.0 |
| `session.status_changed → failed` | signal | −0.5 / 1.0 |
| `session.exited` | **ferme** l'épisode session | exit 0 → +0.3 / 1.0 ; failed → −0.6 / 1.0 ; killed/interrupted → 0 / 0.2 |
| `approval.resolved` `denied` | l'humain a refusé l'action de l'agent | −0.5 / **2.0** |
| `approval.resolved` `approved` | signal faible | +0.05 / 0.3 |
| `memory.node_created` | l'agent a capitalisé | +0.05 / 0.2 |
| `mailbox.message` | trajectoire seulement (volume) | — |

Le payload de `taskboard.card_created` ne porte que `{cardId, orchestratorId}` : titre et corps sont relus via `TaskboardStore.getCard`. Lus à la fermeture, hors bus : `computeOrchestratorHealth` (`orchestrator/health.ts:53`) via `orch.toView().health` (`'bad'` → −0.4 sur l'épisode orchestration), et `sessions.last_error`/`stop_reason` en signal descriptif.

### 5.2 Source (b) — retour humain explicite

`POST /learning/episodes/:id/feedback {rating: -1|0|1, comment?, tags?}` → signal `source='human'`, **poids 3.0**. Contrôles pouce/commentaire sur chaque ligne d'épisode dans `#/learning` et sur le détail d'une carte fermée. Le poids humain domine structurellement le runtime (1.0) et le juge (2.0) : **l'humain a toujours le dernier mot sur la récompense**. Les décisions d'approbation déjà persistées ne sont pas redemandées — elles arrivent par la source (a).

### 5.3 Normalisation

`modules/learning/reward.ts`, fonction **pure**, sans `Date.now()` ni I/O (patron `health.ts`), à tester exhaustivement :

```
reward     = clamp( Σ(wᵢ·pᵢ) / Σ(wᵢ), -1, 1 )
confidence = min(1, Σ(wᵢ) / 6)
outcome    = reward >= 0.4 → success | <= -0.4 → failure | Σw > 0 → partial
             | annulé → aborted | sinon unknown
reward_source = 'human' si un signal humain existe, sinon la source de plus grand Σw
```

`reward_components_json` conserve `{source: {p, w}}` **par source** : c'est ce qui permet de repérer un épisode « bon » uniquement par sa composante runtime (donc probablement triché), et de re-pondérer un dataset exporté sans re-collecter.

---

## 6. Appeler un modèle depuis le serveur

Le seul précédent, `modules/ai/improve-via-ssh.ts:66`, est **SSH-only** (`:70`), claude-only et figé sur trois prompts en dur. `hostExec` (`ssh-exec.ts:227`) est aussi SSH-only et ferme stdin. Le vrai précédent bi-transport est **`providers/probe.ts:48 probeCliBinary`** : `local` → `spawn(binary, args)` dans notre namespace (le Dockerfile installe `@anthropic-ai/claude-code` globalement, `Dockerfile:146`), `ssh` → `hostExec` sous `bash -lc`.

**Décision : un appel headless dédié, agnostique du provider** — `packages/server/src/modules/ai/headless.ts` :

```ts
export async function runHeadless(config, registry, input: HeadlessCallInput, deps?)
  : Promise<{ok: true; text; outputBytes; durationMs}
          | {ok: false; reason: 'UNSUPPORTED_PROVIDER'|'TRANSPORT_UNAVAILABLE'|'TIMEOUT'|'EXIT'; detail}>
```

Prompt **sur stdin, jamais sur argv** (argv est lisible par `ps`). Sinks bornés en octets (patron `makeSink`, `ssh-exec.ts:190`). **Jamais de throw** — toute défaillance est une valeur (doctrine `updates/github.ts`, `catalogue.ts`). `deps.spawnImpl` injectable, donc aucun test ne touche un vrai CLI (patron `HostExecDeps.spawnImpl`, `ssh-exec.ts:76`).

La connaissance CLI reste dans l'adaptateur : ajout d'un membre **optionnel** à `AgentProvider` (`providers/types.ts:388`), non cassant pour les 4 adaptateurs et les doubles de test :

```ts
/** Argv for a one-shot, non-interactive call reading the prompt on stdin.
 *  `null` when this CLI has no usable headless mode. */
headlessArgs?(opts: { model: string }): readonly string[] | null;
```

`claude.ts` → `['-p','--model',model,'--output-format','text']` (forme déjà validée en production par `improve-via-ssh.ts:55`). Les trois autres renvoient `null` en v1 → `UNSUPPORTED_PROVIDER` → dégradation propre. `improveTextViaSsh` reste **inchangé** ; sa réécriture au-dessus de `runHeadless` est un suivi.

**Alternative rejetée : spawner une équipe éphémère** (`Spawner.create` avec un rôle `retro`). Le retro-agent produirait ses propres `session.created`/`session.exited`/cartes, donc **des épisodes sur lui-même** ; il consommerait un slot `SWARM_OS_MAX_ORCHESTRATORS` et apparaîtrait sur la carte de l'opérateur ; et sa complétion ne serait observable qu'en attendant `orchestrator.destroyed`. Gardée en mode alternatif non implémenté (`SWARM_OS_LEARNING_RETRO_MODE=headless|team`) pour une rétro lourde devant lire le dépôt.

**Machine à états des runs** — `modules/learning/runner.ts` reproduit la forme de `updates/runner.ts` + `run-files.ts` :

```
scheduled → preparing → calling → parsing → success
                      ↘ failed | refused | cancelled
```

`TERMINAL_LEARNING_RUN_STATES` exporté comme `TERMINAL_UPDATE_STATES` (`updates/store.ts:45`). Répertoire par run `<dataDir>/learning/runs/<id>/` avec `prompt.txt`, `raw.txt` (la sortie brute du modèle — l'artefact de débogage qui manque toujours), `result.json` (autoritatif), `events.ndjson`. **Exclusivité** : un seul run non terminal à la fois ; un second déclencheur est `refused`, pas mis en file.

**Contrats de prompt** (sortie stricte, parsée côté serveur, `stripOuterFence` réutilisé depuis `improve-via-ssh.ts:59`) :

- **juge** — ≤ 20 épisodes fermés non scorés, chacun résumé en ≤ 4 Ko (énoncé, issue runtime, résumé de trajectoire, artefacts) → `{"scores":[{episodeId, score, rationale, tags}]}`. Toute entrée dont l'`episodeId` n'est pas dans le lot est **jetée** : l'anti-hallucination est un filtre serveur, pas une consigne. Poids 2.0.
- **rétro** — fenêtre d'épisodes scorés d'une équipe + signaux + insights déjà actifs (pour éviter les redites) → `{"insights":[…], "skillCandidates":[…]}`. Chaque insight `upsert`é par `fingerprint` (incrémente `support` au lieu de dupliquer).
- **auteur** et **optimiseur** — §8 et §7.

Tout est **OFF par défaut** : sans `SWARM_OS_LEARNING_JUDGE_ENABLED=true`, aucun octet ne part vers un modèle et la boucle reste fonctionnelle sur les seules sources (a) et (b).

---

## 7. Réinjection

### Canal A — notes mémoire (défaut, aucune ligne de préambule ajoutée)

Le préambule lead impose **déjà** de consulter la mémoire : « *At the start of a task, call `memory.search({ query })` … and treat the hits as background knowledge before you act* » (`modules/preambles/default-lead.md:86-112`). Écrire l'insight dans le vault suffit donc à le réinjecter.

Quand un insight passe `active` → `MemoryStore.upsertNote` (`memory/store.ts:771`) avec :

- `name = learning-<slug-du-fingerprint>` (le validateur `assertValidName:611` n'admet pas `/`),
- `type = 'reference'` (aucun ajout à `MEMORY_NOTE_TYPES`, union fermée consommée par le web),
- `createdBy = 'learning-loop'` → **provenance, donc purge de masse en une requête**,
- corps = l'instruction + un lien `[[learning-hub]]`, `metadata.episodeIds`.

Une note `learning-hub` référence les insights actifs (précédent exact : l'intégration codegraph Option A, `docs/graphify-integration.md`). `retired` → `deleteNote` : le vault ne contient que ce qui est actif.

### Canal B — section de préambule `## Learned lessons` (opt-in)

`buildLearningSection(insights, {isLead, namer})` dans `modules/orchestrator/preamble.ts`, calquée ligne pour ligne sur `buildSkillsSection` (`preamble.ts:340-369`) : renvoie `null` si vide (une session sans insight ne porte pas un octet de plus), rendu des noms d'outils via `namer`, et **placée après `## Active skills`, avant l'override opérateur** — pour que l'invariant « ajouté, jamais substitué » couvre aussi les leçons.

Câblage identique à celui des skills, donc mécaniquement sûr :

- callback `learning:` sur le `Spawner` (miroir de `spawner/index.ts:513`),
- `Orchestrator._readLearning` miroir de `_readSkills` (`orchestrator/index.ts:339`), consommé aux **3 sites `buildPreamble`** (lead start, lead resume, addWorker).

Résolution : `state='active'` ET (`global` OU `role`+`roleId` OU `orchestrator`+`orchId`), triés par `score` décroissant, **plafonnés à 10 insights et 4 Ko**. L'`insights_json` de l'épisode enregistre ce qui a été injecté — c'est ce qui ferme la boucle et permet de mesurer *a posteriori* si un insight améliore la récompense.

### Canal C — graduation en skill

Voir §8.

### Promotion `proposed → active`

Clic opérateur dans `#/learning`, ou auto si `SWARM_OS_LEARNING_AUTOPROMOTE=true` **et** `support >= 3` **et** `contradiction = 0` **et** `distinct_orchs >= 2`. Cette dernière condition est ce qui empêche l'idiosyncrasie d'une équipe de devenir une loi de la maison.

---

## 8. Création autonome de skills

```
épisodes scorés → rétro → learning_insights (proposed)
  └→ PORTE DÉTERMINISTE, sans modèle : support >= 5, distinct_orchs >= 2, contradiction = 0,
     catégorie ∈ {procedure, convention, tool-usage}, cooldown cluster OK, quotas OK
     └→ learning_runs(kind='author') → runHeadless → texte SKILL.md
        └→ VALIDATION SERVEUR (parseSkillMd + interdits)
           └→ learning_skill_drafts (proposed) + event learning.skill_drafted
              └→ PORTE HUMAINE 1 : approve dans #/learning
                 └→ skills.import({kind:'authored'}) → source_kind='authored',
                    source_ref='learning:<draftId>', trust='self-authored', reviewed=0
                    └→ PORTE HUMAINE 2 : activation refusée (409 REVIEW_REQUIRED)
                       → SkillReviewDialog (Lot 3b existant) → skill actif
```

**Le point de conception qui porte tout** : un modèle ne peut jamais proposer un skill *ex nihilo*. Il ne peut que **rédiger** un amas d'insights ayant déjà franchi un seuil de comptage calculé en SQL. La créativité du modèle est confinée à la forme, jamais au déclenchement.

### 8.1 Nouvelle source d'installation

Ajout additif à l'union `SkillInstallSource` (`modules/skills/stage.ts:47`) :

```ts
| { kind: 'authored'; name: string; content: string }
```

```ts
/** Materialise a machine-authored SKILL.md. NOTHING ELSE is written — an
 *  authored skill can therefore never ship assets, by construction. */
export function stageAuthored(content: string, destDir: string): void
```

`installer.ts stageInto` (`:208`) reçoit un `case 'authored'` ; `upgrade()` (`:147`) lève un `AuthoredRequiresNewDraftError` → **409**, exactement comme `UploadRequiresNewUploadError` (`installer.ts:65`) et pour la même raison : pas de source re-fetchable, une nouvelle version passe par un nouveau brouillon.

**`parseSkillInstallSource` (`http/routes/skills.ts:67`) n'est PAS étendu** — la source `authored` n'est pas exposée en REST publique ; le seul appelant est `modules/learning/author.ts`. Un opérateur ne peut pas fabriquer cette provenance par une requête HTTP.

L'invariant « skill = donnée, zéro JS serveur » (`docs/plan-skills-importables.md:19`) est préservé **mécaniquement** : `stageAuthored` n'écrit qu'un fichier texte, donc `fm.assets` est absent, donc `assets_present = 0`, donc `stageAssets` n'a rien à copier. Le chemin le plus dangereux du sous-système skills est fermé par construction sur ce parcours.

### 8.2 Trust et porte de revue

5e niveau dans `modules/skills/store.ts:23` :

```ts
export const SKILL_TRUST_LEVELS =
  ['first-party','verified','community','local','self-authored'] as const;
```

`trust.ts:86 resolveTrust` : `if (sourceKind === 'authored') return 'self-authored';`. Il n'est **pas** dans `REVIEW_EXEMPT_TRUST` (`trust.ts:24`).

Et surtout, **la modification de 3 lignes qui est le cœur du garde-fou**, dans `trust.ts:122` :

```ts
export function isReviewRequired(opts): boolean {
  // A machine-authored skill is ALWAYS review-gated, risk or not: the
  // instruction-only exemption below assumes a human wrote the instructions.
  if (opts.trust === 'self-authored') return !opts.reviewed;
  if (!skillHasRisk(opts.assetsPresent, opts.capabilities)) return false;
  if (trustBypassesReview(opts.trust)) return false;
  return !opts.reviewed;
}
```

Sans cette clause, un skill instruction-only n'est pas « risqué » au sens de `skillHasRisk:113` et s'activerait **sans aucune revue** — autrement dit un modèle écrirait directement dans le system-prompt de toutes les sessions futures. Avec elle, `SkillsSubsystem.setActivation` (`index.ts:447-457`) refuse déjà, renvoie `{blocked:true, reason:'review_required'}`, la route répond 409 `REVIEW_REQUIRED` et le `SkillReviewDialog` du Lot 3b s'ouvre : **zéro nouveau code d'UI de revue**.

**Invariant à graver** : `reviewed=1` ne s'écrit que par une action opérateur (`POST /skills/:name/review` ou `activate {reviewed:true}` depuis le web). **Aucune variable d'environnement ne peut supprimer la porte 2.**

### 8.3 Validation serveur du texte produit

Dans `modules/learning/author.ts`, avant tout `import()` :

1. `stageAuthored` en répertoire temporaire puis `parseSkillMd(dir)` (`manifest.ts:319`) — validation gratuite et strictement identique aux autres imports (nom `SKILL_NAME_RE` = `PLUGIN_NAME_RE`, hors `RESERVED_NAMES`, version non vide, frontmatter en style *flow* uniquement).
2. Refus si le frontmatter déclare `assets` → `reject_reason='assets_forbidden'`.
3. Refus si `requires.capabilities` non vide → `reject_reason='capabilities_forbidden'`.
4. Refus si `store.get(name)` existe **et** `source_kind !== 'authored'` → `reject_reason='name_collision'`. `SkillInstaller.commit` (`:272`) écrase par nom : le garde-fou doit être **avant** l'appel. Un skill importé par l'opérateur ne peut jamais être écrasé par la machine.
5. Bornes : corps ≤ 8 Ko, `triggers` ≤ 10.

### 8.4 Garde-fous anti-emballement

| # | Garde-fou | Mécanisme |
|---|---|---|
| 1 | Pas de proposition sans preuves | porte SQL déterministe avant tout appel modèle |
| 2 | Pas d'auto-confirmation | `support` **ignore les épisodes où le skill candidat était déjà actif** (`evidence_json.skillsActive`) — anti chambre d'écho |
| 3 | Jamais d'exécutable | `stageAuthored` n'écrit qu'un fichier ; `assets`/`capabilities` refusés |
| 4 | Jamais d'écrasement | refus sur collision de nom avec une autre provenance |
| 5 | Toujours une revue humaine | `isReviewRequired` non contournable par env |
| 6 | Quotas | `MAX_OPEN_DRAFTS=3`, `MAX_AUTHORED_SKILLS=10`, `MAX_RUNS_PER_DAY=24` |
| 7 | Cooldown | `cluster_key` = sha256(insightIds triés), pas de re-rédaction du même amas avant 7 j |
| 8 | Réversibilité | supprimer un skill auto-écrit retire l'insight source (balayage de réconciliation au boot), donc pas de re-proposition le lendemain |
| 9 | Interrupteur | `SWARM_OS_LEARNING_AUTHOR_ENABLED=false`, distinct du maître |
| 10 | Traçabilité | badge `self-authored` dans `SkillsPage`, `rationale` + `evidence_json` conservés |

---

## 9. Optimiseur réflexif (le GEPA maison)

Ce que GEPA fait et qu'on reprend : lire les **traces textuelles d'échec** (message d'erreur, rationale du juge, commentaire humain) plutôt qu'un scalaire, et demander à un modèle une mutation ciblée du composant fautif. Ce qu'on remplace : l'évaluation hors-ligne sur un trainset ré-exécutable — impossible sans jeu de tâches figées — par un **A/B en production** sur les épisodes réels.

**Table** `learning_text_versions` : `id (tv_…)`, `target_kind` (`role.leadPrompt` | `role.leadPreamble` | `role.workerPreamble` | `skill.body`), `target_id`, `version`, `text`, `text_hash`, `parent_version_id`, `origin` (`human` | `reflective`), `rationale`, `state` (`active` | `shadow` | `retired` | `rejected`), `episodes_observed`, `mean_reward`, `created_at`, `promoted_at`.

**Boucle**

1. **Sélection de cible** — un rôle dont la récompense moyenne sur ≥ `MIN_EPISODES` (30) est sous seuil, ou dont le taux de `card_reopened` est le plus élevé.
2. **Dataset réflexif** — les k pires épisodes de cette cible, chacun réduit à `{task_input, outcome, rationale du juge, commentaire humain, extrait de trajectoire}` — c'est-à-dire exactement la forme `{Inputs, Generated Outputs, Feedback}` attendue par GEPA, ce qui laisse la porte ouverte à un branchement ultérieur de la vraie lib.
3. **Mutation** — `runHeadless(kind='optimizer')` : texte courant + dataset réflexif → nouvelle version + `rationale`. Stockée en `state='shadow'`.
4. **A/B** — à chaque spawn, `resolveTextOverride(roleId, field)` assigne le bras selon `SWARM_OS_LEARNING_AB_RATIO` (0.3 par défaut) ; l'épisode enregistre son bras dans `policy_json.textVersions`.
5. **Verdict** — après `MIN_EPISODES_PER_ARM` (20 par bras), comparaison des récompenses moyennes, **groupée par `task_hash` quand des groupes existent** pour limiter le biais de dérive des tâches. Promotion si le gain dépasse un seuil d'effet minimal ; sinon `rejected` et rollback implicite.

**Garde-fous** : un seul candidat `shadow` par cible à la fois ; l'opérateur peut promouvoir/rejeter/rollback en un clic depuis `#/learning` ; toutes les versions sont conservées, donc le rollback est une écriture d'état, pas une régénération ; `SWARM_OS_LEARNING_OPTIMIZER_ENABLED=false` par défaut ; jamais appliqué à un rôle sans opt-in explicite sur ce rôle.

**Limite assumée** : l'A/B en production est confondu par la dérive des tâches et par les changements de dépôt. Le verdict est une indication, pas une preuve. C'est le prix à payer pour ne pas construire un harnais de tâches ré-exécutables — et le jour où ce harnais existera, il se branchera au même endroit (étape 4 remplacée par une évaluation hors-ligne, et la lib GEPA devient greffable sur le dataset réflexif de l'étape 2).

---

## 10. Découpage en lots

Convention du dépôt : `a` = backend, `b` = web pour la même capacité, un commit par lot terminé par le verdict tests/build (aucune CI ne lance les tests — `release-image.yml` ne se déclenche que sur tags `v*`).

| Lot | Contenu | Fichiers principaux | Taille |
|---|---|---|---|
| **0** | Ce document + `docs/auto-amelioration-dataset.md` (schéma d'export figé). | docs | ~700 L doc |
| **1a** | **Substrat.** 5 tables, DDL, prepared statements, `assertReady()`. Câblage boot try/catch dans `src/index.ts` (`boot.learning_store_unavailable`, patron `:346-372`), drapeaux dans `config.ts`. Aucun changement de comportement. | `modules/learning/{store,types}.ts`, `src/index.ts`, `config.ts`, `.env.example` | ~750 L + 300 tests |
| **1b** | **Cycle de vie + source (a).** `collector.ts` (un abonnement bus, file mémoire + drain `unref`), `episode.ts`, `reward.ts` (**pure**), `episode-files.ts` (NDJSON borné, patron `run-files.ts`). | `modules/learning/{collector,episode,reward,episode-files}.ts` | ~650 L + 450 tests |
| **1c** | **Janitor + rétention.** TTL sur `<dataDir>/learning/episodes/`, plafond de lignes, balayage au boot fermant les épisodes `open` en `aborted` (patron `taskboard/lifecycle.ts:110`, `persistence.ts recoverFromCrash`). | `modules/learning/lifecycle.ts` | ~180 L |
| **2a** | **REST lecture + source (b).** `GET /learning/{episodes,:id,insights,runs,drafts,stats}`, `POST /learning/episodes/:id/feedback`. Montage conditionnel (patron `if (spawner.skills)`, `http/main.ts:337`). Événements `learning.*` (union ouverte, additif). | `http/routes/learning.ts`, `http/main.ts`, `events.ts` | ~500 L |
| **2b** | **Web `#/learning` + pouces/commentaire.** Overlay routé par hash (patron `SkillsPage`), `useLearning.ts` (poll 5 s), types + méthodes `api/client.ts`, entrée `TopBar`. | `web/components/LearningPage.tsx`, `web/hooks/useLearning.ts`, `web/api/client.ts`, `App.tsx`, `TopBar.tsx` | ~800 L |
| **3a** | **Appel headless + coût.** `modules/ai/headless.ts` (bi-transport, `spawnImpl` injectable, jamais de throw), `AgentProvider.headlessArgs?` + implémentation claude. `cost.ts` : estimation depuis les octets PTY × tarifs `providers/catalogue.ts` → `cost_basis='estimated'`. Diagnostic `POST /learning/headless/probe`. | `modules/ai/headless.ts`, `providers/{types,claude}.ts`, `modules/learning/cost.ts` | ~550 L |
| **3b** | **Juge LLM (source c).** `judge.ts`, `runner.ts` (machine à états + run dir), déclencheurs seuil/cron/manuel, single-flight. OFF par défaut. | `modules/learning/{judge,runner,run-files}.ts` | ~750 L |
| **3c** | **Auto-rétro + insights (source d).** `retro.ts`, upsert par `fingerprint`, cycle `proposed→active→retired`, REST approve/retire, auto-promotion conditionnelle. | `modules/learning/{retro,insights}.ts`, `http/routes/learning.ts` | ~700 L |
| **3d** | **Web : revue des insights + historique des runs.** | `web/components/learning/*` | ~500 L |
| **4a** | **Réinjection.** Canal A (miroir mémoire + note hub). Canal B (`buildLearningSection` + callback `learning:` sur le Spawner + `_readLearning`, 3 sites `buildPreamble`). Attention : `preamble.test.ts` (694 L) gèle l'ordre des sections. | `modules/orchestrator/preamble.ts` + test, `spawner/index.ts`, `orchestrator/index.ts`, `modules/learning/inject.ts` | ~450 L |
| **5a** | **Source `authored` côté skills.** `stage.ts` (union + `stageAuthored`), `installer.ts` (2 cases + `AuthoredRequiresNewDraftError`), `store.ts` (`SKILL_TRUST_LEVELS`), `trust.ts` (`resolveTrust` + `isReviewRequired`). Chirurgical, testable seul. | `modules/skills/{stage,installer,store,trust}.ts` | ~250 L |
| **5b** | **Pipeline de brouillons.** `author.ts` (porte déterministe, headless, validation, quotas, cooldown), cycle de vie, REST approve/reject, réconciliation au boot. | `modules/learning/{author,drafts}.ts`, `http/routes/learning.ts` | ~650 L |
| **5c** | **Web : revue des brouillons.** Prévisualisation `SKILL.md`, approve/reject, badge `self-authored` dans `SkillsPage.tsx`, réutilisation de `SkillReviewDialog` pour la porte 2. | `web/components/learning/DraftReview.tsx`, `SkillsPage.tsx` | ~500 L |
| **6a** | **Surface MCP.** `learning.insights` (lecture), `learning.record_outcome` (lead-only, rate-limited). Ajouts à `TEAM_TOOL_LOGICAL_NAMES` + directive de préambule + le test qui gèle la synchro outils/préambule. | `modules/mcp/learning-tools.ts`, `mcp/{server,tools}.ts`, `preamble.ts`, `preambles/default-lead.md` | ~350 L |
| **7a** | **Optimiseur réflexif.** `learning_text_versions`, `optimizer.ts` (sélection, dataset réflexif, mutation headless), `resolveTextOverride` + assignation de bras au spawn, verdict A/B. | `modules/learning/{optimizer,versions}.ts`, `spawner/index.ts`, `orchestrator/index.ts` | ~700 L |
| **7b** | **Web : versions de texte + A/B.** Diff candidat vs actif, récompense par bras, promote/reject/rollback. | `web/components/learning/TextVersions.tsx` | ~450 L |
| **8a** | **Export dataset.** `GET /learning/export?format=jsonl&kind=&since=` en streaming, schéma figé, variante compatible `ScoredDataGroup`. Épisodes `aborted` exclus. | `http/routes/learning.ts`, `modules/learning/export.ts` | ~300 L |

**Chemin critique minimal pour une valeur observable : 0 → 1a → 1b → 2a → 2b.** À ce stade la boucle capture, score (sources a+b) et affiche, sans qu'un seul octet ne parte vers un modèle.

### Variables d'environnement

Toutes OFF ou conservatrices par défaut.

```
SWARM_OS_LEARNING_ENABLED=false                 # interrupteur maître
SWARM_OS_LEARNING_CAPTURE_TRANSCRIPT=false
SWARM_OS_LEARNING_EPISODE_TTL_MS=2592000000     # 30 j
SWARM_OS_LEARNING_MAX_TRAJECTORY_STEPS=500
SWARM_OS_LEARNING_JUDGE_ENABLED=false
SWARM_OS_LEARNING_JUDGE_BATCH=20
SWARM_OS_LEARNING_JUDGE_MODEL=                  # vide = défaut du provider
SWARM_OS_LEARNING_RETRO_ENABLED=false
SWARM_OS_LEARNING_RETRO_CRON=
SWARM_OS_LEARNING_MAX_RUNS_PER_DAY=24
SWARM_OS_LEARNING_RUN_TIMEOUT_MS=180000
SWARM_OS_LEARNING_INJECT_PREAMBLE=false
SWARM_OS_LEARNING_AUTOPROMOTE=false
SWARM_OS_LEARNING_MAX_ACTIVE_INSIGHTS=25
SWARM_OS_LEARNING_AUTHOR_ENABLED=false
SWARM_OS_LEARNING_SKILL_MIN_SUPPORT=5
SWARM_OS_LEARNING_MAX_OPEN_DRAFTS=3
SWARM_OS_LEARNING_MAX_AUTHORED_SKILLS=10
SWARM_OS_LEARNING_OPTIMIZER_ENABLED=false
SWARM_OS_LEARNING_AB_RATIO=0.3
```

---

## 11. Risques et modes de défaillance

**Reward hacking.** Un agent qui voit les insights peut apprendre à fermer ses cartes plutôt qu'à faire le travail. (i) **La récompense n'est jamais visible de l'agent** — aucun outil MCP ne renvoie son propre score ; (ii) `card_reopened` **annule rétroactivement** `card_closed` sur le même épisode ; (iii) le poids humain (3.0) domine ; (iv) le juge voit la trajectoire, pas seulement l'issue ; (v) `reward_components_json` permet de repérer un épisode bon uniquement par sa composante runtime ; (vi) pas d'auto-promotion depuis un seul orchestrateur.

**Pollution mémoire.** Risque déjà nommé dans `docs/memoire-partagee.md §11` (« une mémoire partagée peut être polluée par un agent confus »). Seuls les insights `active` sont miroités, plafond de 25, espace de noms `learning-*`, `createdBy='learning-loop'` (purge de masse en une requête), `retired` supprime la note, et un insight ne naît jamais d'un seul épisode.

**Explosion de coût.** Aucun appel modèle avant le lot 3b, et le lot **3a rend le coût visible avant de le rendre possible** — l'ordre des lots est lui-même un garde-fou. Ensuite : OFF par défaut, `MAX_RUNS_PER_DAY`, lots d'épisodes bornés, résumés bornés en octets, `AbortSignal` + timeout, single-flight, `cost_usd` par run affiché.

**Boucles de rétroaction.** L'appel headless ne crée ni session ni orchestrateur, donc juge et rétro **ne génèrent aucun épisode sur eux-mêmes** — c'est la raison principale d'avoir écarté l'équipe éphémère. Un insight ne peut pas citer un épisode où son propre skill promu était actif. Cooldown par amas sur les brouillons. Écritures MCP lead-only et rate-limitées.

**Règle 24/7 sans crash.** Store en try/catch → valeur neutre ; `assertReady()` pour que la régression de schéma soit bruyante au boot et jamais silencieuse ensuite ; sous-système entier dans un try/catch de boot qui ne désactive que lui (`boot.learning_store_unavailable`) ; handler de bus try/catch par événement ; drain sur timer `unref()` ; `runHeadless` ne throw jamais ; écritures disque bornées et best-effort ; `LEARNING_UNAVAILABLE` côté MCP, routes non montées, page web dégradée en liste vide.

**Fuite de données.** Une trajectoire peut contenir des extraits PTY, donc des secrets. `CAPTURE_TRANSCRIPT=false` par défaut : sans lui, la trajectoire ne contient que des métadonnées et du texte déjà structuré (titres de cartes, décisions d'approbation). Activé, passage obligatoire par le `stripAnsi` de `log-tail-reader.ts` + une passe de rédaction, y compris pour le prompt du juge.

**Croissance disque.** `<dataDir>/learning/` est sous le même bind mount que le reste, donc **entre automatiquement dans le backup à chaud** — bénéfice (le dataset est sauvegardé) et risque (il grossit la sauvegarde). D'où le janitor du lot 1c et le plafonnement en pas et en octets.

**Coût et tokens sont une estimation.** Aucune télémétrie de tokens n'existe (seulement les tarifs statiques de `providers/catalogue.ts`). `cost_basis='estimated'` est une colonne, pas un commentaire : l'UI doit afficher « estimé », et le jour où un provider rapporte un usage réel, `cost_basis='reported'` distingue les deux populations sans corrompre le dataset.

**Verdict A/B faible.** Voir §9 — confondu par la dérive des tâches. Le groupement par `task_hash` limite le biais sans l'éliminer ; à traiter comme une indication.

---

## 12. Vérification

### Par lot, dans cet ordre

```
pnpm --filter server test         # vitest, globals:false, pool forks, fileParallelism false
pnpm --filter web typecheck && pnpm --filter web build
pnpm lint && pnpm build
```

Le commit se termine par le verdict chiffré (`N tests, M pass`, `EXIT 0`) — convention du dépôt, puisqu'aucune CI ne lance les tests.

### Tests unitaires attendus

Colocalisés `src/modules/learning/*.test.ts` :

- `reward.test.ts` — la fonction est pure, donc couverture exhaustive : chaque combinaison de sources, saturation de confiance, bornes de `clamp`, préséance humaine, table de vérité complète de `outcome`.
- `store.test.ts` — patron `skills/store.test.ts` : `mkdtempSync` → `new SwarmDb(dir)` → store → `afterEach` close + `rmSync`. Vérifier `assertReady`, l'idempotence de `dedupe_key`, l'unicité de `fingerprint`, et **la survie d'un épisode à la suppression de son orchestrateur** (la raison d'être du choix « pas de FK »).
- `collector.test.ts` — émettre des `SwarmEvent` sur le bus singleton, forcer le drain, vérifier les épisodes et signaux produits ; vérifier qu'un handler qui throw ne casse pas le bus.
- `headless.test.ts` — `spawnImpl` injecté, jamais de vrai CLI : succès, timeout, exit non nul, provider sans `headlessArgs`, transport indisponible → chaque cas rend `{ok:false, reason}` et ne throw pas.
- `trust.test.ts` (étendu) — un skill `self-authored` **instruction-only** exige quand même la revue. C'est le test qui garde l'invariant central du pilier 2.
- `author.test.ts` — refus sur `assets`, sur `capabilities`, sur collision de nom avec une autre provenance, sur quota, sur cooldown.

### Intégration

`packages/server/test/integration/`, avec `bootTestStack` + `FakeAgentProcess` (jamais de vrai `claude`) : créer une équipe, créer une carte, la fermer, vérifier qu'un épisode `card` existe en `state='closed'` avec le bon `reward` ; la rouvrir, vérifier `attempt=2` et la récompense corrigée ; poster un feedback humain, vérifier que `reward_source='human'`.

### Bout en bout en local

```
SWARM_OS_DATA_DIR=./.dev-data SWARM_OS_LEARNING_ENABLED=true pnpm dev
```

Dans l'UI : créer une équipe, laisser le lead créer et fermer des cartes, ouvrir `#/learning` — les épisodes doivent apparaître avec récompense et composantes. Noter au pouce, vérifier que la récompense bascule sur `human`. Puis `SWARM_OS_LEARNING_JUDGE_ENABLED=true` + `POST /learning/runs {kind:'judge'}` et inspecter `<dataDir>/learning/runs/<id>/raw.txt`.

### En conteneur

```
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
bash scripts/smoke-docker.sh
```

(Sans le rebuild, les changements ne sont pas visibles.)

### Contrôle de non-régression le plus important

Avec `SWARM_OS_LEARNING_ENABLED=false` (le défaut), `pnpm --filter server test` doit passer **sans qu'aucun test existant ne change**, et un boot conteneur doit produire exactement les mêmes logs qu'avant. Le lot 1a n'ajoute aucun comportement observable.
