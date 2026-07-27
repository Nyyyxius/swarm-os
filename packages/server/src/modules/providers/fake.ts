/**
 * TEST-ONLY provider adapter.
 *
 * Lives in `src/` rather than next to a single test file because several test
 * suites need it (and because a provider is exactly the seam that lets a test
 * drive `Session` without a real CLI on PATH). It is never registered in
 * `createBuiltinProviderRegistry` and nothing in the production graph imports
 * it.
 *
 * Its purpose is to exercise the branches claude never takes: no Ink submit
 * dance, no context reset, no MCP artifact, no config dir.
 */

import type { EffortLevel, PermissionMode } from '../../config.js';
import type {
  AgentProvider,
  ContextResetCommand,
  McpCleanupRequest,
  McpWriteRequest,
  McpWriteResult,
  PreparedSpawn,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderModel,
  ProviderProbeContext,
  RuntimeInitOptions,
  RuntimeInitOutcome,
  SessionConfigRequest,
  SessionConfigResult,
  SpawnRequest,
} from './types.js';

const BASE_CAPABILITIES: ProviderCapabilities = {
  effort: true,
  permissionModes: ['bypassPermissions', 'default'],
  fallbackPermissionMode: 'bypassPermissions',
  // Claude-like by default: the callback means "a human is needed", which is the
  // only semantic that flips the badge / notifies. Tests that need the other two
  // branches pass `capabilities: { notificationHook: 'turn-complete' | false }`.
  notificationHook: 'needs-human',
  inkSubmitDance: true,
  durablePreamble: true,
  httpMcp: true,
};

export interface FakeProviderOptions {
  id?: string;
  label?: string;
  binary?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Override the reset line; return `null` to model "no context reset". */
  contextResetLine?: (cmd: ContextResetCommand, instructions?: string) => string | null;
  /**
   * Override the MCP tool naming. Defaults to identity (claude-like); a test
   * that needs the renaming branch of the preamble renderer passes something
   * like `(n) => \`x_${n.replace(/\./g, '_')}\``.
   */
  mcpToolName?: (logicalName: string) => string;
  /**
   * Availability answer. A function so an availability test can count calls,
   * delay a probe, or flip the verdict between two TTL windows. Defaults to
   * "available, no version".
   */
  probe?: (ctx: ProviderProbeContext) => Promise<ProviderAvailability>;
  /**
   * Phase-A answer. Lets a test model a provider with a per-session config dir
   * to clean up (codex, from Lot 4) — claude returns no cleanup paths, so that
   * branch of `Session` has no other way to be exercised.
   */
  sessionConfig?: (req: SessionConfigRequest) => SessionConfigResult;
  /**
   * Secrets to return from `buildSpawn`. `Session` routes these into a 0600 file
   * the remote shell sources instead of putting them on the remote command line
   * (opencode, from Lot 6a) — claude has none, so that branch has no other way
   * to be exercised.
   */
  secretEnv?: Record<string, string>;
  /** Non-secret env to return from `buildSpawn`. */
  env?: Record<string, string>;
  /**
   * Make `buildSpawn` throw. Models an adapter refusing to launch a
   * half-configured agent (every non-claude adapter does this when its config dir
   * is missing), which is the only way to reach `Session`'s failed-spawn path
   * without a real binary.
   */
  buildSpawnError?: string;
}

export class FakeProvider implements AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly binary: string;
  readonly capabilities: ProviderCapabilities;
  /** Every call recorded, so a test can assert on the request shape. */
  readonly spawnRequests: SpawnRequest[] = [];
  readonly configRequests: SessionConfigRequest[] = [];
  /**
   * `removeMcpConfig` calls. Recorded because the interesting property is that it
   * is called AT ALL: `Session._cleanupMcpConfig` used to skip it for any provider
   * whose `writeMcpConfig` returns null — which is every inline-config provider,
   * and this fake is one.
   */
  readonly mcpCleanupRequests: McpCleanupRequest[] = [];
  /** Every probe recorded, so a test can assert on call COUNT (TTL / single-flight). */
  readonly probeCalls: ProviderProbeContext[] = [];
  private readonly _contextResetLine: (
    cmd: ContextResetCommand,
    instructions?: string,
  ) => string | null;
  private readonly _probe: (ctx: ProviderProbeContext) => Promise<ProviderAvailability>;
  private readonly _sessionConfig: (req: SessionConfigRequest) => SessionConfigResult;
  private readonly _opts: FakeProviderOptions;

  constructor(opts: FakeProviderOptions = {}) {
    this._opts = opts;
    this.id = opts.id ?? 'fake';
    this.label = opts.label ?? 'Fake Provider';
    this.binary = opts.binary ?? 'fake-agent';
    this.capabilities = { ...BASE_CAPABILITIES, ...opts.capabilities };
    this._contextResetLine =
      opts.contextResetLine ??
      ((cmd, instructions) => (instructions ? `${cmd} ${instructions}` : cmd));
    this._probe = opts.probe ?? (() => Promise.resolve({ available: true }));
    this._sessionConfig =
      opts.sessionConfig ?? (() => ({ configDir: null, cleanupPaths: [] }));
  }

  models(): readonly ProviderModel[] {
    return [{ value: 'fake-model', label: 'Fake Model' }];
  }

  defaults(): { model: string; effort: EffortLevel; permissionMode: PermissionMode } {
    return { model: 'fake-model', effort: 'low', permissionMode: 'bypassPermissions' };
  }

  prepareSessionConfig(req: SessionConfigRequest): SessionConfigResult {
    this.configRequests.push(req);
    return this._sessionConfig(req);
  }

  writeMcpConfig(_req: McpWriteRequest): McpWriteResult | null {
    return null;
  }

  removeMcpConfig(req: McpCleanupRequest): void {
    this.mcpCleanupRequests.push(req);
  }

  buildSpawn(req: SpawnRequest): PreparedSpawn {
    this.spawnRequests.push(req);
    if (this._opts.buildSpawnError) throw new Error(this._opts.buildSpawnError);
    return {
      command: this.binary,
      args: [],
      env: this._opts.env ?? {},
      ...(this._opts.secretEnv ? { secretEnv: this._opts.secretEnv } : {}),
    };
  }

  contextResetLine(cmd: ContextResetCommand, instructions?: string): string | null {
    return this._contextResetLine(cmd, instructions);
  }

  mcpToolName(logicalName: string): string {
    return this._opts.mcpToolName ? this._opts.mcpToolName(logicalName) : logicalName;
  }

  initRuntime(_opts: RuntimeInitOptions): RuntimeInitOutcome {
    return { initialized: false, copied: false, skipReason: 'not-applicable' };
  }

  refreshSharedFiles(_opts: RuntimeInitOptions): void {
    /* no shared files */
  }

  probe(ctx: ProviderProbeContext): Promise<ProviderAvailability> {
    this.probeCalls.push(ctx);
    return this._probe(ctx);
  }
}
