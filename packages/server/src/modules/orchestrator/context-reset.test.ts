import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from './session.js';
import { Orchestrator, SessionActionError } from './index.js';
import { NoOpPersistence } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import { CodexProvider } from '../providers/codex.js';
import type { Config } from '../../config.js';

/**
 * Monitoring, Lot 3 (docs/monitoring-agents.md) — the operator context reset.
 *
 * The contract in one line: an operator pressing COMPACT/CLEAR must get a
 * distinct, immediate answer for every reason the command will not run —
 * unknown session, provider without the command, dead session, reset already
 * armed — instead of the silent, log-only skip `_fireContextReset` performs
 * once a reset is armed. And unlike `team.clear_worker`, the operator path
 * accepts the lead.
 */

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];

function makeConfig(): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 8788,
    projectName: 'test',
    defaultModel: 'm',
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
    idleThresholdMs: 50,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
  } as unknown as Config;
}

interface Team {
  orch: Orchestrator;
  lead: Session;
  leadPty: FakeAgentProcess;
}

/**
 * A live team whose sole registered adapter is a fake one — registered under
 * `claude` because that is the team default every session resolves against.
 */
function makeTeam(provider: FakeProvider = new FakeProvider({ id: 'claude' })): Team {
  const config = makeConfig();
  const registry = new ProviderRegistry();
  registry.register(provider, { builtin: true });
  const orch = new Orchestrator(
    {
      name: 'monitoring',
      role: 'co',
      defaultModel: 'm',
      defaultEffort: 'low',
      defaultPermissionMode: 'bypassPermissions',
      defaultProvider: 'claude',
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    config,
    { persistence: new NoOpPersistence(), providerRegistry: registry },
  );
  const leadPty = new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot });
  const lead = orch.start({ agentProcessOverride: leadPty });
  openSessions.push(lead);
  return { orch, lead, leadPty };
}

function addWorker(orch: Orchestrator, name = 'w1'): { worker: Session; pty: FakeAgentProcess } {
  const pty = new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot });
  const worker = orch.addWorker({
    name,
    role: 'tester',
    prompt: 'work',
    cwd: tmpRoot,
    agentProcessOverride: pty,
  });
  openSessions.push(worker);
  return { worker, pty };
}

/** Assert the call refuses with exactly this typed error (code + HTTP status). */
function expectRefusal(fn: () => unknown, code: string, httpStatus: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SessionActionError);
  expect((thrown as SessionActionError).code).toBe(code);
  expect((thrown as SessionActionError).httpStatus).toBe(httpStatus);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ctxreset-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir]) fs.mkdirSync(d, { recursive: true });
  openSessions = [];
});

