# UI Redesign — Intégration du prototype Desktop

Plan d'intégration du **prototype v2** (`prototypes/swarm-os-prototypes_v2.zip`,
dossier `v2/`) dans le code React de `packages/web/`. La v2 couvre tous les
lots **U0 + U1** de `update_UI.md` (et la majorité des U2) en plus de la base
v1. La variante mobile (`prototypes/v2/mobile/` + `Swarm OS Mobile.html`) est
traitée séparément — la version desktop est servie au chargement, la mobile
sera activée plus tard via un breakpoint.

Statut : `update_system.md` S1–S12 est livré (backend v1 complet,
2026-05-22) ; le prototype v2 couvre U0.1–U0.7, U1.1–U1.9, U2.1–U2.6.
**Phase A–D livrée le 2026-05-22** (19 étapes du §5.1, voir
`docs/redesign-desktop/01_…md` à `19_…md`). Phase E (mobile) reste hors
scope. Ce document acte la nouvelle réalité après validation
bidirectionnelle et implémentation.

---

## 1. Anatomie du prototype desktop v2

Le prototype est un SPA React (UMD + Babel standalone), thème "warm-black"
ambré, état tout en local avec données factices (`window.TEAMS_INIT`,
`window.ROLES_INIT`, `window.ENDED_INIT`, `window.WAITING_INIT`,
`window.AGG_HISTORY`, etc.). Toutes les valeurs sont simulées par un
`setInterval` qui incrémente compteurs, historique et "pulses" sur la carte,
et injecte sporadiquement des waiting-toasts pour démo.

Layout grille fixe (inchangé vs v1) :

```
┌──────────────────────────────────────────────────────────────────┐
│  TopBar (56px)                                                    │
│  brand+info | health-strip (team pills) | NEW · ROLES · ⚙ · clock │
├────────────┬─────────────────────────────────┬───────────────────┤
│ LeftPanel  │   MapView (canvas SVG)          │ RightPanel        │
│ 320px      │   1fr                           │ 380px             │
│            │                                 │                   │
│ ▸ Message  │   hub central "SWARM // BUS"    │ head + cfg + chip │
│   flow     │   (clickable → broadcast)        │ stats + meta      │
│ ▸ Per-team │   leads en orbite, workers       │ 5 action buttons  │
│ ▸ Recently │   en arc autour du lead          │ tabs:             │
│   ended    │   + edges + pulses (4 types)     │  CONSOLE/MSGS/CFG │
│ ▸ Bus      │   + waiting ring + inbox badges  │ composer          │
│   health   │   + spawn anim + SVR-RESTART     │   (PTY/INBOX,     │
│            │                                 │    AGENT/TEAM)    │
└────────────┴─────────────────────────────────┴───────────────────┘
                                                + toasts bas-droite
                                                + EventsPip
                                                + overlays (modals)
```

### 1.1 Composants React du prototype v2

| Composant | Fichier | Rôle |
|---|---|---|
| `App` | `v2/app.jsx` | Orchestration globale, état (teams, ended, roles, waitingToasts, selectedId, pulses, history, spawningIds, flashTeamId, overlays) |
| `TopBar` | `v2/app.jsx` | Brand+info + health-strip (team-pill OFFLINE/HEALTHY/WAITING/STARTING/DEGRADED/BAD) + horloge + NEW/ROLES/cog |
| `LeftPanel`, `BigGraph`, `Sparkline` | `v2/panels.jsx` | MESSAGE FLOW / PER-TEAM TRAFFIC / RECENTLY ENDED / BUS HEALTH |
| `MapView`, `Node`, `NodeShape`, `layoutTeams`, `curveBetween` | `v2/map.jsx` | Canvas SVG + pan/zoom/pinch, formes par rôle, ring/dot/inbox-badge/waiting-pulse, hub clickable, pulses 4 kinds (intra/cross/human/broadcast), spawn animation |
| `RightPanel`, `Composer`, `ConfigTab`, `ConfirmModal` | `v2/panels.jsx` | head + cfgline + cwd + stats + meta + 5 actions + tabs CONSOLE/MESSAGES/CONFIG + composer toggles + confirmation modale KILL/STOP |
| `NewOrchestratorDialog` | `v2/modals.jsx` | name/role/cwd/prompt/preamble/model/effort/perm + warning bypassPermissions |
| `RolesPage` | `v2/modals.jsx` | Overlay plein écran, liste + détail role, sections DEFAULTS/LEAD PROMPT/LEAD PREAMBLE/WORKER PREAMBLE/CONNECTORS |
| `SettingsDrawer` | `v2/modals.jsx` | Side-drawer X-Auth-Token (save/clear/show), section About (project/version/uptime/started), section Events (WS status) |
| `SpawnWorkerDialog` | `v2/modals.jsx` | Mini-dialog lead-only : name + role + worker preamble override |
| `EditConfigDialog` | `v2/modals.jsx` | Rotate model/effort/permission → restart team |
| `BroadcastModal` | `v2/modals.jsx` | Composer broadcast cross-team (déclenché par clic sur hub) |
| `Toasts`, `EventsPip` | `v2/toasts.jsx` | Toasts SESSION WAITING bas-droite (max 5 + `+N older`), pip "events :: live" quand aucun toast |
| `ICON` | `v2/icons.jsx` | Lib d'icônes SVG inline : plus, cog, template, pencil, stop, start, pause, kill, reload, fork, send, bcast, back, copy, link, inbox, trash |
| `data.jsx` | `v2/data.jsx` | Mocks + role catalogue + ROLE_SHAPE + helpers (`formatUptime`, `formatRelative`, `formatClockShort`, `statusLabel`, `statusChipClass`, `genLog`, `genMessages`) — à supprimer, remplacé par les vrais endpoints |
| `TweaksPanel` | `prototypes/tweaks-panel.jsx` (v1) | Outil design-time. **À exclure**. |

