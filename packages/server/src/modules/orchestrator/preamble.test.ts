import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildPreamble,
  buildPluginToolsSection,
  renderMcpToolNames,
  TEAM_TOOL_LOGICAL_NAMES,
  type McpToolNamer,
  type PluginToolSummary,
} from './preamble.js';
import { SIGNAL_TEXT } from './messaging.js';
import { Orchestrator } from './index.js';
import { createBuiltinProviderRegistry, ProviderRegistry } from '../providers/index.js';
import { FakeProvider } from '../providers/fake.js';
import { registerTeamCommsTools } from '../mcp/tools.js';
import { registerMemoryTools } from '../mcp/memory-tools.js';
import type { Config } from '../../config.js';

/**
 * Phase 7 — preamble templating.
 *
 * The default Markdown lives next to the module — we don't reload it here,
 * we just verify the substitution + override concatenation behaviour.
 */

const ID = {
  name: 'merge-team-lead',
  role: 'coordinator',
  sessionId: 'sess-00001',
  orchName: 'merge-team',
};

describe('buildPreamble', () => {
  it('substitutes every placeholder for a lead', () => {
    const out = buildPreamble({ identity: ID, isLead: true });
    expect(out).toContain('merge-team-lead');
    expect(out).toContain('coordinator');
    expect(out).toContain('sess-00001');
    expect(out).toContain('merge-team');
    expect(out).not.toContain('{{');
  });

  it('lead and worker preambles are distinct', () => {
    const lead = buildPreamble({ identity: ID, isLead: true });
    const worker = buildPreamble({ identity: ID, isLead: false });
    expect(lead).not.toBe(worker);
    expect(lead.toLowerCase()).toContain('lead');
    // Worker preamble must NOT advertise spawn_worker as available — that's
    // lead-only per plan §10. We don't pin the exact phrasing, just look
    // for an explicit gate.
    expect(worker.toLowerCase()).toMatch(/lead-only|lead only|spawn_worker/);
  });

  it('appends the override after the default with a separator', () => {
    const out = buildPreamble({
      identity: ID,
      isLead: false,
      customOverride: 'Project specific: only touch the /workspace/example dir.',
    });
    expect(out).toContain('Project specific: only touch the /workspace/example dir.');
    expect(out).toContain('Project-specific instructions');
    // The default must still be present in front of the override.
    expect(out.indexOf('Project specific:')).toBeGreaterThan(100);
  });

  it('treats null/undefined/empty/whitespace override as no override', () => {
    const baseline = buildPreamble({ identity: ID, isLead: true });
    expect(buildPreamble({ identity: ID, isLead: true, customOverride: null })).toBe(baseline);
    expect(buildPreamble({ identity: ID, isLead: true, customOverride: '' })).toBe(baseline);
    expect(buildPreamble({ identity: ID, isLead: true, customOverride: '   ' })).toBe(baseline);
  });

  // NOTE: the resume notice is no longer folded into the preamble. It now
  // rides the positional prompt (durable preamble → `--append-system-prompt`,
  // one-shot notice → positional argv) so a `/clear` discards it instead of
  // re-surfacing a stale restart notice. See `buildClaudeArgs` tests.
});

// ---------------------------------------------------------------------------
// Lot 9b — provider-aware tool naming
//
// Three of the four CLIs rename MCP tools before the model ever sees them. A
// preamble that names `team.whoami` to a gemini agent describes a tool that does
// not exist in its schema: the agent improvises or quietly abandons team comms,
// and an agent without `team.*` is not a member of the swarm. These tests pin
// what each provider is actually told.
// ---------------------------------------------------------------------------

/** The name each provider must render for `team.whoami`, MEASURED per adapter. */
const EXPECTED_WHOAMI: Record<string, string> = {
  claude: 'team.whoami',
  codex: 'team_whoami',
  gemini: 'mcp_team-comms_team.whoami',
  opencode: 'team_team_whoami',
};

function namerFor(id: string): McpToolNamer {
  const p = createBuiltinProviderRegistry().get(id);
  if (!p) throw new Error(`no provider '${id}'`);
  return (n) => p.mcpToolName(n);
}

