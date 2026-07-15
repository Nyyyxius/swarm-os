import { describe, it, expect, vi } from 'vitest';
import { ConnectorRegistry } from './connector-registry.js';
import type {
  ChannelConnectorProvider,
  PluginOrchSubscription,
} from './api-types.js';
import type { PluginConfigSchema } from './config-schema.js';

/**
 * Unit tests for the J4 `ConnectorRegistry`: registration inventory, retroactive
 * wiring hook, blanket unsubscribe, dispose→stopAll teardown, and the built-in
 * override guard. No Spawner / real providers — a recording fake stands in.
 */

class FakeProvider implements ChannelConnectorProvider {
  readonly subscribed: Array<{ config: Record<string, unknown>; sub: PluginOrchSubscription }> = [];
  readonly unsubscribed: string[] = [];
  stopAllCalls = 0;

  async subscribeOrch(config: Record<string, unknown>, sub: PluginOrchSubscription): Promise<void> {
    this.subscribed.push({ config, sub });
  }
  async unsubscribeOrch(orchId: string): Promise<void> {
    this.unsubscribed.push(orchId);
  }
  async stopAll(): Promise<void> {
    this.stopAllCalls += 1;
  }
}

const emptySchema: PluginConfigSchema = { type: 'object', properties: {} };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ConnectorRegistry', () => {
  it('registers a provider and exposes it in the inventory', () => {
    const reg = new ConnectorRegistry();
    const p = new FakeProvider();
    reg.register('fake', p, { label: 'Fake', schema: emptySchema });

    expect(reg.has('fake')).toBe(true);
    expect(reg.get('fake')).toBe(p);
    expect(reg.schemaFor('fake')).toBe(emptySchema);
    const types = reg.types();
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ type: 'fake', label: 'Fake', builtin: false });
  });

  it('fires the retroactive wirer when a provider registers', () => {
    const reg = new ConnectorRegistry();
    const wired: string[] = [];
    reg.setRetroactiveWirer((type) => wired.push(type));
    reg.register('fake', new FakeProvider(), { label: 'Fake', schema: null });
    expect(wired).toEqual(['fake']);
  });

  it('a throwing retroactive wirer never escapes register()', () => {
    const reg = new ConnectorRegistry();
    reg.setRetroactiveWirer(() => {
      throw new Error('boom');
    });
    // Must not throw despite the wirer blowing up.
    expect(() => reg.register('fake', new FakeProvider(), { label: 'Fake', schema: null })).not.toThrow();
    expect(reg.has('fake')).toBe(true);
  });

  it('unsubscribeAll detaches the orch from every provider', async () => {
    const reg = new ConnectorRegistry();
    const a = new FakeProvider();
    const b = new FakeProvider();
    reg.register('a', a, { label: 'A', schema: null });
    reg.register('b', b, { label: 'B', schema: null });
    await reg.unsubscribeAll('orch-1');
    expect(a.unsubscribed).toEqual(['orch-1']);
    expect(b.unsubscribed).toEqual(['orch-1']);
  });

  it('dispose removes the type and tears down its subscriptions (stopAll)', async () => {
    const reg = new ConnectorRegistry();
    const p = new FakeProvider();
    const d = reg.register('fake', p, { label: 'Fake', schema: null });
    d.dispose();
    expect(reg.has('fake')).toBe(false);
    expect(reg.get('fake')).toBeNull();
    await flush();
    expect(p.stopAllCalls).toBe(1);
  });

  it('dispose is a no-op if the type was re-registered by someone else', async () => {
    const reg = new ConnectorRegistry();
    const first = new FakeProvider();
    const second = new FakeProvider();
    const d1 = reg.register('fake', first, { label: 'F1', schema: null });
    reg.register('fake', second, { label: 'F2', schema: null });
    d1.dispose(); // stale — must NOT drop the fresh registration
    await flush();
    expect(reg.get('fake')).toBe(second);
    expect(first.stopAllCalls).toBe(0);
  });

  it('refuses to override a built-in connector type', () => {
    const reg = new ConnectorRegistry();
    reg.register('discord', new FakeProvider(), { label: 'Discord', schema: null, builtin: true });
    expect(() =>
      reg.register('discord', new FakeProvider(), { label: 'Evil', schema: null }),
    ).toThrow(/reserved/);
  });

  it('unsubscribeAll swallows a provider that rejects', async () => {
    const reg = new ConnectorRegistry();
    const good = new FakeProvider();
    const bad: ChannelConnectorProvider = {
      subscribeOrch: vi.fn(),
      unsubscribeOrch: vi.fn(async () => {
        throw new Error('detach failed');
      }),
      stopAll: vi.fn(),
    };
    reg.register('good', good, { label: 'G', schema: null });
    reg.register('bad', bad, { label: 'B', schema: null });
    await expect(reg.unsubscribeAll('o1')).resolves.toBeUndefined();
    expect(good.unsubscribed).toEqual(['o1']);
  });
});
