import { useCallback, useEffect, useState } from 'react';
import { api, type SessionView } from '../api/client';

export function useSession(sessionId: string | null, refreshMs = 2000) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const s = await api.getSession(sessionId);
      setSession(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      return;
    }
    void refresh();
    const t = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(t);
  }, [sessionId, refresh, refreshMs]);

  return { session, error, refresh };
}