### 1.2 Système de design (à porter)

- Variables CSS dans `:root` du `<style>` du HTML (palette warm-black ambré +
  états `ok`/`warn`/`bad`/`stopped`/`waiting`/`starting`).
- Polices Google : `Geist` (sans) + `Geist Mono`.
- Aucune utilisation de framework CSS — du CSS brut + utility classes
  custom (`.team-pill`, `.pr-tab`, `.pr-cfgline`, `.pr-cwd`, `.console-line`,
  `.node-inbox-bg`, `.node-ring-pulse`, `.center-hub`, `.toast`, `.modal`,
  `.drawer`, `.cfg-section`, `.cfg-kv`, `.cfg-pre`, etc.).
- Aucune dépendance JS hors React 18 + Babel standalone (SVGs inlines, pas
  de D3, pas de zustand).
- Pulses animés via CSS `offset-path` + `@keyframes pulse-travel`.

### 1.3 Mapping role → shape (figé, livrable U0.2)

| Role string | NodeShape (`v2/data.jsx:117`) |
|---|---|
| `ORCHESTRATOR` | `diamond` |
| `RESEARCHER` | `circle` |
| `BUILDER` | `triangle` |
| `CRITIC` | `diamondS` (diamond outlined) |
| `ANALYST` | `halfmoon` |
| `MEMORY` | `dot` |
| `TOOLS` | `square` |
| _(autre)_ | `circle` (fallback) |

À recopier tel quel dans `MapView.tsx` (`ROLE_SHAPE: Record<string, Shape>`).

---

## 2. État actuel du frontend (`packages/web/`)

Stack : React 19 + Vite 6 + Tailwind 4 + xterm.js. Routing par hash :
`#/`, `#/orchestrators/:id`, `#/roles`.

| Fichier | Responsabilité actuelle |
|---|---|
| `src/App.tsx` | Header (brand + project + health counters + boutons), settings token, route switch, `NotificationPanel` global |
| `src/components/OrchestratorList.tsx` | Liste des orchestrators (actifs + historique) + bouton "New" |
| `src/components/OrchestratorView.tsx` | Détail : liste sessions à gauche, `Terminal` + `QuickReply` à droite, `BroadcastBar` en tête |
| `src/components/Terminal.tsx` | xterm.js attaché à `/ws/sessions/:id` |
| `src/components/BroadcastBar.tsx` | `POST /orchestrators/:id/broadcast` |
| `src/components/NotificationPanel.tsx` | Toasts via `/ws/events` (sessions `waiting`) |
| `src/components/NewOrchestratorDialog.tsx` | Formulaire création (name, role, cwd, prompt, model, effort, perm) |
| `src/components/RolesPage.tsx` + `RoleDialog.tsx` | CRUD de templates de rôles |
| `src/components/StatusBadge.tsx` | Badge statut (idle/running/warn/bad/stopped) avec animation pulse |
| `src/hooks/useOrchestrators.ts` | Poll `/orchestrators` toutes les 3 s |
| `src/hooks/useEvents.ts` | WS `/ws/events`, dedup par session, auto-dismiss 30 s |
| `src/hooks/useRoles.ts`, `useSession.ts` | Idem pour rôles / session unique |
| `src/lib/sessionStatus.ts` (S3, S6) | `mapSessionStatusToVisual`, `enrichWithIdle`, `VISUAL_CLASSES`, `IDLE_VISUAL_THRESHOLD_MS = 30_000` |
| `src/lib/useNow.ts` | Re-render périodique (vieillissement des "x s ago") |
| `src/lib/messageStats.ts` (S4) | Ring buffer 60 pts côté client, `useGlobalMessageStats` |
| `src/lib/loadPercent.ts` (S10) | `formatLoadPercent(value) → 'XX%' | '—'` |
| `src/lib/mailBubble.ts` (S12) | `classifyBubble(msg, sessionId) → 'me'|'them'|'system'|'other-team'` |
| `src/api/client.ts` | Wrapper REST + types (`OrchestratorView`, `SessionView`, `RoleView`, `HealthView`, `InfoView`, `MailMessageView`) |

### 2.1 Surfaces serveur disponibles (backend v1, S1–S12 livrés)

REST :
- `GET /health`, `GET /info` (token-free)
- `GET /orchestrators`, `GET /orchestrators/:id` — `OrchestratorView` avec
  `msgCount` (S1), `health` (S7), `defaultModel/Effort/PermissionMode`,
  `leadPreamble`, `workerPreamble`, `sessions[]`, `stopReason`
- `POST /orchestrators` (create), `DELETE /orchestrators/:id` (destroy)
- `POST /orchestrators/:id/broadcast` — `from: 'human'` → tous les
  membres actifs
- `GET /orchestrators/:id/sessions/:sid/inbox` — `peekInbox`
- `GET /sessions/:id` — `SessionView` (status 8 valeurs dont `paused` S5)
- `POST /sessions/:id/input` — PTY bytes
- `POST /sessions/:id/{stop,pause,resume,restart}` (S5)
- `GET /sessions/:id/log`
- `GET /roles` CRUD complet
- `GET /metrics/messages` (S9, snapshot 60 ticks),
  `GET /metrics/bus` (S8, latency / throughput / queue / err_rate)
- `GET /ws-ticket?session=...` / `?events=1`

