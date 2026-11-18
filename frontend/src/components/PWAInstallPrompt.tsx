import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import {
  installPlatform,
  markedInstalled,
  onInstallChange,
  promptInstall,
  runningInstalled,
  type InstallPlatform,
} from '../lib/installPrompt';
import { Icon } from './icons';

const DISMISSED_KEY = 'bsc_pwa_dismissed_at';
const DISMISS_DAYS = 3;
const SHOW_AFTER_MS = 4000;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY) || 0);
    return Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

/**
 * "Install app" popup for the website. Appears a few seconds after the page
 * loads when this browser can install the app, and never inside the installed
 * app itself. "Not now" hides it for 3 days; Settings → Install app reopens it.
 *
 * - Chrome / Edge (Windows, Mac, Android): one-tap Install button.
 * - iPhone / iPad Safari: Share → Add to Home Screen steps.
 * - Other Android browsers: browser menu → Install app.
 */
export function PWAInstallPrompt() {
  const { user } = useAuth();
  const [platform, setPlatform] = useState<InstallPlatform>(() => installPlatform());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Track the browser's install capability (the install event can arrive at any time).
  useEffect(() => onInstallChange(() => setPlatform(installPlatform())), []);

  // Show automatically once, a few seconds after load, unless dismissed or installed.
  useEffect(() => {
    if (runningInstalled()) return;
    const timer = window.setTimeout(() => {
      const p = installPlatform();
      setPlatform(p);
      if (p !== 'none' && !dismissedRecently() && !(markedInstalled() && p !== 'one-tap')) setOpen(true);
    }, SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Opened on request (Settings) and closed when the browser reports the install.
  useEffect(() => {
    const show = () => {
      setPlatform(installPlatform());
      setDone(false);
      setOpen(true);
    };
    const installed = () => {
      setOpen(false);
      setDone(true);
      if (user) {
        void api.post('/devices/register', {
          deviceType: /Android/.test(navigator.userAgent) ? 'android' : /iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : 'desktop',
          isInstalled: true,
          isStandalone: false,
          userAgent: navigator.userAgent,
          screenWidth: screen.width,
          screenHeight: screen.height,
          pixelRatio: window.devicePixelRatio,
        }).catch(() => undefined);
      }
    };
    window.addEventListener('pwa:open-install', show);
    window.addEventListener('pwa:installed', installed);
    return () => {
      window.removeEventListener('pwa:open-install', show);
      window.removeEventListener('pwa:installed', installed);
    };
  }, [user]);

  // Success note disappears on its own.
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 8000);
    return () => window.clearTimeout(timer);
  }, [done]);

  const notNow = () => {
    setOpen(false);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      /* storage blocked */
    }
  };

  const install = async () => {
    setBusy(true);
    try {
      const accepted = await promptInstall();
      if (accepted) {
        setOpen(false);
        setDone(true);
      } else {
        notNow();
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Popup>
        <div className="flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Icon name="checkCircle" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-900">App installed</p>
            <p className="text-xs text-ink-500">Open BSC Workforce from your home screen, Start menu or app launcher.</p>
          </div>
          <CloseButton onClick={() => setDone(false)} />
        </div>
      </Popup>
    );
  }

  if (!open || platform === 'none') return null;

  return (
    <Popup labelledBy="pwa-install-title">
      <div className="flex items-start gap-3 p-4">
        <img src="/icons/icon-192.png" alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-xl shadow-sm" />
        <div className="min-w-0 flex-1">
          <p id="pwa-install-title" className="text-sm font-semibold text-ink-900">Install the BSC Workforce app</p>
          <p className="mt-0.5 text-xs text-ink-500">Opens in its own window from your home screen or desktop, starts faster, and keeps you signed in.</p>
        </div>
        <CloseButton onClick={notNow} />
      </div>

      {platform === 'ios' && (
        <ol className="mx-4 mb-3 space-y-1.5 rounded-lg bg-ink-50 p-3 text-xs text-ink-700">
          <li className="flex items-center gap-2">
            <Step n={1} /> Tap <b>Share</b> <ShareGlyph /> in Safari's toolbar
          </li>
          <li className="flex items-center gap-2">
            <Step n={2} /> Choose <b>Add to Home Screen</b>
          </li>
          <li className="flex items-center gap-2">
            <Step n={3} /> Tap <b>Add</b>
          </li>
        </ol>
      )}
      {platform === 'android-menu' && (
        <ol className="mx-4 mb-3 space-y-1.5 rounded-lg bg-ink-50 p-3 text-xs text-ink-700">
          <li className="flex items-center gap-2">
            <Step n={1} /> Open the browser menu <b>⋮</b>
          </li>
          <li className="flex items-center gap-2">
            <Step n={2} /> Tap <b>Install app</b> or <b>Add to Home screen</b>
          </li>
        </ol>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-ink-100 px-4 py-3">
        <button type="button" className="btn-ghost btn-sm" onClick={notNow}>Not now</button>
        {platform === 'one-tap' ? (
          <button type="button" className="btn-primary btn-sm" onClick={() => void install()} disabled={busy}>
            <Icon name="download" size={14} /> {busy ? 'Installing…' : 'Install'}
          </button>
        ) : (
          <button type="button" className="btn-primary btn-sm" onClick={notNow}>Got it</button>
        )}
      </div>
    </Popup>
  );
}

function Popup({ children, labelledBy }: { children: React.ReactNode; labelledBy?: string }) {
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      className="no-print fixed inset-x-3 bottom-3 z-[60] sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[380px] safe-bottom"
    >
      <div className="overflow-hidden rounded-xl border border-ink-200 bg-surface shadow-2xl animate-[pwa-in_.25s_ease-out]">
        {children}
      </div>
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Close" className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600">
      <Icon name="x" size={16} />
    </button>
  );
}

function Step({ n }: { n: number }) {
  return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-700">{n}</span>;
}

/** The iOS share icon (square with an up arrow). */
function ShareGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-700" aria-label="Share icon">
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}
