# Spike — hook `SessionStart` de Claude Code

_Généré par `scripts/verify-claude-sessionstart.ts` le 2026-08-30T13:17:07.268Z._

**Commande :** `pnpm verify:claude-sessionstart`

**Environnement :**
- claude CLI : 2.1.251 (Claude Code)
- node : v22.22.2 · platform : linux
- modèle des sessions de test : `haiku` (prompts d'un mot)
- sandbox jetable : `/tmp/claude-1000/verify-claude-sessionstart` (CLAUDE_CONFIG_DIR isolé, nettoyé en fin de run)

**Résumé :** CONFIRMED=9 · INFIRMED=0 · PARTIAL=0 · UNVERIFIED=0 · total=82821ms

| ID | Fait vérifié | Statut |
|----|--------------|--------|
| S1b | SessionStart fires in --print mode | **CONFIRMED** |
| S2 | stdin payload schema + transcript_path reachability + message.usage | **CONFIRMED** |
| S3 | A SessionStart hook’s stdout IS injected into the agent’s context | **CONFIRMED** |
| S5 | A SessionStart hook exiting non-zero does NOT kill the session | **CONFIRMED** |
| S6 | Recommended curl form: payload delivered, nothing injected, 400 harmless | **CONFIRMED** |
| S1a | SessionStart fires on interactive startup (source=startup) | **CONFIRMED** |
| S1c | SessionStart fires after /clear (source=clear) | **CONFIRMED** |
| S1d | SessionStart fires after /compact (source=compact) | **CONFIRMED** |
| S4 | /clear rotates the transcript file (new path) or reuses it | **CONFIRMED** |

---

## S1b — SessionStart fires in --print mode

Statut : **CONFIRMED**

Commande : `claude -p hi --model haiku`

Exit : 0 · Durée : 2983ms

Sortie :
```
Hi! How can I help you today?
```

Notes : Hook fired 1× on a single `claude -p` run, with **`source:"startup"`** — print mode does NOT get a dedicated source value, it reuses `startup`. Payload keys: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`.

Preuve :
```json
{
  "session_id": "12f3984a-ed56-4adb-8bc8-1c84c88d2076",
  "transcript_path": "/tmp/claude-1000/verify-claude-sessionstart/print/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-print-work/12f3984a-ed56-4adb-8bc8-1c84c88d2076.jsonl",
  "cwd": "/tmp/claude-1000/verify-claude-sessionstart/print/work",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```


## S2 — stdin payload schema + transcript_path reachability + message.usage

Statut : **CONFIRMED**

Commande : `hook stdin dump → /tmp/claude-1000/verify-claude-sessionstart/print/hook-payloads.jsonl`

Exit : 0 · Durée : 1ms

Sortie :
```
{
  "session_id": "12f3984a-ed56-4adb-8bc8-1c84c88d2076",
  "transcript_path": "/tmp/claude-1000/verify-claude-sessionstart/print/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-print-work/12f3984a-ed56-4adb-8bc8-1c84c88d2076.jsonl",
  "cwd": "/tmp/claude-1000/verify-claude-sessionstart/print/work",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

Notes : Payload carries exactly the 5 expected keys and no extras. `transcript_path` → `/tmp/claude-1000/verify-claude-sessionstart/print/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-print-work/12f3984a-ed56-4adb-8bc8-1c84c88d2076.jsonl` (exists: true, 14986B). It lands under `$CLAUDE_CONFIG_DIR/projects/<slugified-cwd>/<session_id>.jsonl`, i.e. the file is named after `session_id`. Line types observed: `queue-operation` → `queue-operation` → `user` → `attachment` → `attachment` → `attachment` → `attachment` → `atis-latch` → `assistant+usage` → `assistant+usage` → `last-prompt`. **The last line is NOT an assistant line** (`last-prompt` here), so the parser must scan backwards, never read the tail's final line. Last assistant usage: {"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":20411,"output_tokens":86,"output_tokens_details":{"thinking_tokens":71},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":10,"output_tokens":86,"cache_read_input_tokens":20411,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"}. used = input+cache_read+cache_creation+output = **20507**. ⚠️ **Two `type:"assistant"` lines share one `message.id` and repeat the SAME `usage` object** (thinking block + text block of a single turn). Summing usage across assistant lines double-counts; taking the LAST one — as the plan specifies — is correct.

Preuve :
```json
{"parentUuid":"0db8a886-20a4-4ffa-8064-be8e147b5129","isSidechain":false,"message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CeYzgPLQvD3U6UPV3qZQj","type":"message","role":"assistant","content":[{"type":"text","text":"Hi! How can I help you today?"}],"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":20411,"output_tokens":86,"output_tokens_details":{"thinking_tokens":71},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":10,"output_tokens":86,"cache_read_input_tokens":20411,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"},"diagnostics":null},"requestId":"req_011CeYzgNejY8zxYE4v62M9u","type":"assistant","uuid":"ba300aba-eb05-4583-9fe9-eb15afbe0ed1","timestamp":"2026-08-30T13:15:47.189Z","userType":"external","entrypoint":"sdk-cli","cwd":"/tmp/claude-1000/verify-claude-sessionstart/print/work","sessionId":"12f3984a-ed56-4adb-8bc8-1c84c88d2076","version":"2.1.251","gitBranch":"HEAD"}
```


## S3 — A SessionStart hook’s stdout IS injected into the agent’s context

Statut : **CONFIRMED**

Commande : `loud hook (echo marker) vs silent hook (stdout → /dev/null), same probe prompt`

Exit : 0 · Durée : 7471ms

Sortie :
```
LOUD  → ZQX7-MARKER-ALPHA
SILENT→ NONE
```

Notes : **THE critical fact.** With a hook that echoes `ZQX7-MARKER-ALPHA`, the agent answered with the marker verbatim → the hook's stdout is injected into the conversation as context. With stdout redirected to /dev/null the same probe answered `NONE` → nothing injected. Mechanism (visible in the transcript): the CLI appends a `type:"attachment"` line with `attachment.type:"hook_success"`, whose `content` is the hook's trimmed stdout, immediately before the user turn. Consequence for the integration: the hook command MUST discard stdout.

Preuve :
```json
(no hook attachment line found)
```


## S5 — A SessionStart hook exiting non-zero does NOT kill the session

Statut : **CONFIRMED**

Commande : `claude -p "reply with the single word OK" --model haiku  (hook body: `echo … >&2; exit 1`)`

Exit : 0 · Durée : 2342ms

Sortie :
```
OK
```

Notes : The session ran to completion (exit 0, agent replied normally) despite the hook exiting 1. The failure is recorded in the transcript as `attachment.type:"hook_non_blocking_error"` — SessionStart failures are non-blocking. Note the stderr of a failing hook is NOT injected as context (unlike stdout on success), but it IS surfaced in the transcript. This validates the `|| true` tail of the planned curl command as belt-and-braces rather than a strict requirement.

Preuve :
```json
(no hook attachment line found)
```


## S6 — Recommended curl form: payload delivered, nothing injected, 400 harmless

Statut : **CONFIRMED**

Commande : `curl -sS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:38949/hooks/spike-secret/session.transcript' >/dev/null 2>&1 || true`

Exit : 0 · Durée : 3852ms

Sortie :
```
agent answer: NONE
server received 1 request(s)
parsed payload keys: session_id, transcript_path, cwd, hook_event_name, source
transcript_path in delivered body: /tmp/claude-1000/verify-claude-sessionstart/curl/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-curl-work/07e2b3c1-92f0-4d33-a1e8-12d6aa1840b2.jsonl
```

Notes : The exact command recommended below was run as a real `SessionStart` hook against a server answering **HTTP 400** with a JSON error body. Result: the server received the payload (1 request, `transcript_path` intact), the CLI exited 0, and the probe for the marker planted in the 400 body answered "NONE" — the 400 response body never reached the conversation. `curl` without `-f` treats a 4xx as a successful transfer (exit 0), and `-o /dev/null` plus `>/dev/null 2>&1` keep the body off stdout. This closes the plan's H6 worry for SessionStart: a non-2xx from `hooks.ts` is inert.

Preuve :
```json
{
  "session_id": "07e2b3c1-92f0-4d33-a1e8-12d6aa1840b2",
  "transcript_path": "/tmp/claude-1000/verify-claude-sessionstart/curl/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-curl-work/07e2b3c1-92f0-4d33-a1e8-12d6aa1840b2.jsonl",
  "cwd": "/tmp/claude-1000/verify-claude-sessionstart/curl/work",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```


## S1a — SessionStart fires on interactive startup (source=startup)

Statut : **CONFIRMED**

Commande : `node-pty spawn: claude --model haiku`

Exit : 129 · Durée : 66151ms

Sortie :
```
after boot: 1 payload(s) — sources=[startup]
after /clear: 2 payload(s) — sources=[startup, clear]
after /compact: 3 payload(s) — sources=[startup, clear, compact]
```

Notes : Exactly 1 payload at TUI boot with `source:"startup"`, before any user input. This is the moment the provider needs: the transcript path is known before the first turn.


## S1c — SessionStart fires after /clear (source=clear)

Statut : **CONFIRMED**

Commande : `PTY: submit "/clear" (two-step Ink dance)`

Exit : 129 · Durée : 66151ms

Sortie :
```
after boot: 1 payload(s) — sources=[startup]
after /clear: 2 payload(s) — sources=[startup, clear]
after /compact: 3 payload(s) — sources=[startup, clear, compact]
```

Notes : `/clear` fired a fresh SessionStart with `source:"clear"`.


## S1d — SessionStart fires after /compact (source=compact)

Statut : **CONFIRMED**

Commande : `PTY: submit "/compact" (after 5 turns, so the CLI accepts it)`

Exit : 129 · Durée : 66151ms

Sortie :
```
after boot: 1 payload(s) — sources=[startup]
after /clear: 2 payload(s) — sources=[startup, clear]
after /compact: 3 payload(s) — sources=[startup, clear, compact]
```

Notes : `/compact` fired a fresh SessionStart with `source:"compact"` once the compaction completed. Note it is emitted only when the compaction actually runs: on a too-short conversation the CLI answers "Not enough messages to compact." and NO SessionStart is fired — so the tracker must not assume a hook callback follows every operator-issued compact.


## S4 — /clear rotates the transcript file (new path) or reuses it

Statut : **CONFIRMED**

Commande : `compare transcript_path across startup and clear payloads`

Exit : 0 · Durée : 66151ms

Sortie :
```
startup: session_id=566a03de-207e-46a4-b772-25d47de95e6c
         transcript=/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/566a03de-207e-46a4-b772-25d47de95e6c.jsonl
clear:   session_id=f583d47b-375d-4738-9a37-2fd95ea0e757
         transcript=/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/f583d47b-375d-4738-9a37-2fd95ea0e757.jsonl
compact: session_id=f583d47b-375d-4738-9a37-2fd95ea0e757
         transcript=/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/f583d47b-375d-4738-9a37-2fd95ea0e757.jsonl
```

Notes : **ROTATION CONFIRMÉE** — `/clear` hands back a DIFFERENT `.jsonl`, under a **new `session_id`**. A cached transcript path goes stale the moment a clear happens, so the tracker MUST adopt the path re-supplied by the hook rather than keep the boot-time one. `/compact`, by contrast, re-supplied the SAME path as the post-clear one (/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/f583d47b-375d-4738-9a37-2fd95ea0e757.jsonl) — compaction rewrites in place. Consequence for the "last resort" fallback in the plan (newest `.jsonl` in the projects dir by mtime): it is even more fragile than assumed, since a single agent legitimately produces several transcripts over its lifetime in the same dir.

Preuve :
```json
[
  {
    "source": "startup",
    "session_id": "566a03de-207e-46a4-b772-25d47de95e6c",
    "transcript_path": "/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/566a03de-207e-46a4-b772-25d47de95e6c.jsonl"
  },
  {
    "source": "clear",
    "session_id": "f583d47b-375d-4738-9a37-2fd95ea0e757",
    "transcript_path": "/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/f583d47b-375d-4738-9a37-2fd95ea0e757.jsonl"
  },
  {
    "source": "compact",
    "session_id": "f583d47b-375d-4738-9a37-2fd95ea0e757",
    "transcript_path": "/tmp/claude-1000/verify-claude-sessionstart/tui/cfg/projects/-tmp-claude-1000-verify-claude-sessionstart-tui-work/f583d47b-375d-4738-9a37-2fd95ea0e757.jsonl"
  }
]
```

---

## Recommandation — forme de la commande de hook

S3 est décisif : le stdout d'un hook `SessionStart` **est injecté dans le contexte de l'agent** (ligne de transcript `type:"attachment"` / `attachment.type:"hook_success"`, dont le `content` est le stdout du hook). Un `curl` non muet polluerait donc chaque démarrage, chaque `/clear` et chaque `/compact` avec sa sortie — et gonflerait précisément la métrique qu'on cherche à mesurer.

Forme à livrer dans le `settings.json` per-session :

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:<port>/hooks/<secret>/session.transcript' >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

Justification clause par clause :

- `--data-binary @-` : le payload arrive sur **stdin** du hook (S2). `@-` le relaie tel quel, sans que curl ne réinterprète les newlines.
- `-o /dev/null` **et** `>/dev/null 2>&1` : ceinture et bretelles. `-o` couvre le corps de la réponse, la redirection couvre tout ce que curl pourrait écrire par ailleurs. C'est la clause qui rend le hook muet (S3).
- `-sS` : pas de barre de progression ; `-S` garde les vraies erreurs… qui partent en `2>&1`, donc rien n'est injecté (le stderr d'un hook n'est de toute façon pas injecté — voir S5).
- `-m 5` : un timeout **obligatoire**. Le hook s'exécute de façon synchrone au démarrage de session ; sans borne, un serveur qui ne répond pas retarde le boot du CLI.
- `|| true` : confort, pas nécessité — S5 montre qu'un exit non nul est déjà non bloquant pour `SessionStart` (`hook_non_blocking_error`). On le garde pour que l'échec ne laisse pas non plus de trace dans le transcript.

## Écarts par rapport à `docs/monitoring-agents.md`

- **Valeur `source` en print mode** — Le plan liste `startup|resume|clear|compact|fork`. `claude -p` ne reçoit **pas** de source dédiée : il réutilise `startup` (S1b). Aucune branche du serveur ne doit donc filtrer sur une source « print ». `resume` et `fork` n'ont pas été exercés par ce spike.
- **Rotation du transcript — asymétrie clear / compact** — Le plan traite `clear` et `compact` de la même façon (« re-fournit le nouveau chemin »). Mesuré, les deux ne se comportent PAS pareil (S4) : `/clear` **rotationne** — nouveau `session_id` CLI **et** nouveau fichier `.jsonl` ; `/compact` **ne rotationne pas** — même `session_id`, même fichier, réécrit en place. Le hook re-fournit bien le chemin dans les deux cas, donc « toujours adopter le chemin du payload » reste la bonne règle et couvre les deux ; mais le corollaire vaut d'être noté : après un compact, le fichier grossit sans changer de nom, alors qu'après un clear l'ancien fichier reste sur disque, orphelin. Le nom est `<session_id-du-CLI>.jsonl` — pas l'id de session swarm-os. Corollaire pour le fallback « plus récent `.jsonl` du projects dir par mtime » : il est plus fragile que le plan ne le suppose, puisqu'un seul agent produit légitimement plusieurs transcripts dans le même répertoire au cours de sa vie.
- **Compaction refusée = aucun hook** — Le plan suppose implicitement qu'un compact opérateur produit un callback. Faux si la conversation est trop courte : le CLI répond « Not enough messages to compact. » et **ne déclenche rien** (S1d). Le badge `contextResetPending` ne doit donc pas attendre un `SessionStart` pour retomber.
- **Parse du transcript — ne jamais sommer** — Deux lignes `type:"assistant"` consécutives peuvent porter le **même `message.id` et le même objet `usage`** (bloc thinking + bloc texte d'un même tour) — S2. Sommer les lignes assistant double-compte. Prendre la dernière, comme le plan le spécifie déjà, est la bonne règle : ce spike la confirme et explique pourquoi.
- **Dernière ligne ≠ ligne assistant** — Le transcript se termine couramment par `last-prompt` (autres types observés : `queue-operation`, `attachment`, `atis-latch`) — S2. Le parseur doit remonter le fichier à l'envers ; lire la dernière ligne du `tail -c` ne suffit pas.
- **Risque H6 (non-2xx tue le CLI)** — Le plan impose de livrer la branche `hooks.ts` (200 systématique) avant le changement de settings, par crainte d'un crash sur non-2xx. Pour `SessionStart` cette contrainte tombe : un hook qui sort en exit 1 est **non bloquant** (S5, `hook_non_blocking_error`), et un `curl` sans `-f` sort de toute façon en 0 sur une réponse 400 (S6). L'ordre de livraison reste prudent, mais ce n'est plus un risque de crash.
- **Auth du TUI interactif** — Un `CLAUDE_CODE_OAUTH_TOKEN` seul suffit à `--print` mais **pas** au TUI interactif, qui repart dans le flux de login si le `CLAUDE_CONFIG_DIR` ne contient ni `.credentials.json` ni un `.claude.json` avec `hasCompletedOnboarding`. C'est déjà ce que fait `providers/claude.ts` (symlink + seed) ; à ne pas régresser.
