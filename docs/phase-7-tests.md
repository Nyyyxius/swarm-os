# Phase 7 — Tests

> Status: implemented. Last reviewed 2026-05-15.

## 1. Livrable

Phase 7 promeut les harnesses spike-style des phases 2/3/4 en une vraie suite
de tests automatisés (plan §6 Phase 7). Quatre axes :

1. **Vitest 4** comme runner unique, configs par package (`server` en `node`,
   `web` en `jsdom`) et un projet workspace au root.
2. **145 tests** répartis sur 19 fichiers, exécution pure ~7.5 s, wall-clock
   ~15 s avec cold imports + jsdom. Coverage 73 % lignes / 74 % fonctions
   (threshold 50/50).
3. **`FakeAgentProcess` exclusif** dans toute la suite — aucune session `claude`
   réelle n'est lancée pendant `pnpm test`.
4. **Smoke Docker MANUAL** (`scripts/smoke-docker.sh`) qui build l'image, boot
   un container éphémère, frappe `/health` + `/info` + `/orchestrators` et
   tear down. Hors `pnpm test` parce que `docker build` prend des minutes
   sur cache froid.

Les harnesses `verify:phase{2,3,4}` (15 + 23 + 25 = 63 checks) restent en place
comme smoke harnesses live-stack — distinction de scope, voir §9.

## 2. Stack & layout

- **Vitest 4** + `@vitest/coverage-v8` (provider v8 — pas Istanbul).
- **`@testing-library/react`** + **`@testing-library/jest-dom`** pour le web.
- **`@modelcontextprotocol/sdk`** déjà en deps — réutilisé comme client MCP
  pour les tests d'intégration (même approche que `verify-phase-3.ts`).
- **Pas d'helper babel/jest** ; les tests sont des modules ESM TS purs.

```
swarm-os/
├── vitest.config.ts                     # workspace root — projects + coverage
├── packages/server/
│   ├── vitest.config.ts                 # node env + setup file
│   ├── src/**/*.test.ts                 # unit tests (co-located avec sources)
│   └── test/
│       ├── setup.ts                     # silence pino sur stdout
│       └── integration/                 # tests multi-modules
│           ├── helpers.ts               # bootTestStack, RecordingNotifier
│           ├── boot-recovery.test.ts
│           ├── hooks.test.ts
│           ├── rest-orchestrator.test.ts
│           ├── ws-events.test.ts
│           └── ws-terminal.test.ts
├── packages/web/
│   ├── vitest.config.ts                 # jsdom env + react plugin
│   ├── test/setup.ts                    # jest-dom + cleanup hook
│   └── src/**/*.test.{ts,tsx}           # unit tests (co-located)
└── scripts/
    └── smoke-docker.sh                  # MANUAL — build, boot, hit endpoints
```

## 3. Test runner & scripts

Scripts root (`package.json`) :

| Script | Effet |
|---|---|
| `pnpm test` | `vitest run` — single-shot, mode CI |
| `pnpm test:watch` | `vitest` — re-run sur changement |
| `pnpm test:coverage` | `vitest run --coverage` — génère `./coverage/` HTML + text + JSON summary |

Configs par package :

- `packages/server/vitest.config.ts` : `environment: 'node'`, `globals: false`
  (chaque test importe `describe/it/expect` explicitement), `pool: 'forks'`
  + `fileParallelism: false`. Le pool fork évite les soucis de native binding
  SQLite ; le single-file séquentiel garantit que le singleton `eventBus` et
  l'état des ports HTTP restent prédictibles entre suites.
  `testTimeout: 10_000` pour absorber le cold-start des listeners HTTP en
  intégration (les unit tests bouclent en <50 ms chacun).
- `packages/web/vitest.config.ts` : `environment: 'jsdom'`, plugin React,
  `testTimeout: 5_000`.

## 4. Test count breakdown

### Server unit (101 tests, 11 fichiers)

| Fichier | Tests |
|---|---|
| `config.test.ts` | 18 |
| `http/validation.test.ts` | 9 |
| `modules/db/index.test.ts` | 9 |
| `modules/notify/discord.test.ts` | 12 |
| `modules/notify/null.test.ts` | 1 |
| `modules/orchestrator/agent-process.test.ts` | 9 |
| `modules/orchestrator/mailbox.test.ts` | 11 |
| `modules/orchestrator/messaging.test.ts` | 13 |
| `modules/orchestrator/persistence.test.ts` | 7 |
| `modules/orchestrator/preamble.test.ts` | 4 |
| `runtime/claude-init.test.ts` | 8 |

### Server integration (21 tests, 5 fichiers)

| Fichier | Tests | Surface |
|---|---|---|
| `boot-recovery.test.ts` | 2 | sessions non-terminales → `interrupted` au boot |
| `hooks.test.ts` | 5 | `POST /hooks/notification` (auth, dispatch notifier) |
| `rest-orchestrator.test.ts` | 9 | REST routes + MCP end-to-end via SDK client |
| `ws-events.test.ts` | 1 | flux `/ws/events` (orch / session lifecycle) |
| `ws-terminal.test.ts` | 4 | attach, ticket, multi-attach un seul writer |

