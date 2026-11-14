import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx, initials, priorityTone, statusTone, titleize } from '../lib/format';

export function Avatar({
  name,
  src,
  size = 36,
  className,
  online,
}: {
  name?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
  online?: boolean;
}) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.36) };
  const image = src ? (
    <img src={src} alt={name ?? 'Employee'} style={style} className={cx('rounded-full object-cover border border-ink-200', className)} />
  ) : (
    <span
      style={style}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800', className)}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
  if (online === undefined) return image;
  return (
    <span className="relative inline-flex shrink-0">
      {image}
      <span
        className={cx(
          'absolute bottom-0 right-0 block rounded-full ring-2 ring-white',
          online ? 'bg-emerald-500' : 'bg-ink-300',
        )}
        style={{ width: Math.max(7, size * 0.26), height: Math.max(7, size * 0.26) }}
        title={online ? 'Online' : 'Offline'}
      />
    </span>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: string; className?: string }) {
  const tones: Record<string, string> = {
    neutral: 'bg-ink-100 text-ink-600',
    brand: 'bg-brand-100 text-brand-700',
    success: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700',
    danger: 'bg-red-100 text-red-700',
    info: 'bg-sky-100 text-sky-700',
  };
  return <span className={cx('badge', tones[tone] ?? tones.neutral, className)}>{children}</span>;
}

export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return null;
  const tone = statusTone[status] ?? 'bg-ink-100 text-ink-600';
  return <span className={cx('badge', tone, className)}>{titleize(status)}</span>;
}

export function PriorityBadge({ priority }: { priority?: string | null }) {
  if (!priority) return null;
  return <span className={cx('badge', priorityTone[priority] ?? 'bg-ink-100 text-ink-600')}>{titleize(priority)}</span>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('card', className)}>{children}</div>;
}

export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3', className)}>
      <div>
        <h2 className="text-base font-semibold text-ink-800">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div className={cx('relative z-10 flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl', widths[size])}>
        <div className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-ink-900">{title}</h3>
            {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <button type="button" className="btn-ghost btn-sm -mr-2" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        <div className="scroll-area flex-1 px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-8' : 'py-14')}>
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ink-100 text-xl text-ink-400">∅</div>
      <p className="font-medium text-ink-700">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx('space-y-3', className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="skeleton h-4" style={{ width: `${100 - (index % 3) * 12}%` }} />
      ))}
    </div>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex gap-1 overflow-x-auto border-b border-ink-200', className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cx(
            'whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition',
            value === tab.value
              ? 'border-brand-700 text-brand-700'
              : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-700',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-600">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, tone = 'brand', label }: { value: number; tone?: 'brand' | 'success' | 'warning' | 'danger'; label?: string }) {
  const tones = { brand: 'bg-brand-600', success: 'bg-emerald-600', warning: 'bg-amber-500', danger: 'bg-red-600' };
  return (
    <div>
      {label && (
        <div className="mb-1 flex justify-between text-xs text-ink-500">
          <span>{label}</span>
          <span className="font-semibold text-ink-700">{Math.round(value)}%</span>
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-200" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cx('h-full rounded-full transition-all', tones[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'brand',
  icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    brand: 'bg-brand-50 text-brand-700',
    success: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-700',
    danger: 'bg-red-50 text-red-700',
    neutral: 'bg-ink-100 text-ink-600',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cx(
        'card flex w-full items-start gap-3 p-4 text-left transition',
        onClick && 'hover:border-brand-300 hover:shadow-md cursor-pointer',
        !onClick && 'cursor-default',
      )}
    >
      {icon && <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', tones[tone])}>{icon}</span>}
      <span className="min-w-0">
        <span className="block text-xs font-medium uppercase tracking-wide text-ink-500">{label}</span>
        <span className="mt-1 block text-xl font-semibold text-ink-900">{value}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-500">{hint}</span>}
      </span>
    </button>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-ink-500">
      <span>
        Showing {Math.min(total, (page - 1) * pageSize + 1)}–{Math.min(total, page * pageSize)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="px-1">
          Page {page} of {pages}
        </span>
        <button type="button" className="btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function ConfirmButton({
  children,
  onConfirm,
  confirmText = 'Confirm',
  className = 'btn-danger btn-sm',
  disabled,
}: {
  children: ReactNode;
  onConfirm: () => void;
  confirmText?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        if (window.confirm(confirmText)) onConfirm();
      }}
    >
      {children}
    </button>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-800">{value ?? '—'}</dd>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function IconTextButton({
  children,
  className = 'btn-primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={className} {...props}>
      {children}
    </button>
  );
}
