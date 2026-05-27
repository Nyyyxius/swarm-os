import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Spawner } from '../spawner/index.js';
import type { Session } from '../orchestrator/session.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { WorkerCapError } from '../orchestrator/index.js';
import {
  sendMessage,
  broadcast,
  readInbox,
  sendMessageToLead,
  broadcastToLeads,
  MessageError,
  type MessagingDefaults,
} from '../orchestrator/messaging.js';
import { validateCwdUnderWorkspace } from '../../http/validation.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import { withModule } from '../../logger.js';

const log = withModule('mcp.tool');

/**
 * MCP team-comms tools (plan §10).
 *
 * Phase 3 implements the full set:
 *
 *  - read tools (`team.whoami`, `team.list`)
 *  - mailbox (`team.send_message`, `team.read_inbox`, `team.broadcast`)
 *  - lead-only worker control (`team.spawn_worker`, `team.kill_worker`,
 *    `team.kill_all_workers`)
 *
 * Authentication: every call is bound to a Session via `(orchestrator,
 * session)` resolved by `McpServer.handle()` from the path
 * `/mcp/:orch_id/:session_secret`. Tool callbacks never see the secret.
 *
 * Lead-only enforcement: implemented in `requireLead(ctx)` which throws
 * `McpError(InvalidRequest, 'PERMISSION_DENIED: ...')` when the calling
 * session is not the orchestrator's lead. The lead-vs-worker check uses
 * `ctx.session.id === ctx.orchestrator.leadSessionId` — same predicate as
 * `team.whoami`'s `is_lead`.
 */

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMS: ReadonlySet<string> = new Set([
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

export interface ToolContext {
  orchestrator: Orchestrator;
  session: Session;
  spawner: Spawner;
  /** Server-wide config — needed for cwd validation and worker defaults. */
  config: Config;
  /** Messaging defaults derived from config — passed once for clarity. */
  messagingDefaults: MessagingDefaults;
}

/** Active sessions only (plan §10). */
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

/**
 * Throw a clean MCP `PERMISSION_DENIED` for a worker that calls a lead-only
 * tool. We use `ErrorCode.InvalidRequest` (the SDK doesn't have a dedicated
 * permission code in 1.29) and prefix the message with `PERMISSION_DENIED:`
 * so the client can pattern-match without inspecting the numeric code.
 */
function requireLead(ctx: ToolContext, toolName: string): void {
  const isLead = ctx.session.id === ctx.orchestrator.leadSessionId;
  if (!isLead) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `PERMISSION_DENIED: tool ${toolName} is lead-only; calling session ${ctx.session.id} is a worker`,
    );
  }
}

/**
 * Per-tool log line. We log `sid.slice(0,8)` rather than the full session
 * id to keep log volume sane; the session secret is NEVER logged (it's not
 * even in scope here — McpServer drops it before invoking tools).
 */
function logCall(tool: string, ctx: ToolContext, ok: boolean, err?: string): void {
  log.info({
    event: 'mcp.call',
    tool,
    sid: ctx.session.id,
    orch: ctx.orchestrator.id,
    ok,
    ...(err ? { err } : {}),
  });
}

/**
 * Translate a `MessageError` into an MCP error. Size violations map to
 * `InvalidParams` (the SDK's closest equivalent to HTTP 413), and other
 * validation failures to `InvalidRequest`.
 */
function throwAsMcp(err: MessageError): never {
  const code =
    err.code === 'MESSAGE_TOO_LARGE' ? ErrorCode.InvalidParams : ErrorCode.InvalidRequest;
  throw new McpError(code, `${err.code}: ${err.message}`);
}

/**
 * Resolve the Discord channel + ready bot for the calling orch's role. Shared
 * by `discord.send_message` and `discord.create_thread` — both need the same
 * triplet of validations (channel configured, token configured, bot ready)
 * and throw the same error codes so the LLM can pattern-match uniformly.
 */
