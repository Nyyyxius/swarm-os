# Agent providers — running agents on four CLIs

swarm-os used to have exactly one kind of agent: a `claude` process. The binary
was hard-coded, the argv was Claude Code's, and the model list was a constant.
An **agent provider** is the abstraction that broke that assumption. Today the
server ships four built-in adapters:

| id | label | CLI | models addressed |
|---|---|---|---|
| `claude` | Claude Code | `claude` | Anthropic |
| `codex` | OpenAI Codex | `codex` | OpenAI |
| `gemini` | Gemini CLI | `gemini` | Google |
| `opencode` | OpenCode (OpenRouter) | `opencode` | anything on OpenRouter |

The provider is chosen **per team** (the team default) **and per agent** (a
worker may override it), so a Claude lead with Gemini workers — or the reverse
— is a supported shape, not a hack.

> Every technical claim in this document is backed by the adapter source
> (`packages/server/src/modules/providers/`) or by one of the three spike
> reports that paid for it: `scripts/verify-codex.report.md`,
> `verify-gemini.report.md`, `verify-opencode.report.md`. §7 states plainly
> what those spikes could *not* prove.

---

## 1. What a provider actually is

An agent is a **CLI process running in a PTY**, driven by a `Session`
(`modules/orchestrator/session.ts`). The session owns the parts that are the
same for everyone — the log, the idle heuristic, the mailbox signals, the
context resets — and delegates everything CLI-specific to an adapter
implementing `AgentProvider` (`modules/providers/types.ts`).

An adapter answers four questions:

1. **How is this CLI isolated per session?** Each session gets its own config
   root (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, opencode's
   `XDG_*` set) so two agents never share one identity, one MCP URL or one
   state database.
2. **How does it reach team-comms?** The swarm's MCP server is the product: an
   agent that cannot call `team.*` is not a member of the team. Every adapter
   must be able to mount it over **streamable HTTP**, with the per-session
   secret carried in the URL path.
3. **How does its role survive a context reset?** The preamble must live in a
   channel that a `/clear` cannot wipe — a system prompt, a memory file, an
   instructions file. An agent that keeps its tools and loses its mailbox
   discipline looks alive and behaves at random.
4. **What is its argv and environment?**

The contract has three phases, in the order `Session` already used:

- **Phase A — `prepareSessionConfig`** (session constructor, before the log is
  opened): create the 0700 config dir, symlink the shared host credentials,
  pre-accept the folder-trust dialog, write the notification hook and the
  durable preamble.
- **Phase B.1 — `writeMcpConfig`** (at spawn, into the open log): write the
  team-comms wiring — a standalone `mcp.json` for claude, a merged block in the
  per-session config file for codex/gemini, nothing on disk at all for
  opencode.
- **Phase B.2 — `buildSpawn`** (pure, no I/O): argv + environment.

Two details carry weight. First, adapters write to **container** paths and
reference them through an `AgentPathMapper`: `paths.data()` for anything the
server wrote, `paths.workspace()` for anything the *agent* resolves (its cwd,
and every trust key derived from it). Under SSH the two bind mounts translate
differently and a wrong choice does not throw — the agent simply re-opens a
trust dialog nobody can see. Second, secrets go in `PreparedSpawn.secretEnv`,
never in `env`: under SSH `env` lands on the remote command line and is
world-readable through `ps`, while `secretEnv` is written to a 0600 file the
remote shell sources.

---

## 2. The four adapters, side by side

