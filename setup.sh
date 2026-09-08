#!/usr/bin/env bash
# swarm-os — fullscreen guided installer, self-contained.
#
#   export SWARM_OS_PAT=github_pat_xxx
#   curl -fsSL -H "Authorization: Bearer $SWARM_OS_PAT" \
#        https://raw.githubusercontent.com/luminis1986/swarm-os/master/setup.sh | bash
#
# The repository is private, so raw.githubusercontent answers 404 without that
# header — and the script needs the same read access afterwards, to fetch the
# compose files and pull the image. Exporting the token means you give it once:
# SWARM_OS_PAT, SWARM_OS_GITHUB_TOKEN, GITHUB_TOKEN and GH_TOKEN are all read
# from the environment. `| bash -s -- --token <pat>` works too, but leaves the
# token in your shell history and in `ps` output.
#
# One file, no kit, no clone. It takes a bare host to a running swarm-os:
# checks the prerequisites, asks for a GitHub token when the private repository
# or the private image needs one, lets you pick the install directory / project
# workspace / state directory (suggesting the ones that actually exist on this
# host), verifies the port is free, writes `.env`, pulls the image, starts the
# container, waits for the boot gate and hands you the access token.
#
# Options (after `bash -s --` when piping):
#   --dir <path>       install directory                (default ~/swarm-os)
#   --user <name>      host account to run as           (default: you)
#   --port <n>         host port for the UI             (default 8787)
#   --token <pat>      GitHub token, read-only
#   --ref <ref>        branch or tag to fetch the compose files from
#   --repo <o/r>       source repository                (default luminis1986/swarm-os)
#   --image <ref>      image reference to deploy
#   --no-fullscreen    keep the normal scrollback instead of the alternate screen
#   --help
#
# Re-running it is safe. Point it at a directory that already holds a `.env` and
# it offers to redeploy as it stands, or to reconfigure with your current values
# as the defaults. Your `.env` is backed up before it is ever replaced.
#
# NOTE ON `set -e`: deliberately NOT enabled. This is a long interactive
# program; a probe returning non-zero must render a red line on a screen, not
# kill the process halfway through and leave the terminal in the alternate
# buffer. Everything that must not fail is checked explicitly, with `|| die`.
set -uo pipefail

SETUP_VERSION="1.0.0"

# ── Where things come from ────────────────────────────────────────────────────
REPO="${SWARM_OS_REPO:-luminis1986/swarm-os}"
REF="${SWARM_OS_REF:-master}"
IMAGE_DEFAULT="ghcr.io/luminis1986/swarm-os:latest"
RELEASES_API="https://api.github.com/repos/${REPO}/releases/latest"

# The only files this installer needs from the repository. Everything else it
# writes itself.
KIT_DIST="examples/docker-compose.dist.yml"
KIT_SSH="examples/docker-compose.ssh.yml"

# ── Answers (globals the screens fill in) ─────────────────────────────────────
DIR="${SWARM_OS_DIR:-$HOME/swarm-os}"
TOKEN="${SWARM_OS_PAT:-${SWARM_OS_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}}"
GHCR_TOKEN=""            # may differ from TOKEN: read:packages vs contents:read
GHCR_USER=""
SWARM_OS_PROJECT_NAME=""
SWARM_OS_CONTAINER_NAME=""
SWARM_OS_IMAGE="$IMAGE_DEFAULT"
SWARM_OS_PORT="${SWARM_OS_PORT:-8787}"
WORKSPACE_PATH=""
DATA_PATH=""
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
CLAUDE_JSON="${CLAUDE_JSON:-$HOME/.claude.json}"
# ── The run-as account ────────────────────────────────────────────────────────
# WHOSE host account this instance is. Everything the container touches on the
# host belongs to it: /data, /workspace, the ~/.claude the agents authenticate
# with — and under the ssh transport the agent processes themselves are started
# as this user. It defaults to whoever runs the installer, but it does not have
# to be them: an admin can install from their own shell and hand the instance,
# with its Claude Code login, to a dedicated account. `screen_user` sets these
# four and re-derives every path that hangs off the home directory.
SELF_USER="$(id -un)"          # who is RUNNING the installer, fixed for the session
SWARM_OS_RUN_USER="$SELF_USER"
SWARM_OS_RUN_UID="$(id -u)"
SWARM_OS_RUN_GID="$(id -g)"
RUN_HOME="$HOME"
# HOME *inside* the container — see `apply_run_user`.
SWARM_OS_CONTAINER_HOME=""
SWARM_OS_AGENT_TRANSPORT="local"
SWARM_OS_SSH_TARGET=""
SWARM_OS_SSH_PORT="22"
SWARM_OS_SSH_KEY=""
HOST_SSH_DIR=""
SWARM_OS_HOST_DATA_DIR=""
SWARM_OS_HOST_WORKSPACE_ROOT=""
SWARM_OS_HOST_CLAUDE_DIR=""
SWARM_OS_HOST_CODEX_DIR=""
SWARM_OS_HOST_GEMINI_DIR=""
SWARM_OS_HOST_OPENCODE_DIR=""
SWARM_OS_GEMINI_AUTH_TYPE=""
SWARM_OS_DEFAULT_PROVIDER="claude"
SWARM_OS_DEFAULT_MODEL=""
SWARM_OS_DEFAULT_EFFORT="xhigh"
SWARM_OS_MAX_ORCHESTRATORS="10"
SWARM_OS_MAX_WORKERS_PER_ORCH="20"
SWARM_OS_LOG_LEVEL="info"
SWARM_OS_IDE_ENABLED="true"
SWARM_OS_IDE_PORT="8790"
SWARM_OS_PUBLIC_URL=""
SWARM_OS_DISCORD_WEBHOOK_URL=""
SWARM_OS_GITHUB_TOKEN=""
COMPOSE_PROJECT_NAME=""
ACCESS_MODE="loopback"

FULLSCREEN=1
RUN_USER_ARG=""
RUN_LABEL=""       # "alice (uid 1001)" — set by validate_env, printed after deploy
SKIP_TO_DEPLOY=0
ENV_FILE=""
COMPOSE=(docker compose)
COMPOSE_ARGS=()

# ══════════════════════════════════════════════════════════════════════════════
# 1. Terminal plumbing
# ══════════════════════════════════════════════════════════════════════════════
# Under `curl … | bash` the SCRIPT ITSELF arrives on stdin and bash reads it
# incrementally, so `exec </dev/tty` would replace fd 0 mid-read and the rest of
# this file would silently never run. Open the terminal on a SECOND descriptor
# and read every keystroke from there, leaving fd 0 to bash. The subshell probe
# comes first because a failing redirection on `exec` kills the shell outright.
TTY_FD=0
INTERACTIVE=0
if [ -t 0 ] && [ -t 1 ]; then
  INTERACTIVE=1
elif [ -t 1 ] && (exec 3</dev/tty) 2>/dev/null; then
  exec 3</dev/tty
  INTERACTIVE=1
  TTY_FD=3
fi

# Fractional read timeouts are bash 4.0+. On bash 3.2 (stock macOS) a bare ESC
# costs a one-second pause; every other key is unaffected.
ESC_T="0.05"
[ "${BASH_VERSINFO[0]:-3}" -ge 4 ] || ESC_T="1"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_REV=$'\033[7m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_REV=""
  C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi

# Box-drawing only where the locale says the terminal can render it.
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]*8*|*[Uu][Tt][Ff]8*) G_H="─"; G_OK="✓"; G_NO="✗"; G_WARN="!"; G_DOT="•"
                                    G_SEL="▸"; G_UP="↑"; G_DN="↓"; G_RET="⏎" ;;
  *) G_H="-"; G_OK="+"; G_NO="x"; G_WARN="!"; G_DOT="*"
     G_SEL=">"; G_UP="^"; G_DN="v"; G_RET="<-" ;;
esac

UI_ALT=0
UI_ROW=1
UI_H=24
UI_W=80
CW=76          # content width

ui_size() {
  local s=""
  s="$(stty size <&"$TTY_FD" 2>/dev/null)" || s=""
  if [ -z "$s" ]; then s="$( { tput lines; tput cols; } 2>/dev/null | tr '\n' ' ')"; fi
  UI_H="${s%% *}"; UI_W="${s##* }"
  case "$UI_H" in ''|*[!0-9]*) UI_H=24 ;; esac
  case "$UI_W" in ''|*[!0-9]*) UI_W=80 ;; esac
  # A pty with no window size set answers "0 0", which is numeric and would put
  # the footer on row -1.
  [ "$UI_H" -lt 10 ] && UI_H=24
  [ "$UI_W" -lt 20 ] && UI_W=80
  CW=$((UI_W - 4)); [ "$CW" -gt 92 ] && CW=92
  [ "$CW" -lt 40 ] && CW=40
}

# ── Terminal mode ─────────────────────────────────────────────────────────────
# `read -rsn1` puts the terminal in non-canonical mode for the duration of that
# ONE read and hands it back afterwards. Between two reads — while a screen
# redraws, while a validator forks — the line discipline is in charge again, and
# it EATS the control characters it owns: ^U (kill), ^W (word-erase) and, worst
# of all, backspace (erase). A keystroke that lands in that window is silently
# swallowed, which reads as "this installer randomly ignores my backspace".
# So take the terminal out of canonical mode once, for the whole wizard, and put
# it back exactly as it was on the way out. ISIG stays on: ^C must keep raising
# SIGINT so the abort trap can run.
STTY_SAVED=""
tty_raw() {
  [ -n "$STTY_SAVED" ] && return 0
  STTY_SAVED="$(stty -g <&"$TTY_FD" 2>/dev/null)" || STTY_SAVED=""
  [ -n "$STTY_SAVED" ] || return 0
  stty -icanon -echo min 1 time 0 <&"$TTY_FD" 2>/dev/null || true
}
tty_restore() {
  [ -n "$STTY_SAVED" ] || return 0
  stty "$STTY_SAVED" <&"$TTY_FD" 2>/dev/null || true
  STTY_SAVED=""
}

ui_enter() {
  tty_raw
  [ "$FULLSCREEN" = 1 ] || return 0
  printf '\033[?1049h\033[?25l'
  UI_ALT=1
}

ui_leave() {
  printf '\033[?25h'
  if [ "$UI_ALT" = 1 ]; then printf '\033[?1049l'; UI_ALT=0; fi
  tty_restore
}

ui_abort() { ui_leave; printf '\n  %sInstallation cancelled — nothing was deployed.%s\n\n' "$C_DIM" "$C_RESET"; exit 130; }
trap ui_leave EXIT
trap ui_abort INT TERM

die() { ui_leave; printf '\n  %s%s%s %s\n\n' "$C_RED" "$G_NO" "$C_RESET" "$*" >&2; exit 1; }

rule() { local n=${1:-$CW} i out=""; i=0; while [ "$i" -lt "$n" ]; do out="$out$G_H"; i=$((i+1)); done; printf '%s' "$out"; }

# ── Output primitives. Every one of them advances UI_ROW so widgets know where
#    they are allowed to draw. ────────────────────────────────────────────────
ui_out()  { printf '\033[K  %s\n' "$*"; UI_ROW=$((UI_ROW+1)); }
ui_gap()  { printf '\033[K\n'; UI_ROW=$((UI_ROW+1)); }
ui_dim()  { ui_out "${C_DIM}$*${C_RESET}"; }

# Widgets that draw with absolute cursor moves leave the physical cursor where
# they last painted, which is not where UI_ROW now says the next line goes. Put
# the two back in agreement before anything prints relatively again.
ui_goto() { printf '\033[%d;1H' "$UI_ROW"; }

# Fold prose to the content width. Plain text only — an embedded escape sequence
# would be counted as visible characters and the fold would come out wrong. The
# `set -f` dance is there so a stray `*` in a message is not glob-expanded.
ui_fold() {
  local sink="$1"; shift
  local text="$*" line="" word sv="$-"
  set -f
  for word in $text; do
    if [ -z "$line" ]; then line="$word"
    elif [ $(( ${#line} + 1 + ${#word} )) -le $((CW - 2)) ]; then line="$line $word"
    else "$sink" "$line"; line="$word"; fi
  done
  [ -n "$line" ] && "$sink" "$line"
  case "$sv" in *f*) : ;; *) set +f ;; esac
  return 0
}
ui_wrap()    { ui_fold ui_out "$@"; }
ui_wrapdim() { ui_fold ui_dim "$@"; }
ui_ok()   { ui_out "${C_GREEN}${G_OK}${C_RESET} $*"; }
ui_no()   { ui_out "${C_RED}${G_NO}${C_RESET} $*"; }
ui_warn() { ui_out "${C_YELLOW}${G_WARN}${C_RESET} $*"; }
# A value that would wrap pushes every line below it down and leaves the
# previous frame showing through, so keep the tail (the informative end of a
# path) and mark the cut.
ui_kv() {
  local v="${2:-—}" max=$((CW - 24))
  [ "$max" -lt 12 ] && max=12
  [ "${#v}" -gt "$max" ] && v="…${v:$(( ${#v} - max + 1 ))}"
  printf '\033[K  %s%-22s%s %s\n' "$C_DIM" "$1" "$C_RESET" "$v"
  UI_ROW=$((UI_ROW+1))
}

STEP_NO=0
STEP_TOTAL=12

# ui_head "Title" "one-line subtitle"
ui_head() {
  ui_size
  local sub="${2-}"
  [ "${#sub}" -gt "$CW" ] && sub="…${sub:$(( ${#sub} - CW + 1 ))}"
  printf '\033[H\033[2J'
  printf '  %s%sswarm-os%s%s  %s guided install%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET" "$C_DIM" "$G_DOT" "$C_RESET"
  printf '  %s%s%s\n' "$C_DIM" "$(rule)" "$C_RESET"
  if [ "$STEP_NO" -gt 0 ]; then
    printf '  %s[%d/%d]%s  %s%s%s\n' "$C_DIM" "$STEP_NO" "$STEP_TOTAL" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"
  else
    printf '  %s%s%s\n' "$C_BOLD" "$1" "$C_RESET"
  fi
  [ -n "$sub" ] && printf '  %s%s%s\n' "$C_DIM" "$sub" "$C_RESET"
  printf '\n'
  UI_ROW=6
  [ -n "$sub" ] || UI_ROW=5
  return 0
}

# Footer is pinned to the last line; it never moves UI_ROW.
ui_foot() {
  printf '\033[%d;1H\033[K  %s%s%s' "$((UI_H-1))" "$C_DIM" "$(rule)" "$C_RESET"
  printf '\033[%d;1H\033[K  %s%s%s' "$UI_H" "$C_DIM" "$*" "$C_RESET"
}

FOOT_MENU="$G_UP$G_DN move   1-9 jump   $G_RET select   esc back   q quit"
FOOT_TEXT="type to edit   tab complete   $G_RET confirm   esc back   ^C quit"

# ── Keyboard ──────────────────────────────────────────────────────────────────
# Sets KEYTYPE (enter|up|down|left|right|bs|tab|kill|word|esc|char|eof|other)
# and, for `char`, KEY. Returning through globals rather than stdout is what
# makes a literal space keypress survive — `$(...)` would strip it.
KEY=""; KEYTYPE=""
ui_key() {
  local k="" rest=""
  KEY=""; KEYTYPE=""
  IFS= read -rsn1 -u "$TTY_FD" k || { KEYTYPE=eof; return 0; }
  if [ -z "$k" ]; then KEYTYPE=enter; return 0; fi
  case "$k" in
    $'\033')
      # Read the WHOLE control sequence, however long. Reading a fixed two
      # bytes desynchronises the parser on everything longer — PageUp/Down
      # (`\033[5~`), Home/End on the Linux console and in tmux (`\033[1~`),
      # modified arrows (`\033[1;5C`), F5+ — and the leftovers come back as
      # ordinary keypresses: characters injected into the field being typed
      # (invisibly, in the masked token field), or a stray `q` that aborts a
      # menu. Parameter bytes are 0x30-0x3F; anything else ends the sequence.
      local intro="" c=""
      IFS= read -rsn1 -t "$ESC_T" -u "$TTY_FD" intro 2>/dev/null || intro=""
      if [ -z "$intro" ]; then KEYTYPE=esc; return 0; fi
      rest=""
      if [ "$intro" = "[" ] || [ "$intro" = "O" ]; then
        while :; do
          IFS= read -rsn1 -t "$ESC_T" -u "$TTY_FD" c 2>/dev/null || break
          rest="$rest$c"
          case "$c" in
            [0-9\;:\<\=\>\?]) continue ;;
            *) break ;;
          esac
        done
      fi
      case "${intro}${rest}" in
        '[A'|'OA') KEYTYPE=up ;;
        '[B'|'OB') KEYTYPE=down ;;
        '[C'|'OC') KEYTYPE=right ;;
        '[D'|'OD') KEYTYPE=left ;;
        '[H'|'OH'|'[1~'|'[7~') KEYTYPE=home ;;
        '[F'|'OF'|'[4~'|'[8~') KEYTYPE=end ;;
        '[3~') KEYTYPE=del ;;
        *) KEYTYPE=other ;;
      esac ;;
    $'\177'|$'\b') KEYTYPE=bs ;;
    $'\t')         KEYTYPE=tab ;;
    $'\025')       KEYTYPE=kill ;;   # ^U
    $'\027')       KEYTYPE=word ;;   # ^W
    $'\003')       KEYTYPE=int ;;    # ^C, when the terminal is not generating SIGINT
    *)             KEYTYPE=char; KEY="$k" ;;
  esac
}

