import { config } from '../config.js';
import { query, queryOne } from '../db/index.js';
import { EMAIL_TEMPLATES } from '../lib/emailTemplates.js';
import { emailStats, enqueueEmail, listDeliveries, retryDelivery, sendTestEmail, smtpStatus, } from '../lib/mailer.js';
/**
 * Bridges domain notifications and the transactional email queue.
 *
 * Business writes happen first; email is queued afterwards. A mail failure is
 * therefore never able to roll back a task, ticket, report or meeting.
 */
const TEMPLATE_BY_TYPE = [
    { match: /^task_assigned$|^task_update$/, template: 'task_assigned' },
    { match: /^task_due$|^task_overdue$|^task_reminder$/, template: 'task_reminder' },
    { match: /^daily_report/, template: 'report_reminder' },
    { match: /^ticket_/, template: 'ticket_update' },
    { match: /^meeting/, template: 'meeting_invite' },
    { match: /^leave/, template: 'leave_update' },
    { match: /^kpi/, template: 'kpi_published' },
    { match: /^account$|^registration$/, template: 'welcome' },
    { match: /^announcement$/, template: 'announcement' },
];
/** Chat stays inside the app: mailing every message would train people to ignore email. */
function shouldEmail(type) {
    return !/^(chat_message|chat_group|message)/.test(type);
}
export function templateForNotification(type) {
    return TEMPLATE_BY_TYPE.find((entry) => entry.match.test(type))?.template ?? 'announcement';
}
export class EmailService {
    /**
     * Queues one email per recipient for a persisted notification. Errors are
     * swallowed and logged: notification delivery must not fail the caller.
     */
    static async notifyRecipients(employeeIds, input) {
        if (!shouldEmail(input.type) || employeeIds.length === 0)
            return 0;
        try {
            const placeholders = employeeIds.map(() => '?').join(',');
            const recipients = await query(`SELECT id, full_name, email FROM employees
          WHERE id IN (${placeholders}) AND status = 'active' AND email <> ''`, employeeIds);
            const template = templateForNotification(input.type);
            let queued = 0;
            for (const recipient of recipients) {
                const id = await enqueueEmail({
                    to: recipient.email,
                    toName: recipient.full_name,
                    template,
                    data: {
                        name: recipient.full_name,
                        title: input.title,
                        body: input.body ?? undefined,
                        link: input.link ?? undefined,
                    },
                    subject: `${config.appName}: ${input.title}`.slice(0, 255),
                    dedupeKey: `notif:${input.notificationId}:${recipient.id}`,
                    relatedType: 'notification',
                    relatedId: input.notificationId,
                    maxAttempts: 3,
                });
                if (id)
                    queued += 1;
            }
            return queued;
        }
        catch (error) {
            console.error('[email] could not queue notification emails', error instanceof Error ? error.message : error);
            return 0;
        }
    }
    /** Direct transactional email (not tied to a notification row). */
    static async sendWelcome(employee) {
        await enqueueEmail({
            to: employee.email,
            toName: employee.fullName,
            template: 'welcome',
            data: {
                name: employee.fullName,
                meta: [
                    { label: 'Employee ID', value: employee.employeeCode },
                    ...(employee.roleName ? [{ label: 'Role', value: employee.roleName }] : []),
                ],
            },
            dedupeKey: `welcome:${employee.id}`,
            relatedType: 'employee',
            relatedId: employee.id,
        });
    }
    static async sendTest(to) {
        return sendTestEmail(to);
    }
    static async retry(id) {
        return retryDelivery(id);
    }
    static async deliveries(options) {
        return listDeliveries(options);
    }
    static async overview() {
        const [status, stats, counts] = await Promise.all([
            smtpStatus(),
            emailStats(),
            queryOne('SELECT COUNT(*) AS total FROM email_deliveries WHERE created_at > DATE_SUB(NOW(3), INTERVAL 24 HOUR)'),
        ]);
        return {
            status,
            stats,
            last24h: Number(counts?.total ?? 0),
            templates: Object.entries(EMAIL_TEMPLATES).map(([key, definition]) => ({
                key,
                label: definition.label,
                description: definition.description,
            })),
            settings: {
                appName: config.appName,
                appUrl: config.appUrl,
                otpExpiryMinutes: config.otp.expiryMinutes,
                otpResendCooldownSeconds: config.otp.resendCooldownSeconds,
                otpMaxAttempts: config.otp.maxAttempts,
                provider: 'SMTP',
            },
        };
    }
}
//# sourceMappingURL=EmailService.js.map