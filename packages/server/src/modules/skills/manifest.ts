/**
 * Skill manifest — `SKILL.md` (YAML frontmatter subset + body) parser.
 *
 * A "skill" (docs/plan-skills-importables.md) is DATA: a folder holding a
 * `SKILL.md` whose YAML frontmatter carries the metadata and whose body is the
 * instruction text injected into an agent's preamble. `skill.json` is an
 * OPTIONAL swarm-os superset for fields the frontmatter does not carry.
 *
 * Lot 0 (spike) parses a deliberately SMALL YAML subset with a self-contained
 * parser — NO new dependency (the repo ships `js-yaml` only as a transitive,
 * undeclared package the server must not import). The supported subset:
 *   - `key: scalar`            → string | number | boolean | null
 *   - `key: "…"` / `'…'`       → quoted string (escapes not interpreted)
 *   - `key: [a, b, c]`         → inline (flow) array
 *   - `key: { k: v, … }`       → inline (flow) map
 *   - `# comment` / blank line → ignored
 * Block-style nesting is intentionally unsupported here; nested structures
 * (`requires`, `assets`) use flow style. A full YAML parser can replace this in
 * a later lot IF a dependency is approved.
 *
 * Nothing here executes skill code — a skill is data-first
 * (docs/plan-skills-importables.md §0).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLUGIN_NAME_RE, RESERVED_NAMES } from '../plugins/manifest.js';

/** File that holds a skill's metadata + instructions. */
export const SKILL_FILE = 'SKILL.md';
/** Optional swarm-os superset metadata file. */
export const SKILL_JSON_FILE = 'skill.json';

/**
 * A skill name doubles as a slug (future route/tool prefix), so it reuses the
 * plugin name rule and the same reserved-namespace set.
 */
export const SKILL_NAME_RE = PLUGIN_NAME_RE;

export interface SkillRequires {
  /** Plugins that must be installed+enabled for this skill to work (§0). */
  plugins?: string[];
  /** Plugin capabilities implied when the skill ships executable assets. */
  capabilities?: string[];
}

export interface SkillFrontmatter {
  /** Slug, PK. Matches `SKILL_NAME_RE`, not in `RESERVED_NAMES`. */
  name: string;
  /** Version string (semver recommended; quote it to avoid YAML number coercion). */
  version: string;
  displayName?: string;
  description?: string;
  triggers?: string[];
  requires?: SkillRequires;
  assets?: { dir: string };
}

export interface ParsedSkill {
  /** Validated metadata (`name`/`version` guaranteed present). */
  frontmatter: SkillFrontmatter;
  /** Markdown body AFTER the frontmatter block — the injected instructions. */
  body: string;
  /** Convenience mirror of `frontmatter.name`. */
  name: string;
  /** Convenience mirror of `frontmatter.version`. */
  version: string;
}

// ---------------------------------------------------------------------------
// YAML-subset value parsing (flow style only)
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

