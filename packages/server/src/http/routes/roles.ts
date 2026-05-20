import { Router, type Request, type Response } from 'express';
import type { RoleStore, Connector, RoleInit, RolePatch } from '../../modules/roles/index.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';

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
}

interface RoleBody {
  label?: unknown;
  leadPrompt?: unknown;
  leadPreamble?: unknown;
  workerPreamble?: unknown;
  workerCount?: unknown;
  defaultModel?: unknown;
  defaultEffort?: unknown;
  defaultPermissionMode?: unknown;
  connectors?: unknown;
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

function parseConnectors(
  x: unknown,
): { ok: true; value: Connector[] } | { ok: false; error: string } {
  if (x == null) return { ok: true, value: [] };
  if (!Array.isArray(x)) return { ok: false, error: 'connectors must be an array' };
  const out: Connector[] = [];
  for (let i = 0; i < x.length; i++) {
    const c = x[i] as ConnectorBody;
    if (!c || typeof c !== 'object') {
      return { ok: false, error: `connectors[${i}] must be an object` };
    }
    if (c.type !== 'discord') {
      return { ok: false, error: `connectors[${i}].type must be 'discord'` };
    }
    if (!isNonEmptyString(c.webhookUrl)) {
      return { ok: false, error: `connectors[${i}].webhookUrl must be a non-empty string` };
    }
    if (!/^https?:\/\//i.test(c.webhookUrl)) {
      return { ok: false, error: `connectors[${i}].webhookUrl must be a http(s) URL` };
    }
    out.push({ type: 'discord', webhookUrl: c.webhookUrl });
  }
  return { ok: true, value: out };
}

export function createRolesRouter(store: RoleStore, config: Config): Router {
  const router = Router();

  router.get('/roles', (_req: Request, res: Response) => {
    res.json({ roles: store.list() });
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
    const cn = parseConnectors(body.connectors);
    if (!cn.ok) return res.status(400).json({ error: cn.error });

    const init: RoleInit = {
      label: body.label,
      leadPrompt: lp.value,
      leadPreamble: lpre.value,
      workerPreamble: wpre.value,
      workerCount: wc.value,
      defaultModel: dm.value,
      defaultEffort: effort,
      defaultPermissionMode: perm,
      connectors: cn.value,
    };
    const role = store.create(init);
    res.status(201).json({ role });
  });

  router.get('/roles/:id', (req: Request<{ id: string }>, res: Response) => {
    const role = store.get(req.params.id);
    if (!role) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ role });
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
      const r = parseConnectors(body.connectors);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.connectors = r.value;
    }

    const updated = store.update(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ role: updated });
  });

  router.delete('/roles/:id', (req: Request<{ id: string }>, res: Response) => {
    store.delete(req.params.id);
    res.status(204).end();
  });

  return router;
}
