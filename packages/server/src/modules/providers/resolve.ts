/**
 * ONE resolution rule, shared by every channel that builds an agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 *
 *   A model id, an effort level and a permission mode only mean something for
 *   the provider that supplied them. An inherited value is therefore kept only
 *   when the layer that supplied it was authored for the provider that will
 *   ACTUALLY RUN; otherwise that provider's own `defaults()` decide. Whatever
 *   comes out is then coerced onto `capabilities.permissionModes`, because a
 *   mode the CLI cannot express must never be stored, persisted and displayed
 *   as if it were in force.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY IT IS NOT "did anyone name a value?". That older phrasing is what the
 * `POST /orchestrators` bug was made of: a role carrying `defaultModel:
 * 'claude-opus-4-8'` and NO `defaultProvider` (every role written before
 * multi-provider) counted as "someone named a model", so a request that flipped
 * the provider to gemini kept the claude id and produced
 * `gemini -m claude-opus-4-8` — a team whose lead dies inside its own PTY while
 * the UI reports `running`. The question that matters is not WHETHER a value
 * was named, it is WHICH PROVIDER named it.
 *
 * EACH LAYER HAS A PROVIDER, even when it does not name one: it inherits the
 * effective provider of the layer below (a role with no `defaultProvider` was
 * written against the instance default, so that is what its model belongs to).
 * A corollary worth stating because it is the safety property operators care
 * about: the TOP layer's effective provider is by construction the resolved
 * provider, so **a value named in the request itself is never replaced** — only
 * coerced when the CLI cannot express it. We never refuse a model string
 * (`docs/providers.md`: ids ship faster than our releases); we only choose the
 * right DEFAULT.
 *
 * Consumers — all of them, and the fact that it is all of them is the point:
 *   - `http/routes/orchestrators.ts`  `POST /orchestrators`        (body > role > config)
 *   - `modules/orchestrator/index.ts` `addWorker`                  (spec > team)
 *     …which is also `POST /orchestrators/:id/workers` and MCP `team.spawn_worker`
 *   - `modules/orchestrator/index.ts` `start()` / `resume()`       (team / persisted row)
 *   - `modules/plugins/api.ts`        `teams.create`               (role > config)
 */

import { withModule } from '../../logger.js';
import type { EffortLevel, PermissionMode } from '../../config.js';
import type { AgentProvider } from './types.js';

const log = withModule('providers');

/**
 * One source of defaults, e.g. the request body, a role row, the instance
 * config, a persisted session row. Layers are ordered MOST SPECIFIC FIRST.
 */
export interface AgentDefaultsLayer {
  /** Where these values came from (`'body'`, `'role'`, `'config'`, …). Logged. */
  source: string;
  /**
   * Provider this layer names, or `null` when it expresses no opinion — it then
   * inherits the effective provider of the layer below it.
   */
  provider?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode | null;
}

/** Marker used as a provenance value when nothing in the chain applied. */
export const PROVIDER_DEFAULT_SOURCE = 'provider-default';

export interface ResolvedAgentDefaults {
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** `source` of the layer each value came from, or `PROVIDER_DEFAULT_SOURCE`. */
  modelFrom: string;
  effortFrom: string;
  permissionModeFrom: string;
  /**
   * The mode that was asked for, when the provider could not express it and it
   * was coerced to `capabilities.fallbackPermissionMode`. `null` = no coercion.
   */
  permissionModeCoercedFrom: PermissionMode | null;
}

export interface ResolveAgentDefaultsRequest {
  /** The adapter that will actually run — NOT merely the one that was asked for. */
  provider: AgentProvider;
  /** Most specific first. */
  layers: readonly AgentDefaultsLayer[];
  /** Provider inherited by a layer when no layer at or below it names one. */
  fallbackProvider: string;
  /** Extra fields merged into the coercion log line (orch id, session id, …). */
  context?: Record<string, unknown>;
}

/** A value counts as "named" only when it is a non-empty string. */
function named<T>(v: T | null | undefined): v is T {
  return v != null && v !== '';
}

