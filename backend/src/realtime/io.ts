import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { config } from '../config.js';
import { query } from '../db/index.js';
import { AuthService, type AuthUser } from '../services/AuthService.js';
import { PresenceService } from '../services/PresenceService.js';

interface SocketData {
  user: AuthUser;
}

let io: Server | null = null;
const online = new Map<number, Set<string>>();
const socketUsers = new Map<string, AuthUser>();

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header.split(';').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return acc;
  }, {});
}

export function getIO(): Server | null {
  return io;
}

export function isOnline(employeeId: number): boolean {
  return (online.get(employeeId)?.size ?? 0) > 0;
}

/** Employees with at least one socket inside a meeting room or a 1:1 call. */
export function employeesInCallsOrMeetings(): Set<number> {
  const busy = new Set<number>();
  if (!io) return busy;
  for (const socket of io.of('/').sockets.values()) {
    for (const room of socket.rooms) {
      if (room.startsWith('meeting:') || room.startsWith('call:')) {
        busy.add((socket.data as SocketData).user.id);
        break;
      }
    }
  }
  return busy;
}

function refreshPresence(employeeId: number): void {
  PresenceService.refresh(employeeId).catch((error) => console.error('[presence] refresh failed', error));
}

/** Disconnects every socket that belongs to the given login session (sign-out, revocation). */
export function disconnectSession(sessionId: number): void {
  if (!io) return;
  for (const socket of io.of('/').sockets.values()) {
    if ((socket.data as SocketData).user?.sessionId === sessionId) {
      socket.emit('session:ended', { reason: 'signed_out' });
      socket.disconnect(true);
    }
  }
}

/**
 * Sockets are authenticated once, at connect. This sweep closes any socket
 * whose session has since expired or been revoked, so nobody stays "online"
 * after their session ended.
 */
export async function revalidateSockets(): Promise<number> {
  if (!io) return 0;
  const sockets = [...io.of('/').sockets.values()];
  const sessionIds = [...new Set(sockets.map((s) => (s.data as SocketData).user?.sessionId).filter((id): id is number => Boolean(id)))];
  if (sessionIds.length === 0) return 0;
  const valid = await query<{ id: number }>(
    `SELECT id FROM employee_sessions WHERE id IN (${sessionIds.map(() => '?').join(',')}) AND revoked_at IS NULL AND expires_at > NOW(3)`,
    sessionIds,
  );
  const alive = new Set(valid.map((r) => Number(r.id)));
  let closed = 0;
  for (const socket of sockets) {
    const sid = (socket.data as SocketData).user?.sessionId;
    if (sid && !alive.has(sid)) {
      socket.emit('session:ended', { reason: 'expired' });
      socket.disconnect(true);
      closed += 1;
    }
  }
  return closed;
}

export function onlineEmployeeIds(): number[] {
  return [...online.entries()].filter(([, sockets]) => sockets.size > 0).map(([id]) => id);
}

/** Delivers an event to every live socket of the given employees. */
export function emitToEmployees(employeeIds: number[], event: string, payload: unknown): void {
  if (!io) return;
  for (const id of employeeIds) {
    io.to(`user:${id}`).emit(event, payload);
  }
}

export function emitToEmployee(employeeId: number, event: string, payload: unknown): void {
  emitToEmployees([employeeId], event, payload);
}

export function emitToConversation(conversationId: number, event: string, payload: unknown): void {
  io?.to(`conv:${conversationId}`).emit(event, payload);
}

export function emitToMeeting(meetingCode: string, event: string, payload: unknown, exceptSocketId?: string): void {
  if (!io) return;
  if (exceptSocketId) {
    io.to(`meeting:${meetingCode}`).except(exceptSocketId).emit(event, payload);
  } else {
    io.to(`meeting:${meetingCode}`).emit(event, payload);
  }
}

