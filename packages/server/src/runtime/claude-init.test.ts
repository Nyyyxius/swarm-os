import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initClaudeRuntime } from './claude-init.js';

/**
 * Phase 7 — boot-time `~/.claude` materialisation (Phase 5 module).
 *
 * Uses real temp dirs so cpSync, statSync and fs.lstatSync paths are
 * exercised end-to-end. Each test creates its own (sourceDir, runtimeDir)
 * pair and removes them after.
 */

let tmpRoot: string;
let sourceDir: string;
let runtimeDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-claude-init-'));
  sourceDir = path.join(tmpRoot, 'source');
  runtimeDir = path.join(tmpRoot, 'runtime');
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('initClaudeRuntime — source missing', () => {
  it('returns initialized=false when source dir does not exist', () => {
    const r = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r.initialized).toBe(false);
    expect(r.copied).toBe(false);
    expect(r.skipReason).toBe('source-missing');
    // runtime dir still gets created (defence in depth) so downstream code
    // can `mkdir -p sessions/<id>` against it.
    expect(fs.existsSync(runtimeDir)).toBe(true);
  });
});

describe('initClaudeRuntime — happy path', () => {
  it('copies source contents and writes the marker file', () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '.credentials.json'), '{"k":"v"}');
    fs.mkdirSync(path.join(sourceDir, 'projects', 'sample'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'projects', 'sample', 'log.txt'), 'hello');
    const r = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r.initialized).toBe(true);
    expect(r.copied).toBe(true);
    expect(r.entriesCopied).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(runtimeDir, '.credentials.json'))).toBe(true);
    expect(fs.readFileSync(path.join(runtimeDir, 'projects', 'sample', 'log.txt'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(runtimeDir, '.swarm-os-initialized'))).toBe(true);
  });

  it('cache-hits the second call when source mtime is unchanged', () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'a.txt'), 'one');
    initClaudeRuntime({ sourceDir, runtimeDir });
    const r2 = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r2.copied).toBe(false);
    expect(r2.skipReason).toBe('cache-hit');
    expect(r2.initialized).toBe(true);
  });

  it('re-copies when the source mtime changes', () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'v.txt'), 'v1');
    initClaudeRuntime({ sourceDir, runtimeDir });
    // Move source mtime forward by 1 hour (sync resolution on most FS = 1s).
    const future = Date.now() + 3_600_000;
    fs.utimesSync(sourceDir, future / 1000, future / 1000);
    fs.writeFileSync(path.join(sourceDir, 'v.txt'), 'v2');
    const r = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r.copied).toBe(true);
    expect(fs.readFileSync(path.join(runtimeDir, 'v.txt'), 'utf8')).toBe('v2');
  });
});

describe('initClaudeRuntime — claude.json lift', () => {
  it('returns claudeJson="absent" when neither implicit nor explicit source exists', () => {
    const r = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r.claudeJson).toBe('absent');
    expect(fs.existsSync(path.join(runtimeDir, '.claude.json'))).toBe(false);
  });

  it('lifts the implicit <sourceDir>.json when present', () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(`${sourceDir}.json`, '{"theme":"dark"}', { mode: 0o600 });
    const r = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r.claudeJson).toBe('lifted');
    expect(r.claudeJsonSource).toBe(`${sourceDir}.json`);
    expect(fs.readFileSync(path.join(runtimeDir, '.claude.json'), 'utf8')).toBe('{"theme":"dark"}');
    // Mode should be 0600.
    expect(fs.statSync(path.join(runtimeDir, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it('cache-hits the second lift when source mtime is unchanged', () => {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(`${sourceDir}.json`, '{"theme":"dark"}', { mode: 0o600 });
    initClaudeRuntime({ sourceDir, runtimeDir });
    const r = initClaudeRuntime({ sourceDir, runtimeDir });
    expect(r.claudeJson).toBe('cache-hit');
  });

  it('honours the explicit override path', () => {
    const altPath = path.join(tmpRoot, 'alt-claude.json');
    fs.writeFileSync(altPath, '{"override":true}', { mode: 0o600 });
    const r = initClaudeRuntime({ sourceDir, runtimeDir, claudeJsonSource: altPath });
    expect(r.claudeJson).toBe('lifted');
    expect(r.claudeJsonSource).toBe(altPath);
    expect(fs.readFileSync(path.join(runtimeDir, '.claude.json'), 'utf8')).toBe('{"override":true}');
  });
});
