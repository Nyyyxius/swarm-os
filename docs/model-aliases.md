# Alias de famille de modèles — suivre automatiquement la dernière version

## Problème

Quand un nouveau modèle sort (ex. `claude-opus-5-5`, 2026-09-22), les nouveaux leads et workers
doivent le prendre **sans intervention humaine**. Aujourd'hui ce n'est vrai que pour le défaut
provider (`ModelCatalogue.defaultModel` → famille opus uniquement). Tout id **choisi** est figé :

| Où l'id se fige | Exemple (stiix, 2026-09-23) |
|---|---|
| `roles.default_model` | `claude-opus-5` ×2, `claude-sonnet-5` ×3, `claude-opus-4-8[1m]` ×1 |
| `orchestrators.default_model` (hérité par chaque worker) | `claude-opus-4-8` ×10, `claude-sonnet-5` ×3, … |
| `POST /orchestrators` sans modèle | le défaut catalogue est résolu **puis stocké concret** dans la team → figé à la création |
| `team.spawn_worker({ model })` | le lead recopie un id de son contexte (souvent périmé) |

Rien ne suit `sonnet` ni `fable`.

## Principe

**On stocke l'intention, on exécute le concret.**

- Les couches durables (rôle, team, défaut provider/config) stockent un **alias de famille** :
  `opus`, `sonnet`, `fable`, `haiku`, avec suffixe optionnel `[1m]` (`opus[1m]`).
- **Au spawn** (et seulement au spawn), l'alias est résolu en id concret = membre le plus récent de la
  famille dans le catalogue live (models.dev, déjà interrogé, TTL 6 h, sans timer).
- `sessions.model` reçoit l'id **concret** : ce qui est stocké = ce qui est exécuté = ce qui est
  tarifé/monitoré (`contextLimit`, `costRates` restent justes).
- Catalogue vide / injoignable → l'alias est passé **tel quel** au CLI claude, qui le résout lui-même
  (2.1.280 : `opus→claude-opus-5-5`, `sonnet→claude-sonnet-5`, `fable→claude-fable-5-1`,
  `haiku→claude-haiku-4-5`). Aucun blocage possible, pire cas = choix du CLI.
- Resume / restart d'une session existante : `sessions.model` est concret → inchangé (même agent,
  même modèle). Seuls les **nouveaux** leads/workers suivent.

Décisions utilisateur (2026-09-23) :
1. **Migration complète** des rôles et teams existants vers les alias (une seule fois).
2. **`spawn_worker` normalise** : un id concret d'une famille connue passé par un lead est remonté à
   l'alias de sa famille (→ dernière version). Id hors famille / inconnu : respecté tel quel.
   (Les choix explicites faits dans l'UI / l'API HTTP restent des pins respectés.)

## Lots

### Lot 1 — Résolveur d'alias (serveur, pur)
- `providers/ids.ts` : `CLAUDE_MODEL_FAMILIES = ['opus','sonnet','fable','haiku']`,
  `parseModelAlias(s) → { family, oneM } | null` (`^(opus|sonnet|fable|haiku)(\[1m\])?$`),
  `claudeFamilyOf(id) → alias | null` (`^claude-(opus|sonnet|fable|haiku)-\d+(-\d+)?(-\d{8})?(\[1m\])?$`
  → `family[+[1m]]`).
- Regex famille ancrée des deux côtés (même doctrine que `BUILTIN_PROVIDER_DEFAULT_FAMILIES`) :
  `^claude-<fam>-\d+(-\d+)?$` — exclut les jumeaux datés et les variantes suffixées.
- `ModelCatalogue.familyLatest(provider, regex) → string | null` (sur la liste live triée,
  `familyWinner` existant).

### Lot 2 — Résolution au spawn
- Interface `AgentProvider.resolveModel?(model: string): string` (optionnelle ; identité par défaut).
- `ClaudeProvider.resolveModel` : alias → `familyLatest` + suffixe `[1m]` ; sinon alias inchangé ;
  id non-alias → inchangé.
