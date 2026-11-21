import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { App } from './App';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { RealtimeProvider } from './contexts/RealtimeContext';
import { NativeShell } from './components/mobile/NativeShell';
import { initNativeSession, isNative } from './lib/native';
import { initTheme } from './lib/theme';
import { registerWebPushSubscription } from './lib/notifications';
import { initOutbox } from './lib/outbox';
import { initErrorTracking } from './lib/errorTracking';
// Captures the browser's one-time install event before any screen renders.
import './lib/installPrompt';

initTheme();
initErrorTracking();
if (isNative) document.documentElement.dataset.native = '1';

// Global recovery for stale bundle chunks across all dynamically imported routes.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const key = 'vite_chunk_reload_lock';
  const last = parseInt(sessionStorage.getItem(key) || '0', 10);
  const now = Date.now();
  if (now - last > 15000) {
    sessionStorage.setItem(key, String(now));
    window.location.reload();
  }
});

// Chat messages written offline are re-sent automatically when the connection returns.
initOutbox();

// Register Service Worker for PWA (website only; the app ships its files itself)
if (!isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' so a fixed sw.js reaches phones on the next start, not after 24 h.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        void registration.update().catch(() => undefined);
        if ('Notification' in window && Notification.permission === 'granted') {
          void registerWebPushSubscription();
        }
        
        // Check for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New version available
                window.dispatchEvent(new CustomEvent('sw:update', { detail: registration }));
              }
            });
          }
        });
      })
      .catch((error) => {
        console.error('[SW] Registration failed:', error);
      });
  });

  // Handle messages from service worker
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'VERSION_READY') {
      console.log('[SW] Version ready:', event.data.version);
    }
    if (event.data?.type === 'UPDATE_CHECK') {
      // Handle update notification
      console.log('[SW] Update check:', event.data.manifest);
    }
    if (event.data?.type === 'SYNC_COMPLETE') {
      window.dispatchEvent(new CustomEvent('sw:sync-complete'));
    }
    if (event.data?.type === 'NAVIGATE') {
      window.dispatchEvent(new CustomEvent('sw:navigate', { detail: event.data.url }));
    }
    // Notification "Answer" / tap on a ringing call while the app is already running.
    if (event.data?.type === 'CALL_ACTION') {
      window.dispatchEvent(new CustomEvent('sw:call-action', { detail: event.data }));
    }
    // A ring push arrived while the app is in the foreground: make sure the in-app ring is showing.
    if (event.data?.type === 'CALL_RING') {
      window.dispatchEvent(new CustomEvent('sw:call-ring', { detail: event.data }));
    }
  });
}

// The app reads its stored session from the Keychain / Keystore before the first render.
void initNativeSession().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <RealtimeProvider>
              <NativeShell>
                <App />
              </NativeShell>
            </RealtimeProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
