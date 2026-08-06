/**
 * Filesystem scanning for codegraph: the C3 "is there any code?" gate and the
 * change-detection fingerprint. Both ride the SAME recursive walk (skipping
 * whatever `shouldSkipDir` rejects, symlinks, and going no deeper than
 * `MAX_WALK_FILES`) so the set of files that decides "index this scope" is
 * exactly the set whose mtimes decide "re-index this scope".
 *
 * Everything here is best-effort and NEVER throws: an unreadable dir is skipped
 * with a debug log, because a janitor tick must survive a permission hiccup on
 * one subtree of one scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withModule } from '../../logger.js';
import { CODE_EXTENSIONS, MAX_WALK_FILES } from './constants.js';
import { shouldSkipDir } from './ignore.js';

const log = withModule('codegraph.scan');

/** A visited code file: repo-relative path + size + mtime (ms), for hashing. */
interface FileStat {
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * Walk `root` depth-first, invoking `onFile(relPath, stat)` for every regular
 * file under a non-ignored directory. Return `false` from `onFile` to stop the
 * walk early (used by the code gate to bail on the first hit). Symlinks — file
 * or dir — are skipped to avoid escaping the scope or looping. `extraExcludes`
 * is an extra set of directory NAMES to skip (e.g. the workspace-root scope
 * skips its child project-scope dirs so it doesn't re-scan the whole workspace).
 * Best-effort: unreadable directories are logged at debug and skipped.
 */
function walk(
  root: string,
  onFile: (rel: string, st: fs.Stats) => boolean,
  extraExcludes?: ReadonlySet<string>,
): void {
  let visited = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.debug({ event: 'codegraph.walk_readdir_failed', dir, error: String(err) });
      continue;
    }
    for (const ent of entries) {
      // Never follow symlinks: a symlinked dir could point outside the scope
      // (escaping C1) or form a cycle; a symlinked file is not first-party source.
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Order matters for COST, not for outcome (both branches just skip):
        // `extraExcludes` is a Set lookup, while `shouldSkipDir` may pay an
        // `existsSync` for the structural virtualenv probe. Cheapest test first.
        // `lifecycle.ts`'s watcher walk applies the same two gates in the same
        // order — they must agree, or we would watch a directory the fingerprint
        // never reads (or worse, stop watching one it does).
        if (extraExcludes?.has(ent.name)) continue;
        // Name-based skip PLUS structural virtualenv detection (`pyvenv.cfg`):
        // a `.venv-intraday` matches no exact name but is still 656 dirs of
        // third-party Python we must never walk. `full` is already computed, so
        // this costs at most one extra existsSync per directory.
        if (shouldSkipDir(full, ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (++visited > MAX_WALK_FILES) {
        log.warn({ event: 'codegraph.walk_capped', root, cap: MAX_WALK_FILES });
        return;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!onFile(path.relative(root, full), st)) return;
    }
  }
}

/** True if `ext` (with leading dot, any case) is a first-party code extension. */
export function isCodeExtension(ext: string): boolean {
  return CODE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * C3 gate: does `root` contain at least one first-party code file (excluding
 * dependency / build / VCS dirs)? Stops at the first hit. A docs-only tree
 * (`.md` only) returns `false` → the scope is NOT indexed.
 */
export function hasCodeFiles(root: string, extraExcludes?: ReadonlySet<string>): boolean {
  let found = false;
  walk(
    root,
    (rel) => {
      if (isCodeExtension(path.extname(rel))) {
        found = true;
        return false; // stop the walk
      }
      return true;
    },
    extraExcludes,
  );
  return found;
}

export interface SourceFingerprint {
  /** Number of first-party code files considered. */
  fileCount: number;
  /**
   * Stable SHA-256 over the sorted (path, size, mtime) tuples of every code
   * file. Changes iff a code file is added, removed, or its size/mtime moved —
   * cheap and good enough to gate a graphify run (we never need cryptographic
   * collision resistance, just "did the code change since last index?").
   */
  hash: string;
}

/**
 * Compute a change-detection fingerprint of the first-party code under `root`.
 * ONLY code files count (same extension set as the gate) so a docs edit doesn't
 * trigger a code re-index. Deterministic: entries are sorted before hashing.
 */
export function sourceFingerprint(root: string, extraExcludes?: ReadonlySet<string>): SourceFingerprint {
  const files: FileStat[] = [];
  walk(
    root,
    (rel, st) => {
      if (isCodeExtension(path.extname(rel))) {
        files.push({ rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
      return true;
    },
    extraExcludes,
  );
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    h.update(String(f.size));
    h.update('\0');
    h.update(String(f.mtimeMs));
    h.update('\n');
  }
  return { fileCount: files.length, hash: h.digest('hex') };
}
