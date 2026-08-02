/**
 * Skills MCP tools (docs/plan-skills-importables.md §7) — `skills.list`,
 * `skills.activate`, `skills.deactivate`. Mounted on the same team-comms server
 * as the other tool groups. `activate`/`deactivate` are lead-only.
 */

import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, requireLead, logCall, type ToolContext } from './tools.js';
import type { SkillsSubsystem } from '../skills/index.js';

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

export function registerSkillsTools(server: McpServer, ctxResolver: () => ToolContext): void {
  // ---- skills.list ------------------------------------------------------
  server.registerTool(
    'skills.list',
    {
      title: 'List installed skills',
      description:
        'List the skills installed on this swarm-os instance and which are ACTIVE for your team. A skill is a versioned, imported bundle of instructions the operator can turn on for a role/team; an active skill is injected into your preamble.',
      inputSchema: {},
      outputSchema: {
        skills: z.array(z.record(z.string(), z.unknown())),
        active: z.array(z.string()),
      },
    },
    () => {
      const ctx = ctxResolver();
      const skills = skillsOf(ctx, 'skills.list');
      const active = skills.activeNamesForRole(ctx.orchestrator.roleId);
      logCall('skills.list', ctx, true);
      return ok({ skills: skills.list(), active });
    },
  );

  // ---- skills.activate (lead) -------------------------------------------
  server.registerTool(
    'skills.activate',
    {
      title: 'Activate a skill for this team',
      description:
        "Lead-only. Activate an installed skill for this team: its instructions are injected into every FUTURE spawn's preamble (durable) AND announced right now to every live session (hot). Persisted on the team's role when the team has one; on a role-less team the hot notice still fires but nothing is persisted.",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(),
        found: z.boolean(),
        persisted: z.boolean(),
        injected: z.number(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'skills.activate');
      const skills = skillsOf(ctx, 'skills.activate');
      const name = (args as { name: string }).name;
      const r = skills.activate(ctx.orchestrator, name);
      if (!r.found) {
        logCall('skills.activate', ctx, false, 'SKILL_NOT_FOUND');
        throw new McpError(ErrorCode.InvalidParams, `SKILL_NOT_FOUND: no installed skill named '${name}'`);
      }
      logCall('skills.activate', ctx, true);
      return ok({ name, found: r.found, persisted: r.persisted, injected: r.injected });
    },
  );

  // ---- skills.deactivate (lead) -----------------------------------------
  server.registerTool(
    'skills.deactivate',
    {
      title: 'Deactivate a skill for this team',
      description:
        "Lead-only. Deactivate a skill for this team: removed from future spawns' preamble and a retract notice is sent to every live session.",
      inputSchema: { name: z.string() },
      outputSchema: {
        name: z.string(),
        found: z.boolean(),
        persisted: z.boolean(),
        injected: z.number(),
      },
    },
    (args) => {
      const ctx = ctxResolver();
      requireLead(ctx, 'skills.deactivate');
      const skills = skillsOf(ctx, 'skills.deactivate');
      const name = (args as { name: string }).name;
      const r = skills.deactivate(ctx.orchestrator, name);
      if (!r.found) {
        logCall('skills.deactivate', ctx, false, 'SKILL_NOT_FOUND');
        throw new McpError(ErrorCode.InvalidParams, `SKILL_NOT_FOUND: no installed skill named '${name}'`);
      }
      logCall('skills.deactivate', ctx, true);
      return ok({ name, found: r.found, persisted: r.persisted, injected: r.injected });
    },
  );
}
