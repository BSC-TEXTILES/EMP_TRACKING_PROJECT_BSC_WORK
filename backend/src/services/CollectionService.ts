import { execute, query, queryOne, transaction, nextSequence } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { subtreeIds } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import type { AuthUser } from './AuthService.js';

/**
 * Collection records track customer payments collected by employees.
 * Visibility uses the same reporting hierarchy as tasks and tickets:
 * view.all → organisation, view.team → reporting subtree, otherwise own.
 */

export interface CollectionFilters {
  search?: string;
  status?: string;
  approvalStatus?: string;
  employeeId?: number;
  departmentId?: number;
  locationId?: number;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface CollectionInput {
  customerName: string;
  customerContact?: string | null;
  invoiceNo?: string | null;
  amountDue: number;
  amountCollected?: number;
  currency?: string;
  paymentMode?: string | null;
  dueDate: string;
  collectedOn?: string | null;
  employeeId?: number;
  departmentId?: number | null;
  locationId?: number | null;
  notes?: string | null;
}

const STATUSES = ['pending', 'partial', 'collected', 'cancelled'] as const;
const APPROVALS = ['pending', 'approved', 'rejected'] as const;
const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'] as const;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function deriveStatus(amountDue: number, amountCollected: number, requested?: string): string {
  if (requested === 'cancelled') return 'cancelled';
  if (amountCollected <= 0) return 'pending';
  if (amountCollected >= amountDue) return 'collected';
  return 'partial';
}

export class CollectionService {
  /** Returns null for organisation-wide visibility, otherwise an explicit employee id list. */
  private static async scope(user: AuthUser): Promise<number[] | null> {
    if (user.permissions.includes('collections.view.all')) return null;
    if (user.permissions.includes('collections.view.team')) return subtreeIds(user.id);
    return [user.id];
  }

  private static async assertInScope(user: AuthUser, recordId: number): Promise<{
    id: number;
    employee_id: number;
    created_by: number;
    approval_status: string;
    reference_no: string;
    customer_name: string;
  }> {
    const row = await queryOne<{
      id: number;
      employee_id: number;
      created_by: number;
      approval_status: string;
      reference_no: string;
      customer_name: string;
      deleted_at: string | null;
    }>(
      'SELECT id, employee_id, created_by, approval_status, reference_no, customer_name, deleted_at FROM collections WHERE id = ?',
      [recordId],
    );
    if (!row || row.deleted_at) throw ApiError.notFound('Collection record not found');
    const ids = await CollectionService.scope(user);
    if (ids !== null && !ids.includes(Number(row.employee_id)) && Number(row.created_by) !== user.id) {
      throw ApiError.forbidden('You do not have access to this collection record');
    }
    return row;
  }

