import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, EmptyState, Field, Modal, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime, formatDayLabel } from '../lib/format';
import type { PickerEmployee } from '../lib/types';

interface EmailItem {
  id: number;
  senderId?: number;
  senderName?: string;
  senderEmail?: string;
  senderPhoto?: string | null;
  recipientId?: number;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhoto?: string | null;
  subject: string;
  body: string;
  isRead: boolean;
  readAt: string | null;
  isStarred: boolean;
  attachments: { fileId: number; name: string; size: number; mimeType: string }[];
  createdAt: string;
}

export default function Mailbox() {
  useDocumentTitle('Mailbox');
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [tab, setTab] = useState<'inbox' | 'sent' | 'starred'>('inbox');
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeEmail, setActiveEmail] = useState<EmailItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [search, setSearch] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);

  // Initial active ID from query parameter
  const emailIdParam = params.get('id') ? Number(params.get('id')) : null;

  const loadUnreadCount = useCallback(async () => {
    try {
      const res = await api.get<{ unread: number }>('/emails/unread-count');
      setUnreadCount(res.unread);
    } catch {
      /* ignore */
    }
  }, []);

  const loadEmails = useCallback(async () => {
    setLoading(true);
    try {
      let endpoint = '/emails/inbox';
      if (tab === 'sent') endpoint = '/emails/sent';
      else if (tab === 'starred') endpoint = '/emails/inbox?starred=true';

      const queryParams = new URLSearchParams();
      if (search.trim()) queryParams.set('search', search.trim());

      const url = queryParams.toString() ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}${queryParams.toString()}` : endpoint;
      const res = await api.get<{ emails: EmailItem[]; total: number }>(url);
      setEmails(res.emails);
      void loadUnreadCount();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [tab, search, loadUnreadCount, toast]);

  useEffect(() => {
    void loadEmails();
  }, [loadEmails]);

  const openEmail = async (id: number) => {
    setLoadingEmail(true);
    setParams({ id: String(id) });
    try {
      const detail = await api.get<EmailItem>(`/emails/${id}`);
      setActiveEmail(detail);
      setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, isRead: true } : e)));
      void loadUnreadCount();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoadingEmail(false);
    }
  };

  useEffect(() => {
    if (emailIdParam && (!activeEmail || activeEmail.id !== emailIdParam)) {
      void openEmail(emailIdParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailIdParam]);

  const toggleStar = async (email: EmailItem, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      const res = await api.patch<{ isStarred: boolean }>(`/emails/${email.id}/star`);
      setEmails((prev) => prev.map((e) => (e.id === email.id ? { ...e, isStarred: res.isStarred } : e)));
      if (activeEmail?.id === email.id) {
        setActiveEmail((prev) => (prev ? { ...prev, isStarred: res.isStarred } : null));
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const deleteEmail = async (id: number, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (!window.confirm('Delete this email?')) return;
    try {
      await api.del(`/emails/${id}`);
      setEmails((prev) => prev.filter((e) => e.id !== id));
      if (activeEmail?.id === id) {
        setActiveEmail(null);
        setParams({});
      }
      toast.success('Email deleted.');
      void loadUnreadCount();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] min-h-[520px] overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      {/* Mailbox Navigation & List Pane */}
      <aside className={cx('flex w-full flex-col border-r border-ink-200 md:w-96', activeEmail && 'hidden md:flex')}>
        {/* Top Header & Compose Button */}
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-3 py-3">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-ink-900">Email</h1>
            {unreadCount > 0 && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">{unreadCount} unread</span>}
          </div>
          <button
            type="button"
            className="btn-primary py-1.5 px-3 text-xs"
            onClick={() => setComposeOpen(true)}
          >
            <Icon name="edit" size={14} />
            <span>Compose</span>
          </button>
        </div>

        {/* Folder Tabs */}
        <div className="flex border-b border-ink-200 bg-ink-50 px-2 py-1 text-xs">
          <button
            type="button"
            className={cx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors', tab === 'inbox' ? 'bg-white text-brand-700 shadow-sm' : 'text-ink-600 hover:text-ink-900')}
            onClick={() => { setTab('inbox'); setActiveEmail(null); }}
          >
            <Icon name="inbox" size={14} />
            <span>Inbox</span>
            {unreadCount > 0 && <span className="rounded-full bg-brand-100 px-1.5 text-[10px] font-bold text-brand-700">{unreadCount}</span>}
          </button>
          <button
            type="button"
            className={cx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors', tab === 'sent' ? 'bg-white text-brand-700 shadow-sm' : 'text-ink-600 hover:text-ink-900')}
            onClick={() => { setTab('sent'); setActiveEmail(null); }}
          >
            <Icon name="send" size={14} />
            <span>Sent</span>
          </button>
          <button
            type="button"
            className={cx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors', tab === 'starred' ? 'bg-white text-brand-700 shadow-sm' : 'text-ink-600 hover:text-ink-900')}
            onClick={() => { setTab('starred'); setActiveEmail(null); }}
          >
            <Icon name="star" size={14} />
            <span>Starred</span>
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-ink-100 p-2">
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input py-1.5 pl-8 text-sm"
              placeholder="Search emails..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Emails List */}
        <div className="flex-1 overflow-y-auto divide-y divide-ink-100">
          {loading ? (
            <div className="p-3">
              <Skeleton lines={6} />
            </div>
          ) : emails.length === 0 ? (
            <EmptyState compact title="No emails found" description={tab === 'inbox' ? 'Your inbox is empty.' : tab === 'sent' ? 'No sent emails yet.' : 'No starred emails.'} />
          ) : (
            emails.map((email) => {
              const displayName = tab === 'sent' ? `To: ${email.recipientName}` : email.senderName;
              const photo = tab === 'sent' ? email.recipientPhoto : email.senderPhoto;
              const isSelected = activeEmail?.id === email.id;

              return (
                <div
                  key={email.id}
                  onClick={() => openEmail(email.id)}
                  className={cx(
                    'group relative flex cursor-pointer items-start gap-2.5 p-3 text-left transition-colors hover:bg-ink-50',
                    isSelected && 'bg-brand-50 hover:bg-brand-50',
                    !email.isRead && tab === 'inbox' && 'bg-blue-50/60 font-medium',
                  )}
                >
                  <Avatar name={displayName ?? 'User'} src={photo} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <p className={cx('truncate text-sm text-ink-900', !email.isRead && tab === 'inbox' ? 'font-bold' : 'font-medium')}>
                        {displayName}
                      </p>
                      <span className="shrink-0 text-[11px] text-ink-400">{formatDayLabel(email.createdAt)}</span>
                    </div>
                    <p className={cx('truncate text-xs', !email.isRead && tab === 'inbox' ? 'font-semibold text-ink-900' : 'text-ink-700')}>
                      {email.subject}
                    </p>
                    <p className="truncate text-xs text-ink-400">
                      {email.body.slice(0, 80)}
                    </p>
                    {email.attachments && email.attachments.length > 0 && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-500">
                        <Icon name="paperclip" size={12} />
                        <span>{email.attachments.length} attachment{email.attachments.length > 1 ? 's' : ''}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-center gap-1.5 shrink-0 ml-1">
                    <button
                      type="button"
                      className={cx('p-1 text-ink-300 hover:text-amber-500', email.isStarred && 'text-amber-500')}
                      onClick={(e) => toggleStar(email, e)}
                      title="Star email"
                    >
                      <Icon name="star" size={14} />
                    </button>
                    <button
                      type="button"
                      className="p-1 text-ink-300 opacity-0 group-hover:opacity-100 hover:text-red-600 transition-opacity"
                      onClick={(e) => deleteEmail(email.id, e)}
                      title="Delete email"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Email Reader Pane */}
      <section className={cx('flex min-w-0 flex-1 flex-col', !activeEmail && 'hidden md:flex')}>
        {!activeEmail ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <EmptyState
              title="Select an email to read"
              description="Collaborate securely with colleagues via internal workforce email."
            />
          </div>
        ) : loadingEmail ? (
          <div className="p-6">
            <Skeleton lines={8} />
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-y-auto">
            {/* Header Toolbar */}
            <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg p-1 text-ink-500 hover:bg-ink-100 md:hidden"
                  onClick={() => { setActiveEmail(null); setParams({}); }}
                >
                  <Icon name="chevronLeft" size={18} />
                </button>
                <button
                  type="button"
                  className={cx('p-1.5 rounded-lg text-ink-400 hover:bg-ink-100', activeEmail.isStarred && 'text-amber-500')}
                  onClick={(e) => toggleStar(activeEmail, e)}
                  title="Star email"
                >
                  <Icon name="star" size={18} />
                </button>
                <button
                  type="button"
                  className="p-1.5 rounded-lg text-ink-500 hover:bg-ink-100 hover:text-red-600"
                  onClick={() => deleteEmail(activeEmail.id)}
                  title="Delete email"
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary py-1 px-3 text-xs"
                  onClick={() => {
                    setComposeOpen(true);
                  }}
                >
                  <Icon name="edit" size={14} />
                  <span>Reply</span>
                </button>
              </div>
            </div>

            {/* Email Body Content */}
            <div className="p-6">
              <h2 className="text-xl font-bold text-ink-900 mb-4">{activeEmail.subject}</h2>

              {/* Sender & Recipient Information */}
              <div className="flex items-start justify-between border-b border-ink-100 pb-4 mb-6">
                <div className="flex items-center gap-3">
                  <Avatar name={activeEmail.senderName ?? 'Sender'} src={activeEmail.senderPhoto} size={42} />
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{activeEmail.senderName}</p>
                    <p className="text-xs text-ink-500">From: &lt;{activeEmail.senderEmail}&gt;</p>
                    <p className="text-xs text-ink-500">To: {activeEmail.recipientName} &lt;{activeEmail.recipientEmail}&gt;</p>
                  </div>
                </div>
                <div className="text-right text-xs text-ink-400">
                  {formatDateTime(activeEmail.createdAt)}
                </div>
              </div>

              {/* Body Text */}
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800 font-sans min-h-[160px]">
                {activeEmail.body}
              </div>

              {/* Attachments Section */}
              {activeEmail.attachments && activeEmail.attachments.length > 0 && (
                <div className="mt-8 border-t border-ink-200 pt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-500 mb-3 flex items-center gap-1.5">
                    <Icon name="paperclip" size={14} />
                    <span>Attachments ({activeEmail.attachments.length})</span>
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {activeEmail.attachments.map((att) => (
                      <a
                        key={att.fileId}
                        href={`/api/files/${att.fileId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-100 transition-colors"
                      >
                        <Icon name="download" size={14} />
                        <span className="max-w-[160px] truncate">{att.name}</span>
                        <span className="text-[10px] text-ink-400">({Math.round(att.size / 1024)} KB)</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Compose Email Modal */}
      <ComposeEmailModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSent={async () => {
          setComposeOpen(false);
          await loadEmails();
          toast.success('Email sent successfully.');
        }}
        initialReply={activeEmail ? { recipientId: activeEmail.senderId, subject: `Re: ${activeEmail.subject}` } : undefined}
      />
    </div>
  );
}

