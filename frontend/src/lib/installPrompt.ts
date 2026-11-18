import { isNative } from './native';

/**
 * "Install app" support for the website (Progressive Web App).
 *
 * Chrome / Edge fire `beforeinstallprompt` once, early in the page load. It is
 * captured here at startup (this module is imported by main.tsx) so the popup
 * can offer a real one-tap Install button whenever it appears later.
 * Safari (iPhone / iPad) has no install event: the popup shows the
 * "Share → Add to Home Screen" steps instead.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'one-tap' | 'ios' | 'android-menu' | 'none';

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

const INSTALLED_KEY = 'bsc_pwa_installed';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

if (typeof window !== 'undefined' && !isNative) {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // show our own popup instead of the browser mini-bar
    deferred = event as BeforeInstallPromptEvent;
    // The browser only offers the prompt when the app is NOT installed.
    safeSet(INSTALLED_KEY, null);
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    safeSet(INSTALLED_KEY, 'true');
    notify();
    window.dispatchEvent(new CustomEvent('pwa:installed'));
  });
}

/** Running as the installed app (home-screen / desktop window) or the native app. */
export function runningInstalled(): boolean {
  if (isNative) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function markedInstalled(): boolean {
  return safeGet(INSTALLED_KEY) === 'true';
}

/** How this browser can install the app. */
export function installPlatform(): InstallPlatform {
  if (isNative || runningInstalled()) return 'none';
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // iPhone / iPad: Safari's "Add to Home Screen" is the only way (other iOS browsers can't install).
  if (iOS) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'none' : 'ios';
  if (deferred) return 'one-tap';
  // Android browsers without the install event (Firefox, Samsung Internet) have a menu item.
  if (/Android/.test(ua)) return 'android-menu';
  return 'none'; // desktop Firefox / Safari cannot install web apps
}

/** Shows the browser's own install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const event = deferred;
  deferred = null; // a prompt event can only be used once
  notify();
  await event.prompt();
  const choice = await event.userChoice;
  if (choice.outcome === 'accepted') safeSet(INSTALLED_KEY, 'true');
  return choice.outcome === 'accepted';
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Opens the install popup on request (e.g. Settings → Install app), ignoring an earlier "Not now". */
export function openInstallPopup(): void {
  window.dispatchEvent(new CustomEvent('pwa:open-install'));
}
