/**
 * Per-plugin update detection — one strategy per origin, and an explicit
 * "I don't know" everywhere else.
 *
 * Design constraint that shapes this file: it takes {@link PluginOrigin}, a
 * narrow value type it defines itself, NOT a `PluginRow`. Detection has no
 * business depending on the plugin registry's storage shape; the wiring step
 * projects rows into origins. That also keeps this module testable with three
 * object literals and no SQLite.
 *
 * The rule that matters more than any strategy: **a missing input is never a
 * missing update**. A plugin installed before `source_commit` existed, a spec
 * we can't parse, a registry that answers 500 — all `unknown`. A false
 * `available` would send an operator to re-install a plugin that is already
 * current, which for a git plugin means a fetch + a swap + a re-approval of
 * capabilities. Nothing here ever guesses upward.
 */
import { execFile } from 'node:child_process';
import { withModule } from '../../logger.js';
import { compareVersions } from './semver.js';

const log = withModule('updates.plugins');

/** Wall-clock cap per remote probe. Detection is background work behind a
 *  cached verdict — it must never be the reason a request is slow. */
const DEFAULT_TIMEOUT_MS = 15_000;
const NPM_REGISTRY = 'https://registry.npmjs.org';
/** npm package name grammar, minus the legacy uppercase forms. Anything else
 *  (a tarball URL, a `file:` spec, a git spec routed through npm) is not
 *  checkable against the registry. */
