import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { CurrentUser } from '../lib/types';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  unreadNotifications: number;
  login: (user: CurrentUser) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  has: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
  setUnreadNotifications: (value: number | ((prev: number) => number)) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  const refresh = useCallback(async () => {
    if (!localStorage.getItem('wfm_session_known')) {
      setUser(null);
      return;
    }
    try {
      const result = await api.get<{ user: CurrentUser; unreadNotifications: number }>('/auth/me');
      localStorage.setItem('wfm_session_known', '1');
      setUser(result.user);
      setUnreadNotifications(result.unreadNotifications);
    } catch {
      localStorage.removeItem('wfm_session_known');
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    const onExpired = () => {
      if (localStorage.getItem('wfm_session_known')) sessionStorage.setItem('wfm_session_expired', '1');
      localStorage.removeItem('wfm_session_known');
      setUser(null);
      setLoading(false);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [refresh]);

  const login = useCallback((nextUser: CurrentUser) => {
    sessionStorage.removeItem('wfm_session_expired');
    localStorage.setItem('wfm_session_known', '1');
    setUser(nextUser);
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* clearing client state is enough */
    }
    setUser(null);
    localStorage.removeItem('wfm_session_known');
    window.location.href = '/login';
  }, []);

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
