import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session, buildClaudeArgs, type SessionStatus } from './session.js';
import { FakeAgentProcess } from './agent-process.js';
import { eventBus } from '../../events.js';

/**
 * Pre-seed `.claude.json` so claude-code's "Trust this folder?" widget
 * never fires on first spawn. See `Session._seedClaudeJsonTrust`.
 */

let tmpRoot: string;
let logsDir: string;
let mcpRuntimeDir: string;
let claudeRuntimeDir: string;
let cwd: string;
const openSessions: Session[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-session-'));
  logsDir = path.join(tmpRoot, 'logs');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  claudeRuntimeDir = path.join(tmpRoot, 'claude-runtime');
  cwd = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });
  fs.mkdirSync(claudeRuntimeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  openSessions.length = 0;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeSession(opts: { sessionCwd?: string } = {}): Session {
  const s = new Session({
    orchestratorId: 'orch-seed-test',
    name: 'seed-test',
    role: 'tester',
    type: 'worker',
    cwd: opts.sessionCwd ?? cwd,
    initialPrompt: null,
    preamble: null,
    model: 'test-model',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd }),
    // Seed only runs when all three are set (production path).
    hookToken: 'test-hook',
    mainHttpPort: 12345,
    claudeConfigRoot: claudeRuntimeDir,
  });
  openSessions.push(s);
  return s;
}

function readSeed(s: Session): Record<string, unknown> {
  const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
  return JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Record<string, unknown>;
}

