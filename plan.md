# swarm-os — Plan MVP

> Plateforme web pour orchestrer des équipes de sessions Claude Code en mode autonome. Chaque instance pilote un projet, containerisée, multi-déployable. Un orchestrateur = une équipe (1 lead + N workers) communiquant via un MCP HTTP. Supervision et arrêt depuis n'importe quel navigateur, notifications Discord, interventions humaines à tout moment.

**Project name** : `swarm-os`
**Status** : Plan — non implémenté
**Cible** : single-user, multi-projet, déployable en Docker sur stack WSL2 + Tailscale, accessible depuis mobile

---

## 1. Vision

Un serveur Node.js qui héberge un **Spawner** unique. Le Spawner crée et gère plusieurs **Orchestrateurs**. Chaque orchestrateur est une équipe d'agents Claude avec exactement un **lead** et zéro ou plusieurs **workers**. Les membres d'une équipe communiquent via un MCP `team-comms` fourni par l'orchestrateur, avec une **mailbox en mémoire + signal PTY** comme transport de messages. Toutes les sessions tournent en `--permission-mode bypassPermissions` pour permettre une autonomie maximale, l'isolation étant fournie par le container.

L'humain attache un terminal à n'importe quelle session pour superviser ou intervenir, reçoit des notifications push via Discord quand une session pose une question ou termine, et peut tuer une équipe entière depuis un bouton.

**Une instance swarm-os = un projet**. Plusieurs instances cohabitent sur le même serveur via Docker, chacune avec son propre container, ses propres ports, son propre état. Une stack `docker-compose` au niveau utilisateur déclare les projets actifs.

**Ce que ce projet est** :
- Un orchestrateur de **multi-agent Claude Code teams** avec communication structurée.
- Une console de supervision pour équipes autonomes, accessible mobile.
- Un système **multi-projet, multi-instance**, containerisé.

**Ce que ce projet n'est PAS** :
- Pas un produit SaaS multi-tenant — single-user, un opérateur (toi).
- Pas un outil pour contourner les politiques d'Anthropic. Toutes les sessions sont des `claude` interactifs en PTY, facturés normalement sur les quotas de souscription.
- Pas un système de production pour automation à l'échelle — pour ça, clé API + spend limits restent recommandés.

---

## 2. Cas d'usage cibles

1. **Team merge PR** : orchestrateur `merge-team` avec lead `coordinator` + 3 workers `PR#142`, `PR#143`, `PR#144`. Le lead distribue, les workers exécutent et communiquent via `team-comms` quand besoin de coordination.
2. **QA validation** : orchestrateur `qa-app` avec lead `test-writer` + workers `test-runner-unit`, `test-runner-e2e`. Le lead écrit les tests, dispatche, agrège.
3. **JIRA batch** : orchestrateur `tickets-revalidation` avec lead `analyzer` qui spawn un worker par ticket, parallèle, collecte.
4. **Long-running autonomous task** : laisser une équipe travailler 30 min, recevoir une notif Discord quand le lead pose une question ou termine, attacher pour valider.
5. **Mobile-first supervision** : depuis le téléphone via Discord (notif) → Tailscale (web UI) → attache au lead → intervention ou kill switch.
6. **Multi-projet parallèle** : deux instances swarm-os actives en même temps, une pour `fyrel-cc-app`, une pour `grap-server`. Notifs Discord routées sur des canaux distincts.

---

## 3. Architecture

### Vue d'ensemble (une instance)

```
┌────────────────────────┐         ┌──────────────────────────────────────┐
│  Browser               │         │  Container "swarm-os-{project}"      │
│  ──────────────        │ ◀─WS──▶│  ────────────────────────────────    │
│  • React + Vite        │         │  • Main HTTP (:8787) — exposé        │
│    (bundle servi par   │         │    REST + WS (auth: token + ticket)  │
│    Express)            │         │  • MCP HTTP (:8788) — interne only   │
│  • xterm.js            │         │    auth: orch_id + session_secret    │
│  • Liste orch + sess   │         │  • Module Spawner                    │
│  • Discord links       │         │  • Module Orchestrators (×N)         │
└────────────────────────┘         │  • Module Notifier (Discord webhook) │
         ▲                         │  • SQLite dans /data                 │
         │ Tailscale → host:NNNN   │  • claude CLI installé               │
         │                         └────────┬─────────────────┬───────────┘
         │                            pty   │                 │ HTTP localhost
         │                          spawn   │                 ▲
         │                                  ▼                 │
         │              ┌─────────────────────────────────────┴────────┐
         │              │  Orchestrator "merge-team" (id: X)           │
         │              │  ──────────────────────────────────────────  │
         │              │                                               │
         │              │   ┌─────────────┐  --mcp-config              │
         │              │   │ Lead (PTY)  │──▶ http://127.0.0.1:8788/  │
         │              │   │             │     mcp/X/<session_secret> │
         │              │   └─────────────┘                             │
         │              │                                               │
         │              │   ┌─────────────┐                             │
         │              │   │ Worker W1   │──▶ ...                     │
         │              │   └─────────────┘                             │
         │              │                                               │
         │              │   Inboxes en mémoire : Map<sid, Message[]>   │
         │              │   Workers ont cwd dans /workspace/...         │
         │              └───────────────────────────────────────────────┘
         │
         └─── Discord webhook ◀── Notifier (hook Notification → POST)
```

### Vue multi-instance (plusieurs projets)

