import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SwarmDb, type OrchestratorRow, type SessionRow } from './index.js';

/**
 * Multi-provider, Lot 2 — the `provider` columns.
 *
 * Two distinct failure modes are covered here, and they fail differently:
 *
 *  1. **The migration.** An ALREADY DEPLOYED database never sees `schema.sql`
 *     (`CREATE TABLE IF NOT EXISTS` skips an existing table wholesale), so the
 *     columns only arrive through `applyMigrations`. If that ALTER is missing or
 *     wrong, every read of an inherited row explodes — loudly, at least.
 *
 *  2. **The UPSERT.** A column present in the INSERT but ABSENT from the
 *     `ON CONFLICT DO UPDATE SET` list is written once and never updated again.
 *     Nothing throws, nothing is logged: a team switched to another provider
 *     works until the next restart and then silently comes back as `claude`.
 *     That is the bug the round-trip tests below exist to catch, so they
 *     deliberately upsert TWICE — the first write goes down the INSERT path,
 *     only the second exercises the conflict clause.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-provmig-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * The DDL as it stood BEFORE this lot: no `default_provider`, no `provider`.
 * Written straight through better-sqlite3 so `SwarmDb` meets a database that
 * genuinely predates the columns, exactly like an upgraded deployment does.
 */
function createPreMigrationDb(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'swarm-os.db'));
  db.exec(`
    CREATE TABLE orchestrators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      role_id TEXT,
      status TEXT NOT NULL,
      lead_session_id TEXT,
      default_model TEXT NOT NULL,
      default_effort TEXT NOT NULL,
      default_permission_mode TEXT NOT NULL,
      lead_preamble TEXT,
      worker_preamble TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      hidden_at TEXT,
      last_error TEXT,
      stop_reason TEXT,
      last_resumed_at TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      lead_prompt TEXT,
      lead_preamble TEXT,
      worker_preamble TEXT,
      worker_count INTEGER,
      default_model TEXT,
      default_effort TEXT,
      default_permission_mode TEXT,
      connectors_json TEXT,
      schedule TEXT,
      schedule_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      orchestrator_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      cwd TEXT NOT NULL,
      initial_prompt TEXT,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      last_error TEXT,
      stop_reason TEXT,
      log_path TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      hidden_at TEXT,
      FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
    );
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO orchestrators (id, name, role, role_id, status, lead_session_id,
       default_model, default_effort, default_permission_mode, lead_preamble,
       worker_preamble, created_at, ended_at, hidden_at, last_error, stop_reason,
       last_resumed_at, resume_count)
     VALUES ('orch-legacy','legacy','co',NULL,'running','sess-legacy',
       'claude-opus-4-8','xhigh','bypassPermissions',NULL,NULL,?,NULL,NULL,NULL,NULL,NULL,0)`,
  ).run(now);
  db.prepare(
    `INSERT INTO sessions (id, orchestrator_id, name, role, type, cwd, initial_prompt,
       model, effort, permission_mode, status, pid, started_at, ended_at, exit_code,
       last_error, stop_reason, log_path, last_activity_at, hidden_at)
     VALUES ('sess-legacy','orch-legacy','legacy-lead','co','lead','/workspace/x','do',
       'claude-opus-4-8','xhigh','bypassPermissions','running',42,?,NULL,NULL,NULL,NULL,
       '/data/logs/x.log',?,NULL)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO roles (id, label, lead_prompt, lead_preamble, worker_preamble,
       worker_count, default_model, default_effort, default_permission_mode,
       connectors_json, schedule, schedule_message, created_at, updated_at)
     VALUES ('role-legacy','Legacy',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?)`,
  ).run(now, now);
  db.close();
}

function orchRow(over: Partial<OrchestratorRow> = {}): OrchestratorRow {
  return {
    id: 'orch-1',
    name: 'team',
    role: 'co',
    role_id: null,
    status: 'running',
    lead_session_id: null,
    default_model: 'gpt-5.5',
    default_effort: 'xhigh',
    default_permission_mode: 'bypassPermissions',
    default_provider: 'codex',
    lead_preamble: null,
    worker_preamble: null,
    created_at: new Date().toISOString(),
    ended_at: null,
    hidden_at: null,
    last_error: null,
    stop_reason: null,
    last_resumed_at: null,
    resume_count: 0,
    ...over,
  };
}

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    orchestrator_id: 'orch-1',
    name: 'lead',
    role: 'co',
    type: 'lead',
    cwd: '/workspace/x',
    initial_prompt: 'do',
    model: 'gpt-5.5',
    effort: 'xhigh',
    permission_mode: 'bypassPermissions',
    provider: 'codex',
    status: 'running',
    pid: 1,
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    last_error: null,
    stop_reason: null,
    log_path: '/data/logs/x.log',
    last_activity_at: new Date().toISOString(),
    hidden_at: null,
    ...over,
  };
}

