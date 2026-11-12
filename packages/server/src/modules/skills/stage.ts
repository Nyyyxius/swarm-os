/**
 * Skill staging — fetch a skill from a source into an isolated staging dir.
 *
 * Data-first (docs/internal/skills/plan-skills-importables.md §0): unlike the plugin installer
 * this runs NO `npm install` and NO `import()` — it only fetches/extracts files
 * (via the shared `install-core` primitives) and computes a provenance checksum.
 * Sources: `dir`, `upload` (.tgz), `npm`, `git` (+ optional `subdir`) and
 * `market` (Lot 4). A `market` ref is NOT staged here — the installer resolves
 * it to git coordinates (`market.ts`) and delegates to `stageGit`, so market
 * inherits the exact same data-first clone path (docs/internal/skills/skills-lot4-contract.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SKILL_FILE } from './manifest.js';
import {
  makeRunner,
  extractTgzFile,
  extractTgzBuffer,
  npmPack,
  gitClone,
  gitHeadCommit,
  isSafeSubdir,
  type Runner,
} from '../install-core/fetch.js';

/** Fetch wall-clock cap (skills carry no deps, so this only bounds clone/pack/tar). */
const EXEC_TIMEOUT_MS = 120_000;

/** Bad SKILL.md / name / traversal → HTTP 422. */
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

/** tar / npm / git fetch failure → HTTP 502 (stderr in the message). */
export class SkillStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillStageError';
  }
}

export type SkillInstallSource =
  | { kind: 'dir'; dir: string }
  | { kind: 'upload'; tgz: Buffer; name?: string }
  | { kind: 'npm'; spec: string }
  | { kind: 'git'; url: string; ref?: string; subdir?: string }
  // `ref` is a market identifier (a bare skill name or a GitHub `owner/repo`
  // coordinate), NOT a git ref — the installer resolves it via `market.ts`.
  | { kind: 'market'; ref: string };

/** An install-core runner that throws `SkillStageError` on fetch failure. */
export function makeSkillRunner(npmCacheDir: string, timeoutMs = EXEC_TIMEOUT_MS): Runner {
  return makeRunner({ timeoutMs, npmCacheDir, sourceError: (m) => new SkillStageError(m) });
}

/** Copy a local skill folder into `destDir`. Requires a `SKILL.md` at its root. */
export function stageDir(srcDir: string, destDir: string): void {
  const abs = path.resolve(srcDir);
  if (!fs.existsSync(path.join(abs, SKILL_FILE))) {
    throw new SkillValidationError(`no ${SKILL_FILE} in directory '${srcDir}'`);
  }
  fs.cpSync(abs, destDir, { recursive: true });
}

/** Extract an uploaded `.tgz` (npm pack format) into `destDir`. */
export async function stageUpload(
  run: Runner,
  tgz: Buffer,
  destDir: string,
  tmpTgzPath: string,
): Promise<void> {
  await extractTgzBuffer(run, tgz, destDir, tmpTgzPath);
}

/** `npm pack <spec>` into `packDir`, then extract into `destDir`. */
export async function stageNpm(
  run: Runner,
  spec: string,
  destDir: string,
  packDir: string,
): Promise<void> {
  const tgz = await npmPack(run, (m) => new SkillStageError(m), spec, packDir);
  await extractTgzFile(run, tgz, destDir);
}

/**
 * Clone a git repo into `destDir` (or copy only `<clone>/<subdir>` into it),
 * dropping `.git`. Returns the origin commit (null if unreadable). `cloneDir` is
 * a scratch dir used ONLY for the subdir variant and is wiped afterwards.
 */
export async function stageGit(
  run: Runner,
  source: { url: string; ref?: string; subdir?: string },
  destDir: string,
  cloneDir: string,
): Promise<string | null> {
  if (source.subdir === undefined) {
    await gitClone(run, source.url, source.ref, destDir);
    const commit = await gitHeadCommit(run, destDir);
    rmQuiet(path.join(destDir, '.git'));
    return commit;
  }
  if (!isSafeSubdir(source.subdir)) {
    throw new SkillValidationError(
      `git subdir '${source.subdir}' must be a relative path inside the repo (no absolute path, no "..")`,
    );
  }
  fs.mkdirSync(cloneDir, { recursive: true });
  try {
    await gitClone(run, source.url, source.ref, cloneDir);
    const commit = await gitHeadCommit(run, cloneDir);
    const srcPath = path.resolve(cloneDir, source.subdir);
    const cloneRoot = path.resolve(cloneDir) + path.sep;
    if (
      !srcPath.startsWith(cloneRoot) ||
      !fs.existsSync(srcPath) ||
      !fs.statSync(srcPath).isDirectory()
    ) {
      throw new SkillValidationError(`git subdir '${source.subdir}' not found in ${source.url}`);
    }
    fs.cpSync(srcPath, destDir, { recursive: true });
    rmQuiet(path.join(destDir, '.git'));
    return commit;
  } finally {
    rmQuiet(cloneDir);
  }
}

/**
 * Provenance checksum — sha256 over the WHOLE staged skill tree (every file's
 * relative path + bytes, in a deterministic sorted order), not just `SKILL.md`.
 * A tree hash means a changed `assets/` script drifts the checksum too, so a
 * re-import that mutates executable content invalidates a prior review
 * (installer.ts) — the SKILL.md-only hash would have missed it. Detects drift
 * across a re-import (which drives the diff/trust UI, Lot 3b).
 */
export function checksumSkill(dir: string): string {
  const root = path.resolve(dir);
  const files: string[] = [];
  const walk = (abs: string): void => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const child = path.join(abs, ent.name);
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile()) files.push(child);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash('sha256');
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    hash.update(rel, 'utf8');
    hash.update('\0');
    hash.update(fs.readFileSync(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function rmQuiet(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
