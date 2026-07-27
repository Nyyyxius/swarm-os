/**
 * Multi-provider, Lot 7 — `POST /orchestrators/:id/workers`.
 *
 * The human-operator twin of the MCP `team.spawn_worker` tool. Both channels
 * funnel into `Orchestrator.addWorker`, so what is asserted here is the HTTP
 * envelope around it: one test per status code, plus the two inheritance
 * behaviours that make a mixed team possible.
 *
 * Same substituted registry as `providers.test.ts`, for the same reason: the
 * built-in one probes the real CLIs on PATH, so a test asserting on its verdicts
 * would be green on a dev box and red on CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { FakeProvider } from '../../src/modules/providers/fake.js';
import type { Orchestrator } from '../../src/modules/orchestrator/index.js';
import type { SessionView } from '../../src/modules/orchestrator/session.js';

let stack: TestStack;
/** The adapters of the current stack, so a test can read what Session asked them. */
let fakes: Record<string, FakeProvider>;

/**
 * `binary: 'sh'` on everything a test actually spawns: this route runs a real
 * PTY (there is no `skipSpawn` over HTTP, on purpose), and a missing binary
 * would land the worker in `failed` before we could read the row it wrote.
 */
function fakeRegistry(): ProviderRegistry {
  const claude = new FakeProvider({ id: 'claude', label: 'Claude Code', binary: 'sh' });
  const brokencli = new FakeProvider({
    id: 'brokencli',
    label: 'Broken CLI',
    binary: 'brokencli',
    probe: async () => ({ available: false, reason: '`brokencli` is not on PATH' }),
  });
  const plugcli = new FakeProvider({
    id: 'plugcli',
    label: 'Plugin CLI',
    binary: 'sh',
    capabilities: { effort: false, notificationHook: false },
    probe: async () => ({ available: true, version: 'plugcli 9.9.9' }),
  });
  fakes = { claude, brokencli, plugcli };
  const r = new ProviderRegistry();
  r.register(claude, { builtin: true });
  r.register(brokencli, { builtin: true });
  r.register(plugcli);
  return r;
}

beforeEach(async () => {
  stack = await bootTestStack({ providerRegistry: fakeRegistry() });
});

afterEach(async () => {
  await stack.teardown();
});

function url(p: string): string {
  return `http://127.0.0.1:${stack.mainPort}${p}`;
}

