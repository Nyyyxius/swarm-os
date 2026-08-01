/**
 * api.connectors.register — the guarded provider must FORWARD the optional P5
 * `sendToOrchChannel` seam.
 *
 * The host reconstructs a fresh `guarded` provider object around the plugin's
 * provider (crash isolation). That reconstruction historically listed only the
 * 3 mandatory methods, so any new method would be SILENTLY dropped — it would
 * compile and run, but the call would never reach the plugin. These tests pin
 * the forward: the seam reaches the underlying provider (through the guard) when
 * present, and stays `undefined` when the plugin doesn't implement it.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { buildPluginApi, type PluginGuard } from './api.js';
import { ConnectorRegistry } from './connector-registry.js';
import {
  DisposableStore,
  type ChannelConnectorProvider,
  type PluginCapability,
} from './api-types.js';
import type { PluginStore } from './store.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';

/** Guard that records each hook label so we can prove the wrap happened. */
function recordingGuard(seen: string[]): PluginGuard {
  return <A extends unknown[]>(hook: string, fn: (...a: A) => unknown) =>
    (...a: A): unknown => {
      seen.push(hook);
      return fn(...a);
    };
}

function buildApi(caps: PluginCapability[], guard: PluginGuard, registry: ConnectorRegistry) {
  return buildPluginApi(
    {
      store: {} as unknown as PluginStore,
      eventBus,
      log: withModule('test.connectors'),
      zod: z,
      granted: new Set(caps),
      guard,
      currentEpoch: () => 0,
      onConfigChange: [],
      connectorRegistry: registry,
      connectorDecls: [{ type: 'discord-agent', label: 'Discord Agent' }],
    },
    'discord-agent',
    new DisposableStore(),
    0,
  );
}

describe('connectors.register — sendToOrchChannel forward', () => {
  it('forwards sendToOrchChannel to the plugin through the guard', async () => {
    const seen: string[] = [];
    const registry = new ConnectorRegistry();
    const api = buildApi(['connectors'], recordingGuard(seen), registry);

    const impl = vi.fn(async (orchId: string, _text: string) =>
      orchId === 'o1' ? { messageId: 'm-99' } : null,
    );
    const provider: ChannelConnectorProvider = {
      subscribeOrch: vi.fn(),
      unsubscribeOrch: vi.fn(),
      stopAll: vi.fn(),
      sendToOrchChannel: impl,
    };
    api.connectors.register('discord-agent', provider);

    const guarded = registry.get('discord-agent');
    expect(guarded).not.toBeNull();
    expect(typeof guarded?.sendToOrchChannel).toBe('function');

    const res = await guarded!.sendToOrchChannel!('o1', 'coucou');
    expect(res).toEqual({ messageId: 'm-99' });
    expect(impl).toHaveBeenCalledWith('o1', 'coucou');
    // Proof the call went through the crash-isolating guard.
    expect(seen).toContain('connector.sendToOrchChannel');
  });

  it('leaves sendToOrchChannel undefined when the plugin omits it', () => {
    const registry = new ConnectorRegistry();
    const api = buildApi(['connectors'], recordingGuard([]), registry);

    const provider: ChannelConnectorProvider = {
      subscribeOrch: vi.fn(),
      unsubscribeOrch: vi.fn(),
      stopAll: vi.fn(),
    };
    api.connectors.register('discord-agent', provider);

    const guarded = registry.get('discord-agent');
    expect(guarded).not.toBeNull();
    expect(guarded?.sendToOrchChannel).toBeUndefined();
  });
});
