/**
 * `POST /hooks/notification` — the PROVIDER SEMANTICS of one endpoint.
 *
 * Auth, body validation and the unknown-id behaviour are covered end to end in
 * `test/integration/hooks.test.ts`. What lives here is the thing that suite
 * cannot reach: the three-way branch on the session's provider, and in
 * particular the `compactOnWaiting` arm (the integration stack builds its Config
 * from the environment, and `SWARM_OS_COMPACT_ON_WAITING` defaults to false with
 * no override seam).
 *
 * Why the branch exists, in one paragraph. The endpoint was written for Claude
 * Code's `Notification` hook, which fires when the agent is BLOCKED ON A HUMAN.
 * codex reaches the same URL from `notify` and gemini from `hooks.AfterAgent`,
 * both of which fire at EVERY TURN BOUNDARY (spikes S1 C5 / S2 C5 — gemini's even
 * on a failed turn). Before this filter, a codex lead running twenty turns
 * produced twenty `waiting` badges, twenty Discord alerts and twenty armed
 * compactions for an agent nobody was waiting on.
 *
 * Doubles rather than a real Spawner: the three side effects are an event, a
 * notifier call and a `requestContextReset`, all of which a fake reports more
 * precisely than a live PTY would.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createHooksRouter } from './hooks.js';
import { eventBus, type SwarmEvent } from '../../events.js';
import type {
  Notifier,
  NotificationInput,
  CustomNotificationInput,
} from '../../modules/notify/index.js';
import type { Spawner } from '../../modules/spawner/index.js';
import type { NotificationHookSemantics } from '../../modules/providers/types.js';

/** Local double rather than the integration helper — keeps `src` self-contained. */
class RecordingNotifier implements Notifier {
  readonly events: NotificationInput[] = [];
  readonly customEvents: CustomNotificationInput[] = [];
  async notify(input: NotificationInput): Promise<void> {
    this.events.push(input);
  }
  async notifyCustom(input: CustomNotificationInput): Promise<void> {
    this.customEvents.push(input);
  }
}

const HOOK_TOKEN = 'hook-token-under-test';

let listening: Server | null = null;
let unsubscribe: (() => void) | null = null;

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

interface FakeSession {
  id: string;
  resets: Array<{ cmd: string; idleMs: number }>;
}

/**
 * The narrow slice of `Spawner` / `Orchestrator` / `Session` this route touches.
 * `providerCapabilities` is the field under test: the route reads the semantic
 * off the session's OWN adapter, so a provider unregistered mid-flight cannot
 * change how a live session's callbacks are interpreted.
 */
function fakeStack(semantics: NotificationHookSemantics): {
  spawner: Spawner;
  session: FakeSession;
} {
  const resets: Array<{ cmd: string; idleMs: number }> = [];
  const session = {
    id: 'sess-1',
    name: 'lead',
    role: 'coordinator',
    type: 'lead',
    status: 'running',
    exitCode: null,
    stopReason: null,
    resets,
    providerCapabilities: {
      effort: true,
      permissionModes: ['bypassPermissions'],
      fallbackPermissionMode: 'bypassPermissions',
      notificationHook: semantics,
      inkSubmitDance: true,
      durablePreamble: true,
      httpMcp: true,
    },
    toView: () => ({ provider: 'under-test' }),
    requestContextReset: (cmd: string, opts: { idleMs: number }) => {
      resets.push({ cmd, idleMs: opts.idleMs });
      return true;
    },
  };
  const orch = {
    id: 'orch-1',
    name: 'team',
    role: 'coordinator',
    status: 'running',
    getSession: (id: string) => (id === 'sess-1' ? session : null),
  };
  const spawner = {
    get: (id: string) => (id === 'orch-1' ? orch : null),
  } as unknown as Spawner;
  return { spawner, session: session as unknown as FakeSession };
}