WebSocket :
- `/ws/sessions/:id` — PTY (writer/reader semantics)
- `/ws/events` — push, types : `orchestrator.{created,updated,destroyed}`,
  `session.{created,status_changed,exited}`, `mailbox.message` (S2, payload
  `{ from, to, orchestratorId, fromOrchestratorId? }`)

MCP (intra-agent, pas REST opérateur) :
- `team.send_message`, `team.broadcast`, `team.read_inbox`
- `team.spawn_worker`, `team.kill_worker` (lead-only)
- `swarm.send_to_lead`, `swarm.broadcast_to_leads`

Connecteurs :
- `DiscordWebhookNotifier` par role (`modules/notify/discord.ts`), exposé
  via `RoleView.connectors[]`

Auth : `X-Auth-Token` sur tout sauf `/health` et `/info`, WS via ticket.

---

## 3. Mapping prototype v2 ↔ système

Validation bidirectionnelle effectuée le 2026-05-22 après livraison S1–S12 +
prototype v2. Légende : ✅ couvert, ⚠ couvert avec note, ❌ gap résiduel.

### 3.1 TopBar (`v2/app.jsx:43-130`)

| Élément v2 | Source backend | Statut |
|---|---|---|
| `brand` + project/version/uptime live | `info.project_name`, `info.version`, dérivé de `info.started_at` | ✅ S8/S1 — boucle 1 s côté client |
| `team-pill` (1 par orch) | itérer sur `useOrchestrators()` | ✅ |
| `pill.name` | `orch.name` | ✅ |
| `pill-status` `OFFLINE/HEALTHY/WAITING/STARTING/DEGRADED/BAD` | dérivé de `orch.status` + `orch.health` (S7) + scan `sessions[].status` (`waiting`, `starting`) | ✅ `mapOrchestratorStatusToVisual` + check `sessions.some(s => s.status === 'waiting')` |
| `pill-body "N agt"` | `orch.sessions.length` | ✅ |
| `pill-body "Nk msg"` | `orch.msgCount` (S1) — formaté `>999 → Nk` | ✅ |
| `pill-bar` (santé) | `orch.health === 'warn' ? 60% : 'ok' → 85% : 'offline' → 0%` | ✅ dérivé S7 |
| `flash-new` (animation pill apparue) | local state après `POST /orchestrators` réussi | ✅ pure UI |
| `waiting-flag ●` à côté du nom | un session de la team a `status === 'waiting'` | ✅ |
| `topbar-right "N AGENTS"` + clock | `health.sessions_active` + `new Date()` | ✅ |
| Bouton `+ NEW TEAM` | ouvre `NewOrchestratorDialog` → `api.createOrchestrator(...)` | ✅ U0.1 |
| Bouton `ROLES` | ouvre `RolesPage` (route `#/roles`) | ✅ U0.2 |
| Bouton cog (settings) | ouvre `SettingsDrawer` | ✅ U0.3 |
| Clic team-pill → focus | `selectAgent(team.lead.id)` + route `#/orchestrators/:id` | ✅ |

### 3.2 LeftPanel (`v2/panels.jsx:67-154`)

| Section v2 | Source backend | Statut |
|---|---|---|
| **MESSAGE FLOW** big number + `+N/min` | `useGlobalMessageStats(orchestrators)` → `total`, `perMinute` (S4) | ✅ |
| Sparkline 60 pts (LIVE) | `useGlobalMessageStats(...).history[60]` OU `GET /metrics/messages.global[60]` (S9) | ✅ deux variantes, S4 par défaut |
| **PER-TEAM TRAFFIC** msg count par team | `orch.msgCount` (S1) | ✅ |
| Sparkline per-team 8 pts | `GET /metrics/messages.per_orchestrator[id][8]` (S9) | ✅ |
| Couleur muted si team offline | `orch.health === 'stopped'` | ✅ S7 |
| Tag `ONLINE/STARTING/OFFLINE` | `orch.status` | ✅ |
| **RECENTLY ENDED** liste | `useOrchestrators()` filtre sur `orch.endedAt != null`, trié desc | ✅ U1.5 |
| `badge-reason` (exited/killed/failed/server-restart) | `orch.stopReason` (Phase 4) | ✅ |
| `formatRelative(endedAt)` | helper client | ✅ helpers `useNow` + `formatRelative` |
| Clic ended → drilldown read-only | route `#/orchestrators/:id` avec composer disabled | ⚠ à implémenter côté UI (composer auto-désactivé si `endedAt != null`) |
| **BUS HEALTH** latency / throughput / queue / err rate | `GET /metrics/bus` (S8) — `latency_ms`, `throughput_msg_per_s`, `queue_depth`, `err_rate_pct` | ✅ |

### 3.3 MapView (`v2/map.jsx`)

