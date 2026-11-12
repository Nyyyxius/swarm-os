/**
 * Per-instance visual settings — REST surface + persistence behaviour.
 *
 * Singleton row (id='current'). First GET returns hard-coded defaults from
 * `modules/settings`; first PATCH seeds the DB row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import {
  DEFAULT_INSTANCE_SETTINGS,
  PASSWORD_SENTINEL,
} from '../../src/modules/settings/index.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

function url(path: string): string {
  return `http://127.0.0.1:${stack.mainPort}${path}`;
}

// The parsed JSON is indexed freely by the assertions; typing it would mean
// restating the settings DTO in the test file (same pattern as crons.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

async function getSettings(): Promise<{ status: number; body: JsonBody }> {
  const res = await fetch(url('/settings'), { headers: authHeaders(stack.config.token) });
  return { status: res.status, body: await res.json() };
}

async function patchSettings(body: unknown): Promise<{ status: number; body: JsonBody }> {
  const res = await fetch(url('/settings'), {
    method: 'PATCH',
    headers: authHeaders(stack.config.token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('REST: /settings', () => {
  it('rejects unauthenticated GET', async () => {
    const res = await fetch(url('/settings'));
    expect(res.status).toBe(401);
  });

  it('returns hard-coded defaults when DB row is absent', async () => {
    const r = await getSettings();
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({
      instanceLabel: DEFAULT_INSTANCE_SETTINGS.instanceLabel,
      accent: DEFAULT_INSTANCE_SETTINGS.accent,
      bgTint: DEFAULT_INSTANCE_SETTINGS.bgTint,
      fontSize: DEFAULT_INSTANCE_SETTINGS.fontSize,
      density: DEFAULT_INSTANCE_SETTINGS.density,
      darkMode: DEFAULT_INSTANCE_SETTINGS.darkMode,
    });
  });

  it('persists a PATCH and surfaces it on the next GET', async () => {
    const patched = await patchSettings({ accent: '#8ab6e0', instanceLabel: 'DEV' });
    expect(patched.status).toBe(200);
    expect(patched.body.settings.accent).toBe('#8ab6e0');
    expect(patched.body.settings.instanceLabel).toBe('DEV');

    const next = await getSettings();
    expect(next.body.settings.accent).toBe('#8ab6e0');
    expect(next.body.settings.instanceLabel).toBe('DEV');
  });

  it('keeps untouched fields stable across partial PATCHes', async () => {
    await patchSettings({ accent: '#6ec48a', fontSize: 14 });
    const r = await patchSettings({ density: 'compact' });
    expect(r.body.settings.density).toBe('compact');
    expect(r.body.settings.accent).toBe('#6ec48a');
    expect(r.body.settings.fontSize).toBe(14);
  });

  it('normalises accent to lowercase', async () => {
    const r = await patchSettings({ accent: '#FFB060' });
    expect(r.body.settings.accent).toBe('#ffb060');
  });

  it('treats empty-string and null instanceLabel as cleared', async () => {
    await patchSettings({ instanceLabel: 'PROD' });
    const blank = await patchSettings({ instanceLabel: '' });
    expect(blank.body.settings.instanceLabel).toBeNull();
    await patchSettings({ instanceLabel: 'PROD' });
    const nulled = await patchSettings({ instanceLabel: null });
    expect(nulled.body.settings.instanceLabel).toBeNull();
  });

  it('rejects an accent that is not #rrggbb', async () => {
    for (const bad of ['amber', '#abc', '#zzzzzz', 'ffb060', '#ffb06']) {
      const r = await patchSettings({ accent: bad });
      expect(r.status, `rejected ${bad}`).toBe(400);
    }
  });

  it('rejects an invalid bgTint', async () => {
    const r = await patchSettings({ bgTint: 'pink' });
    expect(r.status).toBe(400);
  });

  it('rejects an out-of-range fontSize', async () => {
    expect((await patchSettings({ fontSize: 8 })).status).toBe(400);
    expect((await patchSettings({ fontSize: 99 })).status).toBe(400);
    expect((await patchSettings({ fontSize: 12.5 })).status).toBe(400);
  });

  it('rejects an invalid density', async () => {
    const r = await patchSettings({ density: 'gigantic' });
    expect(r.status).toBe(400);
  });

  it('rejects an instanceLabel longer than 16 chars', async () => {
    const r = await patchSettings({ instanceLabel: 'A'.repeat(17) });
    expect(r.status).toBe(400);
  });

  it('reset returns defaults but stamps a fresh updatedAt', async () => {
    await patchSettings({ accent: '#c79afa', instanceLabel: 'LAB' });
    const res = await fetch(url('/settings/reset'), {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { accent: string; instanceLabel: string | null; updatedAt: string } };
    expect(body.settings.accent).toBe(DEFAULT_INSTANCE_SETTINGS.accent);
    expect(body.settings.instanceLabel).toBeNull();
    expect(body.settings.updatedAt).not.toBe(DEFAULT_INSTANCE_SETTINGS.updatedAt);
  });
});

/**
 * The OpenRouter API key over REST (multi-provider Lot 6b).
 *
 * THE TEST THAT MATTERS is "never comes back in clear": the web client mirrors
 * `GET /settings` into localStorage, so a plaintext key on that route would end
 * up persisted in every operator's browser with no symptom whatsoever. The
 * assertions below therefore search the RAW RESPONSE TEXT of every route that
 * could plausibly serialise the settings row, not just the field we expect.
 */
