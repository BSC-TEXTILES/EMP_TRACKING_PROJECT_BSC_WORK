// BSC Textiles Workforce - Service Worker for Desktop & Mobile Web Push Notifications
/* eslint-disable no-restricted-globals */

self.addEventListener('install', (event) => {
  // Activate immediately without waiting for existing tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim control over all open clients immediately
  event.waitUntil(self.clients.claim());
});

// Push notification received from Web Push / VAPID
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch (err) {
    payload = {
      title: 'BSC Textiles Workforce',
      body: event.data.text() || 'New workforce notification received',
    };
  }

  const title = payload.title || 'BSC Textiles Workforce';
  const urgent = payload.priority === 'high' || payload.priority === 'critical' || payload.requireInteraction;

  const options = {
    body: payload.body || 'You have a new update in BSC Textiles Workforce.',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/badge-72.png',
    image: payload.image || undefined,
    tag: payload.tag || `bsc-notif-${Date.now()}`,
    data: payload.data || { link: '/notifications' },
    renotify: true,
    requireInteraction: urgent || false,
    vibrate: urgent ? [300, 150, 300, 150, 300] : [200, 100, 200],
    actions: payload.actions || [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// User clicked notification or action button
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  if (action === 'dismiss') return;

  const targetLink = event.notification.data?.link || '/notifications';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If a tab is already open on this origin, focus it and navigate
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            client.navigate(targetLink);
          }
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetLink);
      }
    }),
  );
});

// Notification closed by user without clicking
self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data;
  // If an incoming call notification was dismissed, mark call as missed
  if (data?.type === 'incoming_call' && data?.notificationId) {
    // Best-effort background notification
  }
});
