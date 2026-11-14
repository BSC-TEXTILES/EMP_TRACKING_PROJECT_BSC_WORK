import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime, useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, EmptyState, Field, Modal, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDayLabel, formatTime } from '../lib/format';
import type { ChatMessage, ConversationSummary, PickerEmployee } from '../lib/types';

interface ConversationDetail {
  id: number;
  type: 'direct' | 'group' | 'channel';
  name: string | null;
  description: string | null;
  isAnnouncement: boolean;
  createdBy: number | null;
  myRole: string;
  members: { employeeId: number; name: string; photoUrl: string | null; role: string; designation: string | null; online: boolean; lastSeenAt: string | null }[];
}

const QUICK_EMOJI = ['👍', '✅', '🙏', '🎉', '❤️'];

export default function Chat() {
  useDocumentTitle('Messages');
  const { user } = useAuth();
  const toast = useToast();
  const { socket, connected, onlineIds } = useRealtime();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('c') ? Number(params.get('c')) : null;

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState('');
  const [contactsOpen, setContactsOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const result = await api.get<{ conversations: ConversationSummary[] }>('/chat/conversations');
      setConversations(result.conversations);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMessages = useCallback(
    async (conversationId: number) => {
      setLoadingMessages(true);
      try {
        const [messageResult, conversation] = await Promise.all([
          api.get<{ messages: ChatMessage[] }>(`/chat/conversations/${conversationId}/messages?limit=60`),
          api.get<ConversationDetail>(`/chat/conversations/${conversationId}`),
        ]);
        setMessages([...messageResult.messages].reverse());
        setDetail(conversation);
        await api.post(`/chat/conversations/${conversationId}/read`);
        setConversations((prev) => prev.map((item) => (item.id === conversationId ? { ...item, unread: 0 } : item)));
        window.dispatchEvent(new CustomEvent('notifications:changed'));
      } catch (caught) {
        toast.error(errorMessage(caught));
      } finally {
        setLoadingMessages(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (activeId) {
      void loadMessages(activeId);
      setMobileOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useSocketEvent('message:new', (payload) => {
    const message = payload as ChatMessage;
    if (!message?.conversationId) return;
    if (message.conversationId === activeId) {
      setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message]));
      void api.post(`/chat/conversations/${activeId}/read`).catch(() => undefined);
    }
    void loadConversations();
  });
  useSocketEvent('message:read', () => {
    if (activeId) void loadMessages(activeId);
  });
  useSocketEvent('message:edited', () => {
    if (activeId) void loadMessages(activeId);
  });
  useSocketEvent('message:deleted', () => {
    if (activeId) void loadMessages(activeId);
  });
  useSocketEvent('message:reaction', () => {
    if (activeId) void loadMessages(activeId);
  });
  useSocketEvent('chat:typing', (payload) => {
    const data = payload as { conversationId: number; employeeId: number; name: string; typing: boolean };
    if (data.conversationId !== activeId || data.employeeId === user?.id) return;
    setTypingUsers((prev) => {
      const next = { ...prev };
      if (data.typing) next[data.employeeId] = data.name;
      else delete next[data.employeeId];
      return next;
    });
    if (data.typing) {
      window.setTimeout(() => {
        setTypingUsers((prev) => {
          if (!prev[data.employeeId]) return prev;
          const next = { ...prev };
          delete next[data.employeeId];
          return next;
        });
      }, 6000);
    }
  });

  const openConversation = (id: number) => {
    setParams({ c: String(id) });
  };

  const startDirect = async (employeeId: number) => {
    try {
      const result = await api.post<{ id: number }>('/chat/conversations/direct', { employeeId });
      setContactsOpen(false);
      await loadConversations();
      openConversation(result.id);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const send = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!activeId || !text.trim()) return;
    const body = text.trim();
    setText('');
    setReplyTo(null);
    try {
      await api.post(`/chat/conversations/${activeId}/messages`, { body, replyToId: replyTo?.id });
      socket?.emit('chat:typing', { conversationId: activeId, typing: false });
    } catch (caught) {
      toast.error(errorMessage(caught));
      setText(body);
    }
  };

  const sendFile = async (file: File) => {
    if (!activeId) return;
    try {
      const uploaded = await api.upload<{ id: number; mimeType: string }>(file);
      const type = uploaded.mimeType.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'voice' : 'file';
      await api.post(`/chat/conversations/${activeId}/messages`, { fileIds: [uploaded.id], type, body: text.trim() || undefined });
      setText('');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const onTyping = (value: string) => {
    setText(value);
    if (!activeId || !socket) return;
    socket.emit('chat:typing', { conversationId: activeId, typing: true });
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => socket.emit('chat:typing', { conversationId: activeId, typing: false }), 1800);
  };

  const filtered = conversations.filter((conversation) =>
    filter ? conversation.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  const active = conversations.find((conversation) => conversation.id === activeId);
  const otherOnline = active?.otherEmployeeId ? onlineIds.includes(active.otherEmployeeId) : false;

  return (
    <div className="flex h-[calc(100vh-8.5rem)] min-h-[520px] overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      <aside className={cx('flex w-full flex-col border-r border-ink-200 sm:w-80', mobileOpen && 'hidden sm:flex')}>
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-ink-900">Messages</h1>
            <span className={cx('h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-ink-300')} title={connected ? 'Real-time connected' : 'Reconnecting…'} />
          </div>
          <div className="flex gap-1">
            <button type="button" className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100" title="New chat" onClick={() => setContactsOpen(true)}>
              <Icon name="plus" size={16} />
            </button>
            <button type="button" className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100" title="New group" onClick={() => setGroupOpen(true)}>
              <Icon name="users" size={16} />
            </button>
          </div>
        </div>
        <div className="border-b border-ink-100 p-2">
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input py-1.5 pl-8 text-sm" placeholder="Search conversations" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-3">
              <Skeleton lines={6} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState compact title="No conversations" description="Start a direct chat or create a group." />
          ) : (
            filtered.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => openConversation(conversation.id)}
                className={cx(
                  'flex w-full items-start gap-2.5 border-b border-ink-100 px-3 py-2.5 text-left hover:bg-ink-50',
                  activeId === conversation.id && 'bg-brand-50 hover:bg-brand-50',
                )}
              >
                <Avatar
                  name={conversation.name}
                  size={38}
                  online={conversation.otherEmployeeId ? onlineIds.includes(conversation.otherEmployeeId) : undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink-900">{conversation.name}</p>
                    {conversation.lastMessageAt && <span className="shrink-0 text-[10px] text-ink-400">{formatTime(conversation.lastMessageAt)}</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs text-ink-500">
                      {conversation.lastSender ? `${conversation.lastSender.split(' ')[0]}: ` : ''}
                      {conversation.lastMessage ?? 'No messages yet'}
                    </p>
                    {conversation.unread > 0 && (
                      <span className="shrink-0 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{conversation.unread}</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex gap-1">
                    {conversation.type === 'channel' && <Badge tone="brand">Channel</Badge>}
                    {conversation.type === 'group' && <Badge tone="neutral">{conversation.memberCount} members</Badge>}
                    {conversation.isAnnouncement && <Badge tone="warning">Announcements</Badge>}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className={cx('flex min-w-0 flex-1 flex-col', !mobileOpen && 'hidden sm:flex')}>
        {!activeId ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              title="Select a conversation"
              description="Your messages are delivered in real time and stored permanently. Offline colleagues receive notifications."
            />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-2 border-b border-ink-200 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button type="button" className="rounded-lg p-1 text-ink-500 hover:bg-ink-100 sm:hidden" onClick={() => setMobileOpen(false)}>
                  <Icon name="chevronLeft" size={18} />
                </button>
                <Avatar name={active?.name ?? detail?.name ?? 'Conversation'} size={34} online={otherOnline || undefined} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900">{active?.name ?? detail?.name ?? 'Conversation'}</p>
                  <p className="truncate text-xs text-ink-500">
                    {Object.values(typingUsers).length > 0
                      ? `${Object.values(typingUsers).join(', ')} typing…`
                      : otherOnline
                        ? 'Online'
                        : detail?.type === 'direct'
                          ? 'Offline'
                          : `${detail?.members.length ?? 0} members`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100" title="Search in conversation" onClick={() => setSearch(search ? '' : ' ')}>
                  <Icon name="search" size={16} />
                </button>
              </div>
            </header>

            {search && (
              <div className="border-b border-ink-100 p-2">
                <input
                  autoFocus
                  className="input py-1.5 text-sm"
                  placeholder="Search messages and press Enter"
                  value={search.trim()}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={async (event) => {
                    if (event.key !== 'Enter' || !activeId) return;
                    try {
                      const result = await api.get<{ messages: ChatMessage[] }>(
                        `/chat/conversations/${activeId}/messages?search=${encodeURIComponent(search.trim())}&limit=60`,
                      );
                      setMessages([...result.messages].reverse());
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    }
                  }}
                />
              </div>
            )}

            <div className="flex-1 space-y-1 overflow-y-auto bg-[#efeae2] px-3 py-3">
              {loadingMessages && messages.length === 0 ? (
                <Skeleton lines={8} />
              ) : messages.length === 0 ? (
                <EmptyState compact title="No messages yet" description="Say hello to start the conversation." />
              ) : (
                messages.map((message, index) => {
                  const mine = message.senderId === user?.id;
                  const showDay = index === 0 || formatDayLabel(message.createdAt) !== formatDayLabel(messages[index - 1].createdAt);
                  return (
                    <div key={message.id}>
                      {showDay && (
                        <div className="my-2 text-center">
                          <span className="rounded-full bg-white/80 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-500">
                            {formatDayLabel(message.createdAt)}
                          </span>
                        </div>
                      )}
                      <div className={cx('group flex gap-1.5', mine ? 'justify-end' : 'justify-start')}>
                        {!mine && <Avatar name={message.senderName} src={message.senderPhoto} size={26} />}
                        <div className={cx('max-w-[78%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm', mine ? 'bg-[#d9fdd3]' : 'bg-white')}>
                          {!mine && detail?.type !== 'direct' && (
                            <p className="mb-0.5 text-[11px] font-semibold text-brand-700">{message.senderName}</p>
                          )}
                          {message.replyToBody && (
                            <div className="mb-1 rounded border-l-2 border-brand-500 bg-black/5 px-1.5 py-1 text-[11px] text-ink-600">
                              <span className="font-semibold">{message.replyToSender}</span>: {message.replyToBody.slice(0, 120)}
                            </div>
                          )}
                          {message.deleted ? (
                            <p className="italic text-ink-400">This message was deleted</p>
                          ) : (
                            <>
                              {message.type === 'image' && message.attachments[0] && (
                                <a href={`/api/files/${message.attachments[0].fileId}`} target="_blank" rel="noreferrer">
                                  <img src={`/api/files/${message.attachments[0].fileId}`} alt={message.attachments[0].original_name} className="mb-1 max-h-64 rounded" />
                                </a>
                              )}
                              {(message.type === 'file' || message.type === 'voice') &&
                                message.attachments.map((attachment) => (
                                  <a
                                    key={attachment.fileId}
                                    href={`/api/files/${attachment.fileId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mb-1 flex items-center gap-1.5 rounded bg-black/5 px-1.5 py-1 text-xs text-brand-700"
                                  >
                                    <Icon name="file" size={14} /> {attachment.original_name}
                                  </a>
                                ))}
                              {message.body && <p className="whitespace-pre-line break-words text-ink-800">{message.body}</p>}
                            </>
                          )}
                          <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-400">
                            {message.editedAt && <span>edited</span>}
                            <span>{formatTime(message.createdAt)}</span>
                            {mine && <span title="Delivered">{message.id ? '✓✓' : '✓'}</span>}
                          </div>
                          {message.reactions.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {message.reactions.map((reaction) => (
                                <span key={`${reaction.employeeId}-${reaction.emoji}`} className="rounded-full bg-white px-1 text-[11px]" title={reaction.name}>
                                  {reaction.emoji}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="mt-1 hidden gap-1 group-hover:flex">
                            {QUICK_EMOJI.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                className="rounded px-0.5 text-xs hover:bg-black/5"
                                onClick={async () => {
                                  try {
                                    await api.post(`/chat/messages/${message.id}/reactions`, { emoji });
                                  } catch (caught) {
                                    toast.error(errorMessage(caught));
                                  }
                                }}
                              >
                                {emoji}
                              </button>
                            ))}
                            <button type="button" className="rounded px-0.5 text-[10px] text-ink-500 hover:bg-black/5" onClick={() => setReplyTo(message)}>
                              Reply
                            </button>
                            {mine && !message.deleted && (
                              <>
                                <button
                                  type="button"
                                  className="rounded px-0.5 text-[10px] text-ink-500 hover:bg-black/5"
                                  onClick={async () => {
                                    const next = window.prompt('Edit message', message.body ?? '');
                                    if (!next || next === message.body) return;
                                    try {
                                      await api.patch(`/chat/messages/${message.id}`, { body: next });
                                    } catch (caught) {
                                      toast.error(errorMessage(caught));
                                    }
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="rounded px-0.5 text-[10px] text-red-600 hover:bg-black/5"
                                  onClick={async () => {
                                    if (!window.confirm('Delete this message? The deletion is recorded in the audit log.')) return;
                                    try {
                                      await api.del(`/chat/messages/${message.id}`);
                                    } catch (caught) {
                                      toast.error(errorMessage(caught));
                                    }
                                  }}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {replyTo && (
              <div className="flex items-center justify-between gap-2 border-t border-ink-200 bg-ink-50 px-3 py-1.5 text-xs">
                <span className="truncate">
                  Replying to <strong>{replyTo.senderName}</strong>: {replyTo.body?.slice(0, 80)}
                </span>
                <button type="button" className="text-ink-500" onClick={() => setReplyTo(null)}>
                  ✕
                </button>
              </div>
            )}

            <form onSubmit={send} className="flex items-end gap-2 border-t border-ink-200 px-2 py-2">
              <input ref={fileInput} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void sendFile(file); event.target.value = ''; }} />
              <button type="button" className="rounded-lg p-2 text-ink-500 hover:bg-ink-100" onClick={() => fileInput.current?.click()} title="Attach file">
                <Icon name="paperclip" size={18} />
              </button>
              <textarea
                className="input max-h-28 min-h-[40px] flex-1 resize-none py-2"
                rows={1}
                placeholder={detail?.isAnnouncement && detail.myRole !== 'admin' ? 'Only group admins can post here' : 'Type a message'}
                value={text}
                onChange={(event) => onTyping(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                disabled={Boolean(detail?.isAnnouncement && detail.myRole !== 'admin' && detail.createdBy !== user?.id)}
              />
              <button type="submit" className="btn-primary px-3 py-2" disabled={!text.trim()} title="Send">
                <Icon name="send" size={16} />
              </button>
            </form>
          </>
        )}
      </section>

      <ContactsModal open={contactsOpen} onClose={() => setContactsOpen(false)} onSelect={startDirect} onlineIds={onlineIds} />
      <GroupModal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        onlineIds={onlineIds}
        onCreated={async (id) => {
          setGroupOpen(false);
          await loadConversations();
          openConversation(id);
        }}
      />
    </div>
  );
}

function ContactsModal({
  open,
  onClose,
  onSelect,
  onlineIds,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (id: number) => Promise<void>;
  onlineIds: number[];
}) {
  const [contacts, setContacts] = useState<PickerEmployee[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    api
      .get<{ contacts: PickerEmployee[] }>('/chat/contacts')
      .then((result) => setContacts(result.contacts))
      .catch(() => setContacts([]));
  }, [open]);

  const filtered = (contacts ?? []).filter((contact) =>
    search ? `${contact.full_name} ${contact.designation_title ?? ''}`.toLowerCase().includes(search.toLowerCase()) : true,
  );

  return (
    <Modal open={open} onClose={onClose} title="New conversation" description="Start a direct chat with any active employee.">
      <input className="input mb-3" placeholder="Search employees" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {!contacts ? (
          <Skeleton lines={5} />
        ) : filtered.length === 0 ? (
          <EmptyState compact title="No employees found" />
        ) : (
          filtered.map((contact) => (
            <button
              key={contact.id}
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-ink-50"
              onClick={() => void onSelect(contact.id)}
            >
              <Avatar name={contact.full_name} size={32} online={onlineIds.includes(contact.id)} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-800">{contact.full_name}</p>
                <p className="truncate text-xs text-ink-500">
                  {contact.designation_title ?? '—'} {contact.department_name ? `· ${contact.department_name}` : ''}
                </p>
              </div>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

function GroupModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => Promise<void>; onlineIds: number[] }) {
  const toast = useToast();
  const [contacts, setContacts] = useState<PickerEmployee[]>([]);
  const [form, setForm] = useState({ name: '', description: '', isAnnouncement: false });
  const [members, setMembers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .get<{ contacts: PickerEmployee[] }>('/chat/contacts')
      .then((result) => setContacts(result.contacts))
      .catch(() => undefined);
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (members.length === 0) {
      toast.error('Select at least one member.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ id: number }>('/chat/conversations/group', {
        name: form.name,
        description: form.description || undefined,
        memberIds: members,
        isAnnouncement: form.isAnnouncement,
      });
      await onCreated(result.id);
      setForm({ name: '', description: '', isAnnouncement: false });
      setMembers([]);
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
      title="Create a group"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="group-form" className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit} className="space-y-4">
        <Field label="Group name" required>
          <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} minLength={2} required />
        </Field>
        <Field label="Description">
          <input className="input" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" className="h-4 w-4" checked={form.isAnnouncement} onChange={(event) => setForm({ ...form, isAnnouncement: event.target.checked })} />
          Announcement group (only admins can post)
        </label>
        <div>
          <span className="label">Members *</span>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-300 p-2">
            {contacts.map((contact) => (
              <label key={contact.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-ink-50">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={members.includes(contact.id)}
                  onChange={(event) => setMembers((prev) => (event.target.checked ? [...prev, contact.id] : prev.filter((id) => id !== contact.id)))}
                />
                {contact.full_name} <span className="text-xs text-ink-400">{contact.designation_title ?? ''}</span>
              </label>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}
