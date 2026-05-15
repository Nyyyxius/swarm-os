/**
 * Phase 7 — POST /hooks/notification.
 *
 * Validates Bearer auth, body validation, ignored unknown ids, and the
 * Notifier dispatch via a recording double.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, RecordingNotifier, type TestStack } from './helpers.js';
import { FakeAgentProcess } from '../../src/modules/orchestrator/agent-process.js';

let stack: TestStack;
let notifier: RecordingNotifier;

beforeEach(async () => {
  notifier = new RecordingNotifier();
  stack = await bootTestStack({ notifier });
});

afterEach(async () => {
  await stack.teardown();
});

describe('POST /hooks/notification', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/hooks/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orch_id: 'x', session_id: 'y', message: 'm' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token (401)', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/hooks/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ orch_id: 'x', session_id: 'y', message: 'm' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 + ignored for an unknown orch (per spike H6)', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/hooks/notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stack.config.hookToken}`,
      },
      body: JSON.stringify({ orch_id: 'ghost', session_id: 'g2', message: 'm' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ignored?: string };
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe('orch_unknown');
    expect(notifier.events).toHaveLength(0);
  });

  it('fires the notifier on a known orch + session', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: stack.workspaceRoot });
    const { orchestrator, lead } = stack.spawner.create(
      {
        name: 'hook',
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
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/hooks/notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stack.config.hookToken}`,
      },
      body: JSON.stringify({
        orch_id: orchestrator.id,
        session_id: lead.id,
        kind: 'session.waiting',
        message: 'human, please review',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // Allow the fire-and-forget notifier to flush.
    await new Promise((r) => setTimeout(r, 30));
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.kind).toBe('session.waiting');
    expect(notifier.events[0]?.session?.id).toBe(lead.id);
  });

  it('returns 400 for missing orch_id', async () => {
    const res = await fetch(`http://127.0.0.1:${stack.mainPort}/hooks/notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stack.config.hookToken}`,
      },
      body: JSON.stringify({ session_id: 'x', message: 'm' }),
    });
    expect(res.status).toBe(400);
  });
});
