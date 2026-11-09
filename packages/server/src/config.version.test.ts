import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, _resetConfigCacheForTesting } from './config.js';

/**
 * Anti-drift guard on the version swarm-os reports about itself.
 *
 * History this exists to prevent: `config.ts` hardcoded `'0.6.0-phase6'` while
 * the root `package.json` said `0.5.0`. The `Release:` commits bump the
 * manifest and never touched `config.ts`, so every UI surface lied for several
 * releases and nothing failed.
 *
 * The root path below is recomputed from THIS file rather than imported from
 * `config.ts` — a test that reuses the constant it is testing proves nothing.
 * `packages/server/src` → up 3 = repo root.
 *
 * Env handling mirrors `config.test.ts`: snapshot `process.env`, wipe every
 * `SWARM_OS_*`, mint a fresh tmp dataDir per test (loadConfig writes tokens),
 * and reset the module-level cache around each case.
 */

const ROOT_PACKAGE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'package.json',
);

function readRootManifest(): { name?: unknown; version?: unknown } {
  return JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
}

let envSnapshot: NodeJS.ProcessEnv;
let tmpRoot: string;

beforeEach(() => {
  envSnapshot = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-version-'));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SWARM_OS_') || k === 'HOOK_TOKEN') delete process.env[k];
  }
  process.env.SWARM_OS_DATA_DIR = path.join(tmpRoot, 'data');
  process.env.SWARM_OS_WORKSPACE_ROOT = path.join(tmpRoot, 'workspace');
  process.env.SWARM_OS_MCP_RUNTIME_DIR = path.join(tmpRoot, 'mcp-runtime');
  process.env.SWARM_OS_CLAUDE_SOURCE_DIR = path.join(tmpRoot, 'claude-source');
  process.env.SWARM_OS_CLAUDE_RUNTIME_DIR = path.join(tmpRoot, 'claude-runtime');
  process.env.SWARM_OS_TOKEN = 'test-token-fixed';
  process.env.HOOK_TOKEN = 'test-hook-token-fixed';
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

describe('config.version', () => {
  it('locates the monorepo root package.json (guards the relative path)', () => {
    // If this fails, the tree moved and every other assertion here is vacuous.
    expect(fs.existsSync(ROOT_PACKAGE_JSON)).toBe(true);
    expect(readRootManifest().name).toBe('swarm-os');
  });

  it('matches the root package.json version when SWARM_OS_VERSION is unset', () => {
    delete process.env.SWARM_OS_VERSION;
    _resetConfigCacheForTesting();
    expect(loadConfig().version).toBe(readRootManifest().version);
  });

  it('never reports the server package.json version (deploy ships server@0.0.0)', () => {
    // `pnpm --filter=server deploy --prod` puts `server@0.0.0` next to dist/ in
    // the image. Reading the nearest manifest instead of the root one would
    // reintroduce the drift silently, so pin the negative explicitly.
    delete process.env.SWARM_OS_VERSION;
    _resetConfigCacheForTesting();
    expect(loadConfig().version).not.toBe('0.0.0');
  });

  it('honours SWARM_OS_VERSION when the image bakes one in', () => {
    process.env.SWARM_OS_VERSION = '9.9.9';
    _resetConfigCacheForTesting();
    expect(loadConfig().version).toBe('9.9.9');
  });

  it('treats an empty SWARM_OS_VERSION as unset', () => {
    // `ENV SWARM_OS_VERSION=${APP_VERSION}` with no --build-arg produces "",
    // not an absent variable. Empty must not become the reported version.
    process.env.SWARM_OS_VERSION = '';
    _resetConfigCacheForTesting();
    expect(loadConfig().version).toBe(readRootManifest().version);
  });
});

describe('config.commit / config.image', () => {
  it('defaults both to null outside a built image', () => {
    const cfg = loadConfig();
    expect(cfg.commit).toBeNull();
    expect(cfg.image).toBeNull();
  });

  it('surfaces SWARM_OS_COMMIT verbatim', () => {
    process.env.SWARM_OS_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    _resetConfigCacheForTesting();
    expect(loadConfig().commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('surfaces SWARM_OS_IMAGE verbatim', () => {
    process.env.SWARM_OS_IMAGE = 'ghcr.io/nyyyxius/swarm-os:0.6.0';
    _resetConfigCacheForTesting();
    expect(loadConfig().image).toBe('ghcr.io/nyyyxius/swarm-os:0.6.0');
  });

  it('treats empty SWARM_OS_COMMIT / SWARM_OS_IMAGE as null', () => {
    process.env.SWARM_OS_COMMIT = '';
    process.env.SWARM_OS_IMAGE = '';
    _resetConfigCacheForTesting();
    const cfg = loadConfig();
    expect(cfg.commit).toBeNull();
    expect(cfg.image).toBeNull();
  });
});
