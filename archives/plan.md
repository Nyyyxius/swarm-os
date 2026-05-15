# swarm-os — Plan MVP

> Plateforme web pour orchestrer des équipes de sessions Claude Code en mode autonome. Chaque instance pilote un projet, containerisée, multi-déployable. Un orchestrateur = une équipe (1 lead + N workers) communiquant via un MCP HTTP. Supervision et arrêt depuis n'importe quel navigateur, notifications Discord, interventions humaines à tout moment.

**Project name** : `swarm-os`
**Status** : Plan — non implémenté
**Cible** : single-user, multi-projet, déployable en Docker sur stack WSL2 + Tailscale, accessible depuis mobile

---

## 1. Vision

Un serveur Node.js qui héberge un **Spawner** unique. Le Spawner crée et gère plusieurs **Orchestrateurs**. Chaque orchestrateur est une équipe d'agents Claude avec exactement un **lead** et zéro ou plusieurs **workers**. Les membres d'une équipe communiquent via un MCP `team-comms` fourni par l'orchestrateur. Toutes les sessions tournent en `--permission-mode bypassPermissions` pour permettre une autonomie maximale, l'isolation étant fournie par le container.

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
│  • React + Vite (CDN)  │         │  • Main HTTP (:8787) — exposé        │
│  • xterm.js            │         │    REST + WS (auth: token humain)    │
│  • Liste orch + sess   │         │  • MCP HTTP (:8788) — interne only   │
│  • Discord links       │         │    auth: UUID dans path              │
└────────────────────────┘         │  • Module Spawner                    │
         ▲                         │  • Module Orchestrators (×N)         │
         │ Tailscale → host:NNNN   │  • Module Notifier (Discord webhook) │
         │                         │  • SQLite dans /data                 │
         │                         │  • claude CLI installé               │
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
         │              │   │             │     mcp/X/sessions/L       │
         │              │   └─────────────┘                             │
         │              │                                               │
         │              │   ┌─────────────┐                             │
         │              │   │ Worker W1   │──▶ ...                     │
         │              │   └─────────────┘                             │
         │              │                                               │
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
│   ├── port host:8787 → container:8787
│   ├── mount: ~/dev/fyrel-cc-app:/workspace
│   ├── mount: ~/.claude:/home/node/.claude:ro
│   ├── mount: ~/.swarm-os/fyrel-cc-app:/data
│   └── env: SWARM_OS_PROJECT_NAME, SWARM_OS_TOKEN, SWARM_OS_DISCORD_WEBHOOK
│
├── Container swarm-os-grap-server
│   ├── port host:8797 → container:8787
│   ├── mount: ~/dev/grap-server:/workspace
│   └── ... (mêmes mounts mais data distinct)
│
└── ... (autres projets)
```

Chaque container est strictement isolé : sa propre DB, ses propres logs, son propre token, son propre webhook Discord. Le MCP HTTP (8788) reste interne au container et n'est jamais exposé sur le host.

---

## 4. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Runtime serveur | Node.js 24 | Cohérent avec Fyrel |
| Package manager | pnpm | Plus rapide, strict, économise du disque |
| Framework HTTP | Express 5 | REST minimal |
| WebSocket | `ws` | Standard |
| PTY | `node-pty` | Lib Microsoft, base de VS Code |
| MCP serveur | Code custom léger, transport Streamable HTTP | Spec MCP simple, route par path |
| Persistance | SQLite + `better-sqlite3` | Single-file, single-instance par container |
| Frontend | React 19 + Vite 6 | Aligné Fyrel |
| Terminal UI | `xterm.js` + addons fit, web-links | Standard |
| Styling | Tailwind 4 | Familier |
| Notifications | Discord webhook (out) | Webhook simple, push fiable, riche en formatting |
| Auth humain | Token statique en header `X-Auth-Token` | Single-user via Tailscale |
| Auth MCP | UUID orch_id + session_id dans path | Bind 127.0.0.1 only, secrets non-devinables |
| Containerisation | Docker + docker-compose | Multi-instance, isolation, "Safe YOLO" pour bypass perms |
| Base image | `node:24-bookworm-slim` | Stable, suffisant pour npm install claude-code |

---

## 5. Scope MVP

### In scope (v0.1)

- [ ] **Spawner** : créer, lister, détruire des orchestrateurs (scoped à une instance)
- [ ] **Orchestrator** : 1 lead + N workers, tous en `bypassPermissions`, modèle Opus 4.7 + effort xhigh par défaut, override per-orch et per-worker
- [ ] **MCP HTTP serveur** sur port 8788, bind 127.0.0.1 (intra-container only)
- [ ] **MCP team-comms** : `whoami`, `am_i_lead`, `list`, `send_message`, `broadcast`, `spawn_worker`, `kill_worker`, `kill_all_workers`
- [ ] **Routage de messages inter-sessions** par écriture dans PTY stdin du destinataire avec préambule clair
- [ ] **Préambule équipe paramétrable** : défaut versionné dans le code, override per-orchestrateur au create
- [ ] WebSocket terminal bidirectionnel pour attacher xterm.js à n'importe quelle session
- [ ] Vue UI : liste orchestrateurs + drill-down équipe + attache terminal
- [ ] Bouton "Stop orchestrator" : tue lead + tous les workers, propre
- [ ] Détection "en attente d'humain" via hook `Notification` Claude Code
- [ ] **Notifications Discord** via webhook : posts riches avec nom orchestrateur, session, message, lien direct UI
- [ ] Persistance SQLite (orchestrators, sessions, exit codes) dans `/data`
- [ ] Log brut par session : `/data/logs/{orch_id}/{session_id}.log`
- [ ] Auth token statique
- [ ] **Containerisation** : Dockerfile, image buildable, docker-compose example pour 1 et N projets
- [ ] **Multi-instance** : config par env vars + JSON optionnel, isolation totale par container

### Out of scope (v0.1)

- ❌ **Bot Discord bidirectionnel** : pour MVP, webhook one-way. Le bot qui permet d'envoyer des commandes depuis Discord vers swarm-os arrive en v0.2.
- ❌ **Petits-enfants** : un worker ne peut pas spawn ses propres sessions claude. Workers = feuilles.
- ❌ **Multi-utilisateur** au sein d'une instance
- ❌ **Templates de rôle** avec configs différenciées — rôle = label uniquement
- ❌ Replay visuel des sessions terminées (log brut suffit)
- ❌ Métriques de coût agrégées
- ❌ Édition de fichiers en ligne
- ❌ Permissions différenciées par rôle (un worker peut appeler tous les outils que le lead peut, sauf `spawn_worker` / `kill_*` qui sont lead-only)

---

## 6. Phases d'implémentation

### Phase 0 — Bootstrap (½ jour)

- Monorepo `swarm-os` avec pnpm workspaces : `packages/server`, `packages/web`
- Configurer Vite + Express dev avec proxy WS
- ESLint/Prettier alignés Fyrel

### Phase 1 — Spawner + lead solo (1 jour)

- Module `Spawner` : map d'orchestrateurs, create/get/destroy
- Module `Orchestrator` v0 minimal : spawn une session lead via `node-pty`, gère son cycle de vie
- Endpoint `POST /orchestrators` et `DELETE /orchestrators/:id`
- WebSocket `/ws/sessions/:id` pour attacher xterm.js
- Page web : bouton "Nouvel orchestrateur", form (name, role, cwd, prompt), terminal qui apparaît
- Validation : lance, on tape, claude répond. Pas encore de MCP, pas encore de container.

### Phase 2 — MCP HTTP serveur (1 jour)

- Module `McpServer` qui écoute sur 127.0.0.1:8788
- Routing par path : `POST /mcp/:orch_id/sessions/:session_id` (streamable HTTP transport)
- Handler dispatche au bon orchestrateur via `Spawner.getOrchestrator(orch_id)`
- Implémenter `tools/list` retournant la liste fixe des outils `team.*`
- Implémenter `tools/call` avec gestion des outils simples d'abord : `whoami`, `am_i_lead`, `list`
- Au spawn d'une session, générer un `mcp.json` temporaire dans `/tmp/swarm-os/orch-{id}/session-{id}/` et passer `--mcp-config` à claude
- Validation : depuis le lead, appel `team.whoami` retourne le bon nom/rôle

### Phase 3 — Workers et team-comms (1,5 jour)

- Implémenter `team.spawn_worker({ name, role, prompt, cwd?, model?, effort?, permissionMode? })` : spawn un nouveau PTY claude, génère son mcp.json, l'enregistre
- Implémenter `team.send_message({ to, content })` : écriture formatée dans le PTY stdin du destinataire
- Implémenter `team.broadcast({ content })` : envoie à tous sauf soi
- Implémenter `team.kill_worker({ id })` et `team.kill_all_workers()` (lead-only)
- **Préambule paramétrable** : un défaut versionné dans `packages/server/src/preambles/`, override possible via `lead.preamble` au create de l'orchestrateur
- Vue UI : drill-down sur un orchestrateur affiche la liste des sessions, clic attache xterm.js
- Validation : un lead appelle `spawn_worker`, le worker apparaît, le lead lui envoie un message, le worker répond, le lead voit la réponse dans son input

### Phase 4 — Notifs Discord + persistance (1 jour)

- Module `Notifier` avec interface `notify({ kind, orchestrator, session, message })` et impl Discord webhook
- Hook `Notification` global Claude Code → POST `/hooks/notification` avec `{ orch_id, session_id, message }`
- Le notifier construit un embed Discord riche : title (orch name), description (message), fields (session, role), URL (deep-link vers UI)
- SQLite : tables `orchestrators`, `sessions` ; reprise au démarrage marque les sessions actives comme `interrupted`
- Logs : append-only par session, rotation à 50 MB
- Endpoint `GET /orchestrators/:id/sessions/:sid/log`

### Phase 5 — Containerisation (1 jour)

- `Dockerfile` : base `node:24-bookworm-slim`, install `pnpm`, install `@anthropic-ai/claude-code` global, copy build, expose 8787
- Au runtime, `claude --version` doit fonctionner
- Le container lit sa config depuis env vars (`SWARM_OS_*`) au boot
- Mounts attendus : `/workspace` (projet RW), `/home/node/.claude` (creds RO), `/data` (state RW)
- `docker-compose.yml` example dans `examples/` avec 1 puis 2 projets
- Documentation `docs/deployment.md` : build de l'image, setup compose, exposition Tailscale

### Phase 6 — Polish (½ jour)

- Auth token init au premier boot (généré, écrit dans `/data/token`)
- PWA manifest + service worker minimal pour install mobile
- README agent-readable

**Effort total estimé : 6 jours** de dev concentré.

---

## 7. Structure du projet

```
swarm-os/
├── plan.md                          # ce fichier
├── README.md                        # quickstart agent-readable
├── package.json                     # workspaces root (pnpm)
├── pnpm-workspace.yaml
├── Dockerfile
├── examples/
│   ├── docker-compose.single.yml    # 1 projet
│   └── docker-compose.multi.yml     # plusieurs projets
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts             # entrée, lit env, démarre les 2 HTTP servers
│   │   │   ├── config.ts            # parse env + /data/config.json optionnel
│   │   │   ├── modules/
│   │   │   │   ├── spawner/
│   │   │   │   │   ├── index.ts     # Spawner class
│   │   │   │   │   └── types.ts
│   │   │   │   ├── orchestrator/
│   │   │   │   │   ├── index.ts     # Orchestrator class
│   │   │   │   │   ├── session.ts   # gestion d'un PTY claude
│   │   │   │   │   ├── messaging.ts # send_message/broadcast
│   │   │   │   │   ├── mcp-config.ts
│   │   │   │   │   └── preamble.ts  # build preamble depuis défaut + override
│   │   │   │   ├── mcp/
│   │   │   │   │   ├── server.ts
│   │   │   │   │   ├── tools.ts
│   │   │   │   │   └── dispatch.ts
│   │   │   │   ├── db/
│   │   │   │   │   ├── schema.sql
│   │   │   │   │   └── index.ts
│   │   │   │   ├── notify/
│   │   │   │   │   ├── index.ts     # interface Notifier
│   │   │   │   │   └── discord.ts   # impl webhook
│   │   │   │   └── preambles/
│   │   │   │       └── default-lead.md   # défaut versionné
│   │   │   │       └── default-worker.md
│   │   │   ├── http/
│   │   │   │   ├── main.ts
│   │   │   │   ├── routes/
│   │   │   │   │   ├── orchestrators.ts
│   │   │   │   │   ├── sessions.ts
│   │   │   │   │   └── hooks.ts
│   │   │   │   ├── ws/
│   │   │   │   │   ├── terminal.ts
│   │   │   │   │   └── events.ts
│   │   │   │   └── auth.ts
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
│       │   │   ├── NewOrchestratorDialog.tsx
│       │   │   ├── PreambleEditor.tsx    # textarea pour override preamble
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
    ├── deployment.md               # Docker + docker-compose
    └── multi-project.md            # déployer N instances sur un host
