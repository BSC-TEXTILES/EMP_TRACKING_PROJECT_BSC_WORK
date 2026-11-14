import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    if (!pathRef.current) return;
    setLoading(true);
    try {
      const result = await api.get<T>(pathRef.current);
      setData(result);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reload, ...deps]);

  return { data, loading, error, reload, setData };
}

export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Workforce`;
  }, [title]);
}

/** Authoritative server-anchored clock for the live attendance timer. */
export function useServerClock(serverNow: string | null, elapsedSeconds: number, running: boolean) {
  const anchor = useRef<{ at: number; seconds: number }>({ at: 0, seconds: 0 });
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!serverNow) return;
    const at = new Date(serverNow).getTime();
    anchor.current = { at, seconds: elapsedSeconds };
  }, [serverNow, elapsedSeconds]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running) return elapsedSeconds;
  const drift = (Date.now() - anchor.current.at) / 1000;
  return Math.max(0, Math.floor(anchor.current.seconds + drift));
}
