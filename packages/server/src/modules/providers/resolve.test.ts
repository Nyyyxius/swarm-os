/**
 * The provider-scoping rule, stated once (`providers/resolve.ts`).
 *
 * These are the unit-level statements of the rule; `test/integration/
 * providers.test.ts` and `workers-route.test.ts` then prove that all four
 * creation channels actually go through it.
 */

import { describe, it, expect } from 'vitest';
import { FakeProvider } from './fake.js';
import {
  PROVIDER_DEFAULT_SOURCE,
  resolveAgentDefaults,
  resolveProviderId,
  type AgentDefaultsLayer,
} from './resolve.js';

/** claude-shaped: full permission vocabulary, effort, its own model id. */
function claudeLike(): FakeProvider {
  return new FakeProvider({
    id: 'claude',
    capabilities: {
      permissionModes: ['auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
      fallbackPermissionMode: 'bypassPermissions',
    },
  });
}

/** codex/gemini/opencode-shaped: one forced permission mode, no effort knob. */
function bypassOnly(id = 'codexlike'): FakeProvider {
  return new FakeProvider({
    id,
    capabilities: {
      effort: false,
      permissionModes: ['bypassPermissions'],
      fallbackPermissionMode: 'bypassPermissions',
    },
  });
}

const CONFIG_LAYER: AgentDefaultsLayer = {
  source: 'config',
  provider: 'claude',
  model: 'claude-opus-4-8',
  effort: 'xhigh',
  permissionMode: 'bypassPermissions',
};

describe('resolveProviderId', () => {
  it('takes the topmost layer that names one', () => {
    expect(
      resolveProviderId(
        [
          { source: 'body', provider: 'gemini' },
          { source: 'role', provider: 'codex' },
          CONFIG_LAYER,
        ],
        'claude',
      ),
    ).toBe('gemini');
  });

  it('skips layers that express no opinion', () => {
    expect(
      resolveProviderId(
        [{ source: 'body' }, { source: 'role', provider: 'codex' }, CONFIG_LAYER],
        'claude',
      ),
    ).toBe('codex');
  });

  it('falls back when nobody names one', () => {
    expect(resolveProviderId([{ source: 'body' }, { source: 'role' }], 'claude')).toBe('claude');
  });
});

describe('resolveAgentDefaults — a model belongs to the provider that supplied it', () => {
  it('DROPS a role model when the body switches provider (HIGH 1)', () => {
    // The exact production shape: a role written before multi-provider carries
    // `defaultModel` and NO `defaultProvider`. Asking for a gemini team used to
    // keep the claude id — `gemini -m claude-opus-4-8`, a lead that dies inside
    // its own PTY while the UI reports `running`.
    const gemini = bypassOnly('gemini');
    const r = resolveAgentDefaults({
      provider: gemini,
      layers: [
        { source: 'body', provider: 'gemini' },
        { source: 'role', provider: null, model: 'claude-opus-4-8' },
        CONFIG_LAYER,
      ],
      fallbackProvider: 'claude',
    });
    expect(r.model).toBe(gemini.defaults().model);
    expect(r.model).not.toBe('claude-opus-4-8');
    expect(r.modelFrom).toBe(PROVIDER_DEFAULT_SOURCE);
  });

  it('KEEPS the role model when the role itself named that provider', () => {
    const gemini = bypassOnly('gemini');
    const r = resolveAgentDefaults({
      provider: gemini,
      layers: [
        { source: 'body' },
        { source: 'role', provider: 'gemini', model: 'gemini-3-pro-preview' },
        CONFIG_LAYER,
      ],
      fallbackProvider: 'claude',
    });
    expect(r.model).toBe('gemini-3-pro-preview');
    expect(r.modelFrom).toBe('role');
  });

  it('KEEPS a model named in the same request that chose the provider', () => {
    // The top layer's effective provider IS the resolved provider, so an
    // explicit value can never be replaced — we choose defaults, never refuse
    // an operator's string.
    const gemini = bypassOnly('gemini');
    const r = resolveAgentDefaults({
      provider: gemini,
      layers: [
        { source: 'body', provider: 'gemini', model: 'model-that-ships-tomorrow' },
        CONFIG_LAYER,
      ],
      fallbackProvider: 'claude',
    });
    expect(r.model).toBe('model-that-ships-tomorrow');
  });

  it('KEEPS a model named in a request whose provider comes from the role below', () => {
    // The operator typed a model into a form that had already resolved to
    // gemini: the layer inherits gemini, so the model is gemini's.
    const gemini = bypassOnly('gemini');
    const r = resolveAgentDefaults({
      provider: gemini,
      layers: [
        { source: 'body', model: 'typed-by-hand' },
        { source: 'role', provider: 'gemini' },
        CONFIG_LAYER,
      ],
      fallbackProvider: 'claude',
    });
    expect(r.model).toBe('typed-by-hand');
  });

  it('KEEPS a provider-less role model when nothing switched provider', () => {
    // The boundary, stated on purpose. On an instance whose default is codex, a
    // role naming a model and NO provider inherits that default — so its model
    // is a codex choice by the same rule, and it is an explicit stored value we
    // never refuse. Rejecting it would mean validating a model string against a
    // catalogue, which the product deliberately does not do.
    //
    // `NewOrchestratorDialog` resolves this case identically (see its test of
    // the same name): a form that showed one pairing and created another would
    // be worse than either answer.
    const codex = bypassOnly();
    const r = resolveAgentDefaults({
      provider: codex,
      layers: [
        { source: 'body' },
        { source: 'role', provider: null, model: 'claude-opus-4-8' },
        { source: 'config', provider: 'codexlike', model: 'gpt-5.5' },
      ],
      fallbackProvider: 'codexlike',
    });
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.modelFrom).toBe('role');
  });

  it('leaves a same-provider chain untouched — claude deployments do not move', () => {
    const claude = claudeLike();
    const r = resolveAgentDefaults({
      provider: claude,
      layers: [{ source: 'body' }, { source: 'role' }, CONFIG_LAYER],
      fallbackProvider: 'claude',
    });
    expect(r).toMatchObject({
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
      modelFrom: 'config',
      permissionModeCoercedFrom: null,
    });
  });

  it('treats an empty string as "not named" rather than as a value', () => {
    const claude = claudeLike();
    const r = resolveAgentDefaults({
      provider: claude,
      layers: [{ source: 'spec', model: '' }, CONFIG_LAYER],
      fallbackProvider: 'claude',
    });
    expect(r.model).toBe('claude-opus-4-8');
  });

  it('scopes EFFORT and PERMISSION exactly like the model', () => {
    // `defaults().effort` and `defaults().permissionMode` used to be dead code:
    // `addWorker` inherited effort/permission unconditionally while scoping only
    // the model.
    const codex = bypassOnly();
    const r = resolveAgentDefaults({
      provider: codex,
      layers: [
        { source: 'spec', provider: 'codexlike' },
        {
          source: 'team',
          provider: 'claude',
          model: 'claude-opus-4-8',
          effort: 'max',
          permissionMode: 'plan',
        },
      ],
      fallbackProvider: 'claude',
    });
    expect(r.effort).toBe(codex.defaults().effort);
    expect(r.effortFrom).toBe(PROVIDER_DEFAULT_SOURCE);
    expect(r.permissionMode).toBe(codex.defaults().permissionMode);
    // Nothing to coerce: the team's `plan` never crossed the provider boundary.
    expect(r.permissionModeCoercedFrom).toBeNull();
  });
});

