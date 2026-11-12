/**
 * PluginInstaller — install / upgrade a plugin from npm, git, an uploaded
 * `.tgz`, or a directory (plan §J3).
 *
 * Division of labour (built OVER the J1/J2 socle, not replacing it):
 *   - the INSTALLER fetches a source into an isolated `.staging/<uuid>`, runs
 *     `npm install --omit=dev` when the package declares deps, and validates the
 *     manifest — all OUTSIDE any lock (the uuid dir is private, nothing else can
 *     observe it);
 *   - the HOST commits the staged folder via `PluginHost.commitInstall`, which
 *     runs under the per-name lock SHARED between host and installer (red-team
 *     I-8) and owns the disk swap + row upsert + re-activation.
 *
 * `scan` and `uninstall` already live on the host (J1) — this module only adds
 * the from-source pipeline + the boot-time `.staging` purge.
 *
 * ⚠️ npm hoisting (bloquant B-2): we NEVER `npm install --prefix <staging>
 * <spec>` (npm would hoist the package's deps as SIBLINGS of the installed
 * package, so the moved folder would lose them and ESM resolution would fail at
 * activate). Instead `npm pack <spec>` produces a `.tgz` in the exact `npm pack`
 * layout of the upload pipeline → extract → `npm install --omit=dev` INSIDE the
 * plugin folder, so deps land in `<plugin>/node_modules`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withModule } from '../../logger.js';
import { PluginStore } from './store.js';
import {
  makeRunner,
  extractTgzFile as coreExtractTgzFile,
  extractTgzBuffer as coreExtractTgzBuffer,
  npmPack as coreNpmPack,
  gitClone as coreGitClone,
  gitHeadCommit as coreGitHeadCommit,
  isSafeSubdir,
  encodeGitRef,
  decodeGitRef,
  type Runner,
} from '../install-core/fetch.js';
import {
  loadManifest,
  HOST_API_VERSION,
  type PluginManifest,
} from './manifest.js';
import {
  PluginHost,
  PluginNotFoundError,
  type CommitInstallResult,
} from './host.js';
import { stagingRoot } from './util.js';

const log = withModule('plugins.installer');

/** `npm install` / `npm pack` / `git clone` wall-clock cap (plan §Installation). */
const EXEC_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Sources + errors
// ---------------------------------------------------------------------------

export type InstallSource =
  | { kind: 'npm'; spec: string }
  | { kind: 'git'; url: string; ref?: string; subdir?: string }
  | { kind: 'dir'; dir: string }
  | { kind: 'upload'; tgz: Buffer; name?: string };

// `isSafeSubdir` + the git-ref codec live in the shared install-core module now
// (docs/plan-skills-importables.md §11.4). Re-exported so existing importers
// (installer.test.ts) keep resolving them from here.
export { isSafeSubdir, encodeGitRef, decodeGitRef } from '../install-core/fetch.js';

/** Bad manifest / name / apiVersion / path-traversal / reserved name → HTTP 422. */
export class InstallValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallValidationError';
  }
}

/** npm/git/tar network or exec failure → HTTP 502 (stderr in `last_error`). */
export class InstallSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallSourceError';
  }
}

/** Upgrade of an upload-source plugin → HTTP 409 (needs a fresh upload). */
export class UploadRequiresNewUploadError extends Error {
  constructor(name: string) {
    super(`plugin '${name}' was installed from an upload — upgrade requires a new upload`);
    this.name = 'UploadRequiresNewUploadError';
  }
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

interface Staged {
  dir: string;
  manifest: PluginManifest;
  sourceKind: string;
  sourceRef: string | null;
  /** git HEAD of the fetched clone; null for every non-git source (see `gitHeadCommit`). */
  sourceCommit: string | null;
}

export interface PluginInstallerDeps {
  /** `<dataDir>/plugins`. */
  pluginsDir: string;
  store: PluginStore;
  /** Owns the disk swap + activation + the SHARED per-name lock. */
  host: PluginHost;
  /** Override exec timeout (tests). */
  execTimeoutMs?: number;
}

export class PluginInstaller {
  private readonly pluginsDir: string;
  private readonly store: PluginStore;
  private readonly host: PluginHost;
  private readonly stagingRoot: string;
  private readonly npmCacheDir: string;
  private readonly execTimeoutMs: number;
  /** Shared exec runner (install-core). Fetch primitives + `run` delegate to it. */
  private readonly _runner: Runner;