| Élément v2 | Données système |
|---|---|
| Hub central "SWARM // BUS" clickable | UI seule — clic ouvre `BroadcastModal` qui appelle… ❌ pas d'endpoint `swarm-broadcast` REST (gap §4-1). Fallback : itérer `api.broadcastToOrchestrator(id)` sur tous les actifs côté client. |
| Node lead (diamond) | `orch.sessions.find(s => s.type === 'lead')` |
| Node worker (formes par role) | `orch.sessions.filter(s => s.type === 'worker')` + `ROLE_SHAPE` |
| Status-dot couleur (running/warn/waiting/idle/starting/failed/stopped/interrupted) | `session.status` après `enrichWithIdle` (S6) ; tous les autres états mappent 1:1 |
| Ring (`lead/selected/stopped/failed/starting/interrupted`) | `mapSessionStatusToVisual` → classe CSS |
| `node-ring-pulse` (ambre pulsant) | `session.status === 'waiting'` (S3 — la classe `swarm-pulse-warn` est déjà câblée) |
| `node-inbox-bg` + `node-inbox-txt` (badge unread) | `peekInbox(orch.id, session.id).count` poll 3 s |
| Label `STARTING` / `SVR-RESTART` | `session.status === 'starting' / 'interrupted'` (S5/Phase 4 stopReason) |
| Spawn animation (`spawningIds`) | local state pendant 700 ms après réception event `session.created` |
| Edges lead↔hub, lead↔worker, intra-workers | générés depuis la topologie ; aucun reflet backend (purement structurel) |
| Pulses (4 kinds : intra/cross/human/broadcast) | dérivés de `/ws/events` `mailbox.message` (S2) : `to === 'broadcast'` → kind `broadcast` ; `fromOrchestratorId !== orchestratorId` → `cross` ; `from === 'human'` → `human` ; sinon `intra` |
| Throttle/dedupe pulses | `useEvents` côté client (pulse cap 32) |
| Clic node → select | local state `selectedId`, route `#/orchestrators/:id?session=...` |
| Pan/zoom/pinch + reset | pure UI (`vb` viewBox) |
| Tooltip hover | UI seule, lit `session.name/role/status/inbox` |

### 3.4 RightPanel (`v2/panels.jsx:158-405`)

| Élément v2 | Code actuel / backend |
|---|---|
| `pr-head` (team-id, LEAD/WORKER, sessionId, name, role, status chip) | `SessionView` + `OrchestratorView.name`, `StatusBadge` à restyler |
| `pr-cfgline M:opus E:high P:default` + edit | `orch.defaultModel/Effort/PermissionMode` (S5) ; clic edit → `EditConfigDialog` → ❌ pas d'endpoint PATCH (gap §4-2). Workaround : destroy+recreate. |
| `pr-cwd` | `orch.sessions[].cwd` (déjà sur `SessionView`) |
| `chip` Discord si applicable | `orch.roleId` → `getRole(roleId).connectors[]` contient `discord` (livré) |
| `pr-stats` LOAD | `formatLoadPercent(undefined)` → `'—'` (S10, S1 design-decision) |
| `pr-stats` UPTIME | `formatUptime(session.startedAt)` côté client |
| `pr-stats` LOG LINES | compteur local accumulé sur le flux `/ws/sessions/:id` (déjà fait par `Terminal.tsx`) |
| `pr-meta pid · started · last_activity` | `session.pid`, `session.startedAt`, `session.lastActivityAt` (formaté `formatClockShort` / `formatRelative`) |
| Bouton STOP (lead) — confirme | lead → `api.destroyOrchestrator(orch.id)`, worker → `api.stopSession(id)` (S5). `ConfirmModal` en pré-requis. |
| Bouton PAUSE | `api.pauseSession(id)` → status `paused` (S5) |
| Bouton RESTART | `api.restartSession(id)` (S5) — `newSession.id` diffère, à propager |
| Bouton KILL — confirme | lead → `api.destroyOrchestrator(orch.id)` (kill), worker → ❌ pas d'endpoint `/sessions/:id/kill` distinct (workaround : `stopSession` qui termine le PTY) |
| Bouton REACTIVATE | sur session terminée — ❌ pas d'endpoint REST (workaround : `api.createOrchestrator` avec mêmes params + `team.spawn_worker` côté lead pour les workers) |
| Bouton `+ WORKER` (lead-only) | ouvre `SpawnWorkerDialog` → ❌ pas d'endpoint REST `/orchestrators/:id/workers`. Workaround : envoyer au lead via mailbox/PTY `team.spawn_worker(...)` MCP call. (Gap §4-3) |
| Tab CONSOLE | `Terminal.tsx` xterm.js — palette warm-black à porter |
| Pastille WRITER/READER | ❌ pas exposé sur `SessionView` (gap §4-4). Dérivable client : 1er WS qui ouvre `/ws/sessions/:id` est writer, suivants readers ; le serveur le signale dans le hello frame (`role: 'writer'|'reader'` — déjà géré par `Terminal.tsx`). À surfacer dans le state du RightPanel. |
| Tab MESSAGES — bulles me/them/system/other-team | `peekInbox` polled 3 s + `classifyBubble` (S12) → kind ; rendu via `MailMessageView.from/content/ts`, `fromOrchestratorName/SessionName` pour cross-team |
| Tab CONFIG (RUNTIME, LEAD PROMPT, LEAD PREAMBLE, WORKER PREAMBLE, CONNECTORS) | `orch.defaultModel/Effort/PermissionMode/leadPreamble/workerPreamble` + `getRole(orch.roleId).leadPrompt` + `getRole(orch.roleId).connectors` |
| `EXIT REASON` line dans CONFIG si stopped/failed | `session.exitCode`, `session.stopReason`, `session.lastError` |
| Composer toggle `→ PTY / → INBOX` | PTY = `api.postSessionInput(id, text)` ✅ ; INBOX = ❌ pas d'endpoint `POST /sessions/:id/mail` (gap §4-5). Workaround v1 : désactiver le toggle INBOX pour le mode AGENT (laisser uniquement pour le mode TEAM via `broadcastToOrchestrator`). |
| Composer toggle `AGENT / TEAM` (lead-only) | AGENT = single recipient ; TEAM = `api.broadcastToOrchestrator(orch.id, text)` |
| `send-target` label dynamique | UI |
| `helper` text contextuel | UI |
| `ConfirmModal` pour KILL/STOP | UI (state local) |

### 3.5 Modals & overlays (`v2/modals.jsx`)

