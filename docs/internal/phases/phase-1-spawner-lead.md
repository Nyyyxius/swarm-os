# Phase 1 — Spawner + lead solo

## 1. Livrable

Squelette end-to-end **lead-only** : un Spawner gère un ensemble
d'orchestrateurs ; chaque orchestrateur démarre **exactement une session
lead** via `node-pty` qui exécute le binaire `claude` réel. REST
`POST/GET/DELETE /orchestrators`, WebSockets `/ws/sessions/:id` (terminal
multi-attach, single-writer) et `/ws/events`, ticket WS single-use TTL
10 s émis par `GET /ws-ticket`. Frontend React câble la création, la
liste et l'attache xterm.js. **Pas de MCP** (Phase 2), **pas de workers**
(Phase 3), **pas de container** (Phase 5).

## 2. Module map

Référence : structure cible complète en plan.md §7. Cette phase remplit
les modules nécessaires au lead solo ; `mcp/`, `db/`, `notify/`,
`runtime/`, `preambles/`, `hooks.ts` arriveront aux Phases 2-5.

```
packages/server/src/
├── index.ts                          # boot, signal handlers, shutdownAll
├── config.ts                         # parse env, génère/lit /data/token, defaults
├── events.ts                         # eventBus pour /ws/events
├── modules/
│   ├── spawner/index.ts              # Map<id, Orchestrator>, listActive, counters, findSession
│   └── orchestrator/
│       ├── index.ts                  # cycle de vie orch, start/stop, lead-exit handling
│       ├── session.ts                # cycle de vie session, ring buffer 200 lignes, log capé 50 MB
│       └── agent-process.ts          # interface AgentProcess + impl PtyAgentProcess + stub FakeAgentProcess
└── http/
    ├── main.ts                       # createApp, body-parser limit, auth, WS upgrade routing
    ├── auth.ts                       # X-Auth-Token (timingSafeEqual) + tickets WS TTL 10 s
    ├── validation.ts                 # validateCwdUnderWorkspace via fs.realpath
    ├── routes/{orchestrators,sessions,ws-ticket}.ts
    └── ws/{terminal,events}.ts       # TerminalHub single-writer + EventsHub bridgé sur eventBus

packages/web/src/
├── App.tsx                           # shell, routing list/detail, panneau Settings (token)
├── api/client.ts                     # fetch + X-Auth-Token, types View, getWsTicket
├── components/
│   ├── NewOrchestratorDialog.tsx     # form name/role/cwd/prompt/preamble/defaults
│   ├── OrchestratorList.tsx          # liste + Create + Stop
│   ├── OrchestratorView.tsx          # détail + sélection session + Terminal
│   ├── StatusBadge.tsx
│   └── Terminal.tsx                  # xterm.js + addons fit/web-links + WS + ticket
└── hooks/{useOrchestrators,useSession}.ts   # polling 3 s / 2 s
```

## 3. REST surface live en Phase 1

Auth : `X-Auth-Token` obligatoire sauf `/health` et `/info`.

| Route                              | Méthode  | Auth   | Objet |
|------------------------------------|----------|--------|-------|
| `/health`                          | `GET`    | aucune | `{ status, project_name, orchestrators_active, sessions_active, sessions_waiting, uptime_seconds }` |
| `/info`                            | `GET`    | aucune | `{ project_name, version, started_at }` |
| `/orchestrators`                   | `POST`   | token  | Crée orch + lead. Body validé (name, role, lead.cwd, lead.prompt requis). `201 { orchestrator, lead }` |
| `/orchestrators`                   | `GET`    | token  | Liste actifs uniquement (filtre `stopped`/`failed`) |
| `/orchestrators/:id`               | `GET`    | token  | Détail (404 si inconnu) |
| `/orchestrators/:id`               | `DELETE` | token  | **Idempotent** : `204` qu'il existe ou non |
| `/orchestrators/:id/sessions`      | `GET`    | token  | Liste des sessions |
| `/sessions/:id`                    | `GET`    | token  | Détail (sans `sessionSecret`) |
| `/sessions/:id/input`              | `POST`   | token  | `{ data: string }` push texte humain dans le PTY |
| `/ws-ticket?session=:id`           | `GET`    | token  | Émet ticket terminal (TTL 10 s, single-use) |
| `/ws-ticket?events=1`              | `GET`    | token  | Émet ticket events (TTL 10 s, single-use) |

