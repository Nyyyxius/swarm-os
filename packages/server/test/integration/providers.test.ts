/**
 * Multi-provider, Lot 2 — the REST + MCP surface of `provider`.
 *
 * Everything here runs against a SUBSTITUTED provider registry. The built-in
 * one probes the real CLIs on PATH, so its verdicts differ between a dev box
 * (claude installed) and CI (nothing installed) — a test that asserted on it
 * would be green on one and red on the other. The fakes let us assert the
 * plumbing: precedence, validation, persistence, inheritance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { FakeProvider } from '../../src/modules/providers/fake.js';
import { buildPluginApi, type PluginGuard } from '../../src/modules/plugins/api.js';
import {
  DisposableStore,
  type PluginCapability,
} from '../../src/modules/plugins/api-types.js';
import { PluginStore } from '../../src/modules/plugins/store.js';
import { RoleStore } from '../../src/modules/roles/index.js';
import { eventBus } from '../../src/events.js';
import { withModule } from '../../src/logger.js';

let stack: TestStack;

/**
 * claude (available, the instance default), `brokencli` (a CLI we know is not
 * usable) and `plugcli` (available, NOT built-in — a plugin-provided adapter).
 *
 * `binary: 'sh'` on the ones a test actually spawns: `POST /orchestrators` runs
 * a real PTY, and a non-existent binary would land the lead in `failed` before
 * we could assert on the row it wrote.
 */
function fakeRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(new FakeProvider({ id: 'claude', label: 'Claude Code', binary: 'sh' }), {
    builtin: true,
  });
  r.register(
    new FakeProvider({
      id: 'brokencli',
      label: 'Broken CLI',
      binary: 'brokencli',
      probe: async () => ({ available: false, reason: '`brokencli` is not on PATH' }),
    }),
    { builtin: true },
  );
  r.register(
    new FakeProvider({
      id: 'plugcli',
      label: 'Plugin CLI',
      binary: 'sh',
      capabilities: { effort: false, notificationHook: false },
      probe: async () => ({ available: true, version: 'plugcli 9.9.9' }),
    }),
  );
  // A provider whose callback fires at every TURN BOUNDARY (codex `notify`,
  // gemini `AfterAgent`) rather than when a human is needed. It exists here so
  // `GET /providers` can be asserted to report it as "never reports waiting".
  r.register(
    new FakeProvider({
      id: 'turncli',
      label: 'Turn CLI',
      binary: 'sh',
      capabilities: { notificationHook: 'turn-complete' },
      probe: async () => ({ available: true }),
    }),
    { builtin: true },
  );
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