async function spawnWorker(orchId: string, body: unknown): Promise<Response> {
  return await fetch(url(`/orchestrators/${orchId}/workers`), {
    method: 'POST',
    headers: { ...authHeaders(stack.config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A live team whose lead is NOT spawned (`skipSpawn`) — the lead's PTY is
 * irrelevant here and starting one per test would only add flake. The workers
 * this route creates DO spawn (`sh`), which is the point.
 */
function createTeam(defaultProvider = 'claude'): { orchestrator: Orchestrator } {
  const { orchestrator } = stack.spawner.create(
    {
      name: 'NOMAD',
      role: 'coordinator',
      defaultModel: stack.config.defaultModel,
      defaultEffort: stack.config.defaultEffort,
      defaultPermissionMode: stack.config.defaultPermissionMode,
      defaultProvider,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
    },
    { skipSpawn: true },
  );
  return { orchestrator };
}

interface ErrorBody {
  error: string;
  code?: string;
  known?: string[];
  unavailableReason?: string | null;
}

describe('POST /orchestrators/:id/workers — auth + resource', () => {
  it('requires the auth token', async () => {
    const { orchestrator } = createTeam();
    const res = await fetch(url(`/orchestrators/${orchestrator.id}/workers`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    expect(res.status).toBe(401);
  });

  it('404s on an orchestrator that is not in the live map', async () => {
    const res = await spawnWorker('11111111-2222-3333-4444-555555555555', { prompt: 'go' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe('not found');
  });

  it('409 ORCH_NOT_ACTIVE once the team is stopping or stopped', async () => {
    const { orchestrator } = createTeam();
    stack.spawner.destroy(orchestrator.id, 'user');
    const res = await spawnWorker(orchestrator.id, { prompt: 'go' });
    expect(res.status).toBe(409);
    const j = (await res.json()) as ErrorBody;
    expect(j.code).toBe('ORCH_NOT_ACTIVE');
    // The status is quoted so the operator knows WHICH dead state it is.
    expect(j.error).toMatch(/stopping|stopped/);
    expect(orchestrator.listSessions().filter((s) => s.type === 'worker')).toHaveLength(0);
  });
});

describe('POST /orchestrators/:id/workers — 201', () => {
  it('inherits provider, model, effort and permission from the team', async () => {
    const { orchestrator } = createTeam('plugcli');
    const res = await spawnWorker(orchestrator.id, { name: 'PROBE-04', role: 'scout', prompt: 'go' });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session).toMatchObject({
      name: 'PROBE-04',
      role: 'scout',
      type: 'worker',
      provider: 'plugcli',
      model: stack.config.defaultModel,
      effort: stack.config.defaultEffort,
      permissionMode: stack.config.defaultPermissionMode,
    });
    // cwd is NOT accepted on the wire — it comes from the lead, already
    // realpath-validated when the team was created.
    expect(session.cwd).toBe(orchestrator.lead?.cwd);
    // Persisted, and visible on the team.
    expect(stack.db.getSession(session.id)?.provider).toBe('plugcli');
    expect(orchestrator.listSessions().some((s) => s.id === session.id)).toBe(true);
  });

  it('honours an explicit provider — this is how the UI builds a mixed team', async () => {
    const { orchestrator } = createTeam('claude');
    const res = await spawnWorker(orchestrator.id, {
      name: 'GEM-01',
      prompt: 'go',
      provider: 'plugcli',
      model: 'some-brand-new-model-id',
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session.provider).toBe('plugcli');
    // The model string is deliberately never validated — ids ship faster than
    // our releases, and rejecting a valid one is the worse failure.
    expect(session.model).toBe('some-brand-new-model-id');
    // Mixed, not converted: the lead keeps its own provider.
    expect(orchestrator.lead?.toView().provider).toBe('claude');
    expect(stack.db.getSession(session.id)?.provider).toBe('plugcli');
  });

  it('falls back to the WORKER provider default model when the team provider differs', async () => {
    // Regression: `addWorker` used to do `spec.model ?? this.defaultModel`, so a
    // claude team spawning a plugcli worker with no explicit model pinned the
    // TEAM's (claude) model id onto the other vendor's CLI — a spawn that only
    // fails later, inside the agent's own PTY, with a vendor error message.
    const { orchestrator } = createTeam('claude');
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', provider: 'plugcli' });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session.provider).toBe('plugcli');
    expect(session.model).toBe(fakes.plugcli.defaults().model);
    expect(session.model).not.toBe(stack.config.defaultModel);
    expect(stack.db.getSession(session.id)?.model).toBe(fakes.plugcli.defaults().model);
  });

  it('keeps the team default model when the worker stays on the team provider', async () => {
    // The other half of the rule: same provider ⇒ the team's explicit model
    // choice must NOT be replaced by the adapter's generic default.
    const { orchestrator } = createTeam('plugcli');
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', provider: 'plugcli' });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session.model).toBe(stack.config.defaultModel);
  });

  it('scopes EFFORT and PERMISSION to the worker provider, not just the model', async () => {
    // `addWorker` used to scope the model and inherit effort/permission blind,
    // which made `AgentProvider.defaults().effort` and `.permissionMode` dead
    // code: nothing in the resolution path could ever read them. A cross-provider
    // worker must take all three from the CLI that will run it.
    const { orchestrator } = createTeam('claude');
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', provider: 'plugcli' });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session.effort).toBe(fakes.plugcli!.defaults().effort);
    expect(session.effort).not.toBe(stack.config.defaultEffort);
    expect(session.permissionMode).toBe(fakes.plugcli!.defaults().permissionMode);
  });

  it('coerces a permission mode the worker provider cannot express (MEDIUM 3)', async () => {
    // Asking a `[bypassPermissions, default]` adapter for `plan`: the value used
    // to be stored, persisted and shown as `plan` while the agent ran with
    // approvals bypassed. The only coercion in the product lived in the browser,
    // so every API and MCP caller went straight past it.
    const { orchestrator } = createTeam('claude');
    const res = await spawnWorker(orchestrator.id, {
      prompt: 'go',
      provider: 'plugcli',
      permissionMode: 'plan',
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session.permissionMode).toBe('bypassPermissions');
    expect(stack.db.getSession(session.id)?.permission_mode).toBe('bypassPermissions');
    // The mode the adapter was actually asked to build an argv with — the value
    // in the panel and the value in the PTY are the same value.
    const spawnReq = fakes.plugcli!.spawnRequests.find((r) => r.model === session.model);
    expect(spawnReq?.permissionMode).toBe('bypassPermissions');
  });

  it('keeps a permission mode the worker provider DOES support', async () => {
    const { orchestrator } = createTeam('claude');
    const res = await spawnWorker(orchestrator.id, {
      prompt: 'go',
      provider: 'plugcli',
      permissionMode: 'default',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { session: SessionView }).session.permissionMode).toBe('default');
  });

  it('carries the provider across a session restart', async () => {
    // Regression: `restartSession` rebuilt the WorkerSpec without `provider`,
    // so the restarted worker silently re-resolved to the TEAM default while
    // keeping its old (other-vendor) model id.
    const { orchestrator } = createTeam('claude');
    const res = await spawnWorker(orchestrator.id, {
      prompt: 'go',
      provider: 'plugcli',
      model: 'plug-2',
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };

    const { newSession } = orchestrator.restartSession(session.id);
    expect(newSession.toView().provider).toBe('plugcli');
    expect(newSession.toView().model).toBe('plug-2');
    expect(stack.db.getSession(newSession.id)?.provider).toBe('plugcli');
  });

  it('defaults `role` to the team role and auto-names the worker', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, { prompt: 'go' });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    expect(session.role).toBe('coordinator');
    expect(session.name).toBe('NOMAD-worker-1');
    const second = await spawnWorker(orchestrator.id, { prompt: 'go again' });
    expect(((await second.json()) as { session: SessionView }).session.name).toBe('NOMAD-worker-2');
  });

  it('accepts a per-worker preamble override', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, {
      name: 'SKEPTIC',
      prompt: 'go',
      preamble: 'be relentlessly skeptical',
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionView };
    // The preamble is not a column and not in `SessionView` — the observable is
    // what `Session` handed the adapter in phase A.
    const req = fakes.claude!.configRequests.find((c) => c.sessionId === session.id);
    expect(req?.preamble).toMatch(/relentlessly skeptical/);
  });
});

describe('POST /orchestrators/:id/workers — 400', () => {
  it('rejects a missing prompt', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, { name: 'X' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toMatch(/prompt is required/);
    expect(orchestrator.listSessions().filter((s) => s.type === 'worker')).toHaveLength(0);
  });

  it('rejects an unknown provider id with UNKNOWN_PROVIDER + the known list', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', provider: 'nope' });
    expect(res.status).toBe(400);
    const j = (await res.json()) as ErrorBody;
    expect(j.code).toBe('UNKNOWN_PROVIDER');
    // The operator must learn what they CAN ask for, not just that they were wrong.
    expect(j.known).toContain('claude');
    expect(j.known).toContain('plugcli');
    expect(orchestrator.listSessions().filter((s) => s.type === 'worker')).toHaveLength(0);
  });

  it('rejects an effort outside the whitelist', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', effort: 'turbo' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toMatch(/low\|medium\|high\|xhigh\|max/);
  });

  it('rejects a permissionMode outside the whitelist', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', permissionMode: 'yolo' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toMatch(/permissionMode/);
  });
});

describe('POST /orchestrators/:id/workers — 409 PROVIDER_UNAVAILABLE', () => {
  it('refuses a provider known not to run here, with its reason', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, { prompt: 'go', provider: 'brokencli' });
    expect(res.status).toBe(409);
    const j = (await res.json()) as ErrorBody;
    expect(j.code).toBe('PROVIDER_UNAVAILABLE');
    expect(j.unavailableReason).toMatch(/not on PATH/);
    // …and nothing was spawned.
    expect(orchestrator.listSessions().filter((s) => s.type === 'worker')).toHaveLength(0);
  });
});

describe('POST /orchestrators/:id/workers — 413', () => {
  it('refuses a prompt over the configured cap', async () => {
    const { orchestrator } = createTeam();
    const res = await spawnWorker(orchestrator.id, {
      prompt: 'x'.repeat(stack.config.maxPromptSizeBytes + 1),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error).toMatch(/too large/);
    expect(orchestrator.listSessions().filter((s) => s.type === 'worker')).toHaveLength(0);
  });

  it('counts the preamble in the same envelope as the prompt', async () => {
    const { orchestrator } = createTeam();
    const half = Math.ceil(stack.config.maxPromptSizeBytes / 2) + 1;
    const res = await spawnWorker(orchestrator.id, {
      prompt: 'x'.repeat(half),
      preamble: 'y'.repeat(half),
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /orchestrators/:id/workers — 429', () => {
  it('refuses once the per-team worker cap is reached', async () => {
    const { orchestrator } = createTeam();
    // Mutating the live config is the only seam: `bootTestStack` wipes every
    // SWARM_OS_* env var before `loadConfig()`, and Spawner/Orchestrator hold
    // this exact object. Cap 0 ⇒ the very first worker is over the line.
    stack.config.maxWorkersPerOrch = 0;
    const res = await spawnWorker(orchestrator.id, { prompt: 'go' });
    expect(res.status).toBe(429);
    const j = (await res.json()) as ErrorBody;
    // Same code the MCP tool raises, and the same status team creation uses for
    // `maxOrchestrators`.
    expect(j.code).toBe('MAX_WORKERS_PER_ORCH');
    expect(j.error).toMatch(/max workers per orchestrator/);
    expect(orchestrator.listSessions().filter((s) => s.type === 'worker')).toHaveLength(0);
  });
});
