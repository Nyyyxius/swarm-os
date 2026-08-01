import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware, type RequestHandler as ProxyHandler } from 'http-proxy-middleware';
import { Spawner } from '../modules/spawner/index.js';
import type { Config } from '../config.js';
import { makeAuthMiddleware, consumeTicket } from './auth.js';
import { createOrchestratorsRouter } from './routes/orchestrators.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createWsTicketRouter } from './routes/ws-ticket.js';
import { createHooksRouter } from './routes/hooks.js';
import { createRolesRouter } from './routes/roles.js';
import { createProvidersRouter } from './routes/providers.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createBackupRouter } from './routes/backup.js';
import { createPreamblesRouter } from './routes/preambles.js';
import { createAiRouter } from './routes/ai.js';
import { createDiscordRouter } from './routes/discord.js';
import { createSettingsRouter } from './routes/settings.js';
import { createIdeRouter } from './routes/ide.js';
import { createPluginsRouter } from './routes/plugins.js';
import { createUpdatesRouter } from './routes/updates.js';
import { createMemoryRouter } from './routes/memory.js';
import { createTaskboardRouter } from './routes/taskboard.js';
import type { MemoryStore } from '../modules/memory/store.js';
import type { TaskboardStore } from '../modules/taskboard/store.js';
import type { UpdateService, InfoUpdateProjection } from '../modules/updates/index.js';
import type { PluginHost } from '../modules/plugins/host.js';
import type { PluginHttpRegistry } from '../modules/plugins/http-registry.js';
import type { PluginInstaller } from '../modules/plugins/installer.js';
import type { ConnectorRegistry } from '../modules/plugins/connector-registry.js';
import type { RoleStore } from '../modules/roles/index.js';
import type { SettingsStore } from '../modules/settings/index.js';
import type { MessagesAggregator } from '../modules/metrics/aggregator.js';
import type { BusMetricsCollector } from '../modules/metrics/busMetrics.js';
import type { BackupScheduler } from '../modules/backup/index.js';
import { TerminalHub } from './ws/terminal.js';
import { EventsHub } from './ws/events.js';
import { withModule } from '../logger.js';

const log = withModule('http');

/**
 * Phase 6 — locate the built web bundle. Returns null if not found (typical
 * of `pnpm dev` where Vite serves the bundle on :5173 with HMR).
 *
 * Candidate roots, in order:
 *   1. `../web` relative to `dist/http/` (Docker layout — Dockerfile copies
 *      the bundle to `/home/node/app/web/`)
 *   2. `<repo>/packages/web/dist` (monorepo source layout)
 */
function findWebRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'web'),
    path.resolve(here, '..', '..', '..', 'web', 'dist'),
    path.resolve(here, '..', '..', '..', 'packages', 'web', 'dist'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, 'index.html')).isFile()) return c;
    } catch {
      /* not present */
    }
  }
  return null;
}

export interface ServerHandle {
  http: Server;
  spawner: Spawner;
  /** S9 — exposed on the handle so integration tests can call `tick()`. */
  aggregator: MessagesAggregator;
  /** S8 — exposed so integration tests can call `tick()` / `snapshot()`. */
  busMetrics: BusMetricsCollector | null;
  close(): Promise<void>;
}

/**
 * Phase 8 — shared boot-complete signal. `value` flips to true once the
 * auto-resume sequence (resumeFromDb + rehydrateMailbox + janitor) has
 * finished. While false, business routes return 503; health/info/static
 * stay green so Docker healthchecks pass and the operator can load the UI.
 */
export interface BootGate {
  value: boolean;
}

/**
 * The update projection `/info` may carry, or `undefined` when detection isn't
 * wired (dev, tests, or a boot where the service failed to come up).
 *
 * `getInfoUpdate()` is documented never to block and never to throw — it serves
 * a cached verdict and at most schedules a background refresh. It does read the
 * settings row for the dismissed version, though, and `/info` is the one route
 * the SPA polls forever and an operator curls at a wedged instance. It does not
 * get to 500 over a nicety, so the contract is belt-and-braced here.
 */
