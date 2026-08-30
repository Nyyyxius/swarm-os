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
import type { ApprovalStore, CreateApprovalInput, ApprovalRequest } from '../../modules/approvals/store.js';

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

/**
 * Records `createRequest` calls so a test can assert the approval gate armed (or
 * did NOT arm, the bypass guarantee) without a live SQLite store. Only the one
 * method the route calls is implemented; the rest of `ApprovalStore` is unused
 * here and cast away.
 */
class RecordingApprovals {
  readonly created: CreateApprovalInput[] = [];
  createRequest(input: CreateApprovalInput): ApprovalRequest | null {
    this.created.push(input);
    return {
      id: 'appr-under-test',
      orchestratorId: input.orchestratorId,
      sessionId: input.sessionId,
      category: input.category,
      requestedSummary: input.requestedSummary,
      rawMessage: input.rawMessage,
      permissionMode: input.permissionMode,
      provider: input.provider,
      status: 'pending',
      createdAt: 0,
      expiresAt: null,
      resolvedAt: null,
      resolvedBy: null,
      decision: null,
    };
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
  /** Monitoring — every path the route handed to `setTranscriptPath`, in order. */
  transcripts: string[];
  /** Monitoring — every codex `thread-id` the route handed over, in order. */
  threadIds: string[];
}

/**
 * The narrow slice of `Spawner` / `Orchestrator` / `Session` this route touches.
 * `providerCapabilities` is the field under test: the route reads the semantic
 * off the session's OWN adapter, so a provider unregistered mid-flight cannot
 * change how a live session's callbacks are interpreted.
 */
function fakeStack(
  semantics: NotificationHookSemantics,
  opts: {
    provider?: string;
    permissionMode?: string;
    // P5: when present (even null), the orch is given a role carrying this
    // approval override, reachable via `spawner.roleStore.get`.
    roleApproval?: Record<string, unknown> | null;
  } = {},
): {
  spawner: Spawner;
  session: FakeSession;
  orchNotifier: RecordingNotifier;
} {
  const provider = opts.provider ?? 'under-test';
  const permissionMode = opts.permissionMode ?? 'bypassPermissions';
  const hasRole = 'roleApproval' in opts;
  const resets: Array<{ cmd: string; idleMs: number }> = [];
  const transcripts: string[] = [];
  const threadIds: string[] = [];
  const session = {
    id: 'sess-1',
    name: 'lead',
    role: 'coordinator',
    type: 'lead',
    status: 'running',
    exitCode: null,
    stopReason: null,
    permissionMode,
    resets,
    transcripts,
    threadIds,
    providerCapabilities: {
      effort: true,
      permissionModes: ['bypassPermissions'],
      fallbackPermissionMode: 'bypassPermissions',
      notificationHook: semantics,
      inkSubmitDance: true,
      durablePreamble: true,
      httpMcp: true,
    },
    toView: () => ({ provider }),
    requestContextReset: (cmd: string, opts2: { idleMs: number }) => {
      resets.push({ cmd, idleMs: opts2.idleMs });
      return true;
    },
    setTranscriptPath: (filePath: string) => {
      transcripts.push(filePath);
    },
    setAgentThreadId: (threadId: string) => {
      threadIds.push(threadId);
    },
  };
  // The PER-ORCH notifier (docs §2.2) — distinct from the global one passed to
  // the router. The P3 enriched approval embed goes here, the legacy
  // `session.waiting` ping to the global one.
  const orchNotifier = new RecordingNotifier();
  const orch = {
    id: 'orch-1',
    name: 'team',
    role: 'coordinator',
    status: 'running',
    notifier: orchNotifier,
    roleId: hasRole ? 'role-1' : null,
    getSession: (id: string) => (id === 'sess-1' ? session : null),
  };
  const roleStore = hasRole
    ? { get: (id: string) => (id === 'role-1' ? { id: 'role-1', approval: opts.roleApproval } : null) }
    : undefined;
  const spawner = {
    get: (id: string) => (id === 'orch-1' ? orch : null),
    ...(roleStore ? { roleStore } : {}),
  } as unknown as Spawner;
  return { spawner, session: session as unknown as FakeSession, orchNotifier };
}

async function serve(
  spawner: Spawner,
  notifier: RecordingNotifier,
  compactOnWaiting: boolean,
  approvals?: RecordingApprovals,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(
    createHooksRouter(
      spawner,
      HOOK_TOKEN,
      notifier,
      {
        compactOnWaiting,
        idleThresholdMs: 2_000,
      },
      approvals as unknown as ApprovalStore | undefined,
    ),
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
  opts: {
    compactOnWaiting?: boolean;
    provider?: string;
    permissionMode?: string;
    approvals?: RecordingApprovals;
    message?: string;
    roleApproval?: Record<string, unknown> | null;
  } = {},
): Promise<{
  res: Response;
  body: Record<string, unknown>;
  events: SwarmEvent[];
  notifier: RecordingNotifier;
  orchNotifier: RecordingNotifier;
  session: FakeSession;
  approvals?: RecordingApprovals;
}> {
  const { spawner, session, orchNotifier } = fakeStack(semantics, {
    provider: opts.provider,
    permissionMode: opts.permissionMode,
    ...('roleApproval' in opts ? { roleApproval: opts.roleApproval } : {}),
  });
  const notifier = new RecordingNotifier();
  const base = await serve(spawner, notifier, opts.compactOnWaiting ?? false, opts.approvals);
  const events: SwarmEvent[] = [];
  unsubscribe = eventBus.onEvent((ev) => events.push(ev));
  const res = await fetch(`${base}/hooks/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK_TOKEN}` },
    body: JSON.stringify({
      orch_id: 'orch-1',
      session_id: 'sess-1',
      kind: 'session.waiting',
      message: opts.message ?? 'the agent said something',
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  // The Discord dispatch is fire-and-forget.
  await new Promise((r) => setTimeout(r, 20));
  return { res, body, events, notifier, orchNotifier, session, approvals: opts.approvals };
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

describe('POST /hooks/notification — approval gate (P1)', () => {
  it('records a pending approval when the session prompts (claude/default)', async () => {
    const approvals = new RecordingApprovals();
    const { res, approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      message: 'Claude needs your permission to use Bash',
    });
    expect(res.status).toBe(200);
    expect(seen!.created).toHaveLength(1);
    const input = seen!.created[0];
    expect(input.orchestratorId).toBe('orch-1');
    expect(input.sessionId).toBe('sess-1');
    expect(input.provider).toBe('claude');
    expect(input.permissionMode).toBe('default');
    // Classified from the message (permission phrasing + a tool name).
    expect(input.category).toBe('permission');
    expect(input.requestedSummary).toBe('Claude needs your permission to use Bash');
  });

  it('records NOTHING for a bypassPermissions session (the hard guarantee)', async () => {
    // docs §10 / §1: a bypass team is never slowed by an approval. Even though a
    // `needs-human` callback fired, the gate must not arm — bypass emits no
    // prompt, so an approval here would be a phantom.
    const approvals = new RecordingApprovals();
    const { res, events, notifier } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      approvals,
    });
    expect(res.status).toBe(200);
    expect(approvals.created).toHaveLength(0);
    // …and the legacy waiting/Discord path is UNTOUCHED (behaviour unchanged).
    expect(events.filter((e) => e.kind === 'session.status_changed')).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);
  });

  it('records nothing for a non-claude provider today (bypass-only providers)', async () => {
    const approvals = new RecordingApprovals();
    const { approvals: seen } = await fire('needs-human', {
      provider: 'gemini',
      permissionMode: 'default',
      approvals,
    });
    expect(seen!.created).toHaveLength(0);
  });

  it('still flips the badge + notifies even when no approval store is wired', async () => {
    // The store is optional (may have failed to open at boot); the legacy path
    // must keep working regardless.
    const { res, events, notifier } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
    });
    expect(res.status).toBe(200);
    expect(events.filter((e) => e.kind === 'session.status_changed')).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);
  });
});