describe('buildPreamble — MCP tool naming per provider', () => {
  for (const [id, whoami] of Object.entries(EXPECTED_WHOAMI)) {
    it(`renders the ${id} spelling of every team tool`, () => {
      const namer = namerFor(id);
      const out = buildPreamble({ identity: ID, isLead: true, mcpToolName: namer });
      expect(out).toContain(`\`${whoami}()\``);
      // Not just the one name: everything the vocabulary knows, so a partial
      // substitution (a name missing from `TEAM_TOOL_LOGICAL_NAMES`) shows up
      // here rather than in a live agent.
      expect(out).toContain(namer('team.send_message'));
      expect(out).toContain(namer('team.read_inbox'));
      expect(out).toContain(namer('team.spawn_worker'));
      expect(out).toContain(namer('swarm.list_teams'));
      expect(out).toContain(namer('discord.send_message'));
    });
  }

  it('leaves NOTHING canonical behind for a renaming provider', () => {
    // The complement of the test above: after rendering, no dotted name may
    // survive anywhere except (a) the quoted PTY signal, which is server-side
    // text, and (b) the naming note, whose whole job is to show the mapping.
    // This is what catches a tool mentioned in the Markdown but absent from
    // `TEAM_TOOL_LOGICAL_NAMES`.
    for (const id of ['codex', 'gemini', 'opencode']) {
      for (const isLead of [true, false]) {
        const out = buildPreamble({ identity: ID, isLead, mcpToolName: namerFor(id) });
        const body = out
          .split('## Tool naming on this runtime')[0]!
          .split(SIGNAL_TEXT)
          .join('<signal>');
        for (const logical of TEAM_TOOL_LOGICAL_NAMES) {
          // As a standalone token: gemini's own rendering *contains* the
          // canonical name (`mcp_team-comms_team.whoami`), so a substring test
          // would be vacuously true for it.
          const asToken = new RegExp(
            `(?<![\\w.\\-])${logical.replace(/\./g, '\\.')}(?!\\w)`,
            'g',
          );
          expect(
            asToken.test(body),
            `${id} ${isLead ? 'lead' : 'worker'} still names ${logical}`,
          ).toBe(false);
        }
      }
    }
  });

  it('claude renders byte for byte what it got before there was a namer', () => {
    // The non-regression gate for the ONLY provider running in production: the
    // identity namer must be a no-op, note included (there is none).
    for (const isLead of [true, false]) {
      const withNamer = buildPreamble({ identity: ID, isLead, mcpToolName: namerFor('claude') });
      const without = buildPreamble({ identity: ID, isLead });
      expect(withNamer).toBe(without);
      expect(withNamer).not.toContain('Tool naming on this runtime');
    }
  });

  it('quotes the PTY signal VERBATIM for every provider', () => {
    // `messaging.ts` injects this exact line, canonical dotted name and all.
    // Rendering it through the namer would tell the agent to watch for a line
    // the server never writes — the same class of lie this lot removes.
    for (const id of Object.keys(EXPECTED_WHOAMI)) {
      for (const isLead of [true, false]) {
        const out = buildPreamble({ identity: ID, isLead, mcpToolName: namerFor(id) });
        expect(out).toContain(SIGNAL_TEXT);
        expect(out).not.toContain('{{inboxSignal}}');
      }
    }
  });

  it('attaches the naming note only when names actually change', () => {
    expect(buildPreamble({ identity: ID, isLead: true, mcpToolName: namerFor('claude') })).not
      .toContain('Tool naming on this runtime');
    for (const id of ['codex', 'gemini', 'opencode']) {
      const out = buildPreamble({ identity: ID, isLead: true, mcpToolName: namerFor(id) });
      expect(out).toContain('Tool naming on this runtime');
      // The note must carry the mapping, not just the warning.
      expect(out).toContain(`\`${EXPECTED_WHOAMI[id]}\` (canonical \`team.whoami\`)`);
    }
  });

  it('keeps every rendered name inside the 63-char CLI limit', () => {
    // gemini truncates a name over 63 chars into `<30>...<30>`, which would put
    // an ellipsis in the middle of a tool name. Codex/OpenAI reject long
    // function names outright. Pinned so adding `team.some_very_long_tool` fails
    // here instead of in a live agent.
    for (const id of Object.keys(EXPECTED_WHOAMI)) {
      const namer = namerFor(id);
      for (const logical of TEAM_TOOL_LOGICAL_NAMES) {
        expect(namer(logical).length, `${id}:${logical}`).toBeLessThanOrEqual(63);
      }
    }
  });
});

