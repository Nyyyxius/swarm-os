# Authoring swarm-os plugins

swarm-os plugins are **in-process, hot-loaded ESM modules** that extend the
server at runtime: they can react to events, expose MCP tools to agents, serve
HTTP routes, provide channel connectors (Slack/Telegram/…), schedule work, store
data, message teams, and ship scripts for the agents to run. Install / enable /
disable / uninstall happen live — no restart, no interruption of running teams.

> **Trust model — read this first.** A plugin runs inside the swarm-os Node.js
> process with the capabilities the operator grants it. This is **not a
> sandbox.** A plugin that runs `while (true) {}` freezes the server; one that
> calls `process.exit()` kills it. Only install plugins you trust — the same bar
> as any code you `node`-run on your box. The host protects you against
> *accidental* crashes (a throw in a callback is caught, counted, and after a
> crash-loop the plugin is quarantined), not against malice.

---

## 1. Anatomy of a plugin

A plugin is a directory dropped under `/data/plugins/<name>/`:

```
/data/plugins/my-plugin/
  plugin.json          # manifest (required)
  package.json         # optional — npm deps
  node_modules/        # optional — installed deps (bundled or npm-installed)
  dist/index.js        # ESM entry (manifest.main), or index.js at the root
  agent/               # optional — scripts shipped to agents (agentAssets.dir)
```

### `plugin.json` manifest

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "displayName": "My Plugin",
  "description": "What it does.",
  "main": "dist/index.js",
  "apiVersion": 1,
  "capabilities": ["events", "mcp-tools", "http-routes"],
  "configSchema": {
    "type": "object",
    "properties": {
      "apiToken": { "type": "string", "format": "password", "title": "API token" }
    },
    "required": ["apiToken"]
  },
  "agentAssets": { "dir": "agent" },
  "connectors": [
    { "type": "my-channel", "label": "My Channel", "schema": { "type": "object", "properties": {} } }
  ]
}
```

| Field          | Notes |
|----------------|-------|
| `name`         | `^[a-z][a-z0-9-]{1,40}$`. Prefixes your routes/tools/events. Cannot be a reserved name (`team`, `swarm`, `discord`, `plugins`, `api`, `ws`, `health`, `info`, `ide`, `hooks`, `metrics`, `orchestrators`, `sessions`, `roles`, `settings`, `backup`, `preambles`). |
| `version`      | semver. Also the ESM cache-buster key. |
| `main`         | Relative path to the ESM entry (`.js`). No absolute paths, no `..`. |
| `apiVersion`   | Integer. Enable is refused if `apiVersion > HOST_API_VERSION` (currently `1`). |
| `capabilities` | What the plugin *requests*; the operator *grants* a subset in the UI. |
| `configSchema` | Optional flat JSON-Schema subset → auto-generated config form + validation. |
| `agentAssets`  | Optional `{ dir }` copied into the workspace for agents to run (see §7). |
| `connectors`   | Optional channel connector declarations (see §6). |
| `uiPanels`     | Optional UI panels rendered by the SPA as iframes (see §5, *UI panels*). |

### Entry point

```ts
import type { SwarmPlugin, SwarmPluginApi } from '@swarm-os/plugin-sdk';