# Runs an interactive command (a login, an editor) outside the alternate screen,
# then comes back to exactly where we were.
ui_suspend() {
  local rc=0
  ui_leave
  printf '\n'
  "$@" <&"$TTY_FD" || rc=$?
  printf '\n  %s[press enter to return to the installer]%s ' "$C_DIM" "$C_RESET"
  read -r -u "$TTY_FD" _ 2>/dev/null || true
  ui_enter
  return $rc
}

# ── Widgets ───────────────────────────────────────────────────────────────────
# All of them signal "the user wants the previous screen" by setting UI_BACK=1
# and returning 0, because a non-zero return would have to be handled at every
# single call site.
UI_BACK=0

# ui_menu VARNAME default_index "value|label|hint" ...
ui_menu() {
  local __var="$1" __sel="$2"; shift 2
  # Split from the scalars on purpose: `local a=(…) b=…` is not portable back to
  # the bash 3.2 that stock macOS still ships.
  local __opts
  __opts=("$@")
  local __n=$# __row=$UI_ROW __i __o __val __lab __hint __lines=2 __max
  UI_BACK=0
  __sel=$((__sel - 1))
  [ "$__sel" -lt 0 ] && __sel=0
  [ "$__sel" -ge "$__n" ] && __sel=$((__n - 1))
  # Two lines per option is the readable shape, but a long list on a short
  # terminal would run straight through the footer. Drop the hints rather than
  # the options — losing a choice is worse than losing its explanation.
  [ $(( __n * 2 )) -gt $(( UI_H - __row - 2 )) ] && __lines=1
  __max=$((CW - 8))
  printf '\033[?25l'
  while :; do
    printf '\033[%d;1H' "$__row"
    __i=0
    while [ "$__i" -lt "$__n" ]; do
      __o="${__opts[$__i]}"
      __val="${__o%%|*}"; __lab="${__o#*|}"; __hint="${__lab#*|}"; __lab="${__lab%%|*}"
      [ "$__hint" = "$__lab" ] && __hint=""
      [ "${#__lab}" -gt "$__max" ] && __lab="…${__lab:$(( ${#__lab} - __max + 1 ))}"
      if [ "$__i" = "$__sel" ]; then
        printf '\033[K   %s%s %s%s\n' "$C_CYAN" "$G_SEL" "$__lab" "$C_RESET"
      else
        printf '\033[K     %s\n' "$__lab"
      fi
      if [ "$__lines" = 2 ]; then
        if [ -n "$__hint" ]; then
          [ "${#__hint}" -gt "$__max" ] && __hint="${__hint:0:$((__max - 1))}…"
          printf '\033[K       %s%s%s\n' "$C_DIM" "$__hint" "$C_RESET"
        else
          printf '\033[K\n'
        fi
      fi
      __i=$((__i + 1))
    done
    ui_foot "$FOOT_MENU"
    ui_key
    case "$KEYTYPE" in
      up)    __sel=$(( (__sel - 1 + __n) % __n )) ;;
      down)  __sel=$(( (__sel + 1) % __n )) ;;
      home)  __sel=0 ;;
      end)   __sel=$((__n - 1)) ;;
      enter|right) break ;;
      esc|left) UI_BACK=1; break ;;
      int|eof) ui_abort ;;
      char)
        case "$KEY" in
          j) __sel=$(( (__sel + 1) % __n )) ;;
          k) __sel=$(( (__sel - 1 + __n) % __n )) ;;
          q) ui_abort ;;
          [1-9]) [ "$KEY" -le "$__n" ] && { __sel=$((KEY - 1)); break; } ;;
        esac ;;
    esac
  done
  UI_ROW=$((__row + __n * __lines))
  ui_goto
  __o="${__opts[$__sel]}"
  printf -v "$__var" '%s' "${__o%%|*}"
}

# A validator is a function name; it is handed the current buffer and sets
# V_STATE (ok|warn|err|"") and V_MSG. It runs on every keystroke, so it must be
# cheap — a stat, a local TCP probe, never a network round-trip.
V_STATE=""; V_MSG=""

# ui_input VARNAME "label" "default" [validator] [secret]
ui_input() {
  local __var="$1" __label="$2" __buf="${3-}" __valid="${4-}" __secret="${5-0}"
  local __row=$UI_ROW __shown __col __hint __vis
  UI_BACK=0
  while :; do
    if [ "$__secret" = 1 ]; then
      __shown="$(printf '%*s' "${#__buf}" '' | tr ' ' '*')"
    else
      __shown="$__buf"
    fi
    # A fine-grained PAT is ~93 characters: unclamped it wraps on an 80-column
    # terminal, the validation line then overwrites the wrapped remainder, and
    # every absolute cursor move below is off by a row from there on. Show the
    # tail — the end of a path or a token is the part being edited.
    __vis=$(( UI_W - 5 - ${#__label} ))
    [ "$__vis" -lt 12 ] && __vis=12
    if [ "${#__shown}" -gt "$__vis" ]; then
      __shown="…${__shown:$(( ${#__shown} - __vis + 1 ))}"
    fi
    printf '\033[%d;1H\033[K  %s%s%s %s%s%s\n' "$__row" "$C_DIM" "$__label" "$C_RESET" "$C_BOLD" "$__shown" "$C_RESET"
    V_STATE=""; V_MSG=""
    [ -n "$__valid" ] && "$__valid" "$__buf"
    # One line, always: a message that wrapped would push the footer off and
    # leave the previous frame's text visible underneath.
    [ "${#V_MSG}" -gt $((CW - 4)) ] && V_MSG="${V_MSG:0:$((CW - 5))}…"
    printf '\033[%d;1H\033[K' "$((__row + 1))"
    case "$V_STATE" in
      ok)   printf '  %s%s%s %s' "$C_GREEN" "$G_OK" "$C_RESET" "$V_MSG" ;;
      warn) printf '  %s%s %s%s' "$C_YELLOW" "$G_WARN" "$V_MSG" "$C_RESET" ;;
      err)  printf '  %s%s %s%s' "$C_RED" "$G_NO" "$V_MSG" "$C_RESET" ;;
      *)    [ -n "$V_MSG" ] && printf '  %s%s%s' "$C_DIM" "$V_MSG" "$C_RESET" ;;
    esac
    ui_foot "$FOOT_TEXT"
    # Park the cursor at the end of what was typed, never past the last column.
    __col=$((3 + ${#__label} + 1 + ${#__shown}))
    [ "$__col" -gt "$UI_W" ] && __col="$UI_W"
    printf '\033[%d;%dH\033[?25h' "$__row" "$__col"
    ui_key
    printf '\033[?25l'
    case "$KEYTYPE" in
      enter)
        # A validator that says `err` refuses the value rather than letting the
        # wizard carry a broken answer forward. Say so in the footer, or the
        # enter key just looks broken.
        if [ "$V_STATE" = err ]; then
          ui_foot "${C_RED}that answer cannot be used${C_RESET}${C_DIM} — fix it, or esc to go back"
          continue
        fi
        break ;;
      bs)   __buf="${__buf%?}" ;;
      kill) __buf="" ;;
      word) __buf="$(printf '%s' "$__buf" | sed 's|[^ /]*/*[ ]*$||')" ;;
      tab)  [ "$__secret" = 1 ] || __buf="$(path_complete "$__buf")" ;;
      esc)  UI_BACK=1; break ;;
      int|eof) ui_abort ;;
      char) __buf="$__buf$KEY" ;;
    esac
  done
  UI_ROW=$((__row + 3))
  ui_goto
  printf -v "$__var" '%s' "$__buf"
}

# ui_confirm "Question" [y|n]  → 0 = yes, 1 = no. ESC counts as no.
ui_confirm() {
  local q="$1" def="${2:-y}" hint="[Y/n]" row=$UI_ROW
  [ "$def" = n ] && hint="[y/N]"
  while :; do
    printf '\033[%d;1H\033[K  %s?%s %s %s%s%s ' "$row" "$C_CYAN" "$C_RESET" "$q" "$C_DIM" "$hint" "$C_RESET"
    ui_foot "y / n   esc = no   ^C quit"
    ui_key
    case "$KEYTYPE" in
      enter)   UI_ROW=$((row+1)); ui_goto; [ "$def" = y ] && return 0; return 1 ;;
      esc)     UI_ROW=$((row+1)); ui_goto; return 1 ;;
      int|eof) ui_abort ;;
      char)
        case "$KEY" in
          y|Y|o|O) UI_ROW=$((row+1)); ui_goto; return 0 ;;
          n|N)     UI_ROW=$((row+1)); ui_goto; return 1 ;;
        esac ;;
    esac
  done
}

# Blocks until the user acknowledges. Returns 1 when they asked to go back.
ui_pause() {
  ui_foot "${1:-$G_RET continue   esc back   ^C quit}"
  while :; do
    ui_key
    case "$KEYTYPE" in
      enter|right) ui_goto; return 0 ;;
      esc|left)    UI_BACK=1; ui_goto; return 1 ;;
      int|eof)     ui_abort ;;
      char) case "$KEY" in q) ui_abort ;; esac ;;
    esac
  done
}

# ══════════════════════════════════════════════════════════════════════════════
# 2. Host probes
# ══════════════════════════════════════════════════════════════════════════════
have() { command -v "$1" >/dev/null 2>&1; }

expand_path() {
  local p="$1" ex
  case "$p" in
    "~")   p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
  esac
  # `${HOME}/dev/x` must expand — it is what .env.example teaches. Anything that
  # could RUN must not: this value came from a prompt, not from source. And the
  # expansion goes through a subshell with `set +u`, because an unset variable
  # under `set -u` kills the shell before the closing printf, and every caller
  # is a `$( … )` that would just receive an empty path.
  case "$p" in
    *'`'*|*'$('*|*'"'*|*';'*|*'&'*|*'|'*|*'<'*|*'>'*) : ;;
    *'$'*)
      ex="$(set +u; eval "printf '%s' \"$p\"" 2>/dev/null)" || ex=""
      [ -n "$ex" ] && p="$ex"
      ;;
  esac
  case "$p" in /*) : ;; "") : ;; *) p="$PWD/$p" ;; esac
  # Trim a trailing slash so two answers for the same directory compare equal.
  case "$p" in */) [ "$p" = "/" ] || p="${p%/}" ;; esac
  printf '%s' "$p"
}

path_owner_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null || printf '%s' "-1"; }

# ── Acting for the run-as account ─────────────────────────────────────────────
# `getent` rather than /etc/passwd: it is the only lookup that also sees LDAP /
# SSSD accounts, which is exactly the shape a shared build host has.
user_field()  { getent passwd "$1" 2>/dev/null | head -1 | cut -d: -f"$2"; }
user_exists() { getent passwd "$1" >/dev/null 2>&1; }
user_home()   { user_field "$1" 6; }
user_uid()    { user_field "$1" 3; }
user_gid()    { user_field "$1" 4; }

# Called on every keystroke through the path validators, so no fork: `$(id -un)`
# would be one per call.
is_self() { [ "$SWARM_OS_RUN_USER" = "$SELF_USER" ]; }

# Everything below is `sudo -n` — NEVER a bare sudo. A password prompt would
# land on a terminal this installer holds in raw mode with echo off: the screen
# would simply stop, with the typing invisible. Where a password may genuinely
# be needed the caller goes through `ui_suspend`, which restores the terminal.
SUDO_RUN_OK=""     # "" not probed yet | 1 usable | 0 no non-interactive path
RUN_AS_CMD=()      # the prefix that works on THIS host, probed once
can_run_as() {
  is_self && return 0
  if [ -z "$SUDO_RUN_OK" ]; then
    SUDO_RUN_OK=0
    RUN_AS_CMD=()
    if have sudo && sudo -n -u "$SWARM_OS_RUN_USER" true </dev/null >/dev/null 2>&1; then
      RUN_AS_CMD=(sudo -n -u "$SWARM_OS_RUN_USER"); SUDO_RUN_OK=1
    elif [ "$(id -u)" = 0 ] && have runuser \
         && runuser -u "$SWARM_OS_RUN_USER" -- true </dev/null >/dev/null 2>&1; then
      # A minimal host installed from a root shell may carry no sudo at all.
      RUN_AS_CMD=(runuser -u "$SWARM_OS_RUN_USER" --); SUDO_RUN_OK=1
    fi
  fi
  [ "$SUDO_RUN_OK" = 1 ]
}

# ALWAYS with stdin closed. These run while the installer holds the terminal in
# raw mode, and a child that inherits that terminal DRAINS the keystrokes the
# operator has already typed — verified: two buffered keys vanish into a single
# `sudo -n … true`. Nothing routed through here ever wants stdin; the things
# that do go through `ui_suspend`, which hands the terminal over on purpose.
as_run_user() {
  if is_self; then "$@" </dev/null; return; fi
  can_run_as || return 1
  [ "${#RUN_AS_CMD[@]}" -gt 0 ] || return 1
  "${RUN_AS_CMD[@]}" "$@" </dev/null
}

# The interactive twin: for what must not end up owned by the installer AND may
# talk to the operator (a git clone over ssh, an OAuth login). `ui_suspend` has
# handed the terminal back by then, so a plain `sudo` password prompt is safe
# here — the only place in this script where that is true.
suspend_as_run_user() {
  if is_self; then
    ui_suspend "$@"
  elif have sudo; then
    ui_suspend sudo -u "$SWARM_OS_RUN_USER" "$@"
  elif [ "$(id -u)" = 0 ] && have runuser; then
    ui_suspend runuser -u "$SWARM_OS_RUN_USER" -- "$@"
  else
    # Running it as the installer instead would be worse than not running it:
    # the files would land with the wrong owner and nothing would say so.
    ui_no "cannot run this as $SWARM_OS_RUN_USER — no sudo, and this shell is not root"
    return 1
  fi
}

# `stat` needs execute permission on every parent, so a path inside another
# account's 0700 home answers -1 from here. Ask the account itself before
# concluding anything about ownership.
run_owner_uid() {
  local u
  u="$(path_owner_uid "$1")"
  if [ "$u" = "-1" ] && ! is_self && can_run_as; then
    u="$(as_run_user stat -c %u "$1" 2>/dev/null)" || u=""
    [ -n "$u" ] || u="-1"
  fi
  printf '%s' "$u"
}

# run_test <test-op> <path> → 0 yes | 1 no | 2 could not look.
# `[ -f ~bob/.claude/.credentials.json ]` answers "no" for a 0700 home even when
# the file is right there, and reporting a missing credential that exists is the
# one wrong answer here: it sends the operator off to redo an OAuth login.
run_test() {
  # Ask the account itself whenever we can become it: that answer is the only
  # authoritative one. `-w` on a 0755 ~/dev is TRUE for the installer and FALSE
  # for everybody else — testing it from here would green-light a workspace the
  # agents cannot write a byte into.
  if ! is_self && can_run_as; then
    as_run_user test "$1" "$2" >/dev/null 2>&1 && return 0
    return 1
  fi
  test "$1" "$2" 2>/dev/null && return 0
  is_self && return 1
  return 2
}

# Is a CLI on the account's LOGIN-shell PATH? That is the PATH an agent gets —
# the ssh transport runs `bash -lc`, and a CLI that only exists in the
# interactive branch of ~/.bashrc is invisible to it.
run_user_has() {
  if is_self; then have "$1"; return; fi
  can_run_as || return 1
  as_run_user bash -lc "command -v $1" >/dev/null 2>&1
}

# A directory that must end up owned by the run-as account. Created BY that
# account when we can become it, so the ownership is right by construction
# rather than by a chown afterwards.
run_mkdir() {
  [ -d "$1" ] && return 0
  if can_run_as; then as_run_user mkdir -p "$1" >/dev/null 2>&1 && return 0; fi
  mkdir -p "$1" 2>/dev/null || return 1
  return 0
}

# Adopt an account: resolve it, and settle the two values the compose file reads
# back. Returns 1 on an account this host does not have, leaving the current one
# untouched — a caller must never end up with a half-applied identity.
apply_run_user() {
  local u="$1" h uid gid
  [ -n "$u" ] || return 1
  user_exists "$u" || return 1
  h="$(user_home "$u")"; uid="$(user_uid "$u")"; gid="$(user_gid "$u")"
  [ -n "$h" ] && [ -n "$uid" ] && [ -n "$gid" ] || return 1
  SWARM_OS_RUN_USER="$u"
  RUN_HOME="$h"
  SWARM_OS_RUN_UID="$uid"
  SWARM_OS_RUN_GID="$gid"
  SUDO_RUN_OK=""
  # HOME inside the container. uid 1000 IS the image's own `node` user, so
  # /home/node exists there and belongs to it — that is the historical default
  # and it must not move. Any other uid has NO passwd entry inside the image:
  # Docker then hands the process HOME=/, and every npm fetch, plugin install
  # and CLI that writes under it fails on a read-only root. /data is the one
  # tree we know that uid owns, so the home goes there.
  if [ "$uid" = 1000 ]; then SWARM_OS_CONTAINER_HOME="/home/node"
  else SWARM_OS_CONTAINER_HOME="/data/home"; fi
  return 0
}

