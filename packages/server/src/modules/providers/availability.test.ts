import { describe, it, expect } from 'vitest';
import type { Config } from '../../config.js';
import {
  ProviderAvailabilityCache,
  AVAILABILITY_PROBE_TIMEOUT_MS,
} from './availability.js';
import { ProviderRegistry } from './registry.js';
import { FakeProvider } from './fake.js';
import type { ProviderAvailability } from './types.js';

/**
 * The cache is what makes provider availability a RUNTIME property: this
 * deployment runs 24/7 and is not restarted to notice that an operator
 * installed a CLI on the host. So the contract under test is exactly the one
 * `modules/updates` already relies on — serve stale, refresh in the background,
 * never more than one probe in flight per key, and back off to one attempt per
 * TTL when the answer is "no".
 */

const CONFIG = { agentTransport: 'local' } as unknown as Config;

/** A cache with a controllable clock, over one provider we can script. */
function setup(opts: {
  probe: (n: number) => ProviderAvailability;
  ttlMs?: number;
  /** Resolve the probe only when the returned `release` is called. */
  gated?: boolean;
}) {
  let calls = 0;
  let release: (() => void) | null = null;
  const provider = new FakeProvider({
    id: 'scriptable',
    probe: async () => {
      calls += 1;
      const answer = opts.probe(calls);
      if (opts.gated) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer;
    },
  });
  const registry = new ProviderRegistry();
  registry.register(provider);
  let clock = 1_000;
  const cache = new ProviderAvailabilityCache({
    registry,
    config: CONFIG,
    ttlMs: opts.ttlMs ?? 60_000,
    now: () => clock,
  });
  return {
    cache,
    registry,
    provider,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
    release: () => release?.(),
  };
}