afterEach(async () => {
  // Same drain as the sibling suites: stop every PTY, let the queued log
  // writes and any armed reset timer land before the tmp dir disappears.
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

describe('Session.supportsContextReset', () => {
  it('is true when the adapter has a line for the command', () => {
    const { lead } = makeTeam();
    expect(lead.supportsContextReset('/compact')).toBe(true);
    expect(lead.supportsContextReset('/clear')).toBe(true);
  });

  it('is false when the adapter returns null', () => {
    const { lead } = makeTeam(new FakeProvider({ id: 'claude', contextResetLine: () => null }));
    expect(lead.supportsContextReset('/compact')).toBe(false);
    expect(lead.supportsContextReset('/clear')).toBe(false);
  });

  it('answers per command — one may exist while the other does not', () => {
    const { lead } = makeTeam(
      new FakeProvider({
        id: 'claude',
        contextResetLine: (cmd) => (cmd === '/compact' ? '/compact' : null),
      }),
    );
    expect(lead.supportsContextReset('/compact')).toBe(true);
    expect(lead.supportsContextReset('/clear')).toBe(false);
  });

  it('does not depend on instructions the caller has not typed yet', () => {
    // An adapter that only ever renders the bare token (codex) must still be
    // reported as supporting `/compact`, so the question is asked bare.
    const seen: Array<string | undefined> = [];
    const { lead } = makeTeam(
      new FakeProvider({
        id: 'claude',
        contextResetLine: (cmd, instructions) => {
          seen.push(instructions);
          return cmd;
        },
      }),
    );
    expect(lead.supportsContextReset('/compact')).toBe(true);
    expect(seen).toEqual([undefined]);
  });
});

describe('Orchestrator.requestContextReset — accepted', () => {
  it('arms a reset on the LEAD (what team.clear_worker refuses)', () => {
    const { orch, lead } = makeTeam();
    expect(orch.requestContextReset(lead.id, '/compact').id).toBe(lead.id);
    expect(lead.hasPendingContextReset).toBe(true);
    expect(lead.toView().contextResetPending).toBe(true);
    // The MCP path is untouched: a lead is still not a `team.clear_worker`
    // target, which is the whole reason the operator path is a second method.
    expect(orch.requestWorkerContextReset(lead.id, '/compact')).toBe(false);
  });

  it('arms a reset on a WORKER too', () => {
    const { orch } = makeTeam();
    const { worker } = addWorker(orch);
    expect(orch.requestContextReset(worker.id, '/clear').id).toBe(worker.id);
    expect(worker.toView().contextResetPending).toBe(true);
  });

  it('types the adapter line at the idle boundary, instructions included', async () => {
    const { orch, lead, leadPty } = makeTeam();
    orch.requestContextReset(lead.id, '/compact', 'keep the API contract');
    // Nothing is typed synchronously — the command waits for an idle PTY.
    expect(leadPty.writes).toEqual([]);
    await new Promise((r) => setTimeout(r, 400));
    expect(leadPty.writes.join('')).toContain('/compact keep the API contract');
    expect(lead.hasPendingContextReset).toBe(false);
  });

  it('re-arms once the previous reset has fired', async () => {
    const { orch, lead } = makeTeam();
    orch.requestContextReset(lead.id, '/clear');
    await new Promise((r) => setTimeout(r, 400));
    expect(lead.hasPendingContextReset).toBe(false);
    expect(() => orch.requestContextReset(lead.id, '/compact')).not.toThrow();
  });

  it('stays occupied through the two-step write window — no duplicate reset', async () => {
    // `_fireContextReset` nulls the armed slot 250 ms before the CR lands.
    // Seen live: two operator `/compact` 14 ms apart both answered
    // `scheduled` and both fired. The occupancy must cover that window.
    const { orch, lead, leadPty } = makeTeam();
    orch.requestContextReset(lead.id, '/compact');
    // Idle from the start, so the fire begins almost immediately; poll until
    // the intro write happened but before the +250 ms CR.
    await new Promise((r) => setTimeout(r, 60));
    expect(leadPty.writes.join('')).toContain('/compact');
    expect(leadPty.writes.join('')).not.toContain('\r/compact\r'.repeat(2));
    expect(lead.hasPendingContextReset).toBe(true); // firing counts as pending
    expect(() => orch.requestContextReset(lead.id, '/compact')).toThrow(
      expect.objectContaining({ code: 'RESET_ALREADY_PENDING' }),
    );
    await new Promise((r) => setTimeout(r, 400));
    // Exactly one submission: one intro + one CR.
    const all = leadPty.writes.join('');
    expect(all.match(/\/compact/g)?.length).toBe(1);
  });
});

describe('Orchestrator.requestContextReset — refusals', () => {
  it('404s an unknown session id', () => {
    const { orch } = makeTeam();
    expectRefusal(() => orch.requestContextReset('nope', '/compact'), 'SESSION_UNKNOWN', 404);
  });

  it('refuses a provider with no such command instead of arming a silent no-op', () => {
    const { orch, lead, leadPty } = makeTeam(
      new FakeProvider({ id: 'claude', contextResetLine: () => null }),
    );
    expectRefusal(
      () => orch.requestContextReset(lead.id, '/compact'),
      'PROVIDER_NO_RESET',
      409,
    );
    // The point of the pre-check: nothing was armed, so nothing gets silently
    // dropped 50 ms later and the UI never shows a pending badge that lies.
    expect(lead.hasPendingContextReset).toBe(false);
    expect(leadPty.writes).toEqual([]);
  });

  it('refuses a paused session', () => {
    const { orch } = makeTeam();
    const { worker } = addWorker(orch);
    orch.pauseSession(worker.id);
    expect(worker.status).toBe('paused');
    expectRefusal(
      () => orch.requestContextReset(worker.id, '/compact'),
      'SESSION_NOT_ACTIVE',
      409,
    );
  });

  it('refuses a terminated session', async () => {
    const { orch } = makeTeam();
    const { worker } = addWorker(orch);
    worker.stop('test', 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(['killed', 'exited', 'failed']).toContain(worker.status);
    expectRefusal(
      () => orch.requestContextReset(worker.id, '/clear'),
      'SESSION_NOT_ACTIVE',
      409,
    );
  });

  it('refuses a second request while one is armed (the first wins)', () => {
    const { orch, lead } = makeTeam();
    orch.requestContextReset(lead.id, '/compact', 'first');
    expectRefusal(
      () => orch.requestContextReset(lead.id, '/clear', 'second'),
      'RESET_ALREADY_PENDING',
      409,
    );
    expect(lead.hasPendingContextReset).toBe(true);
  });

  it('reports the provider gap before the status gap — the codes stay distinct', () => {
    const { orch } = makeTeam(new FakeProvider({ id: 'claude', contextResetLine: () => null }));
    const { worker } = addWorker(orch);
    orch.pauseSession(worker.id);
    // Both refusals apply; the documented order makes the operator-facing one
    // ("this provider cannot do it at all") the one that surfaces.
    expectRefusal(
      () => orch.requestContextReset(worker.id, '/compact'),
      'PROVIDER_NO_RESET',
      409,
    );
  });
});

describe('command mapping stays the adapter’s business', () => {
  it('codex still renders /clear as /new and drops instructions', () => {
    // Pinned here because the operator route speaks bare words (`clear`) and
    // maps them to `/clear`: if that ever reached the PTY verbatim, codex
    // would blank the terminal instead of starting a new thread.
    const codex = new CodexProvider();
    expect(codex.contextResetLine('/clear')).toBe('/new');
    expect(codex.contextResetLine('/compact')).toBe('/compact');
    expect(codex.contextResetLine('/compact', 'keep the contract')).toBe('/compact');
  });

  it('the session types whatever the adapter returned, not the requested token', async () => {
    const { orch, lead, leadPty } = makeTeam(
      new FakeProvider({
        id: 'claude',
        contextResetLine: (cmd) => (cmd === '/clear' ? '/new' : cmd),
      }),
    );
    orch.requestContextReset(lead.id, '/clear');
    await new Promise((r) => setTimeout(r, 400));
    const typed = leadPty.writes.join('');
    expect(typed).toContain('/new');
    expect(typed).not.toContain('/clear');
  });
});
