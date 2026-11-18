import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny } from '../middleware/auth.js';
import { ChatService } from '../services/ChatService.js';
import { emitToConversation } from '../realtime/io.js';
export const chatRouter = Router();
chatRouter.use(authenticate, requireAny('chat.use'));
chatRouter.get('/conversations', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ conversations: await ChatService.listConversations(user.id) });
}));
chatRouter.get('/unread', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ total: await ChatService.unreadTotal(user.id) });
}));
chatRouter.get('/contacts', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ contacts: await ChatService.contacts(user) });
}));
chatRouter.post('/conversations/direct', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ employeeId: z.number().int().positive() }), req.body);
    const id = await ChatService.ensureDirectConversation(user.id, body.employeeId);
    res.status(201).json({ id });
}));
chatRouter.post('/conversations/group', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        name: z.string().min(2).max(160),
        description: z.string().max(255).optional(),
        memberIds: z.array(z.number().int().positive()).min(1),
        departmentId: z.number().int().positive().nullable().optional(),
        isAnnouncement: z.boolean().optional(),
    }), req.body);
    const id = await ChatService.createGroup(user, body);
    res.status(201).json({ id });
}));
chatRouter.get('/conversations/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    res.json(await ChatService.conversationDetail(id, user.id));
}));
chatRouter.patch('/conversations/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        name: z.string().min(1).max(160),
        description: z.string().max(255).optional(),
    }), req.body);
    await ChatService.renameConversation(id, user, body.name, body.description);
    res.json({ ok: true });
}));
chatRouter.delete('/conversations/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const result = await ChatService.deleteConversation(id, user);
    res.json(result);
}));
chatRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 40;
    const result = await ChatService.messages(id, user.id, {
        before: Number.isFinite(before) ? before : undefined,
        limit: Number.isFinite(limit) ? limit : 40,
        search: req.query.search ? String(req.query.search) : undefined,
    });
    res.json(result);
}));
chatRouter.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({
        body: z.string().max(8000).optional(),
        type: z.enum(['text', 'image', 'file', 'voice']).optional(),
        replyToId: z.number().int().positive().optional(),
        fileIds: z.array(z.number().int().positive()).max(10).optional(),
        durationSeconds: z.number().int().min(0).max(600).optional(),
        clientId: z.string().min(8).max(64).optional(),
    }), req.body);
    const message = await ChatService.sendMessage(id, user, body);
    res.status(201).json(message);
}));
chatRouter.post('/conversations/:id/read', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    await ChatService.markRead(id, user.id);
    res.json({ ok: true });
}));
chatRouter.post('/conversations/:id/members', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ memberIds: z.array(z.number().int().positive()).min(1) }), req.body);
    await ChatService.addMembers(id, user, body.memberIds);
    res.json({ ok: true });
}));
chatRouter.delete('/conversations/:id/members/:employeeId', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const employeeId = intParam(req.params.employeeId, 'employeeId');
    const user = currentUser(req);
    await ChatService.removeMember(id, user, employeeId);
    emitToConversation(id, 'conversation:members_changed', { conversationId: id });
    res.json({ ok: true });
}));
chatRouter.patch('/messages/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ body: z.string().min(1).max(8000) }), req.body);
    await ChatService.editMessage(id, user.id, body.body);
    res.json({ ok: true });
}));
chatRouter.delete('/messages/:id', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    await ChatService.deleteMessage(id, user);
    res.json({ ok: true });
}));
chatRouter.post('/messages/:id/reactions', asyncHandler(async (req, res) => {
    const id = intParam(req.params.id);
    const user = currentUser(req);
    const body = parseBody(z.object({ emoji: z.string().min(1).max(8) }), req.body);
    await ChatService.react(id, user.id, body.emoji);
    res.json({ ok: true });
}));
//# sourceMappingURL=chat.js.map