/**
 * Skill staging — fetch a skill from a source into an isolated staging dir.
 *
 * Data-first (docs/plan-skills-importables.md §0): unlike the plugin installer
 * this runs NO `npm install` and NO `import()` — it only copies/extracts files
 * and computes a provenance checksum. Lot 1a supports `dir` + `upload`; git/npm/
 * market arrive in a later lot (and would justify extracting a shared
 * `install-core` from `plugins/installer.ts` — deferred until then, plan §11.4).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { withModule } from '../../logger.js';
import { SKILL_FILE } from './manifest.js';

const log = withModule('skills.stage');

/** tar extraction wall-clock cap. */
const EXEC_TIMEOUT_MS = 60_000;
/** Keep `last_error` legible — truncate captured stderr. */
const STDERR_MAX = 600;

/** Bad SKILL.md / name / traversal → HTTP 422. */
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

/** tar / fetch failure → HTTP 502 (stderr in the message). */
export class SkillStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillStageError';
  }
}

export type SkillInstallSource =
  | { kind: 'dir'; dir: string }
  | { kind: 'upload'; tgz: Buffer; name?: string };

/** Copy a local skill folder into `destDir`. Requires a `SKILL.md` at its root. */
export function stageDir(srcDir: string, destDir: string): void {
  const abs = path.resolve(srcDir);
  if (!fs.existsSync(path.join(abs, SKILL_FILE))) {
    throw new SkillValidationError(`no ${SKILL_FILE} in directory '${srcDir}'`);
  }
  fs.cpSync(abs, destDir, { recursive: true });
}

/** Extract an uploaded `.tgz` (npm pack format) into `destDir`. */
export async function stageUpload(tgz: Buffer, destDir: string, tmpTgzPath: string): Promise<void> {
  try {
    fs.writeFileSync(tmpTgzPath, tgz);
    // `--strip-components=1`: npm pack nests everything under `package/`.
    await runTar(['-xzf', tmpTgzPath, '-C', destDir, '--strip-components=1'], destDir);
  } finally {
    try {
      fs.rmSync(tmpTgzPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      'tar',
      args,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const detail = (String(stderr) || err.message).trim().slice(-STDERR_MAX);
        log.warn({ event: 'skills.tar_failed', error: detail });
        reject(new SkillStageError(`tar failed: ${detail}`));
      },
    );
  });
}

/**
 * Provenance checksum — sha256 of the `SKILL.md` bytes. Detects a changed body
 * across a re-import (which drives the diff/trust UI in a later lot). A full-tree
 * hash can replace this if/when skills routinely ship assets.
 */
export function checksumSkill(dir: string): string {
  const buf = fs.readFileSync(path.join(dir, SKILL_FILE));
  return createHash('sha256').update(buf).digest('hex');
}
