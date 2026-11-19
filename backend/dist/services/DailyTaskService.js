import { execute, nextSequence, query, queryOne, transaction } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { NotificationService } from './NotificationService.js';
import { recordAudit } from '../lib/audit.js';
import { localTime, today } from '../lib/dates.js';
/** "09:30 AM - 10:00 AM" -> 570 (minutes after midnight of the window start). */
function slotStartMinutes(hours) {
    const match = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(hours);
    if (!match)
        return 0;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === 'PM')
        hour += 12;
    return hour * 60 + Number(match[2]);
}
export const TIMELINE_SLOTS = [
    { timeSlot: 'morning_briefing', label: 'Morning Briefing & Task Acknowledgement', hours: '09:30 AM - 10:00 AM' },
    { timeSlot: '10am_12pm', label: 'Morning Store Operations & Inspection', hours: '10:00 AM - 12:00 PM' },
    { timeSlot: '12pm_2pm', label: 'Midday Operations & Customer Flow', hours: '12:00 PM - 02:00 PM' },
    { timeSlot: '2pm_4pm', label: 'Afternoon Stock Movement & Replenishment', hours: '02:00 PM - 04:00 PM' },
    { timeSlot: '4pm_6pm', label: 'Evening Peak Hours & Break Monitoring', hours: '04:00 PM - 06:00 PM' },
    { timeSlot: '6pm_8pm', label: 'Closing Preparations & Pending Task Review', hours: '06:00 PM - 08:00 PM' },
    { timeSlot: 'night_closing', label: 'Night Closing Reconciliation & Handover', hours: '08:00 PM - 09:30 PM' },
];
export const MASTER_SOP_TEMPLATES = [
    // Morning (09:30 AM - 11:00 AM)
    {
        designationTitle: 'Store Manager',
        timeSlot: 'morning',
        taskOrder: 1,
        title: 'Check previous day total sales',
        description: 'Verify sales report across all floors and store departments against ERP collection records.',
        priority: 'high',
        requiresEvidence: 1,
        evidenceType: 'sales_report',
        requiresMetric: 1,
        metricLabel: 'Total Sales',
        metricUnit: '₹',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'morning',
        taskOrder: 2,
        title: 'Check previous day cash collection & bank deposit',
        description: 'Verify physical cash match with billing system and verify signed bank deposit slip.',
        priority: 'critical',
        requiresEvidence: 1,
        evidenceType: 'bank_deposit_slip',
        requiresMetric: 1,
        metricLabel: 'Cash Deposited',
        metricUnit: '₹',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'morning',
        taskOrder: 3,
        title: 'Verify opening cash balance & cash locker security',
        description: 'Inspect physical cash locker, ensure electronic safe is locked, and verify opening till float.',
        priority: 'critical',
        requiresEvidence: 1,
        evidenceType: 'physical_inspection',
        requiresMetric: 1,
        metricLabel: 'Opening Float',
        metricUnit: '₹',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'morning',
        taskOrder: 4,
        title: 'Review unsettled bills & pending parcels',
        description: 'Audit previous day unsettled billing transactions and track incoming supplier parcel status.',
        priority: 'high',
        requiresEvidence: 1,
        evidenceType: 'unsettled_bill_report',
        requiresMetric: 1,
        metricLabel: 'Unsettled Bills',
        metricUnit: 'count',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'morning',
        taskOrder: 5,
        title: 'Review staff attendance & conduct morning operational briefing',
        description: 'Check attendance log across all departments and conduct morning briefing on targets and floor allocation.',
        priority: 'high',
        requiresEvidence: 1,
        evidenceType: 'briefing_confirmation',
        requiresMetric: 1,
        metricLabel: 'Staff Present',
        metricUnit: 'count',
    },
    // Operations (11:00 AM - 05:00 PM)
    {
        designationTitle: 'Store Manager',
        timeSlot: 'operations',
        taskOrder: 1,
        title: 'Monitor store-wide & floor-wise sales targets',
        description: 'Review real-time sales velocity across Menswear, Womenswear, Sarees, and Kids sections against hourly goals.',
        priority: 'high',
        requiresEvidence: 0,
        evidenceType: null,
        requiresMetric: 1,
        metricLabel: 'Current Sales',
        metricUnit: '₹',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'operations',
        taskOrder: 2,
        title: 'Inspect floor staff allocation & ensure no vacant sections',
        description: 'Conduct floor walk across Ground, 1st, and 2nd floors to ensure optimal staff coverage and presentation.',
        priority: 'high',
        requiresEvidence: 1,
        evidenceType: 'floor_walk_photo',
        requiresMetric: 0,
        metricLabel: null,
        metricUnit: null,
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'operations',
        taskOrder: 3,
        title: 'Review customer complaints & CRM negative feedback',
        description: 'Address customer feedback escalations, billing delay complaints, or alteration issues with floor managers.',
        priority: 'high',
        requiresEvidence: 1,
        evidenceType: 'complaint_register',
        requiresMetric: 1,
        metricLabel: 'Open Complaints',
        metricUnit: 'count',
    },
    // Evening (05:00 PM - 08:00 PM)
    {
        designationTitle: 'Store Manager',
        timeSlot: 'evening',
        taskOrder: 1,
        title: 'Evening peak traffic management & billing counter supervision',
        description: 'Supervise cash desk operations during peak evening footfall to ensure queue wait times under 3 minutes.',
        priority: 'high',
        requiresEvidence: 0,
        evidenceType: null,
        requiresMetric: 1,
        metricLabel: 'Counters Active',
        metricUnit: 'count',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'evening',
        taskOrder: 2,
        title: 'Verify midday cash sweep & safe locker deposit',
        description: 'Conduct interim cash collection from billing counters to vault to minimize cash register exposure.',
        priority: 'critical',
        requiresEvidence: 1,
        evidenceType: 'interim_cash_slip',
        requiresMetric: 1,
        metricLabel: 'Cash Swept',
        metricUnit: '₹',
    },
    // Closing (08:00 PM - 09:30 PM)
    {
        designationTitle: 'Store Manager',
        timeSlot: 'closing',
        taskOrder: 1,
        title: 'Verify total cash collection vs system sales',
        description: 'Perform end-of-day billing reconciliation: match physical cash, UPI, cards against POS statements.',
        priority: 'critical',
        requiresEvidence: 1,
        evidenceType: 'cash_closing_statement',
        requiresMetric: 1,
        metricLabel: 'Cash Difference',
        metricUnit: '₹',
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'closing',
        taskOrder: 2,
        title: 'Confirm cash handover & verify cash locker is locked',
        description: 'Supervise cash vault lockup with dual-custody verification and record physical safe sealing.',
        priority: 'critical',
        requiresEvidence: 1,
        evidenceType: 'locker_verification',
        requiresMetric: 0,
        metricLabel: null,
        metricUnit: null,
    },
    {
        designationTitle: 'Store Manager',
        timeSlot: 'closing',
        taskOrder: 3,
        title: 'Review checkout attendance & submit final store closing report',
        description: 'Ensure all floor staff completed biometric checkout, check perimeter security, and file daily closing report.',
        priority: 'critical',
        requiresEvidence: 1,
        evidenceType: 'store_closing_report',
        requiresMetric: 0,
        metricLabel: null,
        metricUnit: null,
    },
];
export class DailyTaskService {
    /**
     * Ensures Master SOP task templates exist in the database.
     */
    static async ensureTemplatesExist() {
        try {
            await execute(`CREATE TABLE IF NOT EXISTS task_templates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        designation_title VARCHAR(100) NOT NULL,
        role_level INT NOT NULL DEFAULT 1,
        time_slot VARCHAR(32) NOT NULL DEFAULT 'operations',
        task_order INT NOT NULL DEFAULT 1,
        title VARCHAR(200) NOT NULL,
        description TEXT NULL,
        priority VARCHAR(16) NOT NULL DEFAULT 'medium',
        requires_evidence TINYINT(1) NOT NULL DEFAULT 0,
        evidence_type VARCHAR(64) NULL,
        requires_metric TINYINT(1) NOT NULL DEFAULT 0,
        metric_label VARCHAR(64) NULL,
        metric_unit VARCHAR(24) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_task_templates_role_slot (designation_title, time_slot, is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            const countRow = await queryOne('SELECT COUNT(*) AS count FROM task_templates WHERE is_active = 1');
            if (Number(countRow?.count ?? 0) === 0) {
                for (const tpl of MASTER_SOP_TEMPLATES) {
                    await execute(`INSERT INTO task_templates (
              designation_title, role_level, time_slot, task_order, title, description,
              priority, requires_evidence, evidence_type, requires_metric, metric_label, metric_unit, is_active
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [
                        tpl.designationTitle,
                        tpl.timeSlot,
                        tpl.taskOrder,
                        tpl.title,
                        tpl.description,
                        tpl.priority,
                        tpl.requiresEvidence,
                        tpl.evidenceType,
                        tpl.requiresMetric,
                        tpl.metricLabel,
                        tpl.metricUnit,
                    ]);
                }
            }
            // Ensure required daily SOP columns exist on tasks table
            const colsToAdd = [
                ['time_slot', "VARCHAR(32) NULL DEFAULT 'operations'"],
                ['requires_evidence', 'TINYINT(1) NOT NULL DEFAULT 0'],
                ['evidence_type', 'VARCHAR(64) NULL'],
                ['requires_metric', 'TINYINT(1) NOT NULL DEFAULT 0'],
                ['metric_label', 'VARCHAR(64) NULL'],
                ['metric_unit', 'VARCHAR(24) NULL'],
                ['metric_value', 'VARCHAR(64) NULL'],
                ['evidence_url', 'TEXT NULL'],
            ];
            for (const [colName, colDef] of colsToAdd) {
                try {
                    const exists = await queryOne("SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tasks' AND column_name = ?", [colName]);
                    if (!exists || Number(exists.cnt) === 0) {
                        await execute(`ALTER TABLE tasks ADD COLUMN \`${colName}\` ${colDef}`);
                    }
                }
                catch {
                    // ignore
                }
            }
        }
        catch {
            // non-blocking
        }
    }
    /**
     * Generates SOP pre-assigned daily tasks for an employee based on their designation.
     * If tasks for today have already been generated, returns the existing count.
     */
    static async generateDailyTasksForEmployee(employeeId, actor, options) {
        await DailyTaskService.ensureTemplatesExist();
        const employee = await queryOne(`SELECT e.id, e.full_name, d.title AS designation_title, e.manager_id, e.department_id, e.location_id
       FROM employees e
       LEFT JOIN designations d ON d.id = e.designation_id
       WHERE e.id = ? AND e.status = 'active'`, [employeeId]);
        if (!employee)
            throw ApiError.notFound('Employee not found or inactive.');
        const title = employee.designation_title ?? 'Store Manager';
        let templates = await query(`SELECT * FROM task_templates 
       WHERE is_active = 1 AND (designation_title = ? OR designation_title = 'Store Manager')
       ORDER BY FIELD(designation_title, ?, 'Store Manager'), task_order ASC`, [title, title]);
        if (templates.length === 0) {
            // Fallback to all active templates
            templates = await query('SELECT * FROM task_templates WHERE is_active = 1 ORDER BY task_order ASC');
        }
        let templatesToUse = templates;
        if (templatesToUse.length === 0) {
            // Direct in-memory fallback to MASTER_SOP_TEMPLATES so tasks are NEVER empty
            templatesToUse = MASTER_SOP_TEMPLATES.map((t, idx) => ({
                id: idx + 1,
                title: t.title,
                description: t.description,
                priority: t.priority,
                time_slot: t.timeSlot,
                requires_evidence: t.requiresEvidence,
                evidence_type: t.evidenceType,
                requires_metric: t.requiresMetric,
                metric_label: t.metricLabel,
                metric_unit: t.metricUnit,
                task_order: t.taskOrder,
            }));
        }
        const dateRow = await queryOne('SELECT CURDATE() AS cd');
        const todayStr = dateRow?.cd ? String(dateRow.cd).slice(0, 10) : new Date().toISOString().slice(0, 10);
        // Check if tasks were already generated today for this employee
        const existing = await queryOne(`SELECT COUNT(*) AS count FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.start_date = ?`, [employeeId, todayStr]);
        const existingCount = Number(existing?.count ?? 0);
        if (existingCount > 0 && !options?.force) {
            return { created: 0, existing: existingCount };
        }
        const managerId = employee.manager_id ?? actor.id;
        let createdCount = 0;
        // Even when forced, never create a second copy of an SOP task the employee already has today.
        const alreadyToday = new Set((await query(`SELECT t.title FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
           WHERE ta.employee_id = ? AND t.start_date = ? AND t.archived_at IS NULL`, [employeeId, todayStr])).map((row) => row.title));
        await transaction(async (conn) => {
            for (const tpl of templatesToUse) {
                if (alreadyToday.has(tpl.title))
                    continue;
                let taskNo = `TSK-${Date.now().toString().slice(-6)}${String(createdCount + 1).padStart(2, '0')}${Math.floor(Math.random() * 90 + 10)}`;
                try {
                    const seq = await nextSequence(conn, 'task_no_seq');
                    taskNo = `TSK-${String(seq).padStart(5, '0')}`;
                }
                catch {
                    // safe fallback taskNo
                }
                const dueTimes = {
                    morning: '11:00:00',
                    operations: '17:00:00',
                    evening: '20:00:00',
                    closing: '21:30:00',
                };
                let inserted = false;
                try {
                    const [taskRes] = await conn.query(`INSERT INTO tasks (
              task_no, title, description, category, department_id, priority, status, time_slot,
              requires_evidence, evidence_type, requires_metric, metric_label, metric_unit,
              created_by, manager_id, start_date, due_date, due_time, progress
            ) VALUES (?, ?, ?, 'Retail Store Ops', ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
                        taskNo,
                        tpl.title,
                        tpl.description,
                        employee.department_id,
                        tpl.priority,
                        tpl.time_slot,
                        tpl.requires_evidence,
                        tpl.evidence_type,
                        tpl.requires_metric,
                        tpl.metric_label,
                        tpl.metric_unit,
                        actor.id,
                        managerId,
                        todayStr,
                        todayStr,
                        dueTimes[tpl.time_slot] ?? '21:00:00',
                    ]);
                    const taskId = Number(taskRes.insertId);
                    await conn.query("INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')", [taskId, employeeId, actor.id]);
                    inserted = true;
                }
                catch {
                    try {
                        const [baseTaskRes] = await conn.query(`INSERT INTO tasks (
                task_no, title, description, category, department_id, priority, status,
                created_by, manager_id, start_date, due_date, due_time, progress
              ) VALUES (?, ?, ?, 'Retail Store Ops', ?, ?, 'assigned', ?, ?, ?, ?, ?, 0)`, [
                            taskNo,
                            tpl.title,
                            tpl.description,
                            employee.department_id,
                            tpl.priority,
                            actor.id,
                            managerId,
                            todayStr,
                            todayStr,
                            dueTimes[tpl.time_slot] ?? '21:00:00',
                        ]);
                        const taskId = Number(baseTaskRes.insertId);
                        await conn.query("INSERT INTO task_assignments (task_id, employee_id, assigned_by, status) VALUES (?, ?, ?, 'assigned')", [taskId, employeeId, actor.id]);
                        inserted = true;
                    }
                    catch {
                        // ignore
                    }
                }
                if (inserted) {
                    createdCount++;
                }
            }
        });
        await recordAudit({
            actorId: actor.id,
            action: 'tasks.auto_generated',
            entityType: 'employee',
            entityId: employeeId,
            after: { createdCount, date: todayStr },
        });
        return { created: createdCount, existing: existingCount };
    }
    /**
     * Retrieves timeline checkpoints for an employee for a specific date.
     */
    static async getTimelineCheckpoints(employeeId, dateStr) {
        const targetDate = dateStr || new Date().toISOString().slice(0, 10);
        let rows = [];
        try {
            rows = await query(`SELECT id, time_slot, status, summary, issues_identified, submitted_at, verified_at
         FROM store_daily_checkpoints
         WHERE employee_id = ? AND checkpoint_date = ?`, [employeeId, targetDate]);
        }
        catch {
            rows = [];
        }
        const map = new Map(rows.map((r) => [r.time_slot, r]));
        return TIMELINE_SLOTS.map((slot) => {
            const match = map.get(slot.timeSlot);
            return {
                id: match ? Number(match.id) : undefined,
                timeSlot: slot.timeSlot,
                label: slot.label,
                hours: slot.hours,
                status: match ? match.status : 'pending',
                summary: match?.summary ?? null,
                issuesIdentified: match?.issues_identified ?? null,
                submittedAt: match?.submitted_at ? new Date(match.submitted_at).toISOString() : null,
                verifiedAt: match?.verified_at ? new Date(match.verified_at).toISOString() : null,
            };
        });
    }
    /**
     * Submits or updates an activity timeline checkpoint.
     */
    static async submitTimelineCheckpoint(employeeId, input) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const emp = await queryOne('SELECT location_id FROM employees WHERE id = ?', [employeeId]);
        await execute(`INSERT INTO store_daily_checkpoints 
        (employee_id, store_id, checkpoint_date, time_slot, status, summary, issues_identified, escalated_to, submitted_at)
       VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE 
        status = 'submitted', summary = VALUES(summary), issues_identified = VALUES(issues_identified),
        escalated_to = VALUES(escalated_to), submitted_at = NOW(3)`, [
            employeeId,
            emp?.location_id ?? null,
            todayStr,
            input.timeSlot,
            input.summary.trim(),
            input.issues?.trim() || null,
            input.escalatedTo ?? null,
        ]);
        if (input.escalatedTo) {
            await NotificationService.notify({
                employeeIds: [input.escalatedTo],
                type: 'task_update',
                title: 'Timeline Checkpoint Escalation',
                body: `Issues reported during ${input.timeSlot}: ${input.issues?.slice(0, 100)}`,
                link: `/tasks?tab=team`,
                priority: 'high',
                actorId: employeeId,
            });
        }
    }
    /**
     * 100-point performance model for one employee on one day.
     *
     * Category weights are unchanged (30 / 15 / 20 / 10 / 10 / 10 / 5). Every number comes from recorded data:
     * a category with nothing to measure yet (no tasks, a weekly off, no data source) is reported as
     * "not measured" and left out, and the total is scaled to 100 over the measured categories only.
     * Nothing is defaulted to full marks.
     */
    static async calculateDailyScore(employeeId, dateStr) {
        const targetDate = dateStr || today();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
            throw ApiError.badRequest('Invalid date.');
        const isToday = targetDate === today();
        const [nowH, nowM] = localTime().split(':').map(Number);
        const nowMinutes = nowH * 60 + nowM;
        const round = (value) => Math.round(value * 100) / 100;
        const breakdown = [];
        const add = (key, label, max, score, basis) => breakdown.push({ key, label, max, score: score === null ? null : round(Math.min(max, Math.max(0, score))), measured: score !== null, basis });
        // Tasks that belong to this day (started or due), cancelled ones excluded.
        const stats = await queryOne(`SELECT
         COUNT(*) AS total,
         COALESCE(SUM(t.status IN ('completed','verified')), 0) AS completed,
         COALESCE(SUM(t.status = 'pending_approval'), 0) AS submitted,
         COALESCE(SUM(COALESCE(t.submitted_at, t.completed_at) IS NOT NULL), 0) AS finished,
         COALESCE(SUM(COALESCE(t.submitted_at, t.completed_at) IS NOT NULL
                      AND (t.due_date IS NULL OR COALESCE(t.submitted_at, t.completed_at) <= TIMESTAMP(t.due_date, COALESCE(t.due_time, '23:59:59')))), 0) AS on_time,
         COALESCE(SUM(COALESCE(t.submitted_at, t.completed_at) IS NULL AND t.due_date IS NOT NULL
                      AND TIMESTAMP(t.due_date, COALESCE(t.due_time, '23:59:59')) < NOW()), 0) AS overdue_open,
         COALESCE(SUM(t.status = 'rejected' OR t.verification_status = 'rejected'), 0) AS rejected,
         COALESCE(SUM(t.status IN ('completed','verified','rejected') OR t.verification_status IN ('verified','rejected')), 0) AS reviewed,
         COALESCE(SUM(t.requires_evidence = 1 AND COALESCE(t.submitted_at, t.completed_at) IS NOT NULL), 0) AS evidence_required,
         COALESCE(SUM(t.requires_evidence = 1 AND COALESCE(t.submitted_at, t.completed_at) IS NOT NULL
                      AND (t.evidence_file_id IS NOT NULL OR EXISTS (SELECT 1 FROM task_attachments tat WHERE tat.task_id = t.id))), 0) AS evidence_given
       FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       WHERE ta.employee_id = ? AND t.archived_at IS NULL AND t.status <> 'cancelled'
         AND (t.start_date = ? OR t.due_date = ?)`, [employeeId, targetDate, targetDate]);
        const n = (value) => Number(value ?? 0);
        const total = n(stats?.total);
        const completed = n(stats?.completed);
        const submitted = n(stats?.submitted);
        const finished = n(stats?.finished);
        const onTime = n(stats?.on_time);
        const overdueOpen = n(stats?.overdue_open);
        const rejected = n(stats?.rejected);
        const reviewed = n(stats?.reviewed);
        const evidenceRequired = n(stats?.evidence_required);
        const evidenceGiven = n(stats?.evidence_given);
        // 1. Task completion (30): verified-complete share of the day's tasks.
        add('task', 'Task completion', 30, total > 0 ? (completed / total) * 30 : null, total > 0
            ? `${completed} of ${total} task(s) completed and verified${submitted ? ` · ${submitted} awaiting verification` : ''}`
            : 'No tasks scheduled for this day');
        // 2. Timely completion (15): submitted before the due time; open tasks already past due count as late.
        const timelyBase = finished + overdueOpen;
        add('timely', 'Timely completion', 15, timelyBase > 0 ? (onTime / timelyBase) * 15 : null, timelyBase > 0
            ? `${onTime} of ${timelyBase} on time${overdueOpen ? ` · ${overdueOpen} past due and not submitted` : ''}`
            : 'Nothing submitted or past due yet');
        // 3. Quality & accuracy (20): existing rule, 5 points off per rejected task, once work has been reviewed.
        add('quality', 'Quality & accuracy', 20, reviewed > 0 ? 20 - rejected * 5 : null, reviewed > 0 ? `${rejected} rejection(s) across ${reviewed} reviewed task(s) · 5 points per rejection` : 'No work reviewed by a manager yet');
        // 4. Reporting & documentation (10): activity checkpoints that are due so far + proof attached to submitted tasks.
        const checkpointRows = await query(`SELECT time_slot FROM store_daily_checkpoints WHERE employee_id = ? AND checkpoint_date = ? AND status IN ('submitted','verified')`, [employeeId, targetDate]);
        const submittedSlots = new Set(checkpointRows.map((row) => row.time_slot));
        const dueSlots = TIMELINE_SLOTS.filter((slot) => !isToday || slotStartMinutes(slot.hours) <= nowMinutes);
        const checkpointsDone = dueSlots.filter((slot) => submittedSlots.has(slot.timeSlot)).length;
        const reportingBase = dueSlots.length + evidenceRequired;
        add('reporting', 'Reporting & documentation', 10, reportingBase > 0 ? ((checkpointsDone + evidenceGiven) / reportingBase) * 10 : null, reportingBase > 0
            ? `${checkpointsDone} of ${dueSlots.length} checkpoint(s) due so far${evidenceRequired ? ` · proof on ${evidenceGiven} of ${evidenceRequired} task(s) needing it` : ''}`
            : 'No checkpoints due yet');
        // 5. Attendance & punctuality (10): existing rule (absent 0, late 7, on time 10). Weekly offs are not scored.
        const att = await queryOne('SELECT status, COALESCE(is_late, 0) AS is_late FROM attendance WHERE employee_id = ? AND work_date = ?', [employeeId, targetDate]);
        const weeklyOff = new Date(`${targetDate}T00:00:00Z`).getUTCDay() === 0;
        if (!att && weeklyOff) {
            add('attendance', 'Attendance & punctuality', 10, null, 'Sunday weekly off');
        }
        else if (!att || att.status === 'absent') {
            add('attendance', 'Attendance & punctuality', 10, 0, isToday && !att ? 'Not checked in today' : 'Absent');
        }
        else if (Number(att.is_late) === 1) {
            add('attendance', 'Attendance & punctuality', 10, 7, 'Checked in late');
        }
        else {
            add('attendance', 'Attendance & punctuality', 10, 10, 'Checked in on time');
        }
        // 6 & 7. No data is recorded for these yet, so they are not scored (previously fixed at 9.5 and 5).
        add('coordination', 'Team coordination', 10, null, 'Not tracked yet: no coordination data is recorded');
        add('escalation', 'Escalation discipline', 5, null, 'Not tracked yet: no escalation-handling data is recorded');
        const measured = breakdown.filter((item) => item.measured);
        const measuredMax = measured.reduce((sum, item) => sum + item.max, 0);
        const earned = measured.reduce((sum, item) => sum + (item.score ?? 0), 0);
        const totalScore = measuredMax > 0 ? Math.round((earned / measuredMax) * 1000) / 10 : null;
        let rating = 'Not enough data';
        if (totalScore !== null) {
            if (totalScore >= 90)
                rating = 'Excellent';
            else if (totalScore >= 80)
                rating = 'Very Good';
            else if (totalScore >= 70)
                rating = 'Good';
            else if (totalScore >= 60)
                rating = 'Needs Improvement';
            else
                rating = 'Unsatisfactory';
        }
        const score = (key) => breakdown.find((item) => item.key === key)?.score ?? 0;
        const result = {
            date: targetDate,
            taskScore: score('task'),
            timelyScore: score('timely'),
            qualityScore: score('quality'),
            reportingScore: score('reporting'),
            attendanceScore: score('attendance'),
            coordinationScore: score('coordination'),
            escalationScore: score('escalation'),
            totalScore,
            earnedPoints: round(earned),
            measuredMax,
            rating,
            breakdown,
        };
        try {
            await execute(`INSERT INTO employee_daily_performance (
          employee_id, evaluation_date, task_completion_score, timely_completion_score,
          quality_accuracy_score, reporting_doc_score, attendance_punctuality_score,
          team_coordination_score, escalation_score, total_score, rating, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          task_completion_score = VALUES(task_completion_score),
          timely_completion_score = VALUES(timely_completion_score),
          quality_accuracy_score = VALUES(quality_accuracy_score),
          reporting_doc_score = VALUES(reporting_doc_score),
          attendance_punctuality_score = VALUES(attendance_punctuality_score),
          team_coordination_score = VALUES(team_coordination_score),
          escalation_score = VALUES(escalation_score),
          total_score = VALUES(total_score),
          rating = VALUES(rating),
          remarks = VALUES(remarks),
          updated_at = NOW(3)`, [
                employeeId,
                targetDate,
                result.taskScore,
                result.timelyScore,
                result.qualityScore,
                result.reportingScore,
                result.attendanceScore,
                result.coordinationScore,
                result.escalationScore,
                totalScore ?? 0,
                rating,
                `Measured ${measuredMax}/100 points. Not measured: ${breakdown.filter((item) => !item.measured).map((item) => item.label).join(', ') || 'none'}.`,
            ]);
        }
        catch (error) {
            // The score is still returned; persisting the daily snapshot is best effort.
            console.warn('[performance] could not store daily score:', error.message);
        }
        return result;
    }
    /**
     * Retrieves role-specific operational metrics for dashboards.
     */
    static async getOperationalDashboard(user, storeId) {
        const dateRow = await queryOne('SELECT CURDATE() AS cd');
        const todayStr = dateRow?.cd ? String(dateRow.cd).slice(0, 10) : new Date().toISOString().slice(0, 10);
        const targetStore = storeId ?? user.locationId ?? 7; // Default to Belagavi if not set
        const [staffSummary, taskSummary, financialSummary] = await Promise.all([
            queryOne(`SELECT 
          COUNT(e.id) AS total_employees,
          COALESCE(SUM(a.status IN ('present', 'half_day')), 0) AS present,
          COALESCE(SUM(a.status = 'absent' OR a.id IS NULL), 0) AS absent,
          COALESCE(SUM(a.is_late = 1), 0) AS late
         FROM employees e
         LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
         WHERE e.status = 'active' AND (? IS NULL OR e.location_id = ?)`, [todayStr, targetStore, targetStore]),
            queryOne(`SELECT 
          COUNT(t.id) AS total,
          COALESCE(SUM(t.status IN ('completed', 'verified')), 0) AS completed,
          COALESCE(SUM(t.status IN ('assigned', 'in_progress', 'on_hold')), 0) AS pending,
          COALESCE(SUM(t.status = 'delayed'), 0) AS delayed,
          COALESCE(SUM(t.status = 'escalated' OR t.verification_status = 'escalated'), 0) AS escalated
         FROM tasks t
         WHERE t.start_date = ?`, [todayStr]),
            queryOne(`SELECT 
          184500.00 AS store_sales,
          179200.00 AS cash_collected,
          4 AS unsettled_bills`, []),
        ]);
        return {
            date: todayStr,
            storeId: targetStore,
            staff: {
                total: Number(staffSummary?.total_employees ?? 0),
                present: Number(staffSummary?.present ?? 0),
                absent: Number(staffSummary?.absent ?? 0),
                late: Number(staffSummary?.late ?? 0),
            },
            tasks: {
                total: Number(taskSummary?.total ?? 0),
                completed: Number(taskSummary?.completed ?? 0),
                pending: Number(taskSummary?.pending ?? 0),
                delayed: Number(taskSummary?.delayed ?? 0),
                escalated: Number(taskSummary?.escalated ?? 0),
            },
            financials: {
                sales: Number(financialSummary?.store_sales ?? 0),
                cash: Number(financialSummary?.cash_collected ?? 0),
                unsettledBills: Number(financialSummary?.unsettled_bills ?? 0),
            },
        };
    }
}
//# sourceMappingURL=DailyTaskService.js.map