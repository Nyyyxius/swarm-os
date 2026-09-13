import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNAL_TEXT } from './messaging.js';

/**
 * Per-session preamble builder (plan §11).
 *
 * The default texts live as Markdown next to this file under `../preambles/`
 * so they can be edited as plain documentation rather than as JS string
 * literals. They are loaded ONCE at module import via `fs.readFileSync` and
 * memoized — they are static for the lifetime of the process.
 *
 * `buildPreamble` substitutes the `{{var}}` placeholders, RENAMES the MCP tools
 * to whatever the target CLI actually calls them (see `mcpToolName` below), then
 * concatenates the orchestrator-level override (if provided). The override is
 * appended AFTER the default so per-orchestrator instructions can refine without
 * losing the canonical mailbox-discipline language.
 */

// In ESM, __dirname is not defined; derive from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the markdown sources at module load time. `tsx` runs straight
// from src/, `tsc` compiles to dist/ but the relative layout under
// `modules/preambles/` is identical in both — so this single path works
// for dev (`pnpm dev`) and prod (`node dist/index.js`).
const PREAMBLES_DIR = path.resolve(__dirname, '..', 'preambles');

let cachedLeadDefault: string | null = null;
let cachedWorkerDefault: string | null = null;

function loadDefault(file: string): string {
  const full = path.join(PREAMBLES_DIR, file);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    // The file is shipped with the build; if it's missing, that's a packaging
    // bug. Throw loudly at first call rather than silently degrading the
    // worker's discipline.
    throw new Error(
      `failed to load default preamble at ${full}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getLeadDefault(): string {
  if (cachedLeadDefault === null) cachedLeadDefault = loadDefault('default-lead.md');
  return cachedLeadDefault;
}

export function getWorkerDefault(): string {
  if (cachedWorkerDefault === null) cachedWorkerDefault = loadDefault('default-worker.md');
  return cachedWorkerDefault;
}

/**
 * Every tool the team-comms MCP server registers, by LOGICAL name.
 *
 * This is the closed vocabulary the renderer will translate — a closed list and
 * not a `\b(team|swarm|discord)\.\w+\b` pattern, because an operator's custom
 * preamble is rendered through the same substitution and a pattern would happily
 * rewrite `discord.com` or `team.py` into a tool name. Anything not in this list
 * is left exactly as written.
 *
 * MUST stay in sync with the tools registered on the `team-comms` MCP server —
 * both `registerTeamCommsTools` (`modules/mcp/tools.ts`) AND `registerMemoryTools`
 * (`modules/mcp/memory-tools.ts`), which mount on the same server.
 * `preamble.test.ts` registers the real tools on a recording stub and fails if
 * the two ever diverge, so a new tool cannot ship with a preamble that names it
 * wrongly for three of the four providers.
 */
export const TEAM_TOOL_LOGICAL_NAMES: readonly string[] = [
  'team.whoami',
  'team.list',
  'team.send_message',
  'team.read_inbox',
  'team.broadcast',
  'team.spawn_worker',
  'team.kill_worker',
  'team.kill_all_workers',
  'team.context_compact',
  'team.context_clear',
  'team.clear_worker',
  'swarm.list_teams',
  'swarm.send_to_lead',
  'swarm.broadcast_to_leads',
  'discord.send_message',
  'discord.create_thread',
  'discord.add_reaction',
  // Shared knowledge-graph tools (docs/memoire-partagee.md) — mounted on the
  // same team-comms server, so they are part of the renamed vocabulary.
  'memory.search',
  'memory.read',
  'memory.write',
  'memory.link',
  'memory.list',
  'memory.delete',
  // Durable task-board tools (docs/tableau-de-taches.md §5) — mounted on the
  // same team-comms server, so they are part of the renamed vocabulary.
  'board.list',
  'board.teams',
  'board.get',
  'board.create',
  'board.update',
  'board.move',
  'board.assign',
  'board.comment',
  'board.link',
  'board.unlink',
  'board.close',
  'board.reopen',
  'board.delete',
  // Code-knowledge-graph tools (docs/graphify-integration.md, P2) — mounted on
  // the same team-comms server, so they are part of the renamed vocabulary.
  'codegraph.list',
  'codegraph.search',
  'codegraph.explain',
  'codegraph.path',
  // Skills library tools (docs/plan-skills-importables.md §7) — mounted on the
  // same team-comms server, so they are part of the renamed vocabulary.
  'skills.list',
  'skills.show',
  'skills.activate',
  'skills.deactivate',
];

/** Provider-supplied naming — `AgentProvider.mcpToolName`, narrowed to a fn. */
export type McpToolNamer = (logicalName: string) => string;

/**
 * What the preamble needs to know about ONE plugin-published MCP tool.
 *
 * Declared here, in the CONSUMER, and imported as a type by
 * `plugins/mcp-registry.ts`: `plugins/` already depends on `orchestrator/`
 * (`api.ts`, `api-types.ts`, `agent-assets.ts`) and never the reverse, so
 * pointing the arrow this way keeps that direction intact and adds no runtime
 * edge at all.
 */
export interface PluginToolSummary {
  /** Owning plugin (`novelai`) — the prefix of `qualifiedName`. */
  pluginName: string;
  /** Name the MCP server actually registers (`novelai.generate_text`). */
  qualifiedName: string;
  /** Short human label from `PluginToolDef.title`. */
  title: string;
  /** Lead-only tools are hidden from worker preambles entirely. */
  leadOnly: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One alternation over the whole vocabulary, longest name first.
 *
 * Guards, both load-bearing:
 *  - `(?<![\w.\-])` refuses a match that is already part of a longer token, so a
 *    preamble which ALREADY contains a rendered name (`mcp_team-comms_team.whoami`
 *    in an operator override copied out of a gemini session) is not mangled a
 *    second time into `mcp_team-comms_mcp_team-comms_team.whoami`.
 *  - `(?!\w)` lets the trailing `(`, backtick, `,` or `.` of ordinary prose end
 *    the match. It does NOT need to exclude a following `.`: no name in the
 *    vocabulary is a prefix of another, so there is no longer candidate to
 *    protect.
 */
const TOOL_NAME_PATTERN = new RegExp(
  `(?<![\\w.\\-])(${[...TEAM_TOOL_LOGICAL_NAMES]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})(?!\\w)`,
  'g',
);

/**
 * Rewrite every logical tool name in `text` to what the target CLI exposes.
 *
 * A namer that returns a non-string or an empty string is ignored for that name
 * (the canonical name is kept) — a third-party provider adapter must not be able
 * to blank out the mailbox discipline. It is NOT wrapped in try/catch: a namer
 * that throws is a broken adapter, and failing the spawn is the loud outcome.
 */
export function renderMcpToolNames(text: string, namer: McpToolNamer): string {
  return text.replace(TOOL_NAME_PATTERN, (logical) => {
    const rendered = namer(logical);
    return typeof rendered === 'string' && rendered.length > 0 ? rendered : logical;
  });
}

/** Does this provider expose the tools under their canonical names? */
function isIdentityNamer(namer: McpToolNamer): boolean {
  return TEAM_TOOL_LOGICAL_NAMES.every((n) => namer(n) === n);
}

/**
 * The safety net that rides along with a renamed vocabulary.
 *
 * Returns `null` for a provider that renames nothing (claude): its preamble then
 * comes out byte for byte as it always has.
 *
 * Two jobs, both learned from what actually goes wrong:
 *  - give the agent the canonical ↔ exposed mapping, because the names in
 *    SERVER-side text it will meet (the `[swarm-os] …` PTY signal, log lines,
 *    error payloads, a teammate quoting a tool) stay dotted forever;
 *  - tell it what to do if a call is still rejected — list the tools and match
 *    the suffix — so a naming drift in a future CLI release degrades into one
 *    wasted turn instead of an agent that gives up on its mailbox.
 */
export function buildToolNamingNote(namer: McpToolNamer): string | null {
  if (isIdentityNamer(namer)) return null;
  const example = (logical: string): string => `\`${namer(logical)}\` (canonical \`${logical}\`)`;
  return [
    '---',
    '',
    '## Tool naming on this runtime',
    '',
    'Your CLI does not expose the team-comms MCP tools under their canonical',
    'dotted names — it rewrites them. **The names used above are already the',
    'rewritten ones: call them exactly as written.** For reference,',
    `${example('team.whoami')} and ${example('team.read_inbox')}.`,
    '',
    'Text that comes back from the server keeps the canonical dotted names (the',
    '`[swarm-os] …` lines injected into your terminal, error payloads, anything a',
    'teammate quotes), so treat `team.read_inbox` and its rewritten form as the',
    'same tool. If a call is rejected as an unknown tool, list your available',
    'tools and use the entry whose name ends with the same suffix — the',
    'arguments and the semantics are identical.',
    '',
  ].join('\n');
}

/** A title longer than this is truncated — it rides in EVERY session's prompt. */
const PLUGIN_TITLE_MAX = 120;

/**
 * Announce the tools published by the currently-enabled plugins.
 *
 * WHY THIS EXISTS. Plugin tools are mounted INSIDE the `team-comms` server, so
 * an agent sees `novelai.generate_text`, not a `novelai` MCP server. The default
 * preamble opens with "you have access to a `team-comms` MCP server with the
 * following tools" and then lists only the coordination vocabulary — which reads
 * as exhaustive. Observed consequence on the `test` instance: a lead asked to use
 * NovelAI wrote the prose itself and offered to draft a curl script, while
 * `novelai.generate_text` sat unused in its own tool list. The tools were there;
 * nothing had told the agent they were.
 *
 * Returns `null` when no plugin tool is registered, so a swarm without plugins
 * carries not one extra byte.
 *
 * @param tools  registry snapshot, taken at spawn time
 * @param opts.isLead  worker preambles drop `leadOnly` tools — naming a tool the
 *                     worker will be refused by `requireLead` only wastes turns
 * @param opts.namer   same rendering the rest of the preamble gets; a namer that
 *                     returns a non-string or an empty string leaves the
 *                     canonical name in place, exactly as `renderMcpToolNames`
 */
export function buildPluginToolsSection(
  tools: readonly PluginToolSummary[],
  opts: { isLead: boolean; namer?: McpToolNamer | null },
): string | null {
  const visible = tools.filter((t) => opts.isLead || !t.leadOnly);
  if (visible.length === 0) return null;

  const namer = opts.namer ?? null;
  const render = (qualified: string): string => {
    if (!namer) return qualified;
    const out = namer(qualified);
    return typeof out === 'string' && out.length > 0 ? out : qualified;
  };

  const lines = [...visible]
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
    .map((t) => {
      const title = t.title.trim().slice(0, PLUGIN_TITLE_MAX);
      const suffix = title ? ` — ${title}` : '';
      const lead = t.leadOnly ? ' *(lead only)*' : '';
      return `- \`${render(t.qualifiedName)}\`${suffix}${lead}`;
    });

  return [
    '---',
    '',
    '## Plugin tools (MCP)',
    '',
    'The same `team-comms` server also carries tools published by the plugins',
    'enabled on this swarm-os instance. They are **not** coordination tools —',
    'they are extra capabilities, named `<plugin>.<tool>`. There is no separate',
    'MCP server per plugin, so do not look for one.',
    '',
    ...lines,
    '',
    'Their arguments, defaults and error codes are in the tool definitions you',
    'already have — call them like any other tool. They answer',
    '`{ "ok": false, "code": ..., "hint": ... }` instead of failing hard, so read',
    'the payload before deciding a capability is unavailable.',
    '',
    'This list is a snapshot from when your session started. A plugin enabled',
    'later will not appear until your session is restarted.',
    '',
  ].join('\n');
}

/**
 * What the preamble needs to know about ONE active skill.
 *
 * Declared here, in the CONSUMER (like `PluginToolSummary`), and imported as a
 * type by `modules/skills/`: the skills subsystem depends on `orchestrator/`
 * and never the reverse, so the arrow points the safe way and adds no runtime
 * edge.
 */
export interface SkillFragment {
  /** Skill slug (`hello-skill`) — the SKILL.md frontmatter `name`. */
  name: string;
  /** Optional version, shown in the header for traceability. */
  version?: string;
  /** Optional one-line description from the frontmatter. */
  description?: string;
  /** The SKILL.md body — the instructions injected VERBATIM into the preamble. */
  body: string;
}

/**
 * Announce the skills ACTIVE for this session (docs/plan-skills-importables.md).
 *
 * Mirrors `buildPluginToolsSection`: appended UNCONDITIONALLY to the default and
 * BEFORE the operator override, so a role preamble can never hide an activated
 * skill — and, like every section, it AUGMENTS the mailbox/approval/task-board
 * discipline rather than replacing it. Tool names inside a skill body are
 * rendered for the target CLI, exactly like the rest of the preamble.
 *
 * Returns `null` when no skill is active, so a session without skills carries
 * not one extra byte.
 *
 * @param opts.isLead reserved for a future lead-only skill distinction; every
 *                    active skill is shown to both roles today.
 * @param opts.namer  same rendering the rest of the preamble gets; a namer that
 *                    returns a non-string/empty leaves the canonical name in place.
 */
export function buildSkillsSection(
  skills: readonly SkillFragment[],
  opts: { isLead: boolean; namer?: McpToolNamer | null },
): string | null {
  if (skills.length === 0) return null;
  const namer = opts.namer ?? null;
  const render = (text: string): string => (namer ? renderMcpToolNames(text, namer) : text);

  const blocks = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const version = s.version ? ` (v${s.version})` : '';
      const desc = s.description?.trim() ? `\n\n${s.description.trim()}` : '';
      return `### ${s.name}${version}${desc}\n\n${render(s.body.trim())}`;
    });

  return [
    '---',
    '',
    '## Active skills',
    '',
    'One or more skills have been activated for this session — versioned,',
    'imported capabilities/procedures the operator turned on for your role or',
    'team. Treat their instructions as part of your role. They **augment** your',
    'core discipline (mailbox, approval, task board…); they never replace it.',
    '',
    ...blocks,
    '',
  ].join('\n');
}

