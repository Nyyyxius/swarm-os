/**
 * Market source — import an Agent Skill from the agentskills.io ECOSYSTEM.
 *
 * REALITY CHECK (investigated Lot 4a, 2026-08-03 — docs/skills-lot4-contract.md):
 * agentskills.io is the open Agent-Skills SPEC + client showcase. It exposes NO
 * package-registry download or search HTTP API — the plan's "index HTTP →
 * tarball" assumption (plan §5.1) does not match reality. The canonical
 * distribution channel is a GitHub repo whose skills live at the repo root or
 * under `skills/<name>/SKILL.md` (verified: github.com/anthropics/skills has
 * `skills/pdf/`, `skills/docx/`, …). So `market` does NOT invent an API: it
 * RESOLVES a skill reference to git coordinates and DELEGATES to the existing
 * `git` source (stage.ts `stageGit`, which already handles a mono-repo `subdir`).
 *
 * A market `ref` is one of:
 *   - a GitHub coordinate → resolved with NO network:
 *       `owner/repo`, `owner/repo/sub/dir`, `owner/repo@ref`,
 *       `owner/repo@ref/sub/dir`, `github:owner/repo`, or a
 *       `https://github.com/owner/repo[/tree/<branch>/<subpath>]` URL.
 *   - a bare skill name (`pdf`) → resolved against, in order:
 *       1. the optional registry endpoint (SWARM_OS_SKILLS_MARKET_ENDPOINT), then
 *       2. the default catalog repo(s) (SWARM_OS_SKILLS_MARKET_CATALOG, default
 *          `anthropics/skills` at prefix `skills`) → `{repo, subdir:<prefix>/<name>}`.
 *
 * Everything is DATA-FIRST: the eventual fetch is a `git clone` (or an endpoint
 * that itself returns git coordinates). Nothing here runs skill code. A market
 * import's trust stays `community` (trust.ts), so the Lot 3 review gate applies
 * to any executable assets it ships.
 *
 * DEGRADATION (the server runs 24/7): the endpoint is OPTIONAL. Unset ⇒ the
 * resolver works purely from coordinates + the catalog convention. Set but
 * unreachable ⇒ resolution throws a clean {@link SkillStageError} (HTTP 502).
 *
 * BROWSE ({@link searchMarket}): with an endpoint it queries `/search`; with no
 * endpoint but a GitHub catalog repo it lists the catalog's `<prefix>/` dirs via
 * the GitHub contents API (cached per repo+prefix). Either path degrades to
 * `{available:true, results:[], error}` on any failure (rate-limit, timeout,
 * bad JSON); only "no endpoint AND no browsable catalog" yields
 * `{available:false}`. A missing global `fetch` (very old Node) is treated as a
 * browse failure, never a crash.
 */

import { SkillValidationError, SkillStageError } from './stage.js';

/** Default catalog repo for bare-name resolution (the canonical public repo). */
const DEFAULT_CATALOG = 'anthropics/skills';
/** Default path prefix a bare name nests under inside a catalog repo. */
const DEFAULT_PREFIX = 'skills';
/** Default per-request network timeout for endpoint / catalog calls (ms). */
const DEFAULT_TIMEOUT_MS = 8_000;
/** GitHub contents API base for browsing a catalog repo. */
const GITHUB_API_BASE = 'https://api.github.com';
/**
 * TTL of the in-memory catalog-listing cache. GitHub's unauthenticated rate
 * limit is 60 req/h; caching the `<prefix>/` listing per repo keeps a burst of
 * searches (the UI fires one per keystroke) down to one network call.
 */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1_000;

/** How a bare name / coordinate is resolved. */
export interface MarketPolicy {
  /** Optional base URL of a name→git registry + search index. Unset ⇒ convention-only. */
  endpoint?: string;
  /** Ordered repos a BARE name resolves against (`owner/repo` or a full git url). */
  catalog: string[];
  /** Path prefix inside a catalog repo a bare name nests under (`skills`; '' = root). */
  catalogPrefix: string;
  /** Per-request network timeout for endpoint / catalog calls (ms). */
  timeoutMs: number;
  /** Optional GitHub token → higher contents-API rate limit (5000/h vs 60/h). */
  githubToken?: string;
}

/** Git coordinates a market ref resolves to — fed straight into `stageGit`. */
export interface MarketGitTarget {
  url: string;
  ref?: string;
  subdir?: string;
}

/** A parsed GitHub `owner/repo` (used to browse a catalog via the contents API). */
interface GitHubRepo {
  owner: string;
  repo: string;
}

