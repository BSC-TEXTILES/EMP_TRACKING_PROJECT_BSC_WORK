import { api } from './api';

/** Converts base64 url VAPID public key to Uint8Array for PushManager */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export function getNotificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission as NotificationPermissionState;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Requests desktop notification permission and registers Web Push subscription with backend
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isWebPushSupported()) {
    return 'unsupported';
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await registerWebPushSubscription().catch((err) => {
        console.warn('[Push] Auto-subscription error:', err);
      });
      // Play a quick chime to confirm audio/notification setup
      playNotificationSound('chime');
    }
    return permission as NotificationPermissionState;
  } catch (error) {
    console.error('[Notification] Permission request failed:', error);
    return 'denied';
  }
}

/**
 * Subscribes current browser session to Web Push (VAPID)
 */
export async function registerWebPushSubscription(): Promise<boolean> {
  if (!isWebPushSupported() || Notification.permission !== 'granted') {
    return false;
  }

  try {
    const vapidRes = await api.get<{ publicKey: string }>('/push/vapid-key');
    if (!vapidRes?.publicKey) return false;

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const applicationServerKey = urlBase64ToUint8Array(vapidRes.publicKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as unknown as BufferSource,
      });
    }

    const subJson = subscription.toJSON();
    if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
      await api.post('/push/subscribe', {
        endpoint: subJson.endpoint,
        keys: {
          p256dh: subJson.keys.p256dh,
          auth: subJson.keys.auth,
        },
      });
      console.log('[Push] Successfully subscribed to Web Push');
      return true;
    }
    return false;
  } catch (error) {
    console.warn('[Push] Web push subscription failed:', error);
    return false;
  }
}

/**
 * Shows a native Windows desktop or mobile notification
 */
export async function showDesktopNotification(
  title: string,
  options: {
    body?: string | null;
    link?: string | null;
    icon?: string;
    tag?: string;
    urgent?: boolean;
  } = {},
): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const urgent = options.urgent || false;
  const notifOptions: NotificationOptions = {
    body: options.body || 'New workforce update',
    icon: options.icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: options.tag || `bsc_${Date.now()}`,
    data: { link: options.link || '/notifications' },
    requireInteraction: urgent,
  };

  playNotificationSound(urgent ? 'urgent' : 'chime');

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration && registration.showNotification) {
        await registration.showNotification(title, notifOptions);
        return;
      }
    }
  } catch {
    /* fallback to window.Notification */
  }

  try {
    const notif = new Notification(title, notifOptions);
    notif.onclick = () => {
      window.focus();
      if (options.link) {
        window.location.href = options.link;
      }
      notif.close();
    };
  } catch (err) {
    console.warn('[Notification] Failed to display notification:', err);
  }
}

/**
 * Synthesizes crisp notification audio without external asset dependencies
 */
export function playNotificationSound(kind: 'chime' | 'urgent' | 'call' = 'chime'): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    void ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (kind === 'urgent' || kind === 'call') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(659.25, now); // E5
      osc.frequency.setValueAtTime(880, now + 0.12); // A5
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } else {
      // Pleasant subtle two-tone chime (C6 -> G6)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(783.99, now + 0.08);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch {
    /* audio blocked or unsupported */
  }
}
