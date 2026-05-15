import { createServer, type Server } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { Spawner } from '../modules/spawner/index.js';
import type { Config } from '../config.js';
import { makeAuthMiddleware, consumeTicket } from './auth.js';
import { createOrchestratorsRouter } from './routes/orchestrators.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createWsTicketRouter } from './routes/ws-ticket.js';
import { TerminalHub } from './ws/terminal.js';
import { EventsHub } from './ws/events.js';

export interface ServerHandle {
  http: Server;
  spawner: Spawner;
  close(): Promise<void>;
}

export function createApp(config: Config, spawner: Spawner): { app: express.Express } {
  const app = express();
  app.disable('x-powered-by');
  // Body-parser limit gets the prompt cap PLUS headroom for JSON envelope
  // (name, role, cwd, preamble, defaults, quoting, escapes). The route handler
  // is the canonical enforcer of `prompt+preamble <= maxPromptSizeBytes` and
  // returns a clean 413 with details; the body-parser cap exists only to stop
  // pathological abuse of the socket.
  const bodyLimitKb = Math.max(64, Math.ceil(config.maxPromptSizeBytes / 1024) + 64);
  app.use(express.json({ limit: `${bodyLimitKb}kb` }));

  // Public: health & info & hooks notification (latter not implemented this phase).
  app.get('/health', (_req: Request, res: Response) => {
    const c = spawner.counters();
    res.json({
      status: 'ok',
      project_name: config.projectName,
      orchestrators_active: c.orchestratorsActive,
      sessions_active: c.sessionsActive,
      sessions_waiting: c.sessionsWaiting,
      uptime_seconds: Math.round(process.uptime()),
    });
  });

  app.get('/info', (_req: Request, res: Response) => {
    res.json({
      project_name: config.projectName,
      version: config.version,
      started_at: config.startedAt,
    });
  });

  // Authenticated routes.
  const auth = makeAuthMiddleware(config.token);
  app.use(auth);
  app.use(createOrchestratorsRouter(spawner, config));
  app.use(createSessionsRouter(spawner));
  app.use(createWsTicketRouter(spawner));

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

  return { app };
}

export function startServer(config: Config, spawner: Spawner): ServerHandle {
  const { app } = createApp(config, spawner);
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

      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    } catch (err) {
      console.error('[swarm-os] upgrade error:', err);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  // Bind 127.0.0.1 unless explicitly overridden via SWARM_OS_HOST.
  http.listen(config.port, config.host, () => {
    console.log(
      `[swarm-os] listening on http://${config.host}:${config.port} (project=${config.projectName})`,
    );
  });

  return {
    http,
    spawner,
    async close(): Promise<void> {
      terminalHub.shutdownAll();
      eventsHub.shutdownAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
