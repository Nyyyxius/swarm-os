/**
 * docs/outils-par-role.md (v0.10.2) — which team-comms tools a session sees.
 */
import { describe, it, expect } from 'vitest';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  LEAD_ONLY_MCP_TOOLS,
  filteredRegistrar,
  mcpToolKey,
  mcpToolPredicate,
} from './tool-filter.js';
import { MCP_CORE_TOOLS } from '../roles/index.js';

describe('mcpToolKey', () => {
  it('maps the dotted, sanitised and fully-qualified spellings to one key', () => {
    const k = mcpToolKey('team.send_message');
    expect(mcpToolKey('team_send_message')).toBe(k);
    expect(mcpToolKey('mcp__team-comms__team_send_message')).toBe(k);
    expect(mcpToolKey('  team.send_message ')).toBe(k);
  });
});

describe('mcpToolPredicate', () => {
  it('shows a lead every tool when its role sets no list', () => {
    const allow = mcpToolPredicate({ isLead: true, allowList: null });
    for (const t of [...LEAD_ONLY_MCP_TOOLS, 'memory.search', 'board.list', 'discord-agent.reply']) {
      expect(allow(t)).toBe(true);
    }
  });

  it('hides lead-only tools from a worker even with no list, and keeps the partial ones', () => {
    const allow = mcpToolPredicate({ isLead: false, allowList: null });
    for (const t of LEAD_ONLY_MCP_TOOLS) expect(allow(t)).toBe(false);
    for (const t of ['board.assign', 'board.list', 'board.get', 'discord.send_message', 'memory.search']) {
      expect(allow(t)).toBe(true);
    }
  });

  it('hides lead-only PLUGIN tools from workers only', () => {
    const w = mcpToolPredicate({ isLead: false, allowList: null, pluginLeadOnly: ['discord-agent.reply'] });
    const l = mcpToolPredicate({ isLead: true, allowList: null, pluginLeadOnly: ['discord-agent.reply'] });
    expect(w('discord-agent.reply')).toBe(false);
    expect(l('discord-agent.reply')).toBe(true);
  });

  it('applies an allow-list on top of the core set, whatever spelling the list uses', () => {
    const allow = mcpToolPredicate({
      isLead: false,
      allowList: ['memory_search', 'mcp__team-comms__board_move'],
    });
    expect(allow('memory.search')).toBe(true);
    expect(allow('board.move')).toBe(true);
    expect(allow('memory.write')).toBe(false);
    expect(allow('board.create')).toBe(false);
    for (const t of MCP_CORE_TOOLS) expect(allow(t)).toBe(true);
  });

  it('never lets an allow-list re-expose a lead-only tool to a worker', () => {
    const allow = mcpToolPredicate({ isLead: false, allowList: ['team.spawn_worker'] });
    expect(allow('team.spawn_worker')).toBe(false);
  });
});

describe('filteredRegistrar', () => {
  it('registers only the tools the predicate accepts on the real server', () => {
    const real = new SdkMcpServer({ name: 't', version: '0' }, { capabilities: {} });
    const view = filteredRegistrar(real, (n) => n !== 'b.hidden');
    const handler = async () => ({ content: [] });
    view.registerTool('a.kept', { description: 'x', inputSchema: { q: z.string() } }, handler);
    view.registerTool('b.hidden', { description: 'y' }, handler);
    const registered = Object.keys(
      (real as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(registered).toEqual(['a.kept']);
  });
});
