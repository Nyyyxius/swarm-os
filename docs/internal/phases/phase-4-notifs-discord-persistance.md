# Phase 4 — Notifs Discord + persistance

## 1. Livrable

Phase 4 ferme la boucle d'observabilité humaine. Trois axes interdépendants :

1. **Notifications Discord** via webhook (plan §12) : trois events
   surfacés (`session.waiting`, `orchestrator.ended`, `session.exit_anomaly`)
   avec embeds riches, deep-link UI **sans token**, no-op silencieux quand
   `SWARM_OS_DISCORD_WEBHOOK_URL` est absent.
2. **Persistance SQLite** des `orchestrators` + `sessions` (plan §8).
   Au boot, toute ligne non-terminale est marquée `interrupted`/`failed`
   avec `stop_reason='server-restart'`. Les PTY ne sont **pas** ressuscités.
3. **Hook endpoint** `POST /hooks/notification` (plan §13) authentifié
   par `Authorization: Bearer <HOOK_TOKEN>` (token **distinct** de
   `SWARM_OS_TOKEN`). Le `Notification` hook claude POSTe ici via le
   `settings.json` injecté dans `<dataDir>/.claude-runtime/sessions/<sid>/`.

Plus : **logging pino** (remplace `console.log`/`console.error`) avec
redaction des secrets, **`GET /sessions/:id/log`** download, et UI :
historique des orchestrateurs terminés + toast `session.waiting`.

## 2. Module map

```
packages/server/src/
├── logger.ts                                 # pino root + per-module childs (redacts)
├── index.ts                                  # boot wiring DB+notifier+recovery
├── config.ts                                 # +hookToken, +discord/publicUrl, +log* settings
├── modules/
│   ├── db/
│   │   ├── schema.sql                        # orchestrators + sessions, WAL, FK on
│   │   └── index.ts                          # SwarmDb wrapper, prepared statements
│   ├── notify/
│   │   ├── index.ts                          # Notifier interface, Notification kinds
│   │   ├── discord.ts                        # DiscordWebhookNotifier, embed builder
│   │   └── null.ts                           # NoOpNotifier
│   ├── orchestrator/
│   │   ├── persistence.ts                    # DbPersistence + NoOp + row converters
│   │   ├── index.ts                          # +deps {notifier, persistence}, end-notify
│   │   └── session.ts                        # +settings.json hook, +onStateChange CB
│   └── mcp/{server,tools}.ts                 # console.* → log.*
├── http/
│   ├── main.ts                               # mount /hooks router (Bearer-auth) before X-Auth
│   └── routes/
│       ├── hooks.ts                          # POST /hooks/notification + Bearer auth
│       ├── orchestrators.ts                  # +history list / +DB hydrate on detail
│       └── sessions.ts                       # +GET /sessions/:id/log

packages/web/src/
├── api/client.ts                             # +stopReason on OrchestratorView
├── App.tsx                                   # mount NotificationPanel
├── components/
│   ├── OrchestratorList.tsx                  # active+ended split, "server-restart" badge
│   └── NotificationPanel.tsx                 # toast stack on session.waiting events
└── hooks/useEvents.ts                        # WS /ws/events client + reconnect

packages/server/scripts/verify-phase-4.ts     # 25 checks bout-en-bout
```

## 3. Notifier (plan §12)

Interface `Notifier.notify({ kind, orchestrator, session?, message, extra? })`,
trois kinds : `'session.waiting' | 'orchestrator.ended' | 'session.exit_anomaly'`.
Deux implementations :

- `DiscordWebhookNotifier` : POST JSON sur `webhookUrl`, **timeout 5 s**
  avec `AbortController`, **swallow on failure** (`log.warn` + return).
  Embed colors :
    - `0xFFFF00` (yellow) → `session.waiting`
    - `0x00CC66` (green) → `orchestrator.ended` quand `status === 'stopped'`
    - `0xFF6666` (soft red) → `orchestrator.ended` quand `status === 'failed'`
    - `0xFF0000` (red) → `session.exit_anomaly`
  Fields : `Project`, `Orchestrator`, `Session?`, `Status`, `Exit code?`,
  `Stop reason?`. URL : deep-link `${publicUrl}/#/orchestrators/<id>`
  **uniquement si** `SWARM_OS_PUBLIC_URL` est set ; **jamais** de token
  dans l'URL.
- `NoOpNotifier` : `log.info({event:'notify.noop',...})` puis return.
  Sélectionné dans `index.ts` quand `discordWebhookUrl` est `null`.

Pas de coalescing en MVP (plan §12, §17). Le notifier est passé au Spawner
au boot ; orchestrators et sessions y accèdent via leurs deps. Tous les
sites d'appel font `void notifier.notify(...).catch(log.warn)` — Discord
ne peut **jamais** bloquer un code path orchestrator.

