import { ApiError, api } from './api';
import type { ChatMessage } from './types';

/**
 * Offline outbox for chat messages.
 *
 * A message that cannot reach the server (no network, server restarting) is kept in
 * localStorage and re-sent automatically when the device is back online, when the
 * realtime connection is re-established, and periodically while items remain. The
 * server stores messages idempotently by clientId, so a retry can never duplicate one.
 *
 * Events (window):
 *  - outbox:sent   { clientId, conversationId, tempId, saved }
 *  - outbox:failed { clientId, conversationId, tempId, error }  (rejected by the server, e.g. 403)
 */

export interface OutboxPayload {
  body?: string;
  type: string;
  replyToId?: number;
  fileIds?: number[];
  clientId: string;
}

export interface OutboxItem {
  clientId: string;
  conversationId: number;
  payload: OutboxPayload;
  optimistic: ChatMessage;
  attempts: number;
  queuedAt: number;
}

const KEY = 'wfm_chat_outbox_v1';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const RETRY_INTERVAL_MS = 20_000;

function read(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const items = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    return Array.isArray(items) ? items.filter((i) => i && i.clientId && Date.now() - i.queuedAt < MAX_AGE_MS) : [];
  } catch {
    return [];
  }
}

function write(items: OutboxItem[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage full / private mode: the in-page retry button still works */
  }
}

/** True for failures worth retrying later (offline, timeout, server busy / restarting). */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.code === 'aborted') return false;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

export function enqueueMessage(item: Omit<OutboxItem, 'attempts' | 'queuedAt'>): void {
  const items = read().filter((i) => i.clientId !== item.clientId);
  items.push({ ...item, attempts: 0, queuedAt: Date.now() });
  write(items);
  ensureTimer();
}

export function queuedMessages(conversationId?: number): OutboxItem[] {
  const items = read();
  return conversationId === undefined ? items : items.filter((i) => i.conversationId === conversationId);
}

export function removeQueued(clientId: string): void {
  write(read().filter((i) => i.clientId !== clientId));
}

let flushing: Promise<void> | null = null;

/** Sends every queued message, oldest first. Safe to call often. */
export function flushOutbox(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (const item of read().sort((a, b) => a.queuedAt - b.queuedAt)) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        try {
          const saved = await api.post<ChatMessage>(`/chat/conversations/${item.conversationId}/messages`, item.payload);
          removeQueued(item.clientId);
          window.dispatchEvent(new CustomEvent('outbox:sent', {
            detail: { clientId: item.clientId, conversationId: item.conversationId, tempId: item.optimistic.id, saved },
          }));
        } catch (error) {
          if (isRetryable(error) && !(error instanceof ApiError && error.status === 401)) {
            write(read().map((i) => (i.clientId === item.clientId ? { ...i, attempts: i.attempts + 1 } : i)));
            return; // still offline: keep order, try again later
          }
          if (error instanceof ApiError && error.status === 401) return; // signed out: keep until next sign-in
          removeQueued(item.clientId);
          window.dispatchEvent(new CustomEvent('outbox:failed', {
            detail: { clientId: item.clientId, conversationId: item.conversationId, tempId: item.optimistic.id, error: (error as Error).message },
          }));
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

let timer: number | null = null;
function ensureTimer(): void {
  if (timer !== null || typeof window === 'undefined') return;
  timer = window.setInterval(() => {
    if (read().length === 0) {
      window.clearInterval(timer!);
      timer = null;
      return;
    }
    void flushOutbox();
  }, RETRY_INTERVAL_MS);
}

let started = false;
/** Call once at start-up. */
export function initOutbox(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => void flushOutbox());
  window.addEventListener('realtime:resync', () => void flushOutbox());
  if (read().length > 0) {
    ensureTimer();
    void flushOutbox();
  }
}
