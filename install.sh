#!/usr/bin/env bash
# swarm-os — guided installer for a deployment on a fresh host.
#
# Two modes, chosen by what it finds:
#
#   WIZARD — no `.env` yet, or `--reconfigure`. Walks through every step of
#            `docs/deploy/install.en.md`: host prerequisites, Claude Code
#            credentials, project paths, image + registry login, agent
#            transport (incl. generating and authorising an SSH key), the other
#            agent CLIs, remote access, notifications, update detection. Writes
#            `.env`, then deploys.
#   DEPLOY — `.env` is already there: pull, `compose up -d`, wait for /health,
#            print the token. Safe to re-run; this is also the update path.
#
# Rules it holds itself to:
#   * nothing is written or installed without a confirmation naming the exact
#     command — and every such step can be declined, leaving you the manual one;
#   * an existing `.env` is backed up (`.env.backup-<timestamp>`) before being
#     replaced, never edited in place;
#   * the wizard only ever writes `.env`; every other file it touches (an SSH
#     key, `authorized_keys`, the workspace and data directories) is named in
#     the prompt that creates it.
#
# Usage:
#   ./install.sh                 wizard on first run, deploy afterwards
#   ./install.sh --reconfigure   re-run the wizard, current values as defaults
#   ./install.sh --yes           non-interactive: no questions, deploy from .env
#   ./install.sh --env-file P    use env file P instead of ./.env
#   ./install.sh --help
set -euo pipefail

# Where the kit lives. `${BASH_SOURCE[0]}` is unset when this file is fed to
# bash on stdin (`curl … | bash`), and `set -u` makes that fatal, so fall back to
# the working directory — and check below that the kit is actually there.
SELF="${BASH_SOURCE[0]:-}"
case "$SELF" in
  ""|bash|-bash|sh|/dev/fd/*|/proc/self/fd/*) REPO_ROOT="$PWD" ;;
  *) REPO_ROOT="$(cd "$(dirname "$SELF")" && pwd)" ;;
esac
cd "$REPO_ROOT"

COMPOSE_DIST="examples/docker-compose.dist.yml"
COMPOSE_SSH="examples/docker-compose.ssh.yml"
DEFAULT_IMAGE="ghcr.io/nyyyxius/swarm-os:latest"
LOCAL_IMAGE="swarm-os:local"
RELEASES_API="https://api.github.com/repos/Nyyyxius/swarm-os/releases/latest"

ENV_FILE="$REPO_ROOT/.env"
MODE=""            # "" (auto) | wizard | deploy
ASSUME_YES=0
INTERACTIVE=0
# Where the prompts read from. 0 normally; 3 when stdin is not a terminal but
# one exists — `curl … | bash` feeds the SCRIPT ITSELF on stdin, so reading
# answers from fd 0 would consume the script, and `exec </dev/tty` would truncate
# it outright (bash reads a piped script incrementally). Opening a SECOND
# descriptor leaves fd 0 alone. The subshell probe is there because a failing
# redirection on `exec` kills a non-interactive shell.
TTY_FD=0
if [ -t 0 ] && [ -t 1 ]; then
  INTERACTIVE=1
elif [ -t 1 ] && (exec 3</dev/tty) 2>/dev/null; then
  exec 3</dev/tty
  INTERACTIVE=1
  TTY_FD=3
fi

# ── Presentation ──────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_CYAN=$'\033[1;36m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

say()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s  ok %s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s [!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s [x]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
note() { printf '%s     %s%s\n' "$C_DIM" "$*" "$C_RESET"; }

STEP_N=0
STEP_TOTAL=9
step() {
  STEP_N=$((STEP_N + 1))
  printf '\n%s┌─ %s[%d/%d] %s%s\n' "$C_CYAN" "$C_BOLD" "$STEP_N" "$STEP_TOTAL" "$1" "$C_RESET"
  [ -n "${2-}" ] && printf '%s│  %s%s\n' "$C_DIM" "$2" "$C_RESET"
  printf '%s└%s\n' "$C_CYAN" "$C_RESET"
  return 0
}

banner() {
  printf '\n%s%s\n' "$C_CYAN" "  ┌────────────────────────────────────────────────┐"
  printf '%s\n'     "  │   swarm-os — guided install                    │"
  printf '%s\n'     "  │   teams of autonomous coding agents, one host  │"
  printf '%s%s\n\n' "  └────────────────────────────────────────────────┘" "$C_RESET"
}

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ── Prompts ───────────────────────────────────────────────────────────────────
# All of them degrade to their default when there is no TTY or --yes was given,
# so the same code path serves an operator and a CI run.

ask() { # ask VARNAME "Question" "default"
  local __var="$1" __q="$2" __def="${3-}" __ans=""
  if [ "$INTERACTIVE" != 1 ]; then printf -v "$__var" '%s' "$__def"; return 0; fi
  if [ -n "$__def" ]; then
    read -r -u "$TTY_FD" -p "$(printf '  %s?%s %s %s[%s]%s ' "$C_CYAN" "$C_RESET" "$__q" "$C_DIM" "$__def" "$C_RESET")" __ans || true
  else
    read -r -u "$TTY_FD" -p "$(printf '  %s?%s %s: ' "$C_CYAN" "$C_RESET" "$__q")" __ans || true
  fi
  [ -z "$__ans" ] && __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

ask_secret() { # ask_secret VARNAME "Question"  — never echoed, never logged
  local __var="$1" __q="$2" __ans=""
  if [ "$INTERACTIVE" != 1 ]; then printf -v "$__var" '%s' ""; return 0; fi
  read -r -s -u "$TTY_FD" -p "$(printf '  %s?%s %s %s(hidden, empty to skip)%s: ' "$C_CYAN" "$C_RESET" "$__q" "$C_DIM" "$C_RESET")" __ans || true
  printf '\n'
  printf -v "$__var" '%s' "$__ans"
}

ask_yn() { # ask_yn "Question" [y|n]  → 0 = yes
  local q="$1" def="${2:-y}" ans="" hint="[Y/n]"
  [ "$def" = n ] && hint="[y/N]"
  if [ "$INTERACTIVE" != 1 ]; then [ "$def" = y ]; return; fi
  while true; do
    read -r -u "$TTY_FD" -p "$(printf '  %s?%s %s %s%s%s ' "$C_CYAN" "$C_RESET" "$q" "$C_DIM" "$hint" "$C_RESET")" ans || true
    [ -z "$ans" ] && ans="$def"
    case "$(lc "$ans")" in
      y|yes|o|oui) return 0 ;;
      n|no|non)    return 1 ;;
      *) printf '     answer y or n\n' ;;
    esac
  done
}

# choose VARNAME default_index "value|label|hint" ...
# Sets VARNAME to the chosen `value`. Options are printed numbered, with the
# hint dimmed underneath — the menu shape the deploy docs describe in prose.
choose() {
  local __var="$1" __def="$2"; shift 2
  local __opts=("$@") __i=1 __o __val __lab __hint __ans
  for __o in "${__opts[@]}"; do
    __val="${__o%%|*}"; __lab="${__o#*|}"; __hint="${__lab#*|}"; __lab="${__lab%%|*}"
    if [ "$__i" = "$__def" ]; then
      printf '     %s%d)%s %s%s%s %s(default)%s\n' "$C_BOLD" "$__i" "$C_RESET" "$C_BOLD" "$__lab" "$C_RESET" "$C_DIM" "$C_RESET"
    else
      printf '     %s%d)%s %s\n' "$C_BOLD" "$__i" "$C_RESET" "$__lab"
    fi
    [ -n "$__hint" ] && [ "$__hint" != "$__lab" ] && printf '        %s%s%s\n' "$C_DIM" "$__hint" "$C_RESET"
    __i=$((__i + 1))
  done
  if [ "$INTERACTIVE" != 1 ]; then
    __o="${__opts[$((__def - 1))]}"; printf -v "$__var" '%s' "${__o%%|*}"; return 0
  fi
  while true; do
    read -r -u "$TTY_FD" -p "$(printf '  %s?%s choice %s[%s]%s ' "$C_CYAN" "$C_RESET" "$C_DIM" "$__def" "$C_RESET")" __ans || true
    [ -z "$__ans" ] && __ans="$__def"
    case "$__ans" in
      ''|*[!0-9]*) printf '     enter a number\n'; continue ;;
    esac
    if [ "$__ans" -ge 1 ] && [ "$__ans" -le "${#__opts[@]}" ]; then
      __o="${__opts[$((__ans - 1))]}"; printf -v "$__var" '%s' "${__o%%|*}"; return 0
    fi
    printf '     out of range\n'
  done
}

# ── Small host helpers ────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

# A reference with a path segment can be pulled; a bare `name:tag` is a locally
# built image — the same rule the update surface applies (`IMAGE IS LOCALLY BUILT`).
image_is_registry() { case "$1" in */*) return 0 ;; *) return 1 ;; esac; }

