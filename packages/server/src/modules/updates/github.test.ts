import { describe, it, expect, vi } from 'vitest';
import {
  GithubReleasesClient,
  githubTokenFromEnv,
  pickHighestRelease,
  rateLimitResetAt,
} from './github.js';

/**
 * Every branch is exercised with a mocked `fetchImpl` — the point of this
 * client is that a private repo, a dead network, a spent rate limit and a
 * refused token are all ordinary values, so each of those has to be pinned as
 * a value.
 */

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

function sentHeaders(fetchImpl: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchImpl.mock.calls[0][1] as RequestInit;
  return init.headers as Record<string, string>;
}

function client(fetchImpl: typeof fetch, token: string | null = 'pat_x') {
  return new GithubReleasesClient({ token, fetchImpl, timeoutMs: 50 });
}

function rel(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.0.0',
    draft: false,
    html_url: 'https://github.com/Nyyyxius/swarm-os/releases/tag/v1.0.0',
    body: 'notes',
    published_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('githubTokenFromEnv', () => {
  it('reads SWARM_OS_GITHUB_TOKEN and treats blank as absent', () => {
    expect(githubTokenFromEnv({ SWARM_OS_GITHUB_TOKEN: 'ghp_abc' })).toBe('ghp_abc');
    expect(githubTokenFromEnv({ SWARM_OS_GITHUB_TOKEN: '   ' })).toBeNull();
    expect(githubTokenFromEnv({})).toBeNull();
  });
});

describe('GithubReleasesClient.latestRelease', () => {
  it('no token → an unauthenticated call that still finds the release', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, [rel({ tag_name: 'v0.6.0' })]));
    const r = await client(fetchImpl as unknown as typeof fetch, null).latestRelease();
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.release.tag).toBe('v0.6.0');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/Nyyyxius/swarm-os/releases?per_page=100',
    );
    const headers = sentHeaders(fetchImpl);
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('swarm-os');
  });

  it('200 → the highest non-draft release, with a Bearer header', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, [rel({ tag_name: 'v0.5.0' }), rel({ tag_name: 'v0.6.0' })]));
    const r = await client(fetchImpl as unknown as typeof fetch).latestRelease();
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.release.tag).toBe('v0.6.0');
    expect(r.release.version).toBe('0.6.0');
    expect(r.release.notesBody).toBe('notes');
    expect(r.release.publishedAt).toBe('2026-01-01T00:00:00Z');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pat_x');
  });

  it('401 → unauthorized (bad or expired PAT)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(401, {}));
    expect(await client(fetchImpl as unknown as typeof fetch).latestRelease()).toEqual({
      status: 'unauthorized',
    });
  });

  it('403 that is not a rate limit → unauthorized too: same operator action', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4999' }),
    );
    expect(await client(fetchImpl as unknown as typeof fetch).latestRelease()).toEqual({
      status: 'unauthorized',
    });
  });

  it('401/403 without a token is not blamed on a token that does not exist', async () => {
    for (const code of [401, 403]) {
      const fetchImpl = vi.fn(async () => jsonRes(code, {}));
      expect(await client(fetchImpl as unknown as typeof fetch, null).latestRelease()).toEqual({
        status: 'error',
        message: `HTTP ${code}`,
      });
    }
  });

  it('403 with an exhausted anonymous budget → rate_limited, with the reset time and the way out', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes(
        403,
        { message: 'API rate limit exceeded for 203.0.113.7.' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767225600' },
      ),
    );
    const r = await client(fetchImpl as unknown as typeof fetch, null).latestRelease();
    expect(r.status).toBe('rate_limited');
    if (r.status !== 'rate_limited') return;
    expect(r.authenticated).toBe(false);
    expect(r.resetAt).toBe('2026-01-01T00:00:00.000Z');
    expect(r.message).toContain('unauthenticated');
    expect(r.message).toContain('2026-01-01T00:00:00.000Z');
    expect(r.message).toContain('SWARM_OS_GITHUB_TOKEN');
  });

  it('a spent TOKEN budget is rate_limited too, not unauthorized', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(403, {}, { 'x-ratelimit-remaining': '0' }));
    const r = await client(fetchImpl as unknown as typeof fetch).latestRelease();
    expect(r.status).toBe('rate_limited');
    if (r.status !== 'rate_limited') return;
    expect(r.authenticated).toBe(true);
    expect(r.resetAt).toBeNull();
  });

  it('429 → rate_limited', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(429, {}, { 'retry-after': '60' }));
    const r = await client(fetchImpl as unknown as typeof fetch, null).latestRelease();
    expect(r.status).toBe('rate_limited');
  });

  it('a 403 whose only clue is the message (secondary limit) → rate_limited', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }),
    );
    const r = await client(fetchImpl as unknown as typeof fetch, null).latestRelease();
    expect(r.status).toBe('rate_limited');
  });

  it('404 → not_found: the repo is private (or renamed) and this call cannot see it', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(404, {}));
    expect(await client(fetchImpl as unknown as typeof fetch).latestRelease()).toEqual({
      status: 'not_found',
    });
  });

  it('network down → error, never a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await client(fetchImpl as unknown as typeof fetch).latestRelease();
    expect(r).toEqual({ status: 'error', message: 'ECONNREFUSED' });
  });

  it('zero releases → no_releases, not an error', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, []));
    expect(await client(fetchImpl as unknown as typeof fetch).latestRelease()).toEqual({
      status: 'no_releases',
    });
  });

  it('only drafts → no_releases', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, [rel({ draft: true })]));
    expect(await client(fetchImpl as unknown as typeof fetch).latestRelease()).toEqual({
      status: 'no_releases',
    });
  });

  it('a 500 or a non-array body is an error, not a silent null', async () => {
    expect(await client((vi.fn(async () => jsonRes(500, {})) as unknown) as typeof fetch).latestRelease()).toEqual({
      status: 'error',
      message: 'HTTP 500',
    });
    const r = await client((vi.fn(async () => jsonRes(200, { message: 'nope' })) as unknown) as typeof fetch).latestRelease();
    expect(r.status).toBe('error');
  });
});

