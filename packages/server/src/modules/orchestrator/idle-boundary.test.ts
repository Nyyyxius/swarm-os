import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Session,
  SIGNAL_TEXT,
  POST_COMPACT_NUDGE_TEXT,
  POST_COMPACT_NUDGE_WITH_INBOX_TEXT,
  isTerminalAutoResponse,
} from './session.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';

/**
 * docs/auto-compact.md D1/D5 — the idle boundary, the injection gate and the
 * dialog guard, at the level of ONE Session.
 *
 * This suite is deliberately below the Orchestrator: what it proves is that a
 * Session hands out exactly one boundary per period of silence, declines the
 * ones on which the line is not free WITHOUT consuming them, and re-arms from
 * every site that has no PTY byte behind it. Those are the invariants the whole
 * feature rests on, and every one of them was a reviewer's objection.
 *
 * ⚠️ `FakeAgentProcess.write` ECHOES NOTHING — it only records into `writes`.
 * On a real PTY the CLI's own echo re-arms the boundary; here every "and then
 * the agent spoke" step has to be `pty._emitData(...)` by hand, otherwise a
 * test passes because nothing happened at all.
 */

const IDLE_MS = 50;

let tmpRoot: string;
let logsDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];

/** Real timers, short waits — the same shape as `context-reset.test.ts`. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
}

/**
 * The session log as the operator's console sees it. Read from the in-memory
 * ring buffer rather than the file: `_openLog` writes through a stream, so the
 * file on disk lags the call by an unbounded tick and a read would be flaky.
 */
function consoleText(session: Session): string {
  return session.getRecentLines(200).join('\n');
}

/** Occurrences of `needle` in `haystack` — `SIGNAL_TEXT` is not regex-safe. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Rig {
  session: Session;
  pty: FakeAgentProcess;
  /** Every session handed to `onIdle`, in order — length IS the boundary count. */
  boundaries: Session[];
}

function makeSession(
  opts: {
    provider?: FakeProvider;
    onIdle?: (s: Session) => void;
    permissionMode?: string;
    continueAfterCompact?: boolean;
  } = {},
): Rig {
  const pty = new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot });
  const boundaries: Session[] = [];
  const session = new Session({
    orchestratorId: 'orch-1',
    name: 'agent',
    role: 'tester',
    type: 'worker',
    cwd: tmpRoot,
    initialPrompt: 'hi',
    preamble: null,
    model: 'm',
    effort: 'low',
    permissionMode: (opts.permissionMode ?? 'bypassPermissions') as 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    provider: opts.provider ?? new FakeProvider({ id: 'claude' }),
    agentProcessOverride: pty,
    idleThresholdMs: IDLE_MS,
    ...(opts.continueAfterCompact !== undefined
      ? { continueAfterCompact: opts.continueAfterCompact }
      : {}),
    onIdle:
      opts.onIdle ??
      ((s) => {
        boundaries.push(s);
      }),
  });
  openSessions.push(session);
  return { session, pty, boundaries };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-idle-'));
  logsDir = path.join(tmpRoot, 'logs');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, mcpRuntimeDir]) fs.mkdirSync(d, { recursive: true });
  openSessions = [];
});

