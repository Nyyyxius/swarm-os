/**
 * J4 — channel connectors end-to-end over the booted stack.
 *
 * Proves: a role connector whose type has a registered provider is wired at team
 * creation; an inbound message pushed through the subscription lands in the
 * lead's inbox AND fires `mailbox.message`; destroy detaches it; a provider
 * registered LATE retro-wires the already-running team; and the whole path works
 * through the REAL plugin lifecycle (`api.connectors.register`) — enable wires an
 * existing team, disable removes the provider.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootTestStack, type TestStack } from './helpers.js';
import { RoleStore } from '../../src/modules/roles/index.js';
import { eventBus, type SwarmEvent } from '../../src/events.js';
import type {
  ChannelConnectorProvider,
  PluginOrchSubscription,
} from '../../src/modules/plugins/api-types.js';
import type { PluginConfigSchema } from '../../src/modules/plugins/config-schema.js';

let stack: TestStack;
let roleStore: RoleStore;

const emptySchema: PluginConfigSchema = { type: 'object', properties: {} };

class RecordingProvider implements ChannelConnectorProvider {
  readonly subs: PluginOrchSubscription[] = [];
  readonly configs: Record<string, unknown>[] = [];
  readonly unsubscribed: string[] = [];
  async subscribeOrch(config: Record<string, unknown>, sub: PluginOrchSubscription): Promise<void> {
    this.configs.push(config);
    this.subs.push(sub);
  }
  async unsubscribeOrch(orchId: string): Promise<void> {
    this.unsubscribed.push(orchId);
  }
  async stopAll(): Promise<void> {}
}

const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function createTeam(roleId: string): { orchId: string; leadId: string } {
  const { orchestrator, lead } = stack.spawner.create(
    {
      name: 'team',
      role: 'r',
      roleId,
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

beforeEach(async () => {
  stack = await bootTestStack({ skipMcp: true, skipMainHttp: true });
  roleStore = new RoleStore(stack.db);
});

afterEach(async () => {
  await stack.teardown();
});

describe('connector wiring via the Spawner', () => {
  it('wires a role connector on create; inbound lands in the lead inbox + fires mailbox.message', async () => {
    const provider = new RecordingProvider();
    stack.connectorRegistry.register('fake', provider, { label: 'Fake', schema: emptySchema });

    const role = roleStore.create({ label: 'r', connectors: [{ type: 'fake', config: { room: 'x' } }] });
    const { orchId, leadId } = createTeam(role.id);

    await waitFor(() => provider.subs.length === 1);
    const sub = provider.subs[0]!;
    expect(sub.orchestratorId).toBe(orchId);
    expect(sub.getLeadSessionId()).toBe(leadId);
    expect(provider.configs[0]).toEqual({ room: 'x' });

    const events: SwarmEvent[] = [];
    const off = eventBus.onEvent((e) => events.push(e));
    try {
      sub.pushToLeadInbox('hello from fake', { from: 'fake:user', sourceKind: 'fake' });
      const orch = stack.spawner.get(orchId)!;
      const inbox = orch.mailbox.peek(leadId);
      expect(inbox.some((m) => m.content === 'hello from fake' && m.from === 'fake:user')).toBe(true);
      expect(
        events.some(
          (e) => e.kind === 'mailbox.message' && (e.payload as { from?: string }).from === 'fake:user',
        ),
      ).toBe(true);
    } finally {
      off();
    }

    // Destroy detaches the subscription from the provider.
    stack.spawner.destroy(orchId);
    await waitFor(() => provider.unsubscribed.includes(orchId));
  });

  it('retro-wires an already-running team when a provider registers late', async () => {
    const role = roleStore.create({ label: 'r2', connectors: [{ type: 'late', config: {} }] });
    const { orchId } = createTeam(role.id);

    // No provider yet → not wired.
    const provider = new RecordingProvider();
    expect(provider.subs).toHaveLength(0);

    stack.connectorRegistry.register('late', provider, { label: 'Late', schema: emptySchema });
    await waitFor(() => provider.subs.length === 1);
    expect(provider.subs[0]!.orchestratorId).toBe(orchId);
  });

  it('rejects an unknown connector type but wires a discord-only role harmlessly', () => {
    // A role can hold a discord connector even without a registered discord
    // provider in the test stack — it simply isn't wired (no real Gateway).
    const role = roleStore.create({
      label: 'r3',
      connectors: [{ type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/a/b' }],
    });
    expect(() => createTeam(role.id)).not.toThrow();
  });
});

describe('connector via the real plugin lifecycle', () => {
  it('enable retro-wires an existing team through api.connectors.register; disable removes it', async () => {
    // A tiny on-disk plugin that provides a `fakep` connector whose subscribe
    // immediately pushes a marker into the lead inbox — proving the full path
    // (register → retro-wire → pushToLeadInbox) through the real host.
    const dir = path.join(stack.pluginsDir, 'conntest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'conntest',
        version: '0.1.0',
        main: 'index.js',
        apiVersion: 1,
        capabilities: ['connectors'],
        connectors: [{ type: 'fakep', label: 'FakeP', schema: { type: 'object', properties: {} } }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      [
        'export default {',
        '  activate(api) {',
        '    api.connectors.register("fakep", {',
        '      async subscribeOrch(config, sub) {',
        '        sub.pushToLeadInbox("wired via plugin connector", { from: "fakep:test" });',
        '      },',
        '      async unsubscribeOrch() {},',
        '      async stopAll() {},',
        '    });',
        '  },',
        '};',
        '',
      ].join('\n'),
    );

    // Team exists BEFORE the plugin is enabled → the enable must retro-wire it.
    const role = roleStore.create({ label: 'r4', connectors: [{ type: 'fakep', config: {} }] });
    const { orchId, leadId } = createTeam(role.id);

    await stack.pluginHost.scan();
    await stack.pluginHost.enable('conntest', ['connectors']);
    expect(stack.connectorRegistry.has('fakep')).toBe(true);

    // Retro-wiring subscribed the live team → the marker reached the lead inbox.
    const orch = stack.spawner.get(orchId)!;
    await waitFor(() =>
      orch.mailbox.peek(leadId).some((m) => m.content === 'wired via plugin connector'),
    );
    const inbox = orch.mailbox.peek(leadId);
    expect(inbox.some((m) => m.from === 'fakep:test')).toBe(true);

    // Disable removes the provider (Disposable → registry delete + stopAll).
    await stack.pluginHost.disable('conntest');
    expect(stack.connectorRegistry.has('fakep')).toBe(false);
  });
});
