import { isNative, nativePlatform } from './native';
import { api } from './api';

let pushInitialized = false;
let currentDeviceToken: string | null = null;

/**
 * Initializes Native FCM Push Notifications for Android and iOS using @capacitor/push-notifications.
 * Safe to call on web (no-op).
 */
export async function initNativePushNotifications(onNavigate?: (link: string) => void): Promise<void> {
  if (!isNative || pushInitialized) return;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Check / request permissions
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }

    if (permStatus.receive !== 'granted') {
      console.warn('[NativePush] Notification permission not granted');
      return;
    }

    // Register with FCM / APNs
    await PushNotifications.register();
    pushInitialized = true;

    // Listen for FCM registration token
    await PushNotifications.addListener('registration', async (token: { value: string }) => {
      currentDeviceToken = token.value;
      console.log('[NativePush] FCM Device Token received:', token.value.slice(0, 15) + '...');
      try {
        await api.post('/push/devices', {
          token: token.value,
          platform: nativePlatform === 'ios' ? 'ios' : 'android',
        });
      } catch (err) {
        console.warn('[NativePush] Failed to register token with backend:', err);
      }
    });

    // Listen for registration error
    await PushNotifications.addListener('registrationError', (error: unknown) => {
      console.error('[NativePush] Error on push registration:', error);
    });

    // Listen for push notifications while app is in foreground
    await PushNotifications.addListener('pushNotificationReceived', (notification: { title?: string; body?: string; data?: Record<string, unknown> }) => {
      console.log('[NativePush] Push received in foreground:', notification.title);
      // Let app handle sound or in-app toast notification if needed
    });

    // Listen for notification tap action
    await PushNotifications.addListener('pushNotificationActionPerformed', (action: { notification: { data?: Record<string, string> } }) => {
      const data = action.notification.data;
      const link = data?.link || (data?.notificationId ? '/notifications' : '/');
      console.log('[NativePush] Push tapped, navigating to:', link);

      if (onNavigate) {
        onNavigate(link);
      } else if (typeof window !== 'undefined') {
        window.location.href = link;
      }
    });

  } catch (error) {
    console.warn('[NativePush] Native push initialization failed:', error);
  }
}

/**
 * Unregisters native push notifications on logout
 */
export async function unregisterNativePush(): Promise<void> {
  if (!isNative) return;

  try {
    if (currentDeviceToken) {
      await api.del('/push/devices').catch(() => undefined);
      currentDeviceToken = null;
    }

    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllListeners();
    pushInitialized = false;
  } catch (error) {
    console.warn('[NativePush] Unregister error:', error);
  }
}
