/**
 * `GET /providers` — the catalogue of agent providers, with what each one can
 * do and whether it can be used right now.
 *
 * Mounted next to `/connector-types` (`routes/roles.ts`) and shaped like it: a
 * registry rendered for the UI. It exists to kill two long-standing problems:
 *
 *  1. **Four hard-coded model lists in the web bundle** (`desktop/constants.ts`,
 *     `NewOrchestratorDialog`, `RoleDialog`, `RolesPage`). A catalogue that
 *     lives in four files is a catalogue that is wrong in at least three.
 *  2. **`/info` never exposed the server-side defaults.** The UI had no way to
 *     show what a team would get if the operator left a field empty, so it
 *     re-invented its own defaults — which then drifted.
 *
 * The response also carries `available` + `unavailableReason` per provider, so
 * the UI can render an unusable provider as DISABLED WITH A REASON rather than
 * hiding it. A missing option teaches the operator nothing; a greyed-out one
 * saying "not on PATH on the host" tells them exactly what to do.
 */

import { Router, type Request, type Response } from 'express';
import type { Spawner } from '../../modules/spawner/index.js';
import type { Config } from '../../config.js';
import { AVAILABILITY_COLD_WAIT_MS } from '../../modules/providers/availability.js';
import { MODEL_CATALOGUE_COLD_WAIT_MS } from '../../modules/providers/catalogue.js';

/** One entry of the `providers` array. Mirrored by the web client in Lot 3. */
export interface ProviderInfoPayload {
  id: string;
  label: string;
  binary: string;
  builtin: boolean;
  available: boolean;
  /** Present only when `available` is false. Written for a human. */
  unavailableReason?: string;
  /** First line of `<binary> --version`, when the probe got one. */
  version?: string;
  models: Array<{ value: string; label: string }>;
  capabilities: {
    effort: boolean;
    permissionModes: string[];
    fallbackPermissionMode: string;
    /**
     * "Will a session of this provider ever report `waiting`?" — i.e. does its
     * callback mean A HUMAN IS NEEDED.
     *
     * NOT a straight cast of the server-side field, which is now a three-valued
     * semantic (`false | 'needs-human' | 'turn-complete'`). codex and gemini DO
     * install a callback, but theirs fires at every turn boundary, so
     * `http/routes/hooks.ts` deliberately never flips their badge nor notifies —
     * reporting `true` here would make the UI promise a `waiting` state that
     * cannot happen. Kept as a boolean under its original name because the web
     * bundle already consumes it to render "its sessions never report waiting".
     */
    notificationHook: boolean;
    /** The full semantic, for a UI that wants to word it precisely. */
    notificationSemantics: 'none' | 'needs-human' | 'turn-complete';
    inkSubmitDance: boolean;
    durablePreamble: boolean;
    httpMcp: boolean;
  };
  defaults: { model: string; effort: string; permissionMode: string };
}

export function createProvidersRouter(spawner: Spawner, config: Config): Router {
  const router = Router();

  router.get('/providers', async (_req: Request, res: Response) => {
    // One shared deadline for the whole set: a cold call costs at most
    // AVAILABILITY_COLD_WAIT_MS regardless of how many adapters are
    // registered. Anything still probing comes back as "not available yet"
    // WITH its pending reason, and the finished verdict is served to the next
    // caller from the cache — the UI polls, so nobody stares at a spinner.
    //
    // The model catalogue rides the SAME deadline rather than a second one: both
    // bodies reach their first `await` in this tick, so their two cold waits
    // start together and the route's floor is a MAX (~3 s), not a sum. `models()`
    // and `defaults()` below are synchronous and serve the pins if the catalogue
    // has not landed — this await only decides whether the FIRST caller after a
    // boot sees live data or waits one poll for it.
    const [availability] = await Promise.all([
      spawner.providerAvailability.resolveAll(AVAILABILITY_COLD_WAIT_MS),
      spawner.modelCatalogue?.resolve(MODEL_CATALOGUE_COLD_WAIT_MS) ?? Promise.resolve(),
    ]);
    const types = new Map(spawner.providerRegistry.types().map((t) => [t.id, t]));

    const providers: ProviderInfoPayload[] = spawner.providerRegistry
      .list()
      .map((p) => {
        const state = availability.get(p.id);
        const defaults = p.defaults();
        const info: ProviderInfoPayload = {
          id: p.id,
          label: p.label,
          binary: p.binary,
          builtin: types.get(p.id)?.builtin ?? false,
          available: state?.available ?? false,
          models: p.models().map((m) => ({ value: m.value, label: m.label })),
          capabilities: {
            effort: p.capabilities.effort,
            permissionModes: [...p.capabilities.permissionModes],
            fallbackPermissionMode: p.capabilities.fallbackPermissionMode,
            // See the payload type: only `'needs-human'` ever produces a
            // `waiting` badge, so that is what the boolean has to mean.
            notificationHook: p.capabilities.notificationHook === 'needs-human',
            notificationSemantics:
              p.capabilities.notificationHook === false
                ? 'none'
                : p.capabilities.notificationHook,
            inkSubmitDance: p.capabilities.inkSubmitDance,
            durablePreamble: p.capabilities.durablePreamble,
            httpMcp: p.capabilities.httpMcp,
          },
          defaults: {
            model: defaults.model,
            effort: defaults.effort,
            permissionMode: defaults.permissionMode,
          },
        };
        if (!info.available && state?.reason) info.unavailableReason = state.reason;
        if (state?.version) info.version = state.version;
        return info;
      });

    res.json({
      /** What a team gets when neither the request nor the role names one. */
      defaultProvider: config.defaultProvider,
      /**
       * The other two instance defaults, for the same reason `defaultProvider`
       * is here: a dialog that offers "(inherit the global default)" has to be
       * able to SAY what that default is. Without them the UI showed the option
       * and could not name the value — which is exactly the complaint this
       * route's header levels at `/info`.
       *
       * These are the values `POST /orchestrators` resolves to when neither the
       * body nor the role names one (`routes/orchestrators.ts`), so they are the
       * literal answer to "what will I get if I leave this empty?". Note that
       * `defaultModel` is deliberately NOT among them: it is a claude model id,
       * and the fallback for a team on another provider is that PROVIDER's own
       * `defaults.model` (already carried per provider above) — publishing it as
       * a global default would invite the UI to show a claude id next to a
       * gemini team.
       */
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      /**
       * Where the agents run. The UI needs it to explain why a CLI that is
       * installed on the host still reads as unavailable in `local` transport
       * (and vice-versa).
       */
      transport: config.agentTransport,
      providers,
    });
  });

  return router;
}
