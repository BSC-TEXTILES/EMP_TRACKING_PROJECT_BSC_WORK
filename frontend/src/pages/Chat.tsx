import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, errorMessage, fileUrl, type UploadedFile } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime, useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, EmptyState, Field, Modal, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDayLabel, formatTime } from '../lib/format';
import { useCall } from '../components/CallInterface';
import type { ChatMessage, ConversationSummary, PickerEmployee } from '../lib/types';

interface ConversationDetail {
  id: number;
  type: 'direct' | 'group' | 'channel';
  name: string | null;
  description: string | null;
  isAnnouncement: boolean;
  createdBy: number | null;
  myRole: string;
  otherEmployee?: {
    id: number;
    name: string;
    photoUrl: string | null;
    phone: string | null;
    email: string | null;
    designation: string | null;
    online: boolean;
  } | null;
  members: {
    employeeId: number;
    name: string;
    photoUrl: string | null;
    phone?: string | null;
    email?: string | null;
    role: string;
    designation: string | null;
    online: boolean;
    lastSeenAt: string | null;
  }[];
}

interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore: number | null;
}

interface UploadItem {
  key: string;
  conversationId: number;
  file: File;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  uploaded?: UploadedFile;
}

const QUICK_EMOJI = ['👍', '✅', '🙏', '🎉', '❤️', '😂', '😊', '🔥', '👏', '👌', '📌', '⚠️'];
const MAX_FILES_PER_MESSAGE = 10;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function newClientId(): string {
  const random = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return random.slice(0, 64);
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((a, b) => {
    const aPending = a.id < 0;
    const bPending = b.id < 0;
    if (aPending && bPending) return a.createdAt.localeCompare(b.createdAt);
    if (aPending) return 1;
    if (bPending) return -1;
    return a.id - b.id;
  });
}

/** Inserts or replaces one server message, collapsing an optimistic duplicate. */
function upsertMessage(previous: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const pendingIndex = incoming.clientId
    ? previous.findIndex((message) => message.id < 0 && message.clientId === incoming.clientId)
    : -1;
  let next = pendingIndex >= 0 ? previous.filter((_, index) => index !== pendingIndex) : previous;
  const existingIndex = next.findIndex((message) => message.id === incoming.id);
  if (existingIndex >= 0) next = next.map((message, index) => (index === existingIndex ? incoming : message));
  else next = [...next, incoming];
  return sortMessages(next);
}

function mergeServerMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  let next = previous;
  for (const message of incoming) next = upsertMessage(next, message);
  return next;
}