describe('POST /hooks/notification — per-role override (P5)', () => {
  it('a role WITHOUT approval settings behaves exactly like the default', async () => {
    const approvals = new RecordingApprovals();
    const { approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      roleApproval: null, // role exists, no override
      message: 'Claude needs your permission to use Bash',
    });
    expect(seen!.created).toHaveLength(1); // same as no-role default
  });

  it('enabled:false disables the guard even for a normally-arming mode', async () => {
    const approvals = new RecordingApprovals();
    const { res, events, notifier, approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      roleApproval: { enabled: false },
    });
    expect(res.status).toBe(200);
    expect(seen!.created).toHaveLength(0); // guard OFF for this role
    // Legacy waiting path is still untouched.
    expect(events.filter((e) => e.kind === 'session.status_changed')).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);
  });

  it('armingModes can arm a mode the default would NOT (bypassPermissions)', async () => {
    const approvals = new RecordingApprovals();
    const { approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      approvals,
      roleApproval: { armingModes: ['bypassPermissions'] },
    });
    expect(seen!.created).toHaveLength(1); // override armed a normally-silent mode
  });

  it('armingModes can DISARM a mode the default would arm (default not listed)', async () => {
    const approvals = new RecordingApprovals();
    const { approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      roleApproval: { armingModes: ['plan'] }, // default excluded
    });
    expect(seen!.created).toHaveLength(0);
  });

  it('discordNotify:false suppresses the Discord embed but still records + flips the badge', async () => {
    const approvals = new RecordingApprovals();
    const { res, events, notifier, orchNotifier, approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      roleApproval: { discordNotify: false },
      message: 'Claude needs your permission to use Bash',
    });
    expect(res.status).toBe(200);
    expect(seen!.created).toHaveLength(1); // approval STILL created
    // The Discord approval embed is suppressed for this role...
    expect(orchNotifier.events).toHaveLength(0);
    // ...but the legacy waiting badge + global ping are untouched.
    expect(events.filter((e) => e.kind === 'session.status_changed')).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);
  });

  it('discordNotify defaults ON when the role sets other fields only', async () => {
    const approvals = new RecordingApprovals();
    const { orchNotifier, approvals: seen } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      roleApproval: { enabled: true },
      message: 'Claude needs your permission to use Bash',
    });
    expect(seen!.created).toHaveLength(1);
    expect(orchNotifier.events).toHaveLength(1); // embed still posted (default ON)
  });
});

