/**
 * Auto-compact (docs/auto-compact.md, Lot 1a) — the per-role threshold, end to
 * end through a REAL `SwarmDb`.
 *
 * Three things are pinned here, and they fail differently:
 *
 *  1. **The three-state semantics.** `null` (inherit the instance default), `0`
 *     (this role never auto-compacts) and `1..100` (this role's own threshold)
 *     are three DIFFERENT instructions. A route that folded `null` into `0`
 *     would opt a role out of a feature the operator only meant to stop
 *     overriding; one that folded `0` into `null` would auto-compact a role
 *     that explicitly asked not to be. Both failures are silent.
 *
 *  2. **The validation.** `"35"` and `3.5` are rejected rather than coerced.
 *     A string stored in an INTEGER column comes back out as something
 *     `toAutoCompactPct` refuses, so the role would revert to inheriting while
 *     the form still displays the number the operator typed — the worst kind of
 *     setting, the one that looks applied.
 *
 *  3. **The round-trip.** The column is additive (`applyMigrations` only), and a
 *     field present in the INSERT but missing from the UPDATE is written once
 *     and never changed again — nothing throws, nothing is logged. So every
 *     assertion re-reads through the store, and the update path is exercised
 *     twice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createRolesRouter } from './roles.js';
import { SwarmDb } from '../../modules/db/index.js';
import { RoleStore } from '../../modules/roles/index.js';
import type { Config } from '../../config.js';

/**
 * Deliberately NOT 35: every `defaults.autoCompactPct` assertion below would
 * pass on a hardcoded default if the instance value were the default value.
 */
const INSTANCE_PCT = 42;

