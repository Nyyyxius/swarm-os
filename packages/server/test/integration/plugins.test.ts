/**
 * J1 plugins — end-to-end over the real HTTP + WS stack.
 *
 * Drops the example `echo` plugin under `<dataDir>/plugins`, scans it, enables
 * it, then verifies it re-emits `plugin.echo.seen` on `/ws/events` when a
 * `mailbox.message` fires — and that disabling it removes the listener.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { eventBus } from '../../src/events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ECHO_SRC = path.resolve(HERE, '../../../../examples/plugins/echo');

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack({ skipMcp: true });
  // Drop the real example echo plugin into the scan dir.
  const dest = path.join(stack.pluginsDir, 'echo');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ECHO_SRC, 'plugin.json'), path.join(dest, 'plugin.json'));
  fs.copyFileSync(path.join(ECHO_SRC, 'index.js'), path.join(dest, 'index.js'));
});

afterEach(async () => {
  await stack.teardown();
});

function base(): string {
  return `http://127.0.0.1:${stack.mainPort}`;
}

async function getEventsTicket(): Promise<string> {
  const res = await fetch(`${base()}/ws-ticket?events=1`, {
    headers: authHeaders(stack.config.token),
  });
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

function openWs(): Promise<{ ws: WebSocket; seen: Array<{ kind: string }> }> {
  return getEventsTicket().then(
    (t) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${stack.mainPort}/ws/events?ticket=${t}`);
        const seen: Array<{ kind: string }> = [];
        ws.on('message', (raw) => {
          try {
            seen.push(JSON.parse(String(raw)) as { kind: string });
          } catch {
            /* ignore hello frame */
          }
        });
        ws.once('open', () => resolve({ ws, seen }));
        ws.once('error', reject);
      }),
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('J1 plugins REST + WS', () => {
  it('scan discovers the dropped echo plugin as disabled', async () => {
    const res = await fetch(`${base()}/plugins/scan`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<{ name: string; status: string; enabled: boolean }> };
    const echo = body.plugins.find((p) => p.name === 'echo');
    expect(echo).toBeTruthy();
    expect(echo?.status).toBe('disabled');
    expect(echo?.enabled).toBe(false);
  });

  it('requires auth', async () => {
    const res = await fetch(`${base()}/plugins`);
    expect(res.status).toBe(401);
  });

  it('scan → enable → plugin.echo.seen on /ws/events → disable → listener gone', async () => {
    // Scan + enable.
    await fetch(`${base()}/plugins/scan`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    const enableRes = await fetch(`${base()}/plugins/echo/enable`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({}),
    });
    expect(enableRes.status).toBe(200);
    const enableBody = (await enableRes.json()) as { plugin: { status: string; enabled: boolean } };
    expect(enableBody.plugin.status).toBe('enabled');
    expect(enableBody.plugin.enabled).toBe(true);

    // Subscribe AFTER enable so the plugin.host.changed of enable isn't required.
    const { ws, seen } = await openWs();

    // Trigger a mailbox.message; echo re-emits plugin.echo.seen.
    eventBus.emitEvent({
      kind: 'mailbox.message',
      orchestratorId: 'o1',
      sessionId: 's1',
      payload: { from: 's2', to: 's1' },
    });

    await wait(250);
    expect(seen.map((e) => e.kind)).toContain('plugin.echo.seen');

    // Disable — the listener must be removed.
    const disableRes = await fetch(`${base()}/plugins/echo/disable`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    expect(disableRes.status).toBe(200);

    const before = seen.filter((e) => e.kind === 'plugin.echo.seen').length;
    eventBus.emitEvent({
      kind: 'mailbox.message',
      orchestratorId: 'o1',
      sessionId: 's1',
      payload: { from: 's2', to: 's1' },
    });
    await wait(250);
    const after = seen.filter((e) => e.kind === 'plugin.echo.seen').length;
    expect(after).toBe(before); // no new echo after disable

    ws.close();
  });

  it('a slow event does not block emitEvent (async dispatch)', async () => {
    await fetch(`${base()}/plugins/scan`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    await fetch(`${base()}/plugins/echo/enable`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({}),
    });

    // emitEvent returns synchronously; the plugin handler runs on setImmediate.
    const t0 = Date.now();
    eventBus.emitEvent({
      kind: 'mailbox.message',
      orchestratorId: 'o1',
      sessionId: 's1',
      payload: { from: 's2', to: 's1' },
    });
    // The call above must not have awaited the handler.
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