  private static where(userIds: number[] | null, filters: CollectionFilters): { clause: string; params: unknown[] } {
    const clauses: string[] = ['c.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (userIds !== null) {
      if (userIds.length === 0) clauses.push('1 = 0');
      else {
        clauses.push(`(c.employee_id IN (${userIds.map(() => '?').join(',')}) OR c.created_by IN (${userIds.map(() => '?').join(',')}))`);
        params.push(...userIds, ...userIds);
      }
    }
    if (filters.search) {
      clauses.push('(c.customer_name LIKE ? OR c.reference_no LIKE ? OR c.invoice_no LIKE ? OR c.customer_contact LIKE ?)');
      const term = `%${filters.search}%`;
      params.push(term, term, term, term);
    }
    if (filters.status && (STATUSES as readonly string[]).includes(filters.status)) {
      clauses.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.approvalStatus && (APPROVALS as readonly string[]).includes(filters.approvalStatus)) {
      clauses.push('c.approval_status = ?');
      params.push(filters.approvalStatus);
    }
    if (filters.employeeId) {
      clauses.push('c.employee_id = ?');
      params.push(filters.employeeId);
    }
    if (filters.departmentId) {
      clauses.push('c.department_id = ?');
      params.push(filters.departmentId);
    }
    if (filters.locationId) {
      clauses.push('c.location_id = ?');
      params.push(filters.locationId);
    }
    if (filters.from) {
      clauses.push('c.due_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('c.due_date <= ?');
      params.push(filters.to);
    }
    return { clause: clauses.join(' AND '), params };
  }

  static async list(user: AuthUser, filters: CollectionFilters) {
    const ids = await CollectionService.scope(user);
    const { clause, params } = CollectionService.where(ids, filters);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const total = await queryOne<{ total: number; collected: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN c.status = 'collected' THEN c.amount_collected ELSE 0 END), 0) AS collected
         FROM collections c WHERE ${clause}`,
      params,
    );

    const rows = await query<{
      id: number;
      reference_no: string;
      customer_name: string;
      customer_contact: string | null;
      invoice_no: string | null;
      amount_due: number;
      amount_collected: number;
      currency: string;
      payment_mode: string | null;
      status: string;
      approval_status: string;
      due_date: string;
      collected_on: string | null;
      notes: string | null;
      employee_id: number;
      employee_name: string;
      employee_code: string;
      department_name: string | null;
      location_name: string | null;
      approved_by_name: string | null;
      approved_at: string | null;
      rejection_reason: string | null;
      is_overdue: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT c.id, c.reference_no, c.customer_name, c.customer_contact, c.invoice_no, c.amount_due, c.amount_collected,
              c.currency, c.payment_mode, c.status, c.approval_status, c.due_date, c.collected_on, c.notes,
              c.employee_id, e.full_name AS employee_name, e.employee_code,
              d.name AS department_name, l.name AS location_name,
              a.full_name AS approved_by_name, c.approved_at, c.rejection_reason,
              CASE WHEN c.due_date < CURDATE() AND c.status IN ('pending','partial') THEN 1 ELSE 0 END AS is_overdue,
              c.created_at, c.updated_at
         FROM collections c
         JOIN employees e ON e.id = c.employee_id
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN locations l ON l.id = c.location_id
         LEFT JOIN employees a ON a.id = c.approved_by
        WHERE ${clause}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );

    return {
      items: rows.map((row) => ({
        id: Number(row.id),
        referenceNo: row.reference_no,
        customerName: row.customer_name,
        customerContact: row.customer_contact,
        invoiceNo: row.invoice_no,
        amountDue: Number(row.amount_due),
        amountCollected: Number(row.amount_collected),
        outstanding: round(Number(row.amount_due) - Number(row.amount_collected)),
        currency: row.currency,
        paymentMode: row.payment_mode,
        status: row.status,
        approvalStatus: row.approval_status,
        dueDate: row.due_date,
        collectedOn: row.collected_on,
        notes: row.notes,
        employeeId: Number(row.employee_id),
        employeeName: row.employee_name,
        employeeCode: row.employee_code,
        departmentName: row.department_name,
        locationName: row.location_name,
        approvedByName: row.approved_by_name,
        approvedAt: toIso(row.approved_at),
        rejectionReason: row.rejection_reason,
        overdue: Boolean(row.is_overdue),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      })),
      total: Number(total?.total ?? 0),
      collectedTotal: Number(total?.collected ?? 0),
      page,
      pageSize,
    };
  }

  static async dashboard(user: AuthUser, filters: { from?: string; to?: string }) {
    const ids = await CollectionService.scope(user);
    const { clause, params } = CollectionService.where(ids, { from: filters.from, to: filters.to });
    const summary = await queryOne<{
      records: number;
      due: number;
      collected: number;
      outstanding: number;
      pending_count: number;
      pending_amount: number;
      overdue_count: number;
      overdue_amount: number;
      approvals: number;
    }>(
      `SELECT COUNT(*) AS records,
              COALESCE(SUM(c.amount_due), 0) AS due,
              COALESCE(SUM(c.amount_collected), 0) AS collected,
              COALESCE(SUM(CASE WHEN c.status IN ('pending','partial') THEN c.amount_due - c.amount_collected ELSE 0 END), 0) AS outstanding,
              SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
              COALESCE(SUM(CASE WHEN c.status = 'pending' THEN c.amount_due ELSE 0 END), 0) AS pending_amount,
              SUM(CASE WHEN c.due_date < CURDATE() AND c.status IN ('pending','partial') THEN 1 ELSE 0 END) AS overdue_count,
              COALESCE(SUM(CASE WHEN c.due_date < CURDATE() AND c.status IN ('pending','partial') THEN c.amount_due - c.amount_collected ELSE 0 END), 0) AS overdue_amount,
              SUM(CASE WHEN c.approval_status = 'pending' THEN 1 ELSE 0 END) AS approvals
         FROM collections c WHERE ${clause}`,
      params,
    );

    const byStatus = await query<{ status: string; total: number; amount: number }>(
      `SELECT c.status, COUNT(*) AS total, COALESCE(SUM(c.amount_due), 0) AS amount
         FROM collections c WHERE ${clause} GROUP BY c.status`,
      params,
    );

    const byDepartment = await query<{ department: string | null; collected: number; records: number }>(
      `SELECT d.name AS department, COALESCE(SUM(c.amount_collected), 0) AS collected, COUNT(*) AS records
         FROM collections c
         LEFT JOIN departments d ON d.id = c.department_id
        WHERE ${clause}
        GROUP BY d.name
        ORDER BY collected DESC
        LIMIT 6`,
      params,
    );

    const recent = await query<{
      id: number;
      reference_no: string;
      customer_name: string;
      amount_due: number;
      amount_collected: number;
      currency: string;
      status: string;
      approval_status: string;
      due_date: string;
      employee_name: string;
    }>(
      `SELECT c.id, c.reference_no, c.customer_name, c.amount_due, c.amount_collected, c.currency,
              c.status, c.approval_status, c.due_date, e.full_name AS employee_name
         FROM collections c JOIN employees e ON e.id = c.employee_id
        WHERE ${clause}
        ORDER BY c.created_at DESC LIMIT 6`,
      params,
    );

    const todayTotals = await queryOne<{ today: number; month: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN c.collected_on = CURDATE() THEN c.amount_collected ELSE 0 END), 0) AS today,
         COALESCE(SUM(CASE WHEN DATE_FORMAT(c.collected_on, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m') THEN c.amount_collected ELSE 0 END), 0) AS month
       FROM collections c WHERE c.deleted_at IS NULL`,
    );

