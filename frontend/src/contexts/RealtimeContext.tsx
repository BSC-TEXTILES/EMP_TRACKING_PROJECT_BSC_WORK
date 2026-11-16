import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';

type Handler = (payload: unknown) => void;

interface RealtimeContextValue {
  socket: Socket | null;
  connected: boolean;
  onlineIds: number[];
  subscribe: (event: string, handler: Handler) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const CONNECTION_EVENTS = [
  'notification:new',
  'message:new',
  'message:read',
  'message:edited',
  'message:deleted',
  'message:reaction',
  'chat:typing',
  'presence:update',
  'presence:list',
  'attendance:update',
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
  'conversation:members_changed',
];

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const handlers = useRef(new Map<string, Set<Handler>>());

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    const socketUrl = import.meta.env.VITE_WEBSOCKET_URL || undefined;
    const socket = io(socketUrl, {
      withCredentials: true,
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // Catch up on anything missed while offline.
      window.dispatchEvent(new CustomEvent('realtime:resync'));
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('presence:list', (ids: number[]) => setOnlineIds(ids));
    socket.on('presence:update', (payload: { employeeId: number; online: boolean }) => {
      setOnlineIds((prev) => {
        if (payload.online) return prev.includes(payload.employeeId) ? prev : [...prev, payload.employeeId];
        return prev.filter((id) => id !== payload.employeeId);
      });
    });
    socket.on('notification:new', (payload: { title?: string; body?: string | null }) => {
      if (payload?.title) toast.toast(payload.title, 'info');
      window.dispatchEvent(new CustomEvent('notifications:changed'));
    });

    for (const event of CONNECTION_EVENTS) {
      socket.on(event, (payload: unknown) => {
        const set = handlers.current.get(event);
        if (!set) return;
        for (const handler of set) handler(payload);
      });
    }

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [user, toast]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      socket: socketRef.current,
      connected,
      onlineIds,
      subscribe: (event: string, handler: Handler) => {
        if (!handlers.current.has(event)) handlers.current.set(event, new Set());
        handlers.current.get(event)!.add(handler);
        return () => {
          handlers.current.get(event)?.delete(handler);
        };
      },
    }),
    [connected, onlineIds],
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
