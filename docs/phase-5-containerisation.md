# Phase 5 — Containerisation

## 1. Livrable

Phase 5 boucle le packaging déploiement. Quatre artefacts :

1. **`Dockerfile` multi-stage** (`builder` puis `runtime`) qui produit une
   image `node:24-bookworm-slim` avec la CLI claude pinnée, `USER node`,
   `HEALTHCHECK` sur `/health`, et n'expose que `8787` (plan §6 Phase 5,
   plan §13).
2. **`examples/docker-compose.{single,multi}.yml`** — un container par
   projet, ports bindés sur `127.0.0.1` host-side, mounts `/workspace`,
   `/claude-source:ro`, `/data` (plan §13).
3. **`packages/server/src/runtime/claude-init.ts`** — au boot, copie
   `/claude-source/` (RO) vers `<dataDir>/.claude-runtime/` (RW privé).
   Idempotent via marker `.swarm-os-initialized` qui compare la mtime de
   la source. No-op hors container (dev local — claude utilise alors
   `~/.claude` du host directement). Résout la contrainte spike H7 :
   `~/.claude` est mixte RW et **ne peut pas** être monté RO directement.
4. **Stratégie `CLAUDE_CONFIG_DIR` per-session** par symlinks du runtime
   partagé vers un sous-répertoire propre à la session (cf. §6 ci-dessous).

## 2. Image structure

Stage `builder` (`node:24-bookworm-slim`) :

- Toolchain native (`python3 / make / g++ / git`) pour `node-pty` +
  `better-sqlite3`.
- pnpm `11.1.2` via corepack (`packageManager` pinning).
- `pnpm install --frozen-lockfile` puis `pnpm -r build`. Copie
  explicite `src/modules/preambles/*.md` → `dist/modules/preambles/`
  (tsc ne porte pas les `.md`).
- `pnpm --filter=server deploy --prod --legacy /deploy/server` produit
  un arbre runtime auto-suffisant (sans devDeps, sans symlink farm
  pnpm-store).

Stage `runtime` (`node:24-bookworm-slim`) :

- `tini / curl / python3 / git / ca-certificates`. `python3` requis
  par le hook Notification de Phase 4 (JSON-escape stdin — limite §11
  de Phase 4). Pas de toolchain native (les `.node` compilés voyagent
  depuis `builder`).
- CLI Claude Code **natif** (plus le paquet npm) : le binaire
  `linux-${TARGETARCH}` de `downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}`,
  vérifié par SHA-256 contre le `manifest.json` de la version, posé dans
  `/usr/local/bin/claude` ; `DISABLE_AUTOUPDATER=1` le garde sur le pin.
  `CLAUDE_CODE_VERSION=2.1.142` par défaut (`ARG`). **Bumper** cette
  version exige de **rejouer `pnpm verify:claude` AVANT** + un spawn
  PTY réel (cf. §8).
- `USER node` (uid 1000, image upstream — plan §14 non-root).
- `ENTRYPOINT ["/usr/bin/tini","--"]`, `CMD ["node","dist/index.js"]`.
- `HEALTHCHECK --interval=30s --timeout=5s --retries=3
  --start-period=10s CMD curl -fsS http://127.0.0.1:8787/health`.
- `EXPOSE 8787` **uniquement**. Port `8788` (MCP) intentionnellement
  non déclaré (plan §14).

