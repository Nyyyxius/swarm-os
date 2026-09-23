import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config.js';
import { withModule } from '../../logger.js';

const log = withModule('ide');

/**
 * Supervises the in-container `code serve-web` (official Microsoft VS Code
 * web) process.
 *
 * Design:
 *   - serve-web is served at the ROOT of its own port (`config.idePort`) on
 *     its own origin. The official serve-web cannot be hosted under a
 *     sub-path (microsoft/vscode#192947), so it is NOT reverse-proxied through
 *     the main Express app — the web UI embeds it directly via an iframe whose
 *     URL is built from `window.location` + the port returned by `/ide-info`.
 *   - Access is guarded by serve-web's `--connection-token` (== `config.ideToken`),
 *     handed to the already-authenticated web client by `GET /ide-info`.
 *   - The editor edits the same `/workspace` tree the agents work in (bind
 *     mount), in both local and SSH transport modes.
 *
 * Lifecycle: long-running, restarted on unexpected exit with capped
 * exponential backoff (the container runs 24/7 — a crashed editor must come
 * back without an operator). `stop()` is idempotent and suppresses the
 * restart loop.
 */
export class IdeSupervisor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private spawnedAt = 0;

  constructor(private readonly config: Config) {}

  start(): void {
    // Re-arm on every start so a disable→enable cycle actually respawns:
    // `stop()` latches `stopping=true` (and grows `restarts`), while
    // `spawnChild()` / `scheduleRestart()` bail out on `stopping` — leaving a
    // re-start silently inert unless both are cleared here. The FEATURE REGISTRY
    // (not this supervisor) now decides whether the IDE runs, so the old
    // `SWARM_OS_IDE_ENABLED` early-return is gone; that env var is only a
    // first-boot seed default for the registry (see FeatureRegistry).
    this.stopping = false;
    this.restarts = 0;
    // Idempotent: a live child (or a pending respawn) means we're already armed
    // — never spawn a second serve-web.
    if (this.child || this.restartTimer) return;
    // Skip cleanly when the VS Code CLI isn't present (typical of `pnpm dev`
    // outside the container) — otherwise we'd spin an ENOENT restart loop.
    if (!fs.existsSync(this.config.ideCliPath)) {
      log.warn({
        event: 'ide.cli_missing',
        path: this.config.ideCliPath,
        note: 'VS Code CLI not found — IDE disabled (expected outside the container)',
      });
      return;
    }
    for (const d of [this.config.ideServerDataDir, this.config.ideCliDataDir]) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {
        /* best-effort; config.ts already pre-creates these */
      }
    }
    this.seedDefaultSettings();
    this.spawnChild();
  }

  /**
   * Seed VS Code web's User settings with a dark default theme on a fresh
   * instance. Seed-if-absent: we never clobber the operator's own choices once
   * they customise. serve-web reads User settings from
   * `<server-data-dir>/data/User/settings.json`.
   */
  private seedDefaultSettings(): void {
    const userDir = path.join(this.config.ideServerDataDir, 'data', 'User');
    const settingsPath = path.join(userDir, 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) return; // respect existing user settings
      fs.mkdirSync(userDir, { recursive: true });
      const defaults = {
        'workbench.colorTheme': 'Default Dark Modern',
        'window.autoDetectColorScheme': false,
      };
      fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2) + '\n');
      log.info({ event: 'ide.seed_settings', path: settingsPath });
    } catch (err) {
      log.warn({
        event: 'ide.seed_settings_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private spawnChild(): void {
    if (this.stopping) return;
    const { ideCliPath, idePort, ideBasePath, ideToken, ideServerDataDir, workspaceRoot } =
      this.config;

    // Bind LOOPBACK only — the editor is reached exclusively via the main HTTP
    // server's reverse-proxy under `ideBasePath`, so it inherits the single
    // ingress (port 8787 + its TLS). `--server-base-path` makes serve-web emit
    // all its asset/WS URLs under that prefix so proxying works without path
    // rewriting. The connection-token is the access guard (the iframe is a
    // browser navigation and can't carry the X-Auth-Token header). serve-web
    // keeps server payload + user settings + extensions under --server-data-dir
    // (no separate --user-data-dir / --extensions-dir). --default-folder opens
    // /workspace even on a bare visit (the iframe URL's `?folder=` overrides it).
    const args = [
      'serve-web',
      '--host',
      '127.0.0.1',
      '--port',
      String(idePort),
      '--server-base-path',
      ideBasePath,
      '--accept-server-license-terms',
      '--connection-token',
      ideToken,
      '--server-data-dir',
      ideServerDataDir,
      '--default-folder',
      workspaceRoot,
      '--disable-telemetry',
    ];

    log.info({
      event: 'ide.spawn',
      bin: ideCliPath,
      port: idePort,
      basePath: ideBasePath,
      restarts: this.restarts,
    });
    this.spawnedAt = Date.now();

    let child: ChildProcess;
    try {
      child = spawn(ideCliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: process.env.HOME ?? '/home/node',
          // Persist the downloaded web-server payload on the /data volume so it
          // survives container recreation (otherwise every redeploy re-downloads
          // it and serve-web shows its "downloading latest version" page).
          VSCODE_CLI_DATA_DIR: this.config.ideCliDataDir,
        },
      });
    } catch (err) {
      log.error({
        event: 'ide.spawn_error',
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleRestart();
      return;
    }
    this.child = child;

    child.stdout?.on('data', (b: Buffer) => {
      const line = b.toString().trimEnd();
      if (line) log.debug({ event: 'ide.stdout', line });
    });
    child.stderr?.on('data', (b: Buffer) => {
      const line = b.toString().trimEnd();
      if (line) log.debug({ event: 'ide.stderr', line });
    });

    child.on('error', (err) => {
      log.error({
        event: 'ide.error',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        log.info({ event: 'ide.exit', code, signal, stopping: true });
        return;
      }
      log.warn({ event: 'ide.exit_unexpected', code, signal });
      // A long-lived run that crashed once shouldn't inherit a grown backoff:
      // reset the counter if it stayed up past a healthy threshold.
      if (Date.now() - this.spawnedAt > 60_000) this.restarts = 0;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    // 1s, 2s, 4s, … capped at 30s.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));
    this.restarts += 1;
    log.info({ event: 'ide.restart_scheduled', delayMs: delay });
    this.restartTimer = setTimeout(() => this.spawnChild(), delay);
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 4000);
      t.unref?.();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.child = null;
  }
}
