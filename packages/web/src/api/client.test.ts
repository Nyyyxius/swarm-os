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

describe('shared memory endpoints', () => {
  it('lists notes under /api/memory (authed)', async () => {
    setToken('mem-token');
    await api.listMemory();
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/memory');
    const headers = (last.init?.headers as Record<string, string>) ?? {};
    expect(headers['X-Auth-Token']).toBe('mem-token');
  });

  it('fetches the graph under /api/memory/graph', async () => {
    setToken('t');
    await api.getMemoryGraph();
    expect(calls[calls.length - 1]!.url).toBe('/api/memory/graph');
  });

  it('builds the search query string with q, type and limit', async () => {
    setToken('t');
    await api.searchMemory('hello world', { type: 'project', limit: 10 });
    const url = calls[calls.length - 1]!.url;
    expect(url).toContain('/api/memory/search?');
    expect(url).toContain('q=hello+world');
    expect(url).toContain('type=project');
    expect(url).toContain('limit=10');
  });

  it('encodes the note name in the path on GET', async () => {
    setToken('t');
    await api.getMemoryNote('a b/c');
    expect(calls[calls.length - 1]!.url).toBe('/api/memory/a%20b%2Fc');
  });

  it('PUTs a note body with expectedVersion', async () => {
    setToken('t');
    await api.putMemoryNote('my-note', {
      description: 'd',
      type: 'reference',
      body: 'hi',
      expectedVersion: 3,
    });
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/memory/my-note');
    expect(last.init?.method).toBe('PUT');
    expect(JSON.parse(String(last.init?.body))).toEqual({
      description: 'd',
      type: 'reference',
      body: 'hi',
      expectedVersion: 3,
    });
  });

  it('DELETEs a note by name', async () => {
    setToken('t');
    await api.deleteMemoryNote('gone');
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/memory/gone');
    expect(last.init?.method).toBe('DELETE');
  });
});

describe('approval-gate endpoints (P3)', () => {
  it('lists approvals with a required orch and no status', async () => {
    setToken('appr-token');
    await api.listApprovals('orch-9');
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/approvals?orch=orch-9');
    const headers = (last.init?.headers as Record<string, string>) ?? {};
    expect(headers['X-Auth-Token']).toBe('appr-token');
  });

  it('adds the status filter to the query string when provided', async () => {
    setToken('t');
    await api.listApprovals('orch-9', 'pending');
    const url = calls[calls.length - 1]!.url;
    expect(url).toContain('orch=orch-9');
    expect(url).toContain('status=pending');
  });

  it('encodes the approval id on GET', async () => {
    setToken('t');
    await api.getApproval('a b/c');
    expect(calls[calls.length - 1]!.url).toBe('/api/approvals/a%20b%2Fc');
  });

  it('POSTs the resolve body to /:id/resolve', async () => {
    setToken('t');
    await api.resolveApproval('appr-1', { decision: 'approve', dontAskAgain: true });
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/approvals/appr-1/resolve');
    expect(last.init?.method).toBe('POST');
    expect(JSON.parse(String(last.init?.body))).toEqual({
      decision: 'approve',
      dontAskAgain: true,
    });
  });

  it('POSTs a deny decision', async () => {
    setToken('t');
    await api.resolveApproval('appr-2', { decision: 'deny' });
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/approvals/appr-2/resolve');
    expect(JSON.parse(String(last.init?.body))).toEqual({ decision: 'deny' });
  });
});

