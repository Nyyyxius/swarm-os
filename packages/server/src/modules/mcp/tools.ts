import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Spawner } from '../spawner/index.js';
import type { Session } from '../orchestrator/session.js';
import type { Orchestrator } from '../orchestrator/index.js';

/**
 * MCP team-comms tools (plan §10).
 *
 * Phase 2 implements the read-only tools (`team.whoami`, `team.list`) and
 * registers the rest as **explicit "not implemented" placeholders** so a
 * curious agent invoking `team.spawn_worker` etc. gets a clear, actionable
 * MCP error instead of a confusing "tool not found" / method-not-found.
 *
 * Authentication: every call is bound to a Session via `(orchestrator,
 * session)` resolved by `McpServer.routeRequest()` from the path
 * `/mcp/:orch_id/:session_secret`. Tool callbacks never see the secret.
 */

export interface ToolContext {
  orchestrator: Orchestrator;
  session: Session;
  spawner: Spawner;
}

/** Active sessions only (plan §10). Mirrors Spawner.counters() classification. */
function isActive(s: Session): boolean {
  return s.status === 'running' || s.status === 'starting' || s.status === 'waiting';
}

/** Shape of `team.whoami` payload — never includes `session_secret`. */
export interface WhoamiPayload {
  session_id: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
  is_lead: boolean;
}

export interface MemberView {
  session_id: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
}

export interface ListPayload {
  members: MemberView[];
}

export function buildWhoami(ctx: ToolContext): WhoamiPayload {
  const isLead = ctx.session.id === ctx.orchestrator.leadSessionId;
  return {
    session_id: ctx.session.id,
    name: ctx.session.name,
    role: ctx.session.role,
    type: ctx.session.type,
    is_lead: isLead,
  };
}

export function buildList(ctx: ToolContext): ListPayload {
  // Scope strictly to the calling orchestrator (plan §10 + §14: never reveal
  // sessions from other orchestrators).
  const members: MemberView[] = ctx.orchestrator
    .listSessions()
    .filter(isActive)
    .map((s) => ({
      session_id: s.id,
      name: s.name,
      role: s.role,
      type: s.type,
    }));
  return { members };
}

/**
 * Wrap a payload in the standard MCP `CallToolResult` envelope. We supply
 * BOTH `structuredContent` (typed result, the canonical channel for tools
 * with an outputSchema) AND a `content` text fallback (for clients that
 * don't surface structured content yet). Per the SDK's tool contract that
 * ships in v1.29: when an outputSchema is declared, structuredContent is
 * the source of truth and content is informational.
 */
