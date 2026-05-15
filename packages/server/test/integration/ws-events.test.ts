/**
 * Phase 7 — WebSocket events feed.
 *
 * Subscribes via /ws/events with a ticket, then triggers an orchestrator +
 * session creation and verifies the corresponding events arrive.
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

async function getEventsTicket(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${stack.mainPort}/ws-ticket?events=1`, {
    headers: authHeaders(stack.config.token),
  });
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

function awaitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('WebSocket events feed', () => {
  it('subscribes via ticket and receives orchestrator.created + session.created', async () => {
    const t = await getEventsTicket();
    const ws = new WebSocket(`ws://127.0.0.1:${stack.mainPort}/ws/events?ticket=${t}`);
    await awaitOpen(ws);

    const seen: Array<{ kind: string }> = [];
    ws.on('message', (raw) => {
      try {
        const ev = JSON.parse(String(raw)) as { kind: string };
        seen.push(ev);
      } catch {
        /* ignore — hello frame is the only non-event */
      }
    });

    // Trigger one orchestrator + one session.
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: stack.workspaceRoot });
    stack.spawner.create(
      {
        name: 'evtest',
        role: 'r',
        defaultModel: stack.config.defaultModel,
        defaultEffort: stack.config.defaultEffort,
        defaultPermissionMode: stack.config.defaultPermissionMode,
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: stack.workspaceRoot, prompt: 'p', preamble: null },
      },
      { agentProcessOverride: fake },
    );

    // Allow the WS message pump to flush.
    await new Promise((r) => setTimeout(r, 200));
    const kinds = seen.map((e) => e.kind);
    expect(kinds).toContain('orchestrator.created');
    expect(kinds).toContain('session.created');
    expect(kinds).toContain('session.status_changed');
    ws.close();
  });
});
