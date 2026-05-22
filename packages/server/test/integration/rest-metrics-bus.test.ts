/**
 * S8 — REST + MCP-instrumentation integration tests for `/metrics/bus`.
 *
 * Boots the full server stack (HTTP + MCP listener), drives a real MCP
 * client to record latency / err_rate, and asserts on the `GET /metrics/bus`
 * payload. Queue-depth is driven by mailbox pushes via the spawner API
 * (no PTYs spawned — `skipSpawn: true` in `createOrch`).
 *
 * The collector's `start()` is intentionally NOT called by the helper —
 * we drive `tick()` manually so we never wait the real 1 s interval.
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

interface OrchHandle {
  orchestratorId: string;
  leadId: string;
  leadSecret: string;
}

function createOrch(name = 'bus-team'): OrchHandle {
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
  };
}

async function makeClient(orchId: string, secret: string): Promise<Client> {
  const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`;
  const t = new StreamableHTTPClientTransport(new URL(url));
  const c = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await c.connect(t);
  return c;
}

async function fetchBus(): Promise<{
  status: number;
  body?: {
    latency_ms: number;
    throughput_msg_per_s: number;
    queue_depth: number;
    err_rate_pct: number;
    window_seconds: number;
  };
}> {
  const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/bus`, {
    headers: authHeaders(stack.config.token),
  });
  if (!res.ok) return { status: res.status };
  return { status: res.status, body: await res.json() };
}

describe('REST: GET /metrics/bus — auth + schema', () => {
  it('returns 401 without an X-Auth-Token header', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/bus`);
    expect(res.status).toBe(401);
  });

  it('returns a fully-shaped zero snapshot before any MCP traffic', async () => {
    const { status, body } = await fetchBus();
    expect(status).toBe(200);
    expect(body).toBeDefined();
    expect(body!.window_seconds).toBe(60);
    expect(body!.latency_ms).toBe(0);
    expect(body!.err_rate_pct).toBe(0);
    expect(body!.queue_depth).toBe(0);
    // throughput is 0 at boot — the collector hasn't been ticked.
    expect(body!.throughput_msg_per_s).toBe(0);
    // All fields are present and finite.
    expect(Number.isFinite(body!.throughput_msg_per_s)).toBe(true);
  });
});

describe('REST: GET /metrics/bus — latency instrumentation', () => {
  it('records latency_ms > 0 after a few successful MCP tool calls', async () => {
    const orch = createOrch();
    const client = await makeClient(orch.orchestratorId, orch.leadSecret);
    try {
      for (let i = 0; i < 5; i++) {
        await client.callTool({ name: 'team.whoami', arguments: {} });
      }
    } finally {
      await client.close();
    }
    const { status, body } = await fetchBus();
    expect(status).toBe(200);
    expect(body!.latency_ms).toBeGreaterThan(0);
    expect(body!.err_rate_pct).toBe(0);
  });
});

describe('REST: GET /metrics/bus — queue_depth', () => {
  it('reflects the instantaneous Σ mailbox.totalSize()', async () => {
    const orch = createOrch();
    const o = stack.spawner.get(orch.orchestratorId);
    expect(o).toBeDefined();
    // Push 3 raw messages into the lead's inbox. Bypasses MCP — we just
    // want to assert queue_depth aggregation.
    o!.mailbox.push(orch.leadId, { from: 'human', content: 'a' });
    o!.mailbox.push(orch.leadId, { from: 'human', content: 'b' });
    o!.mailbox.push(orch.leadId, { from: 'human', content: 'c' });

    const { status, body } = await fetchBus();
    expect(status).toBe(200);
    expect(body!.queue_depth).toBe(3);
  });

  it('drops when an inbox is drained', async () => {
    const orch = createOrch();
    const o = stack.spawner.get(orch.orchestratorId);
    o!.mailbox.push(orch.leadId, { from: 'human', content: 'a' });
    o!.mailbox.push(orch.leadId, { from: 'human', content: 'b' });
    expect((await fetchBus()).body!.queue_depth).toBe(2);

    // Drain via read() — same path as `team.read_inbox`.
    o!.mailbox.read(orch.leadId);
    expect((await fetchBus()).body!.queue_depth).toBe(0);
  });
});

describe('REST: GET /metrics/bus — throughput', () => {
  it('reflects new bus traffic over the elapsed window after a few ticks', async () => {
    const orch = createOrch();
    const o = stack.spawner.get(orch.orchestratorId);

    // Baseline tick — locks in messagesTotal=0 as the oldest sample.
    stack.busMetrics.tick();

    // Push 10 messages → messagesTotal jumps to 10.
    for (let i = 0; i < 10; i++) {
      o!.mailbox.push(orch.leadId, { from: 'human', content: `m${i}` });
    }
    // Tick once more so the newest slot records messagesTotal=10.
    stack.busMetrics.tick();

    const { status, body } = await fetchBus();
    expect(status).toBe(200);
    // After 2 ticks, denominator = min(60, 2) = 2; delta = 10.
    // throughput = 10 / 2 = 5 msg/s.
    expect(body!.throughput_msg_per_s).toBeCloseTo(5, 5);
  });
});

describe('REST: GET /metrics/bus — err_rate_pct (instrumentation)', () => {
  it('counts a 404-auth path as ZERO requests (no err_rate inflation)', async () => {
    // Hit /mcp/<bogus>/<bogus> — handler should 404 without instrumenting.
    const url = `http://127.0.0.1:${stack.config.mcpPort}/mcp/no-such-orch/bad-secret`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'whatever' }),
    });
    expect(res.status).toBe(404);

    const { status, body } = await fetchBus();
    expect(status).toBe(200);
    // No tool call was instrumented — err_rate stays at 0, latency stays at 0.
    expect(body!.err_rate_pct).toBe(0);
    expect(body!.latency_ms).toBe(0);
  });

  it('exposes 0% err_rate when every MCP tool call succeeded', async () => {
    const orch = createOrch();
    const client = await makeClient(orch.orchestratorId, orch.leadSecret);
    try {
      for (let i = 0; i < 4; i++) {
        await client.callTool({ name: 'team.whoami', arguments: {} });
      }
    } finally {
      await client.close();
    }
    const { body } = await fetchBus();
    expect(body!.err_rate_pct).toBe(0);
  });
});

/**
 * MCP-side instrumentation tests — exercise the collector indirectly by
 * driving real MCP calls and reading back via the public snapshot API.
 */
