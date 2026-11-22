import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cx } from '../lib/format';

export type ToastTone =
  | 'success'
  | 'error'
  | 'info'
  | 'warning'
  | 'approval'
  | 'tracking_offline'
  | 'sync';

interface Toast {
  id: number;
  message: string;
  title?: string;
  tone: ToastTone;
  createdAt: number;
}

export interface ToastContextValue {
  toast: (message: string, tone?: ToastTone, title?: string, durationMs?: number) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  approval: (message: string, title?: string) => void;
  trackingOffline: (message: string, title?: string) => void;
  sync: (message: string, title?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = 'info', title?: string, durationMs = 4500) => {
      counter += 1;
      const id = counter;
      const newToast: Toast = { id, message, title, tone, createdAt: Date.now() };

      setToasts((prev) => {
        // Keep at most 4 stacked notifications at a time to prevent screen clogging
        const trimmed = prev.length >= 4 ? prev.slice(prev.length - 3) : prev;
        return [...trimmed, newToast];
      });

      if (durationMs > 0) {
        window.setTimeout(() => {
          dismiss(id);
        }, durationMs);
      }
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (message, title) => toast(message, 'success', title),
      error: (message, title) => toast(message, 'error', title),
      info: (message, title) => toast(message, 'info', title),
      warning: (message, title) => toast(message, 'warning', title),
      approval: (message, title) => toast(message, 'approval', title ?? 'Approval Action'),
      trackingOffline: (message, title) => toast(message, 'tracking_offline', title ?? 'Tracking Offline'),
      sync: (message, title) => toast(message, 'sync', title ?? 'Data Synchronized'),
      dismiss,
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Strict Top-Right Notification Container */}
      <div
        aria-live="polite"
        className="fixed top-4 right-4 sm:top-5 sm:right-5 z-[9999] flex w-[min(94vw,400px)] flex-col gap-2.5 pointer-events-none"
      >
        {toasts.map((item) => {
          const isSuccess = item.tone === 'success';
          const isError = item.tone === 'error';
          const isWarning = item.tone === 'warning';
          const isApproval = item.tone === 'approval';
          const isOffline = item.tone === 'tracking_offline';
          const isSync = item.tone === 'sync';
          const isInfo = item.tone === 'info';

          return (
            <div
              key={item.id}
              role="alert"
              className={cx(
                'pointer-events-auto flex items-start gap-3 rounded-xl border p-3.5 shadow-xl transition-all duration-200 animate-in slide-in-from-top-3 fade-in backdrop-blur-md',
                isSuccess && 'border-emerald-300 bg-emerald-50/95 text-emerald-950 dark:border-emerald-700/60 dark:bg-emerald-950/90 dark:text-emerald-100',
                isError && 'border-rose-300 bg-rose-50/95 text-rose-950 dark:border-rose-700/60 dark:bg-rose-950/90 dark:text-rose-100',
                isWarning && 'border-amber-300 bg-amber-50/95 text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/90 dark:text-amber-100',
                isApproval && 'border-indigo-300 bg-indigo-50/95 text-indigo-950 dark:border-indigo-700/60 dark:bg-indigo-950/90 dark:text-indigo-100',
                isOffline && 'border-orange-300 bg-orange-50/95 text-orange-950 dark:border-orange-700/60 dark:bg-orange-950/90 dark:text-orange-100',
                isSync && 'border-cyan-300 bg-cyan-50/95 text-cyan-950 dark:border-cyan-700/60 dark:bg-cyan-950/90 dark:text-cyan-100',
                isInfo && 'border-blue-300 bg-white/95 text-ink-900 dark:border-blue-700/60 dark:bg-slate-900/90 dark:text-ink-100',
              )}
            >
              {/* Tone Icon Badge */}
              <span
                className={cx(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white shadow-xs',
                  isSuccess && 'bg-emerald-600',
                  isError && 'bg-rose-600',
                  isWarning && 'bg-amber-600',
                  isApproval && 'bg-indigo-600',
                  isOffline && 'bg-orange-600',
                  isSync && 'bg-cyan-600',
                  isInfo && 'bg-brand-600',
                )}
              >
                {isSuccess && '✓'}
                {isError && '✕'}
                {isWarning && '⚠'}
                {isApproval && '★'}
                {isOffline && '⚡'}
                {isSync && '↻'}
                {isInfo && 'ℹ'}
              </span>

              {/* Message Content */}
              <div className="min-w-0 flex-1">
                {item.title ? (
                  <p className="text-xs font-bold tracking-tight mb-0.5 uppercase opacity-90">
                    {item.title}
                  </p>
                ) : null}
                <p className="text-xs sm:text-sm font-medium leading-snug break-words">
                  {item.message}
                </p>
              </div>

              {/* Dismiss Button */}
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="shrink-0 rounded-md p-1 text-ink-400 hover:text-ink-700 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                aria-label="Dismiss notification"
              >
                <span className="text-sm font-bold leading-none">✕</span>
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
