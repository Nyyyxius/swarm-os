/**
 * discord-notify — route selection for the "approval requested" post (P5).
 *
 * Covers the plugin-connector seam added for deployments that serve Discord via
 * a plugin (`discord-agent`) instead of the integrated bot: the approval hook
 * must post THROUGH the plugin's `sendToOrchChannel`, capture the returned id,
 * and NOT double-post via the bot/webhook. Absence/failure of the seam must fall
 * back silently to the existing bot → webhook path, and must never throw.
 *
 * All collaborators are duck-typed fakes — no real Spawner/DB/discord.js.
 */

import { describe, it, expect, vi } from 'vitest';
import { notifyApprovalRequested } from './discord-notify.js';
import { ConnectorRegistry } from '../plugins/connector-registry.js';
import type { ChannelConnectorProvider } from '../plugins/api-types.js';
import type { Spawner } from '../spawner/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Session } from '../orchestrator/session.js';
import type { ApprovalRequest, ApprovalStore } from './store.js';
import type { Role } from '../roles/index.js';

const ORCH_ID = 'orch-1';
const ROLE_ID = 'role-1';

function fakeOrch(notify: ReturnType<typeof vi.fn>): Orchestrator {
  return {
    id: ORCH_ID,
    name: 'Equipe',
    role: 'lead',
    roleId: ROLE_ID,
    status: 'running',
    notifier: { notify },
  } as unknown as Orchestrator;
}

const fakeSession = {
  id: 'sess-1',
  name: 'worker',
  role: 'worker',
  type: 'worker',
  status: 'waiting',
  exitCode: null,
  stopReason: null,
} as unknown as Session;

const fakeApproval = {
  id: 'appr-1',
  requestedSummary: 'peut-on lancer le deploy ?',
  category: 'shell',
} as unknown as ApprovalRequest;

/** Minimal store recording setDiscordMessageId calls. */
function fakeStore(): { store: ApprovalStore; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const store = {
    setDiscordMessageId: (id: string, messageId: string) => {
      calls.push([id, messageId]);
      return true;
    },
  } as unknown as ApprovalStore;
  return { store, calls };
}

/** roleStore.get → a role carrying the given connectors. */
function fakeRoleStore(connectors: Role['connectors']) {
  return { get: (id: string) => (id === ROLE_ID ? ({ id, connectors } as Role) : null) };
}

function fakeSpawner(args: {
  roleStore?: unknown;
  connectorRegistry?: ConnectorRegistry | null;
  discordBotPool?: unknown;
}): Spawner {
  return {
    roleStore: args.roleStore ?? null,
    connectorRegistry: args.connectorRegistry ?? null,
    discordBotPool: args.discordBotPool ?? null,
  } as unknown as Spawner;
}

describe('notifyApprovalRequested — plugin connector seam (P5)', () => {
  it('posts through the plugin connector and captures the message id', async () => {
    const sendToOrchChannel = vi.fn(async () => ({ messageId: 'discord-msg-42' }));
    const provider: ChannelConnectorProvider = {
      subscribeOrch: vi.fn(),
      unsubscribeOrch: vi.fn(),
      stopAll: vi.fn(),
      sendToOrchChannel,
    };
    const registry = new ConnectorRegistry();
    registry.register('discord-agent', provider, { label: 'DA', schema: null });

    const notify = vi.fn(async () => {});
    const { store, calls } = fakeStore();

    await notifyApprovalRequested({
      spawner: fakeSpawner({
        roleStore: fakeRoleStore([{ type: 'discord-agent', config: {} }]),
        connectorRegistry: registry,
      }),
      orch: fakeOrch(notify),
      session: fakeSession,
      approval: fakeApproval,
      store,
    });

    expect(sendToOrchChannel).toHaveBeenCalledTimes(1);
    expect(sendToOrchChannel.mock.calls[0][0]).toBe(ORCH_ID);
    // The captured id is persisted for reply correlation…
    expect(calls).toEqual([['appr-1', 'discord-msg-42']]);
    // …and the webhook fallback is NOT taken (single successful path).
    expect(notify).not.toHaveBeenCalled();
  });

  it('falls back to the webhook when the plugin returns null (no id)', async () => {
    const provider: ChannelConnectorProvider = {
      subscribeOrch: vi.fn(),
      unsubscribeOrch: vi.fn(),
      stopAll: vi.fn(),
      sendToOrchChannel: vi.fn(async () => null),
    };
    const registry = new ConnectorRegistry();
    registry.register('discord-agent', provider, { label: 'DA', schema: null });

    const notify = vi.fn(async () => {});
    const { store, calls } = fakeStore();

    await notifyApprovalRequested({
      spawner: fakeSpawner({
        roleStore: fakeRoleStore([{ type: 'discord-agent', config: {} }]),
        connectorRegistry: registry,
      }),
      orch: fakeOrch(notify),
      session: fakeSession,
      approval: fakeApproval,
      store,
    });

    expect(calls).toEqual([]); // nothing captured
    expect(notify).toHaveBeenCalledTimes(1); // webhook informational fallback
  });

  it('a throwing plugin seam never escapes and falls back to the webhook', async () => {
    const provider: ChannelConnectorProvider = {
      subscribeOrch: vi.fn(),
      unsubscribeOrch: vi.fn(),
      stopAll: vi.fn(),
      sendToOrchChannel: vi.fn(async () => {
        throw new Error('gateway down');
      }),
    };
    const registry = new ConnectorRegistry();
    registry.register('discord-agent', provider, { label: 'DA', schema: null });

    const notify = vi.fn(async () => {});
    const { store, calls } = fakeStore();

    await expect(
      notifyApprovalRequested({
        spawner: fakeSpawner({
          roleStore: fakeRoleStore([{ type: 'discord-agent', config: {} }]),
          connectorRegistry: registry,
        }),
        orch: fakeOrch(notify),
        session: fakeSession,
        approval: fakeApproval,
        store,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('ignores a builtin `discord` connector for the plugin branch (uses webhook)', async () => {
    // A role with only the builtin connector must NOT take the plugin branch —
    // registry.get('discord') has no plugin provider here, so we fall through.
    const registry = new ConnectorRegistry();
    const notify = vi.fn(async () => {});
    const { store, calls } = fakeStore();

    await notifyApprovalRequested({
      spawner: fakeSpawner({
        roleStore: fakeRoleStore([{ type: 'discord', channelId: '123' }]),
        connectorRegistry: registry,
      }),
      orch: fakeOrch(notify),
      session: fakeSession,
      approval: fakeApproval,
      store,
    });

    expect(calls).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
