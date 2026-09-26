import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Boot-time warnings about a malformed knob go through the shared logger. The
// import is safe both ways: `logger.ts` only takes a TYPE from this module, so
// nothing is evaluated in a cycle, and a `loadConfig()` that runs before
// `initRootLogger` simply lands on the default JSON logger (see logger.ts).
import { withModule } from './logger.js';
import {
  BUILTIN_PROVIDER_DEFAULT_MODELS,
  BUILTIN_PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
  type BuiltinProviderId,
} from './modules/providers/ids.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode =
  | 'auto'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

/**
 * Transport used to launch claude agent processes.
 *
 * - `local` (default): spawn the `claude` binary directly inside this process'
 *   namespace via `node-pty`. Used when swarm-os runs on the same host as
 *   claude (dev mode) or inside a container that has its own claude binary +
 *   credentials copy.
 * - `ssh`: open `ssh -tt <sshTarget>` and run the **host's** claude binary
 *   remotely. Used to avoid sharing `~/.claude/.credentials.json` between a
 *   container and the host — both processes would otherwise race on OAuth
 *   refresh and invalidate each other's tokens.
 */
export type AgentTransport = 'local' | 'ssh';

export interface Config {
  port: number;
  host: string;
  /**
   * Base URL the agents' hooks POST back to (`<hookUrl>/hooks/notification`).
   * Default `http://127.0.0.1:<port>` — correct under the local transport where
   * agent and server share a loopback. Under `agentTransport=ssh` the hook curl
   * runs on the HOST, whose `127.0.0.1:<port>` is NOT this server (it can even
   * be another swarm-os instance, whose /hooks rejects the post with
   * `token-mismatch`). Each ssh deployment must point this at its host-mapped
   * port, e.g. `http://127.0.0.1:8789`. Env: `SWARM_OS_HOOK_URL`.
   */
  hookUrl: string;
  /**
   * MCP HTTP listener port — separate from `port`. The MCP server binds to
   * the loopback interface ONLY (hardcoded `127.0.0.1`, see plan §14): no
   * env var lets it leak onto the network. The port is configurable via
   * `SWARM_OS_MCP_PORT` purely so it can be moved off a conflict, never
   * to change the bind address.
   */
  mcpPort: number;
  projectName: string;
  /**
   * `SWARM_OS_DEFAULT_MODEL`, or the default model of `defaultProvider` below
   * when unset. The pair is always COHERENT: the id here is one this instance's
   * default provider understands, never an unrelated vendor's.
   */
  defaultModel: string;
  /**
   * Did the OPERATOR name that model, or is it merely the built-in floor?
   *
   * Load-bearing, and the whole reason the live catalogue is reachable at all.
   * `defaultModel` is never empty, so the `'config'` layer that
   * `POST /orchestrators` and `plugins/api.ts` build always named a model, and
   * `pickScoped` (`providers/resolve.ts:131-146`) accepts it as soon as the
   * layer belongs to the running provider — which is true BY CONSTRUCTION for
   * the instance's own default provider. So `own.model` (`resolve.ts:161`, the
   * adapter's `defaults()`) was unreachable on the API path for a claude team on
   * a claude instance, and an adapter that resolved a newer model would have
   * been ignored: `GET /providers` would advertise `claude-opus-5` while
   * `POST /orchestrators` created the team on `claude-opus-4-8`.
   *
   * The browser did not show the bug — `NewOrchestratorDialog.tsx:171` puts
   * `defaultModelFor(provider)` in the submitted body, i.e. in layer 0 — which
   * is exactly what made it a two-answers-for-one-question defect rather than a
   * visible one.
   *
   * So: the config layer names a model only when an operator actually wrote one.
   * `defaultModel` keeps its old meaning for every other reader (docs, the UI's
   * "what will I get?" copy) and for the `SWARM_OS_DEFAULT_PROVIDER=codex`
   * coherence guarantee above.
   */
  defaultModelExplicit: boolean;
  defaultEffort: EffortLevel;
  defaultPermissionMode: PermissionMode;
  /**
   * Agent provider used when neither the request nor the role names one
   * (`SWARM_OS_DEFAULT_PROVIDER`, default `claude`). Validated at boot against
   * the BUILT-IN ids (`modules/providers/ids.ts`) — see that module for why it
   * is not validated against the live registry.
   *
   * `defaultModel` above belongs to THIS provider (they are resolved together
   * in `loadConfig`). When a team is created on a different one without an
   * explicit model, that provider's own default is used instead — the shared
   * rule lives in `modules/providers/resolve.ts`.
   */
  defaultProvider: string;
  maxOrchestrators: number;
  maxPromptSizeBytes: number;
  claudeStartTimeoutMs: number;
  workspaceRoot: string;
  dataDir: string;
  logsDir: string;
  /**
   * Directory under `/tmp` where per-session `mcp.json` files live.
   * Each session writes `<mcpRuntimeDir>/orch-<orch_id>/session-<session_id>/mcp.json`
   * with mode `0600` and unlinks on exit.
   */
  mcpRuntimeDir: string;
  /**
   * Phase 5: source directory for the host `~/.claude` mount (RO inside
   * container — `/claude-source` by default). When the path doesn't exist
   * (typical of local dev outside Docker), the boot-time `claude-init`
   * step is a no-op and Claude falls back to the developer's host
   * `~/.claude`. Configurable via `SWARM_OS_CLAUDE_SOURCE_DIR`.
   */
  claudeSourceDir: string;
  /**
   * Phase 5: writable runtime root for the per-container Claude state.
   * Boot-time `claude-init` copies `claudeSourceDir` here so concurrent
   * containers don't corrupt the shared `~/.claude` host. Per-session
   * `CLAUDE_CONFIG_DIR=<claudeRuntimeDir>/sessions/<sid>/` is derived
   * from this root. Defaults to `<dataDir>/.claude-runtime`.
   */
  claudeRuntimeDir: string;
  /**
   * Phase 6: explicit override for the host `~/.claude.json` source path.
   * Optional. When unset, `claude-init` falls back to `<claudeSourceDir>.json`
   * (sibling — typically `/claude-source.json` if the second optional mount
   * is configured). When neither path exists, the lift is a silent no-op
   * and Claude will use its default-config / theme-picker flow.
   * Configurable via `SWARM_OS_CLAUDE_JSON_SOURCE`.
   */
  claudeJsonSource: string | null;
  /** Phase 3: cap on workers per orchestrator. Lead is not counted. */
  maxWorkersPerOrch: number;
  /** Phase 3: cap on `team.send_message` content size. Bytes. */
  maxMessageSizeBytes: number;
  /** Phase 3: cap on per-session inbox queue length. Oldest dropped over cap. */
  maxInboxSize: number;
  /**
   * Phase 3: idle threshold (ms) before a recipient session gets a PTY signal
   * after a `team.send_message`. If `(now - lastActivityAt) >= this`, we
   * inject the short signal; otherwise we stay silent so we don't garble the
   * agent's current output stream.
   */
  idleThresholdMs: number;
  /**
   * Context-management safety net. When `true`, a session that fires Claude
   * Code's `Notification` hook (i.e. it is blocked waiting on input) gets an
   * auto-`/compact` armed at its next idle boundary — a backstop for agents
   * that pause without calling `team.context_compact` themselves. Default
   * `false`: the agent-driven path is primary. Env: `SWARM_OS_COMPACT_ON_WAITING`.
   */
  contextCompactOnWaiting: boolean;
  /**
   * Context-management safety net. Coarse proxy for "context is getting huge":
   * cumulative bytes of PTY output a session emits since its last reset. Past
   * this, an auto-`/compact` is armed at the next idle boundary. `0` disables
   * it (default). Env: `SWARM_OS_AUTO_COMPACT_BYTES`.
   */
  contextAutoCompactBytes: number;
  /**
   * Monitoring (docs/monitoring-agents.md, Lot 2) — how long a session's
   * context-usage snapshot is served before the next transcript tail read.
   *
   * There is no timer: the read is triggered by `Orchestrator.toView()`, i.e.
   * by the UI's existing 3 s `/orchestrators` poll, so this is what keeps the
   * poll from turning into one file read per session per 3 s. Two server-side
   * reads bypass it, both events rather than a schedule: an agent's idle
   * boundary (once per turn) and its exit (once per life) — they keep the
   * per-call ledger and the token totals complete with no browser open. `0`
   * disables the tracker entirely — nothing is ever read, every gauge shows `—`
   * and no call is recorded. Default 15 000. Env: `SWARM_OS_CONTEXT_USAGE_TTL_MS`.
   */
  contextUsageTtlMs: number;
  /**
   * Auto-compact (docs/auto-compact.md, D6) — the INSTANCE default threshold,
   * in PERCENT of the model's context window (0..100), past which the server
   * arms a `/compact` on an agent that has gone idle with an empty inbox.
   *
   * This is only the fallback: the resolution at each idle boundary is
   * `role.autoCompactPct ?? config.autoCompactPct`, read live from the role
   * store, so a role editing its threshold applies at the next boundary of
   * every one of its agents — no restart, which matters on a 24/7 fleet. On a
   * role, `null` means "inherit this value" and `0` means "never compact this
   * role".
   *
   * `0` here is the kill switch: every role that inherits stops being
   * auto-compacted at all (i.e. the whole fleet, unless a role carries its own
   * non-zero threshold, which still wins — an explicit per-role setting is an
   * instruction, not a suggestion).
   *
   * Default 35. A value that is not an integer in 0..100 falls back to 35 with
   * a `warn` at boot rather than failing the boot — see `autoCompactPctEnv`.
   * Env: `SWARM_OS_AUTO_COMPACT_PCT`.
   *
   * Since v0.10.1 this is the LEAD's threshold only; workers have their own
   * (`workerAutoCompactPct` below, docs/auto-compact.md §8.2).
   */
  autoCompactPct: number;
  /**
   * Auto-compact (docs/auto-compact.md §8.2, v0.10.1) — the INSTANCE default
   * threshold for WORKERS, in percent of the context window (0..100).
   *
   * Same resolution as the lead's, on the role's second field:
   * `role.workerAutoCompactPct ?? config.workerAutoCompactPct`, read live at
   * every boundary. Default **0 = disabled**: workers run short, linear tasks
   * and their reset is their lead's decision (`team.clear_worker`), so a
   * threshold compacting them in the middle of a delegation was noise at best.
   * A role can still opt its workers in with its own non-zero value.
   *
   * A value that is not an integer in 0..100 falls back to 0 with a `warn` at
   * boot, same leniency as `autoCompactPct`. Env:
   * `SWARM_OS_WORKER_AUTO_COMPACT_PCT`.
   */
  workerAutoCompactPct: number;
  /**
   * docs/auto-compact.md §8.1 (D9, v0.10.1) — after each `/compact` the server
   * fired (auto-compact, `team.context_compact`, `team.clear_worker
   * { compact: true }`, the operator's COMPACT, the byte / waiting backstops),
   * type ONE "resume what you were doing" line into the agent's PTY at the
   * first idle boundary after the compaction, folded together with the inbox
   * signal when mail is waiting. A `/compact` hands back an empty prompt, and
   * without it the work in progress never resumes until a human types
   * "continue". Never after `/clear` — a wiped agent is idle on purpose.
   *
   * Default `true`. `0` / `false` / `no` / `off` disable it; an unreadable
   * value keeps it ON with a `warn` at boot (see `continueAfterCompactEnv`).
   * Env: `SWARM_OS_CONTINUE_AFTER_COMPACT`.
   */
  continueAfterCompact: boolean;
  /**
   * Hot-backup interval in ms. The server takes an online SQLite snapshot of
   * `swarm-os.db` into `<dataDir>/backups/` every `backupIntervalMs`. Since
   * `/data` is bind-mounted, snapshots land on the host. `0` disables the
   * scheduler. Default 6h. Env: `SWARM_OS_BACKUP_INTERVAL_MS`.
   */
  backupIntervalMs: number;
  /**
   * How many of the newest snapshots to retain; older ones are pruned each
   * run. `0` disables backups (same as `backupIntervalMs=0`). Default 14.
   * Env: `SWARM_OS_BACKUP_KEEP`.
   */
  backupKeep: number;
  /**
   * Task board (docs/tableau-de-taches.md) — how long (ms) an ORPHANED card
   * (assignee vanished after a crash/restart) is kept before the TTL janitor
   * soft-deletes it. The operator can still delete it sooner from the web. `0`
   * disables the janitor. Default 7 days. Env: `SWARM_OS_TASKBOARD_ORPHAN_TTL_MS`.
   */
  taskboardOrphanTtlMs: number;
  /**
   * Task board — how often (ms) the orphan-card TTL janitor sweeps. `0` disables
   * it. Default 6h (same cadence as the backup scheduler). Env:
   * `SWARM_OS_TASKBOARD_JANITOR_INTERVAL_MS`.
   */
  taskboardJanitorIntervalMs: number;
  /**
   * Approval gate (docs/garde-fous-approbation.md, P5) — how long (ms) a
   * still-`pending` approval is kept before the TTL janitor flags it `expired`
   * (a cleanup flag ONLY — never an auto-decision; the timeout policy is "leave
   * pending"). `0` disables the janitor. Default 7 days. Env:
   * `SWARM_OS_APPROVAL_ORPHAN_TTL_MS`.
   */
  approvalOrphanTtlMs: number;
  /**
   * Approval gate — how often (ms) the pending-approval TTL janitor sweeps. `0`
   * disables it. Default 6h (same cadence as the taskboard janitor). Env:
   * `SWARM_OS_APPROVAL_JANITOR_INTERVAL_MS`.
   */
  approvalJanitorIntervalMs: number;
  /**
   * Dead-worker session reaper (modules/orchestrator/reaper) — how often (ms)
   * the reaper sweeps live teams for terminal workers (killed/exited/failed)
   * whose ROLE opted into auto-removal and whose terminal age exceeds the
   * role's delay. `0` disables the reaper entirely. Default 60000 (1 min).
   * Env: `SWARM_OS_SESSION_REAPER_INTERVAL_MS`.
   */
  sessionReaperIntervalMs: number;
  /**
   * Cost-budget watch (modules/orchestrator/budget-watch) — how often (ms) the
   * janitor compares each live team's cumulative spend (Lot 12 DB aggregate,
   * removed workers included) against its ROLE's `costBudgetUsd`, and on a
   * first crossing emits `session.budget_exceeded`, posts to Discord and — when
   * the role says `pause` — SIGSTOPs the whole team. `0` disables it entirely
   * (`GET /metrics/costs` still reports `budget.exceeded`; only the acting
   * stops). Default 60000 (1 min). Env: `SWARM_OS_BUDGET_CHECK_INTERVAL_MS`.
   */
  budgetCheckIntervalMs: number;
  /**
   * Daily cost roll-up (modules/orchestrator/cost-rollup) — how often (ms) the
   * janitor files each live agent's token delta into `session_token_daily`, the
   * table the long-trend charts and `GET /metrics/costs/export` read. `0`
   * disables it entirely (the export then returns whatever history is already
   * there, and stops growing). Default 3600000 (1 h): the ledger's resolution is
   * the DAY, so a finer cadence would buy nothing but writes — and nothing is
   * lost at this one, since each tick files what the previous did not.
   * Env: `SWARM_OS_COST_ROLLUP_INTERVAL_MS`.
   */
  costRollupIntervalMs: number;
  /**
   * Cron scheduler (modules/crons): master switch. When `true` (default),
   * every non-paused row of the `crons` table gets an in-process croner job
   * that delivers a message — or runs a script that decides — to the lead
   * inbox of every live instance of the cron's role. `false` disarms every
   * job; a manual fire (`POST /crons/:id/fire`) still works, being an explicit
   * operator gesture. Env: `SWARM_OS_SCHEDULE_ENABLED` (name kept for
   * compatibility — renaming it would break existing deployments).
   */
  scheduleEnabled: boolean;
  /**
   * IANA timezone every cron expression is evaluated in. Default `UTC` —
   * explicit so cadence does not drift with the container's TZ. Also exported
   * to script crons as `TZ`, so a script computing "today" agrees with the
   * schedule that woke it. Env: `SWARM_OS_SCHEDULE_TZ`.
   */
  scheduleTimezone: string;
  /**
   * Codegraph (Graphify integration, P1): master switch. When `true` (default)
   * the server discovers code scopes and keeps a background code-knowledge-graph
   * per scope. Auto-disables at runtime if the graphify binary is absent — the
   * boot never fails on it. Env: `SWARM_OS_CODEGRAPH_ENABLED`.
   */
  codegraphEnabled: boolean;
  /** graphify binary name/path (resolved on PATH). Env: `SWARM_OS_CODEGRAPH_BIN`. */
  codegraphBin: string;
  /**
   * Extraction engine: `ast` (default, on-device, 0-token) or `extract`
   * (LLM-enriched, needs an API key — opt-in). Env: `SWARM_OS_CODEGRAPH_ENGINE`.
   */
  codegraphEngine: 'ast' | 'extract';
  /**
   * How often (ms) the codegraph janitor sweeps for changed scopes. `0` disables
   * the janitor. Default 3 min. Env: `SWARM_OS_CODEGRAPH_JANITOR_INTERVAL_MS`.
   */
  codegraphJanitorIntervalMs: number;
  /** Per-run graphify timeout (ms). Env: `SWARM_OS_CODEGRAPH_TIMEOUT_MS`. */
  codegraphTimeoutMs: number;
  token: string;
  /**
   * Phase 4: separate token used by Claude Code's `Notification` hook to
   * authenticate against `/hooks/notification`. **Distinct** from `token`
   * (the user-facing X-Auth-Token) per plan §13/§14. Read from `HOOK_TOKEN`
   * env, otherwise generated and persisted at `<dataDir>/hook-token` (mode 0600).
   */
  hookToken: string;
  /**
   * Phase 4: Discord webhook URL. Optional — when absent the notifier is a
   * no-op (only logs). Plan §13 marks this as the only switch between
   * `DiscordWebhookNotifier` and `NoOpNotifier`.
   */
  discordWebhookUrl: string | null;
  /**
   * Phase 4: public URL of the swarm-os UI (e.g. `https://swarm.tail-xyz.ts.net:8787`).
   * Optional — used for Discord embed deep-links. **Never** carries any token.
   */
  publicUrl: string | null;
  /**
   * Phase 4: log level for pino — `debug|info|warn|error`. Default `info`.
   */
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /**
   * Phase 4: when true, pino emits human-readable lines via `pino-pretty`
   * (dev only). Otherwise structured JSON. Defaults to true if NODE_ENV !==
   * 'production' AND stdout is a TTY.
   */
  logPretty: boolean;
  /**
   * Phase 8: auto-resume teams from SQLite on boot. When false, the legacy
   * recovery path runs (mark all non-terminal as interrupted, no respawn).
   * Default `true`. Env `SWARM_OS_AUTO_RESUME`.
   */
  autoResume: boolean;
  /**
   * Phase 8: delay (ms) between successive PTY spawns during auto-resume.
   * Applied between orchs AND between worker spawns within an orch. Avoids
   * `/data/.claude-runtime` contention + claude-cli startup CPU spikes when
   * resuming many teams at once. Default 150ms. Env
   * `SWARM_OS_RESUME_STAGGER_MS`.
   */
  resumeStaggerMs: number;
  /**
   * Phase 8: how long (ms) to suppress Discord notifications after auto-
   * resume. Agents waking up after a restart commonly need an input prompt
   * within seconds; without this mute window, N restarted teams would emit
   * N `session.waiting` notifications and rate-limit the webhook. Default
   * 60000ms. Env `SWARM_OS_NOTIFY_QUIET_AFTER_BOOT_MS`.
   */
  notifyQuietAfterBootMs: number;
  /**
   * Transport for agent processes. When `ssh`, claude is launched on the host
   * VM via SSH instead of inside this process' namespace. See `AgentTransport`.
   * Env: `SWARM_OS_AGENT_TRANSPORT`, default `local`.
   */
  agentTransport: AgentTransport;
  /**
   * SSH destination for `agentTransport=ssh` (e.g. `ubuntu@host.docker.internal`).
   * Required when transport is `ssh`. Env: `SWARM_OS_SSH_TARGET`.
   */
  sshTarget: string | null;
  /**
   * SSH private key path inside this process' filesystem. Defaults to
   * `/host-ssh/id_ed25519` (matches the docker-compose `${HOME}/.ssh:/host-ssh:ro`
   * mount). Env: `SWARM_OS_SSH_KEY`.
   */
  sshKey: string;
  /** SSH port on the host. Default 22. Env: `SWARM_OS_SSH_PORT`. */
  sshPort: number;
  /**
   * Host-side path that corresponds to `dataDir` (mounted via bind). Required
   * when `agentTransport=ssh` so per-session config dirs + mcp.json paths can
   * be translated into paths the host claude can resolve.
   * Env: `SWARM_OS_HOST_DATA_DIR`.
   */
  hostDataDir: string | null;
  /**
   * Host-side `~/.claude` path (e.g. `/home/ubuntu/.claude`). Used in SSH mode
   * to point per-session symlinks (`.credentials.json`, `history.jsonl`, …) at
   * the host's real files rather than a container-side copy. Default
   * `/home/ubuntu/.claude`. Env: `SWARM_OS_HOST_CLAUDE_DIR`.
   */
  hostClaudeDir: string;
  /**
   * Host-side `~/.codex` — the codex adapter's equivalent of `hostClaudeDir`
   * (SSH transport only). Env: `SWARM_OS_HOST_CODEX_DIR`, default
   * `<host home>/.codex`.
   */
  hostCodexDir: string;
  /**
   * Host-side `~/.gemini`. Env: `SWARM_OS_HOST_GEMINI_DIR`, default
   * `<host home>/.gemini`.
   */
  hostGeminiDir: string;
  /**
   * Which authentication method a gemini session pins in its own
   * `settings.json` (`security.auth.selectedType`). Env:
   * `SWARM_OS_GEMINI_AUTH_TYPE`, default `null` = let the adapter decide.
   *
   * It exists because under the SSH transport the adapter CANNOT decide
   * correctly: the host's `~/.gemini` is not mounted, so whether
   * `oauth_creds.json` exists there is unknowable from the container, and gemini
   * offers no "pick whichever works" mode — an unpinned `selectedType` opens the
   * auth-method picker, a modal that keeps the Ink renderer repainting so the
   * agent is never idle, never gets its messages and never gets reset. See
   * `providers/gemini.ts` (`_selectAuthType`) for the fallback and the trade-off.
   *
   * Set it to what the host is actually logged in with: `oauth-personal` after a
   * `gemini` browser login, `gemini-api-key` when the host exports
   * `GEMINI_API_KEY` (or has a key in its keychain).
   */
  geminiAuthType: string | null;
  /**
   * Host-side `~/.local/share/opencode` equivalent — kept as a single knob
   * until spike S3 pins down opencode's real config root. Env:
   * `SWARM_OS_HOST_OPENCODE_DIR`, default `<host home>/.opencode`.
   */
  hostOpencodeDir: string;
  /**
   * Host-side path matching `workspaceRoot` (container `/workspace`). Required
   * in SSH mode so a cwd stored in DB as `/workspace/foo` (the existing API
   * convention) can be translated to its host equivalent before being passed
   * as the remote `cd` target. Env: `SWARM_OS_HOST_WORKSPACE_ROOT`.
   */
  hostWorkspaceRoot: string | null;
  /**
   * VS Code web (official Microsoft `code serve-web`) integration master
   * switch. When `true` (default), a `code serve-web` child process is
   * launched in-container and exposed on its own port (see `idePort`); the
   * web UI surfaces an IDE overlay on `/workspace`. Env `SWARM_OS_IDE_ENABLED`.
   */
  ideEnabled: boolean;
  /**
   * Loopback port the in-container `code serve-web` listens on. NOT exposed:
   * the main HTTP server reverse-proxies it under `ideBasePath` so the editor
   * rides on the existing single ingress (port 8787 + its TLS). serve-web is
   * launched with `--server-base-path <ideBasePath>` so all its asset URLs are
   * emitted under that prefix (verified). Env `SWARM_OS_IDE_PORT`, default 8790.
   */
  idePort: number;
  /**
   * URL path the VS Code web UI is mounted under, on the SAME origin as the
   * app (e.g. `/ide` → `https://<host>:8787/ide`). Used by: the serve-web
   * `--server-base-path` flag, the Express reverse-proxy mount, and the
   * iframe URL the web client builds. Env `SWARM_OS_IDE_BASE_PATH`, default
   * `/ide`. Must start with `/` and have no trailing slash.
   */
  ideBasePath: string;
  /**
   * Connection-token guarding the IDE port. **Distinct** from `token` (the
   * user-facing X-Auth-Token): the IDE iframe is a browser navigation and
   * cannot send the X-Auth-Token header, so serve-web's own connection-token
   * is the guard. Generated + persisted at `<dataDir>/ide-token` (mode 0600)
   * unless supplied via `SWARM_OS_IDE_TOKEN`. Handed to the authenticated web
   * client via `GET /ide-info`.
   */
  ideToken: string;
  /** Absolute path to the standalone VS Code CLI binary (`code`). The
   *  Dockerfile installs it at `/opt/vscode-cli/code`. Env `SWARM_OS_VSCODE_CLI`. */
  ideCliPath: string;
  /** serve-web `--server-data-dir`: user settings + installed extensions.
   *  Under `<dataDir>/ide` so it persists across container restarts. */
  ideServerDataDir: string;
  /** `VSCODE_CLI_DATA_DIR` for the VS Code CLI — where it downloads the web
   *  server payload (`.../serve-web/<commit>/`). Defaults to `$HOME/.vscode/cli`
   *  which is EPHEMERAL in the container, so we redirect it under `<dataDir>/ide`
   *  to persist the (large) payload across container recreations — otherwise
   *  every redeploy re-downloads it and shows serve-web's "downloading latest
   *  version" interstitial. */
  ideCliDataDir: string;
  startedAt: string;
  /**
   * Version this instance reports on `/info`. Resolved by `resolveVersion()` —
   * env first (baked into the image), monorepo root `package.json` second.
   * NEVER hardcoded: a literal here drifts from the release tag silently,
   * which is exactly what happened between Phase 6 and v0.5.0.
   */
  version: string;
  /**
   * Git SHA the image was built from (`SWARM_OS_COMMIT`, set by the
   * Dockerfile from `--build-arg GIT_SHA`). `null` outside a built image.
   */
  commit: string | null;
  /**
   * Image reference this deployment was started from (`SWARM_OS_IMAGE`, the
   * same var the dist compose interpolates into `image:`). `null` when the
   * compose hardcodes a tag — which is the honest answer, and matches the
   * `image_not_interpolated` self-update eligibility case.
   */
  image: string | null;
}

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMS: ReadonlySet<string> = new Set([
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Env ${name} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

/**
 * Instance default for the auto-compact threshold, in percent of the context
 * window (docs/auto-compact.md D6). Exported so the roles route can serve the
 * same number to the web form that the orchestrator resolves against, and so
 * the figure lives in exactly one place.
 */
export const DEFAULT_AUTO_COMPACT_PCT = 35;

/**
 * Instance default for the WORKERS' auto-compact threshold (docs/auto-compact.md
 * §8.2): `0`, i.e. workers are not auto-compacted unless a role or
 * `SWARM_OS_WORKER_AUTO_COMPACT_PCT` says otherwise. Exported for the same
 * reason as `DEFAULT_AUTO_COMPACT_PCT`: the roles route serves it to the web.
 */
export const DEFAULT_WORKER_AUTO_COMPACT_PCT = 0;

/**
 * Read `SWARM_OS_AUTO_COMPACT_PCT` as an integer percentage 0..100.
 *
 * Deliberately NOT `intEnv`: that one THROWS on a bad value, which is right for
 * the knobs it guards (ports, sizes, caps — a wrong number there is worse than
 * no boot). This one is a tuning parameter on a fleet that runs 24/7, and
 * taking the server down over a typo in a percentage would be a far worse
 * outcome than running at the documented default. So anything that is not an
 * integer in 0..100 — `"35%"`, `3.5`, `-1`, `200` — degrades to
 * `DEFAULT_AUTO_COMPACT_PCT` and says so once, loudly, at boot.
 *
 * `0` is a VALID value (the kill switch), not a rejected one; only an unset or
 * empty var falls through silently to the default.
 */
function autoCompactPctEnv(): number {
  return pctEnv(
    'SWARM_OS_AUTO_COMPACT_PCT',
    DEFAULT_AUTO_COMPACT_PCT,
    'config.auto_compact_pct_invalid',
  );
}

/**
 * `SWARM_OS_WORKER_AUTO_COMPACT_PCT` (docs/auto-compact.md §8.2) — the same
 * lenient reading as `autoCompactPctEnv`, falling back to `0` (off), with its
 * own warn event so the two knobs can be told apart in the boot log.
 */
function workerAutoCompactPctEnv(): number {
  return pctEnv(
    'SWARM_OS_WORKER_AUTO_COMPACT_PCT',
    DEFAULT_WORKER_AUTO_COMPACT_PCT,
    'config.worker_auto_compact_pct_invalid',
  );
}

/** The shared body of the two readers above. */
function pctEnv(name: string, fallback: number, invalidEvent: string): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    withModule('config').warn({
      event: invalidEvent,
      value: raw,
      fallback,
      reason: `${name} must be an integer between 0 and 100`,
    });
    return fallback;
  }
  return n;
}

