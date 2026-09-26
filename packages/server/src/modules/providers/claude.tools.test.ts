/**
 * docs/outils-par-role.md (v0.10.2) — the two claude-side levers on the size
 * of every call's context:
 *
 *  1. `--tools=<list>`: the role's BUILT-IN tool allow-list. Emitted in the
 *     single-token `=` form (the flag is variadic and would otherwise swallow
 *     the next argv), never emitted for an empty/absent list (an empty
 *     `--tools ""` strips every built-in tool).
 *  2. `ENABLE_TOOL_SEARCH`: on-demand tool loading stays ON (env unset) for
 *     every model but haiku, which keeps the 2026-07-04 inline pin;
 *     `SWARM_OS_CLAUDE_TOOL_SEARCH` overrides it instance-wide.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildClaudeArgs, toolSearchEnabled, withToolSearch, ClaudeProvider } from './claude.js';
import { IDENTITY_PATH_MAPPER, type SpawnRequest } from './types.js';

const BASE = {
  model: 'claude-opus-5-5',
  effort: 'high' as const,
  permissionMode: 'bypassPermissions' as const,
  initialPrompt: 'TASK',
  preamble: 'PRE',
  mcpConfigPath: '/data/mcp.json',
};

function req(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    initialPrompt: 'TASK',
    preamble: null,
    resumeNotice: null,
    cwd: '/workspace/proj',
    configDir: '/data/cfg',
    mcpConfigPath: null,
    paths: IDENTITY_PATH_MAPPER,
    ...over,
  };
}

describe('buildClaudeArgs — built-in tool allow-list', () => {
  it('emits no --tools when the list is absent, null or empty', () => {
    for (const tools of [undefined, null, []]) {
      const args = buildClaudeArgs({ ...BASE, tools });
      expect(args.some((a) => a.startsWith('--tools'))).toBe(false);
    }
  });

  it('emits a single `--tools=A,B` token before the MCP config and the `--` positional', () => {
    const args = buildClaudeArgs({ ...BASE, tools: ['Bash', 'Read', 'Edit'] });
    expect(args).toContain('--tools=Bash,Read,Edit');
    expect(args).not.toContain('--tools');
    const t = args.indexOf('--tools=Bash,Read,Edit');
    expect(t).toBeLessThan(args.indexOf('--mcp-config=/data/mcp.json'));
    expect(args.slice(-2)).toEqual(['--', 'TASK']);
  });
});

describe('toolSearchEnabled', () => {
  it('is ON for opus / sonnet / fable and OFF for haiku by default', () => {
    expect(toolSearchEnabled('claude-opus-5-5')).toBe(true);
    expect(toolSearchEnabled('opus')).toBe(true);
    expect(toolSearchEnabled('claude-sonnet-5')).toBe(true);
    expect(toolSearchEnabled('claude-fable-5-1')).toBe(true);
    expect(toolSearchEnabled('claude-haiku-4-5-20251001')).toBe(false);
    expect(toolSearchEnabled('haiku')).toBe(false);
  });

  it('honours the instance override in both directions', () => {
    expect(toolSearchEnabled('claude-opus-5-5', 'off')).toBe(false);
    expect(toolSearchEnabled('claude-opus-5-5', 'false')).toBe(false);
    expect(toolSearchEnabled('claude-haiku-4-5', 'on')).toBe(true);
    expect(toolSearchEnabled('claude-haiku-4-5', 'auto')).toBe(false);
    expect(toolSearchEnabled('claude-opus-5-5', '')).toBe(true);
  });
});

describe('ClaudeProvider.buildSpawn — env and argv', () => {
  const saved = process.env.SWARM_OS_CLAUDE_TOOL_SEARCH;
  afterEach(() => {
    if (saved === undefined) delete process.env.SWARM_OS_CLAUDE_TOOL_SEARCH;
    else process.env.SWARM_OS_CLAUDE_TOOL_SEARCH = saved;
  });

  it('leaves ENABLE_TOOL_SEARCH unset for opus and pins it to false for haiku', () => {
    delete process.env.SWARM_OS_CLAUDE_TOOL_SEARCH;
    const p = new ClaudeProvider();
    expect(p.buildSpawn(req()).env).toEqual({ CLAUDE_CONFIG_DIR: '/data/cfg' });
    expect(p.buildSpawn(req({ model: 'claude-haiku-4-5-20251001' })).env).toEqual({
      CLAUDE_CONFIG_DIR: '/data/cfg',
      ENABLE_TOOL_SEARCH: 'false',
    });
  });

  it('SWARM_OS_CLAUDE_TOOL_SEARCH=off restores the pre-0.10.2 pin for every model', () => {
    process.env.SWARM_OS_CLAUDE_TOOL_SEARCH = 'off';
    const p = new ClaudeProvider();
    expect(p.buildSpawn(req()).env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('passes the built-in tool list through to --tools, with ToolSearch when it is on', () => {
    delete process.env.SWARM_OS_CLAUDE_TOOL_SEARCH;
    const p = new ClaudeProvider();
    expect(p.buildSpawn(req({ builtinTools: ['Bash', 'Read'] })).args).toContain(
      '--tools=Bash,Read,ToolSearch',
    );
    expect(
      p.buildSpawn(req({ model: 'claude-haiku-4-5', builtinTools: ['Bash', 'Read'] })).args,
    ).toContain('--tools=Bash,Read');
    expect(p.buildSpawn(req({ builtinTools: null })).args.some((a) => a.startsWith('--tools'))).toBe(
      false,
    );
  });
});

describe('withToolSearch', () => {
  it('appends ToolSearch to a restricted list only when on-demand loading is on', () => {
    expect(withToolSearch(['Bash'], true)).toEqual(['Bash', 'ToolSearch']);
    expect(withToolSearch(['Bash', 'ToolSearch'], true)).toEqual(['Bash', 'ToolSearch']);
    expect(withToolSearch(['Bash'], false)).toEqual(['Bash']);
    expect(withToolSearch(null, true)).toBeNull();
    expect(withToolSearch([], true)).toEqual([]);
  });
});