function infoUpdate(updates?: UpdateService): InfoUpdateProjection | undefined {
  if (!updates) return undefined;
  try {
    return updates.getInfoUpdate();
  } catch (err) {
    log.warn({
      event: 'http.info_update_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export function createApp(
  config: Config,
  spawner: Spawner,
  roleStore: RoleStore,
  settingsStore: SettingsStore,
  aggregator: MessagesAggregator,
  backup: BackupScheduler,
  busMetrics?: BusMetricsCollector,
  bootGate?: BootGate,
  onRolesChanged?: () => void,
  pluginHost?: PluginHost,
  pluginHttpRegistry?: PluginHttpRegistry,
  pluginInstaller?: PluginInstaller,
  connectorRegistry?: ConnectorRegistry,
  updates?: UpdateService,
  memory?: MemoryStore,
  taskboard?: TaskboardStore,
): { app: express.Express; ideProxy: ProxyHandler | null } {
  const app = express();
  app.disable('x-powered-by');
  // Body-parser limit gets the prompt cap PLUS headroom for JSON envelope
  // (name, role, cwd, preamble, defaults, quoting, escapes). The route handler
  // is the canonical enforcer of `prompt+preamble <= maxPromptSizeBytes` and
  // returns a clean 413 with details; the body-parser cap exists only to stop
  // pathological abuse of the socket.
  const bodyLimitKb = Math.max(64, Math.ceil(config.maxPromptSizeBytes / 1024) + 64);
  app.use(
    express.json({
      limit: `${bodyLimitKb}kb`,
      // J2 — expose the exact raw bytes to plugin PUBLIC handlers so they can
      // verify HMAC signatures (Slack/Stripe/GitHub webhooks) computed over the
      // wire body, which `JSON.parse` would otherwise discard. Only set for
      // parsed JSON requests; other content-types aren't parsed and leave the
      // stream intact with `req.body` undefined (documented in docs/plugins.md).
      verify: (req: Request, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );

  // Public: health & info.
  app.get('/health', (_req: Request, res: Response) => {
    const c = spawner.counters();
    res.json({
      status: 'ok',
      project_name: config.projectName,
      orchestrators_active: c.orchestratorsActive,
      sessions_active: c.sessionsActive,
      sessions_waiting: c.sessionsWaiting,
      // S5 — surfaced so health dashboards can distinguish "operator-paused"
      // from "active/idle". 0 when no session has been pause()d.
      sessions_paused: c.sessionsPaused,
      uptime_seconds: Math.round(process.uptime()),
      // `/health` is mounted BEFORE the bootGate (below) and has always
      // answered 200 unconditionally — so a container that starts and then
      // wedges inside auto-resume reads as perfectly healthy. The status code
      // deliberately STAYS 200: the Dockerfile HEALTHCHECK treats any non-2xx
      // as a failure and would restart-loop a slow-but-correct resume, which
      // is worse than the thing we're fixing. `boot_complete` is the extra bit
      // consumers gate on instead.
      // No gate injected (dev / tests) ⇒ nothing to wait for ⇒ true.
      boot_complete: bootGate ? bootGate.value : true,
    });
  });

  app.get('/info', (_req: Request, res: Response) => {
    res.json({
      project_name: config.projectName,
      version: config.version,
      // Build provenance. Both are baked into the image by the Dockerfile
      // (ARG APP_VERSION / GIT_SHA) and are null on a run from source.
      // `image` is the reference this deployment was started from
      // (SWARM_OS_IMAGE in the compose `.env`); null when the compose
      // hardcodes its tag.
      commit: config.commit,
      image: config.image,
      started_at: config.startedAt,
      // Update detection. It lives HERE and nowhere else: the SPA already polls
      // `/info` every 60 s without auth, which removes any need for a dedicated
      // check engine, a WS kind, or a polling hook — serving this route IS the
      // heartbeat that keeps the verdict warm (modules/updates/index.ts).
      //
      // `/info` is PUBLIC, so it carries ONLY the boolean and the tag. Release
      // notes, plugin origins and the self-update eligibility reason describe
      // the deployment itself (its transport, its image, its .env) and stay
      // behind the auth gate in `GET /updates`.
      //
      // Absent — not `{available:false}` — when detection isn't wired, so a
      // reader can tell "not checked" from "nothing new". JSON.stringify drops
      // the key on `undefined`.
      update: infoUpdate(updates),
    });
  });

  // Phase 4: hook endpoint — Bearer-auth, NOT X-Auth-Token. Mounted before
  // the X-Auth-Token middleware so the user-facing token never leaks here.
  app.use(
    createHooksRouter(spawner, config.hookToken, spawner.notifier, {
      compactOnWaiting: config.contextCompactOnWaiting,
      idleThresholdMs: config.idleThresholdMs,
    }),
  );

  // Phase 6: serve the built web bundle (PWA shell + JS/CSS + manifest +
  // icons + sw.js) WITHOUT auth so it can install as a PWA. Authenticated
  // REST routes still gate via X-Auth-Token below; the static assets carry
  // no secrets (the auth token lives in localStorage, set via the UI). When
  // the bundle isn't found (dev mode), this is a no-op and the developer
  // hits Vite on :5173 directly.
  //
  // Important: mounted BEFORE the X-Auth-Token middleware so anonymous
  // browsers can fetch /, /assets/*, /manifest.webmanifest, /sw.js, /icon-*.
  // The SPA fallback (also unauth'd) handles deep-link navigations like
  // `/?#/orchestrators/<id>` — the actual REST calls from JS still gate on
  // the token.
  const webRoot = findWebRoot();
  if (webRoot) {
    log.info({ event: 'http.serve_web', root: webRoot });
    app.use(
      express.static(webRoot, {
        // index.html is served explicitly via the SPA fallback below.
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
          }
        },
      }),
    );
    // SPA shell at `/` — needs to land BEFORE the auth middleware so the
    // browser can load the app on a fresh tab without a token already set.
    app.get('/', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
  } else {
    log.warn({ event: 'http.no_web_bundle', note: 'dev mode — Vite serves the bundle on its own port' });
  }

  // VS Code web (`code serve-web`) reverse-proxy. serve-web runs on loopback
  // (config.idePort) with `--server-base-path`, so we forward `<ideBasePath>/*`
  // verbatim (no rewrite). Mounted BEFORE the X-Auth-Token middleware: an
  // iframe navigation cannot send that header, so the editor is guarded by
  // serve-web's own connection-token instead (handed to the authenticated
  // client via `GET /ide-info`). The matching WebSocket upgrades are wired in
  // `startServer`'s `http.on('upgrade')` via the returned handler.
  let ideProxy: ProxyHandler | null = null;
  if (config.ideEnabled) {
    const base = config.ideBasePath;
    ideProxy = createProxyMiddleware({
      target: `http://127.0.0.1:${config.idePort}`,
      changeOrigin: true,
      ws: true,
      pathFilter: (pathname: string) => pathname === base || pathname.startsWith(base + '/'),
    });
    app.use(ideProxy);
  }

  // Phase 8 — bootGate: while auto-resume is rebuilding teams, business
  // routes return 503 (health/info/static stay green). Mounted BEFORE the
  // auth middleware so an operator polling `/orchestrators` during a
  // restart gets a clean 503-Service-Unavailable instead of a half-loaded
  // list (or a 401 if no token, which would be confusing).
  if (bootGate) {
    app.use((req, res, next) => {
      if (bootGate.value) return next();
      res
        .status(503)
        .set('Retry-After', '5')
        .json({
          error: 'BOOT_IN_PROGRESS',
          message: 'auto-resume is still rebuilding teams; retry shortly',
        });
    });
  }

  // J2 — plugin PUBLIC routes (`/public/plugins/:name/*`). Mounted AFTER
  // bootGate (so a 503 during auto-resume applies) but BEFORE the auth gate:
  // these are inbound webhooks that carry no X-Auth-Token — the plugin verifies
  // its own signatures over `req.rawBody`. Never torn down: the dispatcher
  // consults a mutable Map, so a disabled plugin 404s immediately.
  if (pluginHttpRegistry) {
    const pub = Router();
    pub.use('/public/plugins/:name', pluginHttpRegistry.publicDispatcher());
    app.use(pub);
  }

  // Authenticated routes.
  const auth = makeAuthMiddleware(config.token);
  app.use(auth);
  app.use(createOrchestratorsRouter(spawner, config));
  app.use(createSessionsRouter(spawner, config));
  app.use(createWsTicketRouter(spawner));
  // The provider registry is handed in so `defaultProvider` is validated by the
  // form that sets it (400 UNKNOWN_PROVIDER) instead of surfacing days later at
  // team creation.
  app.use(
    createRolesRouter(
      roleStore,
      config,
      onRolesChanged,
      connectorRegistry,
      spawner.providerRegistry,
    ),
  );
  // `GET /providers` — agent-provider catalogue + live availability. Mounted
  // with the other business routes (behind X-Auth-Token): it names the CLIs
  // installed on the deployment host, which is deployment detail, not public
  // information like `/info`.
  app.use(createProvidersRouter(spawner, config));
  app.use(createSettingsRouter(settingsStore));
  // Shared knowledge graph (docs/memoire-partagee.md) — `/api/memory/*`. Behind
  // the X-Auth-Token gate like the other business routes. Mounted only when the
  // store came up (a boot where it failed is unaffected everywhere else).
  if (memory) app.use(createMemoryRouter(memory));
  // Durable task board (docs/tableau-de-taches.md) — `/api/board/*`, READ-ONLY
  // plus one operator DELETE. Behind the X-Auth-Token gate like the memory
  // router. Mounted only when the store came up (a boot where it failed leaves
  // every other subsystem unaffected — the `board.*` MCP tools answer
  // TASKBOARD_UNAVAILABLE and this router is simply absent).
  if (taskboard) app.use(createTaskboardRouter(taskboard));
  // `GET /ide-info` — VS Code web connection details for the authenticated
  // client. Mounted after the auth gate so it 401s without X-Auth-Token
  // (parity with the other business routes). The IDE itself runs on its own
  // port (config.idePort), NOT proxied here.
  app.use(createIdeRouter(config));
  app.use(createPreamblesRouter());
  app.use(createAiRouter(config));
  app.use(createDiscordRouter());
  // S9 + S8 — `GET /metrics/messages` and `GET /metrics/bus`. Mounted
  // after the auth middleware so they return 401 without X-Auth-Token
  // (parity with `/orchestrators`). `/metrics/bus` is only mounted when
  // a `BusMetricsCollector` was provided.
  app.use(createMetricsRouter(aggregator, busMetrics));
  // Operator backup: force a snapshot now + list existing snapshots. Same
  // X-Auth-Token gate as the rest; reuses the live BackupScheduler.
  app.use(createBackupRouter(backup));
  // Update detection — `GET /updates` (system + plugins + eligibility reason)
  // and `POST /updates/dismiss`. Modelled on `/backup` above and mounted here
  // for the same reason: everything this router returns names the deployment
  // (transport, image, release notes), so it belongs behind the token, unlike
  // the `{available, latest}` pair `/info` publishes above. Only mounted when
  // the service came up — a 404 is a truer answer than a router that 500s.
  if (updates) app.use(createUpdatesRouter(updates));
  // Plugin management REST (list/scan/enable/disable/permissions/config/
  // install/upload/upgrade/uninstall). Same X-Auth-Token gate. The `/plugin-api`
  // + `/public/plugins` dispatchers for plugin-owned routes are J2 — this is the
  // control plane. `express.raw` is scoped to `/plugins/upload` inside the router.
  if (pluginHost) {
    app.use(
      createPluginsRouter(
        pluginHost,
        path.join(config.dataDir, 'plugins'),
        pluginInstaller,
        // Feeds `latestVersion` / `updateStatus` onto each PluginView: the
        // plugins page already lists every plugin next to an Upgrade button,
        // so the verdict goes there rather than onto a second screen.
        updates,
      ),
    );
  }

  // J2 — plugin AUTHENTICATED routes (`/plugin-api/:name/*`). Mounted AFTER the
  // auth gate so a token is required, and after the `/plugins` control plane so
  // the distinct prefix keeps the two apart. Never torn down (mutable Map).
  if (pluginHttpRegistry) {
    const authRouter = Router();
    authRouter.use('/plugin-api/:name', pluginHttpRegistry.authDispatcher());
    app.use(authRouter);
  }

  // JSON error handler — must be the LAST middleware. Without this, body-parser
  // failures (entity.too.large, malformed JSON) return Express' default HTML
  // error page, which is awful to consume from a JSON client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
    const status =
      typeof e.status === 'number'
        ? e.status
        : typeof e.statusCode === 'number'
          ? e.statusCode
          : 500;
    let code = 'internal';
    if (e.type === 'entity.too.large') code = 'PAYLOAD_TOO_LARGE';
    else if (e.type === 'entity.parse.failed') code = 'INVALID_JSON';
    res.status(status).json({
      error: e.message ?? 'request failed',
      code,
    });
  });

  return { app, ideProxy };
}

export function startServer(
  config: Config,
  spawner: Spawner,
  roleStore: RoleStore,
  settingsStore: SettingsStore,
  aggregator: MessagesAggregator,
  backup: BackupScheduler,
  busMetrics?: BusMetricsCollector,
  bootGate?: BootGate,
  onRolesChanged?: () => void,
  pluginHost?: PluginHost,
  pluginHttpRegistry?: PluginHttpRegistry,
  pluginInstaller?: PluginInstaller,
  connectorRegistry?: ConnectorRegistry,
  updates?: UpdateService,
  memory?: MemoryStore,
  taskboard?: TaskboardStore,
): ServerHandle {
  const { app, ideProxy } = createApp(
    config,
    spawner,
    roleStore,
    settingsStore,
    aggregator,
    backup,
    busMetrics,
    bootGate,
    onRolesChanged,
    pluginHost,
    pluginHttpRegistry,
    pluginInstaller,
    connectorRegistry,
    updates,
    memory,
    taskboard,
  );
  const http = createServer(app);

  const terminalHub = new TerminalHub(spawner);
  const eventsHub = new EventsHub();

  http.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const ticket = url.searchParams.get('ticket');

      // /ws/sessions/:id
      const termMatch = url.pathname.match(/^\/ws\/sessions\/([^/]+)$/);
      if (termMatch) {
        const sessionId = termMatch[1];
        if (!ticket) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const consumed = consumeTicket(ticket, 'terminal');
        if (!consumed || consumed.sessionId !== sessionId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        if (sessionId) {
          terminalHub.handleUpgrade(sessionId, req, socket, head);
        } else {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
        }
        return;
      }

      // /ws/events
      if (url.pathname === '/ws/events') {
        if (!ticket) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const consumed = consumeTicket(ticket, 'events');
        if (!consumed) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        eventsHub.handleUpgrade(req, socket, head);
        return;
      }

      // VS Code web WebSocket (the editor's remote connection) — proxied to
      // the loopback serve-web. No ticket: guarded by serve-web's
      // connection-token like the rest of `<ideBasePath>/*`.
      if (
        ideProxy &&
        (url.pathname === config.ideBasePath ||
          url.pathname.startsWith(config.ideBasePath + '/'))
      ) {
        // The upgrade event types `socket` as Duplex; at runtime it is a
        // net.Socket, which is what http-proxy-middleware's upgrade expects.
        ideProxy.upgrade?.(req, socket as Socket, head);
        return;
      }

      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    } catch (err) {
      log.error({ event: 'ws.upgrade_failed', error: err instanceof Error ? err.message : String(err) });
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  // Bind 127.0.0.1 unless explicitly overridden via SWARM_OS_HOST.
  http.listen(config.port, config.host, () => {
    log.info({
      event: 'http.listen',
      host: config.host,
      port: config.port,
      project: config.projectName,
    });
  });

  return {
    http,
    spawner,
    aggregator,
    busMetrics: busMetrics ?? null,
    async close(): Promise<void> {
      terminalHub.shutdownAll();
      eventsHub.shutdownAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
