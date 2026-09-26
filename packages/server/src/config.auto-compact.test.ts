/**
 * `SWARM_OS_AUTO_COMPACT_PCT` (docs/auto-compact.md D6).
 *
 * The knob is deliberately the ONE env var that does not fail the boot on a bad
 * value: it tunes a background behaviour on a fleet that runs 24/7, so taking
 * the server down over a typo'd percentage would be far worse than running at
 * the documented default. That leniency is only safe if it is LOUD, hence the
 * `warn` assertion below — a silent fallback would leave an operator convinced
 * their threshold is in effect.
 *
 * `0` is the other subtlety: it is a VALID value (the kill switch), not a
 * rejected one, so it must never be mistaken for "unset" and bounced to 35.
 *
 * Harness copied from `config.test.ts`: `process.env` is snapshotted and every
 * `SWARM_OS_*` wiped, because `loadConfig` reads dozens of vars and caches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadConfig,
  _resetConfigCacheForTesting,
  DEFAULT_AUTO_COMPACT_PCT,
  DEFAULT_WORKER_AUTO_COMPACT_PCT,
} from './config.js';

let envSnapshot: NodeJS.ProcessEnv;
let tmpRoot: string;

beforeEach(() => {
  envSnapshot = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-autocompact-cfg-'));
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
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Load the config while capturing whatever pino wrote to stdout. */
function loadCapturingStdout(): { pct: number; out: string } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    return { pct: loadConfig().autoCompactPct, out };
  } finally {
    spy.mockRestore();
  }
}

describe('SWARM_OS_AUTO_COMPACT_PCT', () => {
  it('defaults to 35 when unset', () => {
    expect(loadConfig().autoCompactPct).toBe(35);
    expect(DEFAULT_AUTO_COMPACT_PCT).toBe(35);
  });

  it('defaults to 35 when set to the empty string', () => {
    process.env.SWARM_OS_AUTO_COMPACT_PCT = '';
    expect(loadConfig().autoCompactPct).toBe(35);
  });

  it('accepts every integer in 0..100, the 0 kill switch included', () => {
    for (const raw of ['0', '1', '20', '100']) {
      process.env.SWARM_OS_AUTO_COMPACT_PCT = raw;
      _resetConfigCacheForTesting();
      expect(loadConfig().autoCompactPct, `raw=${raw}`).toBe(Number(raw));
    }
  });

  it('falls back to 35 and warns — rather than throwing — on a bad value', () => {
    for (const raw of ['101', '-1', '3.5', '35%', 'abc', 'NaN', 'Infinity']) {
      process.env.SWARM_OS_AUTO_COMPACT_PCT = raw;
      _resetConfigCacheForTesting();
      const { pct, out } = loadCapturingStdout();
      expect(pct, `raw=${raw}`).toBe(35);
      // Loud, not silent: the operator has to be able to find out why their
      // number is not the one in effect.
      expect(out, `raw=${raw}`).toContain('config.auto_compact_pct_invalid');
    }
  });

  it('says nothing at all when the value is valid', () => {
    process.env.SWARM_OS_AUTO_COMPACT_PCT = '20';
    const { pct, out } = loadCapturingStdout();
    expect(pct).toBe(20);
    expect(out).not.toContain('config.auto_compact_pct_invalid');
  });
});

/** Load the config while capturing stdout, returning the whole Config. */
function loadAllCapturingStdout(): { cfg: ReturnType<typeof loadConfig>; out: string } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    return { cfg: loadConfig(), out };
  } finally {
    spy.mockRestore();
  }
}

// v0.10.1 (docs/auto-compact.md §8.2) — the workers' instance threshold. Same
// leniency as the lead's, but the default is 0 (off), and 0 must survive as a
// real value rather than "unset".
describe('SWARM_OS_WORKER_AUTO_COMPACT_PCT', () => {
  it('defaults to 0 (workers are not auto-compacted) when unset or empty', () => {
    expect(DEFAULT_WORKER_AUTO_COMPACT_PCT).toBe(0);
    expect(loadConfig().workerAutoCompactPct).toBe(0);
    process.env.SWARM_OS_WORKER_AUTO_COMPACT_PCT = '';
    _resetConfigCacheForTesting();
    expect(loadConfig().workerAutoCompactPct).toBe(0);
  });

  it('accepts every integer in 0..100, independently of the lead threshold', () => {
    process.env.SWARM_OS_AUTO_COMPACT_PCT = '20';
    for (const raw of ['0', '1', '35', '100']) {
      process.env.SWARM_OS_WORKER_AUTO_COMPACT_PCT = raw;
      _resetConfigCacheForTesting();
      const cfg = loadConfig();
      expect(cfg.workerAutoCompactPct, `raw=${raw}`).toBe(Number(raw));
      expect(cfg.autoCompactPct).toBe(20);
    }
  });

  it('falls back to 0 and warns with its OWN event on a bad value', () => {
    for (const raw of ['101', '-1', '3.5', '35%', 'abc']) {
      process.env.SWARM_OS_WORKER_AUTO_COMPACT_PCT = raw;
      _resetConfigCacheForTesting();
      const { cfg, out } = loadAllCapturingStdout();
      expect(cfg.workerAutoCompactPct, `raw=${raw}`).toBe(0);
      expect(out, `raw=${raw}`).toContain('config.worker_auto_compact_pct_invalid');
      // …and the lead knob is not blamed for it.
      expect(out, `raw=${raw}`).not.toContain('config.auto_compact_pct_invalid');
    }
  });
});

// v0.10.1 (docs/auto-compact.md §8.1) — the post-compact "resume" line. ON by
// default; the usual spellings switch it off; a typo keeps it ON, loudly,
// instead of failing the boot of a 24/7 fleet.
describe('SWARM_OS_CONTINUE_AFTER_COMPACT', () => {
  it('defaults to ON when unset or empty', () => {
    expect(loadConfig().continueAfterCompact).toBe(true);
    process.env.SWARM_OS_CONTINUE_AFTER_COMPACT = '';
    _resetConfigCacheForTesting();
    expect(loadConfig().continueAfterCompact).toBe(true);
  });

  it('is switched off by 0 / false / no / off, in any case', () => {
    for (const raw of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
      process.env.SWARM_OS_CONTINUE_AFTER_COMPACT = raw;
      _resetConfigCacheForTesting();
      expect(loadConfig().continueAfterCompact, `raw=${raw}`).toBe(false);
    }
  });

  it('stays on for 1 / true / yes / on', () => {
    for (const raw of ['1', 'true', 'yes', 'on']) {
      process.env.SWARM_OS_CONTINUE_AFTER_COMPACT = raw;
      _resetConfigCacheForTesting();
      expect(loadConfig().continueAfterCompact, `raw=${raw}`).toBe(true);
    }
  });

  it('keeps the default and warns — rather than throwing — on an unreadable value', () => {
    process.env.SWARM_OS_CONTINUE_AFTER_COMPACT = 'flase';
    const { cfg, out } = loadAllCapturingStdout();
    expect(cfg.continueAfterCompact).toBe(true);
    expect(out).toContain('config.continue_after_compact_invalid');
  });
});