```
Host (WSL2)
│
├── docker-compose.yml (au home, géré par l'utilisateur)
│
├── Container swarm-os-fyrel-cc-app
│   ├── port host:8787 → container:8787 (bindé 127.0.0.1)
│   ├── mount: ~/dev/fyrel-cc-app:/workspace
│   ├── mount: ~/.claude:/claude-source:ro    (source RO, copié au boot)
│   ├── mount: ~/.swarm-os/fyrel-cc-app:/data (RW)
│   └── env: SWARM_OS_PROJECT_NAME, SWARM_OS_TOKEN, SWARM_OS_DISCORD_WEBHOOK
│
├── Container swarm-os-grap-server
│   ├── port host:8797 → container:8787
│   └── ...
```

Chaque container est strictement isolé : sa propre DB, ses propres logs, son propre token, son propre webhook Discord. Le MCP HTTP (8788) reste interne au container et n'est jamais exposé sur le host. **Le port main est bindé sur `127.0.0.1` du host**, l'accès cross-device passe par Tailscale.

---

## 4. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Runtime serveur | Node.js 24 | Cohérent avec Fyrel |
| Package manager | pnpm | Plus rapide, strict, économise du disque |
| Framework HTTP | Express 5 | REST minimal |
| WebSocket | `ws` | Standard |
| PTY | `node-pty` | Lib Microsoft, base de VS Code |
| MCP serveur | `@modelcontextprotocol/sdk` officiel, transport Streamable HTTP | Évite réimplémenter le protocole, garantit la compatibilité |
| Persistance | SQLite + `better-sqlite3` | Single-file, single-instance par container |
| IDs | `crypto.randomUUID()` (UUID v4) | Built-in Node, pas de dépendance |
| Logs | `pino` (stdout JSON) | Standard, capturé par `docker logs` |
| Frontend | React 19 + Vite 6 | Aligné Fyrel, bundle statique servi par Express |
| Terminal UI | `xterm.js` + addons fit, web-links | Standard |
| Styling | Tailwind 4 | Familier |
| Notifications | Discord webhook (out) | Webhook simple, push fiable |
| Auth humain (HTTP) | Token statique en header `X-Auth-Token` | Single-user via Tailscale |
| Auth humain (WS) | Ticket à usage unique (TTL 10s) émis via `/ws-ticket` | Évite token dans URL/logs |
| Auth MCP | `orch_id` + `session_secret` (UUID v4) dans path | Bind 127.0.0.1, secret distinct du `session_id` (qui apparaît dans logs/UI) |
| Containerisation | Docker multi-stage + docker-compose | Image plus petite, "Safe YOLO" pour bypass perms |
| Base image | `node:24-bookworm-slim` | Stable, suffisant pour npm install claude-code |

---

## 5. Scope MVP

### In scope (v0.1)

- [ ] **Spawner** : créer, lister, détruire des orchestrateurs (scoped à une instance)
- [ ] **Orchestrator** : 1 lead + N workers, tous en `bypassPermissions`, modèle `claude-opus-4-7` par défaut, override per-orch et per-worker
- [ ] **MCP HTTP serveur** sur port 8788, bind 127.0.0.1 (intra-container only), via SDK officiel
- [ ] **MCP team-comms** : `whoami`, `list`, `send_message`, `read_inbox`, `broadcast`, `spawn_worker`, `kill_worker`, `kill_all_workers`
- [ ] **Mailbox en mémoire + signal PTY** : `send_message` push dans une queue bornée du destinataire + ping court dans son PTY si idle. Messages **non persistés**.
- [ ] **Préambule équipe paramétrable** : défaut versionné dans le code, override per-orchestrateur au create
- [ ] WebSocket terminal bidirectionnel, multi-attach (un seul writer, autres read-only)
- [ ] Vue UI : liste orchestrateurs + drill-down équipe + attache terminal + champ broadcast global
- [ ] Bouton "Stop orchestrator" : tue lead + tous les workers, propre (SIGTERM grace 5s puis SIGKILL)
- [ ] Détection "en attente d'humain" via hook `Notification` Claude Code (token interne `HOOK_TOKEN`)
- [ ] **Notifications Discord** via webhook : posts riches avec nom orchestrateur, session, message, lien direct UI
- [ ] Persistance SQLite (orchestrators, sessions, exit codes) dans `/data`
- [ ] Log brut par session : `/data/logs/{orch_id}/{session_id}.log`
- [ ] Auth token statique HTTP + ticket usage unique pour WS
- [ ] **Limites opérationnelles** configurables : max orch actifs, max workers/orch, max taille prompt, max taille message, timeout démarrage Claude
- [ ] **Containerisation** : Dockerfile multi-stage, image buildable, docker-compose example pour 1 et N projets
- [ ] **Multi-instance** : config par env vars + JSON optionnel, isolation totale par container
- [ ] **Tests** : unitaires + intégration via interface `AgentProcess` (fake claude pour test rapide)

### Out of scope (v0.1)

- ❌ **Bot Discord bidirectionnel** : webhook one-way uniquement. Bot bidirectionnel en v0.2.
- ❌ **Persistance des messages team-comms** : queue mémoire bornée. Les messages disparaissent au restart serveur (qui kill aussi les PTY de toute façon).
- ❌ **Reprise des processus PTY** après restart serveur : sessions actives sont marquées `interrupted`, l'historique reste consultable.
- ❌ **Petits-enfants** : un worker ne peut pas spawn ses propres sessions claude. Workers = feuilles.
- ❌ **Multi-utilisateur** au sein d'une instance
- ❌ **Templates de rôle** avec configs différenciées — rôle = label uniquement
- ❌ Replay visuel des sessions terminées (log brut suffit)
- ❌ Métriques de coût agrégées
- ❌ Édition de fichiers en ligne
- ❌ Egress filtering / firewall réseau (roadmap v0.2)
- ❌ Watchdog idle timeout / hard restart auto (kill manuel via UI)
- ❌ Coalescing/batching des notifs Discord (1 event = 1 post)
- ❌ Permissions différenciées par rôle (un worker peut appeler tous les outils que le lead peut, sauf `spawn_worker` / `kill_*` qui sont lead-only)