function readSessionSettings(s: Session): Record<string, unknown> {
  const p = path.join(s.claudeConfigDir!, 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

describe('Session — settings.json bypass disclaimer', () => {
  it('writes skipDangerousModePermissionPrompt:true so the bypass widget never opens', () => {
    // Required to survive the claude 2.1.143 migration that moves
    // .claude.json#bypassPermissionsModeAccepted into userSettings and
    // then deletes the source field. The runtime widget check reads only
    // userSettings/localSettings/flagSettings/policySettings.
    const s = makeSession();
    const settings = readSessionSettings(s);
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  });
});

describe('Session — .claude.json trust seed', () => {
  it('writes a regular file (not a symlink) with the trust flags set for cwd', () => {
    const s = makeSession();
    const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
    expect(fs.lstatSync(seedPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(seedPath).isFile()).toBe(true);

    const json = readSeed(s);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects).toBeDefined();
    expect(projects[cwd]).toBeDefined();
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(projects[cwd].hasCompletedProjectOnboarding).toBe(true);
    expect(projects[cwd].hasClaudeMdExternalIncludesApproved).toBe(true);
    // Pre-accepts the bypass-permissions disclaimer at the top level so the
    // CLI doesn't open an interactive widget on first spawn.
    expect(json.bypassPermissionsModeAccepted).toBe(true);
  });

  it('preserves top-level keys lifted from the runtime .claude.json', () => {
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        userID: 'user-xyz',
        theme: 'dark',
      }),
    );

    const s = makeSession();
    const json = readSeed(s);
    expect(json.hasCompletedOnboarding).toBe(true);
    expect(json.userID).toBe('user-xyz');
    expect(json.theme).toBe('dark');
    // And the cwd trust entry got merged in.
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project entries for other cwds and merges (not replaces) the target cwd', () => {
    const otherCwd = '/some/other/path';
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({
        projects: {
          [otherCwd]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
          [cwd]: { lastSessionId: 'prev-session', allowedTools: ['Read'] },
        },
      }),
    );

    const s = makeSession();
    const json = readSeed(s);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    // Other cwd untouched.
    expect(projects[otherCwd]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash'],
    });
    // Target cwd: existing fields preserved, trust flags added on top,
    // empty containers NOT injected over real saved state.
    expect(projects[cwd].lastSessionId).toBe('prev-session');
    expect(projects[cwd].allowedTools).toEqual(['Read']);
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  it('falls back to a minimal seed when the runtime .claude.json is absent', () => {
    // No file at claudeRuntimeDir/.claude.json — typical fresh container.
    const s = makeSession();
    const json = readSeed(s);
    expect(json.hasCompletedOnboarding).toBe(true);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('falls back to a minimal seed when the runtime .claude.json is malformed', () => {
    fs.writeFileSync(path.join(claudeRuntimeDir, '.claude.json'), '{not valid json');
    const s = makeSession();
    const json = readSeed(s);
    expect(json.hasCompletedOnboarding).toBe(true);
    const projects = json.projects as Record<string, Record<string, unknown>>;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('does not symlink .claude.json from runtime (would let writeFileSync corrupt the shared copy)', () => {
    fs.writeFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      JSON.stringify({ canary: 'untouched' }),
    );

    const s = makeSession();
    const seedPath = path.join(s.claudeConfigDir!, '.claude.json');
    expect(fs.lstatSync(seedPath).isSymbolicLink()).toBe(false);

    // Verify the runtime copy was not modified.
    const runtimeRaw = fs.readFileSync(
      path.join(claudeRuntimeDir, '.claude.json'),
      'utf8',
    );
    expect(JSON.parse(runtimeRaw)).toEqual({ canary: 'untouched' });
  });
});

/**
 * S5 — pause / resume / stop interactions on the underlying PTY.
 *
 * We need a slimmed-down session factory so we can capture the FakeAgent
 * reference (the outer helper hides it inside the override). The fake is
 * extended to NOT exit on SIGSTOP/SIGCONT so we can drive a realistic
 * pause→resume→stop sequence.
 */
function makeS5Session(): { s: Session; fake: FakeAgentProcess } {
  const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
  const s = new Session({
    orchestratorId: 'orch-s5-test',
    name: 's5-test',
    role: 'tester',
    type: 'worker',
    cwd,
    initialPrompt: 'noop',
    preamble: null,
    model: 'test-model',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    logsDir,
    mcpRuntimeDir,
    mcpHost: '127.0.0.1',
    mcpPort: 0,
    agentProcessOverride: fake,
    hookToken: 'test-hook',
    mainHttpPort: 12345,
    claudeConfigRoot: claudeRuntimeDir,
  });
  openSessions.push(s);
  return { s, fake };
}

/** Sniff every `session.status_changed` event for the given session. */
const eventUnsubs: Array<() => void> = [];
function captureStatusEvents(sessionId: string): SessionStatus[] {
  const seen: SessionStatus[] = [];
  const off = eventBus.onEvent((ev) => {
    if (ev.kind !== 'session.status_changed') return;
    if (ev.sessionId !== sessionId) return;
    const status = (ev.payload as { status?: SessionStatus })?.status;
    if (status) seen.push(status);
  });
  eventUnsubs.push(off);
  return seen;
}

afterEach(() => {
  for (const off of eventUnsubs) {
    try {
      off();
    } catch {
      /* ignore */
    }
  }
  eventUnsubs.length = 0;
});

describe('Session.pause / resume — SIGSTOP / SIGCONT', () => {
  it('pause() from running flips to paused and pushes SIGSTOP to the PTY', () => {
    const { s, fake } = makeS5Session();
    expect(s.status).toBe('running');
    const events = captureStatusEvents(s.id);
    expect(s.pause('operator-pause')).toBe(true);
    expect(s.status).toBe('paused');
    expect(fake.signals).toContain('SIGSTOP');
    // session.status_changed must be emitted for the paused transition.
    expect(events.at(-1)).toBe('paused');
  });

  it('pause() is idempotent — second call returns false and does not re-emit', () => {
    const { s, fake } = makeS5Session();
    expect(s.pause('first')).toBe(true);
    const sigCountBefore = fake.signals.filter((sig) => sig === 'SIGSTOP').length;
    const events = captureStatusEvents(s.id);
    expect(s.pause('second')).toBe(false);
    const sigCountAfter = fake.signals.filter((sig) => sig === 'SIGSTOP').length;
    expect(sigCountAfter).toBe(sigCountBefore); // no duplicate SIGSTOP
    expect(events).toHaveLength(0); // no status event for a no-op
  });

  it('pause() refuses terminal states and stop-requested sessions', () => {
    const { s } = makeS5Session();
    s.stop('test', 5000); // sets _stopRequested
    expect(s.pause('attempt')).toBe(false);
    expect(s.status).not.toBe('paused');
  });

  it('resume() from paused → running, pushes SIGCONT to the PTY', () => {
    const { s, fake } = makeS5Session();
    s.pause('p');
    expect(s.resume('r')).toBe(true);
    expect(s.status).toBe('running');
    expect(fake.signals).toContain('SIGCONT');
  });

  it('resume() from non-paused returns false', () => {
    const { s } = makeS5Session();
    expect(s.resume('r')).toBe(false);
  });
});

describe('Session.stop — SIGCONT before SIGTERM when paused', () => {
  it('stop() on a paused session sends SIGCONT first so SIGTERM is honored without waiting the full grace', () => {
    const { s, fake } = makeS5Session();
    s.pause('test');
    expect(s.status).toBe('paused');
    // After stop: SIGCONT must appear BEFORE the SIGTERM in the recorded signal log.
    s.stop('test-stop', 5000);
    const sigContIdx = fake.signals.indexOf('SIGCONT');
    const sigTermIdx = fake.signals.indexOf('SIGTERM');
    expect(sigContIdx).toBeGreaterThanOrEqual(0);
    expect(sigTermIdx).toBeGreaterThan(sigContIdx);
  });

  it('stop() classifies the eventual exit as killed (user-initiated)', async () => {
    const { s } = makeS5Session();
    s.stop('test-kill', 5000);
    // FakeAgentProcess.kill('SIGTERM') schedules onExit via setImmediate.
    await new Promise((r) => setImmediate(r));
    expect(s.status).toBe('killed');
  });
});

describe('FakeAgentProcess — SIGSTOP/SIGCONT do not exit', () => {
  it('records the signal without exiting the process', () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
    let exits = 0;
    fake.onExit(() => exits++);
    fake.kill('SIGSTOP');
    fake.kill('SIGCONT');
    expect(fake.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    // Writes still go through — the fake is still "alive".
    fake.write('post-stop');
    expect(fake.writes).toContain('post-stop');
    expect(exits).toBe(0);
  });
});

describe('buildClaudeArgs — preamble routing', () => {
  const base = {
    model: 'test-model',
    effort: 'low' as const,
    permissionMode: 'bypassPermissions' as const,
  };

  it('routes the preamble to --append-system-prompt (survives /clear)', () => {
    const args = buildClaudeArgs({
      ...base,
      preamble: 'ROLE INSTRUCTIONS',
      initialPrompt: 'do the task',
    });
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('ROLE INSTRUCTIONS');
    // The preamble must NOT be concatenated into the positional prompt.
    expect(args).toContain('do the task');
    expect(args.some((a) => a.includes('ROLE INSTRUCTIONS') && a.includes('do the task'))).toBe(
      false,
    );
  });

  it('keeps only the initial prompt as the trailing positional argument', () => {
    const args = buildClaudeArgs({
      ...base,
      preamble: 'ROLE',
      initialPrompt: 'TASK',
      mcpConfigPath: '/tmp/mcp.json',
    });
    expect(args[args.length - 1]).toBe('TASK');
    expect(args).toContain('--mcp-config=/tmp/mcp.json');
  });

  it('prefixes the resume notice onto the positional prompt, not the system prompt', () => {
    const args = buildClaudeArgs({
      ...base,
      preamble: 'ROLE',
      initialPrompt: 'TASK',
      resumeNotice: '## Server restart notice',
    });
    const positional = args[args.length - 1];
    expect(positional.startsWith('## Server restart notice')).toBe(true);
    expect(positional).toContain('TASK');
    // The system prompt is the durable role only — never the notice.
    const i = args.indexOf('--append-system-prompt');
    expect(args[i + 1]).toBe('ROLE');
  });

  it('omits the positional arg entirely when there is no prompt or notice', () => {
    const args = buildClaudeArgs({ ...base, preamble: 'ROLE', initialPrompt: null });
    expect(args).toContain('--append-system-prompt');
    expect(args[args.length - 1]).toBe('ROLE'); // last token is the preamble value, no positional
  });
});

describe('Session — requestContextReset (deferred /clear & /compact)', () => {
  function makeRunning(): { s: Session; fake: FakeAgentProcess } {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
    const s = new Session({
      orchestratorId: 'orch-ctx-test',
      name: 'ctx-test',
      role: 'tester',
      type: 'worker',
      cwd,
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
      hookToken: 'test-hook',
      mainHttpPort: 12345,
      claudeConfigRoot: claudeRuntimeDir,
    });
    openSessions.push(s);
    return { s, fake };
  }

  it('fires /clear into the PTY once the session has been idle', async () => {
    const { s, fake } = makeRunning();
    expect(s.requestContextReset('/clear', { idleMs: 10 })).toBe(true);
    expect(s.hasPendingContextReset).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    const joined = fake.writes.join('');
    expect(joined).toContain('/clear');
    // submit keypress (solo CR) was sent after the command
    expect(fake.writes).toContain('\r');
    expect(s.hasPendingContextReset).toBe(false);
  });

  it('is idempotent — a second arm while one is pending returns false', () => {
    const { s } = makeRunning();
    expect(s.requestContextReset('/clear', { idleMs: 50 })).toBe(true);
    expect(s.requestContextReset('/compact', { idleMs: 50 })).toBe(false);
  });

  it('passes /compact instructions through to the PTY', async () => {
    const { s, fake } = makeRunning();
    s.requestContextReset('/compact', { idleMs: 10, instructions: 'keep the API contract' });
    await new Promise((r) => setTimeout(r, 350));
    expect(fake.writes.join('')).toContain('/compact keep the API contract');
  });

  it('defers firing while the agent keeps producing output', async () => {
    const { s, fake } = makeRunning();
    s.requestContextReset('/clear', { idleMs: 60 });
    // Keep it "busy": emit output before the idle window elapses.
    const chatter = setInterval(() => fake._emitData('working...'), 20);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.writes.join('')).not.toContain('/clear');
    clearInterval(chatter);
    // Now it can go idle and fire.
    await new Promise((r) => setTimeout(r, 400));
    expect(fake.writes.join('')).toContain('/clear');
  });

  it('auto-arms a /compact once output crosses the byte threshold', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
    const s = new Session({
      orchestratorId: 'orch-auto-test',
      name: 'auto-test',
      role: 'tester',
      type: 'worker',
      cwd,
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
      hookToken: 'test-hook',
      mainHttpPort: 12345,
      claudeConfigRoot: claudeRuntimeDir,
      idleThresholdMs: 10,
      autoCompactBytes: 50,
    });
    openSessions.push(s);
    fake._emitData('x'.repeat(60)); // crosses the 50-byte threshold
    expect(s.hasPendingContextReset).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    expect(fake.writes.join('')).toContain('/compact');
  });
});