```

---

## 8. Modèle de données

```typescript
interface Orchestrator {
  id: string;                    // uuid v7
  name: string;                  // "merge-team", libre
  role: string;                  // label
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  leadSessionId: string;
  // Defaults hérités par les workers spawnés
  defaultModel: string;          // ex: "opus-4-7"
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  defaultPermissionMode: 'auto' | 'bypassPermissions';  // défaut: bypassPermissions
  // Préambule effectif (résolu au create depuis défaut ou override)
  leadPreamble: string;
  workerPreamble: string;
  createdAt: string;
  endedAt: string | null;
}

interface Session {
  id: string;
  orchestratorId: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
  cwd: string;                   // doit être sous /workspace
  initialPrompt: string | null;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  permissionMode: 'auto' | 'bypassPermissions';
  status: 'starting' | 'running' | 'waiting' | 'exited' | 'killed' | 'interrupted';
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastActivityAt: string;
}
```

**Invariants** :
- Un orchestrateur a toujours exactement un lead.
- Tous les `cwd` de sessions doivent être sous `/workspace` (validé au create).
- Si le lead exit, l'orchestrateur passe `stopping` et tue les workers.
- Si un worker exit, l'orchestrateur continue, le lead est notifié via un message inséré dans son PTY.

---

## 9. API surface

### REST (sur :8787, auth token humain)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/orchestrators` | Créer. Body : `{ name, role, lead: { cwd, prompt, preamble? }, workerPreamble?, defaults?: { model, effort, permissionMode } }`. Defaults si absent : `opus-4-7` / `xhigh` / `bypassPermissions`. |
| `GET` | `/orchestrators` | Lister avec sessions associées |
| `GET` | `/orchestrators/:id` | Détails complets |
| `DELETE` | `/orchestrators/:id` | Stop : tue lead + workers |
| `GET` | `/orchestrators/:id/sessions` | Lister les sessions |
| `GET` | `/sessions/:id` | Détails |
| `GET` | `/sessions/:id/log` | Télécharger le log brut |
| `POST` | `/hooks/notification` | Endpoint pour hooks Claude Code |
| `GET` | `/info` | Métadata de l'instance : `{ project_name, version, started_at }` |
| `GET` | `/health` | Healthcheck |

