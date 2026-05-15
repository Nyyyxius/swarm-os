import { loadConfig } from './config.js';
import { Spawner } from './modules/spawner/index.js';
import { startServer } from './http/main.js';
import { McpServer } from './modules/mcp/server.js';

const config = loadConfig();

console.log(
  JSON.stringify({
    event: 'boot',
    project: config.projectName,
    version: config.version,
    host: config.host,
    port: config.port,
    mcpPort: config.mcpPort,
    workspaceRoot: config.workspaceRoot,
    dataDir: config.dataDir,
    mcpRuntimeDir: config.mcpRuntimeDir,
    // token intentionally omitted
  }),
);

const spawner = new Spawner(config);
const handle = startServer(config, spawner);

// Start MCP HTTP listener on its own port (loopback only, plan §14).
// Boot ordering: main HTTP first (so /health is up if a healthcheck is
// already pointed at us), then MCP. If MCP fails to bind we shut down
// the main listener too — the system is non-functional without MCP.
const mcp = new McpServer(spawner, config.mcpPort, config);
mcp.start().catch(async (err) => {
  console.error('[swarm-os] MCP server failed to start:', err);
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
  console.log(JSON.stringify({ event: 'shutdown.start', signal }));
  try {
    spawner.shutdownAll(`signal:${signal}`);
    // Stop MCP first (per-request transport instances will tear down with
    // their sockets) then the main HTTP listener.
    await mcp.stop();
    await handle.close();
  } catch (err) {
    console.error('[swarm-os] shutdown error:', err);
  }
  console.log(JSON.stringify({ event: 'shutdown.done' }));
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('uncaughtException', (err) => {
  console.error('[swarm-os] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[swarm-os] unhandledRejection:', err);
});
