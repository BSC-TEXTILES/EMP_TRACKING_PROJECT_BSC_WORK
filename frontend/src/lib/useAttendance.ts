import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AttendanceState } from './types';

type Action = 'check-in' | 'check-out' | 'break/start' | 'break/end';

export function useAttendance(options: { poll?: boolean } = {}) {
  const [state, setState] = useState<AttendanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<AttendanceState>('/attendance/today');
      if (mounted.current) setState(next);
      return next;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!options.poll) return;
    const timer = window.setInterval(() => {
      void api
        .get<AttendanceState>('/attendance/heartbeat')
        .then((next) => {
          if (mounted.current) setState(next);
        })
        .catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [options.poll]);

  const act = useCallback(
    async (action: Action, payload: Record<string, unknown> = {}) => {
      setPending(action);
      try {
        const next = await api.post<AttendanceState>(`/attendance/${action}`, payload);
        setState(next);
        return next;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return { state, loading, pending, refresh, act, setState };
}
