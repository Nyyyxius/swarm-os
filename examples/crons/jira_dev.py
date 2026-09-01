#!/usr/bin/env python3
"""Wake a swarm-os agent when Jira has tickets waiting to be developed.

A complete, runnable example of the swarm-os *script cron* contract
(docs/crons-agents.md §2.5). Point a cron at it with `action = script` and
`interpreter = python3`; every tick, the server runs this file and reads the
decision off its output.

THE CONTRACT
------------
Environment provided by the runner (nothing else — no server token, no
provider key; the env is an explicit allowlist):

  SWARM_OS_CRON_ID    id of the cron being fired      (e.g. cron_3f9a1c04)
  SWARM_OS_CRON_NAME  its unique display slug         (e.g. jira-dev)
  SWARM_OS_FIRE       fire time, ISO-8601 UTC         (e.g. 2026-08-31T09:00:00.000Z)
  HOME, PATH, LANG/LC_ALL=C.UTF-8, TZ=<server schedule timezone>,
  UV_CACHE_DIR, and HTTP(S)_PROXY / NO_PROXY when the deployment sets them.

Output read by the runner:

  * the LAST non-empty line of stdout must be JSON —
      {"wake": true, "message": "..."}   deliver `message` to the lead of every
                                         live instance of the cron's role
      {"wake": false}                    nothing to do, no agent is disturbed
  * anything else on stdout is ignored, so keep progress logs on STDERR;
  * a non-zero exit, an unparseable last line or a timeout is recorded as an
    `error` run (visible in LAST RUNS) and wakes nobody.

Exit codes used here: 0 = decision printed, 2 = configuration problem,
1 = Jira/network failure. Both non-zero paths print a human-readable reason
on stderr, which is what the LAST RUNS excerpt shows.

CONFIGURATION
-------------
Credentials are NEVER hard-coded and never passed through the environment.
They are read from a JSON file, by default:

    /data/crons/jira_dev.json          (override with JIRA_DEV_CONFIG)

`/data` is the recommendation rather than `/workspace`: agents can write
`/workspace`, so a script and its secrets living there can be rewritten by the
very agents the cron wakes. See examples/crons/README.md.

    {
      "baseUrl":  "https://acme.atlassian.net",
      "email":    "you@acme.com",
      "apiToken": "<Atlassian API token>",
      "project":  "DEV",
      "status":   "À développer",
      "maxResults": 20,
      "timeoutSeconds": 20,
      "searchPath": "/rest/api/3/search/jql"
    }

`jql` may replace `project` + `status` for anything more elaborate.
`searchPath` is the escape hatch for Jira Server / Data Center, whose search
endpoint is `/rest/api/2/search`.

Standard library only, on purpose: the base script must run under the bare
`python3` of the image. The README shows the `uv run --with requests` variant
for anyone who would rather use a client library.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import NoReturn

DEFAULT_CONFIG_PATH = "/data/crons/jira_dev.json"
DEFAULT_SEARCH_PATH = "/rest/api/3/search/jql"
DEFAULT_MAX_RESULTS = 20
DEFAULT_TIMEOUT_SECONDS = 20
# How many keys the wake message names before it trails off. The message lands
# in an agent's inbox: a wall of 200 keys is not more actionable than eight.
KEYS_IN_MESSAGE = 8


def log(message: str) -> None:
    """Progress goes to stderr — stdout carries the decision and nothing else."""
    print(message, file=sys.stderr, flush=True)


def die(message: str, code: int) -> NoReturn:
    """Fail loudly. The runner stores this text in the run excerpt."""
    print(f"jira_dev: {message}", file=sys.stderr, flush=True)
    raise SystemExit(code)


def load_config() -> dict:
    """Read and validate the JSON config file. Exits 2 on any problem."""
    path = os.environ.get("JIRA_DEV_CONFIG") or DEFAULT_CONFIG_PATH
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        die(
            f"config file not found: {path}\n"
            f"  create it (see examples/crons/README.md) or point JIRA_DEV_CONFIG "
            f"at another path INSIDE the container.",
            2,
        )
    except PermissionError:
        die(f"config file not readable: {path}", 2)
    except json.JSONDecodeError as err:
        die(f"config file is not valid JSON: {path} ({err})", 2)

    if not isinstance(raw, dict):
        die(f"config file must contain a JSON object: {path}", 2)

    missing = [k for k in ("baseUrl", "email", "apiToken") if not raw.get(k)]
    if missing:
        die(f"config file {path} is missing required key(s): {', '.join(missing)}", 2)

    if not raw.get("jql") and not raw.get("project"):
        die(
            f"config file {path} must carry either a `jql` string or a `project` "
            f"(optionally with `status`).",
            2,
        )

    raw["_path"] = path
    return raw


def build_jql(config: dict) -> str:
    """Explicit `jql` wins; otherwise build one from `project` + `status`."""
    jql = config.get("jql")
    if jql:
        return str(jql)
    project = str(config["project"])
    status = str(config.get("status") or "À développer")
    # Values are quoted, not interpolated bare: a project key is tame but a
    # status label like "À développer" contains a space and would not parse.
    return (
        f'project = "{escape_jql(project)}" '
        f'AND status = "{escape_jql(status)}" '
        f"ORDER BY created ASC"
    )


def escape_jql(value: str) -> str:
    """Escape the two characters that can break out of a JQL quoted string."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def search(config: dict, jql: str) -> list[dict]:
    """Run the JQL search. Returns the raw `issues` array. Exits 1 on failure."""
    base = str(config["baseUrl"]).rstrip("/")
    path = str(config.get("searchPath") or DEFAULT_SEARCH_PATH)
    max_results = int(config.get("maxResults") or DEFAULT_MAX_RESULTS)
    timeout = float(config.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS)

    query = urllib.parse.urlencode(
        {"jql": jql, "maxResults": max_results, "fields": "summary,status"}
    )
    url = f"{base}{path}?{query}"

    token = base64.b64encode(
        f"{config['email']}:{config['apiToken']}".encode("utf-8")
    ).decode("ascii")
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "User-Agent": "swarm-os-cron/jira_dev",
        },
    )

    log(f"GET {base}{path} (maxResults={max_results}, timeout={timeout:g}s)")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        # Read the body: Jira puts the actual reason in `errorMessages`, and a
        # bare "HTTP Error 400" sends an operator hunting for nothing.
        try:
            body = err.read().decode("utf-8", "replace")[:500]
        except Exception:  # noqa: BLE001 - best effort on an already-failed call
            body = "<unreadable body>"
        hint = ""
        if err.code in (401, 403):
            hint = " — check `email` + `apiToken` in the config file"
        elif err.code == 404:
            hint = " — check `baseUrl` and `searchPath` (Jira Server uses /rest/api/2/search)"
        elif err.code == 400:
            hint = " — the JQL was rejected"
        die(f"Jira answered HTTP {err.code}{hint}: {body}", 1)
    except urllib.error.URLError as err:
        die(f"cannot reach Jira at {base}: {err.reason}", 1)
    except TimeoutError:
        die(f"Jira did not answer within {timeout:g}s", 1)
    except json.JSONDecodeError as err:
        die(f"Jira returned a non-JSON body: {err}", 1)

    issues = payload.get("issues")
    if not isinstance(issues, list):
        die("Jira response carries no `issues` array — wrong endpoint?", 1)
    return issues


