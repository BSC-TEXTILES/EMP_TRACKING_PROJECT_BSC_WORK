import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { DashboardService } from '../services/DashboardService.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
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
