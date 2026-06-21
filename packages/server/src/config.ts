import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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
   * MCP HTTP listener port — separate from `port`. The MCP server binds to
   * the loopback interface ONLY (hardcoded `127.0.0.1`, see plan §14): no
   * env var lets it leak onto the network. The port is configurable via
   * `SWARM_OS_MCP_PORT` purely so it can be moved off a conflict, never
   * to change the bind address.
   */
  mcpPort: number;
  projectName: string;
  defaultModel: string;
  defaultEffort: EffortLevel;
  defaultPermissionMode: PermissionMode;
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
   * Per-role cron scheduler (modules/schedule): master switch. When `true`
   * (default), a role carrying a `schedule` gets an in-process cron that
   * delivers its `scheduleMessage` to the lead inbox of every live instance.
   * Env: `SWARM_OS_SCHEDULE_ENABLED`.
   */
  scheduleEnabled: boolean;
  /**
   * IANA timezone the per-role cron expressions are evaluated in. Default
   * `UTC` — explicit so cadence does not drift with the container's TZ.
   * Env: `SWARM_OS_SCHEDULE_TZ`.
   */
  scheduleTimezone: string;
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
  version: string;
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

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const port = intEnv('SWARM_OS_PORT', 8787);
  const host = process.env.SWARM_OS_HOST ?? '127.0.0.1';
  const mcpPort = intEnv('SWARM_OS_MCP_PORT', 8788);

  // Project name is technically required, but for `pnpm dev` convenience we default to 'dev'.
  const projectName = process.env.SWARM_OS_PROJECT_NAME ?? 'dev';

  const defaultModel = process.env.SWARM_OS_DEFAULT_MODEL ?? 'claude-opus-4-8';

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

  // Hot SQLite backup scheduler (in-process; writes to <dataDir>/backups).
  const backupIntervalMs = intEnv('SWARM_OS_BACKUP_INTERVAL_MS', 6 * 60 * 60 * 1000);
  const backupKeep = intEnv('SWARM_OS_BACKUP_KEEP', 14);

  // Per-role cron scheduler (in-process; modules/schedule).
  const scheduleEnabled = boolEnv('SWARM_OS_SCHEDULE_ENABLED', true);
  const scheduleTimezone = process.env.SWARM_OS_SCHEDULE_TZ ?? 'UTC';

  const workspaceRoot = path.resolve(process.env.SWARM_OS_WORKSPACE_ROOT ?? '/workspace');
  const dataDir = path.resolve(process.env.SWARM_OS_DATA_DIR ?? '/data');

  // Ensure dataDir exists before token read/generate.
  ensureDir(dataDir);
  const logsDir = path.join(dataDir, 'logs');
  ensureDir(logsDir);

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
  if (ideEnabled) {
    // Pre-create so the serve-web child never races a missing dir on first
    // spawn. Best-effort: the supervisor also mkdir's defensively.
    for (const d of [ideServerDataDir, ideCliDataDir]) {
      try {
        ensureDir(d);
      } catch {
        /* best-effort */
      }
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
  const hostClaudeDir = path.resolve(
    process.env.SWARM_OS_HOST_CLAUDE_DIR ?? '/home/ubuntu/.claude',
  );
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
    mcpPort,
    projectName,
    defaultModel,
    defaultEffort,
    defaultPermissionMode,
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
    backupIntervalMs,
    backupKeep,
    scheduleEnabled,
    scheduleTimezone,
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
    hostWorkspaceRoot,
    ideEnabled,
    idePort,
    ideBasePath,
    ideToken,
    ideCliPath,
    ideServerDataDir,
    ideCliDataDir,
    startedAt: new Date().toISOString(),
    version: '0.6.0-phase6',
  };
  return cached;
}

/** Test-only: reset cache so tests with fresh env can re-load. */
export function _resetConfigCacheForTesting(): void {
  cached = null;
}