function resolveDiscordContext(
  ctx: ToolContext,
  toolName: string,
): {
  bot: NonNullable<ReturnType<NonNullable<Spawner['discordBotPool']>['botForOrch']>>;
  channelId: string;
} {
  const roleId = ctx.orchestrator.roleId;
  const role = roleId && ctx.spawner.roleStore ? ctx.spawner.roleStore.get(roleId) : null;
  const discord = role?.connectors.find((c) => c.type === 'discord');
  const channelId = discord?.channelId;
  if (!channelId) {
    logCall(toolName, ctx, false, 'NO_DISCORD_CHANNEL');
    throw new McpError(
      ErrorCode.InvalidRequest,
      "NO_DISCORD_CHANNEL: this orchestrator's role has no Discord channelId configured",
    );
  }
  if (!discord?.botToken) {
    logCall(toolName, ctx, false, 'DISCORD_BOT_NOT_CONFIGURED');
    throw new McpError(
      ErrorCode.InvalidRequest,
      "DISCORD_BOT_NOT_CONFIGURED: this orchestrator's role has no Discord botToken configured",
    );
  }
  const bot = ctx.spawner.discordBotPool?.botForOrch(ctx.orchestrator.id);
  if (!bot || !bot.isReady()) {
    logCall(toolName, ctx, false, 'DISCORD_BOT_DISABLED');
    throw new McpError(
      ErrorCode.InvalidRequest,
      'DISCORD_BOT_DISABLED: the Discord bot for this role failed to start or is not yet connected',
    );
  }
  return { bot, channelId };
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
  // ---- team.whoami -----------------------------------------------------
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

  // ---- team.list -------------------------------------------------------
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

  // ---- team.send_message -----------------------------------------------
  server.registerTool(
    'team.send_message',
    {
      title: 'Send a direct message to a teammate',
      description:
        'Pushes content into the recipient\'s in-memory mailbox. Idle recipients receive a short signal in their PTY. Bounded queue: oldest message is dropped past the cap.',
      inputSchema: {
        to: z.string().describe('Recipient session id (use team.list to discover ids)'),
        content: z.string(),
      },
      outputSchema: {
        delivered: z.boolean(),
        queue_size: z.number(),
        dropped: z.boolean(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as { to: string; content: string };
      try {
        const out = sendMessage(
          {
            orchestrator: ctx.orchestrator,
            mailbox: ctx.orchestrator.mailbox,
            defaults: ctx.messagingDefaults,
          },
          ctx.session.id,
          a.to,
          a.content,
        );
        logCall('team.send_message', ctx, true);
        return ok({
          delivered: out.delivered,
          queue_size: out.queueSize,
          dropped: out.dropped,
        });
      } catch (err) {
        logCall(
          'team.send_message',
          ctx,
          false,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof MessageError) throwAsMcp(err);
        throw err;
      }
    },
  );

  // ---- team.read_inbox -------------------------------------------------
  server.registerTool(
    'team.read_inbox',
    {
      title: 'Read and clear the calling session\'s inbox',
      description:
        'Returns and atomically clears every message queued for the calling session. Returns an empty array if the inbox is empty. Cross-team messages (from another team\'s lead) carry an extra `from_orchestrator` field.',
      inputSchema: {},
      outputSchema: {
        messages: z.array(
          z.object({
            id: z.string(),
            from: z.string(),
            content: z.string(),
            ts: z.string(),
            from_orchestrator: z
              .object({
                id: z.string(),
                name: z.string(),
                lead_name: z.string(),
              })
              .optional(),
            // Present only for messages originating from an external bridge
            // (currently: Discord). Carries the native message id + thread
            // context so the lead can address `discord.send_message` /
            // `discord.create_thread` with the right snowflakes.
            source: z
              .object({
                kind: z.literal('discord'),
                discord_message_id: z.string(),
                thread_id: z.string().optional(),
                thread_name: z.string().optional(),
              })
              .optional(),
          }),
        ),
      },
    },
    () => {
      const ctx = ctxResolver();
      const raw = readInbox(
        {
          orchestrator: ctx.orchestrator,
          mailbox: ctx.orchestrator.mailbox,
          defaults: ctx.messagingDefaults,
        },
        ctx.session.id,
      );
      // Phase 8 — stamp delivered in SQLite so the next boot's rehydrate
      // doesn't re-emit these messages. We do this synchronously here (not
      // inside Mailbox.read) so the markDelivered call sits AFTER the
      // agent has effectively received the message in this turn. The
      // window between flush and stamp is sub-millisecond in practice;
      // a process death inside that window would re-deliver a few
      // messages at next boot (acceptable at-least-once trade-off).
      if (raw.length > 0) {
        try {
          ctx.orchestrator.persistence.db.markMailboxMessagesDelivered(
            raw.map((m) => m.id),
          );
        } catch {
          /* best-effort — db.write_failed already logged inside */
        }
      }
      const messages = raw.map((m) => ({
        id: m.id,
        from: m.from,
        content: m.content,
        ts: m.ts,
        ...(m.fromOrchestratorId
          ? {
              from_orchestrator: {
                id: m.fromOrchestratorId,
                name: m.fromOrchestratorName ?? m.fromOrchestratorId,
                lead_name: m.fromSessionName ?? m.from,
              },
            }
          : {}),
        ...(m.sourceKind === 'discord' && m.sourceMessageId
          ? {
              source: {
                kind: 'discord' as const,
                discord_message_id: m.sourceMessageId,
                ...(m.threadId ? { thread_id: m.threadId } : {}),
                ...(m.threadName ? { thread_name: m.threadName } : {}),
              },
            }
          : {}),
      }));
      logCall('team.read_inbox', ctx, true);
      return ok({ messages });
    },
  );

  // ---- team.broadcast --------------------------------------------------
  server.registerTool(
    'team.broadcast',
    {
      title: 'Broadcast a message to all teammates',
      description:
        'Pushes the content into every active teammate\'s mailbox (excluding the sender). Idle recipients are signalled.',
      inputSchema: {
        content: z.string(),
      },
      outputSchema: {
        delivered_to: z.array(z.string()),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const a = args as { content: string };
      try {
        const out = broadcast(
          {
            orchestrator: ctx.orchestrator,
            mailbox: ctx.orchestrator.mailbox,
            defaults: ctx.messagingDefaults,
          },
          ctx.session.id,
          a.content,
        );
        logCall('team.broadcast', ctx, true);
        return ok({ delivered_to: out.delivered_to });
      } catch (err) {
        logCall(
          'team.broadcast',
          ctx,
          false,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof MessageError) throwAsMcp(err);
        throw err;
      }
    },
  );

  // ---- team.spawn_worker (lead-only) -----------------------------------
  server.registerTool(
    'team.spawn_worker',
    {
      title: 'Spawn a new worker session (lead-only)',
      description:
        'Lead-only. Spawns a new claude PTY worker with its own mcp.json. Returns the new session metadata. cwd defaults to the lead\'s cwd; model/effort/permissionMode default to the orchestrator\'s defaults.',
      inputSchema: {
        name: z.string(),
        role: z.string(),
        prompt: z.string(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        permissionMode: z.string().optional(),
      },
      outputSchema: {
        session: z.object({
          id: z.string(),
          name: z.string(),
          role: z.string(),
          type: z.enum(['lead', 'worker']),
          status: z.string(),
          cwd: z.string(),
          model: z.string(),
          effort: z.string(),
          permissionMode: z.string(),
        }),
      },
    },
    async (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'team.spawn_worker');
      const a = args as {
        name: string;
        role: string;
        prompt: string;
        cwd?: string;
        model?: string;
        effort?: string;
        permissionMode?: string;
      };
      // Prompt size cap (same envelope as the REST orchestrator-create
      // surface, plan §13).
      const promptBytes = Buffer.byteLength(a.prompt, 'utf8');
      if (promptBytes > ctx.config.maxPromptSizeBytes) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `PROMPT_TOO_LARGE: ${promptBytes} bytes > ${ctx.config.maxPromptSizeBytes}`,
        );
      }
      // Validate optional model/effort/permissionMode strings up-front so
      // the agent gets a clean MCP error rather than a vague spawn failure.
      if (a.effort != null && !VALID_EFFORTS.has(a.effort)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `INVALID_EFFORT: must be one of ${[...VALID_EFFORTS].join('|')}`,
        );
      }
      if (a.permissionMode != null && !VALID_PERMS.has(a.permissionMode)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `INVALID_PERMISSION_MODE: must be one of ${[...VALID_PERMS].join('|')}`,
        );
      }
      // cwd validation — reuse the same realpath check as the REST surface
      // (plan §14). Defaults to the lead's cwd if omitted.
      const cwdInput = a.cwd ?? ctx.orchestrator.lead?.cwd ?? null;
      if (!cwdInput) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'INVALID_CWD: lead has no cwd to inherit; pass cwd explicitly',
        );
      }
      let resolvedCwd: string;
      try {
        resolvedCwd = await validateCwdUnderWorkspace(cwdInput, ctx.config.workspaceRoot);
      } catch (err) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `INVALID_CWD: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const worker = ctx.orchestrator.addWorker({
          name: a.name,
          role: a.role,
          prompt: a.prompt,
          cwd: resolvedCwd,
          model: a.model,
          effort: a.effort as EffortLevel | undefined,
          permissionMode: a.permissionMode as PermissionMode | undefined,
        });
        logCall('team.spawn_worker', ctx, true);
        const v = worker.toView();
        return ok({
          session: {
            id: v.id,
            name: v.name,
            role: v.role,
            type: v.type,
            status: v.status,
            cwd: v.cwd,
            model: v.model,
            effort: v.effort,
            permissionMode: v.permissionMode,
          },
        });
      } catch (err) {
        logCall(
          'team.spawn_worker',
          ctx,
          false,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof WorkerCapError) {
          throw new McpError(ErrorCode.InvalidRequest, `${err.code}: ${err.message}`);
        }
        throw err;
      }
    },
  );

  // ---- team.kill_worker (lead-only) ------------------------------------
  server.registerTool(
    'team.kill_worker',
    {
      title: 'Kill a worker session (lead-only)',
      description:
        'Lead-only. SIGTERM, 5s grace, SIGKILL. Idempotent — unknown ids return { killed: false } rather than an error.',
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        killed: z.boolean(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'team.kill_worker');
      const a = args as { id: string };
      const killed = ctx.orchestrator.killWorker(a.id);
      logCall('team.kill_worker', ctx, true);
      return ok({ killed });
    },
  );

  // ---- team.kill_all_workers (lead-only) -------------------------------
  server.registerTool(
    'team.kill_all_workers',
    {
      title: 'Kill all workers in the team (lead-only)',
      description:
        'Lead-only. Sweeps every worker, leaving the lead alone. Returns the array of session ids that were targeted.',
      inputSchema: {},
      outputSchema: {
        killed: z.array(z.string()),
      },
    },
    () => {
      const ctx = ctxResolver();
      requireLead(ctx, 'team.kill_all_workers');
      const killed = ctx.orchestrator.killAllWorkers();
      logCall('team.kill_all_workers', ctx, true);
      return ok({ killed });
    },
  );

  // ---- swarm.list_teams (lead-only) ------------------------------------
  // Cross-team discovery: returns the other active orchestrators and their
  // leads. Workers cannot use this — coordination across teams is the
  // lead's responsibility. Member workers of other teams are intentionally
  // hidden to keep the inter-team boundary tight.
  server.registerTool(
    'swarm.list_teams',
    {
      title: 'List other active teams (lead-only)',
      description:
        'Lead-only. Returns active orchestrators other than the caller\'s, with each team\'s lead and current active worker count. Used as the directory for swarm.send_to_lead.',
      inputSchema: {},
      outputSchema: {
        teams: z.array(
          z.object({
            orchestrator_id: z.string(),
            name: z.string(),
            role: z.string(),
            status: z.string(),
            worker_count: z.number(),
            lead: z.object({
              session_id: z.string(),
              name: z.string(),
              role: z.string(),
            }),
          }),
        ),
      },
    },
    () => {
      const ctx = ctxResolver();
      requireLead(ctx, 'swarm.list_teams');
      const teams = ctx.spawner
        .listActive()
        .filter((o) => o.id !== ctx.orchestrator.id)
        .map((o) => {
          const lead = o.lead;
          if (!lead || !isActive(lead)) return null;
          const worker_count = o
            .listSessions()
            .filter((s) => s.type === 'worker' && isActive(s)).length;
          return {
            orchestrator_id: o.id,
            name: o.name,
            role: o.role,
            status: o.status,
            worker_count,
            lead: {
              session_id: lead.id,
              name: lead.name,
              role: lead.role,
            },
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);
      logCall('swarm.list_teams', ctx, true);
      return ok({ teams });
    },
  );

  // ---- swarm.send_to_lead (lead-only) ----------------------------------
  // 1-to-1 cross-team message to another team's lead. Re-resolves the
  // target lead just before push to close the lead-flip race window
  // (handled inside sendMessageToLead).
  server.registerTool(
    'swarm.send_to_lead',
    {
      title: 'Send a message to another team\'s lead (lead-only)',
      description:
        'Lead-only. Pushes content into the target orchestrator\'s lead inbox. The recipient sees the message via team.read_inbox with a from_orchestrator tag. Use swarm.list_teams to discover orchestrator_ids.',
      inputSchema: {
        orchestrator_id: z
          .string()
          .describe('Target orchestrator id (use swarm.list_teams to discover)'),
        content: z.string(),
      },
      outputSchema: {
        delivered: z.boolean(),
        to_session_id: z.string(),
        to_orchestrator_id: z.string(),
        queue_size: z.number(),
        dropped: z.boolean(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'swarm.send_to_lead');
      const a = args as { orchestrator_id: string; content: string };
      try {
        const out = sendMessageToLead(
          ctx.spawner,
          ctx.orchestrator,
          ctx.session.id,
          a.orchestrator_id,
          a.content,
          ctx.messagingDefaults,
        );
        logCall('swarm.send_to_lead', ctx, true);
        return ok({
          delivered: out.delivered,
          to_session_id: out.to_session_id,
          to_orchestrator_id: out.to_orchestrator_id,
          queue_size: out.queueSize,
          dropped: out.dropped,
        });
      } catch (err) {
        logCall(
          'swarm.send_to_lead',
          ctx,
          false,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof MessageError) throwAsMcp(err);
        throw err;
      }
    },
  );

  // ---- swarm.broadcast_to_leads (lead-only) ----------------------------
  // Best-effort fan-out to every other active team's lead. Per-recipient
  // failures (lead exited mid-loop) are silently skipped — caller sees the
  // final delivered_to list.
  server.registerTool(
    'swarm.broadcast_to_leads',
    {
      title: 'Broadcast a message to every other team\'s lead (lead-only)',
      description:
        'Lead-only. Pushes content into every other active orchestrator\'s lead inbox. Excludes the caller\'s own team. Use sparingly — this lands in every other lead\'s inbox simultaneously.',
      inputSchema: {
        content: z.string(),
      },
      outputSchema: {
        delivered_to: z.array(
          z.object({
            orchestrator_id: z.string(),
            session_id: z.string(),
          }),
        ),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'swarm.broadcast_to_leads');
      const a = args as { content: string };
      try {
        const out = broadcastToLeads(
          ctx.spawner,
          ctx.orchestrator,
          ctx.session.id,
          a.content,
          ctx.messagingDefaults,
        );
        logCall('swarm.broadcast_to_leads', ctx, true);
        return ok({ delivered_to: out.delivered_to });
      } catch (err) {
        logCall(
          'swarm.broadcast_to_leads',
          ctx,
          false,
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof MessageError) throwAsMcp(err);
        throw err;
      }
    },
  );

  // ---- discord.send_message (lead-only) --------------------------------
  // Outbound conversational write to the role's Discord channel. The channel
  // and bot identity are both per-role: the role must carry a
  // `DiscordConnector` with `channelId` AND `botToken`. We route via the
  // pool's `botForOrch(orchId)` — that's the bot this orch subscribed to at
  // create/resume time, which may differ from the role's *current* token
  // if the operator edited the role mid-flight (decision: orchs stay on
  // their original bot until termination). Inbound humans land back in
  // the lead's inbox via the bot's `messageCreate` handler.
  server.registerTool(
    'discord.send_message',
    {
      title: 'Post a message to the role\'s Discord channel (lead-only)',
      description:
        "Lead-only. Posts `content` to the Discord channel bound to this orchestrator's role (role.connectors[type=discord].channelId). When `thread_id` is provided, posts into that thread instead of the channel root — use the `source.thread_id` returned by `team.read_inbox` to stay in the same fil. When `reply_to_message_id` is provided, attaches a Discord native reply reference (use the `source.discord_message_id` from the inbound message). Returns the freshly-posted `message_id` (Discord snowflake) so you can chain follow-ups. Errors NO_DISCORD_CHANNEL when the role has no channel, DISCORD_BOT_NOT_CONFIGURED when the role has no bot token, DISCORD_BOT_DISABLED when the bot failed to start, DISCORD_SEND_FAILED on Discord-side errors. Discord's hard limit is 2000 chars — chunk longer messages yourself.",
      inputSchema: {
        content: z.string().min(1).max(2000),
        thread_id: z.string().optional(),
        reply_to_message_id: z.string().optional(),
      },
      outputSchema: {
        delivered: z.boolean(),
        channel_id: z.string(),
        message_id: z.string(),
        thread_id: z.string().optional(),
      },
    },
    async (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'discord.send_message');
      const a = args as {
        content: string;
        thread_id?: string;
        reply_to_message_id?: string;
      };

      const { bot, channelId } = resolveDiscordContext(ctx, 'discord.send_message');

      try {
        const sent = await bot.sendMessage(channelId, a.content, {
          ...(a.thread_id ? { threadId: a.thread_id } : {}),
          ...(a.reply_to_message_id ? { replyToMessageId: a.reply_to_message_id } : {}),
        });
        logCall('discord.send_message', ctx, true);
        return ok({
          delivered: true,
          channel_id: channelId,
          message_id: sent.messageId,
          ...(a.thread_id ? { thread_id: a.thread_id } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logCall('discord.send_message', ctx, false, msg);
        throw new McpError(ErrorCode.InternalError, `DISCORD_SEND_FAILED: ${msg}`);
      }
    },
  );

  // ---- discord.create_thread (lead-only) -------------------------------
  // Open a new Discord thread on the role's channel. Two modes:
  //  - `from_message_id` set: anchor the thread on that message (the message
  //    becomes the thread's "starter"). Use the `source.discord_message_id`
  //    from the inbound message to spin a thread off the human's question.
  //  - `from_message_id` absent: create a free-standing thread on the channel.
  // Returns `{ thread_id, thread_name, channel_id }`. The lead can then post
  // into the new thread via `discord.send_message({ thread_id })`.
  server.registerTool(
    'discord.create_thread',
    {
      title: "Open a new thread on the role's Discord channel (lead-only)",
      description:
        "Lead-only. Creates a new Discord thread. If `from_message_id` is provided, the thread is anchored to that message (use `source.discord_message_id` from inbox). Otherwise a free-standing thread is opened on the channel root. `auto_archive_minutes` controls when Discord hides the thread (default 1440 = 24h; Discord supports 60, 1440, 4320, 10080). Returns the new `thread_id`, which you pass back into `discord.send_message({ thread_id })` to keep the conversation in the fil. Errors DISCORD_THREAD_PARENT_MESSAGE_NOT_FOUND (anchor message gone), DISCORD_THREAD_CHANNEL_NOT_THREADABLE (channel doesn't support threads), DISCORD_THREAD_CREATE_FAILED (Discord-side failure).",
      inputSchema: {
        name: z.string().min(1).max(100),
        from_message_id: z.string().optional(),
        auto_archive_minutes: z.number().int().positive().optional(),
      },
      outputSchema: {
        thread_id: z.string(),
        thread_name: z.string(),
        channel_id: z.string(),
      },
    },
    async (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'discord.create_thread');
      const a = args as {
        name: string;
        from_message_id?: string;
        auto_archive_minutes?: number;
      };

      const { bot, channelId } = resolveDiscordContext(ctx, 'discord.create_thread');

      try {
        const { threadId, threadName } = await bot.createThread(channelId, {
          name: a.name,
          ...(a.from_message_id ? { fromMessageId: a.from_message_id } : {}),
          ...(a.auto_archive_minutes ? { autoArchiveMinutes: a.auto_archive_minutes } : {}),
        });
        logCall('discord.create_thread', ctx, true);
        return ok({
          thread_id: threadId,
          thread_name: threadName,
          channel_id: channelId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Surface the specific error code if `bot.createThread` raised one of
        // the typed messages; otherwise fall back to the generic
        // DISCORD_THREAD_CREATE_FAILED bucket.
        logCall('discord.create_thread', ctx, false, msg);
        if (/^DISCORD_THREAD_/.test(msg)) {
          throw new McpError(ErrorCode.InternalError, msg);
        }
        throw new McpError(ErrorCode.InternalError, `DISCORD_THREAD_CREATE_FAILED: ${msg}`);
      }
    },
  );
}
