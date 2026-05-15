import { loadConfig } from './config.js';
import { Spawner } from './modules/spawner/index.js';
import { startServer } from './http/main.js';

const config = loadConfig();

console.log(
  JSON.stringify({
    event: 'boot',
    project: config.projectName,
    version: config.version,
    host: config.host,
    port: config.port,
    workspaceRoot: config.workspaceRoot,
    dataDir: config.dataDir,
    // token intentionally omitted
  }),
);

const spawner = new Spawner(config);
const handle = startServer(config, spawner);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'shutdown.start', signal }));
  try {
    spawner.shutdownAll(`signal:${signal}`);
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
