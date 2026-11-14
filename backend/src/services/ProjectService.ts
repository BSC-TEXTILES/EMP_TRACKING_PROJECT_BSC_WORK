import { execute, query, queryOne, transaction } from '../db/index.js';
import { recordAudit } from '../lib/audit.js';
import { toIso } from '../lib/dates.js';
import { ApiError } from '../lib/http.js';
import { assertCanAllocateTo } from '../lib/scope.js';
import { NotificationService } from './NotificationService.js';
import { ChatService } from './ChatService.js';
import type { AuthUser } from './AuthService.js';

export class ProjectService {
  static async create(
    actor: AuthUser,
    input: {
      name: string;
      code?: string;
      description?: string;
      managerId?: number | null;
      departmentId?: number | null;
      startDate?: string | null;
      endDate?: string | null;
      memberIds?: number[];
    },
  ) {
    if (!actor.permissions.includes('projects.create') && !actor.permissions.includes('projects.manage')) {
      throw ApiError.forbidden('You cannot create projects.');
    }
    if (!input.name?.trim()) throw ApiError.badRequest('Project name is required.');
    const seqRow = await queryOne<{ setting_value: string }>("SELECT setting_value FROM system_settings WHERE setting_key = 'project_seq'");
    const nextSeq = Number(seqRow?.setting_value ?? 0) + 1;
    await execute(
      "INSERT INTO system_settings (setting_key, setting_value) VALUES ('project_seq', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
      [String(nextSeq)],
    );
    const code = (input.code?.trim() || `PRJ-${String(nextSeq).padStart(3, '0')}`).toUpperCase();

    const memberIds = [...new Set([actor.id, ...(input.memberIds ?? [])])];
    for (const memberId of input.memberIds ?? []) {
      await assertCanAllocateTo(actor, memberId);
    }

    const id = await transaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO projects (code, name, description, manager_id, department_id, start_date, end_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          code,
          input.name.trim(),
          input.description ?? null,
          input.managerId ?? actor.id,
          input.departmentId ?? actor.departmentId ?? null,
          input.startDate ?? null,
          input.endDate ?? null,
          actor.id,
        ],
      );
      const projectId = Number((result as { insertId: number }).insertId);
      for (const memberId of memberIds) {
        await conn.query("INSERT IGNORE INTO project_members (project_id, employee_id, project_role) VALUES (?, ?, ?)", [
          projectId,
          memberId,
          memberId === (input.managerId ?? actor.id) ? 'manager' : 'member',
        ]);
      }
      return projectId;
    });

    const conversationId = await ChatService.createGroup(actor, {
      name: `Project · ${input.name.trim()}`,
      description: `Discussion channel for project ${code}`,
      memberIds,
    });
    await execute('UPDATE projects SET conversation_id = ? WHERE id = ?', [conversationId, id]);

    await NotificationService.notify({
      employeeIds: memberIds.filter((m) => m !== actor.id),
      type: 'project',
      title: 'Added to a project',
      body: `${actor.fullName} added you to "${input.name.trim()}".`,
      link: `/projects?project=${id}`,
      actorId: actor.id,
    });
    await recordAudit({
      actorId: actor.id,
      action: 'project.created',
      entityType: 'project',
      entityId: id,
      after: { code, name: input.name, memberIds },
    });
    return { id, code, conversationId };
  }

  static async list(actor: AuthUser, filters: { status?: string; search?: string }) {
    const clauses = ['1 = 1'];
    const params: unknown[] = [];
    if (!actor.permissions.includes('projects.manage') && !actor.permissions.includes('projects.view.all')) {
      clauses.push('EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.employee_id = ?)');
      params.push(actor.id);
    }
    if (filters.status) {
      clauses.push('p.status = ?');
      params.push(filters.status);
    }
    if (filters.search) {
      clauses.push('(p.name LIKE ? OR p.code LIKE ?)');
      const term = `%${filters.search}%`;
      params.push(term, term);
    }
    const rows = await query<{
      id: number;
      code: string;
      name: string;
      description: string | null;
      status: string;
      progress: number;
      start_date: string | null;
      end_date: string | null;
      manager_name: string | null;
      department_name: string | null;
      member_count: number;
      task_count: number;
      completed_tasks: number;
      conversation_id: number | null;
    }>(
      `SELECT p.id, p.code, p.name, p.description, p.status, p.progress, p.start_date, p.end_date,
              m.full_name AS manager_name, d.name AS department_name, p.conversation_id,
              (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived_at IS NULL) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS completed_tasks
       FROM projects p
       LEFT JOIN employees m ON m.id = p.manager_id
       LEFT JOIN departments d ON d.id = p.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY FIELD(p.status, 'active','planning','on_hold','completed','cancelled'), p.updated_at DESC`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
      description: r.description,
      status: r.status,
      progress: Number(r.progress),
      startDate: r.start_date,
      endDate: r.end_date,
      managerName: r.manager_name,
      departmentName: r.department_name,
      memberCount: Number(r.member_count),
      taskCount: Number(r.task_count),
      completedTasks: Number(r.completed_tasks),
      conversationId: r.conversation_id ? Number(r.conversation_id) : null,
    }));
  }

  private static async assertAccess(projectId: number, actor: AuthUser) {
    const project = await queryOne<{ id: number; manager_id: number | null; conversation_id: number | null }>(
      'SELECT id, manager_id, conversation_id FROM projects WHERE id = ?',
      [projectId],
    );
    if (!project) throw ApiError.notFound('Project not found');
    if (actor.permissions.includes('projects.manage') || actor.permissions.includes('projects.view.all')) return project;
    const member = await queryOne<{ id: number }>('SELECT id FROM project_members WHERE project_id = ? AND employee_id = ?', [
      projectId,
      actor.id,
    ]);
    if (!member) throw ApiError.forbidden('You are not a member of this project.');
    return project;
  }

  static async detail(projectId: number, actor: AuthUser) {
    const access = await ProjectService.assertAccess(projectId, actor);
    const project = await queryOne<{
      id: number;
      code: string;
      name: string;
      description: string | null;
      status: string;
      progress: number;
      start_date: string | null;
      end_date: string | null;
      manager_id: number | null;
      manager_name: string | null;
      department_name: string | null;
      conversation_id: number | null;
      created_at: string;
    }>(
      `SELECT p.*, m.full_name AS manager_name, d.name AS department_name
       FROM projects p LEFT JOIN employees m ON m.id = p.manager_id LEFT JOIN departments d ON d.id = p.department_id
       WHERE p.id = ?`,
      [projectId],
    );
    if (!project) throw ApiError.notFound('Project not found');

    const [members, milestones, tasks] = await Promise.all([
      query<{ employee_id: number; full_name: string; project_role: string; designation_title: string | null; photo_url: string | null }>(
        `SELECT pm.employee_id, e.full_name, pm.project_role, dg.title AS designation_title, e.photo_url
         FROM project_members pm JOIN employees e ON e.id = pm.employee_id
         LEFT JOIN designations dg ON dg.id = e.designation_id
         WHERE pm.project_id = ? ORDER BY pm.project_role, e.full_name`,
        [projectId],
      ),
      query<{ id: number; title: string; due_date: string | null; status: string }>(
        'SELECT id, title, due_date, status FROM project_milestones WHERE project_id = ? ORDER BY due_date',
        [projectId],
      ),
      query<{
        id: number;
        task_no: string;
        title: string;
        status: string;
        priority: string;
        progress: number;
        due_date: string | null;
        assignee_names: string | null;
      }>(
        `SELECT t.id, t.task_no, t.title, t.status, t.priority, t.progress, t.due_date,
                (SELECT GROUP_CONCAT(e.full_name SEPARATOR ', ') FROM task_assignments ta JOIN employees e ON e.id = ta.employee_id WHERE ta.task_id = t.id) AS assignee_names
         FROM tasks t WHERE t.project_id = ? AND t.archived_at IS NULL
         ORDER BY t.id DESC`,
        [projectId],
      ),
    ]);

    return {
      id: Number(project.id),
      code: project.code,
      name: project.name,
      description: project.description,
      status: project.status,
      progress: Number(project.progress),
      startDate: project.start_date,
      endDate: project.end_date,
      managerId: project.manager_id ? Number(project.manager_id) : null,
      managerName: project.manager_name,
      departmentName: project.department_name,
      conversationId: project.conversation_id ? Number(project.conversation_id) : access.conversation_id ?? null,
      createdAt: toIso(project.created_at),
      members: members.map((m) => ({
        employeeId: Number(m.employee_id),
        name: m.full_name,
        projectRole: m.project_role,
        designation: m.designation_title,
        photoUrl: m.photo_url,
      })),
      milestones: milestones.map((m) => ({
        id: Number(m.id),
        title: m.title,
        dueDate: m.due_date,
        status: m.status,
      })),
      tasks: tasks.map((t) => ({
        id: Number(t.id),
        taskNo: t.task_no,
        title: t.title,
        status: t.status,
        priority: t.priority,
        progress: Number(t.progress),
        dueDate: t.due_date,
        assigneeNames: t.assignee_names,
      })),
    };
  }

  static async updateStatus(projectId: number, actor: AuthUser, status: string) {
    await ProjectService.assertAccess(projectId, actor);
    if (!actor.permissions.includes('projects.manage')) {
      const project = await queryOne<{ manager_id: number | null }>('SELECT manager_id FROM projects WHERE id = ?', [projectId]);
      if (Number(project?.manager_id) !== actor.id) throw ApiError.forbidden('Only the project manager can update status.');
    }
    if (!['planning', 'active', 'on_hold', 'completed', 'cancelled'].includes(status)) throw ApiError.badRequest('Invalid project status.');
    await execute('UPDATE projects SET status = ? WHERE id = ?', [status, projectId]);
    await recordAudit({ actorId: actor.id, action: 'project.status_updated', entityType: 'project', entityId: projectId, after: { status } });
  }

  static async recalculateProgress(projectId: number): Promise<number> {
    const row = await queryOne<{ total: number; done: number }>(
      `SELECT COUNT(*) AS total, SUM(status = 'completed') AS done FROM tasks WHERE project_id = ? AND archived_at IS NULL`,
      [projectId],
    );
    const total = Number(row?.total ?? 0);
    const progress = total > 0 ? Math.round((Number(row?.done ?? 0) / total) * 100) : 0;
    await execute('UPDATE projects SET progress = ? WHERE id = ?', [progress, projectId]);
    return progress;
  }

  static async addMilestone(projectId: number, actor: AuthUser, input: { title: string; dueDate?: string | null; description?: string }) {
    await ProjectService.assertAccess(projectId, actor);
    if (!input.title?.trim()) throw ApiError.badRequest('Milestone title is required.');
    const result = await execute('INSERT INTO project_milestones (project_id, title, description, due_date) VALUES (?, ?, ?, ?)', [
      projectId,
      input.title.trim(),
      input.description ?? null,
      input.dueDate ?? null,
    ]);
    return result.insertId;
  }

  static async completeMilestone(projectId: number, milestoneId: number, actor: AuthUser) {
    await ProjectService.assertAccess(projectId, actor);
    await execute(
      "UPDATE project_milestones SET status = IF(status = 'open', 'completed', 'open'), completed_at = IF(status = 'open', NOW(3), NULL) WHERE id = ? AND project_id = ?",
      [milestoneId, projectId],
    );
  }

  static async addMember(projectId: number, actor: AuthUser, employeeId: number) {
    await ProjectService.assertAccess(projectId, actor);
    await assertCanAllocateTo(actor, employeeId);
    await execute('INSERT IGNORE INTO project_members (project_id, employee_id) VALUES (?, ?)', [projectId, employeeId]);
    const project = await queryOne<{ conversation_id: number | null; name: string }>('SELECT conversation_id, name FROM projects WHERE id = ?', [
      projectId,
    ]);
    if (project?.conversation_id) {
      await ChatService.addMembers(Number(project.conversation_id), actor, [employeeId]);
    }
    await NotificationService.notify({
      employeeIds: [employeeId],
      type: 'project',
      title: 'Added to a project',
      body: `${actor.fullName} added you to "${project?.name ?? 'a project'}".`,
      link: `/projects?project=${projectId}`,
      actorId: actor.id,
    });
  }

  static async removeMember(projectId: number, actor: AuthUser, employeeId: number) {
    const project = await ProjectService.assertAccess(projectId, actor);
    await execute('DELETE FROM project_members WHERE project_id = ? AND employee_id = ?', [projectId, employeeId]);
    if (project.conversation_id) {
      await ChatService.removeMember(Number(project.conversation_id), actor, employeeId);
    }
  }
}
