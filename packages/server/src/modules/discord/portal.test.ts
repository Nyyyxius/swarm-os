import { describe, it, expect, vi } from 'vitest';
import { validateBotToken, createChannelWebhook } from './portal.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('validateBotToken', () => {
  it('returns the bot identity on 200', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: '111', username: 'marketing-bot', avatar: 'abc', discriminator: '0001' }),
    );
    const res = await validateBotToken('fake-token', { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bot.id).toBe('111');
      expect(res.bot.username).toBe('marketing-bot');
      expect(res.bot.avatar).toBe('abc');
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/users/@me');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bot fake-token');
  });

  it('returns ok:false with status on 401', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: '401: Unauthorized' }, { status: 401 }),
    );
    const res = await validateBotToken('bad', { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain('Unauthorized');
    }
  });

  it('returns ok:false on network failure (never throws)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('boom');
    });
    const res = await validateBotToken('whatever', { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.error).toBe('boom');
    }
  });
});

describe('createChannelWebhook', () => {
  it('posts to the channel webhooks endpoint and returns the assembled URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 'wh-1', token: 'wh-tok' }),
    );
    const res = await createChannelWebhook(
      { token: 'tk', channelId: '12345678901234567', name: 'custom' },
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.id).toBe('wh-1');
      expect(res.webhookUrl).toBe('https://discord.com/api/webhooks/wh-1/wh-tok');
    }
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/channels/12345678901234567/webhooks');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'custom' });
  });

  it('defaults the webhook name when omitted', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: 'a', token: 'b' }),
    );
    await createChannelWebhook({ token: 't', channelId: '12345678901234567' }, { fetchImpl });
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      name: 'swarm-os notifications',
    });
  });

  it('surfaces 403 from Discord (missing permission)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: 'Missing Permissions' }, { status: 403 }),
    );
    const res = await createChannelWebhook(
      { token: 't', channelId: '12345678901234567' },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.error).toContain('Missing Permissions');
    }
  });
});