Routes plan §9 **non encore implémentées** :

- `POST /orchestrators/:id/broadcast` — Phase 3 (mailbox).
- `GET /sessions/:id/log` — Phase 4 (persistance + endpoint download).
- `POST /hooks/notification` — Phase 4 (hook `Notification` + Discord).

## 4. WebSocket surface

Deux endpoints, tous deux derrière un ticket consommé en upgrade
(`http.on('upgrade')` dans `http/main.ts`).

### Flux ticket

1. `GET /ws-ticket?session=<id>` → `{ ticket, ttlMs: 10000, kind: 'terminal'|'events', sessionId? }`.
2. Le client ouvre `ws://host/ws/sessions/<id>?ticket=<ticket>`.
3. `consumeTicket(value, kind)` : refus si manquant, expiré (>10 s),
   kind ne correspond pas, ou (terminal) `sessionId` ne matche pas le
   path. Sinon supprimé immédiatement (single-use).
4. Le ticket ne voyage **jamais** dans les logs (les query strings
   d'upgrade ne sont pas loggées par défaut), le token humain ne voyage
   jamais en query string.

### `/ws/sessions/:id` — terminal multi-attach

Premier client connecté = `writer`, suivants = `reader`. À la
déconnexion du writer, le suivant est promu et reçoit un `role-changed`.

Enveloppes serveur → client (toujours JSON) :

| `type`         | Champs                            | Quand |
|----------------|-----------------------------------|-------|
| `attached`     | `role`, `sessionId`, `status`     | À la connexion |
| `replay`       | `lines: string[]` (jusqu'à 50)    | Juste après `attached`, si ring buffer non vide |
| `data`         | `data: string`                    | À chaque chunk PTY |
| `role-changed` | `role: 'writer'`                  | Promotion après départ du writer |
| `exit`         | `ts`                              | Session terminée — la WS est fermée juste après (code 1000) |

Enveloppes client → serveur :

- `binary` : keystrokes bruts (writer uniquement).
- `{ type: 'input', data }` : keystrokes JSON (writer uniquement).
- `{ type: 'resize', cols, rows }` : resize PTY (writer uniquement).
- Texte non-JSON reçu d'un writer = traité comme keystrokes bruts.

### `/ws/events` — flux serveur global

Bridge sur `eventBus` (`packages/server/src/events.ts`). Envoie un
`{ kind: 'hello', ts }` à la connexion, puis un message JSON par event :
`orchestrator.created|updated|destroyed`,
`session.created|status_changed|exited`. Format :
`{ kind, ts, orchestratorId?, sessionId?, payload? }`.

## 5. Lancer en local

Prérequis :

- Node ≥ 22, pnpm 11.
- Binaire `claude` (Claude Code CLI) installé et authentifié au moins
  une fois — voir `docs/internal/phases/phase-0-bis-spike.md` pour les flags vérifiés.
  Sans `claude` dans le `PATH`, la création d'orchestrateur échouera
  dans le spawn PTY (status `failed`).
- En dev, `node-pty` doit être compilé pour ta version de Node — pnpm
  l'autorise via `pnpm-workspace.yaml` (`allowBuilds.node-pty: true`,
  cf. §10).

Variables d'env (dev) :

```
export SWARM_OS_TOKEN=dev-token
export SWARM_OS_WORKSPACE_ROOT="$PWD/.dev-data/workspace"
export SWARM_OS_DATA_DIR="$PWD/.dev-data"
mkdir -p "$SWARM_OS_WORKSPACE_ROOT"
```

Commandes :

```
pnpm install
pnpm dev                              # serveur :8787 + Vite :5173 (concurrently)
pnpm --filter server dev              # tsx watch — debug ciblé
pnpm --filter web dev                 # vite — debug ciblé
pnpm build                            # tsc côté server, vite build côté web
```

## 6. Smoke test (curl + websocat)

Remplacer `dev-token` par la valeur de `SWARM_OS_TOKEN` (ou le contenu
de `$SWARM_OS_DATA_DIR/token` si auto-généré).

```bash
# Health (token-free)
curl -s http://127.0.0.1:8787/health | jq

# Create orchestrator (le cwd doit résoudre sous SWARM_OS_WORKSPACE_ROOT après realpath)
curl -s -X POST http://127.0.0.1:8787/orchestrators \
  -H "X-Auth-Token: dev-token" -H 'Content-Type: application/json' \
  -d '{
    "name":"smoke","role":"explorer",
    "lead":{"cwd":"'"$SWARM_OS_WORKSPACE_ROOT"'","prompt":"List files."}
  }' | jq

# Lister
curl -s http://127.0.0.1:8787/orchestrators -H "X-Auth-Token: dev-token" | jq

ORCH_ID=$(curl -s http://127.0.0.1:8787/orchestrators -H "X-Auth-Token: dev-token" \
  | jq -r '.orchestrators[0].id')
SESSION_ID=$(curl -s http://127.0.0.1:8787/orchestrators -H "X-Auth-Token: dev-token" \
  | jq -r '.orchestrators[0].leadSessionId')

# DELETE idempotent — les deux appels renvoient 204
curl -s -o /dev/null -w "%{http_code}\n" \
  -X DELETE http://127.0.0.1:8787/orchestrators/$ORCH_ID -H "X-Auth-Token: dev-token"
curl -s -o /dev/null -w "%{http_code}\n" \
  -X DELETE http://127.0.0.1:8787/orchestrators/$ORCH_ID -H "X-Auth-Token: dev-token"

# WS terminal (recréer un orchestrateur d'abord si besoin)
TICKET=$(curl -s "http://127.0.0.1:8787/ws-ticket?session=$SESSION_ID" \
  -H "X-Auth-Token: dev-token" | jq -r .ticket)
websocat "ws://127.0.0.1:8787/ws/sessions/$SESSION_ID?ticket=$TICKET"
# → reçoit `{"type":"attached","role":"writer",...}` puis (éventuellement) `replay` puis `data` chunks.
# `wscat -c '...'` fonctionne aussi.
```

## 7. Posture sécurité Phase 1

Référence détaillée : plan §14.

**Déjà appliqué :**

- Bind `127.0.0.1` par défaut (override via `SWARM_OS_HOST`).
- HTTP : header `X-Auth-Token` comparé via `crypto.timingSafeEqual`.
- WS : ticket UUID v4 single-use TTL 10 s, refus si kind/sessionId ne
  matchent pas. Token humain jamais en query string.
- `lead.cwd` validé via `fs.realpath` côté `cwd` **et** côté workspace
  root, puis `path.relative` ; refus si `..` ou path absolu.
- `sessionSecret` (UUID v4) généré par session, distinct de
  `session.id`, **jamais** sérialisé dans `SessionView` ni dans les
  événements.
- `console.log({event:'boot',...})` n'inclut **pas** le token.
- Logs session ouverts en mode `0o600`, `/data/token` écrit en mode
  `0o600`.
- Limite body-parser : `max(64, ceil(maxPromptSizeBytes/1024) + 64) Ko`
  → 413 propre `PAYLOAD_TOO_LARGE`. Validation route renforce
  `prompt+preamble <= maxPromptSizeBytes` (canonique).
- Plafond `SWARM_OS_MAX_ORCHESTRATORS` (défaut 10) → 429
  `MAX_ORCHESTRATORS`.

**Pas encore appliqué (par phase) :**

- `mcp.json` mode `0o600` dans `/tmp/swarm-os/...` — Phase 2.
- Permissions lead-only sur `team.spawn_worker`/`team.kill_*` — Phase 3.
- `Authorization: Bearer <HOOK_TOKEN>` sur `/hooks/notification` —
  Phase 4.
- Container, user `node`, mounts `/workspace` RW + `/claude-source` RO,
  copie boot vers `/data/.claude-runtime/` — Phase 5.

## 8. Configuration

Sous-ensemble du tableau plan §13 reconnu en Phase 1 (parse strict :
type ou domaine invalide → throw au boot) :

| Var                                  | Défaut                | Notes |
|--------------------------------------|-----------------------|-------|
| `SWARM_OS_PORT`                      | `8787`                | int ≥ 0 |
| `SWARM_OS_HOST`                      | `127.0.0.1`           | override pour container Phase 5 |
| `SWARM_OS_PROJECT_NAME`              | `dev`                 | confort dev — plan §13 le marque "obligatoire" en prod |
| `SWARM_OS_TOKEN`                     | auto-généré           | si absent : lit/crée `<dataDir>/token` (mode `0600`) |
| `SWARM_OS_WORKSPACE_ROOT`            | `/workspace`          | racine sous laquelle tous les `cwd` doivent résoudre |
| `SWARM_OS_DATA_DIR`                  | `/data`               | crée `<dataDir>` et `<dataDir>/logs` au boot |
| `SWARM_OS_DEFAULT_MODEL`             | `claude-opus-4-7`     | confirmé H2 du spike Phase 0 bis |
| `SWARM_OS_DEFAULT_EFFORT`            | `xhigh`               | doit appartenir à `low|medium|high|xhigh|max` (H5) |
| `SWARM_OS_DEFAULT_PERMISSION_MODE`   | `bypassPermissions`   | set widened (cf. §9) |
| `SWARM_OS_MAX_ORCHESTRATORS`         | `10`                  | 429 au-dessus |
| `SWARM_OS_MAX_PROMPT_SIZE_KB`        | `64`                  | applique sur `prompt + preamble` |
| `SWARM_OS_CLAUDE_START_TIMEOUT_S`    | `30`                  | parsé, pas encore consommé en Phase 1 |

Vars **non reconnues** en Phase 1 : `SWARM_OS_DISCORD_WEBHOOK_URL`,
`SWARM_OS_PUBLIC_URL`, `SWARM_OS_MCP_PORT`, `SWARM_OS_MAX_WORKERS_PER_ORCH`,
`SWARM_OS_MAX_MESSAGE_SIZE_KB`, `SWARM_OS_MAX_INBOX_SIZE`, `HOOK_TOKEN`
(arrivent Phases 2-4).

## 9. Limites connues, à reprendre

- **Pas de MCP HTTP** (`/mcp/:orch_id/:session_secret`, SDK officiel) —
  Phase 2.
- **Pas de workers**, mailbox, `team.spawn_worker` — Phase 3.
- **Pas de Discord, SQLite, hook `/hooks/notification`,
  `GET /sessions/:id/log`** — Phase 4.
- **Pas de `CLAUDE_CONFIG_DIR` par session** ni copie `~/.claude` →
  `/data/.claude-runtime/` — Phase 5. En attendant, le PTY hérite du
  `process.env`, donc le claude lancé voit le `~/.claude` du
  développeur. À ne PAS exécuter en parallèle avec un autre client
  claude local.
- `PermissionMode` est élargi au set complet de la CLI
  (`auto | bypassPermissions | acceptEdits | default | dontAsk | plan`),
  défaut inchangé `bypassPermissions` (plan §17).
- **Pas de tests** — Phase 7. L'interface `AgentProcess` est en place
  et un `FakeAgentProcess` stub existe, mais pas encore scriptable.
- `SWARM_OS_CLAUDE_START_TIMEOUT_S` parsé mais non appliqué (watchdog
  viendra avec idle-detection en Phase 3).
- Pas de bouton "Stop" individuel par session — seul le DELETE
  d'orchestrateur tue l'ensemble (suffisant en Phase 1 puisqu'il n'y a
  qu'un lead).

## 10. Déviations de plan

- **`SWARM_OS_DEFAULT_EFFORT`** ajouté (défaut `xhigh`). Non listé en
  plan §13, autorisé par le spike Phase 0 bis (H5) qui a confirmé que
  `--effort low|medium|high|xhigh|max` est le flag réel. La correction
  §8 du spike reste l'arbitre : `--effort` est passé à `claude` par
  `buildClaudeArgs` (cf. `session.ts`).
- **`PermissionMode` élargi** au set complet exposé par la CLI. Le
  plan §8 / §17 ne mentionnait que `auto | bypassPermissions` ; le
  spike a montré que la CLI en accepte davantage et il est pratique
  qu'un opérateur puisse switcher en `plan` ou `acceptEdits` sans
  recompiler. Défaut inchangé : `bypassPermissions`.
- **`pnpm-workspace.yaml`** ajoute `allowBuilds: { node-pty: true }`
  pour autoriser le post-install natif sans approve interactif
  (cohérent avec `esbuild: true` ajouté en Phase 0).