## 4. Persistance SQLite (plan §6 Phase 4 + §8)

`SwarmDb` ouvre `<dataDir>/swarm-os.db` via `better-sqlite3`. Pragmas
`journal_mode=WAL` + `foreign_keys=ON` posées dans `schema.sql` (avec
fallback inline pour le runtime compilé).

Tables : `orchestrators` et `sessions`. **Aucune table `messages`** —
mailbox reste 100 % en mémoire (plan §11/§17). `session_secret` n'est
**pas** persisté (régénéré au spawn — un PTY ne survit pas au restart de
toute façon).

Indexes (plan §8) :
- `sessions(orchestrator_id)`, `sessions(status)`, `sessions(ended_at)`
- `orchestrators(status)`, `orchestrators(ended_at)`

Bridge : `DbPersistence` implémente `Persistence` (`writeOrchestrator`,
`writeSession`, `recoverFromCrash`). Throttle : `lastActivityAt`-only
updates plafonnés à 1 write/seconde par session ; status / endedAt /
exitCode forcent un write immédiat. **Toute panne d'écriture SQLite est
swallow-loggée** (`db.write_failed`) — l'orchestrator continue à tourner
sur son modèle in-memory.

**Boot recovery** : `markAllNonTerminalAsInterrupted()` met à jour toute
ligne `orchestrators.status NOT IN ('stopped','failed')` →
`status='failed'`, `stop_reason='server-restart'`, `ended_at=now`. Les
sessions correspondantes basculent à `status='interrupted'`. Aucun
re-spawn (plan §6 Phase 4 — interdit).

## 5. Hook endpoint (`/hooks/notification`)

Mount **avant** le middleware X-Auth-Token dans `http/main.ts` — le hook
n'utilise jamais le token humain. Auth :

```
Authorization: Bearer <HOOK_TOKEN>
```

avec `HOOK_TOKEN` chargé depuis l'env, sinon généré et persisté à
`<dataDir>/hook-token` (mode 0600). **Jamais collapsé** avec
`SWARM_OS_TOKEN` (plan §14 — défense en profondeur, le hook token vit
dans des `settings.json` sur disque lus par claude).

Body : `{ orch_id, session_id, message, kind? }`. Validations :

- 401 si bearer absent ou erroné (`crypto.timingSafeEqual`)
- 400 si `orch_id`/`session_id` manquant ou `kind` non supporté
  (seul `'session.waiting'` est câblé en MVP)
- **200 `{ ok: true, ignored: 'orch_unknown' | 'session_unknown' }`**
  si l'orch/session est inconnu (race typique après un restart : la
  map en mémoire est vide mais le `settings.json` du boot précédent
  référence encore les anciens ids). Spike Phase 0 bis §H6 : un
  hook qui répond 4xx peut **crasher** le claude appelant — on log
  un warning `hooks.orch_unknown` / `hooks.session_unknown` et on
  rend 200 pour préserver le PTY.
- 200 happy path → émet un `session.status_changed`
  (`payload.status='waiting'`, `reason='notification-hook'`) et
  `notifier.notify({ kind: 'session.waiting', ... })` en
  fire-and-forget.

Logs : `hooks.notification` avec `orchId`, `sessionId`, `kind`,
`msgLen` — **jamais** le bearer ni le body (le `message` peut porter
des transcripts d'outils sensibles).

### settings.json par session

`Session` Phase 4 écrit, quand `hookToken` + `mainHttpPort` +
`claudeConfigRoot` sont tous fournis :

```
<claudeConfigRoot>/.claude-runtime/sessions/<id>/settings.json   (mode 0600)
```

Contenu : `{ "hooks": { "Notification": [...] } }` avec un `command`
shell qui :

1. lit le payload de Claude sur **stdin** (spike H6 confirme stdin)
2. JSON-escape le payload via `python3` (avec fallback `sed`)
3. POST à `http://127.0.0.1:<mainHttpPort>/hooks/notification` avec
   `Authorization: Bearer <HOOK_TOKEN>` et un body
   `{ orch_id, session_id, kind: 'session.waiting', message: <stdin> }`
4. Tout est `>/dev/null 2>&1 || true` — le hook ne doit pas casser
   claude si swarm-os est down.

`CLAUDE_CONFIG_DIR=<...>/.claude-runtime/sessions/<id>` est exporté à
l'env du PTY claude (la copie boot-time `~/.claude` → runtime est
laissée à Phase 5, comme prévu). Le settings.json injecté **override**
la config user existante côté hooks.

## 6. Logging (pino)

`logger.ts` instancie un root logger pino, paramétré par `Config` :

