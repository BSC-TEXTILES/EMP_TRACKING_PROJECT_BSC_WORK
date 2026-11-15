import { Router } from 'express';
import { ApiError, asyncHandler } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { DashboardService } from '../services/DashboardService.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { ProfilePhotoService } from '../services/ProfilePhotoService.js';
import { avatarUpload } from '../lib/imageUpload.js';
import { hasPermission } from '../middleware/auth.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const meRouter = Router();
meRouter.use(authenticate);

meRouter.get(
  '/dashboard',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const data = await DashboardService.personal(user);
    res.json(data);
  }),
);

meRouter.post(
  '/photo',
  rateLimit({ windowMs: 60000, max: 10, keyPrefix: 'profile-photo' }),
  (req, res, next) => {
    avatarUpload.single('file')(req, res, (error) => {
      if (error) {
        next(ApiError.badRequest(error instanceof Error ? error.message : 'Photo upload failed'));
        return;
      }
      next();
    });
  },
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.file) throw ApiError.badRequest('Choose an image to upload.');
    const result = await ProfilePhotoService.setPhoto(currentUser(req).id, currentUser(req), req.file);
    res.status(201).json(result);
  }),
);

meRouter.delete(
  '/photo',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await ProfilePhotoService.removePhoto(currentUser(req).id, currentUser(req)));
  }),
);

meRouter.get(
  '/weekly-summary',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json({ days: await AnalyticsService.myWeeklySummary(user.id) });
  }),
);

meRouter.get(
  '/team-snapshot',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!hasPermission(user, 'tasks.view.team') && !hasPermission(user, 'employees.view.team')) {
      res.json({ size: 0, checkedIn: 0, onLeave: 0, overdueTasks: 0, pendingApprovals: 0, reportsPending: 0 });
      return;
    }
    res.json(await DashboardService.teamSnapshot(user));
  }),
);