const plugin: SwarmPlugin = {
  activate(api: SwarmPluginApi) {
    // register everything here; the host tears it down for you on disable
  },
  deactivate() {
    // optional — the DisposableStore already covers anything registered via api.*
  },
};
export default plugin;
```

`activate(api)` must return within **10 s** (it may be async). `deactivate()` (if
present) gets **5 s**. Everything you register through `api.*` returns a
`Disposable` **and** is auto-added to the plugin's teardown set, so a plugin that
never implements `deactivate()` is still fully cleaned up.

---

## 2. Language & dependencies

- **JavaScript ESM only.** Author in TypeScript if you like, but **pre-compile to
  JS before packaging** — the host `import()`s `manifest.main` as-is (there is no
  TypeScript/toolchain in the runtime image).
- **No native modules.** The runtime image has no compiler; a plugin requiring a
  native addon fails cleanly at `activate()` (recorded in `last_error`).
- **npm deps** are resolved from the plugin's own `node_modules` (standard ESM
  upward resolution). When installing from npm/git/upload, the host runs
  `npm install --omit=dev --no-audit --no-fund --ignore-scripts` inside the
  plugin folder. `--ignore-scripts` means legitimate postinstall steps are
  skipped — pre-build anything that needs them.
- **zod is v4.** Do **not** bundle your own zod for MCP schemas — the SDK server
  validates tool schemas with *its* instance, so build them with `api.zod`
  (`api.zod.string()`, `api.zod.object(...)`, …). zod v4's API differs from v3.
- Types come from **`@swarm-os/plugin-sdk`** (a devDependency; types-only, no
  runtime dependency on the server).

---

## 3. Lifecycle, crash isolation & epochs

| Transition | What happens |
|-----------|--------------|
| **enable** | Re-validate manifest → `import(main + '?v=<version>-<now>')` → `activate(api)` (10 s timeout). Failure → status `error`, `last_error`, HTTP 422; partial registrations are rolled back. |
| **disable** | Bump the plugin's **epoch** → `deactivate()` (5 s) → dispose everything in reverse order → remove from all registries. Instant and complete: registries are consulted per-request, so a disabled plugin's routes 404 and its tools vanish at once. |
| **reload** | Used after a permissions/config change. New MCP tools are swapped in *before* the old are removed to minimise the "unknown tool" window an agent might see mid-work. |
| **crash-loop** | Every callback runs through the host `guard()`. A throw (sync) or rejection (async) is logged, written to `last_error`, and counted. **≥5 crashes / 60 s → auto-disable** (status `crashed`) with a persisted exponential backoff; boot skips a plugin whose quarantine window is still open. |
| **epoch** | Each activation carries an epoch token. A callback still in flight after `disable()` becomes a benign no-op; a *value-returning* façade call reached through a stale epoch throws a benign `PluginDisabledError` (swallowed, not counted) rather than silently returning `undefined`. |

**Consequence for authors:** don't fight teardown. Acquire external resources
(sockets, timers, watchers) **through the API** (`api.schedule.*`,
`api.http.*`, `api.connectors.*`) so they're disposed for you. A raw socket you
open yourself won't be closed by the host — though the plugin still goes inert
(registries emptied, epoch bumped) after disable.

### ESM cache

The host never evicts the ESM module cache, so each enable leaks a bounded few
tens of KB (the module graph of that version). The cache-buster
(`?v=<version>-<Date.now()>`) guarantees a fresh module on every enable. This is
an accepted, documented trade-off — enable/disable are serialised by a per-name
lock so cycles can't race.

---

## 4. The API surface (`SwarmPluginApi`)

Every group is **capability-gated**: calling a group whose capability the
operator didn't grant throws a clear `PluginCapabilityError`. Materialised only
for `manifest ∩ granted`.

| Group | Capability | Highlights |
|-------|-----------|-----------|
| `log`, `zod`, `pluginName` | — | Always available. `zod` is the server's v4 instance. |
| `config.get()` / `config.onChange(cb)` | — | Read your validated config; subscribe to live changes (else the host reloads you on a config PUT). |
| `storage.kv` | `db-kv` | `get/set/delete/list(prefix)` string KV, namespaced to your plugin. |
| `storage.defineTable(ddl)` / `prepare(sql)` | `db-tables` | Private SQLite tables — names must start `plugin_<name'>_` (`name'` = name with `-`→`_`). |
| `events.on(kind, cb)` / `events.emit(subKind, payload)` | `events` / `events-emit` | Handlers dispatched async (off the emit path). Emitted kind is forced to `plugin.<name>.<subKind>` — you can't forge a core kind. |
| `teams` | `teams` | `list/get/create/destroy/spawnWorker/killWorker` — snapshots only, never `session_secret`. |
| `roles` | `roles` | `list/get/create/update/delete` (re-arms the scheduler on mutation). |
| `messaging` | `messaging` | `sendToSession/sendToLead/broadcast/broadcastToLeads/readInbox`. `from` shows as `plugin:<name>`. |
| `mcp.registerTool(def)` | `mcp-tools` | Exposes `<name>.<tool>` to agents (see §5). |
| `http.registerRouter` / `registerPublicRouter` | `http-routes` / `http-public` | Dynamic Express routes (see §5). |
| `notify.send(input)` / `notify.custom({title, message, level?})` | `notify` | Fire the operator's notifier (Discord webhook, …). `custom` sends a free-form alert embed titled `[plugin:<name>] <title>` — the plugin name is injected by the host, never by the caller. `level` (`info` \| `warn` \| `critical`, default `info`) maps to the embed colour (green/yellow/red); `title` ≤ 200 chars, `message` ≤ 4000, both non-empty. No-op (logged) when no webhook is configured. |
| `schedule.cron(expr, cb)` / `interval(ms, cb)` | `schedule` | croner + interval; callbacks guarded, timers unref'd. |
| `connectors.register(type, provider)` | `connectors` | Provide a channel connector type (see §6). |
| `settings.instance()` | `settings-read` | Read-only instance settings. |
| `agentAssets.basePath` | `agent-assets` | Transport-aware base path of your copied `agentAssets.dir` (see §7). |
| `host.exec(input)` | `host-exec` | Run a command on the **host** over SSH (see §4.1). ⚠️ Arbitrary host code execution — full trust; `ssh` transport only. |

### 4.1 `host.exec` — run a command on the host

```ts
const { code, stdout, stderr, timedOut } = await api.host.exec({
  argv: ['git', 'status', '--porcelain'],  // program + args (element 0 is the binary)
  cwd: '/workspace/my-repo',               // optional; /workspace + /data → host paths
  timeoutMs: 30_000,                        // optional, default 30 000, capped at 120 000
  maxOutputBytes: 1_048_576,                // optional, default 1 MiB, capped at 8 MiB
});
```

Signature: `exec(input): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>`.

Semantics:

- **`argv` is run directly** — every element is POSIX-shell-quoted before it is
  handed to the remote shell, so an argument with spaces or quotes is passed
  verbatim; there is no shell word-splitting or glob expansion on your args.
  `argv` must be non-empty; `argv[0]` resolves on the host user's login `PATH`.
- **Exit handling** — a non-zero exit is a *normal* result (`code` is set, the
  promise resolves). The promise rejects only for an infrastructure failure
  (wrong transport, or the local `ssh` binary failing to spawn).
- **Timeout** — the remote command is wrapped in the host's `timeout(1)`
  (coreutils), so after ~`timeoutMs` the process is terminated **on the host**
  (SIGTERM, then SIGKILL after a short grace). This is required: killing the
  local `ssh` client alone does **not** stop the remote process — with no PTY and
  the ControlMaster mux keeping the master connection alive, it would otherwise
  run to completion. The local `ssh` is also killed as a backstop, and the call
  resolves with `timedOut: true` and `code: null`.
- **Output cap** — stdout and stderr are each captured up to `maxOutputBytes`;
  past that the stream is truncated with a `\n[output truncated at N bytes]`
  marker. Over-limit `timeoutMs`/`maxOutputBytes` inputs are **rejected**, not
  silently clamped.
- **`cwd`** — a container path under `/workspace` or `/data` is translated to its
  host equivalent (`hostWorkspaceRoot` / `hostDataDir`); any other path is used
  as-is (assumed host-native). No PTY is allocated (never interactive).

> **⚠️ TRUST MODEL.** `host-exec` is the single most powerful capability swarm-os
> exposes: it is **arbitrary code execution on the host machine**, running as the
> SSH user, with that user's full filesystem and network reach. It bypasses every
> other capability boundary — a plugin with `host-exec` can do anything the host
> user can. Grant it **only** to plugins whose code you have audited and trust
> absolutely. It is refused outright unless swarm-os runs with the `ssh` agent
> transport (`SWARM_OS_AGENT_TRANSPORT=ssh`): under the `local` transport there
> is no separate host to reach and the call rejects with a clear error.

### 4.2 `storage.defineTable` / `storage.prepare` — private SQLite tables

`db-kv` covers a string key-value store; `db-tables` (a **separate** capability)
gives you real relational tables on the server's own SQLite database, confined to
a private namespace. Every object you create is prefixed `plugin_<name'>_` where
`name'` is your plugin name with `-` → `_` (a bare hyphen is an invalid SQL
identifier, so `slack-bridge` → `plugin_slack_bridge_`). That is exactly the
prefix the uninstall purge drops, so your tables never outlive a
`DELETE …?purge=true`.