| Modal | Backend |
|---|---|
| `NewOrchestratorDialog` (name/role/cwd/prompt/preamble/model/effort/perm) | `POST /orchestrators` (S5/S6) — option `"+ create new role"` ouvre `RoleDialog` |
| `RolesPage` (overlay plein écran) | `GET /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`, `POST /roles` — sections DEFAULTS / LEAD PROMPT / LEAD PREAMBLE / WORKER PREAMBLE / CONNECTORS Discord |
| `SettingsDrawer` (token + about + WS status) | localStorage `swarm-os.token` (déjà géré par `api/client.ts`) + `GET /info` + `GET /health` ; status WS pip via `useEvents.connected` |
| `SpawnWorkerDialog` | ❌ pas d'endpoint REST (gap §4-3) |
| `EditConfigDialog` (rotate model/effort/perm) | ❌ pas d'endpoint PATCH (gap §4-2) |
| `BroadcastModal` (depuis hub) | itère `api.broadcastToOrchestrator(id, text)` sur tous les actifs (workaround §4-1) |
| `ConfirmModal` (KILL/STOP) | UI seule |

### 3.6 Toasts (`v2/toasts.jsx`)

| Élément | Backend |
|---|---|
| Stack `SESSION WAITING` bas-droite, max 5 | `useEvents()` filtre `session.status_changed` où `status === 'waiting'` (déjà fait par `NotificationPanel.tsx`) |
| `+N older waiting →` | local state |
| Auto-dismiss 30 s (`TOAST_TTL_MS = 30000`) | déjà géré par `useEvents` |
| Bouton `→ OPEN` | `setSelectedId(sessionId)` + route |
| Bouton dismiss `×` | local state |
| `EventsPip` `events :: live / reconnecting…` | `useEvents.connected` |

---

## 4. Gaps résiduels côté serveur

> UI v1 livrée 2026-05-22, ces gaps restent ouverts côté serveur, mitigés
> côté UI par disabled+tooltip ou workarounds clients.

La liste de §4 (v1 du doc) est largement résorbée. Voici **ce qui reste**
après S1–S12 :

1. **Pas de `POST /swarm/broadcast`** (cross-team operator broadcast) —
   le hub `BroadcastModal` doit itérer `broadcastToOrchestrator` côté
   client. Acceptable v1 ; si latence trop visible, ajouter un endpoint
   atomique.
2. **Pas de `PATCH /orchestrators/:id`** pour rotate model/effort/perm
   (`EditConfigDialog`). Aujourd'hui = destroy + recreate côté client.
   À spec ; impact moyen (perte du contexte session).
3. **Pas de `POST /orchestrators/:id/workers`** REST opérateur
   (`SpawnWorkerDialog`). `team.spawn_worker` existe en MCP mais pas
   exposé hors lead. Workaround : broadcast à l'agent lead avec instruction
   d'appeler le MCP tool. À spec si besoin réel.
4. **Pas de `SessionView.writer: boolean`** — le hello frame WS le
   signale, mais le RightPanel a besoin de l'info avant d'ouvrir le WS
   (pour griser le composer en mode reader). Soit ajouter le champ sur
   `SessionView`, soit consulter `/ws-ticket` qui renvoie déjà le `kind`.
5. **Pas de `POST /sessions/:id/mail`** (mailbox 1:1 humain → agent).
   Composer toggle INBOX en mode AGENT est désactivé v1 (toggle visible mais
   inactif, tooltip "v2"). Le mode TEAM (broadcast) reste actif.
6. **`session.kill` vs `session.stop`** : aujourd'hui il n'y a qu'une
   route `/stop`. Le bouton KILL du proto utilise le même endpoint avec un
   timeout plus court ; ou ajouter un endpoint `/kill` qui force `SIGKILL`
   sans grace period. À spec si besoin réel.
7. **`session.lastError` / `exitCode` enrichissement** : déjà sur
   `SessionView`, à propager dans le CONFIG tab (`EXIT REASON` row).
8. **Reactivate session terminée** : pas d'endpoint. Workaround =
   recréer manuellement via `POST /orchestrators` ou (pour les workers)
   passer par le lead.

Aucun de ces gaps ne bloque la v1 visuelle. Stratégie : boutons grisés avec
tooltip `available in v2`, toggle disabled côté composer.

---

## 5. Plan d'intégration

> Phase A–D livrées le 2026-05-22 — voir ci-dessous l'état effectif et
> `docs/redesign-desktop/` pour les analyses détaillées.

### 5.1 Étapes (ordre d'exécution proposé)

**Phase A — fondations visuelles** (autonome, 0 changement serveur)

1. Importer le système de design v2 : variables CSS, fonts Google, classes
   utilitaires (extraites du `<style>` de `prototypes/v2/Swarm OS v2.html`
   — fichier à conserver dans `prototypes/v2/` comme source de vérité).
   Cible : `src/styles/desktop-theme.css` importé depuis `main.tsx`.
2. Créer `src/components/desktop/` :
   - `DesktopShell.tsx` (grid 56px / 320px-1fr-380px) + orchestration
     overlays
   - `TopBar.tsx` (brand+info live, health-strip, NEW/ROLES/cog, clock)
   - `LeftPanel.tsx` + `BigGraph.tsx`, `Sparkline.tsx`
   - `MapView.tsx` (port du `v2/map.jsx`, typé TS, pulses pilotés par
     `/ws/events`)
   - `Node.tsx`, `NodeShape.tsx`, `layoutTeams.ts`, `curveBetween.ts`
   - `RightPanel.tsx` (head/cfgline/cwd/stats/meta/5-actions/tabs/composer)
   - `ConfigTab.tsx`, `Composer.tsx`, `ConfirmModal.tsx`
   - `Toasts.tsx`, `EventsPip.tsx`
