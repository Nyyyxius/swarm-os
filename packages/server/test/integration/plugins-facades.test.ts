/**
 * J2 — plugin API façades (messaging / roles / crons / teams / schedule.cron /
 * notify).
 *
 * Builds the real `SwarmPluginApi` via `buildPluginApi` wired to a booted stack
 * (spawner + roleStore + settings + config) and drives the façades directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { bootTestStack, type TestStack } from './helpers.js';
import { buildPluginApi, type PluginGuard } from '../../src/modules/plugins/api.js';
import {
  DisposableStore,
  type SwarmPluginApi,
  type PluginCapability,
} from '../../src/modules/plugins/api-types.js';
import { PluginStore } from '../../src/modules/plugins/store.js';
import { RoleStore } from '../../src/modules/roles/index.js';
import { DiscordWebhookNotifier, type Notifier } from '../../src/modules/notify/index.js';
import { eventBus, type SwarmEvent } from '../../src/events.js';
import { withModule } from '../../src/logger.js';

let stack: TestStack;
let roleStore: RoleStore;

const PLUGIN = 'facadep';

beforeEach(async () => {
  stack = await bootTestStack({ skipMcp: true, skipMainHttp: true });
  roleStore = new RoleStore(stack.db);
});

afterEach(async () => {
  await stack.teardown();
});

/** Identity guard — runs the fn straight through (crash isolation not under test here). */
const identityGuard: PluginGuard = <A extends unknown[]>(
  _hook: string,
  fn: (...a: A) => unknown,
) => (...a: A): unknown => fn(...a);

/**
 * Build the real façade against the booted stack.
 *
 * `opts.withoutCrons` reproduces a DEGRADED boot: the crons store failed to open
 * (`boot.cron_store_unavailable`) and `index.ts` hands the host no crons trio.
 * The façade must then refuse loudly rather than pretend to work.
 */
function buildApi(
  caps: PluginCapability[],
  notifier?: Notifier,
  opts: { withoutCrons?: boolean } = {},
): {
  api: SwarmPluginApi;
  disposables: DisposableStore;
} {
  const store = new PluginStore(stack.db);
  const disposables = new DisposableStore();
  const api = buildPluginApi(
    {
      store,
      eventBus,
      log: withModule('test.facade'),
      zod: z,
      granted: new Set(caps),
      guard: identityGuard,
      currentEpoch: () => 0,
      onConfigChange: [],
      spawner: stack.spawner,
      roleStore,
      settingsStore: stack.settingsStore,
      notifier: notifier ?? stack.spawner.notifier,
      config: stack.config,
      toolRegistry: stack.pluginToolRegistry,
      httpRegistry: stack.pluginHttpRegistry,
      scheduleTimezone: 'UTC',
      agentAssetsBasePath: null,
      ...(opts.withoutCrons
        ? {}
        : {
            crons: {
              store: stack.cronStore,
              scheduler: stack.cronScheduler,
              runner: stack.cronRunner,
            },
          }),
    },
    PLUGIN,
    disposables,
    0,
  );
  return { api, disposables };
}

function createOrch(name: string) {
  const { orchestrator, lead } = stack.spawner.create(
    {
      name,
      role: 'coordinator',
      defaultModel: stack.config.defaultModel,
      defaultEffort: stack.config.defaultEffort,
      defaultPermissionMode: stack.config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
    },
    { skipSpawn: true },
  );
  return { orchId: orchestrator.id, leadId: lead.id };
}

const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('messaging façade', () => {
  it('sendToLead pushes into the lead inbox and emits mailbox.message', () => {
    const { orchId, leadId } = createOrch('team-a');
    const { api } = buildApi(['messaging']);

    const events: SwarmEvent[] = [];
    const off = eventBus.onEvent((e) => events.push(e));
    try {
      const out = api.messaging.sendToLead(orchId, 'hi from plugin');
      expect(out.delivered).toBe(true);
      expect(out.to_session_id).toBe(leadId);

      const orch = stack.spawner.get(orchId);
      const inbox = orch?.mailbox.peek(leadId) ?? [];
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.from).toBe(`plugin:${PLUGIN}`);
      expect(inbox[0]?.content).toBe('hi from plugin');

      const mailEvt = events.find(
        (e) => e.kind === 'mailbox.message' && (e.payload as { from?: string }).from === `plugin:${PLUGIN}`,
      );
      expect(mailEvt).toBeTruthy();
    } finally {
      off();
    }
  });

  it('requires the messaging capability', () => {
    const { orchId } = createOrch('team-b');
    const { api } = buildApi([]); // no caps granted
    expect(() => api.messaging.sendToLead(orchId, 'x')).toThrow(/messaging/);
  });
});

