/**
 * Provider availability — a lazy, TTL'd, serve-stale-and-refresh cache.
 *
 * Mechanics copied from `modules/updates/index.ts` (`maybeRefresh` / `refresh`
 * / single-flight `inflight`, injectable clock), for the same reason: the value
 * is served on a request path that must never block on the network, and a
 * failing check must back off to one attempt per TTL rather than one per poll.
 *
 * Why a runtime cache and NOT a boot-time probe — this is the load-bearing
 * point. This deployment runs 24/7 and is not restarted to pick up a host-side
 * change. An operator who `npm i -g`'s a CLI on the host must see the provider
 * light up at the NEXT poll, with no container restart. A boot-only probe
 * would make "install the CLI" a two-step operation whose second step is
 * "recreate the container", and nobody would connect the two.
 *
 * Keyed by `(providerId, transport)`. Transport is constant for a given
 * process today (`config.agentTransport`), but the key carries it anyway: an
 * availability verdict is a statement about a CLI *at a location*, and caching
 * a local verdict under an SSH question is exactly the class of bug that makes
 * a provider look installed when it is not.
 */

import { withModule } from '../../logger.js';
import type { AgentTransport, Config } from '../../config.js';
import type { ProviderRegistry } from './registry.js';
import type { ProviderAvailability, ProviderId } from './types.js';

const log = withModule('providers');

/** How long a completed verdict is served without re-probing. */
export const AVAILABILITY_TTL_MS = 60_000;
/**
 * How long a caller waits on a COLD key (nothing cached at all) before it gets
 * the pending placeholder instead. Bounds `GET /providers` on first hit; the
 * probe keeps running and lands in the cache for the next call.
 */
export const AVAILABILITY_COLD_WAIT_MS = 3_000;
/**
 * Per-probe budget handed to the adapter.
 *
 * DELIBERATELY ABOVE `AVAILABILITY_COLD_WAIT_MS`, which is the opposite of what
 * this constant used to be (2 500 ms, "below the cold wait, on purpose"). That
 * value was measured to be unusable: a `gemini --version` costs ~2 755 ms of
 * pure boot on this host (2 628 / 2 875 ms in spike C1; 2 920–3 991 ms for
 * `mcp list`), so a 2 500 ms budget timed out on EVERY poll and pinned gemini to
 * `available:false` forever — a provider permanently invisible because of a
 * constant, with a timeout as its explanation.
 *
 * Overrunning the cold wait costs nothing: the cache is
 * serve-stale-and-refresh, so only the very FIRST caller for a key waits at all,
 * it waits `AVAILABILITY_COLD_WAIT_MS` and not this, and it gets `pending: true`
 * (which every consumer is required to fail OPEN on — see
 * `ProviderAvailabilityState`). The probe keeps running in the background and
 * the verdict is there for the next call, one TTL ahead of the poll that needs
 * it. So the budget is sized on how slow a CLI can legitimately be, not on how
 * long an HTTP request may block.
 *
 * 12 s: four times the slowest measured cold `--version`, and comfortably under
 * the 60 s TTL so a hanging probe can never overlap the next refresh (the
 * single-flight guard would coalesce it anyway).
 */
export const AVAILABILITY_PROBE_TIMEOUT_MS = 12_000;

/**
 * A verdict, plus the two bits a consumer needs to know how much to trust it.
 *
 * `pending: true` means NO probe has completed for this key yet — `available`
 * is a placeholder, not an answer. Callers that gate on unavailability (the
 * 409 in `POST /orchestrators`) MUST fail open on a pending entry: refusing to
 * create a team because we have not finished asking is worse than letting a
 * spawn fail with the CLI's own error.
 */
export interface ProviderAvailabilityState extends ProviderAvailability {
  /** Epoch ms of the last completed probe; `null` when never probed. */
  checkedAtMs: number | null;
  pending: boolean;
}

interface Entry {
  value: ProviderAvailabilityState;
  /** Single-flight guard: at most one probe per key at a time. */
  inflight: Promise<void> | null;
}

export interface ProviderAvailabilityCacheOptions {
  registry: ProviderRegistry;
  config: Config;
  /** Overrides `config.agentTransport` (tests). */
  transport?: AgentTransport;
  ttlMs?: number;
  /** Injectable clock — same seam as `UpdateService`. */
  now?: () => number;
  probeTimeoutMs?: number;
}

const PENDING_REASON = 'availability probe in progress';

export class ProviderAvailabilityCache {
  private readonly entries = new Map<string, Entry>();
  private readonly registry: ProviderRegistry;
  private readonly config: Config;
  private readonly transport: AgentTransport;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;