/** Split `s` on `sep`, ignoring separators inside `[]`/`{}` or quotes. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Index of the first `ch` at bracket/quote depth 0, or -1. */
function indexOfTopLevel(s: string, ch: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function isQuoted(s: string): boolean {
  if (s.length < 2) return false;
  const first = s[0];
  const last = s[s.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'");
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s.length === 0) return null;
  if (isQuoted(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Parse one YAML-subset value: flow array, flow map, or scalar. */
function parseFlowValue(raw: string): YamlValue {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitTopLevel(inner, ',').map((e) => parseFlowValue(e));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const map: { [k: string]: YamlValue } = {};
    if (inner.length === 0) return map;
    for (const pair of splitTopLevel(inner, ',')) {
      const idx = indexOfTopLevel(pair, ':');
      if (idx < 0) continue;
      const key = parseScalar(pair.slice(0, idx));
      if (typeof key !== 'string') continue;
      map[key] = parseFlowValue(pair.slice(idx + 1));
    }
    return map;
  }
  return parseScalar(s);
}

/** Parse the frontmatter block text into a flat record (top-level keys only). */
function parseFrontmatterBlock(block: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // Indented lines belong to block-style nesting, which the spike does not
    // support (nested structures must be written in flow style). Skip them.
    if (/^\s/.test(rawLine)) continue;
    const idx = indexOfTopLevel(rawLine, ':');
    if (idx < 0) continue;
    const key = rawLine.slice(0, idx).trim();
    if (key.length === 0) continue;
    const valuePart = rawLine.slice(idx + 1).trim();
    out[key] = valuePart.length === 0 ? null : parseFlowValue(valuePart);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter split
// ---------------------------------------------------------------------------

export interface SplitResult {
  /** Raw frontmatter block between the `---` fences (empty when there is none). */
  frontmatter: string;
  /** Everything after the closing fence (the whole text when there is no block). */
  body: string;
}

/**
 * Split a `SKILL.md` string into its `---`-delimited frontmatter block and the
 * body that follows. A missing/opening-only block yields an empty frontmatter
 * and the full text as the body (validation then fails on the missing `name`).
 */
export function splitFrontmatter(raw: string): SplitResult {
  // Strip a leading BOM so the `^---` anchor still matches.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*)|$)/.exec(text);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

/** Relative path that stays inside the skill folder (anti-traversal). */
function isSafeRelDir(p: string): boolean {
  if (p.length === 0) return false;
  if (path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  if (normalized.startsWith('..')) return false;
  if (normalized.split(/[\\/]/).includes('..')) return false;
  return true;
}

function validateRequires(v: unknown, file: string): SkillRequires {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`invalid skill: 'requires' must be a map (${file})`);
  }
  const obj = v as Record<string, unknown>;
  const out: SkillRequires = {};
  if (obj.plugins !== undefined) {
    if (!isStringArray(obj.plugins)) {
      throw new Error(`invalid skill: 'requires.plugins' must be an array of strings (${file})`);
    }
    out.plugins = obj.plugins;
  }
  if (obj.capabilities !== undefined) {
    if (!isStringArray(obj.capabilities)) {
      throw new Error(
        `invalid skill: 'requires.capabilities' must be an array of strings (${file})`,
      );
    }
    out.capabilities = obj.capabilities;
  }
  return out;
}

function validateAssets(v: unknown, file: string): { dir: string } {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`invalid skill: 'assets' must be a map with a 'dir' (${file})`);
  }
  const dir = (v as Record<string, unknown>).dir;
  if (typeof dir !== 'string' || !isSafeRelDir(dir)) {
    throw new Error(`invalid skill: 'assets.dir' must be a relative path inside the skill (${file})`);
  }
  return { dir };
}

/**
 * Validate + narrow a raw frontmatter record into a `SkillFrontmatter`. Unknown
 * keys are dropped (forward-compat is tolerated by ignoring, not by preserving,
 * in the spike). Throws a descriptive `Error` on a missing/invalid field.
 */
function validateFrontmatter(raw: Record<string, unknown>, file: string): SkillFrontmatter {
  const name = raw.name;
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill: 'name' must match ${SKILL_NAME_RE} (${file})`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`invalid skill: name '${name}' is reserved by a built-in namespace (${file})`);
  }
  const version = raw.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error(`invalid skill: 'version' must be a non-empty string (${file})`);
  }

  const fm: SkillFrontmatter = { name, version };
  if (typeof raw.displayName === 'string') fm.displayName = raw.displayName;
  if (typeof raw.description === 'string') fm.description = raw.description;
  if (raw.triggers !== undefined) {
    if (!isStringArray(raw.triggers)) {
      throw new Error(`invalid skill: 'triggers' must be an array of strings (${file})`);
    }
    fm.triggers = raw.triggers;
  }
  if (raw.requires !== undefined) fm.requires = validateRequires(raw.requires, file);
  if (raw.assets !== undefined) fm.assets = validateAssets(raw.assets, file);
  return fm;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Read + parse the optional `skill.json` superset. Returns `{}` when absent. */
function readSkillJson(dir: string): Record<string, unknown> {
  const file = path.join(dir, SKILL_JSON_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `skill.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Read + validate `<dir>/SKILL.md` (and merge an optional `<dir>/skill.json`
 * base, frontmatter winning on conflicts). Throws a descriptive `Error` on a
 * missing file or a schema violation — callers translate that into an HTTP 422
 * / a `last_error`.
 */
export function parseSkillMd(dir: string): ParsedSkill {
  const file = path.join(dir, SKILL_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`SKILL.md not found: ${file}`);
  }
  const { frontmatter: block, body } = splitFrontmatter(raw);
  const parsed = parseFrontmatterBlock(block);
  const merged: Record<string, unknown> = { ...readSkillJson(dir), ...parsed };
  const frontmatter = validateFrontmatter(merged, file);
  return { frontmatter, body, name: frontmatter.name, version: frontmatter.version };
}
