import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sendMessage,
  broadcast,
  validateMessageSize,
  isIdle,
  MessageError,
  type MessagingDeps,
} from './messaging.js';
import { Mailbox } from './mailbox.js';
import { Session } from './session.js';
import { FakeAgentProcess } from './agent-process.js';
import type { Orchestrator } from './index.js';

/**
 * Phase 7 — high-level messaging helpers.
 *
 * These tests build a minimal `Orchestrator`-shaped stub instead of standing
 * up the real class — `sendMessage`/`broadcast` only touch
 * `getSession`/`listSessions`, never the rest of the orchestrator surface.
 * Sessions are real `Session` instances with `FakeAgentProcess` so we can
 * actually observe the PTY signal write.
 */

interface StubOrchestrator
  extends Pick<Orchestrator, 'getSession' | 'listSessions'> {
  /** Make TS happy when callers spread additional Orch members. */
  readonly id?: string;
}

let tmpRoot: string;
let logsDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-msg-'));
  logsDir = path.join(tmpRoot, 'logs');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });
  openSessions = [];
});

afterEach(async () => {
  // Drain any session log writes still queued before unlinking the tmp dir,
  // otherwise we get spurious EBADF / ENOENT errors on slower CI runs.
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  openSessions = [];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeSession(opts: {
  id: string;
  fake?: FakeAgentProcess;
}): Session {
  const fake =
    opts.fake ??
    new FakeAgentProcess({
      command: 'fake',
      args: [],
      cwd: tmpRoot,
    });
  const s = new Session({
    id: opts.id,
    orchestratorId: 'orch-test',
    name: opts.id,
    role: 'tester',
    type: 'worker',
    cwd: tmpRoot,
    initialPrompt: null,
    preamble: null,
    model: 'test-model',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    agentProcessOverride: fake,
  });
  openSessions.push(s);
  return s;
}

function makeStubOrchestrator(sessions: Session[]): StubOrchestrator {
  const map = new Map(sessions.map((s) => [s.id, s] as const));
  return {
    getSession: (id: string) => map.get(id),
    listSessions: () => Array.from(map.values()),
  };
}

const DEFAULTS: MessagingDeps['defaults'] = {
  maxMessageSizeBytes: 1024,
  idleThresholdMs: 50,
};

function makeDeps(orch: StubOrchestrator): MessagingDeps {
  return {
    orchestrator: orch as unknown as Orchestrator,
    mailbox: new Mailbox({ maxSize: 100 }),
    defaults: DEFAULTS,
  };
}

describe('validateMessageSize', () => {
  it('accepts a payload under the cap', () => {
    expect(validateMessageSize('hello', 1024).ok).toBe(true);
  });

  it('rejects a payload over the cap', () => {
    const big = 'x'.repeat(2048);
    const r = validateMessageSize(big, 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bytes).toBe(2048);
      expect(r.max).toBe(1024);
    }
  });
});

describe('isIdle', () => {
  it('returns false when last activity is recent', () => {
    const s = makeSession({ id: 'x' });
    expect(isIdle(s, Date.now(), 1000)).toBe(false);
  });

  it('returns true when last activity is older than the threshold', () => {
    const s = makeSession({ id: 'x' });
    expect(isIdle(s, s.idleSince + 5_000, 100)).toBe(true);
  });
});

describe('sendMessage', () => {
  it('rejects oversized content with MessageError(MESSAGE_TOO_LARGE)', () => {
    const sender = makeSession({ id: 'sender' });
    const recv = makeSession({ id: 'recv' });
    const orch = makeStubOrchestrator([sender, recv]);
    const deps = makeDeps(orch);
    const big = 'x'.repeat(DEFAULTS.maxMessageSizeBytes + 1);
    expect(() => sendMessage(deps, sender.id, recv.id, big)).toThrow(MessageError);
  });

  it('rejects an unknown recipient with RECIPIENT_UNKNOWN', () => {
    const sender = makeSession({ id: 'sender' });
    const orch = makeStubOrchestrator([sender]);
    try {
      sendMessage(makeDeps(orch), sender.id, 'ghost', 'hi');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MessageError);
      expect((err as MessageError).code).toBe('RECIPIENT_UNKNOWN');
    }
  });

  it('delivers to an active recipient', () => {
    const sender = makeSession({ id: 'sender' });
    const recv = makeSession({ id: 'recv' });
    const orch = makeStubOrchestrator([sender, recv]);
    const deps = makeDeps(orch);
    const out = sendMessage(deps, sender.id, recv.id, 'hello');
    expect(out.delivered).toBe(true);
    expect(out.queueSize).toBe(1);
    expect(deps.mailbox.peek(recv.id)).toHaveLength(1);
  });

  it('rejects an inactive recipient (status=killed) when not skipping the check', async () => {
    const sender = makeSession({ id: 'sender' });
    const recv = makeSession({ id: 'recv' });
    // Force-stop the recipient and wait for the FakeAgent's setImmediate exit
    // callback to flip the status to 'killed' (Session.stop is async via the
    // underlying agent kill).
    recv.stop('test-shutdown');
    await new Promise((r) => setTimeout(r, 20));
    expect(recv.status).toBe('killed');
    const orch = makeStubOrchestrator([sender, recv]);
    try {
      sendMessage(makeDeps(orch), sender.id, recv.id, 'hi');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MessageError);
      expect((err as MessageError).code).toBe('RECIPIENT_NOT_ACTIVE');
    }
  });

  it('does NOT inject a PTY signal when the recipient is busy (idle window not crossed)', () => {
    const sender = makeSession({ id: 'sender' });
    const fake = new FakeAgentProcess({
      command: 'fake',
      args: [],
      cwd: tmpRoot,
    });
    const recv = makeSession({ id: 'recv', fake });
    // Simulate a fresh PTY data event so idleSince is stamped to 'now'.
    fake._emitData('busy');
    const orch = makeStubOrchestrator([sender, recv]);
    const deps = makeDeps(orch);
    const out = sendMessage(deps, sender.id, recv.id, 'hi');
    expect(out.delivered).toBe(true);
    expect(out.signalled).toBe(false);
    // FakeAgentProcess.writes captures every write — none should have happened.
    expect(fake.writes).toHaveLength(0);
  });

  it('injects a PTY signal when the recipient is idle past the threshold', async () => {
    const sender = makeSession({ id: 'sender' });
    const fake = new FakeAgentProcess({
      command: 'fake',
      args: [],
      cwd: tmpRoot,
    });
    const recv = makeSession({ id: 'recv', fake });
    // Wait past the 50 ms idle threshold without producing PTY output.
    await new Promise((r) => setTimeout(r, 80));
    const orch = makeStubOrchestrator([sender, recv]);
    const deps = makeDeps(orch);
    const out = sendMessage(deps, sender.id, recv.id, 'wake up');
    expect(out.signalled).toBe(true);
    expect(fake.writes.length).toBe(1);
    expect(fake.writes[0]).toContain('[swarm-os] new message in inbox');
  });
});

