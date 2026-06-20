import { describe, it, expect, afterEach } from 'vitest';
import { RoleScheduler, isValidCron } from './index.js';
import { Mailbox } from '../orchestrator/mailbox.js';
import type { Session } from '../orchestrator/session.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Role, RoleStore } from '../roles/index.js';
import type { Spawner } from '../spawner/index.js';

/**
 * The scheduler only touches a thin slice of each collaborator:
 *  - RoleStore: get(id), list()
 *  - Spawner: listActive()
 *  - Orchestrator: id, roleId, lead, mailbox, getSession()
 *  - Session: id, status, idleSince, notifySignal()
 * so we fake exactly that surface rather than standing up the real classes.
 */

const FIRE = new Date('2026-06-18T20:00:00.000Z');
const DEFAULTS = { maxMessageSizeBytes: 4096, idleThresholdMs: 50 };

function fakeSession(id: string): Session {
  // idleSince=0 (epoch) → always idle → exercises the notifySignal path.
  return { id, status: 'running', idleSince: 0, notifySignal: () => {} } as unknown as Session;
}

interface FakeOrch {
  orch: Orchestrator;
  mailbox: Mailbox;
}

function fakeOrch(opts: { id: string; roleId: string | null; lead: Session | null }): FakeOrch {
  const mailbox = new Mailbox({ maxSize: 100 });
  const sessions = new Map<string, Session>();
  if (opts.lead) sessions.set(opts.lead.id, opts.lead);
  const orch = {
    id: opts.id,
    roleId: opts.roleId,
    lead: opts.lead,
    mailbox,
    getSession: (sid: string) => sessions.get(sid),
  } as unknown as Orchestrator;
  return { orch, mailbox };
}

function makeRole(p: Partial<Role> & { id: string; label: string }): Role {
  return {
    leadPrompt: null,
    leadPreamble: null,
    workerPreamble: null,
    workerCount: null,
    defaultModel: null,
    defaultEffort: null,
    defaultPermissionMode: null,
    connectors: [],
    schedule: null,
    scheduleMessage: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...p,
  } as Role;
}

function makeDeps(roles: Role[], orchs: Orchestrator[]) {
  const byId = new Map(roles.map((r) => [r.id, r] as const));
  const roleStore = {
    get: (id: string) => byId.get(id) ?? null,
    list: () => roles,
  } as unknown as RoleStore;
  const spawner = { listActive: () => orchs } as unknown as Spawner;
  return { roleStore, spawner };
}

let live: RoleScheduler | null = null;
afterEach(() => {
  live?.stop();
  live = null;
});

