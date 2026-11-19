import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, Field, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime, titleize } from '../lib/format';

interface Role {
  id: number;
  name: string;
  slug: string;
  level: number;
  description: string | null;
  isSystem: boolean;
  employeeCount: number;
  permissions: number[];
  locations?: number[];
}

interface Permission {
  id: number;
  code: string;
  module: string;
  action: string;
  description: string | null;
}

interface RoleEmployee {
  id: number;
  employeeCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  photoUrl: string | null;
  status: string;
  departmentName: string | null;
  designationTitle: string | null;
  locationName: string | null;
  locationCode: string | null;
}

interface LocationItem {
  id: number;
  name: string;
  code: string;
  city: string | null;
}

interface AuditLogItem {
  id: number;
  action: string;
  module: string | null;
  details: string | null;
  ip: string | null;
  createdAt: string;
  actorName: string | null;
  actorCode: string | null;
  roleName: string | null;
  roleSlug: string | null;
  employeeName: string | null;
  employeeCode: string | null;
}

interface AllEmployeeOption {
  id: number;
  fullName: string;
  employeeCode: string;
  roleName: string;
  roleId: number;
}

const MATRIX_COLUMNS = [
  { key: 'view', label: 'View', match: ['view', 'history', 'review'] },
  { key: 'create', label: 'Create', match: ['create', 'make', 'apply', 'assign'] },
  { key: 'edit', label: 'Edit', match: ['edit', 'update', 'transfer', 'corrections'] },
  { key: 'delete', label: 'Delete', match: ['delete', 'remove'] },
  { key: 'approve', label: 'Approve', match: ['approve', 'receive', 'resolve'] },
  { key: 'export', label: 'Export', match: ['export'] },
  { key: 'manage', label: 'Manage', match: ['manage', 'configure', 'publish', 'moderate'] },
] as const;

const MODULE_DISPLAY_NAMES: Record<string, { label: string; icon: string; description: string }> = {
  calls: { label: 'Calling & WebRTC', icon: 'phone', description: 'Browser audio/video calling, dialer, and duration history' },
  notifications: { label: 'Notifications', icon: 'bell', description: 'Real-time alerts, push delivery, and announcements' },
  employees: { label: 'Employee Tracking', icon: 'users', description: 'Staff directory, profile details, and workforce surveillance' },
  reports: { label: 'Daily Reports (DER)', icon: 'report', description: 'Daily evaluation reports, hourly footfalls, and review metrics' },
  tasks: { label: 'Tasks & SOPs', icon: 'tasks', description: 'Task delegation, SOP workflows, and progress sign-offs' },
  attendance: { label: 'Attendance & Shifts', icon: 'clock', description: 'Check-in times, location geofencing, and shift schedules' },
  activity: { label: 'Workforce Activity', icon: 'activity', description: 'Live screen telemetry, idle monitoring, and device telemetry' },
  chat: { label: 'Messages & Chat', icon: 'chat', description: 'One-to-one direct messages and team department channels' },
  tickets: { label: 'Tickets & Helpdesk', icon: 'ticket', description: 'IT issues, maintenance requests, and problem resolution' },
  meetings: { label: 'Meetings & Video', icon: 'video', description: 'Virtual meeting scheduling and live multi-party conference' },
  kpi: { label: 'Performance & KPI', icon: 'kpi', description: 'Store performance metrics, targets, and employee reviews' },
  leave: { label: 'Leave & Absences', icon: 'leave', description: 'Leave applications, manager approvals, and leave balance' },
  projects: { label: 'Projects & Sourcing', icon: 'project', description: 'Project tracking, procurement, and store sourcing diverts' },
  collections: { label: 'Collections & Cash', icon: 'wallet', description: 'Cash register logs, invoice tracking, and reconciliation' },
  groups: { label: 'Groups & Teams', icon: 'users', description: 'Department clusters and working shift teams' },
  locations: { label: 'Branches & Stores', icon: 'building', description: 'Belagavi, Davanagere, Shivamogga, and Head Office' },
  roles: { label: 'Roles & Access (RBAC)', icon: 'shield', description: 'Hierarchical role levels and module permission rules' },
  settings: { label: 'System Settings', icon: 'settings', description: 'System parameters, email delivery, and security audit logs' },
};

