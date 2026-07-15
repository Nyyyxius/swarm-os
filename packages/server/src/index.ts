import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Spawner } from './modules/spawner/index.js';
import { startServer, type BootGate } from './http/main.js';
import { McpServer } from './modules/mcp/server.js';
import { initRootLogger, withModule } from './logger.js';
import { SwarmDb } from './modules/db/index.js';
import { DbPersistence } from './modules/orchestrator/persistence.js';
import { DiscordWebhookNotifier, NoOpNotifier, type Notifier } from './modules/notify/index.js';
import { DiscordBotPool } from './modules/discord/pool.js';
import { initClaudeRuntime } from './runtime/claude-init.js';
import { RoleStore } from './modules/roles/index.js';
import { SettingsStore } from './modules/settings/index.js';
import { MessagesAggregator } from './modules/metrics/aggregator.js';
import { BusMetricsCollector } from './modules/metrics/busMetrics.js';
import { BackupScheduler } from './modules/backup/index.js';
import { RoleScheduler } from './modules/schedule/index.js';
import { IdeSupervisor } from './modules/ide/index.js';
import { PluginStore } from './modules/plugins/store.js';
import { PluginHost } from './modules/plugins/host.js';
import { PluginToolRegistry } from './modules/plugins/mcp-registry.js';
import { PluginHttpRegistry } from './modules/plugins/http-registry.js';
import { PluginInstaller } from './modules/plugins/installer.js';
import { eventBus } from './events.js';
import {
  rehydrateMailbox,
  mailboxJanitor,
} from './modules/orchestrator/mailbox-persistence.js';
import { broadcastToLeadsFromExternal } from './modules/orchestrator/messaging.js';

const config = loadConfig();
const rootLog = initRootLogger(config);
const log = withModule('boot');

log.info({
  event: 'boot',
  project: config.projectName,
  version: config.version,
  host: config.host,
  port: config.port,
  mcpPort: config.mcpPort,
  workspaceRoot: config.workspaceRoot,
  dataDir: config.dataDir,
  mcpRuntimeDir: config.mcpRuntimeDir,
  claudeSourceDir: config.claudeSourceDir,
  claudeRuntimeDir: config.claudeRuntimeDir,
  discord: config.discordWebhookUrl ? 'configured' : 'no-op',
  publicUrl: config.publicUrl ?? '<unset>',
  // token, hookToken, sessionSecret etc. intentionally redacted by pino
});

// Phase 6 — first-boot token UX. The values are NEVER logged; only the
// path + length so the operator knows where to retrieve them and can
// recognise the difference between `SWARM_OS_TOKEN` (user-facing) and
// `HOOK_TOKEN` (internal hook). When either token was supplied via env,
// the file may not exist — log accordingly so this isn't misleading.
log.info({
  event: 'boot.tokens',
  swarmTokenSource: process.env.SWARM_OS_TOKEN ? 'env' : 'file',
  swarmTokenPath: process.env.SWARM_OS_TOKEN ? null : path.join(config.dataDir, 'token'),
  swarmTokenLen: config.token.length,
  hookTokenSource: process.env.HOOK_TOKEN ? 'env' : 'file',
  hookTokenPath: process.env.HOOK_TOKEN ? null : path.join(config.dataDir, 'hook-token'),
  hookTokenLen: config.hookToken.length,
  hint: process.env.SWARM_OS_TOKEN
    ? 'SWARM_OS_TOKEN supplied via env — paste it into the web UI Token panel'
    : `first-boot token written to ${path.join(config.dataDir, 'token')}; copy it into the web UI Token panel (or run: docker exec <container> cat /data/token)`,
});

// ---- Phase 5: claude runtime materialisation ------------------------------
// Must happen BEFORE the HTTP server accepts traffic so no orchestrator can
// race against the copy. No-op outside containers (when /claude-source is
// not mounted) — Claude then falls back to the dev's host ~/.claude.
//
// Phase 6 also lifts `~/.claude.json` (sibling of `~/.claude/`) so the
// theme picker / "configuration file not found" warning don't wedge the
// first PTY spawn.
//
// SSH transport: the host claude reads its own `~/.claude/` directly; no
// container-side copy is needed and copying would actively re-introduce the
// OAuth refresh race this mode is built to avoid. Skip.
if (config.agentTransport === 'ssh') {
  log.info({
    event: 'boot.claude_init_skipped',
    reason: 'ssh-transport',
    note: 'host claude resolves ~/.claude/ in its own namespace',
  });
} else {
  const claudeInit = initClaudeRuntime({
    sourceDir: config.claudeSourceDir,
    runtimeDir: config.claudeRuntimeDir,
    claudeJsonSource: config.claudeJsonSource,
  });
  log.info({
    event: 'boot.claude_init',
    initialized: claudeInit.initialized,
    copied: claudeInit.copied,
    skipReason: claudeInit.skipReason ?? null,
    entriesCopied: claudeInit.entriesCopied ?? null,
    claudeJson: claudeInit.claudeJson ?? null,
    claudeJsonSource: claudeInit.claudeJsonSource ?? null,
  });
}

