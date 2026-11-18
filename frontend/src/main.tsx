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
// Captures the browser's one-time install event before any screen renders.
import './lib/installPrompt';

initTheme();
if (isNative) document.documentElement.dataset.native = '1';

// Register Service Worker for PWA (website only; the app ships its files itself)
if (!isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('[SW] Service Worker registered:', registration.scope);
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
