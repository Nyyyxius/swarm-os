import { loadConfig } from './config.js';
import { Spawner } from './modules/spawner/index.js';
import { startServer } from './http/main.js';
import { McpServer } from './modules/mcp/server.js';
import { initRootLogger, withModule } from './logger.js';
import { SwarmDb } from './modules/db/index.js';
import { DbPersistence } from './modules/orchestrator/persistence.js';
import { DiscordWebhookNotifier, NoOpNotifier, type Notifier } from './modules/notify/index.js';

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
  discord: config.discordWebhookUrl ? 'configured' : 'no-op',
  publicUrl: config.publicUrl ?? '<unset>',
  // token, hookToken, sessionSecret etc. intentionally redacted by pino
});

// ---- Phase 4: SQLite persistence + crash recovery -------------------------
const db = new SwarmDb(config.dataDir);
const persistence = new DbPersistence(db);
const recovered = persistence.recoverFromCrash();
if (recovered.orchestrators > 0 || recovered.sessions > 0) {
  log.warn({
    event: 'boot.recovery',
    note: 'marked stale rows as interrupted (server-restart)',
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

const spawner = new Spawner(config, { notifier, persistence });
const handle = startServer(config, spawner);

// Start MCP HTTP listener on its own port (loopback only, plan §14).
// Boot ordering: main HTTP first (so /health is up if a healthcheck is
// already pointed at us), then MCP. If MCP fails to bind we shut down
// the main listener too — the system is non-functional without MCP.
const mcp = new McpServer(spawner, config.mcpPort, config);
mcp.start().catch(async (err) => {
  log.error({ event: 'mcp.start_failed', error: err instanceof Error ? err.message : String(err) });
  try {
    await handle.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ event: 'shutdown.start', signal });
  try {
    spawner.shutdownAll(`signal:${signal}`);
    // Stop MCP first (per-request transport instances will tear down with
    // their sockets) then the main HTTP listener.
    await mcp.stop();
    await handle.close();
    db.close();
  } catch (err) {
    log.error({
      event: 'shutdown.error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info({ event: 'shutdown.done' });
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('uncaughtException', (err) => {
  rootLog.error({ event: 'uncaughtException', error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (err) => {
  rootLog.error({
    event: 'unhandledRejection',
    error: err instanceof Error ? err.message : String(err),
  });
});
