/**
 * Skill staging — fetch a skill from a source into an isolated staging dir.
 *
 * Data-first (docs/plan-skills-importables.md §0): unlike the plugin installer
 * this runs NO `npm install` and NO `import()` — it only fetches/extracts files
 * (via the shared `install-core` primitives) and computes a provenance checksum.
 * Sources: `dir`, `upload` (.tgz), `npm`, `git` (+ optional `subdir`). `market`
 * arrives in Lot 4 (after the Lot 3 trust model).
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
  | { kind: 'git'; url: string; ref?: string; subdir?: string };

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
 * Provenance checksum — sha256 of the `SKILL.md` bytes. Detects a changed body
 * across a re-import (which drives the diff/trust UI in a later lot).
 */
export function checksumSkill(dir: string): string {
  const buf = fs.readFileSync(path.join(dir, SKILL_FILE));
  return createHash('sha256').update(buf).digest('hex');
}

function rmQuiet(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
