import { useCallback, useEffect, useState } from 'react';
import { api, type RoleView, type RoleInput } from '../api/client';

interface State {
  roles: RoleView[];
  loading: boolean;
  error: string | null;
}

export function useRoles(refreshMs = 5000): State & {
  refresh: () => Promise<void>;
  create: (body: Partial<RoleInput> & { label: string }) => Promise<RoleView>;
  update: (id: string, body: Partial<RoleInput>) => Promise<RoleView>;
  destroy: (id: string) => Promise<void>;
} {
  const [state, setState] = useState<State>({ roles: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await api.listRoles();
      setState({ roles: r.roles, loading: false, error: null });
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
  }, [refresh, refreshMs]);

  const create = useCallback(
    async (body: Partial<RoleInput> & { label: string }) => {
      const res = await api.createRole(body);
      await refresh();
      return res.role;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, body: Partial<RoleInput>) => {
      const res = await api.updateRole(id, body);
      await refresh();
      return res.role;
    },
    [refresh],
  );

  const destroy = useCallback(
    async (id: string) => {
      await api.deleteRole(id);
      await refresh();
    },
    [refresh],
  );

  return { ...state, refresh, create, update, destroy };
}
