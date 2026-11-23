import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../../db/index.js';
import { ApiError } from '../../lib/http.js';
import { allowedLocationIds, assertEmployeeAccess } from '../../lib/scope.js';
import { TrackingConfig } from './TrackingConfig.js';
import { buildDay, canSeeOthers, dateList, dayStats, deviceLive, devicesByEmployee, employeeLiveStatus, trackingScope, validRange } from './TrackingQueryService.js';
import { trackingAudit } from './trackingAudit.js';
const TZ = 'Asia/Kolkata';
const MAX_EMPLOYEE_DAYS = 2500;
function fmtDateTime(value) {
    if (!value)
        return '';
    return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value));
}
function fmtTime(value) {
    if (!value)
        return '';
    return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value));
}
export function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(seconds ?? 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
}
async function collect(user, request) {
    const { from, to } = validRange(request.from, request.to, 31);
    let ids;
    let scopeLabel;
    if (request.employeeId) {
        await assertEmployeeAccess(user, request.employeeId, 'activity');
        ids = [request.employeeId];
        scopeLabel = 'Individual employee';
    }
    else {
        if (!canSeeOthers(user))
            throw ApiError.forbidden('You can only download your own activity report.');
        const scope = await trackingScope(user);
        const params = [];
        let where = "e.status = 'active'";
        if (scope !== null) {
            if (scope.length === 0)
                return { employees: [], scopeLabel: 'No employees' };
            where += ` AND e.id IN (${scope.map(() => '?').join(',')})`;
            params.push(...scope);
        }
        const code = (request.location ?? 'all').toUpperCase();
        if (code !== 'ALL') {
            const allowed = await allowedLocationIds(user);
            const loc = await query('SELECT id FROM locations WHERE code = ?', [code]);
            if (!loc.length)
                throw ApiError.badRequest('Unknown location.');
            if (allowed !== null && !allowed.includes(Number(loc[0].id)))
                throw ApiError.forbidden('That location is outside your access.');
            where += ' AND e.location_id = ?';
            params.push(Number(loc[0].id));
            scopeLabel = `Location ${code}`;
        }
        else {
            scopeLabel = 'All permitted locations';
        }
        ids = (await query(`SELECT e.id FROM employees e WHERE ${where} ORDER BY e.full_name`, params)).map((r) => Number(r.id));
    }
    const dates = dateList(from, to);
    if (ids.length * dates.length > MAX_EMPLOYEE_DAYS) {
        throw ApiError.badRequest(`This report would cover ${ids.length * dates.length} employee-days. Narrow the location or date range (limit ${MAX_EMPLOYEE_DAYS}).`);
    }
    if (ids.length === 0)
        return { employees: [], scopeLabel };
    const info = await query(`SELECT e.id, e.employee_code, e.full_name, e.location_id, l.code AS location_code, l.name AS location_name, dp.name AS department_name, dg.title AS designation_title
     FROM employees e LEFT JOIN locations l ON l.id = e.location_id LEFT JOIN departments dp ON dp.id = e.department_id
     LEFT JOIN designations dg ON dg.id = e.designation_id
     WHERE e.id IN (${ids.map(() => '?').join(',')}) ORDER BY FIELD(l.code,'BEL','DAV','SHI','HQ'), e.full_name`, ids);
    const [stats, devices] = await Promise.all([dayStats(ids, from, to), devicesByEmployee(ids, true)]);
    const employees = [];
    for (const row of info) {
        const id = Number(row.id);
        const settings = await TrackingConfig.forLocation(row.location_id ? Number(row.location_id) : null);
        const deviceRows = devices.get(id) ?? [];
        const live = deviceRows.filter((d) => d.status === 'active').map((d) => deviceLive(d, settings));
        const days = [];
        for (const date of dates) {
            // Days with no recorded activity are still listed so missing data is visible.
            days.push({ date, day: stats.get(id)?.has(date) ? await buildDay(id, date, settings) : null });
        }
        employees.push({
            id,
            code: String(row.employee_code),
            name: String(row.full_name),
            location: String(row.location_name ?? ''),
            locationCode: String(row.location_code ?? ''),
            department: String(row.department_name ?? ''),
            designation: String(row.designation_title ?? ''),
            settings,
            status: employeeLiveStatus(live, settings).status,
            devices: deviceRows.map((d) => deviceLive(d, settings)),
            deviceRows,
            days,
        });
    }
    return { employees, scopeLabel };
}
const STATUS_LABEL = {
    active: 'Active', idle: 'Idle', locked: 'Locked', offline: 'Offline', not_installed: 'Agent not installed', disabled: 'Tracking disabled',
};
export const TrackingReportService = {
    async generate(user, request, ip) {
        const { employees, scopeLabel } = await collect(user, request);
        const { from, to } = validRange(request.from, request.to, 31);
        const stamp = from === to ? from : `${from}_to_${to}`;
        const subject = request.employeeId && employees[0] ? employees[0].code : (request.location ?? 'all').toUpperCase();
        const base = `activity-report-${subject}-${stamp}`.replace(/[^A-Za-z0-9_.-]/g, '-');
        await trackingAudit(user.id, 'tracking.report_exported', request.employeeId ?? null, 'tracking_report', null, {
            format: request.format, from, to, location: request.location ?? null, employees: employees.length,
        }, ip);
        if (request.format === 'pdf') {
            return { buffer: await pdf(employees, { from, to, scopeLabel, generatedBy: user.fullName }), filename: `${base}.pdf`, mimeType: 'application/pdf' };
        }
        return {
            buffer: await excel(employees, { from, to, scopeLabel, generatedBy: user.fullName }),
            filename: `${base}.xlsx`,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
    },
};
async function excel(employees, meta) {
    const book = new ExcelJS.Workbook();
    book.creator = 'BSC Textiles HRMS';
    book.created = new Date();
    const header = (sheet, columns) => {
        sheet.columns = columns;
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    };
    const about = book.addWorksheet('Report');
    about.columns = [{ width: 28 }, { width: 70 }];
    const aboutRows = [
        ['Report', 'Employee Activity Tracking Report'],
        ['Organisation', 'BSC Textiles HRMS'],
        ['Scope', meta.scopeLabel],
        ['Date range', meta.from === meta.to ? meta.from : `${meta.from} to ${meta.to}`],
        ['Employees', String(employees.length)],
        ['Generated by', meta.generatedBy],
        ['Generated at', `${fmtDateTime(new Date().toISOString())} (Asia/Kolkata)`],
        ['Time zone', 'All times are Asia/Kolkata (IST). Data is stored in UTC.'],
        ['Data basis', 'Only activity observed by the registered tracking agent is reported. "Untracked" time inside the observed span means the device was asleep, offline or the agent was not running; it is never estimated.'],
    ];
    for (const [k, v] of aboutRows) {
        const r = about.addRow([k, v]);
        r.getCell(1).font = { bold: true };
        r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    }
    const summary = book.addWorksheet('Daily Summary');
    header(summary, [
        { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Employee Name', key: 'name', width: 26 },
        { header: 'Location', key: 'loc', width: 10 }, { header: 'Department', key: 'dept', width: 18 }, { header: 'Date', key: 'date', width: 12 },
        { header: 'First Login', key: 'first', width: 12 }, { header: 'Last Logout', key: 'last', width: 12 },
        { header: 'Session Time', key: 'session', width: 13 }, { header: 'Active', key: 'active', width: 11 }, { header: 'Idle', key: 'idle', width: 11 },
        { header: 'Locked', key: 'locked', width: 11 }, { header: 'Untracked (offline)', key: 'offline', width: 18 },
        { header: 'Data Completeness %', key: 'complete', width: 19 }, { header: 'Sessions', key: 'sessions', width: 10 },
        { header: 'Active (seconds)', key: 'activeS', width: 15 }, { header: 'Idle (seconds)', key: 'idleS', width: 14 }, { header: 'Note', key: 'note', width: 34 },
    ]);
    const apps = book.addWorksheet('Applications');
    header(apps, [
        { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Employee Name', key: 'name', width: 26 }, { header: 'Date', key: 'date', width: 12 },
        { header: 'Application', key: 'app', width: 32 }, { header: 'First Used', key: 'first', width: 12 }, { header: 'Last Used', key: 'last', width: 12 },
        { header: 'Active Duration', key: 'active', width: 15 }, { header: 'Idle in App', key: 'idle', width: 12 }, { header: 'Active (seconds)', key: 'activeS', width: 15 },
    ]);
    const sites = book.addWorksheet('Websites');
    header(sites, [
        { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Employee Name', key: 'name', width: 26 }, { header: 'Date', key: 'date', width: 12 },
        { header: 'Browser', key: 'browser', width: 16 }, { header: 'Website Domain', key: 'domain', width: 32 }, { header: 'First Visited', key: 'first', width: 13 },
        { header: 'Last Visited', key: 'last', width: 13 }, { header: 'Active Duration', key: 'active', width: 15 }, { header: 'Visits', key: 'visits', width: 8 },
    ]);
    const sessionsSheet = book.addWorksheet('Sessions');
    header(sessionsSheet, [
        { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Employee Name', key: 'name', width: 26 }, { header: 'Date', key: 'date', width: 12 },
        { header: 'Device', key: 'device', width: 22 }, { header: 'Started', key: 'start', width: 12 }, { header: 'Ended', key: 'end', width: 12 },
        { header: 'Duration', key: 'dur', width: 12 }, { header: 'End Reason', key: 'reason', width: 22 },
    ]);
    const gapsSheet = book.addWorksheet('Missing Data');
    header(gapsSheet, [
        { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Employee Name', key: 'name', width: 26 }, { header: 'Date', key: 'date', width: 12 },
        { header: 'From', key: 'from', width: 12 }, { header: 'To', key: 'to', width: 12 }, { header: 'Duration', key: 'dur', width: 12 }, { header: 'Reason', key: 'reason', width: 34 },
    ]);
    const devicesSheet = book.addWorksheet('Devices');
    header(devicesSheet, [
        { header: 'Employee ID', key: 'code', width: 14 }, { header: 'Employee Name', key: 'name', width: 26 }, { header: 'Location', key: 'loc', width: 10 },
        { header: 'Device', key: 'device', width: 22 }, { header: 'OS', key: 'os', width: 20 }, { header: 'Agent Version', key: 'ver', width: 13 },
        { header: 'Registration', key: 'reg', width: 13 }, { header: 'Enrolled', key: 'enrolled', width: 20 }, { header: 'Last Heartbeat', key: 'hb', width: 20 },
        { header: 'Last Sync', key: 'sync', width: 20 }, { header: 'Pending Events', key: 'pending', width: 14 }, { header: 'Connection Failures', key: 'fail', width: 18 },
        { header: 'Current Tracking Status', key: 'status', width: 22 }, { header: 'Sync Problem', key: 'syncErr', width: 34 },
    ]);
    for (const e of employees) {
        for (const { date, day } of e.days) {
            const s = day?.summary;
            summary.addRow({
                code: e.code, name: e.name, loc: e.locationCode, dept: e.department, date,
                first: fmtTime(s?.firstLoginAt), last: s?.stillSignedIn ? 'Signed in' : fmtTime(s?.lastLogoutAt),
                session: fmtDuration(s?.sessionSeconds), active: fmtDuration(s?.activeSeconds), idle: fmtDuration(s?.idleSeconds),
                locked: fmtDuration(s?.lockedSeconds), offline: fmtDuration(s?.offlineSeconds),
                complete: s?.completenessPercent ?? '', sessions: s?.sessionCount ?? 0, activeS: s?.activeSeconds ?? 0, idleS: s?.idleSeconds ?? 0,
                note: !day ? (e.status === 'not_installed' ? 'Tracking agent not installed' : 'No tracking data recorded') : '',
            });
            if (!day)
                continue;
            for (const a of day.applications)
                apps.addRow({ code: e.code, name: e.name, date, app: a.app, first: fmtTime(a.firstUsedAt), last: fmtTime(a.lastUsedAt), active: fmtDuration(a.activeSeconds), idle: fmtDuration(a.idleSeconds), activeS: a.activeSeconds });
            for (const w of day.websites)
                sites.addRow({ code: e.code, name: e.name, date, browser: w.browser, domain: w.domain, first: fmtTime(w.firstVisitedAt), last: fmtTime(w.lastVisitedAt), active: fmtDuration(w.activeSeconds), visits: w.visits });
            for (const x of day.sessions)
                sessionsSheet.addRow({ code: e.code, name: e.name, date, device: x.device, start: fmtTime(x.startedAt), end: x.open ? 'Open' : fmtTime(x.endedAt), dur: fmtDuration(x.seconds), reason: x.endReason ?? '' });
            for (const g of day.gaps)
                gapsSheet.addRow({ code: e.code, name: e.name, date, from: fmtTime(g.start), to: fmtTime(g.end), dur: fmtDuration(g.seconds), reason: g.reason });
        }
        if (e.devices.length === 0) {
            devicesSheet.addRow({ code: e.code, name: e.name, loc: e.locationCode, device: 'No device registered', status: STATUS_LABEL[e.status] ?? e.status });
        }
        for (const [index, d] of e.devices.entries()) {
            devicesSheet.addRow({
                code: e.code, name: e.name, loc: e.locationCode, device: d.deviceName, os: [d.osName, d.osVersion].filter(Boolean).join(' '),
                ver: d.agentVersion ?? '', reg: String(e.deviceRows[index]?.status ?? ''), enrolled: fmtDateTime(d.enrolledAt), hb: fmtDateTime(d.lastHeartbeatAt),
                sync: fmtDateTime(d.lastSyncAt), pending: d.pendingEvents, fail: d.connectionFailures,
                status: e.deviceRows[index]?.status === 'active' ? (d.online ? 'Connected' : 'Offline') : 'Revoked', syncErr: d.syncError ?? '',
            });
        }
    }
    return Buffer.from(await book.xlsx.writeBuffer());
}
async function pdf(employees, meta) {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true, info: { Title: 'Employee Activity Tracking Report', Author: 'BSC Textiles HRMS' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    const width = doc.page.width - 64;
    const BRAND = '#1F3A5F';
    const ensure = (height) => { if (doc.y + height > doc.page.height - 48)
        doc.addPage(); };
    const table = (headers, widths, rows) => {
        const total = widths.reduce((a, b) => a + b, 0);
        const scaled = widths.map((w) => (w / total) * width);
        const drawHeader = () => {
            ensure(40);
            const y = doc.y;
            doc.rect(32, y, width, 16).fill(BRAND);
            let x = 32;
            doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5);
            headers.forEach((h, i) => { doc.text(h, x + 3, y + 4, { width: scaled[i] - 6, lineBreak: false, ellipsis: true }); x += scaled[i]; });
            doc.y = y + 16;
        };
        drawHeader();
        doc.font('Helvetica').fontSize(7.5).fillColor('#222222');
        rows.forEach((row, index) => {
            if (doc.y + 14 > doc.page.height - 48) {
                doc.addPage();
                drawHeader();
                doc.font('Helvetica').fontSize(7.5).fillColor('#222222');
            }
            const y = doc.y;
            if (index % 2 === 1)
                doc.rect(32, y, width, 14).fill('#F2F5F9');
            doc.fillColor('#222222');
            let x = 32;
            row.forEach((cell, i) => { doc.text(cell ?? '', x + 3, y + 3.5, { width: scaled[i] - 6, lineBreak: false, ellipsis: true }); x += scaled[i]; });
            doc.y = y + 14;
        });
        doc.moveDown(0.6);
    };
    const heading = (text, size = 11) => { ensure(30); doc.x = 32; doc.font('Helvetica-Bold').fontSize(size).fillColor(BRAND).text(text, 32, doc.y, { width }); doc.moveDown(0.25); };
    doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND).text('BSC Textiles HRMS — Employee Activity Tracking Report', 32, 32, { width });
    doc.font('Helvetica').fontSize(9).fillColor('#444444')
        .text(`Scope: ${meta.scopeLabel}   ·   Range: ${meta.from === meta.to ? meta.from : `${meta.from} to ${meta.to}`}   ·   Employees: ${employees.length}`, { width })
        .text(`Generated ${fmtDateTime(new Date().toISOString())} IST by ${meta.generatedBy}. Only activity observed by registered tracking agents is shown; untracked time is reported as such and never estimated.`, { width });
    doc.moveDown(0.8);
    if (employees.length === 0) {
        doc.font('Helvetica').fontSize(10).fillColor('#222222').text('No employees match this report scope.');
    }
    if (employees.length > 1) {
        heading('Overview');
        table(['Employee ID', 'Name', 'Loc', 'Days with data', 'Active', 'Idle', 'Locked', 'Untracked', 'Status now'], [10, 22, 6, 10, 9, 9, 9, 9, 14], employees.map((e) => {
            const ds = e.days.filter((d) => d.day);
            const sum = (k) => ds.reduce((a, d) => a + (d.day.summary[k] ?? 0), 0);
            return [e.code, e.name, e.locationCode, `${ds.length}/${e.days.length}`, fmtDuration(sum('activeSeconds')), fmtDuration(sum('idleSeconds')), fmtDuration(sum('lockedSeconds')), fmtDuration(sum('offlineSeconds')), STATUS_LABEL[e.status] ?? e.status];
        }));
    }
    for (const e of employees) {
        if (employees.length > 1)
            doc.addPage();
        heading(`${e.name} (${e.code})`, 13);
        doc.font('Helvetica').fontSize(8.5).fillColor('#444444')
            .text(`${e.designation || '—'} · ${e.department || '—'} · ${e.location || '—'} · Tracking status now: ${STATUS_LABEL[e.status] ?? e.status}`, 32, doc.y, { width });
        doc.moveDown(0.5);
        heading('Daily summary', 10);
        table(['Date', 'First login', 'Last logout', 'Session', 'Active', 'Idle', 'Locked', 'Untracked', 'Complete', 'Sessions', 'Note'], [9, 8, 8, 8, 8, 8, 8, 8, 7, 6, 18], e.days.map(({ date, day }) => {
            const s = day?.summary;
            return [date, fmtTime(s?.firstLoginAt), s?.stillSignedIn ? 'Signed in' : fmtTime(s?.lastLogoutAt), fmtDuration(s?.sessionSeconds), fmtDuration(s?.activeSeconds),
                fmtDuration(s?.idleSeconds), fmtDuration(s?.lockedSeconds), fmtDuration(s?.offlineSeconds), s?.completenessPercent != null ? `${s.completenessPercent}%` : '',
                String(s?.sessionCount ?? 0), !day ? (e.status === 'not_installed' ? 'Agent not installed' : 'No data recorded') : ''];
        }));
        const appTotals = new Map();
        const siteTotals = new Map();
        const sessionRows = [];
        const gapRows = [];
        for (const { date, day } of e.days) {
            if (!day)
                continue;
            for (const a of day.applications) {
                const t = appTotals.get(a.app) ?? { active: 0, first: a.firstUsedAt, last: a.lastUsedAt };
                t.active += a.activeSeconds;
                if (a.firstUsedAt < t.first)
                    t.first = a.firstUsedAt;
                if (a.lastUsedAt > t.last)
                    t.last = a.lastUsedAt;
                appTotals.set(a.app, t);
            }
            for (const w of day.websites) {
                const key = `${w.browser}|${w.domain}`;
                const t = siteTotals.get(key) ?? { browser: w.browser, domain: w.domain, active: 0, visits: 0, first: w.firstVisitedAt, last: w.lastVisitedAt };
                t.active += w.activeSeconds;
                t.visits += w.visits;
                if (w.firstVisitedAt < t.first)
                    t.first = w.firstVisitedAt;
                if (w.lastVisitedAt > t.last)
                    t.last = w.lastVisitedAt;
                siteTotals.set(key, t);
            }
            for (const x of day.sessions)
                sessionRows.push([date, x.device, fmtTime(x.startedAt), x.open ? 'Open' : fmtTime(x.endedAt), fmtDuration(x.seconds), x.endReason ?? '']);
            for (const g of day.gaps)
                gapRows.push([date, fmtTime(g.start), fmtTime(g.end), fmtDuration(g.seconds), g.reason]);
        }
        if (appTotals.size) {
            heading('Application usage (observed active time)', 10);
            table(['Application', 'First used', 'Last used', 'Active'], [40, 20, 20, 12], [...appTotals.entries()].sort((a, b) => b[1].active - a[1].active).slice(0, 40).map(([app, t]) => [app, fmtDateTime(t.first), fmtDateTime(t.last), fmtDuration(t.active)]));
        }
        if (siteTotals.size) {
            heading('Website usage (observed active time)', 10);
            table(['Browser', 'Domain', 'First visited', 'Last visited', 'Active', 'Visits'], [14, 34, 18, 18, 10, 6], [...siteTotals.values()].sort((a, b) => b.active - a.active).slice(0, 40).map((t) => [t.browser, t.domain, fmtDateTime(t.first), fmtDateTime(t.last), fmtDuration(t.active), String(t.visits)]));
        }
        if (sessionRows.length) {
            heading('Session history', 10);
            table(['Date', 'Device', 'Started', 'Ended', 'Duration', 'End reason'], [10, 24, 10, 10, 10, 20], sessionRows.slice(0, 200));
        }
        if (gapRows.length) {
            heading('Missing data / offline periods', 10);
            table(['Date', 'From', 'To', 'Duration', 'Reason'], [12, 12, 12, 12, 40], gapRows.slice(0, 200));
        }
        heading('Devices', 10);
        table(['Device', 'OS', 'Agent', 'Registration', 'Last heartbeat', 'Last sync', 'Pending', 'Failures', 'Sync problem'], [16, 14, 7, 9, 14, 14, 7, 7, 20], e.devices.length ? e.devices.map((d, i) => [d.deviceName, [d.osName, d.osVersion].filter(Boolean).join(' '), d.agentVersion ?? '', String(e.deviceRows[i]?.status ?? ''), fmtDateTime(d.lastHeartbeatAt), fmtDateTime(d.lastSyncAt), String(d.pendingEvents), String(d.connectionFailures), d.syncError ?? ''])
            : [['No tracking device registered', '', '', '', '', '', '', '', '']]);
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(7).fillColor('#888888').text(`BSC Textiles HRMS · Confidential · Page ${i + 1} of ${range.count}`, 32, doc.page.height - 24, { width, align: 'center', lineBreak: false });
    }
    doc.end();
    return done;
}
//# sourceMappingURL=TrackingReportService.js.map