expand_path() { # ~ and $HOME, then absolute
  local p="$1"
  case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#\~/}" ;; esac
  # `${HOME}/dev/x` has to expand — it is what .env.example teaches. Command
  # substitution does not: a path is a path, and this value came from a prompt.
  case "$p" in
    *'`'*|*'$('*) : ;;
    *'$'*) eval "p=\"$p\"" 2>/dev/null || true ;;
  esac
  case "$p" in /*) : ;; *) p="$PWD/$p" ;; esac
  printf '%s' "$p"
}

path_owner_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null || printf '%s' "-1"; }

port_in_use() { # 0 = something is listening
  # The connection is opened AND closed inside the subshell: touching a
  # descriptor of the current shell here would close the terminal we read the
  # prompts from (TTY_FD) the first time this is called.
  local p="$1"
  (exec 9<>"/dev/tcp/127.0.0.1/${p}") >/dev/null 2>&1
}

free_port_from() { # first free port at or after $1
  local p="$1"
  while port_in_use "$p" && [ "$p" -lt 65535 ]; do p=$((p + 1)); done
  printf '%s' "$p"
}

slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//'; }

run_confirmed() { # run_confirmed "why" "cmd..."  — prints the command, asks, runs it
  local why="$1"; shift
  printf '     %s%s%s\n' "$C_DIM" "$why" "$C_RESET"
  printf '     %s$ %s%s\n' "$C_BOLD" "$*" "$C_RESET"
  if ask_yn "Run it?" y; then
    "$@" && return 0
    warn "that command failed."
    return 1
  fi
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1 — host prerequisites
# ═══════════════════════════════════════════════════════════════════════════════
COMPOSE=(docker compose)

check_docker() {
  if ! have docker; then
    warn "Docker is not installed."
    if [ "$INTERACTIVE" = 1 ] && ask_yn "Install Docker Engine now with the official get.docker.com script (needs sudo)?" n; then
      curl -fsSL https://get.docker.com -o /tmp/swarm-os-get-docker.sh \
        || die "could not download the Docker install script."
      sudo sh /tmp/swarm-os-get-docker.sh || die "the Docker install script failed."
      sudo usermod -aG docker "$(id -un)" || true
      warn "Added $(id -un) to the docker group — LOG OUT AND BACK IN, then re-run ./install.sh."
      exit 0
    fi
    die "Docker is required. https://docs.docker.com/engine/install/"
  fi

  if ! docker info >/dev/null 2>&1; then
    # Capture rather than pipe: `set -o pipefail` would hand us `docker info`'s
    # own failure instead of grep's verdict, and this branch would be dead code.
    local info_err; info_err="$(docker info 2>&1 || true)"
    case "$info_err" in
      *"permission denied"*|*"Permission denied"*)
      warn "Docker is installed but this user cannot talk to the daemon."
      note "fix: sudo usermod -aG docker $(id -un)  — then log out and back in"
      ;;
      *)
      warn "The Docker daemon is not reachable."
      if [ "$INTERACTIVE" = 1 ] && have systemctl; then
        run_confirmed "start the daemon" sudo systemctl start docker || true
      fi
      ;;
    esac
    docker info >/dev/null 2>&1 || die "Docker daemon not reachable."
  fi

  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif have docker-compose; then
    COMPOSE=(docker-compose)
    warn "Using the v1 docker-compose binary. v2 (\`docker compose\`) is what this kit is tested on."
  else
    die "Docker Compose v2 not found. https://docs.docker.com/compose/install/"
  fi
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') + Compose available"
}

# The one hard prerequisite: an authenticated Claude Code CLI ON THE HOST.
# swarm-os ships no API key — every agent launches the CLI and inherits these
# credentials. Without them a spawned session hangs on the first-run theme
# picker, which looks like a swarm-os bug and is not one.
CLAUDE_DIR_HOST="${CLAUDE_DIR:-$HOME/.claude}"
CLAUDE_JSON_HOST="${CLAUDE_JSON:-$HOME/.claude.json}"

check_claude() {
  if ! have claude; then
    warn "The Claude Code CLI is not on PATH."
    if have npm; then
      run_confirmed "install the CLI globally" npm i -g @anthropic-ai/claude-code || true
    else
      note "npm is missing too — install Node.js 20+ first: https://nodejs.org/en/download"
    fi
  fi
  have claude && ok "claude CLI: $(claude --version 2>/dev/null | head -1)"

  if [ ! -f "$CLAUDE_DIR_HOST/.credentials.json" ]; then
    warn "No Claude Code credentials at $CLAUDE_DIR_HOST/.credentials.json"
    note "agents cannot start without them — this is the one blocking prerequisite"
    if [ "$INTERACTIVE" = 1 ] && have claude; then
      printf '     %sLaunching \`claude\` so you can complete the OAuth login.%s\n' "$C_DIM" "$C_RESET"
      printf '     %sFinish the login, then leave the CLI (/exit) to come back here.%s\n' "$C_DIM" "$C_RESET"
      if ask_yn "Run \`claude\` now?" y; then
        claude || true
      fi
    fi
  fi
  if [ -f "$CLAUDE_DIR_HOST/.credentials.json" ]; then
    ok "Claude credentials found at $CLAUDE_DIR_HOST"
  else
    warn "Still no credentials. The install continues, but no agent will start until you run \`claude\` and log in."
  fi

  # Bind-mounting a path that does not exist makes Docker create a DIRECTORY on
  # the host at that path; the container then reads a directory where it expects
  # `~/.claude.json` and the first spawn stalls on the theme picker.
  if [ ! -f "$CLAUDE_JSON_HOST" ]; then
    warn "$CLAUDE_JSON_HOST does not exist — Docker would create a directory there."
    if ask_yn "Create it as an empty JSON file?" y; then
      printf '{}\n' > "$CLAUDE_JSON_HOST" && ok "created $CLAUDE_JSON_HOST"
    fi
  fi
}

wiz_step_prereqs() {
  step "Host prerequisites" "Docker, Compose, and the Claude Code login every agent inherits"
  have curl || die "curl is required (health checks, registry probes)."
  check_docker
  check_claude
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2 — project identity and host paths
# ═══════════════════════════════════════════════════════════════════════════════
wiz_step_identity() {
  step "Project" "one swarm-os instance drives exactly one project"

  ask SWARM_OS_PROJECT_NAME "Project name (shown in the UI, logs and Discord)" "${SWARM_OS_PROJECT_NAME:-my-project}"
  local pslug; pslug="$(slug "$SWARM_OS_PROJECT_NAME")"
  [ -n "$pslug" ] || pslug="swarm-os"

  # Workspace — the tree the agents actually edit, mounted read-write.
  local want_ws
  ask want_ws "Workspace directory (the project the agents work in)" "${WORKSPACE_PATH:-$HOME/dev/$pslug}"
  WORKSPACE_PATH="$(expand_path "$want_ws")"
  if [ ! -d "$WORKSPACE_PATH" ]; then
    if ask_yn "$WORKSPACE_PATH does not exist. Create it?" y; then
      mkdir -p "$WORKSPACE_PATH" || die "could not create $WORKSPACE_PATH"
      ok "created $WORKSPACE_PATH"
    else
      die "the workspace directory must exist before the container mounts it."
    fi
  fi
  # A brand-new workspace is the moment to bring the code in — after this the
  # agents are the ones editing the tree.
  if [ -z "$(ls -A "$WORKSPACE_PATH" 2>/dev/null)" ] && [ "$INTERACTIVE" = 1 ]; then
    local repo_url=""
    ask repo_url "Workspace is empty — git URL to clone into it (empty to skip)" ""
    if [ -n "$repo_url" ]; then
      if have git; then
        git clone "$repo_url" "$WORKSPACE_PATH" && ok "cloned into $WORKSPACE_PATH" || warn "clone failed — continuing with an empty workspace."
      else
        warn "git is not installed — skipping the clone."
      fi
    fi
  fi

  # Data — SQLite, tokens, logs, backups, the per-session claude runtime.
  local want_data
  ask want_data "State directory (SQLite db, tokens, logs, backups)" "${DATA_PATH:-$HOME/.swarm-os/$pslug}"
  DATA_PATH="$(expand_path "$want_data")"
  mkdir -p "$DATA_PATH" || die "could not create $DATA_PATH"

  # The image drops to the unprivileged `node` user, uid 1000. A state dir owned
  # by another uid is a container that boots and then cannot write its database.
  local duid; duid="$(path_owner_uid "$DATA_PATH")"
  if [ "$duid" != "1000" ] && [ "$duid" != "-1" ]; then
    warn "$DATA_PATH is owned by uid $duid; the container runs as uid 1000 and will not be able to write there."
    run_confirmed "hand the state directory to the container's uid" sudo chown -R 1000:1000 "$DATA_PATH" || \
      warn "left as-is — expect write errors in /data until the ownership is fixed."
  fi

  ask SWARM_OS_CONTAINER_NAME "Container name (unique per instance on this host)" "${SWARM_OS_CONTAINER_NAME:-swarm-os-$pslug}"

  local want_port
  ask want_port "Host port for the web UI (bound to 127.0.0.1 only)" "${SWARM_OS_PORT:-8787}"
  # Our own container holding the port on a re-run is not a conflict.
  if port_in_use "$want_port" && \
     [ "$(docker ps --filter "name=^${SWARM_OS_CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null)" != "$SWARM_OS_CONTAINER_NAME" ]; then
    local suggest; suggest="$(free_port_from "$((want_port + 1))")"
    warn "port $want_port is already in use on this host."
    ask want_port "Pick another port" "$suggest"
  fi
  SWARM_OS_PORT="$want_port"

  CLAUDE_DIR="$CLAUDE_DIR_HOST"
  CLAUDE_JSON="$CLAUDE_JSON_HOST"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3 — image
# ═══════════════════════════════════════════════════════════════════════════════
IMAGE_SOURCE="registry"   # registry | local

wiz_step_image() {
  step "Image" "a published image from GHCR, or one built here from this source tree"

  # Reconfiguring a locally-built deployment should not silently flip it back to
  # the registry on a blind enter.
  local src def_src=1
  case "${SWARM_OS_IMAGE:-}" in */*) def_src=1 ;; ?*) def_src=2 ;; esac
  choose src "$def_src" \
    "registry|Pull the published image from GHCR|recommended — also what one-click updates re-pull" \
    "local|Build it here from this repository|needs the full source tree; disables one-click updates"
  IMAGE_SOURCE="$src"

  if [ "$IMAGE_SOURCE" = local ]; then
    [ -f "$REPO_ROOT/Dockerfile" ] || die "no Dockerfile here — a local build needs the full source tree."
    SWARM_OS_IMAGE="$LOCAL_IMAGE"
    note "the image will be built as $LOCAL_IMAGE at the deploy step"
    note "SETTINGS ▸ SYSTEM UPDATE will report IMAGE IS LOCALLY BUILT — update with git pull + ./install.sh"
    return 0
  fi

  ask SWARM_OS_IMAGE "Image reference" "${SWARM_OS_IMAGE:-$DEFAULT_IMAGE}"
  case "$SWARM_OS_IMAGE" in
    */*) : ;;
    *) warn "$SWARM_OS_IMAGE has no registry path — swarm-os will treat it as a local build (no self-update)." ;;
  esac

  # A bare `name:tag` has no registry behind it: pulling would ask Docker Hub for
  # something that only exists on this machine. Answer from the local store.
  if ! image_is_registry "$SWARM_OS_IMAGE"; then
    if docker image inspect "$SWARM_OS_IMAGE" >/dev/null 2>&1; then
      ok "$SWARM_OS_IMAGE found in the local image store"
    else
      warn "No image named $SWARM_OS_IMAGE here, and the reference has no registry to pull it from."
      note "give a full reference (ghcr.io/…/swarm-os:tag), or pick the local build above"
    fi
    return 0
  fi

  # Probe the pull now rather than at deploy: a private package failing to pull
  # is a login problem, and the login is a question, not an error message.
  say "Checking access to $SWARM_OS_IMAGE ..."
  if docker pull "$SWARM_OS_IMAGE" >/dev/null 2>&1; then
    ok "image pulled"
    return 0
  fi
  warn "Could not pull it. The GHCR package is private: it needs a \`docker login\` with a"
  note "GitHub PAT carrying the read:packages scope, on an account the maintainer has granted access."
  if [ "$INTERACTIVE" = 1 ] && ask_yn "Log in to ${SWARM_OS_IMAGE%%/*} now?" y; then
    local gh_user gh_pat
    ask gh_user "GitHub username" "${USER:-}"
    ask_secret gh_pat "GitHub PAT (read:packages)"
    if [ -n "$gh_pat" ]; then
      printf '%s' "$gh_pat" | docker login "${SWARM_OS_IMAGE%%/*}" -u "$gh_user" --password-stdin \
        && ok "logged in to ${SWARM_OS_IMAGE%%/*}" \
        || warn "docker login failed."
      unset gh_pat
      docker pull "$SWARM_OS_IMAGE" >/dev/null 2>&1 && ok "image pulled" || warn "still cannot pull $SWARM_OS_IMAGE — the deploy step will try again."
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4 — agent transport
# ═══════════════════════════════════════════════════════════════════════════════
# `local`: agents are processes inside the container. Only the claude CLI is in
#          the image, so that is the only provider, and swarm-os has no way to
#          run `docker` on the host → no one-click update.
# `ssh`  : the container opens `ssh -tt <target>` and the agent runs on the HOST
#          with the host's own logins. All four CLIs become usable, host+container
#          can never race on the same OAuth refresh, and SETTINGS ▸ SYSTEM UPDATE
#          can act.
wiz_step_transport() {
  step "Agent transport" "where the agent CLI processes actually run"

  local sshd_up=0
  port_in_use 22 && sshd_up=1
  local default_choice=1
  [ "$sshd_up" = 1 ] || default_choice=2

  local t
  choose t "$default_choice" \
    "ssh|Agents run on this host over SSH|recommended — all four provider CLIs, no OAuth race, one-click updates$([ "$sshd_up" = 1 ] || printf '%s' ' (no sshd detected on port 22)')" \
    "local|Agents run inside the container|simplest — claude only, and updates stay a shell job"
  SWARM_OS_AGENT_TRANSPORT="$t"

  if [ "$SWARM_OS_AGENT_TRANSPORT" = local ]; then
    SWARM_OS_SSH_TARGET=""; SWARM_OS_SSH_KEY=""; SWARM_OS_SSH_PORT=""; HOST_SSH_DIR=""
    note "codex / gemini / opencode will report themselves unavailable — correct, not a misconfiguration"
    return 0
  fi

  # ── SSH destination ─────────────────────────────────────────────────────────
  # `host.docker.internal` is mapped to the docker bridge gateway by the
  # compose overlay's `extra_hosts`, so this resolves from inside the container.
  local ssh_user ssh_host
  ask ssh_user "SSH user on this host (the account whose CLIs the agents inherit)" "${SSH_USER_DEFAULT:-$(id -un)}"
  ask ssh_host "Host address as seen FROM the container" "host.docker.internal"
  SWARM_OS_SSH_TARGET="${ssh_user}@${ssh_host}"
  ask SWARM_OS_SSH_PORT "SSH port" "${SWARM_OS_SSH_PORT:-22}"

  # ── Key ─────────────────────────────────────────────────────────────────────
  # The container mounts ONE directory read-only at /host-ssh; the key must live
  # in it and be readable by uid 1000 (the `node` user the image runs as).
  local keymode key_path
  choose keymode 1 \
    "generate|Generate a dedicated key and authorise it|ed25519, no passphrase, in its own directory — nothing else is exposed to the container" \
    "existing|Use an existing private key|you give the path; its directory is what gets mounted"

  if [ "$keymode" = generate ]; then
    local keydir
    ask keydir "Directory for the dedicated key" "$HOME/.swarm-os/ssh"
    keydir="$(expand_path "$keydir")"
    mkdir -p "$keydir" && chmod 700 "$keydir"
    key_path="$keydir/swarm-os-spawner"
    if [ -f "$key_path" ]; then
      ok "reusing the key already at $key_path"
    else
      have ssh-keygen || die "ssh-keygen is not installed (package openssh-client)."
      ssh-keygen -t ed25519 -N "" -C "swarm-os-${SWARM_OS_PROJECT_NAME}" -f "$key_path" >/dev/null \
        || die "ssh-keygen failed."
      ok "generated $key_path"
    fi
    # Authorise it for the SSH user. Only ever appends, and only once.
    if [ "$ssh_user" = "$(id -un)" ]; then
      mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
      touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
      if grep -qF "$(cut -d' ' -f2 "$key_path.pub")" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
        ok "key already authorised in ~/.ssh/authorized_keys"
      elif ask_yn "Append this public key to ~/.ssh/authorized_keys?" y; then
        cat "$key_path.pub" >> "$HOME/.ssh/authorized_keys"
        ok "authorised"
      fi
    else
      warn "The SSH user is $ssh_user, not $(id -un) — authorise the key yourself:"
      note "sudo -u $ssh_user tee -a ~$ssh_user/.ssh/authorized_keys < $key_path.pub"
    fi
  else
    ask key_path "Path to the private key" "$HOME/.ssh/id_ed25519"
    key_path="$(expand_path "$key_path")"
    [ -f "$key_path" ] || warn "$key_path does not exist — the agents will fail to connect until it does."
  fi

  HOST_SSH_DIR="$(dirname "$key_path")"
  SWARM_OS_SSH_KEY="/host-ssh/$(basename "$key_path")"

  # uid 1000 inside the container must be able to read the key file itself.
  local kuid; kuid="$(path_owner_uid "$key_path")"
  if [ "$kuid" != "1000" ] && [ "$kuid" != "-1" ]; then
    warn "$key_path is owned by uid $kuid; the container reads it as uid 1000 and will get EACCES."
    note "either run swarm-os with a key owned by uid 1000, or chmod 640 + a shared group"
  fi

  # ── Verify, the same way the container will ─────────────────────────────────
  if have ssh && [ -f "$key_path" ]; then
    say "Testing the SSH path the agents will take ..."
    if ssh -i "$key_path" -p "${SWARM_OS_SSH_PORT:-22}" \
         -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
         "${ssh_user}@127.0.0.1" -- true >/dev/null 2>&1; then
      ok "ssh ${ssh_user}@127.0.0.1 works with that key"
      # The agent's remote command is `bash -lc '…'`, so what matters is the
      # LOGIN shell PATH, not the interactive one. A CLI that only exists in
      # ~/.bashrc's interactive branch is invisible to a spawned agent.
      local seen; seen="$(ssh -i "$key_path" -p "${SWARM_OS_SSH_PORT:-22}" -o BatchMode=yes \
        -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "${ssh_user}@127.0.0.1" -- \
        "bash -lc 'command -v claude'" 2>/dev/null || true)"
      if [ -n "$seen" ]; then
        ok "claude resolves in the agents' login shell: $seen"
      else
        warn "claude is NOT on the login-shell PATH of $ssh_user — agents will spawn and die."
        note "add its directory to ~/.profile (agents run \`bash -lc\`, not your interactive shell)"
      fi
    else
      warn "Could not SSH to ${ssh_user}@127.0.0.1 with that key."
      note "check sshd is running, that the key is in ~$ssh_user/.ssh/authorized_keys, and PubkeyAuthentication is on"
      if ! ask_yn "Continue anyway (you can fix it and re-run ./install.sh)?" y; then
        die "stopped at the SSH check."
      fi
    fi
  fi

  # ── Host-side paths the container translates into ───────────────────────────
  # Under ssh the agent resolves paths in the HOST's namespace, so every bind
  # mount needs its host-side twin declared. Left unset, these default to the
  # CONTAINER's home and the per-session credential symlinks dangle: the agent
  # starts with no visible error and fails authentication on its first turn.
  SWARM_OS_HOST_DATA_DIR="$DATA_PATH"
  SWARM_OS_HOST_WORKSPACE_ROOT="$WORKSPACE_PATH"
  SWARM_OS_HOST_CLAUDE_DIR="$CLAUDE_DIR"
  SWARM_OS_HOST_CODEX_DIR="${SWARM_OS_HOST_CODEX_DIR:-$HOME/.codex}"
  SWARM_OS_HOST_GEMINI_DIR="${SWARM_OS_HOST_GEMINI_DIR:-$HOME/.gemini}"
  if [ -d "$HOME/.config/opencode" ]; then
    SWARM_OS_HOST_OPENCODE_DIR="${SWARM_OS_HOST_OPENCODE_DIR:-$HOME/.config/opencode}"
  else
    SWARM_OS_HOST_OPENCODE_DIR="${SWARM_OS_HOST_OPENCODE_DIR:-$HOME/.opencode}"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 5 — the other agent CLIs
# ═══════════════════════════════════════════════════════════════════════════════
provider_state() { # prints "installed+logged-in" | "installed" | "missing"
  local bin="$1" cred="$2"
  if ! have "$bin"; then printf 'missing'; return; fi
  if [ -n "$cred" ] && [ ! -e "$cred" ]; then printf 'installed'; return; fi
  printf 'installed+logged-in'
}

offer_provider() { # offer_provider <bin> <npm pkg> <login cmd or ""> <cred path or "">
  local bin="$1" pkg="$2" login="$3" cred="$4" state
  state="$(provider_state "$bin" "$cred")"
  case "$state" in
    installed+logged-in) ok "$bin — installed and authenticated"; return 0 ;;
    installed)
      warn "$bin is installed but not logged in (no $cred)."
      if [ -n "$login" ] && [ "$INTERACTIVE" = 1 ] && ask_yn "Run \`$login\` now?" y; then
        $login || warn "$login did not complete."
      fi
      ;;
    missing)
      note "$bin is not installed"
      if have npm && ask_yn "Install $bin (npm i -g $pkg)?" n; then
        npm i -g "$pkg" || { warn "install failed."; return 0; }
        if [ -n "$login" ] && [ "$INTERACTIVE" = 1 ] && ask_yn "Run \`$login\` to authenticate it?" y; then
          $login || warn "$login did not complete."
        fi
      fi
      ;;
  esac
}

wiz_step_providers() {
  step "Agent providers" "claude is set up; codex / gemini / opencode are optional"

  if [ "$SWARM_OS_AGENT_TRANSPORT" != ssh ]; then
    note "transport is \`local\`, so the image's claude CLI is the only agent that can run here"
    note "switch to the ssh transport to use the others — nothing else to configure now"
    SWARM_OS_DEFAULT_PROVIDER="claude"
    return 0
  fi

  if ask_yn "Set up other provider CLIs on this host?" n; then
    offer_provider codex    "@openai/codex"      "codex login" "$HOME/.codex/auth.json"
    offer_provider gemini   "@google/gemini-cli" "gemini"      "$HOME/.gemini/oauth_creds.json"
    offer_provider opencode "opencode-ai"        ""            ""
    note "opencode has no login: its OpenRouter key is entered in the UI under SETTINGS ▸ OPENROUTER"
  fi

  # gemini has no "use whatever works" auth mode: unpinned, it opens an auth
  # picker that repaints for ever, so the agent never goes idle and never reads
  # its team messages. The container cannot see the host's ~/.gemini, so this
  # has to be declared from here.
  if [ -f "$HOME/.gemini/oauth_creds.json" ]; then
    SWARM_OS_GEMINI_AUTH_TYPE="oauth-personal"
    ok "gemini: Google-account login detected → pinning oauth-personal"
  fi

  local opts=("claude|claude (Anthropic)|the image's own CLI, always available")
  have codex    && opts+=("codex|codex (OpenAI)|installed on this host")
  have gemini   && opts+=("gemini|gemini (Google)|installed on this host")
  have opencode && opts+=("opencode|opencode (OpenRouter)|installed on this host")
  if [ "${#opts[@]}" -gt 1 ]; then
    printf '     %sDefault provider — what a team gets when nothing names one:%s\n' "$C_DIM" "$C_RESET"
    choose SWARM_OS_DEFAULT_PROVIDER 1 "${opts[@]}"
  else
    SWARM_OS_DEFAULT_PROVIDER="claude"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 6 — remote access
# ═══════════════════════════════════════════════════════════════════════════════
# The UI binds to 127.0.0.1 and the container terminates no TLS. Everything
# remote goes through one of these three, and the choice only decides what
# SWARM_OS_PUBLIC_URL says (Discord deep-links) — the binding never changes.
ACCESS_MODE="loopback"

wiz_step_access() {
  step "Remote access" "the UI listens on 127.0.0.1 only, with no TLS in the container"

  local m
  choose m 1 \
    "loopback|Localhost only, reach it over an SSH tunnel|safest — ssh -L ${SWARM_OS_PORT}:127.0.0.1:${SWARM_OS_PORT} user@host" \
    "tailscale|Tailscale (HTTPS on your tailnet)|recommended for phone access — no public port" \
    "proxy|Reverse proxy on a public domain|you run Caddy/nginx and own the TLS + the abuse"
  ACCESS_MODE="$m"

  case "$ACCESS_MODE" in
    loopback)
      SWARM_OS_PUBLIC_URL="${SWARM_OS_PUBLIC_URL:-}"
      note "Discord deep-links stay off unless you set SWARM_OS_PUBLIC_URL later"
      ;;
    tailscale)
      if ! have tailscale; then
        warn "tailscale is not installed."
        if ask_yn "Install it now (official script, needs sudo)?" n; then
          curl -fsSL https://tailscale.com/install.sh | sh || warn "the Tailscale install script failed."
        fi
      fi
      if have tailscale; then
        if ! tailscale status >/dev/null 2>&1; then
          run_confirmed "join this host to your tailnet (opens a login URL)" sudo tailscale up || true
        fi
        local dns=""
        dns="$(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | sed 's/.*"DNSName": *"\([^"]*\)".*/\1/' | sed 's/\.$//')"
        if [ -n "$dns" ]; then
          ok "tailnet name: $dns"
          # `serve` publishes the loopback port over the tailnet with a real
          # certificate. Nothing is exposed to the public internet by it.
          if ask_yn "Publish 127.0.0.1:${SWARM_OS_PORT} on https://${dns}:${SWARM_OS_PORT} with \`tailscale serve\`?" y; then
            tailscale serve --bg --https="${SWARM_OS_PORT}" "http://127.0.0.1:${SWARM_OS_PORT}" \
              || sudo tailscale serve --bg --https="${SWARM_OS_PORT}" "http://127.0.0.1:${SWARM_OS_PORT}" \
              || warn "tailscale serve failed — run it yourself once the container is up."
          fi
          SWARM_OS_PUBLIC_URL="https://${dns}:${SWARM_OS_PORT}"
        else
          ask SWARM_OS_PUBLIC_URL "Public URL of the UI (for Discord deep-links)" "${SWARM_OS_PUBLIC_URL:-}"
        fi
      fi
      ;;
    proxy)
      note "the proxy MUST forward WebSockets — the live terminal and the event stream ride on them"
      note "the VS Code editor is reverse-proxied by swarm-os itself under /ide, so one vhost is enough"
      ask SWARM_OS_PUBLIC_URL "Public URL the operator will use" "${SWARM_OS_PUBLIC_URL:-https://swarm.example.com}"
      ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 7 — notifications and update detection
