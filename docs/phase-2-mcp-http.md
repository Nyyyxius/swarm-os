# Phase 2 — MCP HTTP via le SDK officiel

## 1. Livrable

Phase 2 lève en service le serveur MCP `team-comms` consommé par chaque
session Claude. L'implémentation utilise le SDK officiel
`@modelcontextprotocol/sdk` (v1.29) et le transport **Streamable HTTP**.
Un nouveau listener HTTP — strictement **bind 127.0.0.1** sur
`SWARM_OS_MCP_PORT` (défaut 8788) — répond à
`POST/GET/DELETE /mcp/:orch_id/:session_secret`. Chaque session voit le MCP
via `--mcp-config <path>` ; le `mcp.json` est généré juste avant le spawn
PTY (mode `0600`) et nettoyé à l'exit. Cette phase implémente uniquement
les outils **lecture seule** `team.whoami` et `team.list` ; les six autres
outils du plan §10 sont enregistrés comme placeholders Phase 3 qui
remontent une `McpError` propre, pour que le contrat soit visible à
`tools/list` mais qu'aucune action ne soit feinte.

## 2. Module map

```
packages/server/src/
├── modules/
│   ├── mcp/
│   │   ├── server.ts            # Listener HTTP loopback + routing path-auth + per-request SDK
│   │   └── tools.ts             # registerTeamCommsTools — 2 outils Phase 2 + 6 placeholders Phase 3
│   └── orchestrator/
│       └── mcp-config.ts        # write/remove du mcp.json par session (mode 0600)
├── config.ts                    # +mcpPort, +mcpRuntimeDir
├── index.ts                     # boot McpServer + signal handlers (SIGINT/SIGTERM ferment les deux)
└── modules/orchestrator/
    ├── session.ts               # buildClaudeArgs(--mcp-config), génère + nettoie le mcp.json
    └── index.ts                 # passe mcpRuntimeDir/mcpHost/mcpPort à new Session(...)
packages/server/scripts/
└── verify-phase-2.ts            # tests directs MCP (skipSpawn, sans claude réel)
```

## 3. Surface MCP exposée

Endpoint unique :

| Méthode             | Route                                  | Description                                                                 |
|---------------------|----------------------------------------|-----------------------------------------------------------------------------|
| `POST/GET/DELETE`   | `/mcp/:orch_id/:session_secret`        | Streamable HTTP transport (SDK), bind `127.0.0.1` du container uniquement   |

Auth : `(orch_id, session_secret)` dans le path. Pas de token humain. Toute
combinaison invalide → **HTTP 404** avec body `not found` — sans révéler si
`orch_id` existe (plan §14 : "ne jamais leak l'existence").

Outils enregistrés (`tools/list`) :

| Outil                       | Phase | Comportement                                                            |
|-----------------------------|-------|-------------------------------------------------------------------------|
| `team.whoami`               | 2     | `{}` → `{ session_id, name, role, type, is_lead }`                      |
| `team.list`                 | 2     | `{}` → `{ members: [{ session_id, name, role, type }] }` (actifs only)  |
| `team.send_message`         | 3     | Placeholder — `McpError -32601 "not implemented in Phase 2"`            |
| `team.read_inbox`           | 3     | idem                                                                    |
| `team.broadcast`            | 3     | idem                                                                    |
| `team.spawn_worker`         | 3     | idem (lead-only à terme)                                                |
| `team.kill_worker`          | 3     | idem                                                                    |
| `team.kill_all_workers`     | 3     | idem                                                                    |

Aucune réponse ne contient `session_secret`. `team.list` est scopée à
l'orchestrateur appelant (pas de cross-orch leak).

## 4. Idiome SDK retenu : per-request `McpServer` + transport stateless

Le SDK 1.29 (`@modelcontextprotocol/sdk/server/streamableHttp`) supporte
deux modes :

- **Stateful** : `sessionIdGenerator: () => randomUUID()` — le serveur
  attribue un `mcp-session-id`, tient l'état en mémoire entre requêtes.
- **Stateless** : `sessionIdGenerator: undefined` + `enableJsonResponse:
  true` — chaque requête est traitée indépendamment.

Phase 2 retient **stateless + per-request** (`new SdkMcpServer(...)` à
chaque appel) :

- Les outils `whoami` / `list` sont des lectures synchrones — pas de
  notifications serveur-poussées à diffuser, donc aucune raison de
  maintenir un transport SSE persistant.
- Pas de fuite possible si un PTY claude meurt en plein appel : transport
  + serveur SDK sont scoppés à la requête HTTP.
- Aucun map à maintenir entre `session_secret` et instance SDK.

Phase 3 pourra promouvoir vers per-session (un `McpServer` SDK de longue
durée par couple `(orch_id, session_id)`) si `team.send_message` veut
streamer des notifications "new message" via SSE. Le code est structuré
pour rendre cette promotion locale au fichier `server.ts`.

## 5. Schéma `mcp.json` figé en Phase 0 bis

