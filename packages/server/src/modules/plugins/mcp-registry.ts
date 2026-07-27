/**
 * PluginToolRegistry — dynamic MCP tools exposed to agents (plan §J2).
 *
 * The `SdkMcpServer` is rebuilt PER REQUEST in `McpServer.handle()`, so there
 * is nothing to invalidate on enable/disable: the registry is a mutable
 * `Map<qualifiedName, RegisteredTool>` consulted at request time via
 * `registerAll(sdkServer, ctxResolver)` — called one line after
 * `registerTeamCommsTools`.
 *
 * Each plugin tool is exposed as `<pluginName>.<tool>` (the SDK accepts dots,
 * cf. `team.whoami`). The per-request wrapper:
 *   1. applies the existing `requireLead` guard when `leadOnly`;
 *   2. projects the real `ToolContext` down to a `PluginToolContext` (a plugin
 *      NEVER receives session_secret / Orchestrator / Spawner handles);
 *   3. runs the plugin handler through the host `guard()` (a plugin throw is
 *      charged to the crash counter, NEVER escapes) and returns a clean MCP
 *      error result instead of throwing;
 *   4. envelopes a success payload with `ok()`.
 */

import type { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, requireLead, type ToolContext } from '../mcp/tools.js';
import type { PluginGuard } from './api.js';
import type { PluginToolDef, PluginToolContext } from './api-types.js';
import type { PluginToolSummary } from '../orchestrator/preamble.js';
import { withModule } from '../../logger.js';

const log = withModule('plugins.mcp');

interface RegisteredTool {
  pluginName: string;
  qualifiedName: string;
  def: PluginToolDef;
  /** Bound to the plugin + activation epoch — swallows/charges plugin throws. */
  guard: PluginGuard;
}

/** Project the real MCP context down to the plugin-safe subset. */
function projectContext(ctx: ToolContext): PluginToolContext {
  return {
    orchestratorId: ctx.orchestrator.id,
    orchestratorName: ctx.orchestrator.name,
    sessionId: ctx.session.id,
    sessionName: ctx.session.name,
    role: ctx.session.role,
    isLead: ctx.session.id === ctx.orchestrator.leadSessionId,
  };
}

/** A clean MCP `isError` result — used when the plugin handler crashes. */
function pluginErrorResult(qualifiedName: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: `PLUGIN_ERROR: tool ${qualifiedName} failed (see server logs)`,
      },
    ],
    isError: true,
  };
}

export class PluginToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly byPlugin = new Map<string, Set<string>>();

  /**
   * Register a plugin tool. Returns a Disposable that removes it (the plugin's
   * DisposableStore calls this at disable). The qualified name is
   * `<pluginName>.<def.name>`.
   */
  register(
    pluginName: string,
    def: PluginToolDef,
    guard: PluginGuard,
  ): { dispose(): void } {
    const qualifiedName = `${pluginName}.${def.name}`;
    this.tools.set(qualifiedName, { pluginName, qualifiedName, def, guard });
    let set = this.byPlugin.get(pluginName);
    if (!set) {
      set = new Set();
      this.byPlugin.set(pluginName, set);
    }
    set.add(qualifiedName);
    log.info({ event: 'plugins.tool_registered', plugin: pluginName, tool: qualifiedName });
    return {
      dispose: () => {
        // Only delete if still the SAME registration (a reload swaps in a new
        // one under the same qualified name — don't clobber the fresh entry).
        if (this.tools.get(qualifiedName)?.guard === guard) {
          this.tools.delete(qualifiedName);
        }
        const s = this.byPlugin.get(pluginName);
        s?.delete(qualifiedName);
        if (s && s.size === 0) this.byPlugin.delete(pluginName);
      },
    };
  }

  /** True when the plugin currently has at least one registered tool. */
  has(pluginName: string): boolean {
    return (this.byPlugin.get(pluginName)?.size ?? 0) > 0;
  }

  /** Diagnostics — count of registered tools across all plugins. */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Snapshot for the session preamble — see `buildPluginToolsSection`.
   *
   * A COPY, not a view: the spawner reads this once per session and the map
   * keeps mutating as plugins are enabled and disabled underneath it.
   */
  list(): PluginToolSummary[] {
    return [...this.tools.values()].map((t) => ({
      pluginName: t.pluginName,
      qualifiedName: t.qualifiedName,
      title: typeof t.def.title === 'string' ? t.def.title : '',
      leadOnly: t.def.leadOnly === true,
    }));
  }

  /**
   * Register every plugin tool onto a freshly-built `SdkMcpServer`. Called by
   * `McpServer.handle()` per request, one line after `registerTeamCommsTools`.
   * `ctxResolver` returns the per-call MCP `ToolContext`.
   */
  registerAll(sdkServer: SdkMcpServer, ctxResolver: () => ToolContext): void {
    for (const t of this.tools.values()) {
      this.registerOne(sdkServer, t, ctxResolver);
    }
  }

  private registerOne(
    sdkServer: SdkMcpServer,
    t: RegisteredTool,
    ctxResolver: () => ToolContext,
  ): void {
    const hasOutput = t.def.outputSchema !== undefined;
    sdkServer.registerTool(
      t.qualifiedName,
      {
        title: t.def.title,
        description: t.def.description,
        inputSchema: t.def.inputSchema,
        ...(t.def.outputSchema ? { outputSchema: t.def.outputSchema } : {}),
      },
      async (args: Record<string, unknown>) => {
        const ctx = ctxResolver();
        // Lead-only gate: a clean MCP permission error, NOT a plugin crash.
        if (t.def.leadOnly) requireLead(ctx, t.qualifiedName);
        const pctx = projectContext(ctx);
        // Run the plugin handler through the host guard: a throw (sync) or a
        // rejection (async) is charged to the crash counter and swallowed —
        // the guarded call resolves to `undefined` on failure, never throws.
        const guarded = t.guard('mcp.tool', (a: Record<string, unknown>) =>
          t.def.handler(a, pctx),
        );
        let result: unknown;
        try {
          result = await guarded(args);
        } catch {
          // Belt-and-suspenders: guard shouldn't throw, but never let it escape.
          result = undefined;
        }
        if (result === undefined || result === null || typeof result !== 'object') {
          return pluginErrorResult(t.qualifiedName);
        }
        // With an outputSchema the SDK validates `structuredContent`, so emit
        // both channels via ok(); without one, a plain text content is safest.
        return hasOutput
          ? ok(result as Record<string, unknown>)
          : { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );
  }
}