/**
 * Read `SWARM_OS_CONTINUE_AFTER_COMPACT` (docs/auto-compact.md §8.1). Default ON.
 *
 * Deliberately NOT `boolEnv`, for the reason `autoCompactPctEnv` gives: this is
 * a behaviour switch on a 24/7 fleet, and a typo (`"flase"`) must not keep the
 * server from booting. The usual spellings are honoured both ways; anything
 * else keeps the documented default and says so once, loudly.
 */
function continueAfterCompactEnv(): boolean {
  const raw = process.env.SWARM_OS_CONTINUE_AFTER_COMPACT;
  if (raw == null || raw.trim() === '') return true;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  withModule('config').warn({
    event: 'config.continue_after_compact_invalid',
    value: raw,
    fallback: true,
    reason: 'SWARM_OS_CONTINUE_AFTER_COMPACT must be a boolean (true/false/1/0)',
  });
  return true;
}

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new Error(`Env ${name} must be a boolean (true/false/1/0), got: ${raw}`);
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function loadOrCreateToken(dataDir: string): string {
  const explicit = process.env.SWARM_OS_TOKEN;
  if (explicit && explicit.length > 0) return explicit;

  const tokenPath = path.join(dataDir, 'token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* fall through */
  }
  const fresh = crypto.randomUUID();
  fs.writeFileSync(tokenPath, fresh + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* best-effort */
  }
  return fresh;
}

