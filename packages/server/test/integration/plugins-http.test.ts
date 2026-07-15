/**
 * J2 — dynamic plugin HTTP routes (two zones) end-to-end.
 *
 *  - AUTH zone `/plugin-api/echo/hello` — 200 with token, 404 after disable.
 *  - PUBLIC zone `/public/plugins/:name/*` — reachable WITHOUT a token.
 *  - `req.rawBody` — exact wire bytes are exposed to a public handler.
 *  - bootGate — plugin routes return 503 while auto-resume is in progress.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import type { BootGate } from '../../src/http/main.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ECHO_SRC = path.resolve(HERE, '../../../../examples/plugins/echo');

function dropEcho(stack: TestStack): void {
  const dest = path.join(stack.pluginsDir, 'echo');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ECHO_SRC, 'plugin.json'), path.join(dest, 'plugin.json'));
  fs.copyFileSync(path.join(ECHO_SRC, 'index.js'), path.join(dest, 'index.js'));
}

/** Fixture plugin that registers a PUBLIC router echoing back req.rawBody. */
function dropWebhooker(stack: TestStack): void {
  const dir = path.join(stack.pluginsDir, 'webhooker');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'webhooker',
      version: '0.1.0',
      main: 'index.js',
      apiVersion: 1,
      capabilities: ['http-public'],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    [
      'export default {',
      '  activate(api) {',
      '    const r = api.http.createRouter();',
      "    r.post('/hook', (req, res) => {",
      '      res.json({',
      '        hasRaw: Buffer.isBuffer(req.rawBody),',
      "        raw: req.rawBody ? req.rawBody.toString('utf8') : null,",
      '      });',
      '    });',
      '    api.http.registerPublicRouter(r);',
      '  },',
      '};',
    ].join('\n'),
  );
}

describe('J2 plugin HTTP zones', () => {
  let stack: TestStack;

  beforeEach(async () => {
    stack = await bootTestStack({ skipMcp: true });
    dropEcho(stack);
    dropWebhooker(stack);
  });

  afterEach(async () => {
    await stack.teardown();
  });

  function base(): string {
    return `http://127.0.0.1:${stack.mainPort}`;
  }

  async function scanEnable(name: string): Promise<void> {
    await fetch(`${base()}/plugins/scan`, { method: 'POST', headers: authHeaders(stack.config.token) });
    const res = await fetch(`${base()}/plugins/${name}/enable`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  }

  it('auth route: 200 with token, then 404 after disable', async () => {
    await scanEnable('echo');
    const ok = await fetch(`${base()}/plugin-api/echo/hello`, {
      headers: authHeaders(stack.config.token),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; plugin: string };
    expect(body).toMatchObject({ ok: true, plugin: 'echo' });

    // No token → 401 (auth gate sits in front of the auth zone).
    const noAuth = await fetch(`${base()}/plugin-api/echo/hello`);
    expect(noAuth.status).toBe(401);

    // Disable → the dispatcher's Map no longer has echo → 404.
    await fetch(`${base()}/plugins/echo/disable`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    const gone = await fetch(`${base()}/plugin-api/echo/hello`, {
      headers: authHeaders(stack.config.token),
    });
    expect(gone.status).toBe(404);
  });

  it('public route is reachable WITHOUT a token and exposes exact raw bytes', async () => {
    await scanEnable('webhooker');
    const payload = '{"event":"push","weird":"  spaced \\u00e9 "}';
    const res = await fetch(`${base()}/public/plugins/webhooker/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // NO X-Auth-Token
      body: payload,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { hasRaw: boolean; raw: string | null };
    expect(out.hasRaw).toBe(true);
    // Exact wire bytes — what an HMAC signature would be computed over.
    expect(out.raw).toBe(payload);
  });

  it('unknown public plugin → 404 (dispatcher Map miss)', async () => {
    const res = await fetch(`${base()}/public/plugins/nope/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('PLUGIN_NOT_FOUND');
  });
});

describe('J2 plugin HTTP bootGate', () => {
  let stack: TestStack;
  const bootGate: BootGate = { value: false };

  beforeEach(async () => {
    stack = await bootTestStack({ skipMcp: true, bootGate });
    dropEcho(stack);
    // Enable directly via the host (the REST enable route is itself behind the
    // bootGate while `value` is false).
    await stack.pluginHost.scan();
    await stack.pluginHost.enable('echo');
  });

  afterEach(async () => {
    bootGate.value = false;
    await stack.teardown();
  });

  it('plugin routes return 503 while booting, then 200 once open', async () => {
    const url = `http://127.0.0.1:${stack.mainPort}/plugin-api/echo/hello`;
    const during = await fetch(url, { headers: authHeaders(stack.config.token) });
    expect(during.status).toBe(503);

    bootGate.value = true;
    const after = await fetch(url, { headers: authHeaders(stack.config.token) });
    expect(after.status).toBe(200);
  });
});