| | claude | codex | gemini | opencode |
|---|---|---|---|---|
| Binary | `claude` | `codex` | `gemini` | `opencode` |
| Config isolation | `CLAUDE_CONFIG_DIR=<sd>` | `CODEX_HOME=<sd>` | `GEMINI_CLI_HOME=<sd>` — treated as a `$HOME`, so the real config is `<sd>/.gemini/` | `OPENCODE_CONFIG_CONTENT` (inline JSON) + a private `XDG_{CONFIG,DATA,CACHE,STATE}_HOME` |
| Per-session dir | `<runtimeRoot>/sessions/<id>` — **kept** on exit | `<dataDir>/.codex-runtime/sessions/<id>` — deleted | `<runtimeRoot>/gemini-sessions/<id>` — deleted | `<runtimeRoot>/opencode/<id>` — deleted |
| Shared host state | symlinks: `.credentials.json`, `history.jsonl`, `projects`, … | symlinks: `auth.json`, `installation_id`, `models_cache.json`, `memories`, `rules`, `skills`, `plugins` (**never** the SQLite files) | symlinks: `oauth_creds.json`, `google_accounts.json`, `installation_id` | none — the OpenRouter key is env-only |
| Model | `--model M` | `-m M` | `-m M` | `--model openrouter/<vendor>/<model>` |
| Effort | `--effort E` | `-c model_reasoning_effort=<mapped>` (`max` → `xhigh`) | **no equivalent** | **no equivalent** |
| Permissions | `--permission-mode P` (6 modes) | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` | `--auto` **and** `"permission": "allow"` |
| team-comms MCP | `--mcp-config=<file> --strict-mcp-config` | `[mcp_servers.team-comms] url = …` in `config.toml` | `mcpServers["team-comms"] = { httpUrl, trust: true, timeout }` in `settings.json` | `mcp.team = { type: "remote", url }` in the inline config |
| Durable preamble | `--append-system-prompt` | `<sd>/AGENTS.md` | `<sd>/.gemini/GEMINI.md` | `instructions: ["<sd>/SWARM_ROLE.md"]` |
| Folder trust | seeded `.claude.json` | `[projects."<cwd>"] trust_level = "trusted"` | `.gemini/trustedFolders.json` = `{"<cwd>": "TRUST_FOLDER"}` | none — opencode has no trust gate |
| Notification channel | `settings.json` → `hooks.Notification` | `notify = ["<sd>/notify.sh"]`, payload in **argv[1]**, stdin empty | `settings.json` → `hooks.AfterAgent` | `--port` HTTP control plane, `GET /event` (SSE) — **not consumed today** |
| Semantics | `needs-human` | `turn-complete` | `turn-complete` | *none* |
| Compact token | `/compact` | `/compact` | `/compact` (alias of `/compress`) | `/compact` |
| Clear token | `/clear` | `/new` (keeps the scrollback) | `/clear` | `/clear` |
| PTY submit | two-step: text, then a lone `\r` at +150 ms | two-step | two-step | single write is enough |
| MCP tool naming | `team.whoami` (canonical kept) | `team_whoami` | `mcp_team-comms_team.whoami` | `team_team_whoami` |
| Context usage (monitoring) | transcript `.jsonl` — path via `SessionStart` hook, last main-chain assistant `message.usage` (`verify-claude-sessionstart.report.md`) | rollout `.jsonl` in the live `CODEX_HOME` — `last_token_usage.total_tokens` / `model_context_window`, keyed on the notify `thread-id` (`verify-codex-rollout.report.md`) | **none** (excluded by design) | control plane HTTP — `tokens.total` of the last *completed* assistant message, session re-resolved every poll; **local only** (`verify-opencode-tokens.report.md`) |

Notes the table cannot hold:

- **Why some flags are mandatory rather than preferences.** Without
  `--dangerously-bypass-approvals-and-sandbox`, codex answers `user cancelled
  MCP tool call` on every team-comms call. Without the trust entry, the codex
  and gemini TUIs block on a modal and emit nothing further — the session looks
  merely "busy", forever. Without `--auto`/`"permission": "allow"`, opencode
  freezes on an `Allow once / Reject` dialog while emitting **0 bytes per
  second**, which is byte-for-byte indistinguishable from an idle agent.
- **Banned channels.** `model_instructions_file` (codex) and `GEMINI_SYSTEM_MD`
  (gemini) *replace* the base system instructions instead of appending: the
  agent loses its tool protocol. Neither is ever written. Codex's
  `experimental_instructions_file` is deprecated and ignored outright.
- **Codex's `[hooks]` table is not usable unattended**: config-declared hooks
  wait for an interactive review ("N hooks need review") and never run.
  `notify` is the only working signal, which is why it is a shell script rather
  than a settings key.
- **Gemini's `Notification` event never fires** under `--yolo`: its only
  trigger is a tool-permission request, which `--yolo` removes. `AfterAgent` is
  the event gemini's own `hooks migrate` maps Claude's `Stop` onto, and it is
  what the adapter writes. The shell command itself is claude's, byte for byte
  — gemini's stdin payload is Claude-Code-compatible.
- **Gemini auto-update is disabled explicitly** (`general.enableAutoUpdate` and
  `enableAutoUpdateNotification`, both `true` by default): otherwise gemini
  shells out to `npm install -g` at boot and prints into the PTY.
- **A steering hint on a reset is not universal.** `team.context_compact`
  accepts an optional `reason`, which claude and gemini receive appended to the
  slash command. codex and opencode get the **bare** token: neither was
  verified to accept a free-text argument, and a slash command their palette
  rejects would leave the compaction silently undone — a worse outcome than a
  generic summary.
- **Gemini credentials are symlinked, not copied.** A copy has no readable
  source under SSH (the host's `~/.gemini` is not mounted into the container),
  so the session would start with no credentials at all. The symlink also keeps
  one shared refresh token instead of N copies that revoke each other.

---

## 3. Capabilities, and what they cost you

`GET /providers` publishes a `capabilities` object per provider, and the UI
greys out what a CLI cannot express instead of sending a flag that does
nothing. Two of them — `effort` and `notificationHook` — change how a team
behaves and should be read before choosing a provider.

### `effort` — false for gemini and opencode

There is no CLI equivalent of `--effort` on either. Gemini exposes a reasoning
budget only as a per-model settings value (`thinkingConfig.thinkingBudget`),
and opencode's `--variant` exists on the one-shot `opencode run`, not on the
interactive TUI. The EFFORT control is disabled for those two providers; the
value stored on the agent is inert.

Note also that effort is **not comparable across providers**: claude's
`--effort xhigh` and codex's `model_reasoning_effort = "xhigh"` are not the
same button, and codex's sandbox is not claude's permission mode. No attempt is
made to unify the vocabularies — the mapping is documented in each adapter and
that is all.

### `notificationHook` — three meanings, one endpoint

All providers that have a callback POST to the same `/hooks/notification`
route. What the callback *means* is not the same, so the route branches on the
session's provider (`http/routes/hooks.ts`):

| Semantic | Providers | What the server does |
|---|---|---|
| `needs-human` | claude | badge → `waiting`, Discord notification, `SWARM_OS_COMPACT_ON_WAITING` armed |
| `turn-complete` | codex, gemini | logged, **and nothing else** |
| *none* | opencode | nothing at all |

Codex's `notify` and gemini's `AfterAgent` fire at **every turn boundary**,
whether or not anybody is needed (gemini's fires even on a turn that failed).
A lead that runs twenty turns produces twenty callbacks; routing those to the
badge would mean twenty "waiting" alerts and twenty armed compactions for an
agent nobody is waiting on.

**The operator-visible consequence, stated rather than hidden:**

- a codex, gemini or opencode session **never reaches the `waiting` state**;
- "agent is waiting" Discord notifications never fire for it;
- **`SWARM_OS_COMPACT_ON_WAITING` does nothing for it.**

This is an accepted degradation, not a bug: those CLIs have no "I am blocked on
a human" signal to give. The knob that still works for every provider is
`SWARM_OS_AUTO_COMPACT_BYTES`, which arms a `/compact` once a session has
produced that many bytes since its last reset and fires it at the next idle
boundary. If you rely on compaction, use the volume-driven one.

The UI carries the same statement per provider, so it is visible in the
team-creation dialog rather than discovered while wondering why a team looks
silent.

### `permissionModes` — one entry means "not a choice"

Only claude has a permission vocabulary (`auto`, `acceptEdits`,
`bypassPermissions`, `default`, `dontAsk`, `plan`). The other three declare a
single mode, `bypassPermissions`, which is also their `fallbackPermissionMode`:
whatever mode is requested is coerced onto it. A one-element list is the
machine-readable way of saying "this provider runs unattended, full stop".

### `inkSubmitDance` — PTY cadence

claude, codex and gemini all absorb a `\r` that arrives in the same write as
the text (an Ink/ratatui composer treats the chunk as a paste), so the server
writes the text and a **lone carriage return 150 ms later**. opencode submits
either way, so it gets a single write. Nothing an operator configures — it is
here because it explains why an injected line sometimes appears in the composer
without being sent when a CLI changes its TUI.

### `durablePreamble` and `httpMcp` — mandatory

The registry refuses to expose an adapter that does not declare both. A
provider whose role can be wiped by `/clear` would produce an agent with tools
and no discipline; a provider that cannot mount team-comms is not a swarm
member at all.

### MCP tool renaming

Three of the four CLIs rename MCP tools before showing them to the model, so
the preamble must name them in the rewritten form or the agent is told to call
tools that do not exist:

| provider | `team.whoami` reaches the model as |
|---|---|
| claude | `team.whoami` (canonical name kept — see below) |
| codex | `team_whoami` |
| gemini | `mcp_team-comms_team.whoami` |
| opencode | `team_team_whoami` |

`modules/orchestrator/preamble.ts` is the only consumer: it rewrites the tool
names in both the default preamble and the operator's override, and appends a
short "tool naming on this runtime" note for the three providers that rename
anything. Everywhere else in the codebase — the MCP server registration, the
logs, the `[swarm-os] …` lines injected into the PTY — the canonical dotted
name stays the identifier.

Claude is deliberately given the canonical names even though Claude Code
itself exposes MCP tools as `mcp__<server>__<tool>`: that is the rendering with
a production track record, and changing it would rewrite every claude preamble
for a benefit nothing has measured.

---

## 4. Host prerequisites

**Multi-provider assumes the SSH transport** (`SWARM_OS_AGENT_TRANSPORT=ssh`),
where the CLI process is launched on the host rather than inside the container
and **reuses the host's own credentials**. The rule is then the same for all
four: the CLI must be *installed* and *logged in* on the host the agents run
on. swarm-os ships no API key for any of them.

Under the `local` transport the agents run in the container, whose image
carries **only the Claude Code CLI** — the other three report themselves
unavailable, which is the correct outcome rather than something to work around.

| provider | install on the host | authenticate | swarm-os side |
|---|---|---|---|
| claude | `npm i -g @anthropic-ai/claude-code` | `claude` (OAuth once) → `~/.claude/.credentials.json` | `SWARM_OS_HOST_CLAUDE_DIR` |
| codex | `npm i -g @openai/codex` | `codex login` → `~/.codex/auth.json` | `SWARM_OS_HOST_CODEX_DIR` |
| gemini | `npm i -g @google/gemini-cli` | `gemini` (OAuth once) → `~/.gemini/oauth_creds.json`, **or** an API key | `SWARM_OS_HOST_GEMINI_DIR` + `SWARM_OS_GEMINI_AUTH_TYPE` |
| opencode | `npm i -g opencode-ai` | *no CLI login* — the OpenRouter key is passed per process | Settings ▸ OPENROUTER |

### The `SWARM_OS_HOST_*_DIR` trap

Those four variables tell the adapters where the host's real state directory
is, because the per-session config dir points its credential symlinks there.
Their default is derived from **the container's** home (`os.homedir()`, i.e.
`/home/node`), which under SSH is a path that does not exist on the host. The
symlinks then dangle, the agent boots without complaint, and the first turn
fails on an authentication error.

The same trap already existed for `SWARM_OS_HOST_CLAUDE_DIR`; it now has three
siblings. Set them explicitly in the compose service:

```yaml
environment:
  SWARM_OS_HOST_CLAUDE_DIR: ${HOME}/.claude
  SWARM_OS_HOST_CODEX_DIR: ${HOME}/.codex
  SWARM_OS_HOST_GEMINI_DIR: ${HOME}/.gemini
  SWARM_OS_HOST_OPENCODE_DIR: ${HOME}/.opencode
