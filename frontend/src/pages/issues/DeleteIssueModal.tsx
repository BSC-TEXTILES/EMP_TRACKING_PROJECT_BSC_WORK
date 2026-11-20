import { Modal } from '../../components/ui';
import type { IssueItem } from '../../lib/types';

interface DeleteIssueModalProps {
  issue: IssueItem | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteIssueModal({ issue, open, busy, onClose, onConfirm }: DeleteIssueModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Confirm Delete Issue" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-ink-700">
          Are you sure you want to permanently delete issue{' '}
          <strong className="text-ink-900 font-mono">{issue?.issue_no}</strong> ({issue?.title})?
        </p>
        <p className="text-xs text-rose-600 font-medium">
          This action will permanently remove the issue, all associated escalation history, logs, and comments. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary btn-sm bg-rose-600 hover:bg-rose-700 text-white"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete Issue'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
