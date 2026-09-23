/**
 * Skill activation — the two channels of docs/plan-skills-importables.md §2,
 * generalised to the three scopes (role < orch < session, Lot 2).
 *
 *  - DURABLE: `resolveMergedFragments` merges the active skills of the role,
 *    orchestrator and session scopes (more specific scope wins; an `enabled=0`
 *    entry SUPPRESSES a broader activation) into the `SkillFragment[]` injected
 *    into every FUTURE spawn's preamble.
 *  - HOT: `activateHot` / `deactivateHot` reach the LIVE sessions of a team now
 *    — staging any assets, then pushing a `from:'system'` mailbox message + idle
 *    PTY signal. A `targetSessionId` narrows the notice to one session.
 */

import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Session } from '../orchestrator/session.js';
import type { SkillFragment } from '../orchestrator/preamble.js';
import type { RoleSkillRef } from '../roles/index.js';
import type { SkillStore, SkillRow, SkillActivationRow } from './store.js';
import { copySkillAssets, removeSkillAssets, skillAssetsBasePath, type SkillAssetsConfig } from './assets.js';

const log = withModule('skills.activation');

/** Live session = PTY exists + slot consumed (mirror `Orchestrator._isActive`). */
function isLiveSession(s: Session): boolean {
  return (
    s.status === 'running' ||
    s.status === 'starting' ||
    s.status === 'waiting' ||
    s.status === 'paused'
  );
}

/** Turn a skill row into the preamble fragment (durable channel). */
export function fragmentOf(row: SkillRow): SkillFragment {
  const frag: SkillFragment = { name: row.name, body: row.body_md };
  if (row.version) frag.version = row.version;
  if (row.description) frag.description = row.description;
  return frag;
}

/** Build the durable-channel fragments for a role's active skill refs (role only). */
export function resolveFragments(
  store: SkillStore,
  refs: readonly RoleSkillRef[],
): SkillFragment[] {
  const out: SkillFragment[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.mode !== 'inject') continue;
    if (seen.has(ref.name)) continue;
    const row = store.get(ref.name);
    if (!row) continue;
    seen.add(ref.name);
    out.push(fragmentOf(row));
  }
  return out;
}

export interface ScopeInput {
  /** Role scope (`roles.skills_json`) — always "active", no per-ref disable. */
  roleRefs: readonly RoleSkillRef[];
  /** Orchestrator scope (`skill_activations`), carrying an `enabled` flag. */
  orchActivations: readonly SkillActivationRow[];
  /** Session scope (`skill_activations`), carrying an `enabled` flag. */
  sessionActivations: readonly SkillActivationRow[];
}

/**
 * Merge the three scopes into the effective fragment list. PRECEDENCE
 * role < orch < session: a more specific scope's entry for a skill name replaces
 * the broader one, so a `session`/`orch` activation with `enabled=0` turns OFF a
 * role/orch activation. First-seen order is preserved (role skills first).
 */
export function resolveMergedFragments(store: SkillStore, input: ScopeInput): SkillFragment[] {
  const enabled = new Map<string, boolean>();
  const order: string[] = [];
  const note = (name: string, on: boolean): void => {
    if (!enabled.has(name)) order.push(name);
    enabled.set(name, on);
  };
  for (const r of input.roleRefs) if (r.mode === 'inject') note(r.name, true);
  for (const a of input.orchActivations) if (a.mode === 'inject') note(a.skill_name, a.enabled === 1);
  for (const a of input.sessionActivations) if (a.mode === 'inject') note(a.skill_name, a.enabled === 1);

  const out: SkillFragment[] = [];
  for (const name of order) {
    if (!enabled.get(name)) continue;
    const row = store.get(name);
    if (row) out.push(fragmentOf(row));
  }
  return out;
}

export interface HotActivationDeps {
  store: SkillStore;
  skillsDir: string;
  assetsConfig: SkillAssetsConfig;
}

/** Stage a skill's assets into the workspace (idempotent). Safe to call per-spawn. */
export function stageAssets(deps: HotActivationDeps, row: SkillRow): void {
  if (!row.assets_present) return;
  const dir = assetsDirOf(row);
  if (!dir) return;
  copySkillAssets(deps.assetsConfig.workspaceRoot, path.join(deps.skillsDir, row.name), row.name, dir);
}

/** Announce a freshly-activated skill to LIVE sessions (all, or one target). */
export function activateHot(
  deps: HotActivationDeps,
  orch: Orchestrator,
  row: SkillRow,
  opts: { targetSessionId?: string } = {},
): { injected: number } {
  stageAssets(deps, row);
  return broadcast(orch, renderActivation(deps, row), opts.targetSessionId);
}

/** Notice of a de-activated skill; drops any staged assets. */
export function deactivateHot(
  deps: HotActivationDeps,
  orch: Orchestrator,
  row: SkillRow,
  opts: { targetSessionId?: string } = {},
): { injected: number } {
  removeSkillAssets(deps.assetsConfig.workspaceRoot, row.name);
  const content =
    `[skill deactivated] « ${row.name} » is no longer active for you. Disregard its ` +
    `instructions from here on. (It also drops out of the durable preamble at your ` +
    `next spawn / context reset.)`;
  return broadcast(orch, content, opts.targetSessionId);
}

function broadcast(orch: Orchestrator, content: string, targetSessionId?: string): { injected: number } {
  let injected = 0;
  for (const s of orch.listSessions()) {
    if (!isLiveSession(s)) continue;
    if (targetSessionId && s.id !== targetSessionId) continue;
    orch.mailbox.push(s.id, { from: 'system', content });
    try {
      // docs/auto-compact.md §3.2 — single gate. Best-effort as before: the
      // notice is already in the inbox, and a refusal (a dialog on screen, a
      // half-typed injection) is re-signalled at the next idle boundary.
      if (!s.signalInbox()) {
        log.debug({ event: 'skills.signal_line_busy', sid: s.id });
      }
    } catch (err) {
      log.warn({ event: 'skills.signal_failed', sid: s.id, error: String(err) });
    }
    injected++;
  }
  return { injected };
}

function assetsDirOf(row: SkillRow): string | null {
  if (!row.frontmatter_json) return null;
  try {
    const fm = JSON.parse(row.frontmatter_json) as { assets?: { dir?: unknown } };
    return typeof fm.assets?.dir === 'string' ? fm.assets.dir : null;
  } catch {
    return null;
  }
}

function renderActivation(deps: HotActivationDeps, row: SkillRow): string {
  const lines: string[] = [
    `[skill activated] « ${row.name} »${row.version ? ` (v${row.version})` : ''} is now ACTIVE. ` +
      `Apply its instructions as part of your role; they augment your discipline ` +
      `(mailbox, approval, task board…), never replace it.`,
  ];
  if (row.assets_present) {
    lines.push(`Its assets are staged under: ${skillAssetsBasePath(deps.assetsConfig, row.name)}`);
  }
  lines.push('', '--- SKILL INSTRUCTIONS ---', row.body_md.trim());
  return lines.join('\n');
}
