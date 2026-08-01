import { Router, type Request, type Response } from 'express';
import type {
  RoleStore,
  Connector,
  Role,
  RoleInit,
  RolePatch,
  RoleApprovalSettings,
} from '../../modules/roles/index.js';
import { isDiscordConnector } from '../../modules/roles/index.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import { isValidCron } from '../../modules/schedule/index.js';
import {
  PASSWORD_SENTINEL,
  redactConfigForRead,
  mergeConfigForWrite,
  validateConfig,
  type PluginConfigSchema,
} from '../../modules/plugins/config-schema.js';
import type { ConnectorTypeInfo } from '../../modules/plugins/connector-registry.js';

/**
 * Narrow view of the `ConnectorRegistry` the roles layer needs (J4): which
 * connector types have a provider, their declared schema (for form generation +
 * password masking), and the full list for `GET /connector-types`. Kept as an
 * interface so the roles route stays decoupled from the concrete registry class.
 */
export interface ConnectorTypeLookup {
  has(type: string): boolean;
  schemaFor(type: string): PluginConfigSchema | null;
  types(): ConnectorTypeInfo[];
}

/**
 * Narrow view of the `ProviderRegistry` this route needs: "is this a provider id
 * we have an adapter for?", plus the list to hand back on a rejection so the
 * caller learns what it COULD have asked for.
 *
 * Kept as an interface (like `ConnectorTypeLookup`) so the roles route does not
 * depend on the concrete registry class, and optional at construction so tests
 * can mount the router without one.
 */
export interface ProviderIdLookup {
  has(id: string): boolean;
  types(): Array<{ id: string }>;
}

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMS: ReadonlySet<string> = new Set([
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

interface ConnectorBody {
  type?: unknown;
  webhookUrl?: unknown;
  channelId?: unknown;
  botToken?: unknown;
}

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
// Discord bot tokens encode the application id in base64 + a timestamp +
// HMAC, separated by dots; the canonical length is ~60–80 chars. We
// keep the bound generous because Discord has tweaked the format twice
// in five years and might do it again.
const DISCORD_BOT_TOKEN_MAX = 256;

interface RoleBody {
  label?: unknown;
  leadPrompt?: unknown;
  leadPreamble?: unknown;
  workerPreamble?: unknown;
  workerCount?: unknown;
  defaultModel?: unknown;
  defaultEffort?: unknown;
  defaultPermissionMode?: unknown;
  defaultProvider?: unknown;
  connectors?: unknown;
  schedule?: unknown;
  scheduleMessage?: unknown;
  approval?: unknown;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/**
 * Allow `null` or omitted (= unchanged) for nullable text fields on patch,
 * non-empty string for create. Returns `{ ok: true, value }` where value is
 * the normalized string-or-null, or `{ ok: false, error }`.
 */
function parseNullableString(
  x: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'string') return { ok: false, error: `${field} must be a string or null` };
  return { ok: true, value: x.length === 0 ? null : x };
}

/**
 * A 5/6-field cron expression, or null/'' (= no cadence). Validated with the
 * same croner parser the scheduler uses, so the UI can't store a pattern the
 * scheduler would later reject at reload.
 */
function parseCron(
  x: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'string') return { ok: false, error: 'schedule must be a string or null' };
  const trimmed = x.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!isValidCron(trimmed)) {
    return { ok: false, error: 'schedule must be a valid cron expression (e.g. "0 6,12,20 * * *")' };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate the OPTIONAL per-role approval override (P5). `null`/omitted → clear
 * the override (= role reverts to the built-in default). An object may carry any
 * of `enabled` (bool), `armingModes` (array of valid permission modes), and
 * `discordNotify` (bool). An object that ends up carrying no recognised field
 * normalizes to `null` (no override). Unknown/mistyped fields are rejected so a
 * typo surfaces at the form rather than silently doing nothing.
 */
function parseApprovalBody(
  x: unknown,
): { ok: true; value: RoleApprovalSettings | null } | { ok: false; error: string } {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'object' || Array.isArray(x)) {
    return { ok: false, error: 'approval must be an object or null' };
  }
  const obj = x as Record<string, unknown>;
  const out: RoleApprovalSettings = {};
  if (obj.enabled !== undefined && obj.enabled !== null) {
    if (typeof obj.enabled !== 'boolean') {
      return { ok: false, error: 'approval.enabled must be a boolean' };
    }
    out.enabled = obj.enabled;
  }
  if (obj.armingModes !== undefined && obj.armingModes !== null) {
    if (!Array.isArray(obj.armingModes)) {
      return { ok: false, error: 'approval.armingModes must be an array of permission modes' };
    }
    const modes: string[] = [];
    for (const m of obj.armingModes) {
      if (typeof m !== 'string' || !VALID_PERMS.has(m)) {
        return {
          ok: false,
          error:
            'approval.armingModes must be permission modes (auto|acceptEdits|bypassPermissions|default|dontAsk|plan)',
        };
      }
      if (!modes.includes(m)) modes.push(m);
    }
    out.armingModes = modes;
  }
  if (obj.discordNotify !== undefined && obj.discordNotify !== null) {
    if (typeof obj.discordNotify !== 'boolean') {
      return { ok: false, error: 'approval.discordNotify must be a boolean' };
    }
    out.discordNotify = obj.discordNotify;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null };
}

function parseWorkerCount(
  x: unknown,
  cap: number,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'number' || !Number.isInteger(x)) {
    return { ok: false, error: 'workerCount must be an integer or null' };
  }
  if (x < 0 || x > cap) {
    return { ok: false, error: `workerCount must be between 0 and ${cap}` };
  }
  return { ok: true, value: x };
}

