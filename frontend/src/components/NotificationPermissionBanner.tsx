import { useEffect, useState } from 'react';
import { Icon } from './icons';
import {
  getNotificationPermission,
  iosNeedsHomeScreen,
  isIos,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '../lib/notifications';
import { useToast } from '../contexts/ToastContext';
import { isNative } from '../lib/native';

const DISMISS_KEY = 'bsc_notif_banner_dismissed';

type BannerMode = 'ask' | 'denied' | 'ios-install' | null;

function bannerMode(state: NotificationPermissionState): BannerMode {
  if (isNative) return null; // the Capacitor app asks through the OS
  // iOS Safari exposes no Notification / PushManager until the app is on the Home Screen.
  if (iosNeedsHomeScreen()) return 'ios-install';
  if (state === 'default') return 'ask';
  if (state === 'denied') return 'denied';
  return null;
}

export function NotificationPermissionBanner() {
  const [state, setState] = useState<NotificationPermissionState>('granted');
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      /* ignore */
    }
    setState(getNotificationPermission());
    // The user may change the permission in browser settings and come back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') setState(getNotificationPermission());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const mode = bannerMode(state);
  if (dismissed || !mode) return null;

  const handleEnable = async () => {
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      setState(result);
      if (result === 'granted') {
        toast.success('Notifications are on. Calls and messages will ring on this device, even when the app is closed.');
      } else if (result === 'denied') {
        toast.info('Notifications were blocked. Calls will only ring while the app is open.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  const tone = mode === 'denied' ? 'border-amber-200 from-amber-50 via-orange-50 to-amber-50' : 'border-blue-200 from-blue-50 via-sky-50 to-indigo-50';
  const title = mode === 'ask'
    ? 'Turn on notifications to hear calls and messages'
    : mode === 'denied'
      ? 'Notifications are blocked on this device'
      : 'Add this app to your Home Screen to receive calls';
  const text = mode === 'ask'
    ? 'Incoming calls ring and new messages alert you even when the app is closed, in the background or the phone is locked.'
    : mode === 'denied'
      ? isIos()
        ? 'You will miss calls while the app is closed. Open iPhone Settings › Notifications › BSC Workforce and allow notifications.'
        : 'You will miss calls while the app is closed. Tap the lock icon next to the address (or App info › Notifications) and allow notifications, then reopen the app.'
      : 'On iPhone, notifications only work for the installed app: tap Share, then "Add to Home Screen", and open the app from there (iOS 16.4 or later).';

  return (
    <div className={`relative border-b bg-gradient-to-r px-4 py-3 text-ink-800 shadow-sm ${tone}`} role="status">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-sm ${mode === 'denied' ? 'bg-amber-500' : 'bg-blue-600'}`}>
            <Icon name="bell" size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink-900">{title}</p>
            <p className="text-xs text-ink-600">{text}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {mode === 'ask' && (
            <button
              type="button"
              onClick={handleEnable}
              disabled={busy}
              className="btn-primary btn-sm rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold shadow-sm hover:bg-blue-700"
            >
              {busy ? 'Enabling…' : 'Turn on notifications'}
            </button>
          )}
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-700"
            aria-label="Dismiss banner"
            title="Dismiss for this session"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