/** One browse hit from a configured registry endpoint. */
export interface MarketSearchEntry {
  name: string;
  description?: string;
  /** A market ref the operator can install (a bare name or `owner/repo`). */
  ref?: string;
  /** Canonical web link to the skill's source (e.g. its GitHub tree URL). */
  url?: string;
}

/** Result of a market browse — always resolves (never throws) so the UI degrades. */
export interface MarketSearchResult {
  /**
   * False only when browse is unsupported: no registry endpoint AND no
   * GitHub-browsable catalog repo configured (import by coordinate/bare name
   * instead). A configured GitHub catalog makes browse available even offline.
   */
  available: boolean;
  results: MarketSearchEntry[];
  /** Set when the endpoint / GitHub catalog was unreachable/invalid (non-fatal). */
  error?: string;
}

/** Minimal fetch shape (so tests inject a stub without a real network). */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A cached catalog directory listing (the `type:'dir'` names under a prefix). */
export interface CatalogCacheEntry {
  /** Epoch-ms after which the entry is stale and must be refetched. */
  expiresAt: number;
  names: string[];
}

/** Injectable dependencies (tests supply a fake `fetchImpl`, clock and cache). */
export interface MarketDeps {
  fetchImpl?: FetchLike;
  /** Clock for the catalog-listing cache TTL. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Store for the catalog-listing cache (key `owner/repo#prefix`). Tests pass a
   * fresh `Map` for isolation; production shares a module-global.
   */
  catalogCache?: Map<string, CatalogCacheEntry>;
}

/** Process-wide catalog-listing cache used when a caller injects none. */
const defaultCatalogCache = new Map<string, CatalogCacheEntry>();

/** Split a comma/space/newline separated env list into trimmed, non-empty entries. */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a {@link MarketPolicy} from the environment (`env` injectable for tests):
 *   SWARM_OS_SKILLS_MARKET_ENDPOINT     — optional name→git registry + /search
 *   SWARM_OS_SKILLS_MARKET_CATALOG      — bare-name catalog repos (default `anthropics/skills`)
 *   SWARM_OS_SKILLS_MARKET_PREFIX       — subdir prefix inside a catalog repo (default `skills`)
 *   SWARM_OS_SKILLS_MARKET_TIMEOUT_MS   — endpoint/catalog network timeout (default 8000)
 *   SWARM_OS_SKILLS_MARKET_GITHUB_TOKEN — optional token for the contents-API rate limit
 *
 * An operator sets `SWARM_OS_SKILLS_MARKET_CATALOG=` (empty) to disable the
 * built-in convention entirely (bare names then require an endpoint, and browse
 * reports `available:false`).
 */
