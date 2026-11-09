import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SettingsStore } from '../settings/index.js';
import { GithubReleasesClient } from './github.js';
import { PluginUpdateChecker } from './plugins-check.js';
import { UpdateService, UpdateStore, evaluateSelfUpdate, isRegistryRef, type UpdateServiceConfig } from './index.js';

let dir: string;
let db: SwarmDb;
let settings: SettingsStore;
let clock = 1_000_000;

const CONFIG: UpdateServiceConfig = {
  version: '0.5.0',
  image: 'ghcr.io/nyyyxius/swarm-os:0.5.0',
  agentTransport: 'ssh',
};

function release(tag: string) {
  return {
    tag_name: tag,
    draft: false,
    html_url: `https://github.com/x/y/releases/tag/${tag}`,
    body: 'what changed',
    published_at: '2026-02-02T00:00:00Z',
  };
}

function githubWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return new GithubReleasesClient({
    token: 'pat',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timeoutMs: 50,
  });
}

function okFetch(tags: string[]) {
  return vi.fn(
    async () =>
      ({ ok: true, status: 200, json: async () => tags.map(release) }) as unknown as Response,
  );
}

function service(over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  return new UpdateService({
    config: CONFIG,
    settings,
    github: githubWith(okFetch(['v0.6.0'])),
    ttlMs: 1000,
    now: () => clock,
    ...over,
  });
}