function replaceOptimistic(previous: ChatMessage[], tempId: number, saved: ChatMessage): ChatMessage[] {
  const withoutTemp = previous.filter(
    (message) => message.id !== tempId && !(message.id < 0 && saved.clientId && message.clientId === saved.clientId),
  );
  if (withoutTemp.some((message) => message.id === saved.id)) {
    return withoutTemp.map((message) => (message.id === saved.id ? saved : message));
  }
  return sortMessages([...withoutTemp, saved]);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function attachmentType(files: UploadedFile[]): 'text' | 'image' | 'voice' | 'file' {
  if (files.length === 0) return 'text';
  if (files.every((file) => file.mimeType.startsWith('image/'))) return 'image';
  if (files.every((file) => file.mimeType.startsWith('audio/'))) return 'voice';
  return 'file';
}

function typingLabel(users: string[]): string {
  if (users.length === 0) return '';
  if (users.length === 1) return `${users[0]} is typing…`;
  if (users.length === 2) return `${users[0]} and ${users[1]} are typing…`;
  return `${users.length} people are typing…`;
}

export default function Chat() {
  useDocumentTitle('Messages');
  const { user } = useAuth();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const { socket, onlineIds, syncVersion } = useRealtime();
  const { call } = useCall();
  const [params, setParams] = useSearchParams();
  const rawActiveId = params.get('c');
  const parsedActiveId = rawActiveId ? Number(rawActiveId) : null;
  const activeId = parsedActiveId && Number.isFinite(parsedActiveId) ? parsedActiveId : null;
  const activeIdRef = useRef<number | null>(activeId);
  activeIdRef.current = activeId;

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState('');
  const [contactsOpen, setContactsOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameInput, setRenameInput] = useState('');
  const [renameDescription, setRenameDescription] = useState('');
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchBefore, setSearchBefore] = useState<number | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [preview, setPreview] = useState<{ fileId: number; name: string; mimeType: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number | null>(null);
  const readTimer = useRef<number | null>(null);
  const loadToken = useRef(0);
  const atBottom = useRef(true);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const uploadQueue = useRef<UploadItem[]>([]);
  const uploadRunning = useRef(0);
  const mounted = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
    });
  }, []);

  const loadConversations = useCallback(async (silent = false) => {
    try {
      const result = await api.get<{ conversations: ConversationSummary[] }>('/chat/conversations');
      setConversations(result.conversations);
    } catch (caught) {
      if (!silent) toastRef.current.error(errorMessage(caught));
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  const scheduleRead = useCallback(
    (conversationId: number) => {
      if (readTimer.current) window.clearTimeout(readTimer.current);
      readTimer.current = window.setTimeout(() => {
        if (activeIdRef.current !== conversationId) return;
        if (document.visibilityState !== 'visible') return;
        void api
          .post(`/chat/conversations/${conversationId}/read`)
          .then(() => {
            setConversations((previous) =>
              previous.map((conversation) => (conversation.id === conversationId ? { ...conversation, unread: 0 } : conversation)),
            );
            void loadConversations(true);
            window.dispatchEvent(new CustomEvent('notifications:changed'));
          })
          .catch(() => undefined);
      }, 300);
    },
    [loadConversations],
  );

  const loadMessages = useCallback(async (conversationId: number, token: number) => {
    try {
      const [page, conversation] = await Promise.all([
        api.get<MessagePage>(`/chat/conversations/${conversationId}/messages?limit=40`),
        api.get<ConversationDetail>(`/chat/conversations/${conversationId}`),
      ]);
      if (token !== loadToken.current) return;
      setMessages(sortMessages(page.messages));
      setHasMore(Boolean(page.hasMore));
      setNextBefore(page.nextBefore ?? null);
      setDetail(conversation);
      atBottom.current = true;
      scrollToBottom(false);
      await api.post(`/chat/conversations/${conversationId}/read`).catch(() => undefined);
      if (token !== loadToken.current) return;
      setConversations((previous) =>
        previous.map((item) => (item.id === conversationId ? { ...item, unread: 0 } : item)),
      );
      window.dispatchEvent(new CustomEvent('notifications:changed'));
    } catch (caught) {
      if (token !== loadToken.current) return;
      toastRef.current.error(errorMessage(caught));
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        setParams({});
        void loadConversations(true);
      }
    } finally {
      if (token === loadToken.current) setLoadingMessages(false);
    }
  }, [loadConversations, scrollToBottom, setParams]);

  const resyncActive = useCallback(async (conversationId: number) => {
    try {
      const page = await api.get<MessagePage>(`/chat/conversations/${conversationId}/messages?limit=40`);
      if (activeIdRef.current !== conversationId) return;
      setMessages((previous) => mergeServerMessages(previous, page.messages));
    } catch {
      /* A reconnect resync failure is non-fatal; the next sync retries. */
    }
  }, []);

  const patchMessage = useCallback((id: number, update: (message: ChatMessage) => ChatMessage) => {
    setMessages((previous) => previous.map((message) => (message.id === id ? update(message) : message)));
    setSearchResults((previous) => (previous ? previous.map((message) => (message.id === id ? update(message) : message)) : previous));
  }, []);

  // Initial conversation list.
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Load the selected conversation. The token prevents a slower earlier
  // request from displaying messages in a conversation the user has left.
  useEffect(() => {
    if (!activeId) {
      loadToken.current += 1;
      setMessages([]);
      setDetail(null);
      setHasMore(false);
      setNextBefore(null);
      setLoadingMessages(false);
      return;
    }
    const token = ++loadToken.current;
    setMessages([]);
    setDetail(null);
    setHasMore(false);
    setNextBefore(null);
    setLoadingMessages(true);
    setReplyTo(null);
    setTypingUsers({});
    setEmojiOpen(false);
    setSearchOpen(false);
    setSearchInput('');
    setSearchTerm('');
    setSearchResults(null);
    void loadMessages(activeId, token);
    return () => {
      loadToken.current += 1;
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      socket?.emit('chat:typing', { conversationId: activeId, typing: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, loadMessages]);

  // Join the private conversation room, including after a socket reconnect.
  useEffect(() => {
    if (!socket || !activeId) return;
    const join = () => socket.emit('conversation:join', activeId);
    join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      socket.emit('conversation:leave', activeId);
    };
  }, [socket, activeId]);

  // Refresh after a realtime reconnect: no message may be lost while offline.
  useEffect(() => {
    if (!syncVersion) return;
    void loadConversations(true);
    if (activeIdRef.current) void resyncActive(activeIdRef.current);
  }, [syncVersion, loadConversations, resyncActive]);

  // Mark the open conversation as read when the tab becomes visible again.
  useEffect(() => {
    if (!activeId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleRead(activeId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeId, scheduleRead]);

  // Composer auto-grow.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  }, [text]);

  useEffect(
    () => () => {
      mounted.current = false;
      if (readTimer.current) window.clearTimeout(readTimer.current);
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      for (const controller of uploadControllers.current.values()) controller.abort();
      uploadControllers.current.clear();
    },
    [],
  );

  useSocketEvent('message:new', (payload) => {
    const message = payload as ChatMessage;
    if (!message?.conversationId || !Number.isFinite(Number(message.id))) return;
    if (message.conversationId === activeIdRef.current) {
      setMessages((previous) => upsertMessage(previous, message));
      if (message.senderId !== user?.id) scheduleRead(message.conversationId);
      if (atBottom.current || message.senderId === user?.id) scrollToBottom(true);
    }
    void loadConversations(true);
  });

  useSocketEvent('message:read', (payload) => {
    const data = payload as { conversationId: number; employeeId: number };
    if (!data || data.conversationId !== activeIdRef.current || data.employeeId === user?.id) return;
    setMessages((previous) =>
      previous.map((message) =>
        message.senderId === user?.id && !message.deleted
          ? {
              ...message,
              readCount: Math.min(message.recipientCount ?? 0, (message.readCount ?? 0) + 1),
            }
          : message,
      ),
    );
  });

  useSocketEvent('message:edited', (payload) => {
    const data = payload as { id: number; body?: string; editedAt?: string };
    if (!data?.id) return;
    patchMessage(Number(data.id), (message) => ({
      ...message,
      body: data.body ?? message.body,
      editedAt: data.editedAt ?? new Date().toISOString(),
    }));
  });

  useSocketEvent('message:deleted', (payload) => {
    const data = payload as { id: number };
    if (!data?.id) return;
    patchMessage(Number(data.id), (message) => ({
      ...message,
      body: null,
      deleted: true,
      attachments: [],
      reactions: [],
    }));
  });

  useSocketEvent('message:reaction', (payload) => {
    const data = payload as { messageId: number; reactions: ChatMessage['reactions'] };
    if (!data?.messageId) return;
    patchMessage(Number(data.messageId), (message) => ({ ...message, reactions: data.reactions ?? [] }));
  });

  useSocketEvent('conversation:updated', (payload) => {
    const data = payload as { conversationId: number; name?: string; description?: string };
    if (!data?.conversationId) return;
    setConversations((previous) =>
      previous.map((conversation) =>
        conversation.id === data.conversationId
          ? { ...conversation, name: data.name ?? conversation.name, description: data.description ?? conversation.description }
          : conversation,
      ),
    );
    if (activeIdRef.current === data.conversationId) {
      setDetail((previous) =>
        previous
          ? { ...previous, name: data.name ?? previous.name, description: data.description ?? previous.description }
          : previous,
      );
    }
  });

  const removeConversationLocally = useCallback(
    (conversationId: number) => {
      setConversations((previous) => previous.filter((conversation) => conversation.id !== conversationId));
      if (activeIdRef.current === conversationId) {
        setParams({});
        setDetail(null);
        setMessages([]);
        setSearchResults(null);
        setReplyTo(null);
      }
    },
    [setParams],
  );

  useSocketEvent('conversation:hidden', (payload) => {
    const data = payload as { conversationId: number };
    if (data?.conversationId) removeConversationLocally(Number(data.conversationId));
  });

  useSocketEvent('conversation:deleted', (payload) => {
    const data = payload as { conversationId: number };
    if (!data?.conversationId) return;
    const wasActive = activeIdRef.current === Number(data.conversationId);
    removeConversationLocally(Number(data.conversationId));
    if (wasActive) toastRef.current.info(data ? 'This conversation was deleted.' : 'Conversation removed.');
  });

  useSocketEvent('conversation:members_changed', (payload) => {
    const data = payload as { conversationId: number };
    if (!data?.conversationId) return;
    void loadConversations(true);
    if (activeIdRef.current === Number(data.conversationId)) {
      void api
        .get<ConversationDetail>(`/chat/conversations/${data.conversationId}`)
        .then((conversation) => setDetail(conversation))
        .catch(() => undefined);
    }
  });

  useSocketEvent('chat:typing', (payload) => {
    const data = payload as { conversationId: number; employeeId: number; name: string; typing: boolean };
    if (!data || data.conversationId !== activeIdRef.current || data.employeeId === user?.id) return;
    setTypingUsers((previous) => {
      const next = { ...previous };
      if (data.typing) next[data.employeeId] = data.name;
      else delete next[data.employeeId];
      return next;
    });
    if (data.typing) {
      window.setTimeout(() => {
        setTypingUsers((previous) => {
          if (!previous[data.employeeId]) return previous;
          const next = { ...previous };
          delete next[data.employeeId];
          return next;
        });
      }, 6000);
    }
  });

  const openConversation = (id: number) => {
    setParams({ c: String(id) });
    setMobileOpen(true);
    atBottom.current = true;
  };

  const startDirect = async (employeeId: number) => {
    try {
      const result = await api.post<{ id: number }>('/chat/conversations/direct', { employeeId });
      setContactsOpen(false);
      await loadConversations(true);
      openConversation(result.id);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const startCall = async (employeeId: number, type: 'audio' | 'video') => {
    try {
      await call(employeeId, type);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const deliverOptimistic = useCallback(
    async (
      optimistic: ChatMessage,
      payload: { body?: string; type: string; replyToId?: number; fileIds?: number[]; clientId?: string },
    ) => {
      try {
        const saved = await api.post<ChatMessage>(
          `/chat/conversations/${optimistic.conversationId}/messages`,
          payload,
        );
        setMessages((previous) => replaceOptimistic(previous, optimistic.id, saved));
        void api.post(`/chat/conversations/${optimistic.conversationId}/read`).catch(() => undefined);
        void loadConversations(true);
      } catch (caught) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === optimistic.id ? { ...message, pending: false, failed: true } : message,
          ),
        );
        toastRef.current.error(`Message not sent: ${errorMessage(caught)}`);
      }
    },
    [loadConversations],
  );

  const send = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!activeId || !user) return;
    const conversationId = activeId;
    const conversationUploads = uploads.filter((item) => item.conversationId === conversationId);
    const pending = conversationUploads.filter((item) => item.status === 'queued' || item.status === 'uploading');
    const failed = conversationUploads.filter((item) => item.status === 'error');
    const ready = conversationUploads.filter((item) => item.status === 'done' && item.uploaded);
    const body = text.trim();
    if (pending.length > 0) {
      toast.info('Wait for the attachments to finish uploading.');
      return;
    }
    if (failed.length > 0) {
      toast.error('Retry or remove the failed attachments before sending.');
      return;
    }
    if (!body && ready.length === 0) return;
    if (detail?.isAnnouncement && detail.myRole !== 'admin' && detail.createdBy !== user.id) {
      toast.error('Only group administrators can post in this announcement channel.');
      return;
    }

    const clientId = newClientId();
    const files = ready.map((item) => item.uploaded!);
    const type = attachmentType(files);
    const optimistic: ChatMessage = {
      id: -Date.now(),
      conversationId,
      senderId: user.id,
      senderName: user.fullName,
      senderPhoto: user.photoUrl,
      body: body || null,
      type,
      replyToId: replyTo?.id ?? null,
      replyToBody: replyTo?.body ?? null,
      replyToSender: replyTo?.senderName ?? null,
      clientId,
      editedAt: null,
      deleted: false,
      createdAt: new Date().toISOString(),
      recipientCount: 0,
      readCount: 0,
      pending: true,
      failed: false,
      attachments: files.map((file) => ({
        fileId: file.id,
        original_name: file.name,
        mime_type: file.mimeType,
        size_bytes: file.size,
        duration_seconds: null,
      })),
      reactions: [],
    };

    setMessages((previous) => sortMessages([...previous, optimistic]));
    setText('');
    setReplyTo(null);
    setEmojiOpen(false);
    setUploads((previous) => previous.filter((item) => item.conversationId !== conversationId));
    atBottom.current = true;
    scrollToBottom(true);
    socket?.emit('chat:typing', { conversationId, typing: false });

    await deliverOptimistic(optimistic, {
      body: body || undefined,
      type,
      replyToId: replyTo?.id,
      fileIds: files.length > 0 ? files.map((file) => file.id) : undefined,
      clientId,
    });
  };

  const retryMessage = async (message: ChatMessage) => {
    if (!user) return;
    setMessages((previous) =>
      previous.map((item) => (item.id === message.id ? { ...item, pending: true, failed: false } : item)),
    );
    await deliverOptimistic(
      { ...message, pending: true, failed: false },
      {
        body: message.body ?? undefined,
        type: message.type,
        replyToId: message.replyToId ?? undefined,
        fileIds: message.attachments.length > 0 ? message.attachments.map((attachment) => attachment.fileId) : undefined,
        clientId: message.clientId ?? undefined,
      },
    );
  };

  const runUpload = useCallback(async (item: UploadItem) => {
    const controller = new AbortController();
    uploadControllers.current.set(item.key, controller);
    setUploads((previous) =>
      previous.map((upload) =>
        upload.key === item.key ? { ...upload, status: 'uploading', progress: 0, error: undefined } : upload,
      ),
    );
    try {
      const uploaded = await api.uploadFile(item.file, {
        signal: controller.signal,
        onProgress: (progress) => {
          setUploads((previous) =>
            previous.map((upload) =>
              upload.key === item.key ? { ...upload, progress: progress.percent } : upload,
            ),
          );
        },
      });
      if (!mounted.current || controller.signal.aborted) return;
      setUploads((previous) =>
        previous.map((upload) =>
          upload.key === item.key ? { ...upload, status: 'done', progress: 100, uploaded } : upload,
        ),
      );
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted) return;
      setUploads((previous) =>
        previous.map((upload) =>
          upload.key === item.key
            ? { ...upload, status: 'error', error: errorMessage(caught) }
            : upload,
        ),
      );
    } finally {
      uploadControllers.current.delete(item.key);
    }
  }, []);

  const startNextUpload = useCallback(() => {
    while (uploadRunning.current < 2 && uploadQueue.current.length > 0) {
      const next = uploadQueue.current.shift();
      if (!next) break;
      uploadRunning.current += 1;
      void runUpload(next).finally(() => {
        uploadRunning.current = Math.max(0, uploadRunning.current - 1);
        startNextUpload();
      });
    }
  }, [runUpload]);

  const addFiles = (files: File[]) => {
    if (!activeId) return;
    const conversationId = activeId;
    const existing = uploads.filter((item) => item.conversationId === conversationId);
    const available = MAX_FILES_PER_MESSAGE - existing.length;
    if (available <= 0) {
      toast.error(`You can attach up to ${MAX_FILES_PER_MESSAGE} files to one message.`);
      return;
    }
    const accepted: UploadItem[] = [];
    for (const file of files.slice(0, available)) {
      if (file.size <= 0) {
        toast.error(`${file.name} is empty.`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`${file.name} is larger than the 1 GB upload limit.`);
        continue;
      }
      accepted.push({
        key: newClientId(),
        conversationId,
        file,
        progress: 0,
        status: 'queued',
      });
    }
    if (files.length > available) {
      toast.info(`Only ${available} more file${available === 1 ? '' : 's'} can be added to this message.`);
    }
    if (accepted.length === 0) return;
    setUploads((previous) => [...previous, ...accepted]);
    uploadQueue.current.push(...accepted);
    startNextUpload();
  };

  const retryUpload = (item: UploadItem) => {
    setUploads((previous) =>
      previous.map((upload) =>
        upload.key === item.key ? { ...upload, status: 'queued', progress: 0, error: undefined } : upload,
      ),
    );
    uploadQueue.current.push({ ...item, status: 'queued', progress: 0, error: undefined });
    startNextUpload();
  };

  const removeUpload = (item: UploadItem) => {
    uploadControllers.current.get(item.key)?.abort();
    uploadControllers.current.delete(item.key);
    uploadQueue.current = uploadQueue.current.filter((queued) => queued.key !== item.key);
    setUploads((previous) => previous.filter((upload) => upload.key !== item.key));
  };

  const loadOlder = async () => {
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    setLoadingOlder(true);
    try {
      if (searchResults !== null) {
        if (!searchHasMore || !searchBefore || !activeId || !searchTerm) return;
        const page = await api.get<MessagePage>(
          `/chat/conversations/${activeId}/messages?search=${encodeURIComponent(searchTerm)}&before=${searchBefore}&limit=40`,
        );
        setSearchResults((previous) => mergeServerMessages(previous ?? [], page.messages));
        setSearchHasMore(Boolean(page.hasMore));
        setSearchBefore(page.nextBefore ?? null);
      } else {
        if (!activeId || !hasMore || !nextBefore) return;
        const page = await api.get<MessagePage>(
          `/chat/conversations/${activeId}/messages?before=${nextBefore}&limit=40`,
        );
        setMessages((previous) => mergeServerMessages(previous, page.messages));
        setHasMore(Boolean(page.hasMore));
        setNextBefore(page.nextBefore ?? null);
      }
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const node = scrollRef.current;
          if (node) node.scrollTop = node.scrollHeight - previousHeight + previousTop;
        });
      });
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoadingOlder(false);
    }
  };

  const runSearch = async () => {
    const term = searchInput.trim();
    if (!activeId) return;
    if (!term) {
      setSearchResults(null);
      setSearchTerm('');
      setSearchHasMore(false);
      setSearchBefore(null);
      return;
    }
    setSearchTerm(term);
    setSearchResults([]);
    setSearchHasMore(false);
    setSearchBefore(null);
    setSearchLoading(true);
    try {
      const page = await api.get<MessagePage>(
        `/chat/conversations/${activeId}/messages?search=${encodeURIComponent(term)}&limit=40`,
      );
      setSearchResults(sortMessages(page.messages));
      setSearchHasMore(Boolean(page.hasMore));
      setSearchBefore(page.nextBefore ?? null);
    } catch (caught) {
      toast.error(errorMessage(caught));
      setSearchResults(null);
    } finally {
      setSearchLoading(false);
    }
  };

  const clearSearch = () => {
    setSearchResults(null);
    setSearchTerm('');
    setSearchInput('');
    setSearchHasMore(false);
    setSearchBefore(null);
    setSearchOpen(false);
  };

  const handleRename = async (newName?: string, newDescription?: string) => {
    const finalName = (newName ?? renameInput).trim();
    const finalDescription = (newDescription ?? renameDescription).trim();
    const targetId = renameTarget?.id ?? activeId;
    if (!targetId || !finalName) return;
    setBusyAction(true);
    try {
      await api.patch(`/chat/conversations/${targetId}`, {
        name: finalName,
        description: finalDescription || undefined,
      });
      setConversations((previous) =>
        previous.map((conversation) =>
          conversation.id === targetId ? { ...conversation, name: finalName } : conversation,
        ),
      );
      if (activeId === targetId) {
        setDetail((previous) =>
          previous
            ? { ...previous, name: finalName, description: finalDescription || null }
            : previous,
        );
      }
      setRenameOpen(false);
      setRenameTarget(null);
      toast.success('Conversation name updated.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  const handleDelete = async () => {
    const targetId = deleteTarget?.id ?? activeId;
    if (!targetId) return;
    setBusyAction(true);
    try {
      const result = await api.del<{ deleted?: boolean; left?: boolean; hidden?: boolean }>(
        `/chat/conversations/${targetId}`,
      );
      removeConversationLocally(targetId);
      setDeleteOpen(false);
      setDeleteTarget(null);
      if (result.hidden) toast.success('Chat deleted from your account.');
      else if (result.deleted) toast.success('Group deleted for all members.');
      else if (result.left) toast.success('You left the conversation.');
      else toast.success('Conversation removed.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  const onTyping = (value: string) => {
    setText(value);
    if (!activeId || !socket) return;
    socket.emit('chat:typing', { conversationId: activeId, typing: true });
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(
      () => socket.emit('chat:typing', { conversationId: activeId, typing: false }),
      1800,
    );
  };

  const handleEdit = async (message: ChatMessage) => {
    const next = window.prompt('Edit message', message.body ?? '');
    if (!next || next.trim() === message.body) return;
    try {
      await api.patch(`/chat/messages/${message.id}`, { body: next.trim() });
      patchMessage(message.id, (item) => ({ ...item, body: next.trim(), editedAt: new Date().toISOString() }));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const handleDeleteMessage = async (message: ChatMessage) => {
    if (!window.confirm('Delete this message? The deletion is recorded in the audit log.')) return;
    try {
      await api.del(`/chat/messages/${message.id}`);
      patchMessage(message.id, (item) => ({ ...item, body: null, deleted: true, attachments: [], reactions: [] }));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const handleReact = async (message: ChatMessage, emoji: string) => {
    if (!user) return;
    const existing = message.reactions.some(
      (reaction) => reaction.employeeId === user.id && reaction.emoji === emoji,
    );
    patchMessage(message.id, (item) => ({
      ...item,
      reactions: existing
        ? item.reactions.filter(
            (reaction) => !(reaction.employeeId === user.id && reaction.emoji === emoji),
          )
        : [...item.reactions, { employeeId: user.id, name: user.fullName, emoji }],
    }));
    try {
      await api.post(`/chat/messages/${message.id}/reactions`, { emoji });
    } catch (caught) {
      patchMessage(message.id, (item) => ({
        ...item,
        reactions: existing
          ? [...item.reactions, { employeeId: user.id, name: user.fullName, emoji }]
          : item.reactions.filter(
              (reaction) => !(reaction.employeeId === user.id && reaction.emoji === emoji),
            ),
      }));
      toast.error(errorMessage(caught));
    }
  };

  const activeUploads = uploads.filter((item) => item.conversationId === activeId);
  const pendingUploads = activeUploads.filter((item) => item.status === 'queued' || item.status === 'uploading');
  const failedUploads = activeUploads.filter((item) => item.status === 'error');
  const readyUploads = activeUploads.filter((item) => item.status === 'done' && item.uploaded);
  const displayedMessages = searchResults ?? messages;
  const showingSearch = searchResults !== null;
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);
  const otherOnline = activeConversation?.otherEmployeeId
    ? onlineIds.includes(activeConversation.otherEmployeeId)
    : detail?.otherEmployee
      ? onlineIds.includes(detail.otherEmployee.id)
      : false;
  const canManage = Boolean(detail && (detail.type === 'direct' || detail.myRole === 'admin'));
  const cannotPost = Boolean(
    detail?.isAnnouncement && detail.myRole !== 'admin' && detail.createdBy !== user?.id,
  );
  const sendDisabled =
    cannotPost ||
    pendingUploads.length > 0 ||
    failedUploads.length > 0 ||
    (!text.trim() && readyUploads.length === 0);

  const filteredConversations = conversations.filter((conversation) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return (
      conversation.name.toLowerCase().includes(q) ||
      (conversation.lastMessage ?? '').toLowerCase().includes(q) ||
      (conversation.lastSender ?? '').toLowerCase().includes(q) ||
      (conversation.otherMobile ?? '').toLowerCase().includes(q)
    );
  });
  const typingNames = Object.values(typingUsers);

  const currentDeleteTarget =
    deleteTarget ??
    (activeConversation
      ? activeConversation
      : detail
        ? ({ id: detail.id, name: detail.name, type: detail.type } as ConversationSummary)
        : null);

  const deleteCopy =
    currentDeleteTarget?.type === 'direct'
      ? {
          title: `Delete chat with ${currentDeleteTarget.name}`,
          description:
            `This chat with ${currentDeleteTarget.name} and its messages will be removed from your account. The other participant keeps their copy. This cannot be undone.`,
          confirm: 'Delete chat',
        }
      : {
          title: `Delete group "${currentDeleteTarget?.name ?? 'group'}"`,
          description:
            'Are you sure you want to delete this group? This action will permanently remove the conversation and all messages.',
          confirm: 'Delete group',
        };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] min-h-[520px] overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      <aside className={cx('flex w-full flex-col border-r border-ink-200 sm:w-80', mobileOpen && 'hidden sm:flex')}>
        {/* Header matching Image 1 */}
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-ink-900">Messages</h1>
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 inline-block" title="Online" />
          </div>
          <div className="flex items-center gap-1 text-ink-500">
            <button
              type="button"
              className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-900 transition-colors"
              title="New conversation"
              onClick={() => setContactsOpen(true)}
            >
              <Icon name="plus" size={17} />
            </button>
            <button
              type="button"
              className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-900 transition-colors"
              title="New group chat"
              onClick={() => setGroupOpen(true)}
            >
              <Icon name="user" size={17} />
            </button>
          </div>
        </div>

        {/* Search input matching Image 1 */}
        <div className="border-b border-ink-100 p-2.5">
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="w-full rounded-lg border border-blue-400/80 bg-white py-1.5 pl-9 pr-3 text-sm text-ink-900 placeholder-ink-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
              placeholder="Search conversations"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>

        {/* Conversations List matching Image 1 */}
        <div className="flex-1 overflow-y-auto divide-y divide-ink-50">
          {loadingConversations ? (
            <div className="p-3">
              <Skeleton lines={6} />
            </div>
          ) : filteredConversations.length === 0 ? (
            <EmptyState compact title="No conversations" description="Start a direct chat or create a group." />
          ) : (
            filteredConversations.map((conversation) => {
              const isSelected = activeId === conversation.id;
              const isOnline = conversation.otherEmployeeId ? onlineIds.includes(conversation.otherEmployeeId) : false;
              const initials = conversation.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .slice(0, 2)
                .toUpperCase();

              return (
                <div
                  key={conversation.id}
                  className={cx(
                    'group relative flex w-full items-center justify-between transition-colors hover:bg-blue-50/50 cursor-pointer',
                    isSelected ? 'bg-[#f0f4f9]' : 'bg-white',
                  )}
                  onClick={() => openConversation(conversation.id)}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3 text-left">
                    {/* Circle avatar with initials and status dot matching Image 1 */}
                    <div className="relative shrink-0">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#dbeafe] text-[#1e40af] text-sm font-semibold uppercase">
                        {initials || 'C'}
                      </div>
                      {conversation.type === 'direct' && (
                        <span
                          className={cx(
                            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white',
                            isOnline ? 'bg-emerald-500' : 'bg-slate-300',
                          )}
                          title={isOnline ? 'Online' : 'Offline'}
                        />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className={cx('truncate text-sm font-semibold', isSelected ? 'text-slate-900' : 'text-slate-800')}>
                          {conversation.name}
                        </p>
                        {conversation.lastMessageAt && (
                          <span className="shrink-0 text-[11px] text-slate-400 font-normal">
                            {formatTime(conversation.lastMessageAt).toLowerCase()}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <p className="truncate text-xs text-slate-500">
                          {conversation.lastSender ? `${conversation.lastSender.split(' ')[0]}: ` : ''}
                          {conversation.lastMessage ?? 'No messages yet'}
                        </p>
                        {conversation.unread > 0 && (
                          <span className="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            {conversation.unread}
                          </span>
                        )}
                      </div>

                      {conversation.type === 'group' && (
                        <div className="mt-1">
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 uppercase">
                            {conversation.memberCount || 3} MEMBERS
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions on hover: rename / delete */}
                  <div className="hidden group-hover:flex items-center gap-1 pr-2.5 shrink-0">
                    <button
                      type="button"
                      title="Change name"
                      aria-label="Change name"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameTarget(conversation);
                        setRenameInput(conversation.name);
                        setRenameDescription(conversation.description ?? '');
                        setRenameOpen(true);
                      }}
                      className="rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-blue-600 transition-colors"
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      type="button"
                      title="Delete chat"
                      aria-label="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(conversation);
                        setDeleteOpen(true);
                      }}
                      className="rounded-lg p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
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

      <section className={cx('flex min-w-0 flex-1 flex-col', !mobileOpen && 'hidden sm:flex')}>
        {!activeId ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              title="Select a conversation"
              description="Messages are delivered in real time and stored permanently. Offline colleagues receive notifications."
            />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-2 border-b border-ink-200 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg p-1 text-ink-500 hover:bg-ink-100 sm:hidden"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Back to conversations"
                >
                  <Icon name="chevronLeft" size={18} />
                </button>
                <Avatar
                  name={activeConversation?.name ?? detail?.name ?? 'Conversation'}
                  src={detail?.otherEmployee?.photoUrl ?? activeConversation?.otherPhoto}
                  size={34}
                  online={otherOnline || undefined}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-ink-900">
                      {activeConversation?.name ?? detail?.name ?? 'Conversation'}
                    </p>
                    <button
                      type="button"
                      className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-brand-600 transition-colors"
                      title="Change name"
                      onClick={() => {
                        const target = activeConversation ?? (detail ? ({
                          id: detail.id,
                          name: detail.name,
                          description: detail.description,
                          type: detail.type,
                        } as ConversationSummary) : null);
                        setRenameTarget(target);
                        setRenameInput(activeConversation?.name ?? detail?.name ?? '');
                        setRenameDescription(detail?.description ?? '');
                        setRenameOpen(true);
                      }}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-ink-500">
                    <span className="truncate">
                      {typingNames.length > 0
                        ? typingLabel(typingNames)
                        : detail?.type === 'direct'
                          ? otherOnline
                            ? 'Online'
                            : 'Offline'
                          : `${detail?.members.length ?? 0} members`}
                    </span>
                    {detail?.type !== 'direct' && (
                      <button
                        type="button"
                        className="font-medium text-brand-600 hover:underline"
                        onClick={() => setMembersOpen(true)}
                      >
                        View members
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                {detail?.type === 'direct' && detail.otherEmployee && (
                  <>
                    {detail.otherEmployee.phone ? (
                      <>
                        <a
                          href={`https://wa.me/${detail.otherEmployee.phone.replace(/\D/g, '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors shadow-xs"
                          title={`WhatsApp ${detail.otherEmployee.name} (${detail.otherEmployee.phone})`}
                        >
                          <svg className="w-3.5 h-3.5 fill-emerald-600 shrink-0" viewBox="0 0 24 24">
                            <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.312.045-.698.057-2.071-.475-1.428-.553-2.346-2.001-2.417-2.096-.07-.095-.579-.77-.579-1.468 0-.698.366-1.042.497-1.185.131-.143.286-.179.382-.179s.191.006.274.012c.088.006.203-.033.318.243.12.287.411 1.004.448 1.077.036.073.06.157.012.253s-.072.156-.144.239c-.072.083-.152.185-.217.249-.072.072-.148.15-.064.294.084.144.373.616.8 1 0 .548.497.892.68.995.183.103.29.091.399-.036.109-.126.467-.544.591-.73.124-.186.248-.155.418-.092.17.063 1.08.51 1.266.603.186.093.31.139.356.216.046.077.046.452-.098.857z" />
                          </svg>
                          <span>WhatsApp</span>
                        </a>
                        <a
                          href={`tel:${detail.otherEmployee.phone}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 transition-colors shadow-xs"
                          title={`Call phone: ${detail.otherEmployee.phone}`}
                        >
                          <Icon name="phone" size={13} className="text-blue-600" />
                          <span className="font-mono text-xs">{detail.otherEmployee.phone}</span>
                        </a>
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-400 italic">No phone</span>
                    )}
                    <button
                      type="button"
                      className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                      title={`Audio call ${detail.otherEmployee.name}`}
                      onClick={() => void startCall(detail.otherEmployee!.id, 'audio')}
                    >
                      <Icon name="phone" size={16} />
                    </button>
                    <button
                      type="button"
                      className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                      title={`Video call ${detail.otherEmployee.name}`}
                      onClick={() => void startCall(detail.otherEmployee!.id, 'video')}
                    >
                      <Icon name="video" size={16} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={cx('rounded-lg p-1.5 hover:bg-ink-100', searchOpen ? 'text-brand-600' : 'text-ink-500')}
                  title="Search in conversation"
                  onClick={() => {
                    if (searchOpen) clearSearch();
                    else setSearchOpen(true);
                  }}
                >
                  <Icon name="search" size={16} />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-red-500 hover:bg-red-50 transition-colors"
                  title="Delete chat"
                  onClick={() => {
                    const target = activeConversation ?? (detail ? ({
                      id: detail.id,
                      name: detail.name,
                      type: detail.type,
                    } as ConversationSummary) : null);
                    setDeleteTarget(target);
                    setDeleteOpen(true);
                  }}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </header>

            {searchOpen && (
              <div className="flex items-center gap-2 border-b border-ink-100 p-2">
                <input
                  autoFocus
                  className="input py-1.5 text-sm"
                  placeholder="Search messages and press Enter"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void runSearch();
                    }
                    if (event.key === 'Escape') clearSearch();
                  }}
                />
                <button type="button" className="btn-secondary btn-sm" onClick={() => void runSearch()} disabled={searchLoading}>
                  {searchLoading ? 'Searching…' : 'Search'}
                </button>
                {showingSearch && (
                  <button type="button" className="btn-ghost btn-sm" onClick={clearSearch}>
                    Clear
                  </button>
                )}
              </div>
            )}

            {showingSearch && (
              <div className="flex items-center justify-between gap-2 border-b border-ink-100 bg-brand-50 px-3 py-1.5 text-xs text-brand-800">
                <span className="truncate">
                  {searchLoading
                    ? 'Searching…'
                    : `${displayedMessages.length} result${displayedMessages.length === 1 ? '' : 's'} for “${searchTerm}”`}
                </span>
                <button type="button" className="font-medium hover:underline" onClick={clearSearch}>
                  Back to conversation
                </button>
              </div>
            )}

            <div
              ref={scrollRef}
              className="flex-1 space-y-1 overflow-y-auto bg-ink-50 px-3 py-3"
              onScroll={() => {
                const element = scrollRef.current;
                if (!element) return;
                atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
              }}
            >
              {(hasMore || (showingSearch && searchHasMore)) && (
                <div className="pb-2 text-center">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => void loadOlder()}
                    disabled={loadingOlder}
                  >
                    {loadingOlder
                      ? 'Loading…'
                      : showingSearch
                        ? 'Load older results'
                        : 'Load earlier messages'}
                  </button>
                </div>
              )}

              {loadingMessages && messages.length === 0 ? (
                <Skeleton lines={8} />
              ) : displayedMessages.length === 0 ? (
                <EmptyState
                  compact
                  title={showingSearch ? 'No matching messages' : 'No messages yet'}
                  description={showingSearch ? 'Try a different phrase.' : 'Say hello to start the conversation.'}
                />
              ) : (
                displayedMessages.map((message, index) => {
                  const mine = message.senderId === user?.id;
                  const showDay =
                    index === 0 ||
                    formatDayLabel(message.createdAt) !== formatDayLabel(displayedMessages[index - 1].createdAt);
                  return (
                    <div key={message.id > 0 ? `m-${message.id}` : `p-${message.clientId ?? message.id}`}>
                      {showDay && (
                        <div className="my-2 text-center">
                          <span className="rounded-full bg-white px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-500 shadow-sm">
                            {formatDayLabel(message.createdAt)}
                          </span>
                        </div>
                      )}
                      <MessageBubble
                        message={message}
                        mine={Boolean(mine)}
                        showSender={detail?.type !== 'direct'}
                        onReply={() => {
                          setReplyTo(message);
                          textareaRef.current?.focus();
                        }}
                        onReact={(emoji) => void handleReact(message, emoji)}
                        onEdit={() => void handleEdit(message)}
                        onDelete={() => void handleDeleteMessage(message)}
                        onRetry={() => void retryMessage(message)}
                        onPreview={(attachment) =>
                          setPreview({
                            fileId: attachment.fileId,
                            name: attachment.original_name,
                            mimeType: attachment.mime_type,
                          })
                        }
                        onMediaLoad={() => {
                          if (atBottom.current) scrollToBottom(false);
                        }}
                      />
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {replyTo && (
              <div className="flex items-center justify-between gap-2 border-t border-ink-200 bg-ink-50 px-3 py-1.5 text-xs">
                <span className="truncate">
                  Replying to <strong>{replyTo.senderName}</strong>: {replyTo.body?.slice(0, 80) ?? 'attachment'}
                </span>
                <button type="button" className="text-ink-500" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                  ✕
                </button>
              </div>
            )}

            {activeUploads.length > 0 && (
              <div className="space-y-2 border-t border-ink-200 bg-ink-50 px-3 py-2">
                {activeUploads.map((item) => (
                  <div key={item.key} className="flex items-center gap-2 text-xs">
                    <Icon name={item.file.type.startsWith('image/') ? 'image' : 'file'} size={16} className="shrink-0 text-ink-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-ink-700">{item.file.name}</span>
                        <span
                          className={cx(
                            'shrink-0',
                            item.status === 'error' ? 'text-red-600' : 'text-ink-500',
                          )}
                        >
                          {item.status === 'error'
                            ? item.error ?? 'Upload failed'
                            : item.status === 'done'
                              ? formatBytes(item.file.size)
                              : `${item.progress}%`}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-200">
                        <div
                          className={cx(
                            'h-full transition-all',
                            item.status === 'error' ? 'bg-red-500' : item.status === 'done' ? 'bg-emerald-500' : 'bg-brand-500',
                          )}
                          style={{ width: `${item.status === 'done' ? 100 : item.progress}%` }}
                        />
                      </div>
                    </div>
                    {item.status === 'error' && (
                      <button
                        type="button"
                        className="shrink-0 text-brand-700 hover:underline"
                        onClick={() => retryUpload(item)}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      className="shrink-0 text-ink-400 hover:text-red-600"
                      onClick={() => removeUpload(item)}
                      aria-label={`Remove ${item.file.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={send} className="relative border-t border-ink-200 px-2 py-2">
              {emojiOpen && (
                <div className="absolute bottom-full left-2 mb-2 grid grid-cols-6 gap-1 rounded-xl border border-ink-200 bg-white p-2 shadow-lg">
                  {QUICK_EMOJI.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="rounded-lg p-1.5 text-lg hover:bg-ink-100"
                      onClick={() => {
                        setText((previous) => `${previous}${emoji}`);
                        setEmojiOpen(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  multiple
                  accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.mp3,.m4a,.wav,.ogg,.webm,.mp4,.m4v,image/*,audio/*,video/*"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    if (files.length > 0) addFiles(files);
                  }}
                />
                <button
                  type="button"
                  className="rounded-lg p-2 text-ink-500 hover:bg-ink-100"
                  onClick={() => fileInput.current?.click()}
                  title="Attach files"
                  disabled={cannotPost}
                >
                  <Icon name="paperclip" size={18} />
                </button>
                <button
                  type="button"
                  className={cx('rounded-lg p-2 hover:bg-ink-100', emojiOpen ? 'text-brand-600' : 'text-ink-500')}
                  onClick={() => setEmojiOpen((open) => !open)}
                  title="Emoji"
                  aria-label="Emoji"
                >
                  <span className="text-base leading-none">🙂</span>
                </button>
                <textarea
                  ref={textareaRef}
                  className="input max-h-28 min-h-[40px] flex-1 resize-none py-2"
                  rows={1}
                  maxLength={8000}
                  placeholder={cannotPost ? 'Only group administrators can post here' : 'Type a message'}
                  value={text}
                  onChange={(event) => onTyping(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={cannotPost}
                />
                <button
                  type="submit"
                  className="btn-primary px-3 py-2"
                  disabled={sendDisabled}
                  title={
                    pendingUploads.length > 0
                      ? 'Waiting for attachments'
                      : failedUploads.length > 0
                        ? 'Resolve failed attachments first'
                        : 'Send'
                  }
                >
                  <Icon name="send" size={16} />
                </button>
              </div>
              {readyUploads.length > 0 && (
                <p className="mt-1 px-1 text-[11px] text-ink-500">
                  {readyUploads.length} attachment{readyUploads.length === 1 ? '' : 's'} ready to send
                </p>
              )}
            </form>
          </>
        )}
      </section>

      <ContactsModal
        open={contactsOpen}
        onClose={() => setContactsOpen(false)}
        onSelect={startDirect}
        onCall={startCall}
        onlineIds={onlineIds}
      />
      <GroupModal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        onCreated={async (id) => {
          setGroupOpen(false);
          await loadConversations(true);
          openConversation(id);
        }}
      />
      <RenameModal
        open={renameOpen}
        onClose={() => {
          setRenameOpen(false);
          setRenameTarget(null);
        }}
        initialName={renameInput}
        initialDescription={renameDescription}
        onSave={async (name, description) => {
          await handleRename(name, description);
        }}
        busy={busyAction}
      />
      <DeleteConfirmModal
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeleteTarget(null);
        }}
        onConfirm={handleDelete}
        title={deleteCopy.title}
        description={deleteCopy.description}
        confirmLabel={deleteCopy.confirm}
        busy={busyAction}
      />
      <GroupMembersModal
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        detail={detail}
        onlineIds={onlineIds}
        currentUserId={user?.id ?? null}
        onCall={startCall}
      />
      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.name ?? 'Attachment'}
        size="lg"
        footer={
          preview ? (
            <>
              <a
                className="btn-secondary"
                href={fileUrl(preview.fileId, true)}
                download={preview.name}
              >
                <Icon name="download" size={15} /> Download
              </a>
              <a className="btn-primary" href={fileUrl(preview.fileId)} target="_blank" rel="noreferrer">
                Open full size
              </a>
            </>
          ) : null
        }
      >
        {preview &&
          (preview.mimeType.startsWith('image/') ? (
            <img
              src={fileUrl(preview.fileId)}
              alt={preview.name}
              className="mx-auto max-h-[70vh] rounded-lg object-contain"
            />
          ) : preview.mimeType.startsWith('video/') ? (
            <video src={fileUrl(preview.fileId)} controls className="mx-auto max-h-[70vh] w-full rounded-lg" />
          ) : (
            <div className="py-6 text-center text-sm text-ink-500">
              This attachment cannot be previewed here. Use Download to open it.
            </div>
          ))}
      </Modal>
    </div>
  );
}

function MessageBubble({
  message,
  mine,
  showSender,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onRetry,
  onPreview,
  onMediaLoad,
}: {
  message: ChatMessage;
  mine: boolean;
  showSender: boolean;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onPreview: (attachment: ChatMessage['attachments'][number]) => void;
  onMediaLoad: () => void;
}) {
  const images = message.attachments.filter((attachment) => attachment.mime_type.startsWith('image/'));
  const audios = message.attachments.filter((attachment) => attachment.mime_type.startsWith('audio/'));
  const videos = message.attachments.filter((attachment) => attachment.mime_type.startsWith('video/'));
  const files = message.attachments.filter(
    (attachment) =>
      !attachment.mime_type.startsWith('image/') &&
      !attachment.mime_type.startsWith('audio/') &&
      !attachment.mime_type.startsWith('video/'),
  );

  const normalizedReactions = message.reactions.reduce<Record<string, { count: number; names: string[] }>>(
    (result, reaction) => {
      const entry = result[reaction.emoji] ?? { count: 0, names: [] };
      entry.count += 1;
      entry.names.push(reaction.name);
      result[reaction.emoji] = entry;
      return result;
    },
    {},
  );

  const recipientCount = message.recipientCount ?? 0;
  const readCount = message.readCount ?? 0;
  const readByAll = recipientCount > 0 && readCount >= recipientCount;
  const delivered = readCount > 0 || recipientCount === 0;

  return (
    <div className={cx('group flex gap-1.5', mine ? 'justify-end' : 'justify-start')}>
      {!mine && <Avatar name={message.senderName} src={message.senderPhoto} size={26} className="mt-1" />}
      <div
        className={cx(
          'max-w-[82%] rounded-2xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%]',
          mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md border border-ink-100 bg-white text-ink-800',
          message.failed && 'ring-1 ring-red-400',
          message.pending && 'opacity-90',
        )}
      >
        {!mine && showSender && (
          <p className="mb-0.5 text-[11px] font-semibold text-brand-700">{message.senderName}</p>
        )}
        {message.replyToBody && (
          <div
            className={cx(
              'mb-1 rounded border-l-2 px-1.5 py-1 text-[11px]',
              mine ? 'border-white/70 bg-white/15 text-white/90' : 'border-brand-500 bg-ink-50 text-ink-600',
            )}
          >
            <span className="font-semibold">{message.replyToSender}</span>: {message.replyToBody.slice(0, 120)}
          </div>
        )}
        {message.deleted ? (
          <p className={cx('italic', mine ? 'text-white/70' : 'text-ink-400')}>This message was deleted</p>
        ) : (
          <>
            {images.length > 0 && (
              <div className={cx('mb-1 grid gap-1', images.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
                {images.map((attachment) => (
                  <button
                    key={attachment.fileId}
                    type="button"
                    className="overflow-hidden rounded-lg"
                    onClick={() => onPreview(attachment)}
                    title={`View ${attachment.original_name}`}
                  >
                    <img
                      src={fileUrl(attachment.fileId)}
                      alt={attachment.original_name}
                      loading="lazy"
                      onLoad={onMediaLoad}
                      className="max-h-64 w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
            {videos.map((attachment) => (
              <video
                key={attachment.fileId}
                src={fileUrl(attachment.fileId)}
                controls
                preload="metadata"
                onLoadedMetadata={onMediaLoad}
                className="mb-1 max-h-64 w-full rounded-lg"
              />
            ))}
            {audios.map((attachment) => (
              <audio
                key={attachment.fileId}
                src={fileUrl(attachment.fileId)}
                controls
                preload="metadata"
                onLoadedMetadata={onMediaLoad}
                className="mb-1 w-full max-w-[260px]"
              />
            ))}
            {files.map((attachment) => (
              <a
                key={attachment.fileId}
                href={fileUrl(attachment.fileId, true)}
                download={attachment.original_name}
                className={cx(
                  'mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs',
                  mine ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-ink-50 text-brand-700 hover:bg-ink-100',
                )}
              >
                <Icon name="file" size={16} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{attachment.original_name}</span>
                <span className={cx('shrink-0', mine ? 'text-white/70' : 'text-ink-400')}>
                  {formatBytes(attachment.size_bytes)}
                </span>
                <Icon name="download" size={14} className="shrink-0" />
              </a>
            ))}
            {message.body && (
              <p className="whitespace-pre-wrap break-words leading-relaxed">{message.body}</p>
            )}
          </>
        )}

        <div
          className={cx(
            'mt-0.5 flex flex-wrap items-center justify-end gap-1 text-[10px]',
            mine ? 'text-white/70' : 'text-ink-400',
          )}
        >
          {message.editedAt && <span>edited</span>}
          <span>{formatTime(message.createdAt)}</span>
          {mine &&
            (message.failed ? (
              <span className="font-medium text-red-200">Not sent</span>
            ) : message.pending ? (
              <span title="Sending">Sending…</span>
            ) : (
              <span title={readByAll ? 'Read by everyone' : delivered ? 'Delivered' : 'Sent'}>
                {readByAll ? '✓✓' : '✓'}
              </span>
            ))}
        </div>

        {message.failed && (
          <button
            type="button"
            className="mt-1 w-full rounded-lg bg-red-50 px-2 py-1 text-left text-[11px] font-medium text-red-700 hover:bg-red-100"
            onClick={onRetry}
          >
            Retry sending
          </button>
        )}

        {Object.keys(normalizedReactions).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(normalizedReactions).map(([emoji, entry]) => (
              <button
                key={emoji}
                type="button"
                title={entry.names.join(', ')}
                onClick={() => onReact(emoji)}
                className={cx(
                  'rounded-full px-1.5 py-0.5 text-[11px]',
                  mine ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
                )}
              >
                {emoji} {entry.count}
              </button>
            ))}
          </div>
        )}

        {!message.deleted && (
          <div
            className={cx(
              'mt-1 flex flex-wrap items-center gap-1 text-[11px] transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100',
              mine ? 'text-white/85' : 'text-ink-500',
            )}
          >
            {QUICK_EMOJI.slice(0, 5).map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={cx('rounded px-1 hover:bg-black/10', mine && 'hover:bg-white/15')}
                onClick={() => onReact(emoji)}
                aria-label={`React ${emoji}`}
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              className={cx('rounded px-1 hover:bg-black/10', mine && 'hover:bg-white/15')}
              onClick={onReply}
            >
              Reply
            </button>
            {mine && (
              <>
                <button
                  type="button"
                  className={cx('rounded px-1 hover:bg-black/10', mine && 'hover:bg-white/15')}
                  onClick={onEdit}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={cx('rounded px-1 text-red-200 hover:bg-black/10', mine ? 'hover:bg-white/15' : 'hover:bg-red-50')}
                  onClick={onDelete}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RenameModal({
  open,
  onClose,
  initialName,
  initialDescription,
  onSave,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  initialName: string;
  initialDescription: string;
  onSave: (name: string, description: string) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

  useEffect(() => {
    setName(initialName);
    setDescription(initialDescription);
  }, [initialName, initialDescription, open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change conversation name"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!name.trim() || busy}
            onClick={() => void onSave(name, description)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Conversation name" required>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
        </Field>
        <Field label="Description (optional)">
          <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function DeleteConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={() => void onConfirm()} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-600">{description}</p>
    </Modal>
  );
}

function GroupMembersModal({
  open,
  onClose,
  detail,
  onlineIds,
  currentUserId,
  onCall,
}: {
  open: boolean;
  onClose: () => void;
  detail: ConversationDetail | null;
  onlineIds: number[];
  currentUserId: number | null;
  onCall: (employeeId: number, type: 'audio' | 'video') => Promise<void>;
}) {
  if (!detail) return null;
  return (
    <Modal open={open} onClose={onClose} title={`${detail.name || 'Group'} · Members`}>
      <div className="max-h-96 space-y-2 divide-y divide-ink-100 overflow-y-auto">
        {detail.members.map((member) => (
          <div key={member.employeeId} className="flex items-center justify-between gap-2 pt-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar
                name={member.name}
                src={member.photoUrl}
                size={32}
                online={onlineIds.includes(member.employeeId)}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium text-ink-900">
                    {member.name}
                    {member.employeeId === currentUserId ? ' (you)' : ''}
                  </p>
                  {member.role === 'admin' && <Badge tone="brand">Admin</Badge>}
                </div>
                <p className="truncate text-xs text-ink-500">{member.designation || 'Member'}</p>
              </div>
            </div>
            {member.employeeId !== currentUserId && (
              <div className="ml-2 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                  title={`Audio call ${member.name}`}
                  onClick={() => void onCall(member.employeeId, 'audio')}
                >
                  <Icon name="phone" size={15} />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                  title={`Video call ${member.name}`}
                  onClick={() => void onCall(member.employeeId, 'video')}
                >
                  <Icon name="video" size={15} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ContactsModal({
  open,
  onClose,
  onSelect,
  onCall,
  onlineIds,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (id: number) => Promise<void>;
  onCall: (id: number, type: 'audio' | 'video') => Promise<void>;
  onlineIds: number[];
}) {
  const [contacts, setContacts] = useState<PickerEmployee[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setContacts(null);
    api
      .get<{ contacts: PickerEmployee[] }>('/chat/contacts')
      .then((result) => setContacts(result.contacts))
      .catch(() => setContacts([]));
  }, [open]);

  const filtered = (contacts ?? []).filter((contact) =>
    search
      ? `${contact.full_name} ${contact.employee_code ?? ''} ${contact.designation_title ?? ''} ${contact.department_name ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase())
      : true,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New conversation"
      description="Start a direct chat with any active employee."
    >
      <input
        className="input mb-3"
        placeholder="Search by name, employee ID or department"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {!contacts ? (
          <Skeleton lines={5} />
        ) : filtered.length === 0 ? (
          <EmptyState compact title="No employees found" />
        ) : (
          filtered.map((contact) => (
            <div key={contact.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-ink-50">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                onClick={() => void onSelect(contact.id)}
              >
                <Avatar
                  name={contact.full_name}
                  src={contact.photo_url}
                  size={32}
                  online={onlineIds.includes(contact.id)}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-800">{contact.full_name}</p>
                  <p className="truncate text-xs text-ink-500">
                    {[contact.employee_code, contact.designation_title, contact.department_name]
                      .filter(Boolean)
                      .join(' · ') || 'Employee'}
                  </p>
                </div>
              </button>
              <div className="ml-2 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                  title={`Audio call ${contact.full_name}`}
                  onClick={() => void onCall(contact.id, 'audio')}
                >
                  <Icon name="phone" size={15} />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                  title={`Video call ${contact.full_name}`}
                  onClick={() => void onCall(contact.id, 'video')}
                >
                  <Icon name="video" size={15} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

function GroupModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => Promise<void>;
}) {
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
          <input
            className="input"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            minLength={2}
            required
          />
        </Field>
        <Field label="Description">
          <input
            className="input"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.isAnnouncement}
            onChange={(event) => setForm({ ...form, isAnnouncement: event.target.checked })}
          />
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
                  onChange={(event) =>
                    setMembers((previous) =>
                      event.target.checked
                        ? [...previous, contact.id]
                        : previous.filter((id) => id !== contact.id),
                    )
                  }
                />
                {contact.full_name}{' '}
                <span className="text-xs text-ink-400">{contact.designation_title ?? ''}</span>
              </label>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}
