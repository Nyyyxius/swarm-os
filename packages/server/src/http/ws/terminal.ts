import { WebSocketServer, WebSocket } from 'ws';
import { Spawner } from '../../modules/spawner/index.js';
import type { Session } from '../../modules/orchestrator/session.js';
import type { Disposable } from '../../modules/orchestrator/agent-process.js';

interface AttachState {
  ws: WebSocket;
  isWriter: boolean;
}

/**
 * One TerminalRoom per session. First connection becomes writer; subsequent
 * are read-only. On writer disconnect, the next connected client is promoted.
 */
class TerminalRoom {
  private readonly clients: AttachState[] = [];
  private dataDisposable: Disposable | null = null;
  private exitListener: (() => void) | null = null;

  constructor(private readonly session: Session) {
    this.dataDisposable = session.onData((d) => this.broadcast(d));
    const onExit = (): void => {
      for (const c of this.clients) {
        try {
          c.ws.send(JSON.stringify({ type: 'exit', ts: new Date().toISOString() }));
          c.ws.close(1000, 'session exited');
        } catch {
          /* ignore */
        }
      }
      this.clients.length = 0;
      this.dataDisposable?.dispose();
      this.dataDisposable = null;
    };
    this.exitListener = onExit;
    session.once('exit', onExit);
  }

  attach(ws: WebSocket): void {
    const isWriter = !this.clients.some((c) => c.isWriter);
    const state: AttachState = { ws, isWriter };
    this.clients.push(state);

    // Send initial role + recent buffer so a fresh attach has context.
    try {
      ws.send(
        JSON.stringify({
          type: 'attached',
          role: isWriter ? 'writer' : 'reader',
          sessionId: this.session.id,
          status: this.session.status,
        }),
      );
      const recent = this.session.getRecentLines(50);
      if (recent.length > 0) {
        ws.send(JSON.stringify({ type: 'replay', lines: recent }));
      }
    } catch {
      /* ignore */
    }

    ws.on('message', (raw, isBinary) => {
      // We accept either binary keystrokes or JSON control messages.
      if (isBinary) {
        if (state.isWriter) this.session.writeInput(raw.toString('utf8'));
        return;
      }
      const text = raw.toString('utf8');
      // Try JSON first.
      try {
        const obj = JSON.parse(text) as { type?: string; data?: string; cols?: number; rows?: number };
        if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
          if (obj.type === 'input') {
            if (state.isWriter && typeof obj.data === 'string') this.session.writeInput(obj.data);
            return;
          }
          if (obj.type === 'resize') {
            if (state.isWriter && typeof obj.cols === 'number' && typeof obj.rows === 'number') {
              this.session.resize(obj.cols, obj.rows);
            }
            return;
          }
        }
      } catch {
        // Not JSON — treat as raw keystroke text from the writer.
      }
      if (state.isWriter) this.session.writeInput(text);
    });

    ws.on('close', () => this.detach(state));
    ws.on('error', () => this.detach(state));
  }

  private detach(state: AttachState): void {
    const idx = this.clients.indexOf(state);
    if (idx === -1) return;
    this.clients.splice(idx, 1);
    if (state.isWriter && this.clients.length > 0) {
      // Promote next client.
      const next = this.clients[0];
      if (next) {
        next.isWriter = true;
        try {
          next.ws.send(JSON.stringify({ type: 'role-changed', role: 'writer' }));
        } catch {
          /* ignore */
        }
      }
    }
  }

  private broadcast(data: string): void {
    const payload = JSON.stringify({ type: 'data', data });
    for (const c of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
  }

  get clientCount(): number {
    return this.clients.length;
  }

  shutdown(): void {
    if (this.exitListener) {
      this.session.off('exit', this.exitListener);
      this.exitListener = null;
    }
    this.dataDisposable?.dispose();
    this.dataDisposable = null;
    for (const c of this.clients) {
      try {
        c.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.length = 0;
  }
}

export class TerminalHub {
  private readonly rooms = new Map<string, TerminalRoom>();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly spawner: Spawner) {}

  /** Called by upgrade router after ticket is consumed and session located. */
  handleUpgrade(
    sessionId: string,
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const found = this.spawner.findSession(sessionId);
    if (!found) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const session = found.session;
    let room = this.rooms.get(session.id);
    if (!room) {
      room = new TerminalRoom(session);
      this.rooms.set(session.id, room);
      // Cleanup when session exits.
      session.once('exit', () => {
        const r = this.rooms.get(session.id);
        if (r) {
          r.shutdown();
          this.rooms.delete(session.id);
        }
      });
    }
    const r = room;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      r.attach(ws);
    });
  }

  shutdownAll(): void {
    for (const r of this.rooms.values()) r.shutdown();
    this.rooms.clear();
    this.wss.close();
  }
}