function ok<T extends object>(payload: T): {
  structuredContent: { [k: string]: unknown };
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    structuredContent: payload as { [k: string]: unknown },
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

/** Phase 3 placeholder — explicit error, never a silent no-op. */
function notImplementedPhase3(toolName: string): never {
  throw new McpError(
    ErrorCode.MethodNotFound,
    `tool ${toolName} is registered but not implemented in Phase 2 — wired in Phase 3 (workers + mailbox)`,
  );
}

/**
 * Per-tool log line. We log `sid.slice(0,8)` rather than the full session
 * id to keep log volume sane; the session secret is NEVER logged (it's not
 * even in scope here — McpServer drops it before invoking tools).
 */
function logCall(tool: string, ctx: ToolContext, ok: boolean, err?: string): void {
  // Structured stdout (pino arrives in Phase 4).
  console.log(
    JSON.stringify({
      event: 'mcp.call',
      tool,
      sid: ctx.session.id,
      orch: ctx.orchestrator.id,
      ok,
      ...(err ? { err } : {}),
    }),
  );
}

/**
 * Register all team-comms tools on a freshly-constructed `McpServer`.
 * `ctxResolver` returns the per-call ToolContext (a thunk because the same
 * SDK server may eventually be reused across requests in a future Phase).
 */
export function registerTeamCommsTools(
  server: McpServer,
  ctxResolver: () => ToolContext,
): void {
  // ---- team.whoami (Phase 2) -------------------------------------------
  server.registerTool(
    'team.whoami',
    {
      title: 'Identify the calling session',
      description:
        'Returns the calling session\'s metadata (id, name, role, type, is_lead). No arguments.',
      inputSchema: {},
      outputSchema: {
        session_id: z.string(),
        name: z.string(),
        role: z.string(),
        type: z.enum(['lead', 'worker']),
        is_lead: z.boolean(),
      },
    },
    () => {
      const ctx = ctxResolver();
      const payload = buildWhoami(ctx);
      logCall('team.whoami', ctx, true);
      return ok(payload);
    },
  );

  // ---- team.list (Phase 2) ---------------------------------------------
  server.registerTool(
    'team.list',
    {
      title: 'List active team members',
      description:
        'Returns the active sessions in the calling orchestrator (id, name, role, type). Excludes terminated sessions and sessions from other orchestrators.',
      inputSchema: {},
      outputSchema: {
        members: z.array(
          z.object({
            session_id: z.string(),
            name: z.string(),
            role: z.string(),
            type: z.enum(['lead', 'worker']),
          }),
        ),
      },
    },
    () => {
      const ctx = ctxResolver();
      const payload = buildList(ctx);
      logCall('team.list', ctx, true);
      return ok(payload);
    },
  );

  // ---- Phase 3 placeholders --------------------------------------------
  // Each is registered with a real schema so `tools/list` advertises the
  // contract Phase 3 will fulfill. The handler always throws an explicit
  // McpError so an agent gets a usable, actionable response.

  server.registerTool(
    'team.send_message',
    {
      title: 'Send a direct message to a teammate (Phase 3)',
      description:
        '[NOT IMPLEMENTED — Phase 3] Pushes a message into the recipient\'s in-memory mailbox and pings their PTY if idle.',
      inputSchema: {
        to: z.string().describe('Recipient session id'),
        content: z.string(),
      },
    },
    () => {
      const ctx = ctxResolver();
      logCall('team.send_message', ctx, false, 'NOT_IMPLEMENTED_PHASE_3');
      notImplementedPhase3('team.send_message');
    },
  );

  server.registerTool(
    'team.read_inbox',
    {
      title: 'Read and clear the calling session\'s inbox (Phase 3)',
      description:
        '[NOT IMPLEMENTED — Phase 3] Returns and atomically clears the calling session\'s in-memory mailbox.',
      inputSchema: {},
    },
    () => {
      const ctx = ctxResolver();
      logCall('team.read_inbox', ctx, false, 'NOT_IMPLEMENTED_PHASE_3');
      notImplementedPhase3('team.read_inbox');
    },
  );

  server.registerTool(
    'team.broadcast',
    {
      title: 'Broadcast a message to all teammates (Phase 3)',
      description:
        '[NOT IMPLEMENTED — Phase 3] Pushes content into every teammate\'s mailbox (excluding sender).',
      inputSchema: {
        content: z.string(),
      },
    },
    () => {
      const ctx = ctxResolver();
      logCall('team.broadcast', ctx, false, 'NOT_IMPLEMENTED_PHASE_3');
      notImplementedPhase3('team.broadcast');
    },
  );

  server.registerTool(
    'team.spawn_worker',
    {
      title: 'Spawn a new worker session (lead-only, Phase 3)',
      description:
        '[NOT IMPLEMENTED — Phase 3] Lead-only. Spawns a new claude PTY worker with its own mcp.json.',
      inputSchema: {
        name: z.string(),
        role: z.string(),
        prompt: z.string(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        permissionMode: z.string().optional(),
      },
    },
    () => {
      const ctx = ctxResolver();
      logCall('team.spawn_worker', ctx, false, 'NOT_IMPLEMENTED_PHASE_3');
      notImplementedPhase3('team.spawn_worker');
    },
  );

  server.registerTool(
    'team.kill_worker',
    {
      title: 'Kill a worker session (lead-only, Phase 3)',
      description:
        '[NOT IMPLEMENTED — Phase 3] Lead-only. SIGTERM, 5s grace, SIGKILL.',
      inputSchema: {
        id: z.string(),
      },
    },
    () => {
      const ctx = ctxResolver();
      logCall('team.kill_worker', ctx, false, 'NOT_IMPLEMENTED_PHASE_3');
      notImplementedPhase3('team.kill_worker');
    },
  );

  server.registerTool(
    'team.kill_all_workers',
    {
      title: 'Kill all workers in the team (lead-only, Phase 3)',
      description:
        '[NOT IMPLEMENTED — Phase 3] Lead-only. Sweeps every worker, leaving the lead alone.',
      inputSchema: {},
    },
    () => {
      const ctx = ctxResolver();
      logCall('team.kill_all_workers', ctx, false, 'NOT_IMPLEMENTED_PHASE_3');
      notImplementedPhase3('team.kill_all_workers');
    },
  );
}