---

## 6. Phases d'implémentation

### Phase 0 — Bootstrap (½ jour)

- Monorepo `swarm-os` avec pnpm workspaces : `packages/server`, `packages/web`
- Configurer Vite + Express dev avec proxy WS
- ESLint/Prettier alignés Fyrel

### Phase 0 bis — Spike Claude Code (½ jour)

> Valider les hypothèses CLI **avant** d'écrire du code métier qui en dépend.

Livrable : `scripts/verify-claude-code.ts` qui vérifie dans un container minimal :

- `claude --version` et nom exact du modèle (`claude-opus-4-7` vs `opus-4-7`)
- `--permission-mode bypassPermissions` : flag accepté + comportement réel
- `--mcp-config <file>` : format JSON exact attendu, comportement si invalide
- Notion d'`effort` ou équivalent : flag réel supporté (`--max-thinking-tokens` ?), valeurs acceptées
- Hook `Notification` : déclencheur, payload, mécanisme de transport (`CLAUDE_CONFIG_DIR` + `settings.json` ?)
- `~/.claude` : ce que Claude écrit/lit, ce qui doit être RW vs RO
- `CLAUDE_CONFIG_DIR` : permet bien de pointer vers un répertoire alternatif par session

**Si une hypothèse est fausse, le plan doit être corrigé avant Phase 1.**

### Phase 1 — Spawner + lead solo (1 jour)

- Module `Spawner` : map d'orchestrateurs, create/get/destroy
- Module `Orchestrator` v0 : spawn une session lead via `node-pty`, gère son cycle de vie
- Interface `AgentProcess` (abstraction au-dessus de `node-pty`) pour permettre un fake en tests
- Endpoint `POST /orchestrators` et `DELETE /orchestrators/:id` (idempotent)
- Validation `cwd` via `realpath()` : doit résoudre sous `/workspace` après symlink resolution
- WebSocket `/ws/sessions/:id` pour attacher xterm.js (multi-attach, un seul writer)
- Endpoint `GET /ws-ticket?session=:id` qui émet un ticket à usage unique (TTL 10s)
- Page web : bouton "Nouvel orchestrateur", form (name, role, cwd, prompt), terminal qui apparaît
- Validation : lance, on tape, claude répond. Pas encore de MCP, pas encore de container.

### Phase 2 — MCP HTTP serveur via SDK officiel (1 jour) [x]

- Module `McpServer` qui écoute sur 127.0.0.1:8788 via `@modelcontextprotocol/sdk`
- Routing par path : `POST /mcp/:orch_id/:session_secret` (Streamable HTTP transport)
- `session_secret` (UUID v4) généré à la création de la session, distinct du `session_id`
- Handler dispatche au bon orchestrateur via `Spawner.getOrchestrator(orch_id)` après vérification du secret
- Implémenter `tools/list` retournant la liste fixe des outils `team.*`
- Implémenter `tools/call` avec les outils simples d'abord : `whoami`, `list`
- Au spawn d'une session, générer un `mcp.json` temporaire (mode `0600`) dans `/tmp/swarm-os/orch-{id}/session-{id}/` et passer `--mcp-config` à claude
- Validation : depuis le lead, appel `team.whoami` retourne le bon nom/rôle

### Phase 3 — Workers, mailbox et team-comms (1,5 jour)