# ═══════════════════════════════════════════════════════════════════════════════
wiz_step_notifications() {
  step "Notifications & updates" "both optional; both are just one variable"

  ask SWARM_OS_DISCORD_WEBHOOK_URL "Discord webhook URL for idle / team-ended notifications (empty = off)" "${SWARM_OS_DISCORD_WEBHOOK_URL:-}"

  printf '     %sUpdate detection reads the GitHub Releases of the public swarm-os repo.%s\n' "$C_DIM" "$C_RESET"
  printf '     %sAny read-only GitHub PAT does — the read:packages one used by docker login too.%s\n' "$C_DIM" "$C_RESET"
  printf '     %sEmpty is healthy:%s\n' "$C_DIM" "$C_RESET"
  printf '     %sit simply means "never tell me about releases".%s\n' "$C_DIM" "$C_RESET"
  local pat=""
  if [ -n "${SWARM_OS_GITHUB_TOKEN:-}" ]; then
    # bootstrap.sh exports the token it was given (private fork/mirror): the
    # same read-only PAT that reads the repository reads its releases. Do not
    # make the operator find it twice.
    if ask_yn "A GitHub token is already in the environment — use it for update detection?" y; then
      pat="$SWARM_OS_GITHUB_TOKEN"
    fi
  fi
  [ -n "$pat" ] || ask_secret pat "GitHub PAT for update detection"
  if [ -n "$pat" ]; then
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $pat" "$RELEASES_API" || printf '000')"
    case "$code" in
      200) ok "token can read the releases (latest release visible)" ;;
      404) warn "the API answered 404 — the token is valid but cannot see this repository (wrong scope or no access)." ;;
      401|403) warn "the API refused the token (HTTP $code). Update detection will stay on no_token." ;;
      *) warn "could not reach api.github.com (HTTP $code) — keeping the token anyway." ;;
    esac
    SWARM_OS_GITHUB_TOKEN="$pat"
  else
    SWARM_OS_GITHUB_TOKEN="${SWARM_OS_GITHUB_TOKEN:-}"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 8 — advanced (skippable)
