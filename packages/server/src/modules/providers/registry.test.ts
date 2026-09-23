import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from './registry.js';
import { bindModelCatalogue, createBuiltinProviderRegistry } from './index.js';
import { CLAUDE_PROVIDER } from './claude.js';
import { ModelCatalogue } from './catalogue.js';
import { MODELS_DEV_FIXTURE } from './catalogue.fixture.js';
import { FakeProvider } from './fake.js';
import { BUILTIN_PROVIDER_DEFAULT_MODELS, type BuiltinProviderId } from './ids.js';
import { IDENTITY_PATH_MAPPER } from './types.js';

/**
 * Mirror of `connector-registry.test.ts`: the registry is a lookup table whose
 * built-in entries cannot be shadowed, plus two capability gates that exist
 * because the failure they prevent is silent (an agent with tools and no role
 * looks alive and behaves at random).
 */

describe('ProviderRegistry — registration', () => {
  it('exposes a registered provider through get / has / list / types', () => {
    const r = new ProviderRegistry();
    const fake = new FakeProvider();
    r.register(fake);
    expect(r.has('fake')).toBe(true);
    expect(r.get('fake')).toBe(fake);
    expect(r.list()).toEqual([fake]);
    expect(r.types()).toEqual([
      { id: 'fake', label: 'Fake Provider', binary: 'fake-agent', builtin: false },
    ]);
  });

  it('returns null / false for an unknown id', () => {
    const r = new ProviderRegistry();
    expect(r.get('nope')).toBeNull();
    expect(r.has('nope')).toBe(false);
  });

  it('refuses to shadow a built-in adapter', () => {
    const r = createBuiltinProviderRegistry();
    expect(() => r.register(new FakeProvider({ id: 'claude' }))).toThrow(
      /reserved by a built-in/,
    );
    // …and the built-in is still the one that answers.
    expect(r.get('claude')).toBe(CLAUDE_PROVIDER);
  });

  it('lets a non-built-in be replaced, and dispose only removes its own entry', () => {
    const r = new ProviderRegistry();
    const first = new FakeProvider({ label: 'first' });
    const second = new FakeProvider({ label: 'second' });
    const disposeFirst = r.register(first);
    r.register(second);
    expect(r.get('fake')).toBe(second);
    // The stale disposable must not evict the replacement.
    disposeFirst.dispose();
    expect(r.get('fake')).toBe(second);
  });

  it('dispose removes the provider it registered', () => {
    const r = new ProviderRegistry();
    const d = r.register(new FakeProvider());
    d.dispose();
    expect(r.has('fake')).toBe(false);
    expect(r.list()).toEqual([]);
  });
});

describe('ProviderRegistry — capability gates', () => {
  it('refuses a provider whose preamble does not survive a context reset', () => {
    const r = new ProviderRegistry();
    expect(() =>
      r.register(new FakeProvider({ capabilities: { durablePreamble: false } })),
    ).toThrow(/durable preamble/);
    expect(r.has('fake')).toBe(false);
  });

  it('refuses a provider that cannot reach the team-comms MCP over HTTP', () => {
    const r = new ProviderRegistry();
    expect(() => r.register(new FakeProvider({ capabilities: { httpMcp: false } }))).toThrow(
      /team-comms MCP/,
    );
    expect(r.has('fake')).toBe(false);
  });

  it('refuses an empty permissionModes — "no vocabulary" is spelled [fallback]', () => {
    // Lot 9a settled the ambiguity: an empty array and a one-element array were
    // both plausible for a CLI with no permission-mode vocabulary, and every
    // consumer had to handle both. The rule is now "never empty, always contains
    // the fallback, `length === 1` means not-a-choice" — enforced here so a plugin
    // cannot reintroduce the second shape.
    const r = new ProviderRegistry();
    expect(() =>
      r.register(new FakeProvider({ capabilities: { permissionModes: [] } })),
    ).toThrow(/no permission mode/);
    expect(r.has('fake')).toBe(false);
  });

  it('refuses a fallbackPermissionMode outside permissionModes', () => {
    // The coercion target has to be a mode the CLI accepts, or coercing produces
    // an argv the CLI rejects — at spawn time, in a session log nobody is reading.
    const r = new ProviderRegistry();
    expect(() =>
      r.register(
        new FakeProvider({
          capabilities: { permissionModes: ['plan'], fallbackPermissionMode: 'default' },
        }),
      ),
    ).toThrow(/outside its permissionModes/);
    expect(r.has('fake')).toBe(false);
  });
});

