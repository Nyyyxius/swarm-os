// Tests for `../lib/paths.js` — where a file lives, and what that path means to
// whoever reads it.
//
// Three invariants are worth the whole file:
//
//  1. `toAgentPath` is the identity under the LOCAL transport and a prefix
//     substitution under `ssh`. Getting this wrong is invisible in dev (local
//     transport, identity) and breaks every `Read` in production (the remote
//     `claude` resolves paths in the HOST namespace).
//  2. `toContainerPath` is its INVERSE, and this plugin needs it because agents
//     hand paths BACK (an image to describe, a photo to edit). Under `ssh` the
//     path the agent knows does not exist in the container, so without the
//     translation every vision call from production would ENOENT while working
//     perfectly in local dev.
//  3. Both containment checks refuse to leave the workspace. The plugin runs
//     in-process with the server's rights, so a hole here does not merely read
//     the wrong file — it uploads it to Google.
//
// Every function re-reads `process.env` on each call (no module state — see the
// ESM-cache note in paths.js), which is what lets these tests flip transports
// between cases. The env is snapshotted and restored around each one so nothing
// leaks into the rest of the suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { workspaceRoot, toAgentPath, toContainerPath, resolveOutputDir } from '../lib/paths.js';

/** @type {NodeJS.ProcessEnv} */
let savedEnv;

const VARS = ['SWARM_OS_WORKSPACE_ROOT', 'SWARM_OS_HOST_WORKSPACE_ROOT', 'SWARM_OS_AGENT_TRANSPORT'];

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of VARS) delete process.env[key];
});

afterEach(() => {
  for (const key of VARS) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

/** Put the process in the production shape: container + host, ssh transport. */
function useSsh() {
  process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
  process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/swarm';
  process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
}

describe('workspaceRoot', () => {
  it('falls back to /workspace when SWARM_OS_WORKSPACE_ROOT is unset', () => {
    expect(workspaceRoot()).toBe('/workspace');
  });

  it('normalises the value through path.resolve (trailing slash, inner dot)', () => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '/srv/./ws/';
    expect(workspaceRoot()).toBe('/srv/ws');
  });

  it('treats an empty value as unset', () => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '';
    expect(workspaceRoot()).toBe('/workspace');
  });
});

describe('toAgentPath', () => {
  it('is the identity under the local transport', () => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
    expect(toAgentPath('/workspace/gemini/a.png')).toBe('/workspace/gemini/a.png');
  });

  it('is the identity when only the host root is set (transport not ssh)', () => {
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/swarm';
    expect(toAgentPath('/workspace/a.png')).toBe('/workspace/a.png');
  });

  it('rewrites the workspace prefix under ssh', () => {
    useSsh();
    expect(toAgentPath('/workspace/gemini/a.png')).toBe('/home/ubuntu/swarm/gemini/a.png');
  });

  it('maps the root itself, without leaving a trailing separator', () => {
    useSsh();
    expect(toAgentPath('/workspace')).toBe('/home/ubuntu/swarm');
  });

  it('leaves a path outside the bind mount alone (the host would not see it either)', () => {
    useSsh();
    expect(toAgentPath('/tmp/x')).toBe('/tmp/x');
  });

  it('does not match a sibling directory that merely shares the prefix', () => {
    useSsh();
    // `/workspace-old` starts with `/workspace` textually but is a DIFFERENT
    // directory; rewriting it would silently point the agent at the wrong tree.
    expect(toAgentPath('/workspace-old/a.png')).toBe('/workspace-old/a.png');
  });
});

describe('toContainerPath — the inverse, and the containment gate', () => {
  it('resolves a relative path against the workspace root', () => {
    expect(toContainerPath('shots/a.png')).toBe('/workspace/shots/a.png');
  });

  it('accepts a container path unchanged', () => {
    expect(toContainerPath('/workspace/shots/a.png')).toBe('/workspace/shots/a.png');
  });

  it('rewrites a HOST path back onto the container mount under ssh', () => {
    useSsh();
    expect(toContainerPath('/home/ubuntu/swarm/shots/a.png')).toBe('/workspace/shots/a.png');
  });

  it('round-trips with toAgentPath under ssh', () => {
    useSsh();
    const container = '/workspace/gemini/2026-08-19/x.mp4';
    expect(toContainerPath(toAgentPath(container))).toBe(container);
  });

  it('maps the host root itself', () => {
    useSsh();
    expect(toContainerPath('/home/ubuntu/swarm')).toBe('/workspace');
  });

  it('refuses a traversal out of the workspace', () => {
    expect(() => toContainerPath('../../etc/passwd')).toThrow(/hors du workspace/);
  });

  it('refuses an absolute path outside the workspace', () => {
    expect(() => toContainerPath('/etc/shadow')).toThrow(/hors du workspace/);
  });

  it('refuses a traversal that starts inside the workspace', () => {
    expect(() => toContainerPath('/workspace/../etc/passwd')).toThrow(/hors du workspace/);
  });

  it('refuses a sibling directory sharing the workspace prefix', () => {
    expect(() => toContainerPath('/workspace-other/a.png')).toThrow(/hors du workspace/);
  });

  it('refuses an empty path rather than silently returning the root', () => {
    expect(() => toContainerPath('   ')).toThrow(/vide/);
    expect(() => toContainerPath(/** @type {never} */ (undefined))).toThrow(/vide/);
  });

  it('allows the workspace root itself', () => {
    expect(toContainerPath('/workspace')).toBe('/workspace');
  });
});

describe('resolveOutputDir', () => {
  it('resolves a relative directory against the workspace', () => {
    expect(resolveOutputDir('gemini')).toBe('/workspace/gemini');
  });

  it('treats an empty value as the workspace root', () => {
    expect(resolveOutputDir('')).toBe('/workspace');
    expect(resolveOutputDir('   ')).toBe('/workspace');
  });

  it('refuses a path that escapes the workspace', () => {
    expect(() => resolveOutputDir('../outside')).toThrow(/hors du workspace/);
    expect(() => resolveOutputDir('/etc')).toThrow(/hors du workspace/);
  });

  it('names both the input and the resolved path in the error, plus the fix', () => {
    try {
      resolveOutputDir('../outside');
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err.message)).toContain('../outside');
      expect(String(err.message)).toContain('/outside');
      expect(String(err.message)).toContain('RELATIF');
    }
  });
});