describe('broadcast', () => {
  it('excludes the sender, includes every other active session', () => {
    const a = makeSession({ id: 'a' });
    const b = makeSession({ id: 'b' });
    const c = makeSession({ id: 'c' });
    const orch = makeStubOrchestrator([a, b, c]);
    const deps = makeDeps(orch);
    const out = broadcast(deps, a.id, 'team-wide');
    expect(out.delivered_to).toEqual(expect.arrayContaining([b.id, c.id]));
    expect(out.delivered_to).not.toContain(a.id);
    expect(out.skipped).toContain(a.id);
    expect(deps.mailbox.peek(b.id)).toHaveLength(1);
    expect(deps.mailbox.peek(c.id)).toHaveLength(1);
    expect(deps.mailbox.peek(a.id)).toHaveLength(0);
  });

  it('skips inactive recipients silently', async () => {
    const a = makeSession({ id: 'a' });
    const b = makeSession({ id: 'b' });
    const c = makeSession({ id: 'c' });
    c.stop('test'); // async via FakeAgent kill -> setImmediate
    await new Promise((r) => setTimeout(r, 20));
    expect(c.status).toBe('killed');
    const orch = makeStubOrchestrator([a, b, c]);
    const deps = makeDeps(orch);
    const out = broadcast(deps, a.id, 'hi');
    expect(out.delivered_to).toEqual([b.id]);
    expect(out.skipped).toEqual(expect.arrayContaining([a.id, c.id]));
  });

  it('still validates size', () => {
    const a = makeSession({ id: 'a' });
    const orch = makeStubOrchestrator([a]);
    const deps = makeDeps(orch);
    expect(() =>
      broadcast(deps, a.id, 'x'.repeat(DEFAULTS.maxMessageSizeBytes + 1)),
    ).toThrow(MessageError);
  });
});
