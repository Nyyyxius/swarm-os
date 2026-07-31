import { WebSocketServer, WebSocket } from 'ws';
import { Spawner } from '../../modules/spawner/index.js';
import type { Session } from '../../modules/orchestrator/session.js';
import type { Disposable } from '../../modules/orchestrator/agent-process.js';
import { readConsoleTail } from '../../modules/orchestrator/console-tail.js';

/** Fallback replay depth when the on-disk log yields nothing (fresh session). */
const RING_FALLBACK_LINES = 200;

interface AttachState {
  ws: WebSocket;
  isWriter: boolean;
  /**
   * Whether this client's first `resize` has been handled. The first one
   * triggers the attach repaint nudge; later ones are genuine resizes.
   */
  sawResize: boolean;
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
    const state: AttachState = { ws, isWriter, sawResize: false };
    this.clients.push(state);

    // Send initial role + scrollback so a fresh attach has context.
    try {
      ws.send(
        JSON.stringify({
          type: 'attached',
          role: isWriter ? 'writer' : 'reader',
          sessionId: this.session.id,
          status: this.session.status,
        }),
      );
      // Deep history comes from the on-disk PTY log, rendered to linear
      // colour-preserving lines. It survives server restarts and is bounded
      // by disk rather than by the in-memory ring buffer. The ring buffer is
      // only a fallback for a session so fresh nothing has reached disk yet
      // (the log stream write is async).
      let recent = readConsoleTail(this.session.logPath);
      if (recent.length === 0) recent = this.session.getRecentLines(RING_FALLBACK_LINES);
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
              if (state.sawResize) {
                this.session.resize(obj.cols, obj.rows);
              } else {
                state.sawResize = true;
                this.nudgeRepaint(obj.cols, obj.rows);
              }
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

  /**
   * Force the agent's TUI to repaint on attach.
   *
   * A client that just attached holds no screen state, and the replayed
   * scrollback is inert text. The live TUI only redraws when it is told to,
   * and its cue is SIGWINCH — which the kernel raises ONLY when the winsize
   * actually changes (`tty_do_resize` short-circuits on an identical
   * winsize). So a client attaching at the size the PTY already has would get
   * no repaint at all, leaving the prompt invisible until the agent happened
   * to emit something. Bracketing the real size with a one-row delta
   * guarantees the signal.
   *
   * The delay lets the TUI finish reflowing at the probe size before we
   * settle on the real one; both resizes are no-ops if the agent has exited.
   */
  private nudgeRepaint(cols: number, rows: number): void {
    const probe = rows > 1 ? rows - 1 : rows + 1;
    try {
      this.session.resize(cols, probe);
    } catch {
      /* session may have exited between attach and resize */
    }
    const t = setTimeout(() => {
      try {
        this.session.resize(cols, rows);
      } catch {
        /* ignore */
      }
    }, 50);
    // Never hold the event loop open for a repaint cosmetic.
    if (typeof t.unref === 'function') t.unref();
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
