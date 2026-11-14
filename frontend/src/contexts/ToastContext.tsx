import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cx } from '../lib/format';

type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, tone: ToastTone = 'info') => {
    counter += 1;
    const id = counter;
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4500);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (message: string) => toast(message, 'success'),
      error: (message: string) => toast(message, 'error'),
      info: (message: string) => toast(message, 'info'),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cx(
              'flex items-start gap-2 rounded-lg border px-3.5 py-3 text-sm shadow-lg',
              item.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              item.tone === 'error' && 'border-red-200 bg-red-50 text-red-800',
              item.tone === 'info' && 'border-brand-200 bg-white text-ink-800',
            )}
          >
            <span
              className={cx(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
                item.tone === 'success' && 'bg-emerald-600',
                item.tone === 'error' && 'bg-red-600',
                item.tone === 'info' && 'bg-brand-600',
              )}
            >
              {item.tone === 'success' ? '✓' : item.tone === 'error' ? '!' : 'i'}
            </span>
            <p className="leading-snug">{item.message}</p>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
