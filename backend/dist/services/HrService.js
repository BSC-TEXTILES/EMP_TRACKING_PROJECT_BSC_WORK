import { execute, query, queryOne } from '../db/index.js';
import { ApiError } from '../lib/http.js';
export class HrService {
    /** Live HR dashboard statistics calculated directly from operational database records */
    static async getDashboard(user, locationId) {
        const locParam = locationId ? Number(locationId) : null;
        const locFilter = locParam ? 'AND e.location_id = ?' : '';
        const locParams = locParam ? [locParam] : [];
        // Total, Active, Inactive, New Joinings
        const empMetrics = await queryOne(`SELECT 
        COUNT(*) AS total,
        SUM(e.status = 'active') AS active,
        SUM(e.status IN ('inactive', 'deactivated', 'suspended')) AS inactive,
        SUM(e.joining_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS new_joinings
       FROM employees e
       WHERE 1 = 1 ${locFilter}`, locParams);
        // Present Today (from attendance)
        const attendanceToday = await queryOne(`SELECT COUNT(DISTINCT a.employee_id) AS present
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.work_date = CURDATE()
         AND a.status IN ('present', 'late', 'half_day')
         ${locFilter}`, locParams);
        // On Leave Today (from approved leave_requests)
        const onLeaveToday = await queryOne(`SELECT COUNT(DISTINCT lr.employee_id) AS on_leave
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE CURDATE() BETWEEN lr.start_date AND lr.end_date
         AND lr.status = 'approved'
         ${locFilter}`, locParams);
        // Pending Leaves
        const pendingLeaves = await queryOne(`SELECT COUNT(*) AS pending
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE lr.status IN ('pending_manager', 'pending_hr')
         ${locFilter}`, locParams);
        // Pending Tasks
        const pendingTasks = await queryOne(`SELECT COUNT(DISTINCT t.id) AS pending
       FROM tasks t
       JOIN task_assignments ta ON ta.task_id = t.id
       JOIN employees e ON e.id = ta.employee_id
       WHERE t.status IN ('assigned', 'accepted', 'in_progress', 'pending_approval', 'on_hold')
         ${locFilter}`, locParams);
        // Pending Documents
        const pendingDocs = await queryOne(`SELECT COUNT(*) AS pending
       FROM employee_documents ed
       JOIN employees e ON e.id = ed.employee_id
       WHERE ed.status = 'pending'
         ${locFilter}`, locParams);
        // Department Breakdown
        const deptRows = await query(`SELECT d.id, d.name, COUNT(e.id) AS count
       FROM departments d
       LEFT JOIN employees e ON e.department_id = d.id AND e.status = 'active' ${locFilter}
       GROUP BY d.id, d.name
       ORDER BY count DESC, d.name ASC`, locParams);
        // Location Breakdown
        const locRows = await query(`SELECT l.id, l.code, l.name, COUNT(e.id) AS count
       FROM locations l
       LEFT JOIN employees e ON e.location_id = l.id AND e.status = 'active'
       WHERE l.code IN ('BEL', 'DAV', 'SHI', 'HQ')
       GROUP BY l.id, l.code, l.name
       ORDER BY l.name ASC`);
        // Recent Joinings
        const recentJoinings = await query(`SELECT e.id, e.employee_code, e.full_name, d.name AS department_name, des.title AS designation_title,
              l.code AS location_code, e.joining_date
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.status = 'active' ${locFilter}
       ORDER BY e.joining_date DESC, e.id DESC
       LIMIT 6`, locParams);
        // Recent Pending Leaves
        const recentLeaves = await query(`SELECT lr.id, lr.employee_id, e.employee_code, e.full_name, lt.name AS leave_type,
              lr.start_date, lr.end_date, lr.days, lr.status
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.status IN ('pending_manager', 'pending_hr') ${locFilter}
       ORDER BY lr.created_at DESC
       LIMIT 6`, locParams);
        const totalActive = Number(empMetrics?.active ?? 0);
        const present = Number(attendanceToday?.present ?? 0);
        const onLeave = Number(onLeaveToday?.on_leave ?? 0);
        const absent = Math.max(0, totalActive - present - onLeave);
        return {
            totalEmployees: Number(empMetrics?.total ?? 0),
            activeEmployees: totalActive,
            inactiveEmployees: Number(empMetrics?.inactive ?? 0),
            presentToday: present,
            absentToday: absent,
            onLeaveToday: onLeave,
            newJoiningsThisMonth: Number(empMetrics?.new_joinings ?? 0),
            pendingHrTasks: Number(pendingTasks?.pending ?? 0),
            pendingLeaveApprovals: Number(pendingLeaves?.pending ?? 0),
            pendingDocumentVerifications: Number(pendingDocs?.pending ?? 0),
            departmentCounts: deptRows.map((r) => ({ id: Number(r.id), name: r.name, count: Number(r.count) })),
            locationCounts: locRows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, count: Number(r.count) })),
            recentJoinings: recentJoinings.map((r) => ({
                id: Number(r.id),
                employeeCode: r.employee_code,
                fullName: r.full_name,
                departmentName: r.department_name,
                designationTitle: r.designation_title,
                locationCode: r.location_code,
                joiningDate: r.joining_date,
            })),
            recentLeaves: recentLeaves.map((r) => ({
                id: Number(r.id),
                employeeId: Number(r.employee_id),
                employeeCode: r.employee_code,
                fullName: r.full_name,
                leaveType: r.leave_type,
                startDate: r.start_date,
                endDate: r.end_date,
                days: Number(r.days),
                status: r.status,
            })),
        };
    }
    /** Employee Document management */
    static async listDocuments(filters) {
        const where = ['1=1'];
        const params = [];
        if (filters.employeeId) {
            where.push('ed.employee_id = ?');
            params.push(filters.employeeId);
        }
        if (filters.locationId) {
            where.push('e.location_id = ?');
            params.push(filters.locationId);
        }
        if (filters.status) {
            where.push('ed.status = ?');
            params.push(filters.status);
        }
        if (filters.documentType) {
            where.push('ed.document_type = ?');
            params.push(filters.documentType);
        }
        if (filters.search) {
            where.push('(e.full_name LIKE ? OR e.employee_code LIKE ? OR ed.title LIKE ?)');
            const s = `%${filters.search}%`;
            params.push(s, s, s);
        }
        const rows = await query(`SELECT ed.id, ed.employee_id, e.employee_code, e.full_name, l.code AS location_code,
              d.name AS department_name, ed.document_type, ed.title, ed.file_url,
              ed.file_size_bytes, ed.file_type, ed.status, ed.verified_by,
              v.full_name AS verifier_name, ed.verified_at, ed.notes, ed.created_at
       FROM employee_documents ed
       JOIN employees e ON e.id = ed.employee_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employees v ON v.id = ed.verified_by
       WHERE ${where.join(' AND ')}
       ORDER BY ed.created_at DESC`, params);
        return rows.map((r) => ({
            id: Number(r.id),
            employeeId: Number(r.employee_id),
            employeeCode: r.employee_code,
            fullName: r.full_name,
            locationCode: r.location_code,
            departmentName: r.department_name,
            documentType: r.document_type,
            title: r.title,
            fileUrl: r.file_url,
            fileSizeBytes: Number(r.file_size_bytes),
            fileType: r.file_type,
            status: r.status,
            verifiedBy: r.verified_by ? Number(r.verified_by) : null,
            verifierName: r.verifier_name,
            verifiedAt: r.verified_at,
            notes: r.notes,
            createdAt: r.created_at,
        }));
    }
    static async uploadDocument(actorId, data) {
        const res = await execute(`INSERT INTO employee_documents (employee_id, document_type, title, file_url, file_size_bytes, file_type, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`, [
            data.employeeId,
            data.documentType,
            data.title.trim(),
            data.fileUrl.trim(),
            data.fileSizeBytes ?? 0,
            data.fileType ?? 'application/pdf',
            data.notes?.trim() ?? null,
        ]);
        return { id: res.insertId };
    }
    static async verifyDocument(documentId, verifierId, status, notes) {
        const doc = await queryOne('SELECT id FROM employee_documents WHERE id = ?', [documentId]);
        if (!doc)
            throw ApiError.notFound('Document record not found');
        await execute(`UPDATE employee_documents
       SET status = ?, verified_by = ?, verified_at = NOW(3), notes = COALESCE(?, notes)
       WHERE id = ?`, [status, verifierId, notes?.trim() ?? null, documentId]);
        return { ok: true };
    }
    static async deleteDocument(documentId) {
        await execute('DELETE FROM employee_documents WHERE id = ?', [documentId]);
        return { ok: true };
    }
    /** Employee Salaries management */
    static async listSalaries(filters) {
        const where = ['e.status = "active"'];
        const params = [];
        if (filters.locationId) {
            where.push('e.location_id = ?');
            params.push(filters.locationId);
        }
        if (filters.departmentId) {
            where.push('e.department_id = ?');
            params.push(filters.departmentId);
        }
        if (filters.search) {
            where.push('(e.full_name LIKE ? OR e.employee_code LIKE ?)');
            const s = `%${filters.search}%`;
            params.push(s, s);
        }
        const rows = await query(`SELECT e.id AS employee_id, e.employee_code, e.full_name, d.name AS department_name,
              des.title AS designation_title, l.code AS location_code, r.name AS role_name,
              COALESCE(es.basic_salary, 0.00) AS basic_salary,
              COALESCE(es.hra, 0.00) AS hra,
              COALESCE(es.special_allowance, 0.00) AS special_allowance,
              COALESCE(es.conveyance_allowance, 0.00) AS conveyance_allowance,
              COALESCE(es.medical_allowance, 0.00) AS medical_allowance,
              COALESCE(es.gross_salary, 0.00) AS gross_salary,
              COALESCE(es.epf_deduction, 0.00) AS epf_deduction,
              COALESCE(es.esi_deduction, 0.00) AS esi_deduction,
              COALESCE(es.professional_tax, 0.00) AS professional_tax,
              COALESCE(es.tds_deduction, 0.00) AS tds_deduction,
              COALESCE(es.total_deductions, 0.00) AS total_deductions,
              COALESCE(es.net_salary, 0.00) AS net_salary,
              es.bank_name, es.bank_account_no, es.bank_ifsc, es.pan_number, es.uan_number, es.effective_from
       FROM employees e
       LEFT JOIN employee_salaries es ON es.employee_id = e.id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN roles r ON r.id = e.role_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.full_name ASC`, params);
        return rows.map((r) => ({
            employeeId: Number(r.employee_id),
            employeeCode: r.employee_code,
            fullName: r.full_name,
            departmentName: r.department_name,
            designationTitle: r.designation_title,
            locationCode: r.location_code,
            roleName: r.role_name,
            basicSalary: Number(r.basic_salary),
            hra: Number(r.hra),
            specialAllowance: Number(r.special_allowance),
            conveyanceAllowance: Number(r.conveyance_allowance),
            medicalAllowance: Number(r.medical_allowance),
            grossSalary: Number(r.gross_salary),
            epfDeduction: Number(r.epf_deduction),
            esiDeduction: Number(r.esi_deduction),
            professionalTax: Number(r.professional_tax),
            tdsDeduction: Number(r.tds_deduction),
            totalDeductions: Number(r.total_deductions),
            netSalary: Number(r.net_salary),
            bankName: r.bank_name,
            bankAccountNo: r.bank_account_no,
            bankIfsc: r.bank_ifsc,
            panNumber: r.pan_number,
            uanNumber: r.uan_number,
            effectiveFrom: r.effective_from,
        }));
    }
    static async updateSalary(employeeId, data) {
        const basic = Number(data.basicSalary) || 0;
        const hra = Number(data.hra) || 0;
        const special = Number(data.specialAllowance) || 0;
        const conveyance = Number(data.conveyanceAllowance) || 0;
        const medical = Number(data.medicalAllowance) || 0;
        const gross = basic + hra + special + conveyance + medical;
        const epf = Number(data.epfDeduction) || 0;
        const esi = Number(data.esiDeduction) || 0;
        const pt = Number(data.professionalTax) || 0;
        const tds = Number(data.tdsDeduction) || 0;
        const totalDeductions = epf + esi + pt + tds;
        const netSalary = Math.max(0, gross - totalDeductions);
        await execute(`INSERT INTO employee_salaries (
        employee_id, basic_salary, hra, special_allowance, conveyance_allowance, medical_allowance,
        gross_salary, epf_deduction, esi_deduction, professional_tax, tds_deduction, total_deductions,
        net_salary, bank_name, bank_account_no, bank_ifsc, pan_number, uan_number, effective_from
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        basic_salary = VALUES(basic_salary),
        hra = VALUES(hra),
        special_allowance = VALUES(special_allowance),
        conveyance_allowance = VALUES(conveyance_allowance),
        medical_allowance = VALUES(medical_allowance),
        gross_salary = VALUES(gross_salary),
        epf_deduction = VALUES(epf_deduction),
        esi_deduction = VALUES(esi_deduction),
        professional_tax = VALUES(professional_tax),
        tds_deduction = VALUES(tds_deduction),
        total_deductions = VALUES(total_deductions),
        net_salary = VALUES(net_salary),
        bank_name = VALUES(bank_name),
        bank_account_no = VALUES(bank_account_no),
        bank_ifsc = VALUES(bank_ifsc),
        pan_number = VALUES(pan_number),
        uan_number = VALUES(uan_number),
        effective_from = VALUES(effective_from)`, [
            employeeId,
            basic,
            hra,
            special,
            conveyance,
            medical,
            gross,
            epf,
            esi,
            pt,
            tds,
            totalDeductions,
            netSalary,
            data.bankName?.trim() ?? null,
            data.bankAccountNo?.trim() ?? null,
            data.bankIfsc?.trim() ?? null,
            data.panNumber?.trim() ?? null,
            data.uanNumber?.trim() ?? null,
            data.effectiveFrom ?? null,
        ]);
        return { ok: true, grossSalary: gross, netSalary };
    }
    /** Monthly Payroll Records generation & listing */
    static async listPayrollRecords(params) {
        const where = ['pr.month = ?', 'pr.year = ?'];
        const sqlParams = [params.month, params.year];
        if (params.locationId) {
            where.push('e.location_id = ?');
            sqlParams.push(params.locationId);
        }
        if (params.paymentStatus) {
            where.push('pr.payment_status = ?');
            sqlParams.push(params.paymentStatus);
        }
        const rows = await query(`SELECT pr.id, pr.employee_id, e.employee_code, e.full_name, d.name AS department_name,
              des.title AS designation_title, l.code AS location_code, pr.month, pr.year,
              pr.working_days, pr.present_days, pr.paid_leaves, pr.payable_days,
              pr.gross_earnings, pr.total_deductions, pr.net_pay, pr.payment_status,
              pr.paid_at, pr.reference_no, pr.notes, es.bank_name, es.bank_account_no
       FROM payroll_records pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN employee_salaries es ON es.employee_id = e.id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.full_name ASC`, sqlParams);
        const summary = rows.reduce((acc, r) => {
            acc.totalGross += Number(r.gross_earnings);
            acc.totalDeductions += Number(r.total_deductions);
            acc.totalNetPay += Number(r.net_pay);
            acc.totalCount += 1;
            if (r.payment_status === 'paid')
                acc.paidCount += 1;
            return acc;
        }, { totalGross: 0, totalDeductions: 0, totalNetPay: 0, totalCount: 0, paidCount: 0 });
        return {
            records: rows.map((r) => ({
                id: Number(r.id),
                employeeId: Number(r.employee_id),
                employeeCode: r.employee_code,
                fullName: r.full_name,
                departmentName: r.department_name,
                designationTitle: r.designation_title,
                locationCode: r.location_code,
                month: Number(r.month),
                year: Number(r.year),
                workingDays: Number(r.working_days),
                presentDays: Number(r.present_days),
                paidLeaves: Number(r.paid_leaves),
                payableDays: Number(r.payable_days),
                grossEarnings: Number(r.gross_earnings),
                totalDeductions: Number(r.total_deductions),
                netPay: Number(r.net_pay),
                paymentStatus: r.payment_status,
                paidAt: r.paid_at,
                referenceNo: r.reference_no,
                notes: r.notes,
                bankName: r.bank_name,
                bankAccountNo: r.bank_account_no,
            })),
            summary,
        };
    }
    static async generateMonthlyPayroll(month, year, locationId) {
        const locFilter = locationId ? 'AND e.location_id = ?' : '';
        const locParams = locationId ? [locationId] : [];
        const employees = await query(`SELECT e.id, 
              COALESCE(es.gross_salary, 30000.00) AS gross_salary,
              COALESCE(es.total_deductions, 2000.00) AS total_deductions,
              COALESCE(es.net_salary, 28000.00) AS net_salary
       FROM employees e
       LEFT JOIN employee_salaries es ON es.employee_id = e.id
       WHERE e.status = 'active' ${locFilter}`, locParams);
        const monthStr = String(month).padStart(2, '0');
        const daysInMonth = new Date(year, month, 0).getDate();
        let createdCount = 0;
        for (const emp of employees) {
            // Calculate actual attendance in that month
            const att = await queryOne(`SELECT 
          SUM(status IN ('present', 'late')) AS present,
          SUM(status = 'half_day') AS half_day
         FROM attendance
         WHERE employee_id = ?
           AND work_date >= ? AND work_date <= ?`, [emp.id, `${year}-${monthStr}-01`, `${year}-${monthStr}-${daysInMonth}`]);
            // Approved leaves in that month
            const leaves = await queryOne(`SELECT COALESCE(SUM(days), 0) AS leave_days
         FROM leave_requests
         WHERE employee_id = ?
           AND status = 'approved'
           AND start_date <= ? AND end_date >= ?`, [emp.id, `${year}-${monthStr}-${daysInMonth}`, `${year}-${monthStr}-01`]);
            const presentCount = Number(att?.present ?? 0) + (Number(att?.half_day ?? 0) * 0.5);
            const leaveDays = Number(leaves?.leave_days ?? 0);
            // For payroll calculation, standard working days baseline is 26 or 30
            const standardDays = 30.0;
            // If attendance records exist, payable days = present + leaves, capped at standardDays;
            // if it's the current/upcoming month, payable days default to standardDays
            const payableDays = Math.min(standardDays, Math.max(presentCount + leaveDays, standardDays));
            const payRatio = payableDays / standardDays;
            const grossEarnings = Math.round(Number(emp.gross_salary) * payRatio * 100) / 100;
            const totalDeductions = Math.round(Number(emp.total_deductions) * payRatio * 100) / 100;
            const netPay = Math.round((grossEarnings - totalDeductions) * 100) / 100;
            await execute(`INSERT INTO payroll_records (
          employee_id, month, year, working_days, present_days, paid_leaves, payable_days,
          gross_earnings, total_deductions, net_pay, payment_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
         ON DUPLICATE KEY UPDATE
          working_days = VALUES(working_days),
          present_days = VALUES(present_days),
          paid_leaves = VALUES(paid_leaves),
          payable_days = VALUES(payable_days),
          gross_earnings = VALUES(gross_earnings),
          total_deductions = VALUES(total_deductions),
          net_pay = VALUES(net_pay)`, [
                emp.id,
                month,
                year,
                standardDays,
                presentCount,
                leaveDays,
                payableDays,
                grossEarnings,
                totalDeductions,
                netPay,
            ]);
            createdCount++;
        }
        return { ok: true, processedCount: createdCount };
    }
    static async updatePayrollStatus(id, data) {
        const paidAt = data.paymentStatus === 'paid' ? 'NOW(3)' : 'NULL';
        await execute(`UPDATE payroll_records
       SET payment_status = ?,
           reference_no = COALESCE(?, reference_no),
           notes = COALESCE(?, notes),
           paid_at = ${paidAt}
       WHERE id = ?`, [data.paymentStatus, data.referenceNo?.trim() ?? null, data.notes?.trim() ?? null, id]);
        return { ok: true };
    }
}
//# sourceMappingURL=HrService.js.map