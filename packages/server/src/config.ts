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

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const port = intEnv('SWARM_OS_PORT', 8787);
  const host = process.env.SWARM_OS_HOST ?? '127.0.0.1';
  const mcpPort = intEnv('SWARM_OS_MCP_PORT', 8788);

  // Project name is technically required, but for `pnpm dev` convenience we default to 'dev'.
  const projectName = process.env.SWARM_OS_PROJECT_NAME ?? 'dev';

  const defaultModel = process.env.SWARM_OS_DEFAULT_MODEL ?? 'claude-opus-4-7';

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

  const token = loadOrCreateToken(dataDir);
  const hookToken = loadOrCreateHookToken(dataDir);

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

  // Per-session mcp.json runtime dir. Lives under /tmp so it disappears with
  // the container; per-session files are mode 0600 and per-session/orch dirs
  // are mode 0700 (see mcp-config.ts). The runtime root itself is also
  // tightened to 0700 so other users on the host can't enumerate orch ids by
  // listing the directory — defence in depth on top of the per-orch/dir
  // perms (plan §14).
  const mcpRuntimeDir = path.resolve(
    process.env.SWARM_OS_MCP_RUNTIME_DIR ?? '/tmp/swarm-os',
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
    maxWorkersPerOrch,
    maxMessageSizeBytes: maxMessageSizeKb * 1024,
    maxInboxSize,
    idleThresholdMs,
    token,
    hookToken,
    discordWebhookUrl,
    publicUrl,
    logLevel,
    logPretty,
    startedAt: new Date().toISOString(),
    version: '0.5.0-phase5',
  };
  return cached;
}

/** Test-only: reset cache so tests with fresh env can re-load. */
export function _resetConfigCacheForTesting(): void {
  cached = null;
}