export interface BuildPreambleInput {
  /** Identity slot — substituted into `{{name}}`/`{{role}}`/`{{sessionId}}`/`{{orchName}}`. */
  identity: {
    name: string;
    role: string;
    sessionId: string;
    orchName: string;
  };
  /** Whether this session is the lead. Selects the lead vs worker default. */
  isLead: boolean;
  /**
   * Optional orchestrator-level override text. Appended AFTER the default —
   * `null`/`undefined`/empty string means "no override". A non-empty value
   * is treated as additional instructions, not a replacement, so the
   * mailbox-discipline language always survives.
   */
  customOverride?: string | null;
  /**
   * `AgentProvider.mcpToolName` of the CLI this session will run.
   *
   * Omitted / `null` ⇒ the canonical dotted names are kept, which is exactly
   * what claude gets. Every caller in `Orchestrator` passes the resolved
   * provider's own function, so a gemini worker in an otherwise-claude team is
   * rendered for gemini and nothing else changes.
   *
   * A FUNCTION rather than the provider object on purpose: this module has no
   * business knowing what a provider is, and a test can pin the rendering with a
   * one-line namer.
   */
  mcpToolName?: McpToolNamer | null;
  /**
   * Snapshot of the plugin tools registered when this session is spawned.
   *
   * Appended UNCONDITIONALLY, like the rest of the default: `customOverride` is
   * additional instructions and never a replacement, so an operator who writes a
   * role preamble cannot accidentally hide the swarm's own capabilities from the
   * agent. Omitted / empty ⇒ no section at all.
   */
  pluginTools?: readonly PluginToolSummary[] | null;
  /**
   * Skills ACTIVE for this session, resolved at spawn from the role/team/session
   * scopes (docs/plan-skills-importables.md §2.1, durable channel). Appended
   * UNCONDITIONALLY like `pluginTools`, so an operator override can never hide an
   * activated skill. Omitted / empty ⇒ no section at all.
   */
  skills?: readonly SkillFragment[] | null;
}

