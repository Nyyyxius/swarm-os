import { EventEmitter } from 'node:events';

export type SwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited';

export interface SwarmEvent {
  kind: SwarmEventKind;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  payload?: unknown;
}

class SwarmEventBus extends EventEmitter {
  emitEvent(ev: Omit<SwarmEvent, 'ts'>): void {
    const full: SwarmEvent = { ...ev, ts: new Date().toISOString() };
    this.emit('event', full);
  }

  onEvent(cb: (ev: SwarmEvent) => void): () => void {
    this.on('event', cb);
    return () => this.off('event', cb);
  }
}

export const eventBus = new SwarmEventBus();
// Allow many WS subscribers without spurious warnings.
eventBus.setMaxListeners(100);
