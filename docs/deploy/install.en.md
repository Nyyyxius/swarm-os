# swarm-os — Installation & deployment (EN)

swarm-os orchestrates teams of autonomous agent CLI sessions (Claude Code,
Codex, Gemini CLI, OpenCode). **One container =
one project.** This guide takes a fresh host to a running, accessible instance.

---

## Install in one command

On a fresh host, this whole document fits on one line:

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
```

`bootstrap.sh` downloads the kit (installer, compose files, docs) into
`~/swarm-os` and hands over to the guided setup
([§4](#4-install--the-guided-setup)), which asks one question at a time: Docker,
the Claude login, paths, image, transport, providers, remote access,
notifications.

The repository and the image are **public**: fetching the kit and pulling the
image need no token and no GitHub account ([§2](#2-get-the-image-ghcr)). A token
passed as `SWARM_OS_PAT` (or `--token`) is only needed to fetch from a private
fork or mirror (`SWARM_OS_REPO`); when given, the script also offers it to the
installer as the optional update-detection token.

Before installing, read [SECURITY.md](../../SECURITY.md): the agents run
commands without asking, and the transport you pick in step 4 decides whether
they do it inside the container or on the host as your user.

Options, after `bash -s --`: `--dir <path>` (default `~/swarm-os`),
`--ref <branch|tag>`, `--token <pat>`, `--fetch-only` (download, start nothing).
Re-running the command **updates the kit**, and never touches your `.env`.

Piping a remote script into `bash` is an act of trust; to read it first:

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh -o bootstrap.sh
less bootstrap.sh && bash bootstrap.sh
```

### Windows (PowerShell)

On Windows, the same thing in PowerShell — no bash, no WSL needed:

```powershell
irm https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/install.ps1 | iex
```

`install.ps1` fetches the kit into `~\swarm-os` (`$env:SWARM_OS_DIR` to change
it) and runs the Windows twin of the wizard: **Docker Desktop** (offered through
`winget`, started for you if it is installed but stopped, Linux-containers mode
checked), the native Claude CLI (`irm https://claude.ai/install.ps1 | iex`) and
its login, paths, image (it tests the pull, and offers a `docker login` only if
that fails), remote access (Tailscale via `winget`), notifications, update
detection, advanced settings and a review (eight steps; the transport step only
explains that it is `local`) — then deploys and prints the token. There is no
provider step: on Windows only `claude` runs. From a kit directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1               # wizard, then deploy
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Reconfigure  # redo the wizard
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes          # deploy .env, no questions
```

What differs from `install.sh`: the agent transport is always **`local`**
(agents in the container, claude only, updates via `.\install.ps1`). The `ssh`
transport runs every agent as `bash -lc …` on the host, which needs a POSIX
host — for it (and for codex / gemini / opencode and one-click updates), run
`./install.sh` from a WSL 2 distribution with Docker Desktop's WSL integration
enabled. Paths are written to `.env` as `C:/Users/…`; there is no uid to fix
(Docker Desktop bind mounts are writable by the container as they are).

Sections 1–3 remain the reference for what the wizard does, and the manual path.
The rest of the guide applies either way.

---

## 1. Requirements

- **Docker** + **Docker Compose v2** (`docker compose version` works).
- **A Claude Code account and the CLI, logged in on this host** — the critical
  prerequisite, see below.
- Host sizing: roughly **2–4 vCPU and 4–8 GB RAM per active team**, plus disk for
  your workspace and the `/data` state directory.
- Outbound internet from the container (Claude API, first-run VS Code download,
  Discord webhook, any git/npm the agents run).
- (Optional) Tailscale or a reverse proxy for remote access.

### The critical prerequisite — Claude Code credentials

swarm-os ships **no API key**. Every agent launches the Claude Code CLI, which
authenticates from `~/.claude`. The container mounts that directory read-only and
copies it to writable state at boot.

That `~` is the home of the **account the instance belongs to** — by default the
one you install from, but not necessarily: see "the host account the instance
belongs to" in §3. That account is the one that must have logged in.

Before anything else, on the host:

```sh
curl -fsSL https://claude.ai/install.sh | bash   # native CLI (Linux, macOS, WSL)
claude                                             # complete the OAuth login once
ls ~/.claude/.credentials.json                     # this file MUST exist afterwards
```

The native installer picks the build for the machine (x64/arm64, glibc/musl),
puts it in `~/.local/bin/claude` and keeps it up to date — no Node.js needed.
Make sure `~/.local/bin` is on the account's **login-shell** PATH. On Alpine
(musl), first `apk add libgcc libstdc++ ripgrep` and set `USE_BUILTIN_RIPGREP=0`.
On native Windows, use `irm https://claude.ai/install.ps1 | iex` in PowerShell.
`./install.sh`, `install.ps1` and `setup.sh` offer to run the right command for
you.

