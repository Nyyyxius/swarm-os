import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, _resetConfigCacheForTesting } from './config.js';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from './modules/providers/ids.js';

/**
 * Phase 7 — config parsing/validation.
 *
 * Each test mints its own dataDir + workspaceRoot under a fresh tmp dir so
 * the file-side effects (`/data/token`, `/data/hook-token`,
 * `<dataDir>/logs`, `mcpRuntimeDir`, `claudeRuntimeDir`) don't bleed.
 *
 * `process.env` is snapshotted in `beforeEach` and restored in `afterEach`
 * — `loadConfig` reads dozens of `SWARM_OS_*` vars and the previous test's
 * leftovers would otherwise corrupt the next.
 */

let envSnapshot: NodeJS.ProcessEnv;
let tmpRoot: string;

function setMandatoryEnv(): void {
  // workspaceRoot must exist for downstream realpath calls in other tests, but
  // loadConfig itself only resolves the path. dataDir IS created by config.
  process.env.SWARM_OS_DATA_DIR = path.join(tmpRoot, 'data');
  process.env.SWARM_OS_WORKSPACE_ROOT = path.join(tmpRoot, 'workspace');
  process.env.SWARM_OS_MCP_RUNTIME_DIR = path.join(tmpRoot, 'mcp-runtime');
  process.env.SWARM_OS_CLAUDE_SOURCE_DIR = path.join(tmpRoot, 'claude-source');
  process.env.SWARM_OS_CLAUDE_RUNTIME_DIR = path.join(tmpRoot, 'claude-runtime');
  process.env.SWARM_OS_TOKEN = 'test-token-fixed';
  process.env.HOOK_TOKEN = 'test-hook-token-fixed';
}

beforeEach(() => {
  envSnapshot = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-config-'));
  // Wipe SWARM_OS_*/HOOK_TOKEN before every test so we start from a known state.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SWARM_OS_') || k === 'HOOK_TOKEN') delete process.env[k];
  }
  setMandatoryEnv();
  _resetConfigCacheForTesting();
});

