/**
 * SkillInstaller — data-first import + re-import of skills (plan §5).
 *
 * `install(source)` stages a source into `.staging/<uuid>`, validates its
 * `SKILL.md`, computes a checksum, swaps the folder into `<skillsDir>/<name>`
 * and upserts the registry row. `upgrade(name)` re-fetches a skill's recorded
 * source (re-import). Sources: dir / upload / npm / git. NOTHING here executes
 * skill code — a skill is DATA (§0): fetch → stage → validate, no npm install.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withModule } from '../../logger.js';
import { parseSkillMd, type ParsedSkill } from './manifest.js';
import { SkillStore, type SkillRow } from './store.js';
import {
  stageDir,
  stageUpload,
  stageNpm,
  stageGit,
  makeSkillRunner,
  checksumSkill,
  SkillValidationError,
  type SkillInstallSource,
} from './stage.js';
import { encodeGitRef, decodeGitRef, type Runner } from '../install-core/fetch.js';

const log = withModule('skills.installer');

/** Upgrade/remove of an unknown skill → HTTP 404. */
export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill '${name}' not found`);
    this.name = 'SkillNotFoundError';
  }
}

/** Upgrade of an upload-source skill → HTTP 409 (needs a fresh upload). */
export class UploadRequiresNewUploadError extends Error {
  constructor(name: string) {
    super(`skill '${name}' was installed from an upload — upgrade requires a new upload`);
    this.name = 'UploadRequiresNewUploadError';
  }
}

export interface SkillInstallerDeps {
  /** `<dataDir>/skills`. */
  skillsDir: string;
  store: SkillStore;
}

interface StagedSkill {
  dir: string;
  parsed: ParsedSkill;
  sourceKind: string;
  sourceRef: string | null;
  sourceCommit: string | null;
  checksum: string;
}

export class SkillInstaller {
  private readonly skillsDir: string;
  private readonly store: SkillStore;
  private readonly stagingRoot: string;
  private readonly runner: Runner;

  constructor(deps: SkillInstallerDeps) {
    this.skillsDir = deps.skillsDir;
    this.store = deps.store;
    this.stagingRoot = path.join(deps.skillsDir, '.staging');
    this.runner = makeSkillRunner(path.join(this.stagingRoot, '.npm-cache'));
    this.purgeStaging();
  }

  /** Wipe stale staging (interrupted imports) and recreate the work area. */
  purgeStaging(): void {
    try {
      fs.rmSync(this.stagingRoot, { recursive: true, force: true });
      fs.mkdirSync(this.stagingRoot, { recursive: true });
    } catch (err) {
      log.warn({ event: 'skills.staging_purge_failed', error: String(err) });
    }
  }

  /** Install a NEW skill (or overwrite an existing name) from a source. */
  async install(source: SkillInstallSource): Promise<SkillRow> {
    const uuid = randomUUID();
    const dir = path.join(this.stagingRoot, uuid);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const staged = await this.stageInto(dir, uuid, source);
      return this.commit(staged);
    } finally {
      this.rmQuiet(dir);
    }
  }

  /** Re-import an existing skill by re-fetching its recorded source. */
  async upgrade(name: string): Promise<SkillRow> {
    const row = this.store.get(name);
    if (!row) throw new SkillNotFoundError(name);

    let source: SkillInstallSource;
    switch (row.source_kind) {
      case 'dir':
        source = { kind: 'dir', dir: row.source_ref ?? path.join(this.skillsDir, name) };
        break;
      case 'npm':
        source = { kind: 'npm', spec: row.source_ref ?? name };
        break;
      case 'git': {
        const { url, ref, subdir } = decodeGitRef(row.source_ref ?? '');
        source = { kind: 'git', url, ref, subdir };
        break;
      }
      case 'upload':
        throw new UploadRequiresNewUploadError(name);
      default:
        throw new SkillValidationError(`cannot upgrade source '${row.source_kind}'`);
    }

    const uuid = randomUUID();
    const dir = path.join(this.stagingRoot, uuid);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const staged = await this.stageInto(dir, uuid, source);
      if (staged.parsed.name !== name) {
        throw new SkillValidationError(
          `upgrade produced skill '${staged.parsed.name}', expected '${name}'`,
        );
      }
      return this.commit(staged, row);
    } finally {
      this.rmQuiet(dir);
    }
  }

  /** Delete the registry row + the on-disk skill folder. */
  remove(name: string): void {
    this.store.delete(name);
    this.rmQuiet(path.join(this.skillsDir, name));
  }

  private async stageInto(
    dir: string,
    uuid: string,
    source: SkillInstallSource,
  ): Promise<StagedSkill> {
    let sourceKind: string;
    let sourceRef: string | null;
    let sourceCommit: string | null = null;
    switch (source.kind) {
      case 'dir':
        stageDir(source.dir, dir);
        sourceKind = 'dir';
        sourceRef = path.resolve(source.dir);
        break;
      case 'upload':
        await stageUpload(this.runner, source.tgz, dir, path.join(this.stagingRoot, `${uuid}.tgz`));
        sourceKind = 'upload';
        sourceRef = null;
        break;
      case 'npm': {
        const packDir = path.join(this.stagingRoot, `${uuid}-pack`);
        try {
          await stageNpm(this.runner, source.spec, dir, packDir);
        } finally {
          this.rmQuiet(packDir);
        }
        sourceKind = 'npm';
        sourceRef = source.spec;
        break;
      }
      case 'git':
        sourceCommit = await stageGit(
          this.runner,
          source,
          dir,
          path.join(this.stagingRoot, `${uuid}-clone`),
        );
        sourceKind = 'git';
        sourceRef = encodeGitRef(source.url, source.ref, source.subdir);
        break;
      default:
        throw new SkillValidationError('unknown source kind');
    }

    let parsed: ParsedSkill;
    try {
      parsed = parseSkillMd(dir);
    } catch (err) {
      // A bad manifest is a validation failure, not a source failure.
      throw new SkillValidationError(err instanceof Error ? err.message : String(err));
    }
    const checksum = checksumSkill(dir);
    return { dir, parsed, sourceKind, sourceRef, sourceCommit, checksum };
  }

  /** Swap the staged folder into place + upsert the row. `existing` on upgrade. */
  private commit(staged: StagedSkill, existing?: SkillRow): SkillRow {
    const name = staged.parsed.name;
    const dest = path.join(this.skillsDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.cpSync(staged.dir, dest, { recursive: true, force: true });

    const now = new Date().toISOString();
    const fm = staged.parsed.frontmatter;
    const row: SkillRow = {
      name,
      version: staged.parsed.version,
      display_name: fm.displayName ?? null,
      description: fm.description ?? null,
      source_kind: staged.sourceKind,
      source_ref: staged.sourceRef,
      source_commit: staged.sourceCommit,
      checksum: staged.checksum,
      // A local dir import is the operator's own skill → higher default trust.
      trust: existing?.trust ?? (staged.sourceKind === 'dir' ? 'local' : 'community'),
      requires_json: fm.requires ? JSON.stringify(fm.requires) : null,
      assets_present: fm.assets ? 1 : 0,
      body_md: staged.parsed.body,
      frontmatter_json: JSON.stringify(fm),
      installed_at: existing?.installed_at ?? now,
      updated_at: now,
      last_error: null,
    };
    this.store.upsert(row);
    log.info({ event: 'skills.installed', name, version: row.version, source: row.source_kind });
    return row;
  }

  private rmQuiet(p: string): void {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