export function marketPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MarketPolicy {
  const endpoint = trimOrUndefined(env.SWARM_OS_SKILLS_MARKET_ENDPOINT);
  const catalogRaw = env.SWARM_OS_SKILLS_MARKET_CATALOG;
  const catalog = splitList(catalogRaw === undefined ? DEFAULT_CATALOG : catalogRaw);
  const prefixRaw = env.SWARM_OS_SKILLS_MARKET_PREFIX;
  const catalogPrefix = (prefixRaw === undefined ? DEFAULT_PREFIX : prefixRaw).trim();
  const timeoutMs = parsePositiveInt(env.SWARM_OS_SKILLS_MARKET_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const githubToken = trimOrUndefined(env.SWARM_OS_SKILLS_MARKET_GITHUB_TOKEN);
  return {
    ...(endpoint ? { endpoint } : {}),
    catalog,
    catalogPrefix,
    timeoutMs,
    ...(githubToken ? { githubToken } : {}),
  };
}

/**
 * Resolve a market `ref` to git coordinates. Pure (no network) for coordinates
 * and for the catalog convention; only a configured endpoint reaches out.
 * Throws {@link SkillValidationError} (→422) for a bad ref and
 * {@link SkillStageError} (→502) for an unreachable endpoint.
 */
export async function resolveMarket(
  ref: string,
  policy: MarketPolicy,
  deps: MarketDeps = {},
): Promise<MarketGitTarget> {
  const raw = ref.trim();
  if (raw === '') throw new SkillValidationError('market ref is empty');

  // 1. explicit GitHub coordinate (no network).
  const coord = parseGitHubCoordinate(raw);
  if (coord) return coord;

  // A `/`-bearing or scheme-bearing ref that ISN'T a GitHub coordinate is a
  // malformed coordinate or a non-github URL — never a bare name.
  if (raw.includes('/') || raw.includes('://')) {
    throw new SkillValidationError(
      `market ref '${ref}' is not a GitHub coordinate (owner/repo[/subdir][@ref]); ` +
        `for another git host use source 'git'`,
    );
  }

  // 2. bare skill name.
  if (!isValidBareName(raw)) {
    throw new SkillValidationError(
      `market skill name '${ref}' is invalid (lowercase letters, digits and hyphens only)`,
    );
  }
  if (policy.endpoint) {
    const viaEndpoint = await resolveViaEndpoint(raw, policy, deps);
    if (viaEndpoint) return viaEndpoint;
    // endpoint returned "not found" → fall through to the catalog convention.
  }
  return resolveViaCatalog(raw, policy);
}

/**
 * Browse the market for skills matching `query`. NEVER throws; resolution order:
 *   (a) a configured registry endpoint  → `GET <endpoint>/search?q=` (as before);
 *   (b) else a GitHub catalog repo       → list `<prefix>/` dirs via the GitHub
 *       contents API (each dir = a skill, `ref` re-injectable into install);
 *   (c) else (no endpoint, no catalog)   → `{available:false}` (import by coordinate).
 *
 * Any transport/timeout/HTTP/parse failure degrades to
 * `{available:true, results:[], error}` — `available` stays TRUE whenever browse
 * is *supported* (an endpoint or catalog exists), so the UI shows a degraded
 * state, not a "browse unavailable" hint. `fetchImpl` is injectable for tests.
 */
export async function searchMarket(
  query: string,
  policy: MarketPolicy,
  deps: MarketDeps = {},
): Promise<MarketSearchResult> {
  // (a) a configured registry endpoint takes precedence (unchanged behaviour).
  if (policy.endpoint) {
    const url = `${trimTrailingSlash(policy.endpoint)}/search?q=${encodeURIComponent(query)}`;
    try {
      const data = await fetchJson(url, policy.timeoutMs, deps);
      return { available: true, results: normalizeSearch(data) };
    } catch (err) {
      return { available: true, results: [], error: errText(err) };
    }
  }
  // (b) no endpoint but a GitHub catalog repo → browse its `<prefix>/` directory.
  const repo = catalogGitHubRepo(policy);
  if (repo) return browseGitHubCatalog(query, repo, policy, deps);

  // (c) neither an endpoint nor a browsable GitHub catalog → browse unsupported.
  return { available: false, results: [] };
}

/**
 * Browse the GitHub catalog repo's `<prefix>/` directory, cached per repo+prefix
 * (see {@link CATALOG_CACHE_TTL_MS}). Filters dir names by `query` (case-insensitive
 * substring) and maps each to a re-injectable `ref` (`owner/repo/<prefix>/<name>`).
 * Never throws — a failure yields `{available:true, results:[], error}`.
 */
async function browseGitHubCatalog(
  query: string,
  repo: GitHubRepo,
  policy: MarketPolicy,
  deps: MarketDeps,
): Promise<MarketSearchResult> {
  const prefix = stripSlashes(policy.catalogPrefix);
  const cache = deps.catalogCache ?? defaultCatalogCache;
  const now = deps.now ?? Date.now;
  const key = `${repo.owner}/${repo.repo}#${prefix}`;

  let names: string[];
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) {
    names = hit.names;
  } else {
    try {
      names = await fetchCatalogDirNames(repo, prefix, policy, deps);
    } catch (err) {
      return { available: true, results: [], error: errText(err) };
    }
    cache.set(key, { names, expiresAt: now() + CATALOG_CACHE_TTL_MS });
  }
  return { available: true, results: filterCatalog(names, query, repo, prefix) };
}

/**
 * GET the `type:'dir'` names under `<owner>/<repo>/<prefix>` from the GitHub
 * contents API (bounded by an AbortController timeout). Throws a plain Error on
 * any failure (the caller degrades it to a non-fatal `error`).
 */
async function fetchCatalogDirNames(
  repo: GitHubRepo,
  prefix: string,
  policy: MarketPolicy,
  deps: MarketDeps,
): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? globalFetch();
  if (!fetchImpl) throw new Error('no fetch implementation available for the GitHub catalog');

  const path = prefix ? `/${prefix}` : '';
  const url = `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/contents${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub's REST API rejects requests without a User-Agent.
    'User-Agent': 'swarm-os-skills',
  };
  if (policy.githubToken) headers.Authorization = `Bearer ${policy.githubToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers });
  } catch (err) {
    throw new Error(`GitHub catalog ${url} unreachable: ${errText(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 403) throw new Error(`GitHub catalog ${url} rate-limited or forbidden (HTTP 403)`);
  if (res.status === 404) throw new Error(`GitHub catalog path not found (HTTP 404): ${url}`);
  if (!res.ok) throw new Error(`GitHub catalog ${url} returned HTTP ${res.status}`);

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`GitHub catalog ${url} returned invalid JSON: ${errText(err)}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`unexpected GitHub contents payload for ${url} (expected an array)`);
  }
  const names: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (r.type === 'dir' && typeof r.name === 'string' && r.name.length > 0) names.push(r.name);
  }
  return names;
}

