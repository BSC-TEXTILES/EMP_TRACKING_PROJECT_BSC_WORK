import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { getNotificationPermission, requestNotificationPermission, type NotificationPermissionState } from '../lib/notifications';
import { useToast } from '../contexts/ToastContext';

export function NotificationPermissionBanner() {
  const [state, setState] = useState<NotificationPermissionState>('granted');
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const isDismissed = sessionStorage.getItem('bsc_notif_banner_dismissed') === '1';
    setDismissed(isDismissed);
    setState(getNotificationPermission());
  }, []);

  if (dismissed || state !== 'default') {
    return null;
  }

  const handleEnable = async () => {
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      setState(result);
      if (result === 'granted') {
        toast.success('Desktop & Windows notifications are now enabled!');
      } else if (result === 'denied') {
        toast.info('Notifications were blocked. You can enable them anytime in browser site settings.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem('bsc_notif_banner_dismissed', '1');
    setDismissed(true);
  };

  return (
    <div className="relative border-b border-blue-200 bg-gradient-to-r from-blue-50 via-sky-50 to-indigo-50 px-4 py-3 text-ink-800 shadow-sm">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
            <Icon name="bell" size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink-900">
              Enable Real-Time Desktop & Windows Notifications
            </p>
            <p className="text-xs text-ink-600">
              Receive live alerts for work assignments, approvals, daily reports, and incoming calls even when minimized.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleEnable}
            disabled={busy}
            className="btn-primary btn-sm rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold shadow-sm hover:bg-blue-700"
          >
            {busy ? 'Enabling…' : 'Enable Notifications'}
          </button>
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
