import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { isNative } from '../../lib/native';
import { resolvedTheme } from '../../lib/theme';
import { Icon } from '../icons';

/**
 * Native-only behaviour for the Android / iOS app. Renders its children
 * unchanged on the website.
 *
 * - hides the splash screen once the session check has finished;
 * - matches the status/navigation bar icons to the light or dark theme;
 * - Android back button: closes an open dialog, else goes back, else leaves
 *   the app in the background from a top-level screen;
 * - full-screen "No internet connection" state with retry.
 */
export function NativeShell({ children }: { children: ReactNode }) {
  if (!isNative) return <>{children}</>;
  return <NativeShellInner>{children}</NativeShellInner>;
}

const TOP_LEVEL = new Set(['/', '/login', '/attendance', '/tasks', '/chat']);

function NativeShellInner({ children }: { children: ReactNode }) {
  const { loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const online = useOnline();

  // Splash stays up until we know whether the user is signed in (no login flash).
  useEffect(() => {
    if (loading) return;
    void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide({ fadeOutDuration: 200 })).catch(() => undefined);
  }, [loading]);

  // Status / navigation bar icon colour follows the theme.
  useEffect(() => {
    const apply = () => {
      void import('@capacitor/core').then(({ SystemBars, SystemBarsStyle }) =>
        SystemBars.setStyle({ style: resolvedTheme() === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }),
      ).catch(() => undefined);
    };
    apply();
    window.addEventListener('theme:changed', apply);
    return () => window.removeEventListener('theme:changed', apply);
  }, []);

  // Android hardware / gesture back.
  useEffect(() => {
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(async ({ App }) => {
      const handle = await App.addListener('backButton', ({ canGoBack }) => {
        if (document.querySelector('[role="dialog"]')) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return;
        }
        if (window.dispatchEvent(new CustomEvent('native:back', { cancelable: true })) === false) return;
        if (canGoBack && !TOP_LEVEL.has(pathRef.current)) navigate(-1);
        else if (pathRef.current !== '/' && pathRef.current !== '/login') navigate('/', { replace: true });
        else void App.minimizeApp();
      });
      remove = () => void handle.remove();
    });
    return () => remove?.();
  }, [navigate]);

  return (
    <>
      {children}
      {!online && <OfflineScreen />}
    </>
  );
}

/** Connectivity: Capacitor Network plugin in the app, browser events on the web. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    if (!isNative) {
      const up = () => setOnline(true);
      const down = () => setOnline(false);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return () => {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      };
    }
    let cancelled = false;
    let remove: (() => void) | undefined;
    void import('@capacitor/network').then(async ({ Network }) => {
      const status = await Network.getStatus();
      if (!cancelled) setOnline(status.connected);
      const handle = await Network.addListener('networkStatusChange', (s) => setOnline(s.connected));
      if (cancelled) void handle.remove();
      else remove = () => void handle.remove();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);
  return online;
}

function OfflineScreen() {
  const [checking, setChecking] = useState(false);
  const retry = async () => {
    setChecking(true);
    try {
      const { Network } = await import('@capacitor/network');
      const status = await Network.getStatus();
      if (status.connected) window.dispatchEvent(new Event('online'));
    } finally {
      window.setTimeout(() => setChecking(false), 600);
    }
  };
  return (
    <div role="alert" className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-ink-100 px-8 text-center safe-pad">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-ink-200 text-ink-600">
        <Icon name="wifiOff" size={30} />
      </span>
      <div>
        <p className="text-lg font-semibold text-ink-900">No internet connection</p>
        <p className="mt-1 text-sm text-ink-500">Check Wi-Fi or mobile data. The app reconnects on its own when the connection is back.</p>
      </div>
      <button type="button" className="btn-primary" onClick={() => void retry()} disabled={checking}>
        {checking ? 'Checking…' : 'Try again'}
      </button>
    </div>
  );
}

/**
 * Pull down at the top of a screen to reload it. The page subtree is remounted,
 * so every screen reloads its data the same way it does on first open.
 */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => void; children: ReactNode }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<{ y: number; x: number } | null>(null);
  const THRESHOLD = 70;

  const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    // Ignore pulls that begin inside a scrollable panel (chat, lists, maps) or a dialog.
    const target = event.target as HTMLElement;
    if (!atTop() || refreshing || target.closest('[data-no-pull], [role="dialog"], .scroll-area, input, textarea, select')) {
      start.current = null;
      return;
    }
    start.current = { y: event.touches[0].clientY, x: event.touches[0].clientX };
  }, [refreshing]);

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    if (!start.current) return;
    const dy = event.touches[0].clientY - start.current.y;
    const dx = Math.abs(event.touches[0].clientX - start.current.x);
    if (dy <= 0 || dx > dy || !atTop()) {
      setPull(0);
      return;
    }
    setPull(Math.min(110, dy * 0.5));
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!start.current) return;
    start.current = null;
    if (pull >= THRESHOLD) {
      setRefreshing(true);
      setPull(THRESHOLD);
      onRefresh();
      window.setTimeout(() => {
        setRefreshing(false);
        setPull(0);
      }, 700);
    } else {
      setPull(0);
    }
  }, [onRefresh, pull]);

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={() => { start.current = null; setPull(0); }}>
      <div
        aria-hidden={!refreshing}
        className="pointer-events-none flex items-end justify-center overflow-hidden text-ink-500 transition-[height] duration-150"
        style={{ height: pull }}
      >
        <span className={`mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-surface shadow ${refreshing ? 'animate-spin' : ''}`}
          style={{ transform: refreshing ? undefined : `rotate(${pull * 3}deg)`, opacity: Math.min(1, pull / THRESHOLD) }}>
          <Icon name="refreshCw" size={16} />
        </span>
      </div>
      {children}
    </div>
  );
}