describe('roles façade', () => {
  it('create persists the role', () => {
    const { api } = buildApi(['roles']);
    const role = api.roles.create({ label: 'from-plugin' });
    expect(role.label).toBe('from-plugin');
    expect(roleStore.get(role.id)?.label).toBe('from-plugin');
  });

  // Neutralisation (docs/crons-agents.md §2.1.1): the façade hands its RoleInit
  // straight to the store, so this is the door the 400 on the roles route does
  // NOT cover. A cadence written here must not come back — otherwise it would
  // re-feed the legacy migration at every boot.
  it('never persists a legacy cadence, whatever the plugin sends', () => {
    const { api } = buildApi(['roles']);
    const role = api.roles.create({
      label: 'cadenced-from-plugin',
      schedule: '*/5 * * * *',
      scheduleMessage: 'tick',
    });
    expect(role.schedule).toBeNull();
    expect(role.scheduleMessage).toBeNull();
    const patched = api.roles.update(role.id, { schedule: '0 * * * *', scheduleMessage: 'x' });
    expect(patched.schedule).toBeNull();
    expect(roleStore.get(role.id)?.schedule).toBeNull();
  });
});

describe('teams façade', () => {
  it('list returns a snapshot without session_secret', () => {
    const { orchId, leadId } = createOrch('team-c');
    const { api } = buildApi(['teams']);
    const teams = api.teams.list();
    const t = teams.find((x) => x.id === orchId);
    expect(t).toBeTruthy();
    expect(t?.leadSessionId).toBe(leadId);
    expect(JSON.stringify(t)).not.toContain('sessionSecret');
    expect(t?.sessions.some((s) => s.id === leadId && s.type === 'lead')).toBe(true);
  });
});

describe('schedule.cron', () => {
  it('fires while armed and stops after dispose', async () => {
    const { api } = buildApi(['schedule']);
    let ticks = 0;
    const d = api.schedule.cron('* * * * * *', () => {
      ticks += 1;
    });

    await waitFor(() => ticks >= 1, 4000);
    const atDispose = ticks;
    d.dispose();

    await new Promise((r) => setTimeout(r, 1300));
    // No more ticks after dispose (allow the in-flight second to settle).
    expect(ticks).toBeLessThanOrEqual(atDispose + 1);
    const settled = ticks;
    await new Promise((r) => setTimeout(r, 1300));
    expect(ticks).toBe(settled);
  });

  it('rejects an invalid cron expression', () => {
    const { api } = buildApi(['schedule']);
    expect(() => api.schedule.cron('not a cron', () => undefined)).toThrow();
  });
});