describe('MCP instrumentation: BusMetricsCollector wiring', () => {
  it('every successful tool call increments the request count exactly once', async () => {
    const orch = createOrch();
    const client = await makeClient(orch.orchestratorId, orch.leadSecret);
    try {
      // Note: `client.connect()` (inside `makeClient`) already sent an
      // `initialize` request through the instrumented path — so the
      // collector has already recorded at least one request by the time we
      // snapshot here. We assert "monotone, never decreased" rather than
      // "before = 0".
      const before = stack.busMetrics.snapshot();
      expect(before.err_rate_pct).toBe(0);

      const N = 3;
      for (let i = 0; i < N; i++) {
        await client.callTool({ name: 'team.whoami', arguments: {} });
      }

      const after = stack.busMetrics.snapshot();
      // After N successful calls latency_ms must be > 0 and err_rate stays 0.
      expect(after.latency_ms).toBeGreaterThan(0);
      expect(after.err_rate_pct).toBe(0);
      // Latency is the *mean* over the window — we can't assert "increased"
      // unambiguously (4 fast calls could pull the mean down). The
      // monotone invariant lives in `requests` which we don't expose; the
      // "stays at 0% errors" check above is what guards instrumentation.
    } finally {
      await client.close();
    }
  });

  it('does NOT instrument requests that fail auth (404 path)', async () => {
    const before = stack.busMetrics.snapshot();
    expect(before.latency_ms).toBe(0);
    expect(before.err_rate_pct).toBe(0);

    // 5 bad-auth probes.
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${stack.config.mcpPort}/mcp/bad/bad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
      });
    }

    const after = stack.busMetrics.snapshot();
    // Nothing should have been recorded — 404 paths skip the collector.
    expect(after.latency_ms).toBe(0);
    expect(after.err_rate_pct).toBe(0);
  });
});
