/**
 * install-core — shared fetch/stage primitives for the plugin installer AND the
 * skills installer (docs/plan-skills-importables.md §4/§11.4).
 *
 * PURE mechanics: clone / pack / extract a source into a staging dir, plus the
 * git-ref codec + subdir guard. NOTHING here validates a manifest, runs
 * `npm install`, or imports code — each consumer layers its own policy on top
 * (plugins install deps + validate `plugin.json`; skills stay data-first and
 * only parse `SKILL.md`).
 *
 * Errors: exec / tar / npm / git failures are surfaced through the
 * caller-supplied `ErrorFactory`, so each module keeps its OWN error type
 * (plugins → `InstallSourceError` → 502; skills → `SkillStageError` → 502)
 * without this module depending on either.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { withModule } from '../../logger.js';

const log = withModule('install-core');

/** Keep captured stderr legible in error messages. */
const STDERR_MAX = 600;

/** Builds the error a fetch failure throws (each module's own type). */
export type ErrorFactory = (message: string, opts: { timedOut: boolean }) => Error;

/** A configured exec runner: resolves stdout, rejects via the `ErrorFactory`. */
export type Runner = (bin: string, args: string[], cwd: string) => Promise<string>;

export interface RunnerConfig {
  /** Wall-clock cap per exec (ms). */
  timeoutMs: number;
  /** `npm_config_cache` dir (keeps npm off the global cache). */
  npmCacheDir: string;
  /** Wrap a failure into the consumer's own error type. */
  sourceError: ErrorFactory;
}

/**
 * Build the exec runner every fetch helper uses. Byte-for-byte the same env,
 * timeout and maxBuffer as the plugin installer's original private `run()`
 * (writable HOME/npm-cache, `GIT_TERMINAL_PROMPT=0`, 32 MiB buffer) so the
 * refactor is behaviour-preserving.
 */
export function makeRunner(cfg: RunnerConfig): Runner {
  return (bin, args, cwd) =>
    new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: process.env.HOME || '/home/node',
        npm_config_cache: cfg.npmCacheDir,
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        // Never block on a credential prompt for a private/invalid git URL.
        GIT_TERMINAL_PROMPT: '0',
      };
      execFile(
        bin,
        args,
        { cwd, env, timeout: cfg.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(String(stdout));
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const detail = (String(stderr) || String(stdout) || e.message).trim().slice(-STDERR_MAX);
          const timedOut = e.killed === true || e.signal === 'SIGTERM';
          log.warn({ event: 'install_core.exec_failed', bin, cwd, timedOut, error: detail });
          reject(
            cfg.sourceError(
              `${bin} ${args[0] ?? ''} failed${timedOut ? ' (timed out)' : ''}: ${detail}`,
              { timedOut },
            ),
          );
        },
      );
    });
}

/** `tar -xzf <tgz> -C <dir> --strip-components=1` (npm pack nests under `package/`). */
export async function extractTgzFile(run: Runner, tgzPath: string, destDir: string): Promise<void> {
  await run('tar', ['-xzf', tgzPath, '-C', destDir, '--strip-components=1'], destDir);
}

