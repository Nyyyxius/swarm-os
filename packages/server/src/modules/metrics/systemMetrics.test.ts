/**
 * Lot 10 — unit tests for `SystemMetricsCollector`.
 *
 * The collector's whole job is reading files that only exist inside a
 * container and turning a monotone counter into a rate, so both are injected:
 * a `Map<path, contents>` stands in for the cgroup filesystem (a missing key
 * throws, exactly like a missing file) and a manual clock drives the CPU
 * delta window. No fake timers, no sleeps — the collector owns no timer.
 */
import { describe, it, expect } from 'vitest';
import { SystemMetricsCollector, type SystemMetricsCollectorOptions } from './systemMetrics.js';

const MIB = 1024 * 1024;
const HOST_TOTAL_MEM = 8192 * MIB;
const HOST_CORES = 4;

/** A fake cgroupfs: absent path → throw, like `fs.readFileSync` on ENOENT. */
function fsFixture(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const raw = files[path];
    if (raw === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    return raw;
  };
}

/** Collector wired to a fixture fs, a host of 4 cores / 8 GiB, and a clock. */
function makeCollector(
  files: Record<string, string>,
  over: SystemMetricsCollectorOptions = {},
): { collector: SystemMetricsCollector; clock: { ms: number } } {
  const clock = { ms: 1_000_000 };
  const collector = new SystemMetricsCollector({
    readFileImpl: fsFixture(files),
    cpusImpl: () => new Array(HOST_CORES).fill({}),
    totalmemImpl: () => HOST_TOTAL_MEM,
    nowImpl: () => clock.ms,
    ...over,
  });
  return { collector, clock };
}

/** cgroup v2 leaf with a 1 GiB memory cap and a 2-core CPU quota. */
function v2Files(usageUsec: number, memCurrent = 512 * MIB): Record<string, string> {
  return {
    '/sys/fs/cgroup/memory.current': `${memCurrent}\n`,
    '/sys/fs/cgroup/memory.max': `${1024 * MIB}\n`,
    '/sys/fs/cgroup/cpu.stat': `usage_usec ${usageUsec}\nuser_usec 1\nsystem_usec 2\n`,
    '/sys/fs/cgroup/cpu.max': '200000 100000\n',
  };
}

