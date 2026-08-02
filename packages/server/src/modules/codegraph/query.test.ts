import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { searchNodes, readGraphJson, parseLine } from './query.js';

let dir: string;
let graphPath: string;

// A small NetworkX node-link graph mirroring graphify's real shape.
const GRAPH = {
  directed: false,
  nodes: [
    { id: 'a', label: 'a.py', source_file: 'a.py', source_location: 'L1', file_type: 'code', community_name: 'a.py', norm_label: 'a.py' },
    { id: 'a_hello', label: 'hello()', source_file: 'a.py', source_location: 'L1', file_type: 'code', community_name: 'a.py', norm_label: 'hello' },
    { id: 'a_greet', label: 'greet()', source_file: 'a.py', source_location: 'L3', file_type: 'code', community_name: 'a.py', norm_label: 'greet' },
    { id: 'b_greeter', label: 'GreeterService', source_file: 'svc/b.py', source_location: 'L10-L40', file_type: 'code', community_name: 'svc', norm_label: 'greeterservice' },
  ],
  links: [{ source: 'a_hello', target: 'a_greet', relation: 'calls' }],
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-query-'));
  graphPath = path.join(dir, 'graph.json');
  fs.writeFileSync(graphPath, JSON.stringify(GRAPH));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseLine', () => {
  it('extracts the leading line number', () => {
    expect(parseLine('L3')).toBe(3);
    expect(parseLine('L10-L40')).toBe(10);
    expect(parseLine('')).toBeNull();
    expect(parseLine(undefined)).toBeNull();
  });
});

describe('readGraphJson', () => {
  it('reads nodes and links', () => {
    const g = readGraphJson(graphPath);
    expect(g?.nodes.length).toBe(4);
    expect(g?.links.length).toBe(1);
  });
  it('returns null for a missing file', () => {
    expect(readGraphJson(path.join(dir, 'nope.json'))).toBeNull();
  });
});

describe('searchNodes', () => {
  it('ranks exact/prefix matches first and carries file:line', () => {
    const res = searchNodes(graphPath, 'greet', 10);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // `greet()` (exact bare match) must outrank `GreeterService` (prefix).
    expect(res.results[0].id).toBe('a_greet');
    expect(res.results[0].file).toBe('a.py');
    expect(res.results[0].line).toBe(3);
    expect(res.results.map((r) => r.id)).toContain('b_greeter');
  });

  it('is case-insensitive', () => {
    const res = searchNodes(graphPath, 'HELLO', 10);
    expect(res.ok && res.results[0].id).toBe('a_hello');
  });

  it('matches by file name too', () => {
    const res = searchNodes(graphPath, 'svc/b.py', 10);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.results.some((r) => r.id === 'b_greeter')).toBe(true);
  });

  it('honours the limit', () => {
    const res = searchNodes(graphPath, 'a', 1);
    expect(res.ok && res.results.length).toBe(1);
  });

  it('returns ok:false for a missing graph', () => {
    const res = searchNodes(path.join(dir, 'missing.json'), 'x', 5);
    expect(res.ok).toBe(false);
  });

  it('returns [] (ok:true) when nothing matches', () => {
    const res = searchNodes(graphPath, 'zzzznotthere', 5);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.results).toEqual([]);
  });
});
