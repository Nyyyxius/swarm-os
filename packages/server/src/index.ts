import { createServer } from 'node:http';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = Number(process.env.SWARM_OS_PORT ?? 8787);
// Bind to localhost by default; container/Tailscale handles external access (see plan §14).
const HOST = process.env.SWARM_OS_HOST ?? '127.0.0.1';

const app = express();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const httpServer = createServer(app);

// Placeholder WS endpoint at /ws/events: accept and echo any inbound message.
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ event: 'hello', ts: new Date().toISOString() }));
  ws.on('message', (data) => {
    // Echo back as-is.
    ws.send(data);
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[swarm-os] server listening on ${HOST}:${PORT}`);
});
