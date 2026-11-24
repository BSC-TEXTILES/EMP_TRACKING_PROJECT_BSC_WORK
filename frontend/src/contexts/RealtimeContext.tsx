import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import { useToast, type ToastTone } from './ToastContext';
import { ensureFreshAccess } from '../lib/api';
import { API_ORIGIN, isNative, nativeTokens } from '../lib/native';
import { showDesktopNotification, playMessageSound, registerWebPushSubscription, pushDeviceId } from '../lib/notifications';

/** Sent in the socket handshake: this client confirms incoming calls, and identifies the device for multi-device sync. */
const CALL_HANDSHAKE = { caps: ['call_ack'], deviceId: pushDeviceId() };

/** Notification types that have their own alert path (service-worker push / call UI). */
const SELF_ALERTING_TYPES = new Set(['chat_message', 'incoming_call', 'missed_call']);

type Handler = (payload: unknown) => void;
type ConnectionStatus = 'connecting' | 'online' | 'offline';

interface RealtimeContextValue {
  socket: Socket | null;
  connected: boolean;
  status: ConnectionStatus;
  onlineIds: number[];
  /** Increments whenever the connection is re-established; consumers reload data. */
  syncVersion: number;
  retry: () => void;
  subscribe: (event: string, handler: Handler) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const CONNECTION_EVENTS = [
  'notification:new',
  'message:new',
  'message:read',
  'message:edited',
  'message:deleted',
  'message:hidden',
  'message:reaction',
  'chat:typing',
  'presence:update',
  'presence:list',
  'attendance:update',
  'leave:updated',
  'leave:policy',
  'task:created',
  'task:updated',
  'report:updated',
  'ticket:created',
  'ticket:updated',
  'meeting:created',
  'meeting:response',
  'meeting:participants',
  'meeting:signal',
  'meeting:message',
  'meeting:attendance',
  'conversation:updated',
  'conversation:deleted',
  'conversation:hidden',
  'conversation:members_changed',
  'call:incoming',
  'call:accepted',
  'call:rejected',
  'call:ringing',
  'call:ended',
  'call:missed',
  'call:peer_joined',
  'call:peer_left',
  'call:signal',
  'nudge:received',
  'activity:update',
  'activity:heartbeat',
  'activity:session',
  'activity:team',
  'activity:device',
];

/** Maximum automatic reconnect attempts before the indicator asks for a retry. */
const MAX_RECONNECT_ATTEMPTS = 20;
const HEARTBEAT_INTERVAL_MS = 25_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const [syncVersion, setSyncVersion] = useState(0);
  const [retryToken, setRetryToken] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const handlers = useRef(new Map<string, Set<Handler>>());
  const lastSync = useRef(0);