### Web (23 tests, 3 fichiers)

| Fichier | Tests |
|---|---|
| `api/client.test.ts` | 8 |
| `components/NewOrchestratorDialog.test.tsx` | 5 |
| `components/StatusBadge.test.tsx` | 10 |

**Total : 145 tests, 19 fichiers, ~7.5 s test time, ~15 s wall-clock.**

## 5. Coverage

Threshold v8 : `lines: 50, functions: 50` (pas de plancher branches /
statements — trop bruyant sur la petite surface). Atteint au premier passage :

| Métrique | Valeur |
|---|---|
| Statements | 71 % |
| Branches | 55 % |
| Functions | 74 % |
| Lines | 73 % |

Exclusions (`vitest.config.ts`) : `dist`, `node_modules`, fichiers `*.test.*`,
`test/**`, `scripts/**`, configs, `**/src/index.ts`, `**/src/main.tsx`,
`**/src/App.tsx`, `**/public/**`. Les bootstraps process et le top-level React
sont mieux couverts par les harnesses smoke (verify scripts + smoke-docker).

## 6. Couverture fonctionnelle

Surfaces clés exercées :

- **Mailbox bornée** (drop-oldest à 100, peek non-destructif, isolation par sid).
- **Messaging idle + signal PTY** : injection conditionnelle au franchissement
  de la fenêtre 50 ms, contenu du signal, exclusion des inactifs.
- **MCP `team.*`** : `whoami` / `list` / `send_message` / `read_inbox` /
  `broadcast` / `kill_worker` via vrai client SDK contre le serveur réel ;
  gating `PERMISSION_DENIED` sur `team.spawn_worker` côté worker.
- **REST routes** : `POST/GET/DELETE /orchestrators`, broadcast, sessions, input.
- **WS terminal** : ticket usage unique TTL 10 s, multi-attach un seul writer,
  ticket invalide rejeté.
- **WS events** : `orchestrator.created` / `session.spawned` / `session.exited`.
- **Hook endpoint** `POST /hooks/notification` (auth Bearer, dispatch notifier).
- **Persistance + boot recovery** : write-back, marquage `interrupted` au boot.
- **Discord embed shape** : title / fields / URL / color, no-op sans webhook,
  redaction du body dans les logs (plan §15).
- **`cwd` validation** : `realpath()` + ancrage sous `/workspace`, refus
  traversal et symlink hors-workspace.
- **`claude-init` lifecycle** : copie initiale, cache-hit mtime, recopie au
  changement, lift `.claude.json` (implicite + explicite), no-op si source
  absente (dev mode).
- **Web client** : verbes `api.*` + propagation token, `NewOrchestratorDialog`
  (warning amber `bypassPermissions`), `StatusBadge`.

## 7. Hors scope (post-v0.1)

- **Rendu xterm.js** : DOM glue lourd, ROI faible.
- **Spawn `claude` réel** : interdit dans `pnpm test` ; couvert par les smoke
  harnesses live.
- **`GET /sessions/:id/log`** : pas de test dédié, coverage basse acknowledged.
  Cap 50 MB / append-only exercé indirectement par les sessions intégration.
  À tighten en v0.2 si régression.
- **WS terminal load tests** : single-user, pas pertinent.
- **Browser e2e (Playwright)** : reporté.

## 8. `FakeAgentProcess`

`packages/server/src/modules/orchestrator/agent-process.ts` exporte une impl
de l'interface `AgentProcess` qui ne lance pas `claude` : on lui scripte des
sorties (`scriptOutput([...])`), un exit code (`scriptExit(code)`) et on
inspecte `fake.writes` pour assert sur les écritures du serveur dans le PTY.
L'exit est déterministe via `setImmediate` (pas de timer réel — les tests
attendent ≤ 20 ms quand ils ont besoin de la transition `running → killed`).

L'override se passe à `Spawner.create` ou `Orchestrator.addWorker` :

```ts
const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
const worker = orch.addWorker({
  name: 'scout', role: 'recon', prompt: 'noop', cwd,
  agentProcessOverride: fake,   // bypasse le spawn node-pty
});
```

Les tests d'intégration MCP construisent le worker via `addWorker` avec un
`FakeAgentProcess`, puis pilotent la session par un vrai client MCP (SDK
officiel). Voir §12 pour le rationale `addWorker` vs `team.spawn_worker`.

## 9. Verify scripts conservés

Les harnesses `pnpm --filter server verify:phase{2,3,4}` ne sont **pas**
remplacés. Distinction de scope :

| Couche | Cible | Quand |
|---|---|---|
| Vitest (`pnpm test`) | unit + intégration in-process, fake agent | dev loop, pre-commit, CI |
| `verify:phase*` | smoke live-stack contre le vrai serveur monté | post-bootstrap, post-deploy, debug |
| `smoke-docker.sh` | smoke containerisé end-to-end | release / image bump |