def build_message(issues: list[dict]) -> str:
    """The French one-liner delivered into the lead's inbox."""
    keys = [str(issue.get("key") or "?") for issue in issues]
    shown = ", ".join(keys[:KEYS_IN_MESSAGE])
    if len(keys) > KEYS_IN_MESSAGE:
        shown += f", … (+{len(keys) - KEYS_IN_MESSAGE})"
    plural = "s" if len(keys) > 1 else ""
    return f"{len(keys)} ticket{plural} à développer: {shown}"


def main() -> int:
    # These are informational here, but printing them makes every run in LAST
    # RUNS self-describing — and shows what the script actually receives.
    cron_id = os.environ.get("SWARM_OS_CRON_ID", "?")
    cron_name = os.environ.get("SWARM_OS_CRON_NAME", "jira-dev")
    fired_at = os.environ.get("SWARM_OS_FIRE", "?")
    log(f"cron={cron_name} ({cron_id}) fired_at={fired_at}")

    config = load_config()
    log(f"config={config['_path']}")

    jql = build_jql(config)
    log(f"jql={jql}")

    issues = search(config, jql)
    log(f"{len(issues)} issue(s) matched")

    # THE decision line: last non-empty line of stdout, and the only thing the
    # runner parses. `separators` keeps it compact; `ensure_ascii=False` keeps
    # accented ticket titles readable in the inbox (LC_ALL=C.UTF-8 is set).
    if issues:
        decision = {"wake": True, "message": build_message(issues)}
    else:
        decision = {"wake": False}
    print(json.dumps(decision, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