describe('ProviderAvailabilityCache', () => {
  it('probes once and then serves the cached verdict within the TTL', async () => {
    const s = setup({ probe: () => ({ available: true, version: '1.2.3' }) });

    const first = await s.cache.resolve('scriptable', 50);
    expect(first.available).toBe(true);
    expect(first.version).toBe('1.2.3');
    expect(first.pending).toBe(false);
    expect(s.calls()).toBe(1);

    // Three more reads inside the TTL: no additional probe.
    s.advance(59_000);
    await s.cache.resolve('scriptable', 50);
    s.cache.get('scriptable');
    s.cache.get('scriptable');
    expect(s.calls()).toBe(1);
  });

  it('serves the STALE verdict immediately and refreshes exactly once', async () => {
    // The scenario this protects: an operator uninstalls (or installs) a CLI.
    // The request path must not pay for the discovery, and N concurrent
    // requests must not produce N probes.
    const s = setup({ probe: (n) => ({ available: n === 1, version: `v${n}` }) });

    expect((await s.cache.resolve('scriptable', 50)).version).toBe('v1');
    s.advance(61_000); // past the TTL

    // First read after expiry: still the OLD value, no awaiting.
    const stale = s.cache.get('scriptable');
    expect(stale.version).toBe('v1');
    expect(stale.available).toBe(true);
    // …and the concurrent readers join the same in-flight probe.
    s.cache.get('scriptable');
    s.cache.get('scriptable');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls()).toBe(2);

    // The refreshed (negative) verdict is what the next caller sees.
    const fresh = s.cache.get('scriptable');
    expect(fresh.version).toBe('v2');
    expect(fresh.available).toBe(false);
    expect(s.calls()).toBe(2);
  });

  it('backs a failing probe off to one attempt per TTL, not one per read', async () => {
    const s = setup({ probe: () => ({ available: false, reason: 'not on PATH' }), ttlMs: 60_000 });
    await s.cache.resolve('scriptable', 50);
    for (let i = 0; i < 10; i++) s.cache.get('scriptable');
    expect(s.calls()).toBe(1);
    s.advance(60_001);
    s.cache.get('scriptable');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls()).toBe(2);
  });

  it('returns a PENDING placeholder rather than blocking past the cold deadline', async () => {
    // What bounds `GET /providers` on a cold cache. `pending` is the bit that
    // tells the 409 gate "we have not finished asking" — it must fail open.
    const s = setup({ probe: () => ({ available: true }), gated: true });
    const state = await s.cache.resolve('scriptable', 1);
    expect(state.pending).toBe(true);
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/in progress/);
    // The probe is still in flight; letting it finish updates the cache.
    s.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(s.cache.get('scriptable').pending).toBe(false);
    expect(s.cache.get('scriptable').available).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it('reports an unregistered id as unavailable instead of throwing', async () => {
    const s = setup({ probe: () => ({ available: true }) });
    const state = await s.cache.resolve('ghost', 50);
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/no adapter registered/);
  });

  it('contains a throwing adapter — a bad probe cannot poison the request path', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider({
        id: 'explodes',
        probe: () => Promise.reject(new Error('boom')),
      }),
    );
    const cache = new ProviderAvailabilityCache({ registry, config: CONFIG });
    const state = await cache.resolve('explodes', 200);
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/boom/);
  });

  it('resolveAll covers every registered provider under one deadline', async () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider({ id: 'a' }));
    registry.register(new FakeProvider({ id: 'b', probe: async () => ({ available: false, reason: 'nope' }) }));
    const cache = new ProviderAvailabilityCache({ registry, config: CONFIG });
    const all = await cache.resolveAll(200);
    expect([...all.keys()].sort()).toEqual(['a', 'b']);
    expect(all.get('a')?.available).toBe(true);
    expect(all.get('b')?.available).toBe(false);
    expect(all.get('b')?.reason).toBe('nope');
  });

  it('hands the adapter a budget bigger than a real CLI’s cold boot', async () => {
    // Lot 9a. The budget was 2 500 ms and `gemini --version` costs ~2 755 ms of
    // pure boot on this host (2 628 / 2 875 ms in spike C1, up to 3 991 ms for
    // `mcp list`): the probe timed out on EVERY poll and pinned gemini to
    // `available:false` for good — a provider permanently invisible because of a
    // constant, with a timeout as its only explanation.
    //
    // Frozen as a LITERAL floor rather than by reading the constant, so the test
    // cannot agree with a future regression. 4 s is where measured false
    // negatives start; 8 s keeps margin. Overrunning
    // `AVAILABILITY_COLD_WAIT_MS` is harmless BY DESIGN — the cache serves stale
    // and only the very first caller waits, for the cold-wait window, not for
    // this — which is the property the next assertion pins.
    expect(AVAILABILITY_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
    const s = setup({ probe: () => ({ available: true }) });
    await s.cache.resolve('scriptable', 50);
    expect(s.provider.probeCalls[0]?.timeoutMs).toBe(AVAILABILITY_PROBE_TIMEOUT_MS);
  });

  it('never makes a caller wait for the probe budget — only for the cold window', async () => {
    // The reason a 12 s probe budget is safe on a request path: a COLD key waits
    // the deadline the caller passed and then gets `pending`, while the probe
    // keeps running into the cache for the next call.
    const s = setup({ probe: () => ({ available: true }), gated: true });
    const t0 = Date.now();
    const state = await s.cache.resolve('scriptable', 30);
    expect(Date.now() - t0).toBeLessThan(AVAILABILITY_PROBE_TIMEOUT_MS);
    expect(state.pending).toBe(true);
    // `pending` is the value every consumer must fail OPEN on: refusing to create
    // a team because we have not finished asking is worse than letting the spawn
    // fail with the CLI's own error.
    expect(state.available).toBe(false);
    s.release();
  });

  it('keys verdicts by (provider, transport) — an ssh answer never answers a local question', async () => {
    // Same registry, two caches on different transports. A shared key would
    // make a CLI that only exists on the host read as installed in-container.
    const provider = new FakeProvider({
      id: 'split',
      probe: async (ctx) =>
        ctx.transport === 'ssh'
          ? { available: true, version: 'host' }
          : { available: false, reason: 'not in the container' },
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    const local = new ProviderAvailabilityCache({ registry, config: CONFIG, transport: 'local' });
    const ssh = new ProviderAvailabilityCache({ registry, config: CONFIG, transport: 'ssh' });
    expect((await local.resolve('split', 200)).available).toBe(false);
    expect((await ssh.resolve('split', 200)).available).toBe(true);
  });
});
