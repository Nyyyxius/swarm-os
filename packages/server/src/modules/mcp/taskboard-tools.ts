import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, requireLead, logCall, type ToolContext } from './tools.js';
import {
  TaskboardConflictError,
  TaskboardError,
  TASKBOARD_STATUSES,
  type TaskboardStore,
  type TaskboardCard,
} from '../taskboard/store.js';

/**
 * MCP task-board tools (docs/tableau-de-taches.md §5) — the durable Kanban,
 * exposed to EVERY agent on the same `team-comms` server, right after the shared
 * memory tools. A board is scoped PER TEAM: every tool operates on the calling
 * session's orchestrator (`ctx.orchestrator.id`), never a board the caller does
 * not belong to. The one exception is the lead-only cross-team READ
 * (`board.teams` / `board.list({ team })`).
 *
 * Provenance (`created_by`) and scope (`orchestrator_id`) are stamped from the
 * calling session, never from the arguments, so a card always records who
 * actually created it and on which board it lives (mirror of memory-tools.ts).
 *
 * Permissions (§5/§11):
 *   - read own board + create / comment / link / unlink: EVERYONE
 *   - update / move / close / reopen: the ASSIGNEE or the LEAD
 *     (`requireLeadOrAssignee`)
 *   - assign (to another) / delete / cross-team read: LEAD (`requireLead`);
 *     self-assignment is allowed for anyone.
 */

const STATUS_ENUM = z.enum(TASKBOARD_STATUSES as unknown as [string, ...string[]]);

/** Resolve the store or throw a clean MCP error (pre-taskboard test fixtures). */
function taskboardOf(ctx: ToolContext, tool: string): TaskboardStore {
  if (!ctx.taskboard) {
    logCall(tool, ctx, false, 'TASKBOARD_UNAVAILABLE');
    throw new McpError(
      ErrorCode.InternalError,
      'TASKBOARD_UNAVAILABLE: the task-board store is not configured on this deployment',
    );
  }
  return ctx.taskboard;
}

/** True when the calling session is its orchestrator's lead. */
export function isLeadSession(ctx: ToolContext): boolean {
  return ctx.session.id === ctx.orchestrator.leadSessionId;
}

/**
 * Permission gate for update / move / close / reopen: the card must belong to
 * the caller's team AND the caller must be either the lead or the card's
 * assignee. Throws a clean MCP `PERMISSION_DENIED` otherwise.
 */
export function requireLeadOrAssignee(
  ctx: ToolContext,
  card: Pick<TaskboardCard, 'orchestratorId' | 'assigneeSessionId'>,
  tool: string,
): void {
  if (card.orchestratorId !== ctx.orchestrator.id) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `PERMISSION_DENIED: tool ${tool} cannot act on a card from another team`,
    );
  }
  if (isLeadSession(ctx)) return;
  if (card.assigneeSessionId === ctx.session.id) return;
  throw new McpError(
    ErrorCode.InvalidRequest,
    `PERMISSION_DENIED: tool ${tool} requires the card's assignee or the team lead; session ${ctx.session.id} is neither`,
  );
}

/** Translate a store error into the right MCP error and (re)throw. */
function throwStoreError(err: unknown, tool: string, ctx: ToolContext): never {
  const msg = err instanceof Error ? err.message : String(err);
  logCall(tool, ctx, false, msg);
  if (err instanceof TaskboardConflictError) {
    throw new McpError(ErrorCode.InvalidRequest, `VERSION_CONFLICT: ${msg} — re-read the card and retry`);
  }
  if (err instanceof TaskboardError) {
    const code = err.code === 'NOT_FOUND' ? ErrorCode.InvalidRequest : ErrorCode.InvalidParams;
    throw new McpError(code, `${err.code}: ${msg}`);
  }
  if (err instanceof McpError) throw err;
  throw new McpError(ErrorCode.InternalError, `TASKBOARD_FAILED: ${msg}`);
}

/** Fetch a card of the CALLER'S team or throw NOT_FOUND (workers never see other teams). */
function ownCardOrThrow(
  ctx: ToolContext,
  store: TaskboardStore,
  id: string,
): NonNullable<ReturnType<TaskboardStore['getCard']>> {
  const card = store.getCard(id);
  if (!card || card.orchestratorId !== ctx.orchestrator.id) {
    // A card on another team is indistinguishable from a missing one to a
    // non-lead — same answer, so team membership can't be probed.
    throw new McpError(ErrorCode.InvalidRequest, `NOT_FOUND: card ${id} is not on your board`);
  }
  return card;
}

