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
import { parseSkillMd, SKILL_FILE, type ParsedSkill } from './manifest.js';
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
import {
  encodeGitRef,
  decodeGitRef,
  createTgz,
  createTgzDir,
  extractTgzFlat,
  listTgzEntries,
  firstUnsafeTarEntry,
  type Runner,
} from '../install-core/fetch.js';
import { resolveTrust, trustPolicyFromEnv, type TrustPolicy } from './trust.js';
import {
  resolveMarket,
  searchMarket,
  marketPolicyFromEnv,
  type MarketPolicy,
  type MarketDeps,
  type MarketSearchResult,
} from './market.js';

const log = withModule('skills.installer');

/** What changed across a re-import — drives the Lot 3b diff + review reset. */
export interface ChecksumDrift {
  /** True when the re-imported tree hash differs from the stored one. */
  checksumChanged: boolean;
  /** The checksum BEFORE the re-import (null when it had none). */
  previousChecksum: string | null;
  /** The SKILL.md body BEFORE the re-import (for the UI diff). */
  previousBody: string | null;
}

/** Result of a re-import: the new row + what drifted from the prior version. */
export interface UpgradeResult {
  row: SkillRow;
  drift: ChecksumDrift;
}

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

/** A pack export that resolved to zero valid skills → HTTP 400. */
export class EmptyPackError extends Error {
  constructor(message = 'no valid skill to export (all requested names are unknown)') {
    super(message);
    this.name = 'EmptyPackError';
  }
}

/** Root manifest file name of a skill pack (`.tgz`), at the archive root. */
export const PACK_MANIFEST_FILE = 'pack.json';

/** One entry of a pack's `pack.json` manifest (metadata only — advisory). */
export interface PackManifestEntry {
  name: string;
  description?: string;
  trust?: string;
}

/** A skill pack's root manifest. `version` is bumped on a breaking layout change. */
export interface SkillPackManifest {
  version: 1;
  skills: PackManifestEntry[];
}

/** Result of {@link SkillInstaller.exportPack}: the archive + what it did/didn't include. */
export interface PackExportResult {
  tgz: Buffer;
  included: PackManifestEntry[];
  /** Requested names that were unknown/empty and left out (export still succeeds). */
  skipped: string[];
}

/** A per-skill failure during a pack install (partial success is allowed). */
export interface PackInstallError {
  name: string;
  error: string;
}

/** Result of {@link SkillInstaller.installPack}: installed rows + per-skill errors. */
export interface PackInstallResult {
  installed: SkillRow[];
  errors: PackInstallError[];
}

export interface SkillInstallerDeps {
  /** `<dataDir>/skills`. */
  skillsDir: string;
  store: SkillStore;
  /** Allowlists promoting git/npm sources above `community`. Env-derived by default. */
  trust?: TrustPolicy;
  /** Market resolution policy (endpoint + catalog). Env-derived by default. */
  market?: MarketPolicy;
  /** Injectable network deps for the market endpoint (tests supply a fake fetch). */
  marketDeps?: MarketDeps;
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
  private readonly trustPolicy: TrustPolicy;
  private readonly marketPolicy: MarketPolicy;
  private readonly marketDeps: MarketDeps;

  constructor(deps: SkillInstallerDeps) {
    this.skillsDir = deps.skillsDir;
    this.store = deps.store;
    this.stagingRoot = path.join(deps.skillsDir, '.staging');
    this.runner = makeSkillRunner(path.join(this.stagingRoot, '.npm-cache'));
    this.trustPolicy = deps.trust ?? trustPolicyFromEnv();
    this.marketPolicy = deps.market ?? marketPolicyFromEnv();
    this.marketDeps = deps.marketDeps ?? {};
    this.purgeStaging();
  }

  /** Browse the configured market registry (graceful — never throws). */
  marketSearch(query: string): Promise<MarketSearchResult> {
    return searchMarket(query, this.marketPolicy, this.marketDeps);
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
  async upgrade(name: string): Promise<UpgradeResult> {
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
      case 'market':
        // Re-resolve the ORIGINAL market ref (`source_ref`) — a re-import picks
        // up the repo's newer HEAD, and re-classifies trust under the current policy.
        source = { kind: 'market', ref: row.source_ref ?? name };
        break;
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
      const newRow = this.commit(staged, row);
      return {
        row: newRow,
        drift: {
          checksumChanged: row.checksum !== newRow.checksum,
          previousChecksum: row.checksum,
          previousBody: row.body_md,
        },
      };
    } finally {
      this.rmQuiet(dir);
    }
  }