describe('isValidCron', () => {
  it('accepts a 5-field expression', () => {
    expect(isValidCron('0 6,12,20 * * *')).toBe(true);
    expect(isValidCron('*/2 * * * *')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 99 99 99 99')).toBe(false);
  });
});

describe('RoleScheduler.fireRole', () => {
  it('delivers the rendered message to the lead of every live instance of the role', () => {
    const role = makeRole({
      id: 'rA',
      label: 'analysis',
      schedule: '0 6,12,20 * * *',
      scheduleMessage: 'run cycle cycle_window_id={{fire}}',
    });
    const lead1 = fakeSession('lead1');
    const lead2 = fakeSession('lead2');
    const o1 = fakeOrch({ id: 'o1', roleId: 'rA', lead: lead1 });
    const o2 = fakeOrch({ id: 'o2', roleId: 'rA', lead: lead2 });
    const other = fakeOrch({ id: 'o3', roleId: 'rB', lead: fakeSession('leadX') }); // different role
    const { roleStore, spawner } = makeDeps([role], [o1.orch, o2.orch, other.orch]);

    const sched = new RoleScheduler({
      roleStore,
      spawner,
      defaults: DEFAULTS,
      timezone: 'UTC',
      enabled: true,
      now: () => FIRE,
    });
    sched.fireRole('rA');

    const m1 = o1.mailbox.peek('lead1');
    const m2 = o2.mailbox.peek('lead2');
    expect(m1).toHaveLength(1);
    expect(m1[0].content).toBe('run cycle cycle_window_id=2026-06-18T20:00Z');
    expect(m1[0].from).toBe('system');
    expect(m2).toHaveLength(1);
    // The orchestrator of a different role is untouched.
    expect(other.mailbox.peek('leadX')).toHaveLength(0);
  });

  it('skips an instance whose lead is absent, without throwing', () => {
    const role = makeRole({
      id: 'rA',
      label: 'analysis',
      schedule: '0 6,12,20 * * *',
      scheduleMessage: 'tick {{fire}}',
    });
    const withLead = fakeOrch({ id: 'o1', roleId: 'rA', lead: fakeSession('lead1') });
    const noLead = fakeOrch({ id: 'o2', roleId: 'rA', lead: null });
    const { roleStore, spawner } = makeDeps([role], [noLead.orch, withLead.orch]);
    const sched = new RoleScheduler({
      roleStore, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    expect(() => sched.fireRole('rA')).not.toThrow();
    expect(withLead.mailbox.peek('lead1')).toHaveLength(1);
  });

  it('is a no-op when no live instance of the role exists', () => {
    const role = makeRole({ id: 'rA', label: 'analysis', schedule: '* * * * *', scheduleMessage: 'x' });
    const { roleStore, spawner } = makeDeps([role], []);
    const sched = new RoleScheduler({
      roleStore, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    expect(() => sched.fireRole('rA')).not.toThrow();
  });

  it('does nothing for a role without a schedule', () => {
    const role = makeRole({ id: 'rB', label: 'plain' });
    const o = fakeOrch({ id: 'o1', roleId: 'rB', lead: fakeSession('lead1') });
    const { roleStore, spawner } = makeDeps([role], [o.orch]);
    const sched = new RoleScheduler({
      roleStore, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true, now: () => FIRE,
    });
    sched.fireRole('rB');
    expect(o.mailbox.peek('lead1')).toHaveLength(0);
  });
});

describe('RoleScheduler.reload / start / stop', () => {
  it('arms one cron per scheduled role and ignores the rest', () => {
    const roles = [
      makeRole({ id: 'rA', label: 'analysis', schedule: '0 6,12,20 * * *', scheduleMessage: 'x' }),
      makeRole({ id: 'rB', label: 'plain' }), // no schedule
      makeRole({ id: 'rC', label: 'freq', schedule: '*/5 * * * *', scheduleMessage: 'y' }),
    ];
    const { roleStore, spawner } = makeDeps(roles, []);
    live = new RoleScheduler({
      roleStore, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true,
    });
    live.start();
    expect(live.armedCount).toBe(2);
    live.stop();
    expect(live.armedCount).toBe(0);
  });

  it('does not arm anything when disabled', () => {
    const roles = [makeRole({ id: 'rA', label: 'a', schedule: '* * * * *', scheduleMessage: 'x' })];
    const { roleStore, spawner } = makeDeps(roles, []);
    live = new RoleScheduler({
      roleStore, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: false,
    });
    live.start();
    expect(live.armedCount).toBe(0);
  });

  it('reload() re-arms after the role set changes', () => {
    const roles: Role[] = [makeRole({ id: 'rA', label: 'a', schedule: '* * * * *', scheduleMessage: 'x' })];
    const byId = new Map(roles.map((r) => [r.id, r] as const));
    const roleStore = {
      get: (id: string) => byId.get(id) ?? null,
      list: () => roles,
    } as unknown as RoleStore;
    const spawner = { listActive: () => [] } as unknown as Spawner;
    live = new RoleScheduler({ roleStore, spawner, defaults: DEFAULTS, timezone: 'UTC', enabled: true });
    live.start();
    expect(live.armedCount).toBe(1);
    // Add a second scheduled role, then reload.
    const rB = makeRole({ id: 'rB', label: 'b', schedule: '*/10 * * * *', scheduleMessage: 'y' });
    roles.push(rB);
    byId.set('rB', rB);
    live.reload();
    expect(live.armedCount).toBe(2);
  });
});
