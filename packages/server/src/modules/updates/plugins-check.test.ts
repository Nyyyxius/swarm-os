import { describe, it, expect, vi } from 'vitest';
import {
  PluginUpdateChecker,
  decodeGitSourceRef,
  npmPackageName,
  parseLsRemote,
  type PluginOrigin,
} from './plugins-check.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function origin(over: Partial<PluginOrigin> = {}): PluginOrigin {
  return {
    name: 'echo',
    version: '1.0.0',
    sourceKind: 'git',
    sourceRef: 'https://example.com/x.git#main',
    sourceCommit: SHA_A,
    ...over,
  };
}

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('decodeGitSourceRef', () => {
  it('decodes url / url#ref / url#ref#subdir', () => {
    expect(decodeGitSourceRef('https://e/x.git')).toEqual({ url: 'https://e/x.git', ref: undefined, subdir: undefined });
    expect(decodeGitSourceRef('https://e/x.git#main')).toEqual({ url: 'https://e/x.git', ref: 'main', subdir: undefined });
    expect(decodeGitSourceRef('https://e/x.git##pkgs/a')).toEqual({
      url: 'https://e/x.git',
      ref: undefined,
      subdir: 'pkgs/a',
    });
  });
});

describe('npmPackageName', () => {
  it('strips the version range, scope included', () => {
    expect(npmPackageName('left-pad')).toBe('left-pad');
    expect(npmPackageName('left-pad@1.2.3')).toBe('left-pad');
    expect(npmPackageName('@scope/pkg')).toBe('@scope/pkg');
    expect(npmPackageName('@scope/pkg@^1.0.0')).toBe('@scope/pkg');
  });

  it('rejects specs the registry cannot answer for', () => {
    expect(npmPackageName('https://example.com/x.tgz')).toBeNull();
    expect(npmPackageName('file:../local')).toBeNull();
    expect(npmPackageName('')).toBeNull();
  });
});

describe('parseLsRemote', () => {
  it('prefers the peeled tag (a commit) over the tag object', () => {
    const out = `${SHA_A}\trefs/tags/v1\n${SHA_B}\trefs/tags/v1^{}\n`;
    expect(parseLsRemote(out, 'v1')).toBe(SHA_B);
  });

  it('prefers the branch when both a branch and a tag match', () => {
    const out = `${SHA_A}\trefs/tags/main\n${SHA_B}\trefs/heads/main\n`;
    expect(parseLsRemote(out, 'main')).toBe(SHA_B);
  });

  it('reads a bare HEAD line', () => {
    expect(parseLsRemote(`${SHA_A}\tHEAD\n`, 'HEAD')).toBe(SHA_A);
  });

  it('returns null when nothing matched', () => {
    expect(parseLsRemote('', 'main')).toBeNull();
    expect(parseLsRemote('fatal: repository not found\n', 'main')).toBeNull();
  });
});

describe('PluginUpdateChecker — git', () => {
  it('remote moved → available, carrying the remote sha', async () => {
    const gitLsRemoteImpl = vi.fn(async () => `${SHA_B}\trefs/heads/main\n`);
    const c = new PluginUpdateChecker({ gitLsRemoteImpl });
    const r = await c.check(origin());
    expect(r.status).toBe('available');
    expect(r.latestCommit).toBe(SHA_B);
    expect(gitLsRemoteImpl).toHaveBeenCalledWith('https://example.com/x.git', 'main');
  });

  it('same sha → up_to_date', async () => {
    const c = new PluginUpdateChecker({ gitLsRemoteImpl: async () => `${SHA_A}\trefs/heads/main\n` });
    expect((await c.check(origin())).status).toBe('up_to_date');
  });

  it('no ref in source_ref → compares HEAD (the default branch the installer cloned)', async () => {
    const gitLsRemoteImpl = vi.fn(async () => `${SHA_A}\tHEAD\n`);
    const c = new PluginUpdateChecker({ gitLsRemoteImpl });
    await c.check(origin({ sourceRef: 'https://example.com/x.git' }));
    expect(gitLsRemoteImpl).toHaveBeenCalledWith('https://example.com/x.git', 'HEAD');
  });

  it('NO recorded commit → unknown, never a false available', async () => {
    const gitLsRemoteImpl = vi.fn(async () => `${SHA_B}\trefs/heads/main\n`);
    const c = new PluginUpdateChecker({ gitLsRemoteImpl });
    const r = await c.check(origin({ sourceCommit: null }));
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_recorded_commit');
    // And we don't even pay for the network probe we couldn't use.
    expect(gitLsRemoteImpl).not.toHaveBeenCalled();
  });

  it('ls-remote failure → unknown, not a throw', async () => {
    const c = new PluginUpdateChecker({
      gitLsRemoteImpl: async () => {
        throw new Error('boom');
      },
    });
    const r = await c.check(origin());
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('remote_unreachable');
  });

  it('ref absent from the remote → unknown', async () => {
    const c = new PluginUpdateChecker({ gitLsRemoteImpl: async () => '' });
    expect((await c.check(origin())).reason).toBe('ref_not_found');
  });

  it('refuses a url or ref that would be parsed as a git option', async () => {
    const gitLsRemoteImpl = vi.fn(async () => '');
    const c = new PluginUpdateChecker({ gitLsRemoteImpl });
    const r = await c.check(origin({ sourceRef: '--upload-pack=touch /tmp/pwn#main' }));
    expect(r.reason).toBe('unsafe_source_ref');
    expect(gitLsRemoteImpl).not.toHaveBeenCalled();
  });

  it('tolerates a short recorded sha on either side', async () => {
    const c = new PluginUpdateChecker({ gitLsRemoteImpl: async () => `${SHA_A}\trefs/heads/main\n` });
    expect((await c.check(origin({ sourceCommit: SHA_A.slice(0, 12) }))).status).toBe('up_to_date');
  });
});