3. Câbler `DesktopShell` derrière la route `#/` (remplace
   `OrchestratorList`). Conserver `#/orchestrators/:id` comme alias qui
   pré-sélectionne le lead correspondant. Conserver `#/roles` (RolesPage,
   ouvrable aussi depuis le bouton TopBar).

**Phase B — branchement aux données existantes**

4. `TopBar` ← `useOrchestrators()` + `api.info()` + `api.health()`. Mapping
   statut→pill décrit en §3.1.
5. `LeftPanel` :
   - MESSAGE FLOW ← `useGlobalMessageStats(orchestrators)` (S4) **ou**
     bascule sur `api.getMetricsMessages()` (S9) ;
   - PER-TEAM TRAFFIC ← `orch.msgCount` (S1) + `api.getMetricsMessages().per_orchestrator[id]` ;
   - RECENTLY ENDED ← filter `useOrchestrators()` sur `endedAt != null` ;
   - BUS HEALTH ← `api.getMetricsBus()` (S8) refresh 3 s.
6. `MapView` :
   - `layoutTeams()` : angles calculés depuis le nombre réel
     d'orchestrators (`angle = (i / N) * 2π - π/2`) ;
   - `Node` selon `session.type` et `session.role` via `ROLE_SHAPE` (§1.3) ;
   - status visuel = `enrichWithIdle(session, now)` (S6) ;
   - pulses : kind dérivé de l'event `mailbox.message` (S2) ;
   - sélection : `onSelect(sessionId)` met à jour `selectedId` (lift au
     `DesktopShell`) ;
   - hub clic : `setShowBroadcast(true)` → `BroadcastModal`.
7. `RightPanel` :
   - head + cfgline + cwd + stats + meta : voir §3.4 ;
   - actions : câbler `api.stopSession/pauseSession/resumeSession/restartSession`
     (S5), `api.destroyOrchestrator` pour STOP/KILL d'un lead ;
   - boutons sans backend (`+ WORKER`, ROTATE, REACTIVATE worker) : disabled
     + tooltip `v2` (cf. §4) ;
   - tab CONSOLE ← `Terminal.tsx` actuel, palette warm-black
     (`theme.background: '#0d0a08'`) ;
   - tab MESSAGES ← `peekInbox` + `classifyBubble` (S12) → bulle
     me/them/system/other-team ;
   - tab CONFIG ← `OrchestratorView` + `RoleView.connectors` ;
   - composer ← `api.postSessionInput` (PTY) ou
     `api.broadcastToOrchestrator` (TEAM mode), toggle INBOX en AGENT mode
     disabled v1 (cf. §4-5).
8. `Toasts` ← `useEvents()` filtré `status === 'waiting'`. `EventsPip` ←
   `useEvents.connected`. Conserver l'auto-dismiss 30 s déjà en place.

**Phase C — overlays**

9. Porter `NewOrchestratorDialog` du proto v2 par-dessus le composant
   existant (ajouter dropdown "+ create new role" et warning bypassPermissions).
10. Migrer `RolesPage` actuelle vers le layout overlay plein écran du proto
    (liste + détail + sections EDIT inline). Conserver la logique CRUD.
11. Implémenter `SettingsDrawer` (extrait de `App.tsx` actuel — token +
    About + WS status).
12. Implémenter `BroadcastModal` (workaround §4-1 : boucle
    `broadcastToOrchestrator` sur les actifs).
13. Implémenter `SpawnWorkerDialog` et `EditConfigDialog` en mode
    "preview" disabled tant que §4-2 / §4-3 ne sont pas livrés.
14. Implémenter `ConfirmModal` pour KILL / STOP.

**Phase D — animations & polish**

15. Pulses animés via `offset-path` CSS (issu de `v2/map.jsx`).
16. Spawn animation `spawningIds` (déclenché par event `session.created`).
17. `waiting` ring pulse (S3 — classe `.node-ring-pulse`).
18. Transitions ouverture/fermeture RightPanel (déjà en CSS
    `.panel-right.closed { transform: translateX(100%); }`).
19. `flash-new` sur team-pill après création.

**Phase E — mobile (futur, hors v1)**

20. Détection `window.matchMedia('(max-width: 768px)')` au boot →
    monter `MobileShell` à la place de `DesktopShell`. Code de référence :
    `prototypes/v2/mobile/` (mobile-app, mobile-sheets, mobile-shell,
    ios-frame). Hors scope de cette première intégration.

### 5.2 Composants à supprimer / réécrire

| Existant | Devenir |
|---|---|
| `OrchestratorList.tsx` | Remplacé par `DesktopShell` (mais utiliser la même hook `useOrchestrators` derrière) |
| `OrchestratorView.tsx` | Composants démantelés : header → `RightPanel head`, sessions list → noeuds dans `MapView`, terminal → `RightPanel` tab CONSOLE, `BroadcastBar` → composer du `RightPanel` (mode "team") |
| Header de `App.tsx` | Remplacé par `TopBar.tsx` |
| `NotificationPanel.tsx` | Remplacé par `Toasts.tsx` (`v2/toasts.jsx`) — même logique `useEvents`, nouveau style |
| `NewOrchestratorDialog` | Mis à jour : nouveau layout v2 + dropdown role "+ new", warning bypassPermissions |
| `RoleDialog` / `RolesPage` | `RolesPage` ré-implémentée en overlay plein écran v2 ; `RoleDialog` fusionné dans les sections EDIT inline |
| `StatusBadge.tsx` | Restylé (chip ambre/dot) — la logique `mapSessionStatusToVisual` reste |
| Settings depuis header | Déplacés dans `SettingsDrawer` (cog de la TopBar) |

