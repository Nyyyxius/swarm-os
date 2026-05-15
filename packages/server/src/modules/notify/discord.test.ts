import { describe, it, expect, vi } from 'vitest';
import { DiscordWebhookNotifier } from './discord.js';
import type { NotificationInput } from './index.js';

/**
 * Phase 7 — Discord webhook payload + reliability.
 *
 * `buildPayload` is exposed publicly (plan §12) precisely so we can test the
 * embed shape without going through the network. `notify()` is exercised
 * with a mocked `fetchImpl` so we can verify it never throws on failure.
 */

const ORCH = {
  id: 'orch-1',
  name: 'merge-team',
  role: 'coordinator',
  status: 'running' as const,
};
const SESSION = {
  id: 'sess-1',
  name: 'scout',
  role: 'recon',
  type: 'worker' as const,
  status: 'waiting' as const,
  exitCode: null,
  stopReason: null,
};

function makeInput(over: Partial<NotificationInput> = {}): NotificationInput {
  return {
    kind: 'session.waiting',
    orchestrator: ORCH,
    session: SESSION,
    message: 'session needs attention',
    ...over,
  };
}

describe('DiscordWebhookNotifier.buildPayload', () => {
  const notifier = new DiscordWebhookNotifier({
    webhookUrl: 'https://discord.example/webhooks/abcdef/secret-token',
    projectName: 'fyrel',
  });

  it('uses yellow for waiting', () => {
    const payload = notifier.buildPayload(makeInput({ kind: 'session.waiting' }));
    expect(payload.embeds[0]?.color).toBe(0xffff00);
  });

  it('uses red for session.exit_anomaly', () => {
    const payload = notifier.buildPayload(makeInput({ kind: 'session.exit_anomaly' }));
    expect(payload.embeds[0]?.color).toBe(0xff0000);
  });

  it('uses green for orchestrator.ended when status=stopped', () => {
    const payload = notifier.buildPayload(
      makeInput({
        kind: 'orchestrator.ended',
        orchestrator: { ...ORCH, status: 'stopped' },
      }),
    );
    expect(payload.embeds[0]?.color).toBe(0x00cc66);
  });

  it('uses soft red for orchestrator.ended when status=failed', () => {
    const payload = notifier.buildPayload(
      makeInput({
        kind: 'orchestrator.ended',
        orchestrator: { ...ORCH, status: 'failed' },
      }),
    );
    expect(payload.embeds[0]?.color).toBe(0xff6666);
  });

  it('omits url when publicUrl is unset', () => {
    const payload = notifier.buildPayload(makeInput());
    expect(payload.embeds[0]?.url).toBeUndefined();
  });

  it('embeds a deep-link url when publicUrl is set', () => {
    const n = new DiscordWebhookNotifier({
      webhookUrl: 'https://discord.example/webhooks/x/y',
      projectName: 'fyrel',
      publicUrl: 'https://swarm.tail-xyz.ts.net:8787',
    });
    const payload = n.buildPayload(makeInput());
    expect(payload.embeds[0]?.url).toBe(
      'https://swarm.tail-xyz.ts.net:8787/#/orchestrators/orch-1',
    );
  });

  it('NEVER includes the auth token in the embed url', () => {
    const n = new DiscordWebhookNotifier({
      webhookUrl: 'https://discord.example/webhooks/x/y',
      projectName: 'fyrel',
      publicUrl: 'https://swarm.tail-xyz.ts.net:8787',
    });
    const payload = n.buildPayload(makeInput());
    const url = payload.embeds[0]?.url ?? '';
    // Heuristics: no `token=`, no `?auth=`, no `Bearer`, etc.
    expect(url).not.toMatch(/token/i);
    expect(url).not.toMatch(/auth/i);
    expect(url).not.toMatch(/secret/i);
    expect(url).not.toMatch(/bearer/i);
  });

  it('populates description, fields and timestamp', () => {
    const payload = notifier.buildPayload(makeInput({ message: 'hello' }));
    const e = payload.embeds[0]!;
    expect(e.description).toBe('hello');
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const names = (e.fields ?? []).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Project', 'Orchestrator', 'Session', 'Status']));
  });

  it('truncates a giant description to <= 4000 chars', () => {
    const payload = notifier.buildPayload(makeInput({ message: 'x'.repeat(5000) }));
    expect(payload.embeds[0]?.description?.length).toBeLessThanOrEqual(4000);
  });
});

describe('DiscordWebhookNotifier.notify', () => {
  it('does not throw when fetch rejects', async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const n = new DiscordWebhookNotifier({
      webhookUrl: 'https://discord.example/webhooks/x/y',
      projectName: 'fyrel',
      fetchImpl: failingFetch as unknown as typeof fetch,
      timeoutMs: 100,
    });
    await expect(n.notify(makeInput())).resolves.toBeUndefined();
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it('does not throw when fetch returns a non-2xx status', async () => {
    const failingFetch = vi.fn().mockResolvedValue(
      new Response('{"error":"rate limited"}', { status: 429 }),
    );
    const n = new DiscordWebhookNotifier({
      webhookUrl: 'https://discord.example/webhooks/x/y',
      projectName: 'fyrel',
      fetchImpl: failingFetch as unknown as typeof fetch,
    });
    await expect(n.notify(makeInput())).resolves.toBeUndefined();
  });

  it('POSTs JSON with the embed payload', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const okFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    const n = new DiscordWebhookNotifier({
      webhookUrl: 'https://discord.example/webhooks/x/y',
      projectName: 'fyrel',
      fetchImpl: okFetch as unknown as typeof fetch,
    });
    await n.notify(makeInput());
    expect(seen.length).toBe(1);
    expect(seen[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(seen[0]?.init.body));
    expect(body).toHaveProperty('embeds');
    expect(Array.isArray(body.embeds)).toBe(true);
  });
});
