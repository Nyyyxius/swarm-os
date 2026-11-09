#!/usr/bin/env bash
# swarm-os — one-command bootstrap.
#
#   curl -fsSL <bootstrap-url> | bash
#
# It fetches the deploy kit (installer, compose files, docs) into a directory
# and hands over to the guided installer, which asks its way through Docker, the
# Claude Code login, paths, image, transport, providers and remote access.
#
# The repository is public, so fetching the kit needs no token:
#
#   curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
#
# A token is only needed to fetch from a PRIVATE fork or mirror (SWARM_OS_REPO):
# give it in the environment (SWARM_OS_PAT) or with --token. When one is given it
# is also handed to the installer as the update detection token. The image itself
# is a separate matter: the installer asks for its `docker login`.
#
# Re-running it is the update path for the kit itself: files are refreshed, your
# `.env` is never touched, and the installer picks up where it left off.
#
# Options (after `bash -s --` when piping):
#   --dir <path>     where to put the kit          (default ~/swarm-os)
#   --ref <ref>      branch or tag to fetch        (default master)
#   --token <pat>    GitHub token, read-only — private fork/mirror only
#   --fetch-only     download the kit, do not start the installer
#   --help
set -euo pipefail

REPO="${SWARM_OS_REPO:-Nyyyxius/swarm-os}"
REF="${SWARM_OS_REF:-master}"
DIR="${SWARM_OS_DIR:-$HOME/swarm-os}"
TOKEN="${SWARM_OS_PAT:-${SWARM_OS_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}}"
FETCH_ONLY=0

# The kit — exactly what `docs/deploy/README.md` says to hand over. Anything not
# on this list (the server sources, the plan, the prototypes) stays behind.
KIT="
install.sh
bootstrap.sh
.env.example
LICENSE
examples/.env.example
examples/docker-compose.dist.yml
examples/docker-compose.ssh.yml
examples/docker-compose.multi.yml
docs/deploy/README.md
docs/deploy/install.en.md
docs/deploy/install.fr.md
docs/deploy/usage.en.md
docs/deploy/usage.fr.md
"

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

usage() { sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)        DIR="${2-}"; shift 2 ;;
    --ref)        REF="${2-}"; shift 2 ;;
    --token)      TOKEN="${2-}"; shift 2 ;;
    --fetch-only) FETCH_ONLY=1; shift ;;
    --help|-h)    usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
done

# ── stdin ─────────────────────────────────────────────────────────────────────
# Under `curl … | bash` the script ITSELF arrives on stdin, and bash reads it
# incrementally: `exec </dev/tty` would replace fd 0 mid-read and the rest of
# this file would simply never run — silently, exit 0. So open the terminal on a
# SECOND descriptor and read prompts from there, leaving fd 0 to bash. Probed in
# a subshell first: a failing `exec` redirection kills a non-interactive shell.
INTERACTIVE=0
TTY_FD=0
if [ -t 0 ]; then
  INTERACTIVE=1
elif [ -t 1 ] && (exec 3</dev/tty) 2>/dev/null; then
  exec 3</dev/tty
  INTERACTIVE=1
  TTY_FD=3
fi

printf '\n%s%s\n' "$C_CYAN" "  ┌────────────────────────────────────────────────┐"
printf '%s\n'     "  │   swarm-os — bootstrap                         │"
printf '%s\n'     "  │   fetch the deploy kit, then install           │"
printf '%s%s\n\n' "  └────────────────────────────────────────────────┘" "$C_RESET"

command -v curl >/dev/null 2>&1 || die "curl is required."
[ "$(id -u)" != 0 ] || warn "Running as root. swarm-os runs as uid 1000 — install it as the normal user that owns ~/.claude, or /data ends up unwritable for the container."