/** Let a fire-and-forget refresh land. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-service-'));
  db = new SwarmDb(dir);
  settings = new SettingsStore(db);
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UpdateService — verdict', () => {
  it('is "nothing known" before the first check, never a false positive', () => {
    const s = service();
    const v = s.getVerdict();
    expect(v.available).toBe(false);
    expect(v.latest).toBeNull();
    expect(v.checkStatus).toBe('never_checked');
  });

  it('reports a newer release as available, with its notes', async () => {
    const s = service();
    const v = await s.refreshNow();
    expect(v.available).toBe(true);
    expect(v.latest).toBe('0.6.0');
    expect(v.tag).toBe('v0.6.0');
    expect(v.notesBody).toBe('what changed');
    expect(v.notesUrl).toContain('/releases/tag/v0.6.0');
    expect(v.checkStatus).toBe('ok');
  });

  it('is not available when the newest release is the running version', async () => {
    const s = service({ github: githubWith(okFetch(['v0.5.0', 'v0.4.0'])) });
    expect((await s.refreshNow()).available).toBe(false);
  });

  it('is not available when the version cannot be compared (running from source)', async () => {
    const s = service({ config: { ...CONFIG, version: 'dev' } });
    const v = await s.refreshNow();
    expect(v.latest).toBe('0.6.0');
    expect(v.available).toBe(false);
  });
});

describe('UpdateService — dismiss', () => {
  it('silences exactly the dismissed version, and takes effect immediately', async () => {
    const s = service();
    expect((await s.refreshNow()).available).toBe(true);

    const after = s.dismiss('0.6.0');
    expect(after.available).toBe(false);
    expect(after.dismissedVersion).toBe('0.6.0');
    // No refresh, no TTL wait: the very next read is already quiet.
    expect(s.getVerdict().available).toBe(false);
  });

  it('normalizes the tag form, so dismissing v0.6.0 silences 0.6.0', async () => {
    const s = service();
    await s.refreshNow();
    expect(s.dismiss('v0.6.0').available).toBe(false);
  });

  it('un-dismisses with null', async () => {
    const s = service();
    await s.refreshNow();
    s.dismiss('0.6.0');
    expect(s.dismiss(null).available).toBe(true);
  });

  it('a dismissal does not silence the NEXT version', async () => {
    const s = service();
    await s.refreshNow();
    s.dismiss('0.6.0');
    const s2 = service({ github: githubWith(okFetch(['v0.6.0', 'v0.7.0'])) });
    const v = await s2.refreshNow();
    expect(v.latest).toBe('0.7.0');
    expect(v.available).toBe(true);
  });

  it('persists across a restart of the service', async () => {
    const s = service();
    await s.refreshNow();
    s.dismiss('0.6.0');
    const s2 = service();
    expect((await s2.refreshNow()).available).toBe(false);
  });
});

describe('UpdateService — cache & background refresh (no timer)', () => {
  it('serving the verdict refreshes ONLY when the cache is stale', async () => {
    const fetchImpl = okFetch(['v0.6.0']);
    const s = service({ github: githubWith(fetchImpl) });

    s.getVerdict();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Inside the TTL: no second call, however many tabs poll.
    s.getVerdict();
    s.getVerdict();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 1001;
    s.getVerdict();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns instantly (cached) while the refresh is still in flight', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () => new Promise<Response>((r) => { resolveFetch = r; }),
    );
    const s = service({ github: githubWith(fetchImpl as unknown as ReturnType<typeof vi.fn>) });
    const v = s.getVerdict();
    expect(v.checkStatus).toBe('never_checked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A second read must not start a second sweep.
    s.getVerdict();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, json: async () => [release('v0.6.0')] } as unknown as Response);
    await settle();
    expect(s.getVerdict().latest).toBe('0.6.0');
  });

  it('a failing check backs off to one attempt per TTL instead of one per poll', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const s = service({ github: githubWith(fetchImpl) });
    await s.refreshNow();
    s.getVerdict();
    s.getVerdict();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.getVerdict().checkStatus).toBe('error');
    expect(s.getVerdict().checkedAt).not.toBeNull();
  });

  it('keeps the last known release when a later check fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [release('v0.6.0')] })
      .mockRejectedValueOnce(new Error('offline'));
    const s = service({ github: githubWith(fetchImpl) });
    await s.refreshNow();
    clock += 5000;
    const v = await s.refreshNow();
    expect(v.latest).toBe('0.6.0');
    expect(v.available).toBe(true);
    expect(v.checkStatus).toBe('error');
    expect(v.error).toBe('offline');
  });

  it('a missing PAT is a state, not an error', async () => {
    const s = service({ github: new GithubReleasesClient({ token: null }) });
    const v = await s.refreshNow();
    expect(v.checkStatus).toBe('no_token');
    expect(v.available).toBe(false);
    expect(v.error).toBeNull();
  });
});

describe('UpdateService — projections', () => {
  it('/info gets the boolean and the tag, and nothing else', async () => {
    const s = service();
    await s.refreshNow();
    expect(s.getInfoUpdate()).toEqual({ available: true, latest: '0.6.0' });
    expect(Object.keys(s.getInfoUpdate()).sort()).toEqual(['available', 'latest']);
  });

  it('the authed state carries plugins and the eligibility reason', async () => {
    const s = service({
      pluginChecker: new PluginUpdateChecker({
        gitLsRemoteImpl: async () => `${'b'.repeat(40)}\trefs/heads/main\n`,
      }),
      listPluginOrigins: () => [
        {
          name: 'echo',
          version: '1.0.0',
          sourceKind: 'git',
          sourceRef: 'https://e/x.git#main',
          sourceCommit: 'a'.repeat(40),
        },
      ],
    });
    await s.refreshNow();
    const full = s.getFullState();
    expect(full.system.latest).toBe('0.6.0');
    expect(full.plugins).toHaveLength(1);
    expect(full.plugins[0].status).toBe('available');
    expect(full.pluginsCheckedAt).not.toBeNull();
    expect(full.canSelfUpdate.status).toBe('unknown');
    // The remaining checks are HOST facts, answered by the updater's own
    // preflight — an ineligible deployment costs one `refused` run that
    // touches nothing, not an SSH round trip on every `GET /updates`.
    expect(full.canSelfUpdate.detail).toMatch(/preflight/);
    // With no runner attached, the apply surface is absent rather than faked.
    expect(full.run).toBeNull();
    expect(full.recentRuns).toEqual([]);
    expect(full.updater).toBeNull();
  });

  it('exposes the plugin sweep on its own, without touching the run bookkeeping', async () => {
    const runner = {
      currentRun: vi.fn(() => null),
      listRuns: vi.fn(() => []),
      scriptDescriptor: vi.fn(() => null),
    };
    const s = service({
      pluginChecker: new PluginUpdateChecker({
        gitLsRemoteImpl: async () => `${'b'.repeat(40)}\trefs/heads/main\n`,
      }),
      listPluginOrigins: () => [
        {
          name: 'echo',
          version: '1.0.0',
          sourceKind: 'git',
          sourceRef: 'https://e/x.git#main',
          sourceCommit: 'a'.repeat(40),
        },
      ],
      runner: runner as unknown as Parameters<typeof service>[0]['runner'],
    });
    await s.refreshNow();
    expect(s.getPluginChecks()).toEqual(s.getFullState().plugins);
    expect(s.getPluginChecks()[0]!.name).toBe('echo');
    // `routes/plugins.ts` lists plugins on every page load; it has no business
    // paying for `listRuns(10)` and its per-run `events.ndjson` reads.
    runner.listRuns.mockClear();
    runner.currentRun.mockClear();
    s.getPluginChecks();
    expect(runner.listRuns).not.toHaveBeenCalled();
    expect(runner.currentRun).not.toHaveBeenCalled();
  });

  it('a throwing plugin-origin provider never breaks the verdict', async () => {
    const s = service({
      listPluginOrigins: () => {
        throw new Error('registry down');
      },
    });
    const v = await s.refreshNow();
    expect(v.latest).toBe('0.6.0');
    expect(s.getFullState().plugins).toEqual([]);
  });
});

describe('evaluateSelfUpdate', () => {
  it('local transport disqualifies first — there is no host to act on', () => {
    const r = evaluateSelfUpdate({ ...CONFIG, agentTransport: 'local' });
    expect(r.status).toBe('transport_not_ssh');
    expect(r.detail.length).toBeGreaterThan(0);
  });

  it('an absent SWARM_OS_IMAGE means the compose hardcodes its tag', () => {
    expect(evaluateSelfUpdate({ ...CONFIG, image: null }).status).toBe('image_not_interpolated');
  });

  it('a locally-built image has nothing to pull', () => {
    expect(evaluateSelfUpdate({ ...CONFIG, image: 'swarm-os:latest' }).status).toBe('image_not_registry');
  });

  it('never claims `ok` while the host-side checks are unimplemented', () => {
    expect(evaluateSelfUpdate(CONFIG).status).toBe('unknown');
  });

  it('isRegistryRef distinguishes a local tag from a registry ref', () => {
    expect(isRegistryRef('swarm-os:latest')).toBe(false);
    expect(isRegistryRef('ghcr.io/nyyyxius/swarm-os:0.6.0')).toBe(true);
    expect(isRegistryRef('owner/name:1')).toBe(true);
  });
});

describe('UpdateService — boot assertion', () => {
  it('assertReady surfaces a missing update_runs table', () => {
    const store = new UpdateStore(db);
    const s = service({ store });
    expect(() => s.assertReady()).not.toThrow();
    db.db.exec('DROP TABLE update_runs');
    expect(() => s.assertReady()).toThrow(/update_runs/);
  });

  it('is a no-op when no store was injected', () => {
    expect(() => service().assertReady()).not.toThrow();
  });
});