/** Parse result — `status` lets a caller map an unknown type to 422 vs 400. */
type ParseConnectorsResult =
  | { ok: true; value: Connector[] }
  | { ok: false; error: string; status?: number; code?: string };

interface ParseConnectorsOpts {
  /** Registry of provider-backed connector types (J4). Absent → discord-only. */
  registry?: ConnectorTypeLookup;
  /** Prior connectors — used to preserve password fields left as the sentinel. */
  previous?: Connector[];
}

/** Validate + preserve the flat built-in Discord connector at index `i`. */
function parseDiscordConnector(
  c: ConnectorBody,
  i: number,
  previous?: Connector[],
): { ok: true; value: Connector } | { ok: false; error: string } {
  let webhookUrl: string | undefined;
  if (c.webhookUrl != null && c.webhookUrl !== '') {
    if (!isNonEmptyString(c.webhookUrl)) {
      return { ok: false, error: `connectors[${i}].webhookUrl must be a non-empty string` };
    }
    if (!/^https?:\/\//i.test(c.webhookUrl)) {
      return { ok: false, error: `connectors[${i}].webhookUrl must be a http(s) URL` };
    }
    webhookUrl = c.webhookUrl;
  }
  let channelId: string | undefined;
  if (c.channelId != null && c.channelId !== '') {
    if (typeof c.channelId !== 'string') {
      return { ok: false, error: `connectors[${i}].channelId must be a string` };
    }
    if (!DISCORD_SNOWFLAKE_RE.test(c.channelId)) {
      return {
        ok: false,
        error: `connectors[${i}].channelId must be a Discord snowflake (17–20 digits)`,
      };
    }
    channelId = c.channelId;
  }
  // Password preservation: a botToken echoed back as the masking sentinel means
  // the operator didn't retype it — keep the previously stored token (red-team I-4).
  let botToken: string | undefined;
  const prevDiscord = previous?.find(isDiscordConnector);
  if (c.botToken === PASSWORD_SENTINEL) {
    botToken = prevDiscord?.botToken;
  } else if (c.botToken != null && c.botToken !== '') {
    if (typeof c.botToken !== 'string') {
      return { ok: false, error: `connectors[${i}].botToken must be a string` };
    }
    if (c.botToken.length > DISCORD_BOT_TOKEN_MAX) {
      return { ok: false, error: `connectors[${i}].botToken is too long` };
    }
    botToken = c.botToken;
  }
  // The bot needs a channel to listen on — without one the token is useless.
  if (botToken && !channelId) {
    return {
      ok: false,
      error: `connectors[${i}].botToken requires connectors[${i}].channelId to be set`,
    };
  }
  // Empty connector — neither outbound webhook nor inbound bot — has no effect
  // and is almost certainly a UI mistake. Reject loudly.
  if (!webhookUrl && !(botToken && channelId)) {
    return {
      ok: false,
      error: `connectors[${i}] must set webhookUrl, or both botToken and channelId`,
    };
  }
  return {
    ok: true,
    value: {
      type: 'discord',
      ...(webhookUrl ? { webhookUrl } : {}),
      ...(channelId ? { channelId } : {}),
      ...(botToken ? { botToken } : {}),
    },
  };
}

