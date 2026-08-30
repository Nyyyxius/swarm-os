/**
 * Lot 14 — the cost-budget fields of a role, end to end.
 *
 * Two things are pinned here, and they fail differently:
 *
 *  1. **The validation.** A budget is a guard-rail that can SIGSTOP a whole
 *     team, so an amount the operator did not mean must never reach the store.
 *     `0` in particular is rejected rather than stored: a zero ceiling is
 *     crossed by every team on its first tick, so an operator who typed `0`
 *     meaning "no budget" would pause their fleet. `budgetAction` is a strict
 *     whitelist for the mirror-image reason — a typo'd action that silently
 *     degrades to `notify` is a guard-rail nobody notices is off.
 *
 *  2. **The round-trip.** The columns are additive (`applyMigrations` only), and
 *     a field present in the INSERT but missing from the UPDATE is written once
 *     and never changed again — nothing throws, nothing is logged. So every
 *     assertion below re-reads through a REAL `SwarmDb`, and the update path is
 *     exercised twice.
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

let listening: Server | null = null;
let tmpRoot: string;
let db: SwarmDb;
let store: RoleStore;
let base: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-budget-'));
  db = new SwarmDb(path.join(tmpRoot, 'data'));
  store = new RoleStore(db);
  const app = express();
  app.use(express.json());
  app.use(createRolesRouter(store, { maxWorkersPerOrch: 8 } as unknown as Config));
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

describe('POST /roles — costBudgetUsd validation', () => {
  it('rejects 0 rather than storing a ceiling every team is instantly over', async () => {
    const res = await post({ label: 'CALM', costBudgetUsd: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/costBudgetUsd/);
  });

  it('rejects negative and non-numeric amounts', async () => {
    // NaN / Infinity are absent on purpose: `JSON.stringify` turns both into
    // `null`, so they are unreachable over HTTP. The `Number.isFinite` guard
    // that catches them exists for the DB read path, covered further down.
    for (const bad of [-1, -0.01, '50', '', true, [], {}]) {
      const res = await post({ label: 'CALM', costBudgetUsd: bad });
      expect(res.status, `costBudgetUsd=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('rejects an absurd amount (fat-finger guard)', async () => {
    expect((await post({ label: 'CALM', costBudgetUsd: 1_000_001 })).status).toBe(400);
    expect((await post({ label: 'CALM', costBudgetUsd: 1_000_000 })).status).toBe(201);
  });

  it('accepts a positive amount, including a fractional one', async () => {
    const res = await post({ label: 'CALM', costBudgetUsd: 12.5 });
    expect(res.status).toBe(201);
    expect((await res.json()).role.costBudgetUsd).toBe(12.5);
  });

  it('accepts an explicit null as "no budget"', async () => {
    const res = await post({ label: 'CALM', costBudgetUsd: null });
    expect(res.status).toBe(201);
    expect((await res.json()).role.costBudgetUsd).toBeNull();
  });
});

describe('POST /roles — budgetAction whitelist', () => {
  it('accepts exactly notify and pause', async () => {
    for (const action of ['notify', 'pause']) {
      const res = await post({ label: 'CALM', costBudgetUsd: 10, budgetAction: action });
      expect(res.status).toBe(201);
      expect((await res.json()).role.budgetAction).toBe(action);
    }
  });

  it('rejects anything else — including a near-miss that would degrade to notify', async () => {
    for (const bad of ['Pause', 'PAUSE', 'stop', 'kill', '', 1, true, null, ['pause']]) {
      const res = await post({ label: 'CALM', costBudgetUsd: 10, budgetAction: bad });
      expect(res.status, `budgetAction=${JSON.stringify(bad)}`).toBe(400);
      expect((await res.json()).error).toMatch(/budgetAction must be one of notify\|pause/);
    }
  });

  it('defaults to notify — the non-destructive outcome is never the one you get by omission', async () => {
    const res = await post({ label: 'CALM', costBudgetUsd: 10 });
    expect((await res.json()).role.budgetAction).toBe('notify');
  });
});

describe('PATCH /roles/:id — budget fields', () => {
  it('applies the same rules as create', async () => {
    const id = await createRole({ costBudgetUsd: 50, budgetAction: 'pause' });
    expect((await patch(id, { costBudgetUsd: 0 })).status).toBe(400);
    expect((await patch(id, { costBudgetUsd: -5 })).status).toBe(400);
    expect((await patch(id, { budgetAction: 'halt' })).status).toBe(400);
    // …and the rejected patches changed nothing.
    expect(store.get(id)).toMatchObject({ costBudgetUsd: 50, budgetAction: 'pause' });
  });

  it('leaves both fields untouched when the patch mentions neither', async () => {
    const id = await createRole({ costBudgetUsd: 50, budgetAction: 'pause' });
    expect((await patch(id, { label: 'RENAMED' })).status).toBe(200);
    expect(store.get(id)).toMatchObject({
      label: 'RENAMED',
      costBudgetUsd: 50,
      budgetAction: 'pause',
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip through a real SwarmDb
// ---------------------------------------------------------------------------

describe('cost budget columns — round-trip', () => {
  it('survives create, re-read, update and a SECOND update', async () => {
    const id = await createRole({ costBudgetUsd: 50, budgetAction: 'pause' });
    // Straight out of SQLite, not out of the in-memory object the route built.
    expect(store.get(id)).toMatchObject({ costBudgetUsd: 50, budgetAction: 'pause' });

    // First UPDATE — the INSERT path is behind us, this is the conflict clause.
    expect((await patch(id, { costBudgetUsd: 75 })).status).toBe(200);
    expect(store.get(id)?.costBudgetUsd).toBe(75);

    // Second UPDATE — a column missing from the SET list would freeze here.
    expect((await patch(id, { costBudgetUsd: 120, budgetAction: 'notify' })).status).toBe(200);
    expect(store.get(id)).toMatchObject({ costBudgetUsd: 120, budgetAction: 'notify' });
  });

  it('clears a budget through null, keeping the action for the NEXT one', async () => {
    const id = await createRole({ costBudgetUsd: 50, budgetAction: 'pause' });
    expect((await patch(id, { costBudgetUsd: null })).status).toBe(200);
    const cleared = store.get(id);
    expect(cleared?.costBudgetUsd).toBeNull();
    expect(cleared?.budgetAction).toBe('pause');
  });

  it('backfills a role created without any budget field', async () => {
    const id = await createRole();
    expect(store.get(id)).toMatchObject({ costBudgetUsd: null, budgetAction: 'notify' });
  });

  it('exposes both fields on every role view (GET one, GET list)', async () => {
    const id = await createRole({ costBudgetUsd: 42, budgetAction: 'pause' });
    const one = await (await fetch(`${base}/roles/${id}`)).json();
    expect(one.role).toMatchObject({ costBudgetUsd: 42, budgetAction: 'pause' });
    const list = await (await fetch(`${base}/roles`)).json();
    expect(list.roles[0]).toMatchObject({ costBudgetUsd: 42, budgetAction: 'pause' });
  });

  it('backfills a database that predates the columns, without a catch-up UPDATE', async () => {
    // An already-deployed database never sees schema.sql (`CREATE TABLE IF NOT
    // EXISTS` skips an existing table wholesale), so these columns only arrive
    // through applyMigrations. A missing ALTER means every read of an inherited
    // role explodes; a missing DEFAULT on the action means a NULL nobody
    // whitelisted.
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
      // Backfilled by the ALTER itself — no role is silently armed at $0.
      expect(legacyStore.get('role-legacy')).toMatchObject({
        costBudgetUsd: null,
        budgetAction: 'notify',
      });
      // …and the inherited row is writable, not read-only.
      legacyStore.update('role-legacy', { costBudgetUsd: 30, budgetAction: 'pause' });
      expect(legacyStore.get('role-legacy')).toMatchObject({
        costBudgetUsd: 30,
        budgetAction: 'pause',
      });
    } finally {
      legacyDb.close();
    }
  });

  it('reads a hand-corrupted row as "no budget / notify" rather than pausing on it', async () => {
    const id = await createRole({ costBudgetUsd: 50, budgetAction: 'pause' });
    // Whatever put these there (a downgrade, a manual edit), failing OPEN would
    // mean suspending a team on a bad row. Written through a second connection,
    // so the value genuinely comes back off disk.
    const raw = new Database(path.join(tmpRoot, 'data', 'swarm-os.db'));
    raw.prepare("UPDATE roles SET cost_budget_usd = -3, budget_action = 'HALT' WHERE id = ?").run(id);
    raw.close();
    expect(store.get(id)).toMatchObject({ costBudgetUsd: null, budgetAction: 'notify' });
  });
});
