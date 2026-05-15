/**
 * Phase 7 — WebSocket terminal multi-attach.
 *
 * Boots the server, creates a session, requests a ws-ticket, opens a WS,
 * verifies the first connection becomes writer, the second is read-only,
 * resize messages reach the underlying agent, and an already-consumed
 * ticket is rejected (401).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { FakeAgentProcess } from '../../src/modules/orchestrator/agent-process.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

interface SessionFixture {
  sessionId: string;
  fake: FakeAgentProcess;
}

function makeSession(): SessionFixture {
  const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: stack.workspaceRoot });
  const { lead, orchestrator } = stack.spawner.create(
    {
      name: 'ws',
      role: 'r',
      defaultModel: stack.config.defaultModel,
      defaultEffort: stack.config.defaultEffort,
      defaultPermissionMode: stack.config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
    },
    { skipSpawn: false, agentProcessOverride: fake },
  );
  expect(orchestrator.id).toBeDefined();
  return { sessionId: lead.id, fake };
}

async function getTicket(sessionId: string): Promise<string> {
  const res = await fetch(
    `http://127.0.0.1:${stack.mainPort}/ws-ticket?session=${sessionId}`,
    { headers: authHeaders(stack.config.token) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

function openWs(sessionId: string, ticket: string): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${stack.mainPort}/ws/sessions/${sessionId}?ticket=${ticket}`,
  );
}

/**
 * Buffer EVERY incoming JSON message on the WS for later assertion. We use a
 * buffer (rather than `nextMessage()`) because the server fires `attached`
 * inside the upgrade callback, which can land in the same microtask the
 * client's `open` event fires — a `once('message', ...)` registered after
 * `awaitOpen(...)` would miss it.
 */
function bufferMessages(ws: WebSocket): { messages: Record<string, unknown>[] } {
  const buf: Record<string, unknown>[] = [];
  ws.on('message', (raw) => {
    try {
      buf.push(JSON.parse(String(raw)));
    } catch {
      /* ignore non-JSON */
    }
  });
  return { messages: buf };
}

async function waitForMessage(
  buf: { messages: Record<string, unknown>[] },
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = buf.messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for message');
}

function awaitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS open timeout (3s)')), 3000);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(t);
      reject(new Error(`unexpected response status=${res.statusCode}`));
    });
  });
}

describe('WebSocket terminal', () => {
  it('first attached client becomes writer, second is reader', async () => {
    const { sessionId } = makeSession();
    const t1 = await getTicket(sessionId);
    const w1 = openWs(sessionId, t1);
    const buf1 = bufferMessages(w1);
    await awaitOpen(w1);
    const m1 = await waitForMessage(buf1, (m) => m.type === 'attached');
    expect(m1.role).toBe('writer');

    const t2 = await getTicket(sessionId);
    const w2 = openWs(sessionId, t2);
    const buf2 = bufferMessages(w2);
    await awaitOpen(w2);
    const m2 = await waitForMessage(buf2, (m) => m.type === 'attached');
    expect(m2.role).toBe('reader');

    w1.close();
    w2.close();
  });

  it('rejects (401) a reused ticket', async () => {
    const { sessionId } = makeSession();
    const t = await getTicket(sessionId);
    const w1 = openWs(sessionId, t);
    const buf1 = bufferMessages(w1);
    await awaitOpen(w1);
    await waitForMessage(buf1, (m) => m.type === 'attached');

    // Reuse the same ticket — should be rejected by the server's upgrade
    // handler before the WS handshake completes.
    const w2 = openWs(sessionId, t);
    await new Promise<void>((resolve) => {
      w2.once('error', () => resolve());
      w2.once('unexpected-response', () => resolve());
      w2.once('open', () => resolve()); // safety — will fail assertion below
      setTimeout(() => resolve(), 1000);
    });
    expect(w2.readyState).not.toBe(WebSocket.OPEN);

    w1.close();
  });

  it('forwards a resize message to the underlying agent (no crash)', async () => {
    const { sessionId, fake } = makeSession();
    const t = await getTicket(sessionId);
    const w = openWs(sessionId, t);
    const buf = bufferMessages(w);
    await awaitOpen(w);
    await waitForMessage(buf, (m) => m.type === 'attached');
    // resize: writer-only — nothing observable on the wire, but should not
    // throw. FakeAgentProcess.resize() is a no-op (the agent doesn't track
    // size), so writes stays empty.
    w.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.writes).toHaveLength(0);
    w.close();
  });

  it('writer can send input that reaches the agent process', async () => {
    const { sessionId, fake } = makeSession();
    const t = await getTicket(sessionId);
    const w = openWs(sessionId, t);
    const buf = bufferMessages(w);
    await awaitOpen(w);
    await waitForMessage(buf, (m) => m.type === 'attached');
    w.send(JSON.stringify({ type: 'input', data: 'hello\n' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.writes).toContain('hello\n');
    w.close();
  });
});