const NPM_NAME_RE = /^(?:@[a-z0-9\-*~][a-z0-9\-*._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/;

/**
 * Everything detection needs about an installed plugin — deliberately a
 * hand-written value type, not a projection of the `plugins` table.
 */
export interface PluginOrigin {
  name: string;
  /** Installed version, from the manifest. */
  version: string;
  /** `git` | `npm` | `dir` | `upload` (anything else → `unknown`). */
  sourceKind: string;
  /** Re-fetch address; for git, the packed `url#ref#subdir` form. */
  sourceRef: string | null;
  /** git HEAD the install came from; `null` for non-git AND for pre-feature rows. */
  sourceCommit: string | null;
}

export type PluginUpdateStatus =
  /** A newer version/commit exists at the source. */
  | 'available'
  /** Checked, and the source matches what's installed. */
  | 'up_to_date'
  /** `dir`/`upload`: there is no remote to compare against, by construction. */
  | 'local'
  /** Not checkable right now (no recorded commit, bad spec, network, …). */
  | 'unknown';

export interface PluginUpdateCheck {
  name: string;
  status: PluginUpdateStatus;
  /** npm only — `dist-tags.latest`. `null` for git (a sha is not a version). */
  latestVersion: string | null;
  /** git only — the remote sha at `ref`. */
  latestCommit: string | null;
  /** Stable machine-readable cause for `local`/`unknown`; `null` otherwise. */
  reason: string | null;
  checkedAt: string;
}

/**
 * Inverse of `encodeGitRef` — duplicated on purpose (~8 lines) so detection
 * carries no import into `modules/plugins/`.
 * SOURCE OF TRUTH: `modules/plugins/installer.ts:80` (`encodeGitRef`) — if the
 * encoding ever changes there, this must follow.
 */
export function decodeGitSourceRef(stored: string): { url: string; ref?: string; subdir?: string } {
  const parts = stored.split('#');
  const url = parts[0] ?? stored;
  const ref = parts[1] && parts[1].length > 0 ? parts[1] : undefined;
  const subdir = parts[2] && parts[2].length > 0 ? parts[2] : undefined;
  return { url, ref, subdir };
}

/** `pkg@1.2.3` / `@scope/pkg@^1` / `pkg` → the bare name, or `null`. */
export function npmPackageName(spec: string): string | null {
  const s = spec.trim();
  if (s.length === 0) return null;
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
  const name = at > 0 ? s.slice(0, at) : s;
  return NPM_NAME_RE.test(name) ? name : null;
}

/**
 * Pick the sha out of `git ls-remote` output. Refs are `<sha>\t<refname>`;
 * asking for `main` can legitimately return a branch AND a tag AND that tag's
 * dereferenced commit (`^{}`), so preference order is explicit rather than
 * "first line wins".
 */
export function parseLsRemote(stdout: string, ref: string): string | null {
  const rows: Array<{ sha: string; name: string }> = [];
  for (const line of stdout.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) rows.push({ sha, name: name ?? '' });
  }
  const first = rows[0];
  if (first === undefined) return null;
  const pick = (n: string) => rows.find((r) => r.name === n)?.sha;
  // A dereferenced annotated tag points at the COMMIT — that is what a clone
  // would check out, so it wins over the tag object's own sha.
  return (
    pick(`refs/tags/${ref}^{}`) ??
    pick(`refs/heads/${ref}`) ??
    pick(`refs/tags/${ref}`) ??
    pick(ref) ??
    first.sha
  );
}

export interface PluginUpdateCheckerOptions {
  /** Test seam — defaults to global `fetch` (npm registry). */
  fetchImpl?: typeof fetch;
  /** Test seam — raw `git ls-remote` stdout for `(url, ref)`. */
  gitLsRemoteImpl?: (url: string, ref: string) => Promise<string>;
  timeoutMs?: number;
  now?: () => Date;
}

export class PluginUpdateChecker {
  private readonly fetchImpl: typeof fetch;
  private readonly lsRemote: (url: string, ref: string) => Promise<string>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: PluginUpdateCheckerOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.lsRemote = opts.gitLsRemoteImpl ?? ((url, ref) => gitLsRemote(url, ref, this.timeoutMs));
    this.now = opts.now ?? (() => new Date());
  }

  /** Check every origin concurrently; one failing plugin never fails the batch. */
  async checkAll(origins: PluginOrigin[]): Promise<PluginUpdateCheck[]> {
    return Promise.all(origins.map((o) => this.check(o)));
  }

  async check(origin: PluginOrigin): Promise<PluginUpdateCheck> {
    try {
      switch (origin.sourceKind) {
        case 'git':
          return await this.checkGit(origin);
        case 'npm':
          return await this.checkNpm(origin);
        case 'dir':
        case 'upload':
          // No remote exists to compare against. This is a terminal answer,
          // not a failure — the UI says "local source" and offers nothing.
          return this.result(origin, 'local', { reason: 'local_source' });
        default:
          return this.result(origin, 'unknown', { reason: 'unsupported_source' });
      }
    } catch (err) {
      // Belt-and-braces: a strategy must already return `unknown` rather than
      // throw, but a batch of checks must not be able to take down a request.
      log.warn({ event: 'updates.plugin_check_failed', plugin: origin.name, error: String(err) });
      return this.result(origin, 'unknown', { reason: 'check_failed' });
    }
  }

  // ---- strategies ---------------------------------------------------------

  private async checkGit(origin: PluginOrigin): Promise<PluginUpdateCheck> {
    if (!origin.sourceRef) return this.result(origin, 'unknown', { reason: 'no_source_ref' });
    // No SHA recorded ⇒ every comparison would be a guess. Plugins installed
    // before `source_commit` existed land here and stay here until reinstalled.
    if (!origin.sourceCommit) return this.result(origin, 'unknown', { reason: 'no_recorded_commit' });

    const { url, ref } = decodeGitSourceRef(origin.sourceRef);
    // `git ls-remote <url> <ref>` takes both as POSITIONALS: a value starting
    // with `-` would be parsed as an option. Refuse instead of shelling out.
    if (url.startsWith('-') || (ref && ref.startsWith('-'))) {
      return this.result(origin, 'unknown', { reason: 'unsafe_source_ref' });
    }
    // No explicit ref ⇒ the installer cloned the default branch ⇒ compare HEAD.
    const wanted = ref ?? 'HEAD';

    let stdout: string;
    try {
      stdout = await this.lsRemote(url, wanted);
    } catch (err) {
      log.warn({ event: 'updates.ls_remote_failed', plugin: origin.name, error: String(err) });
      return this.result(origin, 'unknown', { reason: 'remote_unreachable' });
    }

    const remote = parseLsRemote(stdout, wanted);
    if (!remote) return this.result(origin, 'unknown', { reason: 'ref_not_found' });
    const same = remote === origin.sourceCommit ||
      remote.startsWith(origin.sourceCommit) ||
      origin.sourceCommit.startsWith(remote);
    return this.result(origin, same ? 'up_to_date' : 'available', { latestCommit: remote });
  }

  private async checkNpm(origin: PluginOrigin): Promise<PluginUpdateCheck> {
    if (!origin.sourceRef) return this.result(origin, 'unknown', { reason: 'no_source_ref' });
    const name = npmPackageName(origin.sourceRef);
    if (!name) return this.result(origin, 'unknown', { reason: 'unsupported_npm_spec' });

    // CouchDB doc-id form: the slash of a scope is escaped, the `@` is not.
    const url = `${NPM_REGISTRY}/${name.replace('/', '%2f')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let latest: string | null = null;
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'swarm-os' },
        signal: controller.signal,
      });
      if (!res.ok) {
        return this.result(origin, 'unknown', {
          reason: res.status === 404 ? 'package_not_found' : 'registry_error',
        });
      }
      const body = (await res.json()) as { 'dist-tags'?: Record<string, unknown> };
      const tag = body?.['dist-tags']?.latest;
      if (typeof tag === 'string' && tag.length > 0) latest = tag;
    } catch (err) {
      log.warn({ event: 'updates.npm_check_failed', plugin: origin.name, error: String(err) });
      return this.result(origin, 'unknown', { reason: 'registry_unreachable' });
    } finally {
      clearTimeout(timer);
    }

    if (latest === null) return this.result(origin, 'unknown', { reason: 'no_dist_tag' });
    const cmp = compareVersions(latest, origin.version);
    // An unparsable pair (a date-based scheme, a `dev` install) is not a
    // reason to claim an update exists.
    if (cmp === null) return this.result(origin, 'unknown', { reason: 'version_not_comparable', latestVersion: latest });
    return this.result(origin, cmp === 1 ? 'available' : 'up_to_date', { latestVersion: latest });
  }

  private result(
    origin: PluginOrigin,
    status: PluginUpdateStatus,
    extra: { latestVersion?: string | null; latestCommit?: string | null; reason?: string | null } = {},
  ): PluginUpdateCheck {
    return {
      name: origin.name,
      status,
      latestVersion: extra.latestVersion ?? null,
      latestCommit: extra.latestCommit ?? null,
      reason: extra.reason ?? null,
      checkedAt: this.now().toISOString(),
    };
  }
}

/**
 * Default `git ls-remote` runner. Modelled on `PluginInstaller.run`
 * (`modules/plugins/installer.ts:470`): `execFile` (never a shell), an explicit
 * hard timeout, and `GIT_TERMINAL_PROMPT=0` so a private URL fails fast instead
 * of blocking forever on a credential prompt nobody can answer.
 */
function gitLsRemote(url: string, ref: string, timeoutMs: number): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || '/home/node',
    GIT_TERMINAL_PROMPT: '0',
    // Same intent for the ssh transport: never sit on a host-key/passphrase
    // prompt during what is supposed to be a background probe.
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
  };
  // ⚠️ Verified: a pattern only matches the ref's LAST path component, so
  // asking for `v1` returns the annotated tag's OBJECT sha and never the
  // peeled `refs/tags/v1^{}` line. The clone we compare against was pinned by
  // `rev-parse HEAD`, i.e. the COMMIT — so without the second pattern every
  // annotated-tag plugin would read "update available" forever.
  const patterns = ref === 'HEAD' ? [ref] : [ref, `${ref}^{}`];
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['ls-remote', '--', url, ...patterns],
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(String(stdout));
          return;
        }
        const detail = (String(stderr) || err.message).trim().slice(-400);
        reject(new Error(`git ls-remote failed: ${detail}`));
      },
    );
  });
}
