import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type SkillView,
  type SkillInstallInput,
  type SkillInstallResult,
} from '../api/client';

interface State {
  skills: SkillView[];
  loading: boolean;
  error: string | null;
}

/**
 * Polls `GET /skills` and exposes install/upload/upgrade/delete operations.
 * Mirrors the shape of `usePlugins` so SkillsPage can follow the same pattern.
 */
export function useSkills(
  rev = 0,
  refreshMs = 5000,
): State & {
  refresh: () => Promise<void>;
  install: (source: SkillInstallInput) => Promise<SkillInstallResult>;
  upload: (file: File | Blob, name?: string) => Promise<SkillInstallResult>;
  upgrade: (name: string) => Promise<SkillInstallResult>;
  remove: (name: string) => Promise<void>;
} {
  const [state, setState] = useState<State>({ skills: [], loading: true, error: null });

  const refresh = useCallback(async () => {
    try {
      const r = await api.listSkills();
      setState({ skills: r.skills, loading: false, error: null });
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

  const install = useCallback(
    async (source: SkillInstallInput) => {
      const res = await api.installSkill(source);
      await refresh();
      return res;
    },
    [refresh],
  );

  const upload = useCallback(
    async (file: File | Blob, name?: string) => {
      const res = await api.uploadSkill(file, name);
      await refresh();
      return res;
    },
    [refresh],
  );

  const upgrade = useCallback(
    async (name: string) => {
      const res = await api.upgradeSkill(name);
      await refresh();
      return res;
    },
    [refresh],
  );

  const remove = useCallback(
    async (name: string) => {
      await api.deleteSkill(name);
      await refresh();
    },
    [refresh],
  );

  return { ...state, refresh, install, upload, upgrade, remove };
}
