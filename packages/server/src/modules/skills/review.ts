/**
 * Skill review surface (docs/plan-skills-importables.md §9, Lot 3) — read-only
 * inspection of a skill's `assets/` tree so an operator (via the Lot 3b
 * `SkillReviewDialog`) can SEE the executable content before approving it.
 *
 * Nothing here runs skill code: it lists file metadata (path, size, executable
 * bit) and returns text file contents, with a hard anti-traversal guard so a
 * crafted `path` can never escape the skill's assets directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillRow } from './store.js';

/** One file in a skill's `assets/` dir, as shown in the review dialog. */
export interface SkillAssetEntry {
  /** Path RELATIVE to the assets dir, forward-slashed. */
  path: string;
  /** Byte size. */
  size: number;
  /** True when any executable bit is set (a script an agent may run). */
  executable: boolean;
  /** True when the bytes look like UTF-8 text (safe to show inline). */
  isText: boolean;
}

/** Max bytes returned for a single asset's inline content. */
const MAX_ASSET_BYTES = 256 * 1024;

/** The declared assets subdir of a skill, or null when it ships none. */
export function assetsSubdir(row: SkillRow): string | null {
  if (!row.assets_present || !row.frontmatter_json) return null;
  try {
    const fm = JSON.parse(row.frontmatter_json) as { assets?: { dir?: unknown } };
    return typeof fm.assets?.dir === 'string' ? fm.assets.dir : null;
  } catch {
    return null;
  }
}

/** Absolute path of a skill's assets dir on disk (null when none / unresolved). */
function assetsRoot(skillsDir: string, row: SkillRow): string | null {
  const sub = assetsSubdir(row);
  if (sub === null) return null;
  const skillDir = path.join(skillsDir, row.name);
  const root = path.resolve(skillDir, sub);
  // Anti-traversal: the assets dir must stay inside the skill folder.
  const rel = path.relative(path.resolve(skillDir), root);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return root;
}

/** Heuristic: bytes are "text" when they carry no NUL in the sampled prefix. */
function looksText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/**
 * List every file in a skill's assets dir (recursively), sorted by path. Empty
 * array when the skill ships no assets or the dir is unreadable — never throws.
 */
export function listSkillAssets(skillsDir: string, row: SkillRow): SkillAssetEntry[] {
  const root = assetsRoot(skillsDir, row);
  if (!root) return [];
  const out: SkillAssetEntry[] = [];
  const walk = (abs: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const child = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        walk(child);
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(child);
        const rel = path.relative(root, child).split(path.sep).join('/');
        let isText = false;
        try {
          isText = looksText(fs.readFileSync(child).subarray(0, 8192));
        } catch {
          /* keep isText=false */
        }
        out.push({
          path: rel,
          size: st.size,
          executable: (st.mode & 0o111) !== 0,
          isText,
        });
      } catch {
        /* skip unreadable entry */
      }
    }
  };
  walk(root);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Result of reading one asset's content. */
export interface SkillAssetContent {
  path: string;
  size: number;
  executable: boolean;
  isText: boolean;
  /** UTF-8 content (capped at MAX_ASSET_BYTES); empty for binary. */
  content: string;
  /** True when the file was larger than the cap and content is clipped. */
  truncated: boolean;
  /** True when the file is not text (content withheld). */
  binary: boolean;
}

/**
 * Read a single asset's content by its assets-relative `relPath`. Returns null
 * when the skill has no assets, the path escapes the assets dir, or the file is
 * missing. Binary files return metadata with an empty `content`.
 */
export function readSkillAsset(
  skillsDir: string,
  row: SkillRow,
  relPath: string,
): SkillAssetContent | null {
  const root = assetsRoot(skillsDir, row);
  if (!root) return null;
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const isText = looksText(buf.subarray(0, 8192));
  const truncated = buf.length > MAX_ASSET_BYTES;
  const clipped = truncated ? buf.subarray(0, MAX_ASSET_BYTES) : buf;
  return {
    path: rel.split(path.sep).join('/'),
    size: st.size,
    executable: (st.mode & 0o111) !== 0,
    isText,
    content: isText ? clipped.toString('utf8') : '',
    truncated,
    binary: !isText,
  };
}
