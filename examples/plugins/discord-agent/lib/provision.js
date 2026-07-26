// provision.js — Role + Team lifecycle for the Discord agent.
//
// `ensureRole` (idempotent): the marker connector `discord-agent` carries no
//   config schema, so the model + preamble + bypass permission mode ride on an
//   auto-provisioned Role (RoleInit). Safe to call before the boot auto-resume.
// `ensureTeam` (lazy, serialised): called on an inbound message when there is no
//   active binding. Creates the workDir, then the team; the host wires
//   `subscribeOrch` at create/resume/retro-wire (no polling / grace window).
//   Terminal predecessors are destroyed; repeated early lead deaths trip a
//   backoff + a critical notify (never an automatic model mutation).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { LEAD_PREAMBLE, LEAD_PROMPT, PREAMBLE_VERSION } from './preamble.js';

const ROLE_LABEL = 'Discord Agent';
const CONNECTOR_TYPE = 'discord-agent';

/** Statuses where the team is (or is becoming) live — do NOT recreate. */
const ALIVE_STATUSES = new Set(['starting', 'running', 'stopping']);

/** A lead that dies faster than this counts as an "early death". */
const EARLY_DEATH_MS = 30_000;
/** Consecutive early deaths before we stop recreating and back off. */
const MAX_EARLY_DEATHS = 3;
/** How long to suspend recreation once tripped. */
const BACKOFF_MS = 5 * 60_000;

function workspaceRoot() {
  return process.env.SWARM_OS_WORKSPACE_ROOT || '/workspace';
}

/**
 * Ensure the `Discord Agent` role exists and matches the current model +
 * preamble version. Returns the role id.
 *
 * @param {import('../index.js').Runtime} rt
 * @returns {string} roleId
 */
export function ensureRole(rt) {
  const { api } = rt;
  const kv = api.storage.kv;
  const existingId = kv.get('roleId');
  if (existingId) {
    const role = api.roles.get(existingId);
    if (role) {
      const versionChanged = kv.get('preambleVersion') !== String(PREAMBLE_VERSION);
      const modelChanged = role.defaultModel !== rt.cfg.leadModel;
      if (versionChanged || modelChanged) {
        api.roles.update(existingId, {
          leadPreamble: LEAD_PREAMBLE,
          defaultModel: rt.cfg.leadModel,
        });
        kv.set('preambleVersion', String(PREAMBLE_VERSION));
        rt.log.info(
          { event: 'discord-agent.role_updated', roleId: existingId, model: rt.cfg.leadModel },
          'discord-agent role updated',
        );
      }
      return existingId;
    }
    // Stored id no longer resolves — fall through and recreate.
  }
  const role = api.roles.create({
    label: ROLE_LABEL,
    leadPreamble: LEAD_PREAMBLE,
    leadPrompt: LEAD_PROMPT,
    defaultModel: rt.cfg.leadModel,
    defaultPermissionMode: 'bypassPermissions',
    connectors: [{ type: CONNECTOR_TYPE, config: {} }],
  });
  kv.set('roleId', role.id);
  kv.set('preambleVersion', String(PREAMBLE_VERSION));
  rt.log.info(
    { event: 'discord-agent.role_created', roleId: role.id, model: rt.cfg.leadModel },
    'discord-agent role created',
  );
  return role.id;
}

/**
 * Lazily ensure a live team exists for the channel, serialised behind a single
 * promise so concurrent inbound messages never spawn duplicates.
 *
 * @param {import('../index.js').Runtime} rt
 * @returns {Promise<void>}
 */
export function ensureTeam(rt) {
  if (rt.ensureTeamPromise) return rt.ensureTeamPromise;
  rt.ensureTeamPromise = doEnsureTeam(rt).finally(() => {
    rt.ensureTeamPromise = null;
  });
  return rt.ensureTeamPromise;
}

/** @param {import('../index.js').Runtime} rt */
async function doEnsureTeam(rt) {
  const { api } = rt;
  const kv = api.storage.kv;
  const now = Date.now();

  // Backoff gate: after repeated early lead deaths we stop recreating for a while.
  const backoffUntil = Number(kv.get('backoffUntil') || '0');
  if (backoffUntil) {
    if (now < backoffUntil) {
      rt.log.warn(
        { event: 'discord-agent.ensure_team_backoff', until: backoffUntil },
        'discord-agent recreation suspended (early-death backoff)',
      );
      return;
    }
    // Backoff elapsed — clear it and give the team another chance.
    kv.delete('backoffUntil');
    kv.set('earlyDeathCount', '0');
  }

  const roleId = kv.get('roleId') || ensureRole(rt);

  const existingTeamId = kv.get('teamId');
  if (existingTeamId) {
    const team = api.teams.get(existingTeamId);
    if (team && ALIVE_STATUSES.has(team.status)) {
      // Alive (or becoming/leaving live). Wiring is imminent via the host's
      // create/resume/retro-wire path — do not create a second team.
      return;
    }
    if (team) {
      // Terminal ('stopped' | 'failed'): measure the lead's lifetime for the
      // early-death detector, then destroy the husk before recreating.
      const createdAt = Number(kv.get('teamCreatedAt') || '0');
      const lifetime = createdAt ? now - createdAt : Number.POSITIVE_INFINITY;
      let count = Number(kv.get('earlyDeathCount') || '0');
      count = lifetime < EARLY_DEATH_MS ? count + 1 : 0;
      kv.set('earlyDeathCount', String(count));
      if (count >= MAX_EARLY_DEATHS) {
        const until = now + BACKOFF_MS;
        kv.set('backoffUntil', String(until));
        void api.notify
          .custom({
            title: 'Agent Discord instable',
            message: `Le lead est mort ${count} fois de suite en moins de ${
              EARLY_DEATH_MS / 1000
            } s (dernier statut: ${team.status}). Recreation suspendue ${
              BACKOFF_MS / 60000
            } min. Verifier l'authentification Claude, le modele (${rt.cfg.leadModel}) ou la memoire du conteneur.`,
            level: 'critical',
          })
          .catch(() => {});
        rt.log.error(
          { event: 'discord-agent.early_death_backoff', count, until },
          'discord-agent lead early-death backoff engaged',
        );
        return;
      }
      try {
        await api.teams.destroy(existingTeamId, 'discord-agent recreate');
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.destroy_failed', teamId: existingTeamId, error: String(err) },
          'discord-agent could not destroy terminal team',
        );
      }
    }
  }

  // The workDir must exist before teams.create (the host realpaths the cwd).
  const dir = path.join(workspaceRoot(), rt.cfg.workDir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    rt.log.warn(
      { event: 'discord-agent.mkdir_failed', dir, error: String(err) },
      'discord-agent could not create workDir',
    );
  }

  const created = await api.teams.create({
    name: 'discord-agent',
    roleId,
    cwd: rt.cfg.workDir,
  });
  kv.set('teamId', created.id);
  kv.set('teamCreatedAt', String(now));
  rt.log.info(
    { event: 'discord-agent.team_created', teamId: created.id },
    'discord-agent team created',
  );
}
