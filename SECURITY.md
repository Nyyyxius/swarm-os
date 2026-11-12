# Security policy and trust model

swarm-os runs AI coding agents unattended, with their permission prompts turned
off, on a machine you own. This page explains what that means before you install
it: where the agents run, what they can reach, what the auth token unlocks, and
what protects you and what does not.

It describes the code as it is today. The weaknesses listed under
[Known limitations](#known-limitations) are planned hardening work, not fixed
yet.

---

## Reporting a vulnerability

Please report security issues privately, through GitHub's private vulnerability
reporting:

**<https://github.com/Nyyyxius/swarm-os/security/advisories/new>**

Do not open a public issue for a vulnerability. Include the version (`/info`
shows it, or the image tag), the agent transport (`local` or `ssh`), and steps
to reproduce. You will get an answer in the advisory thread; fixes are released
as a new image tag and noted in the release notes.

### Supported versions

swarm-os is a young project maintained by one person. Only the **latest
published release** (the newest `ghcr.io/nyyyxius/swarm-os:X.Y.Z` tag, and
`:latest`) gets security fixes. There are no backports: the fix for an older
version is to update.

---

## The short version

- **The agents run arbitrary code.** Every provider CLI is started with its
  permission prompts disabled (see [Provider flags](#what-the-provider-flags-mean)).
  An agent can run any command its OS user can run, without asking anyone.
- **Where that code runs depends on the transport.** With `local`, inside the
  container. With `ssh`, directly on the host, as your user account. The
  container isolates the `local` transport. It does not isolate the `ssh`
  transport.
- **The auth token is equivalent to code execution.** Anyone holding it can
  start agents, install plugins that run inside the server, open a VS Code
  terminal and run cron scripts.
- **Agents can read the auth token.** It lives in the state directory that the
  agents share with the server (details below). The token protects the UI from
  the network, not from the agents.
- **Treat the machine like a CI runner that executes untrusted input**: a
  dedicated user or VM, nothing on it you would not hand to the agents, the UI
  on loopback or behind a VPN.

---

## Agent transports: `local` vs `ssh`

`SWARM_OS_AGENT_TRANSPORT` decides where the agent processes run. It is the
single most important security setting. `local` is the default in the compose
files and `.env.example`. Note that `install.sh` offers `ssh` as its first,
"recommended" choice when it detects an SSH server on port 22; `install.ps1`
(Windows) always uses `local`.

| | `local` | `ssh` |
|---|---|---|
| Where agents run | Inside the container, as child processes of the server (`node-pty`). | On the host, over `ssh -tt <user>@host.docker.internal`, as `bash -lc '… exec <cli> …'`. |
| As which user | The container user: uid 1000 (`node`) by default, or `SWARM_OS_RUN_UID`. Not root unless you set uid 0 by hand (only `setup.sh` refuses it). | The host account named in `SWARM_OS_SSH_TARGET`, with its normal login environment (`~/.profile`). |
| Environment the agent gets | The server's **entire** environment plus per-session variables. That includes `SWARM_OS_GITHUB_TOKEN`, `SWARM_OS_OPENROUTER_API_KEY`, `SWARM_OS_DISCORD_WEBHOOK_URL` if you set them in `.env` (and `SWARM_OS_TOKEN`, if you added it to the service's `environment:` yourself; the shipped compose file does not pass it). | The host account's login environment plus per-session variables. The container's environment is not forwarded. |
| What it can read | Everything mounted in the container: `/workspace` (read-write), `/data` (read-write, incl. `token`, `hook-token`, `ide-token`, the SQLite database, the copy of your Claude credentials in `/data/.claude-runtime`), `/claude-source` (your `~/.claude`, read-only). The image itself. Not the rest of the host filesystem. | Everything that host account can read: its whole home directory (`~/.ssh`, other projects, shell history, cloud CLIs' credentials, browser profiles), plus every file readable by that user elsewhere on the host. When the account also owns `DATA_PATH` (the usual setup, since it is the run-as account) that includes the auth token and the database. |
| What it can change or destroy | `/workspace` and `/data`. Inside the container's own writable layer, anything uid 1000 can write. | Anything that host account can change: its home, every repository it owns, its crontab and `authorized_keys`. With passwordless `sudo` or membership of the `docker` group, the whole host (both are root-equivalent). |
| Network | Unrestricted outbound. Reaches whatever the Docker bridge reaches, including host services that listen on a non-loopback interface. | Whatever that host account can reach, including services bound to the host loopback. |
| What the container isolates | The host filesystem outside the mounts, host processes, host loopback services, other users. The kernel is shared (standard Docker isolation, no extra seccomp/AppArmor profile, no user namespaces). | Nothing for the agents: they are not in the container. And the container now holds a private key that logs into the host (see [The SSH key](#the-ssh-key)), so any code that runs in the container (a plugin, a cron script, a VS Code terminal) can also reach the host as that account. |
| Features that need it | — | The `codex`, `gemini` and `opencode` providers (the image only ships `claude`); one-click updates (SETTINGS ▸ SYSTEM UPDATE runs `docker` on the host); the plugin `host-exec` capability; the role prompt "improve" helper. |

A writable `/workspace` is a path back to the host under either transport:
anything the agents write there (a git hook, a `Makefile`, a `package.json`
script, a CI file) runs on the host the next time you, or a tool, executes it
there. Review agent output before running it outside the container.

### Which transport to pick

- **`local`** when `claude` is enough. It is the only setup where the container
  is a real boundary between the agents and the rest of the machine.
- **`ssh`** when you need codex, gemini or opencode, or one-click updates. Then
  the host account *is* the boundary, so give swarm-os its own account (or its
  own VM) and nothing else to protect on it. See
  [Recommendations](#recommendations-for-operators).

---

## What the provider flags mean

swarm-os drives the real CLIs unattended, so each one runs with its approval
layer off:

| Provider | Flag(s) swarm-os passes | In practice |
|---|---|---|
| `claude` | `--permission-mode bypassPermissions` by default. The mode can be set per role or per team; the instance default comes from `SWARM_OS_DEFAULT_PERMISSION_MODE`, which the shipped compose files do not pass through, so set it per role or add it to `environment:` | Every tool call runs without a prompt: shell commands, file writes anywhere the user can write, network access. |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` | No approval prompts **and** codex's own command sandbox is disabled. Every other mode is mapped to this one. |
| `gemini` | `--yolo` | Every tool call auto-approved. Every other mode is mapped to this one. |
| `opencode` | `--auto` plus `"permission": "allow"` in its config | Its permission dialog is unreachable. Every other mode is mapped to this one. |

Only `claude` has modes other than bypass (`default`, `plan`, `acceptEdits`,
`auto`, `dontAsk`). In the ones that ask (`default`, `plan`, `acceptEdits`) a permission prompt blocks the agent until a human answers, and
the [approvals module](#protections-that-exist) turns it into an actionable
notification. codex, gemini and opencode always run without prompts.

### Prompt injection, in plain words

An agent treats whatever it reads as possible instructions: files in the
repository, a README of a dependency, a web page it fetched, an issue it was
asked to fix, a message relayed from Discord, a skill imported from a public
source. If any of that text says "run this command" or "send the contents of
`~/.ssh` to this URL", a model may comply, and with the flags above nothing
stops the command from running.

So the realistic threat is not someone breaking into swarm-os; it is someone
getting text in front of your agents. What such text can do is bounded by what
the agent's OS user can do: under `local`, the container and its mounts; under
`ssh`, the host account. Choose the transport and the account with that in mind.

---

## The auth token

- **What it is.** One static secret, a random UUID generated at first boot and
  stored in `/data/token` (mode 0600), unless you set `SWARM_OS_TOKEN` (the shipped compose file does not pass that
  variable; add it to the service's `environment:` to use it). There
  are no user accounts, roles or scopes, and no built-in rotation: to rotate,
  stop the container, delete `/data/token` (or change `SWARM_OS_TOKEN`) and
  start it again.
- **What it grants.** The whole REST API. That includes starting teams with any
  prompt, typing into any agent's terminal, installing a plugin from npm, git or
  an uploaded archive (plugins run inside the server process), fetching the
  VS Code connection token (`GET /ide-info`), which gives a terminal in the
  container, and creating cron scripts. **Holding the token is equivalent to
  running code as the server's user**, and under the `ssh` transport, as the
  host account too.
- **How the browser uses it.** You paste it once; the UI keeps it in
  `localStorage` and sends it as the `X-Auth-Token` header. It is also mirrored
  into a cookie scoped to `Path=/plugin-api/`, `SameSite=Strict`, because plugin
  panels are iframes that cannot set a header; the server accepts that cookie
  only under `/plugin-api/`. The token is never put in a URL.
- **How WebSockets use it.** The live terminal and event stream do not carry
  the token. The UI asks `GET /ws-ticket` (authenticated) for a single-use
  ticket that expires after 10 seconds, and opens the socket with it.
- **Separate secrets.** `hook-token` (agents' notification hooks posting back
  to the server) and `ide-token` (VS Code `serve-web` connection token) are
  distinct files in `/data`, so the main token never has to be written into an
  agent's configuration. They still sit in the same directory the agents can
  read (see [Known limitations](#known-limitations)).

---

## Plugins are trusted code

A plugin is a Node.js module loaded with `import()` **into the server process**.
It is not sandboxed. The manifest's capabilities (`host-exec` and others) gate
which parts of the plugin API it may call, and you grant them, but a plugin can
still use Node's own modules (`child_process`, `fs`, `net`) directly. Install a
plugin only if you would run its code on the machine yourself.

Plugin UI panels run in an iframe with `sandbox="allow-scripts
allow-same-origin allow-forms"`. With both `allow-scripts` and
`allow-same-origin`, the panel runs as the swarm-os origin: it can read
`localStorage`, including the auth token. The iframe is for layout, not
isolation.

A plugin that keeps crashing is quarantined (disabled with a cooldown) so it
cannot take the server down. That protects availability, not confidentiality.

## The web IDE (VS Code)

The VS Code web editor (`code serve-web`) runs **inside the container**, as the
container user, on a loopback port, and swarm-os reverse-proxies it under `/ide`
on the UI port. It is guarded by its own connection token, which the UI obtains
from the authenticated `GET /ide-info`. It opens `/workspace`, and its terminal
is a shell in the container: under the `ssh` transport that shell can read the
mounted SSH key and log into the host.

It is **enabled by default** (`SWARM_OS_IDE_ENABLED` defaults to `true`, and
`install.sh` writes `true` unless you turn it off in the advanced step). That
variable only seeds the setting at first boot; afterwards, turn it on or off
from the Plugins screen (BUILT-IN section).

## Network exposure

- The server listens on `0.0.0.0` inside the container (`SWARM_OS_HOST` in the
  image), and every shipped compose file publishes it on the **host loopback
  only**: `127.0.0.1:${SWARM_OS_PORT:-8787}:8787`. Nothing is published on a
  public interface unless you edit the compose file.
- There is **no TLS** in the container. Remote access is meant to go through
  Tailscale (`tailscale serve`), an SSH tunnel, or a reverse proxy you run (see
  [docs/deploy/install.en.md §6](docs/deploy/install.en.md#6-remote-access)).
- Unauthenticated routes: `/health`, `/info` (version and image), the static
  web app, `/hooks/*` (checked against `hook-token`) and `/ide/*` (checked by
  VS Code against `ide-token`) and `/public/plugins/<name>/*` (inbound
  webhooks of enabled plugins; each plugin verifies its own signatures).
  `/health` also exposes the project name and session counts. Everything else
  requires the token.
- The MCP server agents use to talk to each other (port 8788) is hard-wired to
  `127.0.0.1` inside the container and never published by Docker. Each request
  must carry a per-session secret in its path; a wrong secret gets a 404. Under
  the **`ssh` transport** the port is additionally forwarded to the **host's**
  loopback with `ssh -R 8788:127.0.0.1:8788`, so any process on the host can
  connect to it (it still needs a session secret).
- The server sends no Content-Security-Policy header.

## The SSH key

Under the `ssh` transport the container needs a private key that logs into the
host. What the installers do today:

- `install.sh` (and `setup.sh`) offer to **generate** a dedicated ed25519 key,
  **without a passphrase**, in its own directory (`~/.swarm-os/ssh/swarm-os-spawner`
  by default), and to **append its public key to `~/.ssh/authorized_keys`**
  of the target account. The entry has **no restriction**: no `command=`,
  `from=`, `no-port-forwarding` or similar options. Anyone holding the private
  key gets a full shell as that account.
- The compose overlay `examples/docker-compose.ssh.yml` mounts the key's
  directory read-only at `/host-ssh`: `${HOST_SSH_DIR:-${HOME}/.ssh}`. The
  installers set `HOST_SSH_DIR` to the dedicated directory, so only that key is
  mounted. If `HOST_SSH_DIR` is unset, or you chose "use an existing key" at
  `~/.ssh/id_ed25519`, the **whole `~/.ssh` directory** (every private key in
  it, `known_hosts`, `config`) is mounted into the container.
- The container accepts the host key on first use
  (`StrictHostKeyChecking=accept-new`) and keeps `known_hosts` in `/tmp`, which
  does not survive a container restart.

## Protections that exist

- **Constant-time token comparison** (`crypto.timingSafeEqual`), on every
  authenticated request.
- **Single-use, 10-second WebSocket tickets**: the token itself never travels
  in a WebSocket URL.
- **Loopback by default**: the UI is published on `127.0.0.1` only, and the MCP
  server refuses to start on anything but loopback (checked before and after
  `listen`).
- **Non-root container** with `tini` as PID 1 (uid 1000 by default); `setup.sh`
  refuses to configure uid 0.
- **No shell interpolation of arguments**: agent arguments and remote commands
  are passed as argv or individually shell-quoted. Secrets for opencode are
  passed through a 0600 env file, not on the command line, because `ps` on the
  host shows command lines.
- **Working-directory validation**: a team's `cwd` (and a cron script's path)
  must resolve, after symlinks, under the workspace (or `/data` for crons). This
  sets where an agent *starts*; it does not confine what an agent in a bypass
  mode can do afterwards.
- **Cron scripts get a minimal environment**: no server token and no provider
  key are passed to them (they still run as the container user, so they can
  read `/data`).
- **Plugin crash quarantine**, and a **review gate for imported skills**: a
  skill from a community source that ships executable assets or asks for
  capabilities must be reviewed by you before it can be activated.
- **Human approvals** (`modules/approvals`): for `claude` teams in a prompting
  mode (`default`, `plan`, `acceptEdits`), every permission prompt becomes an
  approval you can grant or refuse from the web UI or Discord. This is the one
  way to keep a human in the loop for each command.
- **`.env` written 0600** by `install.sh`; secrets masked in its review screen;
  the GitHub token is only ever sent to `api.github.com`.
- **Updates refuse before they touch anything**: the host-side updater checks
  everything first, and a failed verification rolls back to the previous image.

---

## Recommendations for operators

1. **Run swarm-os under a dedicated account, or in a dedicated VM.** Give that
   account only the repositories the agents should work on, no personal SSH
   keys, no cloud credentials, no browser profile. `setup.sh` and the `.env`
   variables `SWARM_OS_RUN_USER` / `SWARM_OS_RUN_UID` / `SWARM_OS_RUN_GID`
   install an instance for another account
   ([install.en.md §3](docs/deploy/install.en.md#3-configure)).
2. **Prefer the `local` transport** unless you need codex, gemini, opencode or
   one-click updates. With `ssh`, assume the agents can do anything the SSH
   account can do.
3. **Keep the UI on loopback.** Use an SSH tunnel or Tailscale for remote
   access. If you put a reverse proxy in front of it on a public domain, the
   token is the only thing between the internet and code execution on your
   machine; add your own access control at the proxy (VPN, SSO, IP allow-list).
4. **Do not add the account to the `docker` group unless you need it.** The
   `docker` group is root-equivalent. You need it to run `install.sh` as that
   user, and the `ssh` transport's one-click update needs the SSH account to run
   `docker`, which then also hands it to every agent. Without one-click updates,
   run Docker as another user (or with `sudo`) and keep the agents' account out
   of the group. Same for passwordless `sudo`.
5. **Keep the SSH key dedicated.** Let the installer generate it in
   `~/.swarm-os/ssh` and make sure `HOST_SSH_DIR` points there, never at
   `~/.ssh`. You can restrict its `authorized_keys` line yourself, for example
   with a `from="…"` clause matching the Docker bridge network of your host
   (check `docker network inspect`; it is often inside `172.16.0.0/12` but can
   be `192.168.0.0/16`) and
   `no-agent-forwarding,no-X11-forwarding`; keep port forwarding allowed, since
   the transport uses `ssh -R`.
6. **Use human approvals where it matters.** Create the role (or the team) with
   a prompting permission mode for `claude` and enable the approvals feature, so
   each command waits for your decision.
7. **Turn off what you do not use.** Disable the VS Code editor from the
   Plugins screen if you do not need it, and do not set `SWARM_OS_TOKEN`,
   `SWARM_OS_OPENROUTER_API_KEY` or `SWARM_OS_GITHUB_TOKEN` in `.env` unless you
   need them: under `local`, agents inherit the server's environment. Prefer
   SETTINGS ▸ OPENROUTER for the OpenRouter key.
8. **Install plugins and skills only from sources you trust**, and read what a
   plugin requests before granting `host-exec`.
9. **Treat the token as a root password for the instance.** Do not paste it in
   chats or tickets, and rotate it (delete `/data/token`, restart) if it leaked.
10. **Review what the agents produce** before running it outside the container,
    and keep the workspace under version control so you can see and revert
    their changes.

---

## Known limitations

These are known and planned hardening work. Until they land, the
recommendations above are the mitigation.

- Agents can read `/data/token`, `hook-token`, `ide-token` and the database,
  because they run as the user that owns the state directory. The token does not
  protect the instance from its own agents.
- Under `local`, agents inherit the server's full environment, including any
  secret set there (`SWARM_OS_GITHUB_TOKEN`, `SWARM_OS_OPENROUTER_API_KEY`,
  `SWARM_OS_TOKEN`). There is no allow-list yet.
- The token is single, static, unscoped, with no rotation command, no expiry and
  no audit trail of who used it.
- The token is stored in `localStorage`, readable by any script running on the
  swarm-os origin, including plugin panels. No Content-Security-Policy is set.
- The generated SSH key has no passphrase and its `authorized_keys` entry has
  no restrictions; the overlay falls back to mounting the whole `~/.ssh` when
  `HOST_SSH_DIR` is unset.
- `install.sh` presents the `ssh` transport as the recommended choice when an
  SSH server is running, which is the less isolated option.
- Plugins run in the server process without a sandbox; capabilities restrict
  the plugin API, not Node.js.
- The VS Code editor is enabled by default and gives a shell in the container.
- `codex`, `gemini` and `opencode` cannot run in any prompting mode, so the
  approvals module never applies to them.
- `known_hosts` for the SSH transport lives in `/tmp` and is re-learned after
  every restart (trust on first use each time).