afterEach(() => {
  process.env = envSnapshot;
  _resetConfigCacheForTesting();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('loadConfig', () => {
  it('falls back to defaults when only mandatory env vars are set', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.mcpPort).toBe(8788);
    expect(cfg.host).toBe('127.0.0.1');
    // The constant, not the literal: `pnpm models:sync` rewrites `ids.ts`
    // before a release, and a frozen id here would make every model refresh
    // a test edit.
    expect(cfg.defaultModel).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS.claude);
    expect(cfg.defaultEffort).toBe('xhigh');
    expect(cfg.defaultPermissionMode).toBe('bypassPermissions');
    expect(cfg.maxOrchestrators).toBe(10);
    expect(cfg.maxWorkersPerOrch).toBe(20);
    // 16 KB default
    expect(cfg.maxMessageSizeBytes).toBe(16 * 1024);
    expect(cfg.maxInboxSize).toBe(100);
    expect(cfg.idleThresholdMs).toBe(2000);
    // 64 KB default
    expect(cfg.maxPromptSizeBytes).toBe(64 * 1024);
    // 30 s default
    expect(cfg.claudeStartTimeoutMs).toBe(30 * 1000);
  });

  it('falls back to projectName="dev" when SWARM_OS_PROJECT_NAME is unset', () => {
    const cfg = loadConfig();
    expect(cfg.projectName).toBe('dev');
  });

  it('honours SWARM_OS_PROJECT_NAME when provided', () => {
    process.env.SWARM_OS_PROJECT_NAME = 'integration-test';
    _resetConfigCacheForTesting();
    expect(loadConfig().projectName).toBe('integration-test');
  });

  it('parses SWARM_OS_PORT as integer', () => {
    process.env.SWARM_OS_PORT = '12345';
    _resetConfigCacheForTesting();
    expect(loadConfig().port).toBe(12345);
  });

  it('rejects non-integer SWARM_OS_PORT', () => {
    process.env.SWARM_OS_PORT = 'not-a-number';
    _resetConfigCacheForTesting();
    expect(() => loadConfig()).toThrow(/SWARM_OS_PORT/);
  });

  it('rejects negative SWARM_OS_MAX_ORCHESTRATORS', () => {
    process.env.SWARM_OS_MAX_ORCHESTRATORS = '-1';
    _resetConfigCacheForTesting();
    expect(() => loadConfig()).toThrow(/SWARM_OS_MAX_ORCHESTRATORS/);
  });

  it('rejects an invalid effort level', () => {
    process.env.SWARM_OS_DEFAULT_EFFORT = 'extreme';
    _resetConfigCacheForTesting();
    expect(() => loadConfig()).toThrow(/SWARM_OS_DEFAULT_EFFORT/);
  });

  it('rejects an invalid permission mode', () => {
    process.env.SWARM_OS_DEFAULT_PERMISSION_MODE = 'rogue';
    _resetConfigCacheForTesting();
    expect(() => loadConfig()).toThrow(/SWARM_OS_DEFAULT_PERMISSION_MODE/);
  });

  describe('SWARM_OS_DEFAULT_PROVIDER ↔ SWARM_OS_DEFAULT_MODEL coherence', () => {
    it('derives the default model from the default provider when no model is set', () => {
      // The documented-as-valid pair (`docs/providers.md` §6): pick a provider,
      // say nothing about the model. `defaultModel` used to be the hard-coded
      // claude id regardless, and because the config layer legitimately IS the
      // codex layer no downstream provider-scoping guard could catch it — every
      // team and every worker on the instance ran `codex -m claude-opus-4-8`.
      process.env.SWARM_OS_DEFAULT_PROVIDER = 'codex';
      _resetConfigCacheForTesting();
      const cfg = loadConfig();
      expect(cfg.defaultProvider).toBe('codex');
      expect(cfg.defaultModel).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS.codex);
      expect(cfg.defaultModel).not.toMatch(/^claude-/);
    });

    it('does the same for gemini and opencode', () => {
      for (const provider of ['gemini', 'opencode'] as const) {
        process.env.SWARM_OS_DEFAULT_PROVIDER = provider;
        _resetConfigCacheForTesting();
        expect(loadConfig().defaultModel).toBe(
          BUILTIN_PROVIDER_DEFAULT_MODELS[provider],
        );
      }
    });

    it('never overrides an explicit SWARM_OS_DEFAULT_MODEL', () => {
      // The model string is never validated — ids ship faster than releases —
      // so an operator who names one gets it verbatim, provider or no provider.
      process.env.SWARM_OS_DEFAULT_PROVIDER = 'codex';
      process.env.SWARM_OS_DEFAULT_MODEL = 'gpt-6-preview';
      _resetConfigCacheForTesting();
      expect(loadConfig().defaultModel).toBe('gpt-6-preview');
    });

    it('leaves a claude deployment exactly where it was', () => {
      process.env.SWARM_OS_DEFAULT_PROVIDER = 'claude';
      _resetConfigCacheForTesting();
      expect(loadConfig().defaultModel).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS.claude);
    });

    it('flags whether the OPERATOR named the model, not merely whether one exists', () => {
      // `defaultModel` is never empty, so "is there a model?" cannot answer
      // "should the config layer name one?". Without this flag the `'config'`
      // layer always won for a team on the instance's own default provider, and
      // the adapter's `defaults()` — where the live catalogue lands — was
      // unreachable from the API. See `Config.defaultModelExplicit`.
      _resetConfigCacheForTesting();
      expect(loadConfig().defaultModelExplicit).toBe(false);

      process.env.SWARM_OS_DEFAULT_MODEL = 'claude-opus-9';
      _resetConfigCacheForTesting();
      const named = loadConfig();
      expect(named.defaultModelExplicit).toBe(true);
      expect(named.defaultModel).toBe('claude-opus-9');

      // An empty env var is UNSET, not "named the empty string" — the same
      // reading `providers/resolve.ts` already applies to every layer.
      process.env.SWARM_OS_DEFAULT_MODEL = '';
      _resetConfigCacheForTesting();
      expect(loadConfig().defaultModelExplicit).toBe(false);
    });
  });

  it('parses SWARM_OS_MAX_PROMPT_SIZE_KB into bytes', () => {
    process.env.SWARM_OS_MAX_PROMPT_SIZE_KB = '128';
    _resetConfigCacheForTesting();
    expect(loadConfig().maxPromptSizeBytes).toBe(128 * 1024);
  });

  it('parses SWARM_OS_MAX_MESSAGE_SIZE_KB and SWARM_OS_MAX_INBOX_SIZE', () => {
    process.env.SWARM_OS_MAX_MESSAGE_SIZE_KB = '32';
    process.env.SWARM_OS_MAX_INBOX_SIZE = '250';
    _resetConfigCacheForTesting();
    const cfg = loadConfig();
    expect(cfg.maxMessageSizeBytes).toBe(32 * 1024);
    expect(cfg.maxInboxSize).toBe(250);
  });

  it('parses SWARM_OS_IDLE_THRESHOLD_MS', () => {
    process.env.SWARM_OS_IDLE_THRESHOLD_MS = '50';
    _resetConfigCacheForTesting();
    expect(loadConfig().idleThresholdMs).toBe(50);
  });

  it('persists a generated SWARM_OS_TOKEN under <dataDir>/token (mode 0600)', () => {
    delete process.env.SWARM_OS_TOKEN;
    _resetConfigCacheForTesting();
    const cfg = loadConfig();
    const tokenPath = path.join(cfg.dataDir, 'token');
    expect(fs.existsSync(tokenPath)).toBe(true);
    const content = fs.readFileSync(tokenPath, 'utf8').trim();
    expect(content).toBe(cfg.token);
    expect(cfg.token.length).toBeGreaterThan(0);
    // Mode bits: only owner read/write should be set (0600 == 384 dec).
    const stat = fs.statSync(tokenPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reads back an existing /data/token instead of regenerating', () => {
    delete process.env.SWARM_OS_TOKEN;
    fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
    const tokenPath = path.join(tmpRoot, 'data', 'token');
    fs.writeFileSync(tokenPath, 'persisted-token-value\n', { mode: 0o600 });
    _resetConfigCacheForTesting();
    expect(loadConfig().token).toBe('persisted-token-value');
  });

  it('persists a separate hook-token at <dataDir>/hook-token', () => {
    delete process.env.HOOK_TOKEN;
    _resetConfigCacheForTesting();
    const cfg = loadConfig();
    expect(cfg.hookToken).not.toBe(cfg.token);
    const hookPath = path.join(cfg.dataDir, 'hook-token');
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it('returns a cached config on second call', () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it('treats SWARM_OS_DISCORD_WEBHOOK_URL="" as null', () => {
    process.env.SWARM_OS_DISCORD_WEBHOOK_URL = '';
    _resetConfigCacheForTesting();
    expect(loadConfig().discordWebhookUrl).toBeNull();
  });

  it('honours SWARM_OS_DISCORD_WEBHOOK_URL when set', () => {
    process.env.SWARM_OS_DISCORD_WEBHOOK_URL = 'https://discord.example/webhook/abc';
    _resetConfigCacheForTesting();
    expect(loadConfig().discordWebhookUrl).toBe('https://discord.example/webhook/abc');
  });

  it('rejects an unknown log level', () => {
    process.env.SWARM_OS_LOG_LEVEL = 'shouty';
    _resetConfigCacheForTesting();
    expect(() => loadConfig()).toThrow(/SWARM_OS_LOG_LEVEL/);
  });
});