describe('provider columns — migration of an existing database', () => {
  it('adds the columns and backfills every inherited row with claude', () => {
    const dataDir = path.join(tmpRoot, 'data');
    createPreMigrationDb(dataDir);

    const db = new SwarmDb(dataDir);
    try {
      const orch = db.getOrchestrator('orch-legacy');
      const sessions = db.listSessions('orch-legacy');
      const role = db.getRole('role-legacy');
      // Constant DEFAULT on ADD COLUMN ⇒ SQLite fills existing rows itself, so
      // no catch-up UPDATE is needed. 'claude' is what those rows always were.
      expect(orch?.default_provider).toBe('claude');
      expect(sessions[0]?.provider).toBe('claude');
      // Roles are nullable: NULL means "inherit", not "claude".
      expect(role?.default_provider).toBeNull();
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second boot on the migrated file changes nothing', () => {
    const dataDir = path.join(tmpRoot, 'data');
    createPreMigrationDb(dataDir);
    const first = new SwarmDb(dataDir);
    first.close();
    const second = new SwarmDb(dataDir);
    try {
      expect(second.getOrchestrator('orch-legacy')?.default_provider).toBe('claude');
      const cols = second.db
        .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('sessions')`)
        .all()
        .map((r) => r.name);
      // Exactly one `provider` column — a duplicated ALTER would have thrown
      // and been swallowed, which is the behaviour we rely on.
      expect(cols.filter((c) => c === 'provider')).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});

describe('provider columns — round-trip through the UPSERT', () => {
  it('keeps a non-default provider on the SECOND upsert of an orchestrator', () => {
    const dataDir = path.join(tmpRoot, 'fresh');
    const db = new SwarmDb(dataDir);
    try {
      db.upsertOrchestrator(orchRow());
      // Second write = the ON CONFLICT path. This is the assertion that fails
      // when `default_provider` is missing from the DO UPDATE SET list.
      db.upsertOrchestrator(orchRow({ status: 'stopped', default_provider: 'gemini' }));
      const back = db.getOrchestrator('orch-1');
      expect(back?.status).toBe('stopped');
      expect(back?.default_provider).toBe('gemini');
    } finally {
      db.close();
    }
  });

  it('keeps a non-default provider on the SECOND upsert of a session', () => {
    const dataDir = path.join(tmpRoot, 'fresh2');
    const db = new SwarmDb(dataDir);
    try {
      db.upsertOrchestrator(orchRow());
      db.upsertSession(sessionRow());
      db.upsertSession(sessionRow({ status: 'waiting', provider: 'gemini' }));
      const back = db.getSession('sess-1');
      expect(back?.status).toBe('waiting');
      expect(back?.provider).toBe('gemini');
    } finally {
      db.close();
    }
  });

  it('survives a server restart — the provider is read back from disk', () => {
    // The end-to-end shape of Risk 5: an operator switches a team to another
    // provider, the container is recreated, and the team must NOT come back as
    // claude. Reading through a fresh SwarmDb over the same file is what makes
    // this a persistence assertion rather than a cache one.
    const dataDir = path.join(tmpRoot, 'restart');
    const first = new SwarmDb(dataDir);
    first.upsertOrchestrator(orchRow({ default_provider: 'claude' }));
    first.upsertSession(sessionRow({ provider: 'claude' }));
    first.upsertOrchestrator(orchRow({ default_provider: 'gemini' }));
    first.upsertSession(sessionRow({ provider: 'gemini' }));
    first.close();

    const second = new SwarmDb(dataDir);
    try {
      expect(second.getOrchestrator('orch-1')?.default_provider).toBe('gemini');
      expect(second.listSessions('orch-1')[0]?.provider).toBe('gemini');
    } finally {
      second.close();
    }
  });

  it('round-trips a role provider through insert AND update', () => {
    const dataDir = path.join(tmpRoot, 'roles');
    const db = new SwarmDb(dataDir);
    const now = new Date().toISOString();
    try {
      db.insertRole({
        id: 'r1',
        label: 'Codex team',
        lead_prompt: null,
        lead_preamble: null,
        worker_preamble: null,
        worker_count: null,
        default_model: null,
        default_effort: null,
        default_permission_mode: null,
        default_provider: 'codex',
        connectors_json: null,
        schedule: null,
        schedule_message: null,
        approval_json: null,
        skills_json: null,
        auto_remove_dead_workers: 0,
        auto_remove_dead_workers_delay_ms: 600000,
        cost_budget_usd: null,
        budget_action: 'notify',
        auto_compact_pct: null,
        created_at: now,
        updated_at: now,
      });
      expect(db.getRole('r1')?.default_provider).toBe('codex');
      db.updateRole({
        id: 'r1',
        label: 'Gemini team',
        lead_prompt: null,
        lead_preamble: null,
        worker_preamble: null,
        worker_count: null,
        default_model: null,
        default_effort: null,
        default_permission_mode: null,
        default_provider: 'gemini',
        connectors_json: null,
        schedule: null,
        schedule_message: null,
        approval_json: null,
        skills_json: null,
        auto_remove_dead_workers: 0,
        auto_remove_dead_workers_delay_ms: 600000,
        cost_budget_usd: null,
        budget_action: 'notify',
        auto_compact_pct: null,
        created_at: now,
        updated_at: new Date().toISOString(),
      });
      expect(db.getRole('r1')?.default_provider).toBe('gemini');
      // …and back to "inherit".
      db.updateRole({
        id: 'r1',
        label: 'Gemini team',
        lead_prompt: null,
        lead_preamble: null,
        worker_preamble: null,
        worker_count: null,
        default_model: null,
        default_effort: null,
        default_permission_mode: null,
        default_provider: null,
        connectors_json: null,
        schedule: null,
        schedule_message: null,
        approval_json: null,
        skills_json: null,
        auto_remove_dead_workers: 0,
        auto_remove_dead_workers_delay_ms: 600000,
        cost_budget_usd: null,
        budget_action: 'notify',
        auto_compact_pct: null,
        created_at: now,
        updated_at: new Date().toISOString(),
      });
      expect(db.getRole('r1')?.default_provider).toBeNull();
    } finally {
      db.close();
    }
  });
});
