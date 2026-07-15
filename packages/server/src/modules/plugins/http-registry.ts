/**
 * PluginHttpRegistry — dynamic HTTP routes for plugins (plan §J2).
 *
 * Express never unmounts a router, so — like the MCP tools — enable/disable is
 * a Map mutation consulted at request time. Two never-torn-down dispatchers are
 * mounted ONCE in `http/main.ts`:
 *   - AUTH zone  `/plugin-api/:name/*`   — mounted AFTER the X-Auth-Token gate.
 *   - PUBLIC zone `/public/plugins/:name/*` — mounted AFTER bootGate but BEFORE
 *     auth (inbound webhooks; the plugin verifies its own signatures over the
 *     raw body exposed as `req.rawBody`).
 *
 * A `dispose()` deletes the plugin's entry from the Map ⇒ an immediate 404. A
 * handler error is caught by the dispatcher's error middleware → `500 { error:
 * 'PLUGIN_ERROR', plugin }`, and the plugin's `guard()` is fed the error so the
 * crash counts toward quarantine with correct epoch semantics.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PluginGuard } from './api.js';
import { withModule } from '../../logger.js';

const log = withModule('plugins.http');

// Raw request body captured by the global `express.json({ verify })` in
// main.ts — plugins verify HMAC signatures (Slack/Stripe/GitHub) over the
// exact bytes. Present only for parsed JSON requests (plan §J2 B-1).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

interface RegisteredRouter {
  router: Router;
  /** Bound to the plugin + activation epoch — charges crashes to quarantine. */
  guard: PluginGuard;
}

export class PluginHttpRegistry {
  private readonly authRouters = new Map<string, RegisteredRouter>();
  private readonly publicRouters = new Map<string, RegisteredRouter>();
  /** Per-plugin HTTP crash counter (diagnostics + surfaced in logs). */
  private readonly crashes = new Map<string, number>();

  registerRouter(name: string, router: Router, guard: PluginGuard): { dispose(): void } {
    return this.registerIn(this.authRouters, 'auth', name, router, guard);
  }

  registerPublicRouter(
    name: string,
    router: Router,
    guard: PluginGuard,
  ): { dispose(): void } {
    return this.registerIn(this.publicRouters, 'public', name, router, guard);
  }

  private registerIn(
    map: Map<string, RegisteredRouter>,
    zone: string,
    name: string,
    router: Router,
    guard: PluginGuard,
  ): { dispose(): void } {
    const entry: RegisteredRouter = { router, guard };
    map.set(name, entry);
    log.info({ event: 'plugins.router_registered', plugin: name, zone });
    return {
      dispose: () => {
        // Only delete if still OUR entry (a reload may have swapped a fresh one).
        if (map.get(name) === entry) map.delete(name);
      },
    };
  }

  /** True when the plugin has a router in either zone. */
  has(name: string): boolean {
    return this.authRouters.has(name) || this.publicRouters.has(name);
  }

  crashCount(name: string): number {
    return this.crashes.get(name) ?? 0;
  }

  /** Dispatcher for the authenticated zone. Mount at `/plugin-api/:name`. */
  authDispatcher(): Router {
    return this.buildDispatcher(this.authRouters);
  }

  /** Dispatcher for the public zone. Mount at `/public/plugins/:name`. */
  publicDispatcher(): Router {
    return this.buildDispatcher(this.publicRouters);
  }

  private buildDispatcher(map: Map<string, RegisteredRouter>): Router {
    // `mergeParams: true` so `:name` from the parent mount path is visible here.
    const dispatcher = Router({ mergeParams: true });

    dispatcher.use((req: Request, res: Response, next: NextFunction) => {
      const name = String(req.params.name ?? '');
      const entry = map.get(name);
      if (!entry) {
        res.status(404).json({ error: 'PLUGIN_NOT_FOUND', plugin: name });
        return;
      }
      // Delegate to the plugin's own router. Sync throws + Express-5 async
      // rejections both surface at the error middleware below via `next(err)`.
      entry.router(req, res, next);
    });

    // Plugin error boundary — never a server-killing throw (uncaughtException
    // is FATAL here). Feed the plugin's guard so the crash is charged to
    // quarantine with correct epoch, then answer a clean 500.
    dispatcher.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
      const name = String(req.params.name ?? '');
      this.crashes.set(name, (this.crashes.get(name) ?? 0) + 1);
      const entry = map.get(name);
      if (entry) {
        try {
          // Calling a guard-wrapped thrower routes the error through the host's
          // crash accounting (counted, epoch-aware) and swallows it.
          entry.guard('http.route', () => {
            throw err;
          })();
        } catch {
          /* guard never throws, but be defensive */
        }
      }
      log.warn({
        event: 'plugins.route_error',
        plugin: name,
        error: err instanceof Error ? err.message : String(err),
      });
      if (res.headersSent) return next(err);
      res.status(500).json({ error: 'PLUGIN_ERROR', plugin: name });
    });

    return dispatcher;
  }
}
