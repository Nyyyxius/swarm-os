/**
 * Per-session team-comms tool filtering (docs/outils-par-role.md, v0.10.2).
 *
 * The MCP server rebuilds its `SdkMcpServer` on EVERY request with the calling
 * session's context, so deciding which tools a session sees is a matter of not
 * registering the others. Two rules, in this order:
 *
 *   1. a WORKER never sees a lead-only tool — they were always refused at call
 *      time (`requireLead`), so listing them only cost context and invited
 *      failed calls;
 *   2. when the team's role sets an allow-list for that kind of agent, only
 *      the listed tools are registered — plus `MCP_CORE_TOOLS`, which no list
 *      can remove (an agent must always be able to find its lead, read its
 *      mailbox, report and compact itself).
 *
 * Filtering happens at REGISTRATION: `registerTool` calls for filtered-out
 * names are dropped by a proxy, so every `register*Tools` function keeps its
 * signature and nothing downstream has to know about the policy.
 */
import type { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_CORE_TOOLS } from '../roles/index.js';

/**
 * Built-in team-comms tools every call of which a worker is refused
 * (`requireLead` in the handler, unconditionally). Tools that are only
 * PARTLY lead-only stay visible to workers: `board.assign` (self-assignment is
 * open), `board.list` / `board.get` (cross-team reads only are lead-only),
 * `discord.send_message` (a worker may post inside a thread).
 */
export const LEAD_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
  'team.spawn_worker',
  'team.kill_worker',
  'team.kill_all_workers',
  'team.clear_worker',
  'swarm.list_teams',
  'swarm.send_to_lead',
  'swarm.broadcast_to_leads',
  'discord.create_thread',
  'memory.delete',
  'board.teams',
  'board.delete',
  'skills.activate',
  'skills.deactivate',
]);

/**
 * Canonical comparison key of a tool name. Operators may write the dotted
 * registered name (`team.send_message`), the model-facing one with dots
 * sanitised (`team_send_message`) or the fully qualified one Claude Code shows
 * (`mcp__team-comms__team_send_message`); all three must match.
 */
export function mcpToolKey(name: string): string {
  return name.trim().replace(/^mcp__team-comms__/, '').replace(/\./g, '_');
}

export interface McpToolPolicy {
  /** Whether the calling session is its team's lead. */
  isLead: boolean;
  /** The role's allow-list for this kind of agent; `null` = every tool. */
  allowList: readonly string[] | null;
  /** Plugin tools declared `leadOnly` (qualified names). */
  pluginLeadOnly?: readonly string[];
}

/** Build the per-request predicate: may this session see tool `name`? */
export function mcpToolPredicate(policy: McpToolPolicy): (name: string) => boolean {
  const core = new Set(MCP_CORE_TOOLS.map(mcpToolKey));
  const leadOnly = new Set(
    [...LEAD_ONLY_MCP_TOOLS, ...(policy.pluginLeadOnly ?? [])].map(mcpToolKey),
  );
  const allowed = policy.allowList ? new Set(policy.allowList.map(mcpToolKey)) : null;
  return (name: string): boolean => {
    const key = mcpToolKey(name);
    if (core.has(key)) return true;
    if (!policy.isLead && leadOnly.has(key)) return false;
    return allowed === null || allowed.has(key);
  };
}

/**
 * Wrap `server` so that `registerTool` silently skips names the predicate
 * rejects. The returned object is used ONLY to register tools; the transport
 * is connected to the real server.
 */
export function filteredRegistrar(
  server: SdkMcpServer,
  allow: (name: string) => boolean,
): SdkMcpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]): unknown => {
          if (!allow(name)) return undefined;
          return (target.registerTool as (...a: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
