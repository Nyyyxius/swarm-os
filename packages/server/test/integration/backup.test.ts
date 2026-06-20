/**
 * Operator backup REST surface — `POST /backup` (force a snapshot now) and
 * `GET /backups` (list snapshots). Both gate on X-Auth-Token like the rest.
 *
 * The stack wires a real (un-started) BackupScheduler over the test DB, so a
 * forced backup writes a real `swarm-os-*.db` into the temp data dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

const base = () => `http://127.0.0.1:${stack.mainPort}`;

describe('REST: /backup', () => {
  it('rejects unauthenticated calls', async () => {
    expect((await fetch(`${base()}/backups`)).status).toBe(401);
    expect((await fetch(`${base()}/backup`, { method: 'POST' })).status).toBe(401);
  });

  it('lists no snapshots initially', async () => {
    const res = await fetch(`${base()}/backups`, { headers: authHeaders(stack.config.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backups: unknown[] };
    expect(body.backups).toEqual([]);
  });

  it('POST /backup writes a snapshot, then GET /backups returns it', async () => {
    const post = await fetch(`${base()}/backup`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    expect(post.status).toBe(200);
    const r = (await post.json()) as { ok: boolean; file: string | null; pruned: number };
    expect(r.ok).toBe(true);
    expect(r.file).toMatch(/^swarm-os-.*\.db$/);

    const list = await fetch(`${base()}/backups`, { headers: authHeaders(stack.config.token) });
    const body = (await list.json()) as {
      backups: Array<{ name: string; sizeBytes: number; mtimeMs: number }>;
    };
    expect(body.backups).toHaveLength(1);
    expect(body.backups[0].name).toBe(r.file);
    expect(body.backups[0].sizeBytes).toBeGreaterThan(0);
  });
});