export default function RolesAdmin() {
  useDocumentTitle('Roles & Access Control');
  const { has, user } = useAuth();
  const toast = useToast();

  const [roles, setRoles] = useState<Role[] | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'matrix' | 'tree' | 'employees' | 'locations' | 'audit'>('matrix');

  // Working state
  const [draftPermissions, setDraftPermissions] = useState<Set<number>>(new Set());
  const [roleLocations, setRoleLocations] = useState<Set<number>>(new Set());
  const [roleEmployees, setRoleEmployees] = useState<RoleEmployee[] | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[] | null>(null);
  const [allEmployees, setAllEmployees] = useState<AllEmployeeOption[]>([]);

  // Search & Filter
  const [roleFilter, setRoleFilter] = useState('');
  const [permSearch, setPermSearch] = useState('');
  const [busy, setBusy] = useState(false);

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedAssignEmpId, setSelectedAssignEmpId] = useState<string>('');
  const [migrationRoleId, setMigrationRoleId] = useState<string>('');
  const [roleForm, setRoleForm] = useState({ name: '', slug: '', level: 40, description: '' });

  const canManage =
    has('roles.manage') ||
    has('roles.edit') ||
    has('roles.create') ||
    has('org.manage') ||
    user?.roleSlug === 'super_admin' ||
    (user?.roleLevel ?? 0) >= 60;

  const loadData = async () => {
    try {
      const [roleData, locData] = await Promise.all([
        api.get<{ roles: Role[]; permissions: Permission[] }>('/employees/roles'),
        api.get<{ locations: LocationItem[] }>('/employees/allowed-locations').catch(() => ({ locations: [] })),
      ]);
      setRoles(roleData.roles);
      setPermissions(roleData.permissions);
      if (locData.locations?.length) setLocations(locData.locations);

      const roleParam = new URLSearchParams(window.location.search).get('role');
      const targetRole = roleParam ? roleData.roles.find((r) => String(r.id) === roleParam || r.slug === roleParam) : null;
      if (targetRole) {
        setSelectedRoleId(targetRole.id);
      } else if (selectedRoleId === null && roleData.roles.length > 0) {
        setSelectedRoleId(roleData.roles[0].id);
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRole = useMemo(() => roles?.find((r) => r.id === selectedRoleId) ?? null, [roles, selectedRoleId]);

  // Sync draft permissions whenever selected role changes
  useEffect(() => {
    if (selectedRole) {
      setDraftPermissions(new Set(selectedRole.permissions));
      setRoleLocations(new Set(selectedRole.locations || []));
      if (activeTab === 'employees') void loadRoleEmployees(selectedRole.id);
      if (activeTab === 'audit') void loadAuditLogs();
    }
  }, [selectedRoleId, selectedRole]);

  // Load employees for current role
  const loadRoleEmployees = async (roleId: number) => {
    try {
      const res = await api.get<{ employees: RoleEmployee[] }>(`/employees/roles/${roleId}/employees`);
      setRoleEmployees(res.employees);
    } catch {
      setRoleEmployees([]);
    }
  };

  // Load audit logs
  const loadAuditLogs = async () => {
    try {
      const res = await api.get<{ logs: AuditLogItem[] }>('/employees/roles/audit-logs');
      setAuditLogs(res.logs);
    } catch {
      setAuditLogs([]);
    }
  };

  // Load full employee list for assignment dropdown
  const loadAllEmployeesForAssignment = async () => {
    try {
      const res = await api.get<{ items: { id: number; fullName: string; employeeCode: string; roleName: string; roleId: number }[] }>('/employees?pageSize=200');
      setAllEmployees(res.items || []);
    } catch {
      /* ignore */
    }
  };

  // Group permissions by module
  const groupedModules = useMemo(() => {
    const map = new Map<string, Permission[]>();
    permissions.forEach((p) => {
      if (!map.has(p.module)) map.set(p.module, []);
      map.get(p.module)!.push(p);
    });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  // Filtered module list for tree view
  const filteredModules = useMemo(() => {
    if (!permSearch) return groupedModules;
    const lower = permSearch.toLowerCase();
    return groupedModules
      .map(([mod, perms]) => {
        const matching = perms.filter(
          (p) => p.code.toLowerCase().includes(lower) || (p.description && p.description.toLowerCase().includes(lower)),
        );
        return [mod, matching] as [string, Permission[]];
      })
      .filter(([, perms]) => perms.length > 0);
  }, [groupedModules, permSearch]);

  // Check if permissions are dirty
  const isDirty = useMemo(() => {
    if (!selectedRole) return false;
    if (draftPermissions.size !== selectedRole.permissions.length) return true;
    for (const id of draftPermissions) {
      if (!selectedRole.permissions.includes(id)) return true;
    }
    return false;
  }, [selectedRole, draftPermissions]);

  // Save permissions
  const handleSavePermissions = async () => {
    if (!selectedRole) return;
    setBusy(true);
    try {
      await api.put(`/employees/roles/${selectedRole.id}/permissions`, {
        permissionIds: [...draftPermissions],
      });
      toast.success(`Updated permissions for ${selectedRole.name}. Applied across the platform immediately.`);
      await loadData();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Save locations
  const handleSaveLocations = async () => {
    if (!selectedRole) return;
    setBusy(true);
    try {
      await api.put(`/employees/roles/${selectedRole.id}/locations`, {
        locationIds: [...roleLocations],
      });
      toast.success(`Updated location permissions for ${selectedRole.name}.`);
      await loadData();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Duplicate Role
  const handleDuplicateRole = async (roleId: number) => {
    if (!canManage) return;
    setBusy(true);
    try {
      const res = await api.post<{ id: number; name: string }>(`/employees/roles/${roleId}/duplicate`);
      toast.success(`Duplicated role as "${res.name}".`);
      await loadData();
      setSelectedRoleId(res.id);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Delete Role
  const handleDeleteRole = async () => {
    if (!selectedRole || !canManage) return;
    setBusy(true);
    try {
      const moveToParam = migrationRoleId ? `?moveTo=${migrationRoleId}` : '';
      await api.del(`/employees/roles/${selectedRole.id}${moveToParam}`);
      toast.success(`Role "${selectedRole.name}" has been deleted.`);
      setDeleteOpen(false);
      setSelectedRoleId(null);
      await loadData();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Assign Employee to Role
  const handleAssignEmployee = async () => {
    if (!selectedRole || !selectedAssignEmpId) return;
    setBusy(true);
    try {
      await api.post(`/employees/roles/${selectedRole.id}/employees`, {
        employeeId: Number(selectedAssignEmpId),
      });
      toast.success('Employee assigned to role.');
      setAssignOpen(false);
      setSelectedAssignEmpId('');
      await loadRoleEmployees(selectedRole.id);
      await loadData();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  // Unassign Employee
  const handleUnassignEmployee = async (employeeId: number) => {
    if (!selectedRole) return;
    try {
      await api.del(`/employees/roles/${selectedRole.id}/employees/${employeeId}`);
      toast.success('Employee unassigned from role.');
      await loadRoleEmployees(selectedRole.id);
      await loadData();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  // Helper to test if a matrix cell is checked
  const isCellChecked = (mod: string, colKey: string) => {
    const col = MATRIX_COLUMNS.find((c) => c.key === colKey);
    if (!col) return false;
    const modPerms = permissions.filter((p) => p.module === mod);
    const targetPerms = modPerms.filter((p) => col.match.some((m) => p.action.toLowerCase().includes(m) || p.code.toLowerCase().includes(m)));
    if (targetPerms.length === 0) return false;
    return targetPerms.every((p) => draftPermissions.has(p.id));
  };

  // Helper to toggle a matrix cell
  const toggleMatrixCell = (mod: string, colKey: string) => {
    if (!canManage) return;
    const col = MATRIX_COLUMNS.find((c) => c.key === colKey);
    if (!col) return;
    const modPerms = permissions.filter((p) => p.module === mod);
    const targetPerms = modPerms.filter((p) => col.match.some((m) => p.action.toLowerCase().includes(m) || p.code.toLowerCase().includes(m)));
    if (targetPerms.length === 0) return;

    const allChecked = targetPerms.every((p) => draftPermissions.has(p.id));
    setDraftPermissions((prev) => {
      const next = new Set(prev);
      targetPerms.forEach((p) => {
        if (allChecked) next.delete(p.id);
        else next.add(p.id);
      });
      return next;
    });
  };

  // Helper to toggle all permissions for a module
  const toggleAllModule = (mod: string) => {
    if (!canManage) return;
    const modPerms = permissions.filter((p) => p.module === mod);
    const allChecked = modPerms.every((p) => draftPermissions.has(p.id));
    setDraftPermissions((prev) => {
      const next = new Set(prev);
      modPerms.forEach((p) => {
        if (allChecked) next.delete(p.id);
        else next.add(p.id);
      });
      return next;
    });
  };

  // Select all or clear all
  const selectAll = () => {
    if (!canManage) return;
    setDraftPermissions(new Set(permissions.map((p) => p.id)));
  };
  const clearAll = () => {
    if (!canManage) return;
    setDraftPermissions(new Set());
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Role-Based Access Control (RBAC)"
        description="Configure granular module permissions, assign branch locations, manage calling and notification authorization."
        actions={
          canManage ? (
            <button
              type="button"
              className="btn-primary btn-sm flex items-center gap-1.5 shadow-sm"
              onClick={() => {
                setRoleForm({ name: '', slug: '', level: 40, description: '' });
                setCreateOpen(true);
              }}
            >
              <Icon name="plus" size={16} /> Create Role
            </button>
          ) : undefined
        }
      />

      {!roles ? (
        <Card className="card-pad"><Skeleton lines={8} /></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* Left Panel: Role List & Navigation */}
          <Card className="flex flex-col h-[750px] overflow-hidden">
            <div className="p-3 border-b border-ink-100 bg-ink-50/50">
              <div className="relative">
                <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  className="input pl-8 py-1.5 text-xs w-full"
                  placeholder="Search roles..."
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-ink-50">
              {roles
                .filter((r) => `${r.name} ${r.slug}`.toLowerCase().includes(roleFilter.toLowerCase()))
                .map((role) => {
                  const isSelected = selectedRoleId === role.id;
                  return (
                    <div
                      key={role.id}
                      onClick={() => setSelectedRoleId(role.id)}
                      className={cx(
                        'p-3.5 cursor-pointer transition-all border-l-4 flex flex-col gap-1.5',
                        isSelected
                          ? 'border-brand-600 bg-brand-50/60 shadow-sm'
                          : 'border-transparent hover:bg-ink-50/70',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-sm text-ink-900 truncate">{role.name}</span>
                        <div className="flex items-center gap-1">
                          {role.isSystem && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                              System
                            </span>
                          )}
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-ink-100 text-ink-700">
                            Lvl {role.level}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs text-ink-500">
                        <span className="font-mono text-[11px] text-ink-400">{role.slug}</span>
                        <div className="flex items-center gap-2">
                          <span className="flex items-center gap-1 text-[11px]">
                            <Icon name="users" size={12} className="text-ink-400" />
                            {role.employeeCount}
                          </span>
                          <span className="flex items-center gap-1 text-[11px] font-medium text-brand-600">
                            <Icon name="shield" size={12} />
                            {role.permissions.length}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Quick stats footer */}
            <div className="p-3 border-t border-ink-100 bg-ink-50/70 text-xs text-ink-500 flex items-center justify-between">
              <span>{roles.length} Roles Registered</span>
              <span className="font-medium text-ink-700">{permissions.length} System Permissions</span>
            </div>
          </Card>

          {/* Right Panel: Selected Role Details & Multi-Tab Workspace */}
          <div className="flex flex-col gap-4">
            {!selectedRole ? (
              <Card className="card-pad text-center py-20 text-ink-500">
                <Icon name="shield" size={40} className="mx-auto text-ink-300 mb-2" />
                <p className="text-sm font-semibold">Select a role from the left list to inspect its permissions.</p>
              </Card>
            ) : (
              <>
                {/* Role Header Banner */}
                <Card className="p-4 bg-white border border-ink-200 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-brand-600 to-brand-700 flex items-center justify-center text-white shadow-sm">
                        <Icon name="shield" size={24} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="text-lg font-bold text-ink-900">{selectedRole.name}</h2>
                          <Badge tone="brand">Level {selectedRole.level}</Badge>
                          {selectedRole.isSystem && <Badge tone="warning">System Role</Badge>}
                        </div>
                        <p className="text-xs text-ink-500 mt-0.5">
                          Identifier: <code className="font-mono bg-ink-100 px-1 py-0.5 rounded text-ink-700">{selectedRole.slug}</code>
                          {selectedRole.description ? ` · ${selectedRole.description}` : ''}
                        </p>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={cx(
                          'btn-sm flex items-center gap-1.5 shadow-sm',
                          isDirty ? 'btn-primary animate-pulse' : 'btn-secondary',
                        )}
                        disabled={!isDirty || busy || !canManage}
                        onClick={handleSavePermissions}
                      >
                        <Icon name="save" size={15} />
                        {busy ? 'Saving…' : isDirty ? 'Save Changes *' : 'Saved'}
                      </button>

                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="btn-secondary btn-sm flex items-center gap-1"
                            title="Duplicate this role"
                            onClick={() => handleDuplicateRole(selectedRole.id)}
                            disabled={busy}
                          >
                            <Icon name="plus" size={14} /> Duplicate
                          </button>

                          <button
                            type="button"
                            className="btn-secondary btn-sm flex items-center gap-1"
                            title="Edit role metadata"
                            onClick={() => {
                              setRoleForm({
                                name: selectedRole.name,
                                slug: selectedRole.slug,
                                level: selectedRole.level,
                                description: selectedRole.description || '',
                              });
                              setEditOpen(true);
                            }}
                          >
                            <Icon name="edit" size={14} /> Edit
                          </button>

                          {!selectedRole.isSystem && selectedRole.slug !== 'super_admin' && (
                            <button
                              type="button"
                              className="btn-secondary btn-sm text-red-600 hover:bg-red-50 flex items-center gap-1"
                              title="Delete this role"
                              onClick={() => {
                                setMigrationRoleId(
                                  roles.find((r) => r.id !== selectedRole.id)?.id ? String(roles.find((r) => r.id !== selectedRole.id)!.id) : '',
                                );
                                setDeleteOpen(true);
                              }}
                            >
                              <Icon name="trash" size={14} /> Delete
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Tabs */}
                  <div className="mt-4 pt-3 border-t border-ink-100">
                    <Tabs
                      tabs={[
                        { value: 'matrix', label: `Permission Matrix (${draftPermissions.size})` },
                        { value: 'tree', label: 'Detailed Module Tree' },
                        { value: 'employees', label: `Assigned Employees (${selectedRole.employeeCount})` },
                        { value: 'locations', label: `Branch Access (${roleLocations.size || 'All'})` },
                        { value: 'audit', label: 'Permission Audit Logs' },
                      ]}
                      value={activeTab}
                      onChange={(val) => {
                        setActiveTab(val as typeof activeTab);
                        if (val === 'employees') void loadRoleEmployees(selectedRole.id);
                        if (val === 'audit') void loadAuditLogs();
                      }}
                    />
                  </div>
                </Card>

                {/* TAB 1: PERMISSION MATRIX */}
                {activeTab === 'matrix' && (
                  <Card className="overflow-hidden border border-ink-200">
                    <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-ink-50/70 border-b border-ink-100">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-ink-700">Granular Module Permission Matrix</p>
                        <p className="text-[11px] text-ink-500">Toggle permissions individually or per module category.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button type="button" className="btn-secondary btn-xs" onClick={selectAll} disabled={!canManage}>
                          Select All
                        </button>
                        <button type="button" className="btn-secondary btn-xs" onClick={clearAll} disabled={!canManage}>
                          Clear All
                        </button>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-ink-100/60 border-b border-ink-200 text-ink-700 font-semibold">
                            <th className="py-2.5 px-3 min-w-[200px]">Module</th>
                            {MATRIX_COLUMNS.map((col) => (
                              <th key={col.key} className="py-2.5 px-3 text-center min-w-[75px]">
                                {col.label}
                              </th>
                            ))}
                            <th className="py-2.5 px-3 text-center min-w-[80px]">Category All</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {groupedModules.map(([mod, modPerms]) => {
                            const info = MODULE_DISPLAY_NAMES[mod] || { label: titleize(mod), icon: 'shield', description: `${mod} actions` };
                            const isAllModChecked = modPerms.every((p) => draftPermissions.has(p.id));
                            return (
                              <tr key={mod} className="hover:bg-ink-50/60 transition-colors">
                                <td className="py-2.5 px-3">
                                  <div className="flex items-center gap-2">
                                    <div className="h-7 w-7 rounded-lg bg-ink-100 text-ink-600 flex items-center justify-center shrink-0">
                                      <Icon name={info.icon} size={15} />
                                    </div>
                                    <div>
                                      <p className="font-semibold text-ink-900">{info.label}</p>
                                      <p className="text-[10px] text-ink-400 font-mono">{mod} ({modPerms.length} perms)</p>
                                    </div>
                                  </div>
                                </td>

                                {MATRIX_COLUMNS.map((col) => {
                                  const matches = modPerms.filter((p) =>
                                    col.match.some((m) => p.action.toLowerCase().includes(m) || p.code.toLowerCase().includes(m)),
                                  );
                                  const exists = matches.length > 0;
                                  const checked = isCellChecked(mod, col.key);

                                  return (
                                    <td key={col.key} className="py-2 px-3 text-center">
                                      {exists ? (
                                        <label className="inline-flex items-center justify-center cursor-pointer">
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500 cursor-pointer disabled:opacity-50"
                                            checked={checked}
                                            disabled={!canManage}
                                            onChange={() => toggleMatrixCell(mod, col.key)}
                                          />
                                        </label>
                                      ) : (
                                        <span className="text-ink-300 font-mono text-[10px]">—</span>
                                      )}
                                    </td>
                                  );
                                })}

                                <td className="py-2 px-3 text-center">
                                  <button
                                    type="button"
                                    className={cx(
                                      'px-2 py-0.5 rounded text-[11px] font-medium transition',
                                      isAllModChecked ? 'bg-brand-50 text-brand-700 border border-brand-200' : 'bg-ink-100 text-ink-600 hover:bg-ink-200',
                                    )}
                                    disabled={!canManage}
                                    onClick={() => toggleAllModule(mod)}
                                  >
                                    {isAllModChecked ? 'Full Access' : 'Toggle'}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}

                {/* TAB 2: DETAILED MODULE TREE */}
                {activeTab === 'tree' && (
                  <Card className="card-pad space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <input
                        className="input max-w-sm text-xs"
                        placeholder="Search specific permission codes (e.g. calls.make, reports.approve)..."
                        value={permSearch}
                        onChange={(e) => setPermSearch(e.target.value)}
                      />
                      <span className="text-xs text-ink-500 font-mono">
                        {draftPermissions.size} / {permissions.length} granted
                      </span>
                    </div>

                    <div className="space-y-4">
                      {filteredModules.map(([moduleName, modulePermissions]) => {
                        const allSelected = modulePermissions.every((p) => draftPermissions.has(p.id));
                        const info = MODULE_DISPLAY_NAMES[moduleName] || { label: titleize(moduleName), icon: 'shield', description: '' };
                        return (
                          <div key={moduleName} className="rounded-xl border border-ink-200 overflow-hidden">
                            <div className="flex items-center justify-between gap-2 border-b border-ink-100 bg-ink-50 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Icon name={info.icon} size={16} className="text-brand-600" />
                                <span className="text-xs font-bold uppercase tracking-wider text-ink-700">{info.label}</span>
                                <span className="text-[11px] text-ink-400 font-mono">({modulePermissions.length})</span>
                              </div>
                              <label className="flex items-center gap-1.5 text-xs text-ink-600 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded text-brand-600"
                                  checked={allSelected}
                                  disabled={!canManage}
                                  onChange={(e) => {
                                    setDraftPermissions((prev) => {
                                      const next = new Set(prev);
                                      modulePermissions.forEach((p) => {
                                        if (e.target.checked) next.add(p.id);
                                        else next.delete(p.id);
                                      });
                                      return next;
                                    });
                                  }}
                                />
                                Select all
                              </label>
                            </div>

                            <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
                              {modulePermissions.map((permission) => (
                                <label
                                  key={permission.id}
                                  className={cx(
                                    'flex items-start gap-2.5 p-2 rounded-lg border transition-all cursor-pointer',
                                    draftPermissions.has(permission.id)
                                      ? 'border-brand-200 bg-brand-50/40 text-ink-900'
                                      : 'border-ink-100 hover:bg-ink-50/50 text-ink-600',
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                                    checked={draftPermissions.has(permission.id)}
                                    disabled={!canManage}
                                    onChange={(e) => {
                                      setDraftPermissions((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(permission.id);
                                        else next.delete(permission.id);
                                        return next;
                                      });
                                    }}
                                  />
                                  <div className="min-w-0">
                                    <p className="font-mono text-xs font-semibold text-ink-800 truncate">{permission.code}</p>
                                    <p className="text-[11px] text-ink-500 line-clamp-2 mt-0.5">
                                      {permission.description || `Permits ${permission.action} on ${permission.module}`}
                                    </p>
                                  </div>
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                )}

                {/* TAB 3: ASSIGNED EMPLOYEES */}
                {activeTab === 'employees' && (
                  <Card className="card-pad space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-bold text-ink-900">Employees with "{selectedRole.name}" Role</h4>
                        <p className="text-xs text-ink-500">
                          Employees currently assigned to this role inheriting its permissions.
                        </p>
                      </div>
                      {canManage && (
                        <button
                          type="button"
                          className="btn-primary btn-sm flex items-center gap-1.5"
                          onClick={() => {
                            void loadAllEmployeesForAssignment();
                            setAssignOpen(true);
                          }}
                        >
                          <Icon name="plus" size={15} /> Assign Employee
                        </button>
                      )}
                    </div>

                    {!roleEmployees ? (
                      <Skeleton lines={5} />
                    ) : roleEmployees.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-ink-200 p-8 text-center text-ink-500">
                        <Icon name="users" size={32} className="mx-auto text-ink-300 mb-2" />
                        <p className="text-sm font-medium">No employees currently assigned to this role.</p>
                        <p className="text-xs text-ink-400 mt-1">Use the "Assign Employee" button to assign staff to this role.</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto rounded-lg border border-ink-200">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-ink-50 border-b border-ink-200 text-ink-600 font-semibold">
                            <tr>
                              <th className="p-3">Employee</th>
                              <th className="p-3">Designation</th>
                              <th className="p-3">Department</th>
                              <th className="p-3">Branch Location</th>
                              <th className="p-3">Status</th>
                              {canManage && <th className="p-3 text-right">Actions</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-ink-100">
                            {roleEmployees.map((emp) => (
                              <tr key={emp.id} className="hover:bg-ink-50/50">
                                <td className="p-3">
                                  <div className="flex items-center gap-2.5">
                                    <Avatar name={emp.fullName} src={emp.photoUrl} size={32} />
                                    <div>
                                      <p className="font-semibold text-ink-900">{emp.fullName}</p>
                                      <p className="font-mono text-[11px] text-ink-400">{emp.employeeCode} · {emp.email}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="p-3 text-ink-700">{emp.designationTitle || '—'}</td>
                                <td className="p-3 text-ink-700">{emp.departmentName || '—'}</td>
                                <td className="p-3">
                                  <span className="inline-flex items-center gap-1 font-medium text-ink-800 bg-ink-100 px-2 py-0.5 rounded">
                                    <Icon name="building" size={12} className="text-ink-500" />
                                    {emp.locationCode || 'HQ'} · {emp.locationName || 'Head Office'}
                                  </span>
                                </td>
                                <td className="p-3">
                                  <Badge tone={emp.status === 'active' ? 'success' : 'neutral'}>{emp.status}</Badge>
                                </td>
                                {canManage && (
                                  <td className="p-3 text-right">
                                    <button
                                      type="button"
                                      className="text-red-600 hover:text-red-700 font-medium text-xs hover:underline"
                                      onClick={() => handleUnassignEmployee(emp.id)}
                                    >
                                      Unassign
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                )}

                {/* TAB 4: LOCATION ACCESS */}
                {activeTab === 'locations' && (
                  <Card className="card-pad space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-sm font-bold text-ink-900">Branch & Location Access Configuration</h4>
                        <p className="text-xs text-ink-500">
                          Control which store locations employees in this role can view, call, or manage.
                        </p>
                      </div>
                      {canManage && (
                        <button type="button" className="btn-primary btn-sm" onClick={handleSaveLocations} disabled={busy}>
                          {busy ? 'Saving…' : 'Save Location Access'}
                        </button>
                      )}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 pt-2">
                      {locations.map((loc) => {
                        const checked = roleLocations.has(loc.id);
                        return (
                          <div
                            key={loc.id}
                            onClick={() => {
                              if (!canManage) return;
                              setRoleLocations((prev) => {
                                const next = new Set(prev);
                                if (checked) next.delete(loc.id);
                                else next.add(loc.id);
                                return next;
                              });
                            }}
                            className={cx(
                              'p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between',
                              checked
                                ? 'border-brand-500 bg-brand-50/50 shadow-sm'
                                : 'border-ink-200 hover:bg-ink-50/70',
                            )}
                          >
                            <div className="flex items-start justify-between">
                              <div className="h-10 w-10 rounded-xl bg-ink-100 flex items-center justify-center text-ink-700">
                                <Icon name="building" size={20} />
                              </div>
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded text-brand-600 focus:ring-brand-500 cursor-pointer"
                                checked={checked}
                                onChange={() => undefined}
                                disabled={!canManage}
                              />
                            </div>
                            <div className="mt-3">
                              <span className="font-mono text-xs font-bold text-brand-700 bg-brand-100/70 px-1.5 py-0.5 rounded">
                                {loc.code}
                              </span>
                              <h5 className="font-semibold text-sm text-ink-900 mt-1">{loc.name}</h5>
                              <p className="text-xs text-ink-500">{loc.city || 'Karnataka'}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg text-xs text-blue-900 flex items-center gap-2">
                      <Icon name="info" size={16} className="text-blue-600 shrink-0" />
                      <span>
                        When no specific locations are checked, the role follows standard cross-branch policies or default primary store assignment.
                      </span>
                    </div>
                  </Card>
                )}

                {/* TAB 5: AUDIT LOGS */}
                {activeTab === 'audit' && (
                  <Card className="card-pad space-y-4">
                    <div>
                      <h4 className="text-sm font-bold text-ink-900">Permission & Role Audit Trail</h4>
                      <p className="text-xs text-ink-500">
                        Chronological record of permissions, role duplication, assignment, and authorization changes.
                      </p>
                    </div>

                    {!auditLogs ? (
                      <Skeleton lines={6} />
                    ) : auditLogs.length === 0 ? (
                      <div className="p-8 text-center text-xs text-ink-500">No permission audit records found.</div>
                    ) : (
                      <div className="divide-y divide-ink-100 rounded-lg border border-ink-200">
                        {auditLogs.map((log) => (
                          <div key={log.id} className="p-3 flex items-start justify-between gap-3 text-xs">
                            <div className="flex items-start gap-2.5">
                              <div className="h-7 w-7 rounded-lg bg-ink-100 flex items-center justify-center text-ink-600 shrink-0 mt-0.5">
                                <Icon name="shield" size={14} />
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-ink-900">{log.action}</span>
                                  {log.module && <Badge tone="neutral">{log.module}</Badge>}
                                  {log.roleName && <span className="font-medium text-brand-700">Role: {log.roleName}</span>}
                                </div>
                                <p className="text-ink-500 mt-0.5">
                                  By: {log.actorName || 'System Admin'} ({log.actorCode || 'HQ'})
                                  {log.employeeName ? ` · Target: ${log.employeeName}` : ''}
                                  {log.details ? ` · ${log.details}` : ''}
                                </p>
                              </div>
                            </div>
                            <span className="font-mono text-[11px] text-ink-400 shrink-0">
                              {formatDateTime(log.createdAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* CREATE ROLE MODAL */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Workforce Role"
        description="Add a new custom role with custom hierarchy level. Permissions can be assigned after creation."
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button className="btn-primary" form="create-role-form" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create Role'}
            </button>
          </>
        }
      >
        <form
          id="create-role-form"
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const res = await api.post<{ id: number }>('/employees/roles', {
                ...roleForm,
                level: Number(roleForm.level),
              });
              toast.success('Role created successfully.');
              setCreateOpen(false);
              await loadData();
              setSelectedRoleId(res.id);
            } catch (caught) {
              toast.error(errorMessage(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Role Name" required>
            <input
              className="input"
              value={roleForm.name}
              onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
              placeholder="e.g. Senior Store Auditor"
              required
            />
          </Field>
          <Field label="Role Identifier (Slug)" required hint="Lowercase letters, numbers, and underscores">
            <input
              className="input font-mono"
              value={roleForm.slug}
              onChange={(e) => setRoleForm({ ...roleForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              placeholder="e.g. senior_store_auditor"
              required
            />
          </Field>
          <Field label="Hierarchy Level (1 - 99)" hint="Higher level roles sit above lower levels in reports and approval hierarchy">
            <input
              type="number"
              min={1}
              max={99}
              className="input"
              value={roleForm.level}
              onChange={(e) => setRoleForm({ ...roleForm, level: Number(e.target.value) })}
            />
          </Field>
          <Field label="Description">
            <textarea
              className="input min-h-[60px]"
              value={roleForm.description}
              onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
              placeholder="Brief description of role duties and authority"
            />
          </Field>
        </form>
      </Modal>

      {/* EDIT ROLE MODAL */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit Role Details"
        description="Update role title, slug, or hierarchy level."
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditOpen(false)}>Cancel</button>
            <button className="btn-primary" form="edit-role-form" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save Details'}
            </button>
          </>
        }
      >
        <form
          id="edit-role-form"
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!selectedRole) return;
            setBusy(true);
            try {
              await api.patch(`/employees/roles/${selectedRole.id}`, {
                name: roleForm.name,
                slug: roleForm.slug,
                level: Number(roleForm.level),
                description: roleForm.description,
              });
              toast.success('Role details updated.');
              setEditOpen(false);
              await loadData();
            } catch (caught) {
              toast.error(errorMessage(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Role Name" required>
            <input className="input" value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} required />
          </Field>
          <Field label="Role Slug" required>
            <input className="input font-mono" value={roleForm.slug} onChange={(e) => setRoleForm({ ...roleForm, slug: e.target.value })} required />
          </Field>
          <Field label="Hierarchy Level">
            <input
              type="number"
              min={1}
              max={selectedRole?.slug === 'super_admin' ? 100 : 99}
              className="input"
              value={roleForm.level}
              onChange={(e) => setRoleForm({ ...roleForm, level: Number(e.target.value) })}
            />
          </Field>
          <Field label="Description">
            <textarea className="input min-h-[60px]" value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })} />
          </Field>
        </form>
      </Modal>

      {/* DELETE ROLE MODAL */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete Role "${selectedRole?.name}"`}
        description={
          (selectedRole?.employeeCount || 0) > 0
            ? `Warning: ${selectedRole?.employeeCount} active employee(s) are assigned to this role. You must select a replacement role to transfer them to before deleting.`
            : 'Are you sure you want to permanently delete this custom role?'
        }
        footer={
          <>
            <button className="btn-secondary" onClick={() => setDeleteOpen(false)}>Cancel</button>
            <button className="btn-danger" onClick={handleDeleteRole} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete Role'}
            </button>
          </>
        }
      >
        {(selectedRole?.employeeCount || 0) > 0 && (
          <Field label="Transfer Assigned Employees To" required>
            <select
              className="input"
              value={migrationRoleId}
              onChange={(e) => setMigrationRoleId(e.target.value)}
              required
            >
              <option value="">Select Replacement Role…</option>
              {(roles || [])
                .filter((r) => r.id !== selectedRole?.id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} (Level {r.level})
                  </option>
                ))}
            </select>
          </Field>
        )}
      </Modal>

      {/* ASSIGN EMPLOYEE MODAL */}
      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title={`Assign Employee to "${selectedRole?.name}"`}
        description="Select an employee to assign or transfer to this role."
        footer={
          <>
            <button className="btn-secondary" onClick={() => setAssignOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleAssignEmployee} disabled={!selectedAssignEmpId || busy}>
              {busy ? 'Assigning…' : 'Assign Employee'}
            </button>
          </>
        }
      >
        <Field label="Select Employee" required>
          <select
            className="input"
            value={selectedAssignEmpId}
            onChange={(e) => setSelectedAssignEmpId(e.target.value)}
          >
            <option value="">Choose an employee…</option>
            {allEmployees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.fullName} ({emp.employeeCode}) — Current Role: {emp.roleName}
              </option>
            ))}
          </select>
        </Field>
      </Modal>
    </div>
  );
}
