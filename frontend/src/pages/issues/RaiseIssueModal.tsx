import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Icon } from '../../components/icons';
import { Modal } from '../../components/ui';

interface RaiseIssueModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (issueId: number) => void;
}

export function RaiseIssueModal({ open, onClose, onCreated }: RaiseIssueModalProps) {
  const { user } = useAuth();
  const toast = useToast();

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('software');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [affectedModule, setAffectedModule] = useState('Task Management');
  const [routingMode, setRoutingMode] = useState<'auto' | 'manual'>('auto');
  const [assignedTo, setAssignedTo] = useState<number | ''>('');
  const [description, setDescription] = useState('');
  const [managers, setManagers] = useState<{ id: number; full_name: string; employee_code: string; designation_title?: string; role_name?: string }[]>([]);
  const [fileList, setFileList] = useState<{ id: number; name: string; size: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      // Fetch available managers for manual routing option
      api.get<{ employees: any[] }>('/employees?limit=100&status=active')
        .then((res) => {
          const list = (res.employees ?? []).filter((e: any) =>
            ['super_admin', 'store_manager', 'department_head', 'manager', 'admin'].includes(e.role_slug) ||
            (e.role_level ?? 0) >= 40
          );
          setManagers(list);
          if (list.length > 0 && !assignedTo) {
            setAssignedTo(list[0].id);
          }
        })
        .catch(() => undefined);
    }
  }, [open]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append('file', file);
        const res = await api.post<{ file: { id: number; originalName: string; size: number } }>('/files/upload', formData);
        if (res?.file?.id) {
          setFileList((prev) => [...prev, { id: res.file.id, name: res.file.originalName, size: res.file.size }]);
        }
      }
      toast.success('Files uploaded successfully.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const removeFile = (id: number) => {
    setFileList((prev) => prev.filter((f) => f.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) {
      toast.error('Please fill in both title and detailed description.');
      return;
    }
    if (routingMode === 'manual' && !assignedTo) {
      toast.error('Please select an authorized manager for manual escalation routing.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{ id: number; issueNo: string }>('/issues', {
        title: title.trim(),
        description: description.trim(),
        category,
        priority,
        affectedModule,
        routingMode,
        assignedTo: routingMode === 'manual' ? Number(assignedTo) : undefined,
        fileIds: fileList.map((f) => f.id),
      });

      toast.success(`Issue ${res.issueNo} raised successfully.`);
      setTitle('');
      setDescription('');
      setFileList([]);
      setRoutingMode('auto');
      onCreated(res.id);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Raise Issue / Operational Ticket" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
            Issue Title <span className="text-red-500">*</span>
          </label>
          <input
            className="input mt-1"
            placeholder="e.g. POS Billing synchronization failed at Davanagere counter 2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={3}
            maxLength={200}
          />
        </div>

        {/* 2-col Category & Priority */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">Category</label>
            <select
              className="input mt-1"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="software">Software & POS Application</option>
              <option value="hardware">Hardware & Telemetry</option>
              <option value="network">Network & Internet Connectivity</option>
              <option value="attendance">Attendance & Shift Checkpoint</option>
              <option value="billing">Billing & Cash Float</option>
              <option value="inventory">Inventory & Stock Mismatch</option>
              <option value="customer_service">Customer Service & Escalation</option>
              <option value="hr">HR & Payroll</option>
              <option value="general">General Operations</option>
            </select>
          </div>

          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">Priority Level</label>
            <select
              className="input mt-1 font-semibold"
              value={priority}
              onChange={(e) => setPriority(e.target.value as any)}
            >
              <option value="low" className="text-slate-700">Low (Routine - 72h SLA)</option>
              <option value="medium" className="text-blue-700">Medium (Operational - 48h SLA)</option>
              <option value="high" className="text-amber-700">High (Urgent Attention - 24h SLA)</option>
              <option value="critical" className="text-red-700">Critical (Store Blocker - 8h SLA + Immediate Alert)</option>
            </select>
          </div>
        </div>

        {/* Affected Module */}
        <div>
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">Affected Module / Section</label>
          <select
            className="input mt-1"
            value={affectedModule}
            onChange={(e) => setAffectedModule(e.target.value)}
          >
            <option value="Store Tasks & SOP">Store Tasks & Daily SOP</option>
            <option value="Attendance & Checkpoints">Attendance & Checkpoints</option>
            <option value="LiveGuard & Activity Monitoring">LiveGuard & Activity Monitoring</option>
            <option value="POS Billing & Cash Register">POS Billing & Cash Register</option>
            <option value="Chat & WebRTC Voice Calling">Chat & Multi-Device Calling</option>
            <option value="Inventory & Barcode Scanner">Inventory & Barcode Scanner</option>
            <option value="Hardware / Windows PC">Store Hardware & Terminal PC</option>
            <option value="Enterprise Platform">Enterprise Web Portal</option>
          </select>
        </div>

        {/* Routing Mode Selector */}
        <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5 space-y-3">
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700 block">Routing Mode</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label
              className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                routingMode === 'auto'
                  ? 'border-brand-600 bg-brand-50/50 text-brand-900 ring-1 ring-brand-500/20'
                  : 'border-ink-200 bg-white hover:bg-ink-50 text-ink-800'
              }`}
            >
              <input
                type="radio"
                name="routingMode"
                value="auto"
                checked={routingMode === 'auto'}
                onChange={() => setRoutingMode('auto')}
                className="mt-0.5 text-brand-600 focus:ring-brand-500"
              />
              <div className="text-xs">
                <span className="font-bold block">Option B: Automatic Hierarchy Routing</span>
                <span className="text-ink-500 leading-relaxed block mt-0.5">
                  Directly routes to your Store Manager / Department Head / Super Admin based on reporting hierarchy.
                </span>
              </div>
            </label>

            <label
              className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                routingMode === 'manual'
                  ? 'border-brand-600 bg-brand-50/50 text-brand-900 ring-1 ring-brand-500/20'
                  : 'border-ink-200 bg-white hover:bg-ink-50 text-ink-800'
              }`}
            >
              <input
                type="radio"
                name="routingMode"
                value="manual"
                checked={routingMode === 'manual'}
                onChange={() => setRoutingMode('manual')}
                className="mt-0.5 text-brand-600 focus:ring-brand-500"
              />
              <div className="text-xs">
                <span className="font-bold block">Option A: Manual Manager Escalation</span>
                <span className="text-ink-500 leading-relaxed block mt-0.5">
                  Select a specific authorized manager to directly assign and notify.
                </span>
              </div>
            </label>
          </div>

          {routingMode === 'manual' && (
            <div className="mt-3 pt-3 border-t border-ink-200">
              <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">Select Manager to Assign</label>
              <select
                className="input mt-1"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value ? Number(e.target.value) : '')}
                required
              >
                <option value="">Select an authorized manager…</option>
                {managers.map((mgr) => (
                  <option key={mgr.id} value={mgr.id}>
                    {mgr.full_name} ({mgr.employee_code}) · {mgr.role_name ?? 'Manager'}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Detailed Description */}
        <div>
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
            Description & Impact <span className="text-red-500">*</span>
          </label>
          <textarea
            className="input mt-1 min-h-[100px] text-sm"
            placeholder="Detailed description of the problem, steps to reproduce, and impact on store operations…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            minLength={5}
            rows={4}
          />
        </div>

        {/* Attachment Upload */}
        <div>
          <label className="label text-xs font-bold uppercase tracking-wider text-ink-700 block mb-1">
            Proof / Attachments (Photos, Invoices, Logs)
          </label>
          <div className="flex items-center gap-3">
            <label className="btn-secondary btn-sm cursor-pointer inline-flex items-center gap-1.5">
              <Icon name="upload" size={14} />
              <span>{uploading ? 'Uploading…' : 'Attach Files'}</span>
              <input
                type="file"
                multiple
                className="hidden"
                disabled={uploading}
                onChange={handleFileUpload}
              />
            </label>
            <span className="text-xs text-ink-400">Images, PDFs, logs up to 25MB</span>
          </div>

          {fileList.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {fileList.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-xs text-ink-800"
                >
                  <span className="truncate flex items-center gap-1.5">
                    <Icon name="file" size={13} className="text-brand-600" />
                    <span>{f.name}</span>
                    <span className="text-[10px] text-ink-400">({Math.round(f.size / 1024)} KB)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(f.id)}
                    className="text-red-500 hover:text-red-700 p-1"
                    title="Remove attachment"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Submit Actions */}
        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-ink-100">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm" disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={submitting || uploading}>
            <Icon name="send" size={14} />
            <span>{submitting ? 'Raising Issue…' : 'Submit Issue'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}
