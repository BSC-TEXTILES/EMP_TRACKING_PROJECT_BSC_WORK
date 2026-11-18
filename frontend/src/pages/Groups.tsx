import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { api, errorMessage } from '../lib/api';
import { cx, formatDateTime } from '../lib/format';
import { Avatar, Badge, Card, EmptyState, Field, Modal, StatCard } from '../components/ui';
import { Icon } from '../components/icons';
import type { EmployeeRow } from '../lib/types';

export interface WorkforceGroupItem {
  id: number;
  locationId: number;
  code: string;
  name: string;
  description: string | null;
  managerId: number | null;
  teamLeaderId: number | null;
  isActive: boolean;
  locationName: string;
  locationCode: string;
  managerName: string | null;
  managerCode: string | null;
  teamLeaderName: string | null;
  teamLeaderCode: string | null;
  memberCount: number;
  presentTodayCount: number;
  createdAt: string;
}

export interface GroupMemberItem {
  id: number;
  groupId: number;
  employeeId: number;
  role: string;
  fullName: string;
  employeeCode: string;
  email: string;
  mobile: string;
  designationTitle: string | null;
  departmentName: string | null;
  photoUrl: string | null;
  status: string;
  attendanceStatus: string | null;
  checkInAt: string | null;
}

export interface LocationItem {
  id: number;
  code: string;
  name: string;
  city: string | null;
}

export interface AuditLogItem {
  id: number;
  actorName: string;
  action: string;
  entityType: string;
  fromLocationCode: string | null;
  toLocationCode: string | null;
  fromGroupName: string | null;
  toGroupName: string | null;
  reason: string | null;
  createdAt: string;
}

