/**
 * `GET /providers` with a LIVE catalogue bound.
 *
 * Deliberately NOT in `test/integration/providers.test.ts`: that suite runs on
 * `FakeProvider` precisely so it never probes a real CLI (its header, lines
 * 1-9), and a fake has no catalogue to read. What has to be proven here is the
 * one thing only this layer owns — that the route awaits the catalogue's cold
 * resolve on the SAME deadline as the availability probes, and that what it
 * then serialises is the live list and the live default rather than the pins.
 *
 * The availability cache is a stub: its own semantics have a full suite in
 * `providers/availability.test.ts`, and standing up real probes here would make
 * this test's result depend on which CLIs happen to be installed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createProvidersRouter, type ProviderInfoPayload } from './providers.js';
import type { Config } from '../../config.js';
import type { Spawner } from '../../modules/spawner/index.js';
import {
  bindModelCatalogue,
  createBuiltinProviderRegistry,
} from '../../modules/providers/index.js';
import { ModelCatalogue } from '../../modules/providers/catalogue.js';
import { MODELS_DEV_FIXTURE } from '../../modules/providers/catalogue.fixture.js';
import { BUILTIN_PROVIDER_DEFAULT_MODELS } from '../../modules/providers/ids.js';

let listening: Server | null = null;

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

const CONFIG = {
  defaultProvider: 'claude',
  defaultEffort: 'xhigh',
  defaultPermissionMode: 'bypassPermissions',
  agentTransport: 'local',
} as Config;

function fixtureFetch(delayMs = 0): typeof fetch {
  return (async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(JSON.stringify(MODELS_DEV_FIXTURE), { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * A registry with the four real adapters, the catalogue bound, and a stub
 * availability cache that answers "available" without running anything.
 */
function makeStack(catalogue: ModelCatalogue | null) {
  const providerRegistry = createBuiltinProviderRegistry();
  bindModelCatalogue(providerRegistry, catalogue);
  const spawner = {
    providerRegistry,
    modelCatalogue: catalogue,
    providerAvailability: {
      resolveAll: async () =>
        new Map(
          providerRegistry
            .list()
            .map((p) => [p.id, { available: true, checkedAtMs: 1, pending: false }]),
        ),
    },
  } as unknown as Spawner;
  return { spawner, providerRegistry };
}

async function get(spawner: Spawner): Promise<ProviderInfoPayload[]> {
  const app = express();
  app.use(createProvidersRouter(spawner, CONFIG));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/providers`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { providers: ProviderInfoPayload[] };
  return body.providers;
}

describe('GET /providers — live catalogue', () => {
  it('serves the pinned lists when no catalogue is wired', async () => {
    // The state of every test stack, and of any deployment running with
    // `SWARM_OS_MODEL_CATALOGUE_URL=off`. Nothing about the route may require a
    // catalogue to exist.
    const { spawner } = makeStack(null);
    const providers = await get(spawner);
    const claude = providers.find((p) => p.id === 'claude')!;
    expect(claude.defaults.model).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS.claude);
    // A fixture-only synthetic id: its presence would mean the payload was read.
    // Asserting on a REAL id would be fragile — `pnpm models:sync` keeps the pins
    // converging on the same models the live payload carries.
    expect(claude.models.map((m) => m.value)).not.toContain('claude-opus-5-priceless');
  });

  it('awaits the cold resolve, so the FIRST caller already sees live data', async () => {
    // Without the `await` the route would answer the pins on the very first
    // request after boot and only go live one poll later — for a UI that opens
    // a dialog once, "one poll later" can be never.
    const catalogue = new ModelCatalogue({ env: {}, fetchImpl: fixtureFetch(20) });
    const { spawner } = makeStack(catalogue);
    const providers = await get(spawner);

    const claude = providers.find((p) => p.id === 'claude')!;
    // An alias, labelled with what it resolves to right now.
    expect(claude.defaults.model).toBe('opus');
    expect(claude.models.find((m) => m.value === 'opus')?.label).toContain('claude-opus-5');
    expect(claude.models.map((m) => m.value)).toContain('claude-sonnet-5');
    // The price rides along in the label — see `catalogue.ts:labelFor`.
    expect(claude.models.find((m) => m.value === 'claude-fable-5')?.label).toContain(
      '$10/$50',
    );

    const gemini = providers.find((p) => p.id === 'gemini')!;
    expect(gemini.defaults.model).toBe('gemini-3.1-pro-preview');

    const opencode = providers.find((p) => p.id === 'opencode')!;
    expect(opencode.defaults.model).toBe('anthropic/claude-opus-5');

    // codex reads the host CLI cache, which this catalogue has no Config to
    // find — so it stays pinned while the other three move. That is the
    // designed asymmetry, not a gap.
    const codex = providers.find((p) => p.id === 'codex')!;
    expect(codex.defaults.model).toBe(BUILTIN_PROVIDER_DEFAULT_MODELS.codex);
  });

  it('keeps `defaults.model` inside `models` for every provider it serves', async () => {
    // The invariant the UI depends on: a default absent from the list renders as
    // "<id> · not in catalogue" (`ProviderFields.tsx:298`) against the value the
    // dialog just pre-filled.
    const catalogue = new ModelCatalogue({ env: {}, fetchImpl: fixtureFetch() });
    const { spawner } = makeStack(catalogue);
    for (const p of await get(spawner)) {
      expect(p.models.map((m) => m.value)).toContain(p.defaults.model);
    }
  });

  it('answers within the cold-wait budget when models.dev never replies', async () => {
    // Air-gapped host, SYN with no reply: the route must still answer, on the
    // pins, inside its own deadline — and the availability probes and the
    // catalogue must share that deadline rather than stacking two of them.
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const catalogue = new ModelCatalogue({ env: {}, fetchImpl: hang });
    const { spawner } = makeStack(catalogue);
    const t0 = Date.now();
    const providers = await get(spawner);
    expect(Date.now() - t0).toBeLessThan(3_500);
    expect(providers.find((p) => p.id === 'claude')!.defaults.model).toBe(
      BUILTIN_PROVIDER_DEFAULT_MODELS.claude,
    );
  });
});
