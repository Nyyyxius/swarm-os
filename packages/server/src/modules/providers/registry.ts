/**
 * ProviderRegistry — the set of agent providers a team can be built from.
 *
 * Shape copied from `plugins/connector-registry.ts`: a mutable `Map<id, entry>`
 * whose built-in entries cannot be shadowed, plus a `list()` the UI reads. The
 * reason it is a registry rather than a plain constant is that a provider must
 * eventually be registrable by a plugin — but NOT through `SwarmPluginApi`: an
 * adapter drives deep `Session` internals, and exposing those would publish
 * half of `session.ts` as a stable API.
 *
 * Deliberately NOT async and NOT probing: availability lives in
 * `providers/availability.ts` (Lot 2) so this stays a pure lookup table.
 */

import type { Disposable } from '../plugins/api-types.js';
import { withModule } from '../../logger.js';
import type { AgentProvider, ProviderId } from './types.js';

const log = withModule('providers');

/** Metadata surfaced to the UI for one registered provider. */
export interface ProviderTypeInfo {
  id: ProviderId;
  label: string;
  binary: string;
  /** True for host-provided adapters; false for plugin-provided ones. */
  builtin: boolean;
}

interface RegisterMeta {
  builtin?: boolean;
}

interface Registered {
  provider: AgentProvider;
  info: ProviderTypeInfo;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, Registered>();

  /**
   * Register `provider` under its own id. Returns a `Disposable` that removes
   * it again. A built-in id cannot be shadowed — the override throws so a
   * plugin's enable fails cleanly instead of silently swapping the adapter
   * every live session is about to be respawned with.
   */
  register(provider: AgentProvider, meta: RegisterMeta = {}): Disposable {
    const id = provider.id;
    const existing = this.providers.get(id);
    if (existing?.info.builtin) {
      throw new Error(`provider '${id}' is reserved by a built-in adapter`);
    }
    // A provider whose preamble does not survive a context reset produces an
    // agent with tools and no discipline — visibly alive, behaving at random.
    // Refuse it at the door rather than discover it after a `/clear`.
    if (!provider.capabilities.durablePreamble) {
      throw new Error(`provider '${id}' has no durable preamble — refusing to register`);
    }
    if (!provider.capabilities.httpMcp) {
      throw new Error(`provider '${id}' cannot reach the team-comms MCP over HTTP`);
    }
    // `permissionModes` invariants (see `ProviderCapabilities.permissionModes`):
    // never empty, and it must contain the coercion target. Enforced here rather
    // than documented only, so "no permission vocabulary" is always spelled
    // `[fallback]` and a consumer can read `length === 1` as "not a choice"
    // without a second, easily-forgotten empty-array branch.
    const modes = provider.capabilities.permissionModes;
    if (modes.length === 0) {
      throw new Error(
        `provider '${id}' declares no permission mode — an adapter that has no ` +
          'permission vocabulary must list exactly its fallbackPermissionMode',
      );
    }
    if (!modes.includes(provider.capabilities.fallbackPermissionMode)) {
      throw new Error(
        `provider '${id}' has fallbackPermissionMode ` +
          `'${provider.capabilities.fallbackPermissionMode}' outside its permissionModes ` +
          `[${modes.join(', ')}] — the coercion target must be a mode the CLI accepts`,
      );
    }
    const entry: Registered = {
      provider,
      info: {
        id,
        label: provider.label,
        binary: provider.binary,
        builtin: meta.builtin ?? false,
      },
    };
    this.providers.set(id, entry);
    log.info({ event: 'providers.registered', provider: id, builtin: entry.info.builtin });
    return {
      dispose: () => {
        // Only remove if still OUR entry (a re-register may have swapped it).
        const cur = this.providers.get(id);
        if (cur !== entry) return;
        this.providers.delete(id);
        log.info({ event: 'providers.unregistered', provider: id });
      },
    };
  }

  get(id: ProviderId): AgentProvider | null {
    return this.providers.get(id)?.provider ?? null;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /** Every registered adapter, registration order preserved. */
  list(): AgentProvider[] {
    return [...this.providers.values()].map((r) => r.provider);
  }

  /** Metadata for every registered adapter — the payload of `GET /providers`. */
  types(): ProviderTypeInfo[] {
    return [...this.providers.values()].map((r) => r.info);
  }
}
