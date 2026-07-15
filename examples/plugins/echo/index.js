// echo — example swarm-os plugin.
//
// Pure ESM JavaScript, no dependencies, runs in-process. It:
//   - listens for `mailbox.message` and re-emits `plugin.echo.seen`
//   - counts what it has seen in its private kv store
//   - writes a heartbeat to kv on an interval
//   - exposes an `echo.ping` MCP tool to the agents (J2)
//   - serves an authenticated `/plugin-api/echo/hello` route (J2)
//   - declares a configSchema with a `format:'password'` demo field (J2)
//
// Everything it registers (event listener, interval, MCP tool, HTTP router) is
// auto-torn-down by the host on disable via the DisposableStore.

export default {
  /** @param {import('../../../packages/server/src/modules/plugins/api-types.js').SwarmPluginApi} api */
  activate(api) {
    api.log.info({ event: 'echo.activate' });

    // Restore the running count across enable cycles.
    let seen = Number(api.storage.kv.get('seen') ?? '0') || 0;

    api.events.on('mailbox.message', (ev) => {
      seen += 1;
      api.storage.kv.set('seen', String(seen));
      api.events.emit(
        'seen',
        { count: seen, from: ev.payload && ev.payload.from },
        { orchestratorId: ev.orchestratorId, sessionId: ev.sessionId },
      );
    });

    api.schedule.interval(30_000, () => {
      api.storage.kv.set('heartbeat', new Date().toISOString());
    });

    // MCP tool exposed to agents as `echo.ping` (not lead-only).
    api.mcp.registerTool({
      name: 'ping',
      title: 'Echo ping',
      description:
        'Returns a greeting plus the caller identity. Any team member may call it.',
      leadOnly: false,
      inputSchema: {
        message: api.zod.string().optional().describe('Text to echo back.'),
      },
      outputSchema: {
        reply: api.zod.string(),
        caller: api.zod.string(),
        is_lead: api.zod.boolean(),
      },
      handler: (args, ctx) => {
        const cfg = api.config.get();
        const greeting = typeof cfg.greeting === 'string' ? cfg.greeting : 'pong';
        const message = typeof args.message === 'string' ? args.message : '';
        return {
          reply: message ? `${greeting}: ${message}` : greeting,
          caller: ctx.sessionName,
          is_lead: ctx.isLead,
        };
      },
    });

    // Authenticated HTTP route → GET /plugin-api/echo/hello.
    const router = api.http.createRouter();
    router.get('/hello', (_req, res) => {
      res.json({ ok: true, plugin: 'echo', seen });
    });
    api.http.registerRouter(router);
  },

  deactivate() {
    // Disposables cover teardown; nothing else to do.
  },
};
