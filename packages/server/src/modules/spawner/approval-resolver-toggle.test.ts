/**
 * docs/builtin-features.md D9 — the Discord approval reply/reaction resolvers are
 * attached to a connector subscription UNCONDITIONALLY, and each reads the
 * `approvals` feature flag AT CALL TIME. So a subscription wired while approvals
 * was ON keeps honouring a LATER disable WITHOUT re-subscribing: with approvals
 * off the resolver neutralises to `{ consumed: false }` (the reply falls through
 * to the lead inbox as in the pre-approvals world) and the pending approval is
 * NOT resolved.
 *
 * This drives a REAL Spawner (skipSpawn: no PTY) whose role carries a discord
 * connector, and captures the `sub` handed to a fake connector provider — the
 * exact object `bot.ts` would call — then flips the feature thunk between calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { DbPersistence } from '../orchestrator/persistence.js';
import { Spawner } from './index.js';
import { ApprovalStore } from '../approvals/store.js';
import type { Config } from '../../config.js';
import type { RoleStore, Role } from '../roles/index.js';
import type { ConnectorRegistry } from '../plugins/connector-registry.js';
import type { PluginOrchSubscription, ChannelConnectorProvider } from '../plugins/api-types.js';
import type { FeatureName } from '../features/registry.js';

let tmpRoot: string;
let db: SwarmDb;
let spawner: Spawner | null;

function makeConfig(): Config {
  return {
    port: 8790,
    host: '127.0.0.1',
    mcpPort: 0,
    projectName: 'test',
    defaultModel: 'm',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir: path.join(tmpRoot, 'data'),
    logsDir: path.join(tmpRoot, 'logs'),
    mcpRuntimeDir: path.join(tmpRoot, 'mcp-runtime'),
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 100,
    idleThresholdMs: 50,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
  } as Config;
}

/** A role with one discord connector, so the spawner wires it at create time. */
function fakeRole(): Role {
  return {
    id: 'role-1',
    label: 'R',
    connectors: [{ type: 'discord', botToken: 't', channelId: 'c' }],
    workerCount: 0,
    approval: null,
  } as unknown as Role;
}

const ALL_ON: Record<FeatureName, boolean> = {
  ide: true,
  codegraph: true,
  board: true,
  memory: true,
  monitoring: true,
  approvals: true,
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-appr-toggle-'));
  for (const d of ['data', 'logs', 'mcp-runtime']) {
    fs.mkdirSync(path.join(tmpRoot, d), { recursive: true });
  }
  db = new SwarmDb(path.join(tmpRoot, 'data'));
  spawner = null;
});

afterEach(async () => {
  spawner?.shutdownAll('test-teardown');
  await new Promise((r) => setTimeout(r, 50));
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Spawner — approval resolver honours the feature toggle at call time', () => {
  it('consumes a Discord reply when ON, drops it (unconsumed, pending kept) when OFF', async () => {
    const approvals = new ApprovalStore(db);
    let approvalsOn = true;
    const features = (): Record<FeatureName, boolean> => ({ ...ALL_ON, approvals: approvalsOn });

    // Capture the subscription the spawner hands the connector provider.
    let captured: PluginOrchSubscription | null = null;
    const provider: ChannelConnectorProvider = {
      subscribeOrch: async (_cfg, sub) => {
        captured = sub;
      },
      unsubscribeOrch: async () => {},
      stopAll: async () => {},
    };
    const connectorRegistry = {
      setRetroactiveWirer: () => {},
      get: (type: string) => (type === 'discord' ? provider : null),
      unsubscribeAll: async () => {},
      stopAll: async () => {},
    } as unknown as ConnectorRegistry;
    const roleStore = { get: (id: string) => (id === 'role-1' ? fakeRole() : null) } as unknown as RoleStore;

    spawner = new Spawner(makeConfig(), {
      persistence: new DbPersistence(db),
      roleStore,
      connectorRegistry,
      approvals,
      features,
    });

    const { orchestrator } = spawner.create(
      {
        name: 'TEAM',
        role: 'co',
        roleId: 'role-1',
        defaultModel: 'm',
        defaultEffort: 'low',
        defaultPermissionMode: 'default',
        defaultProvider: 'claude',
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
      },
      { skipSpawn: true },
    );

    // subscribeOrch is fired on a microtask after create — let it settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).not.toBeNull();
    const sub = captured!;
    // The resolvers are attached UNCONDITIONALLY (present even though we will
    // toggle the flag between calls).
    expect(typeof sub.tryConsumeApprovalReply).toBe('function');
    expect(typeof sub.tryConsumeApprovalReaction).toBe('function');

    // Two pending approvals, each correlated to a distinct Discord message id.
    const a = approvals.createRequest({
      orchestratorId: orchestrator.id,
      sessionId: 'sess-gone-a',
      category: 'permission',
      requestedSummary: 's',
      rawMessage: 'r',
      permissionMode: 'default',
      provider: 'claude',
    });
    approvals.setDiscordMessageId(a!.id, 'msg-a');
    const b = approvals.createRequest({
      orchestratorId: orchestrator.id,
      sessionId: 'sess-gone-b',
      category: 'permission',
      requestedSummary: 's',
      rawMessage: 'r',
      permissionMode: 'default',
      provider: 'claude',
    });
    approvals.setDiscordMessageId(b!.id, 'msg-b');

    // --- ON: the reply IS consumed and the approval leaves `pending`. ---
    approvalsOn = true;
    const onResult = sub.tryConsumeApprovalReply!({
      referenceMessageId: 'msg-a',
      content: 'approve',
      author: 'op',
    });
    expect(onResult.consumed).toBe(true);
    expect(approvals.getRequest(a!.id)!.status).not.toBe('pending');

    // --- OFF: the SAME kind of reply is NOT consumed and `b` stays pending. ---
    approvalsOn = false;
    const offResult = sub.tryConsumeApprovalReply!({
      referenceMessageId: 'msg-b',
      content: 'approve',
      author: 'op',
    });
    expect(offResult.consumed).toBe(false);
    expect(approvals.getRequest(b!.id)!.status).toBe('pending');

    // The reaction resolver honours the same call-time gate.
    const offReaction = sub.tryConsumeApprovalReaction!({
      referenceMessageId: 'msg-b',
      emoji: '✅',
      reactor: 'op',
    });
    expect(offReaction.consumed).toBe(false);
    expect(approvals.getRequest(b!.id)!.status).toBe('pending');
  });
});
