# Fonctionnalités intégrées désactivables (built-in features)

Six fonctionnalités du cœur — **Code graph, Monitoring, Approvals, Board, Memory,
IDE** — deviennent gérables comme des plugins : **activer / désactiver /
désinstaller / (ré)installer**, **à chaud, sans redémarrer le conteneur**
(opération 24/7).

Contrairement aux [plugins](./plugins.md) (modules ESM hot-loadés depuis
`/data/plugins`), ces fonctionnalités restent **compilées dans l'image** : c'est
leur **cycle de vie** qui devient pilotable, pas leur code. On ne cherche pas à
les extraire en paquets installables — le système de plugins ne contribue à l'UI
que par iframe et n'accède pas aux tables cœur.

## Sémantique des trois états

| État | Effet |
|---|---|
| **enabled** | fonctionnement normal |
| **disabled** | invisible partout (nav web, routes HTTP → 404, outils MCP absents des nouvelles sessions, sections de préambule retirées, jobs arrêtés). **Données conservées.** |
| **uninstalled** | comme `disabled` + **purge des données**. |

- **enable** sur un état `uninstalled` = install + enable (idempotent — les tables
  built-in sont recréées par `CREATE TABLE IF NOT EXISTS`).
- **(ré)installer** repart de zéro (la purge a déjà eu lieu).

## Décisions structurantes

### D1 — Table dédiée `builtin_features`
Nouveau module `packages/server/src/modules/features/`. Table
`builtin_features(name PK, state, updated_at)` créée par le registre lui-même
(patron « store owns its table », comme `PluginStore`). On **ne réutilise pas** la
table `plugins` : `PluginHost` est couplé au disque (manifest, dossier, import
ESM, quarantaine, scan `FOLDER_GONE`, purge par préfixe) — un built-in n'a rien de
cela. On réutilise seulement `PluginLockRegistry` (sérialisation des verbes par
nom) et la fonction libre `broadcastToLeadsFromExternal`
(`modules/orchestrator/messaging.ts`).

### D2 — Stores inconditionnels, registre après la DB
Le registre est construit **après** `new SwarmDb(...)` et **avant** les
stores/janitors. **Tous les stores concernés (`MemoryStore`, `GraphStore`,
taskboard, approvals) sont construits inconditionnellement** : un enable à chaud
ne fabrique jamais un store à la volée. Le boot dégradé (« store failed to
open ») reste géré par le `try/catch` existant (store `null` → 404 /
`*_UNAVAILABLE`). Fail-open : registre en échec ⇒ tout se comporte comme enabled.

### D3 — Descripteur de feature
```ts
type FeatureName = 'ide'|'codegraph'|'board'|'memory'|'monitoring'|'approvals';
type FeatureState = 'enabled'|'disabled'|'uninstalled';
interface FeatureDescriptor {
  name: FeatureName; displayName: string; description: string;
  start(): void;                    // arme jobs/superviseurs — idempotent, ne throw pas
  stop(): Promise<void> | void;     // désarme, DRAINE les travaux en vol — awaitable
  purge(): Promise<void> | void;    // DELETE + rm de fichiers — JAMAIS de DROP TABLE
}
```
Registre : `isEnabled(name)` synchrone (Map mémoire — LE point de gating par
requête), `snapshot()` (préambules), `list()`, verbes async sérialisés (persistent
→ émettent `feature.changed` → broadcast leads). **Purge = DELETE, jamais DROP** :
les stores gardent leurs prepared statements valides ; réinstaller = store déjà
là, vide.

### D4 — Seed & dépréciation des env vars
Seed premier boot : `enabled` pour les 6, sauf `SWARM_OS_CODEGRAPH_ENABLED=false`
/ `SWARM_OS_IDE_ENABLED=false` → seed `disabled`. Ensuite **la DB gouverne**. Ces
env vars deviennent un simple **défaut de seed** ; log `feature.seed_ignored` au
boot quand env ≠ DB. `.env.example`, `install.sh`, les compose et la doc deploy
sont corrigés en conséquence (Lot 9).

### D5 — Contrat de gating
- **HTTP** : middleware `featureGate(features, name)` → `404 {error:'FEATURE_DISABLED', feature}`.
  Les `if (store)` du boot restent, le gate s'ajoute. `/metrics/*` (aujourd'hui
  inconditionnel) passe derrière le gate. **Proxy IDE** monté
  **inconditionnellement**, gaté au call-time via le registre (patron
  `pluginHttpRegistry`), branche d'upgrade WS comprise.
- **MCP** : le `SdkMcpServer` est reconstruit à chaque requête → un
  `if (features.isEnabled(...))` par famille (memory/board/codegraph), effet
  immédiat. Broadcast « restart/resume to refresh tools » aux leads au toggle.
- **Préambules** : marqueurs `<!--feature:x-->…<!--/feature:x-->` autour des
  sections de `default-lead.md` / `default-worker.md` + `stripFeatureSections`
  appliqué à chaque appel de `buildPreamble`. Ce qui échappe au strip (overrides
  de rôle, skills, `TEAM_TOOL_LOGICAL_NAMES`, notes codegraph) **n'est pas
  réécrit** : un lint `preamble.stale_feature_mention` signale les outils
  désactivés encore cités.
- **Jobs** : chaque descripteur encapsule les start/stop existants — sauf les
  writers de sécurité/comptabilité (D6).

