import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { MemoryStore } from '../memory/store.js';
import { GraphStore } from './store.js';
import { CodegraphMemoryNotes, scopeNoteName, HUB_NOTE_NAME } from './memory-notes.js';

let dir: string;
let db: SwarmDb;
let memory: MemoryStore;
let store: GraphStore;
let notes: CodegraphMemoryNotes;

const NODES = [
  { id: 'a', label: 'a.py', source_file: 'a.py', source_location: 'L1', file_type: 'code', community_name: 'a.py', norm_label: 'a.py' },
  { id: 'a_hello', label: 'hello()', source_file: 'a.py', source_location: 'L1', file_type: 'code', community_name: 'a.py', norm_label: 'hello' },
  { id: 'a_greet', label: 'greet()', source_file: 'a.py', source_location: 'L3', file_type: 'code', community_name: 'a.py', norm_label: 'greet' },
];
const LINKS = [
  { source: 'a', target: 'a_hello', relation: 'contains' },
  { source: 'a', target: 'a_greet', relation: 'contains' },
  { source: 'a_hello', target: 'a_greet', relation: 'calls' },
];

/** Register + index a scope and drop a graph.json for topHubs. */
function seedScope(id: string, nodeCount = NODES.length, edgeCount = LINKS.length): void {
  store.upsertScope({ id, kind: 'project', path: `/ws/${id}`, enabled: true });
  store.recordIndexResult(id, { nodeCount, edgeCount, sourceHash: 'h' });
  const outDir = path.join(store.indexDirFor(id), 'graphify-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify({ directed: false, nodes: NODES, links: LINKS }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-notes-'));
  db = new SwarmDb(dir);
  memory = new MemoryStore(db, { dataDir: dir });
  store = new GraphStore(db, { dataDir: dir });
  notes = new CodegraphMemoryNotes(memory, store);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CodegraphMemoryNotes', () => {
  it('writes a managed per-scope note with counts, hubs and a hub backlink', () => {
    seedScope('project__app');
    notes.syncScope('project__app');
    const note = memory.readNote(scopeNoteName('project__app'));
    expect(note).not.toBeNull();
    expect(note!.type).toBe('reference');
    expect(note!.body).toContain('# Code graph — project__app');
    expect(note!.body).toContain('Nodes / edges:** 3 / 3');
    expect(note!.body).toContain('do not edit by hand');
    // Top hubs pulled from graph.json with file:line.
    expect(note!.body).toMatch(/`greet\(\)` — a\.py:3/);
    // Backlink to the hub → forms a wikilink edge.
    expect(note!.body).toContain(`[[${HUB_NOTE_NAME}]]`);
    expect(note!.outLinks).toContain(HUB_NOTE_NAME);
  });

  it('is idempotent — an unchanged sync does not bump the note version', () => {
    seedScope('project__app');
    notes.syncScope('project__app');
    const v1 = memory.readNote(scopeNoteName('project__app'))!.version;
    notes.syncScope('project__app'); // same data
    const v2 = memory.readNote(scopeNoteName('project__app'))!.version;
    expect(v2).toBe(v1);
  });

  it('rewrites the note (version bumps) when counts change', () => {
    seedScope('project__app');
    notes.syncScope('project__app');
    const v1 = memory.readNote(scopeNoteName('project__app'))!.version;
    store.recordIndexResult('project__app', { nodeCount: 99, edgeCount: 120, sourceHash: 'h2' });
    notes.syncScope('project__app');
    const note = memory.readNote(scopeNoteName('project__app'))!;
    expect(note.version).toBe(v1 + 1);
    expect(note.body).toContain('99 / 120');
  });

  it('refreshHub lists indexed scopes as wikilinks', () => {
    seedScope('project__app');
    seedScope('plugin__novelai');
    notes.refreshHub();
    const hub = memory.readNote(HUB_NOTE_NAME);
    expect(hub).not.toBeNull();
    expect(hub!.body).toContain(`[[${scopeNoteName('project__app')}]]`);
    expect(hub!.body).toContain(`[[${scopeNoteName('plugin__novelai')}]]`);
  });

  it('hub omits a scope that has no note yet (never indexed → no dangling link)', () => {
    store.upsertScope({ id: 'project__pending', kind: 'project', path: '/ws/p', enabled: true });
    notes.refreshHub();
    const hub = memory.readNote(HUB_NOTE_NAME);
    expect(hub!.body).not.toContain('project__pending');
    expect(hub!.body).toContain('No code scope is currently indexed');
  });

  it('removeScope deletes the per-scope note', () => {
    seedScope('project__app');
    notes.syncScope('project__app');
    expect(memory.readNote(scopeNoteName('project__app'))).not.toBeNull();
    notes.removeScope('project__app');
    expect(memory.readNote(scopeNoteName('project__app'))).toBeNull();
  });

  it('removeAll drops the hub AND every per-scope note (feature purge, D7)', () => {
    seedScope('project__app');
    seedScope('plugin__novelai');
    notes.syncScope('project__app');
    notes.syncScope('plugin__novelai');
    notes.refreshHub();
    expect(memory.readNote(HUB_NOTE_NAME)).not.toBeNull();
    expect(memory.readNote(scopeNoteName('project__app'))).not.toBeNull();
    expect(memory.readNote(scopeNoteName('plugin__novelai'))).not.toBeNull();

    notes.removeAll();

    expect(memory.readNote(HUB_NOTE_NAME)).toBeNull();
    expect(memory.readNote(scopeNoteName('project__app'))).toBeNull();
    expect(memory.readNote(scopeNoteName('plugin__novelai'))).toBeNull();
  });

  it('no-ops safely when memory is absent', () => {
    const noMem = new CodegraphMemoryNotes(null, store);
    seedScope('project__app');
    expect(noMem.enabled).toBe(false);
    expect(() => {
      noMem.syncScope('project__app');
      noMem.refreshHub();
      noMem.removeScope('project__app');
      noMem.removeAll();
    }).not.toThrow();
  });
});
