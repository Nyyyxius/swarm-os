// Tests for `../lib/paths.js` — where a generated file lives, and what that
// path means to whoever reads it.
//
// Two invariants are worth the whole file:
//
//  1. `toAgentPath` is the identity under the LOCAL transport and a prefix
//     substitution under `ssh`. Getting this wrong is invisible in dev (local
//     transport, identity) and breaks every `Read` in production (the remote
//     `claude` resolves paths in the HOST namespace, so `/workspace/x` has to
//     become `<hostWorkspaceRoot>/x`).
//  2. `resolveOutputDir` refuses to leave the workspace. The plugin runs
//     in-process with the server's rights, so a containment hole here writes
//     anywhere on the container filesystem.
//
// Both functions re-read `process.env` on every call (no module state — see
// the ESM-cache note in paths.js), which is exactly what lets these tests
// flip transports between cases. The env is snapshotted and restored around
// each one so nothing leaks into the rest of the suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

import { workspaceRoot, toAgentPath, resolveOutputDir } from '../lib/paths.js';

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

describe('workspaceRoot', () => {
  it('falls back to /workspace when SWARM_OS_WORKSPACE_ROOT is unset', () => {
    expect(workspaceRoot()).toBe('/workspace');
  });

  it('uses SWARM_OS_WORKSPACE_ROOT when set', () => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '/srv/ws';
    expect(workspaceRoot()).toBe('/srv/ws');
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
  it('is the identity under the local transport, even with a host root set', () => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/projets/fyrel';
    // No SWARM_OS_AGENT_TRANSPORT === local: the agent runs in the container.
    expect(toAgentPath('/workspace/novelai/2026-07-27/a.ogg')).toBe(
      '/workspace/novelai/2026-07-27/a.ogg',
    );
  });

  it('is the identity under ssh when no host root is configured', () => {
    process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
    expect(toAgentPath('/workspace/novelai/a.ogg')).toBe('/workspace/novelai/a.ogg');
  });

  it('substitutes the workspace prefix under ssh', () => {
    process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/projets/fyrel';
    expect(toAgentPath('/workspace/novelai/2026-07-27/a.ogg')).toBe(
      '/home/ubuntu/projets/fyrel/novelai/2026-07-27/a.ogg',
    );
  });

  it('maps the workspace root itself, with no trailing separator', () => {
    process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/projets/fyrel';
    expect(toAgentPath('/workspace')).toBe('/home/ubuntu/projets/fyrel');
  });

  it('leaves a path outside the workspace untouched', () => {
    process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/projets/fyrel';
    // The host does not see /data at all — rewriting it would invent a path.
    expect(toAgentPath('/data/plugins/novelai/index.js')).toBe('/data/plugins/novelai/index.js');
  });

  it('does not treat a sibling directory as being inside the workspace', () => {
    process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/projets/fyrel';
    // `/workspace-backup` merely shares a string prefix — the separator check
    // is what keeps it out.
    expect(toAgentPath('/workspace-backup/a.ogg')).toBe('/workspace-backup/a.ogg');
  });

  it('normalises BOTH roots through path.resolve before comparing', () => {
    process.env.SWARM_OS_AGENT_TRANSPORT = 'ssh';
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace/./';
    process.env.SWARM_OS_HOST_WORKSPACE_ROOT = '/home/ubuntu/./projets/fyrel/';
    // A non-normalised env value must not silently defeat the prefix test.
    expect(toAgentPath('/workspace/novelai/a.ogg')).toBe('/home/ubuntu/projets/fyrel/novelai/a.ogg');
  });
});

describe('resolveOutputDir', () => {
  beforeEach(() => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '/workspace';
  });

  it('accepts a plain relative directory', () => {
    expect(resolveOutputDir('novelai')).toBe('/workspace/novelai');
  });

  it('accepts a nested relative directory', () => {
    expect(resolveOutputDir('novelai/out')).toBe('/workspace/novelai/out');
  });

  it('accepts the workspace root itself', () => {
    expect(resolveOutputDir('.')).toBe('/workspace');
  });

  it('falls back to the workspace root for an empty value', () => {
    expect(resolveOutputDir('')).toBe('/workspace');
    expect(resolveOutputDir('   ')).toBe('/workspace');
  });

  it('rejects an absolute path', () => {
    expect(() => resolveOutputDir('/etc')).toThrow(/hors du workspace/);
  });

  it('rejects a `..` traversal', () => {
    expect(() => resolveOutputDir('../..')).toThrow(/hors du workspace/);
  });

  it('rejects a traversal that only escapes after normalisation', () => {
    expect(() => resolveOutputDir('novelai/../../etc')).toThrow(/hors du workspace/);
  });

  it('resolves against the configured root, not the process cwd', () => {
    process.env.SWARM_OS_WORKSPACE_ROOT = '/srv/ws';
    const abs = resolveOutputDir('novelai');
    expect(abs).toBe(path.join('/srv/ws', 'novelai'));
    expect(abs.startsWith(process.cwd())).toBe(false);
  });
});