# ── Fetch ─────────────────────────────────────────────────────────────────────
# With a token: the API's raw media type, which is the documented way to read a
# file from a private repository and accepts both token kinds. Without one:
# raw.githubusercontent, which needs no API budget but only serves public repos.
fetch_one() {
  local path="$1" dest="$DIR/$path" url code
  mkdir -p "$(dirname "$dest")"
  if [ -n "$TOKEN" ]; then
    url="https://api.github.com/repos/${REPO}/contents/${path}?ref=${REF}"
    code="$(curl -sS -w '%{http_code}' -o "$dest.part" --retry 2 --retry-delay 1 \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github.raw" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$url" || printf '000')"
  else
    url="https://raw.githubusercontent.com/${REPO}/${REF}/${path}"
    code="$(curl -sS -w '%{http_code}' -o "$dest.part" --retry 2 --retry-delay 1 "$url" || printf '000')"
  fi
  if [ "$code" != 200 ] || [ ! -s "$dest.part" ]; then
    rm -f "$dest.part"
    printf '%s' "$code"
    return 1
  fi
  mv "$dest.part" "$dest"
  return 0
}

say "Fetching the kit for ${REPO}@${REF} into ${DIR}"
mkdir -p "$DIR" || die "cannot create $DIR"
failed=""; fetched=0
for path in $KIT; do
  if code="$(fetch_one "$path")"; then
    printf '     %s%s%s\n' "$C_DIM" "$path" "$C_RESET"
    fetched=$((fetched + 1))
  else
    failed="$failed $path($code)"
  fi
done

if [ -n "$failed" ]; then
  warn "could not fetch:$failed"
  # Whether the token is the problem is already answered by the files that DID
  # come down: diagnosing a partial fetch as an auth failure sends the operator
  # to regenerate a token that works fine.
  if [ "$fetched" -gt 0 ]; then
    note "GitHub answers fine — ${fetched} other files came down from ${REPO}@${REF}"
    die "those paths do not exist at ${REF}. Pick a ref that has them (--ref master), or ask the maintainer for a newer tag."
  fi
  case "$failed" in
    *"(401)"*|*"(403)"*) die "GitHub refused the token. It needs read access to ${REPO} (classic: scope \`repo\`; fine-grained: Contents: Read) — or drop it: the public repo needs none." ;;
    *"(404)"*) die "GitHub answered 404. Either --ref ${REF} does not exist, or ${REPO} is a private fork/mirror the token cannot see (a private repo answers 404, not 403) — pass --token." ;;
    *"(000)"*) die "could not reach api.github.com — check outbound network/DNS." ;;
  esac
  die "kit incomplete — nothing was started."
fi

# Never hand `bash` a login page or an error document: check what we got is the
# installer before making it executable.
head -1 "$DIR/install.sh" | grep -q '^#!/usr/bin/env bash' \
  || die "$DIR/install.sh is not a shell script — check the token and the ref (an error page can be a 200)."
grep -q 'swarm-os' "$DIR/install.sh" \
  || die "$DIR/install.sh does not look like the swarm-os installer."
grep -q 'guided installer' "$DIR/install.sh" \
  || warn "this ref ships the older installer: it asks nothing and expects a ready-made .env (see $DIR/.env.example)."
chmod +x "$DIR/install.sh"
ok "kit ready in $DIR"

# ── Hand over ─────────────────────────────────────────────────────────────────
if [ "$FETCH_ONLY" = 1 ]; then
  printf '\n  %sNext%s\n     cd %s && ./install.sh\n\n' "$C_BOLD" "$C_RESET" "$DIR"
  exit 0
fi
if [ "$INTERACTIVE" != 1 ]; then
  warn "No terminal available, so the guided setup cannot ask anything."
  printf '\n  %sNext, from a terminal:%s\n     cd %s && ./install.sh\n\n' "$C_BOLD" "$C_RESET" "$DIR"
  exit 0
fi

# The token the operator just gave reads releases too, which is exactly what
# update detection needs — offer it rather than asking for a second one later.
if [ -n "$TOKEN" ]; then
  export SWARM_OS_GITHUB_TOKEN="$TOKEN"
fi
say "Starting the guided setup"
cd "$DIR"
# The installer is a real file, so bash reads it from disk and its stdin is free
# to be the terminal — which is exactly what it needs to ask its questions.
if [ "$TTY_FD" = 3 ]; then
  exec ./install.sh <&3
else
  exec ./install.sh
fi
