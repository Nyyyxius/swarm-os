/**
 * `RoleStore.clearApprovalSettings()` (docs/builtin-features.md D7) — the
 * approvals feature purge clears every role's approval override
 * (`roles.approval_json = NULL`) without touching any other role config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { RoleStore } from './index.js';

let dir: string;
let db: SwarmDb;
let roles: RoleStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-clear-approval-'));
  db = new SwarmDb(dir);
  roles = new RoleStore(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('clearApprovalSettings', () => {
  it('nulls approval_json on every role and leaves other config intact', () => {
    const withApproval = roles.create({
      label: 'guarded',
      approval: { enabled: true, armingModes: ['default'], discordNotify: false },
      costBudgetUsd: 12.5,
      budgetAction: 'pause',
    });
    const plain = roles.create({ label: 'plain' });

    // Sanity: the override round-trips before the purge.
    expect(roles.get(withApproval.id)!.approval).toEqual({
      enabled: true,
      armingModes: ['default'],
      discordNotify: false,
    });

    const touched = roles.clearApprovalSettings();
    // Both rows are UPDATE-touched (SQLite counts a NULL→NULL write too).
    expect(touched).toBe(2);

    // The override is gone on both roles...
    expect(roles.get(withApproval.id)!.approval).toBeNull();
    expect(roles.get(plain.id)!.approval).toBeNull();
    // ...but the budget config (out of scope, D7) survives untouched.
    const after = roles.get(withApproval.id)!;
    expect(after.costBudgetUsd).toBe(12.5);
    expect(after.budgetAction).toBe('pause');
    expect(after.label).toBe('guarded');
  });

  it('is a no-op that returns 0 when there are no roles', () => {
    expect(roles.clearApprovalSettings()).toBe(0);
  });
});