Source de vérité : `scripts/verify-claude-code.report.md` (H4).

```json
{
  "mcpServers": {
    "team-comms": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp/<orch_id>/<session_secret>"
    }
  }
}
```

Localisation : `<SWARM_OS_MCP_RUNTIME_DIR>/orch-<orch_id>/session-<session_id>/mcp.json`
(défaut runtime dir : `/tmp/swarm-os`). Permissions (plan §14) :

- Racine `mcpRuntimeDir` : `0700` (mkdir + chmod défensif au boot dans `loadConfig`).
- Dossier session : `0700` (chmod défensif après `mkdir`).
- Fichier `mcp.json` : `0600` (`openSync('w', 0o600)` puis chmod défensif).

Cycle de vie : créé dans `Session._spawn` **avant** le PTY (même en
`skipSpawn`), `unlink()` au `_handleExit`, au `stop()` quand l'agent
n'a jamais démarré, et au catch du spawn fail. `Orchestrator.stop()`
diffuse `session.stop()` à toutes les sessions, ce qui propage le
cleanup. Le `rmdir` du dossier session est best-effort (ENOTEMPTY
toléré pour des artefacts futurs).

## 6. `buildClaudeArgs` — argv résultant

Phase 1 produisait `[--model, --effort, --permission-mode, prompt]`.
Phase 2 ajoute le flag MCP **avant** le prompt :

```
--model <model> --effort <effort> --permission-mode <mode> --mcp-config <path> [<prompt>]
```

Tous ces flags sont confirmés par le spike Phase 0 bis (`docs/phase-0-bis-spike.md`
§5) — en particulier `--effort` et **pas** `--max-thinking-tokens` (H5).
`mcpConfigPath` est optionnel pour le code de test ; en prod, il est
toujours fourni (généré dans `_spawn`). En cas d'échec d'écriture du
mcp.json (`/tmp` indisponible), le PTY est lancé sans MCP plutôt que de
crasher la session — un log `mcp.config.unlink_failed` (et un `console.error`
côté write) signale l'incident.

## 7. Posture sécurité Phase 2

Référence : plan §14 + "Notes pour les agents".

- **Bind loopback hard-codé.** Le host MCP n'est PAS configurable par env :
  l'option `SWARM_OS_MCP_PORT` ne change que le port, jamais l'adresse.
  Le code de `McpServer.start()` fait deux assertions :
    1. avant `listen()`, vérifie que la constante `host` ∈ `{127.0.0.1, ::1, localhost}`
    2. après `listen()`, vérifie via `http.address()` que l'adresse réelle
       est dans le même set, sinon `close()` + reject (fail fast).
- **404 indiscriminé.** Mauvais secret OU orch inexistant produisent le
  même `HTTP 404 not found`. Le body ne contient pas l'`orch_id`.
