# swarm-os — Deployment & handoff docs

Everything needed to install and operate swarm-os on your own host — bilingual.

| Topic | English | Français |
|---|---|---|
| Install, remote access, troubleshooting | [install.en.md](install.en.md) | [install.fr.md](install.fr.md) |
| Usage guide (concepts, UI, backups) | [usage.en.md](usage.en.md) | [usage.fr.md](usage.fr.md) |

**Read order:** install → first login → remote access → usage.

The one hard prerequisite is an **authenticated Claude Code CLI on the host**
(`~/.claude/.credentials.json` must exist). Without it, no agent can start.

TL;DR:

```sh
cp .env.example .env     # edit WORKSPACE_PATH, DATA_PATH, SWARM_OS_IMAGE, project name
./install.sh             # pulls the image, starts it, prints token + URL
```

---

## Handoff checklist (for the maintainer shipping this)

**Publish the image** — push a `vX.Y.Z` git tag (the `release-image` workflow
builds + pushes to GHCR), or run `scripts/push-image.sh vX.Y.Z`. Then grant the
recipient's GitHub account/team read access to the GHCR package.

**Hand over** (the kit only): the repo/source or just `install.sh`, `.env.example`,
`examples/docker-compose.dist.yml`, `docs/deploy/`, `LICENSE` — plus the image
tag and a `read:packages` access path.

**Do NOT hand over** your personal state: your `.env`, `~/.claude`, `~/.ssh`,
`docker-compose.stiix.yml` / `docker-compose.test.yml` (they hold your paths,
tailnet name and SSH keys). The recipient sets up their **own** Claude Code login.

The Software is licensed under `LICENSE` (proprietary, all rights reserved).
