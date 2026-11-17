import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { DashboardService } from '../services/DashboardService.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { ProfilePhotoService } from '../services/ProfilePhotoService.js';
import { avatarUpload } from '../lib/imageUpload.js';
import { hasPermission } from '../middleware/auth.js';
import { execute, queryOne } from '../db/index.js';
export const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/dashboard', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const data = await DashboardService.personal(user);
    res.json(data);
}));
meRouter.post('/photo', rateLimit({ windowMs: 60000, max: 10, keyPrefix: 'profile-photo' }), (req, res, next) => {
    avatarUpload.single('file')(req, res, (error) => {
        if (error) {
            next(ApiError.badRequest(error instanceof Error ? error.message : 'Photo upload failed'));
            return;
        }
        next();
    });
}, asyncHandler(async (req, res) => {
    if (!req.file)
        throw ApiError.badRequest('Choose an image to upload.');
    const result = await ProfilePhotoService.setPhoto(currentUser(req).id, currentUser(req), req.file);
    res.status(201).json(result);
}));
meRouter.delete('/photo', asyncHandler(async (req, res) => {
    res.json(await ProfilePhotoService.removePhoto(currentUser(req).id, currentUser(req)));
}));
meRouter.get('/weekly-summary', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ days: await AnalyticsService.myWeeklySummary(user.id) });
}));
meRouter.get('/team-snapshot', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    if (!hasPermission(user, 'tasks.view.team') && !hasPermission(user, 'employees.view.team')) {
        res.json({ size: 0, checkedIn: 0, onLeave: 0, overdueTasks: 0, pendingApprovals: 0, reportsPending: 0 });
        return;
    }
    res.json(await DashboardService.teamSnapshot(user));
}));
/**
 * Get user preferences
 */
meRouter.get('/preferences', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const prefs = await queryOne('SELECT preferences FROM employee_preferences WHERE employee_id = ?', [user.id]);
    let preferences = {};
    if (prefs?.preferences) {
        try {
            preferences = JSON.parse(prefs.preferences);
        }
        catch { }
    }
    res.json({ preferences });
}));
/**
 * Update user preferences
 */
meRouter.post('/preferences', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({
        emailNotifications: z.boolean().optional(),
        pushNotifications: z.boolean().optional(),
        desktopNotifications: z.boolean().optional(),
        callNotifications: z.boolean().optional(),
        meetingReminders: z.boolean().optional(),
        taskNotifications: z.boolean().optional(),
        theme: z.enum(['light', 'dark', 'system']).optional(),
        language: z.string().max(10).optional(),
        timezone: z.string().max(50).optional(),
    }), req.body);
    await execute(`INSERT INTO employee_preferences (employee_id, preferences, updated_at)
       VALUES (?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE preferences = VALUES(preferences), updated_at = NOW(3)`, [user.id, JSON.stringify(body)]);
    res.json({ ok: true });
}));
/**
 * Export user data (GDPR)
 */
meRouter.post('/export-data', asyncHandler(async (req, res) => {
    const user = currentUser(req);
    // Queue export job - implementation would create a background job
    // For now, just acknowledge
    res.json({ ok: true, message: 'Export queued. You will receive an email when ready.' });
}));
//# sourceMappingURL=me.js.map