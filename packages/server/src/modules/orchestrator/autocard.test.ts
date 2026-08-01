import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Orchestrator, deriveAutoCardTitle } from './index.js';
import { ProviderRegistry } from '../providers/index.js';
import { FakeProvider } from '../providers/fake.js';
import { SwarmDb } from '../db/index.js';
import { TaskboardStore } from '../taskboard/store.js';
import type { Config } from '../../config.js';

const ORCH_ID = 'orch-autocard';

let tmpRoot: string;
let db: SwarmDb;
let store: TaskboardStore;
let orch: Orchestrator | null;

function makeConfig(): Config {
  return {
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
}

function makeOrchestrator(): Orchestrator {
  const provider = new FakeProvider({ id: 'claude', binary: 'sh' });
  const registry = new ProviderRegistry();
  registry.register(provider, { builtin: true });
  return new Orchestrator(
    {
      id: ORCH_ID,
      name: 'auto',
      role: 'co',
      defaultModel: 'm',
      defaultEffort: 'low',
      defaultPermissionMode: 'bypassPermissions',
      defaultProvider: 'claude',
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    makeConfig(),
    { providerRegistry: registry, taskboard: store },
  );
}

function insertOrchRow(id: string): void {
  db.db
    .prepare(
      `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, 'auto', 'co', 'running', 'm', 'low', 'default', new Date().toISOString());
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-autocard-'));
  fs.mkdirSync(path.join(tmpRoot, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'mcp-runtime'), { recursive: true });
  db = new SwarmDb(tmpRoot);
  insertOrchRow(ORCH_ID);
  store = new TaskboardStore(db);
});

afterEach(async () => {
  orch?.stop('test-cleanup');
  orch = null;
  await new Promise((r) => setTimeout(r, 30));
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('deriveAutoCardTitle', () => {
  it('anchors on the worker name and the first prompt line', () => {
    expect(deriveAutoCardTitle({ name: 'scout-1', role: 'scout', prompt: 'Find the bug\nmore detail' })).toBe(
      'scout-1: Find the bug',
    );
  });

  it('falls back to the role when the prompt is empty', () => {
    expect(deriveAutoCardTitle({ name: 'w', role: 'builder', prompt: '' })).toBe('w: builder');
  });

  it('truncates a very long title with an ellipsis', () => {
    const title = deriveAutoCardTitle({ name: 'w', role: 'r', prompt: 'x'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('auto-card on worker spawn', () => {
  it('creates a todo card auto-assigned to a freshly-spawned worker', () => {
    const o = makeOrchestrator();
    orch = o;
    o.start({ skipSpawn: true });
    const worker = o.addWorker({ name: 'scout-1', role: 'scout', prompt: 'Investigate the crash', skipSpawn: true });

    const cards = store.listCards({ orchestratorId: ORCH_ID });
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.assigneeSessionId).toBe(worker.id);
    expect(card.status).toBe('todo');
    expect(card.autoCreated).toBe(true);
    expect(card.title).toBe('scout-1: Investigate the crash');
    // Provenance is the lead session id (the spawner), not the worker.
    expect(card.createdBy).toBe(o.leadSessionId);
  });

  it('does NOT create a card for a resumed worker (existingId set)', () => {
    const o = makeOrchestrator();
    orch = o;
    o.start({ skipSpawn: true });
    o.addWorker({
      name: 'resumed',
      role: 'scout',
      prompt: 'go',
      existingId: 'prior-session-id',
      skipSpawn: true,
    });
    expect(store.listCards({ orchestratorId: ORCH_ID })).toHaveLength(0);
  });
});