    return {
      summary: {
        records: Number(summary?.records ?? 0),
        due: Number(summary?.due ?? 0),
        collected: Number(summary?.collected ?? 0),
        outstanding: Number(summary?.outstanding ?? 0),
        pendingCount: Number(summary?.pending_count ?? 0),
        pendingAmount: Number(summary?.pending_amount ?? 0),
        overdueCount: Number(summary?.overdue_count ?? 0),
        overdueAmount: Number(summary?.overdue_amount ?? 0),
        approvals: Number(summary?.approvals ?? 0),
        collectedToday: Number(todayTotals?.today ?? 0),
        collectedThisMonth: Number(todayTotals?.month ?? 0),
      },
      byStatus: byStatus.map((row) => ({ status: row.status, total: Number(row.total), amount: Number(row.amount) })),
      byDepartment: byDepartment.map((row) => ({
        department: row.department ?? 'Unassigned',
        collected: Number(row.collected),
        records: Number(row.records),
      })),
      recent: recent.map((row) => ({
        id: Number(row.id),
        referenceNo: row.reference_no,
        customerName: row.customer_name,
        amountDue: Number(row.amount_due),
        amountCollected: Number(row.amount_collected),
        currency: row.currency,
        status: row.status,
        approvalStatus: row.approval_status,
        dueDate: row.due_date,
        employeeName: row.employee_name,
      })),
    };
  }

  static async detail(user: AuthUser, id: number) {
    await CollectionService.assertInScope(user, id);
    const row = await queryOne<Record<string, unknown>>(
      `SELECT c.*, e.full_name AS employee_name, e.employee_code, d.name AS department_name, l.name AS location_name,
              a.full_name AS approved_by_name
         FROM collections c
         JOIN employees e ON e.id = c.employee_id
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN locations l ON l.id = c.location_id
         LEFT JOIN employees a ON a.id = c.approved_by
        WHERE c.id = ?`,
      [id],
    );
    if (!row) throw ApiError.notFound('Collection record not found');
    return {
      id: Number(row.id),
      referenceNo: String(row.reference_no),
      customerName: String(row.customer_name),
      customerContact: (row.customer_contact as string | null) ?? null,
      invoiceNo: (row.invoice_no as string | null) ?? null,
      amountDue: Number(row.amount_due),
      amountCollected: Number(row.amount_collected),
      outstanding: round(Number(row.amount_due) - Number(row.amount_collected)),
      currency: String(row.currency),
      paymentMode: (row.payment_mode as string | null) ?? null,
      status: String(row.status),
      approvalStatus: String(row.approval_status),
      dueDate: String(row.due_date),
      collectedOn: (row.collected_on as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      employeeId: Number(row.employee_id),
      employeeName: String(row.employee_name),
      employeeCode: String(row.employee_code),
      departmentName: (row.department_name as string | null) ?? null,
      locationName: (row.location_name as string | null) ?? null,
      approvedByName: (row.approved_by_name as string | null) ?? null,
      approvedAt: toIso(row.approved_at as string | null),
      rejectionReason: (row.rejection_reason as string | null) ?? null,
      createdBy: Number(row.created_by),
      createdAt: toIso(row.created_at as string),
      updatedAt: toIso(row.updated_at as string),
    };
  }

  private static async resolveCollector(user: AuthUser, employeeId?: number) {
    const target = employeeId ?? user.id;
    if (target !== user.id && !user.permissions.includes('collections.view.all')) {
      const ids = await subtreeIds(user.id);
      if (!ids.includes(target)) throw ApiError.forbidden('You can only assign collections inside your reporting structure');
    }
    const employee = await queryOne<{ id: number; department_id: number | null; location_id: number | null; status: string }>(
      'SELECT id, department_id, location_id, status FROM employees WHERE id = ?',
      [target],
    );
    if (!employee || employee.status !== 'active') throw ApiError.badRequest('Select an active employee for this collection');
    return { id: Number(employee.id), departmentId: employee.department_id, locationId: employee.location_id };
  }

  static async create(user: AuthUser, input: CollectionInput) {
    const amountDue = round(Number(input.amountDue));
    if (!Number.isFinite(amountDue) || amountDue <= 0) throw ApiError.badRequest('Amount due must be greater than zero');
    const amountCollected = round(Number(input.amountCollected ?? 0));
    if (amountCollected < 0) throw ApiError.badRequest('Collected amount cannot be negative');
    if (amountCollected > amountDue) throw ApiError.badRequest('Collected amount cannot exceed the amount due');
    const collector = await CollectionService.resolveCollector(user, input.employeeId);

    const created = await transaction(async (conn) => {
      const seq = await nextSequence(conn, 'collection_seq');
      const referenceNo = `COL-${new Date().getUTCFullYear()}-${String(seq).padStart(4, '0')}`;
      const [result] = await conn.query(
        `INSERT INTO collections
           (reference_no, customer_name, customer_contact, invoice_no, amount_due, amount_collected, currency,
            payment_mode, status, approval_status, due_date, collected_on, employee_id, department_id, location_id,
            notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        [
          referenceNo,
          input.customerName.trim(),
          input.customerContact?.trim() || null,
          input.invoiceNo?.trim() || null,
          amountDue,
          amountCollected,
          (input.currency ?? 'INR').toUpperCase().slice(0, 3),
          input.paymentMode || null,
          deriveStatus(amountDue, amountCollected),
          input.dueDate,
          input.collectedOn || null,
          collector.id,
          input.departmentId ?? collector.departmentId,
          input.locationId ?? collector.locationId,
          input.notes?.trim() || null,
          user.id,
        ],
      );
      return { id: Number((result as { insertId: number }).insertId), referenceNo };
    });

    await recordAudit({
      actorId: user.id,
      action: 'collection.created',
      entityType: 'collection',
      entityId: created.id,
      after: { referenceNo: created.referenceNo, amountDue, amountCollected, employeeId: collector.id },
    });

    if (collector.id !== user.id) {
      await NotificationService.notify({
        employeeIds: [collector.id],
        type: 'collection_assigned',
        title: 'Collection record assigned',
        body: `${created.referenceNo} · ${input.customerName} · ${amountDue.toFixed(2)} ${input.currency ?? 'INR'}`,
        link: '/collections',
        priority: 'normal',
        actorId: user.id,
      });
    }
    return created;
  }

  static async update(user: AuthUser, id: number, input: Partial<CollectionInput> & { status?: string }) {
    const record = await CollectionService.assertInScope(user, id);
    if (record.approval_status === 'approved' && !user.permissions.includes('collections.view.all')) {
      throw ApiError.forbidden('Approved collection records can only be changed by an administrator');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (input.customerName !== undefined) assign('customer_name', input.customerName.trim());
    if (input.customerContact !== undefined) assign('customer_contact', input.customerContact?.trim() || null);
    if (input.invoiceNo !== undefined) assign('invoice_no', input.invoiceNo?.trim() || null);
    if (input.notes !== undefined) assign('notes', input.notes?.trim() || null);
    if (input.dueDate !== undefined) assign('due_date', input.dueDate);
    if (input.collectedOn !== undefined) assign('collected_on', input.collectedOn || null);
    if (input.paymentMode !== undefined) assign('payment_mode', input.paymentMode || null);
    if (input.departmentId !== undefined) assign('department_id', input.departmentId ?? null);
    if (input.locationId !== undefined) assign('location_id', input.locationId ?? null);

    let amountDue: number | undefined;
    if (input.amountDue !== undefined) {
      amountDue = round(Number(input.amountDue));
      if (!Number.isFinite(amountDue) || amountDue <= 0) throw ApiError.badRequest('Amount due must be greater than zero');
      assign('amount_due', amountDue);
    }
    if (input.amountCollected !== undefined) {
      const collected = round(Number(input.amountCollected));
      if (collected < 0) throw ApiError.badRequest('Collected amount cannot be negative');
      assign('amount_collected', collected);
    }
    if (input.employeeId !== undefined && input.employeeId !== record.employee_id) {
      const collector = await CollectionService.resolveCollector(user, input.employeeId);
      assign('employee_id', collector.id);
    }

    const current = await queryOne<{ amount_due: number; amount_collected: number }>(
      'SELECT amount_due, amount_collected FROM collections WHERE id = ?',
      [id],
    );
    const nextDue = amountDue ?? Number(current?.amount_due ?? 0);
    const nextCollected = input.amountCollected !== undefined ? round(Number(input.amountCollected)) : Number(current?.amount_collected ?? 0);
    if (nextCollected > nextDue) throw ApiError.badRequest('Collected amount cannot exceed the amount due');
    const requestedStatus = input.status && (STATUSES as readonly string[]).includes(input.status) ? input.status : undefined;
    assign('status', deriveStatus(nextDue, nextCollected, requestedStatus));

    if (sets.length > 0) {
      params.push(id);
      await execute(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    await recordAudit({
      actorId: user.id,
      action: 'collection.updated',
      entityType: 'collection',
      entityId: id,
      before: { status: record.approval_status },
      after: { fields: Object.keys(input) },
    });
    return CollectionService.detail(user, id);
  }

  static async decide(user: AuthUser, id: number, approve: boolean, reason?: string) {
    const record = await CollectionService.assertInScope(user, id);
    if (record.approval_status !== 'pending') throw ApiError.badRequest('This collection record has already been reviewed');
    if (!approve && !reason?.trim()) throw ApiError.badRequest('Provide a reason when rejecting a collection record');

    if (approve) {
      await execute(
        "UPDATE collections SET approval_status = 'approved', approved_by = ?, approved_at = NOW(3), rejection_reason = NULL WHERE id = ?",
        [user.id, id],
      );
    } else {
      await execute(
        "UPDATE collections SET approval_status = 'rejected', approved_by = ?, approved_at = NOW(3), rejection_reason = ? WHERE id = ?",
        [user.id, reason!.trim().slice(0, 400), id],
      );
    }
    await recordAudit({
      actorId: user.id,
      action: approve ? 'collection.approved' : 'collection.rejected',
      entityType: 'collection',
      entityId: id,
      after: { approvalStatus: approve ? 'approved' : 'rejected', reason: reason ?? null },
    });
    await NotificationService.notify({
      employeeIds: [Number(record.employee_id)],
      type: 'collection_update',
      title: approve ? 'Collection approved' : 'Collection rejected',
      body: `${record.reference_no} · ${record.customer_name}${!approve && reason ? ` · ${reason}` : ''}`,
      link: '/collections',
      priority: approve ? 'normal' : 'high',
      actorId: user.id,
      dedupeKey: `collection:${id}:${approve ? 'approved' : 'rejected'}`,
    });
    return CollectionService.detail(user, id);
  }

  static async remove(user: AuthUser, id: number) {
    await CollectionService.assertInScope(user, id);
    await execute('UPDATE collections SET deleted_at = NOW(3) WHERE id = ? AND deleted_at IS NULL', [id]);
    await recordAudit({
      actorId: user.id,
      action: 'collection.deleted',
      entityType: 'collection',
      entityId: id,
    });
  }

  static statuses() {
    return {
      statuses: STATUSES.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
      approvals: APPROVALS.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
      paymentModes: PAYMENT_MODES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
    };
  }
}