# A path still pointing into the PREVIOUS home is a leftover, not a decision:
# follow the account. Anything the operator pointed elsewhere is left alone.
rehome() {   # rehome VARNAME <old home> <new home>
  local __v="$1" __old="$2" __new="$3" __cur=""
  [ -n "$__old" ] && [ -n "$__new" ] && [ "$__old" != "$__new" ] || return 0
  eval "__cur=\${$__v:-}"
  case "$__cur" in
    "$__old")   printf -v "$__v" '%s' "$__new" ;;
    "$__old"/*) printf -v "$__v" '%s' "$__new${__cur#"$__old"}" ;;
  esac
  return 0
}

# Move every answer that hangs off a home directory to the new account's home.
# Anything the operator had pointed OUTSIDE that home is their decision, and
# `rehome` leaves it exactly where it is.
follow_run_home() {
  local old="$1"
  if [ -n "$old" ] && [ "$old" != "$RUN_HOME" ]; then
    rehome CLAUDE_DIR "$old" "$RUN_HOME"
    rehome CLAUDE_JSON "$old" "$RUN_HOME"
    rehome DATA_PATH "$old" "$RUN_HOME"
    rehome WORKSPACE_PATH "$old" "$RUN_HOME"
    rehome HOST_SSH_DIR "$old" "$RUN_HOME"
    rehome SWARM_OS_HOST_DATA_DIR "$old" "$RUN_HOME"
    rehome SWARM_OS_HOST_WORKSPACE_ROOT "$old" "$RUN_HOME"
    rehome SWARM_OS_HOST_CLAUDE_DIR "$old" "$RUN_HOME"
    rehome SWARM_OS_HOST_CODEX_DIR "$old" "$RUN_HOME"
    rehome SWARM_OS_HOST_GEMINI_DIR "$old" "$RUN_HOME"
    rehome SWARM_OS_HOST_OPENCODE_DIR "$old" "$RUN_HOME"
    # The ssh transport logs INTO this account; only the host part survives.
    case "${SWARM_OS_SSH_TARGET:-}" in
      *@*) SWARM_OS_SSH_TARGET="${SWARM_OS_RUN_USER}@${SWARM_OS_SSH_TARGET#*@}" ;;
    esac
  fi
  [ -n "$CLAUDE_DIR" ]  || CLAUDE_DIR="$RUN_HOME/.claude"
  [ -n "$CLAUDE_JSON" ] || CLAUDE_JSON="$RUN_HOME/.claude.json"
  return 0
}

slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//'; }

# Longest common prefix of the directories matching what has been typed so far.
path_complete() {
  local p="$1" expanded m matches n first common i ch
  expanded="$(expand_path "$p")"
  [ -n "$expanded" ] || { printf '%s' "$p"; return 0; }
  matches="$(compgen -d -- "$expanded" 2>/dev/null)" || matches=""
  [ -n "$matches" ] || { printf '%s' "$p"; return 0; }
  n="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
  if [ "$n" = 1 ]; then printf '%s/' "$matches"; return 0; fi
  first="$(printf '%s\n' "$matches" | head -1)"
  common="$first"
  while IFS= read -r m; do
    while [ -n "$common" ] && [ "${m#"$common"}" = "$m" ]; do common="${common%?}"; done
  done <<EOF
$matches
EOF
  [ -n "$common" ] && printf '%s' "$common" || printf '%s' "$p"
}

# 0 = something is listening. `ss` is preferred: it sees a socket that is bound
# but refusing connections, which /dev/tcp cannot. The subshell around the
# network redirection matters — touching a descriptor of THIS shell would close
# the terminal every prompt reads from.
port_in_use() {
  local p="$1"
  if have ss; then
    ss -ltnH 2>/dev/null | grep -qE "[:.]${p}[[:space:]]" && return 0
    return 1
  fi
  if have lsof; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  (exec 9<>"/dev/tcp/127.0.0.1/${p}") >/dev/null 2>&1
}

port_owner() {
  docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
    | grep -E "[:.]${1}->" | head -1 | cut -d'|' -f1
}

free_port_from() {
  local p="$1"
  while [ "$p" -lt 65535 ] && port_in_use "$p"; do p=$((p + 1)); done
  printf '%s' "$p"
}

# Ordinary login accounts on this host: a real uid, a home, and a shell that is
# not a refusal. Sorted by uid, so the humans come before the service accounts a
# distribution happens to give a high uid. `getent` may not enumerate a
# directory-backed account at all — the "another account…" entry is the way in
# for those, and typing one is validated by a direct `getent passwd <name>`.
scan_login_users() {
  getent passwd 2>/dev/null | awk -F: '
    $3 >= 1000 && $3 < 60000 && $6 != "" && $7 !~ /(nologin|false|sync|shutdown|halt)$/ {
      printf "%09d:%s\n", $3, $1
    }' | sort -u | cut -d: -f2
}

# Directories on this host that look like a project someone would point agents
# at: a git checkout, at or one level below the places people keep code. Ordered
# by how likely they are given where the script was launched from. The home-
# derived roots are the RUN-AS account's, not the installer's: a workspace that
# account cannot write is not a candidate, however convenient it looks here.
scan_project_dirs() {
  # An ARRAY, not a string: `$HOME` is `/Users/John Smith` on a stock macOS, and
  # word-splitting a space in it would drop the launch directory and every
  # $HOME-derived root — leaving "nothing to suggest" on exactly the hosts where
  # the suggestion matters. `SEP` is the unit separator, which cannot occur in a
  # path, unlike the `|` the menu parses on.
  local root d out="" seen="" n=0
  local SEP=$'\037'
  local finder=(find) roots=()
  have timeout && finder=(timeout 4 find)
  roots=("$RUN_HOME/dev" "$RUN_HOME/projets" "$RUN_HOME/projects"
         "$RUN_HOME/src" "$RUN_HOME/code" "$RUN_HOME/work" "$RUN_HOME/git" "$RUN_HOME/repos"
         "$RUN_HOME/workspace" "$RUN_HOME" /srv /opt)
  # The launch directory is a strong signal — but it is the INSTALLER's context,
  # not the account's. First when they are the same person; last, and subject to
  # the same write test as anything else, when they are not: offering an admin's
  # own checkout to an instance running as someone else is offering a workspace
  # the agents cannot write a byte into.
  if is_self; then roots=("$PWD" "$(dirname "$PWD")" "${roots[@]}")
  else roots+=("$PWD" "$(dirname "$PWD")"); fi
  for root in "${roots[@]}"; do
    run_test -d "$root" || continue
    if run_test -e "$root/.git" && run_test -w "$root"; then
      case "$seen" in *"$SEP$root$SEP"*) : ;; *) out="$out$root"$'\n'; seen="$seen$SEP$root$SEP"; n=$((n+1)) ;; esac
    fi
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      d="${d%/.git}"
      case "$d" in
        */node_modules/*|*/.cache/*|*/vendor/*|*/.local/*) continue ;;
      esac
      case "$seen" in *"$SEP$d$SEP"*) continue ;; esac
      # A candidate the run-as account cannot write is not a candidate: the
      # agents edit this tree as that account, whatever it looks like from here.
      run_test -w "$d" || continue
      out="$out$d"$'\n'; seen="$seen$SEP$d$SEP"; n=$((n+1))
      [ "$n" -ge 9 ] && break
    done <<EOF
$(as_run_user "${finder[@]}" "$root" -mindepth 2 -maxdepth 2 -name .git -not -path '*/.*/*' 2>/dev/null | head -9)
EOF
    [ "$n" -ge 9 ] && break
  done
  printf '%s' "$out"
}

# Every look is taken THROUGH the run-as account: a directory inside its 0700
# home is invisible from the installer's shell, and the honest-looking
# "does not exist yet" this used to print about an existing checkout is the
# worst answer available — it invites creating a second one next to it.
dir_hint() {
  local d="$1" branch="" n=""
  run_test -d "$d"
  case "$?" in
    1) printf 'does not exist yet — it will be created'; return 0 ;;
    2) printf 'cannot be inspected from %s' "$SELF_USER"; return 0 ;;
  esac
  if run_test -e "$d/.git"; then
    if have git; then
      branch="$(as_run_user git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)" || branch=""
    fi
    printf 'git repository%s' "${branch:+ · branch $branch}"
    return 0
  fi
  n="$(as_run_user ls -A "$d" 2>/dev/null | wc -l | tr -d ' ')"
  case "$n" in ''|0) printf 'exists, empty'; return 0 ;; esac
  printf 'exists · %s entries' "$n"
}

human_gb() { awk -v k="$1" 'BEGIN{printf "%.1f", k/1048576}'; }

# ══════════════════════════════════════════════════════════════════════════════
# 3. Validators
# ══════════════════════════════════════════════════════════════════════════════
v_port() {
  local p="$1" owner
  # The length guard is not cosmetic: a 20-digit value makes `[ -lt ]` print
  # "integer expression expected" straight onto the TUI, and this runs on every
  # keystroke. `10#` stops a leading zero being read as octal by $(( )).
  case "$p" in
    ''|*[!0-9]*|??????*) V_STATE=err; V_MSG="a port is 1 to 5 digits"; return 0 ;;
  esac
  p=$((10#$p))
  if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then V_STATE=err; V_MSG="out of range (1-65535)"; return 0; fi
  if [ "$p" -lt 1024 ]; then V_STATE=warn; V_MSG="privileged port — Docker can publish it, but pick something above 1024 unless you mean it"; return 0; fi
  if port_in_use "$p"; then
    owner="$(port_owner "$p")"
    if [ -n "$owner" ] && [ "$owner" = "$SWARM_OS_CONTAINER_NAME" ]; then
      V_STATE=ok; V_MSG="held by this deployment's own container — it will be recreated"
      return 0
    fi
    if [ -n "$owner" ]; then
      V_STATE=err; V_MSG="already published by container '$owner' — free it or choose another (next free: $(free_port_from $((p+1))))"
    else
      V_STATE=err; V_MSG="something is already listening on $p (next free: $(free_port_from $((p+1))))"
    fi
    return 0
  fi
  V_STATE=ok; V_MSG="free — the UI will answer on http://127.0.0.1:$p"
}

v_dir_new() {   # the install directory: created if absent, must end up writable
  local d p
  d="$(expand_path "$1")"
  [ -n "$d" ] || { V_STATE=err; V_MSG="give a path"; return 0; }
  case "$d" in /*) : ;; *) V_STATE=err; V_MSG="must be an absolute path"; return 0 ;; esac
  if [ -e "$d" ] && [ ! -d "$d" ]; then V_STATE=err; V_MSG="$d exists and is not a directory"; return 0; fi
  if [ -d "$d" ]; then
    if [ ! -w "$d" ]; then V_STATE=err; V_MSG="exists but is not writable by $(id -un)"; return 0; fi
    if [ -f "$d/.env" ]; then V_STATE=warn; V_MSG="already holds a swarm-os .env — you will be asked what to do with it"; return 0; fi
    V_STATE=ok; V_MSG="$(dir_hint "$d")"
    return 0
  fi
  p="$(dirname "$d")"
  while [ ! -d "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  if [ -w "$p" ]; then V_STATE=ok; V_MSG="will be created (parent $p is writable)"
  else V_STATE=err; V_MSG="cannot create it — $p is not writable by $(id -un)"; fi
}

v_dir_exists() {  # the workspace: it has to be a real tree the agents can edit
  local d p
  d="$(expand_path "$1")"
  [ -n "$d" ] || { V_STATE=err; V_MSG="give a path"; return 0; }
  case "$d" in /*) : ;; *) V_STATE=err; V_MSG="must be an absolute path"; return 0 ;; esac
  if run_test -d "$d"; then
    # Writable BY THE RUN-AS ACCOUNT — the agents write as that user, not as
    # whoever is running the installer.
    run_test -w "$d"
    case "$?" in
      1) V_STATE=warn; V_MSG="exists but $SWARM_OS_RUN_USER cannot write to it — the agents will not be able to either"; return 0 ;;
      2) V_STATE=warn; V_MSG="exists; cannot check from here whether $SWARM_OS_RUN_USER can write to it"; return 0 ;;
    esac
    V_STATE=ok; V_MSG="$(dir_hint "$d")"
    return 0
  fi
  if [ -e "$d" ]; then V_STATE=err; V_MSG="exists and is not a directory"; return 0; fi
  # "It will be created" is only true if we can create it. Accepting a path we
  # cannot make leaves Docker to create it — as root, empty, unwritable.
  p="$(dirname "$d")"
  while [ ! -d "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  if [ -w "$p" ]; then V_STATE=warn; V_MSG="does not exist — it will be created"
  else V_STATE=err; V_MSG="cannot create it — $p is not writable by $(id -un)"; fi
}

v_data_dir() {   # the state directory: the run-as account has to own it
  local d uid
  d="$(expand_path "$1")"
  [ -n "$d" ] || { V_STATE=err; V_MSG="give a path"; return 0; }
  case "$d" in /*) : ;; *) V_STATE=err; V_MSG="must be an absolute path"; return 0 ;; esac
  if run_test -d "$d"; then
    uid="$(run_owner_uid "$d")"
    if [ "$uid" != "$SWARM_OS_RUN_UID" ] && [ "$uid" != "-1" ]; then
      V_STATE=warn; V_MSG="owned by uid $uid; the container runs as $SWARM_OS_RUN_USER (uid $SWARM_OS_RUN_UID) — a chown will be offered"
      return 0
    fi
    if run_test -f "$d/swarm-os.db" || run_test -f "$d/token"; then
      V_STATE=ok; V_MSG="existing swarm-os state — teams and history will be picked back up"
      return 0
    fi
    V_STATE=ok; V_MSG="$(dir_hint "$d")"
    return 0
  fi
  V_STATE=ok; V_MSG="will be created"
}

v_account() {   # the run-as account, typed by hand
  local u="$1" uid h
  [ -n "$u" ] || { V_STATE=err; V_MSG="give a user name"; return 0; }
  if ! user_exists "$u"; then
    V_STATE=err; V_MSG="no such account on this host (getent passwd $u finds nothing)"
    return 0
  fi
  uid="$(user_uid "$u")"
  if [ "$uid" = 0 ]; then
    V_STATE=err; V_MSG="the container must never run as root — pick an ordinary account"
    return 0
  fi
  h="$(user_home "$u")"
  if [ ! -d "$h" ]; then
    V_STATE=warn; V_MSG="uid $uid, but its home $h does not exist yet"
    return 0
  fi
  # Below 1000 is a distribution's own service account (`daemon`, `bin`, …), not
  # somewhere a Claude Code login lives. Allowed — a site may genuinely have one
  # — but never silently.
  if [ "$uid" -lt 1000 ] 2>/dev/null; then
    V_STATE=warn; V_MSG="uid $uid is a system account — usable, but it is unlikely to own a Claude login"
    return 0
  fi
  V_STATE=ok; V_MSG="uid $uid · home $h"
}

v_project_name() {
  local n="$1"
  [ -n "$n" ] || { V_STATE=err; V_MSG="give the project a name"; return 0; }
  V_STATE=ok; V_MSG="container will be named swarm-os-$(slug "$n")"
}

v_nonempty_url() {
  local u="$1"
  [ -n "$u" ] || { V_MSG="empty is fine — Discord deep-links stay off"; return 0; }
  case "$u" in
    http://*|https://*) V_STATE=ok; V_MSG="used for Discord deep-links only" ;;
    *) V_STATE=err; V_MSG="must start with http:// or https://" ;;
  esac
}

v_port_number() {   # range only — nothing is listening on the SSH port yet from here
  local p="$1"
  case "$p" in
    ''|*[!0-9]*|??????*) V_STATE=err; V_MSG="a port is 1 to 5 digits"; return 0 ;;
  esac
  p=$((10#$p))
  if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then V_STATE=err; V_MSG="out of range (1-65535)"; return 0; fi
  V_STATE=ok; V_MSG=""
}

# A key path is not a directory path: the ssh transport is built on this file
# existing, and `expand_path` can hand back an empty string.
v_keyfile() {
  local f
  f="$(expand_path "$1")"
  [ -n "$f" ] || { V_STATE=err; V_MSG="give a path"; return 0; }
  case "$f" in /*) : ;; *) V_STATE=err; V_MSG="must be an absolute path"; return 0 ;; esac
  if [ ! -f "$f" ]; then V_STATE=err; V_MSG="no such file — the agents would fail to connect"; return 0; fi
  if [ ! -r "$f" ]; then V_STATE=err; V_MSG="exists but $(id -un) cannot read it"; return 0; fi
  V_STATE=ok; V_MSG="its directory is what gets mounted read-only at /host-ssh"
}

v_image() {
  local i="$1"
  [ -n "$i" ] || { V_STATE=err; V_MSG="empty: compose would fall back to its own default and /info.image would be blank"; return 0; }
  case "$i" in
    *' '*) V_STATE=err; V_MSG="an image reference has no spaces" ;;
    */*)   V_STATE=ok;  V_MSG="pulled from ${i%%/*}" ;;
    *)     V_STATE=warn; V_MSG="no registry path — treated as a locally built image, and one-click updates stay off" ;;
  esac
}

v_token() {
  local t="$1"
  [ -n "$t" ] || { V_MSG="empty: the installer will try without a token and tell you if that is enough"; return 0; }
  case "$t" in
    ghp_*|github_pat_*|gho_*|ghs_*) V_STATE=ok; V_MSG="looks like a GitHub token — it is checked against the API next" ;;
    *) V_STATE=warn; V_MSG="does not look like a GitHub PAT, but it will be tried as-is" ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════════════
