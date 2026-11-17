import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { query } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { addDays, endOfMonth, startOfMonth, today } from '../lib/dates.js';
import { subtreeIds } from '../lib/scope.js';
export class ExportService {
    static async dataset(type, user, filters) {
        const collectionExport = type === 'collections';
        const canExportCollections = ['collections.view.own', 'collections.view.team', 'collections.view.all'].some((code) => user.permissions.includes(code));
        if (collectionExport ? !canExportCollections : !user.permissions.includes('reports.export') && !user.permissions.includes('analytics.view')) {
            throw ApiError.forbidden('You do not have permission to export reports.');
        }
        const scopeAll = collectionExport
            ? user.permissions.includes('collections.view.all')
            : user.permissions.includes('reports.view.all') ||
                user.permissions.includes('analytics.view.all') ||
                user.permissions.includes('employees.view.all');
        const teamIds = scopeAll ? null : await subtreeIds(user.id);
        const placeholders = teamIds === null ? null : teamIds.map(() => '?').join(',') || '0';
        const from = filters.from ?? startOfMonth(today());
        const to = filters.to ?? endOfMonth(today());
        switch (type) {
            case 'attendance': {
                const rows = await query(`SELECT a.work_date AS date, e.employee_code AS code, e.full_name AS employee, d.name AS department,
                  a.status, TIME(a.check_in_at) AS check_in, TIME(a.check_out_at) AS check_out,
                  a.total_minutes AS worked_minutes, a.break_minutes, a.overtime_minutes,
                  IF(a.is_late, 'Yes', 'No') AS late
           FROM attendance a
           JOIN employees e ON e.id = a.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE a.work_date BETWEEN ? AND ?
             ${placeholders ? `AND a.employee_id IN (${placeholders})` : ''}
             ${filters.employeeId ? 'AND a.employee_id = ?' : ''}
             ${filters.departmentId ? 'AND e.department_id = ?' : ''}
           ORDER BY a.work_date DESC, e.full_name`, [from, to, ...(placeholders ? teamIds : []), ...(filters.employeeId ? [filters.employeeId] : []), ...(filters.departmentId ? [filters.departmentId] : [])]);
                return {
                    title: `Attendance report ${from} to ${to}`,
                    columns: [
                        { header: 'Date', key: 'date', width: 14 },
                        { header: 'Employee ID', key: 'code', width: 14 },
                        { header: 'Employee', key: 'employee', width: 26 },
                        { header: 'Department', key: 'department', width: 20 },
                        { header: 'Status', key: 'status', width: 12 },
                        { header: 'Check In', key: 'check_in', width: 12 },
                        { header: 'Check Out', key: 'check_out', width: 12 },
                        { header: 'Worked (min)', key: 'worked_minutes', width: 14 },
                        { header: 'Break (min)', key: 'break_minutes', width: 12 },
                        { header: 'Overtime (min)', key: 'overtime_minutes', width: 14 },
                        { header: 'Late', key: 'late', width: 8 },
                    ],
                    rows,
                };
            }
            case 'tasks': {
                const rows = await query(`SELECT t.task_no AS task_no, t.title, e.full_name AS assignee, d.name AS department, t.priority, t.status,
                  t.start_date, t.due_date, t.progress, t.completed_at, t.approved_at,
                  (SELECT GROUP_CONCAT(x.full_name SEPARATOR ', ') FROM task_assignments ta JOIN employees x ON x.id = ta.employee_id WHERE ta.task_id = t.id) AS assignees
           FROM tasks t
           LEFT JOIN departments d ON d.id = t.department_id
           LEFT JOIN task_assignments tas ON tas.task_id = t.id
           LEFT JOIN employees e ON e.id = tas.employee_id
           WHERE t.archived_at IS NULL AND (t.created_at BETWEEN ? AND ? OR t.due_date BETWEEN ? AND ?)
             ${placeholders ? `AND (t.created_by IN (${placeholders}) OR tas.employee_id IN (${placeholders}))` : ''}
           GROUP BY t.id, e.full_name
           ORDER BY t.due_date DESC`, [from, to, from, to, ...(placeholders ? [...teamIds, ...teamIds] : [])]);
                return {
                    title: `Task report ${from} to ${to}`,
                    columns: [
                        { header: 'Task No', key: 'task_no', width: 12 },
                        { header: 'Title', key: 'title', width: 38 },
                        { header: 'Assignees', key: 'assignees', width: 30 },
                        { header: 'Department', key: 'department', width: 20 },
                        { header: 'Priority', key: 'priority', width: 10 },
                        { header: 'Status', key: 'status', width: 16 },
                        { header: 'Start', key: 'start_date', width: 12 },
                        { header: 'Due', key: 'due_date', width: 12 },
                        { header: 'Progress %', key: 'progress', width: 12 },
                        { header: 'Completed', key: 'completed_at', width: 20 },
                        { header: 'Approved', key: 'approved_at', width: 20 },
                    ],
                    rows,
                };
            }
            case 'kpi': {
                const period = filters.period ?? today().slice(0, 7);
                const rows = await query(`SELECT e.employee_code AS code, e.full_name AS employee, d.name AS department, k.period,
                  k.total_score AS score, k.category, k.status, k.manager_comment
           FROM employee_kpi_records k
           JOIN employees e ON e.id = k.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE k.period = ? ${placeholders ? `AND k.employee_id IN (${placeholders})` : ''}
           ORDER BY k.total_score DESC`, [period, ...(placeholders ? teamIds : [])]);
                return {
                    title: `KPI report ${period}`,
                    columns: [
                        { header: 'Employee ID', key: 'code', width: 14 },
                        { header: 'Employee', key: 'employee', width: 26 },
                        { header: 'Department', key: 'department', width: 20 },
                        { header: 'Period', key: 'period', width: 10 },
                        { header: 'Score', key: 'score', width: 10 },
                        { header: 'Category', key: 'category', width: 18 },
                        { header: 'Status', key: 'status', width: 12 },
                        { header: 'Manager comment', key: 'manager_comment', width: 40 },
                    ],
                    rows,
                };
            }
            case 'tickets': {
                const rows = await query(`SELECT t.ticket_no, t.subject, t.category, t.priority, t.status, t.assigned_team,
                  rq.full_name AS requester, asg.full_name AS assignee, t.sla_due_at, t.created_at, t.resolved_at
           FROM tickets t
           JOIN employees rq ON rq.id = t.requester_id
           LEFT JOIN employees asg ON asg.id = t.assignee_id
           WHERE t.created_at BETWEEN ? AND ?
             ${placeholders ? `AND (t.requester_id IN (${placeholders}) OR t.assignee_id IN (${placeholders}))` : ''}
           ORDER BY t.created_at DESC`, [from, to, ...(placeholders ? [...teamIds, ...teamIds] : [])]);
                return {
                    title: `Ticket report ${from} to ${to}`,
                    columns: [
                        { header: 'Ticket', key: 'ticket_no', width: 12 },
                        { header: 'Subject', key: 'subject', width: 38 },
                        { header: 'Category', key: 'category', width: 20 },
                        { header: 'Priority', key: 'priority', width: 10 },
                        { header: 'Status', key: 'status', width: 20 },
                        { header: 'Team', key: 'assigned_team', width: 16 },
                        { header: 'Requester', key: 'requester', width: 22 },
                        { header: 'Assignee', key: 'assignee', width: 22 },
                        { header: 'SLA due', key: 'sla_due_at', width: 20 },
                        { header: 'Created', key: 'created_at', width: 20 },
                        { header: 'Resolved', key: 'resolved_at', width: 20 },
                    ],
                    rows,
                };
            }
            case 'leave': {
                const rows = await query(`SELECT e.employee_code AS code, e.full_name AS employee, lt.name AS leave_type, l.start_date, l.end_date,
                  l.days, l.status, l.decision_note
           FROM leave_requests l
           JOIN employees e ON e.id = l.employee_id
           JOIN leave_types lt ON lt.id = l.leave_type_id
           WHERE l.start_date BETWEEN ? AND ?
             ${placeholders ? `AND l.employee_id IN (${placeholders})` : ''}
           ORDER BY l.start_date DESC`, [from, to, ...(placeholders ? teamIds : [])]);
                return {
                    title: `Leave report ${from} to ${to}`,
                    columns: [
                        { header: 'Employee ID', key: 'code', width: 14 },
                        { header: 'Employee', key: 'employee', width: 26 },
                        { header: 'Leave type', key: 'leave_type', width: 18 },
                        { header: 'Start', key: 'start_date', width: 12 },
                        { header: 'End', key: 'end_date', width: 12 },
                        { header: 'Days', key: 'days', width: 8 },
                        { header: 'Status', key: 'status', width: 18 },
                        { header: 'Decision note', key: 'decision_note', width: 30 },
                    ],
                    rows,
                };
            }
            case 'daily-reports': {
                const rows = await query(`SELECT r.report_date AS date, e.full_name AS employee, e.employee_code AS code, d.name AS department,
                  r.tasks_completed, r.tasks_in_progress, r.tasks_pending, r.total_minutes AS minutes,
                  r.status, r.summary, r.review_note
           FROM daily_work_reports r
           JOIN employees e ON e.id = r.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE r.report_date BETWEEN ? AND ?
             ${placeholders ? `AND r.employee_id IN (${placeholders})` : ''}
           ORDER BY r.report_date DESC`, [from, to, ...(placeholders ? teamIds : [])]);
                return {
                    title: `Daily work reports ${from} to ${to}`,
                    columns: [
                        { header: 'Date', key: 'date', width: 12 },
                        { header: 'Employee ID', key: 'code', width: 14 },
                        { header: 'Employee', key: 'employee', width: 24 },
                        { header: 'Department', key: 'department', width: 20 },
                        { header: 'Completed', key: 'tasks_completed', width: 12 },
                        { header: 'In progress', key: 'tasks_in_progress', width: 12 },
                        { header: 'Pending', key: 'tasks_pending', width: 10 },
                        { header: 'Minutes', key: 'minutes', width: 10 },
                        { header: 'Status', key: 'status', width: 18 },
                        { header: 'Summary', key: 'summary', width: 50 },
                    ],
                    rows,
                };
            }
            case 'employees': {
                if (!user.permissions.includes('employees.view.all') && !user.permissions.includes('employees.view.team')) {
                    throw ApiError.forbidden('You cannot export employee records.');
                }
                const rows = await query(`SELECT e.employee_code AS code, e.full_name AS employee, e.email, e.mobile, d.name AS department,
                  dg.title AS designation, r.name AS role, m.full_name AS manager, l.name AS location,
                  e.employment_type, e.status, e.joining_date
           FROM employees e
           JOIN roles r ON r.id = e.role_id
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN designations dg ON dg.id = e.designation_id
           LEFT JOIN employees m ON m.id = e.manager_id
           LEFT JOIN locations l ON l.id = e.location_id
           WHERE e.status NOT IN ('rejected','deleted') ${placeholders ? `AND e.id IN (${placeholders})` : ''}
           ORDER BY e.full_name`, placeholders ? teamIds : []);
                return {
                    title: 'Employee directory',
                    columns: [
                        { header: 'Employee ID', key: 'code', width: 14 },
                        { header: 'Name', key: 'employee', width: 26 },
                        { header: 'Email', key: 'email', width: 28 },
                        { header: 'Mobile', key: 'mobile', width: 16 },
                        { header: 'Department', key: 'department', width: 20 },
                        { header: 'Designation', key: 'designation', width: 24 },
                        { header: 'Role', key: 'role', width: 20 },
                        { header: 'Manager', key: 'manager', width: 22 },
                        { header: 'Location', key: 'location', width: 18 },
                        { header: 'Type', key: 'employment_type', width: 14 },
                        { header: 'Status', key: 'status', width: 16 },
                        { header: 'Joined', key: 'joining_date', width: 12 },
                    ],
                    rows,
                };
            }
            case 'collections': {
                const collectionStatus = ['pending', 'partial', 'collected', 'cancelled'].includes(filters.status ?? '')
                    ? filters.status
                    : null;
                const rows = await query(`SELECT c.reference_no AS reference, c.customer_name AS customer, c.invoice_no AS invoice,
                  e.full_name AS collector, e.employee_code AS code, d.name AS department, l.name AS location,
                  c.amount_due AS due_amount, c.amount_collected AS collected_amount,
                  (c.amount_due - c.amount_collected) AS outstanding, c.currency,
                  c.status, c.approval_status, c.payment_mode, c.due_date, c.collected_on
             FROM collections c
             JOIN employees e ON e.id = c.employee_id
             LEFT JOIN departments d ON d.id = c.department_id
             LEFT JOIN locations l ON l.id = c.location_id
            WHERE c.deleted_at IS NULL AND c.due_date BETWEEN ? AND ?
              ${placeholders ? `AND c.employee_id IN (${placeholders})` : ''}
              ${filters.employeeId ? 'AND c.employee_id = ?' : ''}
              ${filters.departmentId ? 'AND c.department_id = ?' : ''}
              ${filters.locationId ? 'AND c.location_id = ?' : ''}
              ${collectionStatus ? 'AND c.status = ?' : ''}
              ${filters.search ? 'AND (c.customer_name LIKE ? OR c.reference_no LIKE ? OR c.invoice_no LIKE ?)' : ''}
            ORDER BY c.due_date DESC, c.id DESC
            LIMIT 5000`, [
                    from,
                    to,
                    ...(teamIds ?? []),
                    ...(filters.employeeId ? [filters.employeeId] : []),
                    ...(filters.departmentId ? [filters.departmentId] : []),
                    ...(filters.locationId ? [filters.locationId] : []),
                    ...(collectionStatus ? [collectionStatus] : []),
                    ...(filters.search ? [`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`] : []),
                ]);
                return {
                    title: 'Collection register',
                    columns: [
                        { header: 'Reference', key: 'reference', width: 16 },
                        { header: 'Customer', key: 'customer', width: 24 },
                        { header: 'Invoice', key: 'invoice', width: 14 },
                        { header: 'Collector', key: 'collector', width: 20 },
                        { header: 'Code', key: 'code', width: 12 },
                        { header: 'Department', key: 'department', width: 16 },
                        { header: 'Location', key: 'location', width: 14 },
                        { header: 'Due', key: 'due_amount', width: 12 },
                        { header: 'Collected', key: 'collected_amount', width: 12 },
                        { header: 'Outstanding', key: 'outstanding', width: 12 },
                        { header: 'Currency', key: 'currency', width: 9 },
                        { header: 'Status', key: 'status', width: 11 },
                        { header: 'Approval', key: 'approval_status', width: 11 },
                        { header: 'Mode', key: 'payment_mode', width: 12 },
                        { header: 'Due date', key: 'due_date', width: 12 },
                        { header: 'Collected on', key: 'collected_on', width: 12 },
                    ],
                    rows,
                };
            }
            default:
                throw ApiError.badRequest('Unsupported export type');
        }
    }
    static async csv(type, user, filters) {
        const { columns, rows, title } = await ExportService.dataset(type, user, filters);
        const escape = (value) => {
            const text = value === null || value === undefined ? '' : String(value);
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const lines = [columns.map((c) => escape(c.header)).join(',')];
        for (const row of rows) {
            lines.push(columns.map((c) => escape(row[c.key])).join(','));
        }
        return { filename: `${type}-${today()}.csv`, mime: 'text/csv; charset=utf-8', buffer: Buffer.from(`${title}\n${lines.join('\n')}`, 'utf8') };
    }
    static async xlsx(type, user, filters) {
        const { columns, rows, title } = await ExportService.dataset(type, user, filters);
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Workforce';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet(type.slice(0, 28) || 'Report');
        sheet.mergeCells(1, 1, 1, columns.length);
        sheet.getCell(1, 1).value = title;
        sheet.getCell(1, 1).font = { bold: true, size: 14 };
        sheet.getRow(2).values = columns.map((c) => c.header);
        sheet.getRow(2).font = { bold: true };
        sheet.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
        columns.forEach((c, index) => {
            sheet.getColumn(index + 1).width = c.width ?? 18;
        });
        rows.forEach((row) => {
            sheet.addRow(columns.map((c) => (row[c.key] === null || row[c.key] === undefined ? '' : row[c.key])));
        });
        sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
        const buffer = await workbook.xlsx.writeBuffer();
        return {
            filename: `${type}-${today()}.xlsx`,
            mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: Buffer.from(buffer),
        };
    }
    static async pdf(type, user, filters) {
        const { columns, rows, title } = await ExportService.dataset(type, user, filters);
        const buffer = await new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
            const chunks = [];
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            doc.fontSize(16).fillColor('#1d4ed8').text('Workforce · Enterprise Workforce Management');
            doc.moveDown(0.2);
            doc.fontSize(12).fillColor('#111827').text(title);
            doc.moveDown(0.4);
            doc.fontSize(7).fillColor('#6b7280').text(`Generated ${new Date().toISOString()} · ${rows.length} record(s)`);
            doc.moveDown(0.6);
            const usable = doc.page.width - 56;
            const visibleColumns = columns.slice(0, 8);
            const colWidth = usable / visibleColumns.length;
            doc.fontSize(7).fillColor('#111827');
            let y = doc.y;
            visibleColumns.forEach((column, index) => {
                doc.text(column.header, 28 + index * colWidth, y, { width: colWidth - 4, ellipsis: true });
            });
            y += 12;
            doc.moveTo(28, y - 2).lineTo(doc.page.width - 28, y - 2).strokeColor('#e5e7eb').stroke();
            for (const row of rows) {
                if (y > doc.page.height - 50) {
                    doc.addPage();
                    y = 40;
                }
                visibleColumns.forEach((column, index) => {
                    const value = row[column.key];
                    doc.fillColor('#374151').text(value === null || value === undefined ? '' : String(value).slice(0, 60), 28 + index * colWidth, y, {
                        width: colWidth - 4,
                        ellipsis: true,
                    });
                });
                y += 11;
            }
            doc.end();
        });
        return { filename: `${type}-${today()}.pdf`, mime: 'application/pdf', buffer };
    }
    static async build(type, format, user, filters) {
        if (format === 'csv')
            return ExportService.csv(type, user, filters);
        if (format === 'xlsx')
            return ExportService.xlsx(type, user, filters);
        return ExportService.pdf(type, user, filters);
    }
    static defaultRange() {
        const to = today();
        return { from: addDays(to, -30), to };
    }
}
//# sourceMappingURL=ExportService.js.map