> `setup.sh` is a third, self-contained installer (a full-screen, 12-step
> wizard). It is not part of the kit `bootstrap.sh` downloads; run it straight
> from the repository with
> `curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/setup.sh | bash`
> (options after `bash -s --`, see `--help`). It fetches the two compose files
> it needs itself.

Without `~/.claude/.credentials.json`, no agent can start — a spawned session
hangs on the first-run theme picker.

### Optional — the other agent providers

Agents can also run on `codex` (OpenAI), `gemini` (Google) or `opencode`
(any model reachable through OpenRouter), chosen per team and per agent. None
of it is required for a standard install, and none of it changes the steps
below — but two host facts decide whether those providers are usable at all:

- **The image carries only the Claude Code CLI.** Under the default `local`
  transport (what `examples/docker-compose.dist.yml` sets up) the other three
  report themselves *unavailable*. That is the correct outcome, not a
  misconfiguration. They become usable when the deployment runs the **`ssh`
  transport**, where the agent process runs on the host.
- **Each CLI must be installed *and logged in* on that host.** swarm-os ships
  no API key for any provider; the agent inherits the host's credentials,
  exactly as it does for Claude Code.

```sh
npm i -g @openai/codex      && codex login    # → ~/.codex/auth.json
npm i -g @google/gemini-cli && gemini         # OAuth once → ~/.gemini/oauth_creds.json
npm i -g opencode-ai                          # no login: the key is set in the UI
```

`opencode` authenticates with an **OpenRouter API key**, entered in the web UI
under **SETTINGS ▸ OPENROUTER** (stored server-side, masked, applied to the next
agent spawn without a restart). Without it, opencode reads as *installed but
unavailable*.

A CLI installed on the host becomes selectable at the next availability poll
(60 s) — no container restart. Full guide, including what each CLI can and
cannot express: [../providers.md](../providers.md).

---

## 2. Get the image (GHCR)

The image is a **public** GitHub Container Registry package: no login, no
token.

```sh
docker pull ghcr.io/nyyyxius/swarm-os:latest      # or a pinned :X.Y.Z tag
```

Images up to 0.10.4 are built for `linux/amd64` only; later releases also ship
`linux/arm64`. If you pull from a private mirror or
fork of your own instead, `docker login` to that registry first; nothing in
swarm-os needs it otherwise.

---

## 3. Configure

From the kit (repo) root:

```sh
cp .env.example .env
```

Edit `.env` — at minimum:

- `SWARM_OS_IMAGE` — the tag you just pulled. **Set it explicitly**: the compose
  file has a `${SWARM_OS_IMAGE:-…:latest}` fallback that starts a container
  anyway, and leaving the variable unset is what turns off self-update (§7.2) —
  that line is the one an update rewrites.