describe('codegraph endpoints (P4)', () => {
  it('lists scopes under /api/codegraph (authed)', async () => {
    setToken('cg-token');
    await api.listCodegraphScopes();
    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/api/codegraph');
    const headers = (last.init?.headers as Record<string, string>) ?? {};
    expect(headers['X-Auth-Token']).toBe('cg-token');
  });

  it('fetches the graph under /api/codegraph/:scopeId/graph', async () => {
    setToken('t');
    await api.getCodegraphGraph('scope-1');
    expect(calls[calls.length - 1]!.url).toBe('/api/codegraph/scope-1/graph');
  });

  it('encodes the scope id in the graph path', async () => {
    setToken('t');
    await api.getCodegraphGraph('scope/with spaces');
    expect(calls[calls.length - 1]!.url).toBe('/api/codegraph/scope%2Fwith%20spaces/graph');
  });

  it('builds the search query string with q and limit', async () => {
    setToken('t');
    await api.searchCodegraph('scope-1', 'greet', 10);
    const url = calls[calls.length - 1]!.url;
    expect(url).toContain('/api/codegraph/scope-1/search?');
    expect(url).toContain('q=greet');
    expect(url).toContain('limit=10');
  });

  it('omits limit from the query string when not provided', async () => {
    setToken('t');
    await api.searchCodegraph('scope-1', 'greet');
    const url = calls[calls.length - 1]!.url;
    expect(url).toContain('q=greet');
    expect(url).not.toContain('limit=');
  });
});

describe('Lot 5b — export / pack API functions', () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let originalCreateElement: typeof document.createElement;
  let clickedAnchors: { href: string; download: string }[];

  beforeEach(() => {
    clickedAnchors = [];
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    originalCreateElement = document.createElement.bind(document);
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        const anchor = el as HTMLAnchorElement;
        anchor.click = () => {
          clickedAnchors.push({ href: anchor.href, download: anchor.download });
        };
      }
      return el;
    });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it('exportSkill sends GET with auth and triggers a download', async () => {
    setToken('sk-token');
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': 'attachment; filename="my-skill.tgz"',
        },
      });
    }) as typeof fetch;

    await api.exportSkill('my-skill');

    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/skills/my-skill/export');
    expect((last.init?.headers as Record<string, string>)['X-Auth-Token']).toBe('sk-token');
    expect(clickedAnchors.length).toBe(1);
    expect(clickedAnchors[0]!.download).toBe('my-skill.tgz');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('exportSkill falls back to <name>.tgz when no Content-Disposition header', async () => {
    setToken('t');
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    }) as typeof fetch;

    await api.exportSkill('some-skill');
    expect(clickedAnchors[0]!.download).toBe('some-skill.tgz');
  });

  it('exportSkill throws HttpError on non-2xx', async () => {
    setToken('t');
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    let err: unknown;
    try { await api.exportSkill('nope'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });

  it('exportPack sends POST with auth and triggers a download', async () => {
    setToken('pk-token');
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': 'attachment; filename="skills-pack-2.tgz"',
        },
      });
    }) as typeof fetch;

    await api.exportPack(['pdf', 'docx']);

    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/skills/pack/export');
    expect(last.init?.method).toBe('POST');
    expect((last.init?.headers as Record<string, string>)['X-Auth-Token']).toBe('pk-token');
    const body = JSON.parse(last.init?.body as string) as { names: string[] };
    expect(body.names).toEqual(['pdf', 'docx']);
    expect(clickedAnchors[0]!.download).toBe('skills-pack-2.tgz');
  });

  it('exportPack falls back to skills-pack-<N>.tgz when no Content-Disposition', async () => {
    setToken('t');
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    }) as typeof fetch;

    await api.exportPack(['a', 'b', 'c']);
    expect(clickedAnchors[0]!.download).toBe('skills-pack-3.tgz');
  });

  it('installPack sends POST application/gzip with auth and returns PackInstallResponse', async () => {
    setToken('pack-token');
    const response: unknown = {
      installed: [{ name: 'pdf', version: '1.0.0' }],
      errors: [],
    };
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/gzip' });
    const result = await api.installPack(file);

    const last = calls[calls.length - 1]!;
    expect(last.url).toBe('/skills/pack/install');
    expect(last.init?.method).toBe('POST');
    const headers = last.init?.headers as Record<string, string>;
    expect(headers['X-Auth-Token']).toBe('pack-token');
    expect(headers['Content-Type']).toBe('application/gzip');
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]!.name).toBe('pdf');
    expect(result.errors).toHaveLength(0);
  });

  it('installPack throws HttpError on 422', async () => {
    setToken('t');
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"corrupted archive"}', {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    const file = new Blob([new Uint8Array([0])], { type: 'application/gzip' });
    let err: unknown;
    try { await api.installPack(file); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
  });
});