const OR_KEY = 'sk-or-v1-integration-0123456789abcdef';

describe('REST: /settings — the OpenRouter key', () => {
  async function raw(path: string): Promise<string> {
    const res = await fetch(url(path), { headers: authHeaders(stack.config.token) });
    return res.text();
  }

  it('accepts a key, answers with the sentinel, and stores the real one', async () => {
    const r = await patchSettings({ openrouterApiKey: OR_KEY });
    expect(r.status).toBe(200);
    // Masked in the response body…
    expect(r.body.settings.openrouterApiKey).toBe(PASSWORD_SENTINEL);
    // …and really stored server-side (the store is the only reader of the clear
    // value, exactly as the opencode adapter reads it).
    expect(stack.settingsStore.getOpenRouterApiKey()).toBe(OR_KEY);
  });

  it('NEVER returns the key in clear — on any route that serialises settings', async () => {
    await patchSettings({ openrouterApiKey: OR_KEY });

    const bodies: Array<[string, string]> = [
      ['/settings', await raw('/settings')],
      ['/info', await raw('/info')],
      ['/health', await raw('/health')],
      ['/orchestrators', await raw('/orchestrators')],
      ['/providers', await raw('/providers')],
      ['/plugins', await raw('/plugins')],
    ];
    for (const [route, text] of bodies) {
      expect(text, `${route} must not contain the key`).not.toContain(OR_KEY);
      // Not even a prefix: a truncated credential in a log is still a
      // credential leak, and a "first 8 chars" display would pass the test above.
      expect(text, `${route} must not contain a key prefix`).not.toContain('sk-or-v1-');
    }
    // The GET is masked, not empty — the drawer has to be able to render
    // "configured" without ever receiving the secret.
    expect(JSON.parse(bodies[0][1]).settings.openrouterApiKey).toBe(PASSWORD_SENTINEL);
  });

  it('keeps the stored key when the sentinel is echoed back', async () => {
    await patchSettings({ openrouterApiKey: OR_KEY });
    // Exactly what the form sends when the operator changes the accent and the
    // masked field rides along untouched.
    const r = await patchSettings({ openrouterApiKey: PASSWORD_SENTINEL, accent: '#8ab6e0' });
    expect(r.body.settings.accent).toBe('#8ab6e0');
    expect(r.body.settings.openrouterApiKey).toBe(PASSWORD_SENTINEL);
    expect(stack.settingsStore.getOpenRouterApiKey()).toBe(OR_KEY);
  });

  it('survives an appearance PATCH that does not mention it', async () => {
    await patchSettings({ openrouterApiKey: OR_KEY });
    await patchSettings({ density: 'compact' });
    expect(stack.settingsStore.getOpenRouterApiKey()).toBe(OR_KEY);
  });

  it('deletes on explicit null and on an emptied field', async () => {
    await patchSettings({ openrouterApiKey: OR_KEY });
    const nulled = await patchSettings({ openrouterApiKey: null });
    expect(nulled.body.settings.openrouterApiKey).toBeNull();
    expect(stack.settingsStore.getOpenRouterApiKey()).toBeNull();

    await patchSettings({ openrouterApiKey: OR_KEY });
    const blank = await patchSettings({ openrouterApiKey: '   ' });
    expect(blank.body.settings.openrouterApiKey).toBeNull();
    expect(stack.settingsStore.getOpenRouterApiKey()).toBeNull();
  });

  it('is preserved by /settings/reset — a theme reset must not revoke it', async () => {
    await patchSettings({ openrouterApiKey: OR_KEY, accent: '#c79afa' });
    const res = await fetch(url('/settings/reset'), {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    const body = (await res.json()) as { settings: { openrouterApiKey: string | null } };
    expect(body.settings.openrouterApiKey).toBe(PASSWORD_SENTINEL);
    expect(stack.settingsStore.getOpenRouterApiKey()).toBe(OR_KEY);
  });

  it('rejects a non-string, an over-long value, and a whitespace-bearing paste', async () => {
    expect((await patchSettings({ openrouterApiKey: 42 })).status).toBe(400);
    expect((await patchSettings({ openrouterApiKey: 'a'.repeat(513) })).status).toBe(400);
    // A key with an embedded space or newline is a truncated copy. It would also
    // land in the 0600 env file the agent's shell sources.
    expect((await patchSettings({ openrouterApiKey: 'sk-or v1-abc' })).status).toBe(400);
    expect((await patchSettings({ openrouterApiKey: 'sk-or\nv1-abc' })).status).toBe(400);
    // …and nothing was stored by any of the rejected attempts.
    expect(stack.settingsStore.getOpenRouterApiKey()).toBeNull();
  });

  it('never echoes a rejected value back in the error message', async () => {
    const r = await patchSettings({ openrouterApiKey: `${OR_KEY} trailing garbage` });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(OR_KEY);
  });
});