/** Filter cached dir names by `query` and map each to a re-injectable market ref. */
function filterCatalog(
  names: string[],
  query: string,
  repo: GitHubRepo,
  prefix: string,
): MarketSearchEntry[] {
  const q = query.trim().toLowerCase();
  const out: MarketSearchEntry[] = [];
  for (const name of names) {
    if (q && !name.toLowerCase().includes(q)) continue;
    const subPath = prefix ? `${prefix}/${name}` : name;
    out.push({
      name,
      ref: `${repo.owner}/${repo.repo}/${subPath}`,
      // Canonical web link to the skill's source dir. `tree/HEAD` auto-tracks the
      // repo's default branch (verified HTTP 200 for anthropics/skills; `tree/main`
      // also resolves 200 but HEAD avoids hardcoding a branch name).
      url: `https://github.com/${repo.owner}/${repo.repo}/tree/HEAD/${subPath}`,
    });
  }
  return out;
}

/** The first catalog entry as a GitHub `{owner,repo}`, or null if it isn't one. */
function catalogGitHubRepo(policy: MarketPolicy): GitHubRepo | null {
  const first = policy.catalog[0];
  if (!first) return null;
  let coord: MarketGitTarget | null;
  try {
    coord = parseGitHubCoordinate(first);
  } catch {
    return null; // traversal / malformed — not browsable
  }
  if (!coord) return null; // a non-GitHub git url (gitlab, file://, …)
  const m = coord.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

// ---------------------------------------------------------------------------
// resolution helpers
// ---------------------------------------------------------------------------

/** Resolve a bare name against the first configured catalog repo. */
function resolveViaCatalog(name: string, policy: MarketPolicy): MarketGitTarget {
  const repo = policy.catalog[0];
  if (!repo) {
    throw new SkillValidationError(
      `cannot resolve market skill '${name}': no registry endpoint and no catalog configured — ` +
        `install it by GitHub coordinate ('owner/repo[/subdir]') or set SWARM_OS_SKILLS_MARKET_CATALOG`,
    );
  }
  const url = toGitUrl(repo);
  const subdir = policy.catalogPrefix ? `${policy.catalogPrefix}/${name}` : name;
  return { url, subdir };
}

/** Query the endpoint for a name → git coordinates. Null = 404 (not in registry). */
async function resolveViaEndpoint(
  name: string,
  policy: MarketPolicy,
  deps: MarketDeps,
): Promise<MarketGitTarget | null> {
  const url = `${trimTrailingSlash(policy.endpoint!)}/skills/${encodeURIComponent(name)}`;
  const data = await fetchJson(url, policy.timeoutMs, deps); // throws SkillStageError on failure
  if (data === null) return null; // 404 → caller falls back to the catalog
  const d = asRecord(data);
  const source = typeof d.source === 'string' ? d.source : 'git';
  if (source !== 'git') {
    throw new SkillValidationError(
      `market endpoint resolved '${name}' to unsupported source '${source}' ` +
        `(Lot 4a supports git-backed resolution)`,
    );
  }
  const gitUrl = typeof d.url === 'string' ? d.url.trim() : '';
  if (gitUrl === '') {
    throw new SkillValidationError(`market endpoint resolution for '${name}' is missing a git url`);
  }
  const gitRef = strOrUndefined(d.ref);
  const subdir = strOrUndefined(d.subdir);
  if (subdir && subdir.includes('..')) {
    throw new SkillValidationError(`market endpoint subdir '${subdir}' must not contain '..'`);
  }
  return { url: gitUrl, ...(gitRef ? { ref: gitRef } : {}), ...(subdir ? { subdir } : {}) };
}

/**
 * Parse a GitHub coordinate → git coordinates, or null when `raw` is not one
 * (a bare name, or a non-github URL). Throws only on a traversal attempt.
 */
export function parseGitHubCoordinate(raw: string): MarketGitTarget | null {
  let s = raw.trim();
  if (s.startsWith('github:')) s = s.slice('github:'.length);

  const hasScheme = /:\/\//.test(s);
  if (hasScheme) {
    const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/i);
    if (!m) return null; // some other host — not a market coordinate
    return parseGitHubPath(m[1]!);
  }
  const bareHost = s.match(/^(?:www\.)?github\.com\/(.+)$/i);
  if (bareHost) return parseGitHubPath(bareHost[1]!);

  if (s.includes('/')) return parseGitHubPath(s);
  return null; // single token, no host → a bare name
}

