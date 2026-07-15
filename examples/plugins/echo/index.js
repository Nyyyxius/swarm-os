// echo — minimal swarm-os plugin (J1 socle example).
//
// Pure ESM JavaScript, no dependencies, runs in-process. It:
//   - listens for `mailbox.message` and re-emits `plugin.echo.seen`
//   - counts what it has seen in its private kv store
//   - writes a heartbeat to kv on an interval
//
// Everything it registers (event listener, interval) is auto-torn-down by the
// host on disable via the DisposableStore — `deactivate` is only here to show
// the shape; it has nothing extra to release.

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
  },

  deactivate() {
    // Disposables cover teardown; nothing else to do.
  },
};
