/**
 * S9 — REST end-to-end for `GET /metrics/messages` (fusion S4 + S9).
 *
 * Boots the full server stack and drives the aggregator's `tick()` directly
 * (via the `aggregator` exposed on the `TestStack`) so we don't have to wait
 * the real 60 s interval. The aggregator's `start()` is intentionally NOT
 * called in the integration helper — see helpers.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

/** Create an orchestrator with `skipSpawn: true` (no real PTY). */
function createOrch(name = 'metrics-team') {
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

async function broadcast(orchestratorId: string, content: string): Promise<void> {
  const res = await fetch(
    `http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}/broadcast`,
    {
      method: 'POST',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({ content }),
    },
  );
  expect(res.status).toBe(200);
}

describe('REST: /metrics/messages', () => {
  it('returns 401 without an X-Auth-Token', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/messages`);
    expect(res.status).toBe(401);
  });

  it('returns the empty boot snapshot when no orch exists', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/messages`, {
      headers: authHeaders(stack.config.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      per_minute: number;
      global: number[];
      per_orchestrator: Record<string, number[]>;
    };
    expect(body.total).toBe(0);
    expect(body.per_minute).toBe(0);
    expect(body.global).toHaveLength(60);
    expect(body.global.every((n) => n === 0)).toBe(true);
    expect(body.per_orchestrator).toEqual({});
  });

  it('reflects 1 orch + N broadcasts after a tick', async () => {
    // Start the aggregator's internal accounting (mimics what `start()` does
    // for `_lastTotalsByOrch`) by ticking once with the orch present.
    const { orchestratorId } = createOrch();
    // Drive the aggregator's _last* baselines manually (no `start()` in tests).
    stack.aggregator.tick();

    const N = 5;
    for (let i = 0; i < N; i++) await broadcast(orchestratorId, `m${i}`);

    stack.aggregator.tick();

    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/messages`, {
      headers: authHeaders(stack.config.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      per_minute: number;
      global: number[];
      per_orchestrator: Record<string, number[]>;
    };
    expect(body.total).toBe(N);
    expect(body.global[59]).toBe(N);
    expect(body.per_minute).toBe(N);
    expect(body.per_orchestrator[orchestratorId]?.[7]).toBe(N);
  });

  it('tracks two orchestrators independently in per_orchestrator', async () => {
    const a = createOrch('team-a');
    const b = createOrch('team-b');
    stack.aggregator.tick(); // baseline

    await broadcast(a.orchestratorId, 'a1');
    await broadcast(a.orchestratorId, 'a2');
    await broadcast(a.orchestratorId, 'a3');
    await broadcast(b.orchestratorId, 'b1');

    stack.aggregator.tick();

    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/messages`, {
      headers: authHeaders(stack.config.token),
    });
    const body = (await res.json()) as {
      total: number;
      per_orchestrator: Record<string, number[]>;
      global: number[];
    };
    expect(body.total).toBe(4);
    expect(body.global[59]).toBe(4);
    expect(body.per_orchestrator[a.orchestratorId]?.[7]).toBe(3);
    expect(body.per_orchestrator[b.orchestratorId]?.[7]).toBe(1);
  });

  it('a stopped orch keeps its key; ring decays to [0]*8 over 8 ticks', async () => {
    const { orchestratorId } = createOrch('soon-stopped');
    stack.aggregator.tick(); // baseline
    await broadcast(orchestratorId, 'hi');
    stack.aggregator.tick();
    expect(stack.aggregator.snapshot().per_orchestrator[orchestratorId]?.[7]).toBe(1);

    // Stop the orch via REST.
    const del = await fetch(
      `http://127.0.0.1:${stack.mainPort}/orchestrators/${orchestratorId}`,
      { method: 'DELETE', headers: authHeaders(stack.config.token) },
    );
    expect(del.status).toBe(204);

    // 8 quiet ticks — messagesTotal stays frozen on the stopped orch, so each
    // tick pushes a 0 into its ring.
    for (let i = 0; i < 8; i++) stack.aggregator.tick();

    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/metrics/messages`, {
      headers: authHeaders(stack.config.token),
    });
    const body = (await res.json()) as { per_orchestrator: Record<string, number[]> };
    expect(body.per_orchestrator[orchestratorId]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('invariant: snapshot.total === Σ /orchestrators[].msgCount', async () => {
    const a = createOrch('inv-a');
    const b = createOrch('inv-b');
    stack.aggregator.tick();

    await broadcast(a.orchestratorId, 'x');
    await broadcast(a.orchestratorId, 'y');
    await broadcast(b.orchestratorId, 'z');

    stack.aggregator.tick();

    const [metrics, list] = await Promise.all([
      fetch(`http://127.0.0.1:${stack.mainPort}/metrics/messages`, {
        headers: authHeaders(stack.config.token),
      }).then((r) => r.json() as Promise<{ total: number }>),
      fetch(`http://127.0.0.1:${stack.mainPort}/orchestrators`, {
        headers: authHeaders(stack.config.token),
      }).then(
        (r) => r.json() as Promise<{ orchestrators: Array<{ msgCount: number }> }>,
      ),
    ]);
    const sumOfMsgCount = list.orchestrators.reduce((acc, o) => acc + o.msgCount, 0);
    expect(metrics.total).toBe(sumOfMsgCount);
  });
});