  constructor(opts: ProviderAvailabilityCacheOptions) {
    this.registry = opts.registry;
    this.config = opts.config;
    this.transport = opts.transport ?? opts.config.agentTransport;
    this.ttlMs = opts.ttlMs ?? AVAILABILITY_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.probeTimeoutMs = opts.probeTimeoutMs ?? AVAILABILITY_PROBE_TIMEOUT_MS;
  }

  private key(id: ProviderId): string {
    return `${id}@${this.transport}`;
  }

  private entry(id: ProviderId): Entry {
    const k = this.key(id);
    let e = this.entries.get(k);
    if (!e) {
      e = {
        value: {
          available: false,
          reason: PENDING_REASON,
          checkedAtMs: null,
          pending: true,
        },
        inflight: null,
      };
      this.entries.set(k, e);
    }
    return e;
  }

  /**
   * Serve the cached verdict (possibly stale) and schedule a refresh if the
   * TTL has expired. Synchronous by construction — never awaits a probe.
   */
  get(id: ProviderId): ProviderAvailabilityState {
    void this.maybeRefresh(id);
    return this.entry(id).value;
  }

  /**
   * Like `get`, but on a COLD key waits up to `timeoutMs` for the first probe.
   * A stale-but-known key returns immediately with the old value while the
   * refresh runs in the background — serve-stale-and-refresh.
   */
  async resolve(
    id: ProviderId,
    timeoutMs: number = AVAILABILITY_COLD_WAIT_MS,
  ): Promise<ProviderAvailabilityState> {
    const pending = this.maybeRefresh(id);
    if (pending && this.entry(id).value.pending) {
      await raceDeadline(pending, timeoutMs);
    }
    return this.entry(id).value;
  }

  /**
   * Every registered provider at once, under ONE shared deadline — so a cold
   * `GET /providers` with four adapters costs `timeoutMs`, not 4×.
   */
  async resolveAll(
    timeoutMs: number = AVAILABILITY_COLD_WAIT_MS,
  ): Promise<Map<ProviderId, ProviderAvailabilityState>> {
    const ids = this.registry.list().map((p) => p.id);
    const waits: Array<Promise<void>> = [];
    for (const id of ids) {
      const p = this.maybeRefresh(id);
      if (p && this.entry(id).value.pending) waits.push(p);
    }
    if (waits.length > 0) {
      await raceDeadline(Promise.all(waits).then(() => undefined), timeoutMs);
    }
    const out = new Map<ProviderId, ProviderAvailabilityState>();
    for (const id of ids) out.set(id, this.entry(id).value);
    return out;
  }

  /** Drop every cached verdict (tests; also handy after a registry change). */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Returns the in-flight probe when one is running or was just started, and
   * `null` when the cached value is still fresh. Mirrors
   * `UpdateService.maybeRefresh`.
   */
  private maybeRefresh(id: ProviderId): Promise<void> | null {
    const e = this.entry(id);
    if (e.inflight !== null) return e.inflight;
    if (e.value.checkedAtMs !== null && this.now() - e.value.checkedAtMs < this.ttlMs) {
      return null;
    }
    return this.refresh(id);
  }

  /** Never throws, never rejects. Advances the clock whatever happens. */
  private refresh(id: ProviderId): Promise<void> {
    const e = this.entry(id);
    if (e.inflight !== null) return e.inflight;
    e.inflight = this.runProbe(id).finally(() => {
      e.inflight = null;
    });
    return e.inflight;
  }

  private async runProbe(id: ProviderId): Promise<void> {
    const provider = this.registry.get(id);
    let result: ProviderAvailability;
    if (!provider) {
      result = { available: false, reason: `no adapter registered for '${id}'` };
    } else {
      try {
        result = await provider.probe({
          transport: this.transport,
          config: this.config,
          timeoutMs: this.probeTimeoutMs,
        });
      } catch (err) {
        // The contract says probe() must not throw; a throwing adapter is a
        // bug, not a reason to poison the request path.
        result = {
          available: false,
          reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
        };
        log.warn({ event: 'providers.probe_threw', provider: id, error: String(err) });
      }
    }
    const e = this.entry(id);
    const was = e.value.pending ? null : e.value.available;
    e.value = { ...result, checkedAtMs: this.now(), pending: false };
    if (was !== result.available) {
      log.info({
        event: 'providers.availability',
        provider: id,
        transport: this.transport,
        available: result.available,
        version: result.version ?? null,
        reason: result.reason ?? null,
      });
    }
  }
}

/**
 * Resolve when `p` settles or when `ms` elapses, whichever comes first. The
 * timer is `unref`'d and cleared so a pending probe can never hold the process
 * open (or leak a handle into a vitest run).
 */
function raceDeadline(p: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
