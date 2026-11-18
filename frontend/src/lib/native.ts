import { Capacitor } from '@capacitor/core';

/**
 * Mobile app (Capacitor) integration. Everything here is a no-op on the
 * website: `isNative` is false in a normal browser.
 *
 * The app runs on its own origin (https://localhost on Android,
 * capacitor://localhost on iOS), so it talks to the API by absolute URL and
 * authenticates with Bearer tokens kept in the Android Keystore / iOS Keychain
 * (never localStorage). See docs/MOBILE_BACKEND.md.
 */

export const isNative = Capacitor.isNativePlatform();
export const nativePlatform = Capacitor.getPlatform() as 'android' | 'ios' | 'web';

/** Production API. Override at build time with VITE_MOBILE_API_ORIGIN (e.g. a staging server). */
export const API_ORIGIN = String(import.meta.env.VITE_MOBILE_API_ORIGIN || 'https://emptrack.bsctextiles.in').replace(/\/+$/, '');

export interface NativeTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
}

const TOKENS_KEY = 'session_tokens';
let tokens: NativeTokens | null = null;
let media: { token: string; expiresAt: number } | null = null;

async function secureStorage() {
  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
  return SecureStorage;
}

/** Loads the stored session before the app renders. */
export async function initNativeSession(): Promise<void> {
  if (!isNative) return;
  try {
    const storage = await secureStorage();
    await storage.setKeyPrefix('bscwf_');
    const stored = await storage.get(TOKENS_KEY);
    if (stored && typeof stored === 'object' && 'refreshToken' in stored) {
      tokens = stored as unknown as NativeTokens;
      // Lets the existing session bootstrap (AuthContext) try /auth/me.
      localStorage.setItem('wfm_session_known', '1');
    } else {
      localStorage.removeItem('wfm_session_known');
    }
  } catch {
    // Keychain/Keystore unreadable (for example after a device restore): sign in again.
    tokens = null;
    localStorage.removeItem('wfm_session_known');
  }
}

export function nativeTokens(): NativeTokens | null {
  return tokens;
}

export async function setNativeTokens(next: NativeTokens | null): Promise<void> {
  tokens = next;
  if (!next) media = null;
  if (!isNative) return;
  try {
    const storage = await secureStorage();
    if (next) await storage.set(TOKENS_KEY, { ...next });
    else await storage.remove(TOKENS_KEY);
  } catch {
    /* the in-memory session still works until the app is closed */
  }
}

export function setMediaToken(next: { token: string; expiresAt: number } | null): void {
  media = next;
}

export function mediaTokenExpiresAt(): number {
  return media?.expiresAt ?? 0;
}

/**
 * Turns an API-relative URL ("/api/files/12") into one the app can load in
 * <img>, <video> or a download link: absolute API origin plus a short-lived
 * media token for file and export URLs. Unchanged on the website.
 */
export function mediaUrl<T extends string | null | undefined>(src: T): T {
  if (!isNative || !src) return src;
  let path: string = src;
  if (/^(data:|blob:)/i.test(path)) return src;
  if (/^https?:\/\//i.test(path)) {
    if (!path.startsWith(API_ORIGIN)) return src;
    path = path.slice(API_ORIGIN.length);
  }
  if (!path.startsWith('/')) return src;
  const absolute = `${API_ORIGIN}${path}`;
  const needsToken = /^\/api\/(files\/\d+|exports)(\/|\?|$)/.test(path) && !/[?&]mt=/.test(path);
  if (!needsToken || !media) return absolute as T;
  return `${absolute}${absolute.includes('?') ? '&' : '?'}mt=${encodeURIComponent(media.token)}` as T;
}

/**
 * Opens a URL outside the app's web view: in-app browser tab on the phone
 * (downloads, exports, external sites), normal navigation on the website.
 */
export async function openExternal(url: string, newTab = false): Promise<void> {
  if (!isNative) {
    if (newTab) window.open(url, '_blank', 'noopener');
    else window.location.href = url;
    return;
  }
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: mediaUrl(url) });
}
