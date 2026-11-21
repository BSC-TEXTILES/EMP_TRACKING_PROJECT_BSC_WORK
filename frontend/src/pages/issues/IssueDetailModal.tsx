import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Icon } from '../../components/icons';
import { Avatar, Badge, Modal } from '../../components/ui';
import { cx, formatTime, relativeTime } from '../../lib/format';
import type { IssueDetailData } from '../../lib/types';

interface IssueDetailModalProps {
  issueId: number | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function IssueDetailModal({ issueId, open, onClose, onUpdated }: IssueDetailModalProps) {
  const { user } = useAuth();
  const toast = useToast();

  const [data, setData] = useState<IssueDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'discussion' | 'history' | 'audit'>('discussion');

  // Comment state
  const [commentText, setCommentText] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [commentFiles, setCommentFiles] = useState<{ id: number; name: string }[]>([]);
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  // Action modals
  const [escalateModalOpen, setEscalateModalOpen] = useState(false);
  const [escalateReason, setEscalateReason] = useState('');
  const [escalateTargetId, setEscalateTargetId] = useState<number | ''>('');
  const [managers, setManagers] = useState<{ id: number; full_name: string; employee_code: string; role_name?: string }[]>([]);

  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [resolutionText, setResolutionText] = useState('');

  const [reopenModalOpen, setReopenModalOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  const [actionBusy, setActionBusy] = useState(false);

  const fetchDetail = async () => {
    if (!issueId) return;
    setLoading(true);
    try {
      const res = await api.get<IssueDetailData>(`/issues/${issueId}`);
      setData(res);
    } catch (err) {
      toast.error(errorMessage(err));
      onClose();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && issueId) {
      void fetchDetail();
      // Load potential escalation targets
      api.get<{ employees: any[] }>('/employees?limit=100&status=active')
        .then((res) => {
          const list = (res.employees ?? []).filter((e: any) =>
            ['super_admin', 'store_manager', 'department_head', 'manager', 'admin'].includes(e.role_slug) ||
            (e.role_level ?? 0) >= 40
          );
          setManagers(list);
        })
        .catch(() => undefined);
    } else {
      setData(null);
    }
  }, [open, issueId]);

  if (!open || !issueId) return null;

  const issue = data?.issue;
  const isSuperAdmin = user?.roleSlug === 'super_admin' || (user?.roleLevel ?? 0) >= 90;
  const isAssignedManager = Boolean(user && issue && issue.assigned_to === user.id);
  const isReporter = Boolean(user && issue && issue.reporter_id === user.id);
  const isManagerOrAdmin = Boolean(isSuperAdmin || (user?.roleLevel ?? 0) >= 50 || user?.permissions?.includes('issues.view.team'));

  const handleAcknowledge = async () => {
    setActionBusy(true);
    try {
      await api.post(`/issues/${issueId}/acknowledge`, {});
      toast.success('Issue acknowledged.');
      void fetchDetail();
      onUpdated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleEscalateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionBusy(true);
    try {
      await api.post(`/issues/${issueId}/escalate`, {
        reason: escalateReason.trim() || 'Escalation requested',
        targetEmployeeId: escalateTargetId ? Number(escalateTargetId) : undefined,
      });
      toast.success('Issue escalated successfully.');
      setEscalateModalOpen(false);
      setEscalateReason('');
      setEscalateTargetId('');
      void fetchDetail();
      onUpdated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleResolveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolutionText.trim()) {
      toast.error('Please enter the resolution details.');
      return;
    }
    setActionBusy(true);
    try {
      await api.post(`/issues/${issueId}/status`, {
        status: 'resolved',
        resolution: resolutionText.trim(),
      });
      toast.success('Issue marked as resolved.');
      setResolveModalOpen(false);
      setResolutionText('');
      void fetchDetail();
      onUpdated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleReopenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionBusy(true);
    try {
      await api.post(`/issues/${issueId}/reopen`, {
        reason: reopenReason.trim() || 'Issue reopened',
      });
      toast.success('Issue reopened.');
      setReopenModalOpen(false);
      setReopenReason('');
      void fetchDetail();
      onUpdated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleCommentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() && commentFiles.length === 0) return;
    setCommentSubmitting(true);
    try {
      await api.post(`/issues/${issueId}/comments`, {
        body: commentText.trim(),
        isInternal: isInternalNote,
        fileIds: commentFiles.map((f) => f.id),
      });
      toast.success(isInternalNote ? 'Internal note added.' : 'Comment posted.');
      setCommentText('');
      setCommentFiles([]);
      setIsInternalNote(false);
      void fetchDetail();
      onUpdated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      for (let i = 0; i < files.length; i++) {
        const formData = new FormData();
        formData.append('file', files[i]);
        const res = await api.post<{ file: { id: number; originalName: string } }>('/files/upload', formData);
        if (res?.file?.id) {
          setCommentFiles((prev) => [...prev, { id: res.file.id, name: res.file.originalName }]);
        }
      }
      toast.success('Files uploaded.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      e.target.value = '';
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="xl" title={`Issue Details: ${issue?.issue_no ?? 'Loading…'}`}>
      {loading || !issue ? (
        <div className="py-16 text-center text-sm text-ink-500">Loading issue details…</div>
      ) : (
        <div className="space-y-5">
          {/* Top Banner Info */}
          <div className="rounded-xl border border-ink-200 bg-surface p-4 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-bold text-ink-800 bg-ink-100 px-2 py-0.5 rounded border border-ink-200">
                    {issue.issue_no}
                  </span>
                  <span
                    className={cx(
                      'px-2 py-0.5 rounded-full text-[11px] font-bold border uppercase tracking-wide',
                      issue.priority === 'critical'
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : issue.priority === 'high'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : issue.priority === 'medium'
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-slate-50 text-slate-700 border-slate-200'
                    )}
                  >
                    {issue.priority} Priority
                  </span>
                  <span
                    className={cx(
                      'px-2 py-0.5 rounded-full text-[11px] font-bold border capitalize',
                      issue.status === 'resolved'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : issue.status === 'escalated'
                        ? 'bg-purple-50 text-purple-700 border-purple-200'
                        : issue.status === 'in_progress'
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    )}
                  >
                    {issue.status.replace(/_/g, ' ')}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    Level {issue.escalation_level}
                  </span>
                  {issue.location_code && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-800 border border-slate-200">
                      <Icon name="building" size={11} />
                      {issue.location_code}
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-base font-bold text-ink-900 leading-snug">{issue.title}</h2>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-1.5 flex-wrap self-start sm:self-auto shrink-0">
                {/* Acknowledge Button */}
                {!issue.acknowledged_at && (isAssignedManager || isSuperAdmin) && (
                  <button
                    type="button"
                    onClick={handleAcknowledge}
                    disabled={actionBusy}
                    className="btn-primary btn-sm inline-flex items-center gap-1.5"
                  >
                    <Icon name="checkCircle" size={14} />
                    <span>Acknowledge</span>
                  </button>
                )}

                {/* Escalate Button */}
                {['new', 'pending', 'in_progress', 'escalated'].includes(issue.status) && (
                  <button
                    type="button"
                    onClick={() => setEscalateModalOpen(true)}
                    disabled={actionBusy}
                    className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-purple-700 border-purple-300 hover:bg-purple-50"
                  >
                    <Icon name="arrowUp" size={14} />
                    <span>Escalate</span>
                  </button>
                )}

                {/* Resolve Button */}
                {['pending', 'in_progress', 'escalated'].includes(issue.status) && (isAssignedManager || isSuperAdmin) && (
                  <button
                    type="button"
                    onClick={() => setResolveModalOpen(true)}
                    disabled={actionBusy}
                    className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                  >
                    <Icon name="check" size={14} />
                    <span>Resolve</span>
                  </button>
                )}

                {/* Reopen Button */}
                {['resolved', 'closed'].includes(issue.status) && (
                  <button
                    type="button"
                    onClick={() => setReopenModalOpen(true)}
                    disabled={actionBusy}
                    className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-amber-700 border-amber-300 hover:bg-amber-50"
                  >
                    <Icon name="refresh" size={14} />
                    <span>Reopen</span>
                  </button>
                )}
              </div>
            </div>

            {/* SLA Due Timer & Metadata */}
            <div className="mt-3.5 pt-3 border-t border-ink-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-ink-400 block font-medium">Raised By</span>
                <span className="font-bold text-ink-800">{issue.reporter_name}</span>
                <span className="text-[10px] text-ink-500 font-mono block">({issue.reporter_code})</span>
              </div>
              <div>
                <span className="text-ink-400 block font-medium">Assigned Manager</span>
                <span className="font-bold text-ink-800">{issue.assigned_to_name ?? 'Unassigned'}</span>
                {issue.assigned_to_code && (
                  <span className="text-[10px] text-ink-500 font-mono block">({issue.assigned_to_code})</span>
                )}
              </div>
              <div>
                <span className="text-ink-400 block font-medium">Resolution SLA Due</span>
                {issue.due_at ? (
                  <span className={cx('font-bold', new Date(issue.due_at) < new Date() ? 'text-red-600' : 'text-ink-800')}>
                    {formatTime(issue.due_at)}
                    {new Date(issue.due_at) < new Date() && ' (Overdue)'}
                  </span>
                ) : (
                  <span className="text-ink-500">Not set</span>
                )}
              </div>
              <div>
                <span className="text-ink-400 block font-medium">Created At</span>
                <span className="font-bold text-ink-800">{relativeTime(issue.created_at)}</span>
              </div>
            </div>
          </div>

          {/* Issue Description */}
          <div className="rounded-xl border border-ink-200 bg-white p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-500 mb-2">Issue Description</h3>
            <p className="text-sm text-ink-800 leading-relaxed whitespace-pre-wrap">{issue.description}</p>
            {issue.affected_module && (
              <p className="mt-2.5 text-xs text-ink-500 font-medium">
                Affected Module: <span className="text-ink-700 font-semibold">{issue.affected_module}</span>
              </p>
            )}
            {issue.resolution && (
              <div className="mt-3.5 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                <span className="text-xs font-bold text-emerald-800 block">Resolution Summary:</span>
                <p className="text-xs text-emerald-900 mt-1">{issue.resolution}</p>
                {issue.resolved_by_name && (
                  <span className="text-[10px] text-emerald-700 block mt-1 font-medium">
                    Resolved by {issue.resolved_by_name} · {issue.resolved_at ? relativeTime(issue.resolved_at) : ''}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Navigation Tabs (Discussion, Escalation History, Audit Log) */}
          <div className="border-b border-ink-200">
            <nav className="flex space-x-6 text-sm font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab('discussion')}
                className={cx(
                  'pb-2.5 border-b-2 transition-colors inline-flex items-center gap-1.5',
                  activeTab === 'discussion'
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-500 hover:text-ink-800'
                )}
              >
                <Icon name="chat" size={14} />
                <span>Discussion & Attachments ({data.comments.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('history')}
                className={cx(
                  'pb-2.5 border-b-2 transition-colors inline-flex items-center gap-1.5',
                  activeTab === 'history'
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-500 hover:text-ink-800'
                )}
              >
                <Icon name="arrowUp" size={14} />
                <span>Escalation History ({data.escalationHistory.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('audit')}
                className={cx(
                  'pb-2.5 border-b-2 transition-colors inline-flex items-center gap-1.5',
                  activeTab === 'audit'
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-500 hover:text-ink-800'
                )}
              >
                <Icon name="shield" size={14} />
                <span>Audit Trail ({data.activityLogs.length})</span>
              </button>
            </nav>
          </div>

          {/* TAB 1: DISCUSSION & ATTACHMENTS */}
          {activeTab === 'discussion' && (
            <div className="space-y-4">
              {/* Attachments Section if any exist */}
              {data.attachments.length > 0 && (
                <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-ink-600 block mb-2">
                    Attached Files ({data.attachments.length})
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {data.attachments.map((att) => (
                      <a
                        key={att.id}
                        href={att.download_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between gap-2 p-2 rounded-lg border border-ink-200 bg-white hover:border-brand-400 transition-colors text-xs"
                      >
                        <span className="truncate flex items-center gap-1.5 font-medium text-ink-800">
                          <Icon name="file" size={14} className="text-brand-600" />
                          <span>{att.original_name}</span>
                        </span>
                        <span className="text-[10px] text-ink-400 shrink-0">
                          {Math.round(att.size_bytes / 1024)} KB
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Comments Timeline */}
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {data.comments.length === 0 ? (
                  <p className="text-xs text-ink-400 italic py-4 text-center">No comments or updates yet.</p>
                ) : (
                  data.comments.map((c) => (
                    <div
                      key={c.id}
                      className={cx(
                        'rounded-xl border p-3.5 transition-all text-xs',
                        c.is_internal
                          ? 'bg-amber-50/40 border-amber-300 ring-1 ring-amber-400/20'
                          : 'bg-white border-ink-200 shadow-xs'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={c.author_name} src={c.author_photo} size={22} />
                          <span className="font-bold text-ink-900">{c.author_name}</span>
                          <span className="text-[10px] text-ink-400 font-mono">({c.author_code})</span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-ink-100 text-ink-600 font-medium">
                            {c.author_role}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {c.is_internal ? (
                            <span className="inline-flex items-center gap-1 font-bold text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded border border-amber-200">
                              <Icon name="lock" size={10} />
                              CONFIDENTIAL INTERNAL NOTE
                            </span>
                          ) : null}
                          <span className="text-[10px] text-ink-400">{relativeTime(c.created_at)}</span>
                        </div>
                      </div>
                      <p className="text-ink-800 leading-relaxed whitespace-pre-wrap mt-1">{c.body}</p>
                    </div>
                  ))
                )}
              </div>

              {/* Add Comment Box */}
              <form onSubmit={handleCommentSubmit} className="rounded-xl border border-ink-200 bg-white p-3 space-y-2.5">
                <textarea
                  className="input min-h-[60px] text-xs"
                  placeholder="Add a comment or operational update…"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  rows={2}
                />

                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-3">
                    <label className="cursor-pointer inline-flex items-center gap-1 text-xs text-ink-600 hover:text-brand-600">
                      <Icon name="upload" size={13} />
                      <span>Attach file</span>
                      <input type="file" multiple className="hidden" onChange={handleFileUpload} />
                    </label>

                    {/* Checkbox for internal note (managers only) */}
                    {isManagerOrAdmin && (
                      <label className="inline-flex items-center gap-1.5 text-xs text-amber-800 font-semibold cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isInternalNote}
                          onChange={(e) => setIsInternalNote(e.target.checked)}
                          className="rounded text-amber-600 focus:ring-amber-500"
                        />
                        <span>Post as confidential internal note (managers only)</span>
                      </label>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={commentSubmitting || (!commentText.trim() && commentFiles.length === 0)}
                    className="btn-primary btn-sm inline-flex items-center gap-1"
                  >
                    <Icon name="send" size={13} />
                    <span>{commentSubmitting ? 'Posting…' : 'Post Reply'}</span>
                  </button>
                </div>

                {commentFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {commentFiles.map((f) => (
                      <span key={f.id} className="inline-flex items-center gap-1 text-[11px] bg-ink-100 text-ink-700 px-2 py-0.5 rounded">
                        <Icon name="file" size={11} />
                        <span className="truncate max-w-[120px]">{f.name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </form>
            </div>
          )}

          {/* TAB 2: ESCALATION HISTORY */}
          {activeTab === 'history' && (
            <div className="space-y-3">
              {data.escalationHistory.length === 0 ? (
                <p className="text-xs text-ink-400 italic py-6 text-center">No escalations have occurred yet.</p>
              ) : (
                <ol className="relative border-l border-purple-200 ml-3 space-y-4">
                  {data.escalationHistory.map((h) => (
                    <li key={h.id} className="ml-4">
                      <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-purple-600" />
                      <div className="rounded-lg border border-purple-100 bg-purple-50/40 p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-purple-900">
                            Escalated from Level {h.from_level} → Level {h.to_level}
                          </span>
                          <span className="text-[10px] text-purple-600 font-mono">{relativeTime(h.created_at)}</span>
                        </div>
                        <p className="mt-1 text-ink-800">
                          <span className="font-semibold">Reason:</span> {h.reason}
                        </p>
                        <div className="mt-2 text-[11px] text-ink-500 flex items-center gap-3">
                          <span>To: <strong>{h.to_employee_name}</strong></span>
                          {h.escalated_by_name && <span>By: <strong>{h.escalated_by_name}</strong></span>}
                          <span className="uppercase text-[10px] bg-purple-100 text-purple-800 px-1 rounded font-bold">
                            {h.escalation_type}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {/* TAB 3: AUDIT TRAIL */}
          {activeTab === 'audit' && (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {data.activityLogs.map((log) => (
                <div key={log.id} className="flex items-start justify-between gap-2 p-2.5 rounded-lg border border-ink-100 bg-white text-xs">
                  <div>
                    <span className="font-bold text-ink-800 capitalize">{log.action.replace(/_/g, ' ')}</span>
                    <span className="text-ink-500 ml-1">by {log.actor_name ?? 'System Engine'}</span>
                    {log.from_status && log.to_status && (
                      <span className="text-ink-400 block text-[11px] mt-0.5">
                        Status: {log.from_status} → {log.to_status}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-ink-400 shrink-0 font-mono">{relativeTime(log.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ESCALATE MODAL PROMPT */}
      <Modal open={escalateModalOpen} onClose={() => setEscalateModalOpen(false)} title="Escalate Issue to Higher Authority" size="md">
        <form onSubmit={handleEscalateSubmit} className="space-y-3">
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">Select Higher Manager (Optional)</label>
            <select
              className="input mt-1"
              value={escalateTargetId}
              onChange={(e) => setEscalateTargetId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Auto-resolve next higher manager in hierarchy…</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name} ({m.employee_code}) · {m.role_name ?? 'Manager'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Reason for Escalation <span className="text-xs font-normal text-ink-400 capitalize">(Optional)</span>
            </label>
            <textarea
              className="input mt-1 min-h-[80px] text-sm"
              placeholder="Explain why this issue requires higher-level intervention or urgent store focus…"
              value={escalateReason}
              onChange={(e) => setEscalateReason(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setEscalateModalOpen(false)} className="btn-secondary btn-sm" disabled={actionBusy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary btn-sm bg-purple-700 hover:bg-purple-800" disabled={actionBusy}>
              Confirm Escalation
            </button>
          </div>
        </form>
      </Modal>

      {/* RESOLVE MODAL PROMPT */}
      <Modal open={resolveModalOpen} onClose={() => setResolveModalOpen(false)} title="Resolve Issue" size="md">
        <form onSubmit={handleResolveSubmit} className="space-y-3">
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Resolution Summary <span className="text-red-500">*</span>
            </label>
            <textarea
              className="input mt-1 min-h-[90px] text-sm"
              placeholder="Detail the steps taken to fix the issue and prevent future occurrences…"
              value={resolutionText}
              onChange={(e) => setResolutionText(e.target.value)}
              required
              rows={4}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setResolveModalOpen(false)} className="btn-secondary btn-sm" disabled={actionBusy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary btn-sm bg-emerald-600 hover:bg-emerald-700" disabled={actionBusy}>
              Mark as Resolved
            </button>
          </div>
        </form>
      </Modal>

      {/* REOPEN MODAL PROMPT */}
      <Modal open={reopenModalOpen} onClose={() => setReopenModalOpen(false)} title="Reopen Issue" size="md">
        <form onSubmit={handleReopenSubmit} className="space-y-3">
          <div>
            <label className="label text-xs font-bold uppercase tracking-wider text-ink-700">
              Reason for Reopening <span className="text-xs font-normal text-ink-400 capitalize">(Optional)</span>
            </label>
            <textarea
              className="input mt-1 min-h-[80px] text-sm"
              placeholder="Why is this issue unresolved or recurring?…"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setReopenModalOpen(false)} className="btn-secondary btn-sm" disabled={actionBusy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary btn-sm bg-amber-600 hover:bg-amber-700" disabled={actionBusy}>
              Reopen Issue
            </button>
          </div>
        </form>
      </Modal>
    </Modal>
  );
}
