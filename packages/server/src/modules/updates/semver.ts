/**
 * Version comparison — the whole of it, in one file, with no dependency.
 *
 * WHY no `semver` package: we compare exactly two kinds of string — a release
 * tag we publish ourselves (`v0.6.0`) and `config.version` — and we need the
 * comparison to be inspectable when it decides to show an operator a badge.
 * A 60 kB dependency whose range grammar we never use would be more surface,
 * not less.
 *
 * WHY `null` instead of a throw or a `0` on garbage: `config.version` legally
 * resolves to `'dev'` when running from source, and a tag is operator-typed.
 * Returning `0` ("equal") from an unparsable input would silently mean "no
 * update available", i.e. a broken detector that looks healthy. `null` is
 * "cannot compare" and forces every caller to name what it does about it.
 *
 * Pre-releases: their identifiers are NOT ordered against each other (we don't
 * ship `rc2`-after-`rc1` chains, and inventing an order we never exercise is
 * untested code by definition). But a pre-release is never >= its own release —
 * `1.0.0-rc1 < 1.0.0` — because the opposite would offer an operator a
 * downgrade dressed as an update.
 */

/** `v`-tolerant, build-metadata-tolerant. Capture 4 = pre-release, if any. */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier without its leading `-`; `null` for a release. */
  prerelease: string | null;
}

/** Parse `[v]X.Y.Z[-pre][+build]`; `null` for anything else (incl. `'dev'`). */
export function parseVersion(input: string | null | undefined): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * `-1` / `0` / `1` for a < b, a == b, a > b — and `null` when either side is
 * unparsable. Two different pre-releases of the same triple compare equal.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  const preA = pa.prerelease !== null;
  const preB = pb.prerelease !== null;
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

/**
 * The only predicate the detector should use: strictly-newer, and `false`
 * whenever the answer isn't knowable. Never claims an update on garbage.
 */
export function isNewer(candidate: string | null | undefined, current: string | null | undefined): boolean {
  return compareVersions(candidate, current) === 1;
}

/** Tag → comparable version string (`v0.6.0` → `0.6.0`); input unchanged if unparsable. */
export function tagToVersion(tag: string): string {
  const t = tag.trim();
  return /^v\d/.test(t) ? t.slice(1) : t;
}