/**
 * Phase 4: separate hook token (plan §13/§14). MUST NOT collapse with
 * `SWARM_OS_TOKEN` — the Notification hook payload travels through Claude's
 * `settings.json` which lives on disk and is read by the claude subprocess;
 * keeping the user token out of that path is a defence-in-depth requirement.
 *
 * Persisted at `<dataDir>/hook-token` (mode 0600).
 */
function loadOrCreateHookToken(dataDir: string): string {
  const explicit = process.env.HOOK_TOKEN;
  if (explicit && explicit.length > 0) return explicit;

  const tokenPath = path.join(dataDir, 'hook-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* fall through */
  }
  const fresh = crypto.randomUUID();
  fs.writeFileSync(tokenPath, fresh + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* best-effort */
  }
  return fresh;
}

/**
 * Connection-token guarding the VS Code web port. Kept SEPARATE from
 * `SWARM_OS_TOKEN` for the same defence-in-depth reason as the hook token:
 * it travels through the IDE iframe URL (`?tkn=`) and serve-web's cookie, a
 * different trust path than the user-facing X-Auth-Token. Persisted at
 * `<dataDir>/ide-token` (mode 0600).
 */
function loadOrCreateIdeToken(dataDir: string): string {
  const explicit = process.env.SWARM_OS_IDE_TOKEN;
  if (explicit && explicit.length > 0) return explicit;

  const tokenPath = path.join(dataDir, 'ide-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* fall through */
  }
  const fresh = crypto.randomUUID();
  fs.writeFileSync(tokenPath, fresh + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* best-effort */
  }
  return fresh;
}