describe('memory', () => {
  it('reads cgroup v2 current/max and reports the cgroup basis', () => {
    const { collector } = makeCollector(v2Files(0));
    const { memory } = collector.snapshot();
    expect(memory).toEqual({
      usedBytes: 512 * MIB,
      limitBytes: 1024 * MIB,
      pct: 0.5,
      basis: 'cgroup',
    });
  });

  it('falls back to host RAM when memory.max is "max"', () => {
    // `docker run` without `-m`: the cgroup caps nothing, so the honest
    // denominator is the host's RAM — and the UI must be told so.
    const files = v2Files(0);
    files['/sys/fs/cgroup/memory.max'] = 'max\n';
    const { collector } = makeCollector(files);
    const { memory } = collector.snapshot();
    expect(memory.basis).toBe('host');
    expect(memory.limitBytes).toBe(HOST_TOTAL_MEM);
    expect(memory.usedBytes).toBe(512 * MIB);
    expect(memory.pct).toBeCloseTo((512 * MIB) / HOST_TOTAL_MEM, 10);
  });

  it('reads the cgroup v1 hierarchy when v2 is absent', () => {
    const { collector } = makeCollector({
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${256 * MIB}\n`,
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${512 * MIB}\n`,
    });
    const { memory } = collector.snapshot();
    expect(memory).toEqual({
      usedBytes: 256 * MIB,
      limitBytes: 512 * MIB,
      pct: 0.5,
      basis: 'cgroup',
    });
  });

  it('treats the v1 sentinel limit as unlimited', () => {
    // v1 spells "no limit" as PAGE_COUNTER_MAX × page size, not a keyword.
    const { collector } = makeCollector({
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${256 * MIB}\n`,
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
    });
    const { memory } = collector.snapshot();
    expect(memory.basis).toBe('host');
    expect(memory.limitBytes).toBe(HOST_TOTAL_MEM);
  });

  it('clamps a usage that overshoots the limit', () => {
    const files = v2Files(0, 4096 * MIB);
    const { collector } = makeCollector(files);
    expect(collector.snapshot().memory.pct).toBe(1);
  });
});

describe('cpu', () => {
  it('returns null on the very first call — one point is not a rate', () => {
    const { collector } = makeCollector(v2Files(1_000_000));
    const { cpu } = collector.snapshot();
    expect(cpu.pct).toBeNull();
    expect(cpu.cores).toBe(2);
    expect(cpu.basis).toBe('cgroup');
  });

  it('computes the delta over the wall window, divided by the cores', () => {
    // 2 s of wall time, 2 s of CPU time consumed, 2 cores available → 50 %.
    const files = v2Files(1_000_000);
    const { collector, clock } = makeCollector(files);
    expect(collector.snapshot().cpu.pct).toBeNull();

    clock.ms += 2_000;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 3000000\n';
    expect(collector.snapshot().cpu.pct).toBeCloseTo(0.5, 10);

    // And it keeps rolling: next window is 1 s of wall for 0.5 s of CPU on
    // 2 cores → 25 %.
    clock.ms += 1_000;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 3500000\n';
    expect(collector.snapshot().cpu.pct).toBeCloseTo(0.25, 10);
  });

  it('serves the cached value for polls closer than 1 s', () => {
    // A sub-second window turns scheduler jitter into 0 %/300 % noise, and a
    // fast poller must not be able to starve the metric either.
    const files = v2Files(1_000_000);
    const { collector, clock } = makeCollector(files);
    collector.snapshot();
    clock.ms += 2_000;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 3000000\n';
    const computed = collector.snapshot().cpu.pct;
    expect(computed).toBeCloseTo(0.5, 10);

    clock.ms += 200;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 9999999999\n';
    expect(collector.snapshot().cpu.pct).toBe(computed);
    clock.ms += 200;
    expect(collector.snapshot().cpu.pct).toBe(computed);

    // Once the window is wide enough again the reference point is still the
    // last *computed* sample, so nothing was lost: 1 s of wall, 1 s of CPU
    // charged over 2 cores → 50 %.
    clock.ms += 600;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 4000000\n';
    expect(collector.snapshot().cpu.pct).toBeCloseTo(0.5, 10);
  });

  it('clamps a delta that exceeds the window', () => {
    // A stepped clock or a cgroup swap can hand us more CPU time than wall
    // time × cores; the gauge stops at 100 % rather than drawing past it.
    const files = v2Files(0);
    const { collector, clock } = makeCollector(files);
    collector.snapshot();
    clock.ms += 1_000;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 60000000\n';
    expect(collector.snapshot().cpu.pct).toBe(1);
  });

  it('never emits a negative rate when the counter resets', () => {
    const files = v2Files(5_000_000);
    const { collector, clock } = makeCollector(files);
    collector.snapshot();
    clock.ms += 1_000;
    files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 10\n';
    expect(collector.snapshot().cpu.pct).toBe(0);
  });

  it('converts the cgroup v1 nanosecond counter', () => {
    // cpuacct.usage is in ns; 1 s of CPU over 1 s of wall on 4 host cores
    // is 25 %. Also exercises the host-core path (no cpu.max at all).
    const files: Record<string, string> = { '/sys/fs/cgroup/cpuacct/cpuacct.usage': '0\n' };
    const { collector, clock } = makeCollector(files);
    const first = collector.snapshot();
    expect(first.cpu.pct).toBeNull();
    expect(first.cpu.cores).toBe(HOST_CORES);
    expect(first.cpu.basis).toBe('host');

    clock.ms += 1_000;
    files['/sys/fs/cgroup/cpuacct/cpuacct.usage'] = '1000000000\n';
    expect(collector.snapshot().cpu.pct).toBeCloseTo(0.25, 10);
  });

  it('derives the core count from a cpu.max quota', () => {
    const files = v2Files(0);
    files['/sys/fs/cgroup/cpu.max'] = '150000 100000\n';
    const { collector } = makeCollector(files);
    const { cpu } = collector.snapshot();
    expect(cpu.cores).toBe(1.5);
    expect(cpu.basis).toBe('cgroup');
  });

  it('falls back to the host core count when cpu.max is "max"', () => {
    const files = v2Files(0);
    files['/sys/fs/cgroup/cpu.max'] = 'max 100000\n';
    const { collector } = makeCollector(files);
    const { cpu } = collector.snapshot();
    expect(cpu.cores).toBe(HOST_CORES);
    expect(cpu.basis).toBe('host');
  });
});

describe('degraded environments', () => {
  it('reports null everywhere when no cgroup file is readable', () => {
    // A dev run outside a container must not throw, and must not invent a
    // number the UI would render as a real gauge.
    const { collector } = makeCollector({});
    expect(collector.snapshot()).toEqual({
      cpu: { pct: null, cores: HOST_CORES, basis: 'host' },
      memory: { usedBytes: null, limitBytes: null, pct: null, basis: null },
    });
  });

  it('reports null cores too when even os.cpus() is unavailable', () => {
    const { collector } = makeCollector({}, { cpusImpl: () => [] });
    expect(collector.snapshot().cpu).toEqual({ pct: null, cores: null, basis: null });
  });

  it('never throws when a read blows up mid-flight', () => {
    const { collector } = makeCollector(v2Files(1_000), {
      readFileImpl: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => collector.snapshot()).not.toThrow();
    expect(collector.snapshot().memory.usedBytes).toBeNull();
  });

  it('ignores garbage contents rather than emitting NaN', () => {
    const { collector } = makeCollector({
      '/sys/fs/cgroup/memory.current': 'not-a-number\n',
      '/sys/fs/cgroup/cpu.stat': 'nr_periods 3\n',
    });
    const snap = collector.snapshot();
    expect(snap.memory.usedBytes).toBeNull();
    expect(snap.cpu.pct).toBeNull();
  });
});
