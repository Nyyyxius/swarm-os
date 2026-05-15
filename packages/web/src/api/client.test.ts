import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, getToken, setToken, HttpError } from './client';

/**
 * Phase 7 — REST client wrapper.
 *
 * The api client is a thin fetch wrapper that:
 *  - reads the token from localStorage
 *  - sends X-Auth-Token on authed routes
 *  - throws HttpError on non-2xx
 *  - skips auth for /health, /info
 */

let originalFetch: typeof globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  window.localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('token storage', () => {
  it('persists and reads back the token via localStorage', () => {
    setToken('secret-1');
    expect(getToken()).toBe('secret-1');
  });

  it('clears the token when set to empty', () => {
    setToken('secret-1');
    setToken('');
    expect(getToken()).toBe('');
  });
});

describe('request', () => {
  it('sends X-Auth-Token on authed routes', async () => {
    setToken('user-token');
    await api.listOrchestrators();
    const last = calls[calls.length - 1]!;
    const headers = (last.init?.headers as Record<string, string>) ?? {};
    expect(headers['X-Auth-Token']).toBe('user-token');
  });

  it('does NOT send X-Auth-Token on /health', async () => {
    setToken('user-token');
    await api.health();
    const last = calls[calls.length - 1]!;
    const headers = (last.init?.headers as Record<string, string>) ?? {};
    expect(headers['X-Auth-Token']).toBeUndefined();
  });

  it('throws HttpError with the response status when fetch returns 401', async () => {
    setToken('bad-token');
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;
    let err: unknown = null;
    try {
      await api.listOrchestrators();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it('handles 204 No Content (DELETE) without parsing a body', async () => {
    setToken('t');
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    await expect(api.destroyOrchestrator('orch-x')).resolves.toBeUndefined();
  });
});

describe('getWsTicket', () => {
  it('encodes the session id in the query string', async () => {
    setToken('t');
    await api.getWsTicket('sess id with spaces');
    const last = calls[calls.length - 1]!;
    expect(last.url).toContain('/ws-ticket?session=sess%20id%20with%20spaces');
  });
});

describe('getEventsTicket', () => {
  it('hits /ws-ticket?events=1', async () => {
    setToken('t');
    await api.getEventsTicket();
    const last = calls[calls.length - 1]!;
    expect(last.url).toContain('/ws-ticket?events=1');
  });
});