async function conversationRoomIds(employeeId: number): Promise<number[]> {
  const rows = await query<{ conversation_id: number }>(
    'SELECT conversation_id FROM conversation_members WHERE employee_id = ?',
    [employeeId],
  );
  return rows.map((r) => Number(r.conversation_id));
}

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: config.appOrigin.split(','), credentials: true },
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
    transports: ['polling', 'websocket'],
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = cookies[config.cookieName];
      if (!token) return next(new Error('unauthorized'));
      const user = await AuthService.authenticateToken(token);
      if (!user) return next(new Error('unauthorized'));
      (socket.data as SocketData).user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const user = (socket.data as SocketData).user;
    socketUsers.set(socket.id, user);
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id)!.add(socket.id);

    socket.join(`user:${user.id}`);
    for (const convId of await conversationRoomIds(user.id)) {
      socket.join(`conv:${convId}`);
    }

    io?.emit('presence:update', { employeeId: user.id, online: true });
    socket.emit('presence:list', onlineEmployeeIds());
    refreshPresence(user.id);

    socket.on('conversation:join', (conversationId: number) => {
      socket.join(`conv:${conversationId}`);
    });

    socket.on('conversation:leave', (conversationId: number) => {
      socket.leave(`conv:${conversationId}`);
    });

    socket.on('chat:typing', (payload: { conversationId: number; typing: boolean }) => {
      if (!payload || typeof payload.conversationId !== 'number') return;
      socket.to(`conv:${payload.conversationId}`).emit('chat:typing', {
        conversationId: payload.conversationId,
        employeeId: user.id,
        employeeName: user.fullName,
        typing: Boolean(payload.typing),
      });
    });

    socket.on('meeting:join', async (payload: { code: string }, ack?: (res: unknown) => void) => {
      try {
        const code = String(payload?.code ?? '');
        if (!code) throw new Error('invalid code');
        const rows = await query<{ id: number }>(
          `SELECT m.id FROM meetings m
           JOIN meeting_participants mp ON mp.meeting_id = m.id
           WHERE m.meeting_code = ? AND mp.employee_id = ?`,
          [code, user.id],
        );
        if (rows.length === 0) throw new Error('not a participant');
        await socket.join(`meeting:${code}`);
        const sockets = await io!.in(`meeting:${code}`).fetchSockets();
        const participants = sockets.map((s) => {
          const u = (s.data as SocketData).user;
          return { socketId: s.id, employeeId: u.id, name: u.fullName };
        });
        io!.to(`meeting:${code}`).emit('meeting:participants', participants);
        refreshPresence(user.id);
        ack?.({ ok: true, participants });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : 'failed' });
      }
    });

    socket.on('meeting:signal', (payload: { code: string; target: string; signal: unknown }) => {
      if (!payload?.target) return;
      io?.to(payload.target).emit('meeting:signal', {
        from: socket.id,
        employeeId: user.id,
        name: user.fullName,
        signal: payload.signal,
      });
    });

    socket.on('meeting:leave', async (payload: { code: string }) => {
      const code = String(payload?.code ?? '');
      if (!code) return;
      socket.leave(`meeting:${code}`);
      refreshPresence(user.id);
      const sockets = await io!.in(`meeting:${code}`).fetchSockets();
      io!.to(`meeting:${code}`).emit(
        'meeting:participants',
        sockets.map((s) => {
          const u = (s.data as SocketData).user;
          return { socketId: s.id, employeeId: u.id, name: u.fullName };
        }),
      );
    });

    // socket.rooms is already empty inside 'disconnect', so capture the meeting
    // and call rooms while they are still known.
    let roomsAtDisconnect: string[] = [];
    socket.on('disconnecting', () => {
      roomsAtDisconnect = [...socket.rooms].filter((room) => room.startsWith('meeting:') || room.startsWith('call:'));
    });

    socket.on('disconnect', () => {
      socketUsers.delete(socket.id);
      const set = online.get(user.id);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(user.id);
          io?.emit('presence:update', { employeeId: user.id, online: false, lastSeenAt: new Date().toISOString() });
          query('UPDATE employees SET last_seen_at = NOW(3) WHERE id = ?', [user.id]).catch(() => undefined);
        }
      }
      // Socket rooms are already left here, so this also ends "In a Meeting".
      refreshPresence(user.id);
      for (const code of roomsAtDisconnect) {
        if (code.startsWith('call:')) {
          // The other party must not keep waiting on a peer that is gone.
          io!.to(code).emit('call:ended', { callId: code.slice('call:'.length), reason: 'disconnected', byEmployeeId: user.id });
          continue;
        }
        io!.in(code)
          .fetchSockets()
          .then((sockets) => {
            io!.to(code).emit(
              'meeting:participants',
              sockets.map((s) => {
                const u = (s.data as SocketData).user;
                return { socketId: s.id, employeeId: u.id, name: u.fullName };
              }),
            );
          })
          .catch((error) => console.error('[realtime] participant refresh failed', error));
      }
    });
  });

  return io;
}

export function connectedSocketCount(): number {
  return socketUsers.size;
}

export async function joinConversationRoom(employeeId: number, conversationId: number): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`user:${employeeId}`).fetchSockets();
  for (const s of sockets) {
    await s.join(`conv:${conversationId}`);
  }
}