afterEach(async () => {
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

describe('Session.onIdle — one boundary per period of silence', () => {
  it('fires once the PTY has been quiet for idleThresholdMs', async () => {
    const { boundaries, session } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    expect(boundaries).toEqual([session]);
  });

  it('does NOT fire before the threshold', async () => {
    const { pty, boundaries } = makeSession();
    // Keep talking: every chunk pushes `_idleSince` forward, and the timer
    // re-arms on the remaining gap instead of firing.
    for (let i = 0; i < 4; i++) {
      pty._emitData('thinking…');
      await sleep(15);
    }
    expect(boundaries).toHaveLength(0);
    await waitUntil(() => boundaries.length > 0);
    expect(boundaries).toHaveLength(1);
  });

  it('fires ONCE per period, not once per check', async () => {
    const { boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    await sleep(IDLE_MS * 4);
    expect(boundaries).toHaveLength(1);
  });

  it('fires again after the agent speaks — a new turn is a new boundary', async () => {
    const { pty, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    pty._emitData('working on it');
    await waitUntil(() => boundaries.length > 1);
    expect(boundaries).toHaveLength(2);
  });

  it('arms ONE timer for a whole burst, not one per chunk', async () => {
    // The guard that matters on a chatty PTY: `_scheduleIdleCheck` returns
    // early while a timer exists, so a thousand chunks cost one timer, and the
    // callback re-arms itself when it wakes up too early.
    const { pty, boundaries } = makeSession();
    for (let i = 0; i < 200; i++) pty._emitData('x');
    await waitUntil(() => boundaries.length > 0);
    expect(boundaries).toHaveLength(1);
  });

  it('stops firing once the session has exited', async () => {
    const { session, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    session.stop('test', 0);
    await waitUntil(() => session.status !== 'running');
    const after = boundaries.length;
    await sleep(IDLE_MS * 3);
    expect(boundaries).toHaveLength(after);
  });

  it('never fires while paused, and comes back on resume()', async () => {
    // `paused` is never idle — a SIGSTOP'd process cannot drain its tty — and
    // nothing but `resume()` would ever re-arm the boundary for it.
    const { session, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    expect(session.pause('test')).toBe(true);
    const atPause = boundaries.length;
    await sleep(IDLE_MS * 3);
    expect(boundaries).toHaveLength(atPause);
    expect(session.resume('test')).toBe(true);
    // Not instantly: the resumed CLI is about to finish the turn it was frozen
    // in the middle of, and the silence clock is re-based on SIGCONT.
    await sleep(Math.floor(IDLE_MS / 2));
    expect(boundaries).toHaveLength(atPause);
    await waitUntil(() => boundaries.length > atPause);
    expect(boundaries.length).toBe(atPause + 1);
  });
});

describe('Session.onIdle — a dying session has no boundary', () => {
  it('hands out nothing during the SIGTERM grace window', async () => {
    // `stop()` leaves the status at `running` until the process actually exits,
    // so without the `_stopRequested` guard the quiet of a dying agent reads as
    // a task boundary: the handler would signal an inbox nobody will drain and
    // arm a `/compact` on a PTY that is closing.
    const { session, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    const before = boundaries.length;
    // A long grace so the process is still alive while we look.
    session.stop('operator', 5_000);
    expect(session.status).toBe('running');
    await sleep(IDLE_MS * 3);
    expect(boundaries).toHaveLength(before);
  });

  it('refuses to arm a context reset during that same window', async () => {
    // The JSDoc of `requestContextReset` has always promised `false` "when the
    // session is terminating"; the status check alone never delivered it.
    const { session, pty } = makeSession();
    await waitUntil(() => pty.writes.length >= 0);
    session.stop('operator', 5_000);
    expect(session.requestContextReset('/compact', { idleMs: IDLE_MS })).toBe(false);
    await sleep(IDLE_MS * 3);
    expect(pty.writes.join('')).not.toContain('/compact');
  });

  it('does not re-arm a timer from the aborted notice on the way out', async () => {
    // `_handleExit` clears the idle timer and THEN resolves the pending notice
    // as `aborted` — which is an arm site. Without the terminal-state guard
    // that re-armed a timer on a dead session.
    const { session, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    session.armNotice('bye', { idleMs: IDLE_MS, deadlineMs: 60_000 });
    const before = boundaries.length;
    session.stop('test', 0);
    await waitUntil(() => session.status !== 'running');
    await sleep(IDLE_MS * 3);
    expect(boundaries).toHaveLength(before);
  });

  it('does not re-arm from a hook landing after the session died', async () => {
    // An `elicitation_response` POST can arrive a second after the agent exited.
    const { session, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    session.stop('test', 0);
    await waitUntil(() => session.status !== 'running');
    const before = boundaries.length;
    session.clearDialogPending('elicitation');
    await sleep(IDLE_MS * 3);
    expect(boundaries).toHaveLength(before);
  });
});

describe('Session.onIdle — a declined boundary is not a consumed one', () => {
  it('comes back when the provider turns out to have no reset at all', async () => {
    // That branch writes NOTHING, so no PTY byte will ever re-arm the boundary
    // it just consumed. An agent that stays silent would never get another one.
    const { session, boundaries } = makeSession({
      provider: new FakeProvider({ id: 'claude', contextResetLine: () => null }),
    });
    await waitUntil(() => boundaries.length > 0);
    session.requestContextReset('/compact', { idleMs: IDLE_MS });
    const before = boundaries.length;
    await waitUntil(() => boundaries.length > before, 3_000);
    expect(boundaries.length).toBeGreaterThan(before);
    expect(consoleText(session)).toContain('has no context reset');
  });

  it('declines while a context reset is armed, and comes back after it fired', async () => {
    // Both timers expire at the same instant by construction (`_idleSince +
    // idleMs`), so this is the common case. The reset wins — it was armed first
    // and it is what changes the context the handler reasons about.
    const { session, pty, boundaries } = makeSession();
    session.requestContextReset('/compact', { idleMs: IDLE_MS });
    await sleep(IDLE_MS * 2);
    expect(boundaries).toHaveLength(0);
    await waitUntil(() => !session.hasPendingContextReset, 3_000);
    // The fake never echoes, so stand in for the CLI's own output.
    pty._emitData('compacting…');
    await waitUntil(() => boundaries.length > 0);
    expect(boundaries).toHaveLength(1);
  });

  it('declines while an operator notice is armed, and comes back when it resolves', async () => {
    const { session, boundaries } = makeSession();
    session.armNotice('container restart in 5 min', { idleMs: 10_000, deadlineMs: 60_000 });
    await sleep(IDLE_MS * 2);
    expect(boundaries).toHaveLength(0);
    // Cancelled: the notice took the boundary and gave nothing back. Without
    // `_resolveNotice` re-arming, mail queued behind it would never be signalled.
    expect(session.cancelNotice()).toBe(true);
    await waitUntil(() => boundaries.length > 0);
    expect(boundaries).toHaveLength(1);
  });

  it('declines while a dialog is on screen, and comes back on the first keystroke', async () => {
    const { session, boundaries } = makeSession();
    await waitUntil(() => boundaries.length > 0);
    session.markDialogPending('permission_prompt');
    // A redraw of the dialog is PTY output: it must NOT lower the flag.
    // Nothing may be handed to the handler while that dialog is up.
    for (let i = 0; i < 3; i++) {
      // (no data emitted — a silent dialog is the hard case)
      await sleep(IDLE_MS);
    }
    expect(boundaries).toHaveLength(1);
    session.writeInput('y');
    // Not on the keystroke itself — the operator may still be typing the rest
    // of a free-text answer, and the boundary handler's first act is a write.
    await sleep(Math.floor(IDLE_MS / 2));
    expect(boundaries).toHaveLength(1);
    await waitUntil(() => boundaries.length > 1);
    expect(boundaries).toHaveLength(2);
  });
});

describe('Session.signalInbox', () => {
  it('types the signal and stamps the time', async () => {
    const { session, pty } = makeSession();
    expect(session.lastInboxSignalAt).toBeNull();
    expect(session.signalInbox()).toBe(true);
    expect(pty.writes.join('')).toContain(SIGNAL_TEXT);
    expect(session.lastInboxSignalAt).not.toBeNull();
  });

  it('refuses WITHOUT writing while a dialog is on screen', () => {
    const { session, pty } = makeSession();
    session.markDialogPending('permission_prompt');
    expect(session.signalInbox()).toBe(false);
    // The whole point: a line typed into a permission dialog validates the
    // highlighted option.
    expect(pty.writes.join('')).not.toContain(SIGNAL_TEXT);
    expect(session.lastInboxSignalAt).toBeNull();
  });

  it('refuses while another signal is mid two-step write', async () => {
    // Two sends 50 ms apart used to interleave as `text1 text2 CR CR` and
    // submit one garbled line that woke the agent for neither message.
    const { session, pty } = makeSession();
    expect(session.signalInbox()).toBe(true);
    expect(session.signalInbox()).toBe(false);
    await sleep(200);
    expect(countOf(pty.writes.join(''), SIGNAL_TEXT)).toBe(1);
    // …and once the CR has landed the line is free again.
    expect(session.signalInbox()).toBe(true);
  });

  it('refuses while a context reset is mid two-step write', async () => {
    const { session, pty } = makeSession();
    session.requestContextReset('/compact', { idleMs: IDLE_MS });
    await waitUntil(() => pty.writes.join('').includes('/compact'));
    // The buffer holds a half-typed slash command; its CR lands at +250 ms.
    expect(session.signalInbox()).toBe(false);
    await waitUntil(() => !session.hasPendingContextReset, 3_000);
    expect(session.signalInbox()).toBe(true);
  });

  it('makes an armed context reset back off instead of garbling the line', async () => {
    // The reverse of the test above, and the reason `_signalFiring` exists at
    // all: the reset's timer expires while the signal's CR has not landed yet.
    // Firing now would interleave a half-typed `/compact` with a half-typed
    // signal and submit neither.
    const { session, pty } = makeSession();
    expect(session.signalInbox()).toBe(true);
    session.requestContextReset('/compact', { idleMs: 0 });
    // The reset wakes ~immediately, finds the line held, and backs off.
    await sleep(60);
    expect(pty.writes.join('')).not.toContain('/compact');
    // …then takes it once the signal's two-step write is over.
    await waitUntil(() => pty.writes.join('').includes('/compact'), 3_000);
    expect(pty.writes.join('')).toContain('/compact');
  });

  it('is reset by a context reset so the next boundary re-signals (guarantee G)', async () => {
    const { session, pty } = makeSession();
    expect(session.signalInbox()).toBe(true);
    expect(session.lastInboxSignalAt).not.toBeNull();
    session.requestContextReset('/clear', { idleMs: IDLE_MS });
    // The stamp drops when the command reaches the PTY, not when it was armed.
    await waitUntil(() => session.lastInboxSignalAt === null, 3_000);
    expect(session.lastInboxSignalAt).toBeNull();
    expect(pty.writes.join('')).toContain('/clear');
  });
});

describe('Session.dialogPending — D5', () => {
  it('starts down, goes up on a typed notification, comes down on input', () => {
    const { session } = makeSession();
    expect(session.dialogPending).toBe(false);
    session.markDialogPending('permission_prompt');
    expect(session.dialogPending).toBe(true);
    expect(session.dialogPendingType).toBe('permission_prompt');
    session.clearDialogPending('input');
    expect(session.dialogPending).toBe(false);
    expect(session.dialogPendingType).toBeNull();
  });

  it('is NOT lowered by PTY output — a resize redraws the dialog', async () => {
    const { session, pty } = makeSession();
    session.markDialogPending('permission_prompt');
    pty._emitData('[2J redrawn dialog');
    await sleep(IDLE_MS * 2);
    expect(session.dialogPending).toBe(true);
  });

  it('is lowered by submitInput as well as writeInput', () => {
    const { session } = makeSession();
    session.markDialogPending('agent_needs_input');
    session.submitInput('yes');
    expect(session.dialogPending).toBe(false);
  });

  it('is lowered by the CLI reporting the elicitation is over', () => {
    // The MCP elicitation cancelled on a timeout: nobody typed, and without
    // this the guard would stand for the rest of the session's life.
    const { session } = makeSession();
    session.markDialogPending('elicitation_dialog');
    session.clearDialogPending('elicitation');
    expect(session.dialogPending).toBe(false);
  });

  it('HOLDS a context reset instead of firing it into the dialog', async () => {
    const { session, pty } = makeSession();
    session.markDialogPending('permission_prompt');
    session.requestContextReset('/compact', { idleMs: IDLE_MS });
    await sleep(IDLE_MS * 4);
    expect(pty.writes.join('')).not.toContain('/compact');
    // …and says so in the session log, once, so "held" and "crashed" are
    // distinguishable from a COMPACT button that answered `scheduled`.
    const held = consoleText(session);
    expect(held).toContain('context /compact held — dialog pending');
    expect(countOf(held, 'held — dialog pending')).toBe(1);
    // A keystroke re-arms it, without a second request — but NOT instantly.
    // `_idleSince` only moves on PTY bytes, so after a dialog that sat there for
    // a while it is ancient, and an un-rebased timer would fire at +1 ms: the
    // `\r` that submits `/compact` would land on the operator's half-typed
    // free-text answer instead. The re-base makes it wait a full window of REAL
    // silence.
    session.writeInput('y');
    await sleep(Math.floor(IDLE_MS / 2));
    expect(pty.writes.join('')).not.toContain('/compact');
    await waitUntil(() => pty.writes.join('').includes('/compact'), 3_000);
    expect(pty.writes.join('')).toContain('/compact');
  });

  it('HOLDS a context reset while the process is SIGSTOPd, and resume() re-arms', async () => {
    // Pre-existing defect repaired in passing: a reset armed before `pause()`
    // was written into a frozen PTY, arrived glued at SIGCONT and never
    // submitted — while `markStale`/`recordReset` had already run.
    const { session, pty } = makeSession();
    session.requestContextReset('/compact', { idleMs: IDLE_MS });
    expect(session.pause('test')).toBe(true);
    // Long enough for the armed timer to wake, see `paused`, and hold without
    // re-arming — which is the behaviour under test.
    await sleep(IDLE_MS * 4);
    expect(pty.writes.join('')).not.toContain('/compact');
    // Same re-base on SIGCONT: a process frozen mid-turn carries an
    // `_idleSince` as old as the pause, and firing at +1 ms would write into a
    // CLI that has not yet emitted the first byte of the turn it was frozen in.
    expect(session.resume('test')).toBe(true);
    await sleep(Math.floor(IDLE_MS / 2));
    expect(pty.writes.join('')).not.toContain('/compact');
    await waitUntil(() => pty.writes.join('').includes('/compact'), 3_000);
    expect(pty.writes.join('')).toContain('/compact');
  });

  it('HOLDS an operator notice until the deadline, then reports why', async () => {
    const { session, pty } = makeSession();
    const outcomes: string[] = [];
    session.markDialogPending('permission_prompt');
    session.armNotice('restarting', {
      idleMs: IDLE_MS,
      deadlineMs: 120,
      onOutcome: (o) => outcomes.push(o),
    });
    await waitUntil(() => outcomes.length > 0, 3_000);
    expect(outcomes).toEqual(['never_idle']);
    expect(pty.writes.join('')).not.toContain('restarting');
    // A reason distinct from "the agent never stopped talking": only this one
    // is fixed by a human walking to the console.
    expect(consoleText(session)).toContain('deadline-dialog-pending');
  });
});

describe('Session — the plumbing the boundary handler reads', () => {
  it('appendServerLogLine writes to the console channel, not the PTY', () => {
    const { session, pty } = makeSession();
    session.appendServerLogLine('[swarm-os] auto-compact armed — context 41% ≥ 35%');
    expect(consoleText(session)).toContain('auto-compact armed — context 41% ≥ 35%');
    expect(pty.writes).toEqual([]);
  });

  it('contextFloorTokens is null for a session with no tracker (gemini)', () => {
    const { session } = makeSession();
    expect(session.contextFloorTokens).toBeNull();
  });

  it('markContextStale is safe on a session with no tracker', () => {
    const { session } = makeSession();
    expect(() => session.markContextStale()).not.toThrow();
  });
});

/**
 * docs/auto-compact.md D5 — the console WebSocket carries more than keystrokes.
 *
 * xterm.js answers the CLI's startup and resize queries on its own, and those
 * frames reach `writeInput` looking exactly like typing. Taking one for a human
 * answer lowers the dialog guard, which is the one thing that stands between
 * the server and a permission prompt.
 */
describe('isTerminalAutoResponse', () => {
  const ESC = '\u001b';

  it('recognises the answers a terminal sends by itself', () => {
    expect(isTerminalAutoResponse(`${ESC}[?62;22c`)).toBe(true); // Device Attributes
    expect(isTerminalAutoResponse(`${ESC}[24;80R`)).toBe(true); // Cursor Position Report
    expect(isTerminalAutoResponse(`${ESC}[?2004;2$y`)).toBe(true); // DECRPM mode report
    expect(isTerminalAutoResponse(`${ESC}]11;rgb:0000/0000/0000${ESC}\\`)).toBe(true); // OSC 11
    expect(isTerminalAutoResponse(`${ESC}[I`)).toBe(true); // focus in
    expect(isTerminalAutoResponse(`${ESC}[O`)).toBe(true); // focus out
  });

  it('accepts several of them coalesced into one frame', () => {
    expect(isTerminalAutoResponse(`${ESC}[I${ESC}[24;80R`)).toBe(true);
  });

  it('is false for real typing', () => {
    expect(isTerminalAutoResponse('y')).toBe(false);
    expect(isTerminalAutoResponse('\r')).toBe(false);
    expect(isTerminalAutoResponse(`${ESC}[A`)).toBe(false); // arrow up IS a keystroke
    expect(isTerminalAutoResponse('')).toBe(false);
  });

  it('is false for a MIXED frame — a false positive costs the guard', () => {
    expect(isTerminalAutoResponse(`${ESC}[Iy`)).toBe(false);
    expect(isTerminalAutoResponse(`y${ESC}[24;80R`)).toBe(false);
  });
});

describe('Session.writeInput — only a human lowers the guard', () => {
  const ESC = '\u001b';

  it('keeps the dialog guard up for a pure auto-response frame', () => {
    // A browser tab regaining focus while a permission prompt is on screen must
    // not re-open the window in which the server types into that prompt.
    const { session, pty } = makeSession();
    session.markDialogPending('permission_prompt');
    session.writeInput(`${ESC}[I`);
    expect(session.dialogPending).toBe(true);
    // …and the bytes still reach the PTY: we filter what they MEAN, not what
    // gets written. The CLI asked for that answer.
    expect(pty.writes.join('')).toBe(`${ESC}[I`);
  });

  it('lowers it for a real keystroke', () => {
    const { session } = makeSession();
    session.markDialogPending('permission_prompt');
    session.writeInput('y');
    expect(session.dialogPending).toBe(false);
  });

  it('lowers it for a frame that merely CONTAINS an auto-response', () => {
    const { session } = makeSession();
    session.markDialogPending('permission_prompt');
    session.writeInput(`${ESC}[Iy`);
    expect(session.dialogPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// docs/auto-compact.md §8.1 (D9, v0.10.1) — the post-compact nudge, Session side
// ---------------------------------------------------------------------------
//
// The Session ARMS the nudge when a `/compact` is actually submitted and GATES
// its injection exactly like `signalInbox`. Whether a given boundary types it is
// the Orchestrator's call (`auto-compact.orchestrator.test.ts`); what this block
// proves is the part that must hold whoever calls it: owed once per submitted
// `/compact`, never after `/clear`, never when switched off, typed once, never
// into a busy line, and in one single line when the inbox is folded in.

/** Arm a reset and wait until its CR has landed (the `_contextResetFiring` window is over). */
async function fireReset(session: Session, cmd: '/compact' | '/clear'): Promise<void> {
  expect(session.requestContextReset(cmd, { idleMs: IDLE_MS })).toBe(true);
  await waitUntil(() => !session.hasPendingContextReset, 3_000);
  expect(session.hasPendingContextReset).toBe(false);
}

describe('Session.signalPostCompact — D9', () => {
  it('is owed once a /compact is SUBMITTED — not when it is armed, not mid-write', async () => {
    const { session, pty } = makeSession({ continueAfterCompact: true });
    expect(session.postCompactNudgeOwed).toBe(false);
    session.requestContextReset('/compact', { idleMs: IDLE_MS });
    // Armed, waiting for its boundary: nothing owed — it may wait minutes.
    expect(session.postCompactNudgeOwed).toBe(false);
    await waitUntil(() => pty.writes.join('').includes('/compact'));
    // Typed but its CR has not landed yet (+250 ms): still nothing owed.
    expect(session.hasPendingContextReset).toBe(true);
    expect(session.postCompactNudgeOwed).toBe(false);
    await waitUntil(() => !session.hasPendingContextReset, 3_000);
    expect(session.postCompactNudgeOwed).toBe(true);
  });

  it('is NEVER owed after a /clear — a wiped agent is idle on purpose', async () => {
    const { session } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/clear');
    expect(session.postCompactNudgeOwed).toBe(false);
    expect(session.signalPostCompact({ inbox: false })).toBe(false);
  });

  it('a /clear fired after the /compact drops the nudge still owed', async () => {
    const { session } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    expect(session.postCompactNudgeOwed).toBe(true);
    await fireReset(session, '/clear');
    expect(session.postCompactNudgeOwed).toBe(false);
  });

  it('is never owed when the Session was built without continueAfterCompact', async () => {
    // The v0.10.0 behaviour, byte for byte: the switch OFF, or a Session built
    // by a caller that predates it.
    for (const opt of [false, undefined]) {
      const { session } = makeSession({ continueAfterCompact: opt });
      await fireReset(session, '/compact');
      expect(session.postCompactNudgeOwed, `continueAfterCompact=${String(opt)}`).toBe(false);
    }
  });

  it('types the nudge ONCE, as its own write with no leading CR, then a lone CR', async () => {
    const { session, pty } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    const before = pty.writes.length;
    expect(session.signalPostCompact({ inbox: false })).toBe(true);
    expect(session.postCompactNudgeOwed).toBe(false);
    // Claude Code ≥ 2.1.277 cancels a submit whose buffer holds a bare CR
    // (docs/internal/post-mortems/correctif-signal-cr-invisible.md): the text goes alone, first.
    expect(pty.writes[before]).toBe(POST_COMPACT_NUDGE_TEXT);
    await sleep(200);
    expect(pty.writes[before + 1]).toBe('\r');
    // Consumed: a second call types nothing.
    expect(session.signalPostCompact({ inbox: false })).toBe(false);
    expect(countOf(pty.writes.join(''), POST_COMPACT_NUDGE_TEXT)).toBe(1);
    // …and the inbox stamp was NOT touched by a nudge that carried no signal.
    expect(session.lastInboxSignalAt).toBeNull();
  });

  it('folds the inbox signal into the SAME line and stamps it', async () => {
    const { session, pty } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    expect(session.lastInboxSignalAt).toBeNull();
    const before = pty.writes.length;
    expect(session.signalPostCompact({ inbox: true })).toBe(true);
    expect(pty.writes[before]).toBe(POST_COMPACT_NUDGE_WITH_INBOX_TEXT);
    // The preamble contract survives: the standard signal is in there verbatim.
    expect(POST_COMPACT_NUDGE_WITH_INBOX_TEXT.endsWith(SIGNAL_TEXT)).toBe(true);
    expect(session.lastInboxSignalAt).not.toBeNull();
    await sleep(200);
    // One submission: one text, one CR.
    expect(pty.writes.slice(before)).toEqual([POST_COMPACT_NUDGE_WITH_INBOX_TEXT, '\r']);
  });

  it('refuses WITHOUT consuming while a dialog is on screen', async () => {
    const { session, pty } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    session.markDialogPending('permission_prompt');
    expect(session.signalPostCompact({ inbox: false })).toBe(false);
    expect(pty.writes.join('')).not.toContain(POST_COMPACT_NUDGE_TEXT);
    expect(session.postCompactNudgeOwed).toBe(true);
    session.clearDialogPending('input');
    expect(session.signalPostCompact({ inbox: false })).toBe(true);
  });

  it('refuses WITHOUT consuming while another injection is mid two-step write', async () => {
    const { session, pty } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    expect(session.signalInbox()).toBe(true);
    // The signal's CR lands at +150 ms; typing now would garble both lines.
    expect(session.signalPostCompact({ inbox: false })).toBe(false);
    expect(session.postCompactNudgeOwed).toBe(true);
    await sleep(200);
    expect(session.signalPostCompact({ inbox: false })).toBe(true);
    expect(countOf(pty.writes.join(''), POST_COMPACT_NUDGE_TEXT)).toBe(1);
  });

  it('makes an armed reset back off while its CR is pending, like the inbox signal', async () => {
    const { session, pty } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    expect(session.signalPostCompact({ inbox: false })).toBe(true);
    const before = pty.writes.length;
    session.requestContextReset('/clear', { idleMs: 0 });
    await sleep(60);
    // Nothing typed into the half-written nudge…
    expect(pty.writes.slice(before).join('')).not.toContain('/clear');
    // …the reset takes the line once the nudge's CR has landed.
    await waitUntil(() => pty.writes.join('').includes('/clear'), 3_000);
    expect(pty.writes.join('')).toContain('/clear');
  });

  it('goes through the provider submit rule — one `\\r…\\r` write without the Ink dance', async () => {
    const { session, pty } = makeSession({
      continueAfterCompact: true,
      provider: new FakeProvider({ id: 'claude', capabilities: { inkSubmitDance: false } }),
    });
    await fireReset(session, '/compact');
    const before = pty.writes.length;
    expect(session.signalPostCompact({ inbox: false })).toBe(true);
    await sleep(200);
    expect(pty.writes.slice(before)).toEqual([`\r${POST_COMPACT_NUDGE_TEXT}\r`]);
  });

  it('writes its console line BEFORE the typed text, never glued to it', async () => {
    const { session } = makeSession({ continueAfterCompact: true });
    await fireReset(session, '/compact');
    session.signalPostCompact({ inbox: true });
    await sleep(200);
    session.appendServerLogLine('[swarm-os] marker');
    const lines = session.getRecentLines(200);
    const i = lines.findIndex((l) => l.includes('compaction over — nudging the agent to resume'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lines[i]).toContain('(+ inbox signal)');
    expect(lines[i]).not.toContain('Contexte compacté');
  });
});
