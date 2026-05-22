/**
 * Phase 7 — REST end-to-end via FakeAgentProcess.
 *
 * Boots the full server stack (HTTP + MCP + SQLite + Spawner). Creates an
 * orchestrator + lead via the REST surface, drives the team-comms tools via
 * a real MCP client, asserts on inbox state, and tears down cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

/**
 * Create an orchestrator via the spawner directly with `skipSpawn: true` so
 * we never launch a real `claude` subprocess. The REST surface doesn't take
 * a `skipSpawn` flag (production code always wants a real PTY) — so for the
 * integration tests we sidestep it for the create call and exercise the
 * REST endpoints for everything that follows.
 */
function createOrch(name = 'merge-team'): { orchestratorId: string; leadId: string } {
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
  return { orchestratorId: orchestrator.id, leadId: lead.id };
}

describe('REST: orchestrator lifecycle', () => {
  it('returns 401 without a token', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('lists a created orchestrator', async () => {
    const { orchestratorId } = createOrch();
    const list = await fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators`, {
      headers: authHeaders(stack.config.token),
    });
    const body = (await list.json()) as { orchestrators: Array<{ id: string; status: string }> };
    expect(body.orchestrators.find((o) => o.id === orchestratorId)).toBeTruthy();
  });

  it('returns 404 for a non-existent orchestrator', async () => {
    const res = await fetch(
      `http://127.0.0.1:${stack.mainPort}/orchestrators/00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(stack.config.token) },
    );
    expect(res.status).toBe(404);
  });

  it('GET /health returns the project name', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; project_name: string };
    expect(body.status).toBe('ok');
    expect(body.project_name).toBe(stack.config.projectName);
  });

  it('DELETE /orchestrators/:id is idempotent', async () => {
    const { orchestratorId } = createOrch();
    const del1 = await fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}`, {
      method: 'DELETE',
      headers: authHeaders(stack.config.token),
    });
    expect(del1.status).toBe(204);
    const del2 = await fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}`, {
      method: 'DELETE',
      headers: authHeaders(stack.config.token),
    });
    expect(del2.status).toBe(204);
  });

  it('POST /orchestrators/:id/broadcast pushes a human message into every active inbox', async () => {
    const { orchestratorId, leadId } = createOrch();
    const res = await fetch(
      `http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}/broadcast`,
      {
        method: 'POST',
        headers: authHeaders(stack.config.token),
        body: JSON.stringify({ content: 'announcement' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivered_to: string[] };
    expect(body.delivered_to).toContain(leadId);
    const inbox = stack.spawner.get(orchestratorId)?.mailbox.peek(leadId) ?? [];
    expect(inbox[0]?.from).toBe('human');
  });

  it('exposes msgCount on GET /orchestrators and GET /orchestrators/:id (S1)', async () => {
    const { orchestratorId, leadId } = createOrch('msg-count-team');

    // Initial state: a freshly created orchestrator has pushed zero bus messages.
    const r0 = await fetch(
      `http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}`,
      { headers: authHeaders(stack.config.token) },
    );
    expect(r0.status).toBe(200);
    const v0 = (await r0.json()) as { msgCount: number };
    expect(v0.msgCount).toBe(0);

    // Drive N broadcasts via REST. Each broadcast has `from: 'human'`, which
    // doesn't match any session id, so all active sessions are recipients —
    // here just the lead, so one push per broadcast = +1 msgCount each.
    const N = 5;
    for (let i = 0; i < N; i++) {
      const res = await fetch(
        `http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}/broadcast`,
        {
          method: 'POST',
          headers: authHeaders(stack.config.token),
          body: JSON.stringify({ content: `m${i}` }),
        },
      );
      expect(res.status).toBe(200);
    }

    // GET /orchestrators/:id reflects the cumulative count.
    const r1 = await fetch(
      `http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}`,
      { headers: authHeaders(stack.config.token) },
    );
    const v1 = (await r1.json()) as { msgCount: number };
    expect(v1.msgCount).toBe(N);

    // GET /orchestrators (list) also exposes msgCount on the same row.
    const r2 = await fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators`, {
      headers: authHeaders(stack.config.token),
    });
    const list = (await r2.json()) as { orchestrators: Array<{ id: string; msgCount: number }> };
    const row = list.orchestrators.find((o) => o.id === orchestratorId);
    expect(row).toBeTruthy();
    expect(row!.msgCount).toBe(N);

    // The mailbox-level counter agrees (sanity).
    expect(stack.spawner.get(orchestratorId)?.mailbox.messagesTotal).toBe(N);
    // Lead inbox was drained by zero readers, so all N landed in lead.
    expect(stack.spawner.get(orchestratorId)?.mailbox.peek(leadId).length).toBe(N);
  });
});

describe('REST + MCP end-to-end (worker spawned via fake agent)', () => {
  async function makeClient(orchId: string, secret: string): Promise<Client> {
    const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`;
    const t = new StreamableHTTPClientTransport(new URL(url));
    const c = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await c.connect(t);
    return c;
  }

  it('drives whoami, list, send_message, read_inbox, broadcast, kill via real MCP', async () => {
    const { FakeAgentProcess } = await import('../../src/modules/orchestrator/agent-process.js');
    const { orchestratorId, leadId } = createOrch();
    const orch = stack.spawner.get(orchestratorId);
    expect(orch).toBeDefined();
    const lead = orch!.getSession(leadId);
    expect(lead).toBeDefined();

    // Add a worker via the orchestrator directly with a fake agent — same path
    // as the verify-phase-3 harness. Bypasses MCP spawn_worker so we don't
    // depend on the real claude CLI.
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: stack.workspaceRoot });
    const worker = orch!.addWorker({
      name: 'scout',
      role: 'recon',
      prompt: 'noop',
      cwd: stack.workspaceRoot,
      agentProcessOverride: fake,
    });

    const leadClient = await makeClient(orchestratorId, lead!.sessionSecret);
    const workerClient = await makeClient(orchestratorId, worker.sessionSecret);

    // whoami
    const me = await leadClient.callTool({ name: 'team.whoami', arguments: {} });
    expect((me.structuredContent as { is_lead: boolean }).is_lead).toBe(true);

    const meWorker = await workerClient.callTool({ name: 'team.whoami', arguments: {} });
    expect((meWorker.structuredContent as { is_lead: boolean }).is_lead).toBe(false);

    // list
    const list = await leadClient.callTool({ name: 'team.list', arguments: {} });
    const members = (list.structuredContent as { members: Array<{ session_id: string }> }).members;
    expect(members.map((m) => m.session_id).sort()).toEqual([leadId, worker.id].sort());

    // send_message lead → worker, worker reads
    await leadClient.callTool({
      name: 'team.send_message',
      arguments: { to: worker.id, content: 'hello scout' },
    });
    const inbox = await workerClient.callTool({ name: 'team.read_inbox', arguments: {} });
    const msgs = (inbox.structuredContent as { messages: Array<{ from: string; content: string }> })
      .messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe('hello scout');

    // broadcast lands in worker inbox only (excludes sender)
    await leadClient.callTool({
      name: 'team.broadcast',
      arguments: { content: 'team-wide' },
    });
    expect(orch!.mailbox.peek(worker.id).length).toBe(1);
    expect(orch!.mailbox.peek(leadId).length).toBe(0);

    // worker.spawn_worker → PERMISSION_DENIED (no real claude needed — the
    // permission gate runs before the orchestrator.addWorker call).
    const denied = await workerClient.callTool({
      name: 'team.spawn_worker',
      arguments: { name: 'rogue', role: 'r', prompt: 'p' },
    });
    expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');

    // kill_worker
    const k1 = await leadClient.callTool({
      name: 'team.kill_worker',
      arguments: { id: worker.id },
    });
    expect((k1.structuredContent as { killed: boolean }).killed).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const k2 = await leadClient.callTool({
      name: 'team.kill_worker',
      arguments: { id: worker.id },
    });
    expect((k2.structuredContent as { killed: boolean }).killed).toBe(false);

    await leadClient.close();
    await workerClient.close();
  });

  it('rejects MCP requests with a bad session_secret (404)', async () => {
    const { orchestratorId } = createOrch();
    const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchestratorId}/00000000-0000-0000-0000-000000000000`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(res.status).toBe(404);
  });

  it('cross-orchestrator isolation: secret from orch A cannot reach orch B', async () => {
    const a = createOrch('orch-a');
    const b = createOrch('orch-b');
    const aLead = stack.spawner.get(a.orchestratorId)!.getSession(a.leadId)!;
    // Try to dial orch-b with orch-a's lead secret — should 404.
    const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${b.orchestratorId}/${aLead.sessionSecret}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(res.status).toBe(404);
  });
});
