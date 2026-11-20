import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import type { IssueItem } from '../../lib/types';

interface EditIssueModalProps {
  issue: IssueItem | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORIES = [
  { id: 'software', label: 'Software / ERP / Portal' },
  { id: 'pos_billing', label: 'POS Billing & Hardware' },
  { id: 'network', label: 'Network & Internet' },
  { id: 'hardware', label: 'Hardware / System Crash' },
  { id: 'attendance_leave', label: 'Attendance & HRMS' },
  { id: 'inventory', label: 'Stock & Inventory Audit' },
  { id: 'infrastructure', label: 'Facility & Electrical' },
  { id: 'security', label: 'Security & Access Control' },
  { id: 'customer_complaint', label: 'Customer Complaint' },
  { id: 'other', label: 'General Operational Issue' },
];

export function EditIssueModal({ issue, open, onClose, onSaved }: EditIssueModalProps) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'software',
    priority: 'medium',
    status: 'new',
    affectedModule: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (issue) {
      setForm({
        title: issue.title,
        description: issue.description,
        category: issue.category,
        priority: issue.priority,
        status: issue.status,
        affectedModule: issue.affected_module ?? '',
      });
    }
  }, [issue]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issue) return;
    if (!form.title.trim()) {
      toast.error('Title is required');
      return;
    }
    if (!form.description.trim()) {
      toast.error('Description is required');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/issues/${issue.id}`, {
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        priority: form.priority,
        status: form.status,
        affectedModule: form.affectedModule.trim() || undefined,
      });
      toast.success('Issue updated successfully');
      onSaved();
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit Issue · ${issue?.issue_no ?? ''}`}
      description="Update issue details, severity, status, or affected module."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
            Issue Title <span className="text-red-500">*</span>
          </label>
          <input
            className="input mt-1"
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
            required
            placeholder="Clear, concise summary of the issue"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Category <span className="text-red-500">*</span>
            </label>
            <select
              className="input mt-1"
              value={form.category}
              onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Priority <span className="text-red-500">*</span>
            </label>
            <select
              className="input mt-1"
              value={form.priority}
              onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}
            >
              <option value="low">Low (General Inquiry)</option>
              <option value="medium">Medium (Standard Request)</option>
              <option value="high">High (Major Disruption)</option>
              <option value="critical">Critical (Store Blocker / POS Down)</option>
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Status <span className="text-red-500">*</span>
            </label>
            <select
              className="input mt-1"
              value={form.status}
              onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}
            >
              <option value="new">New</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="escalated">Escalated</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Affected Module
            </label>
            <input
              className="input mt-1"
              value={form.affectedModule}
              onChange={(e) => setForm((prev) => ({ ...prev, affectedModule: e.target.value }))}
              placeholder="e.g. POS Billing, Tasks, Attendance"
            />
          </div>
        </div>

        <div>
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
            Description <span className="text-red-500">*</span>
          </label>
          <textarea
            className="input mt-1 min-h-[110px]"
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            required
            rows={4}
            placeholder="Detailed description of the issue"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