# ═══════════════════════════════════════════════════════════════════════════════
wiz_step_advanced() {
  step "Advanced settings" "sensible defaults are already picked — skip unless you need to tune"

  if ! ask_yn "Review advanced settings?" n; then
    SWARM_OS_DEFAULT_MODEL="${SWARM_OS_DEFAULT_MODEL:-}"
    SWARM_OS_DEFAULT_EFFORT="${SWARM_OS_DEFAULT_EFFORT:-xhigh}"
    SWARM_OS_MAX_ORCHESTRATORS="${SWARM_OS_MAX_ORCHESTRATORS:-10}"
    SWARM_OS_MAX_WORKERS_PER_ORCH="${SWARM_OS_MAX_WORKERS_PER_ORCH:-20}"
    SWARM_OS_LOG_LEVEL="${SWARM_OS_LOG_LEVEL:-info}"
    SWARM_OS_IDE_ENABLED="${SWARM_OS_IDE_ENABLED:-true}"
    return 0
  fi

  note "leave the model empty to inherit the default provider's own current model (refreshed from models.dev)"
  ask SWARM_OS_DEFAULT_MODEL "Default model id (empty = the provider's own)" "${SWARM_OS_DEFAULT_MODEL:-}"
  choose SWARM_OS_DEFAULT_EFFORT 4 \
    "low|low|" "medium|medium|" "high|high|" "xhigh|xhigh|the shipped default — costly but thorough" "max|max|"
  ask SWARM_OS_MAX_ORCHESTRATORS "Max teams running at once" "${SWARM_OS_MAX_ORCHESTRATORS:-10}"
  ask SWARM_OS_MAX_WORKERS_PER_ORCH "Max workers per team" "${SWARM_OS_MAX_WORKERS_PER_ORCH:-20}"
  choose SWARM_OS_LOG_LEVEL 3 "trace|trace|" "debug|debug|" "info|info|the shipped default" "warn|warn|" "error|error|"
  if ask_yn "Enable the built-in VS Code web editor (served under /ide on the same port)?" y; then
    SWARM_OS_IDE_ENABLED=true
  else
    SWARM_OS_IDE_ENABLED=false
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 9 — review, then write `.env`
# ═══════════════════════════════════════════════════════════════════════════════
mask() { [ -n "${1-}" ] && printf 'set (hidden)' || printf '(not set)'; }
row()  { printf '     %s%-24s%s %s\n' "$C_DIM" "$1" "$C_RESET" "${2:-—}"; }

ENV_TMP=""
env_kv()  { printf '%s=%s\n' "$1" "${2-}" >>"$ENV_TMP"; }
env_txt() { printf '%s\n' "${1-}" >>"$ENV_TMP"; }

wiz_step_review() {
  step "Review" "nothing has been written to $ENV_FILE yet"

  row "project" "$SWARM_OS_PROJECT_NAME"
  row "container" "$SWARM_OS_CONTAINER_NAME"
  row "url" "http://127.0.0.1:${SWARM_OS_PORT}"
  row "workspace" "$WORKSPACE_PATH"
  row "state (/data)" "$DATA_PATH"
  row "image" "$SWARM_OS_IMAGE$([ "$IMAGE_SOURCE" = local ] && printf '%s' ' (built here)')"
  row "transport" "$SWARM_OS_AGENT_TRANSPORT"
  if [ "$SWARM_OS_AGENT_TRANSPORT" = ssh ]; then
    row "ssh target" "${SWARM_OS_SSH_TARGET}:${SWARM_OS_SSH_PORT}"
    row "ssh key" "${SWARM_OS_SSH_KEY} (from ${HOST_SSH_DIR})"
  fi
  row "default provider" "${SWARM_OS_DEFAULT_PROVIDER:-claude}"
  row "default model" "${SWARM_OS_DEFAULT_MODEL:-(provider default)}"
  row "public url" "${SWARM_OS_PUBLIC_URL:-(none — loopback/tunnel)}"
  row "discord webhook" "$(mask "${SWARM_OS_DISCORD_WEBHOOK_URL:-}")"
  row "update detection" "$(mask "${SWARM_OS_GITHUB_TOKEN:-}")"
  printf '\n'

  ask_yn "Write this configuration and deploy?" y || die "nothing was written."
}

write_env() {
  if [ -f "$ENV_FILE" ]; then
    local bak="${ENV_FILE}.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$bak" && ok "previous config backed up to $(basename "$bak")"
  fi
  ENV_TMP="${ENV_FILE}.tmp.$$"
  : >"$ENV_TMP"

  env_txt "# swarm-os — deployment config, written by ./install.sh on $(date -u '+%Y-%m-%d %H:%M UTC')."
  env_txt "# Re-run \`./install.sh --reconfigure\` to change any of it, or edit by hand and"
  env_txt "# re-run \`./install.sh\`. Reference for every variable: docs/deploy/install.en.md"
  env_txt "# (FR: install.fr.md) and .env.example."
  env_txt "#"
  env_txt "# One KEY=VALUE per line, no quotes, no inline comments."
  env_txt ""
  env_txt "# ── Image ────────────────────────────────────────────────────────────────────"
  env_txt "# THIS is the line a one-click update rewrites in place (a .bak is left beside"
  env_txt "# this file). Keep it a plain assignment."
  env_kv  SWARM_OS_IMAGE "$SWARM_OS_IMAGE"
  env_txt ""
  env_txt "# ── Identity ─────────────────────────────────────────────────────────────────"
  env_kv  SWARM_OS_PROJECT_NAME "$SWARM_OS_PROJECT_NAME"
  env_kv  SWARM_OS_CONTAINER_NAME "$SWARM_OS_CONTAINER_NAME"
  env_txt ""
  env_txt "# ── Host paths ───────────────────────────────────────────────────────────────"
  env_kv  WORKSPACE_PATH "$WORKSPACE_PATH"
  env_kv  DATA_PATH "$DATA_PATH"
  env_kv  CLAUDE_DIR "$CLAUDE_DIR"
  env_kv  CLAUDE_JSON "$CLAUDE_JSON"
  env_txt ""
  env_txt "# ── Ports (host loopback only — never bind 0.0.0.0) ───────────────────────────"
  env_kv  SWARM_OS_PORT "$SWARM_OS_PORT"
  env_txt ""
  env_txt "# ── Agent transport ──────────────────────────────────────────────────────────"
  env_txt "# local = agents run inside the container (claude only, no one-click update)."
  env_txt "# ssh   = agents run on this host with the host's own CLI logins."
  env_kv  SWARM_OS_AGENT_TRANSPORT "$SWARM_OS_AGENT_TRANSPORT"
  if [ "$SWARM_OS_AGENT_TRANSPORT" = ssh ]; then
    env_kv SWARM_OS_SSH_TARGET "$SWARM_OS_SSH_TARGET"
    env_kv SWARM_OS_SSH_PORT "${SWARM_OS_SSH_PORT:-22}"
    env_txt "# Path INSIDE the container; HOST_SSH_DIR is what gets mounted at /host-ssh."
    env_kv SWARM_OS_SSH_KEY "$SWARM_OS_SSH_KEY"
    env_kv HOST_SSH_DIR "$HOST_SSH_DIR"
    env_txt "# Host-side twins of the bind mounts. Required under ssh: unset, they default"
    env_txt "# to the CONTAINER's home and every per-session credential symlink dangles."
    env_kv SWARM_OS_HOST_DATA_DIR "$SWARM_OS_HOST_DATA_DIR"
    env_kv SWARM_OS_HOST_WORKSPACE_ROOT "$SWARM_OS_HOST_WORKSPACE_ROOT"
    env_kv SWARM_OS_HOST_CLAUDE_DIR "$SWARM_OS_HOST_CLAUDE_DIR"
    env_kv SWARM_OS_HOST_CODEX_DIR "$SWARM_OS_HOST_CODEX_DIR"
    env_kv SWARM_OS_HOST_GEMINI_DIR "$SWARM_OS_HOST_GEMINI_DIR"
    env_kv SWARM_OS_HOST_OPENCODE_DIR "$SWARM_OS_HOST_OPENCODE_DIR"
    env_kv SWARM_OS_GEMINI_AUTH_TYPE "${SWARM_OS_GEMINI_AUTH_TYPE:-}"
  fi
  env_txt ""
  env_txt "# ── Providers ────────────────────────────────────────────────────────────────"
  env_kv  SWARM_OS_DEFAULT_PROVIDER "${SWARM_OS_DEFAULT_PROVIDER:-claude}"
  env_txt "# Empty = that provider's own default model, kept current from models.dev."
  env_kv  SWARM_OS_DEFAULT_MODEL "${SWARM_OS_DEFAULT_MODEL:-}"
  env_kv  SWARM_OS_DEFAULT_EFFORT "${SWARM_OS_DEFAULT_EFFORT:-xhigh}"
  env_txt ""
  env_txt "# ── Remote access & notifications ────────────────────────────────────────────"
  env_kv  SWARM_OS_PUBLIC_URL "${SWARM_OS_PUBLIC_URL:-}"
  env_kv  SWARM_OS_DISCORD_WEBHOOK_URL "${SWARM_OS_DISCORD_WEBHOOK_URL:-}"
  env_txt ""
  env_txt "# ── Update detection ─────────────────────────────────────────────────────────"
  env_txt "# Read-only GitHub PAT, any scope (the read:packages one works). Empty = never announce releases."
  env_kv  SWARM_OS_GITHUB_TOKEN "${SWARM_OS_GITHUB_TOKEN:-}"
  env_txt ""
  env_txt "# ── Envelopes ────────────────────────────────────────────────────────────────"
  env_kv  SWARM_OS_MAX_ORCHESTRATORS "${SWARM_OS_MAX_ORCHESTRATORS:-10}"
  env_kv  SWARM_OS_MAX_WORKERS_PER_ORCH "${SWARM_OS_MAX_WORKERS_PER_ORCH:-20}"
  env_kv  SWARM_OS_LOG_LEVEL "${SWARM_OS_LOG_LEVEL:-info}"
  # SWARM_OS_IDE_ENABLED is only a FIRST-BOOT seed default: after the first boot
  # the DB governs and the IDE is toggled from the Plugins screen (built-in
  # feature, docs/builtin-features.md). Written here just to seed that state.
  env_kv  SWARM_OS_IDE_ENABLED "${SWARM_OS_IDE_ENABLED:-true}"
  env_kv  SWARM_OS_IDE_PORT "${SWARM_OS_IDE_PORT:-8790}"

  chmod 600 "$ENV_TMP"
  mv "$ENV_TMP" "$ENV_FILE"
  ENV_TMP=""
  ok "wrote $ENV_FILE (mode 600 — it holds your tokens)"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Deploy — shared by the wizard's last step and by every plain re-run
# ═══════════════════════════════════════════════════════════════════════════════
COMPOSE_ARGS=()

load_env() {
  [ -f "$ENV_FILE" ] || die "no $ENV_FILE — run ./install.sh with a TTY to go through the wizard."
  # `source` so ${HOME} in a hand-edited path is expanded by the shell; the
  # exported values then take precedence over anything compose re-reads.
  set -a; . "$ENV_FILE"; set +a
  : "${SWARM_OS_IMAGE:?SWARM_OS_IMAGE is empty — set it in $ENV_FILE}"
  : "${SWARM_OS_CONTAINER_NAME:=swarm-os}"
  : "${SWARM_OS_PORT:=8787}"
  : "${CLAUDE_DIR:=$HOME/.claude}"
  : "${CLAUDE_JSON:=$HOME/.claude.json}"
  [ -n "${WORKSPACE_PATH:-}" ] || die "WORKSPACE_PATH is empty in $ENV_FILE"
  [ -d "$WORKSPACE_PATH" ]     || die "WORKSPACE_PATH does not exist: $WORKSPACE_PATH"
  [ -n "${DATA_PATH:-}" ]      || die "DATA_PATH is empty in $ENV_FILE"
  mkdir -p "$DATA_PATH"

  # The ssh transport needs the overlay: it is what mounts the key, adds the
  # host-gateway alias and passes the SSH_/HOST_ variables through the
  # `environment:` allow-list. Deriving it from the env file (rather than from a
  # flag) keeps a plain re-run on the same compose invocation as the first one.
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f "$COMPOSE_DIST")
  if [ "${SWARM_OS_AGENT_TRANSPORT:-local}" = ssh ]; then
    [ -f "$COMPOSE_SSH" ] || die "transport is ssh but $COMPOSE_SSH is missing from this kit."
    COMPOSE_ARGS+=(-f "$COMPOSE_SSH")
  fi
}

build_or_pull() {
  if image_is_registry "$SWARM_OS_IMAGE"; then
    say "Pulling $SWARM_OS_IMAGE"
    if ! docker pull "$SWARM_OS_IMAGE"; then
      warn "Pull failed. For a private registry, log in first:"
      note "echo <YOUR_GITHUB_PAT> | docker login ${SWARM_OS_IMAGE%%/*} -u <github-user> --password-stdin"
      note "(the PAT needs the read:packages scope)"
      die "could not pull the image."
    fi
    return 0
  fi
  # No registry path → a locally built tag. Build it if it is not there yet.
  if docker image inspect "$SWARM_OS_IMAGE" >/dev/null 2>&1 && [ "${IMAGE_SOURCE:-}" != local ]; then
    ok "using the local image $SWARM_OS_IMAGE"
    return 0
  fi
  [ -f "$REPO_ROOT/Dockerfile" ] || die "$SWARM_OS_IMAGE is not in a registry and there is no Dockerfile here."
  say "Building $SWARM_OS_IMAGE from source (this takes a few minutes) ..."
  docker build -t "$SWARM_OS_IMAGE" "$REPO_ROOT" || die "the image build failed."
  ok "built $SWARM_OS_IMAGE"
}

wait_healthy() {
  local url="http://127.0.0.1:${SWARM_OS_PORT}/health" body="" i=0
  say "Waiting for $url ..."
  for i in $(seq 1 90); do
    body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      case "$body" in
        *'"boot_complete":true'*) ok "server healthy, auto-resume finished"; return 0 ;;
        *) [ "$((i % 5))" = 0 ] && note "up, still replaying teams (boot_complete=false) ..." ;;
      esac
    fi
    sleep 1
  done
  if [ -n "$body" ]; then
    warn "the server answers /health but has not finished booting; business routes answer 503 until it does."
    return 0
  fi
  warn "the server never answered. Recent logs:"
  "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" logs --tail 40 || true
  die "startup failed."
}