### 5.3 Fichiers à porter du prototype v2

À convertir en TSX dans `src/components/desktop/` :

- `v2/app.jsx` → split entre `DesktopShell.tsx` (orchestration) et
  `TopBar.tsx`
- `v2/panels.jsx` → `LeftPanel.tsx`, `RightPanel.tsx`, `Sparkline.tsx`,
  `BigGraph.tsx`, `Composer.tsx`, `ConfigTab.tsx`, `ConfirmModal.tsx`
- `v2/map.jsx` → `MapView.tsx` (+ utils `layoutTeams`, `curveBetween`,
  `NodeShape`, `statusDotColor`, `ringClass`)
- `v2/modals.jsx` → `NewOrchestratorDialog.tsx`, `RolesPage.tsx`,
  `SettingsDrawer.tsx`, `SpawnWorkerDialog.tsx`, `EditConfigDialog.tsx`,
  `BroadcastModal.tsx`
- `v2/toasts.jsx` → `Toasts.tsx`, `EventsPip.tsx`
- `v2/icons.jsx` → `icons.tsx` (lib partagée)
- `Swarm OS v2.html` `<style>` → `src/styles/desktop-theme.css` importé
  depuis `main.tsx`
- `v2/data.jsx`, `prototypes/tweaks-panel.jsx` → **non portés** (mocks +
  outil design-time)
- `v2/data.jsx` helpers (`formatUptime`, `formatRelative`, `formatClockShort`,
  `statusLabel`, `statusChipClass`, `ROLE_SHAPE`) → portés dans
  `src/lib/format.ts` et `src/lib/roleShape.ts`

### 5.4 Risques & points d'attention

1. **Tailwind 4 vs CSS custom** : le prototype repose entièrement sur
   variables CSS et classes nommées. Cohabiter avec Tailwind est
   possible mais demande discipline (pas de purge accidentelle des
   classes custom — vérifier la conf Tailwind safelist).
2. **Performance du `MapView`** avec beaucoup de pulses : le prototype
   plafonne à 32 pulses simultanées (`p.slice(Math.max(0, p.length - 32))`).
   À conserver. Throttler `useEvents` côté client (dedupe par session+ts à
   200 ms).
3. **Boutons sans backend** : §4 liste 6 endpoints manquants pour atteindre
   la parité fonctionnelle complète. Sans eux, ce sont 6 tooltips
   "available in v2" et 6 disabled states côté UI. Documenter clairement
   l'écart.
4. **xterm.js dans la tab CONSOLE** : la palette par défaut de xterm
   jure avec la palette warm-black. Passer `theme.background: '#0d0a08'`
   (la valeur exacte du prototype v2, cf. `BACKDROPS.void` dans
   `v2/app.jsx:23`).
5. **Tests** : `OrchestratorList.test`-like et `NewOrchestratorDialog.test`
   référencent des classes Tailwind. Si on déplace les composants,
   actualiser les selectors. Les hooks (`useOrchestrators`, `useEvents`)
   sont réutilisables tels quels — c'est la garantie qui permet la
   refonte progressive.
6. **`session.writer`** : pour la pastille WRITER/READER de la tab
   CONSOLE, dériver l'info du hello frame WS (déjà fait par `Terminal.tsx`)
   et la remonter au RightPanel via callback / context. Pas besoin de
   nouveau champ serveur en v1.
7. **`stopReason` exhaustivité** : `'exited' | 'killed' | 'failed' | 'server-restart'`
   couvre la palette des `badge-reason` du proto. Vérifier que
   `interrupted` (status) et `server-restart` (reason) sont bien distincts
   et tous deux mappés.

### 5.5 Critères d'acceptation v1

- [x] Au chargement, la grille desktop (TopBar / LeftPanel / MapView /
      RightPanel fermée) est affichée.
- [x] TopBar : une pill par orchestrator actif (mise à jour 3 s),
      statut HEALTHY / DEGRADED / WAITING / STARTING / OFFLINE / BAD
      correct. `msgCount` formaté `Nk` au-delà de 999. Waiting-flag ●
      apparaît quand un worker est en `waiting`.
- [x] TopBar : bouton `+ NEW TEAM` → `NewOrchestratorDialog`,
      `ROLES` → `RolesPage`, cog → `SettingsDrawer`. Project name + version
      + uptime affichés sous le brand.
- [x] LeftPanel : MESSAGE FLOW total + delta/min + sparkline 60 pts ;
      PER-TEAM TRAFFIC sparkline par team ; RECENTLY ENDED avec badge-reason ;
      BUS HEALTH 4 valeurs (latency / throughput / queue / err rate).
- [x] MapView : hub central clickable (broadcast), 1 lead diamond par
      team + workers selon `ROLE_SHAPE`, statut visuel via
      `enrichWithIdle`, inbox badge non-zéro, waiting ring pulsant,
      SVR-RESTART label sur `interrupted`, spawn animation à la création.
- [x] Pulses 4 kinds animés selon `mailbox.message` event.
- [x] Clic sur un node → RightPanel ouvre avec head + cfgline + cwd +
      stats + meta + 5 boutons d'action + 3 tabs.
- [x] Tab CONSOLE attaché au PTY, pastille WRITER/READER affichée.
- [x] Tab MESSAGES affiche les bulles classifiées (`me/them/system/other-team`).
- [x] Tab CONFIG affiche RUNTIME (model/effort/perm/cwd/pid/started/EXIT
      REASON si applicable), LEAD PROMPT, LEAD PREAMBLE, WORKER PREAMBLE,
      CONNECTORS (Discord chip si webhook).
