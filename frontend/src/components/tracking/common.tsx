import { useState } from 'react';
import { Badge, Field, Modal } from '../ui';
import { Icon } from '../icons';
import { downloadFile, errorMessage } from '../../lib/api';
import { cx } from '../../lib/format';
import { STATUS_META, istToday, shiftIsoDate, type LiveStatus } from '../../lib/tracking';
import { useToast } from '../../contexts/ToastContext';

export function StatusPill({ status, syncError }: { status: LiveStatus; syncError?: string | null }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" title={meta.description}>
      <Badge tone={meta.tone} className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className={cx('h-2 w-2 rounded-full', meta.dot, status === 'active' && 'animate-pulse')} aria-hidden />
        {meta.label}
      </Badge>
      {syncError && (
        <Badge tone="warning" className="inline-flex items-center gap-1" >
          <Icon name="alertTriangle" size={12} /> Sync
        </Badge>
      )}
    </span>
  );
}

/** Excel / PDF export for one employee or for a permitted location, over a date range. */
export function ExportDialog({
  open,
  onClose,
  employeeId,
  employeeName,
  locations,
  defaultDate,
}: {
  open: boolean;
  onClose: () => void;
  employeeId?: number;
  employeeName?: string;
  locations?: { code: string; name: string }[];
  defaultDate: string;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<'xlsx' | 'pdf'>('xlsx');
  const [from, setFrom] = useState(defaultDate);
  const [to, setTo] = useState(defaultDate);
  const [location, setLocation] = useState('all');
  const [busy, setBusy] = useState(false);
  const today = istToday();

  const preset = (days: number) => { setTo(defaultDate); setFrom(shiftIsoDate(defaultDate, -(days - 1))); };

  const run = async () => {
    if (from > to) { toast.error('The start date must be on or before the end date.'); return; }
    setBusy(true);
    try {
      const params = new URLSearchParams({ format, from, to });
      if (employeeId) params.set('employeeId', String(employeeId));
      else if (location !== 'all') params.set('location', location);
      await downloadFile(`/tracking/reports/export?${params.toString()}`, `activity-report.${format}`);
      toast.success('Report downloaded.');
      onClose();
    } catch (error) {
      toast.error(errorMessage(error), 'Report not generated');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Download activity report"
      description={employeeName ? `Individual report for ${employeeName}` : 'Location-wise report for the employees you are permitted to see'}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={run} disabled={busy}>
            <Icon name="download" size={16} /> {busy ? 'Preparing…' : 'Download'}
          </button>
        </>
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Format">
          <div className="flex gap-2">
            {(['xlsx', 'pdf'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFormat(f)}
                className={cx('flex-1 rounded-lg border px-3 py-2 text-sm font-medium', format === f ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600 hover:border-ink-300')}>
                {f === 'xlsx' ? 'Excel (.xlsx)' : 'PDF'}
              </button>
            ))}
          </div>
        </Field>
        {!employeeId && locations && (
          <Field label="Location">
            <select className="input" value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="all">All permitted locations</option>
              {locations.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="From"><input type="date" className="input" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button type="button" className="btn-ghost btn-sm" onClick={() => preset(1)}>Selected day</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => preset(7)}>Last 7 days</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => preset(31)}>Last 31 days</button>
      </div>
      <p className="mt-3 text-xs text-ink-500">
        Up to 31 days. Reports contain the same observed figures as the dashboard, including sessions, application and website usage, devices and untracked (offline) periods. Times are in IST.
      </p>
    </Modal>
  );
}