/**
 * update_system D.5 — `armNotice`: the retrying operator warning.
 *
 * The property under test is the one the naive path fails: a lead that is
 * mid-turn when the operator hits "update" must STILL be interrupted, at the
 * first real idle boundary, or be reported as never reached. Never silence.
 */
describe('Session — armNotice (operator warning with a deadline)', () => {
  const NOTICE = '[swarm-os] update in 2 minutes';

  function makeRunning(): { s: Session; fake: FakeAgentProcess } {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd });
    const s = new Session({
      orchestratorId: 'orch-notice-test',
      name: 'notice-test',
      role: 'tester',
      type: 'lead',
      cwd,
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
      hookToken: 'test-hook',
      mainHttpPort: 12345,
      claudeConfigRoot: claudeRuntimeDir,
    });
    openSessions.push(s);
    return { s, fake };
  }

  it('fires into the PTY on a real idle boundary, with the notifySignal cadence', async () => {
    const { s, fake } = makeRunning();
    const outcomes: string[] = [];
    expect(
      s.armNotice(NOTICE, {
        idleMs: 20,
        deadlineMs: 2000,
        id: 'n-1',
        onOutcome: (o) => outcomes.push(o),
      }),
    ).toBe(true);
    expect(s.hasPendingNotice).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    // Text first, then a SOLO carriage return ~150 ms later (structural for
    // the Ink TUI — a one-shot `\rtext\r` lands in the prompt without firing).
    const idx = fake.writes.findIndex((w) => w.includes(NOTICE));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(fake.writes[idx]).toBe(`\r${NOTICE}`);
    expect(fake.writes[idx + 1]).toBe('\r');
    expect(s.hasPendingNotice).toBe(false);
    expect(s.noticeState).toEqual({ id: 'n-1', outcome: 'fired' });
    expect(outcomes).toEqual(['fired']);
  });

  it('does NOT bump idleSince — a server-injected write must not fake activity', async () => {
    const { s } = makeRunning();
    s.armNotice(NOTICE, { idleMs: 20, deadlineMs: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.noticeState?.outcome).toBe('fired');
    // Idle for the whole test: nothing (including our own injection) reset it.
    expect(Date.now() - s.idleSince).toBeGreaterThanOrEqual(250);
  });

  it('re-arms while the agent keeps talking, then fires once it goes quiet', async () => {
    const { s, fake } = makeRunning();
    s.armNotice(NOTICE, { idleMs: 60, deadlineMs: 5000 });
    const chatter = setInterval(() => fake._emitData('working...'), 20);
    await new Promise((r) => setTimeout(r, 250));
    // Still mid-turn: nothing injected, but the notice is still armed.
    expect(fake.writes.join('')).not.toContain(NOTICE);
    expect(s.hasPendingNotice).toBe(true);
    clearInterval(chatter);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.writes.join('')).toContain(NOTICE);
    expect(s.noticeState?.outcome).toBe('fired');
  });

  it('reports never_idle at the deadline instead of waiting forever', async () => {
    const { s, fake } = makeRunning();
    const outcomes: string[] = [];
    s.armNotice(NOTICE, {
      idleMs: 100,
      deadlineMs: 150,
      id: 'n-deadline',
      onOutcome: (o) => outcomes.push(o),
    });
    const chatter = setInterval(() => fake._emitData('busy'), 20);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(chatter);
    expect(outcomes).toEqual(['never_idle']);
    expect(s.noticeState).toEqual({ id: 'n-deadline', outcome: 'never_idle' });
    expect(s.hasPendingNotice).toBe(false);
    // And it stays given up — no late injection after the deadline.
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.writes.join('')).not.toContain(NOTICE);
  });

  it('never interleaves with a pending context reset — it waits for the whole /clear write', async () => {
    const { s, fake } = makeRunning();
    // Both target the same idle boundary and the same prompt buffer.
    expect(s.requestContextReset('/clear', { idleMs: 20 })).toBe(true);
    expect(s.armNotice(NOTICE, { idleMs: 20, deadlineMs: 5000 })).toBe(true);

    await new Promise((r) => setTimeout(r, 1200));
    const joined = fake.writes.join('');
    expect(joined).toContain('/clear');
    expect(joined).toContain(NOTICE);

    const resetIdx = fake.writes.findIndex((w) => w.includes('/clear'));
    const noticeIdx = fake.writes.findIndex((w) => w.includes(NOTICE));
    // The reset went first and its submit CR is the very next write: the
    // notice did not land inside the half-typed slash command.
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(noticeIdx).toBeGreaterThan(resetIdx + 1);
    expect(fake.writes[resetIdx + 1]).toBe('\r');
  });

  it('a second arm supersedes the first (operator escalation)', async () => {
    const { s, fake } = makeRunning();
    const outcomes: string[] = [];
    s.armNotice('stale — update in 5 minutes', {
      idleMs: 5000,
      deadlineMs: 5000,
      id: 'first',
      onOutcome: (o) => outcomes.push(`first:${o}`),
    });
    expect(
      s.armNotice(NOTICE, {
        idleMs: 20,
        deadlineMs: 2000,
        id: 'second',
        onOutcome: (o) => outcomes.push(`second:${o}`),
      }),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(outcomes).toEqual(['first:aborted', 'second:fired']);
    expect(fake.writes.join('')).not.toContain('stale');
    expect(fake.writes.join('')).toContain(NOTICE);
  });

  it('refuses to arm without a live PTY (skipSpawn) and reports it to the caller', () => {
    const s = new Session({
      orchestratorId: 'orch-notice-skip',
      name: 'notice-skip',
      role: 'tester',
      type: 'lead',
      cwd,
      initialPrompt: null,
      preamble: null,
      model: 'test-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
      logsDir,
      mcpRuntimeDir,
      mcpHost: '127.0.0.1',
      mcpPort: 0,
      skipSpawn: true,
    });
    openSessions.push(s);
    expect(s.armNotice(NOTICE, { idleMs: 10, deadlineMs: 1000 })).toBe(false);
    expect(s.noticeState).toBeNull();
  });

  it('refuses to arm on a paused lead — a SIGSTOP’d process cannot drain its tty', () => {
    const { s } = makeRunning();
    expect(s.pause('test')).toBe(true);
    expect(s.armNotice(NOTICE, { idleMs: 10, deadlineMs: 1000 })).toBe(false);
  });

  it('aborts a pending notice when the session is stopped, and cancelNotice is explicit', async () => {
    const { s } = makeRunning();
    const outcomes: string[] = [];
    s.armNotice(NOTICE, {
      idleMs: 5000,
      deadlineMs: 9000,
      onOutcome: (o) => outcomes.push(o),
    });
    expect(s.cancelNotice()).toBe(true);
    expect(s.cancelNotice()).toBe(false);
    expect(outcomes).toEqual(['aborted']);

    const other = makeRunning();
    const seen: string[] = [];
    other.s.armNotice(NOTICE, {
      idleMs: 5000,
      deadlineMs: 9000,
      onOutcome: (o) => seen.push(o),
    });
    other.s.stop('test-stop', 0);
    expect(seen).toEqual(['aborted']);
    await new Promise((r) => setTimeout(r, 30));
  });

  it('keeps a `fired` outcome reportable after the session exits', async () => {
    const { s } = makeRunning();
    s.armNotice(NOTICE, { idleMs: 20, deadlineMs: 2000, id: 'n-exit' });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.noticeState?.outcome).toBe('fired');
    s.stop('test-stop', 0);
    await new Promise((r) => setTimeout(r, 60));
    // The exit path must not overwrite the delivery we already observed.
    expect(s.noticeState).toEqual({ id: 'n-exit', outcome: 'fired' });
  });
});
