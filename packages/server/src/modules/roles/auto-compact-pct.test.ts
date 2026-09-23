/**
 * `Role.autoCompactPct` at the STORE level (docs/auto-compact.md D6, §3.3).
 *
 * The HTTP half is covered by `http/routes/roles.autocompact.route.test.ts`;
 * this file pins the three things no route can guarantee:
 *
 *  1. **`toAutoCompactPct` sanitising on READ.** The column is an INTEGER
 *     nobody re-validates on the way out, and the value decides whether an
 *     agent is compacted. A stored `250` would silently mean "never", a `-5`
 *     "on every boundary", a `35.5` an unreachable threshold — and the operator
 *     would be staring at a role that ignores the only number they can see.
 *     Every one of those reads as `null` (= inherit the instance default),
 *     which is the one outcome that is explainable.
 *
 *  2. **The `undefined` / `null` distinction in `update`.** `null` is a
 *     meaningful patch value ("back to inheriting"), `undefined` means "leave
 *     it alone". A `??` in the store would collapse the two and turn "clear the
 *     field" into a silent no-op.
 *
 *  3. **The migration.** The column arrives through `applyMigrations` only, so
 *     a second boot on the same file must not duplicate it, and a database that
 *     predates it must come back as NULL rather than as a default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SwarmDb } from '../db/index.js';
import { RoleStore, toAutoCompactPct } from './index.js';

let dir: string;
let db: SwarmDb;
let roles: RoleStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-auto-compact-'));
  db = new SwarmDb(dir);
  roles = new RoleStore(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed by a test that reopened the file */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a value straight into the column, bypassing every guard on the way in. */
function forceStoredPct(roleId: string, value: number | null): void {
  const raw = new Database(path.join(dir, 'swarm-os.db'));
  raw.prepare('UPDATE roles SET auto_compact_pct = ? WHERE id = ?').run(value, roleId);
  raw.close();
}

describe('toAutoCompactPct', () => {
  it('passes through every integer in 0..100, zero included', () => {
    for (const n of [0, 1, 35, 99, 100]) expect(toAutoCompactPct(n)).toBe(n);
  });

  it('degrades anything else to null — never to an arbitrary threshold', () => {
    for (const bad of [101, 250, -1, -5, 35.5, 0.5, NaN, Infinity, -Infinity, null, undefined]) {
      expect(toAutoCompactPct(bad), `${String(bad)}`).toBeNull();
    }
  });
});

