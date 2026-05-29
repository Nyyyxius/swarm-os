/**
 * Per-instance visual settings — REST surface + persistence behaviour.
 *
 * Singleton row (id='current'). First GET returns hard-coded defaults from
 * `modules/settings`; first PATCH seeds the DB row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { DEFAULT_INSTANCE_SETTINGS } from '../../src/modules/settings/index.js';

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

async function getSettings(): Promise<{ status: number; body: any }> {
  const res = await fetch(url('/settings'), { headers: authHeaders(stack.config.token) });
  return { status: res.status, body: await res.json() };
}

async function patchSettings(body: unknown): Promise<{ status: number; body: any }> {
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