```

`environment:` is an **explicit allow-list**: a variable that is not named
there never reaches the process, whatever the `.env` file says.

### gemini: say which authentication the host uses

`SWARM_OS_GEMINI_AUTH_TYPE` (`oauth-personal` | `gemini-api-key` | `vertex-ai` |
`compute-default-credentials`) is written verbatim into each session's
`security.auth.selectedType`.

It exists because gemini has no "use whatever works" mode — leaving the value
unset opens the auth-method picker, an Ink modal that repaints for ever, so the
agent is never idle, never receives a team message and is never context-reset.
A value must be chosen, and under the `ssh` transport **the container cannot
choose it correctly**: the host's `~/.gemini` is not mounted, so whether
`oauth_creds.json` exists there is unknowable, and the per-session symlink is
created either way (a dangling link is indistinguishable from a live one
without resolving it on the host).

Unset, the adapter picks:

| transport | choice |
|---|---|
| local | `oauth-personal` when `<host gemini dir>/oauth_creds.json` really resolves, `gemini-api-key` otherwise |
| ssh | `gemini-api-key`, with a `session.gemini_auth_unverified` warning naming this variable |

The ssh default is the *loud* failure, not the correct one. Measured on gemini
0.52.0: a wrong `oauth-personal` drops out of the TUI to `Enter the
authorization code:` and then goes silent — the PTY is quiet, so the agent reads
as idle and its messages are typed into an auth prompt; a wrong
`gemini-api-key` keeps the TUI up and ends every turn with a visible
`✕ [API Error: …]`. **If the host is logged in with a Google account, set this
variable to `oauth-personal`** — otherwise its credentials go unused.

### The OpenRouter key

opencode has no `auth login` and no credentials file — `OPENROUTER_API_KEY` in
the process environment is the entire mechanism, and without it opencode has no
`openrouter` provider at all, so every model id fails to resolve.

**Paste the key in the UI: SETTINGS ▸ OPENROUTER.** It is stored server-side in
`instance_settings`, masked on read (the field never sends the key back to the
browser), rotatable at runtime, and it applies to the **next agent spawn** with
no restart. The adapter reads it fresh on every spawn and on every availability
probe.

`SWARM_OS_OPENROUTER_API_KEY` is a **fallback for dev boxes and CI**, which
have no UI to type into. The stored key wins when both exist; the environment
variable is used only when no key is stored. It is deliberately *not* named
`OPENROUTER_API_KEY`, so the server's own environment cannot leak into an agent
by accident — the agent receives the key explicitly, through `secretEnv`.

---

## 5. Availability — `GET /providers`

The route returns, for every registered provider: `id`, `label`, `binary`,
`builtin`, `available`, `unavailableReason`, `version`, `models[]`,
`capabilities` and `defaults`, plus the instance-wide `defaultProvider`,
`defaultEffort`, `defaultPermissionMode` and the `transport`.

Two properties matter operationally:

- **The verdict is re-probed at runtime, with a 60 s TTL** — never once at
  boot. This deployment runs 24/7 and is not recreated for a host-side change,
  so installing a CLI on the host makes it selectable **at the next poll, with
  no container restart**. The cache is serve-stale-and-refresh with a
  single-flight guard: only the very first caller for a cold key waits (3 s max)
  and gets a `pending` placeholder if the probe is slower. A pending verdict
  **fails open** — refusing to create a team because we have not finished
  asking is worse than letting the spawn fail with the CLI's own error.
- **An unavailable provider stays visible in the UI**, greyed out, with its
  reason as a tooltip. A missing option teaches nothing; a disabled one saying
  "`opencode` is not on PATH on the host" says exactly what to do.

Each probe runs *where the agents run*: in-container under `local`, and through
the host **login** shell under `ssh` — so a CLI installed under `~/.local/bin`
or by a node version manager is found by the probe exactly as it would be by
the agent. What they run:

| provider | probe |
|---|---|
| claude / codex | `<binary> --version` |
| opencode | `opencode --version`, **then** the OpenRouter key. "Installed but no key" is its own reason, distinct from "not installed" |
| gemini | `gemini --version` **and** `gemini mcp list`, both inside one throwaway `GEMINI_CLI_HOME` seeded with a marker MCP server. The version answers "is it installed"; the listing must name the marker back, which proves gemini **read the config tree we pointed it at** |

Gemini's extra check is not zeal. If a future release stopped honouring
`GEMINI_CLI_HOME`, every session would collapse onto one config dir — one MCP
URL — and each agent would authenticate to team-comms as whichever session
wrote the file last. Turning that into an availability verdict means the
provider goes dark at the next poll instead of cross-wiring identities.

The check is a **read**, deliberately. It used to be a write — "did gemini
create `history/` and `tmp/` in the throwaway home?" — and that died silently
when the host auto-updated to gemini 0.52.0, which writes nothing on a
`--version`: the count came back 0 on a healthy CLI and the provider reported
"gemini no longer honours `GEMINI_CLI_HOME`", a false statement that hid the
provider and sent the operator hunting a regression that did not exist. Reading
a marker back is both the property the adapter actually depends on (a session
needs gemini to *read* its `settings.json`) and one that does not depend on a
release's housekeeping habits. The exit code of `mcp list` is ignored on
purpose: it tracks the auth configuration of the home it runs in, not the CLI's
presence.

The probe is deliberately **not** an auth check for any provider: a CLI that is
installed but logged out is still "available", and the fix for that is a login
on the host, not another provider.

---

## 6. Choosing a provider

**In the UI**, PROVIDER is the first technical field of the team-creation
dialog, of the role editor and of the spawn-worker dialog; MODEL, EFFORT and
PERMISSION are derived from it. The model list is the provider's own indicative
catalogue, with a free-text escape hatch — the server never validates a model
string, deliberately, because model ids ship faster than releases do.

**Resolution order** for a new team: request body → role default → instance
default (`SWARM_OS_DEFAULT_PROVIDER`, itself defaulting to `claude`).

**The rule for everything else — model, effort, permission mode — is that a
value only means something for the provider that supplied it.** Each layer of
that chain has a provider (its own, or the one it inherits from the layer
below), and a layer's model/effort/permission is used only when its provider is
the one that will actually run. Otherwise the resolved provider's own defaults
apply. Concretely: a role carrying `defaultModel: claude-opus-4-8` and no
`defaultProvider` — the shape of every role written before multi-provider — does
**not** impose that id on a team the request re-points at gemini; gemini's own
default model is used instead. A model named in the request itself is never
replaced (the top layer's provider is the resolved provider by construction),
because the server never validates a model string: ids ship faster than releases
and rejecting a valid one is the worse failure.

`SWARM_OS_DEFAULT_MODEL` follows the same rule and is resolved **from**
`SWARM_OS_DEFAULT_PROVIDER`: leave it unset and a new team gets the configured
provider's OWN default model (see "Live model catalogue" below for how that is
chosen). Set it and it is taken verbatim, whatever the provider — an explicit
value always wins, and is never validated.

Unset is the interesting case, and it changed: the instance config used to name
a model on every single team creation, which meant the provider adapter's own
default could never apply on a team created through the API while the browser —
which submits an explicit model — got a different answer. The config layer now
speaks only when an operator actually set `SWARM_OS_DEFAULT_MODEL`.

### Live model catalogue

Each adapter's model list and default model are refreshed at runtime from
[`models.dev`](https://models.dev/api.json) — a public, credential-free catalogue
(the one opencode itself uses) — so a 24/7 deployment picks up new model ids
without being redeployed. Nothing is scheduled: `GET /providers` refreshes the
cache when it is older than the TTL and serves the previous answer meanwhile, so
an unreachable models.dev costs nothing but freshness.

| | |
|---|---|
| `SWARM_OS_MODEL_CATALOGUE_URL` | Source URL. **`off` disables the whole thing**: pinned lists only, no outbound call. |
| `SWARM_OS_MODEL_CATALOGUE_TTL_MS` | Refresh interval. Default 6 h. |

Three things worth knowing:

- **The default model is the newest member of a pinned FAMILY**, not the newest
  model overall (`BUILTIN_PROVIDER_DEFAULT_FAMILIES` in
  `modules/providers/ids.ts`): `claude-opus-*` for claude, `gpt-5*` for codex,
  `gemini-*-pro*` for gemini, `anthropic/claude-opus-*` for opencode. The
  patterns are anchored, so variants like `-fast`, `-pro` or `-customtools` are
  offered in the list but can never become the default.
- **The scope is NEW teams.** A team's model is materialised into
  `orchestrators.default_model` when it is created; existing teams keep theirs,
  and so does a resumed one. "The instance follows the newest model" would be
  wrong — "teams created from now on start on the newest" is right.
- **codex does not use models.dev.** It reads the codex CLI's own
  `~/.codex/models_cache.json` instead, because models.dev catalogues the *API*
  and `codex exec` accepts strictly less: measured 2026-07-28, `-m gpt-5.6` (a
  perfectly ordinary id there) answers HTTP 400 *"not supported when using Codex
  with a ChatGPT account"*. When that file is unreadable, codex falls back to its
  pinned list — not to models.dev.

The pinned lists are the floor for all of this: they are what an offline
instance, a `…_URL=off` instance and every test see. `pnpm models:sync` refreshes
them from the same filters before a release.

**Permission mode is coerced, server-side, at the point of resolution.** A
provider only accepts the modes in its `capabilities.permissionModes`; anything
else becomes its `fallbackPermissionMode`, and the coerced value is what gets
stored, persisted, returned and displayed. Asking a codex team for `plan` gives
a team that reads `bypassPermissions` everywhere — which is what it actually
runs as. The alternative (record the request, run the fallback) means a panel
saying an agent is planning while it writes unsupervised.

One rule, one implementation (`modules/providers/resolve.ts`), used by all four
creation paths: `POST /orchestrators`, `POST /orchestrators/:id/workers`, the
MCP `team.spawn_worker` tool and the plugin API's `teams.create`. A divergence
between two of them would be a bug on its own.

**Per agent:** a worker may name its own provider, through
`POST /orchestrators/:id/workers` (what the spawn-worker dialog calls) or
through the `team.spawn_worker` MCP tool, which takes an optional `provider`
argument. Omitted, it inherits the team default. This is what makes a mixed
team possible from inside an agent as well as from the UI.

Two error codes are worth recognising:

- `400 UNKNOWN_PROVIDER` — no adapter with that id (the response lists the
  known ones);
- `409 PROVIDER_UNAVAILABLE` — the adapter exists but its probe says it cannot
  run here; the response carries the same human-readable reason the UI shows.

`SWARM_OS_DEFAULT_PROVIDER` accepts **built-in ids only** (`claude`, `codex`,
`gemini`, `opencode`) and is validated at boot — an unknown value stops the
server rather than silently falling back. A provider registered later by a
plugin can still be selected per team or per agent; it just cannot be the
instance-wide default, because configuration is loaded long before the plugin
host starts.

---

## 7. What is proven, and what is not

Adapters are unit-tested; CLI behaviour is not something a unit test can
establish. The three spike scripts drove the real binaries, and this section
says exactly how far they got. Read it before trusting a provider with
something important.

### codex — proven end to end

`scripts/verify-codex.report.md`, codex-cli 0.130.0, **8/8 CONFIRMED**,
including both blocking checks: a real MCP tool call landed on a swarm-os-shaped
streamable-HTTP server (recorded server-side, not merely claimed by the model),
and the ratatui TUI emits **0.0 B/s at idle** so the silence-based idle detector
works unchanged. The `AGENTS.md` preamble survived `/compact`, `/new` and
`/clear`; the trust entry removed the modal in a real PTY; the `notify` payload
was captured. Model round-trips were exercised on `gpt-5.4-mini`.

### gemini — structurally complete, never exercised against a model

`scripts/verify-gemini.report.md`, @google/gemini-cli 0.35.2, **5 CONFIRMED /
3 PARTIAL**. Everything structural is proven: `GEMINI_CLI_HOME` re-routes the
whole config tree, the MCP server connects over `httpUrl` and its tool is
discovered (server-side evidence), the `GEMINI.md` preamble is loaded and
survives `/clear` and `/compact`, `trustedFolders.json` removes the trust
modal, the notification hook command runs unchanged and POSTs correctly, the
Ink submit dance works, the PTY is silent at idle.

**What could not be proven: any model round-trip at all.** On this host the
operator's gemini authentication is refused by the CLI itself —
`IneligibleTierError: This client is no longer supported for Gemini Code Assist
for individuals` — and no `GEMINI_API_KEY` was available. So the three PARTIAL
checks are partial for one shared reason: no turn could be run. The final hop
(the model *invokes* the discovered tool, the model *obeys* the preamble) is
untested. Give gemini working credentials and re-run `pnpm verify:gemini`
before relying on a gemini agent.

### opencode — the swarm integration is proven; the OpenRouter hop is not

`scripts/verify-opencode.report.md`, opencode 1.18.5, **11 CONFIRMED / 1
UNVERIFIED**. The spike installed opencode into a throwaway prefix and drove it
against two local fakes (a swarm-os-shaped MCP server and an OpenAI-compatible
model endpoint). Proven: config isolation with a positive *and* negative
control, MCP discovery and a real tool invocation, the durable
`instructions[]` preamble surviving `/clear` in a live PTY, unattended
operation with a real negative control, 0 B/s at idle, the `--prompt` boot
turn, and the control-plane SSE stream emitting `permission.asked` and
`session.idle`.

Two honest gaps:

1. **`opencode` is not installed on this host** (it was installed into a
   throwaway prefix for the spike and removed). Until someone runs
   `npm i -g opencode-ai` there, the provider reads as unavailable.
2. **No live OpenRouter round-trip.** There was no key, so "openrouter.ai
   accepts this key and this model id resolves" is unverified; only the local
   stub endpoint was exercised. Everything upstream of that network call —
   provider selection from the env var, model id plumbing, request shape — was
   captured on the wire. Closing it is one command:
   `OPENROUTER_API_KEY=<real key> pnpm verify:opencode`.

### opencode never reports `waiting` — do not expect otherwise

The spike proved that a notification channel *exists*: the TUI's `--port`
control plane serves `GET /event`, whose `permission.asked` and `session.idle`
events would distinguish "blocked on a human" from "turn finished" — something
the byte rate provably cannot, since a frozen opencode TUI is silent too.

**Nothing consumes that stream today.** The adapter allocates the port, the
password and the loopback binding, and stops there. So `capabilities`
declares no notification channel for opencode, and an opencode session never
reaches `waiting`. There is a second obstacle waiting for whoever wires it:
under SSH the control plane listens on the *host's* loopback, and the SSH
transport only sets up a reverse forward today — reaching it from the container
needs a forward one.

---

## 8. Troubleshooting

**A provider is greyed out in the dialog.** Hover it: the reason comes from the
probe and is written for a human. `not on PATH` means install the CLI *on the
host* (the agents do not run in the container under the SSH transport); the
verdict refreshes within 60 s of the install, with no restart.

**opencode says "installed but no OpenRouter API key is configured".** Paste
one in SETTINGS ▸ OPENROUTER. The next availability poll re-evaluates it.

**An agent starts, shows no error, and its first turn fails on
authentication.** Two candidates, in order:

1. the CLI is installed but not logged in on the host — run its login once
   (`codex login`, `gemini`, `claude`) and check the credentials file exists;
2. `SWARM_OS_HOST_CODEX_DIR` / `_GEMINI_DIR` / `_CLAUDE_DIR` is unset, so the
   per-session credential symlinks point at the *container's* home path and
   dangle. See §4.

**A session sits at "busy" forever and produces nothing.** Most likely the TUI
is wedged on a modal you cannot see — a folder-trust dialog, an auth picker, a
permission prompt. Every adapter pre-accepts the dialogs it knows about, so
this means one of them regressed or the trust key does not match the cwd the
agent actually opened (a `paths.workspace` vs `paths.data` mistake under SSH,
which fails silently by design). Attach the session terminal and look: the
modal is on screen.

**A session looks permanently busy and the mailbox signals never arrive.** The
idle detector is silence-based: *any* byte from the PTY resets the clock. A TUI
that repaints continuously therefore reads as "always working". Known
repainters: gemini while a modal is open (~400 B/s), and any CLI that runs its
own updater at boot. This is why gemini's `enableAutoUpdate` and
`enableAutoUpdateNotification` are forced to `false` and opencode gets
`OPENCODE_DISABLE_AUTOUPDATE=1`. If a new CLI version starts printing at idle,
that is the first thing to check.

**A gemini agent prints an ENOENT stack trace on its first screen.** Its
project registry was not seeded — gemini's cold-start `projects.json` rename
races with itself. The adapter seeds it; a stack trace means the seed did not
land (unwritable runtime dir).

**A team on codex/gemini/opencode looks silent and never goes to `waiting`.**
Expected — see §3. Use the session terminal or `SWARM_OS_AUTO_COMPACT_BYTES`
rather than `SWARM_OS_COMPACT_ON_WAITING`.

**An agent claims a `team.*` tool does not exist.** Its CLI renames MCP tools
(§3) and something handed it the canonical dotted name — most likely a custom
preamble written outside the templating path. Ask the agent to list its tools
and match the suffix; the preamble note tells it to do exactly that.

---

## Cross-references

- Adapters: `packages/server/src/modules/providers/` (`types.ts` first — the
  contract and its rationale are there)
- Route: `packages/server/src/http/routes/providers.ts`
- Notification semantics: `packages/server/src/http/routes/hooks.ts`
- Preamble rendering: `packages/server/src/modules/orchestrator/preamble.ts`
- Spike reports: `scripts/verify-{codex,gemini,opencode}.report.md`
- Install prerequisites: `docs/deploy/install.en.md` §1 (FR: `install.fr.md`)