describe('POST /hooks/notification — enriched approval notification (P3)', () => {
  it('fires an enriched session.approval_requested to the PER-ORCH notifier', async () => {
    // Additive to the legacy `session.waiting`: the per-orch notifier gets the
    // enriched embed naming what is requested + the approvalId; the GLOBAL
    // notifier still gets exactly the one legacy waiting ping.
    const approvals = new RecordingApprovals();
    const { orchNotifier, notifier } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'default',
      approvals,
      message: 'Claude needs your permission to use Bash',
    });

    expect(orchNotifier.events).toHaveLength(1);
    const enriched = orchNotifier.events[0]!;
    expect(enriched.kind).toBe('session.approval_requested');
    expect(enriched.session?.id).toBe('sess-1');
    expect(enriched.orchestrator.id).toBe('orch-1');
    expect(enriched.message).toBe('Claude needs your permission to use Bash');
    expect(enriched.extra?.approvalId).toBe('appr-under-test');
    expect(enriched.extra?.category).toBe('permission');

    // The legacy global waiting ping is untouched (additive, not a replacement).
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.kind).toBe('session.waiting');
  });

  it('sends NO enriched notification for a bypass session (bypass guarantee)', async () => {
    const approvals = new RecordingApprovals();
    const { orchNotifier, notifier } = await fire('needs-human', {
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      approvals,
    });
    // No approval recorded → no enriched embed. Legacy waiting still fires.
    expect(approvals.created).toHaveLength(0);
    expect(orchNotifier.events).toHaveLength(0);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.kind).toBe('session.waiting');
  });
});

