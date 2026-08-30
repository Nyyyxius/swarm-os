/**
 * The live catalogue: the cache mechanics, then the filters.
 *
 * The mechanics come first because they are the part that can take the process
 * down or wedge it: an unhandled rejection off `void maybeRefresh()`, a clock
 * that only advances on success (so a dead network means one fetch per request
 * forever), a single-flight guard that coalesces onto a promise that never
 * settles. Each has a test whose failure mode is the outage, not the assertion.
 *
 * The filters are tested against `catalogue.fixture.ts`, a verbatim slice of the
 * real payload — see that file for what each entry is there to prove.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ModelCatalogue,
  MODEL_CATALOGUE_URL,
  deriveCatalogue,
  deriveCodexCatalogue,
  estimateTokenCostUsd,
  modelContextLimit,
  modelCostRates,
  pinnedContextLimit,
  pinnedCostRates,
  type ModelCatalogueOptions,
} from './catalogue.js';
import { MODELS_DEV_FIXTURE, CODEX_CACHE_FIXTURE } from './catalogue.fixture.js';
import type { Config } from '../../config.js';
import type { ProviderModel } from './types.js';

const PINNED: readonly ProviderModel[] = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8 (claude-opus-4-8)' },
];

/** A `fetch` double that answers the fixture and counts calls. */
function fixtureFetch(payload: unknown = MODELS_DEV_FIXTURE) {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A catalogue with no Config: it never touches the codex cache. */
function netOnly(opts: ModelCatalogueOptions = {}) {
  const { impl, calls } = fixtureFetch();
  const cat = new ModelCatalogue({ fetchImpl: impl, env: {}, ...opts });
  return { cat, calls };
}

function values(models: readonly ProviderModel[]): string[] {
  return models.map((m) => m.value);
}

// ---------------------------------------------------------------------------
// 1. Cache mechanics
// ---------------------------------------------------------------------------

describe('ModelCatalogue — cache mechanics', () => {
  it('serves the pinned list synchronously before anything has been fetched', () => {
    const { cat } = netOnly();
    // `models()` must never await: it is called from `GET /providers`, which is
    // on the UI's 60 s poll, and from `defaults()` on the team-creation path.
    expect(values(cat.models('claude', PINNED))).toEqual(['claude-opus-4-8']);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('serves live entries after a resolve, and unions the pins in behind them', async () => {
    const { cat, calls } = netOnly();
    await cat.resolve(1_000);
    expect(calls).toEqual([MODEL_CATALOGUE_URL]);
    const live = values(cat.models('claude', PINNED));
    // Live first, newest first.
    expect(live[0]).toBe('claude-opus-5');
    expect(live).toContain('claude-sonnet-5');
    // The pin is already live, so the union must not duplicate it.
    expect(live.filter((v) => v === 'claude-opus-4-8')).toHaveLength(1);
  });

  it('appends a pinned id the payload does not carry, rather than dropping it', async () => {
    const { cat } = netOnly();
    await cat.resolve(1_000);
    const withOrphan = values(
      cat.models('claude', [
        ...PINNED,
        { value: 'claude-internal-preview', label: 'Internal preview' },
      ]),
    );
    expect(withOrphan.at(-1)).toBe('claude-internal-preview');
  });

  it('does not re-fetch inside the TTL, and does re-fetch once past it', async () => {
    let clock = 1_000;
    const { impl, calls } = fixtureFetch();
    const cat = new ModelCatalogue({
      fetchImpl: impl,
      env: {},
      ttlMs: 60_000,
      now: () => clock,
    });
    await cat.resolve(1_000);
    expect(calls).toHaveLength(1);

    clock += 59_999;
    cat.models('claude', PINNED);
    await cat.resolve(1_000);
    expect(calls).toHaveLength(1);

    clock += 2;
    await cat.resolve(1_000);
    expect(calls).toHaveLength(2);
  });

  it('coalesces concurrent refreshes onto ONE fetch (single flight)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const impl = (async (url: unknown) => {
      calls.push(String(url));
      await gate;
      return new Response(JSON.stringify(MODELS_DEV_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {} });

    const a = cat.resolve(1_000);
    const b = cat.resolve(1_000);
    cat.models('claude', PINNED);
    cat.defaultModel('claude', 'claude-opus-4-8');
    expect(calls).toHaveLength(1);
    release?.();
    await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
  });

  it('ADVANCES THE CLOCK ON FAILURE — one attempt per TTL, not one per request', async () => {
    // The bug this pins: an offline host fails DNS in ~1 ms. If `checkedAtMs`
    // were only written on success, the TTL would never short-circuit and every
    // `GET /providers` would fire a fresh fetch — eight of them, since the route
    // touches `models()` and `defaults()` on four adapters.
    let clock = 1_000;
    let n = 0;
    const impl = (async () => {
      n += 1;
      throw new Error('getaddrinfo ENOTFOUND models.dev');
    }) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {}, ttlMs: 60_000, now: () => clock });

    await cat.resolve(1_000);
    expect(n).toBe(1);
    for (let i = 0; i < 10; i++) {
      cat.models('claude', PINNED);
      cat.defaultModel('claude', 'claude-opus-4-8');
    }
    await cat.resolve(1_000);
    expect(n).toBe(1);

    clock += 60_001;
    await cat.resolve(1_000);
    expect(n).toBe(2);
  });

  it('keeps serving the last good views when a later refresh fails', async () => {
    let clock = 1_000;
    let fail = false;
    const impl = (async () => {
      if (fail) throw new Error('connection reset');
      return new Response(JSON.stringify(MODELS_DEV_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {}, ttlMs: 10, now: () => clock });

    await cat.resolve(1_000);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-5');

    fail = true;
    clock += 1_000;
    await cat.resolve(1_000);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-5');
  });

  it('RECOVERS once the network comes back, without a restart', async () => {
    // The air-gap story end to end, and the reason there is no boot-time fetch:
    // an instance that booted offline must pick the catalogue up on its own at
    // the next TTL boundary. Nothing here is scheduled — the request that
    // arrives after the TTL is what does it.
    let clock = 1_000;
    let offline = true;
    const impl = (async () => {
      if (offline) throw new Error('EHOSTUNREACH');
      return new Response(JSON.stringify(MODELS_DEV_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {}, ttlMs: 60_000, now: () => clock });

    await cat.resolve(1_000);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');

    offline = false;
    clock += 60_001;
    // The recovery request STARTS the refresh and does not wait for it — the
    // catalogue is stale-but-known, and only a COLD one blocks a caller. So this
    // request is still served the pins, and the one after it gets the live data.
    // That is the contract (`ProviderAvailabilityCache.resolve` behaves the
    // same), and it is the reason `GET /providers` costs nothing once warm.
    await cat.resolve(1_000);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');

    await new Promise((r) => setTimeout(r, 0));
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-5');
    expect(values(cat.models('claude', PINNED))).toContain('claude-sonnet-5');
  });

  it('emits NO unhandled rejection when a `void`-ed refresh fails', async () => {
    // `models()` does `void this.#maybeRefresh()`. A rejected promise handed to
    // `void` is an `unhandledRejection`, which by Node's default takes the
    // process down — a dead models.dev would kill the server. This is the test
    // that says the mechanism is in place rather than the intention.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const impl = (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch;
      const cat = new ModelCatalogue({ fetchImpl: impl, env: {} });
      cat.models('claude', PINNED);
      // Two macrotask turns: `unhandledRejection` fires after the microtask
      // queue drains, so a single `await` would pass even if it were broken.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('gives the fetch its own abort deadline, not just a wait deadline', async () => {
    // `raceDeadline` only stops us WAITING. Without an `AbortSignal` the socket
    // outlives the wait, `#inflight` never clears, and single-flight coalesces
    // every subsequent attempt onto a promise that will never settle.
    let seenSignal: AbortSignal | null = null;
    const impl = (async (_url: unknown, init: unknown) => {
      seenSignal = (init as RequestInit | undefined)?.signal ?? null;
      return new Response(JSON.stringify(MODELS_DEV_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {}, fetchTimeoutMs: 25 });
    await cat.resolve(1_000);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('returns from a cold resolve within the deadline when the fetch hangs', async () => {
    const impl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {} });
    const started = Date.now();
    await cat.resolve(30);
    expect(Date.now() - started).toBeLessThan(2_000);
    // …and the caller still gets an answer, which is the pinned one.
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('treats a non-200 and unparsable JSON as "we do not know"', async () => {
    const http500 = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const c1 = new ModelCatalogue({ fetchImpl: http500, env: {} });
    await c1.resolve(1_000);
    expect(c1.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');

    const garbage = (async () =>
      new Response('<html>maintenance</html>', { status: 200 })) as unknown as typeof fetch;
    const c2 = new ModelCatalogue({ fetchImpl: garbage, env: {} });
    await c2.resolve(1_000);
    expect(values(c2.models('claude', PINNED))).toEqual(['claude-opus-4-8']);
  });

  it('makes NO outbound call at all under the `off` kill switch', async () => {
    const impl = (async () => {
      throw new Error('the kill switch let a request through');
    }) as unknown as typeof fetch;
    const readFileImpl = (): string => {
      throw new Error('the kill switch let a file read through');
    };
    const cat = new ModelCatalogue({
      fetchImpl: impl,
      readFileImpl,
      env: { SWARM_OS_MODEL_CATALOGUE_URL: 'off' },
      config: { agentTransport: 'local', hostCodexDir: '/nope' } as Config,
    });
    expect(cat.enabled).toBe(false);
    await cat.resolve(1_000);
    cat.models('claude', PINNED);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('reads its URL and TTL from the environment', async () => {
    const { impl, calls } = fixtureFetch();
    const cat = new ModelCatalogue({
      fetchImpl: impl,
      env: {
        SWARM_OS_MODEL_CATALOGUE_URL: 'https://mirror.example/api.json',
        SWARM_OS_MODEL_CATALOGUE_TTL_MS: '1',
      },
    });
    await cat.resolve(1_000);
    expect(calls).toEqual(['https://mirror.example/api.json']);
    // A 1 ms TTL is stale by the next tick, so the second resolve must re-fetch.
    await new Promise((r) => setTimeout(r, 5));
    await cat.resolve(1_000);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-provider filters — against the verbatim fixture
// ---------------------------------------------------------------------------

describe('deriveCatalogue — claude', () => {
  const view = deriveCatalogue(MODELS_DEV_FIXTURE).claude;

  it('keeps the tool-calling claude models, newest first', () => {
    expect(view).toBeDefined();
    expect(values(view!.models).slice(0, 3)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
    ]);
  });

  it('drops a model that cannot call tools — it could never reach team-comms', () => {
    expect(values(view!.models)).not.toContain('claude-translate-2');
  });

  it('prefers the undated id over its dated twin (the inverse of the old pin)', () => {
    expect(values(view!.models)).toContain('claude-haiku-4-5');
    expect(values(view!.models)).not.toContain('claude-haiku-4-5-20251001');
  });

  it('puts the price in the label, so `claude-fable-5` cannot look cheap', () => {
    const fable = view!.models.find((m) => m.value === 'claude-fable-5');
    expect(fable?.label).toBe('Claude Fable 5 (claude-fable-5) · $10/$50');
    const opus = view!.models.find((m) => m.value === 'claude-opus-5');
    expect(opus?.label).toBe('Claude Opus 5 (claude-opus-5) · $5/$25');
  });

  it('keeps a model whose `cost` is the wrong type, minus its price tag', () => {
    const odd = view!.models.find((m) => m.value === 'claude-opus-5-priceless');
    expect(odd?.label).toBe('Claude Opus 5 (no price data) (claude-opus-5-priceless)');
  });

  it('drops one unreadable entry without losing the readable ones', () => {
    // The fixture carries an entry with no id and an unusable key. If per-entry
    // validation failed the whole fetch, an operator would lose the catalogue
    // over a model nobody asked for.
    expect(view!.models.length).toBeGreaterThanOrEqual(7);
    expect(values(view!.models).some((v) => v.length === 0)).toBe(false);
  });

  it('elects the newest OPUS — not the newest model, and not the $15/$75 one', () => {
    // `claude-sonnet-5` is newer than `claude-opus-4-8`; the family is what
    // decides. And `claude-opus-4-1` is the id an unanchored `^claude-opus-`
    // would have been free to elect on a payload missing opus 5.
    expect(view!.familyDefault).toBe('claude-opus-5');
  });
});

describe('deriveCatalogue — gemini', () => {
  const view = deriveCatalogue(MODELS_DEV_FIXTURE).gemini;

  it('excludes rolling `*-latest` aliases (they change model under the operator)', () => {
    expect(values(view!.models)).not.toContain('gemini-flash-latest');
  });

  it('excludes non-text lines wherever the marker sits in the id', () => {
    const ids = values(view!.models);
    expect(ids).not.toContain('gemini-3-pro-image');
    // Both of these carry their marker in the MIDDLE; a suffix test admits them.
    expect(ids).not.toContain('gemini-robotics-er-1.6-preview');
    expect(ids).not.toContain('gemini-2.5-computer-use-preview-10-2025');
  });

  it('elects the newest `-pro`, not the newest model nor the `-customtools` variant', () => {
    expect(values(view!.models)[0]).toBe('gemini-3.6-flash');
    expect(values(view!.models)).toContain('gemini-3.1-pro-preview-customtools');
    expect(view!.familyDefault).toBe('gemini-3.1-pro-preview');
  });
});

describe('deriveCatalogue — opencode', () => {
  const view = deriveCatalogue(MODELS_DEV_FIXTURE).opencode;

  it('keeps allow-listed vendors only', () => {
    const ids = values(view!.models);
    expect(ids).toContain('anthropic/claude-opus-5');
    expect(ids).toContain('openai/gpt-5.5');
    expect(ids).toContain('deepseek/deepseek-chat');
    expect(ids).not.toContain('inception/mercury-coder');
  });

  it('offers `-fast` but never elects it — the family regex is anchored', () => {
    expect(values(view!.models)).toContain('anthropic/claude-opus-5-fast');
    expect(view!.familyDefault).toBe('anthropic/claude-opus-5');
  });
});

describe('deriveCatalogue — degenerate payloads', () => {
  it('answers with nothing rather than throwing on junk', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { anthropic: 7 }]) {
      expect(deriveCatalogue(junk)).toEqual({});
    }
  });

  it('omits a provider whose section is empty, leaving the adapter on its pin', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ anthropic: { models: {} } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {} });
    await cat.resolve(1_000);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(values(cat.models('claude', PINNED))).toEqual(['claude-opus-4-8']);
  });

  it('falls back to the pin when the family matches nothing in a live list', async () => {
    // A payload with real claude models but no opus at all: the list updates,
    // the default does not move to something outside the pinned family.
    const noOpus = {
      anthropic: {
        models: {
          'claude-sonnet-5': {
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            release_date: '2026-06-29',
            tool_call: true,
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    };
    const impl = (async () =>
      new Response(JSON.stringify(noOpus), { status: 200 })) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {} });
    await cat.resolve(1_000);
    expect(values(cat.models('claude', PINNED))).toEqual([
      'claude-sonnet-5',
      'claude-opus-4-8',
    ]);
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

// ---------------------------------------------------------------------------
// 3. codex — the host CLI's own cache
// ---------------------------------------------------------------------------

describe('deriveCodexCatalogue', () => {
  it('keeps `visibility: "list"` only, in the CLI\'s own priority order', () => {
    const view = deriveCodexCatalogue(CODEX_CACHE_FIXTURE);
    expect(values(view!.models)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.2',
    ]);
    // `codex-auto-review` is an internal model the CLI hides from its own
    // picker; offering it would be offering something nobody can debug.
    expect(values(view!.models)).not.toContain('codex-auto-review');
  });

  it('elects the CLI\'s own first choice, and never a `-mini`/`-codex` variant', () => {
    expect(deriveCodexCatalogue(CODEX_CACHE_FIXTURE)!.familyDefault).toBe('gpt-5.5');
  });

  it('answers null on junk rather than throwing', () => {
    for (const junk of [null, 42, {}, { models: 'nope' }, { models: [] }]) {
      expect(deriveCodexCatalogue(junk)).toBeNull();
    }
  });

  it('reads the host cache in local transport and merges it with the pins', async () => {
    const { impl } = fixtureFetch();
    const readFileImpl = vi.fn(() => JSON.stringify(CODEX_CACHE_FIXTURE));
    const cat = new ModelCatalogue({
      fetchImpl: impl,
      readFileImpl,
      env: {},
      config: { agentTransport: 'local', hostCodexDir: '/home/x/.codex' } as Config,
    });
    await cat.resolve(1_000);
    expect(readFileImpl).toHaveBeenCalledWith('/home/x/.codex/models_cache.json');
    expect(cat.defaultModel('codex', 'gpt-5.5')).toBe('gpt-5.5');
    expect(values(cat.models('codex', [{ value: 'gpt-5.5', label: 'GPT-5.5' }]))[0]).toBe(
      'gpt-5.5',
    );
  });

  it('reads it over `hostExec` under ssh, and never through the local fs', async () => {
    // `hostExec` throws outright when the transport is not ssh, and a container
    // cannot stat a host path — hence two branches rather than one call.
    const { impl } = fixtureFetch();
    const readFileImpl = (): string => {
      throw new Error('the ssh branch read the container filesystem');
    };
    const hostExec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify(CODEX_CACHE_FIXTURE),
      stderr: '',
      timedOut: false,
    }));
    const cat = new ModelCatalogue({
      fetchImpl: impl,
      readFileImpl,
      hostExec,
      env: {},
      config: { agentTransport: 'ssh', hostCodexDir: '/home/host/.codex' } as Config,
    });
    await cat.resolve(1_000);
    expect(hostExec).toHaveBeenCalledTimes(1);
    expect(hostExec.mock.calls[0]?.[1].argv).toEqual([
      'cat',
      '/home/host/.codex/models_cache.json',
    ]);
    expect(cat.defaultModel('codex', 'gpt-5.5')).toBe('gpt-5.5');
  });

  it('leaves codex on its pins when the cache is absent — and still updates claude', async () => {
    // A deployment with no codex installed is an ordinary deployment, not an
    // error, and it must not cost the other three adapters their refresh.
    const { impl } = fixtureFetch();
    const readFileImpl = (): string => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const cat = new ModelCatalogue({
      fetchImpl: impl,
      readFileImpl,
      env: {},
      config: { agentTransport: 'local', hostCodexDir: '/home/x/.codex' } as Config,
    });
    await cat.resolve(1_000);
    expect(cat.defaultModel('codex', 'gpt-5.5')).toBe('gpt-5.5');
    expect(cat.defaultModel('claude', 'claude-opus-4-8')).toBe('claude-opus-5');
  });

  it('never derives codex from models.dev, even with a full payload in hand', async () => {
    // The measured reason (see `deriveCodexCatalogue`): models.dev lists
    // `gpt-5.6`, and `codex exec -m gpt-5.6` answers HTTP 400 "not supported
    // when using Codex with a ChatGPT account". A models.dev-derived codex list
    // would offer ids that kill a lead inside its own PTY.
    const payload = {
      ...MODELS_DEV_FIXTURE,
      openai: {
        models: {
          'gpt-5.6': {
            id: 'gpt-5.6',
            name: 'GPT-5.6',
            release_date: '2026-07-09',
            tool_call: true,
            modalities: { input: ['text'], output: ['text'] },
            cost: { input: 5, output: 20 },
          },
        },
      },
    };
    const impl = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const cat = new ModelCatalogue({ fetchImpl: impl, env: {} });
    await cat.resolve(1_000);
    const pinned: readonly ProviderModel[] = [{ value: 'gpt-5.5', label: 'GPT-5.5' }];
    expect(values(cat.models('codex', pinned))).toEqual(['gpt-5.5']);
    expect(cat.defaultModel('codex', 'gpt-5.5')).toBe('gpt-5.5');
  });
});

// ---------------------------------------------------------------------------
// 4. Context windows — the live figure, and the pinned fallback
// ---------------------------------------------------------------------------

describe('context limits — readModel', () => {
  const view = deriveCatalogue(MODELS_DEV_FIXTURE).claude;

  it('reads `limit.context` when the payload carries one', () => {
    expect(view!.contextLimits['claude-opus-5']).toBe(200_000);
    expect(view!.contextLimits['claude-sonnet-5']).toBe(1_000_000);
  });

  it('omits a model with no `limit` block at all — rather than inventing one', () => {
    // `claude-fable-5` is a perfectly good entry that simply published no
    // window. The absence has to survive as an absence: a default here would
    // become a gauge denominator nobody can trace back to a source.
    expect(view!.models.map((m) => m.value)).toContain('claude-fable-5');
    expect(view!.contextLimits['claude-fable-5']).toBeUndefined();
  });

  it('rejects `limit.context: 0` — a zero denominator pins every gauge at 100 %', () => {
    expect(view!.models.map((m) => m.value)).toContain('claude-opus-5-priceless');
    expect(view!.contextLimits['claude-opus-5-priceless']).toBeUndefined();
  });

  it('gives the codex view an empty map — its cache carries no window', () => {
    expect(deriveCodexCatalogue(CODEX_CACHE_FIXTURE)!.contextLimits).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 4b. Prices — the rate card behind `SessionView.tokenUsage.costUsd` (Lot 11)
// ---------------------------------------------------------------------------

describe('cost rates — readModel', () => {
  const claude = deriveCatalogue(MODELS_DEV_FIXTURE).claude;
  const opencode = deriveCatalogue(MODELS_DEV_FIXTURE).opencode;

  it('keeps all four buckets when the payload publishes them', () => {
    expect(claude!.costs['claude-opus-5']).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it('keeps a model priced on input/output alone, with null cache buckets', () => {
    // The common case outside Anthropic. Dropping the entry would cost the
    // estimate its two BIGGEST buckets over the two it never published.
    expect(opencode!.costs['anthropic/claude-sonnet-5']).toEqual({
      input: 2,
      output: 10,
      cacheRead: null,
      cacheWrite: null,
    });
  });

  it('omits a model whose `cost` is not an object at all', () => {
    // `claude-opus-5-priceless` survives as a MODEL — only its price is gone.
    expect(claude!.models.map((m) => m.value)).toContain('claude-opus-5-priceless');
    expect(claude!.costs['claude-opus-5-priceless']).toBeUndefined();
  });

  it('gives the codex view an empty rate card — its cache is a model list', () => {
    expect(deriveCodexCatalogue(CODEX_CACHE_FIXTURE)!.costs).toEqual({});
  });

  it('serves rates through the catalogue, and null for an id nothing can price', async () => {
    const { cat } = netOnly();
    await cat.resolve(1_000);
    expect(cat.costRates('claude', 'claude-opus-5')).toMatchObject({ input: 5, output: 25 });
    // Neither the payload nor a pinned family knows this one.
    expect(cat.costRates('claude', 'claude-not-a-model')).toBeNull();
  });
});

describe('cost rates — the pinned fallback (Lot 15)', () => {
  it('prices the claude families from figures models.dev publishes', () => {
    expect(pinnedCostRates('claude', 'claude-opus-5')).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(pinnedCostRates('claude', 'claude-sonnet-5')).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(pinnedCostRates('claude', 'claude-haiku-4-5-20251001')).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it('keeps opus 4.1 apart from the rest of the opus line — it costs 3×', () => {
    // The whole reason the table is per FAMILY and ordered: a generic
    // `^claude-opus-` pin would quote this model at a third of its price.
    expect(pinnedCostRates('claude', 'claude-opus-4-1')).toMatchObject({
      input: 15,
      output: 75,
    });
    expect(pinnedCostRates('claude', 'claude-opus-4-8')).toMatchObject({ input: 5, output: 25 });
  });

  it('covers the bare aliases the claude CLI resolves itself', () => {
    // Same hole `pinnedContextLimit` closes for windows: `POST /orchestrators`
    // passes `model: "haiku"` straight through, matching no `claude-*` pin.
    expect(pinnedCostRates('claude', 'haiku')).toMatchObject({ input: 1, output: 5 });
    expect(pinnedCostRates('claude', 'sonnet')).toMatchObject({ input: 2, output: 10 });
    expect(pinnedCostRates('claude', 'opus')).toMatchObject({ input: 5, output: 25 });
    // Alias leniency is claude-scoped: other providers keep exact ids.
    expect(pinnedCostRates('codex', 'opus')).toBeNull();
  });

  it('strips the vendor prefix of an opencode id before matching', () => {
    expect(pinnedCostRates('opencode', 'anthropic/claude-opus-5')).toMatchObject({ input: 5 });
  });

  it('invents no bucket the payload never published', () => {
    // gpt-5.5 is quoted input/output only. The two cache buckets stay null and
    // contribute 0 — a lower bound, never an embellishment.
    expect(pinnedCostRates('codex', 'gpt-5.5')).toEqual({
      input: 5,
      output: 20,
      cacheRead: null,
      cacheWrite: null,
    });
  });

  it('answers null for anything it cannot source — gemini included', () => {
    expect(pinnedCostRates('gemini', 'gemini-3-pro-preview')).toBeNull();
    expect(pinnedCostRates('opencode', 'z-ai/glm-5')).toBeNull();
    expect(pinnedCostRates('claude', '')).toBeNull();
  });
});

describe('cost rates — ModelCatalogue.costRates over the pins', () => {
  it('answers from the pins alone before anything has been fetched', () => {
    // THE failure this table exists for: models.dev unreachable at boot used to
    // make every `$` in the product disappear at once.
    const { cat } = netOnly();
    expect(cat.costRates('claude', 'claude-opus-5')).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it('prefers the LIVE card over the pin', async () => {
    // The fixture prices the openrouter passthrough of sonnet-5 at 2/10 with NO
    // cache buckets; the pinned claude family carries all four. Live wins whole
    // — a pin never fills in the halves a live entry left null.
    const { cat } = netOnly();
    await cat.resolve(1_000);
    expect(cat.costRates('opencode', 'anthropic/claude-sonnet-5')).toEqual({
      input: 2,
      output: 10,
      cacheRead: null,
      cacheWrite: null,
    });
  });

  it('falls back to the pin for an id the live payload never carried', async () => {
    const { cat } = netOnly();
    await cat.resolve(1_000);
    // Not in the payload at all → the family pin answers.
    expect(cat.costRates('claude', 'claude-opus-9')).toMatchObject({ input: 5, output: 25 });
    // In the payload but with an unusable `cost` → same.
    expect(cat.costRates('claude', 'claude-opus-5-priceless')).toMatchObject({ input: 5 });
  });

  it('modelCostRates() works with no catalogue at all', () => {
    expect(modelCostRates(null, 'claude', 'claude-opus-5')).toMatchObject({ input: 5 });
    expect(modelCostRates(undefined, 'gemini', 'gemini-3-pro-preview')).toBeNull();
  });
});

describe('estimateTokenCostUsd', () => {
  const full = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it('sums every bucket at its own per-million rate', () => {
    // 1M in ($5) + 100k out ($2.5) + 2M cache read ($1) + 200k cache write ($1.25)
    expect(
      estimateTokenCostUsd(
        { in: 1_000_000, out: 100_000, cacheRead: 2_000_000, cacheWrite: 200_000 },
        full,
      ),
    ).toBeCloseTo(9.75, 6);
  });

  it('lets a bucket with no published rate contribute ZERO, never a guess', () => {
    // The two cache buckets are unpriced here. 1M in ($2) + 1M out ($10) = $12,
    // and the 5M cached tokens are simply not in the total — which is a
    // statement an operator can check, unlike a house rate they cannot.
    expect(
      estimateTokenCostUsd(
        { in: 1_000_000, out: 1_000_000, cacheRead: 5_000_000, cacheWrite: 1_000_000 },
        { input: 2, output: 10, cacheRead: null, cacheWrite: null },
      ),
    ).toBeCloseTo(12, 6);
  });

  it('answers null — not 0 — when neither input nor output is priced', () => {
    // `0` would read as "this agent was free".
    expect(
      estimateTokenCostUsd(
        { in: 10, out: 10, cacheRead: 10, cacheWrite: 10 },
        { input: null, output: null, cacheRead: 1, cacheWrite: 1 },
      ),
    ).toBeNull();
    expect(estimateTokenCostUsd({ in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, null)).toBeNull();
  });

  it('prices a free model at 0 — `0` is a rate, `null` is an absence', () => {
    expect(
      estimateTokenCostUsd(
        { in: 5_000_000, out: 1_000_000, cacheRead: 0, cacheWrite: 0 },
        { input: 0, output: 0, cacheRead: null, cacheWrite: null },
      ),
    ).toBe(0);
  });

  it('rounds to the micro-dollar rather than shipping float noise', () => {
    const usd = estimateTokenCostUsd(
      { in: 3, out: 7, cacheRead: 0, cacheWrite: 0 },
      { input: 0.1, output: 0.4, cacheRead: null, cacheWrite: null },
    );
    expect(String(usd)).not.toMatch(/e-|0{6}\d/);
  });
});

describe('context limits — the pinned fallback', () => {
  it('answers 200 000 for a claude id and 272 000 for a gpt one', () => {
    expect(pinnedContextLimit('claude', 'claude-opus-5')).toBe(200_000);
    expect(pinnedContextLimit('codex', 'gpt-5.5')).toBe(272_000);
  });

  it('is per MODEL, not per provider: a `[1m]` id gets its million', () => {
    // The whole point of a per-model table. A per-provider one would report a
    // 1M-context agent as five times fuller than it is.
    expect(pinnedContextLimit('claude', 'claude-sonnet-4-5-20250929[1m]')).toBe(1_000_000);
    expect(pinnedContextLimit('claude', 'claude-sonnet-4-5')).toBe(200_000);
  });

  it('strips the vendor prefix of an opencode id before matching', () => {
    expect(pinnedContextLimit('opencode', 'anthropic/claude-opus-5')).toBe(200_000);
  });

  it('covers the bare aliases the claude CLI resolves itself', () => {
    // `POST /orchestrators` passes `model: "haiku"` straight through — seen
    // live: the gauge lost its denominator on an alias-spawned team.
    expect(pinnedContextLimit('claude', 'haiku')).toBe(200_000);
    expect(pinnedContextLimit('claude', 'sonnet')).toBe(200_000);
    expect(pinnedContextLimit('claude', 'opus[1m]')).toBe(1_000_000);
    // Alias leniency is claude-scoped: other providers keep exact ids.
    expect(pinnedContextLimit('codex', 'haiku')).toBeNull();
  });

  it('answers null for anything it cannot source — gemini included', () => {
    expect(pinnedContextLimit('gemini', 'gemini-3-pro-preview')).toBeNull();
    expect(pinnedContextLimit('opencode', 'z-ai/glm-5')).toBeNull();
    expect(pinnedContextLimit('claude', '')).toBeNull();
  });
});

describe('context limits — ModelCatalogue.contextLimit', () => {
  it('prefers the live figure over the pin, and falls back to the pin', async () => {
    const { cat } = netOnly();
    await cat.resolve(1_000);
    // The fixture says 1M for sonnet-5; the pinned table says 200k for any
    // `claude-*`. Live wins, which is the only reason to read the payload.
    expect(cat.contextLimit('claude', 'claude-sonnet-5')).toBe(1_000_000);
    // Not in the payload at all → the pin answers.
    expect(cat.contextLimit('claude', 'claude-opus-9')).toBe(200_000);
    // In the payload but with an unusable figure → the pin answers.
    expect(cat.contextLimit('claude', 'claude-opus-5-priceless')).toBe(200_000);
  });

  it('answers from the pins alone before anything has been fetched', () => {
    const { cat } = netOnly();
    expect(cat.contextLimit('claude', 'claude-opus-5')).toBe(200_000);
  });

  it('degrades to null for a provider that has no slice and no pin', async () => {
    const { cat } = netOnly();
    await cat.resolve(1_000);
    expect(cat.contextLimit('gemini', 'gemini-3.1-pro-preview')).toBeNull();
    expect(cat.contextLimit('some-plugin', 'weird-model')).toBeNull();
  });

  it('modelContextLimit() works with no catalogue at all', () => {
    expect(modelContextLimit(null, 'claude', 'claude-opus-5')).toBe(200_000);
    expect(modelContextLimit(undefined, 'gemini', 'gemini-3-pro-preview')).toBeNull();
  });
});