describe('PluginUpdateChecker — npm', () => {
  const npmOrigin = origin({ sourceKind: 'npm', sourceRef: 'left-pad@1.0.0', sourceCommit: null });

  it('newer dist-tags.latest → available', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { 'dist-tags': { latest: '1.1.0' } }));
    const c = new PluginUpdateChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await c.check(npmOrigin);
    expect(r.status).toBe('available');
    expect(r.latestVersion).toBe('1.1.0');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://registry.npmjs.org/left-pad');
  });

  it('same version → up_to_date', async () => {
    const c = new PluginUpdateChecker({
      fetchImpl: (vi.fn(async () => jsonRes(200, { 'dist-tags': { latest: '1.0.0' } })) as unknown) as typeof fetch,
    });
    expect((await c.check(npmOrigin)).status).toBe('up_to_date');
  });

  it('escapes the slash of a scoped name', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { 'dist-tags': { latest: '1.0.0' } }));
    const c = new PluginUpdateChecker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.check(origin({ sourceKind: 'npm', sourceRef: '@acme/plug@1.0.0', sourceCommit: null }));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://registry.npmjs.org/@acme%2fplug');
  });

  it('404 / 500 / network failure → unknown with distinct reasons', async () => {
    const mk = (impl: () => Promise<Response>) =>
      new PluginUpdateChecker({ fetchImpl: (vi.fn(impl) as unknown) as typeof fetch });
    expect((await mk(async () => jsonRes(404, {})).check(npmOrigin)).reason).toBe('package_not_found');
    expect((await mk(async () => jsonRes(500, {})).check(npmOrigin)).reason).toBe('registry_error');
    expect(
      (
        await mk(async () => {
          throw new Error('offline');
        }).check(npmOrigin)
      ).reason,
    ).toBe('registry_unreachable');
  });

  it('an incomparable version pair is unknown, not available', async () => {
    const c = new PluginUpdateChecker({
      fetchImpl: (vi.fn(async () => jsonRes(200, { 'dist-tags': { latest: '20260101' } })) as unknown) as typeof fetch,
    });
    const r = await c.check(npmOrigin);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('version_not_comparable');
  });
});

describe('PluginUpdateChecker — non-checkable origins', () => {
  it('dir and upload are local, terminally', async () => {
    const c = new PluginUpdateChecker({});
    for (const kind of ['dir', 'upload']) {
      const r = await c.check(origin({ sourceKind: kind, sourceRef: null, sourceCommit: null }));
      expect(r.status).toBe('local');
      expect(r.reason).toBe('local_source');
    }
  });

  it('an unknown source kind is unknown', async () => {
    const r = await new PluginUpdateChecker({}).check(origin({ sourceKind: 'carrier-pigeon' }));
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('unsupported_source');
  });

  it('checkAll never lets one plugin sink the batch', async () => {
    const c = new PluginUpdateChecker({
      gitLsRemoteImpl: async (url) => {
        if (url.includes('bad')) throw new Error('nope');
        return `${SHA_A}\trefs/heads/main\n`;
      },
    });
    const out = await c.checkAll([
      origin({ name: 'good' }),
      origin({ name: 'bad', sourceRef: 'https://bad.example/x.git#main' }),
      origin({ name: 'local', sourceKind: 'dir' }),
    ]);
    expect(out.map((r) => `${r.name}:${r.status}`)).toEqual(['good:up_to_date', 'bad:unknown', 'local:local']);
  });
});
