import { Orchestrator, type OrchestratorInit, type StartOptions } from '../orchestrator/index.js';
import { eventBus } from '../../events.js';
import type { Config } from '../../config.js';
import type { Session } from '../orchestrator/session.js';

export type { OrchestratorInit, StartOptions };

export class SpawnerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'SpawnerError';
  }
}

export interface SpawnerCreateResult {
  orchestrator: Orchestrator;
  lead: Session;
}

export class Spawner {
  private readonly orchestrators = new Map<string, Orchestrator>();

  constructor(private readonly config: Config) {}

  create(spec: OrchestratorInit, opts: StartOptions = {}): SpawnerCreateResult {
    const active = this.listActive().length;
    if (active >= this.config.maxOrchestrators) {
      throw new SpawnerError(
        `max orchestrators (${this.config.maxOrchestrators}) reached`,
        'MAX_ORCHESTRATORS',
        429,
      );
    }
    const orch = new Orchestrator(spec, this.config);
    this.orchestrators.set(orch.id, orch);
    eventBus.emitEvent({
      kind: 'orchestrator.created',
      orchestratorId: orch.id,
      payload: orch.toView(),
    });
    const lead = orch.start(opts);
    return { orchestrator: orch, lead };
  }

  get(id: string): Orchestrator | undefined {
    return this.orchestrators.get(id);
  }

  list(): Orchestrator[] {
    return Array.from(this.orchestrators.values());
  }

  listActive(): Orchestrator[] {
    return this.list().filter(
      (o) => o.status !== 'stopped' && o.status !== 'failed',
    );
  }

  /** Idempotent: returns true if it was running and is now stopped, false if no-op. */
  destroy(id: string, reason = 'user'): boolean {
    const orch = this.orchestrators.get(id);
    if (!orch) return false;
    if (orch.status === 'stopped' || orch.status === 'failed') {
      return false;
    }
    orch.stop(reason);
    eventBus.emitEvent({
      kind: 'orchestrator.destroyed',
      orchestratorId: id,
      payload: { reason },
    });
    return true;
  }

  /** Stop everything — used at process shutdown. */
  shutdownAll(reason = 'shutdown'): void {
    for (const orch of this.orchestrators.values()) {
      try {
        orch.stop(reason);
      } catch (err) {
        console.error('[swarm-os] error stopping orchestrator', orch.id, err);
      }
    }
  }

  /** Counters for /health. */
  counters(): { orchestratorsActive: number; sessionsActive: number; sessionsWaiting: number } {
    let sessionsActive = 0;
    let sessionsWaiting = 0;
    const orchestratorsActive = this.listActive().length;
    for (const orch of this.orchestrators.values()) {
      for (const s of orch.listSessions()) {
        if (s.status === 'running' || s.status === 'starting') sessionsActive++;
        if (s.status === 'waiting') sessionsWaiting++;
      }
    }
    return { orchestratorsActive, sessionsActive, sessionsWaiting };
  }

  /** Find a session across all orchestrators. */
  findSession(sessionId: string): { orchestrator: Orchestrator; session: Session } | null {
    for (const orch of this.orchestrators.values()) {
      const s = orch.getSession(sessionId);
      if (s) return { orchestrator: orch, session: s };
    }
    return null;
  }
}
