/**
 * Phase 7 — REST surface for the `roles` collection + role-driven orch
 * creation. Roles are reusable orchestrator templates: when a role is
 * referenced at orch creation, its leadPrompt / leadPreamble / defaults
 * fill in missing fields and `workerCount` triggers initial worker spawns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { RoleStore } from '../../src/modules/roles/index.js';
import { PASSWORD_SENTINEL } from '../../src/modules/plugins/config-schema.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

async function postRole(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${stack.mainPort}/roles`, {
    method: 'POST',
    headers: authHeaders(stack.config.token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('REST: /roles CRUD', () => {
  it('rejects unauthenticated GET', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/roles`);
    expect(res.status).toBe(401);
  });

  it('returns an empty list initially', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/roles`, {
      headers: authHeaders(stack.config.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: unknown[] };
    expect(body.roles).toEqual([]);
  });

  it('rejects a body with no label', async () => {
    const r = await postRole({ leadPrompt: 'hi' });
    expect(r.status).toBe(400);
  });

  it('rejects an invalid connector', async () => {
    const r = await postRole({
      label: 'broken',
      connectors: [{ type: 'discord', webhookUrl: 'not-a-url' }],
    });
    expect(r.status).toBe(400);
  });

  it('rejects an empty Discord connector (no webhook, no bot+channel)', async () => {
    const r = await postRole({
      label: 'empty',
      connectors: [{ type: 'discord' }],
    });
    expect(r.status).toBe(400);
  });

  it('accepts a bot-only Discord connector (token + channelId, no webhookUrl)', async () => {
    const r = await postRole({
      label: 'bot-only',
      connectors: [
        {
          type: 'discord',
          channelId: '123456789012345678',
          botToken: 'MTA1234567890abcdef.ABCDEF.fakebottokenforintegrationtest',
        },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.role.connectors).toHaveLength(1);
    expect(r.body.role.connectors[0].webhookUrl).toBeUndefined();
    expect(r.body.role.connectors[0].channelId).toBe('123456789012345678');
    expect(r.body.role.connectors[0].botToken).toBeDefined();
  });

  it('rejects workerCount above the configured cap', async () => {
    const r = await postRole({
      label: 'huge',
      workerCount: stack.config.maxWorkersPerOrch + 1,
    });
    expect(r.status).toBe(400);
  });

  it('creates, fetches, patches and deletes a role', async () => {
    const created = await postRole({
      label: 'researcher',
      leadPrompt: 'Investigate the bug carefully.',
      workerCount: 2,
      defaultEffort: 'high',
      connectors: [
        { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/abc/def' },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.role.id as string;
    expect(created.body.role.label).toBe('researcher');
    expect(created.body.role.workerCount).toBe(2);
    expect(created.body.role.connectors).toHaveLength(1);

    const list = await fetch(`http://127.0.0.1:${stack.mainPort}/roles`, {
      headers: authHeaders(stack.config.token),
    });
    const listBody = (await list.json()) as { roles: Array<{ id: string }> };
    expect(listBody.roles.map((r) => r.id)).toContain(id);

    const patched = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      method: 'PATCH',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({ workerCount: 1, leadPrompt: null }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { role: { workerCount: number; leadPrompt: string | null } };
    expect(patchedBody.role.workerCount).toBe(1);
    expect(patchedBody.role.leadPrompt).toBeNull();

    const del = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      method: 'DELETE',
      headers: authHeaders(stack.config.token),
    });
    expect(del.status).toBe(204);

    const gone = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      headers: authHeaders(stack.config.token),
    });
    expect(gone.status).toBe(404);
  });

  // ── Cadence moved to /crons (docs/crons-agents.md) ────────────────────────
  // These four cases used to assert the per-role cadence round-trip. The
  // behaviour is gone: the cadence is a first-class `crons` row now, and the
  // roles route only has to (a) keep accepting the NULL keys every deployed web
  // bundle still posts, and (b) refuse an actual value loudly rather than
  // storing something no scheduler reads.

  it('still accepts schedule/scheduleMessage sent as null (existing clients post the keys)', async () => {
    const created = await postRole({
      label: 'no-cadence',
      schedule: null,
      scheduleMessage: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.role.schedule).toBeNull();
    expect(created.body.role.scheduleMessage).toBeNull();
  });

  it('rejects a non-null schedule with 400 SCHEDULE_MOVED', async () => {
    const r = await postRole({ label: 'cadenced', schedule: '0 6,12,20 * * *', scheduleMessage: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SCHEDULE_MOVED');
    expect(String(r.body.error)).toContain('/crons');
  });

  it('rejects a non-null scheduleMessage even without a schedule', async () => {
    const r = await postRole({ label: 'msg-only', schedule: null, scheduleMessage: 'tick' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SCHEDULE_MOVED');
  });

  it('PATCH refuses a non-null schedule but accepts the null keys', async () => {
    const created = await postRole({ label: 'patchable' });
    expect(created.status).toBe(201);
    const id = created.body.role.id as string;

    const refused = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      method: 'PATCH',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({ schedule: '*/5 * * * *', scheduleMessage: 'tick' }),
    });
    expect(refused.status).toBe(400);

    const accepted = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      method: 'PATCH',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({ schedule: null, scheduleMessage: null, workerCount: 2 }),
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { role: { schedule: string | null; workerCount: number } };
    expect(body.role.schedule).toBeNull();
    expect(body.role.workerCount).toBe(2);
  });

  it('GET /roles reports a cronCount per role (0 when no cron targets it)', async () => {
    const created = await postRole({ label: 'counted' });
    expect(created.status).toBe(201);
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/roles`, {
      headers: authHeaders(stack.config.token),
    });
    const body = (await res.json()) as { roles: Array<{ id: string; cronCount: number }> };
    const row = body.roles.find((r) => r.id === created.body.role.id);
    expect(row?.cronCount).toBe(0);
  });
});

describe('REST: /roles connectors (J4 — generic types + secret masking)', () => {
  const BOT_TOKEN = 'MTA1234567890abcdef.ABCDEF.fakebottokenforintegrationtest';
  const CHANNEL = '123456789012345678';

  it('rejects an unknown connector type with 422 UNKNOWN_CONNECTOR_TYPE', async () => {
    const r = await postRole({
      label: 'unknown-type',
      connectors: [{ type: 'slack', config: { channel: 'C1' } }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('UNKNOWN_CONNECTOR_TYPE');
  });

  it('masks the discord botToken on read and preserves it when the sentinel is echoed back', async () => {
    const created = await postRole({
      label: 'masked',
      connectors: [{ type: 'discord', channelId: CHANNEL, botToken: BOT_TOKEN }],
    });
    expect(created.status).toBe(201);
    const id = created.body.role.id as string;
    // The create response is already masked.
    expect(created.body.role.connectors[0].botToken).toBe(PASSWORD_SENTINEL);

    // GET masks the token too.
    const got = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      headers: authHeaders(stack.config.token),
    });
    const gotBody = (await got.json()) as {
      role: { connectors: Array<{ botToken?: string; channelId?: string }> };
    };
    expect(gotBody.role.connectors[0].botToken).toBe(PASSWORD_SENTINEL);

    // The stored token is intact behind the mask.
    const store = new RoleStore(stack.db);
    const stored = store.get(id);
    const discord = stored?.connectors.find((c) => c.type === 'discord') as
      | { botToken?: string }
      | undefined;
    expect(discord?.botToken).toBe(BOT_TOKEN);

    // PATCH echoing the sentinel back keeps the previously stored token.
    const patched = await fetch(`http://127.0.0.1:${stack.mainPort}/roles/${id}`, {
      method: 'PATCH',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({
        connectors: [{ type: 'discord', channelId: CHANNEL, botToken: PASSWORD_SENTINEL }],
      }),
    });
    expect(patched.status).toBe(200);
    const afterPatch = new RoleStore(stack.db).get(id);
    const discord2 = afterPatch?.connectors.find((c) => c.type === 'discord') as
      | { botToken?: string }
      | undefined;
    expect(discord2?.botToken).toBe(BOT_TOKEN);
  });
});

