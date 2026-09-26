import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeFamilyOf, claudeFamilyPattern, parseModelAlias } from './ids.js';
import { ModelCatalogue, pinnedCostRates } from './catalogue.js';
import { ClaudeProvider } from './claude.js';
import { SwarmDb, type OrchestratorRow, type RoleRow } from '../db/index.js';

/**
 * Family aliases (docs/model-aliases.md): teams and roles store `opus` /
 * `sonnet` / `fable` / `haiku`, every NEW agent execs the newest member.
 */

/** models.dev-shaped payload — the day Opus 5.5 and Fable 5.1 shipped. */
const PAYLOAD = {
  anthropic: {
    models: Object.fromEntries(
      [
        ['claude-opus-5-5', '2026-09-22', 5],
        ['claude-fable-5-1', '2026-09-01', 10],
        ['claude-opus-5', '2026-07-24', 5],
        ['claude-sonnet-5', '2026-06-29', 2],
        ['claude-fable-5', '2026-06-07', 10],
        ['claude-sonnet-4-6', '2026-02-17', 3],
        ['claude-haiku-4-5', '2025-10-15', 1],
        ['claude-haiku-4-5-20251001', '2025-10-15', 1],
      ].map(([id, date, input]) => [
        id,
        {
          id,
          name: String(id),
          release_date: date,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          cost: { input, output: Number(input) * 5 },
        },
      ]),
    ),
  },
};

function liveCatalogue(): ModelCatalogue {
  return new ModelCatalogue({
    env: {},
    fetchImpl: (async () =>
      new Response(JSON.stringify(PAYLOAD), { status: 200 })) as unknown as typeof fetch,
  });
}

