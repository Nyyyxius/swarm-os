import { Router, type Request, type Response } from 'express';
import { Spawner, SpawnerError } from '../../modules/spawner/index.js';
import { normalizeWorkspaceRelativeCwd, validateCwdUnderWorkspace } from '../validation.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import {
  broadcast as messagingBroadcast,
  MessageError,
} from '../../modules/orchestrator/messaging.js';
import {
  rowToOrchView,
  rowToSessionView,
} from '../../modules/orchestrator/persistence.js';

const RECENT_HISTORY_LIMIT = 50;

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMS: ReadonlySet<string> = new Set([
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

interface CreateBody {
  name?: unknown;
  role?: unknown;
  /** Phase 7: optional FK into the roles table. When set, the role's fields
   * (leadPrompt, leadPreamble, workerPreamble, defaults) fill in any field
   * the caller did NOT provide. The label still becomes `orchestrator.role`
   * (denormalized) so existing readers keep working. */
  roleId?: unknown;
  lead?: {
    cwd?: unknown;
    prompt?: unknown;
    preamble?: unknown;
  };
  workerPreamble?: unknown;
  defaults?: {
    model?: unknown;
    effort?: unknown;
    permissionMode?: unknown;
  };
}

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function bytesOf(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function createOrchestratorsRouter(spawner: Spawner, config: Config): Router {
  const router = Router();

  router.post('/orchestrators', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateBody;

    if (!isString(body.name)) {
      res.status(400).json({ error: 'name is required and must be a non-empty string' });
      return;
    }

    // Phase 7: optional role lookup. The role's fields fill in anything the
    // caller omitted (label, lead prompt/preamble, workerPreamble, defaults).
    let role = null;
    if (body.roleId != null) {
      if (!isString(body.roleId)) {
        res.status(400).json({ error: 'roleId must be a non-empty string' });
        return;
      }
      if (spawner.roleStore) {
        role = spawner.roleStore.get(body.roleId);
        if (!role) {
          res.status(400).json({ error: 'roleId not found' });
          return;
        }
      }
    }

    // The label may come from the body or fall back to the role's label.
    let roleLabel: string;
    if (isString(body.role)) {
      roleLabel = body.role;
    } else if (role) {
      roleLabel = role.label;
    } else {
      res.status(400).json({ error: 'role is required and must be a non-empty string' });
      return;
    }

    const lead = body.lead ?? {};
    if (!isString(lead.cwd)) {
      res.status(400).json({ error: 'lead.cwd is required and must be a non-empty string' });
      return;
    }

    // Lead prompt: body wins, else role.leadPrompt, else required error.
    let leadPrompt: string;
    if (isString(lead.prompt)) {
      leadPrompt = lead.prompt;
    } else if (role?.leadPrompt) {
      leadPrompt = role.leadPrompt;
    } else {
      res.status(400).json({ error: 'lead.prompt is required and must be a non-empty string' });
      return;
    }

    if (lead.preamble != null && typeof lead.preamble !== 'string') {
      res.status(400).json({ error: 'lead.preamble must be a string if provided' });
      return;
    }
    if (body.workerPreamble != null && typeof body.workerPreamble !== 'string') {
      res.status(400).json({ error: 'workerPreamble must be a string if provided' });
      return;
    }

    const effectiveLeadPreamble =
      isString(lead.preamble) ? lead.preamble : role?.leadPreamble ?? null;
    const effectiveWorkerPreamble =
      isString(body.workerPreamble) ? body.workerPreamble : role?.workerPreamble ?? null;

    const promptBytes =
      bytesOf(leadPrompt) + (effectiveLeadPreamble ? bytesOf(effectiveLeadPreamble) : 0);
    if (promptBytes > config.maxPromptSizeBytes) {
      res.status(413).json({
        error: `prompt+preamble too large: ${promptBytes} bytes > ${config.maxPromptSizeBytes}`,
      });
      return;
    }

    // Validate defaults — body > role > global config
    let model = role?.defaultModel ?? config.defaultModel;
    let effort: EffortLevel = (role?.defaultEffort as EffortLevel | null) ?? config.defaultEffort;
    let permissionMode: PermissionMode =
      (role?.defaultPermissionMode as PermissionMode | null) ?? config.defaultPermissionMode;
    if (body.defaults) {
      if (body.defaults.model != null) {
        if (!isString(body.defaults.model)) {
          res.status(400).json({ error: 'defaults.model must be a non-empty string' });
          return;
        }
        model = body.defaults.model;
      }
      if (body.defaults.effort != null) {
        if (!isString(body.defaults.effort) || !VALID_EFFORTS.has(body.defaults.effort)) {
          res.status(400).json({ error: 'defaults.effort must be one of low|medium|high|xhigh|max' });
          return;
        }
        effort = body.defaults.effort as EffortLevel;
      }
      if (body.defaults.permissionMode != null) {
        if (!isString(body.defaults.permissionMode) || !VALID_PERMS.has(body.defaults.permissionMode)) {
          res.status(400).json({ error: 'defaults.permissionMode invalid' });
          return;
        }
        permissionMode = body.defaults.permissionMode as PermissionMode;
      }
    }

    // cwd realpath validation under workspace root
    let resolvedCwd: string;
    try {
      const normalized = normalizeWorkspaceRelativeCwd(lead.cwd, config.workspaceRoot);
      resolvedCwd = await validateCwdUnderWorkspace(normalized, config.workspaceRoot);
    } catch (err) {
      res.status(400).json({
        error: 'lead.cwd validation failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      const { orchestrator, lead: leadSession } = spawner.create({
        name: body.name,
        role: roleLabel,
        roleId: role?.id ?? null,
        defaultModel: model,
        defaultEffort: effort,
        defaultPermissionMode: permissionMode,
        leadPreamble: effectiveLeadPreamble,
        workerPreamble: effectiveWorkerPreamble,
        lead: {
          cwd: resolvedCwd,
          prompt: leadPrompt,
          preamble: effectiveLeadPreamble,
        },
      });
      res.status(201).json({
        orchestrator: orchestrator.toView(),
        lead: leadSession.toView(),
      });
    } catch (err) {
      if (err instanceof SpawnerError) {
        res.status(err.httpStatus).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: 'failed to create orchestrator',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Phase 4 — list active orchestrators PLUS up to 50 recently-terminated
   * orchestrators from SQLite, sorted by `endedAt desc`. The response shape
   * is unchanged from Phase 1 (an `orchestrators` array of views), so
   * existing clients keep working — they just see history rows now.
   *
   * In-memory rows take precedence over DB rows when both exist for the
   * same id (the in-memory snapshot has live PIDs / activity timestamps).
   */
  router.get('/orchestrators', (_req: Request, res: Response) => {
    const liveActive = spawner.listActive().map((o) => o.toView());
    const liveIds = new Set(liveActive.map((v) => v.id));
    let history: ReturnType<typeof rowToOrchView>[] = [];
    try {
      const rows = spawner.persistence.db.listRecentlyTerminatedOrchestrators(
        RECENT_HISTORY_LIMIT,
      );
      history = rows
        .filter((r) => !liveIds.has(r.id))
        .map((r) => {
          const sessions = spawner.persistence.db
            .listSessions(r.id)
            .map(rowToSessionView);
          return rowToOrchView(r, sessions);
        });
    } catch {
      /* DB unavailable — return live-only */
    }
    res.json({ orchestrators: [...liveActive, ...history] });
  });

  /**
   * Phase 4 — single orchestrator. Falls back to SQLite if the in-memory
   * Map no longer carries the row (server restart, history lookup).
   */
  router.get('/orchestrators/:id', (req: Request<{ id: string }>, res: Response) => {
    const orch = spawner.get(req.params.id);
    if (orch) {
      res.json(orch.toView());
      return;
    }
    try {
      const row = spawner.persistence.db.getOrchestrator(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const sessions = spawner.persistence.db
        .listSessions(req.params.id)
        .map(rowToSessionView);
      res.json(rowToOrchView(row, sessions));
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  router.delete('/orchestrators/:id', (req: Request<{ id: string }>, res: Response) => {
    // `?hide=true` collapses the legacy stop-then-remove two-click flow into
    // one for the desktop KILL button: the orchestrator hides itself as soon
    // as it reaches a terminal status.
    const hideAfterExit = req.query.hide === 'true' || req.query.hide === '1';
    // Idempotent: 204 whether it existed or not.
    spawner.destroy(req.params.id, 'user', { hideAfterExit });
    res.status(204).end();
  });

  // Soft-delete from the map. Orchestrator must be terminal (stopped/failed).
  // Cascades to hide every session of the orchestrator.
  router.post('/orchestrators/:id/hide', (req: Request<{ id: string }>, res: Response) => {
    const orch = spawner.get(req.params.id);
    if (orch) {
      if (orch.status !== 'stopped' && orch.status !== 'failed') {
        res.status(409).json({
          error: 'NOT_TERMINAL',
          message: `cannot hide orchestrator in status '${orch.status}'`,
        });
        return;
      }
      spawner.hideOrchestrator(orch.id);
      res.status(204).end();
      return;
    }
    // Falls back to history rows in SQLite. Those are by definition terminal
    // (the listing query filters status ∈ {stopped, failed}).
    try {
      const row = spawner.persistence.db.getOrchestrator(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      spawner.hideOrchestrator(req.params.id);
      res.status(204).end();
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  router.get('/orchestrators/:id/sessions', (req: Request<{ id: string }>, res: Response) => {
    const orch = spawner.get(req.params.id);
    if (!orch) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ sessions: orch.listSessions().map((s) => s.toView()) });
  });

  /**
   * POST /orchestrators/:id/broadcast — push a `from: 'human'` message into
   * every active teammate's mailbox (plan §9 + §11). The body is `{ content }`.
   * Idle recipients get the same PTY signal as a peer-to-peer broadcast.
   */
  router.post(
    '/orchestrators/:id/broadcast',
    (req: Request<{ id: string }>, res: Response) => {
      const orch = spawner.get(req.params.id);
      if (!orch) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const body = (req.body ?? {}) as { content?: unknown };
      if (typeof body.content !== 'string' || body.content.length === 0) {
        res.status(400).json({ error: 'body.content must be a non-empty string' });
        return;
      }
      try {
        const out = messagingBroadcast(
          {
            orchestrator: orch,
            mailbox: orch.mailbox,
            defaults: {
              maxMessageSizeBytes: config.maxMessageSizeBytes,
              idleThresholdMs: config.idleThresholdMs,
            },
          },
          'human',
          body.content,
        );
        res.json({ delivered_to: out.delivered_to });
      } catch (err) {
        if (err instanceof MessageError) {
          res.status(err.httpStatus).json({ error: err.message, code: err.code });
          return;
        }
        res.status(500).json({
          error: 'broadcast failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * GET /orchestrators/:id/sessions/:sid/inbox — non-destructive peek into a
   * session's mailbox (plan §9, dev/UI helper). Returns `{ count, messages }`.
   * Auth is the standard X-Auth-Token header on the parent router. Used by
   * the OrchestratorView UI to surface "you have N unread" badges per
   * session.
   */
  router.get(
    '/orchestrators/:id/sessions/:sid/inbox',
    (req: Request<{ id: string; sid: string }>, res: Response) => {
      const orch = spawner.get(req.params.id);
      if (!orch) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const session = orch.getSession(req.params.sid);
      if (!session) {
        res.status(404).json({ error: 'session not found in this orchestrator' });
        return;
      }
      const messages = orch.mailbox.peek(req.params.sid);
      res.json({ count: messages.length, messages });
    },
  );

  return router;
}