/**
 * Effective provider of `layers[index]`: its own, else the first one named
 * below it, else `fallbackProvider`.
 */
function effectiveProviderAt(
  layers: readonly AgentDefaultsLayer[],
  index: number,
  fallbackProvider: string,
): string {
  for (let i = index; i < layers.length; i++) {
    const p = layers[i]?.provider;
    if (named(p)) return p;
  }
  return fallbackProvider;
}

/**
 * The provider id the chain resolves to: the topmost layer that names one, else
 * `fallbackProvider`. (Which is exactly the effective provider of layer 0 —
 * stated as its own function because ingress has to validate this id, and
 * reject or 409 on it, BEFORE an adapter exists to pass to
 * `resolveAgentDefaults`.)
 */
export function resolveProviderId(
  layers: readonly AgentDefaultsLayer[],
  fallbackProvider: string,
): string {
  return effectiveProviderAt(layers, 0, fallbackProvider);
}

/** First layer that names this field AND belongs to the running provider. */
function pickScoped<T>(
  layers: readonly AgentDefaultsLayer[],
  fallbackProvider: string,
  runningProviderId: string,
  read: (l: AgentDefaultsLayer) => T | null | undefined,
): { value: T; source: string } | null {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer) continue;
    const value = read(layer);
    if (!named(value)) continue;
    if (effectiveProviderAt(layers, i, fallbackProvider) !== runningProviderId) continue;
    return { value, source: layer.source };
  }
  return null;
}

/**
 * Apply THE RULE (see the file header) and return a tuple that is coherent with
 * `provider` by construction.
 *
 * Note that the scoping test compares against `provider.id` — the adapter that
 * will run — and not against the id the caller asked for. They differ only on
 * the `Orchestrator._resolveProvider` fallback path (a row written by a newer
 * version, a plugin adapter that has not re-registered). On that path dropping
 * the values is the whole point: they were authored for a CLI that is not the
 * one about to be exec'd.
 */
export function resolveAgentDefaults(req: ResolveAgentDefaultsRequest): ResolvedAgentDefaults {
  const { provider, layers, fallbackProvider } = req;
  const own = provider.defaults();

  const model = pickScoped(layers, fallbackProvider, provider.id, (l) => l.model);
  const effort = pickScoped(layers, fallbackProvider, provider.id, (l) => l.effort);
  const perm = pickScoped(layers, fallbackProvider, provider.id, (l) => l.permissionMode);

  let permissionMode: PermissionMode = perm?.value ?? own.permissionMode;
  let permissionModeCoercedFrom: PermissionMode | null = null;
  // The contract in `types.ts`: "anything else is coerced to
  // fallbackPermissionMode". Until now the only coercion in the product happened
  // in the browser (`web/ProviderFields.tsx`), so an API caller could create a
  // codex team that STORED, PERSISTED and DISPLAYED `plan` while running under
  // `--dangerously-bypass-approvals-and-sandbox`. The gap between what the panel
  // says and what the agent does is the defect; closing it here means every
  // channel closes it, including the ones written after this comment.
  if (!provider.capabilities.permissionModes.includes(permissionMode)) {
    permissionModeCoercedFrom = permissionMode;
    permissionMode = provider.capabilities.fallbackPermissionMode;
    log.warn({
      event: 'provider.permission_mode_coerced',
      provider: provider.id,
      requested: permissionModeCoercedFrom,
      applied: permissionMode,
      requestedFrom: perm?.source ?? PROVIDER_DEFAULT_SOURCE,
      supported: [...provider.capabilities.permissionModes],
      ...req.context,
    });
  }

  return {
    model: model?.value ?? own.model,
    effort: effort?.value ?? own.effort,
    permissionMode,
    modelFrom: model?.source ?? PROVIDER_DEFAULT_SOURCE,
    effortFrom: effort?.source ?? PROVIDER_DEFAULT_SOURCE,
    permissionModeFrom: perm?.source ?? PROVIDER_DEFAULT_SOURCE,
    permissionModeCoercedFrom,
  };
}
