import { isNative } from './native';

/**
 * Light / dark theme. The choice is per device (localStorage). The website
 * keeps its light look unless the user picks otherwise; the mobile app follows
 * the phone's setting by default. Colours are remapped in theme-dark.css.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'wfm_theme';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function themePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage blocked */
  }
  return isNative ? 'system' : 'light';
}

export function resolvedTheme(pref = themePreference()): 'light' | 'dark' {
  if (pref === 'system') return media?.matches ? 'dark' : 'light';
  return pref;
}

export function applyTheme(): void {
  const theme = resolvedTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b1220' : '#1d4ed8');
  window.dispatchEvent(new CustomEvent('theme:changed', { detail: theme }));
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage blocked: still applies for this session */
  }
  applyTheme();
}

/** Applies the theme now (before first paint) and follows OS changes. */
export function initTheme(): void {
  applyTheme();
  media?.addEventListener?.('change', () => {
    if (themePreference() === 'system') applyTheme();
  });
}