### D6 — Périmètre exact de « Monitoring »
Deux writers **ne sont PAS** sous le toggle monitoring :
- **`startBudgetWatch`** applique les budgets de rôle en **suspendant toute
  l'équipe (SIGSTOP, lead inclus)** — garde-fou anti-emballement 24/7. Lit
  `sessions`, pas `session_token_daily`. **Toujours actif.**
- **`startCostRollup`** tient la comptabilité et **le watermark**
  (`session_token_daily.cum_*`). L'arrêter ou purger sa table refait passer tout
  le cumul de vie comme dépense d'un seul jour. **Toujours actif, jamais purgé.**

« Monitoring » ne gate que : le routeur `/metrics/*`, la page, et les collecteurs
mémoire `aggregator` + `busMetrics`. `busMetrics` gagne un flag `active`
(instrumentation MCP = vrai no-op quand off) et **reset ring + ticks au start**
(sinon spike au ré-enable). Purge monitoring = néant persistant.

### D7 — Purges
| Feature | SQLite (DELETE) | Fichiers | Notes |
|---|---|---|---|
| IDE | — | `rm -rf <dataDir>/ide/server-data` | `ide/cli` + `ide-token` conservés (cache/identité). |
| Code graph | `codegraph_scopes` | `rm -rf <dataDir>/codegraph/` + notes memory managées | après drain des runs graphify. |
| Board | `taskboard_cards`, `taskboard_deps`, `taskboard_events` | — | |
| Memory | `memory_nodes`, `memory_edges`, `memory_fts` (clear FTS5), `memory_vectors` + `embedQueue` | `*.md` du vault | **archive-d'abord** (irréversible). |
| Monitoring | — (jamais `session_token_daily`) | — | ≈ no-op. |
| Approvals | `approval_requests`, `approval_events` + `roles.approval_json=NULL` | — | budgets de rôle non purgés. |

### D8 — Sûreté des purges & concurrence
Traité par **code** : archive-avant-purge memory (le backup ne couvre que le
SQLite, pas le vault `.md`) ; memory `close`+drain avant `rm` ; codegraph consulte
le registre à chaque écriture de note (getter) ; `stop()` codegraph draine/tue les
runs graphify avant `purge()` ; l'auto-carte board consulte le registre. Par
**note** (bénin) : janitor taskboard entre stop/purge (soft-delete) ; approvals
`pending` conservés et re-visibles au re-enable.

### D9 — Repli & garde-fou approvals
Désactiver approvals supprime le seul chemin **distant** de déblocage (le legacy
`session.waiting` est unidirectionnel). Donc : **409** au disable/uninstall tant
qu'un rôle/équipe tourne en `permissionMode` non-bypass (rôles nommés). Repli
autorisé : gate au point unique de création (`hooks.ts`), le reste du handler =
comportement pré-approvals (badge waiting, Discord legacy, résolution au terminal
web). Résolveurs Discord : store toujours construit + spread inconditionnel lisant
le flag à l'appel. Le bot built-in ne gère aucune réaction.

### D10 — Publication au front
`/info` étant **public**, l'état des features est servi par `GET /features`
**derrière l'auth** ; le front hydrate au login puis patche sa map sur l'événement
WS `feature.changed` (WS authentifié par ticket). `features === null` = inconnu
(spinner, aucun fetch, aucune redirection) jusqu'au snapshot. REST : `GET
/features`, `POST /features/:name/enable|disable`, `DELETE /features/:name`.

## Lots

1. **Socle serveur** — registre, table, REST, event, threading (thunk `features`,
   param McpServer, `stripFeatureSections`, lint). Descripteurs no-op. Aucun
   changement de comportement.
2. **Socle web** — client, `useEvents`, `SwarmController` (state `features`,
   init `null`), filtrage `CommandLauncher`/`TopBar`, redirection, section
   BUILT-IN de `PluginsPage` (ligne propre), `LeftPanel`/`StatsSheet`/`RolesPage`,
   détection 404 sur les hooks monitoring.
3. **IDE** — supervisor re-démarrable, proxy inconditionnel gaté call-time.
4. **Code graph** — `GraphStore` inconditionnel, getter memory, drain graphify.
5. **Board** — auto-carte + janitor gatés.
6. **Memory** — purge archive→close→drain→delete+rm.
7. **Monitoring** — descripteur restreint (aggregator/busMetrics), budgets &
   rollup hors toggle.
8. **Approvals** — garde-fou 409, résolveurs Discord au call-time.
9. **Docs, env & release** — cette page, dépréciation env vars, bump version.

Ordre strict : 1 → 2 → features (3-8, ordonnées de la plus simple à la plus dure)
→ 9. Les lots features touchent des fichiers partagés (`index.ts`,
`http/main.ts`, `mcp/server.ts`, `preamble.ts`) : à sérialiser sur ces fichiers.

## Vérification
Tests vitest serveur + web par lot. E2E : `docker build -t swarm-os:latest . &&
docker compose -f docker-compose.test.yml up -d`, puis par feature : off → nav
filtrée + 404 + outils absents d'une nouvelle session → on → retour ; uninstall →
purge (archive memory vérifiée) → install → repart de zéro. Cas critiques :
approvals off pendant une session waiting ; codegraph on + memory off (pas de
résurrection du vault) ; monitoring off (budgets toujours appliqués) ; IDE off↔on
à chaud.
