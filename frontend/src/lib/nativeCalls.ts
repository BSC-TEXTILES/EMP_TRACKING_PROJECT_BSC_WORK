import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { API_ORIGIN, isNative, nativePlatform } from './native';

/**
 * Bridge to the native Android call layer (android/app/src/main/java/.../calls).
 *
 * On Android the phone rings natively (full-screen over the lock screen, looping ringtone,
 * Telecom / Bluetooth integration) from a data-only FCM push, even when the app is closed.
 * The web app still runs the WebRTC call itself; this bridge keeps both sides in sync.
 * Every function is a safe no-op on the website and on iOS.
 */

export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth' | 'wired';

export interface NativeCallCapabilities {
  nativeCalls: boolean;
  notifications: boolean;
  fullScreenIntent: boolean;
  telecom: boolean;
  sdk: number;
  manufacturer?: string;
  model?: string;
}

export interface NativeCallAction {
  action: 'answer' | 'declined' | 'hangup' | 'missed';
  callId: string;
}

interface CallBridgePlugin {
  configure(options: { apiOrigin: string; fcmToken?: string }): Promise<void>;
  getLaunchAction(): Promise<{ action?: NativeCallAction }>;
  capabilities(): Promise<NativeCallCapabilities>;
  openFullScreenIntentSettings(): Promise<void>;
  openBatterySettings(): Promise<void>;
  dismissIncoming(options: { callId: string; reason: 'answered' | 'declined' | 'cancelled' | 'missed' | 'local' }): Promise<void>;
  callStarted(options: { callId: string; peerName: string; video: boolean }): Promise<void>;
  callEnded(options: { callId: string; reason?: string }): Promise<void>;
  getAudioRoutes(): Promise<{ routes: AudioRoute[]; current: AudioRoute }>;
  setAudioRoute(options: { route: AudioRoute }): Promise<{ route: AudioRoute; via: string }>;
  addListener(event: 'callAction', handler: (action: NativeCallAction) => void): Promise<PluginListenerHandle>;
  addListener(event: 'callPush', handler: (data: Record<string, string>) => void): Promise<PluginListenerHandle>;
}

/** True only inside the Android app build that contains the native call layer. */
export const hasNativeCalls = isNative && nativePlatform === 'android';

const CallBridge = registerPlugin<CallBridgePlugin>('CallBridge');

function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!hasNativeCalls) return Promise.resolve(fallback);
  return fn().catch((error) => {
    console.warn('[nativeCalls]', error);
    return fallback;
  });
}

let configured = false;
export function configureNativeCalls(fcmToken?: string): Promise<void> {
  if (configured && !fcmToken) return Promise.resolve();
  configured = true;
  return safe(() => CallBridge.configure({ apiOrigin: API_ORIGIN, ...(fcmToken ? { fcmToken } : {}) }), undefined);
}

export const nativeCalls = {
  capabilities: () => safe(() => CallBridge.capabilities(), null as NativeCallCapabilities | null),
  launchAction: () => safe(async () => (await CallBridge.getLaunchAction()).action ?? null, null as NativeCallAction | null),
  openFullScreenSettings: () => safe(() => CallBridge.openFullScreenIntentSettings(), undefined),
  openBatterySettings: () => safe(() => CallBridge.openBatterySettings(), undefined),
  dismissIncoming: (callId: string, reason: 'answered' | 'declined' | 'cancelled' | 'missed' | 'local') =>
    safe(() => CallBridge.dismissIncoming({ callId, reason }), undefined),
  callStarted: (callId: string, peerName: string, video: boolean) => safe(() => CallBridge.callStarted({ callId, peerName, video }), undefined),
  callEnded: (callId: string, reason?: string) => safe(() => CallBridge.callEnded({ callId, reason }), undefined),
  audioRoutes: () => safe(() => CallBridge.getAudioRoutes(), null as { routes: AudioRoute[]; current: AudioRoute } | null),
  setAudioRoute: (route: AudioRoute) => {
    if (!hasNativeCalls) return Promise.reject(new Error('not native'));
    return CallBridge.setAudioRoute({ route });
  },
  onAction: async (handler: (action: NativeCallAction) => void): Promise<() => void> => {
    if (!hasNativeCalls) return () => undefined;
    const handle = await CallBridge.addListener('callAction', handler);
    return () => void handle.remove();
  },
};