/**
 * The one place that answers "what version is this?".
 *
 * Production (container): `SWARM_OS_VERSION`, baked by the Dockerfile from
 * `--build-arg APP_VERSION` (CI passes the git tag). For a published image
 * this is the ONLY source of truth. `ENV SWARM_OS_VERSION=${APP_VERSION}` with
 * no build-arg yields the empty string, so empty MUST read as "unset" rather
 * than as a version.
 *
 * Dev (`pnpm dev`, vitest, `node dist/index.js` from a checkout): the
 * **monorepo root** `package.json`. Emphatically NOT the `package.json` next
 * to `dist/`: `pnpm --filter=server deploy --prod` ships `server@0.0.0` into
 * the image, so reading the nearest manifest would report `0.0.0` in
 * production and silently reintroduce the very drift this function exists to
 * kill. The root manifest is also what the `Release:` commits bump, so the
 * anti-drift test has something real to compare against.
 *
 * One relative path serves every layout because `src/config.ts` and
 * `dist/config.js` sit at the same depth (`rootDir: src` / `outDir: dist` in
 * packages/server/tsconfig.json). Inside the image it resolves to
 * `/home/package.json`, which does not exist — and there `SWARM_OS_VERSION` is
 * always set, so the fallback never fires.
 */
function resolveVersion(): string {
  const fromEnv = process.env.SWARM_OS_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const rootPkg = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'package.json',
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(rootPkg, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    // Name guard: if the tree layout ever moves, report 'dev' rather than a
    // stranger's version number picked up from whatever package.json landed
    // three levels up.
    if (parsed.name === 'swarm-os' && typeof parsed.version === 'string' && parsed.version) {
      return parsed.version;
    }
  } catch {
    /* not a source checkout — fall through to 'dev' */
  }
  return 'dev';
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const port = intEnv('SWARM_OS_PORT', 8787);
  const host = process.env.SWARM_OS_HOST ?? '127.0.0.1';
  const mcpPort = intEnv('SWARM_OS_MCP_PORT', 8788);
  // Where the agents' hooks POST back. Under the ssh transport the hook curl
  // runs on the host, so the container-internal `127.0.0.1:<port>` default is
  // wrong there — the ssh compose files must point this at the host-mapped port.
  const hookUrl = (process.env.SWARM_OS_HOOK_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');

  // Project name is technically required, but for `pnpm dev` convenience we default to 'dev'.
  const projectName = process.env.SWARM_OS_PROJECT_NAME ?? 'dev';

  const effortRaw = process.env.SWARM_OS_DEFAULT_EFFORT ?? 'xhigh';
  if (!VALID_EFFORTS.has(effortRaw)) {
    throw new Error(
      `SWARM_OS_DEFAULT_EFFORT must be one of low|medium|high|xhigh|max, got: ${effortRaw}`,
    );
  }
  const defaultEffort = effortRaw as EffortLevel;

  const permRaw = process.env.SWARM_OS_DEFAULT_PERMISSION_MODE ?? 'bypassPermissions';
  if (!VALID_PERMS.has(permRaw)) {
    throw new Error(`SWARM_OS_DEFAULT_PERMISSION_MODE invalid: ${permRaw}`);
  }
  const defaultPermissionMode = permRaw as PermissionMode;

  // Instance-wide default agent provider. Validated against the built-in ids
  // (see modules/providers/ids.ts): a typo here would otherwise surface much
  // later as "every team falls back to claude", silently.
  const providerRaw = process.env.SWARM_OS_DEFAULT_PROVIDER ?? DEFAULT_PROVIDER_ID;
  if (!(BUILTIN_PROVIDER_IDS as readonly string[]).includes(providerRaw)) {
    throw new Error(
      `SWARM_OS_DEFAULT_PROVIDER must be one of ${BUILTIN_PROVIDER_IDS.join('|')}, got: ${providerRaw}`,
    );
  }
  const defaultProvider = providerRaw as BuiltinProviderId;

  // Resolved AFTER the provider, and from it: a model id only means something
  // to the CLI it was written for. `SWARM_OS_DEFAULT_MODEL` unset used to mean
  // `claude-opus-4-8` whatever the provider, so the documented pair
  // (`SWARM_OS_DEFAULT_PROVIDER=codex`, no model) handed EVERY team and EVERY
  // worker on the instance a claude id on a foreign CLI — and no downstream
  // guard could catch it, since the config layer legitimately IS the codex
  // layer. The operator's explicit value is still taken verbatim and never
  // validated (`docs/providers.md`: ids ship faster than our releases).
  const defaultModel =
    process.env.SWARM_OS_DEFAULT_MODEL ?? BUILTIN_PROVIDER_DEFAULT_MODELS[defaultProvider];
  // Whether the value above came from the operator or from the built-in floor.
  // See `Config.defaultModelExplicit`: an empty string counts as UNSET, because
  // `providers/resolve.ts` already treats `''` as "named nothing" and the two
  // must not disagree about what an empty env var means.
  const defaultModelExplicit = (process.env.SWARM_OS_DEFAULT_MODEL ?? '').length > 0;

  const maxOrchestrators = intEnv('SWARM_OS_MAX_ORCHESTRATORS', 10);
  const maxPromptSizeKb = intEnv('SWARM_OS_MAX_PROMPT_SIZE_KB', 64);
  const claudeStartTimeoutS = intEnv('SWARM_OS_CLAUDE_START_TIMEOUT_S', 30);

  // Phase 3 envelopes (plan §13).
  const maxWorkersPerOrch = intEnv('SWARM_OS_MAX_WORKERS_PER_ORCH', 20);
  const maxMessageSizeKb = intEnv('SWARM_OS_MAX_MESSAGE_SIZE_KB', 16);
  const maxInboxSize = intEnv('SWARM_OS_MAX_INBOX_SIZE', 100);
  // Idle detection threshold in ms. Plan §11 fixes the canonical value at
  // 2000 ms ; we expose it as an env so tests can drop it to ~50 ms without
  // racing.
  const idleThresholdMs = intEnv('SWARM_OS_IDLE_THRESHOLD_MS', 2000);
  // Context-management safety nets (agent-driven path is primary; these are
  // backstops). Both default to "off" so behaviour is unchanged unless opted in.
  const contextCompactOnWaiting = boolEnv('SWARM_OS_COMPACT_ON_WAITING', false);
  const contextAutoCompactBytes = intEnv('SWARM_OS_AUTO_COMPACT_BYTES', 0);
  // Monitoring — TTL of the per-session context-usage snapshot. Rides the
  // existing 3 s poll (no timer of its own); `0` turns the tracker off.
  const contextUsageTtlMs = intEnv('SWARM_OS_CONTEXT_USAGE_TTL_MS', 15_000);
  // Auto-compact (docs/auto-compact.md D6) — instance default threshold, in
  // percent of the context window, for roles that do not carry their own.
  // ON by default at 35: the agent-driven path exists but agents forget, and
  // the whole point of the feature is that nobody has to remember. `0` is the
  // kill switch.
  const autoCompactPct = autoCompactPctEnv();
  // docs/auto-compact.md §8.2 (v0.10.1) — workers get their own threshold, OFF
  // by default: short linear tasks, reset by their lead, not by a percentage.
  const workerAutoCompactPct = workerAutoCompactPctEnv();
  // docs/auto-compact.md §8.1 (v0.10.1) — "resume" line after each `/compact`.
  const continueAfterCompact = continueAfterCompactEnv();

  // Hot SQLite backup scheduler (in-process; writes to <dataDir>/backups).
  const backupIntervalMs = intEnv('SWARM_OS_BACKUP_INTERVAL_MS', 6 * 60 * 60 * 1000);
  const backupKeep = intEnv('SWARM_OS_BACKUP_KEEP', 14);

  // Task board TTL janitor (in-process; modules/taskboard/lifecycle). Orphaned
  // cards are kept 7 days by default so the operator sees what a restart
  // stranded, then swept every 6h.
  const taskboardOrphanTtlMs = intEnv('SWARM_OS_TASKBOARD_ORPHAN_TTL_MS', 7 * 24 * 60 * 60 * 1000);
  const taskboardJanitorIntervalMs = intEnv(
    'SWARM_OS_TASKBOARD_JANITOR_INTERVAL_MS',
    6 * 60 * 60 * 1000,
  );

  // Approval-gate TTL janitor (in-process; modules/approvals/lifecycle). Pending
  // approvals whose prompt was never answered are flagged `expired` after 7 days
  // by default (cleanup flag ONLY — never an auto-deny), swept every 6h.
  const approvalOrphanTtlMs = intEnv('SWARM_OS_APPROVAL_ORPHAN_TTL_MS', 7 * 24 * 60 * 60 * 1000);
  const approvalJanitorIntervalMs = intEnv(
    'SWARM_OS_APPROVAL_JANITOR_INTERVAL_MS',
    6 * 60 * 60 * 1000,
  );

  // Dead-worker session reaper (in-process; modules/orchestrator/reaper). Sweeps
  // live teams every minute by default and hides terminal workers whose ROLE
  // opted in and whose terminal age passed the role's delay. `0` disables it.
  const sessionReaperIntervalMs = intEnv('SWARM_OS_SESSION_REAPER_INTERVAL_MS', 60 * 1000);

  // Cost-budget watch (in-process; modules/orchestrator/budget-watch). Same
  // cadence as the reaper: one aggregate query per tick, and a minute is the
  // right resolution for a bill that moves in dollars per hour. `0` disables it.
  const budgetCheckIntervalMs = intEnv('SWARM_OS_BUDGET_CHECK_INTERVAL_MS', 60 * 1000);

  // Daily cost roll-up (in-process; modules/orchestrator/cost-rollup). Hourly,
  // NOT per minute like the two above: this one WRITES, its output has a
  // one-day resolution, and a delta missed by a tick is picked up whole by the
  // next (the watermark lives in SQLite). `0` disables it.
  const costRollupIntervalMs = intEnv('SWARM_OS_COST_ROLLUP_INTERVAL_MS', 60 * 60 * 1000);

  // Cron scheduler (in-process; modules/crons). Env names predate the move
  // from a per-role cadence to first-class crons and are kept as-is.
  const scheduleEnabled = boolEnv('SWARM_OS_SCHEDULE_ENABLED', true);
  const scheduleTimezone = process.env.SWARM_OS_SCHEDULE_TZ ?? 'UTC';

  // Codegraph (Graphify integration). Feature is optional and auto-disables at
  // runtime if the graphify binary is absent (index.ts probes at boot).
  const codegraphEnabled = boolEnv('SWARM_OS_CODEGRAPH_ENABLED', true);
  const codegraphBin = process.env.SWARM_OS_CODEGRAPH_BIN ?? 'graphify';
  const codegraphEngine: 'ast' | 'extract' =
    process.env.SWARM_OS_CODEGRAPH_ENGINE === 'extract' ? 'extract' : 'ast';
  const codegraphJanitorIntervalMs = intEnv(
    'SWARM_OS_CODEGRAPH_JANITOR_INTERVAL_MS',
    3 * 60 * 1000,
  );
  const codegraphTimeoutMs = intEnv('SWARM_OS_CODEGRAPH_TIMEOUT_MS', 5 * 60 * 1000);

  const workspaceRoot = path.resolve(process.env.SWARM_OS_WORKSPACE_ROOT ?? '/workspace');
  const dataDir = path.resolve(process.env.SWARM_OS_DATA_DIR ?? '/data');

  // Ensure dataDir exists before token read/generate.
  ensureDir(dataDir);
  const logsDir = path.join(dataDir, 'logs');
  ensureDir(logsDir);
  // Plugin drop-in root (`/data/plugins/<name>/`). Created here so the
  // PluginHost can scan it at boot; the host owns everything under it.
  ensureDir(path.join(dataDir, 'plugins'));

  // Phase 5 — claude source (RO mount or host dir for dev) and runtime root
  // (RW per-container copy). The runtime dir is created here so downstream
  // modules can rely on its existence; the actual content copy happens in
  // `runtime/claude-init.ts` at boot.
  const claudeSourceDir = path.resolve(
    process.env.SWARM_OS_CLAUDE_SOURCE_DIR ?? '/claude-source',
  );
  const claudeRuntimeDir = path.resolve(
    process.env.SWARM_OS_CLAUDE_RUNTIME_DIR ?? path.join(dataDir, '.claude-runtime'),
  );
  ensureDir(claudeRuntimeDir);
  try {
    fs.chmodSync(claudeRuntimeDir, 0o700);
  } catch {
    /* best-effort: filesystem may not honour chmod */
  }
  // Phase 6 — `.claude.json` lift source override (optional).
  const claudeJsonSource =
    process.env.SWARM_OS_CLAUDE_JSON_SOURCE && process.env.SWARM_OS_CLAUDE_JSON_SOURCE.length > 0
      ? path.resolve(process.env.SWARM_OS_CLAUDE_JSON_SOURCE)
      : null;

  const token = loadOrCreateToken(dataDir);
  const hookToken = loadOrCreateHookToken(dataDir);

  // VS Code web (`code serve-web`) — own port, own connection-token. State
  // (server payload, settings, extensions) lives under <dataDir>/ide so it
  // persists across container restarts (the /data volume is bind-mounted).
  const ideEnabled = boolEnv('SWARM_OS_IDE_ENABLED', true);
  const idePort = intEnv('SWARM_OS_IDE_PORT', 8790);
  // Normalise base path: ensure a leading '/', strip any trailing '/'.
  let ideBasePath = process.env.SWARM_OS_IDE_BASE_PATH ?? '/ide';
  if (!ideBasePath.startsWith('/')) ideBasePath = '/' + ideBasePath;
  ideBasePath = ideBasePath.replace(/\/+$/, '') || '/ide';
  const ideToken = loadOrCreateIdeToken(dataDir);
  const ideCliPath = process.env.SWARM_OS_VSCODE_CLI ?? '/opt/vscode-cli/code';
  const ideServerDataDir = path.join(dataDir, 'ide', 'server-data');
  const ideCliDataDir = path.join(dataDir, 'ide', 'cli');
  // Pre-create UNCONDITIONALLY so the serve-web child never races a missing dir
  // on first spawn. `ideEnabled` is now only a first-boot seed default for the
  // feature registry (built after the DB), so config time can't know the IDE's
  // live state — pre-creating two empty dirs on the /data volume is benign, and
  // the supervisor also mkdir's defensively before spawning.
  for (const d of [ideServerDataDir, ideCliDataDir]) {
    try {
      ensureDir(d);
    } catch {
      /* best-effort */
    }
  }

  // Phase 4 — Discord webhook + public URL (plan §12/§13).
  const discordWebhookUrl =
    process.env.SWARM_OS_DISCORD_WEBHOOK_URL && process.env.SWARM_OS_DISCORD_WEBHOOK_URL.length > 0
      ? process.env.SWARM_OS_DISCORD_WEBHOOK_URL
      : null;
  const publicUrl =
    process.env.SWARM_OS_PUBLIC_URL && process.env.SWARM_OS_PUBLIC_URL.length > 0
      ? process.env.SWARM_OS_PUBLIC_URL
      : null;

  // Phase 4 — pino log config.
  const VALID_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  const rawLogLevel = process.env.SWARM_OS_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info';
  if (!VALID_LOG_LEVELS.has(rawLogLevel)) {
    throw new Error(`SWARM_OS_LOG_LEVEL must be one of trace|debug|info|warn|error|fatal, got: ${rawLogLevel}`);
  }
  const logLevel = rawLogLevel as Config['logLevel'];
  const logPrettyEnv = process.env.SWARM_OS_LOG_PRETTY;
  let logPretty: boolean;
  if (logPrettyEnv === '1' || logPrettyEnv === 'true') logPretty = true;
  else if (logPrettyEnv === '0' || logPrettyEnv === 'false') logPretty = false;
  else logPretty = process.env.NODE_ENV !== 'production' && Boolean(process.stdout.isTTY);

  // Phase 8 — auto-resume (default true). Any value !== 'false' enables it
  // so an operator setting `SWARM_OS_AUTO_RESUME=true` works as expected.
  const autoResumeEnv = process.env.SWARM_OS_AUTO_RESUME;
  const autoResume = autoResumeEnv === undefined ? true : autoResumeEnv !== 'false';
  const resumeStaggerMs = intEnv('SWARM_OS_RESUME_STAGGER_MS', 150);
  const notifyQuietAfterBootMs = intEnv('SWARM_OS_NOTIFY_QUIET_AFTER_BOOT_MS', 60_000);

  // Agent transport selector (default `local` for backwards-compatibility).
  // When `ssh`, the orchestrator opens `ssh -tt <target>` and runs claude on
  // the host instead of inside this process. Required vars are validated
  // below — fail-fast at boot rather than at first spawn.
  const rawTransport = process.env.SWARM_OS_AGENT_TRANSPORT ?? 'local';
  if (rawTransport !== 'local' && rawTransport !== 'ssh') {
    throw new Error(
      `SWARM_OS_AGENT_TRANSPORT must be 'local' or 'ssh', got: ${rawTransport}`,
    );
  }
  const agentTransport = rawTransport as AgentTransport;
  const sshTarget =
    process.env.SWARM_OS_SSH_TARGET && process.env.SWARM_OS_SSH_TARGET.length > 0
      ? process.env.SWARM_OS_SSH_TARGET
      : null;
  const sshKey = process.env.SWARM_OS_SSH_KEY ?? '/host-ssh/id_ed25519';
  const sshPort = intEnv('SWARM_OS_SSH_PORT', 22);
  const hostDataDir =
    process.env.SWARM_OS_HOST_DATA_DIR && process.env.SWARM_OS_HOST_DATA_DIR.length > 0
      ? path.resolve(process.env.SWARM_OS_HOST_DATA_DIR)
      : null;
  // SSH transport only: where the host keeps ~/.claude. Operators on SSH mode
  // should set SWARM_OS_HOST_CLAUDE_DIR explicitly; the fallback derives from
  // the running user's home rather than a hardcoded /home/ubuntu.
  const hostClaudeDir = path.resolve(
    process.env.SWARM_OS_HOST_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
  );
  // Siblings of hostClaudeDir, one per non-claude built-in adapter. Same rule:
  // set them explicitly on SSH mode; the fallback derives from the running
  // user's home. They are only READ in ssh transport (in local transport the
  // agent shares our filesystem namespace and resolves its own `~/.X`).
  const hostCodexDir = path.resolve(
    process.env.SWARM_OS_HOST_CODEX_DIR ?? path.join(os.homedir(), '.codex'),
  );
  const hostGeminiDir = path.resolve(
    process.env.SWARM_OS_HOST_GEMINI_DIR ?? path.join(os.homedir(), '.gemini'),
  );
  const hostOpencodeDir = path.resolve(
    process.env.SWARM_OS_HOST_OPENCODE_DIR ?? path.join(os.homedir(), '.opencode'),
  );
  // Not validated here: the adapter owns the vocabulary (it is gemini's, not
  // ours) and logs what it does with an unknown value, rather than refusing to
  // boot the whole server over one provider's setting.
  const geminiAuthType =
    process.env.SWARM_OS_GEMINI_AUTH_TYPE && process.env.SWARM_OS_GEMINI_AUTH_TYPE.length > 0
      ? process.env.SWARM_OS_GEMINI_AUTH_TYPE.trim()
      : null;
  const hostWorkspaceRoot =
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT && process.env.SWARM_OS_HOST_WORKSPACE_ROOT.length > 0
      ? path.resolve(process.env.SWARM_OS_HOST_WORKSPACE_ROOT)
      : null;
  if (agentTransport === 'ssh') {
    if (!sshTarget) {
      throw new Error(
        'SWARM_OS_AGENT_TRANSPORT=ssh requires SWARM_OS_SSH_TARGET (e.g. ubuntu@host.docker.internal)',
      );
    }
    if (!hostDataDir) {
      throw new Error(
        'SWARM_OS_AGENT_TRANSPORT=ssh requires SWARM_OS_HOST_DATA_DIR (host path matching the /data bind mount)',
      );
    }
    if (!hostWorkspaceRoot) {
      throw new Error(
        'SWARM_OS_AGENT_TRANSPORT=ssh requires SWARM_OS_HOST_WORKSPACE_ROOT (host path matching the /workspace bind mount)',
      );
    }
  }

  // Per-session mcp.json runtime dir. Lives under /tmp so it disappears with
  // the container; per-session files are mode 0600 and per-session/orch dirs
  // are mode 0700 (see mcp-config.ts). The runtime root itself is also
  // tightened to 0700 so other users on the host can't enumerate orch ids by
  // listing the directory — defence in depth on top of the per-orch/dir
  // perms (plan §14).
  //
  // SSH transport: the host claude reads `--mcp-config=<path>` in its own
  // filesystem namespace, so the runtime root MUST live under `dataDir`
  // (which is bind-mounted to the host) so it has a host-side equivalent
  // reachable via `toHostPath()`. Default to `<dataDir>/mcp-runtime` in that
  // mode; operators can still override with `SWARM_OS_MCP_RUNTIME_DIR`.
  const defaultMcpRuntimeDir =
    agentTransport === 'ssh' ? path.join(dataDir, 'mcp-runtime') : '/tmp/swarm-os';
  const mcpRuntimeDir = path.resolve(
    process.env.SWARM_OS_MCP_RUNTIME_DIR ?? defaultMcpRuntimeDir,
  );
  fs.mkdirSync(mcpRuntimeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(mcpRuntimeDir, 0o700);
  } catch {
    /* best-effort: directory may be on a filesystem that doesn't honour chmod */
  }

  cached = {
    port,
    host,
    hookUrl,
    mcpPort,
    projectName,
    defaultModel,
    defaultModelExplicit,
    defaultEffort,
    defaultPermissionMode,
    defaultProvider,
    maxOrchestrators,
    maxPromptSizeBytes: maxPromptSizeKb * 1024,
    claudeStartTimeoutMs: claudeStartTimeoutS * 1000,
    workspaceRoot,
    dataDir,
    logsDir,
    mcpRuntimeDir,
    claudeSourceDir,
    claudeRuntimeDir,
    claudeJsonSource,
    maxWorkersPerOrch,
    maxMessageSizeBytes: maxMessageSizeKb * 1024,
    maxInboxSize,
    idleThresholdMs,
    contextCompactOnWaiting,
    contextAutoCompactBytes,
    contextUsageTtlMs,
    autoCompactPct,
    workerAutoCompactPct,
    continueAfterCompact,
    backupIntervalMs,
    backupKeep,
    taskboardOrphanTtlMs,
    taskboardJanitorIntervalMs,
    approvalOrphanTtlMs,
    approvalJanitorIntervalMs,
    sessionReaperIntervalMs,
    budgetCheckIntervalMs,
    costRollupIntervalMs,
    scheduleEnabled,
    scheduleTimezone,
    codegraphEnabled,
    codegraphBin,
    codegraphEngine,
    codegraphJanitorIntervalMs,
    codegraphTimeoutMs,
    token,
    hookToken,
    discordWebhookUrl,
    publicUrl,
    logLevel,
    logPretty,
    autoResume,
    resumeStaggerMs,
    notifyQuietAfterBootMs,
    agentTransport,
    sshTarget,
    sshKey,
    sshPort,
    hostDataDir,
    hostClaudeDir,
    hostCodexDir,
    hostGeminiDir,
    geminiAuthType,
    hostOpencodeDir,
    hostWorkspaceRoot,
    ideEnabled,
    idePort,
    ideBasePath,
    ideToken,
    ideCliPath,
    ideServerDataDir,
    ideCliDataDir,
    startedAt: new Date().toISOString(),
    version: resolveVersion(),
    commit:
      process.env.SWARM_OS_COMMIT && process.env.SWARM_OS_COMMIT.length > 0
        ? process.env.SWARM_OS_COMMIT
        : null,
    image:
      process.env.SWARM_OS_IMAGE && process.env.SWARM_OS_IMAGE.length > 0
        ? process.env.SWARM_OS_IMAGE
        : null,
  };
  return cached;
}

/** Test-only: reset cache so tests with fresh env can re-load. */
export function _resetConfigCacheForTesting(): void {
  cached = null;
}
