import { emailSettingsRouter } from './emailSettings.js';
import { Router } from 'express';
import { queryOne } from '../db/index.js';
import { authRouter } from './auth.js';
import { meRouter } from './me.js';
import { attendanceRouter } from './attendance.js';
import { tasksRouter } from './tasks.js';
import { reportsRouter } from './reports.js';
import { chatRouter } from './chat.js';
import { ticketsRouter } from './tickets.js';
import { meetingsRouter } from './meetings.js';
import { kpiRouter } from './kpi.js';
import { leaveRouter } from './leave.js';
import { projectsRouter } from './projects.js';
import { collectionsRouter } from './collections.js';
import { activityRouter } from './activity.js';
import { employeesRouter } from './employees.js';
import { notificationsRouter } from './notifications.js';
import { analyticsRouter } from './analytics.js';
import { adminRouter } from './admin.js';
import { filesRouter } from './files.js';
import { exportsRouter } from './exports.js';
import { asyncHandler } from '../lib/http.js';
export const apiRouter = Router();
apiRouter.get('/live', (_req, res) => { res.json({ status: 'ok' }); });
apiRouter.get(['/health', '/ready'], asyncHandler(async (_req, res) => {
    try {
        await queryOne('SELECT 1 AS ok');
        res.json({ status: 'ok' });
    }
    catch {
        res.status(503).json({ status: 'unavailable' });
    }
}));
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/tasks', tasksRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/chat', chatRouter);
apiRouter.use('/tickets', ticketsRouter);
apiRouter.use('/meetings', meetingsRouter);
apiRouter.use('/kpi', kpiRouter);
apiRouter.use('/leave', leaveRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/collections', collectionsRouter);
apiRouter.use('/activity', activityRouter);
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/admin/email/configuration', emailSettingsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/exports', exportsRouter);
//# sourceMappingURL=index.js.map