describe('renderMcpToolNames — what it must NOT touch', () => {
  const gemini = () => namerFor('gemini');

  it('leaves a text that mentions no tool byte-identical', () => {
    const text = [
      'Ship the parser refactor. The team lists its work in TASKS.md.',
      'Read discord.com/channels for the spec, then run `npm.list` and team-list.sh.',
      'Do not touch teams.whoami_cache or my_team.whoami_helper().',
    ].join('\n');
    expect(renderMcpToolNames(text, gemini())).toBe(text);
  });

  it('renders an operator-supplied preamble too', () => {
    // A custom `roles.lead_preamble` naming the canonical tools is exactly as
    // wrong as the default was; the override goes through the same rendering.
    const out = buildPreamble({
      identity: ID,
      isLead: true,
      customOverride: 'When the build is green, call team.broadcast, then team.context_clear().',
      mcpToolName: gemini(),
    });
    expect(out).toContain('call mcp_team-comms_team.broadcast, then');
    expect(out).toContain('mcp_team-comms_team.context_clear()');
    expect(out).not.toContain('call team.broadcast');
  });

  it('does not re-mangle a name that is already rendered', () => {
    // An operator who copies a name out of a live gemini session must not end up
    // with `mcp_team-comms_mcp_team-comms_team.whoami`.
    const text = 'Call mcp_team-comms_team.whoami and team_team_whoami first.';
    expect(renderMcpToolNames(text, gemini())).toBe(text);
  });

  it('keeps the canonical name when a provider returns nothing usable', () => {
    // A third-party adapter must not be able to blank the mailbox discipline.
    const broken = (() => '') as unknown as McpToolNamer;
    expect(renderMcpToolNames('call team.read_inbox now', broken)).toBe('call team.read_inbox now');
  });
});

