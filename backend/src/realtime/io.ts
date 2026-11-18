import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { config } from '../config.js';
import { query, queryOne } from '../db/index.js';
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
      // Website: HttpOnly session cookie. Mobile app: access token in the handshake
      // `auth` payload (io(url, { transports: ['websocket'], auth: { token } })),
      // because the app's origin never receives the website's cookies.
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const token = cookies[config.cookieName] ?? (typeof authToken === 'string' && authToken.length < 2048 ? authToken : undefined);
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
    if (user.locationId) {
      socket.join(`location:${user.locationId}`);
    }
    if (user.allowedLocations) {
      for (const loc of user.allowedLocations) {
        socket.join(`location:${loc.id}`);
      }
    }
    for (const convId of await conversationRoomIds(user.id)) {
      socket.join(`conv:${convId}`);
    }

    io?.emit('presence:update', { employeeId: user.id, online: true });
    socket.emit('presence:list', onlineEmployeeIds());
    refreshPresence(user.id);

    socket.on('client:heartbeat', (_payload: unknown, ack?: (res: unknown) => void) => {
      // Confirms the authenticated socket is alive and refreshes last-activity.
      void PresenceService.ping(user.id).catch(() => undefined);
      ack?.({ ok: true, at: Date.now() });
    });

    socket.on('conversation:join', async (conversationId: number, ack?: (res: unknown) => void) => {
      try {
        const id = Number(conversationId);
        if (!Number.isFinite(id)) throw new Error('invalid conversation');
        const member = await queryOne<{ id: number }>(
          'SELECT id FROM conversation_members WHERE conversation_id = ? AND employee_id = ?',
          [id, user.id],
        );
        if (!member) throw new Error('not a member');
        await socket.join(`conv:${id}`);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : 'failed' });
      }
    });

    socket.on('conversation:leave', (conversationId: number) => {
      socket.leave(`conv:${conversationId}`);
    });

    socket.on('location:join', async (locationId: number, ack?: (res: unknown) => void) => {
      try {
        const id = Number(locationId);
        if (!Number.isFinite(id)) throw new Error('invalid location');
        const allowed = user.allowedLocations?.map((l) => l.id) ?? (user.locationId ? [user.locationId] : []);
        if (user.roleLevel < 90 && !allowed.includes(id)) {
          throw new Error('unauthorized location');
        }
        await socket.join(`location:${id}`);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : 'failed' });
      }
    });

    socket.on('location:leave', (locationId: number) => {
      socket.leave(`location:${locationId}`);
    });

    socket.on('chat:typing', async (payload: { conversationId: number; typing: boolean }) => {
      if (!payload || typeof payload.conversationId !== 'number') return;
      const member = await queryOne<{ id: number }>(
        'SELECT id FROM conversation_members WHERE conversation_id = ? AND employee_id = ?',
        [payload.conversationId, user.id],
      ).catch(() => null);
      if (!member) return;
      socket.to(`conv:${payload.conversationId}`).emit('chat:typing', {
        conversationId: payload.conversationId,
        employeeId: user.id,
        employeeName: user.fullName,
        name: user.fullName,
        typing: Boolean(payload.typing),
      });
    });

    // ----------------------------- 1:1 calls --------------------------------
    // All call signalling is relayed through the private call room. A client
    // can never address an arbitrary socket, and every action re-checks that
    // the authenticated employee is a participant of the call.
    socket.on('call:join', async (payload: { callId: string }, ack?: (res: unknown) => void) => {
      try {
        const callId = String(payload?.callId ?? '');
        if (!callId) throw new Error('invalid call');
        const call = await queryOne<{ caller_id: number; callee_id: number; status: string }>(
          'SELECT caller_id, callee_id, status FROM calls WHERE call_id = ?',
          [callId],
        );
        if (!call || (Number(call.caller_id) !== user.id && Number(call.callee_id) !== user.id)) {
          throw new Error('not a participant');
        }
        if (!['ringing', 'active'].includes(call.status)) throw new Error('call ended');
        await socket.join(`call:${callId}`);
        const sockets = await io!.in(`call:${callId}`).fetchSockets();
        const participants = sockets.map((s) => {
          const u = (s.data as SocketData).user;
          return { socketId: s.id, employeeId: u.id, name: u.fullName };
        });
        socket.to(`call:${callId}`).emit('call:peer_joined', {
          callId,
          employeeId: user.id,
          name: user.fullName,
          participant: { socketId: socket.id, employeeId: user.id, name: user.fullName },
        });
        refreshPresence(user.id);
        ack?.({ ok: true, participants });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : 'failed' });
      }
    });

    socket.on('call:leave', async (payload: { callId: string }) => {
      const callId = String(payload?.callId ?? '');
      if (!callId) return;
      socket.leave(`call:${callId}`);
      socket.to(`call:${callId}`).emit('call:peer_left', { callId, employeeId: user.id });
      refreshPresence(user.id);
    });

    socket.on('call:signal', async (payload: { callId: string; signal: unknown }, ack?: (res: unknown) => void) => {
      try {
        const callId = String(payload?.callId ?? '');
        if (!callId || !payload?.signal) throw new Error('invalid signal');
        const call = await queryOne<{ caller_id: number; callee_id: number; status: string }>(
          'SELECT caller_id, callee_id, status FROM calls WHERE call_id = ?',
          [callId],
        );
        if (!call || (Number(call.caller_id) !== user.id && Number(call.callee_id) !== user.id)) {
          throw new Error('not a participant');
        }
        if (!['ringing', 'active'].includes(call.status)) throw new Error('call ended');
        socket.to(`call:${callId}`).emit('call:signal', {
          callId,
          from: socket.id,
          employeeId: user.id,
          signal: payload.signal,
        });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : 'failed' });
      }
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

    socket.on('disconnect', async () => {
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
          const callId = code.slice('call:'.length);
          try {
            const remaining = await io!.in(code).fetchSockets();
            const peers = remaining.filter((s) => (s.data as SocketData).user.id !== user.id);
            const ownSockets = remaining.filter((s) => (s.data as SocketData).user.id === user.id);
            // A second tab of the same employee must not end the call.
            if (peers.length > 0 && ownSockets.length === 0) {
              io!.to(code).emit('call:peer_left', { callId, employeeId: user.id, reason: 'disconnected' });
              io!.to(code).emit('call:ended', { callId, reason: 'disconnected', byEmployeeId: user.id });
            }
          } catch (error) {
            console.error('[realtime] call cleanup failed', error);
          }
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
