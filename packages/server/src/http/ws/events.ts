import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from '../../events.js';

export class EventsHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.unsubscribe = eventBus.onEvent((ev) => {
      const payload = JSON.stringify(ev);
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(payload);
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  handleUpgrade(
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      try {
        ws.send(JSON.stringify({ kind: 'hello', ts: new Date().toISOString() }));
      } catch {
        /* ignore */
      }
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  shutdownAll(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}