  useEffect(() => {
    if (!user) {
      socketRef.current?.removeAllListeners();
      socketRef.current?.disconnect();
      socketRef.current = null;
      setStatus('offline');
      setOnlineIds([]);
      return;
    }

    // Mobile app: absolute API origin, WebSocket only, access token in the
    // handshake (re-read on every reconnect so a refreshed token is used).
    const socket = isNative ? io(API_ORIGIN, {
      transports: ['websocket'],
      withCredentials: false,
      auth: (cb) => {
        void ensureFreshAccess()
          .catch(() => null)
          .then((token) => cb({ token: token ?? nativeTokens()?.accessToken ?? '', ...CALL_HANDSHAKE }));
      },
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.25,
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      timeout: 15_000,
      autoConnect: true,
    }) : io(import.meta.env.VITE_WEBSOCKET_URL || undefined, {
      withCredentials: true,
      // This build confirms incoming calls (call:ring_ack), so the caller sees an honest "Ringing".
      auth: { ...CALL_HANDSHAKE },
      // Polling first ensures handshake succeeds behind all reverse proxies, then upgrades cleanly to WebSocket
      transports: ['polling', 'websocket'],
      tryAllTransports: true,
      upgrade: true,
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.25,
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      timeout: 15_000,
      autoConnect: true,
    });
    socketRef.current = socket;
    setStatus('connecting');

    const sync = (reason: string) => {
      // Debounce so a transport upgrade cannot trigger duplicate reloads.
      if (Date.now() - lastSync.current < 400) return;
      lastSync.current = Date.now();
      setSyncVersion((value) => value + 1);
      window.dispatchEvent(new CustomEvent('realtime:resync', { detail: { reason } }));
    };

    // The server only skips a push when the employee has a page in the FOREGROUND.
    const reportVisibility = () => {
      if (socket.connected) socket.emit('client:visibility', { visible: document.visibilityState === 'visible' });
    };

    socket.on('connect', () => {
      setStatus('online');
      reportVisibility();
      sync('connected');
    });
    socket.on('disconnect', (reason) => {
      setStatus(reason === 'io client disconnect' ? 'offline' : 'connecting');
    });
    socket.on('connect_error', () => setStatus('connecting'));
    socket.on('reconnect_attempt', () => setStatus('connecting'));
    socket.on('reconnect_failed', () => setStatus('offline'));
    socket.on('session:ended', () => {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    });

    socket.on('presence:list', (ids: number[]) => {
      if (Array.isArray(ids)) setOnlineIds(ids.map(Number).filter((id) => Number.isFinite(id)));
    });
    socket.on('presence:update', (payload: { employeeId: number; online: boolean }) => {
      if (!payload || !Number.isFinite(Number(payload.employeeId))) return;
      setOnlineIds((prev) => {
        if (payload.online) return prev.includes(payload.employeeId) ? prev : [...prev, payload.employeeId];
        return prev.filter((id) => id !== payload.employeeId);
      });
    });
    socket.on('notification:new', (payload: { type?: string; title?: string; body?: string | null; link?: string | null; priority?: string }) => {
      if (payload?.title && !SELF_ALERTING_TYPES.has(payload.type ?? '')) {
        const tone: ToastTone = payload.priority === 'critical' || payload.priority === 'high' ? 'error' : 'info';
        const msg = payload.body ?? payload.title;
        toastRef.current.toast(msg, tone, payload.body ? payload.title : undefined);
        void showDesktopNotification(payload.title, {
          body: payload.body,
          link: payload.link,
          urgent: payload.priority === 'high' || payload.priority === 'critical',
        });
      }
      window.dispatchEvent(new CustomEvent('notifications:changed'));
    });

    socket.on('message:new', (payload: { senderId?: number; senderName?: string; body?: string | null; conversationId?: number; id?: number }) => {
      if (payload && payload.senderId !== user?.id) {
        const visible = document.visibilityState === 'visible';
        const isCurrentChatOpen =
          window.location.pathname.startsWith('/chat') &&
          new URLSearchParams(window.location.search).get('c') === String(payload.conversationId);

        // In the foreground: in-app tone (and a banner when another chat is open).
        // In the background the server sends a Web Push (the page reported hidden), which the
        // service worker shows with sound; showing one here too would double-alert.
        if (visible) {
          playMessageSound();
          if (!isCurrentChatOpen) {
            void showDesktopNotification(payload.senderName || 'New Chat Message', {
              body: payload.body || 'You received a new message.',
              link: `/chat?c=${payload.conversationId}`,
              tag: `chat-${payload.conversationId}`,
            });
          }
        }
      }
    });

    for (const event of CONNECTION_EVENTS) {
      socket.on(event, (payload: unknown) => {
        const set = handlers.current.get(event);
        if (!set) return;
        for (const handler of set) {
          try {
            handler(payload);
          } catch (error) {
            console.error(`[realtime] handler for ${event} failed`, error);
          }
        }
      });
    }

    // Application heartbeat: detects a half-open socket earlier than the
    // browser's own timeout and confirms the session is still valid. Two
    // consecutive failures close the engine so Socket.IO reconnects with its
    // bounded exponential backoff (no custom retry loop).
    let heartbeatFailures = 0;
    const heartbeat = window.setInterval(() => {
      if (!socket.connected) return;
      socket.timeout(8_000).emit('client:heartbeat', {}, (error: unknown) => {
        if (!error) {
          heartbeatFailures = 0;
          return;
        }
        heartbeatFailures += 1;
        if (heartbeatFailures >= 2) {
          heartbeatFailures = 0;
          setStatus('connecting');
          socket.io.engine.close();
        }
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Reconnect immediately when the device comes back online or the tab becomes
    // visible after being suspended.
    const onOnline = () => {
      if (!socket.connected) {
        setStatus('connecting');
        socket.connect();
      }
    };
    const onVisible = () => {
      reportVisibility();
      if (document.visibilityState !== 'visible') return;
      if (!socket.connected) {
        setStatus('connecting');
        socket.connect();
      } else {
        sync('visible');
      }
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', reportVisibility);

    // Signed in: (re)link this device's push subscription to the user and session.
    if (!isNative && 'Notification' in window && Notification.permission === 'granted') {
      void registerWebPushSubscription();
    }

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', reportVisibility);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setStatus('offline');
    };
  }, [user?.id, retryToken]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      socket: socketRef.current,
      connected: status === 'online',
      status,
      onlineIds,
      syncVersion,
      retry: () => setRetryToken((value) => value + 1),
      subscribe: (event: string, handler: Handler) => {
        if (!handlers.current.has(event)) handlers.current.set(event, new Set());
        handlers.current.get(event)!.add(handler);
        return () => {
          handlers.current.get(event)?.delete(handler);
        };
      },
    }),
    [status, onlineIds, syncVersion],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside RealtimeProvider');
  return context;
}

/** Subscribes to a socket event for the lifetime of the calling component. */
export function useSocketEvent(event: string, handler: Handler): void {
  const { subscribe } = useRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(event, (payload) => ref.current(payload)), [event, subscribe]);
}
