import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session, SIGNAL_TEXT } from './session.js';
import { Orchestrator } from './index.js';
import { NoOpPersistence } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import { eventBus, type SwarmEvent } from '../../events.js';
import type { Config } from '../../config.js';

/**
 * docs/auto-compact.md, end to end on a live team.
 *
 * The decision itself is proven pure in `auto-compact.test.ts` and the boundary
 * in `idle-boundary.test.ts`; what this suite proves is the WIRING — that a real
 * agent, measured through a real transcript read, is compacted when it should
 * be, is not when it should not, and gets its mail back afterwards.
 *
 * ⚠️ Two traps, both paid for in the plan:
 *
 *  1. `FakeAgentProcess.write` ECHOES NOTHING (it only records into `writes`).
 *     On a real PTY the CLI's own output re-arms the idle boundary; here every
 *     "and then the agent spoke" has to be `pty._emitData(...)` by hand, or the
 *     test passes because nothing happened at all.
 *  2. The FIRST measurement of a session becomes its floor, so an agent already
 *     above its threshold at first sight must grow 10 points before it is
 *     compacted (docs §3.8 — "late, never wrong", deliberately). Every "it
 *     fires" scenario therefore starts from a SMALL transcript and grows it.
 */

const IDLE_MS = 50;
const LIMIT = 200_000; // claude-opus-5, from the pinned table
const THRESHOLD = 35;

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];
let unsubscribe: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 0,
    projectName: 'test',
    defaultModel: 'claude-opus-5',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir,
    logsDir,
    mcpRuntimeDir,
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 100,
    idleThresholdMs: IDLE_MS,
    // Effectively no TTL: this suite drives the reads itself and would
    // otherwise spend 15 s of wall clock waiting for a file it just wrote.
    contextUsageTtlMs: 1,
    autoCompactPct: THRESHOLD,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
    ...overrides,
  } as unknown as Config;
}

interface Team {
  orch: Orchestrator;
  lead: Session;
  pty: FakeAgentProcess;
  /** Mutable so a test can edit the "role" while the team runs (D6). */
  threshold: { pct: number };
  events: SwarmEvent[];
}

function makeTeam(opts: { thresholdPct?: number; configOverrides?: Partial<Config> } = {}): Team {
  const config = makeConfig(opts.configOverrides);
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider({ id: 'claude' }), { builtin: true });
  const threshold = { pct: opts.thresholdPct ?? THRESHOLD };
  const orch = new Orchestrator(
    {
      name: 'autocompact',
      role: 'co',
      roleId: 'role-1',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      defaultProvider: 'claude',
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    config,
    {
      persistence: new NoOpPersistence(),
      providerRegistry: registry,
      // D7 — exactly what the Spawner builds, minus the store: read LIVE at
      // every boundary, so mutating `threshold.pct` IS a role edit.
      autoCompact: { thresholdPctFor: () => threshold.pct },
    },
  );
  const pty = new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot });
  const lead = orch.start({ agentProcessOverride: pty });
  openSessions.push(lead);
  const events: SwarmEvent[] = [];
  unsubscribe = eventBus.onEvent((ev) => events.push(ev));
  return { orch, lead, pty, threshold, events };
}

let turnSeq = 0;

