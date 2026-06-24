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

- `SWARM_OS_IMAGE` — the tag you just pulled.
- `WORKSPACE_PATH` — the project the agents will work in.
- `DATA_PATH` — where persistent state is stored.
- `CLAUDE_DIR` — your `~/.claude` (default is fine on a standard layout).
- `SWARM_OS_PROJECT_NAME` — a label for the UI / logs / Discord.

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

```sh
# bump the tag in .env (or keep :latest), then:
./install.sh        # pulls + recreates the container; /data (DB, tokens, teams) persists
```

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
- **Logs** — `docker compose -f examples/docker-compose.dist.yml logs -f`.

See also: [usage.en.md](usage.en.md).