- Appelée dans `Orchestrator.start()` et `addWorker()` **après** `resolveAgentDefaults`, avant
  `new Session` et `_contextUsageWiring` — **sauf** quand `spec.existingId` est posé (resume d'un
  worker) : le resume garde `sessions.model` tel quel, comme `resume()` pour le lead. `resolveAgentDefaults` n'est PAS modifié : `POST
  /orchestrators` et `plugins/api teams.create` doivent continuer à stocker l'alias.
- Log `model.alias_resolved { alias, model, source: 'catalogue'|'cli' }`.
- **Catalogue froid au boot** (revue) : `resolveModel` est synchrone et le catalogue ne se remplit
  qu'au premier accès. → `await modelCatalogue.resolve()` (plafond 3 s existant) en tête de
  `runAutoResume`, avant l'ouverture du boot gate. Les resumes lisent l'id concret de leur ligne
  et n'en dépendent pas ; seuls les spawns neufs résolvent, et ils arrivent après ce délai. Filet : `PINNED_CLAUDE_ALIAS_RATES` gagne `fable`, et `pinnedCostRates`
  retire le suffixe `[1m]` avant lookup — un alias non résolu reste tarifé.

### Lot 3 — Défauts = alias
- `BUILTIN_PROVIDER_DEFAULT_MODELS.claude = 'opus'` ; `ClaudeProvider.defaults().model = 'opus'`
  (plus de résolution catalogue ici : elle se fait au spawn). → une team créée sans modèle stocke
  `opus` et suit à vie.
- `ClaudeProvider.models()` : 4 entrées alias en tête, label dynamique
  `Opus — dernière (claude-opus-5-5)`, puis la liste concrète (pins explicites toujours possibles).

### Lot 4 — Normalisation `team.spawn_worker`
- `mcp/tools.ts` : si le provider effectif est claude et `claudeFamilyOf(model)` ≠ null → remplacer
  par l'alias ; log `model.alias_normalized { requested, alias }`.
- Description du tool + preamble lead : « préférer `opus` / `sonnet` / `fable` ; les ids concrets
  sont remontés à la dernière version de leur famille ».

### Lot 5 — Migration one-shot
- Au boot, une seule fois (marqueur `PRAGMA user_version`, inutilisé jusqu'ici), dans `index.ts`
  entre `new SwarmDb` et la réhydratation, avec `config.defaultProvider` en paramètre :
  - `orchestrators` : `default_provider = 'claude'` (colonne NOT NULL DEFAULT 'claude') ;
  - `roles` : `default_provider = 'claude' OR (default_provider IS NULL AND config.defaultProvider = 'claude')` ;
  - `default_model ← claudeFamilyOf(x) ?? x`. `sessions` non touchées.
- Une fois le marqueur posé, un pin concret remis à la main dans l'UI n'est plus jamais réécrit.

### Lot 6 — UI
- `ProviderFields` : les alias sont des valeurs du catalogue (pas « not in catalogue »), affichés
  « Opus — dernière (claude-opus-5-5) ». La vue team affiche l'alias ; la vue session l'id concret.

### Lot 7 — Tests & docs
- Unitaires : parse/famille, `familyLatest` (fixture : opus-5 vs opus-5-5, fable-5 vs fable-5-1,
  datés exclus), `resolveModel` avec/sans catalogue, `[1m]`, normalisation spawn_worker,
  migration idempotente + marqueur, resume inchangé.
- `docs/providers.md` : section alias.

## Notes de revue (2026-09-23)
- Toutes les voies de spawn passent par `start()` / `addWorker()` (MCP, HTTP, plugins, restart,
  resume worker) ; les crons ne spawnent pas. Aucun contrôle d'appartenance au catalogue : `opus`
  n'est jamais rejeté.
- `improve-via-ssh.ts` lance `claude -p --model <defaults().model>` hors orchestrateur → recevra
  `opus`, résolu par le CLI : acceptable.
- `SWARM_OS_DEFAULT_MODEL` concret reste un pin volontaire (non migré).
- Plugin `discord-agent` : il réapplique `leadModel` à son rôle à chaque boot et écraserait donc la
  migration. Son défaut passe à `opus[1m]`. La valeur **sauvegardée** dans sa config d'instance est
  à basculer via `PUT /plugins/discord-agent/config` : fait sur test le 2026-09-23, reste à faire
  sur stiix.
- Alternative écartée : tout déléguer au CLI (aucune résolution serveur). Plus simple, mais
  `sessions.model` afficherait `opus` au lieu de l'id réellement exécuté, et le prix live serait perdu.

## Hors périmètre
- opencode (`anthropic/claude-*`) : même mécanisme possible (`resolveModel` sans fallback CLI → pin),
  lot ultérieur si besoin. codex / gemini : défaut déjà suivi par famille.
- Basculer les sessions **en cours** : non — un agent vivant garde son modèle jusqu'à son remplacement.