### WebSocket (sur :8787)

- `/ws/sessions/:id` — terminal bidirectionnel
- `/ws/events` — flux d'events globaux (orch créé, session spawned/exited/etc.)

### MCP HTTP (sur :8788, bind 127.0.0.1, intra-container only)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/mcp/:orch_id/sessions/:session_id` | Endpoint MCP streamable HTTP |

Pas d'auth header — l'auth est dans le path + bind localhost.

---

## 10. MCP team-comms — outils exposés

| Outil | Visibilité | Paramètres | Retour |
|---|---|---|---|
| `team.whoami` | tous | `{}` | `{ session_id, name, role, type }` |
| `team.am_i_lead` | tous | `{}` | `{ is_lead: boolean }` |
| `team.list` | tous | `{}` | `{ members: [...] }` |
| `team.send_message` | tous | `{ to, content }` | `{ delivered: boolean }` |
| `team.broadcast` | tous | `{ content }` | `{ delivered_to: [...] }` |
| `team.spawn_worker` | **lead only** | `{ name, role, prompt, cwd?, model?, effort?, permissionMode? }` | `{ session: { id, name, ... } }` |
| `team.kill_worker` | **lead only** | `{ id }` | `{ killed: boolean }` |
| `team.kill_all_workers` | **lead only** | `{}` | `{ killed: [...] }` |

