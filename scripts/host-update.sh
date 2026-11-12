#!/usr/bin/env bash
# =============================================================================
# swarm-os — host-side self-updater (plan Lot D §D.3)
# =============================================================================
#
# Runs ON THE HOST, detached (`spawnHostJob` → `setsid`), and updates the
# swarm-os deployment that owns `$HOST_DATA_DIR` by REWRITING THE
# `SWARM_OS_IMAGE=` LINE of that deployment's env file and running
# `docker compose … up -d`. It then kills its own caller (the container it was
# launched from is recreated), which is why every piece of state it produces is
# a FILE on the `/data` bind mount, never a return value.
#
# ── The constraints that shaped this script (each verified on a live host) ────
#
#  * `flock -n`, never a blocking or a WAITING flock. A second updater must fail
#    fast with "already running": a `-w` that eventually acquires the lock does
#    not decline the update, it DELAYS it, and the deployment is then recreated
#    twice back to back — the second time with whatever the first updater just
#    wrote.
#  * Self-identification is by `Mounts[/data].Source == $HOST_DATA_DIR`, not by
#    name and not by `/etc/hostname` alone. The hint is only ever a hint: it is
#    VALIDATED against that mount, and a scan of `docker ps` on the same
#    criterion is the fallback. Several swarm-os deployments coexist on one host.
#  * No compose labels (a plain `docker run`) ⇒ REFUSE. Reconstructing the argv
#    from `docker inspect` is lossy and would silently degrade the deployment.
#  * `com.docker.compose.project.config_files` may hold SEVERAL comma-separated
#    paths → one `-f` each, in order.
#  * `--project-name` always comes from the container's OWN label, never from
#    `docker compose ls`: `swarm-os-test` and `swarm-os-prod` share the project
#    name `swarm-os`.
#  * NEVER `--remove-orphans`. Verified with `--dry-run`: compose reports
#    `Found orphan containers ([swarm-os-prod])` and the flag would DELETE that
#    unrelated production deployment.
#  * NEVER `--pull always`: it re-resolves the tag at `up` time, defeating the
#    "the tag we wrote IS the tag that runs" property this whole design buys.
#  * Apply by rewriting the env file, NOT by retagging. A retag mutates a tag
#    other deployments share, and makes the tag permanently disagree with its
#    content — which breaks the very version comparison this feature is built on.
#  * The env rewrite is atomic and surgical: temp file + rename(2) in the SAME
#    directory, only the one line changed, comments and ordering preserved, a
#    `.bak` left beside it. Half-writing the operator's env file is worse than a
#    bad image.
#  * After the write, re-read `docker compose config` and assert the RESOLVED
#    image equals the target byte-for-byte: `${SWARM_OS_IMAGE:-ghcr.io/…:latest}`
#    means a missing variable silently falls back to something else entirely.
#  * Verification waits ≥300 s for `boot_complete`, because under the ssh
#    transport every team is respawned with a stagger and a short timeout would
#    declare a good update failed — killing the teams a second time.
#    "Healthy but not boot_complete" is `unknown`/manual review, NEVER an
#    automatic rollback.
#  * Every long step carries its OWN `timeout(1)`: the wrapper `hostExec` adds
#    bounds only the 15 s launcher, never this detached job.
#
# ── Contract with the server ─────────────────────────────────────────────────
#
#   stdout                  NDJSON progress, mirrored to <runDir>/events.ndjson
#   <runDir>/heartbeat      touched every 5 s (liveness; fs-only, zero SSH)
#   <runDir>/result.json    written atomically and LAST; authoritative
#   exit 0                  success        (image applied and verified)
#   exit 10                 rolled_back    (env line restored, service back)
#   exit 20                 failed         (incl. a rollback that itself failed)
#   exit 30                 refused        (preflight said no; NOTHING touched)
#
# `SCRIPT_VERSION` is stamped into every log line and into `result.json`: the
# script that updates version N is version N's script, so a support case must be
# able to tell which one ran.
#
# ── Testing ──────────────────────────────────────────────────────────────────
# Sourcing with `SWARM_OS_HOST_UPDATE_LIB=1` defines the functions and returns
# without doing anything, so the pure helpers (`hu_*`) are unit-tested from
# vitest and cross-checked against their TypeScript mirrors in
# `packages/server/src/modules/updates/compose.ts`.
#
# `apply --test-timing <floor>:<poll>` shrinks the verify window for the tests
# that must wait it out. A FLAG and never an environment variable: this runs
# under ssh, and an ambient variable would disarm the floor on a real update.
# =============================================================================

# NOT `set -e`: every failure here has a specific recovery (refuse / roll back /
# report), and a silent early exit is the one outcome this script may not have.
set -uo pipefail

SCRIPT_VERSION="1.1.0"

# Exit codes — mirrored in `modules/updates/host-script.ts`.
readonly EXIT_SUCCESS=0
readonly EXIT_ROLLED_BACK=10
readonly EXIT_FAILED=20
readonly EXIT_REFUSED=30

# Floors and defaults. The verify floor is load-bearing (see header).
VERIFY_TIMEOUT_FLOOR_S=300
VERIFY_POLL_INTERVAL_S=5
readonly DEFAULT_VERIFY_TIMEOUT_S=600
readonly DEFAULT_WAIT_TIMEOUT_S=300
readonly DEFAULT_PULL_TIMEOUT_S=900
readonly HEARTBEAT_INTERVAL_S=5
readonly DOCKER_PROBE_TIMEOUT_S=30
# One bound for the WHOLE `docker ps` → `docker inspect` scan. Per-container
# probes have no aggregate cap: forty containers on a wedged dockerd is forty
# times `DOCKER_PROBE_TIMEOUT_S`, i.e. twenty minutes of a run that is supposed
# to be identifying itself.
readonly DOCKER_SCAN_TIMEOUT_S=60
readonly COMPOSE_CONFIG_TIMEOUT_S=120

# TESTS ONLY — the `--test-timing <floorSeconds>:<pollSeconds>` FLAG, and never
# an environment variable. The rollback and "healthy but never boot_complete"
# paths cannot be exercised without shrinking the 300 s window, and a test that
# waits five minutes per case is a test nobody runs.
#
# It used to be an environment variable, and that was wrong: this script runs
# under `ssh`, whose environment we do not control, so one stray `export` in a
# host profile silently disarmed the floor on a PRODUCTION run — the failure
# mode being that a good, slowly-resuming update is declared failed and every
# team is killed a second time. An argv flag cannot arrive by accident:
# `buildHostUpdateArgv` never emits one.
hu_set_test_timing() {
  local spec="${1-}"
  [[ "$spec" =~ ^([0-9]+):([0-9]+)$ ]] || return 1
  VERIFY_TIMEOUT_FLOOR_S="${BASH_REMATCH[1]}"
  VERIFY_POLL_INTERVAL_S="${BASH_REMATCH[2]}"
  [ "$VERIFY_POLL_INTERVAL_S" -ge 1 ] || VERIFY_POLL_INTERVAL_S=1
  return 0
}

