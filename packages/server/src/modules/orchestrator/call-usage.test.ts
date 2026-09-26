import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ContextUsageTracker,
  TranscriptContextSource,
  scanTranscriptRange,
  type TranscriptCall,
  type TranscriptRangeReader,
} from './context-usage.js';
import { Orchestrator } from './index.js';
import { NoOpPersistence } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import { CallLedger } from '../metrics/call-usage.js';
import type { SessionCallRow } from '../db/index.js';
import type { Config } from '../../config.js';

/**
 * Per-call ledger (docs/monitoring-agents.md, « Appels par agent ») — the
 * capture half: which transcript lines become calls, that each call is handed
 * over exactly once, and that the server reads a transcript with NO browser
 * open (idle boundary) and one last time when the agent exits.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function line(opts: {
  id?: string;
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  sidechain?: boolean;
  model?: string;
  timestamp?: string | null;
}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    ...(opts.timestamp === null ? {} : { timestamp: opts.timestamp ?? '2026-09-26T10:00:00.000Z' }),
    message: {
      id: opts.id ?? 'msg_1',
      role: 'assistant',
      model: opts.model ?? 'claude-opus-5-5',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: opts.input ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  });
}

const TRANSCRIPT = '/agent/transcript.jsonl';

function memoryRange(files: Record<string, string>): TranscriptRangeReader {
  return async (filePath, offset, maxBytes) => {
    const body = files[filePath];
    if (body === undefined) return null;
    const buf = Buffer.from(body, 'utf8');
    if (offset >= buf.length) return { text: '', bytes: 0, size: buf.length };
    const slice = buf.subarray(offset, Math.min(buf.length, offset + maxBytes));
    return { text: slice.toString('utf8'), bytes: slice.length, size: buf.length };
  };
}

// ---------------------------------------------------------------------------
// 1. The scanner
// ---------------------------------------------------------------------------

describe('scanTranscriptRange — calls', () => {
  it('emits one call per message id, with its four buckets, model and timestamp', () => {
    const text = [
      line({ id: 'm1', input: 3, cacheCreation: 500, cacheRead: 20_000, output: 40 }),
      // The second line of the same turn: same id, same usage — NOT a new call.
      line({ id: 'm1', input: 3, cacheCreation: 500, cacheRead: 20_000, output: 40 }),
      line({ id: 'm2', input: 1, cacheRead: 20_500, output: 7, timestamp: '2026-09-26T10:00:05.000Z' }),
    ].join('\n') + '\n';
    const scan = scanTranscriptRange(text);
    expect(scan.calls).toEqual<TranscriptCall[]>([
      {
        messageId: 'm1',
        ts: Date.parse('2026-09-26T10:00:00.000Z'),
        model: 'claude-opus-5-5',
        input: 3,
        cacheWrite: 500,
        cacheRead: 20_000,
        output: 40,
        isSidechain: false,
      },
      {
        messageId: 'm2',
        ts: Date.parse('2026-09-26T10:00:05.000Z'),
        model: 'claude-opus-5-5',
        input: 1,
        cacheWrite: 0,
        cacheRead: 20_500,
        output: 7,
        isSidechain: false,
      },
    ]);
  });

  it('skips ids the caller has already billed — a call is handed over once', () => {
    const text = `${line({ id: 'm1', input: 5 })}\n${line({ id: 'm2', input: 6 })}\n`;
    const scan = scanTranscriptRange(text, new Set(['m1']));
    expect(scan.calls.map((c) => c.messageId)).toEqual(['m2']);
  });

  it('keeps sidechain calls (they are billed) and flags them', () => {
    const scan = scanTranscriptRange(`${line({ id: 's1', input: 9, sidechain: true })}\n`);
    expect(scan.calls).toHaveLength(1);
    expect(scan.calls[0]?.isSidechain).toBe(true);
  });

  it('refuses <synthetic> messages and all-zero usage — neither reached a model', () => {
    const text = [
      line({ id: 'syn', model: '<synthetic>', input: 0 }),
      line({ id: 'zero' }),
      line({ id: 'real', output: 1 }),
    ].join('\n') + '\n';
    const scan = scanTranscriptRange(text);
    expect(scan.calls.map((c) => c.messageId)).toEqual(['real']);
    // …but the id memory still learns them: billing is unchanged.
    expect(scan.countedIds).toEqual(['syn', 'zero', 'real']);
  });

  it('answers ts: null for a line with no parseable timestamp', () => {
    const text = `${line({ id: 'a', input: 1, timestamp: null })}\n${line({ id: 'b', input: 1, timestamp: 'nope' })}\n`;
    expect(scanTranscriptRange(text).calls.map((c) => c.ts)).toEqual([null, null]);
  });

  it('emits nothing for a trailing partial line (it is re-read whole next time)', () => {
    const full = line({ id: 'm1', input: 1 });
    expect(scanTranscriptRange(full.slice(0, 40)).calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The source and the tracker
// ---------------------------------------------------------------------------

describe('TranscriptContextSource — calls ride the reading', () => {
  it('hands each call over in the read that passed it, never again', async () => {
    const files = { [TRANSCRIPT]: `${line({ id: 'm1', input: 1 })}\n` };
    const source = new TranscriptContextSource({ readRange: memoryRange(files), readTail: async () => null });
    source.retarget(TRANSCRIPT);
    expect((await source.read()).calls?.map((c) => c.messageId)).toEqual(['m1']);
    expect((await source.read()).calls).toBeUndefined();
    files[TRANSCRIPT] += `${line({ id: 'm2', input: 2 })}\n`;
    expect((await source.read()).calls?.map((c) => c.messageId)).toEqual(['m2']);
  });

  it('carries the calls of the file a /clear left behind (the drain)', async () => {
    const OLD = '/agent/old.jsonl';
    const NEW = '/agent/new.jsonl';
    const files: Record<string, string> = { [OLD]: `${line({ id: 'o1', input: 1 })}\n`, [NEW]: '' };
    const source = new TranscriptContextSource({ readRange: memoryRange(files), readTail: async () => null });
    source.retarget(OLD);
    await source.read();
    // The turn that filled the window lands AFTER our last read, then /clear.
    files[OLD] += `${line({ id: 'o2', input: 2 })}\n`;
    source.retarget(NEW);
    files[NEW] = `${line({ id: 'n1', input: 3 })}\n`;
    expect((await source.read()).calls?.map((c) => c.messageId)).toEqual(['o2', 'n1']);
  });

  it('says it is `behind` until the cursor has reached the end of the file', async () => {
    const body = Array.from({ length: 20 }, (_, i) => line({ id: `m${i}`, input: 1 })).join('\n') + '\n';
    const files = { [TRANSCRIPT]: body };
    const source = new TranscriptContextSource({
      readRange: memoryRange(files),
      readTail: async () => null,
      maxRangeBytes: 400,
    });
    source.retarget(TRANSCRIPT);
    expect(source.behind).toBe(true);
    await source.read();
    expect(source.behind).toBe(true);
    for (let i = 0; i < 50 && source.behind; i++) await source.read();
    expect(source.behind).toBe(false);
  });
});

describe('ContextUsageTracker — onCalls, catchUp, flush', () => {
  function trackerOver(files: Record<string, string>, maxRangeBytes?: number) {
    const source = new TranscriptContextSource({
      readRange: memoryRange(files),
      readTail: async () => null,
      ...(maxRangeBytes !== undefined ? { maxRangeBytes } : {}),
    });
    source.retarget(TRANSCRIPT);
    const calls: string[] = [];
    const tracker = new ContextUsageTracker({
      sessionId: 's',
      // A TTL no test will ever wait out: only catchUp/flush may read twice.
      ttlMs: 3_600_000,
      source,
      onCalls: (batch) => calls.push(...batch.map((c) => c.messageId)),
    });
    return { tracker, source, calls };
  }

  it('fires onCalls with each new call exactly once, never empty', async () => {
    const files = { [TRANSCRIPT]: `${line({ id: 'm1', input: 1 })}\n` };
    const batches: number[] = [];
    const source = new TranscriptContextSource({ readRange: memoryRange(files), readTail: async () => null });
    source.retarget(TRANSCRIPT);
    const tracker = new ContextUsageTracker({
      sessionId: 's',
      ttlMs: 3_600_000,
      source,
      onCalls: (b) => batches.push(b.length),
    });
    await tracker.catchUp();
    await tracker.catchUp();
    expect(batches).toEqual([1]);
  });

  it('a throwing sink cannot break the read path', async () => {
    const files = { [TRANSCRIPT]: `${line({ id: 'm1', input: 1 })}\n` };
    const source = new TranscriptContextSource({ readRange: memoryRange(files), readTail: async () => null });
    source.retarget(TRANSCRIPT);
    const tracker = new ContextUsageTracker({
      sessionId: 's',
      ttlMs: 3_600_000,
      source,
      onCalls: () => {
        throw new Error('db down');
      },
    });
    await tracker.catchUp();
    expect(tracker.tokenUsage.in).toBe(1);
  });

  it('catchUp ignores the TTL that maybeRefresh obeys', async () => {
    const files = { [TRANSCRIPT]: `${line({ id: 'm1', input: 1 })}\n` };
    const { tracker, calls } = trackerOver(files);
    await tracker.catchUp();
    files[TRANSCRIPT] += `${line({ id: 'm2', input: 1 })}\n`;
    tracker.maybeRefresh(); // inside the TTL: a no-op
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['m1']);
    await tracker.catchUp();
    expect(calls).toEqual(['m1', 'm2']);
  });

  it('catchUp chains reads while the cursor is behind, bounded', async () => {
    const body = Array.from({ length: 12 }, (_, i) => line({ id: `m${i}`, input: 1 })).join('\n') + '\n';
    const files = { [TRANSCRIPT]: body };
    // ~1 line per read: 12 lines need 12+ reads, a catch-up allows 4.
    const { tracker, calls } = trackerOver(files, 300);
    await tracker.catchUp(4);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(12);
    await tracker.flush(64);
    expect(calls).toHaveLength(12);
  });

  it('flush waits for a read in flight, then reads what was written after it', async () => {
    const files = { [TRANSCRIPT]: `${line({ id: 'm1', input: 1 })}\n` };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const plain = memoryRange(files);
    let first = true;
    const slowRead: TranscriptRangeReader = async (...args) => {
      const out = await plain(...args);
      if (first) {
        first = false;
        await gate;
      }
      return out;
    };
    const source = new TranscriptContextSource({ readRange: slowRead, readTail: async () => null });
    source.retarget(TRANSCRIPT);
    const calls: string[] = [];
    const tracker = new ContextUsageTracker({
      sessionId: 's',
      ttlMs: 3_600_000,
      source,
      onCalls: (b) => calls.push(...b.map((c) => c.messageId)),
    });
    tracker.maybeRefresh(); // in flight, sees only m1
    files[TRANSCRIPT] += `${line({ id: 'm2', input: 1 })}\n`; // the final turn
    const flushed = tracker.flush();
    release();
    await flushed;
    expect(calls).toEqual(['m1', 'm2']);
  });

  it('flush is a no-op for a tracker that never had a target', async () => {
    const source = new TranscriptContextSource({ readRange: memoryRange({}), readTail: async () => null });
    const tracker = new ContextUsageTracker({ sessionId: 's', ttlMs: 1, source });
    await expect(tracker.flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. End to end — a real Orchestrator, a real transcript, no UI poll
// ---------------------------------------------------------------------------

let tmpRoot: string;
let open: Array<{ stop: (r: string, ms: number) => void }> = [];

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 8788,
    projectName: 'test',
    defaultModel: 'claude-opus-5',
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'claude',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir: path.join(tmpRoot, 'data'),
    logsDir: path.join(tmpRoot, 'logs'),
    mcpRuntimeDir: path.join(tmpRoot, 'mcp'),
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 100,
    idleThresholdMs: 30,
    contextUsageTtlMs: 3_600_000,
    autoCompactPct: 0,
    workerAutoCompactPct: 0,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
    ...overrides,
  } as unknown as Config;
}

function makeTeam() {
  const config = makeConfig();
  for (const d of [config.logsDir, config.dataDir, config.mcpRuntimeDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider({ id: 'claude' }), { builtin: true });
  const rows: SessionCallRow[] = [];
  const ledger = new CallLedger({
    insertSessionCalls: (batch) => {
      rows.push(...batch);
      return batch.length;
    },
    deleteSessionCallsBefore: () => 0,
  });
  const orch = new Orchestrator(
    {
      name: 'ledger',
      role: 'co',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      defaultProvider: 'claude',
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    config,
    { persistence: new NoOpPersistence(), providerRegistry: registry, callLedger: ledger },
  );
  const pty = new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot });
  const lead = orch.start({ agentProcessOverride: pty });
  open.push(lead);
  return { orch, lead, pty, rows };
}

async function waitUntil(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const recent = (): string => new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-calls-'));
  open = [];
});

afterEach(async () => {
  for (const s of open) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Orchestrator — the per-call ledger with no browser open', () => {
  it('files a claude agent’s calls at its idle boundary — no toView(), auto-compact OFF', async () => {
    const { lead, pty, rows, orch } = makeTeam();
    const file = path.join(tmpRoot, 'lead.jsonl');
    fs.writeFileSync(file, `${line({ id: 'm1', input: 2, cacheRead: 900, output: 10, timestamp: recent() })}\n`);
    lead.setTranscriptPath(file);
    // One byte of PTY output, then silence ⇒ an idle boundary.
    pty._emitData('x');
    await waitUntil(() => rows.length === 1);
    expect(rows[0]).toMatchObject({
      session_id: lead.id,
      orchestrator_id: orch.id,
      session_type: 'lead',
      message_id: 'm1',
      input_tokens: 2,
      cache_read_tokens: 900,
      output_tokens: 10,
      context_tokens: 902,
      is_sidechain: 0,
    });
  });

  it('reads the transcript one last time when the agent exits', async () => {
    const { lead, pty, rows } = makeTeam();
    const file = path.join(tmpRoot, 'lead.jsonl');
    fs.writeFileSync(file, `${line({ id: 'm1', input: 1, timestamp: recent() })}\n`);
    lead.setTranscriptPath(file);
    pty._emitData('x');
    await waitUntil(() => rows.length === 1);
    // The final turn, written after the last read, then the process dies.
    fs.appendFileSync(file, `${line({ id: 'm2', input: 1, output: 3, timestamp: recent() })}\n`);
    pty._simulateExit({ exitCode: 0, signal: null });
    await waitUntil(() => rows.length === 2);
    expect(rows.map((r) => r.message_id)).toEqual(['m1', 'm2']);
    expect(lead.tokenUsage.out).toBe(3);
  });
});
