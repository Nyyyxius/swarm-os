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
  `echo.ping` MCP tool, an authenticated `/plugin-api/echo/hello` route, and a
  `configSchema` with a masked password field.
- **`examples/plugins/slack-bridge/`** — a real Slack channel connector over
  Socket Mode (npm deps `@slack/socket-mode` + `@slack/web-api`), with inbound
  channel → lead inbox and an outbound `slack.send` MCP tool.