describe('RoleStore — autoCompactPct round-trip', () => {
  it('defaults to null (inherit) on a create that does not mention it', () => {
    const role = roles.create({ label: 'plain' });
    expect(role.autoCompactPct).toBeNull();
    expect(roles.get(role.id)!.autoCompactPct).toBeNull();
  });

  it('stores and re-reads null, 0 and a threshold as three distinct states', () => {
    const inherit = roles.create({ label: 'inherit', autoCompactPct: null });
    const off = roles.create({ label: 'off', autoCompactPct: 0 });
    const own = roles.create({ label: 'own', autoCompactPct: 50 });

    expect(roles.get(inherit.id)!.autoCompactPct).toBeNull();
    // The assertion that fails if `0` is ever folded into `null` anywhere on
    // the write or the read path — the two mean opposite things.
    expect(roles.get(off.id)!.autoCompactPct).toBe(0);
    expect(roles.get(own.id)!.autoCompactPct).toBe(50);

    // …and through `list()`, which goes down a different statement than `get()`.
    const byId = new Map(roles.list().map((r) => [r.id, r.autoCompactPct]));
    expect(byId.get(inherit.id)).toBeNull();
    expect(byId.get(off.id)).toBe(0);
    expect(byId.get(own.id)).toBe(50);
  });

  it('survives a SECOND update — the column is in the UPDATE SET list', () => {
    const role = roles.create({ label: 'own', autoCompactPct: 50 });
    roles.update(role.id, { autoCompactPct: 75 });
    expect(roles.get(role.id)!.autoCompactPct).toBe(75);
    // A column present in the INSERT but missing from the UPDATE is written
    // once and never changed again, silently. This is where that shows up.
    roles.update(role.id, { autoCompactPct: 10 });
    expect(roles.get(role.id)!.autoCompactPct).toBe(10);
  });

  it('treats an explicit null patch as "back to inherit" and an omission as "unchanged"', () => {
    const role = roles.create({ label: 'own', autoCompactPct: 50 });

    // Omission: a patch about something else must not touch the threshold.
    roles.update(role.id, { label: 'renamed' });
    expect(roles.get(role.id)!.autoCompactPct).toBe(50);

    // Explicit null: the override is cleared. A `??` in the store would leave
    // this at 50 and no caller would ever learn the clear did nothing.
    roles.update(role.id, { autoCompactPct: null });
    expect(roles.get(role.id)!.autoCompactPct).toBeNull();

    // And back down to an explicit opt-out, which is NOT the same as the above.
    roles.update(role.id, { autoCompactPct: 0 });
    expect(roles.get(role.id)!.autoCompactPct).toBe(0);
  });

  it('leaves the rest of the role config alone', () => {
    const role = roles.create({
      label: 'guarded',
      costBudgetUsd: 12.5,
      budgetAction: 'pause',
      autoRemoveDeadWorkersDelayMs: 1000,
    });
    roles.update(role.id, { autoCompactPct: 20 });
    expect(roles.get(role.id)).toMatchObject({
      label: 'guarded',
      costBudgetUsd: 12.5,
      budgetAction: 'pause',
      autoRemoveDeadWorkersDelayMs: 1000,
      autoCompactPct: 20,
    });
  });
});

describe('RoleStore — a stored value the route would never have accepted', () => {
  it('reads an out-of-range / fractional column as null (inherit)', () => {
    const role = roles.create({ label: 'own', autoCompactPct: 50 });
    for (const bogus of [250, -5, 35.5, 101]) {
      forceStoredPct(role.id, bogus);
      expect(roles.get(role.id)!.autoCompactPct, `stored ${bogus}`).toBeNull();
    }
  });

  it('does not write the bogus value back on the next update', () => {
    const role = roles.create({ label: 'own', autoCompactPct: 50 });
    forceStoredPct(role.id, 250);
    // `update` re-reads through `get`, so the sanitised `null` is what gets
    // merged and re-written: a bad row heals itself at the next save rather
    // than being carried forward.
    roles.update(role.id, { label: 'renamed' });
    expect(roles.get(role.id)!.autoCompactPct).toBeNull();
  });
});

describe('auto_compact_pct — migration', () => {
  it('adds exactly one column and is idempotent across boots', () => {
    const cols = (d: SwarmDb): string[] =>
      d.db
        .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('roles')`)
        .all()
        .map((r) => r.name);
    expect(cols(db).filter((c) => c === 'auto_compact_pct')).toHaveLength(1);
    db.close();

    // Second boot on the same file: the ALTER throws "duplicate column name"
    // and `applyMigrations` swallows it — that swallow is the mechanism this
    // asserts, not an accident.
    const second = new SwarmDb(dir);
    try {
      expect(cols(second).filter((c) => c === 'auto_compact_pct')).toHaveLength(1);
    } finally {
      second.close();
    }
    // Reopen so the shared afterEach has something valid to close.
    db = new SwarmDb(dir);
  });

  it('backfills a pre-existing role to NULL — inherit, not a hardcoded default', () => {
    const legacyDir = path.join(dir, 'legacy');
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
      // A `DEFAULT 0` on the ALTER would have opted every existing role OUT of
      // a feature that ships ON; any other constant would freeze today's
      // percentage into the schema. NULL is the only honest backfill.
      expect(legacyStore.get('role-legacy')!.autoCompactPct).toBeNull();
      legacyStore.update('role-legacy', { autoCompactPct: 60 });
      expect(legacyStore.get('role-legacy')!.autoCompactPct).toBe(60);
    } finally {
      legacyDb.close();
    }
  });
});
