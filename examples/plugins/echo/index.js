// echo — example swarm-os plugin.
//
// Pure ESM JavaScript, no dependencies, runs in-process. It:
//   - listens for `mailbox.message` and re-emits `plugin.echo.seen`
//   - counts what it has seen in its private kv store
//   - writes a heartbeat to kv on an interval
//   - exposes an `echo.ping` MCP tool to the agents (J2)
//   - serves an authenticated `/plugin-api/echo/hello` route (J2)
//   - serves an authenticated `/plugin-api/echo/panel` HTML page rendered by the
//     SPA as a UI panel iframe (B.3 — declared in plugin.json `uiPanels`)
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

    // B.3 — UI panel page → GET /plugin-api/echo/panel. Declared in plugin.json
    // `uiPanels`; the SPA renders it in a sandboxed iframe. A same-origin fetch
    // back to `./hello` carries the panel-auth cookie, proving the iframe auth.
    router.get('/panel', (_req, res) => {
      res.type('html').send(PANEL_HTML);
    });
    api.http.registerRouter(router);
  },

  deactivate() {
    // Disposables cover teardown; nothing else to do.
  },
};

// Static HTML for the demo panel. Self-contained (inline CSS/JS); the fetch to
// `./hello` is same-origin, so the browser attaches the `swarm_os_token` cookie
// the host's auth gate accepts for the `/plugin-api/` zone.
const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Echo panel</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: #94a3b8; margin: 0 0 16px; }
  button { font: inherit; padding: 8px 14px; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #e2e8f0; cursor: pointer; }
  button:hover { border-color: #64748b; }
  pre { margin-top: 16px; padding: 12px; background: #020617; border: 1px solid #1e293b; border-radius: 6px; overflow-x: auto; }
</style>
</head>
<body>
  <h1>Echo plugin — demo panel</h1>
  <p>Served by the echo plugin at <code>/plugin-api/echo/panel</code> and rendered in a sandboxed iframe.</p>
  <button id="ping">Fetch /plugin-api/echo/hello</button>
  <pre id="out">Click the button to call the plugin's authenticated route.</pre>
  <script>
    document.getElementById('ping').addEventListener('click', async () => {
      const out = document.getElementById('out');
      out.textContent = 'loading…';
      try {
        const res = await fetch('./hello', { headers: { Accept: 'application/json' } });
        out.textContent = 'HTTP ' + res.status + '\\n' + (await res.text());
      } catch (err) {
        out.textContent = 'error: ' + (err && err.message ? err.message : String(err));
      }
    });
  </script>
</body>
</html>`;
