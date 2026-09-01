/**
 * J2 — plugin API façades (messaging / roles / teams / schedule.cron / notify).
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

function buildApi(caps: PluginCapability[], notifier?: Notifier): {
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
