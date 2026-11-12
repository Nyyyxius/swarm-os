import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the CLI layer so unit tests never require the real graphify binary.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFile, spawnSync } from 'node:child_process';
import { probeGraphify, runUpdate, parseCounts } from './graphify.js';

const execFileMock = execFile as unknown as Mock;
/** Node's `execFile` completion callback, as the mocks below invoke it. */
type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
const spawnSyncMock = spawnSync as unknown as Mock;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graphify-'));
  execFileMock.mockReset();
  spawnSyncMock.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseCounts', () => {
  it('parses counts from the graphify stdout line', () => {
    expect(parseCounts('[graphify watch] Rebuilt: 5 nodes, 4 edges, 2 communities', dir)).toEqual({
      nodeCount: 5,
      edgeCount: 4,
    });
  });

  it('falls back to graph.json when stdout has no count line', () => {
    const outDir = path.join(dir, 'graphify-out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'graph.json'),
      JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'b' }] }),
    );
    expect(parseCounts('no counts here', outDir)).toEqual({ nodeCount: 3, edgeCount: 1 });
  });

  it('returns zeros when neither source is available', () => {
    expect(parseCounts('nothing', path.join(dir, 'missing'))).toEqual({ nodeCount: 0, edgeCount: 0 });
  });
});

describe('probeGraphify', () => {
  it('reports available + version on a clean --version', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'graphify 0.9.32\n', stderr: '' });
    expect(probeGraphify('graphify')).toEqual({ available: true, version: 'graphify 0.9.32' });
  });

  it('reports unavailable when the binary is missing (ENOENT)', () => {
    spawnSyncMock.mockReturnValue({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
    const res = probeGraphify('graphify');
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not on PATH/);
  });

  it('reports unavailable on non-zero exit', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'bad' });
    expect(probeGraphify('graphify').available).toBe(false);
  });
});

describe('runUpdate', () => {
  it('prepares the index dir, seeds the build config, and passes GRAPHIFY_OUT', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedArgs: string[] | undefined;
    execFileMock.mockImplementation((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }, cb: ExecFileCallback) => {
      capturedArgs = args;
      capturedEnv = opts.env;
      cb(null, '[graphify watch] Rebuilt: 8 nodes, 6 edges, 3 communities', '');
    });

    const res = await runUpdate({
      bin: 'graphify',
      sourceDir: '/ws/app',
      indexDir: path.join(dir, 'idx'),
      engine: 'ast',
      timeoutMs: 1000,
    });

    expect(res).toEqual({ ok: true, nodeCount: 8, edgeCount: 6 });
    // Argv is the AST `update` verb against the source dir.
    expect(capturedArgs).toEqual(['update', '/ws/app']);
    // Output redirected to our index dir, never the source.
    const outDir = path.join(dir, 'idx', 'graphify-out');
    expect(capturedEnv?.GRAPHIFY_OUT).toBe(outDir);
    // Build config seeded with our excludes (no .graphifyignore in the source).
    const cfg = JSON.parse(fs.readFileSync(path.join(outDir, '.graphify_build.json'), 'utf8'));
    expect(cfg.gitignore).toBe(true);
    expect(cfg.excludes).toContain('node_modules/');
  });

  it('uses the extract verb when engine=extract (opt-in stub)', async () => {
    let capturedArgs: string[] | undefined;
    execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      capturedArgs = args;
      cb(null, 'Rebuilt: 1 nodes, 0 edges', '');
    });
    await runUpdate({ bin: 'graphify', sourceDir: '/ws/app', indexDir: path.join(dir, 'idx'), engine: 'extract', timeoutMs: 1000 });
    expect(capturedArgs?.[0]).toBe('extract');
  });

  it('never throws — a CLI error comes back as { ok:false }', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(Object.assign(new Error('boom'), { killed: false }), '', 'graphify exploded');
    });
    const res = await runUpdate({ bin: 'graphify', sourceDir: '/ws/app', indexDir: path.join(dir, 'idx'), engine: 'ast', timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exploded/);
  });

  it('flags a timeout (SIGTERM) on the result', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }), '', '');
    });
    const res = await runUpdate({ bin: 'graphify', sourceDir: '/ws/app', indexDir: path.join(dir, 'idx'), engine: 'ast', timeoutMs: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.timedOut).toBe(true);
  });

  it('adds extraExcludes as name/ patterns in the seeded build config', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => cb(null, 'Rebuilt: 0 nodes, 0 edges', ''));
    const indexDir = path.join(dir, 'idx');
    await runUpdate({ bin: 'graphify', sourceDir: '/ws', indexDir, engine: 'ast', timeoutMs: 1000, extraExcludes: ['app', 'lib'] });
    const cfg = JSON.parse(fs.readFileSync(path.join(indexDir, 'graphify-out', '.graphify_build.json'), 'utf8'));
    expect(cfg.excludes).toContain('app/');
    expect(cfg.excludes).toContain('lib/');
    expect(cfg.excludes).toContain('node_modules/'); // defaults still present
  });

  it('merges into an existing build config, preserving graphify-written keys', async () => {
    const outDir = path.join(dir, 'idx', 'graphify-out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '.graphify_build.json'), JSON.stringify({ someGraphifyKey: 42, excludes: ['old/'] }));
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => cb(null, 'Rebuilt: 0 nodes, 0 edges', ''));
    await runUpdate({ bin: 'graphify', sourceDir: '/ws/app', indexDir: path.join(dir, 'idx'), engine: 'ast', timeoutMs: 1000 });
    const cfg = JSON.parse(fs.readFileSync(path.join(outDir, '.graphify_build.json'), 'utf8'));
    expect(cfg.someGraphifyKey).toBe(42); // preserved
    expect(cfg.excludes).toContain('node_modules/'); // ours won
  });
});
