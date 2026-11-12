# swarm-os — Deployment & handoff docs

Everything needed to install and operate swarm-os on your own host — bilingual.

| Topic | English | Français |
|---|---|---|
| Install, remote access, troubleshooting | [install.en.md](install.en.md) | [install.fr.md](install.fr.md) |
| Usage guide (concepts, UI, backups) | [usage.en.md](usage.en.md) | [usage.fr.md](usage.fr.md) |

**Read order:** install → first login → remote access → usage.

The one hard prerequisite is an **authenticated Claude Code CLI on the host**
(`~/.claude/.credentials.json` must exist). Without it, no agent can start.

TL;DR — on a bare host, one command:

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
```

From a checkout, the same wizard without the fetch:

```sh
./install.sh             # guided setup: asks, checks, writes .env, deploys
```

On a host with no `.env`, `install.sh` runs a nine-step wizard — host
prerequisites (it can install Docker and run the Claude login for you), project
paths, image + registry login, agent transport (it generates and authorises the
SSH key), the other provider CLIs, remote access (incl. Tailscale),
notifications, update detection — then deploys and prints the token, the URL and
each provider's verdict. `--reconfigure` re-runs it, `--yes` deploys an existing
`.env` without asking anything. The manual path still works:

```sh
cp .env.example .env     # edit WORKSPACE_PATH, DATA_PATH, SWARM_OS_IMAGE, project name
./install.sh
```

Two variables decide what the update surface can do — both documented in
[install.en.md §7](install.en.md): `SWARM_OS_IMAGE` (set it explicitly; it is
the line an update rewrites, `.bak` beside it) and `SWARM_OS_GITHUB_TOKEN` (any
read-only PAT — the `read:packages` one used by `docker login` works; without it
no release is ever detected).

---

## Handoff checklist (for the maintainer shipping this)

**Publish the image** — push a `vX.Y.Z` git tag (the `release-image` workflow
builds + pushes to GHCR **and cuts the GitHub Release the update checker
reads**), or run `scripts/push-image.sh vX.Y.Z`. Then grant the recipient's
GitHub account/team read access to the GHCR package.

> A release is only effective once the tag reaches GitHub:
> `git push origin master --follow-tags`. A tag that stays local publishes
> nothing — the workflow never fires and no instance sees the version. A manual
> `workflow_dispatch` run publishes `:<short-sha>` only: it does not move
> `:latest` and cuts no release.

**Hand over**: just the one-command line above plus one credential — the
recipient's GitHub account granted `read:packages` access to the GHCR package
(they log in with a classic PAT carrying that scope; the same PAT reads the
releases for update detection).
`bootstrap.sh` pulls the kit itself (`install.sh`, `bootstrap.sh`,
`.env.example`, `examples/docker-compose.{dist,ssh,multi}.yml`, `docs/deploy/`,
`LICENSE`) — that list lives in the script, in `KIT`.

**Do NOT hand over** your personal state: your `.env`, `~/.claude`, `~/.ssh`,
`docker-compose.stiix.yml` / `docker-compose.test.yml` (they hold your paths,
tailnet name and SSH keys). The recipient sets up their **own** Claude Code login.

The Software is licensed under the MIT license (see `LICENSE`).
