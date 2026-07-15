import { useCallback, useEffect, useState } from 'react';
import { api, type PluginView } from '../api/client';

interface State {
  plugins: PluginView[];
  loading: boolean;
  error: string | null;
}

/**
 * Polls `GET /plugins` and exposes the enable/disable/scan/permissions/config/
 * uninstall operations. `rev` is an external revision counter (bumped by the
 * controller on a `plugin.host.changed` WS event) — bumping it forces a live
 * refetch on top of the poll.
 */
export function usePlugins(
  rev = 0,
  refreshMs = 5000,
): State & {
  refresh: () => Promise<void>;
  scan: () => Promise<void>;
  enable: (name: string, grantedCapabilities?: string[]) => Promise<PluginView>;
  disable: (name: string) => Promise<PluginView>;
  setPermissions: (name: string, grantedCapabilities: string[]) => Promise<PluginView>;
  uninstall: (name: string, purge?: boolean) => Promise<void>;
} {
  const [state, setState] = useState<State>({ plugins: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await api.listPlugins();
      setState({ plugins: r.plugins, loading: false, error: null });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(t);
  }, [refresh, refreshMs, rev]);

  const scan = useCallback(async () => {
    await api.scanPlugins();
    await refresh();
  }, [refresh]);

  const enable = useCallback(
    async (name: string, grantedCapabilities?: string[]) => {
      const res = await api.enablePlugin(name, grantedCapabilities);
      await refresh();
      return res.plugin;
    },
    [refresh],
  );

  const disable = useCallback(
    async (name: string) => {
      const res = await api.disablePlugin(name);
      await refresh();
      return res.plugin;
    },
    [refresh],
  );

  const setPermissions = useCallback(
    async (name: string, grantedCapabilities: string[]) => {
      const res = await api.setPluginPermissions(name, grantedCapabilities);
      await refresh();
      return res.plugin;
    },
    [refresh],
  );

  const uninstall = useCallback(
    async (name: string, purge = false) => {
      await api.uninstallPlugin(name, purge);
      await refresh();
    },
    [refresh],
  );

  return { ...state, refresh, scan, enable, disable, setPermissions, uninstall };
}