describe('createBuiltinProviderRegistry', () => {
  it('ships the four built-ins, claude first and all flagged built-in', () => {
    const r = createBuiltinProviderRegistry();
    expect(r.types()).toEqual([
      { id: 'claude', label: 'Claude Code', binary: 'claude', builtin: true },
      { id: 'codex', label: 'OpenAI Codex', binary: 'codex', builtin: true },
      { id: 'gemini', label: 'Gemini CLI', binary: 'gemini', builtin: true },
      { id: 'opencode', label: 'OpenCode (OpenRouter)', binary: 'opencode', builtin: true },
    ]);
    expect(r.get('claude')).toBe(CLAUDE_PROVIDER);
  });

  it('has every built-in satisfy the adapter contract, whatever is installed', () => {
    // REWRITTEN in Lot 9a. This used to assert `available: false` +
    // `/not implemented yet/` on codex/gemini/opencode, which was true of the
    // Lot 2 stubs and became false the moment the real adapters landed — and it
    // did so ENVIRONMENT-DEPENDENTLY: `codex --version` and `gemini --version`
    // answer on the dev host and not in CI, so the old test was red here and
    // green there. Availability is a property of the machine, not of the code, so
    // it is asserted in `availability.test.ts` against injected probes and never
    // here.
    //
    // What IS the code's business, and what this now freezes: every built-in
    // declares its capabilities, refuses to build an argv without a config dir,
    // and maps the context-reset commands to something.
    const r = createBuiltinProviderRegistry();
    for (const id of ['claude', 'codex', 'gemini', 'opencode'] as BuiltinProviderId[]) {
      const p = r.get(id)!;
      expect(p.id).toBe(id);
      expect(p.binary.length).toBeGreaterThan(0);
      // The two MANDATORY capabilities. The registry refuses to register an
      // adapter without them (see the gates above), so a built-in that lost one
      // would not be here at all — assert it anyway: this is the invariant plan
      // Risks 1 and 2 are about.
      expect(p.capabilities.durablePreamble).toBe(true);
      expect(p.capabilities.httpMcp).toBe(true);
      // `permissionModes` invariants (settled in Lot 9a — see
      // `ProviderCapabilities.permissionModes`): never empty, and it contains the
      // coercion target.
      expect(p.capabilities.permissionModes.length).toBeGreaterThan(0);
      expect(p.capabilities.permissionModes).toContain(
        p.capabilities.fallbackPermissionMode,
      );
      // The notification semantic is one of the three known values — a boolean
      // here would mean somebody re-introduced the ambiguity that made codex and
      // gemini fire a Discord alert per turn.
      expect([false, 'needs-human', 'turn-complete']).toContain(
        p.capabilities.notificationHook,
      );
      // A model catalogue and a coherent default (the UI's "(inherit)" needs it).
      expect(p.models().length).toBeGreaterThan(0);
      const d = p.defaults();
      expect(d.model.length).toBeGreaterThan(0);
      expect(p.capabilities.permissionModes).toContain(d.permissionMode);
      // THE invariant that still holds once a live catalogue can move a default
      // forward: whatever `defaults()` names, `models()` offers.
      //
      // This used to read `d.model === BUILTIN_PROVIDER_DEFAULT_MODELS[id]`,
      // guarding a drift that mattered when both sides were literals. It cannot
      // be that any more — `providers/catalogue.ts` exists precisely to make the
      // adapter's default outrun the pin on a running instance — and leaving it
      // would have been worse than deleting it: no test stack binds a catalogue,
      // so it would have stayed GREEN while the property it names was false in
      // production. A green test for a dead invariant is a liability.
      //
      // What replaces it is checked in two places: the pin/config coherence for
      // `SWARM_OS_DEFAULT_PROVIDER=<id>` with no model is asserted in
      // `config.test.ts` against `ids.ts` directly (no adapter involved), and the
      // "a bound catalogue MAY move this" case is the next test down.
      expect(p.models().map((m) => m.value)).toContain(d.model);
      // Unbound (the state of every test), the default IS still the pin — which
      // is what lets `codex.test.ts` &co. assert exact ids without knowing the
      // catalogue exists.
      expect(d.model).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS[id]);
      // Both reset commands map to a line or to an explicit `null` (= "no working
      // reset"); never to an empty string, which would submit a blank prompt.
      for (const cmd of ['/clear', '/compact'] as const) {
        const line = p.contextResetLine(cmd);
        expect(line === null || line.length > 0).toBe(true);
      }
    }
  });

  it('lets a BOUND catalogue move a default off its pin, and keeps it inside models()', async () => {
    // The companion to the invariant above, and the thing the old
    // `defaults().model === pin` assertion would have hidden: with a live
    // catalogue the two are ALLOWED to diverge — that divergence is the whole
    // feature — but `defaults().model ∈ models()` must survive it, or the UI
    // renders "not in catalogue" (`ProviderFields.tsx:298`) against the value it
    // has just pre-filled for the operator.
    const registry = createBuiltinProviderRegistry();
    // A payload carrying an opus NEWER than whatever `ids.ts` currently pins, so
    // the divergence is structural rather than a coincidence of today's pins:
    // `pnpm models:sync` keeps the pin converging on the newest real id, and an
    // assertion built on `MODELS_DEV_FIXTURE` would quietly stop testing
    // anything the moment the two met.
    const ahead = {
      anthropic: {
        models: {
          'claude-opus-6': {
            id: 'claude-opus-6',
            name: 'Claude Opus 6',
            release_date: '2099-01-01',
            tool_call: true,
            modalities: { input: ['text'], output: ['text'] },
            cost: { input: 5, output: 25 },
          },
          ...(MODELS_DEV_FIXTURE.anthropic as { models: Record<string, unknown> }).models,
        },
      },
    };
    const catalogue = new ModelCatalogue({
      env: {},
      fetchImpl: (async () =>
        new Response(JSON.stringify(ahead), { status: 200 })) as unknown as typeof fetch,
    });
    // `CLAUDE_PROVIDER` is a module-level singleton shared by every registry
    // (`index.ts:69`), so this binding is global to the test file and MUST be
    // undone — otherwise the next test in this file reads a live default.
    expect(bindModelCatalogue(registry, catalogue)).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
    ]);
    try {
      await catalogue.resolve(1_000);
      const claude = registry.get('claude')!;
      // claude's default is an ALIAS (docs/model-aliases.md): it stays `opus`
      // on the stored side and only the spawn-time resolution moves.
      expect(claude.defaults().model).toBe('opus');
      expect(claude.resolveModel?.('opus')).toBe('claude-opus-6');
      expect(claude.resolveModel?.('opus[1m]')).toBe('claude-opus-6[1m]');
      expect(claude.models().map((m) => m.value)).toContain(claude.defaults().model);
      expect(claude.models().find((m) => m.value === 'opus')?.label).toContain('claude-opus-6');
    } finally {
      bindModelCatalogue(registry, null);
    }
    expect(registry.get('claude')!.defaults().model).toBe(
      BUILTIN_PROVIDER_DEFAULT_MODELS.claude,
    );
  });

  it('has every built-in refuse to spawn without a per-session config dir', () => {
    // Refusing beats launching: without its config dir an agent falls back on the
    // operator's real `~/.codex` / `~/.gemini` / `~/.config/opencode` — no trust
    // entry (the PTY wedges on an invisible modal), no team-comms (not a swarm
    // member), and its state written into the shared home. `Session` turns the
    // throw into a failed session with the reason in its log.
    //
    // claude is the deliberate exception and always has been: it degrades to
    // running without a per-session config dir (`buildSpawn` still returns an
    // argv), which is why it is excluded rather than forgotten.
    const r = createBuiltinProviderRegistry();
    for (const id of ['codex', 'gemini', 'opencode']) {
      const p = r.get(id)!;
      expect(() =>
        p.buildSpawn({
          model: 'm',
          effort: 'high',
          permissionMode: 'bypassPermissions',
          initialPrompt: null,
          preamble: null,
          resumeNotice: null,
          cwd: '/workspace/proj',
          configDir: null,
          mcpConfigPath: null,
          paths: IDENTITY_PATH_MAPPER,
        }),
      ).toThrow();
    }
  });

  it('has every built-in probe() resolve rather than throw, with no config at all', async () => {
    // `probe()` must never reject: the availability cache calls it on a request
    // path, and a throwing adapter would poison it. Called with an EMPTY config —
    // the shape a plugin-provided adapter can genuinely receive — so an adapter
    // that dereferences `config.sshTarget` blindly fails here and not in
    // production.
    //
    // NOTE: this executes real binaries when they are on PATH (the local probe is
    // a `spawnSync` of `<binary> --version`). It is bounded rather than mocked
    // because it is the only place the REAL adapters' error paths are exercised;
    // the per-adapter tests inject their `spawnSync`/`hostExec` and never shell
    // out. A short explicit timeout keeps the cost bounded even on a cold host.
    const r = createBuiltinProviderRegistry();
    const results = await Promise.all(
      r.list().map((p) =>
        p.probe({ transport: 'local', config: {} as never, timeoutMs: 1_000 }),
      ),
    );
    for (const res of results) {
      expect(typeof res.available).toBe('boolean');
      // An unavailable provider MUST say why: that string is what the UI shows
      // next to the greyed-out option, and "no reason reported" teaches nobody
      // anything.
      if (!res.available) expect(res.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('describes claude accurately — every capability the session relies on', () => {
    const claude = createBuiltinProviderRegistry().get('claude')!;
    expect(claude.capabilities.inkSubmitDance).toBe(true);
    // The ONLY built-in whose callback means "a human is needed", so the only one
    // whose hook flips the badge to `waiting` and notifies Discord. codex and
    // gemini fire at every turn boundary instead (`'turn-complete'`).
    expect(claude.capabilities.notificationHook).toBe('needs-human');
    expect(claude.capabilities.effort).toBe(true);
    expect(claude.capabilities.durablePreamble).toBe(true);
    expect(claude.capabilities.httpMcp).toBe(true);
    expect(claude.defaults()).toEqual({
      // The constant, not the literal: `pnpm models:sync` rewrites the pins in
      // `ids.ts` before a release, and a test that froze the id would turn every
      // model refresh into a test edit — which is how a catalogue goes stale.
      model: BUILTIN_PROVIDER_DEFAULT_MODELS.claude,
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
    });
    // Slash commands are claude's own — identity mapping.
    expect(claude.contextResetLine('/clear')).toBe('/clear');
    expect(claude.contextResetLine('/compact', 'keep the API contract')).toBe(
      '/compact keep the API contract',
    );
  });

  it('returns a fresh registry per call (no shared mutable state)', () => {
    const a = createBuiltinProviderRegistry();
    const b = createBuiltinProviderRegistry();
    a.register(new FakeProvider());
    expect(a.has('fake')).toBe(true);
    expect(b.has('fake')).toBe(false);
  });
});