```ts
// DDL — one CREATE, idempotent, entirely inside your prefix.
api.storage.defineTable(
  'CREATE TABLE IF NOT EXISTS plugin_myplugin_events (id INTEGER PRIMARY KEY, at TEXT, kind TEXT)',
);
api.storage.defineTable(
  'CREATE INDEX IF NOT EXISTS plugin_myplugin_events_at ON plugin_myplugin_events(at)',
);

// DML — prepared once, then run/get/all with named (@x) or positional (?) params.
const insert = api.storage.prepare('INSERT INTO plugin_myplugin_events (at, kind) VALUES (@at, @kind)');
insert.run({ at: new Date().toISOString(), kind: 'login' });

const recent = api.storage
  .prepare<{ since: string }, { kind: string }>('SELECT kind FROM plugin_myplugin_events WHERE at > @since')
  .all({ since: '2026-01-01' });
```

**`defineTable(ddl)`** accepts exactly one `CREATE TABLE` / `CREATE [UNIQUE]
INDEX` / `CREATE TRIGGER` statement — the object types the purge knows how to
drop. It is compiled with `.prepare()` (not `.exec()`), so a **single statement**
is enforced: a trailing `; DROP TABLE roles` is rejected. The statement may not
reference any table outside your prefix (so `CREATE TABLE … AS SELECT … FROM
roles` and triggers wired onto core tables are refused), and the object it
actually creates is verified — inside a transaction that rolls back on any
violation — to sit under your prefix (both its own name and the table it attaches
to). `CREATE VIEW`/`VIRTUAL`/`TEMP`, `PRAGMA`, `ATTACH`, `DROP` and `ALTER` are
all rejected.

