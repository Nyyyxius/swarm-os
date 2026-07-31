import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import {
  MemoryStore,
  MemoryConflictError,
  MemoryError,
  parseNote,
  serializeNote,
  parseWikiLinks,
  parseTypedLinks,
  stripTypedLinks,
} from './store.js';

let dir: string;
let db: SwarmDb;
let bus: SwarmEventBus;
let events: SwarmEvent[];
let store: MemoryStore;

function makeStore(): MemoryStore {
  return new MemoryStore(db, { dataDir: dir, eventBus: bus });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
  db = new SwarmDb(dir);
  bus = new SwarmEventBus();
  events = [];
  bus.onEvent((e) => events.push(e));
  store = makeStore();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function vaultFile(name: string): string {
  return path.join(dir, 'memory', `${name}.md`);
}

describe('parseWikiLinks', () => {
  it('extracts targets, handles aliases, dedups, and finds none', () => {
    expect(parseWikiLinks('see [[alpha]] and [[beta|the beta note]] and [[alpha]]')).toEqual([
      'alpha',
      'beta',
    ]);
    expect(parseWikiLinks('no links here')).toEqual([]);
  });
});

describe('parseTypedLinks', () => {
  it('parses a whole-line Dataview field into a typed link', () => {
    expect(parseTypedLinks('depends_on:: [[db-schema]]')).toEqual([
      { relation: 'depends_on', target: 'db-schema' },
    ]);
  });

  it('parses several targets on one field line, in order, respecting aliases', () => {
    expect(parseTypedLinks('related:: [[a]], [[b|Bee]] and [[c]]')).toEqual([
      { relation: 'related', target: 'a' },
      { relation: 'related', target: 'b' },
      { relation: 'related', target: 'c' },
    ]);
  });

  it('parses a bracketed inline field mid-sentence (both [..] and (..))', () => {
    expect(parseTypedLinks('this [supersedes:: [[old-plan]]] entirely')).toEqual([
      { relation: 'supersedes', target: 'old-plan' },
    ]);
    expect(parseTypedLinks('note (blocks:: [[ship-it]]) here')).toEqual([
      { relation: 'blocks', target: 'ship-it' },
    ]);
  });

  it('ignores a scalar field (no wikilink value) and plain wikilinks', () => {
    expect(parseTypedLinks('rating:: 5')).toEqual([]);
    expect(parseTypedLinks('just a [[plain]] link, no relation')).toEqual([]);
  });

  it('de-duplicates identical (relation,target) pairs', () => {
    expect(parseTypedLinks('uses:: [[x]]\nuses:: [[x]]')).toEqual([
      { relation: 'uses', target: 'x' },
    ]);
  });
});

describe('stripTypedLinks', () => {
  it('removes typed-field spans so their wikilinks are not counted as plain', () => {
    const body = 'see [[plain]]\ndepends_on:: [[typed]]\nand [inline:: [[both]]] too';
    const remaining = parseWikiLinks(stripTypedLinks(body));
    expect(remaining).toEqual(['plain']); // typed + inline targets stripped out
  });

  it('leaves prose and scalar `key:: value` lines untouched', () => {
    const body = 'rating:: 5\nplain prose with [[keep-me]]';
    expect(stripTypedLinks(body)).toContain('rating:: 5');
    expect(parseWikiLinks(stripTypedLinks(body))).toEqual(['keep-me']);
  });
});

describe('parseNote / serializeNote', () => {
  it('round-trips frontmatter and body', () => {
    const md = serializeNote({
      name: 'alpha-note',
      description: 'About: the alpha "release"',
      type: 'project',
      team: 'orch-1',
      createdBy: 'sess-9',
      createdAtMs: Date.parse('2026-07-31T10:00:00.000Z'),
      updatedAtMs: Date.parse('2026-07-31T12:00:00.000Z'),
      version: 3,
      metadata: { tags: ['x'] },
      body: 'The fact with a [[beta-note]] link.\n',
    });
    const p = parseNote(md, 'alpha-note');
    expect(p.name).toBe('alpha-note');
    expect(p.description).toBe('About: the alpha "release"'); // colon + quotes survive
    expect(p.type).toBe('project');
    expect(p.team).toBe('orch-1');
    expect(p.createdBy).toBe('sess-9');
    expect(p.version).toBe(3);
    expect(p.metadata).toEqual({ tags: ['x'] });
    expect(p.body).toContain('[[beta-note]]');
    expect(p.createdAtMs).toBe(Date.parse('2026-07-31T10:00:00.000Z'));
  });

  it('tolerates a hand-edited (unquoted) frontmatter', () => {
    const md = ['---', 'name: manual', 'type: entity', 'description: a plain line', '---', '', 'body'].join(
      '\n',
    );
    const p = parseNote(md, 'manual');
    expect(p.type).toBe('entity');
    expect(p.description).toBe('a plain line');
    expect(p.version).toBe(1); // default when absent
  });
});

describe('MemoryStore.upsertNote', () => {
  it('creates the vault file, the index row and is searchable', () => {
    const res = store.upsertNote({
      name: 'alpha-note',
      description: 'the alpha release plan',
      type: 'project',
      body: 'Ships the parser refactor.',
      createdBy: 'sess-1',
      team: 'orch-1',
    });
    expect(res).toEqual({ name: 'alpha-note', version: 1 });
    expect(fs.existsSync(vaultFile('alpha-note'))).toBe(true);

    const note = store.readNote('alpha-note');
    expect(note?.description).toBe('the alpha release plan');
    expect(note?.type).toBe('project');
    expect(note?.body).toContain('parser refactor');
    expect(note?.createdBy).toBe('sess-1');
    expect(note?.team).toBe('orch-1');
    expect(note?.version).toBe(1);

    const hits = store.search('parser');
    expect(hits.map((h) => h.name)).toContain('alpha-note');
    expect(hits[0]?.snippet).toBeTruthy();
    expect(typeof hits[0]?.score).toBe('number');
  });

  it('rejects an invalid / path-traversing name', () => {
    expect(() =>
      store.upsertNote({
        name: '../escape',
        description: '',
        type: 'reference',
        body: '',
        createdBy: 'x',
        team: null,
      }),
    ).toThrow(MemoryError);
  });

  it('derives edges from wikilinks and exposes in/out links', () => {
    store.upsertNote({
      name: 'alpha',
      description: 'a',
      type: 'project',
      body: 'links to [[beta]] and [[gamma]]',
      createdBy: 's',
      team: null,
    });
    store.upsertNote({
      name: 'beta',
      description: 'b',
      type: 'project',
      body: 'points back to [[alpha]]',
      createdBy: 's',
      team: null,
    });
    const alpha = store.readNote('alpha');
    expect(alpha?.outLinks.sort()).toEqual(['beta', 'gamma']);
    expect(alpha?.inLinks).toEqual(['beta']);

    const g = store.graph();
    expect(g.edges).toContainEqual({ from: 'alpha', to: 'beta' });
    expect(g.edges).toContainEqual({ from: 'beta', to: 'alpha' });
  });

  it('derives TYPED edges from body Dataview fields and exposes out/inEdges', () => {
    store.upsertNote({
      name: 'alpha',
      description: 'a',
      type: 'project',
      body: 'depends_on:: [[beta]]\n\nalso a plain [[gamma]] link',
      createdBy: 's',
      team: null,
    });
    const alpha = store.readNote('alpha');
    // Plain string DTO stays intact (backward-compat) — covers both targets.
    expect(alpha?.outLinks.sort()).toEqual(['beta', 'gamma']);
    // Typed DTO carries the relation label per edge.
    expect(alpha?.outEdges).toContainEqual({ to: 'beta', relation: 'depends_on' });
    expect(alpha?.outEdges).toContainEqual({ to: 'gamma', relation: 'links' });

    // The typed target is NOT double-counted as a plain `links` edge.
    const betaEdges = alpha?.outEdges.filter((e) => e.to === 'beta') ?? [];
    expect(betaEdges).toEqual([{ to: 'beta', relation: 'depends_on' }]);

    // The graph surfaces the typed relation; plain links omit it.
    const g = store.graph();
    expect(g.edges).toContainEqual({ from: 'alpha', to: 'beta', relation: 'depends_on' });
    expect(g.edges).toContainEqual({ from: 'alpha', to: 'gamma' });

    // Back-links carry the relation too.
    const beta = store.readNote('beta') ?? null; // dangling target has no row
    expect(beta).toBeNull();
    store.upsertNote({ name: 'beta', description: 'b', type: 'project', body: '', createdBy: 's', team: null });
    expect(store.readNote('beta')?.inEdges).toContainEqual({ from: 'alpha', relation: 'depends_on' });
  });

  it('re-derives edges on update: a removed link drops its edge', () => {
    store.upsertNote({ name: 'a', description: '', type: 'project', body: '[[b]] [[c]]', createdBy: 's', team: null });
    expect(store.readNote('a')?.outLinks.sort()).toEqual(['b', 'c']);
    store.upsertNote({ name: 'a', description: '', type: 'project', body: 'only [[b]] now', createdBy: 's', team: null });
    expect(store.readNote('a')?.outLinks).toEqual(['b']);
  });

  it('increments version, preserves created_at, and enforces the optimistic lock', () => {
    const first = store.upsertNote({ name: 'n', description: 'v1', type: 'project', body: 'x', createdBy: 's', team: null });
    expect(first.version).toBe(1);
    const createdAt = store.readNote('n')!.createdAt;

    const second = store.upsertNote({ name: 'n', description: 'v2', type: 'project', body: 'y', createdBy: 's', team: null, expectedVersion: 1 });
    expect(second.version).toBe(2);
    expect(store.readNote('n')!.createdAt).toBe(createdAt); // preserved

    // Stale writer passes the old version -> conflict.
    expect(() =>
      store.upsertNote({ name: 'n', description: 'v3', type: 'project', body: 'z', createdBy: 's', team: null, expectedVersion: 1 }),
    ).toThrow(MemoryConflictError);
    // The note was not clobbered by the failed write.
    expect(store.readNote('n')!.version).toBe(2);
  });

  it('normalizes an unknown type to reference', () => {
    store.upsertNote({ name: 'weird', description: '', type: 'nonsense', body: '', createdBy: 's', team: null });
    expect(store.readNote('weird')?.type).toBe('reference');
  });
});

describe('MemoryStore.search', () => {
  beforeEach(() => {
    store.upsertNote({ name: 'a', description: 'alpha release notes', type: 'project', body: 'parser refactor', createdBy: 's', team: null });
    store.upsertNote({ name: 'b', description: 'bob the user', type: 'user', body: 'prefers dark mode', createdBy: 's', team: null });
  });

  it('ranks matches and filters by type', () => {
    expect(store.search('release').map((h) => h.name)).toContain('a');
    expect(store.search('mode').map((h) => h.name)).toContain('b');
    expect(store.search('e', 'user').every((h) => h.type === 'user')).toBe(true);
  });

  it('returns [] for an empty/punctuation-only query', () => {
    expect(store.search('   ')).toEqual([]);
    expect(store.search('!!!')).toEqual([]);
  });
});

describe('MemoryStore.list', () => {
  it('filters by type and prefix', () => {
    store.upsertNote({ name: 'proj-a', description: '', type: 'project', body: '', createdBy: 's', team: null });
    store.upsertNote({ name: 'proj-b', description: '', type: 'project', body: '', createdBy: 's', team: null });
    store.upsertNote({ name: 'user-1', description: '', type: 'user', body: '', createdBy: 's', team: null });
    expect(store.list('project').map((n) => n.name).sort()).toEqual(['proj-a', 'proj-b']);
    expect(store.list(null, 'proj').map((n) => n.name).sort()).toEqual(['proj-a', 'proj-b']);
    expect(store.list('user').map((n) => n.name)).toEqual(['user-1']);
  });
});

describe('MemoryStore.addLink / neighbors', () => {
  it('adds a typed edge that surfaces in the graph and neighbours', () => {
    store.upsertNote({ name: 'x', description: '', type: 'entity', body: '', createdBy: 's', team: null });
    store.upsertNote({ name: 'y', description: '', type: 'entity', body: '', createdBy: 's', team: null });
    expect(store.addLink('x', 'y', 'depends_on')).toBe(true);
    expect(store.graph().edges).toContainEqual({ from: 'x', to: 'y', relation: 'depends_on' });
    const n = store.neighbors('x', 1);
    expect(n.nodes.map((nn) => nn.name).sort()).toEqual(['x', 'y']);
    expect(n.edges).toContainEqual({ from: 'x', to: 'y', relation: 'depends_on' });
  });

  it('a MANUAL (addLink) edge survives a body re-derivation of the source note', () => {
    store.upsertNote({ name: 'x', description: '', type: 'entity', body: 'v1', createdBy: 's', team: null });
    store.upsertNote({ name: 'y', description: '', type: 'entity', body: '', createdBy: 's', team: null });
    store.addLink('x', 'y', 'uses');
    // Rewriting x's body re-derives its BODY edges but must not wipe the manual one.
    store.upsertNote({ name: 'x', description: '', type: 'entity', body: 'v2 [[y]]', createdBy: 's', team: null });
    const edges = store.readNote('x')?.outEdges ?? [];
    expect(edges).toContainEqual({ to: 'y', relation: 'uses' }); // manual, preserved
    expect(edges).toContainEqual({ to: 'y', relation: 'links' }); // freshly derived
  });

  it('listRelations reports distinct relation labels in use', () => {
    store.upsertNote({ name: 'a', description: '', type: 'project', body: 'blocks:: [[b]]', createdBy: 's', team: null });
    store.upsertNote({ name: 'b', description: '', type: 'project', body: '[[a]]', createdBy: 's', team: null });
    store.addLink('a', 'b', 'uses');
    expect(store.listRelations().sort()).toEqual(['blocks', 'links', 'uses']);
  });
});

describe('MemoryStore.deleteNote', () => {
  it('removes the file, the row, its edges, and reports existence', () => {
    store.upsertNote({ name: 'a', description: '', type: 'project', body: '[[b]]', createdBy: 's', team: null });
    expect(store.deleteNote('a')).toBe(true);
    expect(fs.existsSync(vaultFile('a'))).toBe(false);
    expect(store.readNote('a')).toBeNull();
    expect(store.graph().edges).toEqual([]);
    // Deleting an absent note is a no-op that reports false.
    expect(store.deleteNote('nope')).toBe(false);
  });
});

describe('MemoryStore events', () => {
  it('emits node_created, node_updated, edge_created and node_deleted', () => {
    events.length = 0;
    store.upsertNote({ name: 'a', description: '', type: 'project', body: '[[b]]', createdBy: 's', team: null });
    store.upsertNote({ name: 'a', description: 'x', type: 'project', body: '[[b]]', createdBy: 's', team: null });
    store.deleteNote('a');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('memory.node_created');
    expect(kinds).toContain('memory.node_updated');
    expect(kinds).toContain('memory.edge_created');
    expect(kinds).toContain('memory.node_deleted');
    const created = events.find((e) => e.kind === 'memory.node_created');
    expect(created?.payload).toEqual({ name: 'a', type: 'project' });
    const edge = events.find((e) => e.kind === 'memory.edge_created');
    expect(edge?.payload).toEqual({ from: 'a', to: 'b' });
  });
});

describe('MemoryStore boot reindex', () => {
  it('indexes vault .md files absent from the SQLite mirror', () => {
    // Write a note file straight into the vault of a FRESH db, then construct a
    // store: reindex must pick it up (files are the source of truth).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reindex-'));
    const db2 = new SwarmDb(dir2);
    try {
      fs.mkdirSync(path.join(dir2, 'memory'), { recursive: true });
      const md = serializeNote({
        name: 'seeded',
        description: 'seeded from disk',
        type: 'reference',
        team: null,
        createdBy: 'disk',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        version: 5,
        metadata: {},
        body: 'a fact linking [[other]]',
      });
      fs.writeFileSync(path.join(dir2, 'memory', 'seeded.md'), md, 'utf8');

      const store2 = new MemoryStore(db2, { dataDir: dir2 });
      const note = store2.readNote('seeded');
      expect(note?.description).toBe('seeded from disk');
      expect(note?.version).toBe(5);
      expect(note?.outLinks).toEqual(['other']);
      expect(store2.search('fact').map((h) => h.name)).toContain('seeded');
    } finally {
      db2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('re-derives TYPED body edges from disk on a fresh reindex (durability)', () => {
    // A typed relation encoded in the body must round-trip through the markdown:
    // a brand-new SQLite mirror rebuilt from the vault still has the typed edge.
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-typed-reindex-'));
    const db3 = new SwarmDb(dir3);
    try {
      fs.mkdirSync(path.join(dir3, 'memory'), { recursive: true });
      const md = serializeNote({
        name: 'plan',
        description: 'the plan',
        type: 'decision',
        team: null,
        createdBy: 'disk',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        version: 1,
        metadata: {},
        body: 'depends_on:: [[db-schema]]\n\nsee also [[appendix]]',
      });
      fs.writeFileSync(path.join(dir3, 'memory', 'plan.md'), md, 'utf8');

      const store3 = new MemoryStore(db3, { dataDir: dir3 });
      const note = store3.readNote('plan');
      expect(note?.outEdges).toContainEqual({ to: 'db-schema', relation: 'depends_on' });
      expect(note?.outEdges).toContainEqual({ to: 'appendix', relation: 'links' });
      expect(store3.graph().edges).toContainEqual({
        from: 'plan',
        to: 'db-schema',
        relation: 'depends_on',
      });
    } finally {
      db3.close();
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  });
});