# =============================================================================
# Pure helpers (no IO beyond stdin/stdout) — unit-tested, mirrored in TS.
# =============================================================================

# `com.docker.compose.project.config_files` → one absolute path per line.
# Comma-separated, whitespace-trimmed, empties dropped; relative entries are
# resolved against the project working dir.
hu_parse_config_files() {
  local raw="${1-}" wd="${2-}"
  local -a parts=()
  # `read -ra` splits on IFS WITHOUT globbing — `for p in $raw` would expand a
  # path containing `*` against the host filesystem.
  IFS=',' read -ra parts <<<"$raw"
  local p
  for p in "${parts[@]-}"; do
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    [ -n "$p" ] || continue
    case "$p" in
      /*) printf '%s\n' "$p" ;;
      *) printf '%s\n' "$wd/$p" ;;
    esac
  done
}

# The compose invocation prefix, one argv element per line.
# ALWAYS `--project-name` from the label and ALWAYS an explicit `--env-file`:
# the latter also removes any environment divergence between the apply pass and
# the rollback pass.
hu_compose_args() {
  local project="$1" envfile="$2"
  shift 2
  printf '%s\n' compose --project-name "$project" --env-file "$envfile"
  local f
  for f in "$@"; do
    printf '%s\n' -f "$f"
  done
}

# True when a `docker inspect --format '{{index .Config.Labels "…"}}'` lookup
# came back empty. Go templates print the literal `<no value>` for a missing
# map key, which is emphatically NOT a label value.
hu_label_missing() {
  local v="${1-}"
  [ -z "$v" ] || [ "$v" = "<no value>" ]
}

# stdin → stdout: rewrite the single `VAR=` assignment to `VAR=<value>`.
#
# Surgical by construction: every other byte of every other line is copied
# through, and the matched line keeps its own leading whitespace and its
# `export ` prefix if it had one — only the value changes.
#
# Exit 3 when the variable appears zero or MORE THAN ONCE. Refusing the
# multiple case is deliberate: dotenv resolution is last-wins, so rewriting the
# first of two would produce a file that looks right and resolves wrong.
hu_rewrite_env_stream() {
  local var="$1" value="$2"
  awk -v var="$var" -v value="$value" '
    BEGIN { re = "^[ \t]*(export[ \t]+)?" var "[ \t]*=" ; n = 0 ; total = 0 }
    {
      total = NR
      if ($0 ~ re) {
        n++
        match($0, re)
        lines[NR] = substr($0, RSTART, RLENGTH) value
      } else {
        lines[NR] = $0
      }
    }
    END {
      if (n != 1) exit 3
      for (i = 1; i <= total; i++) print lines[i]
    }
  '
}

# Minimal JSON string escaping: strip control characters, fold newlines/tabs to
# spaces, escape backslash and double quote. Enough for the message fields we
# emit, and it never needs jq (which is not guaranteed on a host).
hu_json_escape() {
  printf '%s' "${1-}" |
    tr -d '\000-\010\013\014\016-\037' |
    tr '\n\t\r' '   ' |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Given `id<TAB>/data-source` lines on stdin and a wanted source, print the id
# of the single container mounting it. Exit 1 on none, 2 on ambiguity — an
# ambiguous host is a refusal, never a coin flip.
hu_pick_container() {
  local wanted="$1"
  local id src found="" count=0
  while IFS=$'\t' read -r id src; do
    [ -n "$id" ] || continue
    [ "$src" = "$wanted" ] || continue
    found="$id"
    count=$((count + 1))
  done
  [ "$count" -eq 0 ] && return 1
  [ "$count" -gt 1 ] && return 2
  printf '%s\n' "$found"
  return 0
}

# An image reference we are willing to splice into an env file and hand to awk.
# Anything with a backslash, a quote, whitespace or a shell metacharacter is
# refused rather than escaped — the set of legal image references does not
# include them, so this can only ever reject an attack.
hu_valid_image_ref() {
  local ref="${1-}"
  [ -n "$ref" ] || return 1
  case "$ref" in
    *[!A-Za-z0-9._:/@-]*) return 1 ;;
  esac
  return 0
}

# A value we are willing to write back into an env file. Wider than an image
# reference — an operator may legitimately have quoted their value, and a
# rollback must restore their bytes, not our idea of them. Still refuses a
# backslash (awk's `-v` would interpret it as an escape) and anything with a
# newline or a control character.
hu_valid_env_value() {
  local v="${1-}"
  [ -n "$v" ] || return 1
  case "$v" in
    *\\*) return 1 ;;
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

# Digits only, defaulting when the caller passed something else. Keeps a bad
# `--verify-timeout` from silently disabling the floor via a `[` syntax error.
hu_positive_int() {
  local v="${1-}" fallback="$2"
  case "$v" in
    '' | *[!0-9]*) printf '%s\n' "$fallback" ;;
    *) printf '%s\n' "$v" ;;
  esac
}

# =============================================================================
# Run-directory IO — heartbeat, events, result.
# =============================================================================

RUN_DIR=""
RUN_ID=""
HEARTBEAT_PID=""
RESULT_WRITTEN=0
# The verdict of the last `hu_write_result` attempt, kept so the EXIT trap can
# retry THAT verdict rather than replace a real one with "unexpected_exit".
declare -a RESULT_LAST=()

hu_log() {
  printf '[host-update %s] %s\n' "$SCRIPT_VERSION" "$*" >&2
}

# One NDJSON progress record. $1 = phase, $2 = already-formatted extra fields
# (each starting with a comma) or empty.
hu_emit() {
  local phase="$1" extra="${2-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line
  line="{\"ts\":\"${ts}\",\"script_version\":\"${SCRIPT_VERSION}\",\"run_id\":\"${RUN_ID}\",\"phase\":\"${phase}\"${extra}}"
  printf '%s\n' "$line"
  if [ -n "$RUN_DIR" ]; then
    printf '%s\n' "$line" >>"${RUN_DIR}/events.ndjson" 2>/dev/null || true
  fi
}

hu_heartbeat_start() {
  [ -n "$RUN_DIR" ] || return 0
  # `</dev/null >/dev/null 2>&1` is not cosmetic: without it the subshell — and
  # the `sleep` it forks — inherit our stdout, and whoever is reading that pipe
  # stays blocked for one full interval after we exit. The server would see the
  # job "still running" for 5 s after it finished.
  (
    while :; do
      touch "${RUN_DIR}/heartbeat" 2>/dev/null || exit 0
      sleep "$HEARTBEAT_INTERVAL_S"
    done
  ) </dev/null >/dev/null 2>&1 &
  HEARTBEAT_PID=$!
}

hu_cleanup() {
  if [ -n "$HEARTBEAT_PID" ]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
  # A run that reached this trap without a verdict either died in a way none of
  # the branches below anticipated, or HAD a verdict whose write failed. In the
  # second case retry that verdict — replacing a real "refused" with
  # "unexpected_exit" would be a second lie on top of the first.
  if [ "$RESULT_WRITTEN" -eq 0 ] && [ -n "$RUN_DIR" ]; then
    if [ "${#RESULT_LAST[@]}" -gt 0 ]; then
      hu_log "retrying the result.json write that failed earlier"
      hu_write_result "${RESULT_LAST[@]}"
    else
      hu_write_result "failed" "$EXIT_FAILED" "unexpected_exit" \
        "The updater exited without recording a verdict." "skipped"
    fi
  fi
}

# result.json, written atomically (temp + rename in the same directory) and
# LAST. Its presence is what makes a run terminal for the server, so it must
# never be observable half-written.
#
# EVERY string field goes through `hu_json_escape`, not just the message: an
# env file path or an image reference containing a `"` would produce a document
# the reader parses as null, and a run whose result cannot be read is a run the
# server calls abandoned forever.
hu_write_result() {
  local state="$1" code="$2" reason="$3" message="$4" verify="${5-skipped}"
  [ -n "$RUN_DIR" ] || return 0
  RESULT_LAST=("$state" "$code" "$reason" "$message" "$verify")
  local tmp="${RUN_DIR}/.result.json.$$"
  local msg esc_state esc_reason esc_verify esc_cid esc_project esc_service
  local esc_env_file esc_b64 esc_target esc_previous
  msg="$(hu_json_escape "$message")"
  esc_state="$(hu_json_escape "$state")"
  esc_reason="$(hu_json_escape "$reason")"
  esc_verify="$(hu_json_escape "$verify")"
  esc_cid="$(hu_json_escape "${CONTAINER_ID-}")"
  esc_project="$(hu_json_escape "${PROJECT_NAME-}")"
  esc_service="$(hu_json_escape "${SERVICE_NAME-}")"
  esc_env_file="$(hu_json_escape "${ENV_FILE-}")"
  esc_b64="$(hu_json_escape "${ENV_LINE_BEFORE_B64-}")"
  esc_target="$(hu_json_escape "${TARGET_IMAGE-}")"
  esc_previous="$(hu_json_escape "${PREVIOUS_IMAGE-}")"
  {
    printf '{'
    printf '"script_version":"%s",' "$SCRIPT_VERSION"
    printf '"run_id":"%s",' "$(hu_json_escape "$RUN_ID")"
    printf '"state":"%s",' "$esc_state"
    printf '"exit_code":%s,' "$code"
    printf '"reason":"%s",' "$esc_reason"
    printf '"message":"%s",' "$msg"
    printf '"verify":"%s",' "$esc_verify"
    printf '"container_id":"%s",' "$esc_cid"
    printf '"project":"%s",' "$esc_project"
    printf '"service":"%s",' "$esc_service"
    printf '"env_file":"%s",' "$esc_env_file"
    printf '"env_line_before_b64":"%s",' "$esc_b64"
    printf '"target_image":"%s",' "$esc_target"
    printf '"previous_image":"%s",' "$esc_previous"
    printf '"env_written":%s,' "${ENV_WRITTEN:-false}"
    printf '"deployed":%s,' "${DEPLOYED:-false}"
    printf '"finished_at":"%s"' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '}\n'
  } >"$tmp" 2>/dev/null || {
    hu_log "result.json: could NOT be staged at ${tmp} — the run directory is not writable"
    rm -f "$tmp" 2>/dev/null || true
    return 1
  }
  # An unchecked `mv` here is how a run becomes invisible: the file the server
  # polls for is the ONLY thing that makes a run terminal, so a failed rename
  # must not be recorded as a write.
  local attempt
  for attempt in 1 2; do
    if mv -f "$tmp" "${RUN_DIR}/result.json" 2>/dev/null; then
      RESULT_WRITTEN=1
      return 0
    fi
    hu_log "result.json: rename into ${RUN_DIR} FAILED (attempt ${attempt})"
  done
  rm -f "$tmp" 2>/dev/null || true
  hu_log "result.json: giving up — the server will see this run as abandoned"
  return 1
}

# Terminal exits. `refuse` is the only one that promises nothing was touched.
hu_refuse() {
  local reason="$1" message="$2"
  hu_emit "refused" ",\"reason\":\"${reason}\",\"message\":\"$(hu_json_escape "$message")\""
  hu_log "REFUSED (${reason}): ${message}"
  hu_write_result "refused" "$EXIT_REFUSED" "$reason" "$message" "skipped"
  exit "$EXIT_REFUSED"
}

hu_fail() {
  local reason="$1" message="$2" verify="${3-skipped}"
  hu_emit "failed" ",\"reason\":\"${reason}\",\"message\":\"$(hu_json_escape "$message")\""
  hu_log "FAILED (${reason}): ${message}"
  hu_write_result "failed" "$EXIT_FAILED" "$reason" "$message" "$verify"
  exit "$EXIT_FAILED"
}

hu_succeed() {
  local reason="$1" message="$2" verify="$3"
  hu_emit "success" ",\"reason\":\"${reason}\",\"verify\":\"${verify}\",\"message\":\"$(hu_json_escape "$message")\""
  hu_log "SUCCESS (${reason}): ${message}"
  hu_write_result "success" "$EXIT_SUCCESS" "$reason" "$message" "$verify"
  exit "$EXIT_SUCCESS"
}

hu_rolled_back() {
  local reason="$1" message="$2" verify="${3-skipped}"
  hu_emit "rolled_back" ",\"reason\":\"${reason}\",\"message\":\"$(hu_json_escape "$message")\""
  hu_log "ROLLED BACK (${reason}): ${message}"
  hu_write_result "rolled_back" "$EXIT_ROLLED_BACK" "$reason" "$message" "$verify"
  exit "$EXIT_ROLLED_BACK"
}

# =============================================================================
# Env-file rewriting (file level).
# =============================================================================

# Locate the deployment's env file. `<working_dir>/.env`, then
# `<working_dir>/../.env`. NEVER guess further: writing to a file that merely
# happens to be named `.env` somewhere up the tree is how you edit an unrelated
# project's configuration.
hu_locate_env_file() {
  local wd="$1"
  local candidate
  for candidate in "${wd}/.env" "${wd}/../.env"; do
    if [ -f "$candidate" ]; then
      # Normalize `…/dir/../.env` so the value we persist and later restore is
      # the same string every time.
      (cd "$(dirname "$candidate")" 2>/dev/null && printf '%s/%s\n' "$(pwd)" "$(basename "$candidate")")
      return 0
    fi
  done
  return 1
}

# The current `VAR=` line, verbatim. Exit 1 when absent, 2 when duplicated.
hu_read_env_line() {
  local file="$1" var="$2"
  local matches
  matches="$(grep -c -E "^[[:space:]]*(export[[:space:]]+)?${var}[[:space:]]*=" "$file" 2>/dev/null || true)"
  [ "${matches:-0}" -eq 0 ] && return 1
  [ "${matches:-0}" -gt 1 ] && return 2
  grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${var}[[:space:]]*=" "$file"
  return 0
}

# Rewrite `VAR=` to `<value>` in place: `.bak` beside the file, temp + rename(2)
# in the SAME directory (so the rename is atomic), original trailing-newline
# state preserved. Returns 1 if anything went wrong WITHOUT having replaced the
# file — the caller can treat that as "nothing touched".
#
# $4 (`make_bak`, default 1) exists for ONE reason: the rollback and revert
# passes call this function too, and refreshing `.bak` there would replace the
# operator's original with the version we are backing out of — leaving them a
# "backup" of the broken state at the exact moment they need the good one.
hu_write_env_line() {
  local file="$1" var="$2" value="$3" make_bak="${4:-1}"
  local dir tmp
  hu_valid_env_value "$value" || return 1
  dir="$(dirname "$file")"
  tmp="${dir}/.$(basename "$file").swarm-os.$$"

  if ! hu_rewrite_env_stream "$var" "$value" <"$file" >"$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  # `awk` newline-terminates every record; if the original did not end with a
  # newline, put it back the way we found it.
  local tail_probe
  tail_probe="$(tail -c1 "$file" 2>/dev/null; printf 'X')"
  if [ -s "$file" ] && [ "$tail_probe" != "$(printf '\nX')" ]; then
    truncate -s -1 "$tmp" 2>/dev/null || true
  fi
  # `.bak` FIRST: if the rename below is the step that fails, the operator still
  # has an untouched copy beside their file.
  if [ "$make_bak" = "1" ]; then
    cp -p "$file" "${file}.bak" 2>/dev/null || true
  fi
  # Match the original's mode/owner as closely as we can before it becomes the
  # live file (cp -p on the temp would clobber our fresh content).
  chmod --reference="$file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file" || {
    rm -f "$tmp" 2>/dev/null || true
    return 1
  }
  return 0
}

# =============================================================================
# `restore-env` subcommand — used by the server's `abandoned` handler when a run
# died after writing the env line but before deploying. Kept in THIS script so
# the restore path is the same code (and the same version) as the write path.
# =============================================================================

hu_main_restore_env() {
  local env_file="" var="SWARM_OS_IMAGE" line_b64=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --env-file) env_file="${2-}"; shift 2 ;;
      --env-var) var="${2-}"; shift 2 ;;
      --line-b64) line_b64="${2-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$env_file" ] && [ -n "$line_b64" ] || {
    hu_log "restore-env: --env-file and --line-b64 are required"
    return "$EXIT_REFUSED"
  }
  [ -f "$env_file" ] && [ -w "$env_file" ] || {
    hu_log "restore-env: ${env_file} is missing or not writable"
    return "$EXIT_REFUSED"
  }
  local line
  line="$(printf '%s' "$line_b64" | base64 -d 2>/dev/null)" || {
    hu_log "restore-env: --line-b64 is not valid base64"
    return "$EXIT_REFUSED"
  }
  # The archived line is byte-exact and carries its own `VAR=` prefix, so we
  # restore the VALUE and let the rewriter re-derive the prefix from the file.
  local value="${line#*=}"
  if ! hu_valid_env_value "$value"; then
    hu_log "restore-env: archived value cannot be written back safely"
    return "$EXIT_REFUSED"
  fi
  # `0`: never refresh the `.bak` here either — it still holds the state the
  # operator started from, which is exactly what this call is putting back.
  if hu_write_env_line "$env_file" "$var" "$value" 0; then
    hu_log "restore-env: ${var} restored in ${env_file}"
    return 0
  fi
  hu_log "restore-env: rewrite failed"
  return "$EXIT_FAILED"
}

# =============================================================================
# `apply` subcommand.
# =============================================================================

CONTAINER_ID=""
PROJECT_NAME=""
SERVICE_NAME=""
WORKING_DIR=""
ENV_FILE=""
ENV_VAR="SWARM_OS_IMAGE"
ENV_LINE_BEFORE=""
ENV_LINE_BEFORE_B64=""
ENV_WRITTEN="false"
DEPLOYED="false"
TARGET_IMAGE=""
PREVIOUS_IMAGE=""
CONFIG_HASH_BEFORE=""
# The `--wait-timeout` handed to compose. A GLOBAL, because `hu_rollback` needs
# the operator's value too: a rollback that used the built-in default while the
# apply used the flag would wait a different time to bring back the image the
# host is actually going to run.
WAIT_TIMEOUT_S=300
# The `/data` source this run was told to update, and the mount point it lives
# at. Globals for the same reason: `hu_rollback` and the post-`up` re-check are
# not in the parser's scope.
HOST_DATA_DIR=""
DATA_MOUNT="/data"
declare -a CONFIG_FILES=()
declare -a COMPOSE_ARGS=()

# Resolve the deployment's `/data` bind source for one container id.
hu_data_source_of() {
  local cid="$1" mount="$2"
  timeout "$DOCKER_PROBE_TIMEOUT_S" docker inspect \
    --format "{{range .Mounts}}{{if eq .Destination \"${mount}\"}}{{.Source}}{{end}}{{end}}" \
    "$cid" 2>/dev/null
}

hu_label_of() {
  local cid="$1" label="$2"
  timeout "$DOCKER_PROBE_TIMEOUT_S" docker inspect \
    --format "{{index .Config.Labels \"${label}\"}}" "$cid" 2>/dev/null
}

# The resolved image of OUR service, straight from compose. `config --images
# <service>` is used rather than parsing `--format json`, because it needs no
# JSON parser on the host and answers exactly the question being asked.
hu_resolved_image() {
  timeout "$COMPOSE_CONFIG_TIMEOUT_S" docker "${COMPOSE_ARGS[@]}" config --images "$SERVICE_NAME" 2>/dev/null | head -n1
}

# sha256 of the RESOLVED compose config. Non-zero (and silent) when compose did
# not answer: piping a failed `config` straight into `sha256sum` yields the hash
# of the empty string, which compares equal to the next failure — so a rollback
# would "prove" its restore was exact by comparing one failure to another.
hu_config_hash() {
  local out
  out="$(timeout "$COMPOSE_CONFIG_TIMEOUT_S" docker "${COMPOSE_ARGS[@]}" config 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | sha256sum | cut -d' ' -f1
}

hu_service_container() {
  timeout "$DOCKER_PROBE_TIMEOUT_S" docker "${COMPOSE_ARGS[@]}" ps -q "$SERVICE_NAME" 2>/dev/null | head -n1
}

# Poll `/health` from INSIDE the container until `boot_complete` is true.
# Prints one of: boot_complete | healthy_no_boot_complete | unreachable.
hu_verify_boot() {
  local cid="$1" timeout_s="$2" port="$3"
  local deadline now out healthy=0
  deadline=$(( $(date +%s) + timeout_s ))
  while :; do
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    out="$(timeout 20 docker exec "$cid" curl -fsS -m 5 "http://127.0.0.1:${port}/health" 2>/dev/null)"
    if [ -n "$out" ]; then
      healthy=1
      case "$out" in
        *'"boot_complete":true'* | *'"boot_complete": true'*)
          printf 'boot_complete\n'
          return 0
          ;;
      esac
    else
      # The container id changes on every recreate, and compose can recreate
      # more than once; re-resolve rather than poll a corpse.
      local fresh
      fresh="$(hu_service_container)"
      if [ -n "$fresh" ] && [ "$fresh" != "$cid" ]; then
        cid="$fresh"
        CONTAINER_ID="$fresh"
      fi
    fi
    sleep "$VERIFY_POLL_INTERVAL_S"
  done
  if [ "$healthy" -eq 1 ]; then
    printf 'healthy_no_boot_complete\n'
    return 0
  fi
  printf 'unreachable\n'
  return 1
}

# Put the original line back and bring the previous image up again. Durable by
# construction: a later reboot re-reads the env file and gets the old tag.
hu_rollback() {
  local why="$1" verify="${2-skipped}"
  hu_emit "rolling_back" ",\"reason\":\"$(hu_json_escape "$why")\""

  if [ "$ENV_WRITTEN" != "true" ]; then
    hu_fail "$why" "Failed before the env file was modified; nothing to roll back." "$verify"
  fi

  local prev_value="${ENV_LINE_BEFORE#*=}"
  if ! hu_write_env_line "$ENV_FILE" "$ENV_VAR" "$prev_value" 0; then
    # Name the exact line rather than point at a file: this is the one moment
    # where the operator has to fix it by hand, and "look in the .bak" is not
    # an instruction they can act on without opening two files.
    hu_fail "rollback_env_write_failed" \
      "${why}; and restoring ${ENV_VAR} in ${ENV_FILE} FAILED. Put this line back by hand before the next reboot, or the host will come up on an image that was never verified: ${ENV_LINE_BEFORE}" "$verify"
  fi
  ENV_WRITTEN="false"
  hu_emit "env_restored" ",\"env_file\":\"$(hu_json_escape "$ENV_FILE")\""

  # The strongest available proof that the restore was exact: the resolved
  # config must hash to what it hashed before we touched anything. When compose
  # does not answer at all there IS no proof — say so rather than let two empty
  # strings compare equal.
  local hash_now
  if ! hash_now="$(hu_config_hash)"; then
    hu_emit "rollback_config_unverified" ",\"before\":\"${CONFIG_HASH_BEFORE}\""
  elif [ "$hash_now" != "$CONFIG_HASH_BEFORE" ]; then
    hu_emit "rollback_config_drift" ",\"before\":\"${CONFIG_HASH_BEFORE}\",\"after\":\"${hash_now}\""
  fi

  timeout "$(( WAIT_TIMEOUT_S + 120 ))" docker "${COMPOSE_ARGS[@]}" \
    up -d --no-deps --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT_S" -- "$SERVICE_NAME" \
    >>"${RUN_DIR}/compose.log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    hu_fail "rollback_up_failed" \
      "${why}; the env file was restored but \`compose up\` on the previous image exited ${rc}. The deployment needs manual attention." "$verify"
  fi
  DEPLOYED="true"
  hu_rolled_back "$why" "Rolled back to ${PREVIOUS_IMAGE}." "$verify"
}

hu_main_apply() {
  local host_data_dir="" data_mount="/data" container_hint="" health_port="8787"
  local verify_timeout="$DEFAULT_VERIFY_TIMEOUT_S" wait_timeout="$DEFAULT_WAIT_TIMEOUT_S"
  local pull_timeout="$DEFAULT_PULL_TIMEOUT_S" lock_file=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --run-dir) RUN_DIR="${2-}"; shift 2 ;;
      --run-id) RUN_ID="${2-}"; shift 2 ;;
      --host-data-dir) host_data_dir="${2-}"; shift 2 ;;
      --data-mount) data_mount="${2-}"; shift 2 ;;
      --container-hint) container_hint="${2-}"; shift 2 ;;
      --target) TARGET_IMAGE="${2-}"; shift 2 ;;
      --env-var) ENV_VAR="${2-}"; shift 2 ;;
      --health-port) health_port="${2-}"; shift 2 ;;
      --verify-timeout) verify_timeout="${2-}"; shift 2 ;;
      --wait-timeout) wait_timeout="${2-}"; shift 2 ;;
      --pull-timeout) pull_timeout="${2-}"; shift 2 ;;
      --lock) lock_file="${2-}"; shift 2 ;;
      # Accepted and ignored: the lock is taken with `flock -n`, which never
      # waits. Kept so an older caller's argv does not become "unknown".
      --lock-wait) shift 2 ;;
      --test-timing)
        hu_set_test_timing "${2-}" || hu_log "ignoring malformed --test-timing '${2-}'"
        shift 2 ;;
      *) hu_log "ignoring unknown argument: $1"; shift ;;
    esac
  done

  if [ -z "$RUN_DIR" ] || [ -z "$host_data_dir" ] || [ -z "$TARGET_IMAGE" ]; then
    hu_log "usage: host-update.sh apply --run-dir DIR --host-data-dir DIR --target IMAGE [...]"
    exit "$EXIT_REFUSED"
  fi
  [ -n "$RUN_ID" ] || RUN_ID="$(basename "$RUN_DIR")"
  mkdir -p "$RUN_DIR" 2>/dev/null || {
    hu_log "cannot create run dir ${RUN_DIR}"
    exit "$EXIT_REFUSED"
  }
  # The floor is not advisory: a shorter window declares a good, slowly-resuming
  # update failed and kills every team a second time.
  verify_timeout="$(hu_positive_int "$verify_timeout" "$DEFAULT_VERIFY_TIMEOUT_S")"
  wait_timeout="$(hu_positive_int "$wait_timeout" "$DEFAULT_WAIT_TIMEOUT_S")"
  pull_timeout="$(hu_positive_int "$pull_timeout" "$DEFAULT_PULL_TIMEOUT_S")"
  health_port="$(hu_positive_int "$health_port" 8787)"
  if [ "$verify_timeout" -lt "$VERIFY_TIMEOUT_FLOOR_S" ]; then
    verify_timeout="$VERIFY_TIMEOUT_FLOOR_S"
  fi
  # `--wait-timeout 0` means "do not wait" to `[ -gt ]` and "wait forever" to
  # nobody: compose would be handed a zero and `timeout 120` would bound the
  # whole `up`. One second is the smallest honest value.
  [ "$wait_timeout" -ge 1 ] || wait_timeout=1
  [ "$pull_timeout" -ge 1 ] || pull_timeout=1
  WAIT_TIMEOUT_S="$wait_timeout"
  HOST_DATA_DIR="$host_data_dir"
  DATA_MOUNT="$data_mount"
  [ -n "$lock_file" ] || lock_file="${host_data_dir}/updater/update.lock"

  trap hu_cleanup EXIT
  hu_heartbeat_start
  hu_emit "started" ",\"target\":\"$(hu_json_escape "$TARGET_IMAGE")\",\"host_data_dir\":\"$(hu_json_escape "$host_data_dir")\""

  # ── 1. One updater at a time. `-n`: decline, never queue. ─────────────────
  # A `-w` that eventually wins the lock does not decline the second update, it
  # postpones it — and then applies it, recreating the deployment a second time
  # on top of whatever the first updater just finished writing.
  mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true
  exec 9>"$lock_file" || hu_refuse "lock_unavailable" "Cannot open the updater lock at ${lock_file}."
  if ! flock -n 9; then
    hu_refuse "already_running" "Another swarm-os update is already running on this host (lock ${lock_file})."
  fi

  # ── 2. Identify our own container, by its /data mount. ─────────────────────
  hu_emit "identifying"
  if ! hu_valid_image_ref "$TARGET_IMAGE"; then
    hu_refuse "invalid_target" "Target image reference '${TARGET_IMAGE}' contains characters no image reference may contain."
  fi
  case "$TARGET_IMAGE" in
    *@sha256:*) hu_refuse "target_pinned_by_digest" "Target '${TARGET_IMAGE}' is pinned by digest; this updater rewrites a TAG and would make the reference disagree with itself." ;;
  esac

  if [ -n "$container_hint" ]; then
    local hint_src
    hint_src="$(hu_data_source_of "$container_hint" "$data_mount")"
    if [ "$hint_src" = "$host_data_dir" ]; then
      CONTAINER_ID="$container_hint"
    else
      hu_emit "hint_rejected" ",\"hint\":\"$(hu_json_escape "$container_hint")\",\"mount\":\"$(hu_json_escape "${hint_src}")\""
    fi
  fi
  if [ -z "$CONTAINER_ID" ]; then
    local scan="" scan_ids rc_pick
    scan_ids="$(timeout "$DOCKER_PROBE_TIMEOUT_S" docker ps -q 2>/dev/null)"
    if [ -n "$scan_ids" ]; then
      # ONE `docker inspect` for every candidate, under ONE `timeout`. The
      # per-container loop this replaces had no aggregate bound: forty
      # containers on a wedged dockerd was forty × 30 s of "identifying".
      # The ids come from `docker ps -q` — hex, one per line — so the unquoted
      # expansion below can only ever split on whitespace.
      # shellcheck disable=SC2086
      scan="$(timeout "$DOCKER_SCAN_TIMEOUT_S" docker inspect \
        --format "{{.Id}}"$'\t'"{{range .Mounts}}{{if eq .Destination \"${data_mount}\"}}{{.Source}}{{end}}{{end}}" \
        $scan_ids 2>/dev/null)"
    fi
    CONTAINER_ID="$(printf '%s\n' "$scan" | hu_pick_container "$host_data_dir")"
    rc_pick=$?
    # Order matters: `hu_pick_container` prints NOTHING when it returns 2, so a
    # `-z "$CONTAINER_ID"` test first would report the one host where two
    # deployments collide as "no container matches" — the exact opposite of the
    # truth, on the exact host where the truth matters most.
    if [ "$rc_pick" -eq 2 ]; then
      hu_refuse "container_ambiguous" "More than one running container mounts ${host_data_dir} at ${data_mount}; refusing to pick one."
    fi
    if [ "$rc_pick" -ne 0 ] || [ -z "$CONTAINER_ID" ]; then
      hu_refuse "container_not_found" "No running container mounts ${host_data_dir} at ${data_mount}; refusing to guess which deployment to update."
    fi
  fi

  # ── 3. Compose labels. No labels ⇒ refuse (rebuilding the argv is lossy). ──
  PROJECT_NAME="$(hu_label_of "$CONTAINER_ID" 'com.docker.compose.project')"
  SERVICE_NAME="$(hu_label_of "$CONTAINER_ID" 'com.docker.compose.service')"
  WORKING_DIR="$(hu_label_of "$CONTAINER_ID" 'com.docker.compose.project.working_dir')"
  local config_files_raw
  config_files_raw="$(hu_label_of "$CONTAINER_ID" 'com.docker.compose.project.config_files')"

  if hu_label_missing "$PROJECT_NAME" || hu_label_missing "$SERVICE_NAME" ||
    hu_label_missing "$WORKING_DIR" || hu_label_missing "$config_files_raw"; then
    # An unreachable (or wedged) dockerd answers EVERY inspect with an empty
    # string, which is byte-identical to "this container has no compose labels".
    # Ask one question whose answer we already know before telling the operator
    # their deployment was started with `docker run`.
    local probe_id
    probe_id="$(timeout "$DOCKER_PROBE_TIMEOUT_S" docker inspect --format '{{.Id}}' "$CONTAINER_ID" 2>/dev/null)"
    if [ -z "$probe_id" ]; then
      hu_refuse "docker_unreachable" \
        "\`docker inspect ${CONTAINER_ID}\` returned nothing — the docker daemon did not answer (or the container is already gone). Refusing: an unreachable daemon looks exactly like a container with no compose labels, and the two need opposite responses."
    fi
    hu_refuse "not_compose_managed" \
      "Container ${CONTAINER_ID} carries no docker-compose labels — it was started with plain \`docker run\`. Reconstructing the argv from \`docker inspect\` is lossy, so this updater refuses rather than silently degrade the deployment."
  fi

  mapfile -t CONFIG_FILES < <(hu_parse_config_files "$config_files_raw" "$WORKING_DIR")
  if [ "${#CONFIG_FILES[@]}" -eq 0 ]; then
    hu_refuse "no_config_files" "The compose config_files label is present but empty."
  fi
  local f
  for f in "${CONFIG_FILES[@]}"; do
    [ -f "$f" ] || hu_refuse "config_file_missing" "Compose file ${f} (from the container's own label) does not exist on this host."
  done

  # ── 4. The env file. Located, never guessed. ──────────────────────────────
  ENV_FILE="$(hu_locate_env_file "$WORKING_DIR")" || ENV_FILE=""
  if [ -z "$ENV_FILE" ]; then
    hu_refuse "env_file_not_found" \
      "No .env beside the compose project (looked in ${WORKING_DIR}/.env and ${WORKING_DIR}/../.env). Self-update rewrites ${ENV_VAR} in that file and will not guess which other file to edit."
  fi
  if [ ! -w "$ENV_FILE" ]; then
    hu_refuse "env_file_not_writable" "${ENV_FILE} is not writable by $(id -un)."
  fi

  local read_rc
  ENV_LINE_BEFORE="$(hu_read_env_line "$ENV_FILE" "$ENV_VAR")"
  read_rc=$?
  if [ "$read_rc" -eq 1 ]; then
    hu_refuse "env_var_absent" \
      "${ENV_VAR} is not set in ${ENV_FILE}. A compose \`image: \${${ENV_VAR}:-…}\` with no variable behind it silently resolves to its fallback, so eligibility requires the variable to be genuinely present."
  fi
  if [ "$read_rc" -eq 2 ]; then
    hu_refuse "env_var_duplicated" \
      "${ENV_VAR} is assigned more than once in ${ENV_FILE}; dotenv resolution is last-wins and rewriting one of them would produce a file that reads right and resolves wrong."
  fi
  ENV_LINE_BEFORE_B64="$(printf '%s' "$ENV_LINE_BEFORE" | base64 -w0 2>/dev/null || printf '%s' "$ENV_LINE_BEFORE" | base64 | tr -d '\n')"
  # Checked HERE, before anything is pulled or written: if we could not write
  # the operator's own value back, we must never take it away in the first place.
  if ! hu_valid_env_value "${ENV_LINE_BEFORE#*=}"; then
    hu_refuse "env_value_unsupported" \
      "The current ${ENV_VAR} value in ${ENV_FILE} contains a backslash or a control character, so a byte-exact rollback could not be guaranteed. Refusing before touching anything."
  fi

  mapfile -t COMPOSE_ARGS < <(hu_compose_args "$PROJECT_NAME" "$ENV_FILE" "${CONFIG_FILES[@]}")

  # ── 5. Preflight. Everything below this line still touches nothing. ───────
  hu_emit "preflight" ",\"project\":\"$(hu_json_escape "$PROJECT_NAME")\",\"service\":\"$(hu_json_escape "$SERVICE_NAME")\",\"env_file\":\"$(hu_json_escape "$ENV_FILE")\",\"env_line_before_b64\":\"${ENV_LINE_BEFORE_B64}\""

  PREVIOUS_IMAGE="$(hu_resolved_image)"
  if [ -z "$PREVIOUS_IMAGE" ]; then
    hu_refuse "compose_config_failed" "\`docker compose config\` did not resolve for project ${PROJECT_NAME}; the deployment's own files do not currently produce a valid configuration."
  fi
  case "$PREVIOUS_IMAGE" in
    *@sha256:*) hu_refuse "image_pinned_by_digest" "The deployment resolves to ${PREVIOUS_IMAGE}, pinned by digest. Rewriting a tag variable would not change what runs." ;;
  esac
  if [ "$PREVIOUS_IMAGE" = "$TARGET_IMAGE" ]; then
    hu_refuse "already_at_target" "The deployment already resolves to ${TARGET_IMAGE}."
  fi

  # The /data source must be EXACTLY the one we were told to update: a new
  # container pointed at a different directory boots on an empty database.
  local mount_src
  mount_src="$(hu_data_source_of "$CONTAINER_ID" "$data_mount")"
  if [ "$mount_src" != "$host_data_dir" ]; then
    hu_refuse "data_dir_mismatch" "Container ${CONTAINER_ID} mounts '${mount_src}' at ${data_mount}, not ${host_data_dir}."
  fi

  # The rollback's proof that its restore was exact is a comparison against this
  # hash. Without it there is no proof — so refuse now, while nothing has been
  # touched, rather than discover it while putting the file back.
  if ! CONFIG_HASH_BEFORE="$(hu_config_hash)" || [ -z "$CONFIG_HASH_BEFORE" ]; then
    CONFIG_HASH_BEFORE=""
    hu_refuse "config_hash_failed" \
      "\`docker compose config\` produced nothing to hash for project ${PROJECT_NAME}. That hash is the only proof a rollback has that it restored the configuration exactly, so this run refuses before touching anything."
  fi
  hu_emit "preflight_ok" ",\"previous_image\":\"$(hu_json_escape "$PREVIOUS_IMAGE")\",\"config_sha256\":\"${CONFIG_HASH_BEFORE}\",\"compose_files\":${#CONFIG_FILES[@]}"

  # ── 6. Pull. Still nothing touched — a pull failure is a REFUSAL. ─────────
  hu_emit "pulling" ",\"image\":\"$(hu_json_escape "$TARGET_IMAGE")\""
  if ! timeout "$pull_timeout" docker pull "$TARGET_IMAGE" >>"${RUN_DIR}/docker.log" 2>&1; then
    hu_refuse "pull_failed" \
      "\`docker pull ${TARGET_IMAGE}\` failed. Either the tag does not exist or this host has no valid \`docker login\` for its registry — see docker.log in the run directory."
  fi

  # ── 7. The one write. Atomic, surgical, .bak beside it. ──────────────────
  hu_emit "writing_env" ",\"env_file\":\"$(hu_json_escape "$ENV_FILE")\""
  if ! hu_write_env_line "$ENV_FILE" "$ENV_VAR" "$TARGET_IMAGE"; then
    hu_refuse "env_write_failed" "Could not rewrite ${ENV_VAR} in ${ENV_FILE}; the file was left exactly as it was."
  fi
  ENV_WRITTEN="true"
  hu_emit "env_written" ",\"env_file\":\"$(hu_json_escape "$ENV_FILE")\",\"env_line_before_b64\":\"${ENV_LINE_BEFORE_B64}\""

  # ── 8. Assert the resolved image IS the target, byte for byte. ───────────
  local resolved
  resolved="$(hu_resolved_image)"
  if [ "$resolved" != "$TARGET_IMAGE" ]; then
    hu_emit "resolve_mismatch" ",\"resolved\":\"$(hu_json_escape "${resolved}")\""
    # Nothing has been deployed yet, so put the file back and refuse: this is
    # the `${VAR:-fallback}` trap, and deploying now would install the fallback.
    #
    # The revert's exit status is the whole point. `refused` is the ONE verdict
    # that promises nothing was touched, and the server's recovery path only
    # ever fires on a MISSING result.json — so a discarded failure here leaves
    # the operator's env file pointing at an unverified image with a verdict
    # that says otherwise, and nothing downstream that will ever repair it.
    local prev_value="${ENV_LINE_BEFORE#*=}"
    if hu_write_env_line "$ENV_FILE" "$ENV_VAR" "$prev_value" 0; then
      ENV_WRITTEN="false"
      hu_emit "env_restored" ",\"env_file\":\"$(hu_json_escape "$ENV_FILE")\""
      hu_refuse "resolve_mismatch" \
        "After writing ${ENV_VAR}=${TARGET_IMAGE}, compose still resolves the image to '${resolved}'. The compose file does not interpolate ${ENV_VAR} into \`image:\` (or overrides it), so the env file is not the lever for this deployment. Reverted."
    fi
    ENV_WRITTEN="true"
    hu_fail "revert_failed" \
      "After writing ${ENV_VAR}=${TARGET_IMAGE}, compose still resolves the image to '${resolved}' — and putting the original line back FAILED. ${ENV_FILE} still reads ${ENV_VAR}=${TARGET_IMAGE}, which is NOT what will run; the untouched original is in ${ENV_FILE}.bak, and this line is the one to restore by hand before the next reboot: ${ENV_LINE_BEFORE}"
  fi

  # ── 9. Deploy. No --remove-orphans, no --pull always, our service only. ──
  hu_emit "applying" ",\"target\":\"$(hu_json_escape "$TARGET_IMAGE")\""
  timeout "$(( WAIT_TIMEOUT_S + 120 ))" docker "${COMPOSE_ARGS[@]}" \
    up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT_S" -- "$SERVICE_NAME" \
    >>"${RUN_DIR}/compose.log" 2>&1
  local up_rc=$?
  if [ "$up_rc" -ne 0 ]; then
    hu_rollback "compose_up_failed" "unreachable"
  fi
  DEPLOYED="true"
  hu_emit "deployed"

  # ── 10. Verify. ≥300 s, and "healthy but not boot_complete" is NOT a
  #        rollback trigger — it is a human's call.
  local cid verdict
  cid="$(hu_service_container)"
  if [ -z "$cid" ]; then
    hu_rollback "container_missing_after_up" "unreachable"
  fi
  CONTAINER_ID="$cid"

  # The mount was checked on the OLD container, before the recreate. It has to
  # be checked again on the NEW one: a compose file whose bind source changed
  # between the two produces a container that starts, answers /health and
  # reports boot_complete — on an EMPTY database. That is a success verdict for
  # a deployment that has lost every team, so it is a rollback, not a warning.
  local new_mount_src
  new_mount_src="$(hu_data_source_of "$cid" "$DATA_MOUNT")"
  if [ "$new_mount_src" != "$HOST_DATA_DIR" ]; then
    hu_emit "data_dir_moved" ",\"container_id\":\"${cid}\",\"mount\":\"$(hu_json_escape "${new_mount_src}")\",\"expected\":\"$(hu_json_escape "$HOST_DATA_DIR")\""
    hu_rollback "data_dir_moved_after_up" "skipped"
  fi

  hu_emit "verifying" ",\"container_id\":\"${cid}\",\"timeout_s\":${verify_timeout}"
  verdict="$(hu_verify_boot "$cid" "$verify_timeout" "$health_port")"
  # `hu_verify_boot` ran in a command substitution, so any container id it
  # re-resolved died with that subshell. Re-read it here so `result.json` names
  # the container that is actually running.
  cid="$(hu_service_container)"
  [ -n "$cid" ] && CONTAINER_ID="$cid"
  case "$verdict" in
    boot_complete)
      hu_succeed "verified" "Updated to ${TARGET_IMAGE}; the new container reported boot_complete." "$verdict"
      ;;
    healthy_no_boot_complete)
      hu_succeed "needs_review" \
        "Updated to ${TARGET_IMAGE}. /health answered but never reported boot_complete within ${verify_timeout}s — the container is serving, its boot may still be resuming teams. Left in place for manual review; an automatic rollback here would kill the teams a second time." \
        "$verdict"
      ;;
    *)
      hu_rollback "health_unreachable" "$verdict"
      ;;
  esac
}

# =============================================================================
# Dispatch.
# =============================================================================

# Library mode: define everything, do nothing. This is what the unit tests
# source.
if [ "${SWARM_OS_HOST_UPDATE_LIB:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

case "${1-}" in
  apply)
    shift
    hu_main_apply "$@"
    ;;
  restore-env)
    shift
    hu_main_restore_env "$@"
    exit $?
    ;;
  version | --version)
    printf '%s\n' "$SCRIPT_VERSION"
    exit 0
    ;;
  *)
    hu_log "usage: host-update.sh {apply|restore-env|version} [options]"
    exit "$EXIT_REFUSED"
    ;;
esac