**`prepare(sql)`** compiles one DML statement (`SELECT` / `INSERT` / `UPDATE` /
`DELETE` / `REPLACE` / `WITH`) and returns a safe `{ run, get, all }` projection —
never the raw better-sqlite3 handle. `PRAGMA`, `ATTACH`/`DETACH`, `VACUUM`, DDL
and explicit transactions (`BEGIN`/`COMMIT`) are refused, and the statement may
reference **only** tables under your prefix — reads and writes to any core table
(`roles`, `plugins`, …) or another plugin's tables throw. A statement you hold
across `disable()` becomes inert: the next `run/get/all` raises a benign
`PluginDisabledError` rather than touching the DB.

> Limits (documented, not a sandbox — plugins are trusted in-process code). The
> table guard is a conservative identifier scan: an identifier that merely
> *collides* with a forbidden table name (e.g. a column literally named `roles`)
> is rejected too, and the `ATTACH` ban is an anti-accident guard. The prefix is
> textual — `plugin_a_` is a prefix of `plugin_a_b_` (plugin `a-b`), the same
> ambiguity the purge carries; avoid plugin names where one is a `<other>-…`
> extension of another.

---

## 5. MCP tools & HTTP routes

### MCP tools

```ts
api.mcp.registerTool({
  name: 'ping',                    // exposed to agents as `<plugin>.ping`
  title: 'Ping',
  description: 'Returns a greeting.',
  leadOnly: false,                 // true → only the team lead may call it
  inputSchema: { message: api.zod.string().optional() },
  outputSchema: { reply: api.zod.string() },
  handler: (args, ctx) => ({ reply: `pong: ${args.message ?? ''} (from ${ctx.sessionName})` }),
});
```

- `ctx` is a **projection**: `orchestratorId/Name`, `sessionId/Name`, `role`,
  `isLead` — never the live handles or `session_secret`.
- Tools register into the single `team-comms` MCP server, so the per-session
  `mcp.json` covers them with no config change. **Sessions already running** pick
  up new tools only on their next restart/resume (the transport is stateless);
  the host broadcasts an informational note to leads when a plugin's tool set
  changes.

### HTTP routes — two zones

```ts
const router = api.http.createRouter();       // use the SERVER's express, not your own
router.get('/hello', (_req, res) => res.json({ ok: true }));
api.http.registerRouter(router);              // → /plugin-api/<name>/hello  (auth required)

const pub = api.http.createRouter();
pub.post('/webhook', (req, res) => { /* verify signature over req.rawBody */ res.sendStatus(200); });
api.http.registerPublicRouter(pub);           // → /public/plugins/<name>/webhook  (no auth)
```

- **Authenticated zone** `/plugin-api/<name>/*` — mounted after the
  `X-Auth-Token` gate.
- **Public zone** `/public/plugins/<name>/*` — mounted after the boot gate but
  **before** auth (inbound webhooks carry no token). **You must verify inbound
  requests yourself** (HMAC signature, etc.).

#### Raw body for webhooks

Slack/Stripe/GitHub sign the **exact wire bytes**, which `JSON.parse` discards.
The server captures them for you: use **`req.rawBody`** (a `Buffer`) to compute
the HMAC, then read the parsed `req.body` for the data. Note: only JSON bodies
are parsed — `x-www-form-urlencoded` bodies are left intact with `req.body`
undefined (read `req.rawBody`).