/** Write buffered `.tgz` bytes to `tmpTgzPath`, extract into `destDir`, clean up. */
export async function extractTgzBuffer(
  run: Runner,
  tgz: Buffer,
  destDir: string,
  tmpTgzPath: string,
): Promise<void> {
  try {
    fs.writeFileSync(tmpTgzPath, tgz);
    await extractTgzFile(run, tmpTgzPath, destDir);
  } finally {
    try {
      fs.rmSync(tmpTgzPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * `tar -czf <out> -C <parentDir> <topDir>` — archive a single directory so its
 * files nest under `<topDir>/`. The inverse of {@link extractTgzFile} (which
 * strips one leading component): a tarball built this way re-extracts to the
 * flat layout, which is what makes a skill export round-trip through upload.
 */
export async function createTgz(
  run: Runner,
  parentDir: string,
  topDir: string,
  outPath: string,
): Promise<void> {
  await run('tar', ['-czf', outPath, '-C', parentDir, topDir], parentDir);
}

/**
 * `tar -czf <out> -C <dir> .` — archive a directory's CONTENTS at the archive
 * root (multiple top-level entries, e.g. a pack's `pack.json` + `<name>/` dirs).
 * `outPath` MUST be outside `dir` or tar would try to include the file it writes.
 */
export async function createTgzDir(run: Runner, dir: string, outPath: string): Promise<void> {
  await run('tar', ['-czf', outPath, '-C', dir, '.'], dir);
}

/** `tar -xzf <tgz> -C <dir>` — extract VERBATIM (no `--strip-components`). */
export async function extractTgzFlat(run: Runner, tgzPath: string, destDir: string): Promise<void> {
  await run('tar', ['-xzf', tgzPath, '-C', destDir], destDir);
}

/** `tar -tzf <tgz>` → the archive's member names (one per line, blanks dropped). */
export async function listTgzEntries(run: Runner, tgzPath: string): Promise<string[]> {
  const out = await run('tar', ['-tzf', tgzPath], path.dirname(tgzPath));
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Traversal guard: the first archive member that is absolute or escapes the
 * extraction root via `..`, or null when every entry is safe. Pure (error-type
 * agnostic) — the caller throws its own error. Belt-and-braces on top of tar's
 * own refusal, so a hand-crafted pack tarball can never write outside its dir.
 */
export function firstUnsafeTarEntry(entries: readonly string[]): string | null {
  for (const entry of entries) {
    const norm = entry.replace(/\\/g, '/');
    if (norm.startsWith('/') || path.isAbsolute(norm)) return entry;
    if (norm.split('/').some((seg) => seg === '..')) return entry;
  }
  return null;
}

/** `npm pack <spec>` into `packDir` → the produced `.tgz` path. */
export async function npmPack(
  run: Runner,
  sourceError: ErrorFactory,
  spec: string,
  packDir: string,
): Promise<string> {
  fs.mkdirSync(packDir, { recursive: true });
  await run(
    'npm',
    ['pack', spec, '--pack-destination', packDir, '--no-audit', '--no-fund', '--silent'],
    packDir,
  );
  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw sourceError(`npm pack produced no tarball for '${spec}'`, { timedOut: false });
  return path.join(packDir, tgz);
}

/** `git clone --depth 1 [--branch <ref>] <url> <dir>`. */
export async function gitClone(
  run: Runner,
  url: string,
  ref: string | undefined,
  destDir: string,
): Promise<void> {
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push('--', url, destDir);
  await run('git', args, destDir);
}

/**
 * `git rev-parse HEAD` in a fresh clone — the source's ORIGIN commit. BEST-EFFORT:
 * null on any non-commit output or failure (the `--depth 1` clone's `.git` is
 * deleted moments later, so this is the only window, and a metadata read must
 * never fail an otherwise-good fetch).
 */
export async function gitHeadCommit(run: Runner, cloneDir: string): Promise<string | null> {
  try {
    const out = (await run('git', ['rev-parse', 'HEAD'], cloneDir)).trim();
    // 40 hex = sha1, 64 = sha256 object format. Anything else is not a commit id.
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(out)) {
      log.warn({ event: 'install_core.git_head_unexpected', cloneDir, out: out.slice(0, 80) });
      return null;
    }
    return out;
  } catch (err) {
    log.warn({ event: 'install_core.git_head_failed', cloneDir, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// git-ref codec + subdir guard (pure — moved verbatim from plugins/installer.ts)
// ---------------------------------------------------------------------------

/**
 * A `subdir` must be a plain relative path INSIDE the clone — reject absolute
 * paths and any `..` traversal. The empty string is invalid (use `undefined`
 * for "whole repo").
 */
export function isSafeSubdir(subdir: string): boolean {
  if (subdir.length === 0) return false;
  if (path.isAbsolute(subdir)) return false;
  const normalized = path.normalize(subdir);
  if (normalized.startsWith('..')) return false;
  if (normalized.split(/[\\/]/).includes('..')) return false;
  return true;
}

/**
 * Encode a git source into the `source_ref` column so `upgrade` can re-fetch the
 * SAME url/ref/subdir. Backward-compatible with the pre-subdir `url#ref` form.
 */
export function encodeGitRef(url: string, ref?: string, subdir?: string): string {
  if (subdir) return `${url}#${ref ?? ''}#${subdir}`;
  return ref ? `${url}#${ref}` : url;
}

/** Inverse of `encodeGitRef` (tolerant of the legacy `url` / `url#ref` forms). */
export function decodeGitRef(stored: string): { url: string; ref?: string; subdir?: string } {
  const parts = stored.split('#');
  const url = parts[0] ?? stored;
  const ref = parts[1] && parts[1].length > 0 ? parts[1] : undefined;
  const subdir = parts[2] && parts[2].length > 0 ? parts[2] : undefined;
  return { url, ref, subdir };
}