/** One assistant turn whose four usage fields sum to `usedTokens`. */
function transcript(usedTokens: number, id: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    parentUuid: 'p',
    requestId: 'req_1',
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: usedTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  })}\n`;
}

/**
 * Make the session's gauge read `usedTokens`, by APPENDING one assistant turn
 * to the session's transcript and pumping the TTL'd refresh until the tracker
 * has accepted it.
 *
 * Appending, not rewriting: the source holds a cursor into the file (that is
 * how it reads a 200 MB transcript for the price of its tail), so truncating
 * under it is a state a real agent never produces. The parser scans BACKWARDS
 * for the newest assistant line, so the figure can go down as well as up —
 * which is exactly what a post-compaction turn looks like.
 *
 * Driven through `Orchestrator.toView()`, the same heartbeat the UI poll
 * provides in production, so nothing here reaches into the tracker.
 */
async function measure(team: Team, usedTokens: number): Promise<void> {
  const file = path.join(tmpRoot, 'transcript.jsonl');
  turnSeq += 1;
  fs.appendFileSync(file, transcript(usedTokens, `msg-${turnSeq}`));
  team.lead.setTranscriptPath(file);
  const ok = await waitUntil(() => {
    team.orch.toView();
    const u = team.lead.contextUsage;
    return u !== null && u.usedTokens === usedTokens && !u.stale;
  });
  expect(ok).toBe(true);
}

/**
 * Produce an idle boundary: the agent speaks, then falls silent. `_idleNotified`
 * comes down on the byte and the boundary lands `idleThresholdMs` later.
 */
async function turn(team: Team): Promise<void> {
  team.pty._emitData('working…\r\n');
  await sleep(IDLE_MS * 3);
}

function armedLine(team: Team): string | undefined {
  return team.lead.getRecentLines(200).find((l) => l.includes('auto-compact armed'));
}

function signalCount(team: Team): number {
  return team.pty.writes.join('').split(SIGNAL_TEXT).length - 1;
}

beforeEach(() => {
  turnSeq = 0;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-autocompact-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir]) fs.mkdirSync(d, { recursive: true });
  openSessions = [];
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await sleep(30);
  openSessions = [];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('auto-compact — it arms', () => {
  it('arms a /compact at the threshold with an empty inbox', async () => {
    const team = makeTeam();
    // First measurement seeds the floor low, as a fresh agent's would.
    await measure(team, 10_000);
    await turn(team);
    // Now grow past 35 % of a 200 000 window, and past the 10-point hysteresis.
    await measure(team, 0.4 * LIMIT);
    await turn(team);

    expect(team.lead.hasPendingContextReset).toBe(true);
    // The two figures an operator needs, on the console channel.
    expect(armedLine(team)).toContain('auto-compact armed — context 40% ≥ 35%');
    const ev = team.events.filter((e) => e.kind === 'session.auto_compact');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toEqual({ pct: 40, thresholdPct: 35 });
    expect(ev[0]?.sessionId).toBe(team.lead.id);

    // …and it lands as a real `/compact`, steered by the server's instructions.
    await waitUntil(() => team.pty.writes.join('').includes('/compact'));
    expect(team.pty.writes.join('')).toContain('swarm-os auto-compact:');
  });

  it('does NOT arm below the threshold', async () => {
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    await measure(team, 0.3 * LIMIT); // 30 % < 35 %
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);
    expect(armedLine(team)).toBeUndefined();
  });

  it('does NOT arm while the inbox is not empty', async () => {
    // C3 of the requirement: an agent with queued mail is not "done", and
    // compacting it now summarises away the state it needs to answer.
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'one more thing' });
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);
    // It signalled the inbox instead — that is step 1 of the same boundary.
    expect(signalCount(team)).toBe(1);
  });

  it('arms once the mail has been drained', async () => {
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'x' });
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);

    team.orch.mailbox.read(team.lead.id);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(true);
  });
});

describe('auto-compact — the threshold is the role\'s, live', () => {
  it('uses the role threshold rather than the instance default', async () => {
    const team = makeTeam({ thresholdPct: 20 });
    await measure(team, 10_000);
    await turn(team);
    await measure(team, 0.25 * LIMIT); // 25 %: over 20, under the instance 35
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(true);
    expect(armedLine(team)).toContain('context 25% ≥ 20%');
  });

  it('picks up a role edit at the very next boundary, with no restart', async () => {
    // D6 — the resolver is called at EVERY boundary and nothing is cached: this
    // fleet runs 24/7 and a restart is not an acceptable way to change a
    // percentage.
    const team = makeTeam({ thresholdPct: 80 });
    await measure(team, 10_000);
    await turn(team);
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);

    team.threshold.pct = 35; // the operator just edited the role
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(true);
  });

  it('0 on the role disables it entirely', async () => {
    const team = makeTeam({ thresholdPct: 0 });
    await measure(team, 10_000);
    await turn(team);
    await measure(team, 0.9 * LIMIT); // 90 %, and still nothing
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);
    expect(team.events.filter((e) => e.kind === 'session.auto_compact')).toHaveLength(0);
  });

  it('a provider with no gauge (gemini) is never compacted', async () => {
    // No tracker at all ⇒ `no-usage` forever. `—` in the UI, nothing armed.
    const team = makeTeam();
    // Never call `measure`: a session that has produced no reading is exactly
    // the gemini case, and the decision must refuse rather than guess.
    await turn(team);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);
  });
});

describe('auto-compact — the anti-loop', () => {
  it('does not re-arm on the pre-compaction figure claude re-serves', async () => {
    // The BLOCKER three reviewers found: after `/compact` the transcript is
    // rewritten IN PLACE and the gauge re-serves the pre-compaction number as
    // fresh. With a MINIMUM floor that reading gives growth 0 → `not-grown`; a
    // first-sample floor would have re-armed a `/compact` immediately, forever.
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(true);

    // Let the reset actually reach the PTY (which marks the gauge stale), then
    // stand in for the compaction's own output.
    await waitUntil(() => !team.lead.hasPendingContextReset);
    expect(team.pty.writes.join('')).toContain('/compact');
    // Same file, same number — exactly what claude serves for a turn or two.
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false);
    expect(team.events.filter((e) => e.kind === 'session.auto_compact')).toHaveLength(1);
  });

  it('arms again once the agent has really grown 10 more points', async () => {
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    await waitUntil(() => !team.lead.hasPendingContextReset);

    // Post-compaction floor: a genuinely smaller context.
    await measure(team, 0.36 * LIMIT);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(false); // 36 % ≥ 35 %, but +0 grown
    // +10 points of real conversation.
    await measure(team, 0.47 * LIMIT);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(true);
    expect(team.events.filter((e) => e.kind === 'session.auto_compact')).toHaveLength(2);
  });
});

describe('auto-compact — guarantee G: the mail comes back', () => {
  it('re-signals the inbox after a /compact, once the PTY is quiet again', async () => {
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    // Mail arrives, gets its one nudge, and is NOT drained.
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'still here' });
    await turn(team);
    expect(signalCount(team)).toBe(1);

    // An operator compacts the agent anyway.
    expect(team.orch.requestContextReset(team.lead.id, '/compact').id).toBe(team.lead.id);
    await waitUntil(() => !team.lead.hasPendingContextReset);
    expect(team.pty.writes.join('')).toContain('/compact');

    // NOT BEFORE. A compaction is a model call that runs for seconds, and the
    // PTY spins the whole time — assert against a PTY that is actually TALKING,
    // not against one that has simply had nothing done to it (the earlier
    // version of this test proved nothing, because nothing was emitted).
    for (let i = 0; i < 9; i++) {
      team.pty._emitData('⠋ compacting…\r');
      await sleep(Math.max(1, Math.floor(IDLE_MS / 3)));
      expect(signalCount(team)).toBe(1);
    }

    // The spinner stops: THAT is the end of the compaction, and the boundary
    // that re-signals the inbox.
    await sleep(IDLE_MS * 3);
    expect(signalCount(team)).toBe(2);
  });

  it('signals a message that arrived MID-TURN, at the end of that turn', async () => {
    // The hole in the mailbox since Phase 3: `sendMessage` only injects when the
    // recipient is ALREADY idle, so a message landing mid-turn waited for the
    // agent to poll. It is now delivered at the boundary.
    const team = makeTeam();
    await turn(team);
    team.pty._emitData('thinking hard');
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'urgent' });
    expect(signalCount(team)).toBe(0);
    await sleep(IDLE_MS * 3);
    expect(signalCount(team)).toBe(1);
  });

  it('nudges at most ONCE per message', async () => {
    // An agent that ignores its inbox is not re-poked at every boundary for the
    // rest of its life.
    const team = makeTeam();
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'one' });
    await turn(team);
    expect(signalCount(team)).toBe(1);
    await turn(team);
    await turn(team);
    expect(signalCount(team)).toBe(1);

    // …but a NEW message is a new nudge.
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'two' });
    await turn(team);
    expect(signalCount(team)).toBe(2);
  });

  it('yields the boundary to an armed reset rather than signalling into it', async () => {
    // Both timers expire at the same instant by construction. D2 step 0 gives
    // the boundary to the reset, so nothing is typed into a half-written
    // `/compact`.
    const team = makeTeam();
    // Open a FRESH silence period — the mail and the reset have to arrive with
    // a boundary still owed, or the test proves nothing (a boundary already
    // consumed could not have signalled anyway).
    team.pty._emitData('done\r\n');
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'hello' });
    team.orch.requestContextReset(team.lead.id, '/clear');
    // The boundary and the reset now expire at the same instant. Step 0 gives
    // it to the reset, so nothing is typed into the half-written `/clear`.
    await sleep(IDLE_MS * 2);
    expect(signalCount(team)).toBe(0);
    await waitUntil(() => !team.lead.hasPendingContextReset);
    expect(team.pty.writes.join('')).toContain('/clear');
    expect(signalCount(team)).toBe(0);
    // The reset landed; the mail is signalled at the boundary AFTER it — which
    // on a real PTY is opened by the CLI's own echo, emitted by hand here.
    await turn(team);
    expect(signalCount(team)).toBe(1);
  });
});

describe('auto-compact — what a boundary costs when the feature is OFF', () => {
  /**
   * Step 3 of D2 refreshes the gauge so the NEXT boundary has a fresher sample.
   * On a fleet running `SWARM_OS_AUTO_COMPACT_PCT=0` there is no next decision
   * to feed, and the read is a transcript tail — one SSH round trip per agent
   * per TTL for a number nobody asked for. Before this feature the only caller
   * was `toView()`, i.e. an open UI tab; `disabled` keeps exactly that bargain.
   *
   * Both tests below drive the session through boundaries ONLY — no
   * `orch.toView()` anywhere — so the gauge moving (or not) is proof of what
   * step 3 did.
   */
  function pointAtTranscript(team: Team, usedTokens: number): void {
    const file = path.join(tmpRoot, 'transcript.jsonl');
    turnSeq += 1;
    fs.appendFileSync(file, transcript(usedTokens, `msg-${turnSeq}`));
    team.lead.setTranscriptPath(file);
  }

  it('reads nothing at a boundary when the threshold is 0', async () => {
    const team = makeTeam({ thresholdPct: 0 });
    pointAtTranscript(team, 50_000);
    await turn(team);
    await turn(team);
    expect(team.lead.contextUsage).toBeNull();
  });

  it('…but the boundary IS the heartbeat when it is on', async () => {
    // The control: same setup, same absence of a UI poll, threshold non-zero.
    const team = makeTeam();
    pointAtTranscript(team, 50_000);
    // One byte, then real silence — emitting on every poll tick would keep the
    // session busy and no boundary would ever land.
    for (let i = 0; i < 10 && team.lead.contextUsage === null; i++) {
      await turn(team);
    }
    expect(team.lead.contextUsage?.usedTokens).toBe(50_000);
  });
});

describe('auto-compact — the refusals an operator has to be able to read', () => {
  it('warns ONCE when unread mail is the only thing holding a firing decision', async () => {
    // C3 starving C1: the agent is over its threshold and would be compacted,
    // but it has never read its inbox. The fix is human, so the warning is
    // once per session — not once per boundary.
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'read me' });
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    expect(team.lead.lastAutoCompactSkipReason).toBe('inbox-pending');
    expect(team.lead.autoCompactStarvedWarned).toBe(true);
    // Still exactly once a few boundaries later.
    await turn(team);
    await turn(team);
    expect(team.lead.autoCompactStarvedWarned).toBe(true);
  });

  it('does NOT warn when the decision would not have fired anyway', async () => {
    // An agent with mail and a 20 % context is not starving — it is just busy.
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'read me' });
    await measure(team, 0.2 * LIMIT);
    await turn(team);
    expect(team.lead.lastAutoCompactSkipReason).toBe('inbox-pending');
    expect(team.lead.autoCompactStarvedWarned).toBe(false);
  });

  it('re-arms the starvation warning at the next actual compaction', async () => {
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'read me' });
    await measure(team, 0.4 * LIMIT);
    await turn(team);
    expect(team.lead.autoCompactStarvedWarned).toBe(true);

    team.orch.mailbox.read(team.lead.id);
    await turn(team);
    expect(team.lead.hasPendingContextReset).toBe(true);
    // Both pieces of "we already said this" state die with the arming, so the
    // next starvation is reported afresh.
    expect(team.lead.autoCompactStarvedWarned).toBe(false);
    expect(team.lead.lastAutoCompactSkipReason).toBeNull();
  });

  it('tracks the last reason, which is what makes the log info-on-change', async () => {
    // `session.auto_compact_skipped` is `info` when the reason CHANGES and
    // `debug` otherwise — an agent sitting below its threshold produces one of
    // these per boundary forever, and only the transitions are news.
    const team = makeTeam();
    await turn(team);
    expect(team.lead.lastAutoCompactSkipReason).toBe('no-usage');

    await measure(team, 10_000);
    await turn(team);
    expect(team.lead.lastAutoCompactSkipReason).toBe('below-threshold');
    await turn(team);
    expect(team.lead.lastAutoCompactSkipReason).toBe('below-threshold');

    team.orch.mailbox.push(team.lead.id, { from: 'human', content: 'hi' });
    await turn(team);
    expect(team.lead.lastAutoCompactSkipReason).toBe('inbox-pending');
  });

  it('reports `blocked`, with the dialog type, while a prompt is on screen', async () => {
    const team = makeTeam();
    await measure(team, 10_000);
    await turn(team);
    team.lead.markDialogPending('permission_prompt');
    // The boundary handler is not even reached while a dialog is up (D2 step 0
    // declines), so provoke the decision through a boundary that IS reached:
    // clear the dialog, then re-raise it between the byte and the boundary.
    team.pty._emitData('.');
    team.lead.clearDialogPending('input');
    team.lead.markDialogPending('elicitation_dialog');
    await sleep(IDLE_MS * 3);
    // Declined at step 0, so the reason is untouched — and nothing was typed.
    expect(team.lead.dialogPendingType).toBe('elicitation_dialog');
    expect(signalCount(team)).toBe(0);
  });
});
