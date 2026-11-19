import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { currentPushEndpoint, unsubscribeWebPush } from '../lib/notifications';
import { ApiError, api, refreshMediaToken } from '../lib/api';
import { isNative } from '../lib/native';
import type { CurrentUser } from '../lib/types';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  unreadNotifications: number;
  login: (user: CurrentUser) => void;
  refresh: () => Promise<void>;
  /** keepNotifications (default true): this device keeps ringing for calls and messages after sign-out. */
  logout: (options?: { keepNotifications?: boolean }) => Promise<void>;
  has: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
  setUnreadNotifications: (value: number | ((prev: number) => number)) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = 'wfm_session_known';
const fingerprint = `browser-${navigator.userAgent.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;

function isSessionInvalid(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === 'session_expired' || error.status === 401 || error.status === 403;
}

/** Network and server-side failures must never look like a signed-out session. */
function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.code === 'timeout');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const userRef = useRef<CurrentUser | null>(null);
  userRef.current = user;

  const refresh = useCallback(async () => {
    if (!localStorage.getItem(SESSION_KEY)) {
      setUser(null);
      return;
    }
    try {
      const result = await api.get<{ user: CurrentUser; unreadNotifications: number }>('/auth/me');
      // Mobile app: image and download URLs need a media token before anything renders.
      if (isNative) await refreshMediaToken();
      localStorage.setItem(SESSION_KEY, '1');
      const cleanUser = result.user ?? null;
      setUser(cleanUser);
      setUnreadNotifications(result.unreadNotifications);
    } catch (error) {
      if (isSessionInvalid(error)) {
        localStorage.removeItem(SESSION_KEY);
        setUser(null);
        return;
      }
      // Transient outage: keep the signed-in state and retry later.
      if (isTransient(error)) throw error;
      localStorage.removeItem(SESSION_KEY);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await refresh();
          return;
        } catch {
          if (cancelled) return;
          await new Promise((resolve) => window.setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    };
    void boot().finally(() => {
      if (!cancelled) setLoading(false);
    });

    const onExpired = () => {
      if (localStorage.getItem(SESSION_KEY)) sessionStorage.setItem('wfm_session_expired', '1');
      localStorage.removeItem(SESSION_KEY);
      setUser(null);
      setLoading(false);
    };
    const onOnline = () => {
      if (!userRef.current && localStorage.getItem(SESSION_KEY)) {
        void refresh().catch(() => undefined);
      }
    };
    window.addEventListener('auth:expired', onExpired);
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener('auth:expired', onExpired);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  const login = useCallback((nextUser: CurrentUser) => {
    sessionStorage.removeItem('wfm_session_expired');
    localStorage.setItem(SESSION_KEY, '1');
    const cleanUser = nextUser ?? null;
    setUser(cleanUser);
    void refresh().catch(() => undefined);
  }, [refresh]);

  const logout = useCallback(async (options?: { keepNotifications?: boolean }) => {
    const keepNotifications = options?.keepNotifications !== false;
    const pushEndpoint = await currentPushEndpoint();
    try {
      await api.post('/activity/auto-stop').catch(() => undefined);
      await api.post('/auth/logout', { keepNotifications, ...(pushEndpoint ? { pushEndpoint } : {}) });
    } catch {
      /* clearing client state is enough */
    }
    if (!keepNotifications) await unsubscribeWebPush();
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
    window.location.href = '/login';
  }, []);

  // Activity monitoring starts automatically at login and keeps a heartbeat
  // while the employee is signed in. A network interruption only delays the
  // next heartbeat; it does not end the session.
  useEffect(() => {
    // A phone cannot report desktop activity; the native agent does that.
    if (!user?.id || isNative) return;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') return;
      void api.post('/activity/auto-start', { machineFingerprint: fingerprint }).catch(() => undefined);
    };
    start();
    const timer = window.setInterval(start, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') start();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user?.id]);

  // Idle/active presence for administrators. The ping carries no content and is
  // sent at most once a minute, only while the employee is actually active.
  useEffect(() => {
    if (!user?.id) return;
    let lastPing = 0;
    let lastActivity = Date.now();
    const send = () => {
      const now = Date.now();
      if (now - lastPing < 60_000) return;
      if (document.visibilityState !== 'visible') return;
      if (now - lastActivity > 5 * 60_000) return; // idle users are reported as away by the server
      lastPing = now;
      void api.post('/presence/ping').catch(() => undefined);
    };
    const onActivity = () => {
      lastActivity = Date.now();
      send();
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart', 'focus'];
    for (const event of events) window.addEventListener(event, onActivity, { passive: true } as AddEventListenerOptions);
    const timer = window.setInterval(send, 90_000);
    return () => {
      window.clearInterval(timer);
      for (const event of events) window.removeEventListener(event, onActivity);
    };
  }, [user?.id]);

  const has = useCallback(
    (...permissions: string[]) => {
      if (!user) return false;
      return permissions.every((permission) => user.permissions.includes(permission));
    },
    [user],
  );

  const canAny = useCallback(
    (...permissions: string[]) => {
      if (!user) return false;
      return permissions.some((permission) => user.permissions.includes(permission));
    },
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, unreadNotifications, login, refresh, logout, has, canAny, setUnreadNotifications }),
    [user, loading, unreadNotifications, login, refresh, logout, has, canAny],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
