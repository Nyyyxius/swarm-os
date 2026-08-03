import { describe, it, expect } from 'vitest';
import {
  resolveMarket,
  searchMarket,
  parseGitHubCoordinate,
  marketPolicyFromEnv,
  type MarketPolicy,
  type FetchLike,
} from './market.js';
import { SkillValidationError, SkillStageError } from './stage.js';

/** A policy with the built-in catalog convention but NO endpoint. */
function conventionPolicy(over: Partial<MarketPolicy> = {}): MarketPolicy {
  return { catalog: ['anthropics/skills'], catalogPrefix: 'skills', timeoutMs: 1000, ...over };
}

type FetchInit = { signal?: AbortSignal; headers?: Record<string, string> } | undefined;

/** A fake `fetch` returning `body` as JSON with the given status. Records calls. */
function fakeFetch(
  status: number,
  body: unknown,
): { fetchImpl: FetchLike; calls: string[]; inits: FetchInit[] } {
  const calls: string[] = [];
  const inits: FetchInit[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push(url);
    inits.push(init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  };
  return { fetchImpl, calls, inits };
}

/** A GitHub contents API payload: three skill dirs plus a non-dir entry. */
const GITHUB_CONTENTS = [
  { name: 'pdf', path: 'skills/pdf', type: 'dir' },
  { name: 'docx', path: 'skills/docx', type: 'dir' },
  { name: 'pptx', path: 'skills/pptx', type: 'dir' },
  { name: 'README.md', path: 'skills/README.md', type: 'file' },
];

/** A fake `fetch` that always rejects (endpoint unreachable). */
const throwingFetch: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

describe('marketPolicyFromEnv', () => {
  it('defaults to the anthropics/skills catalog at prefix "skills", no endpoint', () => {
    const p = marketPolicyFromEnv({});
    expect(p.endpoint).toBeUndefined();
    expect(p.catalog).toEqual(['anthropics/skills']);
    expect(p.catalogPrefix).toBe('skills');
    expect(p.timeoutMs).toBeGreaterThan(0);
  });

  it('honours env overrides and an empty catalog (disables the convention)', () => {
    const p = marketPolicyFromEnv({
      SWARM_OS_SKILLS_MARKET_ENDPOINT: 'https://reg.example/api/',
      SWARM_OS_SKILLS_MARKET_CATALOG: '',
      SWARM_OS_SKILLS_MARKET_PREFIX: '',
      SWARM_OS_SKILLS_MARKET_TIMEOUT_MS: '2500',
    });
    expect(p.endpoint).toBe('https://reg.example/api/');
    expect(p.catalog).toEqual([]);
    expect(p.catalogPrefix).toBe('');
    expect(p.timeoutMs).toBe(2500);
  });
});

describe('parseGitHubCoordinate', () => {
  it('resolves a bare owner/repo slug', () => {
    expect(parseGitHubCoordinate('anthropics/skills')).toEqual({
      url: 'https://github.com/anthropics/skills.git',
    });
  });

  it('extracts a mono-repo subdir', () => {
    expect(parseGitHubCoordinate('anthropics/skills/skills/pdf')).toEqual({
      url: 'https://github.com/anthropics/skills.git',
      subdir: 'skills/pdf',
    });
  });

  it('extracts an @ref and a subdir', () => {
    expect(parseGitHubCoordinate('acme/pack@v1.2.0/skills/foo')).toEqual({
      url: 'https://github.com/acme/pack.git',
      ref: 'v1.2.0',
      subdir: 'skills/foo',
    });
  });

  it('accepts the github: shorthand and strips a .git suffix', () => {
    expect(parseGitHubCoordinate('github:acme/pack.git')).toEqual({
      url: 'https://github.com/acme/pack.git',
    });
  });

  it('parses a full https URL with the /tree/<branch>/<subpath> form', () => {
    expect(parseGitHubCoordinate('https://github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({
      url: 'https://github.com/anthropics/skills.git',
      ref: 'main',
      subdir: 'skills/pdf',
    });
  });

  it('returns null for a bare name and for a non-github host', () => {
    expect(parseGitHubCoordinate('pdf')).toBeNull();
    expect(parseGitHubCoordinate('https://gitlab.com/acme/pack')).toBeNull();
  });

  it('refuses a traversal in the subdir', () => {
    expect(() => parseGitHubCoordinate('acme/pack/../../etc')).toThrow(SkillValidationError);
  });
});

describe('resolveMarket', () => {
  it('resolves a coordinate with no network', async () => {
    const t = await resolveMarket('acme/pack/skills/foo', conventionPolicy());
    expect(t).toEqual({ url: 'https://github.com/acme/pack.git', subdir: 'skills/foo' });
  });

  it('resolves a bare name via the catalog convention', async () => {
    const t = await resolveMarket('pdf', conventionPolicy());
    expect(t).toEqual({ url: 'https://github.com/anthropics/skills.git', subdir: 'skills/pdf' });
  });

  it('throws a validation error for a bare name when no endpoint and no catalog', async () => {
    await expect(
      resolveMarket('pdf', conventionPolicy({ catalog: [] })),
    ).rejects.toBeInstanceOf(SkillValidationError);
  });

  it('rejects a non-github URL (use source git instead)', async () => {
    await expect(
      resolveMarket('https://gitlab.com/acme/pack', conventionPolicy()),
    ).rejects.toBeInstanceOf(SkillValidationError);
  });

  it('rejects an invalid bare name', async () => {
    await expect(resolveMarket('PDF_Bad', conventionPolicy())).rejects.toBeInstanceOf(
      SkillValidationError,
    );
  });

  it('resolves a bare name via a configured endpoint (git coordinates)', async () => {
    const { fetchImpl, calls } = fakeFetch(200, {
      source: 'git',
      url: 'https://github.com/acme/pack.git',
      ref: 'v2',
      subdir: 'skills/pdf',
    });
    const t = await resolveMarket(
      'pdf',
      conventionPolicy({ endpoint: 'https://reg.example/' }),
      { fetchImpl },
    );
    expect(t).toEqual({ url: 'https://github.com/acme/pack.git', ref: 'v2', subdir: 'skills/pdf' });
    expect(calls[0]).toBe('https://reg.example/skills/pdf');
  });

  it('falls back to the catalog when the endpoint returns 404', async () => {
    const { fetchImpl } = fakeFetch(404, {});
    const t = await resolveMarket(
      'pdf',
      conventionPolicy({ endpoint: 'https://reg.example' }),
      { fetchImpl },
    );
    expect(t).toEqual({ url: 'https://github.com/anthropics/skills.git', subdir: 'skills/pdf' });
  });

  it('throws a stage error (502) when a configured endpoint is unreachable', async () => {
    await expect(
      resolveMarket('pdf', conventionPolicy({ endpoint: 'https://reg.example' }), {
        fetchImpl: throwingFetch,
      }),
    ).rejects.toBeInstanceOf(SkillStageError);
  });

  it('rejects an endpoint resolution to an unsupported (non-git) source', async () => {
    const { fetchImpl } = fakeFetch(200, { source: 'tarball', url: 'https://x/y.tgz' });
    await expect(
      resolveMarket('pdf', conventionPolicy({ endpoint: 'https://reg.example' }), { fetchImpl }),
    ).rejects.toBeInstanceOf(SkillValidationError);
  });
});

describe('searchMarket — GitHub catalog browse (no endpoint)', () => {
  it('lists <prefix>/ dirs, filters by q, and builds re-injectable refs', async () => {
    const { fetchImpl, calls, inits } = fakeFetch(200, GITHUB_CONTENTS);
    const r = await searchMarket('doc', conventionPolicy(), { fetchImpl, catalogCache: new Map() });

    expect(r.available).toBe(true);
    expect(r.error).toBeUndefined();
    // only the dir whose name contains "doc"; the file README.md is excluded.
    expect(r.results).toEqual([{ name: 'docx', ref: 'anthropics/skills/skills/docx' }]);
    // browses the GitHub contents API at the catalog repo's prefix.
    expect(calls[0]).toBe('https://api.github.com/repos/anthropics/skills/contents/skills');
    // sends the required GitHub headers; no Authorization without a token.
    expect(inits[0]?.headers?.['Accept']).toBe('application/vnd.github+json');
    expect(inits[0]?.headers?.['User-Agent']).toBeTruthy();
    expect(inits[0]?.headers?.['Authorization']).toBeUndefined();
  });

  it('an empty query returns every skill dir (a browsable-catalog probe)', async () => {
    const { fetchImpl } = fakeFetch(200, GITHUB_CONTENTS);
    const r = await searchMarket('', conventionPolicy(), { fetchImpl, catalogCache: new Map() });
    expect(r.available).toBe(true);
    expect(r.results.map((e) => e.name)).toEqual(['pdf', 'docx', 'pptx']);
  });

  it('re-resolves each ref back to git coordinates via resolveMarket', async () => {
    const { fetchImpl } = fakeFetch(200, GITHUB_CONTENTS);
    const r = await searchMarket('pdf', conventionPolicy(), { fetchImpl, catalogCache: new Map() });
    const t = await resolveMarket(r.results[0]!.ref!, conventionPolicy());
    expect(t).toEqual({ url: 'https://github.com/anthropics/skills.git', subdir: 'skills/pdf' });
  });

  it('sends an Authorization header when a github token is configured', async () => {
    const { fetchImpl, inits } = fakeFetch(200, GITHUB_CONTENTS);
    await searchMarket('pdf', conventionPolicy({ githubToken: 'ghp_x' }), {
      fetchImpl,
      catalogCache: new Map(),
    });
    expect(inits[0]?.headers?.['Authorization']).toBe('Bearer ghp_x');
  });

  it('caches the listing per repo+prefix (one network call for repeated searches)', async () => {
    const { fetchImpl, calls } = fakeFetch(200, GITHUB_CONTENTS);
    const cache = new Map();
    const deps = { fetchImpl, catalogCache: cache, now: () => 1000 };
    const a = await searchMarket('pdf', conventionPolicy(), deps);
    const b = await searchMarket('docx', conventionPolicy(), deps);
    expect(a.results).toEqual([{ name: 'pdf', ref: 'anthropics/skills/skills/pdf' }]);
    expect(b.results).toEqual([{ name: 'docx', ref: 'anthropics/skills/skills/docx' }]);
    expect(calls).toHaveLength(1); // second search served from cache
  });

  it('degrades gracefully (available:true + error) when GitHub is unreachable', async () => {
    const r = await searchMarket('pdf', conventionPolicy(), {
      fetchImpl: throwingFetch,
      catalogCache: new Map(),
    });
    expect(r.available).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it('degrades gracefully on a GitHub rate-limit (HTTP 403)', async () => {
    const { fetchImpl } = fakeFetch(403, { message: 'API rate limit exceeded' });
    const r = await searchMarket('pdf', conventionPolicy(), { fetchImpl, catalogCache: new Map() });
    expect(r.available).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.error).toContain('403');
  });

  it('is unavailable when neither an endpoint nor a catalog is configured', async () => {
    const r = await searchMarket('pdf', conventionPolicy({ catalog: [] }));
    expect(r).toEqual({ available: false, results: [] });
  });

  it('is unavailable when the catalog is a non-GitHub git host (browse unsupported)', async () => {
    const r = await searchMarket('pdf', conventionPolicy({ catalog: ['https://gitlab.com/acme/pack'] }));
    expect(r).toEqual({ available: false, results: [] });
  });
});

describe('searchMarket — endpoint (unchanged)', () => {
  it('normalizes a { results: [...] } payload', async () => {
    const { fetchImpl, calls } = fakeFetch(200, {
      results: [
        { name: 'pdf', description: 'PDF tools', ref: 'anthropics/skills/skills/pdf' },
        { notName: true },
      ],
    });
    const r = await searchMarket('pdf', conventionPolicy({ endpoint: 'https://reg.example/' }), {
      fetchImpl,
    });
    expect(r.available).toBe(true);
    expect(r.results).toEqual([
      { name: 'pdf', description: 'PDF tools', ref: 'anthropics/skills/skills/pdf' },
    ]);
    expect(calls[0]).toBe('https://reg.example/search?q=pdf');
  });

  it('accepts a bare-array payload', async () => {
    const { fetchImpl } = fakeFetch(200, [{ name: 'docx' }]);
    const r = await searchMarket('doc', conventionPolicy({ endpoint: 'https://reg.example' }), {
      fetchImpl,
    });
    expect(r.results).toEqual([{ name: 'docx' }]);
  });

  it('degrades gracefully (no throw) when the endpoint is unreachable', async () => {
    const r = await searchMarket('pdf', conventionPolicy({ endpoint: 'https://reg.example' }), {
      fetchImpl: throwingFetch,
    });
    expect(r.available).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});