# 4. Screens
# ══════════════════════════════════════════════════════════════════════════════
screen_welcome() {
  STEP_NO=0
  ui_head "A swarm-os instance on this host" "one container, one project, one port"
  ui_out "This installer takes you from a bare host to a running instance:"
  ui_gap
  ui_dim "  1.  checks Docker, Compose and this host's outbound network"
  ui_dim "  2.  asks for a GitHub token, and only if this host actually needs one"
  ui_dim "  3.  asks which host account it runs as — its uid, and the Claude Code"
  ui_dim "      login every agent inherits from it"
  ui_dim "  4.  lets you pick the install directory, the workspace and the port"
  ui_dim "  5.  writes a .env you own, pulls the image and starts the container"
  ui_dim "  6.  waits for the boot gate and hands you the access token"
  ui_gap
  ui_out "Nothing outside the directories you name is written. The existing"
  ui_out "configuration of a host that already runs swarm-os is backed up, never"
  ui_out "edited in place."
  ui_gap
  ui_dim "installer $SETUP_VERSION $G_DOT source $REPO@$REF"
  ui_gap
  ui_out "${C_CYAN}${G_RET}${C_RESET} to begin."
  ui_foot "$G_RET begin   ^C quit"
  while :; do
    ui_key
    case "$KEYTYPE" in
      enter|right) return 0 ;;
      int|eof) ui_abort ;;
      char) case "$KEY" in q) ui_abort ;; esac ;;
    esac
  done
}

# ── Prerequisites ─────────────────────────────────────────────────────────────
HARD_FAIL=0
CLAUDE_READY=0

run_prereqs() {
  HARD_FAIL=0
  CLAUDE_READY=0

  if have curl; then ui_ok "curl"
  else ui_no "curl is missing — this installer cannot fetch anything without it"; HARD_FAIL=1; fi

  if have docker; then
    ui_ok "docker $(docker version --format '{{.Client.Version}}' 2>/dev/null || echo '')"
  else
    ui_no "docker is not installed  ${C_DIM}https://docs.docker.com/engine/install/${C_RESET}"
    HARD_FAIL=1
  fi

  if have docker; then
    local info_err=""
    if docker info >/dev/null 2>&1; then
      ui_ok "docker daemon reachable"
    else
      info_err="$(docker info 2>&1)"
      case "$info_err" in
        *ermission*denied*)
          ui_no "the daemon refuses this user"
          ui_dim "  sudo usermod -aG docker $(id -un)   — then log out and back in" ;;
        *) ui_no "the docker daemon is not running  ${C_DIM}sudo systemctl start docker${C_RESET}" ;;
      esac
      HARD_FAIL=1
    fi
  fi

  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    ui_ok "docker compose v2"
  elif have docker-compose; then
    COMPOSE=(docker-compose)
    ui_warn "only the v1 docker-compose binary — v2 is what this kit is tested on"
  else
    ui_no "docker compose v2 not found  ${C_DIM}https://docs.docker.com/compose/install/${C_RESET}"
    HARD_FAIL=1
  fi

  # Room for the image plus whatever the agents will check out and build.
  local avail_k=""
  avail_k="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
  case "$avail_k" in ''|*[!0-9]*) avail_k="" ;; esac
  if [ -n "$avail_k" ]; then
    if [ "$avail_k" -lt 8388608 ]; then
      ui_warn "only $(human_gb "$avail_k") GB free on $HOME (the image is a few GB)"
    else
      ui_ok "disk: $(human_gb "$avail_k") GB free on $HOME"
    fi
  fi

  local mem_k=""
  mem_k="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null)"
  case "$mem_k" in ''|*[!0-9]*) mem_k="" ;; esac
  if [ -n "$mem_k" ]; then
    if [ "$mem_k" -lt 4194304 ]; then
      ui_warn "$(human_gb "$mem_k") GB of RAM — budget 4-8 GB per active team"
    else
      ui_ok "memory: $(human_gb "$mem_k") GB"
    fi
  fi

  # Not fatal, and no longer a dead end: the account the instance RUNS as is its
  # own step, two screens down, and root can hand it to a normal user there.
  if [ "$(id -u)" = 0 ]; then
    ui_warn "running as root"
    ui_wrapdim "the container itself must not — pick the account that owns ~/.claude on the run-as screen and everything is created for it"
  fi

  if curl -fsS -m 6 -o /dev/null "https://api.github.com" 2>/dev/null; then
    ui_ok "outbound network to api.github.com"
  else
    ui_warn "could not reach api.github.com — check outbound DNS/proxy"
  fi
}

screen_prereqs() {
  STEP_NO=1
  while :; do
    ui_head "Host prerequisites" "Docker, Compose, disk, network — the Claude login is checked per account, later"
    run_prereqs
    ui_gap
    if [ "$HARD_FAIL" = 1 ]; then
      ui_out "${C_RED}Blocking problems above.${C_RESET} Fix them in another terminal, then re-check."
      ui_foot "r re-check   f fix what can be fixed   esc back   ^C quit"
    else
      ui_out "${C_GREEN}This host is ready.${C_RESET}"
      ui_foot "$G_RET continue   r re-check   esc back   ^C quit"
    fi
    ui_key
    case "$KEYTYPE" in
      enter|right) [ "$HARD_FAIL" = 1 ] || return 0 ;;
      esc|left) UI_BACK=1; return 0 ;;
      int|eof) ui_abort ;;
      char)
        case "$KEY" in
          r|R) : ;;
          f|F) fix_prereqs ;;
          q) ui_abort ;;
        esac ;;
    esac
  done
}

fix_prereqs() {
  UI_ROW=$((UI_ROW + 1))
  if ! have docker && have curl; then
    if ui_confirm "Install Docker Engine with the official get.docker.com script (needs sudo)?" n; then
      ui_suspend bash -c 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$(id -un)"' || true
      return 0
    fi
  fi
  if ! docker info >/dev/null 2>&1 && have systemctl; then
    if ui_confirm "Start the Docker daemon (sudo systemctl start docker)?" y; then
      ui_suspend sudo systemctl start docker || true
      return 0
    fi
  fi
  return 0
}

# ── GitHub access ─────────────────────────────────────────────────────────────
# What the token is FOR, in order: reading two compose files out of a private
# repository, and pulling a private image out of GHCR. Those are two different
# permissions and a token can carry one without the other, so both are probed
# and reported separately instead of failing later with `pull access denied`.
KIT_ACCESS=""      # ok | 401 | 403 | 404 | 000
GHCR_ACCESS=""     # ok | denied | skipped

probe_kit() {
  local code
  if [ -n "$TOKEN" ]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' -m 20 \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github.raw" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${REPO}/contents/${KIT_DIST}?ref=${REF}" 2>/dev/null)" || code="000"
  else
    code="$(curl -sS -o /dev/null -w '%{http_code}' -m 20 \
      "https://raw.githubusercontent.com/${REPO}/${REF}/${KIT_DIST}" 2>/dev/null)" || code="000"
  fi
  case "$code" in 200) KIT_ACCESS=ok ;; *) KIT_ACCESS="$code" ;; esac
}

