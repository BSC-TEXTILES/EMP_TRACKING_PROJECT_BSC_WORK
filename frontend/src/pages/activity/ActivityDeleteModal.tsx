import React, { useState } from 'react';
import { Modal, Field } from '../../components/ui';
import { Icon } from '../../components/icons';
import type { ActivityRecordType, TrashItem } from './activityTypes';

interface SoftDeleteTarget {
  type: ActivityRecordType;
  id: number;
  title: string;
  detail?: string;
  isBulk?: boolean;
  bulkItems?: { type: string; id: number }[];
}

interface ActivityDeleteModalProps {
  target: SoftDeleteTarget | null;
  onClose: () => void;
  onConfirm: (type: ActivityRecordType, id: number, reason: string, isBulk?: boolean, bulkItems?: { type: string; id: number }[]) => void;
  busy: boolean;
}

export function ActivityDeleteModal({ target, onClose, onConfirm, busy }: ActivityDeleteModalProps) {
  const [reason, setReason] = useState('');

  if (!target) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(target.type, target.id, reason.trim(), target.isBulk, target.bulkItems);
    setReason('');
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={target.isBulk ? `Delete ${target.bulkItems?.length ?? 0} Activity Records` : `Delete ${target.title}`}
      description="Move activity log to the Recycle Bin. Soft-deleted records can be restored at any time."
      size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="soft-delete-activity-form"
            className="btn-danger inline-flex items-center gap-1.5"
            disabled={busy}
          >
            <Icon name="trash" size={14} />
            <span>{busy ? 'Deleting…' : 'Move to Recycle Bin'}</span>
          </button>
        </div>
      }
    >
      <form id="soft-delete-activity-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-ink-200 bg-surface-alt/50 p-3.5 space-y-1.5 text-xs text-ink-700">
          <p className="font-bold text-ink-900 text-sm">{target.title}</p>
          {target.detail && <p className="text-ink-600">{target.detail}</p>}
          <p className="text-[11px] text-ink-400 font-mono">
            Record Type: <strong className="text-ink-700 uppercase">{target.type}</strong>
            {!target.isBulk && ` · ID #${target.id}`}
          </p>
        </div>

        <Field
          label="Reason for Deletion (Optional)"
          hint="Saved in the activity audit trail and visible in the Recycle Bin."
        >
          <input
            type="text"
            className="input text-xs sm:text-sm"
            placeholder="e.g. Errant background launch, accidental recording during break..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={255}
          />
        </Field>

        <p className="text-[11px] text-ink-500">
          Note: This operation soft-deletes the entry. The record will be hidden from reports and daily statistics, but remains safely recoverable in the Recycle Bin.
        </p>
      </form>
    </Modal>
  );
}

interface PermanentPurgeModalProps {
  target: TrashItem | null;
  bulkItems?: TrashItem[];
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}

export function PermanentPurgeModal({
  target,
  bulkItems,
  onClose,
  onConfirm,
  busy,
}: PermanentPurgeModalProps) {
  const isBulk = Boolean(bulkItems && bulkItems.length > 0);
  if (!target && !isBulk) return null;

  return (
    <Modal
      open={Boolean(target) || isBulk}
      onClose={onClose}
      title={isBulk ? `Permanently Purge ${bulkItems?.length} Records` : `Permanently Purge Record`}
      description="This action is irreversible under organisation retention policies."
      size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={onConfirm}
          >
            <Icon name="trash" size={14} />
            <span>{busy ? 'Purging…' : 'Permanently Purge'}</span>
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-rose-300 bg-rose-50/70 p-4 text-xs text-rose-900 space-y-2">
          <div className="flex items-center gap-2 font-bold text-rose-800 text-sm">
            <Icon name="alertTriangle" size={16} className="text-rose-600" />
            <span>Warning: Irreversible Data Purge</span>
          </div>
          <p className="leading-relaxed">
            This activity record will be permanently deleted from the database. It cannot be recovered from the Recycle Bin after this point.
          </p>
        </div>

        {target && (
          <div className="rounded-lg border border-ink-200 bg-surface p-3 text-xs space-y-1">
            <p className="font-bold text-ink-900">{target.title}</p>
            <p className="text-ink-600">
              Employee: {target.employeeName} ({target.employeeCode})
            </p>
            <p className="text-[11px] font-mono text-ink-500">
              Type: {target.typeLabel} · Deleted on: {target.deletedAt}
            </p>
          </div>
        )}

        {isBulk && (
          <div className="rounded-lg border border-ink-200 bg-surface p-3 text-xs space-y-1">
            <p className="font-bold text-ink-900">
              {bulkItems?.length} records selected for permanent purge.
            </p>
            <p className="text-[11px] text-ink-500">
              All selected records will be permanently removed from the Recycle Bin.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