Les trois couches couvrent des risques différents (plan §6 Phase 7) et
restent maintenues. Les compteurs `15 + 23 + 25 = 63` checks sont la baseline
verify ; un drift là est traité comme un drift de tests.

## 10. Smoke Docker (MANUAL)

`scripts/smoke-docker.sh` — exécuté à la main après release ou bump d'image.

- `set -euo pipefail` en tête + `trap cleanup EXIT` (rm -f container/image,
  rm -rf workspace tmp) — propre dans tous les cas (succès, fail, Ctrl-C).
- Suffixe `$$` (PID shell) sur `IMAGE_TAG` et `CONTAINER_NAME` → invocations
  parallèles sans collision.
- Port host `127.0.0.1:18799` (hors range standard) pour éviter les conflits
  avec un container dev sur 8787.
- Checks : `docker build`, `docker run`, wait `/health` (30 s max, 1 s/poll),
  `GET /info` (assert `project_name=smoke`), `GET /orchestrators` avec et
  sans token (200 vs 401).
- Exit codes : `0` PASS / `1` FAIL / `2` prerequisites missing.

```sh
bash scripts/smoke-docker.sh
```

Hors `pnpm test` parce qu'un `docker build` froid prend ~3-5 min (npm install
de la CLI claude inclus) et qu'un daemon Docker n'est pas garanti dispo.

## 11. Fix prod — `claude-init.ts` mtime intégral

Phase 7 a chassé une régression mise en évidence par `claude-init.test.ts` :
`cpSync` avec `preserveTimestamps: true` round-trippe les mtimes avec un
drift sub-ms sur certains filesystems (FAT32 = résolution 2 s, NFS variable,
ext4 OK). La comparaison stricte `mtimeMs` échouait alors le cache-hit et
déclenchait une recopie inutile à chaque boot sur ces FS.

Fix dans `packages/server/src/runtime/claude-init.ts` (`liftClaudeJson` et
`initClaudeRuntime`) : comparaison à la **seconde entière** :

```ts
Math.floor(destStat.mtimeMs / 1000) === Math.floor(chosenStat.mtimeMs / 1000)
```

Conséquence : on a retiré le workaround `utimesSync` qui re-stampait la dest
à la valeur exacte de la source pour stabiliser le test. La résolution
per-second répond à la vraie question (« la source a-t-elle changé depuis la
dernière copie ? »). `utimesSync` reste utilisé dans le test « re-copies when
the source mtime changes » pour **avancer** le mtime source d'1 heure —
geste légitime du scénario, pas un workaround.

## 12. Déviations du plan

- **`team.spawn_worker` MCP** : le test d'intégration `rest-orchestrator`
  exerce le gate `PERMISSION_DENIED` via le vrai client MCP, mais le **spawn
  effectif du worker** passe par `orch.addWorker({ ..., agentProcessOverride })`
  directement. Sinon il faudrait soit lancer un vrai `claude` (interdit),
  soit injecter le fake à travers la pile MCP — coût d'ingéniérie disproportionné
  pour un risque déjà couvert par les unit tests `mailbox` / `messaging` et
  par le harness `verify:phase-3`.
- **Un wait temps réel restant** : `messaging.test.ts` attend 80 ms pour
  franchir le seuil idle de 50 ms (`it('injects a PTY signal when the
  recipient is idle past the threshold')`). Pas de fake timers ici parce que
  le code prod lit `Date.now()` directement et qu'un mock global rendrait le
  reste de la suite fragile. 30 ms de marge sur 50 ms — pas de flake observé
  sur 50+ runs locaux ni en cold-cache CI.
- **`vitest --reporter=hanging-process`** : passé clean — aucune ressource
  WS / HTTP / DB / timer n'est laissée ouverte entre suites. Les helpers
  `bootTestStack` exposent un `teardown()` invoqué dans `afterAll`.
- **Coverage thresholds basses (50/50)** : volontairement lâches pour la v0.1
  (plan §6 Phase 7 — premier pass focalisé sur les unités load-bearing, pas
  sur le coverage blanket). Bumper le seuil est une décision délibérée, pas
  une métrique à gamer.

## 13. Comment lancer

```sh
pnpm test                # 145 tests, ~15 s wall-clock (single shot CI)
pnpm test:watch          # mode interactif vitest
pnpm test:coverage       # ./coverage/index.html + summary terminal
pnpm --filter server verify:phase2   # 15/15 — smoke live-stack
pnpm --filter server verify:phase3   # 23/23
pnpm --filter server verify:phase4   # 25/25
bash scripts/smoke-docker.sh         # MANUAL — build + container smoke
```

Performance budget : < 10 s test execution. Atteint à ~7.5 s (coût pur
vitest). Le wall-clock ~15 s vient des cold imports TS, du setup jsdom et
du cold-start des listeners HTTP en intégration — incompressible sans virer
les modules natifs (better-sqlite3, node-pty).