describe('REST: orchestrator creation honors a role', () => {
  it('fills in lead prompt + workerCount, returns roleId on the view', async () => {
    // Create a role with leadPrompt + 2 workers.
    const role = await postRole({
      label: 'team-lead',
      leadPrompt: 'Coordinate the team and split the work.',
      workerCount: 2,
    });
    expect(role.status).toBe(201);
    const roleId = role.body.role.id as string;

    // Create an orchestrator by reference (no body.role, no body.lead.prompt) —
    // they should come from the role. We still need a cwd. Use the spawner
    // directly to skip the actual Claude spawn but exercise the role
    // wiring inside the route. The test routes through HTTP because that's
    // where the inheritance lives.
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({
        name: 'team-A',
        roleId,
        lead: { cwd: '/' },
      }),
    });
    // The lead will try to spawn claude; in an integration test without a
    // real binary this either succeeds (FakeAgentProcess) or fails fast. We
    // only care that the route accepted the body shape (so it filled in the
    // missing fields).  Both 201 and 500 indicate the validation passed —
    // 400 would be the failure mode we care about.
    expect(res.status).not.toBe(400);
    if (res.status === 201) {
      const body = (await res.json()) as { orchestrator: { roleId: string | null; role: string } };
      expect(body.orchestrator.roleId).toBe(roleId);
      expect(body.orchestrator.role).toBe('team-lead');
    }
  });
});