probe_ghcr() {
  local registry="${SWARM_OS_IMAGE%%/*}"
  GHCR_ACCESS=skipped
  case "$SWARM_OS_IMAGE" in */*) : ;; *) return 0 ;; esac
  have docker || return 0
  docker info >/dev/null 2>&1 || return 0
  # Already authenticated, or a public image: nothing to ask for.
  if docker manifest inspect "$SWARM_OS_IMAGE" >/dev/null 2>&1; then GHCR_ACCESS=ok; return 0; fi
  if [ -n "$GHCR_TOKEN" ]; then
    [ -n "$GHCR_USER" ] || GHCR_USER="$(curl -sS -m 15 -H "Authorization: Bearer ${GHCR_TOKEN}" \
      https://api.github.com/user 2>/dev/null | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$GHCR_USER" ] || GHCR_USER="${USER:-x}"
    if printf '%s' "$GHCR_TOKEN" | docker login "$registry" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
      docker manifest inspect "$SWARM_OS_IMAGE" >/dev/null 2>&1 && { GHCR_ACCESS=ok; return 0; }
    fi
  fi
  GHCR_ACCESS=denied
}

screen_token() {
  STEP_NO=2
  local probed=0
  while :; do
    ui_head "GitHub access" "the repository and the image are private — one read-only token unlocks both"
    ui_wrapdim "Classic PAT: scopes \`repo\` and \`read:packages\`. Fine-grained PAT: Contents: Read on ${REPO}, plus read access to the package."
    ui_wrapdim "Leave it empty to try without one — the probe below says whether that is enough on this host."
    ui_gap
    ui_input TOKEN "token" "$TOKEN" v_token 1
    [ "$UI_BACK" = 1 ] && return 0

    ui_gap
    ui_out "${C_DIM}checking…${C_RESET}"
    probe_kit
    [ -n "$GHCR_TOKEN" ] || GHCR_TOKEN="$TOKEN"
    probe_ghcr
    probed=1
    printf '\033[%d;1H\033[K' "$((UI_ROW-1))"
    UI_ROW=$((UI_ROW-1))

    case "$KIT_ACCESS" in
      ok)  ui_ok "compose files readable from ${REPO}@${REF}" ;;
      401|403) ui_no "GitHub refused the token (HTTP $KIT_ACCESS)"
               ui_wrapdim "it needs read access to ${REPO}" ;;
      404) ui_no "GitHub answered 404"
           ui_wrapdim "a private repo answers 404, not 403, to a token that cannot see it — and so does a ref that does not exist" ;;
      000) ui_no "could not reach api.github.com — network, DNS or proxy" ;;
      *)   ui_no "unexpected HTTP $KIT_ACCESS from GitHub" ;;
    esac
    case "$GHCR_ACCESS" in
      ok)      ui_ok "image ${SWARM_OS_IMAGE} can be pulled${GHCR_USER:+ (as $GHCR_USER)}" ;;
      denied)  ui_warn "the image cannot be pulled yet"
               ui_wrapdim "the token needs \`read:packages\`, and the maintainer must have granted your account access to the package" ;;
      skipped) ui_dim "image access not checked (docker unavailable)" ;;
    esac
    ui_gap

    if [ "$KIT_ACCESS" = ok ] && [ "$GHCR_ACCESS" != denied ]; then
      ui_out "${C_GREEN}Both are in reach.${C_RESET}"
      ui_foot "$G_RET continue   e edit the token   esc back   ^C quit"
    else
      ui_wrap "e tries another token, g gives a separate one for the image, enter carries on — the deploy stops with a clear error if it cannot pull."
      ui_foot "e edit   g image token   $G_RET continue   esc back"
    fi

    # One key loop for both outcomes. `enter` only leaves the screen when the
    # compose files are actually reachable: without them there is nothing to
    # deploy, and finding that out ten screens later helps nobody.
    local again=0
    while [ "$again" = 0 ]; do
      ui_key
      case "$KEYTYPE" in
        enter|right)
          if [ "$KIT_ACCESS" = ok ]; then return 0; fi
          ui_foot "the compose files cannot be fetched — a token that can read ${REPO} is required   e edit   esc back" ;;
        esc|left) UI_BACK=1; return 0 ;;
        int|eof) ui_abort ;;
        char)
          case "$KEY" in
            e|E) again=1 ;;
            g|G) UI_ROW=$((UI_ROW + 1))
                 ui_input GHCR_TOKEN "image token (read:packages)" "" v_token 1
                 GHCR_USER=""; again=1 ;;
            q) ui_abort ;;
          esac ;;
      esac
    done
  done
}

# ── Install directory ─────────────────────────────────────────────────────────
screen_dir() {
  STEP_NO=3
  local pick opts=() cand
  ui_head "Where to install" "this directory holds the compose files, your .env, and nothing else"

  opts=()
  local seen=""
  for cand in "${DIR:-$HOME/swarm-os}" "$HOME/swarm-os" "$PWD/swarm-os" "$HOME/.local/share/swarm-os" "/opt/swarm-os"; do
    cand="$(expand_path "$cand")"
    # `ui_menu` splits its options on `|`, so a path containing one would come
    # back silently truncated. Such a path is pathological; leave it out of the
    # suggestions rather than mis-report it — it can still be typed by hand.
    case "$cand" in *'|'*) continue ;; esac
    case "$seen" in *"|$cand|"*) continue ;; esac
    seen="$seen|$cand|"
    opts+=("$cand|$cand|$( [ -d "$cand" ] && dir_hint "$cand" || printf 'will be created' )")
  done
  opts+=("__custom__|Another path…|type it yourself, with tab completion")

  ui_menu pick 1 "${opts[@]}"
  [ "$UI_BACK" = 1 ] && return 0

  if [ "$pick" = "__custom__" ]; then
    ui_gap
    ui_input DIR "path" "$DIR" v_dir_new
    [ "$UI_BACK" = 1 ] && return 0
  else
    DIR="$pick"
  fi
  DIR="$(expand_path "$DIR")"
  ENV_FILE="$DIR/.env"

  # A directory that already holds a deployment is a decision, not an accident.
  if [ -f "$ENV_FILE" ]; then
    ui_head "That directory already holds a deployment" "$ENV_FILE"
    ui_out "swarm-os has been installed here before."
    ui_gap
    local what
    ui_menu what 1 \
      "reconfigure|Reconfigure it|walk the questions again, your current values as the defaults" \
      "redeploy|Redeploy it as it stands|pull, recreate the container, keep every answer — this is also how you update" \
      "elsewhere|Install somewhere else|leave this deployment untouched"
    [ "$UI_BACK" = 1 ] && return 0
    case "$what" in
      redeploy)   load_env_file; SKIP_TO_DEPLOY=1; return 0 ;;
      elsewhere)  UI_BACK=1; return 0 ;;
      reconfigure) load_env_file ;;
    esac
  fi
  return 0
}

# Seeds every answer from an existing .env so a reconfigure starts from the
# truth rather than from the defaults.
load_env_file() {
  [ -f "$ENV_FILE" ] || return 0
  # Blanked BEFORE the source, or the check below could never tell "the file
  # says this account" from "this is the default we started with" — the global
  # is never empty, so every inference under it would be dead code.
  local prev="$SWARM_OS_RUN_USER" u="" chome=""
  SWARM_OS_RUN_USER=""
  SWARM_OS_CONTAINER_HOME=""
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE" 2>/dev/null || true
  set +a
  [ -n "${SWARM_OS_GITHUB_TOKEN:-}" ] && [ -z "$TOKEN" ] && TOKEN="$SWARM_OS_GITHUB_TOKEN"

  # The run-as account is a property of the DEPLOYMENT, not of this shell.
  # Silently reverting it to whoever is typing would rewrite /data's owner and
  # cut the agents off from the credentials they have been running on.
  u="${SWARM_OS_RUN_USER:-}"
  chome="${SWARM_OS_CONTAINER_HOME:-}"
  # An .env written before this installer grew the question has no such key, so
  # infer it, best evidence first: an ssh transport already NAMES the account
  # its agents run as, and otherwise whoever owns the state directory is the
  # account the instance was installed for.
  if [ -z "$u" ]; then
    case "${SWARM_OS_SSH_TARGET:-}" in
      ?*@*) u="${SWARM_OS_SSH_TARGET%@*}" ;;
    esac
  fi
  if [ -z "$u" ] && [ -n "${DATA_PATH:-}" ] && [ -d "${DATA_PATH:-}" ]; then
    u="$(getent passwd "$(path_owner_uid "$DATA_PATH")" 2>/dev/null | head -1 | cut -d: -f1)"
  fi
  apply_run_user "$u" || apply_run_user "$prev" || true
  # A container HOME the operator moved by hand is an answer, not a default:
  # keep it, exactly as `carry_over_unknown` keeps the keys we do not manage.
  [ -n "$chome" ] && SWARM_OS_CONTAINER_HOME="$chome"
  return 0
}

# ── The account the instance runs as ──────────────────────────────────────────
# One answer decides three things at once, which is why it is its own step:
#   * the uid:gid the container process carries (compose `user:`), hence who
#     owns everything it writes in /data and /workspace;
#   * which ~/.claude is mounted at /claude-source — the login every agent
#     authenticates with, since swarm-os ships no API key;
#   * under the ssh transport, the account the agent CLI processes are actually
#     started as on this host.
# Defaulting to the installer is right on a single-user host and wrong on the
# host where an admin installs for a dedicated account — the case this screen
# exists for.
ACCOUNT_FATAL=0
ACCOUNT_UNSURE=0

account_hint() {
  local u="$1" h uid out
  uid="$(user_uid "$u")"; h="$(user_home "$u")"
  out="uid $uid"
  [ -n "$h" ] && out="$out · $h"
  [ "$u" = "$SELF_USER" ] && out="$out · you"
  # A direct test only: a 0700 home simply answers nothing here, and claiming
  # "no credentials" about an account we cannot look into would be a lie.
  [ -f "$h/.claude/.credentials.json" ] && out="$out · has a Claude login"
  printf '%s' "$out"
}

run_account_checks() {
  CLAUDE_READY=0
  ACCOUNT_FATAL=0
  ACCOUNT_UNSURE=0

  if [ "$SWARM_OS_RUN_UID" = 0 ]; then
    ui_no "$SWARM_OS_RUN_USER is uid 0 — the container must never run as root"
    ui_wrapdim "press c and pick the account that owns the Claude Code login: /data, /workspace and the agents all follow it"
    ACCOUNT_FATAL=1
    return 0
  fi

  ui_ok "$SWARM_OS_RUN_USER — uid $SWARM_OS_RUN_UID, gid $SWARM_OS_RUN_GID, home $RUN_HOME"
  if [ ! -d "$RUN_HOME" ]; then
    ui_warn "$RUN_HOME does not exist — create the home before deploying"
    ACCOUNT_UNSURE=1
  fi
  if ! is_self; then
    if can_run_as; then
      ui_ok "$SELF_USER can act as $SWARM_OS_RUN_USER (password-less sudo)"
    else
      ui_warn "$SELF_USER cannot become $SWARM_OS_RUN_USER without a password"
      ui_wrapdim "the steps that must belong to that account are printed for you to run rather than run from here"
      ACCOUNT_UNSURE=1
    fi
  fi

  run_test -f "$CLAUDE_DIR/.credentials.json"
  case "$?" in
    0) ui_ok "Claude Code credentials in $CLAUDE_DIR"; CLAUDE_READY=1 ;;
    # Unknown is not "missing": claiming the credentials are absent would send
    # the operator off to redo an OAuth login that is already done. Say what we
    # could not see, and let the verdict below stay honest about it.
    2) ui_warn "cannot look inside $CLAUDE_DIR from here — the container will, as uid $SWARM_OS_RUN_UID"
       CLAUDE_READY=1; ACCOUNT_UNSURE=1 ;;
    *) ui_no "no $CLAUDE_DIR/.credentials.json — no agent starts until $SWARM_OS_RUN_USER logs in" ;;
  esac

  run_test -f "$CLAUDE_JSON"
  case "$?" in
    0) ui_ok "$CLAUDE_JSON" ;;
    2) ui_warn "cannot see $CLAUDE_JSON from here"; ACCOUNT_UNSURE=1 ;;
    *) # Not cosmetic: compose bind-mounts this path, so Docker creates a
       # root-owned DIRECTORY where the container expects a file, and the first
       # agent hangs on the theme picker.
       ui_no "$CLAUDE_JSON is missing"
       ui_dim "  Docker would create a DIRECTORY there and the first session would freeze"
       CLAUDE_READY=0 ;;
  esac

  if run_user_has claude; then
    ui_ok "claude is on ${SWARM_OS_RUN_USER}'s login-shell PATH"
  elif ! is_self && ! can_run_as; then
    ui_warn "cannot check ${SWARM_OS_RUN_USER}'s PATH from here"
    ACCOUNT_UNSURE=1
  else
    # `bash -lc` is what an ssh-transport agent gets: a CLI reachable only from
    # the interactive branch of ~/.bashrc is invisible to it.
    ui_warn "claude is not on ${SWARM_OS_RUN_USER}'s login-shell PATH  ${C_DIM}npm i -g @anthropic-ai/claude-code${C_RESET}"
    ACCOUNT_UNSURE=1
  fi

  if id -nG "$SWARM_OS_RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    ui_ok "in the docker group — one-click updates and plugin host-exec will work"
  else
    ui_wrapdim "not in the docker group: under the ssh transport, one-click updates and plugin host-exec need  sudo usermod -aG docker $SWARM_OS_RUN_USER"
  fi
  return 0
}

# Every fix here runs AS the account. A credentials file or a ~/.claude.json
# created by root is a file the container cannot read — the exact failure this
# screen exists to prevent.
fix_account() {
  UI_ROW=$((UI_ROW + 1))
  local cred cj
  run_test -f "$CLAUDE_DIR/.credentials.json"; cred=$?
  run_test -f "$CLAUDE_JSON"; cj=$?

  if ! run_user_has claude && is_self && have npm; then
    if ui_confirm "Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code)?" y; then
      ui_suspend npm i -g @anthropic-ai/claude-code || true
      return 0
    fi
  fi

  if [ "$cred" = 1 ]; then
    if is_self; then
      if ui_confirm "Launch \`claude\` now to complete the OAuth login?" y; then
        ui_suspend claude || true
        return 0
      fi
    elif have sudo; then
      # A login shell, not `sudo -u … claude`: the CLI must come from the
      # account's own PATH, and it writes into that account's home.
      if ui_confirm "Run the OAuth login as $SWARM_OS_RUN_USER (sudo -u $SWARM_OS_RUN_USER -i claude)?" y; then
        ui_suspend sudo -u "$SWARM_OS_RUN_USER" -i claude || true
        return 0
      fi
    else
      ui_out "Run this as $SWARM_OS_RUN_USER, then press r:"
      ui_dim "  su - $SWARM_OS_RUN_USER -c claude"
      # Not `ui_pause || return`: an esc here means "done reading", not "leave
      # the run-as screen" — a UI_BACK left standing would send the wizard a
      # screen backwards the next time this one is left.
      ui_pause
      UI_BACK=0
      return 0
    fi
  fi

  if [ "$cj" = 1 ]; then
    if ui_confirm "Create $CLAUDE_JSON as an empty JSON file, owned by $SWARM_OS_RUN_USER?" y; then
      if is_self; then
        printf '{}\n' >"$CLAUDE_JSON" 2>/dev/null || ui_no "could not write $CLAUDE_JSON"
      elif can_run_as; then
        as_run_user sh -c "printf '{}\n' > \"\$1\"" sh "$CLAUDE_JSON" 2>/dev/null \
          || ui_no "could not write $CLAUDE_JSON as $SWARM_OS_RUN_USER"
      else
        ui_suspend sudo -u "$SWARM_OS_RUN_USER" sh -c "printf '{}\n' > \"\$1\"" sh "$CLAUDE_JSON" || true
      fi
      return 0
    fi
  fi
  return 0
}

pick_account() {
  local u cand opts=() sel=1 n=0 old="$RUN_HOME"
  ui_head "Run-as account" "who this instance belongs to on this host"
  ui_wrapdim "Login accounts found on this host. The instance takes this account's uid, its ~/.claude, and — under the ssh transport — runs the agent processes as it."
  ui_gap

  opts=()
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    # See screen_dir: `|` is the menu's own delimiter.
    case "$cand" in *'|'*) continue ;; esac
    n=$((n + 1))
    [ "$cand" = "$SWARM_OS_RUN_USER" ] && sel=$n
    opts+=("$cand|$cand|$(account_hint "$cand")")
    [ "$n" -ge 8 ] && break
  done <<EOF
$(scan_login_users)
EOF
  opts+=("__custom__|Another account…|type the user name — looked up in passwd, LDAP included")

  ui_menu u "$sel" "${opts[@]}"
  [ "$UI_BACK" = 1 ] && { UI_BACK=0; return 0; }

  if [ "$u" = "__custom__" ]; then
    ui_gap
    ui_input u "user name" "$SWARM_OS_RUN_USER" v_account
    [ "$UI_BACK" = 1 ] && { UI_BACK=0; return 0; }
  fi

  if ! apply_run_user "$u"; then
    ui_gap
    ui_no "no such account on this host: $u"
    ui_pause || UI_BACK=0
    return 0
  fi

  follow_run_home "$old"
  return 0
}

screen_user() {
  STEP_NO=4
  while :; do
    ui_head "Run-as account" "the uid the container carries, and the Claude login every agent inherits"
    ui_wrapdim "swarm-os ships no API key: every agent launches a provider CLI and authenticates with THIS account's login. The container runs with its uid, so everything it writes in /data and /workspace belongs to it too."
    ui_gap
    run_account_checks
    ui_gap
    if [ "$ACCOUNT_FATAL" = 1 ]; then
      ui_foot "c change account   r re-check   esc back   ^C quit"
    elif [ "$CLAUDE_READY" != 1 ]; then
      ui_wrap "The instance will start, but agents will not, until that account has a Claude Code login."
      ui_out "${C_BOLD}f${C_RESET} fixes the ${C_RED}${G_NO}${C_RESET} lines above, one at a time, as $SWARM_OS_RUN_USER."
      ui_foot "f fix now   c change account   r re-check   $G_RET continue anyway   esc back"
    elif [ "$ACCOUNT_UNSURE" = 1 ]; then
      # The Claude login is there, but something else is missing or could not be
      # looked at from here — a 0700 home, no password-less sudo, no provider
      # CLI on that account's PATH. Saying "ready" would be a promise this
      # installer is in no position to make.
      ui_wrap "Nothing here blocks the install — read the ${C_YELLOW}${G_WARN}${C_RESET} lines above: they are what could not be verified, or is missing on that account."
      ui_foot "$G_RET continue   c change account   r re-check   esc back   ^C quit"
    else
      ui_out "${C_GREEN}This account is ready.${C_RESET}"
      ui_foot "$G_RET continue   c change account   r re-check   esc back   ^C quit"
    fi
    ui_key
    case "$KEYTYPE" in
      enter|right) [ "$ACCOUNT_FATAL" = 1 ] || return 0 ;;
      esc|left) UI_BACK=1; return 0 ;;
      int|eof) ui_abort ;;
      char)
        case "$KEY" in
          c|C) pick_account ;;
          f|F) [ "$ACCOUNT_FATAL" = 1 ] || fix_account ;;
          r|R) : ;;
          q) ui_abort ;;
        esac ;;
    esac
  done
}

# ── Project, workspace, state ─────────────────────────────────────────────────
screen_project() {
  STEP_NO=5
  ui_head "Project" "one swarm-os instance drives exactly one project"
  ui_dim "The name shows up in the UI, in the logs and in the Discord notifications."
  ui_gap
  local def="${SWARM_OS_PROJECT_NAME:-$(basename "$PWD")}"
  ui_input SWARM_OS_PROJECT_NAME "name" "$def" v_project_name
  [ "$UI_BACK" = 1 ] && return 0
  local ps; ps="$(slug "$SWARM_OS_PROJECT_NAME")"
  [ -n "$ps" ] || ps="swarm-os"
  ui_input SWARM_OS_CONTAINER_NAME "container" "${SWARM_OS_CONTAINER_NAME:-swarm-os-$ps}"
  [ "$UI_BACK" = 1 ] && return 0
  return 0
}

screen_workspace() {
  STEP_NO=6
  local pick opts=() d hint n=0 cap
  ui_head "Workspace" "the tree the agents actually edit — mounted read-write at /workspace"

  # However many candidates the host has, only as many as this terminal can show
  # above the footer — plus the "another path" escape hatch, which is never cut.
  cap=$(( (UI_H - UI_ROW - 4) / 2 - 1 ))
  [ "$cap" -gt 8 ] && cap=8
  [ "$cap" -lt 2 ] && cap=2

  opts=()
  # See screen_dir: a `|` in a path would be eaten by the menu's own delimiter.
  if [ -n "${WORKSPACE_PATH:-}" ] && [ -d "$WORKSPACE_PATH" ]; then
    case "$WORKSPACE_PATH" in
      *'|'*) : ;;
      *) opts+=("$WORKSPACE_PATH|$WORKSPACE_PATH|current setting · $(dir_hint "$WORKSPACE_PATH")"); n=1 ;;
    esac
  fi
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$d" in *'|'*) continue ;; esac
    [ "$d" = "${WORKSPACE_PATH:-}" ] && continue
    hint="$(dir_hint "$d")"
    [ "$d" = "$PWD" ] && hint="$hint · you launched the installer here"
    opts+=("$d|$d|$hint")
    n=$((n+1))
    [ "$n" -ge "$cap" ] && break
  done <<EOF
$(scan_project_dirs)
EOF
  opts+=("__custom__|Another path…|type it yourself, with tab completion — it is created if missing")

  if [ "$n" = 0 ]; then
    ui_wrapdim "No git checkout found near $PWD or under $RUN_HOME, so there is nothing to suggest."
    ui_gap
  else
    ui_dim "Found on this host — pick one, or give a path of your own."
    ui_gap
  fi

  ui_menu pick 1 "${opts[@]}"
  [ "$UI_BACK" = 1 ] && return 0

  if [ "$pick" = "__custom__" ]; then
    ui_gap
    ui_input WORKSPACE_PATH "path" "${WORKSPACE_PATH:-$RUN_HOME/dev/$(slug "$SWARM_OS_PROJECT_NAME")}" v_dir_exists
    [ "$UI_BACK" = 1 ] && return 0
  else
    WORKSPACE_PATH="$pick"
  fi
  WORKSPACE_PATH="$(expand_path "$WORKSPACE_PATH")"

  if ! run_test -d "$WORKSPACE_PATH"; then
    ui_gap
    ui_warn "$WORKSPACE_PATH does not exist."
    if ui_confirm "Create it, owned by $SWARM_OS_RUN_USER?" y; then
      # Advancing here would hand compose a path only the daemon can create, as
      # root — so go back to the question instead. `run_mkdir` creates it AS the
      # run-as account whenever it can: a workspace owned by the installer is
      # one the agents cannot write to.
      run_mkdir "$WORKSPACE_PATH" || { ui_no "could not create it"; ui_pause; UI_BACK=1; return 0; }
      ui_ok "created"
      if [ "$(run_owner_uid "$WORKSPACE_PATH")" != "$SWARM_OS_RUN_UID" ]; then
        ui_warn "it belongs to uid $(run_owner_uid "$WORKSPACE_PATH"), not to $SWARM_OS_RUN_USER"
        ui_dim "  sudo chown -R $SWARM_OS_RUN_UID:$SWARM_OS_RUN_GID $WORKSPACE_PATH"
      fi
    else
      UI_BACK=1; return 0
    fi
  fi

  # An empty workspace is the last moment where cloning is the operator's job
  # rather than an agent's.
  if [ -z "$(as_run_user ls -A "$WORKSPACE_PATH" 2>/dev/null)" ] && have git; then
    ui_gap
    ui_dim "The workspace is empty. Give a git URL to clone into it, or leave blank."
    local url=""
    ui_input url "git url" ""
    # ESC means "back" in every other field; do not silently turn it into
    # "forward" here by resetting UI_BACK unconditionally.
    [ "$UI_BACK" = 1 ] && return 0
    if [ -n "$url" ]; then
      # Through ui_suspend, not inline: a private HTTPS URL or an unknown host
      # key makes git prompt on /dev/tty, and the wizard has that terminal in
      # -icanon -echo — the installer would look frozen with typing invisible.
      # As the run-as account, so the checkout it produces is one the agents can
      # commit in — and so the credentials git asks for are that account's.
      suspend_as_run_user git clone "$url" "$WORKSPACE_PATH" \
        && ui_ok "cloned into $WORKSPACE_PATH" \
        || ui_warn "clone failed — continuing with an empty workspace"
      ui_pause || return 0
    fi
  fi
  return 0
}

screen_data() {
  STEP_NO=7
  local ps uid
  ps="$(slug "$SWARM_OS_PROJECT_NAME")"
  ui_head "State directory" "SQLite database, access token, logs, backups — mounted at /data"
  ui_dim "Everything that must survive a container replacement lives here. Keep it,"
  ui_dim "and teams, history and tokens come back after an update."
  ui_gap
  ui_input DATA_PATH "path" "${DATA_PATH:-$RUN_HOME/.swarm-os/$ps}" v_data_dir
  [ "$UI_BACK" = 1 ] && return 0
  DATA_PATH="$(expand_path "$DATA_PATH")"
  run_mkdir "$DATA_PATH" || { ui_no "could not create $DATA_PATH"; ui_pause; UI_BACK=1; return 0; }

  # The container writes here as the run-as account. A state directory owned by
  # anyone else is a container that boots and then cannot write its database.
  uid="$(run_owner_uid "$DATA_PATH")"
  if [ "$uid" != "$SWARM_OS_RUN_UID" ] && [ "$uid" != "-1" ]; then
    ui_gap
    ui_warn "$DATA_PATH belongs to uid $uid; the container runs as $SWARM_OS_RUN_USER (uid $SWARM_OS_RUN_UID)."
    if ui_confirm "Run: sudo chown -R $SWARM_OS_RUN_UID:$SWARM_OS_RUN_GID $DATA_PATH ?" y; then
      ui_suspend sudo chown -R "$SWARM_OS_RUN_UID:$SWARM_OS_RUN_GID" "$DATA_PATH" \
        || ui_warn "chown failed — expect write errors in /data"
    else
      ui_warn "left as-is — the container will fail to write its database"
      ui_pause || return 0
    fi
  fi

  # The container's own HOME when it does not run as uid 1000 — see
  # `apply_run_user`. It lives under /data because that is the one tree we know
  # the run-as account owns; created here so the very first boot finds it there.
  case "$SWARM_OS_CONTAINER_HOME" in
    /data/*)
      local ch="$DATA_PATH/${SWARM_OS_CONTAINER_HOME#/data/}"
      if run_mkdir "$ch"; then
        ui_gap
        ui_ok "$ch — the container's HOME (uid $SWARM_OS_RUN_UID has no home inside the image)"
      else
        ui_warn "could not create $ch — npm and plugin installs inside the container will fail"
      fi ;;
  esac
  return 0
}

screen_port() {
  STEP_NO=8
  ui_head "Port" "the UI is published on the host loopback only — 127.0.0.1, never 0.0.0.0"
  ui_dim "The container always listens on 8787 internally; this is the host side."
  ui_dim "The VS Code editor needs no port of its own — it is proxied under /ide here."
  ui_gap
  local suggested="$SWARM_OS_PORT"
  port_in_use "$suggested" && [ "$(port_owner "$suggested")" != "$SWARM_OS_CONTAINER_NAME" ] && \
    suggested="$(free_port_from "$suggested")"
  ui_input SWARM_OS_PORT "port" "$suggested" v_port
  return 0
}

# ── Transport ─────────────────────────────────────────────────────────────────
screen_transport() {
  STEP_NO=9
  local t sshd_up=0 def=2
  port_in_use 22 && sshd_up=1
  [ "$sshd_up" = 1 ] && def=1
  [ "$SWARM_OS_AGENT_TRANSPORT" = ssh ] && def=1

  ui_head "Agent transport" "where the agent CLI processes actually run — the one structural choice"
  ui_dim "ssh   agents run on this host: all four provider CLIs, one-click updates,"
  ui_dim "      plugin host-exec, and no race on the Claude OAuth refresh."
  ui_dim "local agents run in the container: claude only, updates stay a shell job."
  ui_gap
  ui_dim "Either way they are ${SWARM_OS_RUN_USER}'s processes: as that account on the host,"
  ui_dim "or as uid $SWARM_OS_RUN_UID inside the container."
  ui_gap
  ui_menu t "$def" \
    "ssh|Agents run on this host as $SWARM_OS_RUN_USER|recommended$([ "$sshd_up" = 1 ] || printf '%s' ' — but no sshd is listening on port 22 right now')" \
    "local|Agents run inside the container|simplest; codex / gemini / opencode will correctly report themselves unavailable"
  [ "$UI_BACK" = 1 ] && return 0
  SWARM_OS_AGENT_TRANSPORT="$t"

  if [ "$t" = local ]; then
    SWARM_OS_SSH_TARGET=""; SWARM_OS_SSH_KEY=""; HOST_SSH_DIR=""
    return 0
  fi
  setup_ssh
  return 0
}

setup_ssh() {
  local user host keydir key_path pub seen mode
  ui_head "SSH transport" "the container opens \`ssh -tt\` back into this host"
  ui_wrapdim "It needs a key it can read, and an account whose CLI logins the agents will inherit."
  ui_gap

  # NOT a question: the account is the one chosen on the run-as screen. Asking
  # again is how an instance ends up ssh-ing as one user while mounting another
  # one's ~/.claude — a mismatch nothing downstream can detect, and every agent
  # dies on its first turn with a credentials error that names neither.
  user="$SWARM_OS_RUN_USER"
  ui_kv "ssh user" "$user  (the run-as account — change it on step 4)"
  # `ui_gap`, not a bare UI_ROW bump: a row that is skipped without being
  # printed still shows the previous frame underneath it.
  ui_gap
  # Every other default is seeded from the current `.env` when there is one: a
  # reconfigure must not silently drag a customised gateway, port or key path
  # back to the shipped default and strip the agents of the credentials they had.
  # `host.docker.internal` is what the overlay's extra_hosts maps to the bridge
  # gateway, so it resolves from inside the container on Linux too.
  host="${SWARM_OS_SSH_TARGET#*@}"
  [ -n "$host" ] && [ "$host" != "$SWARM_OS_SSH_TARGET" ] || host="host.docker.internal"
  ui_input host "host, as seen FROM the container" "$host"
  [ "$UI_BACK" = 1 ] && return 0
  ui_input SWARM_OS_SSH_PORT "ssh port" "${SWARM_OS_SSH_PORT:-22}" v_port_number
  [ "$UI_BACK" = 1 ] && return 0
  SWARM_OS_SSH_TARGET="${user}@${host}"

  ui_gap
  ui_menu mode 1 \
    "generate|Generate a dedicated key and authorise it|ed25519, no passphrase, alone in its own directory — nothing else gets mounted" \
    "existing|Use a key I already have|you give the path; its whole directory is what the container mounts read-only"
  [ "$UI_BACK" = 1 ] && return 0

  if [ "$mode" = generate ]; then
    # Under the RUN-AS account's home, generated AS that account. Two reasons,
    # both fatal otherwise: the container reads the private key as that uid (a
    # 0600 key owned by the installer is EACCES), and the key has to end up in
    # THAT account's authorized_keys for the login to be accepted at all.
    keydir="${HOST_SSH_DIR:-$RUN_HOME/.swarm-os/ssh}"
    key_path="$keydir/swarm-os-spawner"
    run_mkdir "$keydir" && as_run_user chmod 700 "$keydir" 2>/dev/null
    ui_gap
    # `[ -f ]` from here is FALSE for a key that exists inside a 0700 home;
    # `run_test` asks the account itself.
    if run_test -f "$key_path"; then
      ui_ok "reusing the key already at $key_path"
    elif ! have ssh-keygen; then
      ui_no "ssh-keygen is not installed (package openssh-client)"
    elif ! is_self && ! can_run_as; then
      ui_no "cannot generate it as $user from here (no password-less sudo)"
      ui_wrapdim "run this as $user, then come back and choose \"a key I already have\":"
      ui_dim "  ssh-keygen -t ed25519 -N '' -f $key_path"
    else
      if as_run_user ssh-keygen -t ed25519 -N "" -C "swarm-os-$(slug "$SWARM_OS_PROJECT_NAME")" \
           -f "$key_path" >/dev/null 2>&1; then
        ui_ok "generated $key_path (owned by $user)"
      else
        ui_no "ssh-keygen failed"
      fi
    fi
    if run_test -f "$key_path.pub"; then
      if is_self || can_run_as; then
        as_run_user mkdir -p "$RUN_HOME/.ssh" 2>/dev/null && as_run_user chmod 700 "$RUN_HOME/.ssh" 2>/dev/null
        as_run_user touch "$RUN_HOME/.ssh/authorized_keys" 2>/dev/null \
          && as_run_user chmod 600 "$RUN_HOME/.ssh/authorized_keys" 2>/dev/null
        pub="$(as_run_user cat "$key_path.pub" 2>/dev/null | cut -d' ' -f2)"
        if [ -n "$pub" ] && as_run_user grep -qF "$pub" "$RUN_HOME/.ssh/authorized_keys" 2>/dev/null; then
          ui_ok "already authorised in ~$user/.ssh/authorized_keys"
        elif as_run_user sh -c 'cat "$1" >> "$2"' sh "$key_path.pub" "$RUN_HOME/.ssh/authorized_keys" 2>/dev/null; then
          ui_ok "authorised in ~$user/.ssh/authorized_keys"
        else
          ui_warn "could not append to ~$user/.ssh/authorized_keys"
          ui_dim "  sudo -u $user tee -a ~$user/.ssh/authorized_keys < $key_path.pub"
        fi
      else
        ui_warn "authorise it yourself for $user:"
        ui_dim "  sudo -u $user tee -a ~$user/.ssh/authorized_keys < $key_path.pub"
      fi
    fi
  else
    ui_gap
    local kdef="$RUN_HOME/.ssh/id_ed25519"
    [ -n "$HOST_SSH_DIR" ] && [ -n "$SWARM_OS_SSH_KEY" ] && kdef="$HOST_SSH_DIR/${SWARM_OS_SSH_KEY##*/}"
    ui_input key_path "private key path" "$kdef" v_keyfile
    [ "$UI_BACK" = 1 ] && return 0
    key_path="$(expand_path "$key_path")"
  fi

  # A key that does not exist is not a warning, it is the whole transport. The
  # `.env` would otherwise be complete and valid, the overlay's `:?` guard
  # satisfied and the container HEALTHY — and every single agent spawn would die
  # on `ssh -i /host-ssh/…: no such file`, with nothing on the boot path saying so.
  if ! run_test -f "$key_path"; then
    ui_gap
    ui_no "no private key at $key_path"
    ui_wrapdim "the ssh transport cannot be configured without one. Install openssh-client and come back, or choose the local transport."
    ui_gap
    ui_pause "$G_RET back to the transport question"
    UI_BACK=1
    return 0
  fi

  HOST_SSH_DIR="$(dirname "$key_path")"
  SWARM_OS_SSH_KEY="/host-ssh/$(basename "$key_path")"

  # The container reads that file as the run-as uid and gets EACCES otherwise.
  # -1 means we could not even stat it (a 0700 directory of another account),
  # which says nothing about the container: it will read it as the owner.
  local kuid; kuid="$(run_owner_uid "$key_path")"
  if [ "$kuid" != "$SWARM_OS_RUN_UID" ] && [ "$kuid" != "-1" ]; then
    ui_warn "the key is owned by uid $kuid; the container reads it as uid $SWARM_OS_RUN_UID ($SWARM_OS_RUN_USER)"
  fi

  # Verify exactly the way the container will, including the shell. The agent's
  # remote command is `bash -lc`, so what matters is the LOGIN shell's PATH: a
  # CLI that only exists in the interactive branch of ~/.bashrc is invisible to
  # a spawned agent, and the failure looks like a swarm-os bug.
  if ! have ssh; then
    :
  elif ! is_self && ! can_run_as; then
    ui_gap
    ui_warn "cannot test the connection from here — the key belongs to $user"
    ui_dim "  sudo -u $user ssh -i $key_path -p ${SWARM_OS_SSH_PORT:-22} ${user}@127.0.0.1 -- true"
  else
    ui_gap
    ui_out "${C_DIM}testing the exact path the agents will take…${C_RESET}"
    if as_run_user ssh -i "$key_path" -p "${SWARM_OS_SSH_PORT:-22}" -o BatchMode=yes \
         -o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 \
         "${user}@127.0.0.1" -- true >/dev/null 2>&1; then
      ui_ok "ssh ${user}@127.0.0.1 works with that key"
      seen="$(as_run_user ssh -i "$key_path" -p "${SWARM_OS_SSH_PORT:-22}" -o BatchMode=yes \
        -o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 "${user}@127.0.0.1" -- \
        "bash -lc 'command -v claude'" 2>/dev/null)" || seen=""
      if [ -n "$seen" ]; then
        ui_ok "claude resolves in the agents' login shell: $seen"
      else
        ui_no "claude is NOT on the login-shell PATH of $user"
        ui_wrapdim "agents would spawn and die. Add its directory to ~$user/.profile — they run \`bash -lc\`, not your interactive shell"
      fi
    else
      ui_no "could not ssh to ${user}@127.0.0.1 with that key"
      ui_wrapdim "check that sshd is running, that the key is in ~$user/.ssh/authorized_keys, and that PubkeyAuthentication is on"
    fi
  fi

  # Host-side twins of the bind mounts. Under ssh the agent resolves paths in
  # the HOST's namespace, so /data and /workspace mean nothing to it; left
  # unset these default to the CONTAINER's home and every per-session
  # credential symlink dangles — the agent starts silently and fails auth on
  # its first turn.
  # These two always follow the answers just given; the per-CLI ones are seeded
  # so an operator who pointed codex at a shared directory keeps it. They must
  # never be written EMPTY: the server resolves an empty string against its own
  # cwd, which is worse than the unset default.
  SWARM_OS_HOST_DATA_DIR="$DATA_PATH"
  SWARM_OS_HOST_WORKSPACE_ROOT="$WORKSPACE_PATH"
  SWARM_OS_HOST_CLAUDE_DIR="$CLAUDE_DIR"
  # Per-CLI state under the RUN-AS account's home: that is the account the agent
  # logs in as, and the only one whose provider logins it can possibly read.
  SWARM_OS_HOST_CODEX_DIR="${SWARM_OS_HOST_CODEX_DIR:-$RUN_HOME/.codex}"
  SWARM_OS_HOST_GEMINI_DIR="${SWARM_OS_HOST_GEMINI_DIR:-$RUN_HOME/.gemini}"
  if [ -z "$SWARM_OS_HOST_OPENCODE_DIR" ]; then
    if run_test -d "$RUN_HOME/.config/opencode"; then
      SWARM_OS_HOST_OPENCODE_DIR="$RUN_HOME/.config/opencode"
    else
      SWARM_OS_HOST_OPENCODE_DIR="$RUN_HOME/.opencode"
    fi
  fi
  # gemini has no "use whatever works" auth mode: unpinned it opens an auth
  # picker that repaints for ever, so the agent never goes idle and never reads
  # its team messages.
  run_test -f "$RUN_HOME/.gemini/oauth_creds.json" && SWARM_OS_GEMINI_AUTH_TYPE="oauth-personal"

  # Only under ssh can anything but claude run at all, and only what is already
  # on this host. Offer the choice rather than hardcoding claude — a team that
  # names no provider gets this one, and changing it later means hand-editing
  # `.env`. Installing the CLIs stays the operator's job: one is selectable at
  # the next availability poll, 60 s, no restart.
  local popts
  # On the RUN-AS account's login-shell PATH — the only PATH an agent ever sees.
  popts=("claude|claude (Anthropic)|always available")
  run_user_has codex    && popts+=("codex|codex (OpenAI)|on ${user}'s login-shell PATH")
  run_user_has gemini   && popts+=("gemini|gemini (Google)|on ${user}'s login-shell PATH")
  run_user_has opencode && popts+=("opencode|opencode (OpenRouter)|on ${user}'s login-shell PATH")
  if [ "${#popts[@]}" -gt 1 ]; then
    ui_gap
    ui_dim "Default provider — what a team gets when neither it nor its role names one:"
    ui_menu SWARM_OS_DEFAULT_PROVIDER 1 "${popts[@]}"
    [ "$UI_BACK" = 1 ] && { UI_BACK=0; SWARM_OS_DEFAULT_PROVIDER="claude"; }
  else
    SWARM_OS_DEFAULT_PROVIDER="claude"
  fi

  ui_gap
  ui_pause "$G_RET continue   esc back" || return 0
  return 0
}