async function serve(
  spawner: Spawner,
  notifier: RecordingNotifier,
  compactOnWaiting: boolean,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(
    createHooksRouter(spawner, HOOK_TOKEN, notifier, {
      compactOnWaiting,
      idleThresholdMs: 2_000,
    }),
  );
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** Fire one notification callback and collect everything it caused. */
async function fire(
  semantics: NotificationHookSemantics,
  opts: { compactOnWaiting?: boolean } = {},
): Promise<{
  res: Response;
  body: Record<string, unknown>;
  events: SwarmEvent[];
  notifier: RecordingNotifier;
  session: FakeSession;
}> {
  const { spawner, session } = fakeStack(semantics);
  const notifier = new RecordingNotifier();
  const base = await serve(spawner, notifier, opts.compactOnWaiting ?? false);
  const events: SwarmEvent[] = [];
  unsubscribe = eventBus.onEvent((ev) => events.push(ev));
  const res = await fetch(`${base}/hooks/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK_TOKEN}` },
    body: JSON.stringify({
      orch_id: 'orch-1',
      session_id: 'sess-1',
      kind: 'session.waiting',
      message: 'the agent said something',
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  // The Discord dispatch is fire-and-forget.
  await new Promise((r) => setTimeout(r, 20));
  return { res, body, events, notifier, session };
}

describe('POST /hooks/notification — needs-human (claude)', () => {
  it('flips the badge to waiting AND notifies', async () => {
    const { res, body, events, notifier } = await fire('needs-human');
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    const status = events.filter((e) => e.kind === 'session.status_changed');
    expect(status).toHaveLength(1);
    expect(status[0]?.payload).toEqual({ status: 'waiting', reason: 'notification-hook' });
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.kind).toBe('session.waiting');
    expect(notifier.events[0]?.session?.id).toBe('sess-1');
  });

  it('arms the /compact safety net when the option is on', async () => {
    const { session } = await fire('needs-human', { compactOnWaiting: true });
    expect(session.resets).toEqual([{ cmd: '/compact', idleMs: 2_000 }]);
  });

  it('arms nothing when the option is off', async () => {
    const { session } = await fire('needs-human');
    expect(session.resets).toEqual([]);
  });
});

describe('POST /hooks/notification — turn-complete (codex, gemini)', () => {
  it('does NOT notify and does NOT move the badge', async () => {
    // THE regression this file exists for. A finished turn is not a request for
    // attention: announcing it means one Discord alert per turn, and `waiting` on
    // an agent that is simply between turns is a lie the operator acts on.
    const { res, body, events, notifier } = await fire('turn-complete');
    expect(res.status).toBe(200);
    expect(events.filter((e) => e.kind === 'session.status_changed')).toHaveLength(0);
    expect(notifier.events).toHaveLength(0);
    // …and the response says WHY, so an operator curling the endpoint can tell
    // "filtered" from "Discord is broken".
    expect(body).toEqual({ ok: true, notified: false, semantics: 'turn-complete' });
  });

  it('arms NO /compact either, even with compactOnWaiting on', async () => {
    // Considered and rejected — see the route's module header. In short: a
    // volume-driven `/compact` already lands on the SAME idle boundary for any
    // provider (`Session._maybeAutoCompact`, `SWARM_OS_AUTO_COMPACT_BYTES`), so
    // the only thing this branch could add is compaction on EVERY turn however
    // small the context; that is lossy, costs a model call each time, and can
    // feed itself (the compaction is a turn, whose completion fires the callback
    // again — a session that compacts forever and merely looks busy).
    const { session } = await fire('turn-complete', { compactOnWaiting: true });
    expect(session.resets).toEqual([]);
  });
});

describe('POST /hooks/notification — no consumed callback (opencode)', () => {
  it('ignores the callback entirely, and still answers 200', async () => {
    // The provider declares that nothing we consume calls back, so a POST
    // claiming otherwise is a stale per-session config file or a wrong
    // declaration — trusting it over the declaration is how a provider that
    // cannot report `waiting` starts reporting it. 200 because per spike H6 a
    // non-2xx can crash the calling CLI.
    const { res, body, events, notifier, session } = await fire(false, {
      compactOnWaiting: true,
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, ignored: 'provider_sends_no_notification' });
    expect(events).toHaveLength(0);
    expect(notifier.events).toHaveLength(0);
    expect(session.resets).toEqual([]);
  });
});