- [x] Composer toggle PTY/INBOX + AGENT/TEAM ; envoi PTY câblé sur
      `postSessionInput`, TEAM câblé sur `broadcastToOrchestrator`. INBOX
      en mode AGENT est disabled v1 (gap §4-5).
- [x] Boutons STOP / PAUSE / RESUME / RESTART / KILL câblés sur les
      endpoints S5. `+ WORKER`, ROTATE config, REACTIVATE en preview
      disabled (gaps §4-2, §4-3).
- [x] Confirmation modale KILL / STOP avant exécution.
- [x] Toasts SESSION WAITING bas-droite, max 5, `+N older`, auto-dismiss
      30 s, bouton OPEN navigue vers l'agent.
- [x] `EventsPip` quand aucun toast (`events :: live` ou
      `reconnecting…`).
- [x] Aucune régression dans les tests Vitest existants (ajuster les
      selectors uniquement quand le composant a été déplacé).

---

## 6. Estimation grossière

| Phase | Lot | Effort |
|---|---|---|
| A | Système de design v2 + squelette `DesktopShell` + routes | S |
| B | Branchement données (TopBar, LeftPanel, MapView, RightPanel) | M |
| C | Overlays (5 modals + drawer) | M |
| D | Animations, pan/zoom, polish | S |
| Tests | Ajustement des tests existants | S |
| E | Mobile (hors v1) | M |

Total v1 (A+B+C+D+tests) ≈ une session de dev focalisée. Les gaps §4
(6 endpoints manquants) sont des chantiers séparés ; ils n'empêchent pas
la v1 visuelle, ils dégradent seulement l'expérience aux boutons concernés.

---

## 7. Validation bidirectionnelle (2026-05-22)

### 7.1 Système → Prototype

Tous les éléments backend livrés en S1–S12 ont un emplacement v2 :

| Backend | Emplacement v2 |
|---|---|
| `OrchestratorView.msgCount` (S1) | TopBar pill `Nk msg` + LeftPanel PER-TEAM TRAFFIC |
| `mailbox.message` event (S2) | MapView pulses (4 kinds) |
| `mapSessionStatusToVisual` 5 buckets (S3) | Status-dot couleur, ring class, chip |
| `useGlobalMessageStats` ring 60 pts (S4) | LeftPanel MESSAGE FLOW sparkline |
| `POST /sessions/:id/{stop,pause,resume,restart}` (S5) | RightPanel pr-actions |
| `enrichWithIdle` 30 s (S6) | MapView status-dot, RightPanel chip |
| `OrchestratorView.health` (S7) | TopBar pill-status + pill-bar |
| `GET /metrics/bus` (S8) | LeftPanel BUS HEALTH |
| `GET /metrics/messages` (S9) | LeftPanel MESSAGE FLOW (alt) + PER-TEAM TRAFFIC sparkline |
| `formatLoadPercent` (S10) | RightPanel pr-stats LOAD cell |
| Console PTY brute (S11) | RightPanel tab CONSOLE (xterm.js inchangé) |
| `classifyBubble` 4 kinds (S12) | RightPanel tab MESSAGES bulles |
| `OrchestratorView.defaultModel/Effort/PermissionMode` | RightPanel pr-cfgline + tab CONFIG |
| `OrchestratorView.leadPreamble/workerPreamble` | RightPanel tab CONFIG |
| `RoleView.connectors[]` (Discord) | RightPanel tab CONFIG + RolesPage CONNECTORS |
| `SessionView.pid/startedAt/lastActivityAt/exitCode/stopReason` | RightPanel pr-meta + tab CONFIG EXIT REASON |
| `OrchestratorView.stopReason` (Phase 4) | LeftPanel RECENTLY ENDED badge-reason |
| Cross-team `fromOrchestratorId/Name/SessionName` | RightPanel tab MESSAGES bulle `other-team` |
| Token `X-Auth-Token` + WS ticket | SettingsDrawer |
| `info` + `health` endpoints | TopBar brand-sub + SettingsDrawer About |

✅ **Aucun élément serveur orphelin** — toute fonctionnalité backend a un
écho UI.

### 7.2 Prototype → Système

Tous les éléments visuels v2 ont une source backend identifiée, hormis :

| Élément v2 | Statut |
|---|---|
| Hub clic → `BroadcastModal` | ⚠ workaround : itérer broadcast côté client (gap §4-1) |
| `EditConfigDialog` (rotate) | ⚠ workaround : destroy+recreate (gap §4-2) |
| `SpawnWorkerDialog` REST | ⚠ workaround : broadcast au lead avec instruction MCP (gap §4-3) |
| Pastille WRITER/READER | ⚠ dérivé du hello frame WS — pas d'expo `SessionView` (gap §4-4) |
| Composer INBOX en mode AGENT | ⚠ disabled v1 (gap §4-5) |
| Bouton KILL distinct de STOP (worker) | ⚠ même endpoint, à spec si besoin (gap §4-6) |
| REACTIVATE session terminée | ⚠ workaround : recréer manuellement (gap §4-8) |

Toutes les autres surfaces visuelles sont câblables sans nouveau code
serveur.

✅ **Aucun élément visuel non-câblable** — chaque feature a au moins un
workaround documenté.

### 7.3 Conclusion

Le prototype v2 est une cible visuelle **complète** pour le backend v1 :
- 100% des fonctionnalités serveur ont un emplacement visuel ;
- 100% des fonctionnalités visuelles ont une source backend (directe ou
  via workaround documenté).

La phase 3 (intégration code) peut démarrer. Les 8 gaps résiduels du §4
sont des améliorations v2, pas des blocages.

Implémentation Phase A–D livrée 2026-05-22 ; voir
`docs/redesign-desktop/`.