# ── Remote access ─────────────────────────────────────────────────────────────
screen_access() {
  STEP_NO=10
  local m dns=""
  ui_head "Remote access" "the UI binds to 127.0.0.1 and terminates no TLS inside the container"
  ui_gap
  # Seed the default from what is already configured. Always opening on
  # `loopback` would make enter — the "keep what I have" gesture — silently
  # erase the public URL of an existing tailscale or proxy deployment.
  local def=1
  case "${SWARM_OS_PUBLIC_URL:-}" in
    "") def=1 ;;
    *ts.net*) def=2 ;;
    *) def=3 ;;
  esac
  ui_menu m "$def" \
    "loopback|Localhost only, reached over an SSH tunnel|safest — ssh -L ${SWARM_OS_PORT}:127.0.0.1:${SWARM_OS_PORT} $(id -un)@<this-host>" \
    "tailscale|Tailscale, HTTPS on your tailnet|recommended for phone access — no public port is ever opened" \
    "proxy|A reverse proxy on a public domain|you run Caddy/nginx, you own the TLS and the abuse"
  [ "$UI_BACK" = 1 ] && return 0
  # Set BEFORE the branches: two of them return early, and `do_deploy` reads
  # this to decide whether to run `tailscale serve`. Assigned at the end of the
  # function, a tailnet URL could land in `.env` with nothing published on it.
  ACCESS_MODE="$m"

  case "$m" in
    loopback)
      SWARM_OS_PUBLIC_URL=""
      ;;
    tailscale)
      ui_gap
      if ! have tailscale; then
        ui_warn "tailscale is not installed on this host."
        if ui_confirm "Install it now (official script, needs sudo)?" n; then
          ui_suspend bash -c 'curl -fsSL https://tailscale.com/install.sh | sh' || true
        fi
      fi
      if have tailscale; then
        tailscale status >/dev/null 2>&1 || {
          if ui_confirm "This host is not on a tailnet. Run \`sudo tailscale up\`?" y; then
            ui_suspend sudo tailscale up || true
          fi
        }
        dns="$(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | sed 's/.*"DNSName": *"\([^"]*\)".*/\1/' | sed 's/\.$//')"
      fi
      if [ -n "$dns" ]; then
        ui_ok "tailnet name: $dns"
        SWARM_OS_PUBLIC_URL="https://${dns}:${SWARM_OS_PORT}"
        # `serve` publishes the loopback port over the tailnet with a real
        # certificate; nothing is exposed to the public internet by it. The
        # container has to be up first, so it is run at the end of the deploy.
        ui_out "It will be published with \`tailscale serve\` once the container is up."
      else
        ui_gap
        ui_input SWARM_OS_PUBLIC_URL "public url" "$SWARM_OS_PUBLIC_URL" v_nonempty_url
      fi
      ui_gap
      ui_pause || return 0
      ;;
    proxy)
      ui_gap
      ui_wrapdim "The proxy MUST forward WebSockets — the live terminal and the event stream ride on them."
      ui_wrapdim "One vhost is enough: the VS Code editor is proxied by swarm-os itself under /ide, same origin, same port."
      ui_gap
      ui_input SWARM_OS_PUBLIC_URL "public url" "${SWARM_OS_PUBLIC_URL:-https://swarm.example.com}" v_nonempty_url
      [ "$UI_BACK" = 1 ] && return 0
      ;;
  esac
  return 0
}

# ── Optional extras ───────────────────────────────────────────────────────────
screen_extras() {
  STEP_NO=11
  ui_head "Notifications, updates, limits" "all optional — enter walks past every one of them"
  ui_dim "Update detection reads the GitHub releases of a private repository, so it"
  ui_dim "needs a read-only PAT. Empty is a healthy state: it means \"never tell me\"."
  ui_gap
  SWARM_OS_GITHUB_TOKEN="${SWARM_OS_GITHUB_TOKEN:-$TOKEN}"
  ui_input SWARM_OS_GITHUB_TOKEN "release-check token" "$SWARM_OS_GITHUB_TOKEN" v_token 1
  [ "$UI_BACK" = 1 ] && return 0
  ui_input SWARM_OS_DISCORD_WEBHOOK_URL "discord webhook (empty = off)" "$SWARM_OS_DISCORD_WEBHOOK_URL"
  [ "$UI_BACK" = 1 ] && return 0
  ui_input SWARM_OS_MAX_ORCHESTRATORS "max teams at once" "$SWARM_OS_MAX_ORCHESTRATORS"
  [ "$UI_BACK" = 1 ] && return 0
  ui_input SWARM_OS_MAX_WORKERS_PER_ORCH "max workers per team" "$SWARM_OS_MAX_WORKERS_PER_ORCH"
  [ "$UI_BACK" = 1 ] && return 0
  ui_input SWARM_OS_IMAGE "image reference" "$SWARM_OS_IMAGE" v_image
  return 0
}