read_token() {
  local t="" i=0
  for i in $(seq 1 10); do
    t="$(docker exec "$SWARM_OS_CONTAINER_NAME" cat /data/token 2>/dev/null || true)"
    [ -n "$t" ] && break
    sleep 1
  done
  printf '%s' "$t"
}

# What the instance itself thinks of each provider — the answer to the single
# most common "why is codex greyed out?" question, before it gets asked.
show_providers() {
  local token="$1"
  have python3 || return 0
  local json; json="$(curl -fsS -H "X-Auth-Token: $token" "http://127.0.0.1:${SWARM_OS_PORT}/providers" 2>/dev/null || true)"
  [ -n "$json" ] || return 0
  printf '\n  %sProviders as this instance sees them:%s\n' "$C_BOLD" "$C_RESET"
  printf '%s' "$json" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for p in d.get("providers",[]):
    mark = "ok " if p.get("available") else "-- "
    why  = "" if p.get("available") else "  (%s)" % (p.get("unavailableReason") or "unavailable")
    print("     %s%-9s%s" % (mark, p.get("id",""), why))
' || true
}

deploy() {
  step "Deploy" "pull, start, wait for the boot gate, hand you the token"
  build_or_pull
  say "Starting ${SWARM_OS_CONTAINER_NAME} ..."
  "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" up -d || die "\`compose up\` failed."
  wait_healthy

  local token; token="$(read_token)"
  local url="http://127.0.0.1:${SWARM_OS_PORT}"

  printf '\n%s%s%s\n' "$C_GREEN" "  swarm-os is up." "$C_RESET"
  printf '  %sURL%s    %s\n' "$C_DIM" "$C_RESET" "$url"
  if [ -n "${SWARM_OS_PUBLIC_URL:-}" ]; then
    printf '  %sremote%s %s\n' "$C_DIM" "$C_RESET" "$SWARM_OS_PUBLIC_URL"
  fi
  if [ -n "$token" ]; then
    printf '  %stoken%s  %s%s%s\n' "$C_DIM" "$C_RESET" "$C_BOLD" "$token" "$C_RESET"
    printf '  %s       paste it into the Token panel — it is stored in the browser localStorage%s\n' "$C_DIM" "$C_RESET"
  else
    warn "could not read the token automatically:"
    note "docker exec $SWARM_OS_CONTAINER_NAME cat /data/token"
  fi

  [ -n "$token" ] && show_providers "$token"

  printf '\n  %sNext%s\n' "$C_BOLD" "$C_RESET"
  if [ -z "${SWARM_OS_PUBLIC_URL:-}" ]; then
    printf '     from your laptop:  ssh -L %s:127.0.0.1:%s %s@<this-host>\n' "$SWARM_OS_PORT" "$SWARM_OS_PORT" "$(id -un)"
  fi
  printf '     logs:              %s %s logs -f\n' "${COMPOSE[*]}" "${COMPOSE_ARGS[*]}"
  printf '     reconfigure:       ./install.sh --reconfigure\n'
  printf '     update:            ./install.sh   (or SETTINGS ▸ SYSTEM UPDATE in the UI)\n'
  printf '     docs:              docs/deploy/install.en.md · docs/deploy/usage.en.md (FR available)\n\n'
}

