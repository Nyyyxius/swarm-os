# swarm-os — Installation & deployment (EN)

swarm-os orchestrates teams of autonomous Claude Code sessions. **One container =
one project.** This guide takes a fresh host to a running, accessible instance.

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

Before anything else, on the host:

```sh
npm i -g @anthropic-ai/claude-code     # install the CLI
claude                                  # complete the OAuth login once
ls ~/.claude/.credentials.json          # this file MUST exist afterwards
```

Without `~/.claude/.credentials.json`, no agent can start — a spawned session
hangs on the first-run theme picker.

---

## 2. Get the image (GHCR)

The image lives in a **private** GitHub Container Registry package. You need a
GitHub **Personal Access Token (classic)** with the `read:packages` scope, and the
maintainer must have granted your account access to the package.

```sh
echo <YOUR_PAT> | docker login ghcr.io -u <your-github-user> --password-stdin
docker pull ghcr.io/luminis1986/swarm-os:latest      # or a pinned :X.Y.Z tag
```

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
- `SWARM_OS_GITHUB_TOKEN` — optional; without it swarm-os never tells you a new
  version exists (§7.4).

The same file, next to `examples/docker-compose.dist.yml`, is
[`examples/.env.example`](../../examples/.env.example).

---

## 4. Install (easy mode)

```sh
./install.sh
```

It checks Docker, checks your Claude credentials, pulls the image, starts the
container, waits for `/health`, and prints your **access token** and URL. Re-run it
any time after editing `.env`, or to update to a newer image tag.

> **Manual equivalent** (if you prefer not to use the script):
> ```sh
> set -a && source .env && set +a
> docker compose -f examples/docker-compose.dist.yml up -d
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

---

## 6. Remote access

The UI binds to `127.0.0.1` only and there is **no TLS inside the container**.
Choose one method.

### A. Tailscale (recommended)

Put the host on your tailnet, then expose the loopback over HTTPS:

```sh
tailscale serve --bg --https=8787 http://127.0.0.1:8787
tailscale serve --bg --https=8790 http://127.0.0.1:8790   # only if the IDE is enabled
```

Reach it at `https://<host>.<tailnet>.ts.net:8787`. Set `SWARM_OS_PUBLIC_URL` in
`.env` to that URL so Discord deep-links resolve. No public port is ever opened.

### B. Reverse proxy + TLS (public domain)

Terminate TLS at Caddy/nginx in front of `127.0.0.1:8787`. Requirements:

- the proxy **must forward WebSockets** (the live terminal and the events stream
  rely on them);
- the VS Code editor (port 8790) needs **its own host/port** — `serve-web` cannot
  live under a sub-path, and an HTTPS page cannot embed a plain-HTTP iframe. Give
  8790 its own TLS vhost, or disable the editor with `SWARM_OS_IDE_ENABLED=false`.

Caddy example:

```
swarm.example.com {
    reverse_proxy 127.0.0.1:8787
}
ide.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

Whatever you expose is still gated by the X-Auth-Token, but you now own patching
and abuse handling. Prefer Tailscale unless you genuinely need a public URL.

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
| `IMAGE IS LOCALLY BUILT` | `SWARM_OS_IMAGE` has no registry path (`swarm-os:latest`) — nothing to pull | point at `ghcr.io/luminis1986/swarm-os:<tag>` |
| `NO .env FOUND` / `.env IS NOT WRITABLE` | the updater found no writable env file beside the compose file | create it / fix its ownership (the container user is uid 1000) |
| `REGISTRY LOGIN MISSING` | the host is not authenticated against GHCR | `docker login ghcr.io` with a `read:packages` PAT |

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
  that is blunt on purpose: *"3 teams warned — 1 lead (stiix-infra) has not read
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

### 7.4 Update detection — `SWARM_OS_GITHUB_TOKEN`

swarm-os reads the **GitHub Releases** of `luminis1986/swarm-os` to know a newer
version exists. That repository is private, so an unauthenticated call answers
404: with no token, the check status stays `no_token`, the badge never lights,
and no update is ever offered. Nothing else breaks — it is a healthy state, and
it means "never tell me about releases".

To turn detection on:

1. Create a **read-only** GitHub PAT with access to the swarm-os repository —
   classic PAT: scope `repo`; fine-grained PAT: permission **`Contents: Read`**.
   This is *not* the `read:packages` token used by `docker login`: that one can
   pull images but cannot read releases.
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
that writes it, echoes it, or stores it in the database.

### 7.5 Publishing a release (maintainer)

The checker reads *published GitHub releases*, and the release is cut by the
`release-image` workflow when a `v*` **tag reaches GitHub**:

```sh
# bump package.json, commit ("Release: vX.Y.Z"), tag, then:
git push origin master --follow-tags
```

A tag that only exists locally publishes nothing. `--follow-tags` is what makes
the release effective: without it the commit lands, the workflow never fires,
and no instance will ever see the new version. A manual `workflow_dispatch` run
publishes `:<short-sha>` only — it does **not** move `:latest` and cuts no
release.

---

## 8. Troubleshooting

- **UI loads but every call returns 401** — wrong/empty token. Re-copy it:
  `docker exec <container> cat /data/token`.
- **A team never starts / a session hangs** — Claude credentials missing or not
  logged in. Check `~/.claude/.credentials.json` exists and that `CLAUDE_DIR` in
  `.env` points at it.
- **`pull access denied` / `unauthorized`** — log in to GHCR with a
  `read:packages` PAT and confirm the maintainer granted your account access to
  the package.
- **IDE iframe is blank** — confirm port 8790 is published and (when remote)
  served over HTTPS matching the UI's scheme.
- **SYSTEM UPDATE says "no SWARM_OS_GITHUB_TOKEN" although you set one** — the
  variable is in `.env` but not in the service's `environment:` allow-list, so
  it never reaches the process. Add
  `SWARM_OS_GITHUB_TOKEN: ${SWARM_OS_GITHUB_TOKEN:-}` and recreate the
  container (§7.4).
- **Everything answers 503 right after an update** — the boot gate: auto-resume
  is replaying the teams and business routes wait for it. `/health` and `/info`
  stay green; the drawer offers CHECK AGAIN.
- **Logs** — `docker compose -f examples/docker-compose.dist.yml logs -f`.

See also: [usage.en.md](usage.en.md).