  /** Delete the registry row + the on-disk skill folder. */
  remove(name: string): void {
    this.store.delete(name);
    this.rmQuiet(path.join(this.skillsDir, name));
  }

  // ---- export / packs (Lot 5a) ------------------------------------------

  /**
   * Export one skill as a `.tgz` that ROUND-TRIPS through `POST /skills/upload`:
   * every file nests under `<name>/`, so upload's `--strip-components=1` restores
   * SKILL.md (+ `assets/`) at the root — the checksum survives the round-trip.
   * Exporting never runs skill code. Throws {@link SkillNotFoundError} if unknown.
   */
  async exportSkill(name: string): Promise<Buffer> {
    this.requireSkillDir(name);
    const outPath = path.join(this.stagingRoot, `${randomUUID()}-export.tgz`);
    try {
      await createTgz(this.runner, this.skillsDir, name, outPath);
      return fs.readFileSync(outPath);
    } finally {
      this.rmQuiet(outPath);
    }
  }

  /**
   * Export several skills as a mono-repo `.tgz` pack: `<name>/SKILL.md` (+
   * `<name>/assets/…`) per skill PLUS a root `pack.json` manifest. Unknown names
   * are skipped (not fatal); throws {@link EmptyPackError} only when NONE resolve.
   */
  async exportPack(names: readonly string[]): Promise<PackExportResult> {
    const uuid = randomUUID();
    const workDir = path.join(this.stagingRoot, `${uuid}-pack`);
    const outPath = path.join(this.stagingRoot, `${uuid}-pack.tgz`);
    fs.mkdirSync(workDir, { recursive: true });
    try {
      const included: PackManifestEntry[] = [];
      const skipped: string[] = [];
      const seen = new Set<string>();
      for (const raw of names) {
        const name = typeof raw === 'string' ? raw.trim() : '';
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        const row = this.store.get(name);
        const src = path.join(this.skillsDir, name);
        if (!row || !fs.existsSync(path.join(src, SKILL_FILE))) {
          skipped.push(name);
          continue;
        }
        fs.cpSync(src, path.join(workDir, name), { recursive: true });
        included.push({
          name,
          ...(row.description ? { description: row.description } : {}),
          trust: row.trust,
        });
      }
      if (included.length === 0) throw new EmptyPackError();
      const manifest: SkillPackManifest = { version: 1, skills: included };
      fs.writeFileSync(path.join(workDir, PACK_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
      await createTgzDir(this.runner, workDir, outPath);
      return { tgz: fs.readFileSync(outPath), included, skipped };
    } finally {
      this.rmQuiet(workDir);
      this.rmQuiet(outPath);
    }
  }

  /**
   * Install a `.tgz` pack: extract (traversal-guarded), then install EACH
   * `<name>/SKILL.md` member through the normal upload path (data-first; the Lot
   * 3 review gate still applies per skill). Partial success is allowed — a
   * failing member is reported in `errors`, never aborting the others. Never
   * throws a 5xx: a corrupt/unsafe/non-pack archive raises
   * {@link SkillValidationError} (→422).
   */
  async installPack(tgz: Buffer): Promise<PackInstallResult> {
    const uuid = randomUUID();
    const extractDir = path.join(this.stagingRoot, `${uuid}-packin`);
    const tmpTgz = path.join(this.stagingRoot, `${uuid}-packin.tgz`);
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      fs.writeFileSync(tmpTgz, tgz);
      let entries: string[];
      try {
        entries = await listTgzEntries(this.runner, tmpTgz);
      } catch (err) {
        throw new SkillValidationError(
          `unreadable pack archive: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const unsafe = firstUnsafeTarEntry(entries);
      if (unsafe) throw new SkillValidationError(`pack archive contains an unsafe path '${unsafe}'`);
      try {
        await extractTgzFlat(this.runner, tmpTgz, extractDir);
      } catch (err) {
        throw new SkillValidationError(
          `corrupt pack archive: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const members = this.discoverPackMembers(extractDir);
      if (members.length === 0) {
        throw new SkillValidationError('archive is not a skill pack: no <name>/SKILL.md found');
      }
      const installed: SkillRow[] = [];
      const errors: PackInstallError[] = [];
      for (const member of members) {
        try {
          const memberTgz = await this.tarMember(extractDir, member);
          installed.push(await this.install({ kind: 'upload', tgz: memberTgz }));
        } catch (err) {
          errors.push({ name: member, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { installed, errors };
    } finally {
      this.rmQuiet(extractDir);
      this.rmQuiet(tmpTgz);
    }
  }

  /** Resolve a skill's on-disk folder, or throw {@link SkillNotFoundError}. */
  private requireSkillDir(name: string): string {
    const row = this.store.get(name);
    const dir = path.join(this.skillsDir, name);
    if (!row || !fs.existsSync(path.join(dir, SKILL_FILE))) throw new SkillNotFoundError(name);
    return dir;
  }

  /** Top-level dirs of an extracted pack that hold a SKILL.md (each = one skill). */
  private discoverPackMembers(extractDir: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(extractDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === '.' || ent.name === '..' || ent.name.includes('/') || ent.name.includes('\\')) {
        continue;
      }
      if (fs.existsSync(path.join(extractDir, ent.name, SKILL_FILE))) out.push(ent.name);
    }
    out.sort();
    return out;
  }

  /** Re-tar one extracted pack member under `<member>/` → an upload-shaped buffer. */
  private async tarMember(extractDir: string, member: string): Promise<Buffer> {
    const outPath = path.join(this.stagingRoot, `${randomUUID()}-member.tgz`);
    try {
      await createTgz(this.runner, extractDir, member, outPath);
      return fs.readFileSync(outPath);
    } finally {
      this.rmQuiet(outPath);
    }
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
      case 'market': {
        // agentskills.io has NO download API — a market ref resolves to git
        // coordinates (market.ts) and reuses the SAME data-first clone path.
        // Persist the ORIGINAL ref so `upgrade` re-resolves; trust stays
        // `community` (resolveTrust), so the Lot 3 review gate still applies.
        const target = await resolveMarket(source.ref, this.marketPolicy, this.marketDeps);
        sourceCommit = await stageGit(
          this.runner,
          target,
          dir,
          path.join(this.stagingRoot, `${uuid}-clone`),
        );
        sourceKind = 'market';
        sourceRef = source.ref;
        break;
      }
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
    // Trust is recomputed from the source + policy on every import (so adding a
    // repo to the verified allowlist promotes it on the next re-import).
    const trust = resolveTrust(staged.sourceKind, staged.sourceRef, this.trustPolicy);
    // Review state is FAIL-SAFE across a re-import: a prior review survives only
    // when the tree hash is byte-identical; any content drift (SKILL.md OR an
    // assets/ script) resets `reviewed` so the operator must re-approve.
    const checksumChanged = existing ? existing.checksum !== staged.checksum : false;
    const reviewed = existing && !checksumChanged ? existing.reviewed : 0;
    const reviewedAt = reviewed ? existing?.reviewed_at ?? null : null;
    const row: SkillRow = {
      name,
      version: staged.parsed.version,
      display_name: fm.displayName ?? null,
      description: fm.description ?? null,
      source_kind: staged.sourceKind,
      source_ref: staged.sourceRef,
      source_commit: staged.sourceCommit,
      checksum: staged.checksum,
      trust,
      requires_json: fm.requires ? JSON.stringify(fm.requires) : null,
      assets_present: fm.assets ? 1 : 0,
      reviewed,
      reviewed_at: reviewedAt,
      body_md: staged.parsed.body,
      frontmatter_json: JSON.stringify(fm),
      installed_at: existing?.installed_at ?? now,
      updated_at: now,
      last_error: null,
    };
    this.store.upsert(row);
    log.info({
      event: 'skills.installed',
      name,
      version: row.version,
      source: row.source_kind,
      trust,
      reviewed: reviewed === 1,
    });
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