- `WORKSPACE_PATH` — the project the agents will work in.
- `DATA_PATH` — where persistent state is stored.
- `CLAUDE_DIR` — your `~/.claude` (default is fine on a standard layout).
- `SWARM_OS_PROJECT_NAME` — a label for the UI / logs / Discord.
- `SWARM_OS_GITHUB_TOKEN` — optional. Update detection works without it; a
  token only raises GitHub's API rate limit (§7.4). Releases up to 0.10.4 still
  need it for detection.

A near-identical copy, next to `examples/docker-compose.dist.yml`, is
[`examples/.env.example`](../../examples/.env.example).

Optional, and only relevant if you use a provider other than Claude (§1):

- `SWARM_OS_DEFAULT_PROVIDER` — `claude` (default), `codex`, `gemini` or
  `opencode`; what a team gets when neither the request nor the role names one.
  An unknown value stops the boot rather than falling back silently. It also
  decides `SWARM_OS_DEFAULT_MODEL` when that one is left unset: the instance
  default becomes the default model *of this provider*, never a claude id on a
  foreign CLI.
- `SWARM_OS_HOST_CODEX_DIR` / `SWARM_OS_HOST_GEMINI_DIR` /
  `SWARM_OS_HOST_OPENCODE_DIR` — the host's state directory for each CLI,
  siblings of `SWARM_OS_HOST_CLAUDE_DIR` and needed for the same reason. **Set
  them explicitly under the `ssh` transport**: their default is derived from the
  *container's* home (`/home/node/.codex`…), a path that does not exist on the
  host, so the per-session credential symlinks dangle and the agent fails its
  first turn on an authentication error with nothing visible at spawn.
- `SWARM_OS_OPENROUTER_API_KEY` — a dev/CI fallback only. The normal path is
  **SETTINGS ▸ OPENROUTER** in the UI; a key stored there always wins.

As with `SWARM_OS_GITHUB_TOKEN`, a variable only reaches the process if the
compose service names it in `environment:` — that block is an explicit
allow-list (§7.4).

### The other choice that matters — the host account the instance belongs to

By default the container runs as the image's own `node` user, **uid 1000**:
the right answer whenever you install from the account that owns `~/.claude`,
and nothing to do. On a host where an admin installs *for* another account — a
dedicated one, a colleague's, a service account — three variables move the whole
instance:

| Variable | What it does |
|---|---|
| `SWARM_OS_RUN_UID` / `SWARM_OS_RUN_GID` | the process uid:gid (compose `user:`). Everything it writes under `/data` and `/workspace` belongs to that account, and this is the uid that reads the mounted `~/.claude` — 0700 and all |
| `SWARM_OS_CONTAINER_HOME` | `HOME` **inside** the container. uid 1000 owns `/home/node`; any other uid has no passwd entry in the image, gets `HOME=/` and fails every plugin `npm install` that writes under it. Point it at `/data/home`, inside the one tree that account owns |
| `SWARM_OS_RUN_USER` | informational, read by the installer only: it is what makes a reconfigure keep this account instead of reverting to whoever re-runs the script |

And the paths must follow the same account, or nothing works: `CLAUDE_DIR` /
`CLAUDE_JSON` (the login **every** agent inherits), `DATA_PATH` (the container
has to write it, or it boots and then cannot write its database),
`WORKSPACE_PATH` (the agents have to edit it). Under the `ssh` transport the
user part of `SWARM_OS_SSH_TARGET` and the `SWARM_OS_HOST_*` directories name
**that same account**: it is the one the agents log into, and its private key
has to be readable by the uid above — so generate it as that account, not as
yourself.

By hand, for the account `alice`:

```sh
sudo -u alice -i claude                    # the OAuth login, in ITS home
id -u alice; id -g alice                   # → SWARM_OS_RUN_UID / _GID
sudo -u alice mkdir -p ~alice/.swarm-os/my-project/home
```

then in `.env`:

```sh
SWARM_OS_RUN_USER=alice
SWARM_OS_RUN_UID=1001
SWARM_OS_RUN_GID=1001
SWARM_OS_CONTAINER_HOME=/data/home
CLAUDE_DIR=/home/alice/.claude
CLAUDE_JSON=/home/alice/.claude.json
DATA_PATH=/home/alice/.swarm-os/my-project
WORKSPACE_PATH=/home/alice/dev/my-project
```

`setup.sh` (the self-contained installer, fetched with `curl` — see §1) makes it
a step of its own ("Run-as account", 4/12): it lists the
host's accounts, checks *from the target account* that the Claude login is
there, offers to run it if it is not, generates the SSH key under its identity
and authorises it in its own `authorized_keys`, creates `/data` and its `home`
with the right owner, and writes the variables above. `setup.sh --user alice`
does the same without asking. (`install.sh` has no run-as step: it always
configures uid 1000.)

A dedicated account is also the main security measure available today — see
[SECURITY.md](../../SECURITY.md#recommendations-for-operators).

**Never uid 0.** The container must not run as root: `setup.sh` refuses the
value, and a hand-written `.env` carrying it leaves root-owned files all over
your workspace.

### The choice that matters — the agent transport

`SWARM_OS_AGENT_TRANSPORT` decides **where the agent process runs**. It is the
one variable that changes three things at once, and the wizard asks it as a real
question (step 4):

| | `local` (default) | `ssh` |
|---|---|---|
| Where the agent runs | inside the container | on the host, over `ssh -tt` |
| Usable providers | `claude` only — the image carries nothing else | all four, with the host's own logins |
| One-click update | no (`TRANSPORT IS NOT SSH`) | yes |
| Plugin `host-exec` | no | yes |
| OAuth refresh race | possible (host and container write the same file) | impossible |
| What the agents can reach | the container and its mounts (`/workspace`, `/data`, read-only `~/.claude`) | everything the SSH account can read or change on the host |
| Isolation | the container is the boundary | none from the container: the host account is the boundary |
| What it costs | nothing | an unrestricted, passphrase-less SSH key the container can read, and agents running with the host user's privileges |

Agents run with their permission prompts off (`bypassPermissions`, `--yolo`,
`--dangerously-bypass-approvals-and-sandbox`), so under `ssh` they can do
anything that host account can do. Pick `local` unless you need what `ssh`
adds, and give an `ssh` deployment a dedicated account. The full comparison,
and what the token and plugins grant: [SECURITY.md](../../SECURITY.md).

The `ssh` transport needs a **compose overlay** on top of the base file:

```sh
docker compose -f examples/docker-compose.dist.yml \
               -f examples/docker-compose.ssh.yml up -d
```

`./install.sh` adds that `-f` by itself as soon as the env file says `ssh` — you
do not have to remember it. The overlay mounts the key's directory
(`HOST_SSH_DIR`) read-only at `/host-ssh`, adds the `host.docker.internal`
alias, and passes the `SWARM_OS_SSH_*` / `SWARM_OS_HOST_*` variables through
(its header documents each one). Keep `HOST_SSH_DIR` pointed at a directory that
holds only the swarm-os key: when it is unset the overlay falls back to your
whole `~/.ssh`.

---

## 4. Install — the guided setup

```sh
./install.sh
```

On a host with no `.env`, `install.sh` opens a **nine-step wizard**: it asks for
each value, checks each answer against the host, writes `.env`, then deploys.
Values in `[brackets]` are working answers — enter accepts them. **Nothing is
installed or written without a confirmation naming the exact command**, and every
offer can be declined, leaving you the manual path described above.

| # | Step | What it does |
|---|---|---|
| 1 | Prerequisites | Docker + Compose (offers the official `get.docker.com` install, which also adds you to the `docker` group, or starting the daemon; if you lack access to the daemon it prints the `usermod -aG docker` fix); the claude CLI through the **native installer** (`curl -fsSL https://claude.ai/install.sh \| bash`, `npm i -g @anthropic-ai/claude-code` only when neither curl nor wget exists); **the OAuth login** — it launches `claude` for you and waits; creates `~/.claude.json` if missing, because a bind mount to a non-existent file makes Docker create a *directory* there and the first session then freezes on the theme picker |
| 2 | Project | name, workspace (creates it, and offers a `git clone` if it is empty), state directory, container name, port — a port already in use is detected and a free one suggested; if `/data` is not owned by uid 1000 it offers the `chown` (the container runs as `node`, uid 1000, and otherwise cannot write its database) |
| 3 | Image | GHCR or a local build. It **tests the `docker pull` immediately**; the public image needs no login, and only if the pull fails does it offer a `docker login` (useful for a private mirror). A local build needs a full `git clone` of the repository: the kit `bootstrap.sh` downloads has no `Dockerfile` |
| 4 | Transport | `local` or `ssh` (§3, and [SECURITY.md](../../SECURITY.md)). `ssh` is listed first and marked recommended when an SSH server answers on port 22; `local` is the more isolated choice. Under `ssh`: generates a dedicated ed25519 key in its own directory, adds it to `authorized_keys`, tests the connection **and** checks that `claude` resolves in the *login* shell — the agent runs under `bash -lc`, so a CLI that only exists in the interactive branch of `~/.bashrc` is invisible to it |
| 5 | Providers | detects codex / gemini / opencode, offers to install and log in to each, picks the default provider among the ones actually present, and pins `oauth-personal` when gemini's Google login is detected |
| 6 | Remote access | loopback/SSH tunnel, **Tailscale** (install, `tailscale up`, `tailscale serve`, public URL derived from the tailnet) or a reverse proxy |
| 7 | Notifications & updates | Discord webhook; an **optional** GitHub token for release detection (empty is fine — detection works without one, §7.4). A token you do give is **tested live** against the API, so you know at once whether it is 200, 401 or 404 |
| 8 | Advanced | default model and effort, team and worker ceilings, log level, the VS Code editor. Skippable in one keystroke |
| 9 | Review | full summary with secrets masked, then a confirmation. The old `.env` is saved as `.env.backup-<timestamp>`, the new one written 0600 (it holds your tokens) |

The deploy that follows pulls (or builds) the image, starts the container, waits
for `/health` **all the way to `boot_complete`** — not merely the first 200 —,
prints the token, and then **what the instance makes of each provider**, with the
reason when one is unavailable. That is the question that always follows an
install; it is answered before it is asked.

### Options

| Command | Effect |
|---|---|
| `./install.sh` | wizard when there is no `.env`; otherwise a menu: deploy / reconfigure / quit |
| `./install.sh --reconfigure` | re-runs the wizard with your current values as the defaults |
| `./install.sh --yes` | no questions: deploys the existing `.env` (CI, cron, scripts) |
| `./install.sh --env-file <path>` | use another env file |

Re-run it any time after editing `.env`, or to move to a newer image tag.

> **Manual equivalent** (if you prefer not to use the script):
> ```sh
> set -a && source .env && set +a
> docker compose -f examples/docker-compose.dist.yml up -d
> # ssh transport: add -f examples/docker-compose.ssh.yml
> docker exec "$SWARM_OS_CONTAINER_NAME" cat /data/token
> ```
> The `set -a && source .env` step expands `${HOME}` in your paths before Compose
> reads them.

---

## 5. First login

1. Open `http://127.0.0.1:8787`.
2. The Token/Settings panel opens automatically (no token stored yet).
3. Paste the token printed by `install.sh` (or `docker exec <container> cat
   /data/token`).
4. Save — it is kept in the browser's `localStorage`. You're in.

Treat the token like a root password for the instance: it grants everything,
including running code on the machine. See
[SECURITY.md](../../SECURITY.md#the-auth-token).

---

## 6. Remote access

The UI binds to `127.0.0.1` only and there is **no TLS inside the container**.
Choose one method.

### A. Tailscale (recommended)

Put the host on your tailnet, then expose the loopback over HTTPS:

```sh
tailscale serve --bg --https=8787 http://127.0.0.1:8787
```

One line: the VS Code editor is reverse-proxied by swarm-os itself under `/ide`,
on this port. Reach it at `https://<host>.<tailnet>.ts.net:8787`. Set
`SWARM_OS_PUBLIC_URL` in `.env` to that URL so Discord deep-links resolve. No
public port is ever opened. (The wizard offers to do all of this at step 6 —
including reading your tailnet name for you.)

### B. Reverse proxy + TLS (public domain)

Terminate TLS at Caddy/nginx in front of `127.0.0.1:8787`. Requirements:

- the proxy **must forward WebSockets** (the live terminal and the events stream
  rely on them);
- **one vhost is enough.** The VS Code editor has no port to expose any more:
  `serve-web` listens on loopback *inside* the container and swarm-os
  reverse-proxies it under `/ide` on the same port, same origin. Whatever serves
  the UI serves the editor — no second certificate, no plain-HTTP iframe. You
  enable/disable it from the Plugins screen (built-in feature, BUILT-IN section —
  see [../builtin-features.md](../builtin-features.md)); `SWARM_OS_IDE_ENABLED=false`
  only seeds that state at the first boot, the database being authoritative
  thereafter.

Caddy example:

```
swarm.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Whatever you expose is still gated by the X-Auth-Token, but that token is
equivalent to code execution on the machine ([SECURITY.md](../../SECURITY.md#the-auth-token)),
and you now own patching and abuse handling. Put your own access control in
front of it (VPN, SSO, IP allow-list), and prefer Tailscale unless you genuinely
need a public URL.

### C. Localhost / SSH tunnel (simplest, safest)

Leave it on loopback and forward a port on demand:

```sh
ssh -L 8787:127.0.0.1:8787 user@host
# then browse http://127.0.0.1:8787 on your laptop
```

---

## 7. Update

Two paths. The host shell always works; the one-click update in the UI works
when the deployment qualifies (§7.2).

### 7.1 From the host shell

```sh
# bump the tag in .env (or keep :latest), then:
./install.sh        # pulls + recreates the container; /data (DB, tokens, teams) persists
```

### 7.2 One-click, from SETTINGS ▸ SYSTEM UPDATE

The drawer shows the running version, the newest published release, and one
line saying whether this deployment can update itself. It never offers a button
the host would refuse — instead it names the single reason:

| Headline | Meaning | The fix |
|---|---|---|
| `ELIGIBLE` / `HOST CHECKS PENDING` | transport and image qualify; the rest is decided on the host, at preflight | nothing |
| `TRANSPORT IS NOT SSH` | `SWARM_OS_AGENT_TRANSPORT=local` — agents run in-container, so swarm-os cannot run `docker` on the host at all | switch the transport to `ssh` and mount a key |
| `IMAGE TAG IS HARDCODED` | `SWARM_OS_IMAGE` is unset, so the compose file pins its own tag — there is no variable to rewrite | put `image: ${SWARM_OS_IMAGE}` in the compose and define the variable in `.env` |
| `IMAGE IS LOCALLY BUILT` | `SWARM_OS_IMAGE` has no registry path (`swarm-os:latest`) — nothing to pull | point at `ghcr.io/nyyyxius/swarm-os:<tag>` |
| `NO .env FOUND` / `.env IS NOT WRITABLE` | the updater found no env file beside the compose file, or the SSH account cannot write it | create it / give the SSH account (the user in `SWARM_OS_SSH_TARGET`, which runs the updater on the host) write access |
| `REGISTRY LOGIN MISSING` | the host could not pull the target image (the run ends as refused, `pull_failed`) | check the tag exists and the host reaches `ghcr.io`; the public image needs no login, a private mirror needs `docker login` on the host |

The last three are **host facts**: they are answered by the updater's preflight,
on the host, before anything is written. A run that hits one of them ends as
`REFUSED — NOTHING WAS TOUCHED`: no `.env` modified, no container recreated, no
team interrupted.

**What an update writes — exactly one line.** swarm-os rewrites the
`SWARM_OS_IMAGE=` line of *your* deployment `.env` (the one next to the compose
file it found) and nothing else in it:

- the file is copied to `<file>.bak` **before** the write, so the previous line
  is always recoverable by hand;
- the write itself is a temp file + `rename(2)` — the env file is never left
  half-written;
- then `docker compose up -d` recreates the container and the new one is polled
  on `/health` until it reports `boot_complete`;
- if that verification fails, the original line is put back, the container is
  redeployed on the previous version, and the run ends as `ROLLED BACK`. The
  `.bak` is **not** refreshed by the rollback: it still holds the pre-update
  state.

`/data` (SQLite DB, tokens, teams, logs) persists across all of this — the
container is replaced, the state directory is not.

### 7.3 What the teams get — the 120 s guarantee

An update recreates the container, which kills every running session. So before
anything is written, each live lead is sent a notice in its own session and the
run waits out a **warning window** (300 s by default).

- **That window is never shorter than 120 s.** You can ask for less; the server
  floors it. Below two minutes a lead mid-turn has no realistic chance to reach
  an idle boundary, read the notice and wrap up — that is an announcement, not a
  warning.
- The drawer shows the countdown, one line per team (`read` · `displayed,
  unread` · `never available` · `no lead` · `no answer yet`), and a sentence
  that is blunt on purpose: *"3 teams warned — 1 lead (my-project) has not read
  it yet (busy for 4m31). **Applying anyway** in 01:12."* The deadline is not a
  negotiation.
- `APPLY NOW` ends the window early — but only once the 120 s floor has elapsed;
  the server refuses (409) below it and says how many seconds are left.
- During `applying`/`verifying` the screen is taken over by a full-screen panel
  driven by the public `/health` endpoint (every authenticated call fails while
  the container is being replaced). It can be closed after five minutes; the run
  carries on without it.
- Afterwards the drawer says who came back. For a team that did not, it says
  what the interruption did to its work — *"notice delivered but never read, the
  lead was busy for the whole window. Its work was interrupted at an arbitrary
  point."* `RESTART TEAMS` is a **fresh start in place**: the session begins from
  the beginning, not where the lead was. It is checked against the live team
  list first, so a team that is running again is skipped rather than killed.

### 7.4 Update detection — `SWARM_OS_GITHUB_TOKEN` (optional)

swarm-os reads the **GitHub Releases** of `Nyyyxius/swarm-os` to know a newer
version exists. The repository is public, so the check works **without a
token**: nothing to configure. (This holds from the release after 0.10.4;
0.10.4 and earlier need `SWARM_OS_GITHUB_TOKEN` to detect updates.)

The check runs in the background at most once every 6 hours per instance, when
a browser tab is open. Unauthenticated, GitHub allows 60 API requests per hour
per IP address, which is plenty for one instance. A token only raises that
limit — useful when many instances, or other tools, share one public IP:

1. Create any **read-only** GitHub token. No scope is needed to read the
   releases of a public repository.
2. Put it in the deployment `.env`:
   ```sh
   SWARM_OS_GITHUB_TOKEN=github_pat_xxxxxxxx
   ```
3. Make sure the compose service passes it through. `environment:` is an
   **explicit allow-list** — a variable that is not named there never reaches the
   process, whatever the `.env` says. All the shipped compose files carry the
   line already:
   ```yaml
   environment:
     SWARM_OS_GITHUB_TOKEN: ${SWARM_OS_GITHUB_TOKEN:-}
   ```
4. `./install.sh` (or `docker compose up -d`) to recreate the container.

The token is only ever sent to `api.github.com`, as a read. There is no route
that writes it, echoes it, or stores it in the database. Under the `local`
transport, agents inherit the server's environment and can read it
([SECURITY.md](../../SECURITY.md#known-limitations)): use a token with no scopes.

### 7.5 Publishing a release (maintainer)

The checker reads *published GitHub releases*; a release exists only once a
`v*` tag has reached GitHub and the `release-image` workflow has run. The
procedure is in [CONTRIBUTING.md](https://github.com/Nyyyxius/swarm-os/blob/master/CONTRIBUTING.md#release-procedure-maintainers).

---

## 8. Troubleshooting

- **UI loads but every call returns 401** — wrong/empty token. Re-copy it:
  `docker exec <container> cat /data/token`.
- **A team never starts / a session hangs** — Claude credentials missing or not
  logged in. Check `~/.claude/.credentials.json` exists and that `CLAUDE_DIR` in
  `.env` points at it.
- **The container boots then dies / `EACCES` on `/data`** — the state directory
  does not belong to the process uid. Compare `stat -c %u $DATA_PATH` with
  `SWARM_OS_RUN_UID` (1000 by default), then
  `sudo chown -R <uid>:<gid> $DATA_PATH` (§3).
- **An agent cannot read the mounted `~/.claude` although it is right there** —
  it is 0700 and owned by an account other than `SWARM_OS_RUN_UID`. Align the
  uid with the owner of `CLAUDE_DIR` rather than opening up the permissions (§3).
- **A plugin fails to install with a write error** — `HOME` inside the container
  points at a directory it cannot write: uid ≠ 1000 with no
  `SWARM_OS_CONTAINER_HOME` (§3).
- **`pull access denied` / `unauthorized`** on `ghcr.io/nyyyxius/swarm-os` —
  the image is public, so this usually means a mistyped reference or tag, or a
  stale `docker login` for `ghcr.io` with an expired token: `docker logout
  ghcr.io` and pull again. A private mirror needs its own `docker login`.
- **`no matching manifest for linux/arm64`** — images up to 0.10.4 are
  published for `linux/amd64` only; later releases also ship `linux/arm64`.
- **A provider is greyed out when creating a team** — hover it: the reason comes
  from a live probe. `not on PATH` means the CLI is missing *on the host that
  runs the agents* (§1); install it and it lights up within 60 s, no restart.
  Under the `local` transport everything but `claude` is unavailable by design.
- **A codex/gemini agent starts, shows no error, then fails on authentication**
  — either the CLI is not logged in on the host, or
  `SWARM_OS_HOST_CODEX_DIR` / `_GEMINI_DIR` is unset and the per-session
  credential symlinks point at a container path (§3).
- **A codex/gemini/opencode team looks silent and never shows `waiting`** —
  expected: those CLIs have no "blocked on a human" signal, so
  `SWARM_OS_COMPACT_ON_WAITING` is a no-op for them. See
  [../providers.md](../providers.md).
- **IDE iframe is blank** — the editor is served under `/ide` on the UI's own
  port (nothing to publish). Check the IDE is enabled (Plugins screen, BUILT-IN
  section — `SWARM_OS_IDE_ENABLED` is only a first-boot seed), and that your
  reverse proxy forwards WebSockets under that path.
- **SYSTEM UPDATE cannot read the releases** — a 401 means the
  `SWARM_OS_GITHUB_TOKEN` you set is expired or revoked: replace it, or empty it
  (detection works without one). A 403/429 means GitHub's unauthenticated rate
  limit for your IP is used up: wait, or set a token. A token set in `.env` only
  takes effect if the service's `environment:` allow-list names it (§7.4).
- **Everything answers 503 right after an update** — the boot gate: auto-resume
  is replaying the teams and business routes wait for it. `/health` and `/info`
  stay green; the drawer offers CHECK AGAIN.
- **Logs** — `docker compose -f examples/docker-compose.dist.yml logs -f`.

See also: [usage.en.md](usage.en.md).
