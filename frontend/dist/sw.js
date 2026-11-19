// BSC Textiles Workforce - Service Worker
// Handles Web Push while the app is closed, in the background, or the phone is locked:
//  - incoming calls: persistent ringing notification with Answer / Decline, re-alerted by the
//    server every ~10 s, replaced by "Missed call from X" or closed on cancel / timeout
//  - chat messages: one notification per conversation (title = sender, body = preview)
//  - everything else: generic notification that opens its deep link
// Every displayed push is acknowledged to /api/push/ack for the delivery log.
/* eslint-disable no-restricted-globals */

const SW_VERSION = '2026-11-19.2';
const APP_NAME = 'BSC Textiles Workforce';
const RING_VIBRATION = [900, 400, 900, 400, 900, 400, 900, 400, 900];
const MESSAGE_VIBRATION = [180, 90, 180];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION_READY', version: SW_VERSION });
  // The page tells the worker to drop a call notification (answered / ended in-app).
  if (event.data?.type === 'CLOSE_CALL_NOTIFICATION' && event.data.callId) {
    event.waitUntil(closeByTag(`call-${event.data.callId}`));
  }
});

// ------------------------------------------------------------------ helpers

async function windowClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

/** A page of this app that the user is looking at right now. */
async function visibleClient() {
  const list = await windowClients();
  return list.find((c) => c.visibilityState === 'visible' && c.focused) || null;
}

async function closeByTag(tag) {
  const open = await self.registration.getNotifications({ tag });
  open.forEach((n) => n.close());
}

function ack(token) {
  if (!token) return Promise.resolve();
  return fetch('/api/push/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ack: token }),
    credentials: 'omit',
    keepalive: true,
  }).catch(() => undefined);
}

function setBadge(count) {
  try {
    if (typeof count === 'number' && self.navigator.setAppBadge) {
      return count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge();
    }
  } catch {
    /* unsupported */
  }
  return Promise.resolve();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ push

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: APP_NAME, body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(handlePush(payload || {}));
});

async function handlePush(p) {
  const tasks = [];
  switch (p.kind) {
    case 'call_ring':
      tasks.push(showCallRing(p));
      break;
    case 'call_cancel':
      tasks.push(closeByTag(p.tag));
      break;
    case 'call_missed':
      tasks.push(showMissedCall(p));
      break;
    case 'chat':
      tasks.push(showChat(p));
      break;
    default:
      tasks.push(showGeneric(p));
  }
  tasks.push(ack(p.ack));
  if (p.data && typeof p.data.badge === 'number') tasks.push(setBadge(p.data.badge));
  await Promise.all(tasks);
}

async function showCallRing(p) {
  const call = p.call || {};
  const expiresAt = Number(call.expiresAt) || Date.now() + 45000;
  if (Date.now() >= expiresAt) return; // the call is already over; never ring late
  const inApp = await visibleClient();
  // The open app plays its own looping ringtone and full-screen UI; keep the notification quiet then.
  inApp?.postMessage({ type: 'CALL_RING', callId: call.callId });

  const tag = p.tag || `call-${call.callId}`;
  await self.registration.showNotification(p.title || 'Incoming call', {
    body: p.body || 'Incoming call',
    icon: p.icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag,
    renotify: !inApp, // re-alert (sound + vibration) on every server re-ring
    silent: Boolean(inApp),
    requireInteraction: true,
    vibrate: inApp ? undefined : RING_VIBRATION,
    timestamp: Date.now(),
    actions: [
      { action: 'answer', title: call.type === 'video' ? 'Answer video' : 'Answer' },
      { action: 'decline', title: 'Decline' },
    ],
    data: {
      kind: 'call_ring',
      callId: call.callId,
      callType: call.type,
      actionToken: call.actionToken,
      expiresAt,
      link: p.link || `/calls?incoming=${encodeURIComponent(call.callId)}`,
    },
  });

  // Best effort: remove the ring at the deadline even if the "missed" push is delayed.
  // (Browsers may stop the worker earlier; the server's call_missed / call_cancel push is the main path.)
  const remaining = Math.min(expiresAt - Date.now(), 50000);
  if (remaining > 0) {
    await wait(remaining + 1500);
    const still = await self.registration.getNotifications({ tag });
    still.filter((n) => n.data?.kind === 'call_ring' && Number(n.data.expiresAt) <= Date.now()).forEach((n) => n.close());
  }
}