describe('parseModelAlias / claudeFamilyOf', () => {
  it('parses the four families, with and without [1m]', () => {
    expect(parseModelAlias('opus')).toEqual({ family: 'opus', oneM: false });
    expect(parseModelAlias('sonnet[1m]')).toEqual({ family: 'sonnet', oneM: true });
    expect(parseModelAlias('fable')).toEqual({ family: 'fable', oneM: false });
    expect(parseModelAlias('haiku')).toEqual({ family: 'haiku', oneM: false });
    expect(parseModelAlias('claude-opus-5')).toBeNull();
    expect(parseModelAlias('gpt-5.5')).toBeNull();
  });

  it('maps concrete claude ids to their family, keeping [1m]', () => {
    expect(claudeFamilyOf('claude-opus-4-8')).toBe('opus');
    expect(claudeFamilyOf('claude-opus-5')).toBe('opus');
    expect(claudeFamilyOf('claude-opus-5-5')).toBe('opus');
    expect(claudeFamilyOf('claude-sonnet-4-6')).toBe('sonnet');
    expect(claudeFamilyOf('claude-fable-5-1')).toBe('fable');
    expect(claudeFamilyOf('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(claudeFamilyOf('claude-opus-4-8[1m]')).toBe('opus[1m]');
  });

  it('leaves aliases, variants and other vendors alone', () => {
    expect(claudeFamilyOf('opus')).toBeNull();
    expect(claudeFamilyOf('claude-opus-5-fast')).toBeNull();
    expect(claudeFamilyOf('anthropic/claude-opus-5')).toBeNull();
    expect(claudeFamilyOf('gpt-5.5')).toBeNull();
  });

  it('family patterns exclude dated twins', () => {
    expect(claudeFamilyPattern('haiku').test('claude-haiku-4-5')).toBe(true);
    expect(claudeFamilyPattern('haiku').test('claude-haiku-4-5-20251001')).toBe(false);
    expect(claudeFamilyPattern('opus').test('claude-opus-5-5')).toBe(true);
    expect(claudeFamilyPattern('opus').test('claude-sonnet-5')).toBe(false);
  });
});

describe('ClaudeProvider.resolveModel', () => {
  it('resolves each alias to the newest member of its family', async () => {
    const catalogue = liveCatalogue();
    await catalogue.resolve(1_000);
    const claude = new ClaudeProvider();
    claude.useCatalogue(catalogue);
    expect(claude.resolveModel('opus')).toBe('claude-opus-5-5');
    expect(claude.resolveModel('fable')).toBe('claude-fable-5-1');
    expect(claude.resolveModel('sonnet')).toBe('claude-sonnet-5');
    expect(claude.resolveModel('haiku')).toBe('claude-haiku-4-5');
    expect(claude.resolveModel('opus[1m]')).toBe('claude-opus-5-5[1m]');
  });

  it('never touches a concrete id — a pin stays a pin', async () => {
    const catalogue = liveCatalogue();
    await catalogue.resolve(1_000);
    const claude = new ClaudeProvider();
    claude.useCatalogue(catalogue);
    expect(claude.resolveModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('falls back to the bare alias (resolved by the CLI) with no catalogue', () => {
    const claude = new ClaudeProvider();
    expect(claude.resolveModel('opus')).toBe('opus');
    expect(claude.resolveModel('sonnet[1m]')).toBe('sonnet[1m]');
  });

  it('stores the alias as its default and offers the aliases first', async () => {
    const catalogue = liveCatalogue();
    await catalogue.resolve(1_000);
    const claude = new ClaudeProvider();
    claude.useCatalogue(catalogue);
    expect(claude.defaults().model).toBe('opus');
    const values = claude.models().map((m) => m.value);
    expect(values.slice(0, 4)).toEqual(['opus', 'sonnet', 'fable', 'haiku']);
    expect(claude.models()[0]?.label).toBe('Opus — latest (claude-opus-5-5)');
  });
});

describe('pinnedCostRates for unresolved aliases', () => {
  it('prices fable and the [1m] forms', () => {
    expect(pinnedCostRates('claude', 'fable')?.input).toBe(10);
    expect(pinnedCostRates('claude', 'opus[1m]')?.input).toBe(5);
    expect(pinnedCostRates('claude', 'sonnet[1m]')?.input).toBe(2);
  });
});

describe('SwarmDb.migrateModelAliases', () => {
  let tmp: string;
  let db: SwarmDb;
  const now = '2026-09-23T00:00:00.000Z';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-aliases-'));
    db = new SwarmDb(tmp);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function orch(id: string, model: string, provider = 'claude'): void {
    db.upsertOrchestrator({
      id,
      name: id,
      role: 'r',
      role_id: null,
      status: 'running',
      lead_session_id: null,
      default_model: model,
      default_effort: 'xhigh',
      default_permission_mode: 'bypassPermissions',
      default_provider: provider,
      lead_preamble: null,
      worker_preamble: null,
      created_at: now,
      ended_at: null,
      hidden_at: null,
      last_error: null,
      stop_reason: null,
      last_resumed_at: null,
      resume_count: 0,
    } satisfies OrchestratorRow);
  }

  function role(id: string, model: string | null, provider: string | null): void {
    const row: RoleRow = {
      id,
      label: id,
      lead_prompt: null,
      lead_preamble: null,
      worker_preamble: null,
      worker_count: null,
      default_model: model,
      default_effort: null,
      default_permission_mode: null,
      default_provider: provider,
      connectors_json: null,
      schedule: null,
      schedule_message: null,
      approval_json: null,
      skills_json: null,
      auto_remove_dead_workers: 0,
      auto_remove_dead_workers_delay_ms: 0,
      cost_budget_usd: null,
      budget_action: 'notify',
      auto_compact_pct: null,
      worker_auto_compact_pct: null,
      created_at: now,
      updated_at: now,
    };
    db.insertRole(row);
  }

  it('rewrites claude pins once, and never again', () => {
    orch('a', 'claude-opus-4-8');
    orch('b', 'claude-sonnet-5');
    orch('c', 'claude-opus-4-8[1m]');
    orch('d', 'gpt-5.5', 'codex');
    orch('e', 'claude-opus-5-fast');
    role('r1', 'claude-fable-5', null);
    role('r2', 'claude-sonnet-4-6', 'claude');
    role('r3', 'claude-opus-5', 'opencode');

    expect(db.migrateModelAliases('claude', claudeFamilyOf)).toEqual({
      orchestrators: 3,
      roles: 2,
    });
    expect(db.getOrchestrator('a')?.default_model).toBe('opus');
    expect(db.getOrchestrator('b')?.default_model).toBe('sonnet');
    expect(db.getOrchestrator('c')?.default_model).toBe('opus[1m]');
    expect(db.getOrchestrator('d')?.default_model).toBe('gpt-5.5');
    expect(db.getOrchestrator('e')?.default_model).toBe('claude-opus-5-fast');

    // A pin set by hand AFTER the migration survives every later boot.
    orch('a', 'claude-opus-4-8');
    expect(db.migrateModelAliases('claude', claudeFamilyOf)).toBeNull();
    expect(db.getOrchestrator('a')?.default_model).toBe('claude-opus-4-8');
  });

  it('leaves inherit-provider roles alone when the instance default is not claude', () => {
    role('r1', 'claude-opus-5', null);
    expect(db.migrateModelAliases('codex', claudeFamilyOf)).toEqual({
      orchestrators: 0,
      roles: 0,
    });
  });
});