/**
 * Produce the system-prompt-ready preamble for a session.
 *
 * The output is the loaded default (with `{{var}}` placeholders filled and the
 * tool names rendered for the target CLI), optionally followed by the
 * orchestrator-level override prefixed with a separator so the agent can tell
 * where the project-specific instructions begin.
 *
 * This text is DURABLE: it is passed to the CLI via `--append-system-prompt`,
 * so it survives a `/clear` (which only wipes the conversation). The one-shot
 * resume notice is therefore NOT folded in here — it rides the positional
 * prompt instead (see `Session.resumeNotice` / `buildClaudeArgs`) so it does
 * not re-surface on every context reset.
 *
 * ORDER OF OPERATIONS, and none of the three steps commutes:
 *
 *  1. identity placeholders — on the DEFAULT only, historical behaviour: an
 *     operator's override is never templated;
 *  2. tool renaming — on the default AND on the override, because an override
 *     that says `team.send_message` is exactly as wrong as a default that does,
 *     and the operator cannot be expected to know each CLI's mangling;
 *  3. `{{inboxSignal}}` — LAST, and only in the default. It expands to the
 *     literal line `messaging.ts` injects into the PTY, which is server-side
 *     text and keeps its canonical dotted name. Expanding it before step 2 would
 *     rewrite that quote into a line the agent will never actually see.
 */