async function showMissedCall(p) {
  await self.registration.showNotification(p.title || 'Missed call', {
    body: p.body || '',
    icon: p.icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: p.tag, // same tag as the ring: replaces it in place
    renotify: false,
    requireInteraction: false,
    vibrate: MESSAGE_VIBRATION,
    timestamp: Date.now(),
    actions: [{ action: 'open', title: 'View calls' }],
    data: { kind: 'call_missed', link: '/calls', callId: p.call?.callId },
  });
}

async function showChat(p) {
  const conversationId = p.data?.conversationId;
  const link = p.link || (conversationId ? `/chat?c=${conversationId}` : '/chat');
  // Already reading this exact chat: the page shows and sounds it.
  const client = await visibleClient();
  if (client && conversationId) {
    try {
      const url = new URL(client.url);
      if (url.pathname.startsWith('/chat') && url.searchParams.get('c') === String(conversationId)) return;
    } catch {
      /* ignore */
    }
  }
  // Group per conversation: one notification that counts and shows the latest message.
  const existing = await self.registration.getNotifications({ tag: p.tag });
  const previousCount = existing.reduce((max, n) => Math.max(max, Number(n.data?.count) || 1), 0);
  const count = previousCount + 1;
  await self.registration.showNotification(count > 1 ? `${p.title} (${count})` : p.title || 'New message', {
    body: p.body || 'New message',
    icon: p.icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: p.tag || `chat-${conversationId}`,
    renotify: true, // sound + vibration for every new message, even when grouped
    requireInteraction: false,
    vibrate: MESSAGE_VIBRATION,
    timestamp: Date.now(),
    actions: [{ action: 'open', title: 'Open chat' }],
    data: { kind: 'chat', link, conversationId, count },
  });
}

async function showGeneric(p) {
  const urgent = Boolean(p.urgent || p.requireInteraction || p.priority === 'high' || p.priority === 'critical');
  const link = p.link || p.data?.link || '/notifications';
  await self.registration.showNotification(p.title || APP_NAME, {
    body: p.body || 'You have a new update.',
    icon: p.icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    image: p.image || undefined,
    tag: p.tag || `bsc-notif-${Date.now()}`,
    renotify: true,
    requireInteraction: urgent,
    vibrate: urgent ? [300, 150, 300, 150, 300] : [200, 100, 200],
    timestamp: Date.now(),
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    data: { ...(p.data || {}), kind: 'notification', link },
  });
}

// ------------------------------------------------------------------ clicks

async function focusOrOpen(url, message) {
  const list = await windowClients();
  const client = list.find((c) => 'focus' in c);
  if (client) {
    // Keep the running app (and its live connection); it navigates in place.
    client.postMessage(message || { type: 'NAVIGATE', url });
    return client.focus();
  }
  return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
}

function callAction(callId, token, action) {
  return fetch('/api/calls/push-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId, token, action }),
    credentials: 'include',
    keepalive: true,
  }).catch(() => undefined);
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  const action = event.action;
  notification.close();

  if (action === 'dismiss') return;

  if (data.kind === 'call_ring') {
    if (Date.now() > Number(data.expiresAt || 0) + 2000) {
      event.waitUntil(focusOrOpen('/calls'));
      return;
    }
    if (action === 'decline') {
      event.waitUntil(callAction(data.callId, data.actionToken, 'decline'));
      return;
    }
    const answer = action === 'answer';
    const url = `/calls?incoming=${encodeURIComponent(data.callId)}${answer ? '&answer=1' : ''}`;
    event.waitUntil(focusOrOpen(url, { type: 'CALL_ACTION', action: answer ? 'answer' : 'show', callId: data.callId, url }));
    return;
  }

  event.waitUntil(focusOrOpen(data.link || '/notifications'));
});

// Swiping a ringing call away = "not answering": stop the re-rings and tell the caller.
self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  if (data.kind === 'call_ring' && data.callId && data.actionToken && Date.now() < Number(data.expiresAt || 0)) {
    event.waitUntil(callAction(data.callId, data.actionToken, 'missed'));
  }
});

// ------------------------------------------------------------------ subscription rotation

// Browsers can rotate or expire a subscription. Re-subscribe with the same key and register it
// again; if the user is signed out this fails and the app re-registers on its next start.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options?.applicationServerKey;
      if (!key) return;
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      const json = sub.toJSON();
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      }).catch(() => undefined);
    })(),
  );
});