// ---- Phase 4: SQLite persistence ------------------------------------------
const db = new SwarmDb(config.dataDir);
const persistence = new DbPersistence(db);

// ---- Phase 8: auto-resume — classify what to bring back up ----------------
// loadResumableState is the atomic-guard variant of the old recoverFromCrash:
// it flips every resumable orch row to 'interrupted' synchronously BEFORE
// returning, so a crash mid-resume cannot lead to a double-spawn at the
// next boot. The orch rows are then re-flipped to 'running' by
// Orchestrator.resume() on success.
let resumableState: ReturnType<typeof persistence.loadResumableState> = {
  resumable: [],
  reaped: { orchestrators: 0, sessions: 0 },
};
if (config.autoResume) {
  resumableState = persistence.loadResumableState();
  log.warn({
    event: 'boot.recovery',
    mode: 'auto-resume',
    candidates: resumableState.resumable.length,
    reapedOrchestrators: resumableState.reaped.orchestrators,
    reapedSessions: resumableState.reaped.sessions,
  });
} else {
  const recovered = persistence.recoverFromCrash();
  log.warn({
    event: 'boot.recovery',
    mode: 'legacy',
    note: 'auto-resume disabled — marked stale rows as interrupted',
    orchestrators: recovered.orchestrators,
    sessions: recovered.sessions,
  });
}

// ---- Phase 4: Notifier ----------------------------------------------------
const notifier: Notifier = config.discordWebhookUrl
  ? new DiscordWebhookNotifier({
      webhookUrl: config.discordWebhookUrl,
      projectName: config.projectName,
      publicUrl: config.publicUrl,
    })
  : new NoOpNotifier();

// ---- Discord bot pool (bidirectional). One bot per distinct role token. ----
// The pool is created empty; bots come up lazily when an orch with a
// `botToken`-bearing role subscribes (create or resume path).
const discordBotPool = new DiscordBotPool();

const roleStore = new RoleStore(db);
const settingsStore = new SettingsStore(db);
const spawner = new Spawner(config, {
  notifier,
  persistence,
  roleStore,
  discordBotPool,
});

// ---- S9: in-memory `/metrics/messages` aggregator -------------------------
// Owns a 60-pt global ring + 8-pt per-orch rings, ticked every 60 s. Lost on
// restart by design (see docs/update_system/09_metrics_messages.md §7.3).
const aggregator = new MessagesAggregator(spawner);
aggregator.start();

// ---- S8: in-memory `/metrics/bus` collector -------------------------------
// 60-slot ring (1 s/slot) backing latency / throughput / err_rate, with an
// instantaneous queue_depth. Instrumented from McpServer (constructor arg)
// so each tool call updates the current slot synchronously. Lost on restart
// by design — same policy as the messages aggregator above.
const busMetrics = new BusMetricsCollector(spawner);
busMetrics.start();

// ---- Hot SQLite backup scheduler ------------------------------------------
// In-process online snapshots of swarm-os.db into <dataDir>/backups (bind-
// mounted to the host). No OS cron / sidecar — see modules/backup for the
// rationale. Disabled when interval or keep is 0.
const backup = new BackupScheduler({
  db: db.db,
  dataDir: config.dataDir,
  intervalMs: config.backupIntervalMs,
  keep: config.backupKeep,
});
backup.start();

// ---- Per-role cron scheduler ----------------------------------------------
// In-process; for each role carrying a `schedule` cron, delivers its
// `scheduleMessage` to the lead inbox of every live instance at each tick.
// Re-armed on every role mutation via the onRolesChanged hook below. Host-
// independent (no OS cron / sidecar) — see modules/schedule for the rationale.
const scheduler = new RoleScheduler({
  roleStore,
  spawner,
  defaults: {
    maxMessageSizeBytes: config.maxMessageSizeBytes,
    idleThresholdMs: config.idleThresholdMs,
  },
  timezone: config.scheduleTimezone,
  enabled: config.scheduleEnabled,
});
scheduler.start();