// ---------------------------------------------------------------------------
// `session.transcript` — the SessionStart channel (docs/monitoring-agents.md)
// ---------------------------------------------------------------------------

/**
 * POST one hook body verbatim (no envelope helper): these tests are about what
 * the route tolerates, so the body has to be under the test's control.
 */
async function post(
  spawner: Spawner,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = await serve(spawner, new RecordingNotifier(), false);
  const res = await fetch(`${base}/hooks/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The payload claude's `SessionStart` hook actually delivers (spike S2). */
function sessionStartPayload(transcriptPath: string): string {
  return JSON.stringify({
    session_id: '566a03de-207e-46a4-b772-25d47de95e6c',
    transcript_path: transcriptPath,
    cwd: '/workspace/demo',
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
}

describe('POST /hooks/notification — session.transcript', () => {
  const TRANSCRIPT = '/home/ubuntu/.claude/projects/-workspace-demo/566a03de.jsonl';

  it('adopts the transcript path and answers 200', async () => {
    const { spawner, session } = fakeStack('needs-human');
    const { status, body } = await post(spawner, {
      orch_id: 'orch-1',
      session_id: 'sess-1',
      kind: 'session.transcript',
      message: sessionStartPayload(TRANSCRIPT),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, transcript: true });
    expect(session.transcripts).toEqual([TRANSCRIPT]);
  });

  it('answers 200 on a payload it cannot read at all', async () => {
    // The hook runs SYNCHRONOUSLY while the CLI boots. A body we cannot parse
    // costs one poll cycle of gauge; it must never cost a startup. Three shapes
    // that all reach the same answer.
    const bodies = [
      'not json at all',
      JSON.stringify({ hook_event_name: 'SessionStart' }),
      JSON.stringify({ transcript_path: 42 }),
    ];
    for (const message of bodies) {
      const { spawner, session } = fakeStack('needs-human');
      const { status, body } = await post(spawner, {
        orch_id: 'orch-1',
        session_id: 'sess-1',
        kind: 'session.transcript',
        message,
      });
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, transcript: false });
      expect(session.transcripts).toEqual([]);
    }
  });

  it('fires none of the waiting side effects', async () => {
    // A SessionStart is not a request for attention: no badge, no Discord, no
    // armed /compact. Only the path is taken from it.
    const { spawner, session } = fakeStack('needs-human');
    const notifier = new RecordingNotifier();
    const base = await serve(spawner, notifier, true);
    const events: SwarmEvent[] = [];
    unsubscribe = eventBus.onEvent((ev) => events.push(ev));
    await fetch(`${base}/hooks/notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK_TOKEN}` },
      body: JSON.stringify({
        orch_id: 'orch-1',
        session_id: 'sess-1',
        kind: 'session.transcript',
        message: sessionStartPayload(TRANSCRIPT),
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(notifier.events).toEqual([]);
    expect(session.resets).toEqual([]);
    expect(events.filter((e) => e.kind === 'session.status_changed')).toEqual([]);
  });

  it('reaches a provider that declares no notification callback', async () => {
    // `notificationHook: false` gates the WAITING semantics, not this one:
    // SessionStart is a different hook, and a session that never reports
    // `waiting` still has a transcript worth reading.
    const { spawner, session } = fakeStack(false);
    const { status } = await post(spawner, {
      orch_id: 'orch-1',
      session_id: 'sess-1',
      kind: 'session.transcript',
      message: sessionStartPayload(TRANSCRIPT),
    });
    expect(status).toBe(200);
    expect(session.transcripts).toEqual([TRANSCRIPT]);
  });

  it('still answers 200 for an unknown session (a restart race)', async () => {
    const { spawner } = fakeStack('needs-human');
    const { status, body } = await post(spawner, {
      orch_id: 'orch-1',
      session_id: 'sess-gone',
      kind: 'session.transcript',
      message: sessionStartPayload(TRANSCRIPT),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ignored: 'session_unknown' });
  });

  it('rejects an unknown kind, exactly as before', async () => {
    const { spawner } = fakeStack('needs-human');
    const { status } = await post(spawner, {
      orch_id: 'orch-1',
      session_id: 'sess-1',
      kind: 'session.invented',
      message: '{}',
    });
    expect(status).toBe(400);
  });
});

describe('POST /hooks/notification — belt-and-braces transcript parse', () => {
  it('takes `transcript_path` out of a WAITING payload too', async () => {
    // claude's `Notification` payload carries it as well. An agent whose
    // SessionStart hook never fired (an older per-session settings.json left by
    // a previous release) still ends up tracked.
    const { session } = await fire('needs-human', {
      message: JSON.stringify({
        session_id: 'x',
        transcript_path: '/home/ubuntu/.claude/projects/-w/abc.jsonl',
        hook_event_name: 'Notification',
      }),
    });
    expect(session.transcripts).toEqual(['/home/ubuntu/.claude/projects/-w/abc.jsonl']);
  });

  it('leaves the waiting branch untouched when the message is a plain sentence', async () => {
    const { res, body, notifier, session } = await fire('needs-human', {
      message: 'Claude needs your permission to use Bash',
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(session.transcripts).toEqual([]);
    expect(session.threadIds).toEqual([]);
    expect(notifier.events).toHaveLength(1);
  });
});

describe('POST /hooks/notification — codex thread-id (Lot 6)', () => {
  /** The payload codex hands `notify.sh` as argv[1] (spike verify-codex C5). */
  function notifyPayload(threadId: string): string {
    return JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': threadId,
      'turn-id': '019fa005-1aba-7150-bc42-560d5c66e27c',
      cwd: '/workspace/demo',
      client: 'codex-tui',
      'input-messages': ['do the thing'],
      'last-assistant-message': 'done',
    });
  }

  const THREAD = '019fa005-0a8b-7f73-ba10-1ae5a444ea73';

  it('hands the thread-id to the session and still answers 200', async () => {
    // It rides the `session.waiting` kind because that IS what codex posts: one
    // `notify` per completed turn, which the route already treats as a turn
    // boundary. The thread-id is simply the other thing that payload carries.
    const { res, body, session } = await fire('turn-complete', {
      message: notifyPayload(THREAD),
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, semantics: 'turn-complete' });
    expect(session.threadIds).toEqual([THREAD]);
  });

  it('accepts the snake_case spelling too', async () => {
    const { session } = await fire('turn-complete', {
      message: JSON.stringify({ type: 'agent-turn-complete', thread_id: THREAD }),
    });
    expect(session.threadIds).toEqual([THREAD]);
  });

  it('takes nothing from a payload that carries no thread at all', async () => {
    for (const message of ['not json', '{}', JSON.stringify({ 'thread-id': 42 })]) {
      const { res, session } = await fire('turn-complete', { message });
      expect(res.status).toBe(200);
      expect(session.threadIds).toEqual([]);
    }
  });

  it('reaches the session through the SessionStart kind as well', async () => {
    // Belt and braces, exactly like the transcript path: whichever kind the
    // payload arrives on, every field we can use is read from it.
    const { spawner, session } = fakeStack('turn-complete');
    const { status } = await post(spawner, {
      orch_id: 'orch-1',
      session_id: 'sess-1',
      kind: 'session.transcript',
      message: notifyPayload(THREAD),
    });
    expect(status).toBe(200);
    expect(session.threadIds).toEqual([THREAD]);
  });
});
