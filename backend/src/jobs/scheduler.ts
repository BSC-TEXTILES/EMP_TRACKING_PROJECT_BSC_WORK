import cron from 'node-cron';
import { config } from '../config.js';
import { execute, query, queryOne } from '../db/index.js';
import { AttendanceService } from '../services/AttendanceService.js';
import { DailyReportService } from '../services/DailyReportService.js';
import { KpiService } from '../services/KpiService.js';
import { MeetingService } from '../services/MeetingService.js';
import { TaskService } from '../services/TaskService.js';
import { TicketService } from '../services/TicketService.js';
import { ActivityService } from '../services/ActivityService.js';
import { FileService } from '../services/FileService.js';
import { WeeklyOffService } from '../services/WeeklyOffService.js';
import { processEmailQueue } from '../lib/mailer.js';
import { addDays, today } from '../lib/dates.js';

const running = new Set<string>();

async function runJob(name: string, task: () => Promise<string>): Promise<void> {
  if (running.has(name)) return;
  running.add(name);
  const started = await execute('INSERT INTO job_runs (job_name) VALUES (?)', [name]);
  try {
    const message = await task();
    await execute("UPDATE job_runs SET status = 'success', finished_at = NOW(3), message = ? WHERE id = ?", [
      message.slice(0, 255),
      started.insertId,
    ]);
  } catch (error) {
    console.error(`[jobs] ${name} failed`, error);
    await execute("UPDATE job_runs SET status = 'failed', finished_at = NOW(3), message = ? WHERE id = ?", [
      (error instanceof Error ? error.message : 'unknown error').slice(0, 255),
      started.insertId,
    ]);
  } finally {
    running.delete(name);
  }
}

/**
 * Background automations. Runs inside the API process; every run is recorded in
 * job_runs so administrators can audit automation activity.
 */