---

## 11. Communication inter-sessions

`team.send_message({ to, content })` écrit dans le PTY stdin du destinataire un bloc formaté :

```
\n[team-comms message from <sender_name> (<sender_role>)]\n
<content>\n
[end message]\n
```

Claude côté destinataire le traite à son prochain tour. Pas de polling, pas de mailbox.

**Préambule équipe** : à la création de l'orchestrateur, l'utilisateur peut fournir `lead.preamble` et `workerPreamble`. Sinon, le défaut versionné dans `packages/server/src/modules/preambles/` est utilisé. Le préambule est concaténé au prompt initial fourni par l'utilisateur (ou par le lead lors de `spawn_worker`).

Le défaut couvre :
- Identité (nom, rôle, type lead/worker)
- Liste des outils `team.*` disponibles (filtrée selon lead/worker)
- Format des messages entrants `[team-comms message from ...]`
- Convention de réponse encouragée (utiliser `team.send_message` plutôt que d'attendre que l'humain pousse l'input)

---

## 12. Notifications Discord

Module `Notifier` avec une seule impl en MVP : webhook Discord unidirectionnel.

**Configuration** : env var `SWARM_OS_DISCORD_WEBHOOK_URL` au boot, optionnelle. Si absent, le notifier no-op (logs seulement).

**Events qui notifient** :
- Session passe en `waiting` (hook `Notification`)
- Orchestrateur exit (lead terminé) avec son statut
- Session exit anormale (exit code ≠ 0)

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

L'URL embed pointe directement vers la session via deep-link. Sur mobile, tap → safari → Tailscale → UI swarm-os → terminal de la session en attente.

**Roadmap v0.2** : bot Discord bidirectionnel pour permettre des interventions depuis Discord (envoyer un message à une session, kill une équipe). Conserver le webhook pour l'envoi sortant en parallèle.

---

## 13. Containerisation & déploiement multi-instance

### Dockerfile (esquisse)

```dockerfile
FROM node:24-bookworm-slim

# Outils système nécessaires à node-pty et claude
RUN apt-get update && apt-get install -y \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Utilisateur non-root
USER node
WORKDIR /home/node/app

# Build du serveur swarm-os
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && pnpm build

# Volumes attendus
VOLUME ["/workspace", "/home/node/.claude", "/data"]

EXPOSE 8787

CMD ["node", "packages/server/dist/index.js"]
```

### docker-compose pour un projet

```yaml
services:
  swarm-fyrel-cc-app:
    image: swarm-os:latest
    container_name: swarm-fyrel-cc-app
    ports:
      - "8787:8787"
    volumes:
      - ~/dev/fyrel-cc-app:/workspace
      - ~/.claude:/home/node/.claude:ro
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
    ports: ["8787:8787"]
    volumes:
      - ~/dev/fyrel-cc-app:/workspace
      - ~/.claude:/home/node/.claude:ro
      - ~/.swarm-os/fyrel:/data
    environment:
      SWARM_OS_PROJECT_NAME: fyrel-cc-app
      SWARM_OS_DISCORD_WEBHOOK_URL: ${FYREL_DISCORD_WEBHOOK}

  swarm-grap:
    image: swarm-os:latest
    ports: ["8797:8787"]
    volumes:
      - ~/dev/grap-server:/workspace
      - ~/.claude:/home/node/.claude:ro
      - ~/.swarm-os/grap:/data
    environment:
      SWARM_OS_PROJECT_NAME: grap-server
      SWARM_OS_DISCORD_WEBHOOK_URL: ${GRAP_DISCORD_WEBHOOK}
```

### Variables d'environnement supportées

| Var | Obligatoire | Description |
|---|---|---|
| `SWARM_OS_PROJECT_NAME` | oui | Nom affiché dans l'UI et les notifs |
| `SWARM_OS_DISCORD_WEBHOOK_URL` | non | Si absent, notifs no-op |
| `SWARM_OS_PUBLIC_URL` | non | Pour les deep-links Discord. Sinon, pas de lien dans les embeds |
| `SWARM_OS_PORT` | non | Override du port main (défaut 8787) |
| `SWARM_OS_TOKEN` | non | Si absent, généré au premier boot et écrit dans /data/token |
| `SWARM_OS_DEFAULT_MODEL` | non | Défaut `opus-4-7` |
| `SWARM_OS_DEFAULT_EFFORT` | non | Défaut `xhigh` |
| `SWARM_OS_DEFAULT_PERMISSION_MODE` | non | Défaut `bypassPermissions` |

---

## 14. Sécurité & accès

- **`bypassPermissions` par défaut** : aucune approbation, le classifier serveur d'Anthropic est aussi désactivé. L'agent fait ce qu'il veut.
- **L'isolation principale vient du container** : les agents ne voient que `/workspace`, `/data`, `/tmp`. Pas d'accès au home host, pas d'accès aux autres projets, pas d'accès aux secrets ailleurs.
- **Toujours scoper les mounts** : un container par projet, un seul `/workspace` qui pointe vers le bon dossier. Jamais mount le home complet.
- **`~/.claude` monté en read-only** : le container utilise tes credentials de souscription mais ne peut pas les modifier.
- Container tourne **en user non-root** (`USER node` dans Dockerfile). Réduit la surface si une vulnérabilité de Docker permet une évasion.
- Le main HTTP/WS exposé : sur `127.0.0.1:PORT` du host, puis Tailscale gère l'accès cross-device. **Jamais exposé internet public.**
- Le MCP HTTP **strictement intra-container**, jamais mappé sur le host.
- Auth humaine par token statique en header, généré et stocké dans `/data/token` au boot.
- Auth MCP par UUIDs dans le path, bind localhost intra-container.
- Fichiers `mcp.json` temporaires dans `/tmp/swarm-os/...`, mode `0600`.

### Limites connues du modèle de sécurité

- Un agent qui sort de son rôle peut faire des dégâts dans `/workspace` (mais c'est borné au projet).
- Un agent peut faire des appels réseau sortants (Discord, npm install, fetch externe). Pas de pare-feu en MVP. Pour resserrer, ajouter un `--network` config dans docker-compose, ou un proxy egress filtrant en v0.2.
- Les credentials Anthropic mountées en RO sont quand même lisibles par tous les processus du container. Si un agent décide d'exfiltrer son contenu vers un serveur externe, il peut. Mitigation v0.2 : firewall egress + audit des appels réseau via hook MCP.

---

## 15. Observabilité

- Logs serveur : `pino` JSON, stdout du container, capturé par `docker logs`.
- Logs sessions : append-only dans `/data/logs/{orch_id}/{session_id}.log`. Capture le PTY output complet + les écritures `team.send_message` reçues.
- Log dédié des appels MCP : `/data/logs/{orch_id}/mcp.log` pour audit a posteriori.
- Healthcheck `/health` : `{ status, project_name, orchestrators_active, sessions_active, sessions_waiting, uptime_seconds }`. Utilisable par docker healthcheck.

---

## 16. Roadmap post-MVP

- **Bot Discord bidirectionnel** : envoyer des commandes depuis Discord (kill, send_message, attach via lien).
- **Permissions par rôle** : config quels outils MCP un rôle peut appeler.
- **Templates d'orchestrateur** : presets versionnés (`merge-team`, `qa-team`, etc.).
- **Petits-enfants** : permettre à un worker de devenir lead de sous-équipe.
- **Quick-replies UI** : pousser des messages manuels dans la team-comms depuis le frontend.
- **Intégration JIRA FYRA** : créer un orchestrateur depuis un ticket.
- **Replay temporel** : asciinema-style replay.
- **Worker types autres que claude** : aider, scripts custom implémentant le protocole.
- **Firewall egress** : limiter les domaines accessibles depuis le container.
- **Multi-tenant** dans une instance : plusieurs utilisateurs avec leurs propres orchestrateurs.

---

## 17. Décisions tranchées

- [x] **Nom** : `swarm-os`
- [x] **Mode de permission par défaut** : `bypassPermissions` (autonomie max, isolation par container)
- [x] **Modèle et effort par défaut** : `opus-4-7` avec effort `xhigh`. Override per-orch et per-worker.
- [x] **Préambule paramétrable** dès la v0.1, défaut versionné dans le repo.
- [x] **Persistance des messages team-comms** : logs seulement, pas de stockage DB.
- [x] **Package manager** : pnpm workspaces
- [x] **Notifications** : Discord webhook (out-only en MVP, bot bidirectionnel en v0.2)
- [x] **Ports** : 8787 main, 8788 MCP (intra-container)
- [x] **Multi-instance** : un container par projet, déploiement docker-compose
- [x] **Containerisation** : Docker obligatoire, image basée sur `node:24-bookworm-slim` avec claude CLI installé

---

## Notes pour les agents Claude Code travaillant sur ce projet

- Ce projet est **single-user, multi-projet**. Chaque instance swarm-os = un container = un projet. Pas d'over-engineering multi-tenant à l'intérieur d'une instance.
- Toutes les sessions tournent en `bypassPermissions` — l'isolation vient du container, pas du runtime. Toute modif qui contourne l'isolation container (mount additionnel, escape de namespace, etc.) est un bug de sécurité critique.
- Le serveur MCP HTTP doit rester **strictement bind 127.0.0.1 dans le container**, jamais exposé en port mapping Docker. Toute modif qui change ça est un bug de sécurité critique.
- Workers = feuilles. Pas de spawn récursif en v0.1. Si un worker tente d'appeler `team.spawn_worker`, ça retourne `PERMISSION_DENIED`.
- Le préambule par défaut versionné dans `packages/server/src/modules/preambles/` est la source de vérité. Si tu le modifies, justifie pourquoi dans le commit message.
- La doc agent-readable doit rester en plain Markdown, lisible avec `cat`/`grep`. Pas de mermaid, pas de HTML embed.
- Quand tu modifies ce plan, mets à jour la section "Phases" pour marquer les phases complétées avec `[x]`.
