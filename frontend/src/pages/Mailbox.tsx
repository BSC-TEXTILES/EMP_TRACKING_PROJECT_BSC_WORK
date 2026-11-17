import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage, fileUrl } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, EmptyState, Field, Modal, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime, formatDayLabel } from '../lib/format';
import type { PickerEmployee } from '../lib/types';

/** Server's real per-recipient delivery outcome for "Send Email". */
interface SendResult {
  success?: boolean;
  status?: string;
  messageId?: string | null;
  error?: string | null;
  sent?: number;
  delivered?: number;
  deliveryConfigured?: boolean;
  emailId?: number;
  emailIds?: number[];
  recipients?: any;
}

interface EmailItem {
  id: number;
  senderId?: number;
  senderName?: string;
  senderEmail?: string;
  senderPhoto?: string | null;
  recipientId?: number | null;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhoto?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  body: string;
  bodyHtml?: string | null;
  isRead: boolean;
  readAt: string | null;
  isStarred: boolean;
  deliveryStatus?: string;
  providerMessageId?: string | null;
  lastError?: string | null;
  attachments: { fileId: number; name: string; size: number; mimeType: string }[];
  createdAt: string;
}

interface RecipientChip {
  id?: number;
  name?: string;
  email: string;
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
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-ink-900">{activeEmail.senderName}</p>
                      {activeEmail.deliveryStatus && (
                        <span
                          className={cx(
                            'text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider',
                            activeEmail.deliveryStatus === 'accepted' || activeEmail.deliveryStatus === 'delivered'
                              ? 'bg-emerald-100 text-emerald-800'
                              : activeEmail.deliveryStatus === 'failed'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800',
                          )}
                        >
                          {activeEmail.deliveryStatus === 'accepted' ? 'Accepted by SMTP' : activeEmail.deliveryStatus}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-500">From: &lt;{activeEmail.senderEmail}&gt;</p>
                    <p className="text-xs text-ink-500">To: {activeEmail.recipientName || activeEmail.recipientEmail} &lt;{activeEmail.recipientEmail}&gt;</p>
                    {activeEmail.cc && (
                      <p className="text-xs text-ink-500">Cc: {activeEmail.cc}</p>
                    )}
                    {activeEmail.bcc && (
                      <p className="text-xs text-ink-500">Bcc: {activeEmail.bcc}</p>
                    )}
                    {activeEmail.providerMessageId && (
                      <p className="text-[11px] text-ink-400 font-mono mt-0.5">Message-ID: {activeEmail.providerMessageId}</p>
                    )}
                    {activeEmail.lastError && (
                      <p className="text-xs text-rose-600 mt-1">Delivery notice: {activeEmail.lastError}</p>
                    )}
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
                        href={fileUrl(att.fileId, true)}
                        download={att.name}
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
        onSent={async (result) => {
          setComposeOpen(false);
          await loadEmails();
          if (result.success || result.status === 'accepted') {
            toast.success(`Email accepted by SMTP server for delivery!`);
          } else if (result.status === 'queued') {
            toast.info(`Email queued for delivery.`);
          } else if (!result.deliveryConfigured) {
            toast.warning(`Saved in Workforce mailbox. Outgoing SMTP is not configured on the server.`);
          } else {
            toast.error(result.error || 'Email delivery failed.');
          }
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
  onSent: (result: SendResult) => Promise<void>;
  initialReply?: { recipientId?: number; subject?: string };
}) {
  const toast = useToast();
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const [contacts, setContacts] = useState<PickerEmployee[]>([]);
  const [toRecipients, setToRecipients] = useState<RecipientChip[]>([]);
  const [ccRecipients, setCcRecipients] = useState<RecipientChip[]>([]);
  const [bccRecipients, setBccRecipients] = useState<RecipientChip[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  const [toSearch, setToSearch] = useState('');
  const [toOpen, setToOpen] = useState(false);
  const [ccSearch, setCcSearch] = useState('');
  const [ccOpen, setCcOpen] = useState(false);
  const [bccSearch, setBccSearch] = useState('');
  const [bccOpen, setBccOpen] = useState(false);

  const formatRealEmail = (email?: string | null, name?: string): string => {
    if (email && !email.toLowerCase().includes('@workforce.test')) {
      return email;
    }
    const clean = (name || 'employee').toLowerCase().trim().replace(/[^a-z0-9]+/g, '.');
    return `${clean}@bsctextiles.in`;
  };

  const isValidEmail = (str: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());
  };

  const addRecipient = (type: 'to' | 'cc' | 'bcc', chip: RecipientChip) => {
    const list = type === 'to' ? toRecipients : type === 'cc' ? ccRecipients : bccRecipients;
    if (list.some((r) => r.email.toLowerCase() === chip.email.toLowerCase())) {
      toast.info(`${chip.email} is already added.`);
      return;
    }
    if (type === 'to') {
      setToRecipients((prev) => [...prev, chip]);
      setToSearch('');
      setToOpen(false);
    } else if (type === 'cc') {
      setCcRecipients((prev) => [...prev, chip]);
      setCcSearch('');
      setCcOpen(false);
    } else {
      setBccRecipients((prev) => [...prev, chip]);
      setBccSearch('');
      setBccOpen(false);
    }
  };

  const addRawEmail = (type: 'to' | 'cc' | 'bcc', raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return;
    if (!isValidEmail(trimmed)) {
      toast.error(`"${raw}" is not a valid email address.`);
      return;
    }
    addRecipient(type, { email: trimmed, name: trimmed });
  };

  const removeRecipient = (type: 'to' | 'cc' | 'bcc', email: string) => {
    if (type === 'to') setToRecipients((prev) => prev.filter((r) => r.email !== email));
    else if (type === 'cc') setCcRecipients((prev) => prev.filter((r) => r.email !== email));
    else setBccRecipients((prev) => prev.filter((r) => r.email !== email));
  };

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<{ fileId: number; name: string; size: number; mimeType: string }[]>([]);
  const [showFormatting, setShowFormatting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .get<{ contacts: PickerEmployee[] }>('/chat/contacts')
      .then((res) => {
        setContacts(res.contacts);
        if (initialReply?.recipientId) {
          const existing = res.contacts.find((c) => c.id === initialReply.recipientId);
          if (existing) {
            setToRecipients([{ id: existing.id, name: existing.full_name, email: formatRealEmail(existing.email, existing.full_name) }]);
          }
        }
      })
      .catch(() => undefined);

    if (!initialReply?.recipientId) {
      setToRecipients([]);
    }
    setCcRecipients([]);
    setBccRecipients([]);
    setShowCc(false);
    setShowBcc(false);
    setSubject(initialReply?.subject ?? '');
    setBody('');
    setAttachments([]);
    setMinimized(false);
    setMaximized(false);
    setToSearch('');
    setToOpen(false);
  }, [open, initialReply]);

  const filterEmployees = (queryText: string, excludedEmails: string[]) => {
    const q = queryText.trim().toLowerCase();
    const available = contacts.filter((c) => !excludedEmails.includes((c.email || '').toLowerCase()) && !excludedEmails.includes(formatRealEmail(c.email, c.full_name).toLowerCase()));
    if (!q) return available.slice(0, 10);
    return available
      .filter((c) => {
        const name = (c.full_name ?? '').toLowerCase();
        const rawEmail = (c.email ?? '').toLowerCase();
        const realEmail = formatRealEmail(c.email, c.full_name).toLowerCase();
        const dept = (c.department_name ?? '').toLowerCase();
        const desig = (c.designation_title ?? '').toLowerCase();
        return name.includes(q) || rawEmail.includes(q) || realEmail.includes(q) || dept.includes(q) || desig.includes(q);
      })
      .slice(0, 10);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const res = await api.upload<{ id: number; name: string; mimeType: string; size: number }>(file);
        setAttachments((prev) => [
          ...prev,
          { fileId: res.id, name: file.name, size: file.size, mimeType: file.type || res.mimeType },
        ]);
      }
      toast.success(`${files.length} file(s) attached.`);
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

  const applyFormat = (syntax: string) => {
    setBody((prev) => `${prev} ${syntax}`);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (toRecipients.length === 0) {
      toast.error('Please enter or select at least one recipient email.');
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
      const result = await api.post<SendResult>('/emails/send', {
        recipientIds: toRecipients.filter((r) => r.id).map((r) => r.id!),
        toEmails: toRecipients.map((r) => r.email),
        ccEmails: ccRecipients.map((r) => r.email),
        bccEmails: bccRecipients.map((r) => r.email),
        subject: subject.trim(),
        body: body.trim(),
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      if (result.success || result.status === 'accepted') {
        toast.success(`Email accepted by mail server! Message ID: ${result.messageId || 'OK'}`);
      } else if (result.status === 'queued') {
        toast.info('Email queued for background delivery.');
      } else {
        toast.error(result.error || 'Email could not be delivered.');
      }
      await onSent(result);
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
      // Form content is preserved so user does not lose their draft!
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  // Minimized dock at bottom right
  if (minimized) {
    return (
      <div
        className="fixed bottom-0 right-4 sm:right-8 z-50 h-10 w-72 rounded-t-xl bg-[#f2f6fc] border border-slate-300 shadow-2xl flex items-center justify-between px-3.5 cursor-pointer hover:bg-slate-200 transition-colors"
        onClick={() => setMinimized(false)}
      >
        <span className="text-xs font-semibold text-slate-800 truncate">
          {subject.trim() || initialReply?.subject || 'New Message'}
        </span>
        <div className="flex items-center gap-1.5 text-slate-600" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            title="Restore window"
            className="p-1 hover:bg-slate-300 rounded text-slate-600"
            onClick={() => setMinimized(false)}
          >
            <Icon name="maximize" size={12} />
          </button>
          <button
            type="button"
            title="Close"
            className="p-1 hover:bg-slate-300 rounded text-slate-600"
            onClick={onClose}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {maximized && <div className="fixed inset-0 bg-black/40 z-40 transition-opacity" onClick={() => setMaximized(false)} />}
      <div
        className={cx(
          'fixed z-50 flex flex-col bg-white border border-slate-300 shadow-2xl overflow-hidden transition-all',
          maximized
            ? 'inset-3 sm:inset-6 rounded-2xl'
            : 'bottom-0 right-2 sm:right-8 w-[calc(100vw-1rem)] sm:w-[580px] md:w-[620px] h-[600px] rounded-t-2xl',
        )}
      >
        {/* Title Bar matching Image 2 */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#f2f6fc] border-b border-slate-200 select-none">
          <span className="text-sm font-semibold text-slate-800">
            {initialReply?.subject ? initialReply.subject : 'New Message'}
          </span>
          <div className="flex items-center gap-1 text-slate-600">
            <button
              type="button"
              title="Minimize"
              className="p-1.5 hover:bg-slate-200 rounded text-slate-600 transition-colors"
              onClick={() => setMinimized(true)}
            >
              <Icon name="minus" size={13} />
            </button>
            <button
              type="button"
              title={maximized ? 'Exit full screen' : 'Full screen'}
              className="p-1.5 hover:bg-slate-200 rounded text-slate-600 transition-colors"
              onClick={() => setMaximized((v) => !v)}
            >
              <Icon name={maximized ? 'minimize' : 'maximize'} size={13} />
            </button>
            <button
              type="button"
              title="Close"
              className="p-1.5 hover:bg-slate-200 rounded text-slate-600 transition-colors"
              onClick={onClose}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        {/* Recipients (To) Section with instant search and manual email entry */}
        <div className="relative border-b border-slate-200 px-4 py-1.5 flex flex-wrap items-center gap-1.5 min-h-[42px]">
          <span className="text-xs font-medium text-slate-500 w-16 shrink-0">Recipients</span>
          <div className="flex-1 flex flex-wrap items-center gap-1.5">
            {toRecipients.map((r) => (
              <span
                key={r.email}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 pl-1.5 pr-2 py-0.5 text-xs text-slate-800"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white uppercase">
                  {(r.name || r.email)[0]}
                </span>
                <span className="font-medium max-w-[170px] truncate">{r.name && r.name !== r.email ? r.name : r.email}</span>
                <button
                  type="button"
                  title={`Remove ${r.email}`}
                  className="text-slate-400 hover:text-red-600 ml-0.5"
                  onClick={() => removeRecipient('to', r.email)}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              type="text"
              value={toSearch}
              onChange={(e) => {
                setToSearch(e.target.value);
                setToOpen(true);
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && toSearch.trim()) {
                  e.preventDefault();
                  addRawEmail('to', toSearch);
                }
              }}
              onFocus={() => setToOpen(true)}
              placeholder={toRecipients.length === 0 ? 'Type email address or search name...' : 'Add another recipient...'}
              className="flex-1 min-w-[160px] text-xs text-slate-800 placeholder-slate-400 focus:outline-none py-1 bg-transparent"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 shrink-0">
            {!showCc && (
              <button
                type="button"
                className="hover:text-slate-900 font-medium"
                onClick={() => setShowCc(true)}
              >
                Cc
              </button>
            )}
            {!showBcc && (
              <button
                type="button"
                className="hover:text-slate-900 font-medium"
                onClick={() => setShowBcc(true)}
              >
                Bcc
              </button>
            )}
          </div>

          {/* Autocomplete Dropdown for "To" */}
          {toOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setToOpen(false)} />
              <div className="absolute left-16 right-4 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
                {toSearch.trim() && (
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-blue-700 bg-blue-50/70 hover:bg-blue-100 font-medium border-b border-slate-100"
                    onClick={() => addRawEmail('to', toSearch)}
                  >
                    <Icon name="mail" size={13} className="text-blue-600 shrink-0" />
                    <span>Send to email: <strong>{toSearch.trim()}</strong></span>
                  </button>
                )}
                {filterEmployees(toSearch, toRecipients.map((r) => r.email)).map((emp) => (
                  <button
                    key={emp.id}
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-blue-50 transition-colors"
                    onClick={() => addRecipient('to', { id: emp.id, name: emp.full_name, email: formatRealEmail(emp.email, emp.full_name) })}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-xs font-semibold">
                        {emp.full_name[0]}
                      </span>
                      <div>
                        <p className="font-semibold text-slate-800">{emp.full_name}</p>
                        <p className="text-[11px] text-slate-500">{formatRealEmail(emp.email, emp.full_name)}</p>
                      </div>
                    </div>
                    {emp.designation_title && (
                      <span className="text-[10px] text-slate-400 bg-slate-100 rounded px-1.5 py-0.5">
                        {emp.designation_title}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Optional Cc Line */}
        {showCc && (
          <div className="relative border-b border-slate-200 px-4 py-1.5 flex flex-wrap items-center gap-1.5 min-h-[38px]">
            <span className="text-xs font-medium text-slate-500 w-16 shrink-0">Cc</span>
            <div className="flex-1 flex flex-wrap items-center gap-1.5">
              {ccRecipients.map((r) => (
                <span
                  key={r.email}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 pl-1.5 pr-2 py-0.5 text-xs text-slate-800"
                >
                  <span className="font-medium max-w-[160px] truncate">{r.name && r.name !== r.email ? r.name : r.email}</span>
                  <button
                    type="button"
                    className="text-slate-400 hover:text-red-600 ml-0.5"
                    onClick={() => removeRecipient('cc', r.email)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={ccSearch}
                onChange={(e) => {
                  setCcSearch(e.target.value);
                  setCcOpen(true);
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && ccSearch.trim()) {
                    e.preventDefault();
                    addRawEmail('cc', ccSearch);
                  }
                }}
                onFocus={() => setCcOpen(true)}
                placeholder="Add Cc email or employee..."
                className="flex-1 min-w-[120px] text-xs text-slate-800 placeholder-slate-400 focus:outline-none py-1 bg-transparent"
              />
            </div>
            {ccOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCcOpen(false)} />
                <div className="absolute left-16 right-4 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
                  {ccSearch.trim() && (
                    <button
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-blue-700 bg-blue-50/70 hover:bg-blue-100 font-medium border-b border-slate-100"
                      onClick={() => addRawEmail('cc', ccSearch)}
                    >
                      <Icon name="mail" size={13} className="text-blue-600 shrink-0" />
                      <span>Add Cc: <strong>{ccSearch.trim()}</strong></span>
                    </button>
                  )}
                  {filterEmployees(ccSearch, [...toRecipients, ...ccRecipients].map((r) => r.email)).map((emp) => (
                    <button
                      key={emp.id}
                      type="button"
                      className="w-full flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-blue-50"
                      onClick={() => addRecipient('cc', { id: emp.id, name: emp.full_name, email: formatRealEmail(emp.email, emp.full_name) })}
                    >
                      <span className="font-medium text-slate-800">{emp.full_name}</span>
                      <span className="text-[11px] text-slate-500">{formatRealEmail(emp.email, emp.full_name)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Optional Bcc Line */}
        {showBcc && (
          <div className="relative border-b border-slate-200 px-4 py-1.5 flex flex-wrap items-center gap-1.5 min-h-[38px]">
            <span className="text-xs font-medium text-slate-500 w-16 shrink-0">Bcc</span>
            <div className="flex-1 flex flex-wrap items-center gap-1.5">
              {bccRecipients.map((r) => (
                <span
                  key={r.email}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 pl-1.5 pr-2 py-0.5 text-xs text-slate-800"
                >
                  <span className="font-medium max-w-[160px] truncate">{r.name && r.name !== r.email ? r.name : r.email}</span>
                  <button
                    type="button"
                    className="text-slate-400 hover:text-red-600 ml-0.5"
                    onClick={() => removeRecipient('bcc', r.email)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={bccSearch}
                onChange={(e) => {
                  setBccSearch(e.target.value);
                  setBccOpen(true);
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && bccSearch.trim()) {
                    e.preventDefault();
                    addRawEmail('bcc', bccSearch);
                  }
                }}
                onFocus={() => setBccOpen(true)}
                placeholder="Add Bcc email or employee..."
                className="flex-1 min-w-[120px] text-xs text-slate-800 placeholder-slate-400 focus:outline-none py-1 bg-transparent"
              />
            </div>
            {bccOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setBccOpen(false)} />
                <div className="absolute left-16 right-4 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
                  {bccSearch.trim() && (
                    <button
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-blue-700 bg-blue-50/70 hover:bg-blue-100 font-medium border-b border-slate-100"
                      onClick={() => addRawEmail('bcc', bccSearch)}
                    >
                      <Icon name="mail" size={13} className="text-blue-600 shrink-0" />
                      <span>Add Bcc: <strong>{bccSearch.trim()}</strong></span>
                    </button>
                  )}
                  {filterEmployees(bccSearch, [...toRecipients, ...ccRecipients, ...bccRecipients].map((r) => r.email)).map((emp) => (
                    <button
                      key={emp.id}
                      type="button"
                      className="w-full flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-blue-50"
                      onClick={() => addRecipient('bcc', { id: emp.id, name: emp.full_name, email: formatRealEmail(emp.email, emp.full_name) })}
                    >
                      <span className="font-medium text-slate-800">{emp.full_name}</span>
                      <span className="text-[11px] text-slate-500">{formatRealEmail(emp.email, emp.full_name)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Subject Line matching Image 2 */}
        <div className="border-b border-slate-200 px-4 py-2">
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="w-full text-sm font-normal text-slate-900 placeholder-slate-400 focus:outline-none bg-transparent"
          />
        </div>

        {/* Message Body matching Image 2 */}
        <div className="flex-1 px-4 py-3 flex flex-col overflow-y-auto bg-white">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your email here..."
            className="w-full flex-1 min-h-[220px] text-sm text-slate-800 placeholder-slate-400 focus:outline-none resize-none font-sans leading-relaxed bg-transparent"
          />

          {/* Attachments Chips */}
          {attachments.length > 0 && (
            <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div
                  key={a.fileId}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 shadow-sm"
                >
                  <Icon name="paperclip" size={13} className="text-slate-400 shrink-0" />
                  <span className="font-medium max-w-[180px] truncate">{a.name}</span>
                  <span className="text-[10px] text-slate-400">
                    ({(a.size / 1024).toFixed(0)} KB)
                  </span>
                  <button
                    type="button"
                    title="Remove attachment"
                    className="text-slate-400 hover:text-red-500 font-bold ml-1"
                    onClick={() => removeAttachment(a.fileId)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Formatting Toolbar matching Image 2 */}
        {showFormatting && (
          <div className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 flex items-center gap-1 text-slate-600 text-xs overflow-x-auto select-none">
            <button
              type="button"
              title="Undo"
              onClick={() => toast.info('Undo')}
              className="p-1 hover:bg-slate-200 rounded text-slate-600"
            >
              <Icon name="undo" size={13} />
            </button>
            <button
              type="button"
              title="Redo"
              onClick={() => toast.info('Redo')}
              className="p-1 hover:bg-slate-200 rounded text-slate-600"
            >
              <Icon name="redo" size={13} />
            </button>
            <div className="h-4 w-px bg-slate-300 mx-1" />

            <span className="px-1 text-slate-700 font-sans cursor-pointer hover:bg-slate-200 rounded">Sans Serif ▾</span>
            <span className="px-1 text-slate-700 font-sans cursor-pointer hover:bg-slate-200 rounded">TT ▾</span>
            <div className="h-4 w-px bg-slate-300 mx-1" />

            <button
              type="button"
              title="Bold"
              onClick={() => applyFormat('**bold text**')}
              className="p-1 hover:bg-slate-200 rounded font-bold text-slate-700 px-1.5"
            >
              <Icon name="bold" size={13} />
            </button>
            <button
              type="button"
              title="Italic"
              onClick={() => applyFormat('*italic text*')}
              className="p-1 hover:bg-slate-200 rounded italic text-slate-700 px-1.5"
            >
              <Icon name="italic" size={13} />
            </button>
            <button
              type="button"
              title="Underline"
              onClick={() => applyFormat('__underlined text__')}
              className="p-1 hover:bg-slate-200 rounded underline text-slate-700 px-1.5"
            >
              <Icon name="underline" size={13} />
            </button>
            <div className="h-4 w-px bg-slate-300 mx-1" />

            <button
              type="button"
              title="Align left"
              className="p-1 hover:bg-slate-200 rounded text-slate-600"
            >
              <Icon name="alignLeft" size={13} />
            </button>
            <button
              type="button"
              title="Numbered list"
              onClick={() => applyFormat('\n1. Item 1\n2. Item 2')}
              className="p-1 hover:bg-slate-200 rounded text-slate-600"
            >
              <Icon name="listOrdered" size={13} />
            </button>
            <button
              type="button"
              title="Bulleted list"
              onClick={() => applyFormat('\n• Point 1\n• Point 2')}
              className="p-1 hover:bg-slate-200 rounded text-slate-600"
            >
              <Icon name="list" size={13} />
            </button>
            <button
              type="button"
              title="Quote"
              onClick={() => applyFormat('\n> Quote text')}
              className="p-1 hover:bg-slate-200 rounded text-slate-600"
            >
              <Icon name="quote" size={13} />
            </button>
          </div>
        )}

        {/* Bottom Action Bar with Send Split Button & Tool Icons matching Image 2 */}
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 bg-white">
          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Blue Send Split Button */}
            <div className="inline-flex items-stretch rounded-full bg-blue-600 shadow-sm hover:bg-blue-700 transition-colors">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || uploading}
                className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white focus:outline-none disabled:opacity-50"
              >
                {busy ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>Sending via SMTP...</span>
                  </>
                ) : (
                  <>
                    <span>Send</span>
                    <Icon name="send" size={13} />
                  </>
                )}
              </button>
              <button
                type="button"
                title="Send options"
                disabled={busy || uploading}
                className="border-l border-blue-500 pr-3 pl-2 py-2 hover:bg-blue-800 rounded-r-full text-white focus:outline-none disabled:opacity-50"
                onClick={() => toast.info('Direct SMTP delivery active')}
              >
                <Icon name="chevronDown" size={14} />
              </button>
            </div>

            {/* Action Tool Icons */}
            <button
              type="button"
              title="Formatting options"
              onClick={() => setShowFormatting((v) => !v)}
              className={cx(
                'p-2 rounded hover:bg-slate-100 transition-colors',
                showFormatting ? 'text-blue-600 bg-blue-50' : 'text-slate-600',
              )}
            >
              <span className="font-serif font-bold text-xs">Aa</span>
            </button>

            <label
              className="cursor-pointer p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
              title="Attach files"
            >
              <Icon name="paperclip" size={16} />
              <input type="file" multiple className="hidden" onChange={handleFileUpload} disabled={uploading} />
            </label>

            <button
              type="button"
              title="Insert link"
              onClick={() => {
                const url = window.prompt('Enter link URL:');
                if (url) applyFormat(`[link](${url})`);
              }}
              className="p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Icon name="link" size={15} />
            </button>

            <button
              type="button"
              title="Insert emoji"
              onClick={() => applyFormat('😊')}
              className="p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <span className="text-sm leading-none">😊</span>
            </button>

            <button
              type="button"
              title="Insert files using Drive"
              onClick={() => toast.info('BSC Workforce Cloud Storage connected')}
              className="p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Icon name="folder" size={15} />
            </button>

            <label
              className="cursor-pointer p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
              title="Insert photo"
            >
              <Icon name="image" size={15} />
              <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} disabled={uploading} />
            </label>

            <button
              type="button"
              title="Toggle confidential mode"
              onClick={() => toast.info('Confidential mode: workforce internal encryption is active')}
              className="p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Icon name="lock" size={15} />
            </button>

            <button
              type="button"
              title="Insert signature"
              onClick={() => applyFormat('\n\n--\nBest regards,\nBSC Textiles Workforce Team')}
              className="p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Icon name="edit" size={15} />
            </button>

            <button
              type="button"
              title="More options"
              onClick={() => toast.info('Additional email options')}
              className="p-2 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Icon name="moreVertical" size={15} />
            </button>
          </div>

          {/* Right Discard Draft Trash Button */}
          <button
            type="button"
            title="Discard draft"
            onClick={onClose}
            className="p-2 rounded hover:bg-slate-100 text-slate-500 hover:text-red-600 transition-colors"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>
    </>
  );
}
