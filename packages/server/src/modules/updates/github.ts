/**
 * GitHub Releases client — the ONE source of truth for "is there a newer
 * swarm-os?".
 *
 * The repository is public, so the releases API answers WITHOUT a token: no
 * token configured is the normal case, and the call goes out unauthenticated.
 * A token (`SWARM_OS_GITHUB_TOKEN`, and nothing else — no write route, no
 * settings field, no reading the host's `~/.docker/config.json`) is optional:
 * it raises GitHub's rate limit (60 unauthenticated requests per hour per IP,
 * shared by everything behind that IP) and lets a private fork be read. It is
 * sent only when set.
 *
 * Running out of that budget is its own state (`rate_limited`), not a failure
 * and not a token problem: it clears at the reset time, and a token is only
 * the way to stop hitting it. A PRIVATE repo answers an unauthenticated call
 * with 404, not 401, which lands in `not_found`. Every outcome is a value;
 * this client does not throw.
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
 * Every way this call can end, as data. `rate_limited`, `unauthorized` and
 * `not_found` each have their own operator-facing sentence upstream —
 * collapsing them into one "error" would tell the operator to fix the wrong
 * thing (a rate limit needs waiting or a token; a refused token needs a new
 * token; a 404 needs the right repository).
 *
 * There is no `no_token` outcome any more: without a token the call is made
 * unauthenticated.
 */
export type GithubLatestResult =
  | { status: 'ok'; release: GithubRelease }
  | { status: 'no_releases' }
  | GithubRateLimited
  | { status: 'unauthorized' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export interface GithubRateLimited {
  status: 'rate_limited';
  /** Whether the exhausted budget was the token's or the anonymous one. */
  authenticated: boolean;
  /** ISO time the budget comes back, when GitHub said; else `null`. */
  resetAt: string | null;
  /** One operator-facing sentence. */
  message: string;
}

/** Shape we consume out of the API payload — everything else is ignored. */
interface RawRelease {
  tag_name?: unknown;
  draft?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
}

export interface GithubReleasesClientOptions {
  /** Optional token, or `null` when unset — `null` means an unauthenticated call. */
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
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/releases?per_page=${PER_PAGE}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'swarm-os',
    };
    // Sent only when configured: the public repo answers without it.
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
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

    // A rate limit comes back as 429, or as 403 with an exhausted budget /
    // `retry-after` / a "rate limit" message. Checked BEFORE the token buckets:
    // a 403 from a spent anonymous budget is not a token problem.
    if (res.status === 429 || (res.status === 403 && (await isRateLimited(res)))) {
      const limited = this.rateLimited(res);
      log.warn({
        event: 'updates.github_rate_limited',
        authenticated: limited.authenticated,
        resetAt: limited.resetAt,
      });
      return limited;
    }
    // 401 = the token is wrong/expired. 403 = token valid but refused (missing
    // scope / no access) — same operator action (fix the token), same bucket.
    // Without a token neither should happen on a public repo: report it raw.
    if (res.status === 401 || res.status === 403) {
      return this.token !== null
        ? { status: 'unauthorized' }
        : { status: 'error', message: `HTTP ${res.status}` };
    }
    // 404: the repository is private (GitHub hides existence rather than
    // admitting it, to an anonymous call or to a token that cannot see it) or
    // was renamed.
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

  private rateLimited(res: Response): GithubRateLimited {
    const authenticated = this.token !== null;
    const resetAt = rateLimitResetAt(res);
    const until = resetAt ? ` until ${resetAt}` : '';
    const message = authenticated
      ? `GitHub API rate limit reached for SWARM_OS_GITHUB_TOKEN${until}; a later check retries on its own.`
      : `GitHub API rate limit reached for unauthenticated requests from this IP (60 per hour)${until}; ` +
        'a later check retries on its own. Setting SWARM_OS_GITHUB_TOKEN (any read-only token) raises the limit.';
    return { status: 'rate_limited', authenticated, resetAt, message };
  }
}

/** Header lookup that tolerates a response without `headers` (test doubles). */
function header(res: Response, name: string): string | null {
  const h = (res as Partial<Response>).headers;
  return h && typeof h.get === 'function' ? h.get(name) : null;
}

/**
 * Does a 403 mean "rate limited"? GitHub's primary limit sets
 * `x-ratelimit-remaining: 0`; its secondary limits send `retry-after`; both
 * say "rate limit" in the body's `message`.
 */
async function isRateLimited(res: Response): Promise<boolean> {
  if (header(res, 'x-ratelimit-remaining') === '0') return true;
  if (header(res, 'retry-after') !== null) return true;
  try {
    const body: unknown = await res.json();
    const message =
      typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
    return typeof message === 'string' && /rate limit/i.test(message);
  } catch {
    return false;
  }
}

/**
 * When the budget comes back: `retry-after` (seconds from now) wins, then
 * `x-ratelimit-reset` (epoch seconds). `null` when GitHub said neither.
 */
export function rateLimitResetAt(res: Response, nowMs: number = Date.now()): string | null {
  const retryAfter = header(res, 'retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
    return new Date(nowMs + Number(retryAfter.trim()) * 1000).toISOString();
  }
  const reset = header(res, 'x-ratelimit-reset');
  if (reset !== null && /^\d+$/.test(reset.trim()) && Number(reset.trim()) > 0) {
    return new Date(Number(reset.trim()) * 1000).toISOString();
  }
  return null;
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