export function buildPreamble(input: BuildPreambleInput): string {
  const base = input.isLead ? getLeadDefault() : getWorkerDefault();
  const namer = input.mcpToolName ?? null;
  let filled = base
    .replace(/\{\{name\}\}/g, input.identity.name)
    .replace(/\{\{role\}\}/g, input.identity.role)
    .replace(/\{\{sessionId\}\}/g, input.identity.sessionId)
    .replace(/\{\{orchName\}\}/g, input.identity.orchName);
  if (namer) filled = renderMcpToolNames(filled, namer);
  filled = filled.replace(/\{\{inboxSignal\}\}/g, SIGNAL_TEXT);

  // Plugin tools BEFORE the naming note: the note asserts that "the names used
  // above are already the rewritten ones", which has to cover them too.
  const plugins = buildPluginToolsSection(input.pluginTools ?? [], {
    isLead: input.isLead,
    namer,
  });
  if (plugins) filled = `${filled}\n${plugins}`;

  // Active skills AFTER plugin tools, still BEFORE the naming note (which asserts
  // "the names above are already rewritten", so it must cover skill bodies too)
  // and BEFORE the operator override — a skill augments the role, never replaces
  // the swarm's own discipline.
  const skills = buildSkillsSection(input.skills ?? [], {
    isLead: input.isLead,
    namer,
  });
  if (skills) filled = `${filled}\n${skills}`;

  const note = namer ? buildToolNamingNote(namer) : null;
  if (note) filled = `${filled}\n${note}`;

  let override = input.customOverride?.trim();
  if (override && namer) override = renderMcpToolNames(override, namer);
  if (override) {
    return `${filled}\n\n---\n\n## Project-specific instructions\n\n${override}\n`;
  }

  return filled;
}

/** Test-only — drop the cached defaults so a test can swap the files on disk. */
export function _resetPreambleCacheForTesting(): void {
  cachedLeadDefault = null;
  cachedWorkerDefault = null;
}
