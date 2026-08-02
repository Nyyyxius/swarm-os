/**
 * Skills MCP tools (docs/plan-skills-importables.md §7) — `skills.list`,
 * `skills.show`, `skills.activate`, `skills.deactivate`. Mounted on the same
 * team-comms server as the other tool groups. `activate`/`deactivate` are
 * lead-only and scope to the team (`orch`, default), a session, or the role.
 */

import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, requireLead, logCall, type ToolContext } from './tools.js';
import type { SkillsSubsystem, SkillScope } from '../skills/index.js';

/** Resolve the subsystem or throw a clean MCP error (pre-skills test fixtures). */
function skillsOf(ctx: ToolContext, tool: string): SkillsSubsystem {
  if (!ctx.skills) {
    logCall(tool, ctx, false, 'SKILLS_UNAVAILABLE');
    throw new McpError(
      ErrorCode.InternalError,
      'SKILLS_UNAVAILABLE: the skills subsystem is not configured on this deployment',
    );
  }
  return ctx.skills;
}

const SCOPE_ENUM = z.enum(['role', 'orch', 'session']);

export function registerSkillsTools(server: McpServer, ctxResolver: () => ToolContext): void {
  // ---- skills.list ------------------------------------------------------
  server.registerTool(
    'skills.list',
    {
      title: 'List installed skills',
      description:
        'List the skills installed on this swarm-os instance and which are ACTIVE for YOU (role + team + session scopes merged). A skill is a versioned, imported bundle of instructions the operator can turn on; an active skill is injected into your preamble.',
      inputSchema: {},
      outputSchema: {
        skills: z.array(z.record(z.string(), z.unknown())),
        // Each active skill tagged with the scope that activated it (role/orch/session).
        active: z.array(z.object({ name: z.string(), scope: z.string() })),
      },
    },
    () => {
      const ctx = ctxResolver();
      const skills = skillsOf(ctx, 'skills.list');
      const active = skills.activeForSession(
        ctx.orchestrator.roleId,
        ctx.orchestrator.id,
        ctx.session.id,
      );
      logCall('skills.list', ctx, true);
      return ok({ skills: skills.list(), active });
    },
  );

  // ---- skills.show ------------------------------------------------------
  server.registerTool(
    'skills.show',
    {
      title: 'Show one skill (metadata + body)',
      description:
        'Return an installed skill\'s metadata and its full SKILL.md body — the exact instructions that get injected when it is active.',
      inputSchema: { name: z.string() },
      outputSchema: {
        found: z.boolean(),
        skill: z.record(z.string(), z.unknown()).nullable(),
        body: z.string().nullable(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      const skills = skillsOf(ctx, 'skills.show');
      const name = (args as { name: string }).name;
      const skill = skills.getView(name);
      logCall('skills.show', ctx, true);
      return ok({ found: skill != null, skill, body: skill ? skills.getBody(name) : null });
    },
  );

  // ---- skills.activate (lead) -------------------------------------------
  server.registerTool(
    'skills.activate',
    {
      title: 'Activate a skill',
      description:
        "Lead-only. Activate an installed skill. `scope` defaults to 'orch' (this team), or 'session' (one worker — `sessionId`, defaults to yours) or 'role' (the team's role template, affecting ALL its teams). It is injected into every FUTURE matching spawn's preamble (durable) AND announced now to the relevant live session(s) (hot).",
      inputSchema: { name: z.string(), scope: SCOPE_ENUM.optional(), sessionId: z.string().optional() },
      outputSchema: {
        name: z.string(),
        scope: z.string(),
        found: z.boolean(),
        persisted: z.boolean(),
        injected: z.number(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'skills.activate');
      const skills = skillsOf(ctx, 'skills.activate');
      const a = args as { name: string; scope?: SkillScope; sessionId?: string };
      const scope: SkillScope = a.scope ?? 'orch';
      const r = skills.activate({
        name: a.name,
        scope,
        orchestratorId: ctx.orchestrator.id,
        sessionId: scope === 'session' ? a.sessionId ?? ctx.session.id : undefined,
      });
      if (!r.found) {
        logCall('skills.activate', ctx, false, 'SKILL_NOT_FOUND');
        throw new McpError(ErrorCode.InvalidParams, `SKILL_NOT_FOUND: no installed skill named '${a.name}'`);
      }
      logCall('skills.activate', ctx, true);
      return ok({ name: a.name, scope, found: r.found, persisted: r.persisted, injected: r.injected });
    },
  );

  // ---- skills.deactivate (lead) -----------------------------------------
  server.registerTool(
    'skills.deactivate',
    {
      title: 'Deactivate a skill',
      description:
        "Lead-only. Deactivate a skill at a scope (default 'orch'; 'session' or 'role'). Removed from future matching spawns' preamble and a retract notice is sent to the relevant live session(s). At orch/session scope this also SUPPRESSES a broader (role/orch) activation for that scope.",
      inputSchema: { name: z.string(), scope: SCOPE_ENUM.optional(), sessionId: z.string().optional() },
      outputSchema: {
        name: z.string(),
        scope: z.string(),
        found: z.boolean(),
        persisted: z.boolean(),
        injected: z.number(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'skills.deactivate');
      const skills = skillsOf(ctx, 'skills.deactivate');
      const a = args as { name: string; scope?: SkillScope; sessionId?: string };
      const scope: SkillScope = a.scope ?? 'orch';
      const r = skills.deactivate({
        name: a.name,
        scope,
        orchestratorId: ctx.orchestrator.id,
        sessionId: scope === 'session' ? a.sessionId ?? ctx.session.id : undefined,
      });
      if (!r.found) {
        logCall('skills.deactivate', ctx, false, 'SKILL_NOT_FOUND');
        throw new McpError(ErrorCode.InvalidParams, `SKILL_NOT_FOUND: no installed skill named '${a.name}'`);
      }
      logCall('skills.deactivate', ctx, true);
      return ok({ name: a.name, scope, found: r.found, persisted: r.persisted, injected: r.injected });
    },
  );
}
