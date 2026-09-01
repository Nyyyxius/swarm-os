/**
 * Shared validation for cron writes (docs/crons-agents.md §2.2).
 *
 * There are TWO write surfaces on the crons entity — the REST route
 * (`http/routes/crons.ts`, driven by the UI) and the plugin façade
 * (`api.crons.*`, driven by a plugin reconciling its own cadences) — and they
 * must refuse exactly the same things. Keeping one copy of the rules here is
 * not tidiness: a divergence would let a plugin store a cron the form refuses
 * (a 6-field per-second expression, a `message` cron with no template), and the
 * store's own `assertInvariants` is deliberately narrower than this — it knows
 * nothing about role existence, about the 5-field restriction, or about script
 * path containment.
 *
 * Layering, from narrowest to widest:
 *   - `CronStore.assertInvariants` — what the TABLE must never hold.
 *   - this module — what an OPERATOR (or a plugin) may ask for: field types,
 *     5-field cron, known role, resolvable script path.
 *   - the route — HTTP shape only (status codes, response envelope).
 *
 * Every function here returns a `CronParsed` rather than throwing: the route
 * turns it into a 400 with a field-level message, the façade turns it into a
 * `CronValidationError` the plugin can catch. Neither has to guess.
 */

import {
  CRON_INTERPRETERS,
  CRON_NAME_RE,
  DEFAULT_CRON_TIMEOUT_MS,
  MAX_CRON_TIMEOUT_MS,
  type CronAction,
  type CronInit,
  type CronPatch,
  type CronRecord,
} from './store.js';
import { isValidCron } from './scheduler.js';

/**
 * The slice of the role store the validators need: "does this role exist". A
 * cron pointing at a role id that never existed is a typo worth reporting at
 * the form; a role deleted LATER leaves an orphan cron on purpose (§6.2 —
 * operator config is not cascade-deleted).
 */
export interface RoleExistsLookup {
  get(id: string): unknown | null;
}

/** Why a write was refused. The route maps these onto its 400 payload. */
export type CronInvalidCode = 'INVALID' | 'UNKNOWN_ROLE' | 'INVALID_SCRIPT';

export type CronParsed<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: CronInvalidCode };

export interface CronValidationDeps {
  /** Omitted ⇒ role existence is not checked (no role store wired). */
  roles?: RoleExistsLookup;
  /**
   * The script runner's `resolveScriptPath` — realpaths the script and refuses
   * anything outside the workspace / data roots. Omitted ⇒ this server has no
   * script runner and `action: 'script'` is refused outright.
   *
   * This probe is a UX affordance, NOT the security boundary: the runner
   * repeats it at every fire, on the path it then actually executes. Its value
   * is a refusal in the form instead of a silent `error` run three hours later.
   */
  resolveScriptPath?: (scriptPath: string) => Promise<string>;
}

/** Raw, untrusted write input — every field is validated before it is used. */
export interface CronInput {
  name?: unknown;
  roleId?: unknown;
  schedule?: unknown;
  action?: unknown;
  message?: unknown;
  scriptPath?: unknown;
  scriptArgs?: unknown;
  interpreter?: unknown;
  timeoutMs?: unknown;
  paused?: unknown;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function bad(error: string, code: CronInvalidCode = 'INVALID'): {
  ok: false;
  error: string;
  code: CronInvalidCode;
} {
  return { ok: false, error, code };
}

export function parseCronName(x: unknown): Parsed<string> {
  if (typeof x !== 'string') return { ok: false, error: 'name must be a string' };
  const trimmed = x.trim();
  if (!CRON_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'name must be a slug of 1-64 chars: letters, digits, dot, dash, underscore (it is also the `cron:<name>` sender of the messages)',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * A cron expression, restricted to FIVE fields (§2.2). croner itself accepts a
 * 6-field, to-the-second form — refused here: a per-second script cron is a
 * fork bomb bounded only by the overlap guard, and no operator asks for one on
 * purpose from this form.
 */
export function parseCronSchedule(x: unknown): Parsed<string> {
  if (typeof x !== 'string') return { ok: false, error: 'schedule must be a string' };
  const trimmed = x.trim();
  if (trimmed === '') return { ok: false, error: 'schedule is required' };
  if (trimmed.split(/\s+/).length !== 5) {
    return {
      ok: false,
      error:
        'schedule must have exactly 5 fields (minute hour day month weekday) — per-second expressions are refused',
    };
  }
  if (!isValidCron(trimmed)) {
    return {
      ok: false,
      error: 'schedule must be a valid cron expression (e.g. "0 6,12,20 * * *")',
    };
  }
  return { ok: true, value: trimmed };
}

export function parseCronAction(x: unknown): Parsed<CronAction> {
  if (x === 'message' || x === 'script') return { ok: true, value: x };
  return { ok: false, error: "action must be 'message' or 'script'" };
}

function parseNullableString(x: unknown, field: string): Parsed<string | null> {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'string') return { ok: false, error: `${field} must be a string or null` };
  return { ok: true, value: x.length === 0 ? null : x };
}

function parseScriptArgs(x: unknown): Parsed<string[] | null> {
  if (x == null) return { ok: true, value: null };
  if (!Array.isArray(x) || x.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'scriptArgs must be an array of strings or null' };
  }
  return { ok: true, value: x as string[] };
}

function parseInterpreter(x: unknown): Parsed<string | null> {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'string' || !CRON_INTERPRETERS.includes(x)) {
    return { ok: false, error: `interpreter must be one of ${CRON_INTERPRETERS.join('|')}` };
  }
  return { ok: true, value: x };
}