describe('notify façade — custom', () => {
  /** Real Discord notifier with a mocked fetch — captures the outgoing webhook payload. */
  function webhookCapture(): { notifier: Notifier; seen: { url: string; body: string }[] } {
    const seen: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body) });
      return new Response('{}', { status: 200 });
    });
    const notifier = new DiscordWebhookNotifier({
      webhookUrl: 'https://discord.example/webhooks/x/y',
      projectName: 'fyrel',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { notifier, seen };
  }

  it('sends a [plugin:<name>]-prefixed embed with the level colour', async () => {
    const { notifier, seen } = webhookCapture();
    const { api } = buildApi(['notify'], notifier);

    await api.notify.custom({
      title: 'breaker tripped',
      message: 'daily loss limit reached',
      level: 'critical',
    });

    expect(seen).toHaveLength(1);
    const payload = JSON.parse(seen[0]!.body) as {
      embeds: Array<{ title: string; description: string; color: number }>;
    };
    expect(payload.embeds[0]?.title).toBe(`[plugin:${PLUGIN}] breaker tripped`);
    expect(payload.embeds[0]?.description).toBe('daily loss limit reached');
    expect(payload.embeds[0]?.color).toBe(0xff0000);
  });

  it('defaults the level to info (green)', async () => {
    const { notifier, seen } = webhookCapture();
    const { api } = buildApi(['notify'], notifier);

    await api.notify.custom({ title: 'hello', message: 'world' });

    const payload = JSON.parse(seen[0]!.body) as { embeds: Array<{ color: number }> };
    expect(payload.embeds[0]?.color).toBe(0x00cc66);
  });

  it('requires the notify capability', async () => {
    const { notifier, seen } = webhookCapture();
    const { api } = buildApi([], notifier); // no caps granted
    await expect(
      api.notify.custom({ title: 't', message: 'm' }),
    ).rejects.toThrow(/notify/);
    expect(seen).toHaveLength(0);
  });

  it('rejects an invalid input (empty title, bad level) without sending', async () => {
    const { notifier, seen } = webhookCapture();
    const { api } = buildApi(['notify'], notifier);
    await expect(api.notify.custom({ title: '', message: 'm' })).rejects.toThrow();
    await expect(api.notify.custom({ title: 't', message: '   ' })).rejects.toThrow();
    await expect(
      api.notify.custom({
        title: 't',
        message: 'm',
        level: 'debug' as unknown as 'info',
      }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('host façade — exec', () => {
  // The test stack boots with the default `local` agent transport, so exec is
  // never able to reach a real host — every case below rejects before spawn.
  it('requires the host-exec capability', async () => {
    const { api } = buildApi([]); // no caps granted
    await expect(api.host.exec({ argv: ['echo', 'hi'] })).rejects.toThrow(/host-exec/);
  });

  it('rejects under the local agent transport with a clear message', async () => {
    const { api } = buildApi(['host-exec']);
    await expect(api.host.exec({ argv: ['echo', 'hi'] })).rejects.toThrow(
      /ssh agent transport/,
    );
  });

  it('rejects an empty argv (zod) before touching the transport', async () => {
    const { api } = buildApi(['host-exec']);
    await expect(api.host.exec({ argv: [] })).rejects.toThrow();
  });

  it('rejects an out-of-bounds timeout / output cap (zod)', async () => {
    const { api } = buildApi(['host-exec']);
    await expect(api.host.exec({ argv: ['echo'], timeoutMs: 999_999 })).rejects.toThrow();
    await expect(
      api.host.exec({ argv: ['echo'], maxOutputBytes: 999_999_999 }),
    ).rejects.toThrow();
  });
});

describe('crons façade', () => {
  /**
   * A cadence that cannot fire during the test run (1 January, 03:00) — same
   * trick as crons.test.ts, so a real tick can never slip a run row (or a
   * message into a lead's inbox) under an assertion.
   */
  const NEVER = '0 3 1 1 *';

  function targetRole(label = 'cron-target'): string {
    return roleStore.create({ label }).id;
  }

  it('create validates, persists and re-arms the scheduler', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);
    const reload = vi.spyOn(stack.cronScheduler, 'reload');

    const cron = await api.crons.create({
      name: 'facade-daily',
      roleId,
      schedule: NEVER,
      action: 'message',
      message: 'wake up: {{now}}',
    });

    expect(cron.id).toMatch(/^cron_/);
    expect(cron.name).toBe('facade-daily');
    expect(cron.paused).toBe(false);
    // Read off the ARMED job: a created, non-paused cron knows its next fire.
    expect(cron.nextRun).not.toBeNull();
    expect(reload).toHaveBeenCalled();
    // Persisted where the REST surface and the UI read it, not in a plugin table.
    expect(stack.cronStore.getByName('facade-daily')?.roleId).toBe(roleId);
  });

  it('supports the documented upsert-by-name (getByName → create/update)', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);

    expect(api.crons.getByName('facade-upsert')).toBeNull();
    const created = await api.crons.create({
      name: 'facade-upsert',
      roleId,
      schedule: NEVER,
      action: 'message',
      message: 'v1',
    });

    // Second activation: the name is found, so the plugin patches instead of
    // creating a duplicate.
    const found = api.crons.getByName('facade-upsert');
    expect(found?.id).toBe(created.id);
    const updated = await api.crons.update(found!.id, { message: 'v2', paused: true });
    expect(updated.message).toBe('v2');
    expect(updated.paused).toBe(true);
    // Paused ⇒ nothing is armed, so there is no next fire to advertise.
    expect(updated.nextRun).toBeNull();
    expect(stack.cronStore.list().filter((c) => c.name === 'facade-upsert')).toHaveLength(1);
  });

  it('refuses a duplicate name rather than adopting the existing cron', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);
    const init = {
      name: 'facade-dup',
      roleId,
      schedule: NEVER,
      action: 'message' as const,
      message: 'x',
    };
    await api.crons.create(init);
    await expect(api.crons.create(init)).rejects.toThrow(/already exists/);
  });

  it('list/get expose the same crons the REST surface serves', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);
    const cron = await api.crons.create({
      name: 'facade-list',
      roleId,
      schedule: NEVER,
      action: 'message',
      message: 'x',
    });

    expect(api.crons.list().map((c) => c.name)).toContain('facade-list');
    expect(api.crons.get(cron.id)?.id).toBe(cron.id);
    expect(api.crons.get('cron_missing')).toBeNull();
    expect(api.crons.getByName('nope')).toBeNull();
  });

  it('delete removes the cron and re-arms', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);
    const cron = await api.crons.create({
      name: 'facade-gone',
      roleId,
      schedule: NEVER,
      action: 'message',
      message: 'x',
    });
    const reload = vi.spyOn(stack.cronScheduler, 'reload');

    api.crons.delete(cron.id);

    expect(stack.cronStore.get(cron.id)).toBeNull();
    expect(reload).toHaveBeenCalled();
    // Idempotent: deleting an unknown id is a no-op, not a throw.
    expect(() => api.crons.delete(cron.id)).not.toThrow();
  });

  it('update throws on an unknown id', async () => {
    const { api } = buildApi(['crons']);
    await expect(api.crons.update('cron_missing', { paused: true })).rejects.toThrow(
      /cron cron_missing not found/,
    );
  });

  // The whole point of sharing `modules/crons/validate.ts` with the route: a
  // plugin must not be able to store a cron the operator's own form refuses.
  it('applies the same validation rules as the REST route', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);
    const base = { roleId, schedule: NEVER, action: 'message' as const, message: 'x' };

    await expect(api.crons.create({ ...base, name: 'bad name' })).rejects.toThrow(/name must be/);
    await expect(
      api.crons.create({ ...base, name: 'facade-persec', schedule: '* * * * * *' }),
    ).rejects.toThrow(/exactly 5 fields/);
    await expect(
      // 5 fields, but croner cannot parse it — the second half of the check.
      api.crons.create({ ...base, name: 'facade-badcron', schedule: '99 * * * *' }),
    ).rejects.toThrow(/valid cron expression/);
    await expect(
      api.crons.create({ ...base, name: 'facade-norole', roleId: 'role_missing' }),
    ).rejects.toThrow(/unknown role/);
    await expect(
      api.crons.create({ name: 'facade-nomsg', roleId, schedule: NEVER, action: 'message' }),
    ).rejects.toThrow(/message is required/);
    await expect(
      api.crons.create({ name: 'facade-noscript', roleId, schedule: NEVER, action: 'script' }),
    ).rejects.toThrow(/scriptPath is required/);
    await expect(
      api.crons.create({
        name: 'facade-nointerp',
        roleId,
        schedule: NEVER,
        action: 'script',
        scriptPath: `${stack.workspaceRoot}/tick.py`,
      }),
    ).rejects.toThrow(/interpreter is required/);
    // Containment: a path outside the workspace / data roots is refused here,
    // exactly as the form refuses it.
    await expect(
      api.crons.create({
        name: 'facade-escape',
        roleId,
        schedule: NEVER,
        action: 'script',
        scriptPath: '/etc/passwd',
        interpreter: 'bash',
      }),
    ).rejects.toThrow();
    expect(stack.cronStore.list().filter((c) => c.name.startsWith('facade-'))).toHaveLength(0);
  });

  it('enforces the merged invariants on a patch', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons']);
    const cron = await api.crons.create({
      name: 'facade-patch',
      roleId,
      schedule: NEVER,
      action: 'message',
      message: 'x',
    });
    // Clearing the template of a `message` cron would leave a cadence with
    // nothing to deliver.
    await expect(api.crons.update(cron.id, { message: null })).rejects.toThrow(
      /message is required/,
    );
    expect(stack.cronStore.get(cron.id)?.message).toBe('x');
  });

  it('requires the crons capability on every method', async () => {
    const { api } = buildApi([]); // no caps granted
    expect(() => api.crons.list()).toThrow(/'crons' capability/);
    expect(() => api.crons.get('x')).toThrow(/'crons' capability/);
    expect(() => api.crons.getByName('x')).toThrow(/'crons' capability/);
    expect(() => api.crons.delete('x')).toThrow(/'crons' capability/);
    await expect(
      api.crons.create({ name: 'nope', roleId: 'r', schedule: NEVER, action: 'message' }),
    ).rejects.toThrow(/'crons' capability/);
    await expect(api.crons.update('x', {})).rejects.toThrow(/'crons' capability/);
  });

  it('fails loudly when the crons subsystem did not start (degraded boot)', async () => {
    const roleId = targetRole();
    const { api } = buildApi(['crons'], undefined, { withoutCrons: true });
    const boom = /crons subsystem did not start/;
    expect(() => api.crons.list()).toThrow(boom);
    expect(() => api.crons.get('x')).toThrow(boom);
    expect(() => api.crons.getByName('x')).toThrow(boom);
    expect(() => api.crons.delete('x')).toThrow(boom);
    await expect(
      api.crons.create({ name: 'facade-degraded', roleId, schedule: NEVER, action: 'message', message: 'x' }),
    ).rejects.toThrow(boom);
    await expect(api.crons.update('x', {})).rejects.toThrow(boom);
  });
});