export function startJobs(): void {
  if (config.isTest) return;

  cron.schedule(
    '20 3 * * *',
    () => {
      void runJob('activity_retention', async () => {
        const result = await ActivityService.purgeExpired(null, false);
        return `${result.removed} activity record(s) older than ${result.retentionDays} days removed`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule('* * * * *', () => {
    void runJob('stale_calls', async () => {
      const { sweepStaleCalls } = await import('../routes/calls.js');
      const result = await sweepStaleCalls();
      return `${result.missed} unanswered call(s) marked missed, ${result.closed} abandoned call(s) closed`;
    });
  });

  cron.schedule('* * * * *', () => {
    void runJob('issue_escalation_sweep', async () => {
      const { IssueService } = await import('../services/IssueService.js');
      const result = await IssueService.runEscalationSweep();
      return `${result.remindersSent} reminder(s) sent, ${result.escalationsTriggered} auto-escalation(s) triggered`;
    });
  });

  cron.schedule(
    '35 3 * * *',
    () => {
      void runJob('push_log_retention', async () => {
        const { PushService } = await import('../services/PushService.js');
        const removed = await PushService.pruneLog(30);
        return `${removed} push delivery log row(s) older than 30 days removed`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule('*/5 * * * *', () => {
    void runJob('activity_stale_sessions', async () => {
      const closed = await ActivityService.closeStaleSessions();
      return `${closed} monitoring session(s) closed (agent disconnected, attendance closed or day ended)`;
    });
  });

  cron.schedule(
    '45 23 * * *',
    () => {
      void runJob('activity_daily_summaries', async () => {
        const { ActivityAnalyticsService } = await import('../services/ActivityAnalyticsService.js');
        const generated = await ActivityAnalyticsService.generateAllDaily(today());
        return `${generated} daily activity summary(ies) generated`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule(
    '30 1 * * 1',
    () => {
      void runJob('activity_weekly_performance', async () => {
        const { ActivityAnalyticsService } = await import('../services/ActivityAnalyticsService.js');
        const lastWeek = addDays(today(), -7);
        const generated = await ActivityAnalyticsService.generateAllWeekly(lastWeek);
        return `${generated} preliminary weekly report(s) for the week of ${lastWeek}`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule('*/5 * * * *', () => {
    void runJob('overdue_and_sla', async () => {
      const overdue = await TaskService.markOverdue();
      const breached = await TicketService.escalateBreaches();
      const meetingReminders = await MeetingService.reminderJob();
      return `${overdue} overdue task(s), ${breached} SLA breach(es), ${meetingReminders} meeting reminder(s)`;
    });
  });

  cron.schedule('* * * * *', () => {
    void runJob('email_queue', async () => {
      const result = await processEmailQueue(25);
      return `${result.sent} sent, ${result.failed} retrying, ${result.skipped} skipped`;
    });
  });

  // Daily Master Operational SOP task generation at midnight for all store roles across BEL, DAV, and SHI
  cron.schedule(
    '5 0 * * *',
    () => {
      void runJob('daily_store_sop_generation', async () => {
        const { DailyTaskService } = await import('../services/DailyTaskService.js');
        const admin = await queryOne<{ id: number; email: string; role_slug: string }>(
          `SELECT e.id, e.email, r.slug AS role_slug
           FROM employees e JOIN roles r ON e.role_id = r.id
           WHERE r.slug = 'super_admin' LIMIT 1`,
        );
        const actor = admin
          ? { id: admin.id, email: admin.email, roleSlug: 'super_admin', roleLevel: 100 }
          : { id: 1, email: 'renukaradhya@bsctextiles.in', roleSlug: 'super_admin', roleLevel: 100 };
        const result = await DailyTaskService.generateDailyTasksForStore(null, actor as any, { force: false });
        return `Generated ${result.createdTotal} SOP tasks across ${result.employeesCount} store employees (${result.carriedForward ?? 0} carried forward)`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule('*/10 * * * *', () => {
    void runJob('attendance_autoclose', async () => {
      const closed = await AttendanceService.autoCloseStaleSessions(16);
      return `${closed} stale attendance session(s) closed`;
    });
  });

  cron.schedule(
    '10 18 * * 1-6',
    () => {
      void runJob('daily_report_reminder', async () => {
        const reminded = await DailyReportService.remindMissing();
        return `${reminded} daily report reminder(s) sent`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule(
    '0 2 1 * *',
    () => {
      void runJob('monthly_kpi_generation', async () => {
        const now = new Date();
        const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const period = previous.toISOString().slice(0, 7);
        const admin = await queryOne<{ id: number }>(
          `SELECT e.id FROM employees e JOIN role_permissions rp ON rp.role_id = e.role_id
           JOIN permissions p ON p.id = rp.permission_id AND p.code = 'kpi.publish'
           WHERE e.status = 'active' LIMIT 1`,
        );
        if (!admin) return 'no KPI administrator found';
        const { KpiService: service } = await import('../services/KpiService.js');
        const user = await import('../services/AuthService.js').then((m) => m.AuthService.buildUser(Number(admin.id)));
        if (!user) return 'KPI administrator could not be loaded';
        const result = await service.generate(period, user);
        return `generated ${result.generated} KPI record(s) for ${period}`;
      });
    },
    { timezone: config.timezone },
  );

  // Comp-off: credit any worked Sunday / holiday a live hook missed, then lapse expired credits.
  cron.schedule(
    '45 0 * * *',
    () => {
      void runJob('comp_off_maintenance', async () => {
        const checked = await WeeklyOffService.reconcileRecent(7);
        const lapsed = await WeeklyOffService.expireCompOffs();
        return `${checked} worked weekly-off/holiday day(s) reconciled, ${lapsed} comp-off credit(s) lapsed`;
      });
    },
    { timezone: config.timezone },
  );

  cron.schedule('30 0 * * *', () => {
    void runJob('housekeeping', async () => {
      const sessions = await execute('DELETE FROM employee_sessions WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 30 DAY)');
      const otps = await execute('DELETE FROM otp_verifications WHERE created_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)');
      const uploads = await FileService.cleanupExpiredSessions();
      await KpiService.monthlyReminder();
      return `${sessions.affectedRows} expired session(s), ${otps.affectedRows} stale OTP row(s), ${uploads} abandoned upload(s) removed`;
    });
  });

  cron.schedule('0 * * * *', () => {
    void runJob('kpi_reminder_check', async () => {
      await KpiService.monthlyReminder();
      const pending = await query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM leave_requests WHERE status = 'pending_hr' AND created_at < DATE_SUB(NOW(3), INTERVAL 2 DAY)",
      );
      return `${Number(pending[0]?.total ?? 0)} leave request(s) awaiting HR for over 48h`;
    });
  });

  console.log(`[jobs] scheduler started (timezone ${config.timezone})`);
}
