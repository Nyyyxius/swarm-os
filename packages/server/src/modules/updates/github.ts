/**
 * GitHub Releases client — the ONE source of truth for "is there a newer
 * swarm-os?".
 *
 * Credentials: `SWARM_OS_GITHUB_TOKEN`, and nothing else. No write route, no
 * settings field, no reading the host's `~/.docker/config.json` (its
 * `read:packages` scope isn't `contents:read` anyway, and siphoning another
 * tool's credential file is a surprise, not a feature). The operator already
 * creates a PAT to `docker pull` from GHCR — this reuses that habit, not that
 * secret.
 *
 * A PRIVATE repo answers an unauthenticated call with 404, not 401 (verified
 * while `Nyyyxius/swarm-os` was private). So "no PAT configured" is a
 * first-class, expected state of a healthy deployment — never an error, never
 * a log storm. Every outcome is a
 * value; this client does not throw.
 *
 * ⚠️ `GET /releases` is ordered by CREATION date and INCLUDES drafts. Taking
 * `[0]` would (a) offer an operator a draft that has no image behind it, and
 * (b) pick a backport tagged today over the higher version tagged last week.
 * We filter drafts out and take the max through our own comparator.
 */
import { withModule } from '../../logger.js';
import { compareVersions, parseVersion, tagToVersion } from './semver.js';

const log = withModule('updates.github');

/** The repository this build's updates come from. */
export const DEFAULT_OWNER = 'Nyyyxius';
export const DEFAULT_REPO = 'swarm-os';

/** Wall-clock cap on the whole call. `/info` fans out to this in the
 *  background; a hung socket must not pin the entry forever. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Release bodies are rendered as preformatted text in a drawer, not archived.
 *  Cap what we hold in memory and hand back over HTTP. */
const NOTES_MAX = 20_000;
/** One page is 30 releases by default; ask for enough to cover a long tail of
 *  patch tags without paginating (we only ever want the max). */
const PER_PAGE = 100;

export interface GithubRelease {
  /** Tag exactly as published (`v0.6.0`). */
  tag: string;
  /** Comparable form of `tag` (`0.6.0`) — what goes through the comparator. */
  version: string;
  /** `html_url` of the release page. */
  notesUrl: string | null;
  /** Release body (markdown, rendered as PREFORMATTED text — never parsed). */
  notesBody: string | null;
  publishedAt: string | null;
}

/**
 * Every way this call can end, as data. `no_token` and `not_found` are
 * ordinary states of a correct deployment (no PAT / PAT without access to a
 * private repo) and each has its own operator-facing sentence upstream —
 * collapsing them into one "error" would tell the operator to fix the wrong
 * thing.
 */
export type GithubLatestResult =
  | { status: 'ok'; release: GithubRelease }
  | { status: 'no_releases' }
  | { status: 'no_token' }
  | { status: 'unauthorized' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/** Shape we consume out of the API payload — everything else is ignored. */
interface RawRelease {
  tag_name?: unknown;
  draft?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
}

export interface GithubReleasesClientOptions {
  /** PAT, or `null` when unset — `null` short-circuits WITHOUT a network call. */
  token: string | null;
  owner?: string;
  repo?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Read the PAT from the environment. The only supported source, on purpose. */
export function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SWARM_OS_GITHUB_TOKEN;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export class GithubReleasesClient {
  private readonly token: string | null;
  private readonly owner: string;
  private readonly repo: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GithubReleasesClientOptions) {
    this.token = opts.token;
    this.owner = opts.owner ?? DEFAULT_OWNER;
    this.repo = opts.repo ?? DEFAULT_REPO;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** Highest non-draft release, or a typed non-answer. Never throws. */
  async latestRelease(): Promise<GithubLatestResult> {
    if (this.token === null) return { status: 'no_token' };

    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/releases?per_page=${PER_PAGE}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'swarm-os',
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Network down, DNS gone, abort on timeout — all the same to the caller:
      // we simply don't know, and the previous verdict stays in place.
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ event: 'updates.github_unreachable', error: message });
      return { status: 'error', message };
    } finally {
      clearTimeout(timer);
    }

    // 401 = the PAT is wrong/expired. 403 = valid PAT, refused (missing scope
    // or rate-limited) — same operator action (fix the token), same bucket.
    if (res.status === 401 || res.status === 403) return { status: 'unauthorized' };
    // 404 on a private repo means "this PAT cannot see it" — GitHub hides
    // existence rather than admitting it, so this is NOT a missing-repo bug.
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      return { status: 'error', message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!Array.isArray(payload)) return { status: 'error', message: 'expected a JSON array of releases' };

    const best = pickHighestRelease(payload as RawRelease[]);
    return best ? { status: 'ok', release: best } : { status: 'no_releases' };
  }
}

/**
 * Max by version over the non-draft, parsable-tag releases. Exported for the
 * test that pins the two traps: drafts must not win, and neither must "first
 * in the array" (the API sorts by creation date, not by version).
 */
export function pickHighestRelease(raw: RawRelease[]): GithubRelease | null {
  let best: GithubRelease | null = null;
  for (const r of raw) {
    if (r.draft === true) continue;
    if (typeof r.tag_name !== 'string' || r.tag_name.length === 0) continue;
    const version = tagToVersion(r.tag_name);
    // A tag we cannot compare cannot be offered as an update — skip rather
    // than surface a version the badge could never reason about.
    if (parseVersion(version) === null) continue;
    const candidate: GithubRelease = {
      tag: r.tag_name,
      version,
      notesUrl: typeof r.html_url === 'string' ? r.html_url : null,
      notesBody: typeof r.body === 'string' ? r.body.slice(0, NOTES_MAX) : null,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    };
    if (best === null || compareVersions(candidate.version, best.version) === 1) best = candidate;
  }
  return best;
}
