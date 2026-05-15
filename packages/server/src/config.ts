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
  token: string;
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

  const workspaceRoot = path.resolve(process.env.SWARM_OS_WORKSPACE_ROOT ?? '/workspace');
  const dataDir = path.resolve(process.env.SWARM_OS_DATA_DIR ?? '/data');

  // Ensure dataDir exists before token read/generate.
  ensureDir(dataDir);
  const logsDir = path.join(dataDir, 'logs');
  ensureDir(logsDir);

  const token = loadOrCreateToken(dataDir);

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
    token,
    startedAt: new Date().toISOString(),
    version: '0.2.0-phase2',
  };
  return cached;
}

/** Test-only: reset cache so tests with fresh env can re-load. */
export function _resetConfigCacheForTesting(): void {
  cached = null;
}