Tailles mesurées : ~279 MiB contenu, ~1.09 GB image avec attestations
`buildx` (overhead attestation ~75 % du blob, zéro pull supplémentaire
à l'usage). Largement sous la cible 600 MB du plan.

## 3. Mounts attendus

| Container path     | Rôle                                | Suggestion host                | Mode |
|--------------------|-------------------------------------|--------------------------------|------|
| `/workspace`       | Code projet (cwd des agents)        | `~/dev/<projet>`               | RW   |
| `/claude-source`   | Credentials Claude **source**       | `~/.claude`                    | **RO** (copié au boot par `claude-init`) |
| `/data`            | État (DB, tokens, logs, runtime)    | `~/.swarm-os/<projet>`         | RW   |

`VOLUME ["/workspace","/claude-source","/data"]` déclare ces points :
Docker crée des volumes anonymes si aucun bind n'est fourni —
en pratique `docker-compose` les remplit toujours.

## 4. Compose

Deux exemples sous `examples/`. Communs aux deux :

- `init: true` — Docker injecte tini PID 1 (zombie reaping). L'image
  porte déjà `tini` en `ENTRYPOINT` ; les deux couches sont bénignes
  et le contrat reste explicite côté orchestration (plan §13).
- `restart: unless-stopped`.
- `healthcheck` dupliqué au niveau compose (visible via
  `docker compose ps`) — mêmes seuils que le Dockerfile.
- `${FYREL_DISCORD_WEBHOOK:-}`, `${SWARM_OS_PUBLIC_URL:-…}` injectés
  via `.env` ou env shell — jamais en dur dans le YAML.

`docker-compose.single.yml` : un service `swarm-fyrel-cc-app`,
`"127.0.0.1:8787:8787"`, mounts complets, environnement de base.

`docker-compose.multi.yml` : deux services (`swarm-fyrel-cc-app` +
`swarm-grap-server`) sur ports loopback distincts (`8787` et `8797`),
chacun avec son `/workspace`, son `/data`, son webhook Discord. La
source `~/.claude` est partagée RO entre les deux : la copie boot-time
locale à chaque container évite la corruption croisée (plan §13/§14).

## 5. Boot sequence

Ordre strict (`packages/server/src/index.ts`) :

1. `loadConfig()` — parse env, résout `dataDir`, `claudeSourceDir`,
   `claudeRuntimeDir`, ouvre / génère tokens (`SWARM_OS_TOKEN`,
   `HOOK_TOKEN`).
2. `initClaudeRuntime({ sourceDir, runtimeDir })` — copie
   `/claude-source` → `/data/.claude-runtime` si nécessaire (idempotent
   marker). **Avant** le HTTP : aucun orchestrateur ne peut racer
   contre la copie.
3. `new SwarmDb(dataDir)` ouvre SQLite (WAL + FK), applique le schéma,
   puis `persistence.recoverFromCrash()` marque toute ligne
   non-terminale comme `interrupted` / `failed` avec
   `stop_reason='server-restart'` (plan §6 Phase 4).
4. `startServer(...)` (HTTP main `:8787`) puis `mcp.start()`
   (MCP `:8788` loopback intra-container). Échec MCP → on ferme
   proprement le main et `process.exit(1)`.
5. `SIGINT` / `SIGTERM` handlers installés ; `uncaughtException` /
   `unhandledRejection` log via le root pino.

## 6. Stratégie `CLAUDE_CONFIG_DIR` per-session

Pour chaque session spawnée, `Session._spawn` (Phase 4) dérive :

```
<runtimeDir>/sessions/<sid>/
├── settings.json                  # écrit par Phase 4 — Notification hook + HOOK_TOKEN
├── .credentials.json -> ../../.credentials.json   (symlink)
├── history.jsonl     -> ../../history.jsonl
├── projects          -> ../../projects
├── cache             -> ../../cache
├── plans             -> ../../plans
├── plugins           -> ../../plugins
├── tasks             -> ../../tasks
├── telemetry         -> ../../telemetry
├── todos             -> ../../todos
└── …                 (cf. SHARED_ENTRIES dans session.ts)
```

`CLAUDE_CONFIG_DIR=<runtimeDir>/sessions/<sid>` est exporté dans
l'env du PTY claude.

Décisions clé :

- **`settings.json` per-session, pas symlinké** — il porte le
  `Notification` hook avec `HOOK_TOKEN` + `orch_id` + `session_id`
  baked-in. `_linkSharedClaudeState` retire d'abord un lien stale
  avant que `writeFileSync` ne dépose le fichier spécifique.
- **`sessions/` du runtime root NON linké** — collisionnerait avec
  le namespace session-id propre à Claude. Si Claude écrit un arbre
  `sessions/` dans son config dir, il atterrit dans la dir
  per-session (pas dans le runtime partagé).
- **Tradeoff assumé** : les écritures partagées (history.jsonl,
  cache, telemetry…) propagent vers `<runtimeDir>` et sont vues par
  les sessions concurrentes — exactement le comportement attendu
  par claude (qui pense écrire dans `~/.claude`). Seul le hook
  context reste isolé.

Choix **symlink plutôt que copie** : une copie complète par spawn
coûterait des MB et fragmenterait l'historique claude (chaque
session ré-écrirait dans son silo, perdant le cache partagé).

## 7. Sécurité posture

- **Bind `127.0.0.1:HOST:8787` host-side** — accès inter-machine
  uniquement via Tailscale qui expose le loopback de l'host sur le
  tailnet. Jamais `0.0.0.0` côté host (plan §14 — critique).
- **`SWARM_OS_HOST=0.0.0.0` côté container** est correct : le binding
  loopback est appliqué côté **host** par Docker (`127.0.0.1:8787:8787`).
  Lecture plan §14 = "loopback du host", cf. §12 ci-dessous.
- **MCP `:8788` jamais mappé** — ni dans `EXPOSE`, ni dans `ports:`.
  Reste hardcodé loopback intra-container côté serveur MCP.
- **`USER node`** non-root.
- **`/claude-source` RO** + copie RW privée par container : plusieurs
  swarm-os concurrents partagent les mêmes credentials sources sans
  corruption croisée (plan §14).