# ── Review ────────────────────────────────────────────────────────────────────
mask() { [ -n "${1-}" ] && printf 'set (hidden)' || printf '(not set)'; }

screen_review() {
  STEP_NO=12
  ui_head "Review" "nothing has been written to $DIR yet"
  ui_kv "project"        "$SWARM_OS_PROJECT_NAME"
  ui_kv "container"      "$SWARM_OS_CONTAINER_NAME"
  ui_kv "url"            "http://127.0.0.1:${SWARM_OS_PORT}"
  ui_kv "install dir"    "$DIR"
  ui_kv "runs as"        "$SWARM_OS_RUN_USER  (uid $SWARM_OS_RUN_UID, gid $SWARM_OS_RUN_GID)"
  ui_kv "claude login"   "$CLAUDE_DIR"
  ui_kv "workspace"      "$WORKSPACE_PATH"
  ui_kv "state (/data)"  "$DATA_PATH"
  ui_kv "image"          "$SWARM_OS_IMAGE"
  ui_kv "transport"      "$SWARM_OS_AGENT_TRANSPORT"
  [ "$SWARM_OS_AGENT_TRANSPORT" = ssh ] && {
    ui_kv "ssh target"   "${SWARM_OS_SSH_TARGET}:${SWARM_OS_SSH_PORT}"
    ui_kv "ssh key"      "${SWARM_OS_SSH_KEY} (from $HOST_SSH_DIR)"
  }
  ui_kv "remote access"  "${SWARM_OS_PUBLIC_URL:-loopback / ssh tunnel}"
  ui_kv "discord"        "$(mask "$SWARM_OS_DISCORD_WEBHOOK_URL")"
  ui_kv "release checks" "$(mask "$SWARM_OS_GITHUB_TOKEN")"
  ui_gap
  ui_wrap "Writing this creates $DIR/.env in mode 600 (it holds your tokens), fetches two compose files, pulls the image and starts the container."
  ui_gap
  if ui_confirm "Write it and deploy?" y; then return 0; fi
  UI_BACK=1
  return 0
}

# ══════════════════════════════════════════════════════════════════════════════
# 5. Writing what we were told
# ══════════════════════════════════════════════════════════════════════════════
ENV_TMP=""
ENV_KEYS=""
etx() { printf '%s\n' "${1-}" >>"$ENV_TMP"; }

# This file is SHELL-SOURCED — by `do_deploy`, by `load_env_file` on a
# reconfigure, and by the wrapper on every `swarm-os logs`. An unquoted value
# with a space (`SWARM_OS_PROJECT_NAME=Swarm Trader`) is not a truncated string:
# it is an assignment prefix plus a command, so the variable ends up UNSET and
# the wrapper dies at line 5 for ever. A value carrying `;` or `$(` would be
# executed outright. Single-quote everything, escaping embedded quotes.
ekv() {
  ENV_KEYS="$ENV_KEYS $1 "
  printf "%s='%s'\n" "$1" "$(printf '%s' "${2-}" | sed "s/'/'\\\\''/g")" >>"$ENV_TMP"
}

# The one exception. swarm-os's own one-click updater rewrites this line on the
# host and reads it back with `sed 's/^[^=]*=//'`, so quotes here would become
# part of the image reference.
ekv_raw() { ENV_KEYS="$ENV_KEYS $1 "; printf '%s=%s\n' "$1" "${2-}" >>"$ENV_TMP"; }

# `write_env` re-emits its own fixed key list, so anything the operator added by
# hand — SWARM_OS_OPENROUTER_API_KEY is read by the shipped compose file and is
# not on that list — would be silently deleted by a reconfigure, surfacing only
# on the NEXT restart. Keep every line whose key we did not write.
carry_over_unknown() {
  local src="$1" line key first=1
  [ -f "$src" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      [A-Za-z_]*=*) key="${line%%=*}" ;;
      *) continue ;;
    esac
    case "$ENV_KEYS" in *" $key "*) continue ;; esac
    if [ "$first" = 1 ]; then
      etx ""
      etx "# ── Carried over ─────────────────────────────────────────────────────────────"
      etx "# Keys this installer does not manage, kept verbatim from the file it replaced."
      first=0
    fi
    etx "$line"
  done < "$src"
  return 0
}

write_env() {
  mkdir -p "$DIR" || die "cannot create $DIR"
  ENV_FILE="$DIR/.env"
  local bak=""
  if [ -f "$ENV_FILE" ]; then
    bak="${ENV_FILE}.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$bak" && printf '  %s%s%s previous config backed up to %s\n' "$C_GREEN" "$G_OK" "$C_RESET" "$(basename "$bak")"
  fi
  ENV_TMP="${ENV_FILE}.tmp.$$"
  ENV_KEYS=""
  : >"$ENV_TMP" || die "cannot write in $DIR"

  etx "# swarm-os — deployment config, written by setup.sh $SETUP_VERSION on $(date -u '+%Y-%m-%d %H:%M UTC')."
  etx "# One KEY=VALUE per line, no quotes, no inline comments."
  etx "# Re-run the installer to change any of it; this file is backed up first."
  etx ""
  etx "# ── Image ────────────────────────────────────────────────────────────────────"
  etx "# THIS is the line a one-click update rewrites in place (leaving a .bak beside"
  etx "# this file). Keep it a plain, unquoted assignment."
  ekv_raw SWARM_OS_IMAGE "$SWARM_OS_IMAGE"
  etx ""
  etx "# ── Identity ─────────────────────────────────────────────────────────────────"
  ekv SWARM_OS_PROJECT_NAME "$SWARM_OS_PROJECT_NAME"
  ekv SWARM_OS_CONTAINER_NAME "$SWARM_OS_CONTAINER_NAME"
  etx "# The compose project. Pinned at first install and never recomputed: renaming"
  etx "# the container later must not move the deployment into a new project and"
  etx "# leave the old container running against this same DATA_PATH."
  ekv COMPOSE_PROJECT_NAME "$(compose_project)"
  etx ""
  etx "# ── Run-as account ───────────────────────────────────────────────────────────"
  etx "# The host account this instance belongs to. The container process carries"
  etx "# this uid:gid (compose \`user:\`), so everything it writes in /data and"
  etx "# /workspace belongs to that account — and under the ssh transport the agent"
  etx "# CLIs are started as it. The paths below are its home, not the installer's."
  etx "# SWARM_OS_RUN_USER is not read by anything at runtime: it is what makes a"
  etx "# reconfigure keep this account instead of reverting to whoever re-runs the"
  etx "# installer."
  ekv SWARM_OS_RUN_USER "$SWARM_OS_RUN_USER"
  ekv SWARM_OS_RUN_UID "$SWARM_OS_RUN_UID"
  ekv SWARM_OS_RUN_GID "$SWARM_OS_RUN_GID"
  etx "# HOME inside the container. uid 1000 is the image's own \`node\` user, which"
  etx "# owns /home/node; any other uid has no passwd entry in the image, would get"
  etx "# HOME=/ and fail every npm / plugin install that writes under it."
  ekv SWARM_OS_CONTAINER_HOME "$SWARM_OS_CONTAINER_HOME"
  etx ""
  etx "# ── Host paths (under the run-as account's home) ──────────────────────────────"
  ekv WORKSPACE_PATH "$WORKSPACE_PATH"
  ekv DATA_PATH "$DATA_PATH"
  ekv CLAUDE_DIR "$CLAUDE_DIR"
  ekv CLAUDE_JSON "$CLAUDE_JSON"
  etx ""
  etx "# ── Port (host loopback only — never bind 0.0.0.0) ────────────────────────────"
  ekv SWARM_OS_PORT "$SWARM_OS_PORT"
  etx ""
  etx "# ── Agent transport ──────────────────────────────────────────────────────────"
  etx "# local = agents run inside the container (claude only, no one-click update)."
  etx "# ssh   = agents run on this host with the host's own CLI logins."
  ekv SWARM_OS_AGENT_TRANSPORT "$SWARM_OS_AGENT_TRANSPORT"
  if [ "$SWARM_OS_AGENT_TRANSPORT" = ssh ]; then
    ekv SWARM_OS_SSH_TARGET "$SWARM_OS_SSH_TARGET"
    ekv SWARM_OS_SSH_PORT "${SWARM_OS_SSH_PORT:-22}"
    etx "# Path INSIDE the container; HOST_SSH_DIR is what gets mounted at /host-ssh."
    ekv SWARM_OS_SSH_KEY "$SWARM_OS_SSH_KEY"
    ekv HOST_SSH_DIR "$HOST_SSH_DIR"
    etx "# Host-side twins of the bind mounts. Required under ssh: left unset they"
    etx "# default to the CONTAINER's home and every credential symlink dangles."
    ekv SWARM_OS_HOST_DATA_DIR "$SWARM_OS_HOST_DATA_DIR"
    ekv SWARM_OS_HOST_WORKSPACE_ROOT "$SWARM_OS_HOST_WORKSPACE_ROOT"
    ekv SWARM_OS_HOST_CLAUDE_DIR "$SWARM_OS_HOST_CLAUDE_DIR"
    ekv SWARM_OS_HOST_CODEX_DIR "$SWARM_OS_HOST_CODEX_DIR"
    ekv SWARM_OS_HOST_GEMINI_DIR "$SWARM_OS_HOST_GEMINI_DIR"
    ekv SWARM_OS_HOST_OPENCODE_DIR "$SWARM_OS_HOST_OPENCODE_DIR"
    ekv SWARM_OS_GEMINI_AUTH_TYPE "$SWARM_OS_GEMINI_AUTH_TYPE"
  fi
  etx ""
  etx "# ── Providers ────────────────────────────────────────────────────────────────"
  ekv SWARM_OS_DEFAULT_PROVIDER "$SWARM_OS_DEFAULT_PROVIDER"
  etx "# Empty = that provider's own default model, kept current from models.dev."
  ekv SWARM_OS_DEFAULT_MODEL "$SWARM_OS_DEFAULT_MODEL"
  ekv SWARM_OS_DEFAULT_EFFORT "$SWARM_OS_DEFAULT_EFFORT"
  etx ""
  etx "# ── Remote access & notifications ────────────────────────────────────────────"
  ekv SWARM_OS_PUBLIC_URL "$SWARM_OS_PUBLIC_URL"
  ekv SWARM_OS_DISCORD_WEBHOOK_URL "$SWARM_OS_DISCORD_WEBHOOK_URL"
  etx ""
  etx "# ── Update detection ─────────────────────────────────────────────────────────"
  etx "# Read-only GitHub PAT (contents:read). Empty = never announce releases."
  ekv SWARM_OS_GITHUB_TOKEN "$SWARM_OS_GITHUB_TOKEN"
  etx ""
  etx "# ── Envelopes ────────────────────────────────────────────────────────────────"
  ekv SWARM_OS_MAX_ORCHESTRATORS "$SWARM_OS_MAX_ORCHESTRATORS"
  ekv SWARM_OS_MAX_WORKERS_PER_ORCH "$SWARM_OS_MAX_WORKERS_PER_ORCH"
  ekv SWARM_OS_LOG_LEVEL "$SWARM_OS_LOG_LEVEL"
  etx "# First-boot seed only: after that the DB governs and the IDE is toggled from"
  etx "# the Plugins screen."
  ekv SWARM_OS_IDE_ENABLED "$SWARM_OS_IDE_ENABLED"
  ekv SWARM_OS_IDE_PORT "$SWARM_OS_IDE_PORT"

  carry_over_unknown "$bak"

  chmod 600 "$ENV_TMP" 2>/dev/null
  mv "$ENV_TMP" "$ENV_FILE" || die "could not write $ENV_FILE"
  ENV_TMP=""
  printf '  %s%s%s wrote %s (mode 600 — it holds your tokens)\n' "$C_GREEN" "$G_OK" "$C_RESET" "$ENV_FILE"
}

# The compose files, straight from the repository. With a token: the API's raw
# media type, the documented way to read a file out of a private repo, which
# accepts both token kinds. Without one: raw.githubusercontent, which needs no
# API budget but only ever serves public repositories.
fetch_one() {
  local path="$1" dest="$DIR/$path" code
  mkdir -p "$(dirname "$dest")" || return 1
  if [ -n "$TOKEN" ]; then
    code="$(curl -sS -w '%{http_code}' -o "$dest.part" -m 40 --retry 2 --retry-delay 1 \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github.raw" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${REPO}/contents/${path}?ref=${REF}" 2>/dev/null)" || code="000"
  else
    code="$(curl -sS -w '%{http_code}' -o "$dest.part" -m 40 --retry 2 --retry-delay 1 \
      "https://raw.githubusercontent.com/${REPO}/${REF}/${path}" 2>/dev/null)" || code="000"
  fi
  if [ "$code" != 200 ] || [ ! -s "$dest.part" ]; then rm -f "$dest.part"; printf '%s' "$code"; return 1; fi
  mv "$dest.part" "$dest"
  return 0
}

fetch_kit() {
  local path code
  for path in "$KIT_DIST" "$KIT_SSH"; do
    if code="$(fetch_one "$path")"; then
      printf '  %s%s%s %s\n' "$C_GREEN" "$G_OK" "$C_RESET" "$path"
    else
      case "$code" in
        401|403) die "GitHub refused the token while fetching $path (HTTP $code). It needs read access to ${REPO}." ;;
        404) die "HTTP 404 on $path. Either the token cannot see ${REPO} (a private repo answers 404, not 403), or ref '${REF}' has no such file." ;;
        000) die "could not reach GitHub while fetching $path — network, DNS or proxy." ;;
        *) die "could not fetch $path (HTTP $code)." ;;
      esac
    fi
  done
  # An error page can be a 200. Never hand `docker compose` a login form.
  grep -q '^services:' "$DIR/$KIT_DIST" 2>/dev/null \
    || die "$DIR/$KIT_DIST is not a compose file — check the token and the ref."
  grep -q 'swarm-os:' "$DIR/$KIT_DIST" 2>/dev/null \
    || die "$DIR/$KIT_DIST does not describe the swarm-os service."
}

# A four-command wrapper, because this installer is standalone: without it the
# operator has to remember the whole `--env-file … -f … -f …` invocation to so
# much as read the logs.
write_wrapper() {
  local w="$DIR/swarm-os"
  cat >"$w" <<'WRAP'
#!/usr/bin/env bash
# swarm-os — deployment wrapper, written by setup.sh. Run it from anywhere.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
set -a; . "$HERE/.env"; set +a
# -p must match what the installer used, or compose looks for the container in a
# project named after the `examples/` directory and finds nothing.
PROJ="${COMPOSE_PROJECT_NAME:-${SWARM_OS_CONTAINER_NAME:-swarm-os}}"
PROJ="$(printf '%s' "$PROJ" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//')"
ARGS=(--env-file "$HERE/.env" -p "${PROJ:-swarm-os}" -f "$HERE/examples/docker-compose.dist.yml")
[ "${SWARM_OS_AGENT_TRANSPORT:-local}" = ssh ] && ARGS+=(-f "$HERE/examples/docker-compose.ssh.yml")
case "${1:-status}" in
  up|start|restart) docker compose "${ARGS[@]}" up -d ;;
  down|stop)        docker compose "${ARGS[@]}" down ;;
  logs)             shift; docker compose "${ARGS[@]}" logs -f "$@" ;;
  status|ps)        docker compose "${ARGS[@]}" ps ;;
  token)            docker exec "${SWARM_OS_CONTAINER_NAME:-swarm-os}" cat /data/token ;;
  update)           docker pull "$SWARM_OS_IMAGE" && docker compose "${ARGS[@]}" up -d ;;
  url)              printf '%s\n' "${SWARM_OS_PUBLIC_URL:-http://127.0.0.1:${SWARM_OS_PORT:-8787}}" ;;
  *) printf 'usage: swarm-os {up|down|restart|logs|status|token|update|url}\n' >&2; exit 2 ;;
esac
WRAP
  chmod +x "$w" 2>/dev/null
  printf '  %s%s%s wrote %s\n' "$C_GREEN" "$G_OK" "$C_RESET" "$w"
}

