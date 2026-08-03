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
 * unreachable ⇒ resolution throws a clean {@link SkillStageError} (HTTP 502) and
 * {@link searchMarket} returns `{available:true, results:[], error}`. A missing
 * global `fetch` (very old Node) is treated as "endpoint unavailable", never a
 * crash.
 */

import { SkillValidationError, SkillStageError } from './stage.js';

/** Default catalog repo for bare-name resolution (the canonical public repo). */
const DEFAULT_CATALOG = 'anthropics/skills';
/** Default path prefix a bare name nests under inside a catalog repo. */
const DEFAULT_PREFIX = 'skills';
/** Default per-request network timeout for endpoint calls (ms). */
const DEFAULT_TIMEOUT_MS = 8_000;

/** How a bare name / coordinate is resolved. */
export interface MarketPolicy {
  /** Optional base URL of a name→git registry + search index. Unset ⇒ convention-only. */
  endpoint?: string;
  /** Ordered repos a BARE name resolves against (`owner/repo` or a full git url). */
  catalog: string[];
  /** Path prefix inside a catalog repo a bare name nests under (`skills`; '' = root). */
  catalogPrefix: string;
  /** Per-request network timeout for endpoint calls (ms). */
  timeoutMs: number;
}

/** Git coordinates a market ref resolves to — fed straight into `stageGit`. */
export interface MarketGitTarget {
  url: string;
  ref?: string;
  subdir?: string;
}

/** One browse hit from a configured registry endpoint. */
export interface MarketSearchEntry {
  name: string;
  description?: string;
  /** A market ref the operator can install (a bare name or `owner/repo`). */
  ref?: string;
}

/** Result of a market browse — always resolves (never throws) so the UI degrades. */
export interface MarketSearchResult {
  /** False when no endpoint is configured (browse unsupported — import by coordinate). */
  available: boolean;
  results: MarketSearchEntry[];
  /** Set when a configured endpoint was unreachable/invalid (non-fatal). */
  error?: string;
}

/** Minimal fetch shape (so tests inject a stub without a real network). */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Injectable dependencies (tests supply a fake `fetchImpl`). */
export interface MarketDeps {
  fetchImpl?: FetchLike;
}

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
 *   SWARM_OS_SKILLS_MARKET_ENDPOINT    — optional name→git registry + /search
 *   SWARM_OS_SKILLS_MARKET_CATALOG     — bare-name catalog repos (default `anthropics/skills`)
 *   SWARM_OS_SKILLS_MARKET_PREFIX      — subdir prefix inside a catalog repo (default `skills`)
 *   SWARM_OS_SKILLS_MARKET_TIMEOUT_MS  — endpoint network timeout (default 8000)
 *
 * An operator sets `SWARM_OS_SKILLS_MARKET_CATALOG=` (empty) to disable the
 * built-in convention entirely (bare names then require an endpoint).
 */
export function marketPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MarketPolicy {
  const endpoint = trimOrUndefined(env.SWARM_OS_SKILLS_MARKET_ENDPOINT);
  const catalogRaw = env.SWARM_OS_SKILLS_MARKET_CATALOG;
  const catalog = splitList(catalogRaw === undefined ? DEFAULT_CATALOG : catalogRaw);
  const prefixRaw = env.SWARM_OS_SKILLS_MARKET_PREFIX;
  const catalogPrefix = (prefixRaw === undefined ? DEFAULT_PREFIX : prefixRaw).trim();
  const timeoutMs = parsePositiveInt(env.SWARM_OS_SKILLS_MARKET_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  return { ...(endpoint ? { endpoint } : {}), catalog, catalogPrefix, timeoutMs };
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
 * Browse a configured registry endpoint. NEVER throws: no endpoint ⇒
 * `{available:false}`; an unreachable/invalid endpoint ⇒
 * `{available:true, results:[], error}`. Lets a browse UI degrade gracefully.
 */
export async function searchMarket(
  query: string,
  policy: MarketPolicy,
  deps: MarketDeps = {},
): Promise<MarketSearchResult> {
  if (!policy.endpoint) return { available: false, results: [] };
  const url = `${trimTrailingSlash(policy.endpoint)}/search?q=${encodeURIComponent(query)}`;
  try {
    const data = await fetchJson(url, policy.timeoutMs, deps);
    return { available: true, results: normalizeSearch(data) };
  } catch (err) {
    return { available: true, results: [], error: errText(err) };
  }
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
    out.push({
      name,
      ...(description ? { description } : {}),
      ...(entryRef ? { ref: entryRef } : {}),
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
