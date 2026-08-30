import { Router, type Request, type Response } from 'express';
import { Spawner, SpawnerError } from '../../modules/spawner/index.js';
import { WorkerCapError } from '../../modules/orchestrator/index.js';
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
import type { SessionView } from '../../modules/orchestrator/session.js';
import { buildSessionCostViews } from '../../modules/metrics/costs.js';
import {
  resolveAgentDefaults,
  resolveProviderId,
  type AgentDefaultsLayer,
} from '../../modules/providers/resolve.js';

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
    /** Agent provider id (`claude` | `codex` | …). Body > role > server default. */
    provider?: unknown;
  };
}

/**
 * Body of `POST /orchestrators/:id/workers` — the human-operator twin of the
 * MCP `team.spawn_worker` tool (`modules/mcp/tools.ts`). Same operation, other
 * channel: everything but `prompt` is optional and falls back to the team
 * default inside `Orchestrator.addWorker`, so leaving a field out means
 * "inherit" here exactly as it does for a lead calling the MCP tool.
 *
 * `cwd` is deliberately NOT accepted: the lead's cwd (already realpath-checked
 * against the workspace root when the team was created) is the only value a UI
 * caller could sensibly pick, and accepting one would re-open a path-escape
 * surface for no gain. A lead that needs another cwd still has the MCP tool.
 */