- **`HEALTHCHECK`** comme signal de vie pour `restart: unless-stopped`
  + diagnostic `docker compose ps`.

## 8. Bug fix critique landé cette phase

`Session._buildClaudeArgs` utilise désormais `--mcp-config=<path>`
(forme `=`) et **non** `--mcp-config <path>` (deux tokens). Raison :
dans claude `2.1.142`, la flag est **variadique** (`<configs...>`) ;
avec deux tokens, le prompt suivant est slurped comme un second
fichier de config et claude crashe. Latent depuis Phase 2 — les
`verify-phase*` utilisent `FakeAgentProcess` et n'exerçaient donc
pas la vraie CLI. Surfacé par le smoke test container.

**Avertissement** : tout futur bump de `CLAUDE_CODE_VERSION` doit
**rejouer `pnpm verify:claude` ET un spawn PTY réel** pour rattraper
ce genre de régression argv (un bump variadique → positional muet
ne casse pas le parsing, juste la sémantique).

## 9. Nouvelles vars d'env

| Var                            | Défaut                              | Notes |
|--------------------------------|-------------------------------------|-------|
| `SWARM_OS_CLAUDE_SOURCE_DIR`   | `/claude-source`                    | Mount point RO de `~/.claude`. Chemin résolu à `path.resolve()`. |
| `SWARM_OS_CLAUDE_RUNTIME_DIR`  | `<dataDir>/.claude-runtime`         | Cible RW de la copie boot. `chmod 0700`. |

Cf. plan §13 — table principale (`SWARM_OS_*`) inchangée par ailleurs.

## 10. Container smoke recipe

```sh
# Build (defaults : claude 2.1.142)
docker build -t swarm-os:phase5 .

# Dirs jetables
mkdir -p /tmp/swarm-os-smoke/{workspace,data}

# Run (loopback, /claude-source RO depuis le host)
docker run -d --name swarm-smoke --init \
  -p 127.0.0.1:8787:8787 \
  -v /tmp/swarm-os-smoke/workspace:/workspace \
  -v "$HOME/.claude:/claude-source:ro" \
  -v /tmp/swarm-os-smoke/data:/data \
  -e SWARM_OS_PROJECT_NAME=smoke \
  swarm-os:phase5

# Sanity
docker exec swarm-smoke claude --version          # 2.1.142 (Claude Code)
curl -fsS http://127.0.0.1:8787/health            # {"ok":true,...}
docker logs swarm-smoke | grep claude_init        # cache-hit | copied
docker exec swarm-smoke ls -la /data/.claude-runtime/ | head -5
docker rm -f swarm-smoke
```

## 11. Limitations restantes / known issues

- **`~/.claude.json`** (dans `$HOME`, **hors** `~/.claude/`) n'est pas
  encore lifté par `claude-init`. Conséquence : warning
  *"configuration file not found"* + un theme-picker interactif au
  premier spawn. Cible polish Phase 6. Référence : footer spike H7
  (`scripts/verify-claude-code.report.md`).
- Phase 6 reprend : auto-init `SWARM_OS_TOKEN` (UX), PWA manifest,
  README à la racine.
- Phase 7 reprend : suite tests unit/integration et smoke-test
  container en CI.
- Pas de garbage collection des `<runtimeDir>/sessions/<sid>/` à
  l'exit d'une session (plan §6 Phase 5 le mentionnait — laissé à
  Phase 6 polish, l'orphan n'est pas dangereux : symlinks +
  `settings.json` ~1 KiB).

## 12. Déviations du plan

- **`pnpm deploy --prod --legacy`** requis depuis pnpm ≥ 10 (sans
  `inject-workspace-packages=true`, le nouveau deploy refuse).
  `--legacy` est sans risque sur un workspace single-package cible.
- **`dist/modules/preambles/*.md` non émis par tsc** — patché par
  `cp` explicite dans le stage `builder` + allowlist
  `packages/server/src/modules/preambles/*.md` dans `.dockerignore`
  (qui exclut sinon `node_modules / dist / .dev-data / .git /
  archives`).
- **`SWARM_OS_HOST=0.0.0.0` in-container** — divergence apparente
  avec plan §14 ("loopback uniquement"). Lecture correcte : le
  loopback s'applique **côté host** via le mapping
  `127.0.0.1:HOST:8787`. Le container doit accepter depuis l'hôte
  Docker (réseau bridge), donc `0.0.0.0` à l'intérieur. MCP reste
  hardcodé loopback intra-container.
- **Symlinks plutôt que copie** pour le `CLAUDE_CONFIG_DIR`
  per-session (plan §13 disait "copie minimale du runtime"). Plus
  léger, et matche l'attente claude de muter son propre history /
  cache partagé. Seul `settings.json` est matérialisé per-session.