  constructor(deps: PluginInstallerDeps) {
    this.pluginsDir = deps.pluginsDir;
    this.store = deps.store;
    this.host = deps.host;
    this.stagingRoot = stagingRoot(deps.pluginsDir);
    this.npmCacheDir = path.join(this.stagingRoot, '.npm-cache');
    this.execTimeoutMs = deps.execTimeoutMs ?? EXEC_TIMEOUT_MS;
    this._runner = makeRunner({
      timeoutMs: this.execTimeoutMs,
      npmCacheDir: this.npmCacheDir,
      sourceError: (m) => new InstallSourceError(m),
    });
  }

  /**
   * Wipe stale `.staging/*` (interrupted installs, `.bak-*` leftovers) and
   * recreate the work area + npm cache. Called at boot before activateEnabled.
   */
  purgeStaging(): void {
    // Wrapped whole: this runs synchronously at boot, so a transient FS error
    // must degrade to a log line, never an uncaught throw that aborts startup.
    try {
      fs.rmSync(this.stagingRoot, { recursive: true, force: true });
      fs.mkdirSync(this.npmCacheDir, { recursive: true });
    } catch (err) {
      log.warn({ event: 'plugins.staging_purge_failed', error: String(err) });
    }
  }

  // ---- public entry points ----------------------------------------------

  /** Install a NEW plugin (or overwrite an existing name) from a source. */
  async install(source: InstallSource): Promise<CommitInstallResult> {
    const uuid = randomUUID();
    const dir = path.join(this.stagingRoot, uuid);
    try {
      const staged = await this.stageInto(dir, uuid, source);
      return await this.host.commitInstall({
        name: staged.manifest.name,
        stagingDir: staged.dir,
        sourceKind: staged.sourceKind,
        sourceRef: staged.sourceRef,
        sourceCommit: staged.sourceCommit,
        version: staged.manifest.version,
        apiVersion: staged.manifest.apiVersion,
        manifestCaps: staged.manifest.capabilities,
      });
    } finally {
      // No-op once commitInstall renamed the dir into place; cleans up on failure.
      this.rmQuiet(dir);
    }
  }

  /**
   * Upgrade an existing plugin by re-fetching its recorded source. npm/git
   * re-fetch `source_ref`; `dir` re-scans the folder; `upload` → 409.
   */
  async upgrade(name: string): Promise<CommitInstallResult> {
    const row = this.store.get(name);
    if (!row) throw new PluginNotFoundError(name);

    let source: InstallSource;
    switch (row.source_kind) {
      case 'npm':
        source = { kind: 'npm', spec: row.source_ref ?? name };
        break;
      case 'git': {
        const { url, ref, subdir } = decodeGitRef(row.source_ref ?? '');
        source = { kind: 'git', url, ref, subdir };
        break;
      }
      case 'dir':
        source = { kind: 'dir', dir: row.source_ref ?? path.join(this.pluginsDir, name) };
        break;
      case 'upload':
        throw new UploadRequiresNewUploadError(name);
      default:
        throw new InstallValidationError(`cannot upgrade source '${row.source_kind}'`);
    }

    const uuid = randomUUID();
    const dir = path.join(this.stagingRoot, uuid);
    try {
      let staged: Staged;
      try {
        staged = await this.stageInto(dir, uuid, source);
      } catch (err) {
        // Record the fetch/validation failure on the existing row so the UI
        // surfaces it — the OLD version keeps running (we never touched it).
        if (err instanceof InstallSourceError || err instanceof InstallValidationError) {
          this.store.patch(name, { last_error: err.message });
        }
        throw err;
      }
      // The re-fetched package must still be the same plugin.
      if (staged.manifest.name !== name) {
        throw new InstallValidationError(
          `upgrade produced plugin '${staged.manifest.name}', expected '${name}'`,
        );
      }
      return await this.host.commitInstall({
        name,
        stagingDir: staged.dir,
        sourceKind: staged.sourceKind,
        sourceRef: staged.sourceRef,
        sourceCommit: staged.sourceCommit,
        version: staged.manifest.version,
        apiVersion: staged.manifest.apiVersion,
        manifestCaps: staged.manifest.capabilities,
      });
    } finally {
      this.rmQuiet(dir);
    }
  }