- **`session_secret` jamais loggé.** Le helper `redactSecret()` n'expose
  que les 4 premiers caractères. La `ToolContext` passée aux callbacks
  ne contient PAS le secret (juste `(orchestrator, session)` ; l'attribut
  `session.sessionSecret` existe mais aucun chemin de log ne l'imprime).
- **Pas de CORS sur le listener MCP.** Pas d'header `Access-Control-*` —
  loopback only, pas d'origin browser à autoriser.
- **Aucune modification de `auth.ts`.** Le middleware HTTP humain reste
  intact ; le MCP a son propre modèle d'auth (path-based secret) sur un
  listener distinct.
- **Logs structurés.** Format `{ event, tool, sid, orch, ok }` sur stdout
  (pino arrive Phase 4). Pas de body request/response loggé. Pas de
  `session_secret` même tronqué dans les logs `mcp.call`.

### Limites connues Phase 2

- Tout processus dans le container qui devine `(orch_id, session_secret)`
  peut appeler `team.*` au nom d'une session — atténuation par UUID v4 +
  bind loopback (cf. plan §14 "Limites connues du modèle de sécurité").
- Pas de rate-limit sur l'endpoint MCP. Cap dur sur la taille du body :
  1 MiB par requête, au-delà → erreur de parse JSON du transport.

## 8. Configuration

Sous-ensemble du tableau plan §13 reconnu en Phase 2 (additions sur
Phase 1) :

| Var                         | Défaut         | Notes                                                                  |
|-----------------------------|----------------|------------------------------------------------------------------------|
| `SWARM_OS_MCP_PORT`         | `8788`         | Port d'écoute du listener MCP. Bind hardcodé `127.0.0.1`.              |
| `SWARM_OS_MCP_RUNTIME_DIR`  | `/tmp/swarm-os`| Racine pour les `mcp.json` per-session (mode `0600`).                  |

Pas de variable pour l'adresse MCP — voir §7.

## 9. Validation

Commande unique :

```
pnpm --filter server verify:phase2
```

Le script `packages/server/scripts/verify-phase-2.ts` boote en in-process
un `Spawner` + `McpServer` sur les ports `18787/18788`, crée un
orchestrateur avec `skipSpawn=true` (pas de `claude` requis), puis utilise
le client MCP officiel (`@modelcontextprotocol/sdk/client`) pour exercer :

1. Connexion + `tools/list` → 8 outils (2 implémentés + 6 placeholders).
2. `tools/call team.whoami` → métadonnées du lead, pas de `session_secret`
   dans la réponse.
3. `tools/call team.list` → 1 membre actif (le lead).
4. `tools/call team.spawn_worker` → `isError: true`, message contenant
   "not implemented".
5. Mauvais `session_secret` → `HTTP 404` body `not found`, pas de leak
   d'`orch_id`.
6. Orch inexistant → `HTTP 404` (même réponse).
7. Vérification du `mcp.json` : existence, permissions `0600`, schéma
   `{ mcpServers: { team-comms: { type: 'http', url } } }`, `session_secret`
   présent uniquement dans l'URL.
8. `spawner.destroy(...)` → `mcp.json` unlinked.

Total : **15/15** checks PASS au commit de référence.

### Validation manuelle via `claude` réel (optionnelle)

Le script ne lance pas `claude` pour rester déterministe et ne pas
consommer de quota. Recette manuelle quand on veut le faire bout-en-bout :
boot serveur normal (Phase 1 setup), `POST /orchestrators` avec un prompt
qui force l'appel (`"Call team-comms MCP tool team.whoami and print the
JSON, then stop."`), puis `tail -f` du log session — on doit voir
`mcp.call tool=team.whoami` côté serveur et la réponse JSON côté PTY.

Vérif réseau côté host (en-dehors du container) :

```bash
ss -tnlp | grep 8788   # attendu : 127.0.0.1:8788, JAMAIS 0.0.0.0:8788
```

## 10. Déviations de plan

- **`SWARM_OS_MCP_RUNTIME_DIR`** ajouté (défaut `/tmp/swarm-os`). Non
  listé en plan §13 : le plan dit "fichiers `mcp.json` temporaires dans
  `/tmp/swarm-os/...`, mode `0600`" sans nommer la variable. Exposer un
  override est utile pour tests + futurs containers où `/tmp` peut être un
  tmpfs alternatif. Pas de risque sécu — c'est un chemin filesystem
  privilégié.
- **MCP SDK : `registerTool` (et non l'API "low-level")**. Le plan parlait
  d'"implémenter `tools/list`" et d'"implémenter `tools/call`" comme deux
  étapes distinctes. Le SDK officiel les couvre via une seule API
  déclarative (`registerTool(name, config, callback)`) qui génère
  `tools/list` automatiquement. C'est explicitement autorisé par la
  consigne Phase 2 ("Si l'API du SDK diffère du plan, suivre le SDK").
- **Per-request `McpServer` + transport stateless** plutôt que per-session
  persistant (cf. §4). Décision documentée et locale au fichier `server.ts`.
- **Schéma outils en zod, pas JSON Schema brut.** Le SDK accepte les deux ;
  zod offre l'inférence de type côté serveur sans duplication. Output
  schemas typés sur `whoami` / `list`, input schemas sur les placeholders
  Phase 3 pour matérialiser le contrat.
- **`team.spawn_worker`/`kill_*` sont enregistrés en Phase 2** (placeholders
  qui throw `McpError`). Le plan ne le précisait pas explicitement, mais
  c'est demandé par le brief Phase 2 et c'est le bon design : un agent
  curieux qui appelle `team.spawn_worker` reçoit un message clair plutôt
  qu'un cryptique "tool not found".

## 11. Limites connues Phase 2 (à reprendre Phase 3+)

- Pas de mailbox, pas de workers, pas de `team.send_message` — Phase 3.
- Pas de permissions différenciées lead/worker (les placeholders
  rejettent tout — à raffiner Phase 3 quand `spawn_worker` deviendra
  lead-only).
- **Pas de timeout sur les callbacks d'outil.** Acceptable en Phase 2
  parce que `whoami`/`list` sont synchrones et O(n) sur les sessions
  d'un orchestrateur ; à reconsidérer Phase 3 quand `send_message`
  pourra impliquer une injection PTY.
- Cycle de vie `mcp.json` lié à `Session.stop()` — Phase 3 (mailbox +
  workers spawnés via MCP) demandera de resserrer les invariants
  (fenêtre entre `spawn_worker` et la première écriture de mcp.json).
- Pas de pino structuré sur les logs MCP — `console.log({event:'mcp.call',...})`
  en attendant Phase 4.
- Pas encore d'isolation `CLAUDE_CONFIG_DIR` par session (Phase 5) — le PTY
  claude lancé hérite toujours du `~/.claude` du host.
- Pas de tests automatisés pour le bind loopback (l'assertion runtime
  fait foi). Phase 7 pourra écrire un unit test qui mock `http.address()`
  pour exercer le chemin de rejet.
