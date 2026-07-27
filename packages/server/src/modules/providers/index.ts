/**
 * Agent providers — public surface of the module.
 *
 * Lot 1 shipped one working adapter (claude) behind the abstraction. Lot 2 adds
 * the plumbing that makes `provider` a first-class field — the DB column, the
 * config knob, `GET /providers`, the availability cache — plus the three
 * adapter STUBS (codex / gemini / opencode). The stubs are registered and
 * report themselves unavailable, so:
 *   - the operator sees every provider the product knows about, with a reason
 *     for the ones that cannot be used yet;
 *   - Lots 4/5/6 each touch exactly ONE file (`providers/<their>.ts`) and no
 *     shared file at all.
 */

export * from './types.js';
export { ProviderRegistry, type ProviderTypeInfo } from './registry.js';
export {
  buildClaudeArgs,
  ClaudeProvider,
  CLAUDE_PROVIDER,
  CLAUDE_SHARED_ENTRIES,
} from './claude.js';
export { CodexProvider, CODEX_SHARED_ENTRIES, CODEX_EFFORT_MAP } from './codex.js';
export { GeminiProvider, GEMINI_SHARED_ENTRIES } from './gemini.js';
export { OpencodeProvider, OPENCODE_SHARED_ENTRIES } from './opencode.js';
export { buildNotificationHookCommand, linkSharedState } from './session-config.js';
export { probeCliBinary, PROBE_DEFAULT_TIMEOUT_MS } from './probe.js';
export {
  resolveAgentDefaults,
  resolveProviderId,
  PROVIDER_DEFAULT_SOURCE,
  type AgentDefaultsLayer,
  type ResolvedAgentDefaults,
} from './resolve.js';
export {
  ProviderAvailabilityCache,
  AVAILABILITY_TTL_MS,
  AVAILABILITY_COLD_WAIT_MS,
  type ProviderAvailabilityState,
} from './availability.js';
export {
  BUILTIN_PROVIDER_DEFAULT_MODELS,
  BUILTIN_PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
  builtinDefaultModel,
  type BuiltinProviderId,
} from './ids.js';

import type { Config } from '../../config.js';
import { ProviderRegistry } from './registry.js';
import { CLAUDE_PROVIDER } from './claude.js';
import { CodexProvider } from './codex.js';
import { GeminiProvider } from './gemini.js';
import { OpencodeProvider } from './opencode.js';

/**
 * The built-in registry. Built-ins are registered first and cannot be shadowed
 * by a plugin (see `ProviderRegistry.register`).
 *
 * `config` is what carries the host-side state dirs (`hostCodexDir`,
 * `hostGeminiDir`, `hostOpencodeDir`) into the adapters that need them: under
 * SSH those are the roots the per-session symlinks point at, and each adapter
 * has its OWN — mixing them up produces an agent that starts and is not
 * authenticated. It is optional only so unit tests can build a registry
 * without a full Config; production callers (`Spawner`, boot) always pass one.
 */
export function createBuiltinProviderRegistry(config?: Config): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(CLAUDE_PROVIDER, { builtin: true });
  registry.register(new CodexProvider(config), { builtin: true });
  registry.register(new GeminiProvider(config), { builtin: true });
  registry.register(new OpencodeProvider(config), { builtin: true });
  return registry;
}
