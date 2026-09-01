/**
 * REST + persistence surface of the agent crons (docs/crons-agents.md, Lot 1).
 *
 * Covers the contract the UI (Lot 3) will be written against — CRUD, the
 * validation rules that are easy to regress (5 fields only, invariants, the
 * temporary refusal of script crons), pause/next-run, the manual fire — plus
 * the one-shot migration of the legacy per-role cadence, which only ever runs
 * once per deployment and therefore has to be right the first time.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import { RoleStore } from '../../src/modules/roles/index.js';
import { CronStore } from '../../src/modules/crons/store.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack();
});

afterEach(async () => {
  await stack.teardown();
});

/**
 * A cadence that cannot fire during the test run (1 January, 03:00). Every case
 * that counts runs uses it, so a real tick can never slip an extra row in.
 */
const NEVER = '0 3 1 1 *';

function url(p: string): string {
  return `http://127.0.0.1:${stack.mainPort}${p}`;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  // The parsed JSON is indexed freely by the assertions below (same shape as
  // `postRole` in roles.test.ts); typing it properly would mean restating every
  // response DTO in the test file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const res = await fetch(url(path), {
    method,
    headers: authHeaders(stack.config.token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeRole(label = 'analysis'): Promise<string> {
  const r = await req('POST', '/roles', { label });
  expect(r.status).toBe(201);
  return r.body.role.id as string;
}

/**
 * Drop a real script in the stack's (temporary) workspace root. The stack wires
 * a real `CronScriptRunner` against these tmpdirs, so script crons go through
 * the same containment rules and the same `spawn` as production.
 */
function writeScript(name: string, body: string): string {
  const file = path.join(stack.workspaceRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${body}\n`, 'utf8');
  return file;
}

/** POST a script cron, expecting success. Returns its id. */
async function makeScriptCron(
  name: string,
  roleId: string,
  scriptPath: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await req('POST', '/crons', {
    name, roleId, schedule: NEVER, action: 'script', scriptPath, interpreter: 'bash', ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.cron.id as string;
}

/**
 * A script run is journalled only when its child exits, so the assertions poll
 * — exactly as the UI does with the `runId` its 202 returned.
 */
async function waitForRun(cronId: string, runId: string, timeoutMs = 10_000): Promise<{
  outcome: string;
  exitCode: number | null;
  outputExcerpt: string | null;
  deliveredTo: string[];
}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = await req('GET', `/crons/${cronId}/runs`);
    const found = runs.body.runs.find((r: { id: string }) => r.id === runId);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`run ${runId} never landed`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('REST: /crons CRUD', () => {
  it('rejects unauthenticated access', async () => {
    const res = await fetch(url('/crons'));
    expect(res.status).toBe(401);
  });

  it('creates, lists, reads, patches and deletes a cron', async () => {
    const roleId = await makeRole();

    const created = await req('POST', '/crons', {
      name: 'analysis-cycle',
      roleId,
      schedule: NEVER,
      action: 'message',
      message: 'run cycle cycle_window_id={{fire}}',
    });
    expect(created.status).toBe(201);
    const id = created.body.cron.id as string;
    expect(id).toMatch(/^cron_[0-9a-f]{8}$/);
    expect(created.body.cron.paused).toBe(false);
    // Armed straight away: the route reloads the scheduler after a mutation.
    expect(created.body.cron.nextRun).not.toBeNull();

    const list = await req('GET', '/crons');
    expect(list.status).toBe(200);
    expect(list.body.schedulingEnabled).toBe(true);
    expect(list.body.crons).toHaveLength(1);
    expect(list.body.crons[0].name).toBe('analysis-cycle');
    expect(list.body.crons[0].lastRun).toBeNull();

    const one = await req('GET', `/crons/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.cron.message).toBe('run cycle cycle_window_id={{fire}}');

    const patched = await req('PATCH', `/crons/${id}`, { message: 'other', schedule: '30 4 1 1 *' });
    expect(patched.status).toBe(200);
    expect(patched.body.cron.message).toBe('other');
    expect(patched.body.cron.schedule).toBe('30 4 1 1 *');

    const del = await req('DELETE', `/crons/${id}`);
    expect(del.status).toBe(204);
    expect((await req('GET', `/crons/${id}`)).status).toBe(404);
  });

  it('counts the role"s crons in GET /roles', async () => {
    const roleId = await makeRole('counted');
    await req('POST', '/crons', {
      name: 'one', roleId, schedule: NEVER, action: 'message', message: 'x',
    });
    await req('POST', '/crons', {
      name: 'two', roleId, schedule: NEVER, action: 'message', message: 'y',
    });
    const roles = await req('GET', '/roles');
    const row = roles.body.roles.find((r: { id: string }) => r.id === roleId);
    expect(row.cronCount).toBe(2);
  });

  it('deleting a cron drops its runs (FK cascade)', async () => {
    const roleId = await makeRole();
    const created = await req('POST', '/crons', {
      name: 'cascade', roleId, schedule: NEVER, action: 'message', message: 'x',
    });
    const id = created.body.cron.id as string;
    expect((await req('POST', `/crons/${id}/fire`)).status).toBe(202);
    expect((await req('GET', `/crons/${id}/runs`)).body.runs).toHaveLength(1);
    await req('DELETE', `/crons/${id}`);
    // The rows are gone with the cron — read straight from SQLite, since the
    // route now 404s.
    const left = stack.db.db
      .prepare('SELECT COUNT(*) AS n FROM cron_runs WHERE cron_id = ?')
      .get(id) as { n: number };
    expect(left.n).toBe(0);
  });
});