- Implémenter `team.spawn_worker({ name, role, prompt, cwd?, model?, permissionMode? })` : spawn un nouveau PTY claude, génère son mcp.json, l'enregistre
- **Mailbox en mémoire** : `Map<sessionId, Message[]>` au niveau de l'orchestrateur, queue bornée (défaut 100 messages, drop le plus vieux + warning sender si plein)
- Implémenter `team.send_message({ to, content })` :
  1. Push `{ id, from, to, content, ts }` dans la queue de `to`
  2. Si la session destinataire est idle (pas d'output PTY depuis ≥2s), injecter un signal court dans son PTY : `\n[swarm-os] new message in inbox\n`
  3. Logger une ligne `pino` : `{ from, to, len }` (pas le body)
- Implémenter `team.read_inbox()` : retourne la queue du caller et la vide
- Implémenter `team.broadcast({ content })` : push dans toutes les queues sauf soi
- Implémenter `team.kill_worker({ id })` et `team.kill_all_workers()` (lead-only). SIGTERM, attente 5s, SIGKILL.
- **Worker exit anormal** → message auto au lead avec `{ exit_code, last_20_lines }`
- **Préambule paramétrable** : un défaut versionné dans `packages/server/src/modules/preambles/`, override possible via `lead.preamble` au create de l'orchestrateur. Le préambule **insiste explicitement** sur l'appel à `team.read_inbox()` après chaque tâche.
- Vue UI : drill-down sur un orchestrateur affiche la liste des sessions, clic attache xterm.js
- Validation : un lead appelle `spawn_worker`, le worker apparaît, le lead lui envoie un message, le worker appelle `read_inbox`, lit, répond

### Phase 4 — Notifs Discord + persistance (1 jour)

- Module `Notifier` avec interface `notify({ kind, orchestrator, session, message })` et impl Discord webhook
- Hook `Notification` global Claude Code → POST `/hooks/notification` avec `{ orch_id, session_id, message }` + header `Authorization: Bearer <HOOK_TOKEN>` (token interne généré au boot, partagé via `CLAUDE_CONFIG_DIR`)
- Le notifier construit un embed Discord riche : title (orch name), description (message), fields (session, role), URL (deep-link UI **sans token**)
- SQLite : tables `orchestrators`, `sessions` ; au boot, marque toute session non terminale comme `interrupted`
- Indexes : `sessions(orchestrator_id)`, `sessions(status)`, `orchestrators(status)`
- Persiste `lastError`, `stopReason`, `logPath` sur `Session`
- Logs sessions : append-only par session, cap à 50 MB par fichier (truncate à l'ouverture si dépassement)
- Endpoint `GET /sessions/:id/log`

### Phase 5 — Containerisation (1 jour)

- `Dockerfile` **multi-stage** :
  - Stage `builder` : build serveur + frontend
  - Stage `runtime` : `node:24-bookworm-slim` + claude CLI version pinnée + artefacts du builder
- Au runtime, **copie au boot** de `/claude-source` (mount RO) vers `/data/.claude-runtime/` (volume RW privé). Évite la corruption du `~/.claude` host par plusieurs containers concurrents.
- Chaque session reçoit `CLAUDE_CONFIG_DIR=/data/.claude-runtime/sessions/{session_id}/` (copie minimale du runtime + `settings.json` injectant le hook Notification avec `HOOK_TOKEN`)
- Mounts attendus : `/workspace` (projet RW), `/claude-source` (creds source RO), `/data` (state RW)
- `docker-compose.yml` example : `init: true`, healthcheck sur `/health`, ports bindés sur `127.0.0.1` uniquement
- Documentation `docs/deployment.md`

### Phase 6 — Polish (½ jour)

- Auth token init au premier boot (généré, écrit dans `/data/token`)
- PWA manifest + service worker minimal pour install mobile
- README agent-readable

### Phase 7 — Tests (1 jour)

- **Fake `AgentProcess`** : implémente l'interface sans lancer claude (scripts d'output déterministes)
- **Unitaires** : validation config, validation `cwd` (realpath + traversal), permissions lead-only, format messages, mailbox bornée
- **Intégration** : spawner + fake AgentProcess + lifecycle complet (spawn lead → spawn worker → send_message → read_inbox → kill_all)
- **MCP** : appels `tools/list` et `tools/call` contre le serveur réel via SDK client
- **WebSocket** : attach terminal, input, output, ticket invalide refusé, multi-attach un seul writer
- **Smoke test Docker** : `claude --version`, `/health`, création orchestrateur avec fake agent

**Effort total estimé : 8 jours** de dev concentré.

---

## 7. Structure du projet

```
swarm-os/
├── plan.md
├── README.md
├── package.json                     # workspaces root (pnpm)
├── pnpm-workspace.yaml
├── Dockerfile                       # multi-stage
├── scripts/
│   └── verify-claude-code.ts        # spike Phase 0 bis
├── examples/
│   ├── docker-compose.single.yml
│   └── docker-compose.multi.yml
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts             # entrée
│   │   │   ├── config.ts            # parse env + /data/config.json optionnel + limites
│   │   │   ├── runtime/
│   │   │   │   └── claude-init.ts   # copie .claude-source → .claude-runtime au boot
│   │   │   ├── modules/
│   │   │   │   ├── spawner/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── types.ts
│   │   │   │   ├── orchestrator/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── session.ts
│   │   │   │   │   ├── agent-process.ts  # interface + impl node-pty
│   │   │   │   │   ├── mailbox.ts        # Map<sid, Message[]> bornée
│   │   │   │   │   ├── messaging.ts      # send_message/broadcast + signal PTY
│   │   │   │   │   ├── mcp-config.ts
│   │   │   │   │   └── preamble.ts
│   │   │   │   ├── mcp/
│   │   │   │   │   ├── server.ts          # SDK officiel
│   │   │   │   │   └── tools.ts
│   │   │   │   ├── db/
│   │   │   │   │   ├── schema.sql
│   │   │   │   │   └── index.ts
│   │   │   │   ├── notify/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── discord.ts
│   │   │   │   └── preambles/
│   │   │   │       ├── default-lead.md
│   │   │   │       └── default-worker.md
│   │   │   ├── http/
│   │   │   │   ├── main.ts
│   │   │   │   ├── routes/
│   │   │   │   │   ├── orchestrators.ts
│   │   │   │   │   ├── sessions.ts
│   │   │   │   │   ├── ws-ticket.ts
│   │   │   │   │   └── hooks.ts
│   │   │   │   ├── ws/
│   │   │   │   │   ├── terminal.ts        # multi-attach, un writer
│   │   │   │   │   └── events.ts
│   │   │   │   └── auth.ts                # token + ticket
│   │   │   └── ...
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── OrchestratorList.tsx
│       │   │   ├── OrchestratorView.tsx
│       │   │   ├── SessionList.tsx
│       │   │   ├── Terminal.tsx
│       │   │   ├── BroadcastBar.tsx       # quick-reply textarea
│       │   │   ├── NewOrchestratorDialog.tsx
│       │   │   ├── PreambleEditor.tsx
│       │   │   └── StatusBadge.tsx
│       │   ├── hooks/
│       │   │   ├── useOrchestrators.ts
│       │   │   ├── useSession.ts
│       │   │   └── useEvents.ts
│       │   ├── api/
│       │   │   └── client.ts
│       │   └── pwa/
│       │       ├── manifest.json
│       │       └── sw.ts
│       └── package.json
└── docs/
    ├── hooks-setup.md
    ├── mcp-protocol.md
    ├── deployment.md
    └── multi-project.md
```

---

## 8. Modèle de données

```typescript
interface Orchestrator {
  id: string;                    // UUID v4
  name: string;
  role: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  leadSessionId: string;
  defaultModel: string;          // ex: "claude-opus-4-7"
  defaultPermissionMode: 'auto' | 'bypassPermissions';
  leadPreamble: string;
  workerPreamble: string;
  createdAt: string;
  endedAt: string | null;
  lastError: string | null;
}

interface Session {
  id: string;                    // UUID v4 (apparaît dans logs/UI)
  sessionSecret: string;         // UUID v4 (utilisé pour auth MCP, jamais loggé)
  orchestratorId: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
  cwd: string;                   // absolu, sous /workspace après realpath
  initialPrompt: string | null;
  model: string;
  permissionMode: 'auto' | 'bypassPermissions';
  status: 'starting' | 'running' | 'waiting' | 'exited' | 'killed' | 'interrupted' | 'failed';
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  stopReason: string | null;     // 'user' | 'lead-stopped' | 'crash' | 'timeout' | ...
  logPath: string;               // chemin du log brut
  lastActivityAt: string;
}
```

**Tables SQLite** : `orchestrators`, `sessions`. **Pas de table `Message`** — la mailbox vit en mémoire uniquement.

**Indexes** :
- `sessions(orchestrator_id)`
- `sessions(status)`
- `orchestrators(status)`

**Invariants** :
- Un orchestrateur a toujours exactement un lead.
- Tous les `cwd` doivent être sous `/workspace` après `realpath()` (validé au create).
- Si le lead exit, l'orchestrateur passe `stopping` et tue les workers (SIGTERM, grace 5s, SIGKILL).
- Si un worker exit, l'orchestrateur continue, le lead reçoit un message auto avec exit code + last 20 lines.
- Au boot, toute session non terminale est marquée `interrupted`.

---

## 9. API surface

### REST (sur :8787, auth token humain)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/orchestrators` | Créer. Body : `{ name, role, lead: { cwd, prompt, preamble? }, workerPreamble?, defaults?: { model, permissionMode } }`. Defaults si absent : `claude-opus-4-7` / `bypassPermissions`. |
| `GET` | `/orchestrators` | Lister actifs uniquement (avec sessions associées) |
| `GET` | `/orchestrators/:id` | Détails complets |
| `DELETE` | `/orchestrators/:id` | Stop : tue lead + workers. **Idempotent** (204 si déjà stoppé). |
| `GET` | `/orchestrators/:id/sessions` | Lister les sessions |
| `POST` | `/orchestrators/:id/broadcast` | Body `{ content }` — envoie un message humain à toute l'équipe via la mailbox |
| `GET` | `/sessions/:id` | Détails |
| `GET` | `/sessions/:id/log` | Télécharger le log brut |
| `POST` | `/sessions/:id/input` | Body `{ data }` — push texte humain dans le PTY de la session |
| `POST` | `/hooks/notification` | Endpoint pour hooks Claude Code, auth `Authorization: Bearer <HOOK_TOKEN>` |
| `GET` | `/ws-ticket?session=:id` | Émet un ticket à usage unique (TTL 10s) pour ouverture WS |
| `GET` | `/info` | `{ project_name, version, started_at }` |
| `GET` | `/health` | Healthcheck |

### WebSocket (sur :8787, auth ticket dans query)

- `/ws/sessions/:id?ticket=...` — terminal bidirectionnel, multi-attach (un seul writer, autres read-only)
- `/ws/events?ticket=...` — flux d'events globaux (orch créé, session spawned/exited/etc.)

### MCP HTTP (sur :8788, bind 127.0.0.1, intra-container only)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/mcp/:orch_id/:session_secret` | Endpoint MCP Streamable HTTP via SDK officiel |

Le `session_secret` (UUID v4) n'apparaît jamais dans les logs ni l'UI. L'auth est dans le path + bind localhost.

---

## 10. MCP team-comms — outils exposés

| Outil | Visibilité | Paramètres | Retour |
|---|---|---|---|
| `team.whoami` | tous | `{}` | `{ session_id, name, role, type, is_lead }` |
| `team.list` | tous | `{}` | `{ members: [...] }` (sessions actives uniquement) |
| `team.send_message` | tous | `{ to, content }` | `{ delivered: boolean, queue_size: number }` |
| `team.read_inbox` | tous | `{}` | `{ messages: [{ id, from, content, ts }, ...] }` (vide la queue) |
| `team.broadcast` | tous | `{ content }` | `{ delivered_to: [...] }` |
| `team.spawn_worker` | **lead only** | `{ name, role, prompt, cwd?, model?, permissionMode? }` | `{ session: { id, name, ... } }` |
| `team.kill_worker` | **lead only** | `{ id }` | `{ killed: boolean }` |
| `team.kill_all_workers` | **lead only** | `{}` | `{ killed: [...] }` |

`is_lead` retourné par `whoami` (pas de tool dédié `am_i_lead`).

---

## 11. Communication inter-sessions

**Modèle hybride : mailbox en mémoire bornée + signal PTY passif.**

### Mailbox

```typescript
// Au niveau de l'Orchestrator
const inboxes = new Map<sessionId, Message[]>();
const MAX_INBOX_SIZE = 100;

interface Message {
  id: string;          // UUID v4
  from: string;        // session_id sender
  content: string;
  ts: string;          // ISO
}
```

### Flux `send_message`

1. Sender appelle `team.send_message({ to, content })`
2. Server push `{ id, from, to, content, ts }` dans `inboxes.get(to)`
3. Si la queue dépasse `MAX_INBOX_SIZE`, drop le plus vieux et retourne `{ delivered: true, queue_size: 100 }` (sender peut détecter)
4. Si la session destinataire est **idle** (pas d'output PTY depuis ≥2s), injecter un signal court dans son PTY :
   ```
   \n[swarm-os] new message in inbox — call team.read_inbox to fetch\n
   ```
5. Sinon, ne rien injecter (le worker lira sa boîte à son prochain cycle)
6. Logger une ligne `pino` : `{ event: 'mail.send', from, to, len: content.length }` (pas le body)

### Flux `read_inbox`

- Caller appelle `team.read_inbox()`
- Server retourne la queue complète et la vide
- Logger une ligne `pino` : `{ event: 'mail.read', sid, count }`

### Survie au restart

Aucune. Si le serveur swarm-os redémarre, les PTY sont killés de toute façon et les messages en queue sont perdus avec eux. C'est volontaire — pas de code de persistance/purge à maintenir.

### Préambule équipe

À la création de l'orchestrateur, l'utilisateur peut fournir `lead.preamble` et `workerPreamble`. Sinon, le défaut versionné dans `packages/server/src/modules/preambles/` est utilisé. Le préambule est concaténé au prompt initial.

Le défaut **insiste fortement** sur la discipline mailbox :

> Tu fais partie d'une équipe d'agents. Pour communiquer, utilise les outils MCP `team.*`.
> **Après chaque tâche significative, appelle `team.read_inbox()` pour récupérer les messages en attente.**
> Quand tu reçois le signal `[swarm-os] new message in inbox`, lis ta mailbox immédiatement avant de continuer.
> Ne réponds jamais à un signal en l'écrivant dans ton terminal — passe par `team.send_message`.

Variantes lead/worker pour rappeler les outils disponibles (le worker n'a pas `spawn_worker`/`kill_*`).

---

## 12. Notifications Discord

Module `Notifier` avec une seule impl en MVP : webhook Discord unidirectionnel.

**Configuration** : env var `SWARM_OS_DISCORD_WEBHOOK_URL` au boot, optionnelle. Si absent, le notifier no-op (logs seulement).

**Events qui notifient** :
- Session passe en `waiting` (hook `Notification`)
- Orchestrateur exit (lead terminé) avec son statut
- Session exit anormale (exit code ≠ 0)

Pas de coalescing en MVP : un event = un POST. Si le rate-limit Discord devient un problème, ajouter le batching en post-MVP.

**Format d'embed Discord** :
```json
{
  "embeds": [{
    "title": "🟡 Session en attente d'attention",
    "description": "<message du hook Claude>",
    "color": 16776960,
    "fields": [
      { "name": "Project", "value": "fyrel-cc-app", "inline": true },
      { "name": "Orchestrator", "value": "merge-team", "inline": true },
      { "name": "Session", "value": "coordinator (lead)", "inline": true }
    ],
    "url": "https://swarm.tail-xyz.ts.net:8787/orchestrators/{id}",
    "timestamp": "2026-05-14T..."
  }]
}
```

L'URL embed pointe vers la session via deep-link **sans token** (l'utilisateur s'authentifie au navigateur).

**Roadmap v0.2** : bot Discord bidirectionnel.

---

## 13. Containerisation & déploiement multi-instance

### Dockerfile multi-stage (esquisse)

```dockerfile
# ---- Builder ----
FROM node:24-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# ---- Runtime ----
FROM node:24-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (version pinnée — à valider au spike)
RUN npm install -g @anthropic-ai/claude-code@<pinned>

USER node
WORKDIR /home/node/app

COPY --from=builder --chown=node:node /build/packages/server/dist ./server
COPY --from=builder --chown=node:node /build/packages/server/node_modules ./server/node_modules
COPY --from=builder --chown=node:node /build/packages/web/dist ./web

VOLUME ["/workspace", "/claude-source", "/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('http').get('http://127.0.0.1:8787/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server/index.js"]
```

### Initialisation runtime claude (au boot serveur)

Avant de démarrer le HTTP server, le module `runtime/claude-init.ts` :

1. Crée `/data/.claude-runtime/` si absent
2. Copie le contenu de `/claude-source/` (mount RO) vers `/data/.claude-runtime/`
3. Cette copie est privée au container et RW : Claude peut écrire son cache sans corrompre le `~/.claude` host
4. Plusieurs containers peuvent ainsi partager les mêmes credentials source sans se marcher dessus

Pour chaque session spawned, un sous-répertoire `CLAUDE_CONFIG_DIR=/data/.claude-runtime/sessions/{session_id}/` est dérivé du runtime, avec un `settings.json` injectant le hook Notification (URL `http://127.0.0.1:8787/hooks/notification` + header `Authorization: Bearer <HOOK_TOKEN>`).

### docker-compose pour un projet

```yaml
services:
  swarm-fyrel-cc-app:
    image: swarm-os:latest
    container_name: swarm-fyrel-cc-app
    init: true
    ports:
      - "127.0.0.1:8787:8787"   # localhost only, exposé via Tailscale
    volumes:
      - ~/dev/fyrel-cc-app:/workspace
      - ~/.claude:/claude-source:ro
      - ~/.swarm-os/fyrel-cc-app:/data
    environment:
      SWARM_OS_PROJECT_NAME: fyrel-cc-app
      SWARM_OS_DISCORD_WEBHOOK_URL: ${FYREL_DISCORD_WEBHOOK}
      SWARM_OS_PUBLIC_URL: https://swarm.tail-xyz.ts.net:8787
    restart: unless-stopped
```

### docker-compose pour plusieurs projets

```yaml
services:
  swarm-fyrel:
    image: swarm-os:latest
    init: true
    ports: ["127.0.0.1:8787:8787"]
    volumes:
      - ~/dev/fyrel-cc-app:/workspace
      - ~/.claude:/claude-source:ro
      - ~/.swarm-os/fyrel:/data
    environment:
      SWARM_OS_PROJECT_NAME: fyrel-cc-app
      SWARM_OS_DISCORD_WEBHOOK_URL: ${FYREL_DISCORD_WEBHOOK}

  swarm-grap:
    image: swarm-os:latest
    init: true
    ports: ["127.0.0.1:8797:8787"]
    volumes:
      - ~/dev/grap-server:/workspace
      - ~/.claude:/claude-source:ro
      - ~/.swarm-os/grap:/data
    environment:
      SWARM_OS_PROJECT_NAME: grap-server
      SWARM_OS_DISCORD_WEBHOOK_URL: ${GRAP_DISCORD_WEBHOOK}
```

### Variables d'environnement supportées

| Var | Obligatoire | Défaut | Description |
|---|---|---|---|
| `SWARM_OS_PROJECT_NAME` | oui | — | Nom affiché dans l'UI et les notifs |
| `SWARM_OS_DISCORD_WEBHOOK_URL` | non | — | Si absent, notifs no-op |
| `SWARM_OS_PUBLIC_URL` | non | — | Pour les deep-links Discord |
| `SWARM_OS_PORT` | non | `8787` | Port main |
| `SWARM_OS_MCP_PORT` | non | `8788` | Port MCP intra-container |
| `SWARM_OS_TOKEN` | non | généré | Si absent, généré au premier boot dans `/data/token` |
| `SWARM_OS_DEFAULT_MODEL` | non | `claude-opus-4-7` | À valider au spike |
| `SWARM_OS_DEFAULT_PERMISSION_MODE` | non | `bypassPermissions` | |
| `SWARM_OS_MAX_ORCHESTRATORS` | non | `10` | Plafond actifs |
| `SWARM_OS_MAX_WORKERS_PER_ORCH` | non | `20` | |
| `SWARM_OS_MAX_PROMPT_SIZE_KB` | non | `64` | |
| `SWARM_OS_MAX_MESSAGE_SIZE_KB` | non | `16` | Pour `team.send_message` |
| `SWARM_OS_MAX_INBOX_SIZE` | non | `100` | Messages max par mailbox |
| `SWARM_OS_CLAUDE_START_TIMEOUT_S` | non | `30` | Timeout démarrage Claude |
| `HOOK_TOKEN` | non | généré | Token interne pour `/hooks/notification` |

---

## 14. Sécurité & accès

- **`bypassPermissions` par défaut** : aucune approbation utilisateur. Les actions de l'agent ne sont pas filtrées par le mécanisme de permissions Claude Code. L'isolation vient exclusivement du container.
- **Isolation principale = container** : les agents ne voient que `/workspace`, `/data`, `/tmp`, `/data/.claude-runtime`. Pas d'accès au home host, pas d'accès aux autres projets.
- **Mounts strictement scopés** : un container par projet, un seul `/workspace` qui pointe vers le bon dossier. Jamais mount le home complet.
- **Validation `cwd` via `realpath()`** au create : la cible résolue (après symlinks) doit être sous `/workspace`. Refuse sinon.
- **`/claude-source` monté en RO**, copié au boot vers `/data/.claude-runtime/` (RW privé container). Évite que plusieurs containers concurrents corrompent le `~/.claude` host.
- **Container en user non-root** (`USER node`).
- **Port main bindé sur `127.0.0.1`** du host (`"127.0.0.1:8787:8787"`), accès cross-device via Tailscale uniquement. **Jamais exposé internet public.**
- **MCP HTTP strictement intra-container**, jamais mappé sur le host.
- **Auth humaine** : token statique en header `X-Auth-Token` pour HTTP. Pour WS, ticket à usage unique (TTL 10s) émis par `GET /ws-ticket`. Token jamais dans les URLs ni les logs.
- **Auth MCP** : `session_secret` (UUID v4) dans le path, distinct du `session_id` (lui peut apparaître dans logs/UI). Bind localhost intra-container.
- **Fichiers `mcp.json` temporaires** dans `/tmp/swarm-os/...`, mode `0600`.
- **Hook Notification** : `HOOK_TOKEN` interne en `Authorization: Bearer`, vérifié par l'endpoint.

### Limites connues du modèle de sécurité

- Un agent qui sort de son rôle peut faire des dégâts dans `/workspace` (borné au projet).
- Pas de pare-feu egress en MVP : un agent peut faire des appels réseau sortants (Discord, npm install, fetch). Roadmap v0.2.
- Les credentials sources sont copiées dans `/data/.claude-runtime` — lisibles par tous les processus du container. Si un agent décide de les exfiltrer, il peut.
- **Impersonation MCP intra-container** : tout processus dans le container qui devine `orch_id + session_secret` peut appeler `team.*` au nom d'une session. Mitigé par le caractère imprévisible des UUIDs v4 et le bind localhost.
- Reprise PTY après restart serveur impossible : sessions actives marquées `interrupted`, à relancer manuellement.

---

## 15. Observabilité

- **Logs serveur** : `pino` JSON sur stdout, capturé par `docker logs`.
- **Logs sessions** : append-only dans `/data/logs/{orch_id}/{session_id}.log`. Capture le PTY output complet + les signaux mailbox injectés.
- **Cap fichier log** : 50 MB par session, truncate à l'ouverture si dépassement (pas de rotation rolling, suffisant pour MVP).
- **Logs MCP** : pino structured (`{ event: 'mcp.call', tool, sid, ok }`) sur stdout serveur. Pas de body request/response loggé par défaut.
- **Logs mailbox** : pino (`{ event: 'mail.send'/'mail.read', from, to, len/count }`) sans body.
- **Healthcheck `/health`** : `{ status, project_name, orchestrators_active, sessions_active, sessions_waiting, uptime_seconds }`.

---

## 16. Roadmap post-MVP

- **Bot Discord bidirectionnel** : envoyer des commandes depuis Discord (kill, send_message, attach via lien).
- **Permissions par rôle** : config quels outils MCP un rôle peut appeler.
- **Templates d'orchestrateur** : presets versionnés (`merge-team`, `qa-team`, etc.).
- **Petits-enfants** : permettre à un worker de devenir lead de sous-équipe.
- **Mailbox persistée optionnelle** : si un cas d'usage émerge où l'audit du contenu est nécessaire (avec stratégie de purge).
- **Watchdog idle timeout** : kill auto des sessions silencieuses depuis X minutes.
- **Coalescing notifs Discord** : batching/debounce si rate-limit devient un problème.
- **Vue split-screen** : afficher lead + worker côte à côte.
- **Indicateur de coût** : parser les logs Claude pour estimation tokens.
- **Intégration JIRA FYRA** : créer un orchestrateur depuis un ticket.
- **Replay temporel** : asciinema-style replay.
- **Worker types autres que claude** : aider, scripts custom implémentant le protocole.
- **Firewall egress** : limiter les domaines accessibles depuis le container.
- **Multi-tenant** dans une instance.

---

## 17. Décisions tranchées

- [x] **Nom** : `swarm-os`
- [x] **Mode de permission par défaut** : `bypassPermissions` (autonomie max, isolation par container)
- [x] **Modèle par défaut** : `claude-opus-4-7` (à confirmer au spike Phase 0 bis). Notion d'`effort` reportée tant que la CLI ne l'a pas confirmée.
- [x] **Préambule paramétrable** dès la v0.1, défaut versionné dans le repo.
- [x] **Communication** : mailbox **en mémoire bornée** + signal PTY passif. Pas de persistance des messages (les PTY ne survivent pas au restart de toute façon).
- [x] **MCP** : SDK officiel `@modelcontextprotocol/sdk`, pas d'implémentation custom.
- [x] **Auth MCP** : `session_secret` UUID v4 distinct du `session_id`.
- [x] **Auth WS** : ticket à usage unique (TTL 10s), pas de token en query.
- [x] **Multi-attach WS** : un seul writer, autres read-only.
- [x] **IDs** : `crypto.randomUUID()`, pas de dépendance UUID.
- [x] **Package manager** : pnpm workspaces.
- [x] **Frontend** : bundle Vite servi par Express (pas de CDN runtime).
- [x] **Notifications** : Discord webhook (out-only en MVP, 1 event = 1 post).
- [x] **Ports** : 8787 main (bindé `127.0.0.1` côté host), 8788 MCP (intra-container).
- [x] **Multi-instance** : un container par projet, déploiement docker-compose, `init: true`.
- [x] **Containerisation** : Docker multi-stage obligatoire, image basée sur `node:24-bookworm-slim` avec claude CLI installé. `~/.claude` source RO, copié au boot vers volume RW privé.
- [x] **Validation cwd** : `realpath()` obligatoire, doit résoudre sous `/workspace`.
- [x] **Tests** : interface `AgentProcess` + fake claude pour tests rapides.

---

## Notes pour les agents Claude Code travaillant sur ce projet

- Ce projet est **single-user, multi-projet**. Chaque instance swarm-os = un container = un projet. Pas d'over-engineering multi-tenant à l'intérieur d'une instance.
- Toutes les sessions tournent en `bypassPermissions` — l'isolation vient du container, pas du runtime. Toute modif qui contourne l'isolation container est un bug de sécurité critique.
- Le serveur MCP HTTP doit rester **strictement bind 127.0.0.1 dans le container**, jamais exposé en port mapping Docker. Toute modif qui change ça est un bug de sécurité critique.
- Le port main doit rester **bindé sur `127.0.0.1` côté host**. L'accès cross-device passe par Tailscale.
- **`session_secret` ne doit jamais être loggé**. Utiliser `session_id` pour les logs et l'UI.
- La **mailbox vit en mémoire**. Ne pas ajouter de persistance sans nécessité forte (audit, replay) — sinon ça grossit la DB sans bénéfice (les PTY ne survivent pas au restart).
- Le **préambule par défaut** versionné dans `packages/server/src/modules/preambles/` est la source de vérité. Si tu le modifies, justifie pourquoi dans le commit message — c'est lui qui garantit que les workers appellent `team.read_inbox()` régulièrement.
- Workers = feuilles. Pas de spawn récursif en v0.1. Si un worker tente d'appeler `team.spawn_worker`, ça retourne `PERMISSION_DENIED`.
- Avant de figer des flags CLI Claude (`--mcp-config`, modèle, hooks, effort), valide via le script `scripts/verify-claude-code.ts`.
- La doc agent-readable doit rester en plain Markdown, lisible avec `cat`/`grep`. Pas de mermaid, pas de HTML embed.
- Quand tu modifies ce plan, mets à jour la section "Phases" pour marquer les phases complétées avec `[x]`.