let listening: Server | null = null;
let tmpRoot: string;
let db: SwarmDb;
let store: RoleStore;
let base: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-autocompact-'));
  db = new SwarmDb(path.join(tmpRoot, 'data'));
  store = new RoleStore(db);
  const app = express();
  app.use(express.json());
  app.use(
    createRolesRouter(store, {
      maxWorkersPerOrch: 8,
      autoCompactPct: INSTANCE_PCT,
    } as unknown as Config),
  );
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
});

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
  try {
    db.close?.();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function post(body: unknown): Promise<Response> {
  return fetch(`${base}/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(id: string, body: unknown): Promise<Response> {
  return fetch(`${base}/roles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Create a role and return its id, failing loudly if the create itself broke. */
async function createRole(over: Record<string, unknown> = {}): Promise<string> {
  const res = await post({ label: 'CALM', ...over });
  expect(res.status).toBe(201);
  return (await res.json()).role.id as string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('POST /roles — autoCompactPct validation', () => {
  it('accepts an explicit null as "inherit the instance default"', async () => {
    const res = await post({ label: 'CALM', autoCompactPct: null });
    expect(res.status).toBe(201);
    expect((await res.json()).role.autoCompactPct).toBeNull();
  });

  it('accepts 0 — an explicit opt-out, not an absence of setting', async () => {
    const res = await post({ label: 'CALM', autoCompactPct: 0 });
    expect(res.status).toBe(201);
    expect((await res.json()).role.autoCompactPct).toBe(0);
    // …and it is stored as 0, not collapsed to NULL on the way back out.
    expect(store.list()[0]?.autoCompactPct).toBe(0);
  });

  it('accepts both ends of the range and a value in between', async () => {
    for (const pct of [0, 1, 35, 100]) {
      const res = await post({ label: 'CALM', autoCompactPct: pct });
      expect(res.status, `autoCompactPct=${pct}`).toBe(201);
      expect((await res.json()).role.autoCompactPct).toBe(pct);
    }
  });

  it('rejects out-of-range, fractional, stringified and non-numeric values', async () => {
    // `"35"` and `3.5` are the two that would be "helpfully" coerced by a
    // lenient parser, and both would end up as a role that silently inherits.
    for (const bad of [101, -1, 3.5, '35', '', true, [], {}, [50]]) {
      const res = await post({ label: 'CALM', autoCompactPct: bad });
      expect(res.status, `autoCompactPct=${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).error).toBe(
        'autoCompactPct must be null or an integer between 0 and 100',
      );
    }
  });

  it('defaults to null (inherit) when the field is omitted entirely', async () => {
    const id = await createRole();
    expect(store.get(id)?.autoCompactPct).toBeNull();
  });
});

describe('PATCH /roles/:id — autoCompactPct', () => {
  it('applies the same rules as create, and a rejected patch changes nothing', async () => {
    const id = await createRole({ autoCompactPct: 50 });
    for (const bad of [101, -1, 3.5, '35', true]) {
      const res = await patch(id, { autoCompactPct: bad });
      expect(res.status, `autoCompactPct=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(store.get(id)?.autoCompactPct).toBe(50);
  });

  it('clears the override back to inherit through an explicit null', async () => {
    const id = await createRole({ autoCompactPct: 50 });
    expect((await patch(id, { autoCompactPct: null })).status).toBe(200);
    // The `!== undefined` guard in `RoleStore.update` is what makes this work:
    // a `??` there would have made the clear a no-op and left the role at 50.
    expect(store.get(id)?.autoCompactPct).toBeNull();
  });

  it('distinguishes "back to inherit" from "never compact this role"', async () => {
    const id = await createRole({ autoCompactPct: 50 });
    expect((await patch(id, { autoCompactPct: 0 })).status).toBe(200);
    expect(store.get(id)?.autoCompactPct).toBe(0);
    expect((await patch(id, { autoCompactPct: null })).status).toBe(200);
    expect(store.get(id)?.autoCompactPct).toBeNull();
  });

  it('leaves the field untouched when the patch does not mention it', async () => {
    const id = await createRole({ autoCompactPct: 20 });
    expect((await patch(id, { label: 'RENAMED' })).status).toBe(200);
    expect(store.get(id)).toMatchObject({ label: 'RENAMED', autoCompactPct: 20 });
  });
});

// ---------------------------------------------------------------------------
// Round-trip through a real SwarmDb
// ---------------------------------------------------------------------------

describe('auto_compact_pct column — round-trip', () => {
  it('survives create, re-read, update and a SECOND update', async () => {
    const id = await createRole({ autoCompactPct: 50 });
    // Straight out of SQLite, not out of the in-memory object the route built.
    expect(store.get(id)?.autoCompactPct).toBe(50);

    // First UPDATE — the INSERT path is behind us, this is the UPDATE statement.
    expect((await patch(id, { autoCompactPct: 75 })).status).toBe(200);
    expect(store.get(id)?.autoCompactPct).toBe(75);

    // Second UPDATE — a column missing from the SET list would freeze here.
    expect((await patch(id, { autoCompactPct: 10 })).status).toBe(200);
    expect(store.get(id)?.autoCompactPct).toBe(10);
  });

  it('exposes the field on every role view (GET one, GET list)', async () => {
    const id = await createRole({ autoCompactPct: 25 });
    const one = await (await fetch(`${base}/roles/${id}`)).json();
    expect(one.role).toMatchObject({ autoCompactPct: 25 });
    const list = await (await fetch(`${base}/roles`)).json();
    expect(list.roles[0]).toMatchObject({ autoCompactPct: 25 });
  });

  it('backfills a database that predates the column, without a catch-up UPDATE', async () => {
    // An already-deployed database never sees schema.sql (`CREATE TABLE IF NOT
    // EXISTS` skips an existing table wholesale), so this column only arrives
    // through applyMigrations. A missing ALTER means every read of an inherited
    // role explodes; a DEFAULT 0 would opt the whole fleet OUT of a feature that
    // ships ON.
    const legacyDir = path.join(tmpRoot, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const raw = new Database(path.join(legacyDir, 'swarm-os.db'));
    raw.exec(`
      CREATE TABLE roles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        lead_prompt TEXT,
        lead_preamble TEXT,
        worker_preamble TEXT,
        worker_count INTEGER,
        default_model TEXT,
        default_effort TEXT,
        default_permission_mode TEXT,
        connectors_json TEXT,
        schedule TEXT,
        schedule_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const ts = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO roles (id, label, created_at, updated_at) VALUES ('role-legacy','Legacy',?,?)`,
      )
      .run(ts, ts);
    raw.close();

    const legacyDb = new SwarmDb(legacyDir);
    try {
      const legacyStore = new RoleStore(legacyDb);
      // NULL = inherit — which is the state every pre-existing role is in.
      expect(legacyStore.get('role-legacy')?.autoCompactPct).toBeNull();
      // …and the inherited row is writable, not read-only.
      legacyStore.update('role-legacy', { autoCompactPct: 60 });
      expect(legacyStore.get('role-legacy')?.autoCompactPct).toBe(60);
    } finally {
      legacyDb.close();
    }
  });

  it('reads a hand-corrupted row as "inherit" rather than as a bogus threshold', async () => {
    const id = await createRole({ autoCompactPct: 50 });
    // Whatever put these there (a downgrade, a manual edit), a 250 would read
    // as "never compact" and a 35.5 as an unreachable threshold — both silently.
    // Written through a second connection so the value genuinely comes off disk.
    const rawDb = new Database(path.join(tmpRoot, 'data', 'swarm-os.db'));
    for (const bogus of [250, -5, 35.5]) {
      rawDb.prepare('UPDATE roles SET auto_compact_pct = ? WHERE id = ?').run(bogus, id);
      expect(store.get(id)?.autoCompactPct, `stored ${bogus}`).toBeNull();
    }
    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// The instance default served alongside the list
// ---------------------------------------------------------------------------

describe('GET /roles — defaults.autoCompactPct', () => {
  it('carries the instance default so the UI can render "inherits (N %)"', async () => {
    const body = await (await fetch(`${base}/roles`)).json();
    expect(body.defaults).toEqual({ autoCompactPct: INSTANCE_PCT });
  });

  it('is served even with no role at all, and leaves the roles array untouched', async () => {
    const body = await (await fetch(`${base}/roles`)).json();
    expect(body.roles).toEqual([]);
    expect(body.defaults.autoCompactPct).toBe(INSTANCE_PCT);

    // The array shape is unchanged by the new key: a role still carries its own
    // fields (and its cronCount), and NOT the instance default.
    const id = await createRole({ autoCompactPct: null });
    const after = await (await fetch(`${base}/roles`)).json();
    expect(after.roles).toHaveLength(1);
    expect(after.roles[0]).toMatchObject({ id, autoCompactPct: null, cronCount: 0 });
    expect(after.defaults.autoCompactPct).toBe(INSTANCE_PCT);
  });
});