function parseTimeoutMs(x: unknown): Parsed<number | null> {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 1000 || x > MAX_CRON_TIMEOUT_MS) {
    return {
      ok: false,
      error: `timeoutMs must be an integer between 1000 and ${MAX_CRON_TIMEOUT_MS}, or null`,
    };
  }
  return { ok: true, value: x };
}

/**
 * Containment + completeness check for a script cron. Returns an error string,
 * or `null` when the path is acceptable.
 */
async function checkScript(
  scriptPath: string | null,
  interpreter: string | null,
  deps: CronValidationDeps,
): Promise<string | null> {
  if (!scriptPath) return "scriptPath is required when action is 'script'";
  if (!interpreter) return "interpreter is required when action is 'script'";
  if (!deps.resolveScriptPath) {
    return 'script crons are unavailable on this server (no script runner configured)';
  }
  try {
    await deps.resolveScriptPath(scriptPath);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Validate a CREATE. The field order matters and is preserved from the original
 * route: an operator sending three bad fields at once should keep getting the
 * same first complaint across versions.
 */
export async function validateCronInit(
  input: CronInput,
  deps: CronValidationDeps = {},
): Promise<CronParsed<CronInit>> {
  const name = parseCronName(input.name);
  if (!name.ok) return bad(name.error);
  if (typeof input.roleId !== 'string' || input.roleId.length === 0) {
    return bad('roleId is required and must be a non-empty string');
  }
  if (deps.roles && deps.roles.get(input.roleId) == null) {
    return bad(`unknown role '${input.roleId}'`, 'UNKNOWN_ROLE');
  }
  const schedule = parseCronSchedule(input.schedule);
  if (!schedule.ok) return bad(schedule.error);
  const action = parseCronAction(input.action);
  if (!action.ok) return bad(action.error);
  const message = parseNullableString(input.message, 'message');
  if (!message.ok) return bad(message.error);
  const scriptPath = parseNullableString(input.scriptPath, 'scriptPath');
  if (!scriptPath.ok) return bad(scriptPath.error);
  const scriptArgs = parseScriptArgs(input.scriptArgs);
  if (!scriptArgs.ok) return bad(scriptArgs.error);
  const interpreter = parseInterpreter(input.interpreter);
  if (!interpreter.ok) return bad(interpreter.error);
  const timeoutMs = parseTimeoutMs(input.timeoutMs);
  if (!timeoutMs.ok) return bad(timeoutMs.error);
  if (input.paused !== undefined && typeof input.paused !== 'boolean') {
    return bad('paused must be a boolean');
  }
  // §2.2 invariants, checked here so the caller gets a field-level message (the
  // store re-checks the subset it owns — the migration writes there too).
  if (action.value === 'message' && message.value == null) {
    return bad("message is required when action is 'message'");
  }
  if (action.value === 'script') {
    const reason = await checkScript(scriptPath.value, interpreter.value, deps);
    if (reason) return bad(reason, 'INVALID_SCRIPT');
  }

  return {
    ok: true,
    value: {
      name: name.value,
      roleId: input.roleId,
      schedule: schedule.value,
      action: action.value,
      message: message.value,
      scriptPath: scriptPath.value,
      scriptArgs: scriptArgs.value,
      interpreter: interpreter.value,
      // A script cron stores its budget explicitly rather than leaning on the
      // store's `null`-means-default: the number a run is going to be judged by
      // (and that an operator will want to raise) should be visible in the UI,
      // not implied. Message crons keep `null` — they have no timeout.
      timeoutMs:
        action.value === 'script'
          ? (timeoutMs.value ?? DEFAULT_CRON_TIMEOUT_MS)
          : timeoutMs.value,
      paused: input.paused === true,
    },
  };
}

/**
 * Validate a PARTIAL edit against the cron it will be applied to. Only the keys
 * actually present in `input` land in the patch — `undefined` means "leave it
 * alone", while an explicit `null` is a meaningful value on every nullable
 * field (clear the args, drop back to the default timeout).
 */
export async function validateCronPatch(
  existing: CronRecord,
  input: CronInput,
  deps: CronValidationDeps = {},
): Promise<CronParsed<CronPatch>> {
  const patch: CronPatch = {};

  if (input.name !== undefined) {
    const r = parseCronName(input.name);
    if (!r.ok) return bad(r.error);
    patch.name = r.value;
  }
  if (input.roleId !== undefined) {
    if (typeof input.roleId !== 'string' || input.roleId.length === 0) {
      return bad('roleId must be a non-empty string');
    }
    if (deps.roles && deps.roles.get(input.roleId) == null) {
      return bad(`unknown role '${input.roleId}'`, 'UNKNOWN_ROLE');
    }
    patch.roleId = input.roleId;
  }
  if (input.schedule !== undefined) {
    const r = parseCronSchedule(input.schedule);
    if (!r.ok) return bad(r.error);
    patch.schedule = r.value;
  }
  if (input.action !== undefined) {
    const r = parseCronAction(input.action);
    if (!r.ok) return bad(r.error);
    patch.action = r.value;
  }
  if (input.message !== undefined) {
    const r = parseNullableString(input.message, 'message');
    if (!r.ok) return bad(r.error);
    patch.message = r.value;
  }
  if (input.scriptPath !== undefined) {
    const r = parseNullableString(input.scriptPath, 'scriptPath');
    if (!r.ok) return bad(r.error);
    patch.scriptPath = r.value;
  }
  if (input.scriptArgs !== undefined) {
    const r = parseScriptArgs(input.scriptArgs);
    if (!r.ok) return bad(r.error);
    patch.scriptArgs = r.value;
  }
  if (input.interpreter !== undefined) {
    const r = parseInterpreter(input.interpreter);
    if (!r.ok) return bad(r.error);
    patch.interpreter = r.value;
  }
  if (input.timeoutMs !== undefined) {
    const r = parseTimeoutMs(input.timeoutMs);
    if (!r.ok) return bad(r.error);
    patch.timeoutMs = r.value;
  }
  if (input.paused !== undefined) {
    if (typeof input.paused !== 'boolean') return bad('paused must be a boolean');
    patch.paused = input.paused;
  }

  // Invariants are enforced against the MERGED cron: a patch can clear the
  // message while the action stays `message`, which would leave a cadence with
  // nothing to deliver.
  const effAction = patch.action ?? existing.action;
  const effMessage = patch.message !== undefined ? patch.message : existing.message;
  if (effAction === 'message' && effMessage == null) {
    return bad("message is required when action is 'message'");
  }
  if (effAction === 'script') {
    const effScriptPath = patch.scriptPath !== undefined ? patch.scriptPath : existing.scriptPath;
    const effInterpreter =
      patch.interpreter !== undefined ? patch.interpreter : existing.interpreter;
    const reason = await checkScript(effScriptPath, effInterpreter, deps);
    if (reason) return bad(reason, 'INVALID_SCRIPT');
    // Same reasoning as the create path: materialise the budget so it is
    // visible. Only when the merged cron has none — never overwriting an
    // explicit value.
    const effTimeout = patch.timeoutMs !== undefined ? patch.timeoutMs : existing.timeoutMs;
    if (effTimeout == null) patch.timeoutMs = DEFAULT_CRON_TIMEOUT_MS;
  }

  return { ok: true, value: patch };
}
