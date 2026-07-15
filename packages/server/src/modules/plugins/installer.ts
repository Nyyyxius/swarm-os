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
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withModule } from '../../logger.js';
import { PluginStore } from './store.js';
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
/** Keep `last_error` legible — truncate captured stderr. */
const STDERR_MAX = 600;

// ---------------------------------------------------------------------------
// Sources + errors
// ---------------------------------------------------------------------------

export type InstallSource =
  | { kind: 'npm'; spec: string }
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'dir'; dir: string }
  | { kind: 'upload'; tgz: Buffer; name?: string };

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

  constructor(deps: PluginInstallerDeps) {
    this.pluginsDir = deps.pluginsDir;
    this.store = deps.store;
    this.host = deps.host;
    this.stagingRoot = stagingRoot(deps.pluginsDir);
    this.npmCacheDir = path.join(this.stagingRoot, '.npm-cache');
    this.execTimeoutMs = deps.execTimeoutMs ?? EXEC_TIMEOUT_MS;
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
        const ref = row.source_ref ?? '';
        const hash = ref.lastIndexOf('#');
        source =
          hash > 0
            ? { kind: 'git', url: ref.slice(0, hash), ref: ref.slice(hash + 1) }
            : { kind: 'git', url: ref };
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
        await this.gitClone(source.url, source.ref, dir);
        this.rmQuiet(path.join(dir, '.git'));
        sourceKind = 'git';
        sourceRef = source.ref ? `${source.url}#${source.ref}` : source.url;
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
    return { dir, manifest, sourceKind, sourceRef };
  }

  // ---- fetch primitives --------------------------------------------------

  /** Write the uploaded `.tgz` bytes to a temp file and extract it. */
  private async extractTgz(tgz: Buffer, dir: string, uuid: string): Promise<void> {
    const tgzPath = path.join(this.stagingRoot, `${uuid}.tgz`);
    try {
      fs.writeFileSync(tgzPath, tgz);
      await this.extractTgzFile(tgzPath, dir);
    } finally {
      this.rmQuiet(tgzPath);
    }
  }

  /** `tar -xzf <tgz> -C <dir> --strip-components=1` (npm pack nests under `package/`). */
  private async extractTgzFile(tgzPath: string, dir: string): Promise<void> {
    await this.run('tar', ['-xzf', tgzPath, '-C', dir, '--strip-components=1'], dir);
  }

  /** `npm pack <spec>` into `packDir` → returns the produced `.tgz` path. */
  private async npmPack(spec: string, packDir: string): Promise<string> {
    fs.mkdirSync(packDir, { recursive: true });
    await this.run(
      'npm',
      ['pack', spec, '--pack-destination', packDir, '--no-audit', '--no-fund', '--silent'],
      packDir,
    );
    const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new InstallSourceError(`npm pack produced no tarball for '${spec}'`);
    return path.join(packDir, tgz);
  }

  /** `git clone --depth 1 [--branch <ref>] <url> <dir>`. */
  private async gitClone(url: string, ref: string | undefined, dir: string): Promise<void> {
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push('--', url, dir);
    await this.run('git', args, dir);
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
  private run(bin: string, args: string[], cwd: string): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: process.env.HOME || '/home/node',
      npm_config_cache: this.npmCacheDir,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // Never block on a credential prompt for a private/invalid git URL.
      GIT_TERMINAL_PROMPT: '0',
    };
    return new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd, env, timeout: this.execTimeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(String(stdout));
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const detail = (String(stderr) || String(stdout) || e.message).trim().slice(-STDERR_MAX);
          const timedOut = e.killed || e.signal === 'SIGTERM';
          log.warn({ event: 'plugins.exec_failed', bin, cwd, timedOut, error: detail });
          reject(
            new InstallSourceError(
              `${bin} ${args[0] ?? ''} failed${timedOut ? ' (timed out)' : ''}: ${detail}`,
            ),
          );
        },
      );
    });
  }

  private rmQuiet(target: string): void {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