/**
 * Parse the `<owner>/<repo>[...]` portion of a coordinate. Supports `@ref` on the
 * repo segment, a trailing mono-repo `subdir`, and the GitHub web
 * `/tree/<branch>/<subpath>` form.
 */
function parseGitHubPath(pathStr: string): MarketGitTarget | null {
  const parts = pathStr.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return null;

  const owner = parts[0]!;
  let repoSeg = parts[1]!;
  let rest = parts.slice(2);

  let ref: string | undefined;
  const at = repoSeg.indexOf('@');
  if (at >= 0) {
    ref = repoSeg.slice(at + 1) || undefined;
    repoSeg = repoSeg.slice(0, at);
  }
  const repo = repoSeg.replace(/\.git$/i, '');

  let subdir: string | undefined;
  if (rest[0] === 'tree' && rest.length >= 2) {
    // GitHub web URL: /tree/<branch>/<subpath...>
    ref = rest[1];
    subdir = rest.slice(2).join('/') || undefined;
  } else if (rest.length > 0) {
    subdir = rest.join('/');
  }

  if (!isValidSegment(owner) || !isValidSegment(repo)) return null;
  if (subdir && subdir.split('/').some((seg) => seg === '..')) {
    throw new SkillValidationError(`market subdir '${subdir}' must not contain '..'`);
  }
  return {
    url: `https://github.com/${owner}/${repo}.git`,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
  };
}

/** `owner/repo` slug → github https url; a full git url passes through unchanged. */
function toGitUrl(repo: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith('git@') || repo.startsWith('file:')) {
    return repo;
  }
  return `https://github.com/${repo.replace(/\.git$/i, '')}.git`;
}

// ---------------------------------------------------------------------------
// network + parsing utilities
// ---------------------------------------------------------------------------

/**
 * GET `url` as JSON with a timeout. Returns null on HTTP 404 (a clean "absent"),
 * throws {@link SkillStageError} on any transport/timeout/non-2xx failure. Never
 * throws anything else, so callers only handle those two outcomes.
 */
async function fetchJson(url: string, timeoutMs: number, deps: MarketDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? globalFetch();
  if (!fetchImpl) throw new SkillStageError('no fetch implementation available for the market endpoint');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new SkillStageError(`market endpoint ${url} returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof SkillStageError) throw err;
    throw new SkillStageError(`market endpoint ${url} unreachable: ${errText(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The runtime's global `fetch` (Node ≥18), or undefined on an ancient runtime. */
function globalFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === 'function' ? (f as FetchLike) : undefined;
}

/** Normalize an endpoint's search payload (`{results:[…]}` or a bare array). */
function normalizeSearch(data: unknown): MarketSearchEntry[] {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown })?.results)
      ? (data as { results: unknown[] }).results
      : [];
  const out: MarketSearchEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name : undefined;
    if (!name) continue;
    const description = typeof r.description === 'string' ? r.description : undefined;
    const entryRef = typeof r.ref === 'string' ? r.ref : undefined;
    // Propagate a canonical web link if the endpoint supplies one under any of the
    // common keys; stays undefined (never throws) when absent or non-string.
    const entryUrl =
      typeof r.url === 'string'
        ? r.url
        : typeof r.html_url === 'string'
          ? r.html_url
          : typeof r.homepage === 'string'
            ? r.homepage
            : undefined;
    out.push({
      name,
      ...(description ? { description } : {}),
      ...(entryRef ? { ref: entryRef } : {}),
      ...(entryUrl ? { url: entryUrl } : {}),
    });
  }
  return out;
}

/** A bare skill name: lowercase letters, digits and single hyphens (spec §name). */
function isValidBareName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** A single path segment safe to interpolate into a URL (no traversal, no scheme). */
function isValidSegment(seg: string): boolean {
  return seg.length > 0 && seg !== '.' && seg !== '..' && /^[A-Za-z0-9._-]+$/.test(seg);
}

function trimOrUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Strip leading & trailing slashes (a catalog prefix normalised into a path segment). */
function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

function parsePositiveInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