  // ---- staging (per source) ---------------------------------------------

  private async stageInto(dir: string, uuid: string, source: InstallSource): Promise<Staged> {
    fs.mkdirSync(dir, { recursive: true });
    let sourceKind: string;
    let sourceRef: string | null;
    // Only a git source has a commit; every other branch leaves this null.
    let sourceCommit: string | null = null;

    switch (source.kind) {
      case 'dir': {
        const abs = path.resolve(source.dir);
        if (!fs.existsSync(path.join(abs, 'plugin.json'))) {
          throw new InstallValidationError(`no plugin.json in directory '${source.dir}'`);
        }
        fs.cpSync(abs, dir, { recursive: true });
        // A dev folder may carry a stale node_modules — drop it so `npm install`
        // rebuilds a clean tree that matches the shipped package.json.
        this.rmQuiet(path.join(dir, 'node_modules'));
        sourceKind = 'dir';
        sourceRef = abs;
        break;
      }
      case 'upload': {
        await this.extractTgz(source.tgz, dir, uuid);
        sourceKind = 'upload';
        sourceRef = null;
        break;
      }
      case 'npm': {
        const packDir = path.join(this.stagingRoot, `${uuid}-pack`);
        try {
          const tgz = await this.npmPack(source.spec, packDir);
          await this.extractTgzFile(tgz, dir);
        } finally {
          // Cleaned even if npm pack itself throws (the boot purge is only a backstop).
          this.rmQuiet(packDir);
        }
        sourceKind = 'npm';
        sourceRef = source.spec;
        break;
      }
      case 'git': {
        if (source.subdir === undefined) {
          // Whole-repo clone straight into the staging dir (the plugin root).
          await this.gitClone(source.url, source.ref, dir);
          // Read HEAD while `.git` is still there — it is about to be deleted.
          sourceCommit = await this.gitHeadCommit(dir);
          this.rmQuiet(path.join(dir, '.git'));
        } else {
          if (!isSafeSubdir(source.subdir)) {
            throw new InstallValidationError(
              `git subdir '${source.subdir}' must be a relative path inside the repo ` +
                `(no absolute path, no "..")`,
            );
          }
          // Clone into a private temp, then copy ONLY <clone>/<subdir> into the
          // staging dir — which BECOMES the plugin root (commitInstall renames the
          // staging entire), so loadManifest / npmInstallIfDeps / the `main` check
          // all operate on the relocated subdir, not the repo root.
          const cloneDir = path.join(this.stagingRoot, `${uuid}-clone`);
          try {
            // Pre-create so `run`'s cwd exists; `git clone` fills the empty dir.
            fs.mkdirSync(cloneDir, { recursive: true });
            await this.gitClone(source.url, source.ref, cloneDir);
            // HEAD lives in the CLONE, not in `dir` (which only ever receives the
            // copied subdir) — and the clone is wiped by the `finally` below.
            sourceCommit = await this.gitHeadCommit(cloneDir);
            const srcPath = path.resolve(cloneDir, source.subdir);
            const cloneRoot = path.resolve(cloneDir) + path.sep;
            if (
              !srcPath.startsWith(cloneRoot) ||
              !fs.existsSync(srcPath) ||
              !fs.statSync(srcPath).isDirectory()
            ) {
              throw new InstallValidationError(
                `git subdir '${source.subdir}' not found in ${source.url}`,
              );
            }
            fs.cpSync(srcPath, dir, { recursive: true });
            // A subdir may itself carry a nested .git (submodule/worktree leftover).
            this.rmQuiet(path.join(dir, '.git'));
          } finally {
            this.rmQuiet(cloneDir);
          }
        }
        sourceKind = 'git';
        sourceRef = encodeGitRef(source.url, source.ref, source.subdir);
        break;
      }
    }

    // Install runtime deps INSIDE the plugin folder (never `--prefix` — B-2).
    await this.npmInstallIfDeps(dir);

    // Validate the manifest (name regex, reserved names, safe `main` — all in
    // loadManifest; apiVersion checked here) and confirm the entry exists.
    let manifest: PluginManifest;
    try {
      manifest = loadManifest(dir);
    } catch (err) {
      throw new InstallValidationError(err instanceof Error ? err.message : String(err));
    }
    if (manifest.apiVersion > HOST_API_VERSION) {
      throw new InstallValidationError(
        `apiVersion ${manifest.apiVersion} exceeds host ${HOST_API_VERSION}`,
      );
    }
    const entry = path.resolve(dir, manifest.main);
    if (!entry.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(entry)) {
      throw new InstallValidationError(`entry '${manifest.main}' not found in package`);
    }
    if (source.kind === 'upload' && source.name && source.name !== manifest.name) {
      throw new InstallValidationError(
        `uploaded package is '${manifest.name}', expected '${source.name}'`,
      );
    }
    return { dir, manifest, sourceKind, sourceRef, sourceCommit };
  }

