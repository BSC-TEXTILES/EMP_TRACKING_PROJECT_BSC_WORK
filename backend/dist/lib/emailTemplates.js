/**
 * Transactional email templates.
 *
 * Deliberately plain, table-based HTML with inline styles so the messages render
 * consistently in Outlook, Gmail and Apple Mail. No external assets, no tracking
 * pixels, no gradient backgrounds — just the brand line, a clear heading, the
 * content and one primary action.
 */
const BRAND = '#1d4ed8';
const INK = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const APP_URL_FALLBACK = 'http://localhost:5173';
function esc(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function shell(options) {
    const { appName, heading, intro, content = '', cta, footerNote } = options;
    const ctaBlock = cta
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px">
         <tr><td style="border-radius:6px;background:${BRAND}">
           <a href="${esc(cta.url)}" style="display:inline-block;padding:11px 20px;font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${esc(cta.label)}</a>
         </td></tr>
       </table>`
        : '';
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:8px">
        <tr><td style="padding:20px 28px;border-bottom:1px solid ${BORDER}">
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;font-weight:700;color:${INK};letter-spacing:-0.01em">${esc(appName)}</span>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${MUTED};padding-left:8px">Workforce operations</span>
        </td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-family:Segoe UI,Arial,sans-serif;font-size:19px;line-height:1.35;color:${INK}">${esc(heading)}</h1>
          <p style="margin:0 0 14px;font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#334155">${intro}</p>
          ${content}
          ${ctaBlock}
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};background:#f8fafc">
          <p style="margin:0;font-family:Segoe UI,Arial,sans-serif;font-size:11px;line-height:1.6;color:${MUTED}">
            ${esc(footerNote ?? 'You are receiving this because you have an account on this Workforce platform. If this was not expected, contact your administrator.')}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
function paragraph(text) {
    // pre-wrap keeps the sender's line breaks and paragraphs in Gmail/Outlook.
    return `<p style="margin:0 0 14px;font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#334155;white-space:pre-wrap">${esc(text)}</p>`;
}
function metaTable(meta) {
    if (!meta || meta.length === 0)
        return '';
    const rows = meta
        .map((item) => `<tr>
        <td style="padding:7px 0;border-bottom:1px solid ${BORDER};font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:${MUTED};width:38%">${esc(item.label)}</td>
        <td style="padding:7px 0;border-bottom:1px solid ${BORDER};font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:${INK}">${esc(item.value)}</td>
      </tr>`)
        .join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px">${rows}</table>`;
}
function codeBlock(code) {
    return `<div style="margin:8px 0 18px;padding:16px;border:1px solid ${BORDER};border-radius:6px;background:#f8fafc;text-align:center">
    <span style="font-family:Consolas,Menlo,monospace;font-size:28px;letter-spacing:9px;font-weight:700;color:${INK}">${esc(code)}</span>
  </div>`;
}
function greeting(name) {
    return name ? `Hello ${esc(name)},` : 'Hello,';
}
function appBase(data) {
    return (data.appUrl ?? APP_URL_FALLBACK).replace(/\/+$/, '');
}
function notificationSubject(data) {
    const appName = data.appName ?? 'Workforce';
    return data.title ? `${appName}: ${data.title}` : `${appName} notification`;
}
function generic(data, appName, heading, intro) {
    const link = data.link ? `${appBase(data)}${data.link.startsWith('/') ? data.link : `/${data.link}`}` : `${appBase(data)}/notifications`;
    const html = shell({
        appName,
        heading,
        intro,
        content: `${data.body ? paragraph(data.body) : ''}${metaTable(data.meta)}`,
        cta: { label: data.linkLabel ?? 'Open in Workforce', url: link },
    });
    return {
        subject: notificationSubject(data),
        html,
        text: `${intro}\n\n${data.body ?? ''}\n\nOpen: ${link}`,
    };
}
export const EMAIL_TEMPLATES = {
    otp: {
        label: 'One-time code',
        description: 'Sign-in, registration and password-reset verification codes.',
        render: (data) => {
            const appName = data.appName ?? 'Workforce';
            const purpose = (data.purpose ?? 'verification').replace(/_/g, ' ');
            const minutes = data.expiresMinutes ?? 10;
            return {
                subject: `${appName} verification code`,
                html: shell({
                    appName,
                    heading: 'Your verification code',
                    intro: greeting(data.name),
                    content: `${paragraph(`Use the code below to continue with ${purpose}. It expires in ${minutes} minutes.`)}${codeBlock(data.code ?? '------')}${paragraph('If you did not request this code, ignore this email and consider changing your password.')}`,
                    footerNote: 'For security, never share this code with anyone, including colleagues claiming to be from IT.',
                }),
                text: `Hello ${data.name ?? ''}, your ${purpose} code is ${data.code ?? ''}. It expires in ${minutes} minutes.`,
            };
        },
    },
    welcome: {
        label: 'Account activated',
        description: 'Sent when an administrator approves a new employee account.',
        render: (data) => {
            const appName = data.appName ?? 'Workforce';
            const link = `${appBase(data)}/login`;
            return {
                subject: `${appName}: your account is ready`,
                html: shell({
                    appName,
                    heading: 'Your account is active',
                    intro: greeting(data.name),
                    content: `${paragraph('Your registration has been approved. You can now sign in, check in for attendance and see the work assigned to you.')}${metaTable(data.meta)}`,
                    cta: { label: 'Sign in', url: link },
                }),
                text: `Hello ${data.name ?? ''}, your ${appName} account is active. Sign in: ${link}`,
            };
        },
    },
    task_assigned: {
        label: 'Task allocated',
        description: 'New task allocation, reassignment or deadline change.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'New work assigned to you', greeting(data.name)),
    },
    task_reminder: {
        label: 'Task reminder',
        description: 'Deadline approaching or task overdue.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Task deadline reminder', greeting(data.name)),
    },
    report_reminder: {
        label: 'Daily report reminder',
        description: 'End-of-day nudge to submit the daily work report.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Daily report not submitted', greeting(data.name)),
    },
    ticket_update: {
        label: 'Ticket update',
        description: 'Ticket assignment, escalation, resolution or reopen.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Support ticket update', greeting(data.name)),
    },
    meeting_invite: {
        label: 'Meeting invitation',
        description: 'New meeting invitation or schedule change.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Meeting invitation', greeting(data.name)),
    },
    meeting_reminder: {
        label: 'Meeting reminder',
        description: 'Reminder shortly before a meeting starts.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Meeting starting soon', greeting(data.name)),
    },
    leave_update: {
        label: 'Leave decision',
        description: 'Leave approval or rejection with the decision stage.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Leave request update', greeting(data.name)),
    },
    kpi_published: {
        label: 'Performance published',
        description: 'Monthly KPI evaluation published to the employee.',
        render: (data) => generic(data, data.appName ?? 'Workforce', 'Monthly performance published', greeting(data.name)),
    },
    internal_email: {
        label: 'Mailbox email',
        description: 'A message an employee sent from the Workforce mailbox.',
        render: (data) => {
            const appName = data.appName ?? 'Workforce';
            const rendered = generic({ ...data, meta: [...(data.meta ?? []), ...(data.attachments?.length ? [{ label: 'Attachments', value: data.attachments.map((file) => file.name).join(', ') }] : [])] }, appName, data.title ?? 'New message', `${data.senderName ?? 'A colleague'} sent you a message through ${appName}.`);
            return { ...rendered, subject: data.title ?? `Message from ${data.senderName ?? appName}` };
        },
    },
    announcement: {
        label: 'Announcement',
        description: 'Administrative announcements and general notices.',
        render: (data) => generic(data, data.appName ?? 'Workforce', data.title ?? 'Company announcement', greeting(data.name)),
    },
    test: {
        label: 'SMTP test',
        description: 'Connection test from the email configuration page.',
        render: (data) => {
            const appName = data.appName ?? 'Workforce';
            return {
                subject: `${appName} SMTP test`,
                html: shell({
                    appName,
                    heading: 'SMTP is configured correctly',
                    intro: greeting(data.name),
                    content: paragraph('This message confirms that the platform can reach your SMTP provider and deliver mail. No further action is required.'),
                    footerNote: 'Sent from the Workforce email configuration page.',
                }),
                text: `${appName} SMTP test: delivery is working.`,
            };
        },
    },
};
export function renderEmail(template, data) {
    const definition = EMAIL_TEMPLATES[template] ?? EMAIL_TEMPLATES.announcement;
    return definition.render({ appName: data.appName ?? 'Workforce', ...data });
}
//# sourceMappingURL=emailTemplates.js.map