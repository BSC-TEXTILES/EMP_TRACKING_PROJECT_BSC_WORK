import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, ProgressBar, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { formatDate, titleize } from '../lib/format';
import type { PickerEmployee, ProjectSummary } from '../lib/types';

interface ProjectDetail extends ProjectSummary {
  managerId: number | null;
  createdAt: string;
  members: { employeeId: number; name: string; projectRole: string; designation: string | null; photoUrl: string | null }[];
  milestones: { id: number; title: string; dueDate: string | null; status: string; description?: string | null }[];
  tasks: { id: number; taskNo: string; title: string; status: string; priority: string; progress: number; dueDate: string | null; assigneeNames: string | null }[];
}

export default function Projects() {
  useDocumentTitle('Projects');
  const { has, user } = useAuth();
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [employees, setEmployees] = useState<PickerEmployee[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [view, setView] = useState<'grid' | 'list' | 'kanban'>('grid');
  const [milestone, setMilestone] = useState({ title: '', dueDate: '' });

  const load = async () => {
    try {
      const result = await api.get<{ projects: ProjectSummary[] }>(`/projects${statusFilter ? `?status=${statusFilter}` : ''}`);
      setProjects(result.projects);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    api.get<{ employees: PickerEmployee[] }>('/employees/picker').then((result) => setEmployees(result.employees)).catch(() => undefined);
  }, []);

  const openDetail = async (id: number) => {
    try {
      setDetail(await api.get<ProjectDetail>(`/projects/${id}`));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const canDelete = (project: { managerId?: number | null; managerName?: string | null }) =>
    has('projects.manage') || (project.managerId != null && Number(project.managerId) === user?.id);

  const deleteProject = async (project: { id: number; name: string }) => {
    if (!window.confirm(`Delete project "${project.name}"?

Its members and milestones will be removed. Linked tasks are kept but unlinked from the project. This cannot be undone.`)) return;
    try {
      await api.del(`/projects/${project.id}`);
      toast.success('Project deleted.');
      setDetail((current) => (current?.id === project.id ? null : current));
      setProjects((current) => (current ? current.filter((item) => item.id !== project.id) : current));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const byStatus = (status: string) => (projects ?? []).filter((project) => project.status === status);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Projects & teams"
        description="Milestones, members, linked tasks and project performance."
        actions={
          <>
            <select className="input w-auto" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">All statuses</option>
              {['planning', 'active', 'on_hold', 'completed', 'cancelled'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
            </select>
            {has('projects.create', 'projects.manage') && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}><Icon name="plus" size={15} /> New project</button>
            )}
          </>
        }
      />

      <Tabs
        tabs={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
          { value: 'kanban', label: 'Kanban' },
        ]}
        value={view}
        onChange={(value) => setView(value as 'grid' | 'list' | 'kanban')}
      />

      {!projects ? (
        <Card className="card-pad"><Skeleton lines={6} /></Card>
      ) : projects.length === 0 ? (
        <Card><EmptyState title="No projects" description="Projects you manage or belong to will appear here." /></Card>
      ) : view === 'grid' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <div
              key={project.id}
              role="button"
              tabIndex={0}
              onClick={() => void openDetail(project.id)}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openDetail(project.id); } }}
              className="card cursor-pointer p-4 text-left transition hover:border-brand-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">{project.name}</p>
                  <p className="text-xs text-ink-400">{project.code} · {project.departmentName ?? 'No department'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusBadge status={project.status} />
                  {canDelete(project) && (
                    <button
                      type="button"
                      className="rounded-md p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
                      onClick={(event) => { event.stopPropagation(); void deleteProject(project); }}
                      aria-label={`Delete project ${project.name}`}
                      title="Delete project"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-ink-500">{project.description ?? 'No description'}</p>
              <div className="mt-3"><ProgressBar value={project.progress} label={`${project.completedTasks}/${project.taskCount} tasks`} /></div>
              <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
                <span>{project.memberCount} members</span>
                <span>{project.endDate ? `Due ${formatDate(project.endDate)}` : 'No deadline'}</span>
              </div>
              <p className="mt-1 text-xs text-ink-400">Manager: {project.managerName ?? '—'}</p>
            </div>
          ))}
        </div>
      ) : view === 'list' ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Project</th><th>Manager</th><th>Status</th><th>Progress</th><th>Timeline</th><th>Team</th><th className="w-10"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} className="cursor-pointer" onClick={() => void openDetail(project.id)}>
                    <td><p className="font-medium text-ink-800">{project.name}</p><p className="text-xs text-ink-400">{project.code}</p></td>
                    <td className="text-ink-600">{project.managerName ?? '—'}</td>
                    <td><StatusBadge status={project.status} /></td>
                    <td className="w-32"><ProgressBar value={project.progress} /></td>
                    <td className="whitespace-nowrap text-xs text-ink-500">{project.startDate ? formatDate(project.startDate) : '—'} → {project.endDate ? formatDate(project.endDate) : '—'}</td>
                    <td className="text-ink-600">{project.memberCount}</td>
                    <td>
                      {canDelete(project) && (
                        <button
                          type="button"
                          className="rounded-md p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
                          onClick={(event) => { event.stopPropagation(); void deleteProject(project); }}
                          aria-label={`Delete project ${project.name}`}
                          title="Delete project"
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3 overflow-x-auto lg:grid-cols-5">
          {['planning', 'active', 'on_hold', 'completed', 'cancelled'].map((status) => (
            <div key={status} className="rounded-xl bg-ink-100/70 p-2">
              <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{titleize(status)} ({byStatus(status).length})</p>
              <div className="space-y-2">
                {byStatus(status).map((project) => (
                  <button key={project.id} type="button" onClick={() => void openDetail(project.id)} className="w-full rounded-lg bg-white p-2.5 text-left shadow-sm hover:shadow">
                    <p className="text-sm font-medium text-ink-800">{project.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-400">{project.completedTasks}/{project.taskCount} tasks</p>
                    <div className="mt-1.5"><ProgressBar value={project.progress} /></div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.name ?? ''} size="xl" description={detail ? `${detail.code} · managed by ${detail.managerName ?? '—'}` : undefined}
        footer={detail ? <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {detail.conversationId && <Link to={`/chat?c=${detail.conversationId}`} className="btn-secondary btn-sm">Project chat</Link>}
            <Link to={`/tasks?view=all`} className="btn-secondary btn-sm">View tasks</Link>
            {has('projects.manage') && (
              <select className="input w-auto py-1 text-xs" value={detail.status} onChange={async (event) => {
                try {
                  await api.post(`/projects/${detail.id}/status`, { status: event.target.value });
                  await openDetail(detail.id);
                  await load();
                } catch (caught) { toast.error(errorMessage(caught)); }
              }}>
                {['planning', 'active', 'on_hold', 'completed', 'cancelled'].map((value) => <option key={value} value={value}>{titleize(value)}</option>)}
              </select>
            )}
          </div>
          <div className="flex gap-1.5">
            {canDelete(detail) && (
              <button type="button" className="btn-secondary btn-sm text-red-600 hover:bg-red-50" onClick={() => void deleteProject(detail)}>
                <Icon name="trash" size={14} /> Delete project
              </button>
            )}
            <button className="btn-secondary btn-sm" onClick={() => setDetail(null)}>Close</button>
          </div>
        </div> : null}>
        {detail && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={detail.status} /><Badge tone="brand">{detail.departmentName ?? 'No department'}</Badge></div>
            <p className="text-sm text-ink-600">{detail.description ?? 'No description.'}</p>
            <ProgressBar value={detail.progress} label="Overall progress" />

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <SectionHeader title={`Milestones (${detail.milestones.length})`} />
                <div className="mt-2 space-y-1.5">
                  {detail.milestones.map((item) => (
                    <label key={item.id} className="flex items-start gap-2 rounded-lg border border-ink-200 px-2.5 py-2 text-sm">
                      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={item.status === 'completed'} onChange={async () => {
                        try {
                          await api.patch(`/projects/${detail.id}/milestones/${item.id}`);
                          await openDetail(detail.id);
                        } catch (caught) { toast.error(errorMessage(caught)); }
                      }} />
                      <span className={item.status === 'completed' ? 'text-ink-400 line-through' : 'text-ink-700'}>{item.title}<span className="ml-1 text-[11px] text-ink-400">{item.dueDate ?? ''}</span></span>
                    </label>
                  ))}
                  {has('projects.manage') && (
                    <form className="flex gap-2" onSubmit={async (event) => {
                      event.preventDefault();
                      try {
                        await api.post(`/projects/${detail.id}/milestones`, { title: milestone.title, dueDate: milestone.dueDate || null });
                        setMilestone({ title: '', dueDate: '' });
                        await openDetail(detail.id);
                      } catch (caught) { toast.error(errorMessage(caught)); }
                    }}>
                      <input className="input" placeholder="New milestone" value={milestone.title} onChange={(event) => setMilestone({ ...milestone, title: event.target.value })} required />
                      <input type="date" className="input w-36" value={milestone.dueDate} onChange={(event) => setMilestone({ ...milestone, dueDate: event.target.value })} />
                      <button type="submit" className="btn-secondary btn-sm">Add</button>
                    </form>
                  )}
                </div>
              </div>

              <div>
                <SectionHeader title={`Team (${detail.members.length})`} />
                <div className="mt-2 space-y-1">
                  {detail.members.map((member) => (
                    <div key={member.employeeId} className="flex items-center gap-2 rounded-lg border border-ink-100 px-2 py-1.5">
                      <Avatar name={member.name} src={member.photoUrl} size={26} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink-800">{member.name}</p>
                        <p className="truncate text-[11px] text-ink-400">{member.designation ?? ''}</p>
                      </div>
                      <Badge tone="neutral">{titleize(member.projectRole)}</Badge>
                    </div>
                  ))}
                  {has('projects.manage') && (
                    <form className="flex gap-2" onSubmit={async (event) => {
                      event.preventDefault();
                      const select = event.currentTarget.elements.namedItem('member') as HTMLSelectElement;
                      if (!select.value) return;
                      try {
                        await api.post(`/projects/${detail.id}/members`, { employeeId: Number(select.value) });
                        select.value = '';
                        await openDetail(detail.id);
                      } catch (caught) { toast.error(errorMessage(caught)); }
                    }}>
                      <select name="member" className="input">
                        <option value="">Add team member…</option>
                        {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}
                      </select>
                      <button type="submit" className="btn-secondary btn-sm">Add</button>
                    </form>
                  )}
                </div>
              </div>
            </div>

            <div>
              <SectionHeader title={`Project tasks (${detail.tasks.length})`} />
              <div className="mt-2 overflow-x-auto rounded-lg border border-ink-200">
                <table className="table-base">
                  <thead><tr><th>Task</th><th>Assignees</th><th>Status</th><th>Progress</th><th>Due</th></tr></thead>
                  <tbody>
                    {detail.tasks.map((task) => (
                      <tr key={task.id}>
                        <td><Link to={`/tasks?task=${task.id}`} className="font-medium text-brand-700 hover:underline">{task.title}</Link><p className="text-xs text-ink-400">{task.taskNo}</p></td>
                        <td className="text-ink-600">{task.assigneeNames ?? '—'}</td>
                        <td><StatusBadge status={task.status} /></td>
                        <td className="w-24"><ProgressBar value={task.progress} /></td>
                        <td className="text-xs text-ink-500">{task.dueDate ? formatDate(task.dueDate) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <CreateProject open={createOpen} onClose={() => setCreateOpen(false)} employees={employees} onCreated={() => { setCreateOpen(false); void load(); }} />
    </div>
  );
}

function CreateProject({ open, onClose, employees, onCreated }: { open: boolean; onClose: () => void; employees: PickerEmployee[]; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', code: '', description: '', managerId: '', startDate: '', endDate: '' });
  const [members, setMembers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/projects', {
        name: form.name,
        code: form.code || undefined,
        description: form.description || undefined,
        managerId: form.managerId ? Number(form.managerId) : null,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        memberIds: members,
      });
      toast.success('Project created.');
      setForm({ name: '', code: '', description: '', managerId: '', startDate: '', endDate: '' });
      setMembers([]);
      onCreated();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create project" size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" form="project-form" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></>}>
      <form id="project-form" onSubmit={submit} className="space-y-4">
        <Field label="Project name" required><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} minLength={3} required /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code"><input className="input" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="Auto-generated if blank" /></Field>
          <Field label="Project manager">
            <select className="input" value={form.managerId} onChange={(event) => setForm({ ...form, managerId: event.target.value })}>
              <option value="">Select manager</option>
              {employees.filter((e) => !e.full_name.toLowerCase().includes('gagan')).map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}
            </select>
          </Field>
          <Field label="Start date"><input type="date" className="input" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} /></Field>
          <Field label="End date"><input type="date" className="input" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} /></Field>
        </div>
        <Field label="Description"><textarea className="input min-h-[70px]" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        <div>
          <span className="label">Team members</span>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-ink-300 p-2">
            {employees.map((employee) => (
              <label key={employee.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-ink-50">
                <input type="checkbox" className="h-4 w-4" checked={members.includes(employee.id)} onChange={(event) => setMembers((prev) => (event.target.checked ? [...prev, employee.id] : prev.filter((id) => id !== employee.id)))} />
                {employee.full_name}
              </label>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}
