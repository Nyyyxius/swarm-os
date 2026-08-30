// Tests for `../lib/jobs.js` — the video job store.
//
// Two things matter and neither is obvious:
//
//  1. A RUNNING JOB IS NEVER PRUNED. Veo takes minutes; a busy swarm can push 50
//     records through the store in that time, and evicting the one job an agent
//     is still waiting on strands an operation that was paid for.
//  2. `saveJob` RETURNS FALSE WHEN THE STORE IS DEAD. `db-kv` is an optional
//     capability and the caller's SafeKv swallows a missing grant, so a `set`
//     that silently does nothing is indistinguishable from success — unless the
//     write is read back. The tool surfaces that boolean to the agent as "use
//     the operation name instead", which only works if it is honest.

import { describe, it, expect } from 'vitest';

import { getJob, listJobs, newJobId, pruneJobs, saveJob } from '../lib/jobs.js';

/** A KV with the same surface as `api.storage.kv`. */
function memKv() {
  const store = new Map();
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
    list: (p = '') => [...store].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
  };
}

function job(id, over = {}) {
  return { id, operation: `op/${id}`, model: 'veo', prompt: 'p', status: 'done', createdAt: 1000, updatedAt: 0, ...over };
}

describe('newJobId', () => {
  it('is hex and does not repeat', () => {
    const a = newJobId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(newJobId());
  });
});

describe('saveJob / getJob', () => {
  it('round-trips a record and stamps updatedAt', () => {
    const kv = memKv();
    expect(saveJob(kv, job('a', { status: 'running' }))).toBe(true);
    const back = getJob(kv, 'a');
    expect(back.operation).toBe('op/a');
    expect(back.updatedAt).toBeGreaterThan(0);
  });

  it('returns FALSE when the store is unavailable (no db-kv grant)', () => {
    const dead = {
      get() {
        throw new Error('capability not granted');
      },
      set() {
        throw new Error('capability not granted');
      },
    };
    expect(saveJob(dead, job('a'))).toBe(false);
  });

  it('returns false rather than throwing on a nonsense argument', () => {
    expect(saveJob(memKv(), /** @type {never} */ (null))).toBe(false);
    expect(saveJob(null, job('a'))).toBe(false);
  });

  it('treats a corrupted row as a missing row', () => {
    const kv = memKv();
    kv.set('job.x', '{not json');
    expect(getJob(kv, 'x')).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(getJob(memKv(), 'nope')).toBeNull();
  });
});

describe('listJobs', () => {
  it('returns the newest first and honours the limit', () => {
    const kv = memKv();
    saveJob(kv, job('old', { createdAt: 1 }));
    saveJob(kv, job('new', { createdAt: 999 }));
    expect(listJobs(kv).map((j) => j.id)).toEqual(['new', 'old']);
    expect(listJobs(kv, 1).map((j) => j.id)).toEqual(['new']);
  });

  it('skips corrupted rows instead of failing the whole listing', () => {
    const kv = memKv();
    saveJob(kv, job('good'));
    kv.set('job.bad', 'nope');
    expect(listJobs(kv).map((j) => j.id)).toEqual(['good']);
  });

  it('is empty (never throws) when the store has no list()', () => {
    expect(listJobs({ get: () => null, set: () => {} })).toEqual([]);
  });
});

describe('pruneJobs', () => {
  it('drops the oldest finished records past the cap', () => {
    const kv = memKv();
    for (let i = 0; i < 60; i += 1) saveJob(kv, job(`j${i}`, { createdAt: 1000 + i }));
    expect(kv.store.size).toBe(50);
    expect(getJob(kv, 'j59')).not.toBeNull(); // newest kept
    expect(getJob(kv, 'j0')).toBeNull(); // oldest dropped
  });

  it('NEVER drops a running job, however old it is', () => {
    const kv = memKv();
    saveJob(kv, job('waiting', { createdAt: 0, status: 'running' }));
    for (let i = 0; i < 60; i += 1) saveJob(kv, job(`j${i}`, { createdAt: 1000 + i }));
    expect(getJob(kv, 'waiting')).not.toBeNull();
  });

  it('does nothing below the cap and returns the number removed', () => {
    const kv = memKv();
    saveJob(kv, job('a'));
    expect(pruneJobs(kv)).toBe(0);
  });
});