describe('Orchestrator wiring — each session is rendered for ITS provider', () => {
  // The unit tests above pin the rendering; this one pins that the renderer is
  // actually reached, per session, with the right provider — the failure mode
  // being a mixed team whose gemini worker is handed claude's tool names.
  let tmpRoot: string;
  let renaming: FakeProvider;
  let plain: FakeProvider;
  let orch: Orchestrator | null = null;

  /** `x_team_whoami` — renames, and is nobody's real mangling on purpose. */
  const rename = (n: string): string => `x_${n.replace(/\./g, '_')}`;

  function orchestrator(): Orchestrator {
    plain = new FakeProvider({ id: 'claude', binary: 'sh' });
    renaming = new FakeProvider({ id: 'renamecli', binary: 'sh', mcpToolName: rename });
    const registry = new ProviderRegistry();
    registry.register(plain, { builtin: true });
    registry.register(renaming, { builtin: true });
    const config = {
      mcpPort: 8788,
      port: 8787,
      logsDir: path.join(tmpRoot, 'logs'),
      mcpRuntimeDir: path.join(tmpRoot, 'mcp-runtime'),
      idleThresholdMs: 50,
      maxWorkersPerOrch: 5,
      contextAutoCompactBytes: 0,
      hookToken: 'hk',
      claudeRuntimeDir: null,
      claudeSourceDir: null,
      claudeJsonSource: null,
      defaultProvider: 'claude',
      defaultModel: 'm',
      defaultEffort: 'low',
      defaultPermissionMode: 'bypassPermissions',
      agentTransport: 'local',
    } as unknown as Config;
    orch = new Orchestrator(
      {
        name: 'mixed',
        role: 'co',
        defaultModel: 'm',
        defaultEffort: 'low',
        defaultPermissionMode: 'bypassPermissions',
        defaultProvider: 'claude',
        leadPreamble: null,
        workerPreamble: null,
        lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
      },
      config,
      { providerRegistry: registry },
    );
    return orch;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-preamble-wiring-'));
    fs.mkdirSync(path.join(tmpRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'mcp-runtime'), { recursive: true });
  });

  afterEach(async () => {
    // Close the session log streams BEFORE the directory goes away: a write
    // that lands after the `rmSync` surfaces as an unhandled ENOENT and
    // poisons the whole run's error count.
    orch?.stop('test-cleanup');
    orch = null;
    await new Promise((r) => setTimeout(r, 30));
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("renders the worker preamble for the worker's own provider", () => {
    const o = orchestrator();
    o.start({ skipSpawn: true });
    o.addWorker({
      name: 'w1',
      role: 'scout',
      prompt: 'go',
      provider: 'renamecli',
      skipSpawn: true,
    });
    // `prepareSessionConfig` runs in the Session constructor and receives the
    // assembled preamble — the exact text the agent will be given.
    const leadText = plain.configRequests[0]?.preamble ?? '';
    const workerText = renaming.configRequests[0]?.preamble ?? '';
    expect(leadText).toContain('`team.whoami()`');
    expect(leadText).not.toContain('x_team_whoami');
    expect(workerText).toContain('`x_team_whoami()`');
    expect(workerText).toContain('Tool naming on this runtime');
    expect(workerText).not.toContain('`team.whoami()`');
    // …and the worker text is the WORKER default, not the lead's.
    expect(workerText).toContain('x_team_spawn_worker');
    expect(workerText).toMatch(/lead-only/);
  });
});

describe('TEAM_TOOL_LOGICAL_NAMES', () => {
  it('is exactly what the MCP server registers', () => {
    // Drift guard. The tools mounted on the `team-comms` server are the source
    // of truth; a tool added there and missing here would be handed to
    // gemini/codex/opencode agents under a name that does not exist, which is
    // precisely the bug this lot fixes. Both the built-in team-comms tools AND
    // the shared-memory tools mount on the same server, so both must be counted.
    // Only `registerTool` is ever called on the server, so a recorder is a
    // sufficient stand-in.
    const registered: string[] = [];
    const stub = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as McpServer;
    const resolver = () => {
      throw new Error('the context resolver must not run at registration time');
    };
    registerTeamCommsTools(stub, resolver);
    registerMemoryTools(stub, resolver);
    expect([...registered].sort()).toEqual([...TEAM_TOOL_LOGICAL_NAMES].sort());
  });

  it('contains no name that is a prefix of another', () => {
    // The substitution regex relies on it: `(?!\w)` is enough to end a match
    // only because no longer candidate can start where a shorter one ends.
    for (const a of TEAM_TOOL_LOGICAL_NAMES) {
      for (const b of TEAM_TOOL_LOGICAL_NAMES) {
        if (a !== b) expect(b.startsWith(a), `${a} is a prefix of ${b}`).toBe(false);
      }
    }
  });
});

/**
 * Plugin tools in the preamble.
 *
 * Regression origin, worth keeping in the file: on the `test` instance a lead
 * was asked to use NovelAI, had `novelai.generate_text` in its own MCP tool
 * list, and answered by writing the prose itself and offering to draft a curl
 * script. The default preamble presents `team-comms` as the coordination
 * server and lists a closed vocabulary; nothing said plugin tools ride on the
 * same server. So the tools below must reach EVERY preamble — including one
 * whose role carries a custom override.
 */
const PLUGIN_TOOLS = [
  {
    pluginName: 'novelai',
    qualifiedName: 'novelai.generate_voice',
    title: 'Synthetiser de la voix (NovelAI TTS)',
    leadOnly: false,
  },
  {
    pluginName: 'novelai',
    qualifiedName: 'novelai.generate_text',
    title: 'Generer de la prose (NovelAI Erato)',
    leadOnly: false,
  },
  {
    pluginName: 'discord-agent',
    qualifiedName: 'discord-agent.reply',
    title: 'Repondre sur Discord',
    leadOnly: true,
  },
];

describe('buildPluginToolsSection', () => {
  it('is null when no plugin tool is registered', () => {
    expect(buildPluginToolsSection([], { isLead: true })).toBeNull();
  });

  it('is null for a worker when every registered tool is lead-only', () => {
    const leadOnly = PLUGIN_TOOLS.filter((t) => t.leadOnly);
    expect(buildPluginToolsSection(leadOnly, { isLead: false })).toBeNull();
    expect(buildPluginToolsSection(leadOnly, { isLead: true })).not.toBeNull();
  });

  it('lists every tool for a lead, sorted, and marks the lead-only ones', () => {
    const out = buildPluginToolsSection(PLUGIN_TOOLS, { isLead: true }) ?? '';
    expect(out).toContain('`discord-agent.reply`');
    expect(out).toContain('`novelai.generate_text`');
    expect(out).toContain('`novelai.generate_voice`');
    expect(out).toContain('Generer de la prose (NovelAI Erato)');
    expect(out).toMatch(/`discord-agent\.reply`.*\(lead only\)/);
    // Deterministic order — the section rides in a system prompt, so it must
    // not churn between two spawns of the same team.
    expect(out.indexOf('discord-agent.reply')).toBeLessThan(out.indexOf('novelai.generate_text'));
    expect(out.indexOf('novelai.generate_text')).toBeLessThan(
      out.indexOf('novelai.generate_voice'),
    );
  });

  it('hides lead-only tools from a worker', () => {
    const out = buildPluginToolsSection(PLUGIN_TOOLS, { isLead: false }) ?? '';
    expect(out).not.toContain('discord-agent.reply');
    expect(out).toContain('novelai.generate_text');
  });

  it('renders plugin tool names for the target CLI', () => {
    const namer: McpToolNamer = (n) => `x_${n.replace(/[.-]/g, '_')}`;
    const out = buildPluginToolsSection(PLUGIN_TOOLS, { isLead: true, namer }) ?? '';
    expect(out).toContain('`x_novelai_generate_text`');
    expect(out).not.toContain('`novelai.generate_text`');
  });

  it('keeps the canonical name when the namer returns nothing usable', () => {
    // Same contract as `renderMcpToolNames`: a broken adapter must not be able
    // to blank a tool name out of the listing.
    const out =
      buildPluginToolsSection(PLUGIN_TOOLS, {
        isLead: true,
        namer: () => '',
      }) ?? '';
    expect(out).toContain('`novelai.generate_text`');
  });

  it('truncates a title so one plugin cannot bloat every system prompt', () => {
    const out =
      buildPluginToolsSection(
        [{ pluginName: 'p', qualifiedName: 'p.t', title: 'A'.repeat(400), leadOnly: false }],
        { isLead: true },
      ) ?? '';
    expect(out).toContain('A'.repeat(120));
    expect(out).not.toContain('A'.repeat(121));
  });
});

describe('buildPreamble — the plugin section is unconditional', () => {
  it('survives a role-supplied custom preamble, and precedes it', () => {
    const text = buildPreamble({
      identity: ID,
      isLead: true,
      customOverride: 'Ship only what the ticket asks for.',
      pluginTools: PLUGIN_TOOLS,
    });
    expect(text).toContain('## Plugin tools (MCP)');
    expect(text).toContain('`novelai.generate_text`');
    expect(text).toContain('Ship only what the ticket asks for.');
    expect(text.indexOf('## Plugin tools (MCP)')).toBeLessThan(
      text.indexOf('## Project-specific instructions'),
    );
  });

  it('adds nothing at all when no plugin is enabled', () => {
    const text = buildPreamble({ identity: ID, isLead: true });
    expect(text).not.toContain('Plugin tools');
  });

  it('precedes the tool-naming note, which claims the names above are rendered', () => {
    const namer: McpToolNamer = (n) => `x_${n.replace(/[.-]/g, '_')}`;
    const text = buildPreamble({
      identity: ID,
      isLead: true,
      mcpToolName: namer,
      pluginTools: PLUGIN_TOOLS,
    });
    expect(text.indexOf('## Plugin tools (MCP)')).toBeLessThan(
      text.indexOf('## Tool naming on this runtime'),
    );
    expect(text).toContain('`x_novelai_generate_text`');
  });
});

describe('Orchestrator wiring — the plugin snapshot reaches every session', () => {
  let tmpRoot: string;
  let plain: FakeProvider;
  let orch: Orchestrator | null = null;

  function orchestrator(pluginTools?: () => readonly PluginToolSummary[]): Orchestrator {
    plain = new FakeProvider({ id: 'claude', binary: 'sh' });
    const registry = new ProviderRegistry();
    registry.register(plain, { builtin: true });
    const config = {
      mcpPort: 8788,
      port: 8787,
      logsDir: path.join(tmpRoot, 'logs'),
      mcpRuntimeDir: path.join(tmpRoot, 'mcp-runtime'),
      idleThresholdMs: 50,
      maxWorkersPerOrch: 5,
      contextAutoCompactBytes: 0,
      hookToken: 'hk',
      claudeRuntimeDir: null,
      claudeSourceDir: null,
      claudeJsonSource: null,
      defaultProvider: 'claude',
      defaultModel: 'm',
      defaultEffort: 'low',
      defaultPermissionMode: 'bypassPermissions',
      agentTransport: 'local',
    } as unknown as Config;
    orch = new Orchestrator(
      {
        name: 'plugged',
        role: 'co',
        defaultModel: 'm',
        defaultEffort: 'low',
        defaultPermissionMode: 'bypassPermissions',
        defaultProvider: 'claude',
        // A role that overrides BOTH preambles — the exact configuration in
        // which the operator's text must not be able to hide the tools.
        leadPreamble: 'Custom lead rules.',
        workerPreamble: 'Custom worker rules.',
        lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
      },
      config,
      { providerRegistry: registry, ...(pluginTools ? { pluginTools } : {}) },
    );
    return orch;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-preamble-plugins-'));
    fs.mkdirSync(path.join(tmpRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'mcp-runtime'), { recursive: true });
  });

  afterEach(async () => {
    orch?.stop('test-cleanup');
    orch = null;
    await new Promise((r) => setTimeout(r, 30));
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('lands in the lead AND the worker preamble despite custom role text', () => {
    const o = orchestrator(() => PLUGIN_TOOLS);
    o.start({ skipSpawn: true });
    o.addWorker({ name: 'w1', role: 'scout', prompt: 'go', skipSpawn: true });

    const leadText = plain.configRequests[0]?.preamble ?? '';
    const workerText = plain.configRequests[1]?.preamble ?? '';

    expect(leadText).toContain('## Plugin tools (MCP)');
    expect(leadText).toContain('`novelai.generate_text`');
    expect(leadText).toContain('Custom lead rules.');
    expect(workerText).toContain('`novelai.generate_text`');
    expect(workerText).toContain('Custom worker rules.');
    // The lead-only plugin tool is the lead's alone.
    expect(leadText).toContain('discord-agent.reply');
    expect(workerText).not.toContain('discord-agent.reply');
  });

  it('is re-read per session, so a plugin enabled mid-team reaches the next worker', () => {
    const live = [...PLUGIN_TOOLS];
    const o = orchestrator(() => live);
    o.start({ skipSpawn: true });
    live.push({
      pluginName: 'late',
      qualifiedName: 'late.tool',
      title: 'Enabled after the lead started',
      leadOnly: false,
    });
    o.addWorker({ name: 'w1', role: 'scout', prompt: 'go', skipSpawn: true });

    expect(plain.configRequests[0]?.preamble ?? '').not.toContain('late.tool');
    expect(plain.configRequests[1]?.preamble ?? '').toContain('`late.tool`');
  });

  it('a throwing snapshot costs the listing, never the team', () => {
    const o = orchestrator(() => {
      throw new Error('registry exploded');
    });
    expect(() => o.start({ skipSpawn: true })).not.toThrow();
    const leadText = plain.configRequests[0]?.preamble ?? '';
    expect(leadText).not.toContain('Plugin tools');
    // The discipline language is untouched — that is the part worth protecting.
    expect(leadText).toContain('`team.read_inbox()`');
  });
});