- Level depuis `SWARM_OS_LOG_LEVEL` (défaut `info`)
- Pretty-print via `pino-pretty` quand stdout est un TTY hors prod
  (override `SWARM_OS_LOG_PRETTY=0|1`)
- Stream **explicite** `process.stdout` (pas de sonic-boom direct
  fd 1) — sinon les `verify:phase*` ne peuvent pas spy le stream
- **Redact paths** : `token`, `hookToken`, `session_secret` /
  `sessionSecret`, `Authorization` / `authorization`,
  `X-Auth-Token` / `x-auth-token` / `xAuthToken`, `webhookUrl`,
  `discordWebhookUrl` (+ variants `*.foo` / casing). Censor :
  `[REDACTED]`. Base : `{ pid, project }`.

Tous les `console.log({event:'mail.send',...})` de Phase 3 ont été
remplacés par `withModule('messaging').info({...})` — module-tag
visible sur chaque ligne. Plus aucun `console.log` dans les code
paths prod (mcp, mailbox, messaging, hooks, notify, orchestrator,
persistence, http utilisent tous `withModule`). Pas de rotation
(plan §15) — `docker logs` capte stdout.

## 7. REST surface ajoutée

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/hooks/notification` | Bearer auth (HOOK_TOKEN) ; body `{ orch_id, session_id, message, kind? }`. Plan §6 Phase 4 + §13. |
| `GET`  | `/sessions/:id/log` | Auth `X-Auth-Token` ; `text/plain; charset=utf-8` + `Content-Disposition: attachment; filename="<sid>.log"`, streamé via `fs.createReadStream`. 404 si la session n'existe ni en mémoire ni en DB. **Path-traversal guard** : le chemin résolu doit rester sous `<dataDir>/logs/`, sinon 404 (défense en profondeur si la DB était corrompue). Plan §9. |

`GET /orchestrators` et `GET /orchestrators/:id` étendus :

- list = active in-memory ∪ jusqu'à 50 lignes terminées les plus
  récentes depuis SQLite (sort `ended_at desc`). Contrat de réponse
  inchangé (`{ orchestrators: [...] }`) — pas de breaking change.
- detail = lookup in-memory en premier, fallback DB hydraté avec ses
  sessions si l'orch n'est plus actif.

## 8. UI Web

- `OrchestratorList` : section "Recently ended" en bas, repliable. Badge
  `server-restart` violet quand `stopReason === 'server-restart'`. Les
  rows terminés n'ont **pas** de bouton Stop. Le `StatusBadge`
  préexistant gère déjà `interrupted` (style violet) — Phase 1 avait vu
  loin.
- `NotificationPanel` (nouveau) : monté dans `App.tsx`, écoute
  `/ws/events` via `useEvents` et surface chaque
  `session.status_changed` avec `payload.status === 'waiting'` comme
  toast amber en bottom-right. Click "Open orchestrator" navigue vers
  le détail. Indicateur live/reconnecting en bas à droite quand vide.
- `useEvents` : fetch un ticket WS via `GET /ws-ticket?type=events`
  (TTL 10 s, plan §14), ouvre `/ws/events?ticket=...`, **reconnect
  avec backoff exponentiel** (1 s → 30 s plafond, reset à 1 s sur
  open). Cleanup propre à l'unmount (cancel + `ws.close()`).

## 9. Configuration

Plan §13 — additions Phase 4 :

| Var | Défaut | Notes |
|---|---|---|
| `HOOK_TOKEN` | auto-généré | Persisté à `<dataDir>/hook-token` (0600). **Distinct** de `SWARM_OS_TOKEN`. |
| `SWARM_OS_DISCORD_WEBHOOK_URL` | `null` | Si absent → `NoOpNotifier`. |
| `SWARM_OS_PUBLIC_URL` | `null` | Si absent → embed Discord sans `url`. Jamais de token dedans. |
| `SWARM_OS_LOG_LEVEL` | `info` | `trace|debug|info|warn|error|fatal`. |
| `SWARM_OS_LOG_PRETTY` | auto (TTY+!prod) | `0|1` override. |

## 10. Recette de validation

```
pnpm install
pnpm -r build
pnpm lint
pnpm --filter server verify:phase2   # 15/15
pnpm --filter server verify:phase3   # 23/23
pnpm --filter server verify:phase4   # 25/25
```

`verify-phase-4.ts` boote un fake Discord (HTTP server local qui
capture les POST), un Spawner avec vrai `DiscordWebhookNotifier` +
`DbPersistence`, et couvre 25 cases regroupées :

- **Tokens** : `HOOK_TOKEN ≠ SWARM_OS_TOKEN` (invariant plan §14)
- **Settings.json per-session** : présence sous
  `<dataDir>/.claude-runtime/sessions/<sid>/settings.json`, mode
  `0600`, hook command embed HOOK_TOKEN + URL `/hooks/notification`
  + orch_id + session_id
- **Auth hook** : 401 sur bearer absent / erroné
- **Happy path hook** : 200 → fake Discord reçoit l'embed `Session
  waiting for attention` ; URL deep-link `https://.../#/orchestrators/
  <id>` **sans** token ; field `Project` match
  `SWARM_OS_PROJECT_NAME`
- **Spike H6 regression-guard** : `POST /hooks/notification` avec
  orch_id inconnu → **200 `{ok:true, ignored:'orch_unknown'}`**
- **DB writes** : `getOrchestrator` + `listSessions` retournent les
  rows
- **Log download** : `GET /sessions/:id/log` 200 + `Content-Type:
  text/plain` + `Content-Disposition: attachment` + contenu inclut
  le marker `[verify-phase4]` ; unknown id → 404
- **Embed dumps** : 3 kinds (waiting / ended / anomaly) printed
  pour vérif visuelle des couleurs
- **Orchestrator end** : `DELETE /orchestrators/:id` → 204 → fake
  Discord reçoit `Orchestrator ended`
- **Restart simulé** : close + insert ghost non-terminal + reopen ;
  `recoverFromCrash` retourne `{orchestrators:≥1, sessions:≥1}` ;
  ghost row a `status='failed'` (orch) / `status='interrupted'`
  (session) avec `stop_reason='server-restart'`
- **History REST** : `GET /orchestrators` contient le ghost ;
  `GET /orchestrators/:id` hydrate depuis SQLite avec ses sessions

## 11. Limites connues à reprendre Phase 5+

- **Phase 5 — Containerisation (plan §6 Phase 5 + §13)** :
  Dockerfile multi-stage, `node:24-bookworm-slim` runtime, claude
  CLI pinnée, **copie boot-time `/claude-source` (RO) →
  `<dataDir>/.claude-runtime/` (RW)**. Phase 4 écrit déjà le
  `settings.json` per-session sous cet arbre ; en dev hors
  container, Claude merge avec `~/.claude` du host. Nettoyage des
  `sessions/<id>/` à l'exit également laissé à Phase 5.
- **Phase 6 — Polish (plan §6 Phase 6)** : `SWARM_OS_TOKEN`
  auto-init avec persistance `<dataDir>/token` (Phase 4 ne fait que
  charger l'env), PWA manifest, README agent-readable.
- **Phase 7 — Tests (plan §6 Phase 7)** : suite unit/integration
  proprement dite. Les `verify:phase*` restent des harnesses
  spike-style.
- Le hook command shell utilise `python3` avec fallback `sed` pour
  JSON-escape stdin. L'image `node:24-bookworm-slim` n'inclut pas
  `python3` — à ajouter au `apt-get install` Phase 5 ou réécrire
  en node. Le fallback `sed` couvre le cas mais n'échappe pas
  parfaitement les unicode escapes.
- Pas de **rotation** des logs (plan §15). 50 MB / fichier avec
  truncate-on-open hérité de Phase 1.

## 12. Déviations du plan

- **`SWARM_OS_LOG_LEVEL` / `SWARM_OS_LOG_PRETTY`** ajoutés (non listés
  plan §13). Nécessaires pour piloter pino sans rebuild ; valeur
  défensive `info` + auto-pretty hors prod TTY.
- **Hook command via stdin (et non `$1`)** : le brief proposait `$1`
  mais le spike Phase 0 bis (H6) a confirmé que Claude pousse le
  payload sur **stdin** (`{session_id, transcript_path, cwd,
  hook_event_name, message}`). On lit donc via `cat`, JSON-escape, et
  POSTe le payload entier comme `message`. Le serveur n'introspect pas
  le contenu — il l'attache à la notif Discord.
- **Stream pino explicite (`pino(opts, process.stdout)`)** au lieu du
  default sonic-boom direct fd 1. Permet aux verify scripts de spier
  via `process.stdout.write`. Aucun impact runtime — `docker logs`
  capte le stdout du container quoi qu'il arrive.
- **Embed glyphes textuels (`[WAIT]`, `[END]`, `[FAIL]`)** plutôt que
  les emojis du plan §12. Discord rend les emojis en titre embed
  inégalement selon le client (mobile vs desktop) ; le préfixe texte
  est universel et survit au copy-paste dans des canaux text-only.
- **`writeOrchestrator(orch)` appelé deux fois dans `Spawner.create`**
  (avant et après `start()`). Le second write capte une éventuelle
  transition immédiate `starting → failed` (lead spawn fail). Pas une
  régression de perf — c'est `INSERT ... ON CONFLICT UPDATE`, deux
  writes triviaux.
