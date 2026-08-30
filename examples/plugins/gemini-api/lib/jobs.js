// jobs.js — the bookkeeping behind asynchronous video generation.
//
// Veo takes MINUTES. An MCP tool call that blocks for six of them is a tool call
// the client times out on, so `generate_video` starts the job, hands back a
// `job_id`, and `video_status` polls it. That split needs somewhere to remember
// what was started.
//
// KV, NOT MEMORY. A module-level Map would be the obvious choice and the wrong
// one: a config change hot-restarts the plugin (host.ts:670-681), and every
// in-flight video would become an orphan operation with the agent holding a
// job_id nothing recognises. The KV row survives a reload, a disable/enable
// cycle, and a server restart — the operation lives on Google's side either way.
//
// Every function here is BEST-EFFORT: `db-kv` is an optional capability, and the
// caller's `SafeKv` swallows a missing grant. A store that silently does nothing
// degrades video generation to "fire and check the output directory", which is
// exactly what the tool tells the agent when `saveJob` returns false.
//
// NO MUTABLE MODULE STATE (see the ESM-cache note in lib/gemini.js).

import { randomBytes } from 'node:crypto';

/** KV key prefix. Everything under it is a job record. */
const PREFIX = 'job.';

/** Jobs kept before the oldest are dropped — a swarm, not an archive. */
const MAX_JOBS = 50;

/**
 * @typedef {object} VideoJob
 * @property {string} id
 * @property {string} operation      Google's long-running operation name
 * @property {string} model
 * @property {string} prompt         truncated, for the operator's /status page
 * @property {string} status         'running' | 'done' | 'failed'
 * @property {number} createdAt      epoch ms
 * @property {number} updatedAt      epoch ms
 * @property {string} [sessionName]  who asked, for the operator
 * @property {Array<object>} [files]  written media, once done
 * @property {string} [code]         failure code, once failed
 * @property {string} [error]        failure detail, once failed
 * @property {string} [hint]
 */

/** @returns {string} 16 hex characters — collision-free enough for a job list. */
export function newJobId() {
  return randomBytes(8).toString('hex');
}

/**
 * Persist a job. Returns false when the store is unavailable (no `db-kv` grant),
 * which the caller MUST surface: a job that cannot be looked up later is a very
 * different promise from one that can.
 *
 * @param {{get(k:string):string|null, set(k:string,v:string):void, delete?(k:string):void, list?(p?:string):Array<{key:string,value:string}>}} kv
 * @param {VideoJob} job
 * @returns {boolean}
 */
export function saveJob(kv, job) {
  if (!kv || !job || typeof job.id !== 'string' || job.id === '') return false;
  try {
    kv.set(`${PREFIX}${job.id}`, JSON.stringify({ ...job, updatedAt: Date.now() }));
  } catch {
    return false;
  }
  // A write is the only moment the store can grow, so it is the only moment
  // worth paying for a prune.
  pruneJobs(kv);
  // Read back: `SafeKv` swallows a missing `db-kv` grant, so a successful `set`
  // proves nothing on its own.
  return getJob(kv, job.id) !== null;
}

/**
 * @param {any} kv
 * @param {string} id
 * @returns {VideoJob|null}
 */
export function getJob(kv, id) {
  if (!kv || typeof id !== 'string' || id === '') return null;
  let raw = null;
  try {
    raw = kv.get(`${PREFIX}${id}`);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // a corrupted row is a missing row
  }
}

/**
 * Every known job, newest first.
 *
 * @param {any} kv
 * @param {number} [limit]
 * @returns {VideoJob[]}
 */
export function listJobs(kv, limit = MAX_JOBS) {
  if (!kv || typeof kv.list !== 'function') return [];
  let rows = [];
  try {
    rows = kv.list(PREFIX) || [];
  } catch {
    return [];
  }
  /** @type {VideoJob[]} */
  const jobs = [];
  for (const row of rows) {
    if (!row || typeof row.value !== 'string') continue;
    try {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') jobs.push(parsed);
    } catch {
      // Skip a corrupted row rather than fail the whole listing.
    }
  }
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.slice(0, Math.max(0, limit));
}

/**
 * Drop the oldest records past `keep`. A RUNNING job is never pruned, whatever
 * its age: dropping it would strand an operation the agent is still waiting on.
 *
 * @param {any} kv
 * @param {number} [keep]
 * @returns {number} rows removed
 */
export function pruneJobs(kv, keep = MAX_JOBS) {
  if (!kv || typeof kv.list !== 'function' || typeof kv.delete !== 'function') return 0;
  const jobs = listJobs(kv, Number.MAX_SAFE_INTEGER);
  if (jobs.length <= keep) return 0;
  const finished = jobs.filter((j) => j.status !== 'running');
  const excess = jobs.length - keep;
  let removed = 0;
  // `finished` is newest-first, so the tail is the oldest.
  for (const job of finished.slice(-excess)) {
    try {
      kv.delete(`${PREFIX}${job.id}`);
      removed += 1;
    } catch {
      // Best-effort: a row we could not drop is a row we keep.
    }
  }
  return removed;
}
