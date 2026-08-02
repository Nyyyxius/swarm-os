/**
 * SkillsSubsystem — the façade the REST routes, MCP tools and the Orchestrator
 * reach (docs/plan-skills-importables.md §7). Held on the Spawner as
 * `spawner.skills`, exactly like `memory` / `taskboard` / `graph`.
 *
 * Owns: the registry (`SkillStore`), import/re-import (`SkillInstaller`), the
 * durable resolver (role → `SkillFragment[]` for the preamble) and the hot
 * activation channel (mailbox + signal to live sessions). A skill is DATA (§0);
 * nothing here runs skill code.
 */

import * as path from 'node:path';
import { withModule } from '../../logger.js';
import type { Config } from '../../config.js';
import type { RoleStore, RoleSkillRef } from '../roles/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { SkillFragment } from '../orchestrator/preamble.js';
import { SkillStore, type SkillRow } from './store.js';
import { SkillInstaller } from './installer.js';
import type { SkillInstallSource } from './stage.js';
import { removeSkillAssets, type SkillAssetsConfig } from './assets.js';
import {
  resolveFragments,
  activateHot,
  deactivateHot,
  type HotActivationDeps,
} from './activation.js';

const log = withModule('skills');

/** API-facing view of a skill (the REST contract shape — Lot 1b builds on it). */
export interface SkillView {
  name: string;
  version: string;
  displayName: string | null;
  description: string | null;
  sourceKind: string;
  sourceRef: string | null;
  trust: string;
  requires: { plugins: string[]; capabilities: string[] };
  assetsPresent: boolean;
  triggers: string[];
  checksum: string | null;
  installedAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface SkillsSubsystemDeps {
  store: SkillStore;
  installer: SkillInstaller;
  /** Role registry — where role-scoped activations persist (roles.skills_json). */
  roleStore: RoleStore;
  config: Config;
}

export interface SkillActivationResult {
  found: boolean;
  /** True when the activation was persisted on the team's role. */
  persisted: boolean;
  /** Number of live sessions the hot notice reached. */
  injected: number;
}

export class SkillsSubsystem {
  /** Public so tests / adjacent modules can read rows directly. */
  readonly store: SkillStore;
  private readonly installer: SkillInstaller;
  private readonly roleStore: RoleStore;
  private readonly config: Config;
  private readonly skillsDir: string;

  constructor(deps: SkillsSubsystemDeps) {
    this.store = deps.store;
    this.installer = deps.installer;
    this.roleStore = deps.roleStore;
    this.config = deps.config;
    this.skillsDir = path.join(deps.config.dataDir, 'skills');
  }

  // ---- catalogue --------------------------------------------------------

  list(): SkillView[] {
    return this.store.list().map(toView);
  }

  getView(name: string): SkillView | null {
    const row = this.store.get(name);
    return row ? toView(row) : null;
  }

  getBody(name: string): string | null {
    return this.store.get(name)?.body_md ?? null;
  }

  async import(source: SkillInstallSource): Promise<SkillView> {
    return toView(await this.installer.install(source));
  }

  async upgrade(name: string): Promise<SkillView> {
    return toView(await this.installer.upgrade(name));
  }

  remove(name: string): void {
    this.installer.remove(name);
    try {
      removeSkillAssets(this.config.workspaceRoot, name);
    } catch {
      /* best-effort */
    }
  }

  // ---- durable resolution (preamble) ------------------------------------

  /** Fragments for a role's active skills — injected at every future spawn. */
  resolveForRole(roleId: string | null): SkillFragment[] {
    const refs = this.refsForRole(roleId);
    return refs.length ? resolveFragments(this.store, refs) : [];
  }

  activeNamesForRole(roleId: string | null): string[] {
    return this.refsForRole(roleId).map((r) => r.name);
  }

  private refsForRole(roleId: string | null): RoleSkillRef[] {
    if (!roleId) return [];
    const role = this.roleStore.get(roleId);
    return role?.skills ?? [];
  }

  // ---- activation (persist + hot) ---------------------------------------

  activate(orch: Orchestrator, name: string): SkillActivationResult {
    const row = this.store.get(name);
    if (!row) return { found: false, persisted: false, injected: 0 };
    const persisted = this.setRoleSkill(orch.roleId, name, true);
    const { injected } = activateHot(this.hotDeps(), orch, row);
    return { found: true, persisted, injected };
  }

  deactivate(orch: Orchestrator, name: string): SkillActivationResult {
    const row = this.store.get(name);
    if (!row) return { found: false, persisted: false, injected: 0 };
    const persisted = this.setRoleSkill(orch.roleId, name, false);
    const { injected } = deactivateHot(this.hotDeps(), orch, row);
    return { found: true, persisted, injected };
  }

  private setRoleSkill(roleId: string | null, name: string, active: boolean): boolean {
    if (!roleId) return false;
    const role = this.roleStore.get(roleId);
    if (!role) return false;
    const current = role.skills ?? [];
    const next: RoleSkillRef[] = active
      ? current.some((r) => r.name === name)
        ? current
        : [...current, { name, mode: 'inject' }]
      : current.filter((r) => r.name !== name);
    this.roleStore.update(roleId, { skills: next });
    return true;
  }

  private hotDeps(): HotActivationDeps {
    return { store: this.store, skillsDir: this.skillsDir, assetsConfig: this.assetsConfig() };
  }

  private assetsConfig(): SkillAssetsConfig {
    return {
      workspaceRoot: this.config.workspaceRoot,
      hostWorkspaceRoot: this.config.hostWorkspaceRoot,
      agentTransport: this.config.agentTransport,
    };
  }
}

function toView(row: SkillRow): SkillView {
  return {
    name: row.name,
    version: row.version,
    displayName: row.display_name,
    description: row.description,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    trust: row.trust,
    requires: parseRequires(row.requires_json),
    assetsPresent: row.assets_present === 1,
    triggers: parseTriggers(row.frontmatter_json),
    checksum: row.checksum,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

function parseRequires(json: string | null): { plugins: string[]; capabilities: string[] } {
  const empty = { plugins: [] as string[], capabilities: [] as string[] };
  if (!json) return empty;
  try {
    const r = JSON.parse(json) as { plugins?: unknown; capabilities?: unknown };
    return {
      plugins: asStringArray(r.plugins),
      capabilities: asStringArray(r.capabilities),
    };
  } catch (err) {
    log.warn({ event: 'skills.requires_parse_failed', error: String(err) });
    return empty;
  }
}

function parseTriggers(json: string | null): string[] {
  if (!json) return [];
  try {
    const fm = JSON.parse(json) as { triggers?: unknown };
    return asStringArray(fm.triggers);
  } catch {
    return [];
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