  // ---- fetch primitives --------------------------------------------------

  // Fetch primitives now live in the shared install-core module; these thin
  // methods delegate to it through the plugin's own error-typed runner.

  private async extractTgz(tgz: Buffer, dir: string, uuid: string): Promise<void> {
    await coreExtractTgzBuffer(this._runner, tgz, dir, path.join(this.stagingRoot, `${uuid}.tgz`));
  }

  private async extractTgzFile(tgzPath: string, dir: string): Promise<void> {
    await coreExtractTgzFile(this._runner, tgzPath, dir);
  }

  private async npmPack(spec: string, packDir: string): Promise<string> {
    return coreNpmPack(this._runner, (m) => new InstallSourceError(m), spec, packDir);
  }

  private async gitClone(url: string, ref: string | undefined, dir: string): Promise<void> {
    await coreGitClone(this._runner, url, ref, dir);
  }

  /**
   * `git rev-parse HEAD` in a fresh clone — the plugin's ORIGIN, recorded so a
   * later pass can tell whether the remote has moved (the `--depth 1` clone's
   * `.git` is deleted moments later, so this is the only window).
   *
   * BEST-EFFORT on purpose: the clone already succeeded and the package is about
   * to be validated, so failing an otherwise-good install over a metadata read
   * would be a regression. `null` is exactly the "origin unknown" state every
   * consumer must already handle for rows installed before this existed.
   */
  private async gitHeadCommit(cloneDir: string): Promise<string | null> {
    return coreGitHeadCommit(this._runner, cloneDir);
  }

  /** `npm install --omit=dev …` in `dir` when its package.json declares deps. */
  private async npmInstallIfDeps(dir: string): Promise<void> {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    let pkg: { dependencies?: Record<string, unknown> };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as typeof pkg;
    } catch (err) {
      throw new InstallValidationError(`invalid package.json: ${String(err)}`);
    }
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) return;
    await this.run(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'],
      dir,
    );
  }

  // ---- exec --------------------------------------------------------------

  /**
   * Run a fetch/build command with an explicit, writable HOME + npm cache
   * (⚠️ never `-g`: the global prefix is root-owned under `USER node`) and a
   * hard timeout. Any non-zero exit / timeout → `InstallSourceError` carrying
   * a truncated stderr for `last_error`.
   */
  /** Exec delegate — `npmInstallIfDeps` (plugin-only, not in install-core) uses it. */
  private run(bin: string, args: string[], cwd: string): Promise<string> {
    return this._runner(bin, args, cwd);
  }

  private rmQuiet(target: string): void {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
