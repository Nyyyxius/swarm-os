import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import { GraphStore } from './store.js';

let dir: string;
let db: SwarmDb;
let store: GraphStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-store-'));
  db = new SwarmDb(dir);
  store = new GraphStore(db, { dataDir: dir });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GraphStore', () => {
  it('creates the index root under <dataDir>/codegraph', () => {
    expect(fs.existsSync(path.join(dir, 'codegraph'))).toBe(true);
  });

  it('indexDirFor returns a per-scope path under the index root', () => {
    expect(store.indexDirFor('project__foo')).toBe(path.join(dir, 'codegraph', 'project__foo'));
  });

  it('inserts a new enabled scope as pending and reads it back', () => {
    const s = store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    expect(s).not.toBeNull();
    expect(s?.status).toBe('pending');
    expect(s?.enabled).toBe(true);
    expect(s?.nodeCount).toBe(0);
    expect(s?.lastSourceHash).toBeNull();
    expect(store.getScope('project__foo')?.path).toBe('/ws/foo');
  });

  it('inserts a code-less scope as disabled', () => {
    const s = store.upsertScope({ id: 'project__docs', kind: 'project', path: '/ws/docs', enabled: false });
    expect(s?.status).toBe('disabled');
    expect(s?.enabled).toBe(false);
  });

  it('upsert refreshes descriptor without clobbering index state', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.recordIndexResult('project__foo', { nodeCount: 12, edgeCount: 20, sourceHash: 'abc' });
    // Re-discovery with a moved path must keep counts + hash + indexed status.
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo2', enabled: true });
    const s = store.getScope('project__foo');
    expect(s?.path).toBe('/ws/foo2');
    expect(s?.nodeCount).toBe(12);
    expect(s?.lastSourceHash).toBe('abc');
    expect(s?.status).toBe('indexed');
  });

  it('recordIndexResult stamps counts, hash, indexed status and clears error', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.setStatus('project__foo', 'error', 'boom');
    expect(store.getScope('project__foo')?.lastError).toBe('boom');
    store.recordIndexResult('project__foo', { nodeCount: 3, edgeCount: 4, sourceHash: 'h1' });
    const s = store.getScope('project__foo');
    expect(s?.status).toBe('indexed');
    expect(s?.nodeCount).toBe(3);
    expect(s?.edgeCount).toBe(4);
    expect(s?.lastSourceHash).toBe('h1');
    expect(s?.lastError).toBeNull();
    expect(s?.lastIndexedAt).toBeGreaterThan(0);
  });

  it('setEnabled(false) parks an indexed scope at disabled', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.recordIndexResult('project__foo', { nodeCount: 1, edgeCount: 0, sourceHash: 'h' });
    store.setEnabled('project__foo', false);
    const s = store.getScope('project__foo');
    expect(s?.enabled).toBe(false);
    expect(s?.status).toBe('disabled');
  });

  it('setEnabled is a no-op when the flag does not change (keeps indexed status)', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.recordIndexResult('project__foo', { nodeCount: 1, edgeCount: 0, sourceHash: 'h' });
    store.setEnabled('project__foo', true); // already enabled
    expect(store.getScope('project__foo')?.status).toBe('indexed');
  });

  it('re-enabling a disabled scope resets it to pending', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: false });
    store.setEnabled('project__foo', true);
    expect(store.getScope('project__foo')?.status).toBe('pending');
  });

  it('purgeAll empties the table but keeps the store writable (DELETE, not DROP)', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.recordIndexResult('project__foo', { nodeCount: 5, edgeCount: 4, sourceHash: 'h' });
    store.upsertScope({ id: 'plugin__bar', kind: 'plugin', path: '/ws/bar', enabled: true });
    expect(store.listScopes()).toHaveLength(2);

    store.purgeAll();
    expect(store.listScopes()).toEqual([]);

    // The prepared statements must still work after a purge — a re-enable finds
    // the store present and simply empty (the whole point of DELETE-not-DROP).
    const s = store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    expect(s?.status).toBe('pending');
    expect(store.listScopes()).toHaveLength(1);
  });

  it('removeScope deletes the row', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.removeScope('project__foo');
    expect(store.getScope('project__foo')).toBeNull();
  });

  it('listScopes returns all rows ordered by id', () => {
    store.upsertScope({ id: 'project__b', kind: 'project', path: '/ws/b', enabled: true });
    store.upsertScope({ id: 'project__a', kind: 'project', path: '/ws/a', enabled: true });
    store.upsertScope({ id: 'plugin__z', kind: 'plugin', path: '/data/plugins/z', enabled: true });
    const ids = store.listScopes().map((s) => s.id);
    expect(ids).toEqual(['plugin__z', 'project__a', 'project__b']);
  });

  it('survives a reopen — the table persists on the shared Db', () => {
    store.upsertScope({ id: 'project__foo', kind: 'project', path: '/ws/foo', enabled: true });
    store.recordIndexResult('project__foo', { nodeCount: 7, edgeCount: 9, sourceHash: 'z' });
    db.close();
    db = new SwarmDb(dir);
    const store2 = new GraphStore(db, { dataDir: dir });
    expect(store2.getScope('project__foo')?.nodeCount).toBe(7);
  });
});

describe('GraphStore events', () => {
  let bus: SwarmEventBus;
  let events: SwarmEvent[];
  let estore: GraphStore;

  beforeEach(() => {
    bus = new SwarmEventBus();
    events = [];
    bus.onEvent((e) => events.push(e));
    estore = new GraphStore(db, { dataDir: dir, eventBus: bus });
  });

  it('emits code.graph.indexed with counts on recordIndexResult', () => {
    estore.upsertScope({ id: 'project__app', kind: 'project', path: '/ws/app', enabled: true });
    estore.recordIndexResult('project__app', { nodeCount: 5, edgeCount: 4, sourceHash: 'h' });
    const ev = events.find((e) => e.kind === 'code.graph.indexed');
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ scopeId: 'project__app', kind: 'project', nodeCount: 5, edgeCount: 4 });
  });

  it('emits scope_enabled / scope_disabled on a real transition only', () => {
    estore.upsertScope({ id: 'project__app', kind: 'project', path: '/ws/app', enabled: false });
    events.length = 0;
    estore.setEnabled('project__app', true);
    estore.setEnabled('project__app', true); // no-op, no second event
    estore.setEnabled('project__app', false);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['code.graph.scope_enabled', 'code.graph.scope_disabled']);
  });

  it('emits scope_disabled on removeScope', () => {
    estore.upsertScope({ id: 'project__app', kind: 'project', path: '/ws/app', enabled: true });
    events.length = 0;
    estore.removeScope('project__app');
    expect(events.map((e) => e.kind)).toContain('code.graph.scope_disabled');
  });
});
