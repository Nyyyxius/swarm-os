import { describe, it, expect, vi } from 'vitest';
import { GithubReleasesClient, githubTokenFromEnv, pickHighestRelease } from './github.js';

/**
 * Every branch is exercised with a mocked `fetchImpl` — the point of this
 * client is that a private repo, a dead network and a missing PAT are all
 * ordinary values, so each of those has to be pinned as a value.
 */

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function client(fetchImpl: typeof fetch, token: string | null = 'pat_x') {
  return new GithubReleasesClient({ token, fetchImpl, timeoutMs: 50 });
}

function rel(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.0.0',
    draft: false,
    html_url: 'https://github.com/luminis1986/swarm-os/releases/tag/v1.0.0',
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
  it('no PAT → no_token, without touching the network', async () => {
    const fetchImpl = vi.fn();
    const r = await client(fetchImpl as unknown as typeof fetch, null).latestRelease();
    expect(r).toEqual({ status: 'no_token' });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('403 → unauthorized too: same operator action', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(403, {}));
    expect(await client(fetchImpl as unknown as typeof fetch).latestRelease()).toEqual({
      status: 'unauthorized',
    });
  });

  it('404 → not_found: the repo is private and this PAT cannot see it', async () => {
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