function ComposeEmailModal({
  open,
  onClose,
  onSent,
  initialReply,
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => Promise<void>;
  initialReply?: { recipientId?: number; subject?: string };
}) {
  const toast = useToast();
  const [contacts, setContacts] = useState<PickerEmployee[]>([]);
  const [recipientIds, setRecipientIds] = useState<number[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<{ fileId: number; name: string; size: number; mimeType: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .get<{ contacts: PickerEmployee[] }>('/chat/contacts')
      .then((res) => setContacts(res.contacts))
      .catch(() => undefined);

    if (initialReply?.recipientId) {
      setRecipientIds([initialReply.recipientId]);
    } else {
      setRecipientIds([]);
    }
    setSubject(initialReply?.subject ?? '');
    setBody('');
    setAttachments([]);
  }, [open, initialReply]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.upload<{ id: number; name: string; mimeType: string; size: number }>(file);
      setAttachments((prev) => [
        ...prev,
        { fileId: res.id, name: file.name, size: file.size, mimeType: file.type || res.mimeType },
      ]);
      toast.success(`${file.name} attached.`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const removeAttachment = (fileId: number) => {
    setAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (recipientIds.length === 0) {
      toast.error('Select at least one recipient.');
      return;
    }
    if (!subject.trim()) {
      toast.error('Subject line is required.');
      return;
    }
    if (!body.trim()) {
      toast.error('Email body is required.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/emails/send', {
        recipientIds,
        subject: subject.trim(),
        body: body.trim(),
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      await onSent();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compose Email"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy || uploading}>
            Cancel
          </button>
          <button type="submit" form="compose-form" className="btn-primary" disabled={busy || uploading}>
            <Icon name="send" size={15} />
            <span>{busy ? 'Sending…' : 'Send Email'}</span>
          </button>
        </>
      }
    >
      <form id="compose-form" onSubmit={submit} className="space-y-4">
        <div>
          <span className="label">Recipients *</span>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-ink-300 p-2 space-y-1">
            {contacts.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-ink-50 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded text-brand-600"
                  checked={recipientIds.includes(c.id)}
                  onChange={(e) =>
                    setRecipientIds((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)))
                  }
                />
                <span className="font-medium text-ink-800">{c.full_name}</span>
                <span className="text-xs text-ink-400">({c.email ?? 'Workforce'}) · {c.designation_title ?? 'Employee'}</span>
              </label>
            ))}
          </div>
        </div>

        <Field label="Subject" required>
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What is this email about?"
            required
          />
        </Field>

        <Field label="Message" required>
          <textarea
            className="input min-h-[140px] resize-y"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your email here..."
            required
          />
        </Field>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-ink-700">Attachments</span>
            <label className="cursor-pointer inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium">
              <Icon name="paperclip" size={13} />
              <span>{uploading ? 'Uploading…' : 'Attach File'}</span>
              <input type="file" className="hidden" onChange={handleFileUpload} disabled={uploading} />
            </label>
          </div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span
                  key={a.fileId}
                  className="inline-flex items-center gap-1 rounded-md bg-ink-100 px-2 py-1 text-xs text-ink-700"
                >
                  <span className="max-w-[140px] truncate">{a.name}</span>
                  <button
                    type="button"
                    className="text-ink-400 hover:text-red-500"
                    onClick={() => removeAttachment(a.fileId)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