describe('REST: /crons validation', () => {
  it('rejects an invalid cron expression', async () => {
    const roleId = await makeRole();
    const r = await req('POST', '/crons', {
      name: 'bad', roleId, schedule: 'not a cron', action: 'message', message: 'x',
    });
    expect(r.status).toBe(400);
  });

  it('rejects a 6-field (per-second) expression even though croner accepts it', async () => {
    const roleId = await makeRole();
    const r = await req('POST', '/crons', {
      name: 'per-second', roleId, schedule: '* * * * * *', action: 'message', message: 'x',
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('5 fields');
  });

  it("rejects action=message without a message", async () => {
    const roleId = await makeRole();
    const r = await req('POST', '/crons', {
      name: 'no-msg', roleId, schedule: NEVER, action: 'message',
    });
    expect(r.status).toBe(400);
  });

  it('rejects a script cron without a scriptPath or an interpreter', async () => {
    const roleId = await makeRole();
    const noPath = await req('POST', '/crons', {
      name: 'jira', roleId, schedule: NEVER, action: 'script', interpreter: 'python3',
    });
    expect(noPath.status).toBe(400);
    expect(noPath.body.code).toBe('INVALID_SCRIPT');

    const noInterp = await req('POST', '/crons', {
      name: 'jira', roleId, schedule: NEVER, action: 'script',
      scriptPath: writeScript('probe.sh', 'echo \'{"wake": false}\''),
    });
    expect(noInterp.status).toBe(400);
  });

  it('rejects an interpreter outside the allowlist', async () => {
    const roleId = await makeRole();
    const r = await req('POST', '/crons', {
      name: 'perl-cron', roleId, schedule: NEVER, action: 'script',
      scriptPath: writeScript('probe.sh', 'echo \'{"wake": false}\''), interpreter: 'perl',
    });
    expect(r.status).toBe(400);
  });

  it('rejects a timeout over the 240s ceiling', async () => {
    const roleId = await makeRole();
    const r = await req('POST', '/crons', {
      name: 'too-long', roleId, schedule: NEVER, action: 'script',
      scriptPath: writeScript('probe.sh', 'echo \'{"wake": false}\''),
      interpreter: 'bash', timeoutMs: 300_000,
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('240000');
  });

  it('rejects a name that would make the `cron:<name>` sender ambiguous', async () => {
    const roleId = await makeRole();
    for (const name of ['has space', 'has:colon', '']) {
      const r = await req('POST', '/crons', {
        name, roleId, schedule: NEVER, action: 'message', message: 'x',
      });
      expect(r.status).toBe(400);
    }
  });

  it('rejects a duplicate name with 409 (the name is the sender identity)', async () => {
    const roleId = await makeRole();
    const body = { name: 'dup', roleId, schedule: NEVER, action: 'message', message: 'x' };
    expect((await req('POST', '/crons', body)).status).toBe(201);
    const second = await req('POST', '/crons', body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('NAME_TAKEN');
  });

  it('rejects an unknown role', async () => {
    const r = await req('POST', '/crons', {
      name: 'orphan', roleId: 'no-such-role', schedule: NEVER, action: 'message', message: 'x',
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNKNOWN_ROLE');
  });

  it('refuses a PATCH that would clear the message of a message cron', async () => {
    const roleId = await makeRole();
    const created = await req('POST', '/crons', {
      name: 'keeps-message', roleId, schedule: NEVER, action: 'message', message: 'x',
    });
    const r = await req('PATCH', `/crons/${created.body.cron.id}`, { message: null });
    expect(r.status).toBe(400);
  });

  it('404s on an unknown id', async () => {
    expect((await req('GET', '/crons/cron_deadbeef')).status).toBe(404);
    expect((await req('PATCH', '/crons/cron_deadbeef', { paused: true })).status).toBe(404);
    expect((await req('POST', '/crons/cron_deadbeef/fire')).status).toBe(404);
    expect((await req('GET', '/crons/cron_deadbeef/runs')).status).toBe(404);
  });
});

describe('REST: /crons pause + manual fire', () => {
  it('pausing disarms the cron and clears its next run', async () => {
    const roleId = await makeRole();
    const created = await req('POST', '/crons', {
      name: 'pausable', roleId, schedule: NEVER, action: 'message', message: 'x',
    });
    const id = created.body.cron.id as string;
    expect(stack.cronScheduler.armedCount).toBe(1);

    const paused = await req('PATCH', `/crons/${id}`, { paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.cron.paused).toBe(true);
    expect(paused.body.cron.nextRun).toBeNull();
    expect(stack.cronScheduler.armedCount).toBe(0);

    const resumed = await req('PATCH', `/crons/${id}`, { paused: false });
    expect(resumed.body.cron.nextRun).not.toBeNull();
    expect(stack.cronScheduler.armedCount).toBe(1);
  });

  it('a manual fire answers 202 + runId and journals the run — even when paused', async () => {
    const roleId = await makeRole();
    const created = await req('POST', '/crons', {
      name: 'manual', roleId, schedule: NEVER, action: 'message', message: 'hello {{fire}}',
      paused: true,
    });
    const id = created.body.cron.id as string;

    const fired = await req('POST', `/crons/${id}/fire`);
    expect(fired.status).toBe(202);
    expect(typeof fired.body.runId).toBe('string');

    const runs = await req('GET', `/crons/${id}/runs`);
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0].id).toBe(fired.body.runId);
    expect(runs.body.runs[0].kind).toBe('manual');
    // No live team of this role → nothing to wake, and that is a noop, not an
    // error (§6.1 — v1 does not restart a stopped team).
    expect(runs.body.runs[0].outcome).toBe('noop');

    // …and the list route surfaces it as the cron's lastRun.
    const list = await req('GET', '/crons');
    expect(list.body.crons[0].lastRun.id).toBe(fired.body.runId);
  });

  it('answers 409 while a run of the same cron is in flight', async () => {
    const roleId = await makeRole();
    const created = await req('POST', '/crons', {
      name: 'busy', roleId, schedule: NEVER, action: 'message', message: 'x',
    });
    const id = created.body.cron.id as string;
    // A message delivery is synchronous, so there is no window to race from a
    // second HTTP call. What this asserts is the ROUTE's half of the guard —
    // that it consults the scheduler and refuses rather than queueing a second
    // run. The guard's own set/release is covered in the scheduler unit test.
    const realIsRunning = stack.cronScheduler.isRunning.bind(stack.cronScheduler);
    stack.cronScheduler.isRunning = (cronId: string) => cronId === id;
    try {
      const r = await req('POST', `/crons/${id}/fire`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('RUN_IN_FLIGHT');
    } finally {
      stack.cronScheduler.isRunning = realIsRunning;
    }
    // No run was recorded for the refused call.
    expect((await req('GET', `/crons/${id}/runs`)).body.runs).toHaveLength(0);
  });
});

describe('REST: /crons script crons (docs/crons-agents.md §2.5)', () => {
  it('creates one, materialises the default timeout, and fires it end to end', async () => {
    const roleId = await makeRole();
    const script = writeScript('crons/skip.sh', 'echo \'{"wake": false}\'');
    const id = await makeScriptCron('nightly-scan', roleId, script);

    const one = await req('GET', `/crons/${id}`);
    expect(one.body.cron.action).toBe('script');
    expect(one.body.cron.interpreter).toBe('bash');
    // The budget an operator will want to raise is stored, not implied.
    expect(one.body.cron.timeoutMs).toBe(60_000);

    const fired = await req('POST', `/crons/${id}/fire`);
    // 202 with a runId, and NO run in the body: the child is still going. A
    // script may outlive Node's request timeout, so the route never waits.
    expect(fired.status).toBe(202);
    expect(typeof fired.body.runId).toBe('string');
    expect(fired.body.run).toBeNull();

    const run = await waitForRun(id, fired.body.runId);
    // The script declined to wake anyone — the cheap, normal case.
    expect(run.outcome).toBe('skip');
    expect(run.exitCode).toBe(0);
  });

  it('a wake with no live instance of the role journals a noop, not an error', async () => {
    const roleId = await makeRole('wakeful');
    const script = writeScript('crons/wake.sh', 'echo \'{"wake": true, "message": "look at JIRA-1"}\'');
    const id = await makeScriptCron('wake-cron', roleId, script);
    const fired = await req('POST', `/crons/${id}/fire`);
    const run = await waitForRun(id, fired.body.runId);
    expect(run.outcome).toBe('noop');
    expect(run.deliveredTo).toEqual([]);
  });

  it('a non-zero exit journals an error with the code and the stderr tail', async () => {
    const roleId = await makeRole('failing');
    const script = writeScript('crons/boom.sh', 'echo "boom detail" >&2\nexit 7');
    const id = await makeScriptCron('boom-cron', roleId, script);
    const fired = await req('POST', `/crons/${id}/fire`);
    const run = await waitForRun(id, fired.body.runId);
    expect(run.outcome).toBe('error');
    expect(run.exitCode).toBe(7);
    expect(String(run.outputExcerpt)).toContain('boom detail');
  });

  it('unparseable output is an error, not a silent skip', async () => {
    const roleId = await makeRole('garbage');
    const script = writeScript('crons/garbage.sh', 'echo "nothing to do today"');
    const id = await makeScriptCron('garbage-cron', roleId, script);
    const fired = await req('POST', `/crons/${id}/fire`);
    const run = await waitForRun(id, fired.body.runId);
    expect(run.outcome).toBe('error');
    expect(String(run.outputExcerpt)).toContain('not JSON');
  });

  it('a timeout kills the process group and journals an error', async () => {
    const roleId = await makeRole('slowpoke');
    // Ignores SIGTERM: only the process-group SIGKILL ends this.
    const script = writeScript('crons/stubborn.sh', 'trap "" TERM\nsleep 30');
    const id = await makeScriptCron('stubborn-cron', roleId, script, { timeoutMs: 1000 });
    const fired = await req('POST', `/crons/${id}/fire`);
    const run = await waitForRun(id, fired.body.runId);
    expect(run.outcome).toBe('error');
    expect(String(run.outputExcerpt)).toContain('timed out');
  }, 20_000);

  it('truncates the persisted excerpt to the 2000-byte budget', async () => {
    const roleId = await makeRole('noisy');
    const script = writeScript(
      'crons/noisy.sh',
      'for i in $(seq 1 500); do echo "a very wordy diagnostic line number $i" >&2; done\nexit 1',
    );
    const id = await makeScriptCron('noisy-cron', roleId, script);
    const fired = await req('POST', `/crons/${id}/fire`);
    const run = await waitForRun(id, fired.body.runId);
    expect(run.outcome).toBe('error');
    expect(Buffer.byteLength(String(run.outputExcerpt), 'utf8')).toBeLessThanOrEqual(2000);
  }, 20_000);

  it('the child gets the SWARM_OS_* env and none of the server"s secrets', async () => {
    const roleId = await makeRole('enviro');
    // The message round-trips the child's environment back to us.
    const script = writeScript(
      'crons/env.sh',
      'printf \'{"wake": false, "message": "%s|%s|%s"}\\n\' "$SWARM_OS_CRON_NAME" "${SWARM_OS_TOKEN:-ABSENT}" "${SWARM_OS_FIRE:+SET}"',
    );
    const id = await makeScriptCron('env-cron', roleId, script);
    const fired = await req('POST', `/crons/${id}/fire`);
    await waitForRun(id, fired.body.runId);
    // The excerpt keeps the stdout tail, which is where the JSON line is.
    const runs = await req('GET', `/crons/${id}/runs`);
    const excerpt = String(runs.body.runs[0].outputExcerpt);
    expect(excerpt).toContain('env-cron|ABSENT|SET');
  });

  it('refuses a script path outside the workspace and data roots', async () => {
    const roleId = await makeRole('escapist');
    const r = await req('POST', '/crons', {
      name: 'outside', roleId, schedule: NEVER, action: 'script',
      scriptPath: '/etc/passwd', interpreter: 'bash',
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_SCRIPT');
    expect(String(r.body.error)).toContain('is not under');
  });

  it('refuses a symlink inside the workspace whose target escapes it', async () => {
    const roleId = await makeRole('linky');
    const outside = path.join(stack.dataDir, '..', 'outside-script.sh');
    fs.writeFileSync(outside, 'echo \'{"wake": true}\'\n', 'utf8');
    const link = path.join(stack.workspaceRoot, 'innocent.sh');
    fs.symlinkSync(outside, link);

    const r = await req('POST', '/crons', {
      name: 'symlinked', roleId, schedule: NEVER, action: 'script',
      scriptPath: link, interpreter: 'bash',
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('is not under');
  });

  it('refuses a PATCH that turns a message cron into a script cron with a bad path', async () => {
    const roleId = await makeRole('switcher');
    const created = await req('POST', '/crons', {
      name: 'switching', roleId, schedule: NEVER, action: 'message', message: 'x',
    });
    const id = created.body.cron.id as string;
    const bad = await req('PATCH', `/crons/${id}`, {
      action: 'script', scriptPath: '/etc/passwd', interpreter: 'bash',
    });
    expect(bad.status).toBe(400);

    // …and accepts the same switch with a contained path, defaulting the budget.
    const good = await req('PATCH', `/crons/${id}`, {
      action: 'script', scriptPath: writeScript('crons/ok.sh', 'echo \'{"wake": false}\''),
      interpreter: 'bash',
    });
    expect(good.status).toBe(200);
    expect(good.body.cron.action).toBe('script');
    expect(good.body.cron.timeoutMs).toBe(60_000);
  });

  it('holds the overlap guard across the whole run: a second fire is a 409', async () => {
    const roleId = await makeRole('busy-script');
    const script = writeScript('crons/slow.sh', 'sleep 3\necho \'{"wake": false}\'');
    const id = await makeScriptCron('slow-cron', roleId, script, { timeoutMs: 10_000 });

    const first = await req('POST', `/crons/${id}/fire`);
    expect(first.status).toBe(202);
    // The child is still running — the route consults the SAME guard the tick
    // path uses and refuses rather than queueing a second concurrent run.
    const second = await req('POST', `/crons/${id}/fire`);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RUN_IN_FLIGHT');
    // GET /crons advertises it too, so the UI can grey out RUN NOW.
    const list = await req('GET', `/crons/${id}`);
    expect(list.body.cron.running).toBe(true);

    const run = await waitForRun(id, first.body.runId, 15_000);
    expect(run.outcome).toBe('skip');
    // Only the one run was journalled: the refused call recorded nothing.
    const runs = await req('GET', `/crons/${id}/runs`);
    expect(runs.body.runs).toHaveLength(1);
  }, 30_000);

  it('a tick landing on a running script journals an overlap', async () => {
    const roleId = await makeRole('overlapping');
    const script = writeScript('crons/slow2.sh', 'sleep 2\necho \'{"wake": false}\'');
    const id = await makeScriptCron('overlap-cron', roleId, script, { timeoutMs: 10_000 });

    const first = await req('POST', `/crons/${id}/fire`);
    // Fire the SCHEDULER directly, the way a cadence tick does — it bypasses the
    // route's 409 and must therefore record the skipped tick itself.
    const overlapped = stack.cronScheduler.fire(id, 'tick');
    expect(overlapped?.run?.outcome).toBe('overlap');

    await waitForRun(id, first.body.runId, 15_000);
    const runs = await req('GET', `/crons/${id}/runs`);
    expect(runs.body.runs.map((r: { outcome: string }) => r.outcome).sort()).toEqual([
      'overlap',
      'skip',
    ]);
  }, 30_000);

  it('shutdown kills an in-flight script and journals it as an error', async () => {
    const roleId = await makeRole('doomed');
    const script = writeScript('crons/long.sh', 'trap "" TERM\nsleep 30');
    const id = await makeScriptCron('long-cron', roleId, script, { timeoutMs: 60_000 });

    const fired = await req('POST', `/crons/${id}/fire`);
    expect(fired.status).toBe(202);
    // Let the child actually start before pulling the rug.
    await new Promise((r) => setTimeout(r, 300));
    expect(stack.cronRunner.inFlightCount).toBe(1);

    // This is what index.ts calls, synchronously, just before db.close().
    stack.cronScheduler.stop();
    expect(stack.cronRunner.inFlightCount).toBe(0);

    // The row is already there — written by stop() itself, not by the child's
    // (much later) exit callback, which would land after the DB is closed.
    const runs = await req('GET', `/crons/${id}/runs`);
    const run = runs.body.runs.find((r: { id: string }) => r.id === fired.body.runId);
    expect(run.outcome).toBe('error');
    expect(String(run.outputExcerpt)).toContain('shutdown');

    // …and the dying child does not write a second row a moment later.
    await new Promise((r) => setTimeout(r, 500));
    expect((await req('GET', `/crons/${id}/runs`)).body.runs).toHaveLength(1);
  }, 30_000);
});

describe('crons: migration of the legacy per-role cadence', () => {
  /** Write a legacy cadence straight into the roles table (the store won't). */
  function seedLegacyRole(label: string, schedule: string, message: string): string {
    const roles = new RoleStore(stack.db);
    const role = roles.create({ label });
    stack.db.db
      .prepare('UPDATE roles SET schedule = ?, schedule_message = ? WHERE id = ?')
      .run(schedule, message, role.id);
    return role.id;
  }

  function readRoleRow(id: string): { schedule: string | null; schedule_message: string | null; updated_at: string } {
    return stack.db.db
      .prepare('SELECT schedule, schedule_message, updated_at FROM roles WHERE id = ?')
      .get(id) as { schedule: string | null; schedule_message: string | null; updated_at: string };
  }

  it('moves a role cadence into a cron and clears the columns without touching updated_at', () => {
    const roleId = seedLegacyRole('Market Analysis', '0 6,12,20 * * *', 'run cycle {{fire}}');
    const before = readRoleRow(roleId).updated_at;

    const migrated = new CronStore(stack.db);

    const cron = migrated.get(`cron_role_${roleId}`);
    expect(cron).not.toBeNull();
    expect(cron?.name).toBe('market-analysis-cadence');
    expect(cron?.roleId).toBe(roleId);
    expect(cron?.schedule).toBe('0 6,12,20 * * *');
    expect(cron?.action).toBe('message');
    expect(cron?.message).toBe('run cycle {{fire}}');
    expect(cron?.paused).toBe(false);

    const after = readRoleRow(roleId);
    expect(after.schedule).toBeNull();
    expect(after.schedule_message).toBeNull();
    // A migration is not an operator edit: the raw UPDATE leaves updated_at be.
    expect(after.updated_at).toBe(before);
  });

  it('is replayable — a second store (or a crash before the UPDATE) creates no duplicate', () => {
    const roleId = seedLegacyRole('replayable', '*/5 * * * *', 'tick');
    new CronStore(stack.db);
    // Simulate a crash between the INSERT and the UPDATE: the cron exists and
    // the role still carries its cadence when the next boot comes around.
    stack.db.db
      .prepare('UPDATE roles SET schedule = ?, schedule_message = ? WHERE id = ?')
      .run('*/5 * * * *', 'tick', roleId);

    const second = new CronStore(stack.db);
    const forRole = second.listByRole(roleId);
    expect(forRole).toHaveLength(1);
    expect(forRole[0].id).toBe(`cron_role_${roleId}`);
    expect(readRoleRow(roleId).schedule).toBeNull();
  });

  it('resolves a name collision between two roles sharing a label', () => {
    const a = seedLegacyRole('daily', '0 6 * * *', 'a');
    const b = seedLegacyRole('daily', '0 7 * * *', 'b');

    const migrated = new CronStore(stack.db);
    const nameA = migrated.get(`cron_role_${a}`)?.name;
    const nameB = migrated.get(`cron_role_${b}`)?.name;
    expect(nameA).toBe('daily-cadence');
    expect(nameB).toBe(`daily-cadence-${b}`);
    expect(nameA).not.toBe(nameB);
    // Both survived — a collision must never silently drop a cadence.
    expect(migrated.list().filter((c) => c.id.startsWith('cron_role_'))).toHaveLength(2);
  });

  it('cannot be re-fed: the role store refuses to write a cadence back', () => {
    const roles = new RoleStore(stack.db);
    const role = roles.create({
      label: 'neutralised',
      schedule: '*/5 * * * *',
      scheduleMessage: 'tick',
    });
    expect(role.schedule).toBeNull();
    expect(role.scheduleMessage).toBeNull();

    const patched = roles.update(role.id, { schedule: '0 * * * *', scheduleMessage: 'x' });
    expect(patched?.schedule).toBeNull();
    expect(readRoleRow(role.id).schedule).toBeNull();

    // …so a later boot has nothing left to migrate.
    const after = new CronStore(stack.db);
    expect(after.listByRole(role.id)).toHaveLength(0);
  });
});