export function registerTaskboardTools(server: McpServer, ctxResolver: () => ToolContext): void {
  // ---- board.list -------------------------------------------------------
  server.registerTool(
    'board.list',
    {
      title: 'List cards on the team board',
      description:
        "List cards on THIS team's board. Filter by `status` and/or `assignee`; `mine:true` lists only cards assigned to you. `team` reads ANOTHER team's board (lead-only, read-only). Excludes deleted cards.",
      inputSchema: {
        status: STATUS_ENUM.optional(),
        assignee: z.string().optional(),
        mine: z.boolean().optional(),
        team: z.string().optional(),
      },
      outputSchema: {
        cards: z.array(z.record(z.string(), z.unknown())),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.list');
      const a = args as { status?: string; assignee?: string; mine?: boolean; team?: string };
      // Cross-team read is lead-only; default is the caller's own team.
      const orchestratorId = a.team ?? ctx.orchestrator.id;
      if (orchestratorId !== ctx.orchestrator.id) requireLead(ctx, 'board.list({team})');
      const assignee = a.mine ? ctx.session.id : a.assignee;
      const cards = store.listCards({
        orchestratorId,
        ...(a.status ? { status: a.status } : {}),
        ...(assignee ? { assignee } : {}),
      });
      logCall('board.list', ctx, true);
      return ok({ cards });
    },
  );

  // ---- board.teams (lead-only) -----------------------------------------
  server.registerTool(
    'board.teams',
    {
      title: 'List other teams whose board you can read (lead-only)',
      description:
        'Lead-only. Returns the other active orchestrators (teams) whose board you can read with `board.list({ team })`. Mirror of swarm.list_teams for the board surface.',
      inputSchema: {},
      outputSchema: {
        teams: z.array(
          z.object({ orchestrator_id: z.string(), name: z.string(), role: z.string() }),
        ),
      },
    },
    () => {
      const ctx = ctxResolver();
      requireLead(ctx, 'board.teams');
      taskboardOf(ctx, 'board.teams');
      const teams = ctx.spawner
        .listActive()
        .filter((o) => o.id !== ctx.orchestrator.id)
        .map((o) => ({ orchestrator_id: o.id, name: o.name, role: o.role }));
      logCall('board.teams', ctx, true);
      return ok({ teams });
    },
  );

  // ---- board.get --------------------------------------------------------
  server.registerTool(
    'board.get',
    {
      title: 'Read one card + dependencies + audit journal',
      description:
        'Fetch one card with its dependencies (`dependsOn` / `blocks`) and the tail of its append-only audit journal (`events`, oldest → newest). Leads may read a card on any team; workers only on their own.',
      inputSchema: { id: z.string().min(1) },
      outputSchema: { found: z.boolean(), card: z.record(z.string(), z.unknown()).optional() },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.get');
      const a = args as { id: string };
      const card = store.getCard(a.id);
      // Own team → anyone; another team → lead only.
      if (card && card.orchestratorId !== ctx.orchestrator.id) requireLead(ctx, 'board.get(cross-team)');
      logCall('board.get', ctx, true);
      return card ? ok({ found: true, card }) : ok({ found: false });
    },
  );

  // ---- board.create -----------------------------------------------------
  server.registerTool(
    'board.create',
    {
      title: 'Create a card on the team board',
      description:
        "Create a card on THIS team's board (scoped to your orchestrator automatically). `status` defaults to `todo`; `assignee` is a session id; `dependsOn` is a list of card ids this card is blocked by. Provenance (`created_by`) is stamped from your session.",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional(),
        status: STATUS_ENUM.optional(),
        assignee: z.string().optional(),
        priority: z.number().int().optional(),
        labels: z.array(z.string()).optional(),
        dependsOn: z.array(z.string()).optional(),
      },
      outputSchema: { card: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.create');
      const a = args as {
        title: string;
        body?: string;
        status?: string;
        assignee?: string;
        priority?: number;
        labels?: string[];
        dependsOn?: string[];
      };
      try {
        const card = store.createCard({
          orchestratorId: ctx.orchestrator.id,
          title: a.title,
          ...(a.body != null ? { body: a.body } : {}),
          ...(a.status ? { status: a.status } : {}),
          ...(a.assignee ? { assignee: a.assignee } : {}),
          ...(a.priority != null ? { priority: a.priority } : {}),
          ...(a.labels ? { labels: a.labels } : {}),
          ...(a.dependsOn ? { dependsOn: a.dependsOn } : {}),
          createdBy: ctx.session.id,
        });
        logCall('board.create', ctx, true);
        return ok({ card });
      } catch (err) {
        throwStoreError(err, 'board.create', ctx);
      }
    },
  );

  // ---- board.update -----------------------------------------------------
  server.registerTool(
    'board.update',
    {
      title: 'Edit a card (assignee or lead)',
      description:
        'Edit a card\'s title / body / priority / labels under an optimistic lock: pass `expectedVersion` from a prior read; a mismatch returns VERSION_CONFLICT. Allowed to the card\'s assignee or the team lead.',
      inputSchema: {
        id: z.string().min(1),
        expectedVersion: z.number().int().nonnegative(),
        title: z.string().optional(),
        body: z.string().optional(),
        priority: z.number().int().optional(),
        labels: z.array(z.string()).optional(),
      },
      outputSchema: { card: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.update');
      const a = args as {
        id: string;
        expectedVersion: number;
        title?: string;
        body?: string;
        priority?: number;
        labels?: string[];
      };
      try {
        const existing = ownCardOrThrow(ctx, store, a.id);
        requireLeadOrAssignee(ctx, existing, 'board.update');
        const card = store.updateCard({
          id: a.id,
          expectedVersion: a.expectedVersion,
          actorSessionId: ctx.session.id,
          ...(a.title != null ? { title: a.title } : {}),
          ...(a.body != null ? { body: a.body } : {}),
          ...(a.priority != null ? { priority: a.priority } : {}),
          ...(a.labels != null ? { labels: a.labels } : {}),
        });
        logCall('board.update', ctx, true);
        return ok({ card });
      } catch (err) {
        throwStoreError(err, 'board.update', ctx);
      }
    },
  );

  // ---- board.move -------------------------------------------------------
  server.registerTool(
    'board.move',
    {
      title: 'Move a card to another column (assignee or lead)',
      description:
        'Move a card to another status column (the key Kanban action). Optional `expectedVersion` guards against a concurrent edit. Allowed to the card\'s assignee or the team lead.',
      inputSchema: {
        id: z.string().min(1),
        status: STATUS_ENUM,
        expectedVersion: z.number().int().nonnegative().optional(),
      },
      outputSchema: { card: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.move');
      const a = args as { id: string; status: string; expectedVersion?: number };
      try {
        const existing = ownCardOrThrow(ctx, store, a.id);
        requireLeadOrAssignee(ctx, existing, 'board.move');
        const card = store.moveCard({
          id: a.id,
          status: a.status,
          actorSessionId: ctx.session.id,
          ...(a.expectedVersion != null ? { expectedVersion: a.expectedVersion } : {}),
        });
        logCall('board.move', ctx, true);
        return ok({ card });
      } catch (err) {
        throwStoreError(err, 'board.move', ctx);
      }
    },
  );

  // ---- board.assign -----------------------------------------------------
  server.registerTool(
    'board.assign',
    {
      title: 'Assign a card (lead; or self-assign)',
      description:
        'Assign a card to a session id. Assigning to ANOTHER session (or unassigning with `assignee:null`) is lead-only; self-assignment (`assignee` = your own session id, or "self"/"me") is allowed to anyone. The card must be on your board.',
      inputSchema: {
        id: z.string().min(1),
        assignee: z.string().nullable(),
      },
      outputSchema: { card: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.assign');
      const a = args as { id: string; assignee: string | null };
      try {
        const existing = ownCardOrThrow(ctx, store, a.id);
        if (existing.orchestratorId !== ctx.orchestrator.id) {
          throw new McpError(ErrorCode.InvalidRequest, 'NOT_FOUND: card is not on your board');
        }
        const target =
          a.assignee === 'self' || a.assignee === 'me' ? ctx.session.id : a.assignee;
        const selfAssign = target != null && target === ctx.session.id;
        if (!selfAssign) requireLead(ctx, 'board.assign');
        const card = store.assignCard({
          id: a.id,
          assignee: target,
          actorSessionId: ctx.session.id,
        });
        logCall('board.assign', ctx, true);
        return ok({ card });
      } catch (err) {
        throwStoreError(err, 'board.assign', ctx);
      }
    },
  );

  // ---- board.comment ----------------------------------------------------
  server.registerTool(
    'board.comment',
    {
      title: 'Comment on a card (everyone)',
      description:
        'Append a comment to a card\'s append-only audit journal. Open to everyone on the team. Does not change the card\'s version.',
      inputSchema: { id: z.string().min(1), text: z.string().min(1) },
      outputSchema: { event: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.comment');
      const a = args as { id: string; text: string };
      try {
        ownCardOrThrow(ctx, store, a.id);
        const event = store.comment({ id: a.id, text: a.text, actorSessionId: ctx.session.id });
        logCall('board.comment', ctx, true);
        return ok({ event });
      } catch (err) {
        throwStoreError(err, 'board.comment', ctx);
      }
    },
  );

  // ---- board.link / board.unlink ---------------------------------------
  server.registerTool(
    'board.link',
    {
      title: 'Add a dependency between two cards (everyone)',
      description:
        'Add a dependency edge: card `from` is blocked by card `to` (`from` depends on `to`). Both cards must be on your board. Cycle-guarded — an edge that would close a dependency cycle is refused.',
      inputSchema: { from: z.string().min(1), to: z.string().min(1) },
      outputSchema: { ok: z.boolean() },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.link');
      const a = args as { from: string; to: string };
      try {
        ownCardOrThrow(ctx, store, a.from);
        ownCardOrThrow(ctx, store, a.to);
        store.addDep({ cardId: a.from, dependsOnId: a.to, actorSessionId: ctx.session.id });
        logCall('board.link', ctx, true);
        return ok({ ok: true });
      } catch (err) {
        throwStoreError(err, 'board.link', ctx);
      }
    },
  );

  server.registerTool(
    'board.unlink',
    {
      title: 'Remove a dependency between two cards (everyone)',
      description:
        'Remove the dependency edge `from` → `to`. Both cards must be on your board. Idempotent.',
      inputSchema: { from: z.string().min(1), to: z.string().min(1) },
      outputSchema: { ok: z.boolean() },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.unlink');
      const a = args as { from: string; to: string };
      try {
        ownCardOrThrow(ctx, store, a.from);
        store.removeDep({ cardId: a.from, dependsOnId: a.to, actorSessionId: ctx.session.id });
        logCall('board.unlink', ctx, true);
        return ok({ ok: true });
      } catch (err) {
        throwStoreError(err, 'board.unlink', ctx);
      }
    },
  );

  // ---- board.close / board.reopen --------------------------------------
  server.registerTool(
    'board.close',
    {
      title: 'Close a card (assignee or lead)',
      description:
        'Close a card: stamp it done and record the closure in the journal. Optional `expectedVersion` guards a concurrent edit. Allowed to the card\'s assignee or the team lead.',
      inputSchema: { id: z.string().min(1), expectedVersion: z.number().int().nonnegative().optional() },
      outputSchema: { card: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.close');
      const a = args as { id: string; expectedVersion?: number };
      try {
        const existing = ownCardOrThrow(ctx, store, a.id);
        requireLeadOrAssignee(ctx, existing, 'board.close');
        const card = store.closeCard({
          id: a.id,
          actorSessionId: ctx.session.id,
          ...(a.expectedVersion != null ? { expectedVersion: a.expectedVersion } : {}),
        });
        logCall('board.close', ctx, true);
        return ok({ card });
      } catch (err) {
        throwStoreError(err, 'board.close', ctx);
      }
    },
  );

  server.registerTool(
    'board.reopen',
    {
      title: 'Reopen a closed card (assignee or lead)',
      description:
        'Reopen a closed card: clear its closure and move it back to `todo`. Optional `expectedVersion` guards a concurrent edit. Allowed to the card\'s assignee or the team lead.',
      inputSchema: { id: z.string().min(1), expectedVersion: z.number().int().nonnegative().optional() },
      outputSchema: { card: z.record(z.string(), z.unknown()) },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.reopen');
      const a = args as { id: string; expectedVersion?: number };
      try {
        const existing = ownCardOrThrow(ctx, store, a.id);
        requireLeadOrAssignee(ctx, existing, 'board.reopen');
        const card = store.reopenCard({
          id: a.id,
          actorSessionId: ctx.session.id,
          ...(a.expectedVersion != null ? { expectedVersion: a.expectedVersion } : {}),
        });
        logCall('board.reopen', ctx, true);
        return ok({ card });
      } catch (err) {
        throwStoreError(err, 'board.reopen', ctx);
      }
    },
  );

  // ---- board.delete (lead-only) ----------------------------------------
  server.registerTool(
    'board.delete',
    {
      title: 'Delete a card (lead-only)',
      description:
        'Lead-only. Soft-delete a card (hidden from the board, kept for audit). The card must be on your board. Returns `{ deleted }` — false if it was already deleted.',
      inputSchema: { id: z.string().min(1) },
      outputSchema: { deleted: z.boolean() },
    },
    (args) => {
      const ctx = ctxResolver();
      const store = taskboardOf(ctx, 'board.delete');
      requireLead(ctx, 'board.delete');
      const a = args as { id: string };
      try {
        ownCardOrThrow(ctx, store, a.id);
        const deleted = store.deleteCard({ id: a.id, actorSessionId: ctx.session.id });
        logCall('board.delete', ctx, true);
        return ok({ deleted });
      } catch (err) {
        throwStoreError(err, 'board.delete', ctx);
      }
    },
  );
}
