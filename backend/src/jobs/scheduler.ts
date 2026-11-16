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
import { processEmailQueue } from '../lib/mailer.js';

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

  cron.schedule('30 0 * * *', () => {
    void runJob('housekeeping', async () => {
      const sessions = await execute('DELETE FROM employee_sessions WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 30 DAY)');
      const otps = await execute('DELETE FROM otp_verifications WHERE created_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)');
      await KpiService.monthlyReminder();
      return `${sessions.affectedRows} expired session(s), ${otps.affectedRows} stale OTP row(s) removed`;
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
