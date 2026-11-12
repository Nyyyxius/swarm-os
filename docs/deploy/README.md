# swarm-os — Deployment docs

Everything needed to install and operate swarm-os on your own host — bilingual.

| Topic | English | Français |
|---|---|---|
| Install, remote access, troubleshooting | [install.en.md](install.en.md) | [install.fr.md](install.fr.md) |
| Usage guide (concepts, UI, backups) | [usage.en.md](usage.en.md) | [usage.fr.md](usage.fr.md) |
| Trust model: what the agents can reach, what the token grants | [../../SECURITY.md](../../SECURITY.md) | (English only) |

**Read order:** security → install → first login → remote access → usage.

The one hard prerequisite is an **authenticated Claude Code CLI on the host**
(`~/.claude/.credentials.json` must exist). Without it, no agent can start.

Before you install, know this: agents run commands **without asking for
permission**. Under the default `local` transport they are confined to the
container and its mounts; under the `ssh` transport they run on the host as your
account. [SECURITY.md](../../SECURITY.md) explains the difference and how to set
up a dedicated account.

TL;DR — on a bare host, one command (no token, no GitHub
account: the repository and the image are public):

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/install.ps1 | iex
```

From a checkout or a kit directory, the same wizard without the fetch:

```sh
./install.sh             # guided setup: asks, checks, writes .env, deploys
```

On a host with no `.env`, `install.sh` runs a nine-step wizard — host
prerequisites (it can install Docker and the native Claude CLI and run the
Claude login for you), project paths, image, agent transport (it can generate
and authorise the SSH key), the other provider CLIs, remote access (incl.
Tailscale), notifications and update detection, advanced settings, review — then
deploys and prints the token, the URL and each provider's verdict.
`--reconfigure` re-runs it, `--yes` deploys an existing `.env` without asking
anything. The manual path still works:

```sh
cp .env.example .env     # edit WORKSPACE_PATH, DATA_PATH, SWARM_OS_IMAGE, project name
./install.sh
```

A third installer, `setup.sh`, is a self-contained full-screen wizard (12 steps,
including installing for another host account). It is not in the kit; run it
from the repository with
`curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/setup.sh | bash`.
See [install.en.md §1 and §3](install.en.md).

Two variables shape the update surface — both documented in
[install.en.md §7](install.en.md): `SWARM_OS_IMAGE` (set it explicitly; it is
the line a one-click update rewrites, `.bak` beside it) and
`SWARM_OS_GITHUB_TOKEN` (optional: release detection works without it; a
read-only token only raises GitHub's API rate limit).

---

## What `bootstrap.sh` downloads

`bootstrap.sh` fetches the deploy kit into `~/swarm-os` (`--dir` to change it).
The list lives in the script, in `KIT`:

- `install.sh`, `install.ps1`, `bootstrap.sh`
- `.env.example`, `examples/.env.example`
- `examples/docker-compose.dist.yml`, `examples/docker-compose.ssh.yml`,
  `examples/docker-compose.multi.yml`
- `docs/deploy/README.md`, `docs/deploy/install.{en,fr}.md`,
  `docs/deploy/usage.{en,fr}.md`
- `LICENSE`

Nothing else (server sources, `Dockerfile`, `setup.sh`) is part of the kit. To
build the image yourself, clone the repository instead. Re-running the command
refreshes the kit and never touches your `.env`.

## Keep your own state out of the repository

Your deployment state is yours: never commit it, paste it, or copy it to
another machine. That means your `.env` (it holds your tokens), `~/.claude`,
the SSH key directory (`~/.swarm-os/ssh`, or `~/.ssh`), and the `DATA_PATH`
directory (`token`, `hook-token`, `ide-token`, the database). A local compose
file with your own paths belongs next to your `.env`, outside version control.
On another machine, run the installer again and log in to Claude Code there.

---

## Publishing a release (maintainer)

Push a `vX.Y.Z` git tag: the `release-image` workflow builds and pushes the
image to GHCR **and cuts the GitHub Release the update checker reads**.
`scripts/push-image.sh vX.Y.Z` can push an image from your own machine, but it
cuts no GitHub Release, so no instance will be told about it.

> A release is only effective once the tag reaches GitHub:
> `git push origin master --follow-tags`. A tag that stays local publishes
> nothing — the workflow never fires and no instance sees the version. A manual
> `workflow_dispatch` run publishes `:<short-sha>` only: it does not move
> `:latest` and cuts no release.

The Software is licensed under the MIT license (see `LICENSE`).
