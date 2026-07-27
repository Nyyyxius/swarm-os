# Spike gemini — contrat CLI pour swarm-os

_Généré par `scripts/verify-gemini.ts` le 2026-07-26T19:47:51.726Z._

**Commande :** `pnpm verify:gemini` (alias de `pnpm --filter server exec tsx ../../scripts/verify-gemini.ts`).

**Environnement :**
- gemini CLI présent : oui (`/usr/bin/gemini`)
- version gemini : 0.35.2
- node : v22.22.2
- plateforme : linux
- `GEMINI_CLI_HOME` jetable : `/tmp/swarm-os-spike/gemini/home` (supprimé en fin de run)
- `~/.gemini` de l'opérateur : **inchangé** (taille+mtime identiques avant/après)

**Auth :** mode `gemini-api-key` · round-trip modèle **INDISPONIBLE**. Copied the operator OAuth credentials into the disposable home (never symlinked). Model round-trip FAILED (exit 1, AUTH failure — every model-dependent assertion below is therefore about the CLI surface, not about the flag/file under test): Keychain initialization encountered an error: libsecret-1.so.0: cannot open shared object file: No such file or directory | Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google |     at throwIneligibleOrProjectIdError (file:///usr/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/setu
…[truncated 12 chars] Falling back to a placeholder GEMINI_API_KEY so the TUI settles at the prompt (structural checks stay valid; model-dependent assertions are reported UNVERIFIED).

**Résumé :** CONFIRMED=5 · PARTIAL=3 · REFUTED=0 · UNVERIFIED=0 · total=176355ms

| check | statut | preuve |
|-------|--------|--------|
| C1 — GEMINI_CLI_HOME isolates the config (runtime availability probe) | CONFIRMED | `GEMINI_CLI_HOME=/tmp/swarm-os-spike/gemini/home gemini mcp list` |
| C2 — Per-session MCP over streamable HTTP (BLOCKING) | PARTIAL | `settings.json → mcpServers.swarm-probe = { httpUrl: "http://127.0.0.1:35669/mcp/orch-spike/sess-secret-9f3a", headers: {…}, trust: true, timeout: 10000 } ; gemi` |
| C3 — Durable preamble: $GEMINI_CLI_HOME/.gemini/GEMINI.md survives /clear and /compact | PARTIAL | `echo canary > /tmp/swarm-os-spike/gemini/home/.gemini/GEMINI.md ; PTY: /memory show → /clear → /memory show → /compact → /memory show` |
| C4 — trustedFolders.json suppresses the folder-trust dialog | CONFIRMED | `PTY gemini in /tmp/swarm-os-spike/gemini/trust-probe-a-1785095170535 (no trust file) vs /tmp/swarm-os-spike/gemini/trust-probe-b-1785095170535 (trustedFolders.j` |
| C5 — swarm-os's Notification hook command, unchanged, under gemini | PARTIAL | `settings.json → hooks.{SessionStart,BeforeAgent,AfterAgent,Notification}[].hooks[] = { type:"command", command: <swarm-os shell command verbatim> } ; PTY sessio` |
| C6 — /clear resets the conversation, /compact is an alias of /compress | CONFIRMED | `PTY: type "/clear" + \r ; type "/compact" + \r` |
| C7 — PTY injection: two-step Ink submit dance vs single write | CONFIRMED | `(a) pty.write("CANARY_TWO_STEP_MESSAGE") ; sleep 150ms ; pty.write("\r")   \|   (b) pty.write("CANARY_SINGLE_WRITE_MESSAGE\r")` |
| C8 — PTY goes silent when idle (BLOCKING) | CONFIRMED | `PTY gemini --approval-mode yolo ; settle 10000ms ; measure PTY output for 10000ms` |

---
## C1 — GEMINI_CLI_HOME isolates the config (runtime availability probe)

Status: CONFIRMED

Command: `GEMINI_CLI_HOME=/tmp/swarm-os-spike/gemini/home gemini mcp list`

Exit: 0  ·  Duration: 5503ms

Output:
```
stdout:
(empty)

stderr:
Configured MCP servers:

✗ swarm-probe: http://127.0.0.1:1/mcp (http) - Disconnected

```


Notes: `GEMINI_CLI_HOME` re-routes the whole config root: gemini read `/tmp/swarm-os-spike/gemini/home/.gemini/settings.json` and reported the `swarm-probe` server declared there (found), exit=0. It also created its own state under the disposable home (google_accounts.json, history, installation_id, oauth_creds.json, projects.json, settings.json, tmp), which proves the redirection is total and not just for settings. Timing: cold 2628ms, warm 2875ms. **Gotcha:** when stdout is not a TTY, `gemini mcp list` prints the listing on **stderr**, not stdout (verified: `gemini mcp list 2>/dev/null` prints nothing, `gemini mcp list 1>/dev/null` prints the list). The probe must therefore merge both streams. **This is the availability probe for the adapter**: non-interactive, no model call, exit 0, the merged output must contain the probe server name. Use an unreachable `httpUrl` (`http://127.0.0.1:1/mcp`) so the connection attempt fails instantly instead of hanging. If a future gemini stops honouring GEMINI_CLI_HOME, this command stops printing `swarm-probe` and the adapter must refuse to spawn (every session would otherwise share one config = one MCP URL = every agent authenticating as the last writer). Note: the probe inherits the auth mode from the settings file — with `selectedType: "gemini-api-key"` and no `GEMINI_API_KEY` in the env it exits 41 before listing, so the probe env must carry the same credentials as the session.

## C2 — Per-session MCP over streamable HTTP (BLOCKING)

Status: PARTIAL

Command: `settings.json → mcpServers.swarm-probe = { httpUrl: "http://127.0.0.1:35669/mcp/orch-spike/sess-secret-9f3a", headers: {…}, trust: true, timeout: 10000 } ; gemini mcp list ; PTY session + /mcp list`

Exit: 0  ·  Duration: 23513ms

Output:
```
$ gemini mcp list
Configured MCP servers:

✓ swarm-probe: http://127.0.0.1:35669/mcp/orch-spike/sess-secret-9f3a (http) - Connected

$ gemini mcp list  (wrong secret in path)
Configured MCP servers:

✗ swarm-probe: http://127.0.0.1:35669/mcp/orch-spike/WRONG-SECRET (http) - Disconnected

TUI /mcp list →
 YOLO Ctrl+Y                                                                           1 MCP server
 *   Type your message or @path/to/file
 > /mcp list
 YOLO Ctrl+Y                                                                           1 MCP server
Configured MCP servers:
🟢 swarm-probe - Ready (1 tool)
  Tools:
  - mcp_swarm-probe_swarm_probe_ping
 YOLO Ctrl+Y                                                                           1 MCP server
 *   Type your message or @path/to/file
 YOLO Ctrl+Y                                                                           1 MCP server
 *   Type your message or @path/to/file
```

Evidence / context:
```
SERVER-SIDE HITS (assertions are on this, not on model text):
  POST /mcp/orch-spike/sess-secret-9f3a rpc=initialize tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  POST /mcp/orch-spike/sess-secret-9f3a rpc=notifications/initialized tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  GET /mcp/orch-spike/sess-secret-9f3a rpc=- tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  POST /mcp/orch-spike/sess-secret-9f3a rpc=ping tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  POST /mcp/orch-spike/WRONG-SECRET rpc=initialize tool=- auth=- x-swarm-session=-
  POST /mcp/orch-spike/sess-secret-9f3a rpc=initialize tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  POST /mcp/orch-spike/sess-secret-9f3a rpc=notifications/initialized tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  GET /mcp/orch-spike/sess-secret-9f3a rpc=- tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
  POST /mcp/orch-spike/sess-secret-9f3a rpc=tools/list tool=- auth=Bearer spike-session-token x-swarm-session=sess-spike
```

Notes: Transport: `httpUrl` (NOT claude's `{"type":"http","url":…}`). The fake server received 9 request(s): initialize, notifications/initialized, ping, tools/list. **Arbitrary path segments survive**: the session-identifying path `/mcp/orch-spike/sess-secret-9f3a` reached the server verbatim (verified), so swarm-os's `/mcp/<orchId>/<sessionSecret>` session-identifying URL works unchanged. **Custom HTTP headers are supported** and sent on every request (verified: Authorization + X-Swarm-Session) via `mcpServers.<name>.headers`. A wrong path/secret is correctly reported as Disconnected. gemini status: Connected; the tool is exposed to the model as `mcp_swarm-probe_swarm_probe_ping` (server-name-prefixed) — confirmed in /mcp list. **No `tools/call` could be observed**: no working model credentials in this environment (see the Auth section), so no model turn can be run. Everything up to and including tool discovery is proven server-side; the final "model invokes the tool" hop is UNVERIFIED. Re-run this script once gemini has working credentials to promote C2 to CONFIRMED.

## C3 — Durable preamble: $GEMINI_CLI_HOME/.gemini/GEMINI.md survives /clear and /compact

Status: PARTIAL

Command: `echo canary > /tmp/swarm-os-spike/gemini/home/.gemini/GEMINI.md ; PTY: /memory show → /clear → /memory show → /compact → /memory show`

Exit: 0  ·  Duration: 36790ms

Output:
```
--- boot (footer) ---
⠹ Initializing...
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
⠸ Initializing...
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file

--- /memory show at boot ---
  ---
  --- Global ---
  --- Context from: ../home/.gemini/GEMINI.md ---
  # ROLE PREAMBLE (swarm-os spike)
  Ton nom de code est ZEPHYR-7.
  Si on te demande ton nom de code, reponds exactement ZEPHYR-7.
  --- End of Context from: ../home/.gemini/GEMINI.md ---
  ---
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file

--- /memory show after /clear ---
  ---
  --- Global ---
  --- Context from: ../home/.gemini/GEMINI.md ---
  # ROLE PREAMBLE (swarm-os spike)
  Ton nom de code est ZEPHYR-7.
  Si on te demande ton nom de code, reponds exactement ZEPHYR-7.
  --- End of Context from: ../home/.gemini/GEMINI.md ---
  ---
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file

--- /memory show after /compact ---
  ---
  --- Global ---
  --- Context from: ../home/.gemini/GEMINI.md ---
  # ROLE PREAMBLE (swarm-os spike)
  Ton nom de code est ZEPHYR-7.
  Si on te demande ton nom de code, reponds exactement ZEPHYR-7.
  --- End of Context from: ../home/.gemini/GEMINI.md ---
  ---
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
```


Notes: The preamble file is `$GEMINI_CLI_HOME/.gemini/GEMINI.md` (global memory). The footer reports "1 GEMINI.md file" at boot and `/memory show` prints it under "--- Global ---". It is still there after `/clear` (verified) and after `/compact` (verified) — consistent with the sources: `core/client.js` builds the system instruction as `getCoreSystemPrompt(config, userMemory)` and `resetChat()` re-derives it from the same `userMemory`, which is loaded from disk at startup and never cleared by those commands. **PARTIAL**: what is proven is that the file is loaded into the memory that feeds the system instruction, and that it survives both reset commands. That the model *obeys* it could not be proven here (no working model credentials — see the Auth section). Do NOT use `GEMINI_SYSTEM_MD`: it *replaces* the base system prompt (tool instructions included) instead of appending.

## C4 — trustedFolders.json suppresses the folder-trust dialog

Status: CONFIRMED

Command: `PTY gemini in /tmp/swarm-os-spike/gemini/trust-probe-a-1785095170535 (no trust file) vs /tmp/swarm-os-spike/gemini/trust-probe-b-1785095170535 (trustedFolders.json = {"<cwd>":"TRUST_FOLDER"})`

Exit: 0  ·  Duration: 24015ms

Output:
```
--- WITHOUT trustedFolders.json ---
    ▝▜▄
   ▗▟▀    Authenticated with gemini-api-key /auth
  ▝▀
Tips for getting started:
1. Create GEMINI.md files to customize your interactions
2. /help for more information
3. Ask coding questions, edit code or run commands
4. Be specific for the best results
│ ⠋ Waiting for authentication... (Press Esc or Ctrl+C to cancel)                                  │
 │ Do you trust the files in this folder?                                                         │
 │ Trusting a folder allows Gemini CLI to load its local configurations, including custom         │
 │ commands, hooks, MCP servers, agent skills, and settings. These configurations could execute   │
 │ code on your behalf or change the behavior of the CLI.                                         │
 │ ● 1. Trust folder (trust-probe-a-1785095170535)                                                │
 │   2. Trust parent folder (gemini)                                                              │
 │   3. Don't trust                                                                               │

--- WITH trustedFolders.json ---
⠙ Initializing...
 Shift+Tab to accept edits
⠹ Initializing...
 Shift+Tab to accept edits
⠹ Initializing...
 Shift+Tab to accept edits                                                         1 GEMINI.md file
⠸ Initializing...
 Shift+Tab to accept edits                                                         1 GEMINI.md file
⠼ Initializing...
 Shift+Tab to accept edits                                                         1 GEMINI.md file
 Shift+Tab to accept edits                                                         1 GEMINI.md file
 >   Type your message or @path/to/file
```


Notes: Failure mode reproduced: on a never-seen cwd the TUI DOES wedge on "Do you trust the files in this folder?" waiting for a keypress — exactly the hang swarm-os must avoid. Writing `$GEMINI_CLI_HOME/.gemini/trustedFolders.json` = `{"<abs cwd>": "TRUST_FOLDER"}` removes it (verified: the prompt is reachable). The enum value is confirmed by the sources (`config/trustedFolders.js`, `enum TrustLevel`): the only legal values are **TRUST_FOLDER**, **TRUST_PARENT**, **DO_NOT_TRUST** — the hypothesis `TRUST_FOLDER` was correct. The file is a FLAT map `{ "<path>": "<TrustLevel>" }` (no wrapper object), keyed by the *realpath*, and its location can be overridden with `GEMINI_CLI_TRUSTED_FOLDERS_PATH`. Folder trust is ON by default (`isFolderTrustEnabled` → `settings.security.folderTrust.enabled ?? true`). **This is not cosmetic**: `hookRegistry.processHooksFromConfig()` skips ALL configured hooks when the folder is untrusted, and stdio MCP servers are refused too — so C5 depends on C4.

## C5 — swarm-os's Notification hook command, unchanged, under gemini

Status: PARTIAL

Command: `settings.json → hooks.{SessionStart,BeforeAgent,AfterAgent,Notification}[].hooks[] = { type:"command", command: <swarm-os shell command verbatim> } ; PTY session + one prompt`

Exit: 0  ·  Duration: 20970ms

Output:
```
HTTP stub received 3 POST(s), events in order: SessionStart → BeforeAgent → AfterAgent

Sample stdin payload gemini fed to the hook:
{
  "session_id": "38ccde42-e2f4-47a4-ac85-a4ca3dad907c",
  "transcript_path": "/tmp/swarm-os-spike/gemini/home/.gemini/tmp/work/chats/session-2026-07-26T19-46-38ccde42.json",
  "cwd": "/tmp/swarm-os-spike/gemini/work",
  "hook_event_name": "SessionStart",
  "timestamp": "2026-07-26T19:46:42.018Z",
  "source": "startup"
}

Sample envelope the swarm-os command POSTed:
{"orch_id":"orch-spike","session_id":"sess-spike","kind":"session.waiting","message":"{\"session_id\":\"38ccde42-e2f4-47a4-ac85-a4ca3dad907c\",\"transcript_path\":\"/tmp/swarm-os-spike/gemini/home/.gemini/tmp/work/chats/session-2026-07-26T19-46-38ccde42.json\",\"cwd\":\"/tmp/swarm-os-spike/gemini/work\",\"hook_event_name\":\"SessionStart\",\"timestamp\":\"2026-07-26T19:46:42.018Z\",\"source\":\"startup\"}"}
```

Evidence / context:
```
Hook command under test (verbatim from session.ts:571-576):
payload=$(cat); msg=$(printf '%s' "$payload" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))' 2>/dev/null) || msg=$(printf '"%s"' "$(printf '%s' "$payload" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')"); body=$(printf '{"orch_id":"%s","session_id":"%s","kind":"session.waiting","message":%s}' 'orch-spike' 'sess-spike' "$msg"); curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer hook-token-spike' -d "$body" 'http://127.0.0.1:45393/hooks/notification' >/dev/null 2>&1 || true
```

Notes: **The transport works unchanged.** The exact shell command swarm-os writes for claude (`payload=$(cat); … curl -s -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' -d "$body" <url>`) runs as-is under gemini's `hooks` key and POSTed to the stub (verified; Authorization header correct, Content-Type correct). The stdin payload is Claude-Code-compatible: `{ session_id, transcript_path, cwd, hook_event_name, timestamp, … }` (gemini adds `timestamp`; `session_id`/`transcript_path`/`cwd`/`hook_event_name` are identical). Config shape is identical too: `{"hooks": {"<Event>": [{"matcher": "", "hooks": [{"type": "command", "command": "…"}]}]}}`, with an optional per-hook `timeout` (ms) and `env`. gemini also exports `GEMINI_PROJECT_DIR` **and** `CLAUDE_PROJECT_DIR` to the hook process. 

**BUT the event name must change.** gemini's `Notification` event never fired: `hooks/types.d.ts` declares `enum NotificationType { ToolPermission = "ToolPermission" }` and the only caller is `hookSystem.fireToolNotificationEvent()`, i.e. it fires **only when a tool asks for permission**. Under `--approval-mode yolo` (what swarm-os uses) permission is never asked, so a `Notification` hook would fire literally never and the whole "session is waiting" signal would be lost. The correct analogue is **`AfterAgent`** — gemini's own `hooks migrate` maps Claude's `Stop` → `AfterAgent` (`commands/hooks/migrate.js:19`). Observed here: SessionStart fired at boot, AfterAgent fired at the end of the turn — including a turn that failed with an API error, which makes it a reliable idle signal. Full Claude→gemini event mapping (from migrate.js): PreToolUse→BeforeTool, PostToolUse→AfterTool, UserPromptSubmit→BeforeAgent, Stop→AfterAgent, SubAgentStop→AfterAgent, SessionStart→SessionStart, SessionEnd→SessionEnd, PreCompact→PreCompress, Notification→Notification. Marked PARTIAL: the hook plumbing is CONFIRMED, the `Notification` event itself is REFUTED for swarm-os's use case.

## C6 — /clear resets the conversation, /compact is an alias of /compress

Status: CONFIRMED

Command: `PTY: type "/clear" + \r ; type "/compact" + \r`

Exit: 0  ·  Duration: 1ms

Output:
```
--- after /clear ---
 > /clear
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
  ▝▜▄     Gemini CLI v0.35.2
    ▝▜▄
   ▗▟▀    Authenticated with gemini-api-key /auth
  ▝▀
Tips for getting started:
1. /help for more information
2. Ask coding questions, edit code or run commands
3. Be specific for the best results
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file

--- after /compact ---
 copy             Copy the last result or code snippet to clipboard
 ▼
 (0/38)
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 * /compact
 compress   Compresses the context by replacing it with a summary
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
 > /compact
✦ Nothing to compress.
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
```


Notes: `/clear` works in the TUI: the screen is wiped and the splash banner + tips are repainted (verified), and the GEMINI.md role is still loaded afterwards (verified via /memory show). Internally it fires SessionEnd(Clear), calls `resetChat()`, assigns a NEW session id, then fires SessionStart(Clear) — so any hook keyed on SessionStart fires again on every /clear, and the transcript path changes. `/compact` is accepted: the completer resolves it to `compress` (verified) and the command runs (verified). Sources agree: `ui/commands/compressCommand.js` declares `altNames: ['summarize','compact']`. Note: an actual compression is a model call, so on an empty/failed conversation it answers "Nothing to compress."

## C7 — PTY injection: two-step Ink submit dance vs single write

Status: CONFIRMED

Command: `(a) pty.write("CANARY_TWO_STEP_MESSAGE") ; sleep 150ms ; pty.write("\r")   |   (b) pty.write("CANARY_SINGLE_WRITE_MESSAGE\r")`

Exit: 0  ·  Duration: 36178ms

Output:
```
--- (a) two-step, 150ms gap ---
 Shift+Tab to accept edits
 >   Type your message or @path/to/file
✕ [API Error: {"error":{"message":"{\n  \"error\": {\n    \"code\": 400,\n    \"message\": \"API key
  not valid. Please pass a valid API key.\",\n    \"status\": \"INVALID_ARGUMENT\",\n
  \"details\": [\n      {\n        \"@type\": \"type.googleapis.com/google.rpc.ErrorInfo\",\n
  \"reason\": \"API_KEY_INVALID\",\n        \"domain\": \"googleapis.com\",\n        \"metadata\":
  {\n          \"service\": \"generativelanguage.googleapis.com\"\n        }\n      },\n      {\n
  \"@type\": \"type.googleapis.com/google.rpc.LocalizedMessage\",\n        \"locale\": \"en-US\",\n
  \"message\": \"API key not valid. Please pass a valid API key.\"\n      }\n    ]\n
  }\n}\n","code":400,"status":"Bad Request"}}]
ℹ This request failed. Press F12 for diagnostics, or run /settings and change "Error Verbosity" to
  full for full details.
 Shift+Tab to accept edits                                                         1 GEMINI.md file
 >   Type your message or @path/to/file
 Shift+Tab to accept edits                                                         1 GEMINI.md file
 >   Type your message or @path/to/file

--- (b) single write "text\r" ---
 Shift+Tab to accept edits                                                         1 GEMINI.md file
 > CANARY_SINGLE_WRITE_MESSAGE
 Shift+Tab to accept edits                                                         1 GEMINI.md file
 > CANARY_SINGLE_WRITE_MESSAGE
```


Notes: (a) The two-step cadence **works**: the text left the input box and the turn was submitted (verified). (b) The single write `"text\r"` **does not submit**: the text is still sitting in the input box (verified — the canary is still on the "> " line after 7s). Same behaviour as Claude Code, same cause: gemini's TUI is an Ink/React app whose `useInput` handler processes the paste-like burst and the Enter key in a single tick, so the newline is swallowed as part of the text. **`capabilities.inkSubmitDance = true`** — the adapter MUST keep swarm-os's write-then-\r cadence (150ms was enough here). Slash commands need the same dance, and note the completion popup: typing `/clear` opens a suggestion list, and the lone \r both accepts the suggestion and runs the command (built-in commands are `autoExecute: true`).

## C8 — PTY goes silent when idle (BLOCKING)

Status: CONFIRMED

Command: `PTY gemini --approval-mode yolo ; settle 10000ms ; measure PTY output for 10000ms`

Exit: 0  ·  Duration: 20012ms

Output:
```
idle window: 0 bytes in 10000ms across 0 chunk(s) → 0.0 B/s (threshold: < 100 B/s)

--- screen at the end of the settle period ---
⠹ Initializing...
 YOLO Ctrl+Y
⠸ Initializing...
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
⠼ Initializing...
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 YOLO Ctrl+Y                                                                       1 GEMINI.md file
 *   Type your message or @path/to/file
```


Notes: Once settled at the prompt, gemini's TUI emits **0.0 B/s** (0 bytes / 0 chunks over 10s) — well under the 100 B/s threshold, so swarm-os silence-based idle detection works unchanged. Two caveats that DO break the measurement and must be handled by the adapter's settings.json: (1) `general.enableAutoUpdate`/`enableAutoUpdateNotification` default to **true** — on boot gemini prints an "update available … attempting to automatically update now" banner and shells out to npm; both must be set to false. (2) Any modal dialog (folder trust, auth) keeps the renderer repainting at several hundred B/s indefinitely, which reads as "permanently busy". Measured here: ~394 B/s while the auth dialog was open vs 0 B/s once settled. So C4 (trust) and a valid auth mode are prerequisites for C8 holding in production. The settle period must be generous: gemini shows an "Initializing…" spinner for several seconds after launch.
---

## Contrat pour l'adaptateur

### Ligne d'argv

```sh
gemini --approval-mode yolo
# + éventuellement: -m <model>   (nom exact NON vérifié par ce spike — sans -m le footer affiche "Auto (Gemini 3)")
# NE PAS passer -p / --prompt : mode headless, pas de TUI donc pas de session pilotable.
# NE PAS passer -i / --prompt-interactive pour le préambule : passer par GEMINI.md (C3).
```

`-y/--yolo` est équivalent à `--approval-mode yolo` ; le mode est visible dans le footer (`YOLO Ctrl+Y`, invite `*`).

### Variables d'environnement

```sh
GEMINI_CLI_HOME=<runtimeDir>/sessions/<session_id>   # racine de config jetable (config réelle: $GEMINI_CLI_HOME/.gemini/)
TERM=xterm-256color
# selon le mode d'auth choisi :
GEMINI_API_KEY=<clé>                                 # si security.auth.selectedType = "gemini-api-key"
# optionnel : GEMINI_CLI_TRUSTED_FOLDERS_PATH=<chemin> pour déplacer trustedFolders.json
```

Équivalence avec claude : `CLAUDE_CONFIG_DIR=<dir>` → `GEMINI_CLI_HOME=<dir>`, **mais attention** : claude lit
`<dir>/settings.json`, gemini lit `<dir>/.gemini/settings.json` (il traite la variable comme un `$HOME`).

### settings.json à générer — `$GEMINI_CLI_HOME/.gemini/settings.json`

```json
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  },
  "general": {
    "enableAutoUpdate": false,
    "enableAutoUpdateNotification": false
  },
  "ui": {
    "showHomeDirectoryWarning": false
  },
  "mcpServers": {
    "swarm-os": {
      "httpUrl": "http://127.0.0.1:<mcpPort>/mcp/<orch_id>/<session_secret>",
      "trust": true,
      "timeout": 30000
    }
  },
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "<the swarm-os curl one-liner, unchanged>"
          }
        ]
      }
    ]
  }
}
```

- `general.enableAutoUpdate: false` et `general.enableAutoUpdateNotification: false` sont **obligatoires** :
  sinon gemini tente un `npm install -g` au boot et pollue la PTY (C8).
- `mcpServers.<nom>.httpUrl` (et **pas** `{"type":"http","url":…}` comme claude). Champs utiles :
  `headers` (Record<string,string>, envoyés sur chaque requête), `trust` (bool), `timeout` (ms),
  `includeTools`/`excludeTools`. Les outils sont exposés au modèle sous `mcp_<serveur>_<outil>`.
- `hooks` : même schéma que Claude Code, mais **noms d'événements différents** (voir C5).

### Fichier de préambule

```
$GEMINI_CLI_HOME/.gemini/GEMINI.md
```

Chargé au boot comme "global memory", replié dans l'instruction système via `getCoreSystemPrompt(config, userMemory)`
et re-dérivé par `resetChat()` — donc conservé par `/clear` et `/compact` (C3). Vérifiable en session avec `/memory show`.
**Ne pas utiliser `GEMINI_SYSTEM_MD`** : cette variable *remplace* le prompt système de base (on perdrait les
instructions d'outillage).

### Fichier et format de confiance

```
$GEMINI_CLI_HOME/.gemini/trustedFolders.json
```

```json
{
  "<absolute cwd of the session>": "TRUST_FOLDER"
}
```

Map plate `{ "<chemin absolu>": "<TrustLevel>" }`. Valeurs légales (source `config/trustedFolders.js`) :
**`TRUST_FOLDER`**, `TRUST_PARENT`, `DO_NOT_TRUST`. La clé est comparée au *realpath* du cwd.
Sans cette entrée la TUI se fige sur "Do you trust the files in this folder?" (C4), **et** tous les hooks
configurés sont désactivés (`hookRegistry.processHooksFromConfig()` court-circuite si le dossier n'est pas de confiance).

### Tokens de reset

| intention | token à injecter | remarque |
|---|---|---|
| vider la conversation | `/clear` | nouvelle session id, SessionEnd(Clear) puis SessionStart(Clear) re-tirés ; GEMINI.md conservé |
| compacter le contexte | `/compact` | alias de `/compress` (`altNames: ['summarize','compact']`) |

Les deux doivent être injectés avec la danse Ink (texte, puis `\r` seul ~150 ms plus tard).

### capabilities

```ts
{
  effort: null,            // aucun flag CLI équivalent à --effort de claude. Le budget de raisonnement
                           // n'est réglable que via settings.modelConfigs.*.generateContentConfig.thinkingConfig.thinkingBudget
  notificationHook: 'AfterAgent',  // PAS 'Notification' : celui-ci ne se déclenche que sur ToolPermission,
                                   // donc jamais en --approval-mode yolo
  inkSubmitDance: true,    // écrire le texte, puis \r seul ~150 ms plus tard (C7)
  durablePreamble: true,   // GEMINI.md survit à /clear et /compact (C3)
  httpMcp: true,           // mcpServers.<nom>.httpUrl + headers, chemins arbitraires OK (C2)
}
```

### Commande de sonde de disponibilité (issue de C1)

```sh
GEMINI_CLI_HOME="$SESSION_HOME" gemini mcp list 2>&1
# préparation : $SESSION_HOME/.gemini/settings.json contient
#   {"mcpServers":{"swarm-probe":{"httpUrl":"http://127.0.0.1:1/mcp"}}}
# succès  ⇔ exit 0 ET la sortie FUSIONNÉE contient "swarm-probe"
# ATTENTION : hors TTY, gemini écrit ce listing sur stderr, pas sur stdout — le 2>&1 est obligatoire.
# coût    : ~2,7 s, aucun appel modèle, aucune TUI
```

Si cette sonde échoue, l'adaptateur doit **refuser de démarrer une session** : sans isolation par
`GEMINI_CLI_HOME`, toutes les sessions partageraient une seule config donc une seule URL MCP, et chaque
agent s'authentifierait auprès du serveur comme le dernier ayant écrit le fichier.

### Pièges à ne pas oublier

1. **Les identifiants OAuth doivent être COPIÉS, jamais symlinkés** dans le `GEMINI_CLI_HOME` de session :
   gemini réécrit `oauth_creds.json` au rafraîchissement du jeton et suit le lien symbolique. Vérifié à la dure
   pendant ce spike (le `~/.gemini/oauth_creds.json` de l'opérateur a été réécrit). Corollaire non résolu :
   N sessions concurrentes qui rafraîchissent chacune leur copie du même refresh-token peuvent s'invalider
   mutuellement — à trancher avant la mise en prod (un mode API-key par session évite le problème).
   État du `~/.gemini` hôte à la fin de CE run : **inchangé**.
2. **La TUI se fige sur toute boîte de dialogue modale** (confiance, auth) et repeint en continu (~400 B/s),
   ce qui casse la détection d'inactivité. Pré-accepter la confiance (C4) et garantir une auth valide.
3. **`gemini mcp list` hérite du mode d'auth** : avec `selectedType: "gemini-api-key"` et pas de
   `GEMINI_API_KEY` dans l'env, il sort en 41 avant d'afficher quoi que ce soit.
3bis. **Toute invocation de `gemini`, y compris `gemini --version`, écrit dans le répertoire de config**
   (bootstrap : registre de projets + nettoyage de sessions). Il n'existe aucune commande "lecture seule" :
   `GEMINI_CLI_HOME` doit être positionné même pour un simple check de version, sinon on pollue le
   `~/.gemini` de l'hôte. Vérifié pendant ce spike.
4. Les outils MCP sont renommés `mcp_<serveur>_<outil>` côté modèle — en tenir compte dans le préambule
   et dans `--allowed-mcp-server-names`.

---

### Checks à reprendre

- **C2 PARTIAL** — Per-session MCP over streamable HTTP (BLOCKING)
- **C3 PARTIAL** — Durable preamble: $GEMINI_CLI_HOME/.gemini/GEMINI.md survives /clear and /compact
- **C5 PARTIAL** — swarm-os's Notification hook command, unchanged, under gemini