describe('rateLimitResetAt', () => {
  const res = (headers: Record<string, string>) => ({ headers: new Headers(headers) }) as unknown as Response;

  it('prefers retry-after (seconds from now) over x-ratelimit-reset', () => {
    expect(rateLimitResetAt(res({ 'retry-after': '60', 'x-ratelimit-reset': '1' }), 0)).toBe(
      '1970-01-01T00:01:00.000Z',
    );
  });

  it('reads x-ratelimit-reset as epoch seconds', () => {
    expect(rateLimitResetAt(res({ 'x-ratelimit-reset': '1767225600' }))).toBe('2026-01-01T00:00:00.000Z');
  });

  it('null when GitHub said nothing usable, or there are no headers at all', () => {
    expect(rateLimitResetAt(res({}))).toBeNull();
    expect(rateLimitResetAt(res({ 'retry-after': 'soon', 'x-ratelimit-reset': 'x' }))).toBeNull();
    expect(rateLimitResetAt({} as Response)).toBeNull();
  });
});

describe('pickHighestRelease', () => {
  it('ignores drafts even when they carry the highest tag', () => {
    const best = pickHighestRelease([
      rel({ tag_name: 'v0.5.0' }),
      rel({ tag_name: 'v9.9.9', draft: true }),
    ]);
    expect(best?.tag).toBe('v0.5.0');
  });

  it('takes the max, NOT index 0 (the API sorts by creation date)', () => {
    const best = pickHighestRelease([
      rel({ tag_name: 'v0.4.1' }), // newest by date: a backport
      rel({ tag_name: 'v0.6.0' }),
      rel({ tag_name: 'v0.5.0' }),
    ]);
    expect(best?.tag).toBe('v0.6.0');
  });

  it('skips tags the comparator cannot read', () => {
    expect(pickHighestRelease([rel({ tag_name: 'nightly' })])).toBeNull();
    expect(pickHighestRelease([rel({ tag_name: 'nightly' }), rel({ tag_name: 'v1.0.0' })])?.tag).toBe('v1.0.0');
  });

  it('does not let a pre-release outrank its own release', () => {
    const best = pickHighestRelease([rel({ tag_name: 'v1.0.0' }), rel({ tag_name: 'v1.0.0-rc1' })]);
    expect(best?.tag).toBe('v1.0.0');
  });

  it('tolerates missing optional fields', () => {
    const best = pickHighestRelease([{ tag_name: 'v1.0.0', draft: false }]);
    expect(best).toEqual({
      tag: 'v1.0.0',
      version: '1.0.0',
      notesUrl: null,
      notesBody: null,
      publishedAt: null,
    });
  });
});
