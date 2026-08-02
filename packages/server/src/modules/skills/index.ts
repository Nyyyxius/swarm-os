/**
 * SkillsSubsystem — the façade the REST routes, MCP tools and the Orchestrator
 * reach (docs/plan-skills-importables.md §7). Held on the Spawner as
 * `spawner.skills`, exactly like `memory` / `taskboard` / `graph`.
 *
 * Owns: the registry (`SkillStore`), import/re-import (`SkillInstaller`), the
 * durable resolver (role+orch+session → `SkillFragment[]` for the preamble) and
 * the hot activation channel (mailbox + signal to live sessions). A skill is
 * DATA (§0); nothing here runs skill code.
 *
 * SCOPES (Lot 2, precedence role < orch < session): role activations live in
 * `roles.skills_json`; orch/session activations live in `skill_activations`. A
 * more specific scope overrides a broader one — an orch/session entry with
 * `enabled=0` SUPPRESSES a role/orch activation.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withModule } from '../../logger.js';
import type { Config } from '../../config.js';
import type { RoleStore, RoleSkillRef } from '../roles/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { SkillFragment } from '../orchestrator/preamble.js';
import { SkillStore, type SkillRow, type SkillScopeType } from './store.js';
import { SkillInstaller } from './installer.js';
import type { SkillInstallSource } from './stage.js';
import { removeSkillAssets, type SkillAssetsConfig } from './assets.js';
import {
  resolveMergedFragments,
  activateHot,
  deactivateHot,
  stageAssets,
  type HotActivationDeps,
  type ScopeInput,
} from './activation.js';

const log = withModule('skills');

/** Activation scope. `role` persists on the team's role; `orch`/`session` in `skill_activations`. */
export type SkillScope = 'role' | 'orch' | 'session';

/** An effectively-active skill + the most specific scope that activated it. */
export interface ActiveSkillInfo {
  name: string;
  scope: SkillScope;
}

/** Resolve a live orchestrator by id (set by the host after the Spawner exists). */
export type OrchestratorLookup = (id: string) => Orchestrator | null;

/** API-facing view of a skill (the REST contract shape). */
export interface SkillView {
  name: string;
  version: string;
  displayName: string | null;
  description: string | null;
  sourceKind: string;
  sourceRef: string | null;
  sourceCommit: string | null;
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
  /** True when the activation was persisted (role/orch/session). */
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
  private orchLookup: OrchestratorLookup | null = null;

  constructor(deps: SkillsSubsystemDeps) {
    this.store = deps.store;
    this.installer = deps.installer;
    this.roleStore = deps.roleStore;
    this.config = deps.config;
    this.skillsDir = path.join(deps.config.dataDir, 'skills');
  }

  /**
   * Wire a live-orchestrator lookup (set by `src/index.ts` after the Spawner is
   * built, since the Spawner and this subsystem are constructed together). Lets
   * the REST + MCP scope-activation paths fire the HOT channel on a team.
   */
  setOrchestratorLookup(fn: OrchestratorLookup): void {
    this.orchLookup = fn;
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
    this.store.deleteActivationsForSkill(name);
    try {
      removeSkillAssets(this.config.workspaceRoot, name);
    } catch {
      /* best-effort */
    }
  }

  // ---- durable resolution (preamble) ------------------------------------

  /**
   * The effective fragments for a session — merge of role, orch and session
   * scopes (docs/plan-skills-importables.md §2.1). Called at EACH spawn; also
   * stages any durable assets into the workspace (idempotent).
   */
  resolveForSession(
    roleId: string | null,
    orchestratorId: string | null,
    sessionId: string | null,
  ): SkillFragment[] {
    const input: ScopeInput = {
      roleRefs: this.refsForRole(roleId),
      orchActivations: orchestratorId ? this.store.listActivations('orch', orchestratorId) : [],
      sessionActivations: sessionId ? this.store.listActivations('session', sessionId) : [],
    };
    const frags = resolveMergedFragments(this.store, input);
    this.stageDurableAssets(frags);
    return frags;
  }