describe('resolveAgentDefaults — permission-mode coercion (MEDIUM 3)', () => {
  it('coerces a mode the provider cannot express, and reports the coercion', () => {
    // A codex team created with `plan` used to STORE, PERSIST and DISPLAY `plan`
    // while running under `--dangerously-bypass-approvals-and-sandbox`. An
    // operator reading the panel believed an agent was planning while it wrote
    // unsupervised.
    const codex = bypassOnly();
    const r = resolveAgentDefaults({
      provider: codex,
      layers: [{ source: 'body', provider: 'codexlike', permissionMode: 'plan' }],
      fallbackProvider: 'claude',
    });
    expect(r.permissionMode).toBe('bypassPermissions');
    expect(r.permissionModeCoercedFrom).toBe('plan');
  });

  it('leaves a supported mode alone', () => {
    const claude = claudeLike();
    const r = resolveAgentDefaults({
      provider: claude,
      layers: [{ source: 'body', provider: 'claude', permissionMode: 'plan' }],
      fallbackProvider: 'claude',
    });
    expect(r.permissionMode).toBe('plan');
    expect(r.permissionModeCoercedFrom).toBeNull();
  });
});

describe('resolveAgentDefaults — the adapter that RUNS decides', () => {
  it('drops values authored for a provider the registry could not resolve', () => {
    // `Orchestrator._resolveProvider` hands back a fallback adapter when a row
    // names an id this build has no adapter for. Inheriting the old model onto
    // another vendor's CLI is the failure this whole file exists to prevent.
    const claude = claudeLike();
    const r = resolveAgentDefaults({
      provider: claude,
      layers: [{ source: 'session-row', provider: 'some-plugin-cli', model: 'plugin-model-7' }],
      fallbackProvider: 'claude',
    });
    expect(r.model).toBe(claude.defaults().model);
    expect(r.model).not.toBe('plugin-model-7');
  });
});
