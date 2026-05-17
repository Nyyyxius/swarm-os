import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspaceRelativeCwd, validateCwdUnderWorkspace } from './validation.js';

/**
 * Phase 7 — `cwd` validation.
 *
 * The validator is the single security gate that every spawn path goes
 * through (REST `POST /orchestrators` and MCP `team.spawn_worker`). We test
 * the load-bearing edge cases:
 *
 *   - resolves under workspace → pass
 *   - traversal via `..`        → reject
 *   - symlink that escapes      → reject (because `realpath` follows)
 *   - non-absolute path         → still works as long as it resolves under
 *                                 the workspace; path normalisation is
 *                                 fs.realpath's job
 *   - workspace itself          → pass (it IS under itself)
 *   - trailing/double slash     → normalised by realpath
 */

let tmpRoot: string;
let workspaceRoot: string;
let outsideRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-validate-'));
  workspaceRoot = path.join(tmpRoot, 'workspace');
  outsideRoot = path.join(tmpRoot, 'outside');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('validateCwdUnderWorkspace', () => {
  it('accepts a directory directly under the workspace root', async () => {
    const sub = path.join(workspaceRoot, 'project-a');
    fs.mkdirSync(sub);
    const resolved = await validateCwdUnderWorkspace(sub, workspaceRoot);
    // realpath strips macOS /private prefixes etc. — compare via realpath too.
    expect(resolved).toBe(fs.realpathSync(sub));
  });

  it('accepts the workspace root itself', async () => {
    const resolved = await validateCwdUnderWorkspace(workspaceRoot, workspaceRoot);
    expect(resolved).toBe(fs.realpathSync(workspaceRoot));
  });

  it('rejects a path that traverses out via "..".', async () => {
    const escape = path.join(workspaceRoot, '..', 'outside');
    await expect(validateCwdUnderWorkspace(escape, workspaceRoot)).rejects.toThrow(
      /not under workspace root/,
    );
  });

  it('rejects a symlink whose target escapes the workspace', async () => {
    const link = path.join(workspaceRoot, 'escape-link');
    fs.symlinkSync(outsideRoot, link);
    await expect(validateCwdUnderWorkspace(link, workspaceRoot)).rejects.toThrow(
      /not under workspace root/,
    );
  });

  it('accepts a symlink whose target stays inside the workspace', async () => {
    const target = path.join(workspaceRoot, 'real-project');
    fs.mkdirSync(target);
    const link = path.join(workspaceRoot, 'project-link');
    fs.symlinkSync(target, link);
    const resolved = await validateCwdUnderWorkspace(link, workspaceRoot);
    expect(resolved).toBe(fs.realpathSync(target));
  });

  it('rejects a non-existent path', async () => {
    await expect(
      validateCwdUnderWorkspace(path.join(workspaceRoot, 'does-not-exist'), workspaceRoot),
    ).rejects.toThrow(/cannot be resolved/);
  });

  it('rejects an empty cwd', async () => {
    await expect(validateCwdUnderWorkspace('', workspaceRoot)).rejects.toThrow(
      /cwd must be a non-empty string/,
    );
  });

  it('normalises trailing and double slashes (still resolves under root)', async () => {
    const sub = path.join(workspaceRoot, 'projB');
    fs.mkdirSync(sub);
    const messy = `${sub}//`;
    const resolved = await validateCwdUnderWorkspace(messy, workspaceRoot);
    expect(resolved).toBe(fs.realpathSync(sub));
  });

  it('rejects a fully-qualified path outside the workspace', async () => {
    await expect(validateCwdUnderWorkspace(outsideRoot, workspaceRoot)).rejects.toThrow(
      /not under workspace root/,
    );
  });
});

describe('normalizeWorkspaceRelativeCwd', () => {
  const root = '/workspace';

  it('maps "/" to the workspace root itself', () => {
    expect(normalizeWorkspaceRelativeCwd('/', root)).toBe(root);
  });

  it('maps "/reviewer" to "/workspace/reviewer"', () => {
    expect(normalizeWorkspaceRelativeCwd('/reviewer', root)).toBe('/workspace/reviewer');
  });

  it('maps a bare name "reviewer" to "/workspace/reviewer"', () => {
    expect(normalizeWorkspaceRelativeCwd('reviewer', root)).toBe('/workspace/reviewer');
  });

  it('keeps a path already under the workspace root as-is (backward compat)', () => {
    expect(normalizeWorkspaceRelativeCwd('/workspace/foo', root)).toBe('/workspace/foo');
  });

  it('keeps the workspace root itself as-is', () => {
    expect(normalizeWorkspaceRelativeCwd(root, root)).toBe(root);
  });

  it('does NOT match a sibling that shares a prefix (e.g. /workspace2)', () => {
    expect(normalizeWorkspaceRelativeCwd('/workspace2/foo', root)).toBe(
      '/workspace/workspace2/foo',
    );
  });
});