A route error never crashes the server: it's caught, charged to your crash
counter (epoch-aware), and answered as `500 { error: 'PLUGIN_ERROR', plugin }`.

### UI panels (`uiPanels`, feature B.3)

A plugin can surface **pages** in the swarm-os SPA. Each declared panel becomes a
navigation entry (in the **Plugins** page, under the plugin's detail) that opens
the plugin's page in a full-screen **iframe**. This is a v1: the panel is a plain
HTML page **you serve** from your authenticated HTTP zone — swarm-os does **not**
load a third-party JS bundle and does **not** inject React components.

**Manifest schema** — `uiPanels` is optional (default `[]`):

```json
"uiPanels": [
  { "id": "demo", "title": "Echo Demo", "path": "panel" }
]
```

| field   | rule |
| ------- | ---- |
| `id`    | slug `^[a-z][a-z0-9-]*$`, **unique** within `uiPanels`; also the SPA route segment |
| `title` | navigation label — non-empty, ≤ 80 chars |
| `path`  | **relative** path under your authenticated zone — no absolute path, no `..` (same anti-traversal rigour as `main`) |

`path` resolves to `/plugin-api/<name>/<path>`, so you serve the page from a
normal authenticated route:

```ts
const router = api.http.createRouter();
router.get('/panel', (_req, res) => res.type('html').send('<!doctype html>…'));
api.http.registerRouter(router);        // → GET /plugin-api/<name>/panel
```

**Lifecycle — enabled only.** Panels are surfaced in `PluginView.uiPanels` **only
while the plugin is enabled**. A disabled plugin's `/plugin-api/*` routes are torn
down (they 404), so no navigation entry is shown for it.

**Iframe authentication.** An `<iframe src="/plugin-api/<name>/…">` cannot send
the `X-Auth-Token` header the REST client uses. The SPA therefore mirrors the
token into a cookie:

```
swarm_os_token=<token>; Path=/plugin-api/; SameSite=Strict
```

and the server's auth gate accepts that cookie **as an alternative to the header,
but only for requests under `/plugin-api/`** (belt-and-suspenders with the
cookie's own path scope). Rationale:

- The swarm-os token grants full API access, so we keep it **out of URLs** (a
  `?token=` query would leak via referrer / browser history / access logs). A
  path-scoped cookie avoids that.
- `SameSite=Strict` blocks cross-site attachment ⇒ CSRF-safe; `Path=/plugin-api/`
  means the browser never sends it to `/orchestrators`, `/plugins`, etc.
- No `Secure` flag: swarm-os is commonly served over plain http (loopback /
  Tailscale), where a `Secure` cookie would silently fail to store.

A **same-origin** `fetch('./data')` from inside your panel automatically carries
this cookie, so your panel's own authenticated calls just work.

**Sandbox.** The iframe is rendered with
`sandbox="allow-scripts allow-same-origin allow-forms"` and
`referrerpolicy="no-referrer"`. `allow-same-origin` is required for the panel's
own `/plugin-api` fetches to carry the cookie; combined with `allow-scripts` it
means the panel runs with **same-origin privileges** (it can reach the app's
`localStorage`, where the token lives). That is acceptable because **plugins are
already fully-trusted in-process code** (they run in the server process, can hold
`host-exec`, etc.) — a UI panel does not widen that trust boundary. Do not install
plugins you would not already trust with the host. `allow-popups` and
`allow-top-navigation` are intentionally omitted.

**Limits (v1).** No third-party JS bundle, no injected React components — a panel
is an iframe to a page you serve. Richer host↔panel integration is future work.

---

## 6. Channel connectors

A **connector** binds an orchestrator's lead to an external channel. A role
carries a connector of some `type`; when a team of that role is created (or
resumed), the host subscribes it to the connector's provider. Inbound platform
messages land in the lead's inbox; the lead replies through whatever outbound
path you provide (typically an MCP tool).

Declare the type(s) in the manifest so the UI can render a config form and mask
secrets:

```json
"connectors": [{
  "type": "slack",
  "label": "Slack (Socket Mode)",
  "schema": {
    "type": "object",
    "properties": {
      "appToken": { "type": "string", "format": "password" },
      "botToken": { "type": "string", "format": "password" },
      "channel":  { "type": "string" }
    },
    "required": ["appToken", "botToken", "channel"]
  }
}]
```

Register a provider at `activate()`:

```ts
api.connectors.register('slack', {
  async subscribeOrch(config, sub) {
    // `config` = the role connector's config ({ appToken, botToken, channel }).
    // Open your connection; on each inbound human message:
    sub.pushToLeadInbox(text, { from: `slack:${user}`, sourceKind: 'slack', threadId });
    // `notifyLead()` is available if you want to wake the lead without pushing.
  },
  async unsubscribeOrch(orchId) { /* detach this orch */ },
  async stopAll() { /* tear down everything (called on disable) */ },
});
```

Behaviour that comes for free:

- **`pushToLeadInbox`** does `mailbox.push` + a `mailbox.message` event + an idle
  PTY wake — the same path the built-in Discord bridge uses.
- **Retroactive wiring:** enabling your plugin while teams are already running
  wires every live team whose role carries your connector type. Disabling
  detaches them (via your `stopAll`).
- **Password masking:** `format:'password'` connector fields are returned as the
  sentinel `•••` on read and preserved on write when left untouched — the token
  never leaves the server after it's first stored.

The built-in `discord` type is just a connector registered by the host — your
types sit alongside it and are chosen from the same role UI. Unknown types (no
registered provider) are rejected with `422 UNKNOWN_CONNECTOR_TYPE`.

See `examples/plugins/slack-bridge/` for a complete Socket Mode implementation
(no public URL required) with an outbound `slack.send` MCP tool.

---

## 7. Agent assets

A plugin can ship scripts/CLI for the **agents themselves** to run (in addition
to MCP tools). Declare `agentAssets: { dir: "agent" }` (capability
`agent-assets`); on enable the host copies that folder into the workspace,
preserving execute bits; on disable/uninstall it removes it.

Because the relative path depends on the agent's cwd and transport, the host
gives you the resolved, transport-aware absolute directory via
`api.agentAssets.basePath`. **Announce your scripts to leads yourself** (e.g.
`api.messaging.broadcastToLeads(...)` at activate, and/or a `<name>.help` MCP
tool) using that base path — there is no preamble/skill injection. Required
interpreters (bash/node/python) must exist in the agents' environment.

---

## 8. Config & secrets

`configSchema` is a flat JSON-Schema subset: `type: object` with
`string | number | boolean | enum` props, plus `required`, `default`, `title`,
`description`, and `format: 'password'`. It drives the auto-generated form and
validates `PUT /plugins/:name/config`.

Password fields (`format: 'password'`, string only): **GET** returns the
sentinel `•••`; a **PUT** that echoes the sentinel back keeps the stored secret.
The same mechanic protects connector password fields. Config is redacted in logs.

---

## 9. Installing

| Source | How |
|--------|-----|
| **dir / drop** | Copy the folder into `/data/plugins/<name>/`, then `POST /plugins/scan` (or the UI "Scan" button). |
| **upload** | `POST /plugins/upload?name=x` with a `.tgz` (npm-pack format), `Content-Type: application/gzip` (≤ 50 MB). |
| **npm** | `POST /plugins/install { source:'npm', spec }` — the host `npm pack`s the spec, then extracts + installs deps (avoids the sibling-hoist trap). |
| **git** | `POST /plugins/install { source:'git', url, ref? }` — shallow clone; the repo must commit compiled JS (no build at install). |
| **marketplace** | Reserved (`source_kind='registry'`, `GET /plugins/catalog`) — not yet implemented. |

**Upgrade** re-fetches the source (`npm`/`git` re-pull `source_ref`; `dir`
re-scans; `upload` returns 409 — send a fresh upload). **Uninstall**
(`DELETE /plugins/:name`) disables first, removes the folder + agent assets, and
drops the row; `?purge=true` additionally drops the plugin's KV, config, and
every private `plugin_<name'>_*` table so a later reinstall starts clean.

---

## 10. Examples

- **`examples/plugins/echo/`** — dependency-free: re-emits `mailbox.message` as
  `plugin.echo.seen`, a private KV counter, an interval heartbeat, an
  `echo.ping` MCP tool, an authenticated `/plugin-api/echo/hello` route, a
  `uiPanels` demo page served at `/plugin-api/echo/panel` (§5, *UI panels*), and
  a `configSchema` with a masked password field.
- **`examples/plugins/slack-bridge/`** — a real Slack channel connector over
  Socket Mode (npm deps `@slack/socket-mode` + `@slack/web-api`), with inbound
  channel → lead inbox and an outbound `slack.send` MCP tool.