# ═══════════════════════════════════════════════════════════════════════════════
# Wizard driver + entry point
# ═══════════════════════════════════════════════════════════════════════════════
run_wizard() {
  banner
  printf '  %sNine steps. Every default in [brackets] is a working answer — press enter to take it.%s\n' "$C_DIM" "$C_RESET"
  printf '  %sNothing is installed or written without a confirmation naming the command.%s\n' "$C_DIM" "$C_RESET"

  # Seed the defaults from an existing config when reconfiguring.
  [ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
  CLAUDE_DIR_HOST="${CLAUDE_DIR:-$HOME/.claude}"
  CLAUDE_JSON_HOST="${CLAUDE_JSON:-$HOME/.claude.json}"

  wiz_step_prereqs
  wiz_step_identity
  wiz_step_image
  wiz_step_transport
  wiz_step_providers
  wiz_step_access
  wiz_step_notifications
  wiz_step_advanced
  wiz_step_review
  write_env
  load_env
  STEP_TOTAL=10
  deploy
}

usage() {
  if [ -r "$SELF" ]; then
    sed -n '2,29p' "$SELF" | sed 's/^# \{0,1\}//'
  else
    printf '%s\n' \
      "swarm-os — guided installer." \
      "" \
      "  ./install.sh                 wizard on first run, deploy afterwards" \
      "  ./install.sh --reconfigure   re-run the wizard, current values as defaults" \
      "  ./install.sh --yes           non-interactive: no questions, deploy from .env" \
      "  ./install.sh --env-file P    use env file P instead of ./.env"
  fi
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --reconfigure|--wizard) MODE=wizard; shift ;;
      --yes|-y)               ASSUME_YES=1; INTERACTIVE=0; shift ;;
      --env-file)             ENV_FILE="$(expand_path "${2-}")"; shift 2 ;;
      --help|-h)              usage; exit 0 ;;
      *) die "unknown option: $1  (try --help)" ;;
    esac
  done

  # The installer is one file of a kit: without the compose files beside it there
  # is nothing to deploy. This is what piping THIS script (rather than
  # bootstrap.sh) into bash looks like, so say so instead of failing later.
  if [ ! -f "$REPO_ROOT/$COMPOSE_DIST" ]; then
    warn "no $COMPOSE_DIST next to this script (looked in $REPO_ROOT)."
    note "run ./install.sh from the kit directory, or fetch the kit first:"
    note "  curl -fsSL -H \"Authorization: Bearer <PAT>\" <raw-url>/bootstrap.sh | bash"
    die "kit incomplete."
  fi

  if [ "$MODE" = wizard ]; then
    [ "$INTERACTIVE" = 1 ] || die "--reconfigure needs a terminal to ask questions on."
    run_wizard
    exit 0
  fi

  if [ ! -f "$ENV_FILE" ]; then
    if [ "$INTERACTIVE" = 1 ]; then
      run_wizard
      exit 0
    fi
    # No TTY and no config: fall back to the old copy-and-edit path rather than
    # guessing answers nobody can confirm.
    cp .env.example "$ENV_FILE"
    warn "created $ENV_FILE from .env.example (no terminal to run the wizard on)."
    warn "edit it, then re-run ./install.sh — or run it interactively for the guided setup."
    exit 0
  fi

  # Config already there. A plain re-run deploys; the wizard is one keystroke away.
  banner
  if [ "$INTERACTIVE" = 1 ]; then
    say "Found an existing configuration: $ENV_FILE"
    local what
    choose what 1 \
      "deploy|Deploy it as it stands|pull + up -d + health check — this is also how you update" \
      "reconfigure|Re-run the wizard|current values become the defaults" \
      "quit|Quit|"
    case "$what" in
      reconfigure) run_wizard; exit 0 ;;
      quit) exit 0 ;;
    esac
  fi
  STEP_TOTAL=1; STEP_N=0
  load_env
  deploy
}

main "$@"
