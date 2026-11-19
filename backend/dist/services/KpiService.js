import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { endOfMonth, periodRange, previousPeriod, toIso } from '../lib/dates.js';
import { isWeeklyOff, sundaysBetween } from '../lib/calendar.js';
import { ApiError } from '../lib/http.js';
import { assertEmployeeAccess, locationEmployeeClause, subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
/** MySQL JSON columns are returned parsed by mysql2, while legacy rows may be strings. */
function parseStored(value) {
    if (typeof value === 'string')
        return JSON.parse(value);
    return value;
}
const DEFAULT_PARAMETERS = [
    { key: 'task_completion', label: 'Task Completion', weight: 25, source: 'tasks', description: 'Completed tasks divided by tasks assigned in the period.' },
    { key: 'work_quality', label: 'Work Quality', weight: 20, source: 'tasks+reviews', description: 'First-pass approvals blended with manager review ratings.' },
    { key: 'attendance', label: 'Attendance', weight: 15, source: 'attendance', description: 'Present days against working days in the period.' },
    { key: 'timely_delivery', label: 'Timely Delivery', weight: 15, source: 'tasks', description: 'Tasks completed on or before their due date.' },
    { key: 'productivity', label: 'Productivity', weight: 10, source: 'tasks', description: 'Estimated effort versus time actually logged.' },
    { key: 'collaboration', label: 'Team Collaboration', weight: 10, source: 'chat+meetings', description: 'Internal collaboration signals: discussions, meetings and comments.' },
    { key: 'reporting_discipline', label: 'Reporting Discipline', weight: 5, source: 'daily_reports', description: 'Daily reports submitted against working days.' },
];
function categoryFor(score) {
    if (score >= 90)
        return 'Excellent';
    if (score >= 80)
        return 'Very Good';
    if (score >= 70)
        return 'Good';
    if (score >= 60)
        return 'Needs Improvement';
    return 'Unsatisfactory';
}
export class KpiService {
    static async parameters(templateId) {
        const template = templateId
            ? await queryOne('SELECT id, name, department_id FROM kpi_templates WHERE id = ?', [templateId])
            : await queryOne('SELECT id, name, department_id FROM kpi_templates WHERE is_active = 1 AND department_id IS NULL ORDER BY id LIMIT 1');
        if (!template)
            throw new ApiError(500, 'No KPI template configured');
        const params = await query('SELECT param_key, label, weight, description, data_source FROM kpi_parameters WHERE template_id = ? ORDER BY position, id', [template.id]);
        return {
            templateId: Number(template.id),
            templateName: template.name,
            parameters: params.map((p) => ({
                key: p.param_key,
                label: p.label,
                weight: Number(p.weight),
                description: p.description,
                dataSource: p.data_source,
            })),
        };
    }
    static async ensureTemplate() {
        const existing = await queryOne("SELECT id FROM kpi_templates WHERE name = 'Standard Monthly KPI' LIMIT 1");
        if (existing)
            return Number(existing.id);
        const result = await execute("INSERT INTO kpi_templates (name) VALUES ('Standard Monthly KPI')");
        let position = 0;
        for (const param of DEFAULT_PARAMETERS) {
            await execute('INSERT INTO kpi_parameters (template_id, param_key, label, weight, description, data_source, position) VALUES (?, ?, ?, ?, ?, ?, ?)', [result.insertId, param.key, param.label, param.weight, param.description, param.source, position]);
            position += 1;
        }
        return result.insertId;
    }
    static async workingDays(period, employeeId) {
        const { start, end } = periodRange(period);
        // Saturdays are working days; Sundays are the weekly off, counted from the real calendar
        // (a month can have 4 or 5). A holiday that falls on a Sunday is not subtracted twice.
        const holidayRows = await query(`SELECT DISTINCT h.holiday_date FROM holidays h WHERE h.holiday_date BETWEEN ? AND ?
         AND (h.location_id IS NULL OR h.location_id = (SELECT location_id FROM employees WHERE id = ?))`, [start, end, employeeId]);
        const days = new Date(`${end}T00:00:00Z`).getUTCDate();
        const sundays = sundaysBetween(start, end).length;
        const weekdayHolidays = holidayRows.filter((row) => !isWeeklyOff(String(row.holiday_date).slice(0, 10))).length;
        return Math.max(1, days - sundays - weekdayHolidays);
    }
    /** Computes the raw, explainable metrics used for each parameter. */
    static async computeMetrics(employeeId, period) {
        const { start, end } = periodRange(period);
        const [taskRow, reportRow, attendanceRow, collabRow, reviewRow, workingDays, projectRow] = await Promise.all([
            queryOne(`SELECT COUNT(*) AS assigned,
                SUM(t.status = 'completed') AS completed,
                SUM(t.status = 'completed' AND (t.due_date IS NULL OR DATE(t.completed_at) <= t.due_date)) AS on_time,
                SUM(t.status = 'completed' AND t.approved_at IS NOT NULL) AS approved,
                COALESCE(SUM(t.estimated_minutes), 0) AS estimated,
                COALESCE(SUM(ta.time_spent_minutes), 0) AS logged
         FROM task_assignments ta
         JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND t.archived_at IS NULL
           AND (t.created_at BETWEEN ? AND ? OR t.completed_at BETWEEN ? AND ?)`, [employeeId, `${start} 00:00:00`, `${end} 23:59:59`, `${start} 00:00:00`, `${end} 23:59:59`]),
            queryOne(`SELECT COUNT(*) AS submitted, SUM(status = 'approved') AS approved
         FROM daily_work_reports WHERE employee_id = ? AND report_date BETWEEN ? AND ?`, [employeeId, start, end]),
            queryOne(`SELECT SUM(status IN ('present','late','half_day')) AS present, SUM(is_late) AS late,
                COALESCE(SUM(total_minutes),0) AS minutes, SUM(status = 'on_leave') AS leave_days
         FROM attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ?`, [employeeId, start, end]),
            queryOne(`SELECT
          (SELECT COUNT(*) FROM messages m WHERE m.sender_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted_at IS NULL) AS messages,
          (SELECT COUNT(*) FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
             WHERE tc.author_id = ? AND tc.created_at BETWEEN ? AND ?) AS comments,
          (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.employee_id = ? AND mp.attended = 1
             AND mp.joined_at BETWEEN ? AND ?) AS meetings`, [employeeId, `${start} 00:00:00`, `${end} 23:59:59`, employeeId, `${start} 00:00:00`, `${end} 23:59:59`, employeeId, `${start} 00:00:00`, `${end} 23:59:59`]),
            queryOne('SELECT AVG(rating) AS rating, COUNT(*) AS comments FROM manager_reviews WHERE employee_id = ? AND period = ?', [employeeId, period]),
            KpiService.workingDays(period, employeeId),
            queryOne(`SELECT COUNT(*) AS completed FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
         WHERE ta.employee_id = ? AND t.project_id IS NOT NULL AND t.status = 'completed' AND t.completed_at BETWEEN ? AND ?`, [employeeId, `${start} 00:00:00`, `${end} 23:59:59`]),
        ]);
        const assigned = Number(taskRow?.assigned ?? 0);
        const completed = Number(taskRow?.completed ?? 0);
        const onTime = Number(taskRow?.on_time ?? 0);
        const approved = Number(taskRow?.approved ?? 0);
        const estimated = Number(taskRow?.estimated ?? 0);
        const logged = Number(taskRow?.logged ?? 0);
        const present = Number(attendanceRow?.present ?? 0);
        const late = Number(attendanceRow?.late ?? 0);
        const submittedReports = Number(reportRow?.submitted ?? 0);
        const messages = Number(collabRow?.messages ?? 0);
        const comments = Number(collabRow?.comments ?? 0);
        const meetings = Number(collabRow?.meetings ?? 0);
        const reviewRating = reviewRow?.rating === null || reviewRow?.rating === undefined ? null : Number(reviewRow.rating);
        const managerReviewCount = Number(reviewRow?.comments ?? 0);
        const scores = [];
        const push = (key, label, weight, score, note) => {
            scores.push({
                key,
                label,
                weight,
                score: score === null ? null : Math.max(0, Math.min(100, Math.round(score * 10) / 10)),
                weighted: 0,
                available: score !== null,
                note,
            });
        };
        push('task_completion', 'Task Completion', 25, assigned > 0 ? (completed / assigned) * 100 : null, assigned > 0 ? `${completed} of ${assigned} tasks completed` : 'No tasks were assigned in this period');
        const qualityParts = [];
        if (completed > 0)
            qualityParts.push((approved / completed) * 100);
        if (reviewRating !== null)
            qualityParts.push((reviewRating / 5) * 100);
        push('work_quality', 'Work Quality', 20, qualityParts.length > 0 ? qualityParts.reduce((a, b) => a + b, 0) / qualityParts.length : null, qualityParts.length > 0
            ? `Approval rate ${completed > 0 ? Math.round((approved / completed) * 100) : 0}%${reviewRating !== null ? `, manager rating ${reviewRating.toFixed(1)}/5` : ''}`
            : 'No completed work or manager review available');
        push('attendance', 'Attendance', 15, workingDays > 0 ? Math.min(100, (present / workingDays) * 100) : null, `${present} present day(s) of ${workingDays} working day(s)`);
        push('timely_delivery', 'Timely Delivery', 15, completed > 0 ? (onTime / completed) * 100 : null, completed > 0 ? `${onTime} of ${completed} completed on time` : 'No completed tasks to measure');
        push('productivity', 'Productivity', 10, estimated > 0 && logged > 0 ? Math.min(100, (estimated / logged) * 100) : null, estimated > 0 && logged > 0 ? `${Math.round(logged / 60)}h logged against ${Math.round(estimated / 60)}h estimated` : 'No effort estimates with logged time');
        const collabScore = Math.min(100, comments * 6 + meetings * 15 + Math.min(30, messages * 0.5));
        push('collaboration', 'Team Collaboration', 10, comments + meetings + messages > 0 ? collabScore : null, comments + meetings + messages > 0
            ? `${comments} task comments, ${meetings} meetings attended, ${messages} messages`
            : 'No collaboration signals recorded');
        push('reporting_discipline', 'Reporting Discipline', 5, workingDays > 0 ? Math.min(100, (submittedReports / workingDays) * 100) : null, `${submittedReports} report(s) submitted for ${workingDays} working day(s)`);
        // Parameters without data are excluded and their weight is redistributed
        // proportionally, so missing data never counts as poor performance.
        const available = scores.filter((s) => s.available);
        const availableWeight = available.reduce((sum, s) => sum + s.weight, 0);
        let total = 0;
        for (const score of scores) {
            if (!score.available) {
                score.weighted = 0;
                continue;
            }
            const normalisedWeight = availableWeight > 0 ? (score.weight / availableWeight) * 100 : 0;
            score.weighted = Math.round((score.score * normalisedWeight) / 100 * 10) / 10;
            total += score.weighted;
        }
        total = Math.round(Math.min(100, total) * 10) / 10;
        return {
            period,
            workingDays,
            metrics: {
                tasksAssigned: assigned,
                tasksCompleted: completed,
                tasksOnTime: onTime,
                tasksApproved: approved,
                estimatedMinutes: estimated,
                loggedMinutes: logged,
                presentDays: present,
                lateDays: late,
                leaveDays: Number(attendanceRow?.leave_days ?? 0),
                reportsSubmitted: submittedReports,
                reportsApproved: Number(reportRow?.approved ?? 0),
                messages,
                taskComments: comments,
                meetingsAttended: meetings,
                managerRating: reviewRating,
                managerReviewCount,
                projectTasksCompleted: Number(projectRow?.completed ?? 0),
                attendancePercent: workingDays > 0 ? Math.round((present / workingDays) * 100) : 0,
                punctualityPercent: present > 0 ? Math.round(((present - late) / present) * 100) : 0,
            },
            scores,
            total,
            category: categoryFor(total),
            excluded: scores.filter((s) => !s.available).map((s) => s.key),
        };
    }
    static async generate(period, actor, employeeIds) {
        if (!actor.permissions.includes('kpi.configure') && !actor.permissions.includes('kpi.publish') && !actor.permissions.includes('kpi.review')) {
            throw ApiError.forbidden('You cannot generate KPI evaluations.');
        }
        const templateId = await KpiService.ensureTemplate();
        let targets;
        if (employeeIds?.length) {
            targets = employeeIds;
        }
        else {
            const rows = await query("SELECT id FROM employees WHERE status = 'active'");
            targets = rows.map((r) => Number(r.id));
        }
        let generated = 0;
        for (const employeeId of targets) {
            const result = await KpiService.computeMetrics(employeeId, period);
            const existing = await queryOne('SELECT id, status FROM employee_kpi_records WHERE employee_id = ? AND period = ?', [employeeId, period]);
            if (existing?.status === 'published')
                continue;
            await execute(`INSERT INTO employee_kpi_records (employee_id, template_id, period, scores, metrics, total_score, category, status, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', NOW(3))
         ON DUPLICATE KEY UPDATE scores = VALUES(scores), metrics = VALUES(metrics), total_score = VALUES(total_score),
           category = VALUES(category), computed_at = NOW(3)`, [
                employeeId,
                templateId,
                period,
                JSON.stringify(result.scores),
                JSON.stringify({ ...result.metrics, workingDays: result.workingDays, excluded: result.excluded }),
                result.total,
                result.category,
            ]);
            generated += 1;
        }
        await recordAudit({
            actorId: actor.id,
            action: 'kpi.generated',
            entityType: 'kpi_period',
            entityId: null,
            after: { period, generated },
        });
        return { period, generated };
    }
    static async list(actor, filters) {
        const clauses = ['1 = 1'];
        const params = [];
        const wantsAll = filters.scope === 'all' && actor.permissions.includes('kpi.view.all');
        const wantsTeam = filters.scope === 'team' && (actor.permissions.includes('kpi.view.team') || actor.permissions.includes('kpi.view.all'));
        if (filters.employeeId) {
            await assertEmployeeAccess(actor, filters.employeeId, 'kpi');
            clauses.push('k.employee_id = ?');
            params.push(filters.employeeId);
        }
        else if (wantsAll) {
            const location = await locationEmployeeClause(actor, 'k.employee_id');
            clauses.push(location.clause);
            params.push(...location.params);
        }
        else if (wantsTeam) {
            const ids = await subtreeIds(actor.id);
            if (ids.length === 0)
                return { items: [] };
            clauses.push(`k.employee_id IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        }
        else {
            clauses.push('k.employee_id = ?');
            params.push(actor.id);
        }
        if (filters.period) {
            clauses.push('k.period = ?');
            params.push(filters.period);
        }
        else {
            clauses.push("k.period = (SELECT MAX(period) FROM employee_kpi_records)");
        }
        const rows = await query(`SELECT k.id, k.employee_id, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title,
              k.period, k.total_score, k.category, k.status, k.computed_at, k.published_at, k.manager_comment, k.strengths, k.improvements
       FROM employee_kpi_records k
       JOIN employees e ON e.id = k.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY k.total_score DESC`, params);
        return {
            items: rows.map((r) => ({
                id: Number(r.id),
                employeeId: Number(r.employee_id),
                employeeName: r.full_name,
                employeeCode: r.employee_code,
                departmentName: r.department_name,
                designationTitle: r.designation_title,
                period: r.period,
                totalScore: Number(r.total_score),
                category: r.category,
                status: r.status,
                computedAt: toIso(r.computed_at),
                publishedAt: toIso(r.published_at),
                managerComment: r.manager_comment,
                strengths: r.strengths,
                improvements: r.improvements,
            })),
        };
    }
    static async detail(recordId, actor) {
        const row = await queryOne(`SELECT k.*, e.full_name, e.employee_code, d.name AS department_name, dg.title AS designation_title, t.name AS template_name
       FROM employee_kpi_records k
       JOIN employees e ON e.id = k.employee_id
       JOIN kpi_templates t ON t.id = k.template_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE k.id = ?`, [recordId]);
        if (!row)
            throw ApiError.notFound('KPI record not found');
        const isSelf = Number(row.employee_id) === actor.id;
        if (!isSelf) {
            const canView = actor.permissions.includes('kpi.view.all') || actor.permissions.includes('kpi.view.team');
            if (!canView)
                throw ApiError.forbidden('You cannot view this KPI record.');
            if (actor.permissions.includes('kpi.view.team') && !actor.permissions.includes('kpi.view.all')) {
                const ids = await subtreeIds(actor.id);
                if (!ids.includes(Number(row.employee_id)))
                    throw ApiError.forbidden('This employee is outside your team.');
            }
        }
        if (!isSelf && row.status !== 'published' && !actor.permissions.includes('kpi.review')) {
            throw ApiError.forbidden('This evaluation is not published yet.');
        }
        return {
            id: Number(row.id),
            employeeId: Number(row.employee_id),
            employeeName: row.full_name,
            employeeCode: row.employee_code,
            departmentName: row.department_name,
            designationTitle: row.designation_title,
            period: row.period,
            templateName: row.template_name,
            scores: parseStored(row.scores),
            metrics: parseStored(row.metrics),
            totalScore: Number(row.total_score),
            category: row.category,
            status: row.status,
            strengths: row.strengths,
            improvements: row.improvements,
            managerComment: row.manager_comment,
            employeeComment: row.employee_comment,
            computedAt: toIso(row.computed_at),
            reviewedAt: toIso(row.reviewed_at),
            publishedAt: toIso(row.published_at),
        };
    }
    static async review(recordId, actor, input) {
        if (!actor.permissions.includes('kpi.review'))
            throw ApiError.forbidden('You cannot review KPI evaluations.');
        const record = await queryOne('SELECT employee_id, period, scores, status, total_score FROM employee_kpi_records WHERE id = ?', [recordId]);
        if (!record)
            throw ApiError.notFound('KPI record not found');
        if (record.status === 'published')
            throw ApiError.conflict('Published evaluations cannot be edited.');
        const scores = parseStored(record.scores);
        if (input.scores) {
            for (const override of input.scores) {
                const target = scores.find((s) => s.key === override.key);
                if (target) {
                    target.score = Math.max(0, Math.min(100, override.score));
                    target.available = true;
                    target.note = `${target.note} (manager adjusted)`;
                }
            }
        }
        const available = scores.filter((s) => s.available);
        const availableWeight = available.reduce((sum, s) => sum + s.weight, 0);
        let total = 0;
        for (const score of scores) {
            if (!score.available) {
                score.weighted = 0;
                continue;
            }
            const normalised = availableWeight > 0 ? (score.weight / availableWeight) * 100 : 0;
            score.weighted = Math.round(((score.score ?? 0) * normalised) / 100 * 10) / 10;
            total += score.weighted;
        }
        total = Math.round(Math.min(100, total) * 10) / 10;
        await execute(`UPDATE employee_kpi_records SET scores = ?, total_score = ?, category = ?, strengths = COALESCE(?, strengths),
              improvements = COALESCE(?, improvements), manager_comment = COALESCE(?, manager_comment),
              status = 'review', reviewed_by = ?, reviewed_at = NOW(3)
       WHERE id = ?`, [
            JSON.stringify(scores),
            total,
            categoryFor(total),
            input.strengths ?? null,
            input.improvements ?? null,
            input.managerComment ?? null,
            actor.id,
            recordId,
        ]);
        await recordAudit({
            actorId: actor.id,
            action: 'kpi.reviewed',
            entityType: 'employee_kpi_record',
            entityId: recordId,
            before: { totalScore: Number(record.total_score) },
            after: { totalScore: total, scores: input.scores },
        });
    }
    static async publish(period, actor) {
        if (!actor.permissions.includes('kpi.publish'))
            throw ApiError.forbidden('You cannot publish KPI results.');
        const records = await query(`SELECT k.id, k.employee_id, e.full_name, k.total_score FROM employee_kpi_records k
       JOIN employees e ON e.id = k.employee_id
       WHERE k.period = ? AND k.status <> 'published'`, [period]);
        if (records.length === 0)
            throw ApiError.badRequest('No unpublished KPI records for this period.');
        await execute("UPDATE employee_kpi_records SET status = 'published', published_at = NOW(3) WHERE period = ? AND status <> 'published'", [period]);
        await NotificationService.notify({
            employeeIds: records.map((r) => Number(r.employee_id)),
            type: 'kpi_published',
            title: `KPI results published · ${period}`,
            body: 'Your monthly performance evaluation is now available.',
            link: '/kpi',
            priority: 'high',
            actorId: actor.id,
        });
        await recordAudit({
            actorId: actor.id,
            action: 'kpi.published',
            entityType: 'kpi_period',
            entityId: null,
            after: { period, count: records.length },
        });
        return { period, published: records.length };
    }
    static async employeeComment(recordId, employeeId, comment) {
        const record = await queryOne('SELECT employee_id, status FROM employee_kpi_records WHERE id = ?', [recordId]);
        if (!record)
            throw ApiError.notFound('KPI record not found');
        if (Number(record.employee_id) !== employeeId)
            throw ApiError.forbidden('You can only comment on your own evaluation.');
        if (record.status !== 'published')
            throw ApiError.badRequest('You can comment once results are published.');
        await execute('UPDATE employee_kpi_records SET employee_comment = ? WHERE id = ?', [comment.slice(0, 2000), recordId]);
    }
    static async history(employeeId) {
        const rows = await query('SELECT period, total_score, category, status FROM employee_kpi_records WHERE employee_id = ? ORDER BY period DESC LIMIT 12', [employeeId]);
        return rows
            .map((r) => ({ period: r.period, score: Number(r.total_score), category: r.category, status: r.status }))
            .reverse();
    }
    static async teamComparison(actor, period) {
        const ids = await subtreeIds(actor.id);
        if (ids.length === 0)
            return [];
        const rows = await query(`SELECT k.employee_id, e.full_name, d.name AS department_name, k.total_score, k.category
       FROM employee_kpi_records k
       JOIN employees e ON e.id = k.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE k.period = ? AND k.employee_id IN (${ids.map(() => '?').join(',')})
       ORDER BY k.total_score DESC`, [period, ...ids]);
        return rows.map((r) => ({
            employeeId: Number(r.employee_id),
            employeeName: r.full_name,
            departmentName: r.department_name,
            score: Number(r.total_score),
            category: r.category,
        }));
    }
    static async departmentAverages(period) {
        const rows = await query(`SELECT COALESCE(d.name, 'Unassigned') AS department_name, AVG(k.total_score) AS avg_score, COUNT(*) AS employees
       FROM employee_kpi_records k
       JOIN employees e ON e.id = k.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE k.period = ? GROUP BY d.name ORDER BY avg_score DESC`, [period]);
        return rows.map((r) => ({ department: r.department_name, averageScore: Math.round(Number(r.avg_score) * 10) / 10, employees: Number(r.employees) }));
    }
    static async trendFor(employeeId) {
        const rows = await query('SELECT period, total_score FROM employee_kpi_records WHERE employee_id = ? ORDER BY period DESC LIMIT 6', [employeeId]);
        return rows.map((r) => ({ period: r.period, score: Number(r.total_score) })).reverse();
    }
    static async previousScore(employeeId, period) {
        const prev = previousPeriod(period);
        const row = await queryOne('SELECT total_score, category FROM employee_kpi_records WHERE employee_id = ? AND period = ?', [employeeId, prev]);
        return row ? { period: prev, score: Number(row.total_score), category: row.category } : null;
    }
    static async updateWeights(actor, templateId, weights) {
        if (!actor.permissions.includes('kpi.configure'))
            throw ApiError.forbidden('You cannot configure KPI weights.');
        const total = weights.reduce((sum, w) => sum + w.weight, 0);
        if (Math.abs(total - 100) > 0.01)
            throw ApiError.badRequest(`Weights must total 100%. Current total: ${total}%.`);
        await transaction(async (conn) => {
            for (const weight of weights) {
                await conn.query('UPDATE kpi_parameters SET weight = ? WHERE template_id = ? AND param_key = ?', [weight.weight, templateId, weight.key]);
            }
        });
        await recordAudit({
            actorId: actor.id,
            action: 'kpi.weights_updated',
            entityType: 'kpi_template',
            entityId: templateId,
            after: { weights },
        });
    }
    static async monthlyReminder() {
        const templateId = await KpiService.ensureTemplate();
        void templateId;
        const publicationDay = Number((await queryOne("SELECT setting_value FROM system_settings WHERE setting_key = 'kpi_publish_day'"))?.setting_value ?? 3);
        const now = new Date();
        if (now.getUTCDate() !== publicationDay)
            return;
        const period = now.toISOString().slice(0, 7);
        const admins = await query(`SELECT DISTINCT e.id FROM employees e
       JOIN role_permissions rp ON rp.role_id = e.role_id
       JOIN permissions p ON p.id = rp.permission_id AND p.code = 'kpi.publish'
       WHERE e.status = 'active'`);
        if (admins.length > 0) {
            await NotificationService.notify({
                employeeIds: admins.map((a) => Number(a.id)),
                type: 'kpi',
                title: 'Monthly KPI review due',
                body: `Generate and review KPI evaluations for ${period}.`,
                link: '/kpi?tab=all',
                dedupeKey: `kpi_reminder:${period}`,
            });
        }
        // Ensure next month's period string is bounded
        void endOfMonth(`${period}-01`);
    }
}
//# sourceMappingURL=KpiService.js.map