// ---- VS Code web (`code serve-web`) supervisor -----------------------------
// In-container child process serving the official Microsoft VS Code web at the
// root of its own port (config.idePort), guarded by a connection-token. Edits
// the same /workspace tree the agents work in. Independent of the orchestrator
// stack, so started here (no auto-resume dependency). Disabled when
// SWARM_OS_IDE_ENABLED=false.
const ide = new IdeSupervisor(config);
ide.start();
if (config.ideEnabled) {
  log.info({ event: 'boot.ide', port: config.idePort, cli: config.ideCliPath });
}

// ---- Plugin system (J1 — socle) -------------------------------------------
// PluginStore owns its own tables on the raw Db handle. PluginHost loads,
// enable/disable/reload at runtime, guards every plugin callback against a
// server-killing throw, and quarantines crash loops. Activated AFTER mcp.start
// (so future bridges are up before auto-resume) but its activateEnabled()
// never rejects — see the boot chain below.
const pluginStore = new PluginStore(db);
// J2 — registries consulted per-request (MCP tools) / per-request (HTTP zones).
// Never torn down; enable/disable is a Map mutation.
const pluginToolRegistry = new PluginToolRegistry();
const pluginHttpRegistry = new PluginHttpRegistry();
const pluginMessagingDefaults = {
  maxMessageSizeBytes: config.maxMessageSizeBytes,
  idleThresholdMs: config.idleThresholdMs,
};
const pluginHost = new PluginHost({
  store: pluginStore,
  eventBus,
  pluginsDir: path.join(config.dataDir, 'plugins'),
  zod: z,
  onRolesChanged: () => scheduler.reload(),
  // J2 façades.
  spawner,
  roleStore,
  settingsStore,
  config,
  toolRegistry: pluginToolRegistry,
  httpRegistry: pluginHttpRegistry,
  // Signal leads of a plugin tool-set change via the external-origin broadcast
  // path (mailbox.push + emit + idle wake). Best-effort — never throws into
  // the enable/disable path.
  broadcastToLeads: (from, content) => {
    try {
      broadcastToLeadsFromExternal(spawner, from, content, pluginMessagingDefaults);
    } catch (err) {
      log.warn({
        event: 'plugins.broadcast_to_leads_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
// J3 — install/upgrade from npm/git/upload/dir. Shares the host's per-name lock
// (via host.commitInstall) so a swap is never concurrent with an enable (I-8).
const pluginInstaller = new PluginInstaller({
  pluginsDir: path.join(config.dataDir, 'plugins'),
  store: pluginStore,
  host: pluginHost,
});
// Purge stale `.staging/*` (interrupted installs, `.bak-*` leftovers) at boot.
pluginInstaller.purgeStaging();

// Phase 8 — bootGate: HTTP listens immediately so /health stays green for
// Docker, but business routes return 503 until auto-resume finishes.
const bootGate: BootGate = { value: false };
const handle = startServer(
  config,
  spawner,
  roleStore,
  settingsStore,
  aggregator,
  backup,
  busMetrics,
  bootGate,
  () => scheduler.reload(),
  pluginHost,
  pluginHttpRegistry,
  pluginInstaller,
);

// Start MCP HTTP listener on its own port (loopback only, plan §14).
// Phase 8 — MCP must be listening BEFORE we respawn PTYs, otherwise the
// first `team.read_inbox` call from a resumed agent ECONNREFUSEs and the
// agent wastes its first turn on a transport error. If MCP fails to bind
// we shut down the main listener too — the system is non-functional
// without MCP.
const mcp = new McpServer(spawner, config.mcpPort, config, busMetrics, pluginToolRegistry);

async function runAutoResume(): Promise<void> {
  if (!config.autoResume || resumableState.resumable.length === 0) {
    bootGate.value = true;
    log.info({ event: 'boot.complete', resumed: 0, mailboxRehydrated: 0 });
    return;
  }
  try {
    const { resumed, failed } = await spawner.resumeFromDb(
      resumableState.resumable,
      { staggerMs: config.resumeStaggerMs },
    );
    const mailbox = rehydrateMailbox(spawner, db);
    const janitor = mailboxJanitor(db);
    // Mute Discord for a window so the inevitable session.waiting cascade
    // from N freshly-respawned agents doesn't hit the webhook rate limit.
    if (config.notifyQuietAfterBootMs > 0) {
      notifier.muteUntil = Date.now() + config.notifyQuietAfterBootMs;
    }
    log.info({
      event: 'boot.auto_resume',
      resumed,
      failed: failed.length,
      mailboxRehydrated: mailbox.rehydrated,
      mailboxDroppedSenderTerminal: mailbox.droppedSenderTerminal,
      mailboxDroppedOrphan: mailbox.droppedOrphan,
      janitorDeleted: janitor.deleted,
      muteUntilMs: notifier.muteUntil ?? null,
    });
    if (failed.length > 0) {
      log.warn({ event: 'boot.auto_resume_failures', failed });
    }
  } catch (err) {
    log.error({
      event: 'boot.auto_resume_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    bootGate.value = true;
    log.info({ event: 'boot.complete', listening: true });
  }
}

mcp
  .start()
  // Plugins come up BEFORE auto-resume so any future bridge is live when the
  // teams return. activateEnabled() catches per-plugin internally and NEVER
  // rejects, so it can't trip the fatal .catch below.
  .then(() => pluginHost.activateEnabled())
  .then(() => runAutoResume())
  .catch(async (err) => {
    log.error({ event: 'mcp.start_failed', error: err instanceof Error ? err.message : String(err) });
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    // Use the unified shutdown so DB/spawner/etc. flush together.
    await shutdown('mcp.start_failed').catch(() => undefined);
    process.exit(1);
  });

let shuttingDown = false;
/**
 * Tear down the active server stack. Returns once everything is flushed —
 * **does not call `process.exit`**; the caller is responsible for picking
 * the exit code (signals → 0, uncaughtException → 1). Idempotent.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ event: 'shutdown.start', signal });
  try {
    // S9 + S8 — stop the metrics ticks BEFORE the spawner so the last tick
    // can't observe a half-torn-down mailbox.
    aggregator.stop();
    busMetrics.stop();
    // Stop the backup timer before db.close() so no snapshot races teardown.
    backup.stop();
    // Disarm per-role crons so no tick fires into a half-torn-down spawner.
    scheduler.stop();
    // Tear down active plugins (disposables + deactivate) before the spawner
    // goes away, so a plugin's teardown can still observe live teams.
    await pluginHost.deactivateAll();
    // Stop the VS Code web child (suppresses its restart loop, SIGTERM→SIGKILL).
    await ide.stop();
    spawner.shutdownAll(`signal:${signal}`);
    // Stop MCP first (per-request transport instances will tear down with
    // their sockets) then the main HTTP listener.
    await mcp.stop();
    await discordBotPool.stopAll();
    await handle.close();
    db.close();
  } catch (err) {
    log.error({
      event: 'shutdown.error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info({ event: 'shutdown.done' });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

// Phase 6 carry-over: treat uncaughtException as fatal. The classic case is
// EADDRINUSE during `http.listen` (port collision) — Node fires the error
// asynchronously off the listen callback, so without this handler it just
// gets logged and the process keeps running with a half-open server. We
// attempt a graceful shutdown first (so orchestrators get SIGTERM and
// flushable state lands on disk), then hard-exit with code 1 after a short
// guard timeout so we never hang.
process.on('uncaughtException', (err) => {
  rootLog.fatal({
    event: 'uncaughtException',
    fatal: true,
    error: err.message,
    code: (err as NodeJS.ErrnoException).code ?? null,
    stack: err.stack,
  });
  // Bound the graceful path: if shutdown stalls (e.g. SQLite holding a lock,
  // hub teardown wedged), we MUST still exit so the container restarts.
  const guard = setTimeout(() => {
    rootLog.fatal({ event: 'uncaughtException.guard_exit' });
    process.exit(1);
  }, 5000);
  guard.unref();
  void shutdown('uncaughtException').finally(() => {
    process.exit(1);
  });
});
process.on('unhandledRejection', (err) => {
  // unhandledRejection stays a warn (vs fatal) — most are non-fatal Promise
  // chains we forgot to catch. Add to the fatal handler if a specific kind
  // ever surfaces as actually-fatal in production.
  rootLog.error({
    event: 'unhandledRejection',
    error: err instanceof Error ? err.message : String(err),
  });
});
