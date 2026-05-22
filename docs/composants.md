# swarm-os — Composants principaux

Vue d'ensemble des composantes du système et de la stack technique utilisée
pour chacune. Complémentaire des rapports `phase-*.md` qui décrivent
l'historique d'implémentation.

---

## 1. Server (`packages/server/`)

Backend Node.js / TypeScript (ESM, Node ≥22, runtime Docker `node:24-bookworm-slim`).

| Sous-système | Tech |
|---|---|
| HTTP/API REST | Express 5 (`src/http/`) |
| WebSocket (terminaux + flux d'événements) | `ws` |
| Serveur MCP exposé aux sessions Claude | `@modelcontextprotocol/sdk` (`src/modules/mcp/`) |
| PTY / spawn des sessions Claude | `node-pty` (`src/modules/spawner/`, `src/modules/orchestrator/`) |
| Persistance | `better-sqlite3` (`src/modules/db/`) |
| Validation | `zod` |
| Logs structurés | `pino` (+ `pino-pretty` en dev) |

Modules métier : `orchestrator`, `spawner`, `roles`, `preambles`, `notify`,
`mcp`, `db`.

---

## 2. Web (`packages/web/`)

SPA + PWA (shell mobile via Tailscale).

| Sous-système | Tech |
|---|---|
| Framework UI | React 19 |
| Build / dev server | Vite 6 + `@vitejs/plugin-react` |
| Styling | Tailwind CSS 4 (`@tailwindcss/vite`) |
| Terminal in-browser | `@xterm/xterm` + addons `fit` / `web-links` |
| Tests UI | Testing Library + jsdom + Vitest |

---

## 3. Sessions agents

Composante centrale du système : une "session" = un processus `claude` (CLI
Anthropic) lancé dans un **PTY** et piloté par le server.

### 3.1 Anatomie d'une session

- **Binaire** : `claude` (Claude Code CLI), version pinned **`2.1.142`** dans
  le Dockerfile.
- **Spawn / I/O** : `node-pty` via `PtyAgentProcess`
  (`modules/orchestrator/agent-process.ts:41`). Fournit
  `write / resize / kill / onData / onExit`.
  En tests : `FakeAgentProcess` (même interface, déterministe).
- **Type** : `lead` ou `worker` (`session.ts:21`).
- **Statuts** :
  `starting → running → waiting → exited | killed | interrupted | failed`.
  `paused` ajouté à l'enum (ticket S5, 2026-05-22) : transition
  bidirectionnelle `running ↔ paused` via `SIGSTOP / SIGCONT`, exposée
  par `POST /sessions/:id/{pause,resume}`. Restart = nouvelle session
  (l'ancienne passe en `interrupted`).
- **Args claude** (`buildClaudeArgs`, `session.ts:128`) :

  ```
  --model <m>
  --effort <low|medium|high|xhigh|max>
  --permission-mode <bypassPermissions|...>
  --mcp-config=<path>
  <prompt>
  ```

  Le `=` est obligatoire : `--mcp-config` est variadique dans claude 2.1.142
  (`<configs...>`). Sans le `=`, le prompt qui suit serait avalé comme un
  deuxième fichier de config (`ENAMETOOLONG`). Leçon du smoke test Phase 5.

- **Logs** : flux PTY → fichier `<dataDir>/logs/<orchId>/<sessionId>.log`
  (cap 50 MB) + ring buffer 200 lignes en mémoire pour replay côté UI.

### 3.2 Architecture d'équipe

```
Spawner (singleton)
  └── Orchestrator (N max)
        ├── Session lead (1, obligatoire)
        └── Session worker (0..N, plafonné)
```

- **Spawner** (`modules/spawner/index.ts`) — singleton du process. Plafonné
  par `maxOrchestrators`. Crée un Orchestrator, persiste l'état, lance le
  lead, puis spawn N **initial workers** si le rôle attaché en demande.
- **Orchestrator** (`modules/orchestrator/index.ts`) — une "équipe" =
  1 lead + N workers (`maxWorkersPerOrchestrator`). Garde `leadSessionId`,
  la mailbox et la liste des sessions.
- **Roles** (`modules/roles/index.ts`) — templates réutilisables (modèle,
  effort, preamble, connectors Discord, workerCount initial) stockés via
  `RoleStore`. Permet d'instancier rapidement des équipes typées.

### 3.3 Communication inter-agents — MCP

Chaque session voit un serveur **MCP HTTP local** (loopback uniquement).

- **Transport** : `@modelcontextprotocol/sdk` → `StreamableHTTPServerTransport`,
  bind **127.0.0.1** sur `mcpPort` (8788 par défaut), mode stateless
  per-request (`mcp/server.ts:61`).
- **Auth** : URL `/mcp/:orch_id/:session_secret`. Le `sessionSecret` (UUID v4)
  est unique à chaque session et injecté dans le `mcp.json` per-session écrit
  sur disque avant le spawn (`mcp-config.ts`). Jamais loggé en clair
  (4 chars max via `redactSecret`).
- **Outils MCP exposés** (`mcp/tools.ts`) :

  Intra-équipe :
  - `team.whoami`
  - `team.list`
  - `team.send_message`
  - `team.read_inbox`
  - `team.broadcast`

  Lead-only :
  - `team.spawn_worker`
  - `team.kill_worker`
  - `team.kill_all_workers`

  Cross-équipe (entre leads d'orchestrators distincts) :
  - `swarm.list_teams`
  - `swarm.send_to_lead`
  - `swarm.broadcast_to_leads`

- **Mailbox** (`orchestrator/mailbox.ts`) — file in-memory bornée
  (`SWARM_OS_MAX_INBOX_SIZE = 100`), politique drop-oldest avec flag
  `dropped: true` retourné au sender. **Jamais persistée** : les PTY ne
  survivent pas au redémarrage du process, donc persister leurs inbox ne
  ferait que gonfler la DB sans consommateur.
  Depuis S1 (2026-05-22), un compteur cumulé `messagesTotal: number` est
  incrémenté à chaque `deliver()` / `broadcast()` (jamais reset). Exposé
  comme `OrchestratorView.msgCount` via `GET /orchestrators[/:id]`. Sert
  aux compteurs per-team + total global UI.

### 3.3.bis Surface d'observabilité (depuis S1-S9, 2026-05-22)

- `OrchestratorView` (`modules/orchestrator/index.ts` — `toView()`)
  expose désormais `msgCount: number` (S1) et
  `health: 'ok' | 'warn' | 'bad' | 'stopped'` (S7, calculé à la volée
  par `modules/orchestrator/health.ts#computeOrchestratorHealth`).
- `SwarmEventKind` (`packages/server/src/events.ts`) ajoute
  `'mailbox.message'` (S2) avec payload
  `{ from, to: string | 'broadcast', orchestratorId }`. Émis depuis
  `modules/orchestrator/messaging.ts` (4 fonctions de livraison) et
  `index.ts#_onWorkerExit` (synthétique `from: 'system'`). Les anciens
  consommateurs ignorent les kinds inconnus.
- Métriques agrégées (in-memory, perdues au restart) :
  - `MessagesAggregator` (`modules/metrics/aggregator.ts`) — ring buffer
    global 60 pts + per-orchestrator 8 pts. Sortie via
    `GET /metrics/messages` (S9).
  - `BusMetricsCollector` (`modules/metrics/busMetrics.ts`) — latency
    MCP / queue depth / throughput / err rate sur fenêtre 60 s. Sortie
    via `GET /metrics/bus` (S8). MCP server (`modules/mcp/server.ts`)
    instrumenté pour publier les RTT.

### 3.4 Notification hook (session → server)

Pour détecter qu'une session devient `waiting` (attente d'input humain),
on utilise le hook `Notification` de Claude Code, configuré via un
`settings.json` **par session** :

- Dossier : `<claudeRuntimeDir>/sessions/<id>/`, exporté via
  `CLAUDE_CONFIG_DIR` dans l'env du PTY.
- Pre-accept du dialog "bypass permissions"
  (`skipDangerousModePermissionPrompt: true`) + dialog trust (`.claude.json`
  seedé sur le `cwd`) pour éviter que le PTY se fige au premier spawn.
- Le hook lit le payload Claude sur stdin et `POST` vers
  `http://127.0.0.1:<port>/hooks/notification` avec
  `Authorization: Bearer <HOOK_TOKEN>` (token séparé du token UI, généré
  dans `/data/hook-token`).

### 3.5 Runtime Claude (Docker)

`runtime/claude-init.ts` matérialise `~/.claude` au boot du container :

- Source `/claude-source` (mount RO) → copie RW vers
  `<dataDir>/.claude-runtime/` (`chmod 0700`), idempotente via marker mtime.
- `.claude.json` "lifté" séparément (OAuth + thème).
- Sessions partagent l'auth + l'historique via **symlinks** depuis leur
  `CLAUDE_CONFIG_DIR` per-session vers ce runtime root.
- Hors container (`pnpm dev`) : no-op, le `~/.claude` du host est utilisé
  tel quel.

### 3.6 Isolation

Pas d'isolation au runtime — toutes les sessions tournent en
`bypassPermissions` dans le **même** container Docker. L'isolation = la
frontière du container (plan §14). MCP et HTTP server bindent loopback
uniquement.

---

## 4. Notifications

| Sous-système | Tech |
|---|---|
| Discord webhooks | `fetch` natif, embeds custom (`modules/notify/discord.ts`) |
| Sélection notifier | Per-rôle (override si webhook présent sur le rôle) sinon global |

Variable d'env : `SWARM_OS_DISCORD_WEBHOOK_URL` (no-op si absente).

---

## 5. Conteneurisation / déploiement

- **Dockerfile** multi-stage :
  - `builder` : `node:24-bookworm-slim` + toolchain native (python3, g++)
    pour compiler `node-pty` et `better-sqlite3`, puis `pnpm -r build` +
    `pnpm deploy --prod`.
  - `runtime` : `node:24-bookworm-slim` minimal + claude CLI + curl + tini,
    USER `node`, expose 8787.
- **Compose** : `examples/docker-compose.single.yml` (mono-projet),
  `examples/docker-compose.multi.yml` (multi-projet, un container par
  projet, ports + canaux Discord distincts).

---

## 6. Tooling repo

| Sous-système | Tech |
|---|---|
| Monorepo | pnpm workspaces (`pnpm@11.1.2`) |
| Dev parallèle | `concurrently` (`pnpm dev` lance server + Vite) |
| Tests | Vitest 4 + `@vitest/coverage-v8` |
| Smoke harnesses | `tsx` (`scripts/verify-claude-code.ts`, `verify-phase-{2,3,4}.ts`) |
| Lint | ESLint 9 + `typescript-eslint`, plugins React |
| Format | Prettier 3 |
| Scripts CLI | TypeScript via `tsx` |