export default function Groups() {
  const toast = useToast();
  const { user } = useAuth();

  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [groups, setGroups] = useState<WorkforceGroupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  // Stats
  const [summary, setSummary] = useState<{
    totalEmployees: number;
    presentEmployees: number;
    onlineEmployees: number;
    workingEmployees: number;
  } | null>(null);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<WorkforceGroupItem | null>(null);
  const [transferTarget, setTransferTarget] = useState<WorkforceGroupItem | null>(null);
  const [membersTarget, setMembersTarget] = useState<WorkforceGroupItem | null>(null);
  const [membersList, setMembersList] = useState<GroupMemberItem[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [auditModalOpen, setAuditModalOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Form states
  const [groupForm, setGroupForm] = useState({
    locationId: '',
    name: '',
    code: '',
    description: '',
    managerId: '',
    teamLeaderId: '',
  });
  const [transferForm, setTransferForm] = useState({
    targetLocationId: '',
    reason: '',
  });
  const [availableEmployees, setAvailableEmployees] = useState<EmployeeRow[]>([]);
  const [selectedAddMemberId, setSelectedAddMemberId] = useState('');
  const [busyAction, setBusyAction] = useState(false);

  const canManageGroups =
    (user?.roleLevel ?? 0) >= 50 ||
    user?.roleSlug === 'super_admin' ||
    user?.permissions.includes('groups.manage') ||
    user?.permissions.includes('locations.manage');

  // Load authorized locations
  const loadLocations = async () => {
    try {
      const res = await api.get<{ locations: LocationItem[] }>('/employees/allowed-locations');
      setLocations(res.locations);
      if (res.locations.length > 0 && selectedLocationId === null) {
        // Default to user's assigned location or first available
        const userLoc = res.locations.find((l) => l.code === user?.locationCode || l.id === user?.locationId);
        setSelectedLocationId(userLoc ? userLoc.id : res.locations[0].id);
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  // Load groups
  const loadGroups = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedLocationId) params.set('locationId', String(selectedLocationId));
      if (!showInactive) params.set('isActive', 'true');
      if (search.trim()) params.set('search', search.trim());

      const res = await api.get<{ items: WorkforceGroupItem[] }>(`/groups?${params.toString()}`);
      setGroups(res.items ?? []);

      // Load summary
      const sumRes = await api.get<{
        summary: {
          totalEmployees: number;
          presentEmployees: number;
          onlineEmployees: number;
          workingEmployees: number;
        };
      }>(`/groups/dashboard/summary?${selectedLocationId ? `locationId=${selectedLocationId}` : ''}`);
      setSummary(sumRes.summary);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  // Load employees for picker (scoped to location)
  const loadEmployeesForLocation = async (locId: number | null) => {
    try {
      const params = new URLSearchParams({ pageSize: '150', status: 'active' });
      if (locId) params.set('locationId', String(locId));
      const res = await api.get<{ items: EmployeeRow[] }>(`/employees?${params.toString()}`);
      setAvailableEmployees(res.items);
    } catch {
      setAvailableEmployees([]);
    }
  };

  useEffect(() => {
    void loadLocations();
  }, []);

  useEffect(() => {
    if (locations.length > 0) {
      void loadGroups();
      void loadEmployeesForLocation(selectedLocationId);
    }
  }, [selectedLocationId, showInactive, locations]);

  // Open Manage Members
  const openManageMembers = async (grp: WorkforceGroupItem) => {
    setMembersTarget(grp);
    setMembersLoading(true);
    try {
      const res = await api.get<{ group: WorkforceGroupItem; members: GroupMemberItem[] }>(`/groups/${grp.id}`);
      setMembersList(res.members);
      await loadEmployeesForLocation(grp.locationId);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setMembersLoading(false);
    }
  };

  // Add Member to Group
  const handleAddMember = async () => {
    if (!membersTarget || !selectedAddMemberId) return;
    setBusyAction(true);
    try {
      await api.post(`/groups/${membersTarget.id}/members`, {
        employeeId: Number(selectedAddMemberId),
        role: 'member',
      });
      toast.success('Employee added to group successfully.');
      setSelectedAddMemberId('');
      await openManageMembers(membersTarget);
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Remove Member
  const handleRemoveMember = async (employeeId: number, name: string) => {
    if (!membersTarget) return;
    if (!window.confirm(`Remove ${name} from ${membersTarget.name}?`)) return;
    setBusyAction(true);
    try {
      await api.del(`/groups/${membersTarget.id}/members/${employeeId}`);
      toast.success(`${name} removed from group.`);
      await openManageMembers(membersTarget);
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Promote to Team Leader
  const handlePromoteTeamLeader = async (employeeId: number, name: string) => {
    if (!membersTarget) return;
    setBusyAction(true);
    try {
      await api.patch(`/groups/${membersTarget.id}`, { teamLeaderId: employeeId });
      toast.success(`${name} is now the Team Leader for ${membersTarget.name}.`);
      await openManageMembers(membersTarget);
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Create Group Submit
  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupForm.name.trim() || !groupForm.locationId) {
      toast.error('Group name and store location are required.');
      return;
    }
    setBusyAction(true);
    try {
      await api.post('/groups', {
        name: groupForm.name.trim(),
        code: groupForm.code.trim() || undefined,
        locationId: Number(groupForm.locationId),
        description: groupForm.description.trim() || undefined,
        managerId: groupForm.managerId ? Number(groupForm.managerId) : undefined,
        teamLeaderId: groupForm.teamLeaderId ? Number(groupForm.teamLeaderId) : undefined,
      });
      toast.success(`Group "${groupForm.name}" created successfully.`);
      setCreateModalOpen(false);
      setGroupForm({ locationId: '', name: '', code: '', description: '', managerId: '', teamLeaderId: '' });
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Edit Group Submit
  const handleEditGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    setBusyAction(true);
    try {
      await api.patch(`/groups/${editTarget.id}`, {
        name: groupForm.name.trim() || undefined,
        description: groupForm.description.trim() || undefined,
        managerId: groupForm.managerId ? Number(groupForm.managerId) : null,
        teamLeaderId: groupForm.teamLeaderId ? Number(groupForm.teamLeaderId) : null,
      });
      toast.success('Group updated successfully.');
      setEditTarget(null);
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Transfer Group Submit
  const handleTransferGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferTarget || !transferForm.targetLocationId) return;
    setBusyAction(true);
    try {
      await api.patch(`/groups/${transferTarget.id}`, {
        locationId: Number(transferForm.targetLocationId),
        reason: transferForm.reason.trim() || 'Location transfer by authorized administrator',
      });
      toast.success(`Group "${transferTarget.name}" transferred to new location.`);
      setTransferTarget(null);
      setTransferForm({ targetLocationId: '', reason: '' });
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Toggle Active State
  const handleToggleActive = async (grp: WorkforceGroupItem) => {
    const nextState = !grp.isActive;
    const actionLabel = nextState ? 'activate' : 'deactivate';
    if (!window.confirm(`Are you sure you want to ${actionLabel} "${grp.name}"?`)) return;
    setBusyAction(true);
    try {
      await api.patch(`/groups/${grp.id}`, { isActive: nextState });
      toast.success(`Group "${grp.name}" is now ${nextState ? 'active' : 'inactive'}.`);
      await loadGroups();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusyAction(false);
    }
  };

  // Open Audit Log
  const openAuditLogs = async () => {
    setAuditModalOpen(true);
    setAuditLoading(true);
    try {
      const res = await api.get<{ logs: AuditLogItem[] }>(
        `/groups/audit/logs?limit=50${selectedLocationId ? `&locationId=${selectedLocationId}` : ''}`,
      );
      setAuditLogs(res.logs);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAuditLoading(false);
    }
  };

  const filteredGroups = useMemo(() => {
    return groups.filter((g) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          g.name.toLowerCase().includes(q) ||
          g.code.toLowerCase().includes(q) ||
          (g.managerName && g.managerName.toLowerCase().includes(q)) ||
          (g.teamLeaderName && g.teamLeaderName.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [groups, search]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-ink-900">Workforce Groups & Teams</h1>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800">
              Location-Based
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-500">
            Strict location-controlled team hierarchy for Belagavi, Davanagere, Shivamogga, and Head Office.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm inline-flex items-center gap-1.5 cursor-pointer"
            onClick={openAuditLogs}
            title="View Location & Group Transfer Audit Logs"
          >
            <Icon name="shield" size={15} />
            <span>Audit Trail</span>
          </button>

          {canManageGroups && (
            <button
              type="button"
              className="btn-primary btn-sm inline-flex items-center gap-1.5 cursor-pointer"
              onClick={() => {
                setGroupForm({
                  locationId: selectedLocationId ? String(selectedLocationId) : (locations[0]?.id ? String(locations[0].id) : ''),
                  name: '',
                  code: '',
                  description: '',
                  managerId: '',
                  teamLeaderId: '',
                });
                setCreateModalOpen(true);
              }}
            >
              <Icon name="plus" size={15} />
              <span>Create Group</span>
            </button>
          )}
        </div>
      </div>

      {/* Location Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 pb-3">
        <span className="text-xs font-bold uppercase tracking-wider text-ink-400 mr-2 flex items-center gap-1">
          <Icon name="building" size={14} /> Store:
        </span>
        <button
          type="button"
          onClick={() => setSelectedLocationId(null)}
          className={cx(
            'flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer',
            selectedLocationId === null
              ? 'bg-blue-600 text-white shadow-xs'
              : 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-100',
          )}
        >
          <span>All Authorized Stores</span>
        </button>

        {locations.map((loc) => (
          <button
            key={loc.id}
            type="button"
            onClick={() => setSelectedLocationId(loc.id)}
            className={cx(
              'flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer',
              selectedLocationId === loc.id
                ? 'bg-blue-600 text-white shadow-xs'
                : 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-100',
            )}
          >
            <span className="font-mono font-bold">{loc.code}</span>
            <span>·</span>
            <span>{loc.name}</span>
          </button>
        ))}
      </div>

      {/* Workforce Summary KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Groups in View"
          value={filteredGroups.length}
          tone="brand"
          icon={<Icon name="users" size={18} />}
        />
        <StatCard
          label="Total Assigned Workforce"
          value={summary?.totalEmployees ?? 0}
          tone="neutral"
          icon={<Icon name="user" size={18} />}
        />
        <StatCard
          label="Present Today"
          value={summary?.presentEmployees ?? 0}
          tone="success"
          icon={<Icon name="check" size={18} />}
        />
        <StatCard
          label="Online Right Now"
          value={summary?.onlineEmployees ?? 0}
          tone="warning"
          icon={<Icon name="activity" size={18} />}
        />
      </div>

      {/* Search and Filters Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <input
            className="input pl-9 text-sm"
            placeholder="Search groups by name, code, manager, team leader…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="absolute left-3 top-2.5 text-ink-400">
            <Icon name="search" size={16} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-ink-300 text-blue-600 focus:ring-blue-500"
            />
            <span>Show inactive groups</span>
          </label>
        </div>
      </div>

      {/* Group Cards Grid */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="animate-pulse p-5 space-y-3">
              <div className="h-5 bg-ink-200 rounded w-1/3" />
              <div className="h-6 bg-ink-200 rounded w-2/3" />
              <div className="h-4 bg-ink-100 rounded w-1/2" />
            </Card>
          ))}
        </div>
      ) : filteredGroups.length === 0 ? (
        <EmptyState
          title="No groups found"
          description={
            search ? 'No groups match your search criteria.' : 'No workforce groups configured for this location yet.'
          }
          action={
            canManageGroups ? (
              <button
                type="button"
                className="btn-primary btn-sm inline-flex items-center gap-1.5"
                onClick={() => setCreateModalOpen(true)}
              >
                <Icon name="plus" size={14} />
                <span>Create Group</span>
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredGroups.map((grp) => (
            <div
              key={grp.id}
              className={cx(
                'group relative flex flex-col justify-between rounded-xl border bg-white p-5 shadow-2xs transition-all hover:border-blue-300 hover:shadow-md',
                grp.isActive ? 'border-ink-200' : 'border-ink-200 bg-ink-50/50 opacity-75',
              )}
            >
              <div>
                {/* Header row: Code & Location */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-extrabold uppercase tracking-wider text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                      {grp.code}
                    </span>
                    <Badge tone="brand">{grp.locationCode || grp.locationName}</Badge>
                  </div>
                  {!grp.isActive && <Badge tone="neutral">Inactive</Badge>}
                </div>

                {/* Group Title */}
                <h3 className="text-base font-bold text-ink-900 group-hover:text-blue-600 transition-colors">
                  {grp.name}
                </h3>
                {grp.description && <p className="mt-1 text-xs text-ink-500 line-clamp-2">{grp.description}</p>}

                {/* Group Hierarchy: Manager & Team Leader */}
                <div className="mt-4 space-y-2 border-t border-ink-100 pt-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-ink-400 font-medium">Group Manager:</span>
                    <span className="font-semibold text-ink-800">
                      {grp.managerName ? `${grp.managerName} (${grp.managerCode ?? 'EMP'})` : <span className="text-ink-400 italic">Unassigned</span>}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-ink-400 font-medium">Team Leader:</span>
                    <span className="font-semibold text-ink-800">
                      {grp.teamLeaderName ? `${grp.teamLeaderName} (${grp.teamLeaderCode ?? 'EMP'})` : <span className="text-ink-400 italic">Unassigned</span>}
                    </span>
                  </div>
                </div>

                {/* Members & Present Pill */}
                <div className="mt-4 flex items-center justify-between rounded-lg bg-ink-50/80 p-2.5 text-xs font-medium">
                  <div className="flex items-center gap-1.5 text-ink-700">
                    <Icon name="users" size={14} className="text-blue-600" />
                    <span>
                      <strong className="text-ink-900">{grp.memberCount}</strong> active members
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span>{grp.presentTodayCount} present today</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-5 border-t border-ink-100 pt-3 flex flex-wrap items-center justify-between gap-1.5">
                <button
                  type="button"
                  className="btn-primary btn-xs inline-flex items-center gap-1 cursor-pointer font-semibold"
                  onClick={() => openManageMembers(grp)}
                >
                  <Icon name="users" size={13} />
                  <span>Manage Members</span>
                </button>

                {canManageGroups && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title="Edit Group"
                      className="btn-secondary btn-xs inline-flex items-center gap-1 cursor-pointer"
                      onClick={() => {
                        setEditTarget(grp);
                        setGroupForm({
                          locationId: String(grp.locationId),
                          name: grp.name,
                          code: grp.code,
                          description: grp.description ?? '',
                          managerId: grp.managerId ? String(grp.managerId) : '',
                          teamLeaderId: grp.teamLeaderId ? String(grp.teamLeaderId) : '',
                        });
                        void loadEmployeesForLocation(grp.locationId);
                      }}
                    >
                      <Icon name="edit" size={13} />
                      <span>Edit</span>
                    </button>

                    <button
                      type="button"
                      title="Transfer Location"
                      className="btn-secondary btn-xs inline-flex items-center gap-1 cursor-pointer"
                      onClick={() => {
                        setTransferTarget(grp);
                        setTransferForm({ targetLocationId: '', reason: '' });
                      }}
                    >
                      <Icon name="send" size={13} />
                      <span>Transfer</span>
                    </button>

                    <button
                      type="button"
                      title={grp.isActive ? 'Deactivate Group' : 'Activate Group'}
                      className={cx(
                        'btn-xs inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-semibold cursor-pointer',
                        grp.isActive
                          ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                          : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50',
                      )}
                      onClick={() => handleToggleActive(grp)}
                    >
                      <span>{grp.isActive ? 'Deactivate' : 'Activate'}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* CREATE GROUP MODAL */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create New Workforce Group"
        description="Add a location-controlled team for floor sales, cashiering, inventory, or operational units."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              form="create-group-form"
              className="btn-primary"
              disabled={busyAction || !groupForm.name.trim() || !groupForm.locationId}
            >
              {busyAction ? 'Creating…' : 'Create Group'}
            </button>
          </>
        }
      >
        <form id="create-group-form" onSubmit={handleCreateGroup} className="space-y-3.5">
          <Field label="Store Location" required hint="Group will be strictly bound to this location">
            <select
              className="input font-medium"
              value={groupForm.locationId}
              onChange={(e) => {
                const locId = e.target.value;
                setGroupForm({ ...groupForm, locationId: locId, managerId: '', teamLeaderId: '' });
                if (locId) void loadEmployeesForLocation(Number(locId));
              }}
              required
            >
              <option value="">Select Store Location</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.code} – {loc.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Group Name" required hint="e.g. Group A - Floor Sales">
              <input
                className="input"
                placeholder="e.g. Group A - Floor Sales"
                value={groupForm.name}
                onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                required
              />
            </Field>

            <Field label="Group Code (Optional)" hint="e.g. BEL-GRP-A (auto-generated if empty)">
              <input
                className="input font-mono uppercase"
                placeholder="Leave blank for auto-code"
                value={groupForm.code}
                onChange={(e) => setGroupForm({ ...groupForm, code: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>

          <Field label="Description / Operational Scope">
            <textarea
              className="input min-h-[70px]"
              placeholder="e.g. Responsible for ground floor saree and suiting section sales, customer billing handover."
              value={groupForm.description}
              onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Assigned Group Manager">
              <select
                className="input"
                value={groupForm.managerId}
                onChange={(e) => setGroupForm({ ...groupForm, managerId: e.target.value })}
              >
                <option value="">Select Manager (Optional)</option>
                {availableEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} ({emp.employeeCode})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Assigned Team Leader">
              <select
                className="input"
                value={groupForm.teamLeaderId}
                onChange={(e) => setGroupForm({ ...groupForm, teamLeaderId: e.target.value })}
              >
                <option value="">Select Team Leader (Optional)</option>
                {availableEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} ({emp.employeeCode})
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </form>
      </Modal>

      {/* EDIT GROUP MODAL */}
      <Modal
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        title={`Edit ${editTarget?.name ?? 'Group'}`}
        description="Update operational parameters, group manager, or team leader."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditTarget(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="edit-group-form"
              className="btn-primary"
              disabled={busyAction || !groupForm.name.trim()}
            >
              {busyAction ? 'Saving…' : 'Save Changes'}
            </button>
          </>
        }
      >
        <form id="edit-group-form" onSubmit={handleEditGroup} className="space-y-3.5">
          <Field label="Group Name" required>
            <input
              className="input"
              value={groupForm.name}
              onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
              required
            />
          </Field>

          <Field label="Description">
            <textarea
              className="input min-h-[70px]"
              value={groupForm.description}
              onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Group Manager">
              <select
                className="input"
                value={groupForm.managerId}
                onChange={(e) => setGroupForm({ ...groupForm, managerId: e.target.value })}
              >
                <option value="">Select Manager</option>
                {availableEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} ({emp.employeeCode})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Team Leader">
              <select
                className="input"
                value={groupForm.teamLeaderId}
                onChange={(e) => setGroupForm({ ...groupForm, teamLeaderId: e.target.value })}
              >
                <option value="">Select Team Leader</option>
                {availableEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} ({emp.employeeCode})
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </form>
      </Modal>

      {/* MANAGE MEMBERS MODAL */}
      <Modal
        open={Boolean(membersTarget)}
        onClose={() => setMembersTarget(null)}
        title={`Group Members: ${membersTarget?.name ?? ''}`}
        description={`Location: ${membersTarget?.locationName} (${membersTarget?.locationCode}) · Total: ${membersList.length} member(s)`}
        size="lg"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setMembersTarget(null)}>
            Done
          </button>
        }
      >
        <div className="space-y-4">
          {/* Add member row */}
          {canManageGroups && (
            <div className="flex flex-col sm:flex-row items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/50 p-3">
              <div className="flex-1 w-full">
                <select
                  className="input text-sm bg-white"
                  value={selectedAddMemberId}
                  onChange={(e) => setSelectedAddMemberId(e.target.value)}
                >
                  <option value="">Select employee from {membersTarget?.locationName} to add…</option>
                  {availableEmployees
                    .filter((e) => !membersList.some((m) => m.employeeId === e.id))
                    .map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.fullName} ({emp.employeeCode}) · {emp.designationTitle ?? 'Employee'}
                      </option>
                    ))}
                </select>
              </div>
              <button
                type="button"
                className="btn-primary btn-sm inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                disabled={busyAction || !selectedAddMemberId}
                onClick={handleAddMember}
              >
                <Icon name="plus" size={14} />
                <span>Add Member</span>
              </button>
            </div>
          )}

          {/* Members Table */}
          {membersLoading ? (
            <div className="p-8 text-center text-sm text-ink-500">Loading group members…</div>
          ) : membersList.length === 0 ? (
            <EmptyState
              compact
              title="No members in this group"
              description="Use the dropdown above to add employees to this group."
            />
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
              {membersList.map((m) => {
                const isLeader = membersTarget?.teamLeaderId === m.employeeId;
                const isMgr = membersTarget?.managerId === m.employeeId;
                return (
                  <div key={m.id} className="flex items-center justify-between gap-3 p-3 hover:bg-ink-50/50 transition">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={m.fullName} src={m.photoUrl} size={36} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-ink-900 truncate">{m.fullName}</p>
                          {isLeader && (
                            <span className="rounded bg-amber-100 px-1.5 py-0.2 text-[10px] font-bold text-amber-800">
                              Team Leader
                            </span>
                          )}
                          {isMgr && (
                            <span className="rounded bg-indigo-100 px-1.5 py-0.2 text-[10px] font-bold text-indigo-800">
                              Manager
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-500 truncate font-mono">
                          {m.employeeCode} · {m.designationTitle ?? 'Designation Unassigned'} · {m.departmentName ?? 'Department'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {m.attendanceStatus ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                          {m.attendanceStatus}
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink-400">Not checked in</span>
                      )}

                      {canManageGroups && (
                        <div className="flex items-center gap-1">
                          {!isLeader && (
                            <button
                              type="button"
                              className="btn-secondary btn-xs text-[11px] cursor-pointer"
                              title="Set as Team Leader for this group"
                              onClick={() => handlePromoteTeamLeader(m.employeeId, m.fullName)}
                              disabled={busyAction}
                            >
                              Make TL
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-secondary btn-xs !text-rose-700 hover:!bg-rose-50 cursor-pointer"
                            title="Remove employee from group"
                            onClick={() => handleRemoveMember(m.employeeId, m.fullName)}
                            disabled={busyAction}
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      {/* TRANSFER GROUP MODAL */}
      <Modal
        open={Boolean(transferTarget)}
        onClose={() => setTransferTarget(null)}
        title={`Transfer Group: ${transferTarget?.name ?? ''}`}
        description="Reassign this entire group to another authorized store location."
        size="md"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setTransferTarget(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="transfer-group-form"
              className="btn-primary"
              disabled={busyAction || !transferForm.targetLocationId}
            >
              {busyAction ? 'Transferring…' : 'Confirm Location Transfer'}
            </button>
          </>
        }
      >
        <form id="transfer-group-form" onSubmit={handleTransferGroup} className="space-y-4">
          <div className="rounded-lg bg-amber-50 p-3.5 border border-amber-200 text-xs text-amber-900">
            <strong>Location Transfer Notice:</strong> Transferring this group will reassign the group and update
            the location bounds. All transfers are recorded in the permanent audit trail.
          </div>

          <Field label="Current Store Location">
            <input className="input bg-ink-100" value={`${transferTarget?.locationName} (${transferTarget?.locationCode})`} disabled />
          </Field>

          <Field label="Target Store Location" required>
            <select
              className="input font-medium"
              value={transferForm.targetLocationId}
              onChange={(e) => setTransferForm({ ...transferForm, targetLocationId: e.target.value })}
              required
            >
              <option value="">Select Destination Store</option>
              {locations
                .filter((l) => l.id !== transferTarget?.locationId)
                .map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} – {loc.name}
                  </option>
                ))}
            </select>
          </Field>

          <Field label="Reason for Transfer" required hint="Mandatory audit trail reason">
            <textarea
              className="input min-h-[70px]"
              placeholder="e.g. Relocating floor team to Belagavi new branch opening."
              value={transferForm.reason}
              onChange={(e) => setTransferForm({ ...transferForm, reason: e.target.value })}
              required
            />
          </Field>
        </form>
      </Modal>

      {/* AUDIT LOG MODAL */}
      <Modal
        open={auditModalOpen}
        onClose={() => setAuditModalOpen(false)}
        title="Workforce Location & Group Audit Trail"
        description="Immutable record of location transfers, group modifications, and employee relocations."
        size="xl"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setAuditModalOpen(false)}>
            Close
          </button>
        }
      >
        {auditLoading ? (
          <div className="p-8 text-center text-sm text-ink-500">Loading audit log…</div>
        ) : auditLogs.length === 0 ? (
          <EmptyState compact title="No audit entries" description="No location transfers recorded yet." />
        ) : (
          <div className="max-h-96 overflow-y-auto divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
            {auditLogs.map((log) => (
              <div key={log.id} className="p-3 text-xs space-y-1 hover:bg-ink-50/50 transition">
                <div className="flex items-center justify-between text-ink-500">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink-900">{log.actorName}</span>
                    <span className="font-mono text-[10px] uppercase bg-ink-100 px-1.5 py-0.2 rounded border">
                      {log.action}
                    </span>
                  </div>
                  <span className="font-mono">{formatDateTime(log.createdAt)}</span>
                </div>
                <div className="text-ink-800">
                  {log.fromLocationCode && log.toLocationCode && (
                    <span>
                      Location transfer: <strong>{log.fromLocationCode}</strong> → <strong>{log.toLocationCode}</strong>
                    </span>
                  )}
                  {log.toGroupName && (
                    <span className="ml-2 text-blue-700">
                      Group: <strong>{log.toGroupName}</strong>
                    </span>
                  )}
                </div>
                {log.reason && <p className="text-ink-500 italic">"{log.reason}"</p>}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