async function post(p: string, body: unknown): Promise<Response> {
  return await fetch(url(p), {
    method: 'POST',
    headers: { ...authHeaders(stack.config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface ProvidersBody {
  defaultProvider: string;
  defaultEffort: string;
  defaultPermissionMode: string;
  transport: string;
  providers: Array<{
    id: string;
    label: string;
    binary: string;
    builtin: boolean;
    available: boolean;
    unavailableReason?: string;
    version?: string;
    models: Array<{ value: string; label: string }>;
    capabilities: Record<string, unknown>;
    defaults: { model: string; effort: string; permissionMode: string };
  }>;
}

describe('GET /providers', () => {
  it('requires the auth token', async () => {
    const res = await fetch(url('/providers'));
    expect(res.status).toBe(401);
  });

  it('returns the catalogue, the server default and the transport', async () => {
    const res = await fetch(url('/providers'), { headers: authHeaders(stack.config.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvidersBody;
    // This is what kills the four hard-coded model lists in the web bundle and
    // what `/info` never exposed: the server's own defaults.
    expect(body.defaultProvider).toBe('claude');
    expect(body.transport).toBe('local');
    expect(body.providers.map((p) => p.id)).toEqual([
      'claude',
      'brokencli',
      'plugcli',
      'turncli',
    ]);

    const claude = body.providers[0]!;
    expect(claude).toMatchObject({
      id: 'claude',
      label: 'Claude Code',
      binary: 'sh',
      builtin: true,
      available: true,
    });
    expect(claude.models.length).toBeGreaterThan(0);
    expect(claude.models[0]).toHaveProperty('value');
    expect(claude.models[0]).toHaveProperty('label');
    expect(claude.defaults).toEqual({
      model: 'fake-model',
      effort: 'low',
      permissionMode: 'bypassPermissions',
    });
    // Capabilities drive which controls the UI may show at all.
    expect(claude.capabilities).toEqual({
      effort: true,
      permissionModes: ['bypassPermissions', 'default'],
      fallbackPermissionMode: 'bypassPermissions',
      // Boolean = "will a session of this provider ever report `waiting`?", i.e.
      // does its callback mean a human is needed. NOT a cast of the server-side
      // field, which is a three-valued semantic since Lot 9a.
      notificationHook: true,
      notificationSemantics: 'needs-human',
      inkSubmitDance: true,
      durablePreamble: true,
      httpMcp: true,
    });
  });

  it('carries the instance defaults so the UI can NAME what "(inherit)" means', () => {
    // The complaint this route's header levels at `/info`: a dialog that offers
    // "(inherit the global default)" could show the option and not the value.
    // These are exactly what `POST /orchestrators` resolves to when neither the
    // body nor the role names one.
    const body = async (): Promise<ProvidersBody> =>
      (await (
        await fetch(url('/providers'), { headers: authHeaders(stack.config.token) })
      ).json()) as ProvidersBody;
    return body().then((b) => {
      expect(b.defaultProvider).toBe(stack.config.defaultProvider);
      expect(b.defaultEffort).toBe(stack.config.defaultEffort);
      expect(b.defaultPermissionMode).toBe(stack.config.defaultPermissionMode);
      // `defaultModel` is deliberately absent: it is a claude id, and the answer
      // for a team on another provider is that PROVIDER's own `defaults.model`
      // (carried per provider), never a global.
      expect(b).not.toHaveProperty('defaultModel');
    });
  });

  it('reports a turn-complete provider as NOT reporting waiting', async () => {
    // codex `notify` and gemini `AfterAgent` fire at every turn boundary, so
    // `/hooks/notification` never flips their badge — the boolean has to say so or
    // the UI promises a `waiting` state that cannot happen. The full semantic is
    // carried alongside for a UI that wants to word it precisely.
    const res = await fetch(url('/providers'), { headers: authHeaders(stack.config.token) });
    const body = (await res.json()) as ProvidersBody;
    const turn = body.providers.find((p) => p.id === 'turncli')!;
    expect(turn.capabilities.notificationHook).toBe(false);
    expect(turn.capabilities.notificationSemantics).toBe('turn-complete');
  });

  it('lists an unusable provider WITH its reason rather than hiding it', async () => {
    // A missing option teaches the operator nothing. A disabled one saying
    // "not on PATH" tells them exactly what to do.
    const res = await fetch(url('/providers'), { headers: authHeaders(stack.config.token) });
    const body = (await res.json()) as ProvidersBody;
    const broken = body.providers.find((p) => p.id === 'brokencli')!;
    expect(broken.available).toBe(false);
    expect(broken.unavailableReason).toMatch(/not on PATH/);
    expect(broken.version).toBeUndefined();
  });

  it('flags plugin-provided adapters as non-builtin and carries their version', async () => {
    const res = await fetch(url('/providers'), { headers: authHeaders(stack.config.token) });
    const body = (await res.json()) as ProvidersBody;
    const plug = body.providers.find((p) => p.id === 'plugcli')!;
    expect(plug.builtin).toBe(false);
    expect(plug.available).toBe(true);
    expect(plug.version).toBe('plugcli 9.9.9');
    expect(plug.capabilities.effort).toBe(false);
    expect(plug.capabilities.notificationHook).toBe(false);
  });

  it('answers a cold call quickly (no probe may block the request path)', async () => {
    const t0 = Date.now();
    const res = await fetch(url('/providers'), { headers: authHeaders(stack.config.token) });
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3_500);
  });
});

describe('POST /orchestrators — provider selection', () => {
  const base = {
    name: 'prov-team',
    role: 'coordinator',
    lead: { prompt: 'noop' },
  };

  function body(extra: Record<string, unknown>): Record<string, unknown> {
    return { ...base, lead: { ...base.lead, cwd: stack.workspaceRoot }, ...extra };
  }

  it('rejects an unknown provider id with 400 UNKNOWN_PROVIDER', async () => {
    const res = await post('/orchestrators', body({ defaults: { provider: 'nope' } }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { code: string; known: string[] };
    expect(j.code).toBe('UNKNOWN_PROVIDER');
    expect(j.known).toContain('claude');
  });

  it('refuses a provider known to be unavailable with 409 + the reason', async () => {
    const res = await post('/orchestrators', body({ defaults: { provider: 'brokencli' } }));
    expect(res.status).toBe(409);
    const j = (await res.json()) as { code: string; unavailableReason: string };
    expect(j.code).toBe('PROVIDER_UNAVAILABLE');
    expect(j.unavailableReason).toMatch(/not on PATH/);
    // …and nothing was created.
    const list = await fetch(url('/orchestrators'), { headers: authHeaders(stack.config.token) });
    const teams = (await list.json()) as { orchestrators: Array<{ name: string }> };
    expect(teams.orchestrators.find((o) => o.name === 'prov-team')).toBeUndefined();
  });

  it('accepts an explicit provider and stamps it on the team AND the lead session', async () => {
    const res = await post('/orchestrators', body({ defaults: { provider: 'plugcli' } }));
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      orchestrator: { id: string; defaultProvider: string; defaultModel: string };
      lead: { id: string; provider: string; model: string };
    };
    expect(j.orchestrator.defaultProvider).toBe('plugcli');
    expect(j.lead.provider).toBe('plugcli');
    // No model was named anywhere ⇒ the PROVIDER's default, never
    // `config.defaultModel` (a claude id a foreign CLI has never heard of).
    expect(j.orchestrator.defaultModel).toBe('fake-model');
    expect(j.lead.model).toBe('fake-model');

    // Persisted, both rows.
    const orchRow = stack.db.getOrchestrator(j.orchestrator.id);
    expect(orchRow?.default_provider).toBe('plugcli');
    expect(stack.db.getSession(j.lead.id)?.provider).toBe('plugcli');
  });

  it('keeps an explicit model when one is given', async () => {
    const res = await post(
      '/orchestrators',
      body({ defaults: { provider: 'plugcli', model: 'some-brand-new-model-id' } }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as { orchestrator: { defaultModel: string } };
    // The model string is deliberately NOT validated — ids ship faster than we
    // release, and rejecting a valid one is the worse failure.
    expect(j.orchestrator.defaultModel).toBe('some-brand-new-model-id');
  });

  it('defaults to the server provider when the request names none', async () => {
    const res = await post('/orchestrators', body({}));
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      orchestrator: { defaultProvider: string; defaultModel: string };
    };
    expect(j.orchestrator.defaultProvider).toBe('claude');
    // Provider === the instance default ⇒ `config.defaultModel` still applies,
    // exactly as before this lot.
    expect(j.orchestrator.defaultModel).toBe(stack.config.defaultModel);
  });

  it('drops a ROLE model when the body switches provider (HIGH 1)', async () => {
    // The role shape every deployment already has on disk: a `defaultModel`
    // written before providers existed, and therefore NO `defaultProvider`.
    //
    // The old guard asked "did anyone name a model?" and this role answered yes,
    // so the claude id survived the switch and the team was created as
    // `plugcli -m claude-opus-4-8` — a lead that dies inside its own PTY with a
    // vendor error while the UI reports `running`. The question that matters is
    // not whether a model was named, it is WHICH PROVIDER named it.
    const roleRes = await post('/roles', {
      label: 'Legacy role',
      leadPrompt: 'from the role',
      defaultModel: 'claude-opus-4-8',
    });
    expect(roleRes.status).toBe(201);
    const roleId = ((await roleRes.json()) as { role: { id: string } }).role.id;

    const res = await post(
      '/orchestrators',
      body({ roleId, defaults: { provider: 'plugcli' } }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      orchestrator: { defaultProvider: string; defaultModel: string };
      lead: { provider: string; model: string };
    };
    expect(j.orchestrator.defaultProvider).toBe('plugcli');
    expect(j.orchestrator.defaultModel).toBe('fake-model');
    expect(j.orchestrator.defaultModel).not.toBe('claude-opus-4-8');
    // …and the lead, which is what actually gets exec'd.
    expect(j.lead.provider).toBe('plugcli');
    expect(j.lead.model).toBe('fake-model');
  });

  it('keeps the ROLE model when the role named that same provider', async () => {
    // The other half of the rule: scoping must not throw away a deliberate
    // pairing. A role that says "plugcli, and this model" is coherent.
    const roleRes = await post('/roles', {
      label: 'Coherent role',
      leadPrompt: 'from the role',
      defaultProvider: 'plugcli',
      defaultModel: 'plug-model-42',
    });
    const roleId = ((await roleRes.json()) as { role: { id: string } }).role.id;

    const res = await post('/orchestrators', body({ roleId }));
    expect(res.status).toBe(201);
    const j = (await res.json()) as { orchestrator: { defaultModel: string } };
    expect(j.orchestrator.defaultModel).toBe('plug-model-42');
  });

  it('coerces a permission mode the provider cannot express (MEDIUM 3)', async () => {
    // `plugcli` accepts [bypassPermissions, default] — like codex/gemini/
    // opencode, which accept exactly one. Asking for `plan` used to STORE,
    // PERSIST and DISPLAY `plan` on a team running with approvals bypassed: an
    // operator reading the panel believed an agent was planning while it wrote
    // unsupervised. The only coercion in the product was in the browser, so any
    // API caller bypassed it entirely.
    const res = await post(
      '/orchestrators',
      body({ defaults: { provider: 'plugcli', permissionMode: 'plan' } }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      orchestrator: { id: string; defaultPermissionMode: string };
      lead: { id: string; permissionMode: string };
    };
    expect(j.orchestrator.defaultPermissionMode).toBe('bypassPermissions');
    expect(j.lead.permissionMode).toBe('bypassPermissions');
    // Persisted as coerced too — a resume must not resurrect the lie.
    expect(stack.db.getOrchestrator(j.orchestrator.id)?.default_permission_mode).toBe(
      'bypassPermissions',
    );
    expect(stack.db.getSession(j.lead.id)?.permission_mode).toBe('bypassPermissions');
  });

  it('leaves a permission mode the provider DOES support alone', async () => {
    const res = await post(
      '/orchestrators',
      body({ defaults: { provider: 'plugcli', permissionMode: 'default' } }),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as { orchestrator: { defaultPermissionMode: string } };
    expect(j.orchestrator.defaultPermissionMode).toBe('default');
  });
});

describe('roles — defaultProvider', () => {
  async function createRole(payload: Record<string, unknown>): Promise<{ id: string }> {
    const res = await post('/roles', payload);
    expect(res.status).toBe(201);
    const j = (await res.json()) as { role: { id: string } };
    return j.role;
  }

  it('round-trips a nullable defaultProvider through create / patch', async () => {
    const role = await createRole({ label: 'Plug team', defaultProvider: 'plugcli' });
    const read = await fetch(url(`/roles/${role.id}`), {
      headers: authHeaders(stack.config.token),
    });
    expect(((await read.json()) as { role: { defaultProvider: string } }).role.defaultProvider).toBe(
      'plugcli',
    );

    const patched = await fetch(url(`/roles/${role.id}`), {
      method: 'PATCH',
      headers: { ...authHeaders(stack.config.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultProvider: null }),
    });
    expect(patched.status).toBe(200);
    const j = (await patched.json()) as { role: { defaultProvider: string | null } };
    // NULL = inherit, same convention as defaultModel.
    expect(j.role.defaultProvider).toBeNull();
  });

  it('rejects an unknown provider id on create — 400 UNKNOWN_PROVIDER', async () => {
    // Lot 9a. `POST /orchestrators` already validated this, but that is the wrong
    // place to LEARN about a typo: the operator is then in a different dialog,
    // days later, and the error names a provider they cannot see in the form they
    // are looking at. `defaultEffort` and `defaultPermissionMode` have always been
    // validated here for the same reason.
    const res = await post('/roles', { label: 'Typo team', defaultProvider: 'gemnii' });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { code: string; known: string[] };
    expect(j.code).toBe('UNKNOWN_PROVIDER');
    // The caller must learn what it COULD have asked for.
    expect(j.known).toContain('claude');
    // …and nothing was stored.
    const list = await fetch(url('/roles'), { headers: authHeaders(stack.config.token) });
    const roles = (await list.json()) as { roles: Array<{ label: string }> };
    expect(roles.roles.find((r) => r.label === 'Typo team')).toBeUndefined();
  });

  it('rejects an unknown provider id on patch, and keeps the stored value', async () => {
    const role = await createRole({ label: 'Plug team', defaultProvider: 'plugcli' });
    const res = await fetch(url(`/roles/${role.id}`), {
      method: 'PATCH',
      headers: { ...authHeaders(stack.config.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultProvider: 'gemnii' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('UNKNOWN_PROVIDER');
    const read = await fetch(url(`/roles/${role.id}`), {
      headers: authHeaders(stack.config.token),
    });
    expect(
      ((await read.json()) as { role: { defaultProvider: string } }).role.defaultProvider,
    ).toBe('plugcli');
  });

  it('still accepts null (= inherit) and does NOT validate the model string', async () => {
    // The model is deliberately never validated — ids ship far faster than our
    // releases, and rejecting a valid one is the worse failure. Only the provider
    // ID, which addresses an adapter we either have or do not, is checked.
    const res = await post('/roles', {
      label: 'Inherit team',
      defaultProvider: null,
      defaultModel: 'some-model-that-does-not-exist-yet',
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      role: { defaultProvider: string | null; defaultModel: string };
    };
    expect(j.role.defaultProvider).toBeNull();
    expect(j.role.defaultModel).toBe('some-model-that-does-not-exist-yet');
  });

  it('is inherited by a team created from the role', async () => {
    const role = await createRole({
      label: 'Plug team',
      leadPrompt: 'from the role',
      defaultProvider: 'plugcli',
    });
    const res = await post('/orchestrators', {
      name: 'role-team',
      roleId: role.id,
      lead: { cwd: stack.workspaceRoot },
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      orchestrator: { defaultProvider: string };
      lead: { provider: string };
    };
    expect(j.orchestrator.defaultProvider).toBe('plugcli');
    expect(j.lead.provider).toBe('plugcli');
  });

  it('is overridden by an explicit body provider (body > role > config)', async () => {
    const role = await createRole({
      label: 'Plug team',
      leadPrompt: 'from the role',
      defaultProvider: 'plugcli',
    });
    const res = await post('/orchestrators', {
      name: 'override-team',
      roleId: role.id,
      lead: { cwd: stack.workspaceRoot },
      defaults: { provider: 'claude' },
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { orchestrator: { defaultProvider: string } };
    expect(j.orchestrator.defaultProvider).toBe('claude');
  });
});

describe('team.spawn_worker — per-agent provider', () => {
  function createOrch(defaultProvider?: string) {
    const { orchestrator, lead } = stack.spawner.create(
      {
        name: 'mixed-team',
        role: 'coordinator',
        defaultModel: stack.config.defaultModel,
        defaultEffort: stack.config.defaultEffort,
        defaultPermissionMode: stack.config.defaultPermissionMode,
        ...(defaultProvider ? { defaultProvider } : {}),
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
      },
      { skipSpawn: true },
    );
    return { orchestrator, lead };
  }

  async function leadClient(orchId: string, secret: string): Promise<Client> {
    const t = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`),
    );
    const c = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await c.connect(t);
    return c;
  }

  interface SpawnResult {
    structuredContent?: {
      session?: { id: string; provider?: string; permissionMode?: string; model?: string };
    };
    /** The SDK reports a tool-level McpError as an isError payload, not a reject. */
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  }

  function errorText(res: SpawnResult): string {
    expect(res.isError).toBe(true);
    return (res.content ?? []).map((c) => c.text ?? '').join('\n');
  }

  it('inherits the team provider when `provider` is omitted', async () => {
    const { orchestrator, lead } = createOrch('plugcli');
    const client = await leadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: { name: 'w1', role: 'scout', prompt: 'noop' },
      })) as SpawnResult;
      expect(res.structuredContent?.session?.provider).toBe('plugcli');
    } finally {
      await client.close();
    }
  });

  it('honours an explicit provider — this is how a lead builds a mixed team', async () => {
    const { orchestrator, lead } = createOrch('claude');
    const client = await leadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: { name: 'w2', role: 'scout', prompt: 'noop', provider: 'plugcli' },
      })) as SpawnResult;
      const sessionId = res.structuredContent?.session?.id;
      expect(res.structuredContent?.session?.provider).toBe('plugcli');
      // The lead stays on its own provider: mixed, not converted.
      expect(orchestrator.lead?.toView().provider).toBe('claude');
      expect(stack.db.getSession(sessionId!)?.provider).toBe('plugcli');
    } finally {
      await client.close();
    }
  });

  it('rejects an unknown provider id with INVALID_PARAMS', async () => {
    const { orchestrator, lead } = createOrch('claude');
    const client = await leadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: { name: 'w3', role: 'scout', prompt: 'noop', provider: 'ghost' },
      })) as SpawnResult;
      expect(errorText(res)).toMatch(/UNKNOWN_PROVIDER/);
      // The lead must learn what it CAN ask for, not just that it was wrong.
      expect(errorText(res)).toMatch(/claude/);
      expect(orchestrator.listSessions().find((s) => s.name === 'w3')).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('refuses a provider known to be unavailable', async () => {
    const { orchestrator, lead } = createOrch('claude');
    const client = await leadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: { name: 'w4', role: 'scout', prompt: 'noop', provider: 'brokencli' },
      })) as SpawnResult;
      expect(errorText(res)).toMatch(/PROVIDER_UNAVAILABLE/);
      expect(errorText(res)).toMatch(/not on PATH/);
      expect(orchestrator.listSessions().find((s) => s.name === 'w4')).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('rejects an EMPTY model string, exactly like its HTTP twin (MEDIUM 4)', async () => {
    // `z.string().optional()` accepts `""`, and `??` inheritance does not treat
    // it as absent — so the empty string reached the argv as `--model ''` and
    // the CLI died in its own PTY. `POST /orchestrators/:id/workers` has always
    // answered 400 here; the two channels must not disagree.
    const { orchestrator, lead } = createOrch('claude');
    const client = await leadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: { name: 'w5', role: 'scout', prompt: 'noop', model: '' },
      })) as SpawnResult;
      expect(errorText(res)).toMatch(/INVALID_MODEL/);
      expect(orchestrator.listSessions().find((s) => s.name === 'w5')).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('coerces a permission mode the worker provider cannot express (MEDIUM 3)', async () => {
    const { orchestrator, lead } = createOrch('claude');
    const client = await leadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: {
          name: 'w6',
          role: 'scout',
          prompt: 'noop',
          provider: 'plugcli',
          permissionMode: 'plan',
        },
      })) as SpawnResult;
      const session = res.structuredContent?.session;
      expect(session?.provider).toBe('plugcli');
      // What the tool RETURNS to the lead is what the worker actually runs.
      expect(session?.permissionMode).toBe('bypassPermissions');
      expect(stack.db.getSession(session!.id)?.permission_mode).toBe('bypassPermissions');
    } finally {
      await client.close();
    }
  });
});

/**
 * A divergence between two creation channels IS a bug, even when each channel
 * is individually defensible: the operator's mental model is "this is the same
 * team, made two ways". These drive the same inputs through all four and assert
 * the SAME resolved triple — so a future change to one of them cannot quietly
 * become a change to only one of them.
 */
describe('every creation channel resolves identically', () => {
  interface Triple {
    model: string;
    effort: string;
    permissionMode: string;
  }

  /** claude team, cross-provider agent, no model, a mode plugcli cannot express. */
  const ASK = { provider: 'plugcli', permissionMode: 'plan' } as const;
  /** plugcli's own defaults, with `plan` coerced onto its fallback. */
  const EXPECTED: Triple = {
    model: 'fake-model',
    effort: 'low',
    permissionMode: 'bypassPermissions',
  };

  /** Session-shaped view → the triple under comparison. */
  function triple(v: Triple): Triple {
    return { model: v.model, effort: v.effort, permissionMode: v.permissionMode };
  }

  /** Team-shaped view → the same triple (the fields are prefixed `default*`). */
  function teamTriple(v: {
    defaultModel: string;
    defaultEffort: string;
    defaultPermissionMode: string;
  }): Triple {
    return {
      model: v.defaultModel,
      effort: v.defaultEffort,
      permissionMode: v.defaultPermissionMode,
    };
  }

  async function mcpLeadClient(orchId: string, secret: string): Promise<Client> {
    const t = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${stack.config.mcpPort}/mcp/${orchId}/${secret}`),
    );
    const c = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await c.connect(t);
    return c;
  }

  it('channel 1 — POST /orchestrators (the team + its lead)', async () => {
    const res = await post('/orchestrators', {
      name: 'chan-1',
      role: 'coordinator',
      lead: { cwd: stack.workspaceRoot, prompt: 'noop' },
      defaults: ASK,
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as {
      orchestrator: { defaultModel: string; defaultEffort: string; defaultPermissionMode: string };
      lead: Triple;
    };
    expect(triple(j.lead)).toEqual(EXPECTED);
    // …and the team card shows what the lead runs, not what was asked for.
    expect(teamTriple(j.orchestrator)).toEqual(EXPECTED);
  });

  it('channel 2 — POST /orchestrators/:id/workers', async () => {
    const create = await post('/orchestrators', {
      name: 'chan-2',
      role: 'coordinator',
      lead: { cwd: stack.workspaceRoot, prompt: 'noop' },
    });
    const orchId = ((await create.json()) as { orchestrator: { id: string } }).orchestrator.id;
    const res = await post(`/orchestrators/${orchId}/workers`, { prompt: 'noop', ...ASK });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: Triple };
    expect(triple(session)).toEqual(EXPECTED);
  });

  it('channel 3 — MCP team.spawn_worker', async () => {
    const { orchestrator, lead } = stack.spawner.create(
      {
        name: 'chan-3-team',
        role: 'coordinator',
        defaultModel: stack.config.defaultModel,
        defaultEffort: stack.config.defaultEffort,
        defaultPermissionMode: stack.config.defaultPermissionMode,
        defaultProvider: 'claude',
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
      },
      { skipSpawn: true },
    );
    const client = await mcpLeadClient(orchestrator.id, lead.sessionSecret);
    try {
      const res = (await client.callTool({
        name: 'team.spawn_worker',
        arguments: { name: 'chan-3', role: 'scout', prompt: 'noop', ...ASK },
      })) as { structuredContent?: { session?: Triple } };
      expect(triple(res.structuredContent!.session!)).toEqual(EXPECTED);
    } finally {
      await client.close();
    }
  });

  it('channel 4 — the plugin API `teams.create`', async () => {
    // Not in the reviewer's list, and it carried the SAME defect plus one of its
    // own: it read the role's MODEL while ignoring the role's PROVIDER outright,
    // so a `defaultProvider: plugcli` role produced a CLAUDE team running a
    // plugcli model id — wrong in both directions at once.
    const roleRes = await post('/roles', {
      label: 'Plug role',
      leadPrompt: 'noop',
      defaultProvider: 'plugcli',
      defaultPermissionMode: 'plan',
    });
    expect(roleRes.status).toBe(201);
    const roleId = ((await roleRes.json()) as { role: { id: string } }).role.id;

    const api = buildPluginApi(
      {
        store: new PluginStore(stack.db),
        eventBus,
        log: withModule('test.providers'),
        zod: z,
        granted: new Set<PluginCapability>(['teams']),
        guard: (<A extends unknown[]>(_hook: string, fn: (...a: A) => unknown) =>
          (...a: A): unknown =>
            fn(...a)) as PluginGuard,
        currentEpoch: () => 0,
        onConfigChange: [],
        spawner: stack.spawner,
        roleStore: new RoleStore(stack.db),
        config: stack.config,
      },
      'test-plugin',
      new DisposableStore(),
      0,
    );
    const { id } = await api.teams.create({
      name: 'chan-4',
      roleId,
      cwd: stack.workspaceRoot,
      prompt: 'noop',
    });
    const orch = stack.spawner.get(id)!.toView();
    expect(orch.defaultProvider).toBe('plugcli');
    expect(teamTriple(orch)).toEqual(EXPECTED);
  });
});