interface SpawnWorkerBody {
  name?: unknown;
  role?: unknown;
  prompt?: unknown;
  /** Per-worker override of the team's `workerPreamble`. */
  preamble?: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  /** Provider id for THIS worker — how a mixed team is built from the UI. */
  provider?: unknown;
}

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function bytesOf(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function createOrchestratorsRouter(spawner: Spawner, config: Config): Router {
  const router = Router();

  /**
   * Rate card for the history views (docs/monitoring-agents.md, Lot 11). A
   * terminated agent's token totals come straight out of SQLite, so its cost
   * has to be priced here — the live `Session` that used to hold the thunk is
   * long gone. `null` catalogue ⇒ tokens without a price, never a made-up one.
   *
   * Written as an explicit lambda everywhere it is used: `.map(rowToSessionView)`
   * would hand the array INDEX to the second parameter.
   */
  const sessionView = (row: Parameters<typeof rowToSessionView>[0]): SessionView =>
    rowToSessionView(row, (providerId, modelId) =>
      spawner.modelCatalogue?.costRates(providerId, modelId) ?? null,
    );

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

    // Validate the body's own defaults first — everything below reasons over
    // values that are already typed.
    let bodyProvider: string | null = null;
    let bodyModel: string | null = null;
    let bodyEffort: EffortLevel | null = null;
    let bodyPerm: PermissionMode | null = null;
    if (body.defaults) {
      if (body.defaults.provider != null) {
        if (!isString(body.defaults.provider)) {
          res.status(400).json({ error: 'defaults.provider must be a non-empty string' });
          return;
        }
        bodyProvider = body.defaults.provider;
      }
      if (body.defaults.model != null) {
        if (!isString(body.defaults.model)) {
          res.status(400).json({ error: 'defaults.model must be a non-empty string' });
          return;
        }
        bodyModel = body.defaults.model;
      }
      if (body.defaults.effort != null) {
        if (!isString(body.defaults.effort) || !VALID_EFFORTS.has(body.defaults.effort)) {
          res.status(400).json({ error: 'defaults.effort must be one of low|medium|high|xhigh|max' });
          return;
        }
        bodyEffort = body.defaults.effort as EffortLevel;
      }
      if (body.defaults.permissionMode != null) {
        if (!isString(body.defaults.permissionMode) || !VALID_PERMS.has(body.defaults.permissionMode)) {
          res.status(400).json({ error: 'defaults.permissionMode invalid' });
          return;
        }
        bodyPerm = body.defaults.permissionMode as PermissionMode;
      }
    }

    // body > role > config, as three layers rather than three `??` chains — so
    // model/effort/permission are scoped to WHICH LAYER'S PROVIDER supplied
    // them. The rule and the reason live in `providers/resolve.ts`; the short
    // version is that a role written before multi-provider carries a claude
    // `defaultModel` and NO `defaultProvider`, and re-pointing such a team at
    // gemini used to keep the claude id — `gemini -m claude-opus-4-8`, a lead
    // that dies inside its own PTY while the UI still says `running`.
    const layers: AgentDefaultsLayer[] = [
      {
        source: 'body',
        provider: bodyProvider,
        model: bodyModel,
        effort: bodyEffort,
        permissionMode: bodyPerm,
      },
      {
        source: 'role',
        provider: role?.defaultProvider ?? null,
        model: role?.defaultModel ?? null,
        effort: (role?.defaultEffort as EffortLevel | null) ?? null,
        permissionMode: (role?.defaultPermissionMode as PermissionMode | null) ?? null,
      },
      {
        source: 'config',
        provider: config.defaultProvider,
        // Only when an operator actually set `SWARM_OS_DEFAULT_MODEL`. Left as
        // `config.defaultModel` (never empty), this layer always won for a team
        // on the instance's own default provider, so the adapter's `defaults()`
        // — where the live catalogue lands — could never be reached from the
        // API. See `Config.defaultModelExplicit`.
        model: config.defaultModelExplicit ? config.defaultModel : null,
        effort: config.defaultEffort,
        permissionMode: config.defaultPermissionMode,
      },
    ];
    const provider = resolveProviderId(layers, config.defaultProvider);

    // The provider ID is validated (unlike the model string, deliberately —
    // see below): it addresses an adapter we either have or don't, and a typo
    // would silently fall back to claude at spawn time.
    const adapter = spawner.providerRegistry.get(provider);
    if (!adapter) {
      res.status(400).json({
        error: `unknown provider '${provider}'`,
        code: 'UNKNOWN_PROVIDER',
        known: spawner.providerRegistry.types().map((t) => t.id),
      });
      return;
    }
    // …and refused when we KNOW it cannot run. `pending` (no probe has
    // completed yet) fails OPEN: blocking a team creation because we have not
    // finished asking would be worse than letting the spawn fail with the
    // CLI's own error message in the session log.
    const availability = await spawner.providerAvailability.resolve(provider);
    if (!availability.pending && !availability.available) {
      res.status(409).json({
        error: `provider '${provider}' is not available`,
        code: 'PROVIDER_UNAVAILABLE',
        unavailableReason: availability.reason ?? null,
      });
      return;
    }
    // The model STRING itself is never validated: the code has deliberately
    // never done it (model ids ship far faster than our releases, and a
    // rejected-but-valid id is a worse failure than an accepted-but-wrong one,
    // which the CLI reports on its own). Only the DEFAULT is chosen here — and
    // `permissionMode` is coerced onto what this CLI can express, so the value
    // the team card shows is the value the agent runs under.
    const resolved = resolveAgentDefaults({
      provider: adapter,
      layers,
      fallbackProvider: config.defaultProvider,
      context: { channel: 'POST /orchestrators', team: body.name },
    });
    const model = resolved.model;
    const effort = resolved.effort;
    const permissionMode = resolved.permissionMode;

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
        defaultProvider: provider,
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
          const sessions = spawner.persistence.db.listSessions(r.id).map(sessionView);
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
      const sessions = spawner.persistence.db.listSessions(req.params.id).map(sessionView);
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

  // Relaunch a terminal orchestrator in place — same id/config/history,
  // reusing the auto-resume mechanic. Backs the desktop RESTART / REACTIVATE
  // button so a dead team can come back without a KILL + create-new-team.
  router.post(
    '/orchestrators/:id/restart',
    (req: Request<{ id: string }>, res: Response) => {
      try {
        const orch = spawner.restartOrchestrator(req.params.id);
        res.status(200).json({ orchestrator: orch.toView() });
      } catch (err) {
        if (err instanceof SpawnerError) {
          res.status(err.httpStatus).json({ error: err.message, code: err.code });
          return;
        }
        res.status(500).json({
          error: 'failed to restart orchestrator',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

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

  /**
   * Lot 12 — per-session cost ventilation for ONE team, the drill-down behind
   * an expanded row of the MONITORING page's TEAM COSTS section.
   *
   * Served from SQLite rather than from the live session map, and that is the
   * point: the rows worth naming here are the ones that are GONE (killed,
   * reaped, removed by hand), and they only exist in the database. Live rows
   * come from the same place so both halves are read consistently — the state
   * throttle persists a running agent once a second, so "a second stale" is the
   * worst case, and a cost table does not need better.
   *
   * 404 only when the team exists nowhere: not in the spawner AND with no
   * session row at all. A team that has ended still answers — its history is
   * the most interesting thing about its bill.
   */
  router.get('/orchestrators/:id/cost', (req: Request<{ id: string }>, res: Response) => {
    const orchId = req.params.id;
    let rows: ReturnType<typeof spawner.persistence.db.sessionCostRowsForOrchestrator> = [];
    try {
      rows = spawner.persistence.db.sessionCostRowsForOrchestrator(orchId);
    } catch {
      rows = [];
    }
    if (rows.length === 0 && !spawner.get(orchId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({
      sessions: buildSessionCostViews(rows, (providerId, modelId) =>
        spawner.modelCatalogue?.costRates(providerId, modelId) ?? null,
      ),
    });
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
   * Multi-provider Lot 7 — spawn a worker into an existing team from the UI.
   *
   * This is the HTTP twin of the MCP `team.spawn_worker` tool, and it is
   * deliberately the same operation rather than a parallel one: both funnel into
   * `Orchestrator.addWorker`, which owns the cap check (`WorkerCapError`) and the
   * model/effort/permission/provider inheritance from the team defaults. The
   * only thing this route adds is the validation the MCP layer also does — a
   * clean status code instead of a vague spawn failure.
   *
   * Status codes and what triggers each:
   *   404  orchestrator not in the live map (history rows cannot gain workers)
   *   409  ORCH_NOT_ACTIVE       — team is stopping/stopped/failed
   *   409  PROVIDER_UNAVAILABLE  — provider known not to run here (+ reason)
   *   400  UNKNOWN_PROVIDER      — no adapter with that id
   *   400  malformed / invalid effort or permissionMode
   *   413  prompt (+preamble) over `maxPromptSizeBytes`
   *   429  MAX_WORKERS_PER_ORCH  — worker cap reached, mirroring the 429 that
   *                                `maxOrchestrators` produces on team creation
   *   201  `{ session }` — the new worker's view
   */
  router.post('/orchestrators/:id/workers', async (req: Request<{ id: string }>, res: Response) => {
    // Resource first, then body — same order as the broadcast route below.
    const orch = spawner.get(req.params.id);
    if (!orch) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // `addWorker` throws a bare Error for these; catching it below would turn a
    // perfectly ordinary "the team is already dead" into a 500.
    if (
      orch.status === 'stopped' ||
      orch.status === 'failed' ||
      orch.status === 'stopping'
    ) {
      res.status(409).json({
        error: `cannot spawn a worker while orchestrator is '${orch.status}'`,
        code: 'ORCH_NOT_ACTIVE',
      });
      return;
    }

    const body = (req.body ?? {}) as SpawnWorkerBody;

    if (!isString(body.prompt)) {
      res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
      return;
    }
    if (body.name != null && !isString(body.name)) {
      res.status(400).json({ error: 'name must be a non-empty string if provided' });
      return;
    }
    if (body.role != null && !isString(body.role)) {
      res.status(400).json({ error: 'role must be a non-empty string if provided' });
      return;
    }
    if (body.preamble != null && typeof body.preamble !== 'string') {
      res.status(400).json({ error: 'preamble must be a string if provided' });
      return;
    }
    if (body.model != null && !isString(body.model)) {
      res.status(400).json({ error: 'model must be a non-empty string if provided' });
      return;
    }
    if (body.effort != null && (!isString(body.effort) || !VALID_EFFORTS.has(body.effort))) {
      res.status(400).json({ error: 'effort must be one of low|medium|high|xhigh|max' });
      return;
    }
    if (
      body.permissionMode != null &&
      (!isString(body.permissionMode) || !VALID_PERMS.has(body.permissionMode))
    ) {
      res.status(400).json({ error: 'permissionMode invalid' });
      return;
    }

    // Same envelope as team creation: prompt AND the preamble that gets
    // concatenated onto it, since it is the sum that reaches the agent.
    const preamble = typeof body.preamble === 'string' ? body.preamble : null;
    const promptBytes = bytesOf(body.prompt) + (preamble ? bytesOf(preamble) : 0);
    if (promptBytes > config.maxPromptSizeBytes) {
      res.status(413).json({
        error: `prompt+preamble too large: ${promptBytes} bytes > ${config.maxPromptSizeBytes}`,
      });
      return;
    }

    // Provider: validated here for the same reason as on team creation — an
    // unknown id would otherwise be silently coerced back to the team default
    // by `Orchestrator._resolveProvider`, handing the operator a worker they
    // did not ask for. The model string stays unvalidated, on purpose.
    if (body.provider != null) {
      if (!isString(body.provider)) {
        res.status(400).json({ error: 'provider must be a non-empty string' });
        return;
      }
      if (!spawner.providerRegistry.has(body.provider)) {
        res.status(400).json({
          error: `unknown provider '${body.provider}'`,
          code: 'UNKNOWN_PROVIDER',
          known: spawner.providerRegistry.types().map((t) => t.id),
        });
        return;
      }
      // Shared cache with `GET /providers`, `POST /orchestrators` and the MCP
      // tool — a second one would double the SSH round-trips and could disagree
      // with the first. `pending` fails OPEN, same rule as team creation.
      const availability = await spawner.providerAvailability.resolve(body.provider);
      if (!availability.pending && !availability.available) {
        res.status(409).json({
          error: `provider '${body.provider}' is not available`,
          code: 'PROVIDER_UNAVAILABLE',
          unavailableReason: availability.reason ?? null,
        });
        return;
      }
    }

    // Defaults for the two fields `addWorker` requires but a UI caller may not
    // want to invent: the team's own role, and the naming scheme the role-driven
    // initial workers already use (`spawner.create`).
    // Counted over EVERY worker the team ever had, terminated ones included, so
    // an auto-name is never reused after a worker dies — two log files and two
    // mailbox histories under one name is a debugging trap.
    const workersEver = orch.listSessions().filter((s) => s.type === 'worker').length;
    const name = isString(body.name)
      ? body.name
      : `${orch.name}-worker-${workersEver + 1}`;

    try {
      const worker = orch.addWorker({
        name,
        role: isString(body.role) ? body.role : orch.role,
        prompt: body.prompt,
        // cwd omitted ⇒ `addWorker` uses the lead's (already validated) cwd.
        ...(isString(body.model) ? { model: body.model } : {}),
        ...(isString(body.effort) ? { effort: body.effort as EffortLevel } : {}),
        ...(isString(body.permissionMode)
          ? { permissionMode: body.permissionMode as PermissionMode }
          : {}),
        ...(isString(body.provider) ? { provider: body.provider } : {}),
        ...(preamble !== null ? { preamble } : {}),
      });
      res.status(201).json({ session: worker.toView() });
    } catch (err) {
      if (err instanceof WorkerCapError) {
        res.status(429).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: 'failed to spawn worker',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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
