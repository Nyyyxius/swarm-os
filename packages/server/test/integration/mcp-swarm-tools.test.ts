/**
 * Cross-team messaging — swarm.* MCP tools end-to-end.
 *
 * Boots the full stack, spins up 2–3 orchestrators (each with a FakeAgent
 * lead and an optional FakeAgent worker), drives the swarm.* tools via a
 * real MCP client, and asserts both the permission gates and the routing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bootTestStack, type TestStack } from './helpers.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

interface OrchHandle {
  orchestratorId: string;
  leadId: string;
  leadSecret: string;
  leadName: string;
  name: string;
}

function createOrch(name: string): OrchHandle {
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
  return {
    orchestratorId: orchestrator.id,
    leadId: lead.id,
    leadSecret: lead.sessionSecret,
    leadName: lead.name,
    name: orchestrator.name,
  };
}

async function addFakeWorker(orchId: string, name = 'scout') {
  const { FakeAgentProcess } = await import('../../src/modules/orchestrator/agent-process.js');
  const orch = stack.spawner.get(orchId);
  if (!orch) throw new Error(`orch ${orchId} not found`);
  const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: stack.workspaceRoot });
  return orch.addWorker({
    name,
    role: 'recon',
    prompt: 'noop',
    cwd: stack.workspaceRoot,
    agentProcessOverride: fake,
  });
}

async function makeClient(orchId: string, secret: string): Promise<Client> {
  const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`;
  const t = new StreamableHTTPClientTransport(new URL(url));
  const c = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await c.connect(t);
  return c;
}

describe('swarm.list_teams', () => {
  it('returns other active orchestrators, excludes the caller and stopped orchs', async () => {
    const a = createOrch('alpha');
    const b = createOrch('bravo');
    const c = createOrch('charlie');
    // Add a worker to bravo so we can assert worker_count.
    await addFakeWorker(b.orchestratorId, 'b-worker');
    // Stop charlie — it should drop out of list_teams.
    stack.spawner.destroy(c.orchestratorId, 'test');
    await new Promise((r) => setTimeout(r, 30));

    const leadA = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const res = await leadA.callTool({ name: 'swarm.list_teams', arguments: {} });
      const { teams } = res.structuredContent as {
        teams: Array<{
          orchestrator_id: string;
          name: string;
          worker_count: number;
          lead: { session_id: string; name: string };
        }>;
      };
      const ids = teams.map((t) => t.orchestrator_id);
      expect(ids).toContain(b.orchestratorId);
      expect(ids).not.toContain(a.orchestratorId); // caller hidden
      expect(ids).not.toContain(c.orchestratorId); // stopped hidden

      const bravoEntry = teams.find((t) => t.orchestrator_id === b.orchestratorId);
      expect(bravoEntry?.name).toBe('bravo');
      expect(bravoEntry?.worker_count).toBe(1);
      expect(bravoEntry?.lead.session_id).toBe(b.leadId);
      expect(bravoEntry?.lead.name).toBe(b.leadName);
    } finally {
      await leadA.close();
    }
  });

  it('worker calling swarm.list_teams gets PERMISSION_DENIED', async () => {
    const a = createOrch('alpha');
    createOrch('bravo'); // give the lead something to list, but worker shouldn't see anything
    const worker = await addFakeWorker(a.orchestratorId);
    const workerClient = await makeClient(a.orchestratorId, worker.sessionSecret);
    try {
      const denied = await workerClient.callTool({
        name: 'swarm.list_teams',
        arguments: {},
      });
      expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');
    } finally {
      await workerClient.close();
    }
  });
});

describe('swarm.send_to_lead', () => {
  it('delivers a tagged message to the target lead inbox', async () => {
    const a = createOrch('alpha');
    const b = createOrch('bravo');

    const leadA = await makeClient(a.orchestratorId, a.leadSecret);
    const leadB = await makeClient(b.orchestratorId, b.leadSecret);
    try {
      const send = await leadA.callTool({
        name: 'swarm.send_to_lead',
        arguments: { orchestrator_id: b.orchestratorId, content: 'ping from alpha' },
      });
      const sendOut = send.structuredContent as {
        delivered: boolean;
        to_session_id: string;
        to_orchestrator_id: string;
      };
      expect(sendOut.delivered).toBe(true);
      expect(sendOut.to_session_id).toBe(b.leadId);
      expect(sendOut.to_orchestrator_id).toBe(b.orchestratorId);

      const inbox = await leadB.callTool({ name: 'team.read_inbox', arguments: {} });
      const { messages } = inbox.structuredContent as {
        messages: Array<{
          from: string;
          content: string;
          from_orchestrator?: { id: string; name: string; lead_name: string };
        }>;
      };
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('ping from alpha');
      expect(messages[0]?.from).toBe(a.leadId);
      expect(messages[0]?.from_orchestrator).toEqual({
        id: a.orchestratorId,
        name: 'alpha',
        lead_name: a.leadName,
      });
    } finally {
      await leadA.close();
      await leadB.close();
    }
  });

  it('worker calling swarm.send_to_lead gets PERMISSION_DENIED (even with a valid target)', async () => {
    const a = createOrch('alpha');
    const b = createOrch('bravo');
    const worker = await addFakeWorker(a.orchestratorId);
    const workerClient = await makeClient(a.orchestratorId, worker.sessionSecret);
    try {
      const denied = await workerClient.callTool({
        name: 'swarm.send_to_lead',
        arguments: { orchestrator_id: b.orchestratorId, content: 'hi' },
      });
      expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');
      // Confirm nothing landed in bravo's inbox.
      const bravo = stack.spawner.get(b.orchestratorId);
      expect(bravo?.mailbox.peek(b.leadId)).toHaveLength(0);
    } finally {
      await workerClient.close();
    }
  });

  it('returns ORCH_UNKNOWN for an unknown orchestrator_id', async () => {
    const a = createOrch('alpha');
    const leadA = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const res = await leadA.callTool({
        name: 'swarm.send_to_lead',
        arguments: {
          orchestrator_id: '00000000-0000-0000-0000-000000000000',
          content: 'hi',
        },
      });
      expect(JSON.stringify(res)).toContain('ORCH_UNKNOWN');
    } finally {
      await leadA.close();
    }
  });

  it('returns INVALID_RECIPIENT when targeting the caller own orchestrator', async () => {
    const a = createOrch('alpha');
    const leadA = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const res = await leadA.callTool({
        name: 'swarm.send_to_lead',
        arguments: { orchestrator_id: a.orchestratorId, content: 'hi' },
      });
      expect(JSON.stringify(res)).toContain('INVALID_RECIPIENT');
    } finally {
      await leadA.close();
    }
  });

  it('returns ORCH_NOT_ACTIVE for a stopped orchestrator', async () => {
    const a = createOrch('alpha');
    const b = createOrch('bravo');
    stack.spawner.destroy(b.orchestratorId, 'test');
    await new Promise((r) => setTimeout(r, 30));

    const leadA = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const res = await leadA.callTool({
        name: 'swarm.send_to_lead',
        arguments: { orchestrator_id: b.orchestratorId, content: 'hi' },
      });
      expect(JSON.stringify(res)).toContain('ORCH_NOT_ACTIVE');
    } finally {
      await leadA.close();
    }
  });
});

describe('swarm.broadcast_to_leads', () => {
  it('delivers to every other lead but not the caller', async () => {
    const a = createOrch('alpha');
    const b = createOrch('bravo');
    const c = createOrch('charlie');

    const leadA = await makeClient(a.orchestratorId, a.leadSecret);
    try {
      const res = await leadA.callTool({
        name: 'swarm.broadcast_to_leads',
        arguments: { content: 'all hands' },
      });
      const { delivered_to } = res.structuredContent as {
        delivered_to: Array<{ orchestrator_id: string; session_id: string }>;
      };
      const orchIds = delivered_to.map((d) => d.orchestrator_id).sort();
      expect(orchIds).toEqual([b.orchestratorId, c.orchestratorId].sort());

      const orchA = stack.spawner.get(a.orchestratorId);
      const orchB = stack.spawner.get(b.orchestratorId);
      const orchC = stack.spawner.get(c.orchestratorId);
      expect(orchA?.mailbox.peek(a.leadId)).toHaveLength(0);
      expect(orchB?.mailbox.peek(b.leadId)).toHaveLength(1);
      expect(orchC?.mailbox.peek(c.leadId)).toHaveLength(1);
      expect(orchB?.mailbox.peek(b.leadId)[0]?.content).toBe('all hands');
      expect(orchB?.mailbox.peek(b.leadId)[0]?.fromOrchestratorId).toBe(a.orchestratorId);
    } finally {
      await leadA.close();
    }
  });

  it('worker calling swarm.broadcast_to_leads gets PERMISSION_DENIED', async () => {
    const a = createOrch('alpha');
    createOrch('bravo');
    const worker = await addFakeWorker(a.orchestratorId);
    const workerClient = await makeClient(a.orchestratorId, worker.sessionSecret);
    try {
      const denied = await workerClient.callTool({
        name: 'swarm.broadcast_to_leads',
        arguments: { content: 'hi' },
      });
      expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');
    } finally {
      await workerClient.close();
    }
  });
});