# ══════════════════════════════════════════════════════════════════════════════
# 6. Deploy — outside the alternate screen, so the output stays in the scrollback
# ══════════════════════════════════════════════════════════════════════════════
say()  { printf '\n%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
good() { printf '  %s%s%s %s\n' "$C_GREEN" "$G_OK" "$C_RESET" "$*"; }
bad()  { printf '  %s%s%s %s\n' "$C_RED" "$G_NO" "$C_RESET" "$*"; }
hmm()  { printf '  %s%s%s %s\n' "$C_YELLOW" "$G_WARN" "$C_RESET" "$*"; }
dimly(){ printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# Compose names a project after the directory holding the first `-f` file, which
# here is always `examples` — every install on this host would land in the SAME
# project, and a `compose up` in one would treat another's container as an
# orphan of its own project.
#
# So the project name is pinned in `.env` at first install and read back for
# ever after. Deriving it from the container name on every run would be worse
# than the collision it fixes: renaming the project on a reconfigure would move
# the deployment into a NEW compose project, leaving the old container running
# against the same DATA_PATH — two servers on one SQLite file.
compose_project() {
  local p="${COMPOSE_PROJECT_NAME:-}"
  [ -n "$p" ] || p="${SWARM_OS_CONTAINER_NAME:-swarm-os}"
  p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//')"
  [ -n "$p" ] || p="swarm-os"
  printf '%s' "$p"
}

compose_args() {
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -p "$(compose_project)" -f "$DIR/$KIT_DIST")
  if [ "${SWARM_OS_AGENT_TRANSPORT:-local}" = ssh ]; then
    [ -f "$DIR/$KIT_SSH" ] || die "transport is ssh but $DIR/$KIT_SSH was not fetched."
    COMPOSE_ARGS+=(-f "$DIR/$KIT_SSH")
  fi
}

# Everything below runs against a `.env` this script may not have written: the
# "redeploy as it stands" path takes a file the operator may have hand-edited,
# and a wrong path here is silent rather than loud. A bind mount whose host side
# does not exist makes the DAEMON create it — root-owned. `${WORKSPACE_PATH}`
# then mounts an empty tree the agents happily "work" in, and `${DATA_PATH}`
# mounts a directory the run-as uid cannot write, so the container restart-loops.
validate_env() {
  local duid chome who
  : "${SWARM_OS_CONTAINER_NAME:=swarm-os}"
  : "${SWARM_OS_PORT:=8787}"
  # An .env from before the run-as question — or one written by hand — means uid
  # 1000, the image's own `node` user: exactly what the compose file falls back
  # to. Resolve it identically here, so every check below speaks about the uid
  # the container will really carry.
  : "${SWARM_OS_RUN_UID:=1000}"
  : "${SWARM_OS_RUN_GID:=1000}"
  : "${SWARM_OS_CONTAINER_HOME:=/home/node}"
  # A NAME, resolved from that uid — never a label like "uid 1000". The checks
  # below reach into another account's home through it, and a name no passwd
  # entry matches would turn every one of them into a silent "cannot tell".
  # `who` stays EMPTY when nothing resolves: the fallback below keeps the tests
  # working, but a name we invented must never appear in a message.
  who="${SWARM_OS_RUN_USER:-}"
  [ -n "$who" ] || who="$(getent passwd "$SWARM_OS_RUN_UID" 2>/dev/null | head -1 | cut -d: -f1)"
  RUN_LABEL="uid $SWARM_OS_RUN_UID"
  [ -n "$who" ] && RUN_LABEL="$who (uid $SWARM_OS_RUN_UID)"
  SWARM_OS_RUN_USER="${who:-$SELF_USER}"
  : "${CLAUDE_DIR:=$HOME/.claude}"
  : "${CLAUDE_JSON:=$HOME/.claude.json}"
  [ -n "${SWARM_OS_IMAGE:-}" ] || die "SWARM_OS_IMAGE is empty in $ENV_FILE"
  [ -n "${WORKSPACE_PATH:-}" ] || die "WORKSPACE_PATH is empty in $ENV_FILE"
  # `run_test`, not `[ -d ]`: on an instance installed for another account the
  # workspace can sit in a 0700 home. Killing a legitimate deploy over a
  # permission the CONTAINER has and we do not is the wrong call.
  run_test -d "$WORKSPACE_PATH"
  [ "$?" = 1 ] && die "WORKSPACE_PATH does not exist: $WORKSPACE_PATH
  Docker would create it as root and the agents would work in an empty tree."
  [ -n "${DATA_PATH:-}" ]      || die "DATA_PATH is empty in $ENV_FILE"
  run_mkdir "$DATA_PATH"       || die "cannot create DATA_PATH: $DATA_PATH"

  # The state directory has to belong to the uid in `user:`, or the container
  # boots and then cannot write its own database. -1 = we cannot stat it from
  # here, which says nothing about the container.
  duid="$(run_owner_uid "$DATA_PATH")"
  if [ "$duid" != "$SWARM_OS_RUN_UID" ] && [ "$duid" != "-1" ]; then
    hmm "$DATA_PATH belongs to uid $duid, but the container runs as $RUN_LABEL:"
    dimly "sudo chown -R $SWARM_OS_RUN_UID:$SWARM_OS_RUN_GID $DATA_PATH"
  fi

  # A run-as account other than uid 1000 has no home inside the image, so its
  # HOME is redirected into /data. It has to exist before the first boot.
  case "$SWARM_OS_CONTAINER_HOME" in
    /data/*)
      chome="$DATA_PATH/${SWARM_OS_CONTAINER_HOME#/data/}"
      run_mkdir "$chome" \
        || hmm "cannot create $chome — the container's HOME; npm and plugin installs inside it will fail" ;;
  esac

  # Through `run_test`: on a deployment installed FOR another account, a 0700
  # home makes a plain `[ -f ]` answer "missing" about files that are there, and
  # this warning would send the operator off to redo an OAuth login.
  run_test -f "$CLAUDE_JSON"
  [ "$?" = 1 ] && hmm "$CLAUDE_JSON does not exist — Docker will create a directory there and the first agent will hang on the theme picker."
  run_test -f "$CLAUDE_DIR/.credentials.json"
  [ "$?" = 1 ] && hmm "no $CLAUDE_DIR/.credentials.json — the server will start, but no agent can."
  return 0
}

pull_image() {
  case "$SWARM_OS_IMAGE" in
    */*) : ;;
    *) if docker image inspect "$SWARM_OS_IMAGE" >/dev/null 2>&1; then
         good "using the local image $SWARM_OS_IMAGE"; return 0
       fi
       die "$SWARM_OS_IMAGE has no registry path and is not in the local image store." ;;
  esac
  say "Pulling $SWARM_OS_IMAGE"
  if docker pull "$SWARM_OS_IMAGE"; then good "image ready"; return 0; fi

  # The access probe on the token screen ran against whatever image was selected
  # THEN; the answer can have changed since, and the registry login is the one
  # recovery worth attempting without sending the operator back to the start.
  local registry="${SWARM_OS_IMAGE%%/*}" tok="${GHCR_TOKEN:-${TOKEN:-}}"
  if [ -n "$tok" ]; then
    [ -n "$GHCR_USER" ] || GHCR_USER="$(curl -sS -m 15 -H "Authorization: Bearer ${tok}" \
      https://api.github.com/user 2>/dev/null \
      | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    if [ -n "$GHCR_USER" ]; then
      say "Authenticating to $registry as $GHCR_USER"
      if printf '%s' "$tok" | docker login "$registry" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
        good "logged in"
        if docker pull "$SWARM_OS_IMAGE"; then good "image ready"; return 0; fi
      else
        bad "docker login was refused by $registry"
      fi
    fi
  fi
  bad "the pull failed."
  dimly "the GHCR package is private: it needs a \`docker login\` with a PAT carrying"
  dimly "read:packages, on an account the maintainer has granted access to."
  dimly "  echo <PAT> | docker login ${SWARM_OS_IMAGE%%/*} -u <github-user> --password-stdin"
  die "could not pull the image — nothing was started."
}

wait_healthy() {
  local url="http://127.0.0.1:${SWARM_OS_PORT}/health" body="" i=1
  say "Waiting for $url"
  while [ "$i" -le 120 ]; do
    body="$(curl -fsS -m 3 "$url" 2>/dev/null)" || body=""
    case "$body" in
      *'"boot_complete":true'*) good "server healthy, auto-resume finished"; return 0 ;;
      ?*) [ "$((i % 5))" = 0 ] && dimly "up, still replaying teams (boot_complete=false)…" ;;
    esac
    sleep 1
    i=$((i + 1))
  done
  if [ -n "$body" ]; then
    hmm "the server answers /health but has not finished booting; business routes answer 503 until it does."
    return 0
  fi
  bad "the server never answered. Recent logs:"
  "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" logs --tail 40 2>&1 | sed 's/^/    /'
  die "startup failed."
}

read_token() {
  local t="" i=1
  while [ "$i" -le 10 ]; do
    t="$(docker exec "$SWARM_OS_CONTAINER_NAME" cat /data/token 2>/dev/null)" || t=""
    [ -n "$t" ] && break
    sleep 1
    i=$((i + 1))
  done
  printf '%s' "$t"
}

# What the instance itself thinks of each provider — the answer to "why is codex
# greyed out?", given before the question is asked.
show_providers() {
  local token="$1" json
  have python3 || return 0
  json="$(curl -fsS -m 5 -H "X-Auth-Token: $token" "http://127.0.0.1:${SWARM_OS_PORT}/providers" 2>/dev/null)" || return 0
  [ -n "$json" ] || return 0
  printf '\n  %sProviders as this instance sees them%s\n' "$C_BOLD" "$C_RESET"
  printf '%s' "$json" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for p in d.get("providers",[]):
    mark = "  ok " if p.get("available") else "  -- "
    why  = "" if p.get("available") else "  (%s)" % (p.get("unavailableReason") or "unavailable")
    print("  %s%-9s%s" % (mark, p.get("id",""), why))
' 2>/dev/null || true
}

do_deploy() {
  ui_leave
  printf '\n  %s%sswarm-os%s %s— deploying %s%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET" "$C_DIM" "$SWARM_OS_PROJECT_NAME" "$C_RESET"
  printf '  %s%s%s\n' "$C_DIM" "$(rule 72)" "$C_RESET"

  if [ "$SKIP_TO_DEPLOY" != 1 ]; then
    say "Writing the configuration"
    write_env
    say "Fetching the compose files from ${REPO}@${REF}"
    fetch_kit
  else
    # "As it stands" means the answers, not the plumbing: the compose files stay
    # pinned to the ref they were installed from.
    say "Redeploying $ENV_FILE as it stands"
    [ -f "$DIR/$KIT_DIST" ] || fetch_kit
  fi
  # The wrapper is pure derivative of `.env`, never operator data — rewrite it
  # every time so it can never disagree with the deployment it drives.
  write_wrapper

  # Export everything so ${HOME} in a hand-edited path is expanded by the shell
  # before compose ever reads it.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  validate_env
  compose_args

  pull_image

  say "Starting $SWARM_OS_CONTAINER_NAME"
  "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" up -d || die "\`compose up\` failed."
  wait_healthy

  # Only now is there something on the loopback port worth publishing.
  if [ "$ACCESS_MODE" = tailscale ] && have tailscale && [ -n "$SWARM_OS_PUBLIC_URL" ]; then
    say "Publishing it on your tailnet"
    tailscale serve --bg --https="$SWARM_OS_PORT" "http://127.0.0.1:${SWARM_OS_PORT}" 2>/dev/null \
      || sudo tailscale serve --bg --https="$SWARM_OS_PORT" "http://127.0.0.1:${SWARM_OS_PORT}" 2>/dev/null \
      || hmm "tailscale serve failed — run it yourself once you are logged in"
  fi

  local token; token="$(read_token)"
  printf '\n  %s%s%s\n' "$C_GREEN$C_BOLD" "swarm-os is up." "$C_RESET"
  printf '  %surl%s     http://127.0.0.1:%s\n' "$C_DIM" "$C_RESET" "$SWARM_OS_PORT"
  printf '  %sruns as%s %s, Claude login %s\n' "$C_DIM" "$C_RESET" "$RUN_LABEL" "$CLAUDE_DIR"
  [ -n "${SWARM_OS_PUBLIC_URL:-}" ] && printf '  %sremote%s  %s\n' "$C_DIM" "$C_RESET" "$SWARM_OS_PUBLIC_URL"
  if [ -n "$token" ]; then
    printf '  %stoken%s   %s%s%s\n' "$C_DIM" "$C_RESET" "$C_BOLD" "$token" "$C_RESET"
    dimly "paste it into the Token panel — it is kept in the browser localStorage"
  else
    hmm "could not read the token automatically:"
    dimly "docker exec $SWARM_OS_CONTAINER_NAME cat /data/token"
  fi

  [ -n "$token" ] && show_providers "$token"

  printf '\n  %sNext%s\n' "$C_BOLD" "$C_RESET"
  [ -z "${SWARM_OS_PUBLIC_URL:-}" ] && \
    printf '     from your laptop:  ssh -L %s:127.0.0.1:%s %s@<this-host>\n' "$SWARM_OS_PORT" "$SWARM_OS_PORT" "$(id -un)"
  printf '     logs:              %s/swarm-os logs\n' "$DIR"
  printf '     restart / update:  %s/swarm-os up   |   %s/swarm-os update\n' "$DIR" "$DIR"
  printf '     reconfigure:       re-run this installer and point it at %s\n' "$DIR"
  printf '\n'
}

# ══════════════════════════════════════════════════════════════════════════════
# 7. Entry point
# ══════════════════════════════════════════════════════════════════════════════
# The header comment IS the help text — but under `curl … | bash` this script
# has no path on disk to read it back from, so keep a short fallback.
usage() {
  local self="${BASH_SOURCE[0]:-}"
  case "$self" in
    ""|bash|-bash|sh|/dev/fd/*|/proc/self/fd/*) self="" ;;
  esac
  if [ -n "$self" ] && [ -r "$self" ]; then
    sed -n '2,35p' "$self" | sed 's/^# \{0,1\}//'
    return 0
  fi
  printf '%s\n' \
    "swarm-os — fullscreen guided installer." \
    "" \
    "  --dir <path>      install directory      (default ~/swarm-os)" \
    "  --user <name>     host account to run as (default: you)" \
    "  --port <n>        host port for the UI   (default 8787)" \
    "  --token <pat>     GitHub token, read-only" \
    "  --ref <ref>       branch or tag to fetch the compose files from" \
    "  --repo <o/r>      source repository" \
    "  --image <ref>     image reference to deploy" \
    "  --no-fullscreen   keep the normal scrollback" \
    "  --help"
}

# `screen_user` sits AFTER `screen_dir` on purpose: the directory screen is what
# loads an existing `.env`, and the account that deployment was installed for
# must be the default offered, not the one who happens to be typing.
SCREENS=(screen_welcome screen_prereqs screen_token screen_dir screen_user
         screen_project screen_workspace screen_data screen_port screen_transport
         screen_access screen_extras screen_review)

main() {
  # Settle the default account before anything derived from it is read. The
  # globals at the top of this file can only carry `id -u`; the container's own
  # HOME depends on the passwd lookup, which lives down here.
  apply_run_user "$SELF_USER" || true

  # `shift 2` with a single argument left shifts NOTHING and returns non-zero,
  # and with `set -e` off that spins this loop on the same `$1` for ever — a
  # hung, hot machine after the exact typo a piped invocation invites
  # (`bash -s -- --token` with the value forgotten). Check before shifting.
  local need
  while [ "$#" -gt 0 ]; do
    need="$1"
    case "$1" in
      --dir|--port|--token|--ref|--repo|--image|--user)
        [ "$#" -ge 2 ] || die "$need needs a value (try --help)" ;;
    esac
    case "$1" in
      --dir)            DIR="$(expand_path "$2")"; shift 2 ;;
      --user)           RUN_USER_ARG="$2"; shift 2 ;;
      --port)           SWARM_OS_PORT="$2"; shift 2 ;;
      --token)          TOKEN="$2"; shift 2 ;;
      --ref)            REF="$2"; shift 2 ;;
      --repo)           REPO="$2"; shift 2 ;;
      --image)          SWARM_OS_IMAGE="$2"; shift 2 ;;
      --no-fullscreen)  FULLSCREEN=0; shift ;;
      --help|-h)        usage; exit 0 ;;
      *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
    esac
  done

  # Applied before the first screen so the account is the DEFAULT everywhere,
  # not an override applied afterwards to answers already derived from it.
  if [ -n "$RUN_USER_ARG" ]; then
    local prev="$RUN_HOME"
    apply_run_user "$RUN_USER_ARG" || die "--user: no such account on this host: $RUN_USER_ARG"
    [ "$SWARM_OS_RUN_UID" = 0 ] && die "--user: the container must never run as root"
    follow_run_home "$prev"
  fi

  if [ "$INTERACTIVE" != 1 ]; then
    printf '\n  swarm-os setup needs a terminal to ask its questions.\n' >&2
    printf '  Run it from an interactive shell:\n\n' >&2
    printf '    curl -fsSL <url>/setup.sh -o setup.sh && bash setup.sh\n\n' >&2
    exit 1
  fi
  have curl || die "curl is required."

  ui_size
  if [ "$UI_H" -lt 18 ] || [ "$UI_W" -lt 68 ]; then
    printf '\n  This installer needs a terminal of at least 68x18 (this one is %sx%s).\n' "$UI_W" "$UI_H" >&2
    printf '  Resize it, or run it over an 80-column terminal for the intended layout.\n\n' >&2
    exit 1
  fi

  ui_enter
  local i=0 n=${#SCREENS[@]}
  while [ "$i" -lt "$n" ]; do
    UI_BACK=0
    "${SCREENS[$i]}"
    [ "$SKIP_TO_DEPLOY" = 1 ] && break
    if [ "$UI_BACK" = 1 ]; then
      [ "$i" -gt 0 ] && i=$((i - 1))
    else
      i=$((i + 1))
    fi
  done
  ui_leave

  do_deploy
}

main "$@"