function parseConnectors(x: unknown, opts: ParseConnectorsOpts = {}): ParseConnectorsResult {
  if (x == null) return { ok: true, value: [] };
  if (!Array.isArray(x)) return { ok: false, error: 'connectors must be an array' };
  const out: Connector[] = [];
  for (let i = 0; i < x.length; i++) {
    const c = x[i] as ConnectorBody;
    if (!c || typeof c !== 'object') {
      return { ok: false, error: `connectors[${i}] must be an object` };
    }
    if (typeof c.type !== 'string' || c.type.length === 0) {
      return { ok: false, error: `connectors[${i}].type must be a non-empty string` };
    }
    if (c.type === 'discord') {
      const r = parseDiscordConnector(c, i, opts.previous);
      if (!r.ok) return r;
      out.push(r.value);
      continue;
    }
    // Generic (plugin-provided) connector type — needs a registered provider.
    if (!opts.registry || !opts.registry.has(c.type)) {
      return {
        ok: false,
        status: 422,
        code: 'UNKNOWN_CONNECTOR_TYPE',
        error: `connectors[${i}].type '${c.type}' has no registered provider`,
      };
    }
    const rawConfig = (c as { config?: unknown }).config;
    if (rawConfig != null && (typeof rawConfig !== 'object' || Array.isArray(rawConfig))) {
      return { ok: false, error: `connectors[${i}].config must be an object` };
    }
    const incoming = (rawConfig ?? {}) as Record<string, unknown>;
    const schema = opts.registry.schemaFor(c.type);
    if (!schema) {
      // No schema declared — store the config verbatim (no fields to validate).
      out.push({ type: c.type, config: incoming });
      continue;
    }
    const prevGeneric = opts.previous?.find(
      (p): p is Extract<Connector, { config: Record<string, unknown> }> =>
        !isDiscordConnector(p) && p.type === c.type,
    );
    const merged = mergeConfigForWrite(schema, incoming, prevGeneric?.config ?? {});
    const validated = validateConfig(schema, merged);
    if (!validated.ok) {
      return { ok: false, error: `connectors[${i}].config: ${validated.error}` };
    }
    out.push({ type: c.type, config: validated.value });
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Password masking on read (red-team I-4)
// ---------------------------------------------------------------------------

/** Replace connector password fields with the masking sentinel for a read. */
function maskConnector(c: Connector, registry?: ConnectorTypeLookup): Connector {
  if (isDiscordConnector(c)) {
    // botToken is the only password field on the built-in discord connector.
    return c.botToken ? { ...c, botToken: PASSWORD_SENTINEL } : { ...c };
  }
  const schema = registry?.schemaFor(c.type) ?? null;
  return { type: c.type, config: redactConfigForRead(schema, c.config) };
}

/** Serialise a role for a response, masking every connector's password fields. */
function maskRole(role: Role, registry?: ConnectorTypeLookup): Role {
  return { ...role, connectors: role.connectors.map((c) => maskConnector(c, registry)) };
}

export function createRolesRouter(
  store: RoleStore,
  config: Config,
  /**
   * Invoked after any successful role create/update/delete so the in-process
   * RoleScheduler can re-arm its crons (there is no role-change event bus, so
   * the mutating route is the re-arm trigger). Optional — tests omit it.
   */
  onRolesChanged?: () => void,
  /**
   * J4 — connector-type registry: gates unknown connector types (422) and drives
   * password masking + form generation. Optional (discord stays built-in either
   * way; without it, non-discord types are rejected as unknown).
   */
  connectorRegistry?: ConnectorTypeLookup,
  /**
   * Provider registry — gates `defaultProvider` (400 `UNKNOWN_PROVIDER`) so a
   * typo is reported by the form that made it. Optional: without it the id is
   * stored unchecked, exactly as before, and `POST /orchestrators` catches it at
   * team-creation time.
   */
  providerRegistry?: ProviderIdLookup,
): Router {
  const router = Router();

  /**
   * Validate a role's `defaultProvider` against the registry.
   *
   * WHY here and not only at team creation: `POST /orchestrators` does validate
   * (400 `UNKNOWN_PROVIDER`), but that is the wrong place to LEARN about a typo —
   * the operator is then in a different dialog, days later, and the error names a
   * provider they cannot see in the form they are looking at. `defaultEffort` and
   * `defaultPermissionMode` have always been validated here for the same reason;
   * `defaultProvider` addresses an adapter we either have or do not, so it
   * belongs with them.
   *
   * The MODEL string next to it is still NOT validated, and that is deliberate
   * and documented product behaviour: model ids ship far faster than our
   * releases, and rejecting a valid one is a worse failure than accepting a wrong
   * one (which the CLI reports on its own).
   *
   * `null` (= inherit the instance default) always passes. So does any id when no
   * registry was supplied.
   *
   * Accepted cost: a role whose provider came from a plugin that is later
   * disabled can no longer be PATCHED with that provider still in the body — the
   * caller has to pick an available one or clear the field. Reading and using the
   * role are unaffected (nothing re-validates on read, and team creation resolves
   * its own fallback), and a plugin-less id that cannot create a team is worth
   * surfacing rather than storing.
   */
  function checkProvider(value: string | null): { ok: true } | { ok: false; body: object } {
    if (value == null || !providerRegistry || providerRegistry.has(value)) return { ok: true };
    return {
      ok: false,
      body: {
        error: `unknown provider '${value}'`,
        code: 'UNKNOWN_PROVIDER',
        known: providerRegistry.types().map((t) => t.id),
      },
    };
  }

  router.get('/roles', (_req: Request, res: Response) => {
    res.json({ roles: store.list().map((r) => maskRole(r, connectorRegistry)) });
  });

  // J4 — connector types available for role connectors (built-in `discord` +
  // any plugin-provided types). Drives the generic connector form in the UI.
  router.get('/connector-types', (_req: Request, res: Response) => {
    res.json({ connectorTypes: connectorRegistry?.types() ?? [] });
  });

  router.post('/roles', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RoleBody;
    if (!isNonEmptyString(body.label)) {
      res.status(400).json({ error: 'label is required and must be a non-empty string' });
      return;
    }

    const lp = parseNullableString(body.leadPrompt, 'leadPrompt');
    if (!lp.ok) return res.status(400).json({ error: lp.error });
    const lpre = parseNullableString(body.leadPreamble, 'leadPreamble');
    if (!lpre.ok) return res.status(400).json({ error: lpre.error });
    const wpre = parseNullableString(body.workerPreamble, 'workerPreamble');
    if (!wpre.ok) return res.status(400).json({ error: wpre.error });
    const dm = parseNullableString(body.defaultModel, 'defaultModel');
    if (!dm.ok) return res.status(400).json({ error: dm.error });
    // Nullable string, exactly like defaultModel: NULL = inherit the instance
    // default. Unlike defaultModel, the id IS checked against the registry —
    // see `checkProvider`.
    const dp = parseNullableString(body.defaultProvider, 'defaultProvider');
    if (!dp.ok) return res.status(400).json({ error: dp.error });
    const dpKnown = checkProvider(dp.value);
    if (!dpKnown.ok) return res.status(400).json(dpKnown.body);

    let effort: EffortLevel | null = null;
    if (body.defaultEffort != null) {
      if (typeof body.defaultEffort !== 'string' || !VALID_EFFORTS.has(body.defaultEffort)) {
        return res
          .status(400)
          .json({ error: 'defaultEffort must be one of low|medium|high|xhigh|max' });
      }
      effort = body.defaultEffort as EffortLevel;
    }
    let perm: PermissionMode | null = null;
    if (body.defaultPermissionMode != null) {
      if (
        typeof body.defaultPermissionMode !== 'string' ||
        !VALID_PERMS.has(body.defaultPermissionMode)
      ) {
        return res.status(400).json({ error: 'defaultPermissionMode invalid' });
      }
      perm = body.defaultPermissionMode as PermissionMode;
    }

    const wc = parseWorkerCount(body.workerCount, config.maxWorkersPerOrch);
    if (!wc.ok) return res.status(400).json({ error: wc.error });
    const cn = parseConnectors(body.connectors, { registry: connectorRegistry });
    if (!cn.ok) {
      return res
        .status(cn.status ?? 400)
        .json({ error: cn.error, ...(cn.code ? { code: cn.code } : {}) });
    }
    const sch = parseCron(body.schedule);
    if (!sch.ok) return res.status(400).json({ error: sch.error });
    const smsg = parseNullableString(body.scheduleMessage, 'scheduleMessage');
    if (!smsg.ok) return res.status(400).json({ error: smsg.error });
    if (sch.value != null && smsg.value == null) {
      return res
        .status(400)
        .json({ error: 'scheduleMessage is required when schedule is set' });
    }
    const appr = parseApprovalBody(body.approval);
    if (!appr.ok) return res.status(400).json({ error: appr.error });

    const init: RoleInit = {
      label: body.label,
      leadPrompt: lp.value,
      leadPreamble: lpre.value,
      workerPreamble: wpre.value,
      workerCount: wc.value,
      defaultModel: dm.value,
      defaultEffort: effort,
      defaultPermissionMode: perm,
      defaultProvider: dp.value,
      connectors: cn.value,
      schedule: sch.value,
      scheduleMessage: smsg.value,
      approval: appr.value,
    };
    const role = store.create(init);
    onRolesChanged?.();
    res.status(201).json({ role: maskRole(role, connectorRegistry) });
  });

  router.get('/roles/:id', (req: Request<{ id: string }>, res: Response) => {
    const role = store.get(req.params.id);
    if (!role) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ role: maskRole(role, connectorRegistry) });
  });

  router.patch('/roles/:id', (req: Request<{ id: string }>, res: Response) => {
    const existing = store.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as RoleBody;
    const patch: RolePatch = {};

    if (body.label !== undefined) {
      if (!isNonEmptyString(body.label)) {
        return res.status(400).json({ error: 'label must be a non-empty string' });
      }
      patch.label = body.label;
    }
    if (body.leadPrompt !== undefined) {
      const r = parseNullableString(body.leadPrompt, 'leadPrompt');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.leadPrompt = r.value;
    }
    if (body.leadPreamble !== undefined) {
      const r = parseNullableString(body.leadPreamble, 'leadPreamble');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.leadPreamble = r.value;
    }
    if (body.workerPreamble !== undefined) {
      const r = parseNullableString(body.workerPreamble, 'workerPreamble');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.workerPreamble = r.value;
    }
    if (body.defaultModel !== undefined) {
      const r = parseNullableString(body.defaultModel, 'defaultModel');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.defaultModel = r.value;
    }
    if (body.defaultProvider !== undefined) {
      const r = parseNullableString(body.defaultProvider, 'defaultProvider');
      if (!r.ok) return res.status(400).json({ error: r.error });
      const known = checkProvider(r.value);
      if (!known.ok) return res.status(400).json(known.body);
      patch.defaultProvider = r.value;
    }
    if (body.defaultEffort !== undefined) {
      if (body.defaultEffort === null) {
        patch.defaultEffort = null;
      } else if (
        typeof body.defaultEffort !== 'string' ||
        !VALID_EFFORTS.has(body.defaultEffort)
      ) {
        return res
          .status(400)
          .json({ error: 'defaultEffort must be one of low|medium|high|xhigh|max' });
      } else {
        patch.defaultEffort = body.defaultEffort as EffortLevel;
      }
    }
    if (body.defaultPermissionMode !== undefined) {
      if (body.defaultPermissionMode === null) {
        patch.defaultPermissionMode = null;
      } else if (
        typeof body.defaultPermissionMode !== 'string' ||
        !VALID_PERMS.has(body.defaultPermissionMode)
      ) {
        return res.status(400).json({ error: 'defaultPermissionMode invalid' });
      } else {
        patch.defaultPermissionMode = body.defaultPermissionMode as PermissionMode;
      }
    }
    if (body.workerCount !== undefined) {
      const r = parseWorkerCount(body.workerCount, config.maxWorkersPerOrch);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.workerCount = r.value;
    }
    if (body.connectors !== undefined) {
      const r = parseConnectors(body.connectors, {
        registry: connectorRegistry,
        previous: existing.connectors,
      });
      if (!r.ok) {
        return res
          .status(r.status ?? 400)
          .json({ error: r.error, ...(r.code ? { code: r.code } : {}) });
      }
      patch.connectors = r.value;
    }
    if (body.schedule !== undefined) {
      const r = parseCron(body.schedule);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.schedule = r.value;
    }
    if (body.scheduleMessage !== undefined) {
      const r = parseNullableString(body.scheduleMessage, 'scheduleMessage');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.scheduleMessage = r.value;
    }
    if (body.approval !== undefined) {
      const r = parseApprovalBody(body.approval);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.approval = r.value;
    }
    // Enforce the schedule⇒message invariant against the MERGED role: a patch
    // can set a schedule without a message, or clear the message while the
    // schedule stays — both would leave a cron with nothing to deliver.
    const effSchedule = patch.schedule !== undefined ? patch.schedule : existing.schedule;
    const effMessage =
      patch.scheduleMessage !== undefined ? patch.scheduleMessage : existing.scheduleMessage;
    if (effSchedule != null && effMessage == null) {
      return res
        .status(400)
        .json({ error: 'scheduleMessage is required when schedule is set' });
    }

    const updated = store.update(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    onRolesChanged?.();
    res.json({ role: maskRole(updated, connectorRegistry) });
  });

  router.delete('/roles/:id', (req: Request<{ id: string }>, res: Response) => {
    store.delete(req.params.id);
    onRolesChanged?.();
    res.status(204).end();
  });

  return router;
}
