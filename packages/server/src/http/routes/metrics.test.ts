/**
 * Lot 10 — the `/metrics/system` route's own contract.
 *
 * The collector's semantics have their own suite
 * (`modules/metrics/systemMetrics.test.ts`); what belongs to this layer is
 * that the route exists on the same authenticated router as
 * `/metrics/messages`, and that it serves the snapshot **verbatim** — the UI
 * gauges key off the exact field names and off `null` meaning "unknown".
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createMetricsRouter } from './metrics.js';
import type { MessagesAggregator } from '../../modules/metrics/aggregator.js';
import { SystemMetricsCollector } from '../../modules/metrics/systemMetrics.js';

let listening: Server | null = null;

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

const aggregator = { snapshot: () => ({ total: 0 }) } as unknown as MessagesAggregator;

async function serve(systemMetrics: SystemMetricsCollector): Promise<string> {
  const app = express();
  app.use(createMetricsRouter(aggregator, undefined, systemMetrics));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

const MIB = 1024 * 1024;

const files: Record<string, string> = {
  '/sys/fs/cgroup/memory.current': `${512 * MIB}`,
  '/sys/fs/cgroup/memory.max': `${1024 * MIB}`,
  '/sys/fs/cgroup/cpu.stat': 'usage_usec 1000000',
  '/sys/fs/cgroup/cpu.max': '200000 100000',
};

function collector(): SystemMetricsCollector {
  return new SystemMetricsCollector({
    readFileImpl: (p) => {
      const raw = files[p];
      if (raw === undefined) throw new Error(`ENOENT ${p}`);
      return raw;
    },
    cpusImpl: () => new Array(4).fill({}),
    totalmemImpl: () => 8192 * MIB,
    nowImpl: () => 0,
  });
}

describe('GET /metrics/system', () => {
  it('answers 200 with the snapshot shape the gauges expect', async () => {
    const base = await serve(collector());
    const res = await fetch(`${base}/metrics/system`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      // First request → no CPU delta yet, and that is a null, not a zero.
      cpu: { pct: null, cores: 2, basis: 'cgroup' },
      memory: { usedBytes: 512 * MIB, limitBytes: 1024 * MIB, pct: 0.5, basis: 'cgroup' },
    });
  });

  it('is mounted even without a bus collector, alongside /metrics/messages', async () => {
    const base = await serve(collector());
    expect((await fetch(`${base}/metrics/messages`)).status).toBe(200);
    expect((await fetch(`${base}/metrics/bus`)).status).toBe(404);
    expect((await fetch(`${base}/metrics/system`)).status).toBe(200);
  });
});