  /**
   * The skills effectively active for a session, each tagged with the MOST
   * SPECIFIC scope that activated it (role < orch < session). Provenance for the
   * management UI + `skills.list`.
   */
  activeForSession(
    roleId: string | null,
    orchestratorId: string | null,
    sessionId: string | null,
  ): ActiveSkillInfo[] {
    const state = new Map<string, { enabled: boolean; scope: SkillScope }>();
    for (const r of this.refsForRole(roleId)) {
      if (r.mode === 'inject') state.set(r.name, { enabled: true, scope: 'role' });
    }
    if (orchestratorId) {
      for (const a of this.store.listActivations('orch', orchestratorId)) {
        if (a.mode === 'inject') state.set(a.skill_name, { enabled: a.enabled === 1, scope: 'orch' });
      }
    }
    if (sessionId) {
      for (const a of this.store.listActivations('session', sessionId)) {
        if (a.mode === 'inject') state.set(a.skill_name, { enabled: a.enabled === 1, scope: 'session' });
      }
    }
    const out: ActiveSkillInfo[] = [];
    for (const [name, v] of state) if (v.enabled) out.push({ name, scope: v.scope });
    return out;
  }

  activeNamesForSession(
    roleId: string | null,
    orchestratorId: string | null,
    sessionId: string | null,
  ): string[] {
    return this.activeForSession(roleId, orchestratorId, sessionId).map((i) => i.name);
  }

  /** Every orch/session activation of a skill (provenance for the Lot 2b UI). */
  activationsForSkill(name: string): Array<{ scope: SkillScope; scopeId: string; enabled: boolean }> {
    return this.store.listActivationsForSkill(name).map((a) => ({
      scope: a.scope_type,
      scopeId: a.scope_id,
      enabled: a.enabled === 1,
    }));
  }

  private refsForRole(roleId: string | null): RoleSkillRef[] {
    if (!roleId) return [];
    const role = this.roleStore.get(roleId);
    return role?.skills ?? [];
  }

  private stageDurableAssets(frags: readonly SkillFragment[]): void {
    for (const f of frags) {
      const row = this.store.get(f.name);
      if (row?.assets_present) stageAssets(this.hotDeps(), row);
    }
  }

  // ---- activation (persist + hot) ---------------------------------------

  activate(opts: {
    name: string;
    scope: SkillScope;
    orchestratorId: string;
    sessionId?: string;
  }): SkillActivationResult {
    return this.setActivation(opts, true);
  }

  deactivate(opts: {
    name: string;
    scope: SkillScope;
    orchestratorId: string;
    sessionId?: string;
  }): SkillActivationResult {
    return this.setActivation(opts, false);
  }

  private setActivation(
    opts: { name: string; scope: SkillScope; orchestratorId: string; sessionId?: string },
    on: boolean,
  ): SkillActivationResult {
    const row = this.store.get(opts.name);
    if (!row) return { found: false, persisted: false, injected: 0 };
    const orch = this.orchLookup ? this.orchLookup(opts.orchestratorId) : null;
    const persisted = this.persist(opts, orch, on);

    const target =
      opts.scope === 'session' && opts.sessionId ? { targetSessionId: opts.sessionId } : {};
    let injected = 0;
    if (orch) {
      injected = on
        ? activateHot(this.hotDeps(), orch, row, target).injected
        : deactivateHot(this.hotDeps(), orch, row, target).injected;
    }
    return { found: true, persisted, injected };
  }

  private persist(
    opts: { name: string; scope: SkillScope; orchestratorId: string; sessionId?: string },
    orch: Orchestrator | null,
    on: boolean,
  ): boolean {
    if (opts.scope === 'role') {
      const roleId = orch?.roleId ?? null;
      return this.setRoleSkill(roleId, opts.name, on);
    }
    const scopeType: SkillScopeType = opts.scope === 'session' ? 'session' : 'orch';
    const scopeId = scopeType === 'session' ? opts.sessionId : opts.orchestratorId;
    if (!scopeId) return false;
    // Deactivate persists an `enabled=0` override so it can suppress a broader
    // (role/orch) activation, not just clear an own-scope one.
    this.store.upsertActivation({
      id: randomUUID(),
      skill_name: opts.name,
      scope_type: scopeType,
      scope_id: scopeId,
      mode: 'inject',
      enabled: on ? 1 : 0,
      created_at: new Date().toISOString(),
    });
    return true;
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
    sourceCommit: row.source_commit,
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
    return { plugins: asStringArray(r.plugins), capabilities: asStringArray(r.capabilities) };
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
