import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReportingHierarchy from '../components/ReportingHierarchy';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';

interface LocationItem {
  id: number;
  name: string;
  code: string;
  city: string | null;
  state?: string | null;
  address?: string | null;
  timezone: string;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusM: number | null;
  employeeCount?: number;
  isActive?: boolean;
}

interface RoleItem {
  id: number;
  name: string;
  slug: string;
  level: number;
  employeeCount: number;
  category?: string;
  description?: string | null;
  isSystem?: boolean;
}

interface Structure {
  departments: { id: number; name: string; code: string; head_name: string | null; employeeCount: number }[];
  designations: { id: number; title: string; departmentId: number | null; level: number }[];
  locations: LocationItem[];
  roles: RoleItem[];
}

export default function Organization() {
  useDocumentTitle('Organization');
  const toast = useToast();
  const { user, has } = useAuth();
  const [structure, setStructure] = useState<Structure | null>(null);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'hierarchy';
  const setTab = (value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', value);
        return next;
      },
      { replace: true },
    );

  // Permission checks
  const canManageLocations =
    has('locations.manage') ||
    has('org.manage') ||
    user?.roleSlug === 'super_admin' ||
    (user?.roleLevel ?? 0) >= 90;

  const canManageRoles =
    has('roles.manage') ||
    has('roles.create') ||
    has('roles.edit') ||
    has('roles.delete') ||
    has('roles.view') ||
    has('org.manage') ||
    user?.roleSlug === 'super_admin' ||
    (user?.roleLevel ?? 0) >= 40;

  // Search filters
  const [locationSearch, setLocationSearch] = useState('');
  const [roleSearch, setRoleSearch] = useState('');

  // Location Add/Edit Modal state
  const [locationModalOpen, setLocationModalOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<LocationItem | null>(null);
  const [locationForm, setLocationForm] = useState({
    name: '',
    code: '',
    city: '',
    state: 'Karnataka',
    address: '',
    timezone: 'Asia/Kolkata',
    geofenceRadiusM: '300',
    latitude: '',
    longitude: '',
  });
  const [locationSaving, setLocationSaving] = useState(false);

  // Location Delete Modal state
  const [deleteLocationTarget, setDeleteLocationTarget] = useState<LocationItem | null>(null);
  const [moveToLocationId, setMoveToLocationId] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [locationDeleting, setLocationDeleting] = useState(false);

  // Role Add/Edit Modal state
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleItem | null>(null);
  const [roleForm, setRoleForm] = useState({
    name: '',
    slug: '',
    level: '30',
    category: 'general',
    description: '',
  });
  const [roleSaving, setRoleSaving] = useState(false);

  // Role Delete Modal state
  const [deleteRoleTarget, setDeleteRoleTarget] = useState<RoleItem | null>(null);
  const [moveToRoleId, setMoveToRoleId] = useState('');
  const [deleteRoleConfirmText, setDeleteRoleConfirmText] = useState('');
  const [roleDeleting, setRoleDeleting] = useState(false);

  const loadStructure = async () => {
    setLoading(true);
    try {
      const data = await api.get<Structure>('/employees/structure');
      setStructure(data);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'hierarchy' || structure) return;
    void loadStructure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Filtered locations
  const filteredLocations = useMemo(() => {
    if (!structure?.locations) return [];
    const query = locationSearch.trim().toLowerCase();
    if (!query) return structure.locations;
    return structure.locations.filter(
      (loc) =>
        loc.name.toLowerCase().includes(query) ||
        loc.code.toLowerCase().includes(query) ||
        (loc.city && loc.city.toLowerCase().includes(query)) ||
        (loc.state && loc.state.toLowerCase().includes(query)) ||
        (loc.address && loc.address.toLowerCase().includes(query)),
    );
  }, [structure?.locations, locationSearch]);

  // Filtered roles
  const filteredRoles = useMemo(() => {
    if (!structure?.roles) return [];
    const query = roleSearch.trim().toLowerCase();
    if (!query) return structure.roles;
    return structure.roles.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.slug.toLowerCase().includes(query) ||
        (r.category && r.category.toLowerCase().includes(query)) ||
        (r.description && r.description.toLowerCase().includes(query)),
    );
  }, [structure?.roles, roleSearch]);

  // Location Handlers
  const openAddLocation = () => {
    setEditingLocation(null);
    setLocationForm({
      name: '',
      code: '',
      city: '',
      state: 'Karnataka',
      address: '',
      timezone: 'Asia/Kolkata',
      geofenceRadiusM: '300',
      latitude: '',
      longitude: '',
    });
    setLocationModalOpen(true);
  };

  const openEditLocation = (loc: LocationItem) => {
    setEditingLocation(loc);
    setLocationForm({
      name: loc.name,
      code: loc.code,
      city: loc.city ?? '',
      state: loc.state ?? '',
      address: loc.address ?? '',
      timezone: loc.timezone || 'Asia/Kolkata',
      geofenceRadiusM: loc.geofenceRadiusM ? String(loc.geofenceRadiusM) : '',
      latitude: loc.latitude !== null && loc.latitude !== undefined ? String(loc.latitude) : '',
      longitude: loc.longitude !== null && loc.longitude !== undefined ? String(loc.longitude) : '',
    });
    setLocationModalOpen(true);
  };

  const openDeleteLocation = (loc: LocationItem) => {
    setDeleteLocationTarget(loc);
    setDeleteConfirmText('');
    const otherLocations = structure?.locations.filter((l) => l.id !== loc.id) ?? [];
    setMoveToLocationId(otherLocations[0]?.id ? String(otherLocations[0].id) : '');
  };

  const handleSaveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!locationForm.name.trim() || !locationForm.code.trim()) {
      toast.error('Location name and unique code are required.');
      return;
    }

    const payload = {
      name: locationForm.name.trim(),
      code: locationForm.code.trim().toUpperCase(),
      city: locationForm.city.trim() || undefined,
      state: locationForm.state.trim() || undefined,
      address: locationForm.address.trim() || undefined,
      timezone: locationForm.timezone.trim() || 'Asia/Kolkata',
      geofenceRadiusM: locationForm.geofenceRadiusM ? Number(locationForm.geofenceRadiusM) : undefined,
      latitude: locationForm.latitude ? Number(locationForm.latitude) : undefined,
      longitude: locationForm.longitude ? Number(locationForm.longitude) : undefined,
    };

    setLocationSaving(true);
    try {
      if (editingLocation) {
        await api.patch(`/employees/locations/${editingLocation.id}`, payload);
        toast.success(`Location ${payload.code} (${payload.name}) updated successfully.`);
      } else {
        await api.post('/employees/locations', payload);
        toast.success(`New location ${payload.code} (${payload.name}) created successfully.`);
      }
      setLocationModalOpen(false);
      setEditingLocation(null);
      await loadStructure();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLocationSaving(false);
    }
  };

  const handleConfirmDeleteLocation = async () => {
    if (!deleteLocationTarget) return;
    const staffCount = deleteLocationTarget.employeeCount ?? 0;
    if (staffCount > 0 && !moveToLocationId) {
      toast.error('Please select a target location to transfer the assigned employees to.');
      return;
    }
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      toast.error('Type DELETE to confirm deletion.');
      return;
    }

    setLocationDeleting(true);
    try {
      const query = staffCount > 0 && moveToLocationId ? `?moveTo=${moveToLocationId}` : '';
      await api.del(`/employees/locations/${deleteLocationTarget.id}${query}`);
      toast.success(`Location ${deleteLocationTarget.name} (${deleteLocationTarget.code}) deleted successfully.`);
      setDeleteLocationTarget(null);
      setDeleteConfirmText('');
      setMoveToLocationId('');
      await loadStructure();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLocationDeleting(false);
    }
  };

  // Role Handlers
  const openAddRole = () => {
    setEditingRole(null);
    setRoleForm({
      name: '',
      slug: '',
      level: '30',
      category: 'operations',
      description: '',
    });
    setRoleModalOpen(true);
  };

  const openEditRole = (role: RoleItem) => {
    setEditingRole(role);
    setRoleForm({
      name: role.name,
      slug: role.slug,
      level: String(role.level),
      category: role.category ?? 'general',
      description: role.description ?? '',
    });
    setRoleModalOpen(true);
  };

  const openDeleteRole = (role: RoleItem) => {
    if (role.slug === 'super_admin' || role.level >= 100) {
      toast.error('The core Super Admin role cannot be deleted.');
      return;
    }
    setDeleteRoleTarget(role);
    setDeleteRoleConfirmText('');
    const otherRoles = structure?.roles.filter((r) => r.id !== role.id) ?? [];
    setMoveToRoleId(otherRoles[0]?.id ? String(otherRoles[0].id) : '');
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleForm.name.trim() || !roleForm.slug.trim()) {
      toast.error('Role name and identifier slug are required.');
      return;
    }

    const payload = {
      name: roleForm.name.trim(),
      slug: roleForm.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      level: Number(roleForm.level) || 30,
      category: roleForm.category.trim() || 'general',
      description: roleForm.description.trim() || undefined,
    };

    setRoleSaving(true);
    try {
      if (editingRole) {
        await api.patch(`/employees/roles/${editingRole.id}`, payload);
        toast.success(`Role "${payload.name}" updated successfully.`);
      } else {
        await api.post('/employees/roles', payload);
        toast.success(`Role "${payload.name}" (${payload.slug}) created successfully.`);
      }
      setRoleModalOpen(false);
      setEditingRole(null);
      await loadStructure();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRoleSaving(false);
    }
  };

  const handleConfirmDeleteRole = async () => {
    if (!deleteRoleTarget) return;
    const staffCount = deleteRoleTarget.employeeCount ?? 0;
    if (staffCount > 0 && !moveToRoleId) {
      toast.error('Please select a replacement role to reassign assigned employees.');
      return;
    }
    if (deleteRoleConfirmText.trim().toUpperCase() !== 'DELETE') {
      toast.error('Type DELETE to confirm deletion.');
      return;
    }

    setRoleDeleting(true);
    try {
      const query = staffCount > 0 && moveToRoleId ? `?moveTo=${moveToRoleId}` : '';
      await api.del(`/employees/roles/${deleteRoleTarget.id}${query}`);
      toast.success(`Role "${deleteRoleTarget.name}" deleted successfully.`);
      setDeleteRoleTarget(null);
      setDeleteRoleConfirmText('');
      setMoveToRoleId('');
      await loadStructure();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRoleDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organisation structure"
        description="Reporting hierarchy, live workforce status and location-wise attendance, plus departments, locations and roles."
        actions={
          tab === 'locations' && canManageLocations ? (
            <button
              type="button"
              className="btn-primary btn-sm inline-flex items-center gap-1.5 !bg-brand-600 hover:!bg-brand-700 !text-white shadow-xs cursor-pointer"
              onClick={openAddLocation}
              title="Add a new store or office location"
            >
              <Icon name="plus" size={15} />
              <span>Add Location</span>
            </button>
          ) : tab === 'roles' && canManageRoles ? (
            <button
              type="button"
              className="btn-primary btn-sm inline-flex items-center gap-1.5 !bg-brand-600 hover:!bg-brand-700 !text-white shadow-xs cursor-pointer"
              onClick={openAddRole}
              title="Create a new workforce role"
            >
              <Icon name="plus" size={15} />
              <span>Add Role</span>
            </button>
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { value: 'hierarchy', label: 'Reporting hierarchy' },
          { value: 'departments', label: 'Departments' },
          { value: 'locations', label: 'Locations' },
          { value: 'roles', label: 'Roles' },
          { value: 'times', label: 'Office Times & Shifts' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'hierarchy' ? (
        <ReportingHierarchy />
      ) : !structure || loading ? (
        <Card className="card-pad">
          <Skeleton lines={8} />
        </Card>
      ) : tab === 'departments' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {structure.departments.map((department) => (
            <Card key={department.id} className="card-pad">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-ink-900">{department.name}</p>
                  <p className="text-xs text-ink-400">{department.code}</p>
                </div>
                <Badge tone="brand">{department.employeeCount} staff</Badge>
              </div>
              <p className="mt-2 text-xs text-ink-500">Head: {department.head_name ?? 'Unassigned'}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {structure.designations
                  .filter((designation) => designation.departmentId === department.id)
                  .slice(0, 6)
                  .map((designation) => (
                    <span
                      key={designation.id}
                      className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-600"
                    >
                      {designation.title}
                    </span>
                  ))}
              </div>
            </Card>
          ))}
        </div>
      ) : tab === 'locations' ? (
        <div className="space-y-4">
          {/* Action & Filter Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-ink-100 shadow-2xs">
            <div className="flex items-center gap-3">
              <div className="relative">
                <input
                  type="search"
                  className="input py-1.5 pl-8 pr-3 text-sm w-64"
                  placeholder="Search location, code, city…"
                  value={locationSearch}
                  onChange={(e) => setLocationSearch(e.target.value)}
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400">
                  <Icon name="search" size={14} />
                </span>
              </div>
              <span className="text-xs font-semibold text-ink-500">
                {filteredLocations.length} {filteredLocations.length === 1 ? 'Location' : 'Locations'}
              </span>
            </div>

            {canManageLocations && (
              <button
                type="button"
                className="btn-primary btn-sm inline-flex items-center gap-1.5 !bg-brand-600 hover:!bg-brand-700 !text-white shadow-xs cursor-pointer"
                onClick={openAddLocation}
              >
                <Icon name="plus" size={15} />
                <span>Add Location</span>
              </button>
            )}
          </div>

          {filteredLocations.length === 0 ? (
            <EmptyState
              title="No locations found"
              description={
                locationSearch.trim()
                  ? `No store or office location matches "${locationSearch}".`
                  : 'No store locations have been configured yet.'
              }
              action={
                canManageLocations ? (
                  <button
                    type="button"
                    className="btn-primary btn-sm inline-flex items-center gap-1.5 cursor-pointer"
                    onClick={openAddLocation}
                  >
                    <Icon name="plus" size={14} />
                    <span>Create First Location</span>
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredLocations.map((location) => (
                <Card key={location.id} className="card-pad hover:shadow-sm transition flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-base font-bold text-ink-900 truncate">{location.name}</p>
                          <Badge tone="brand">{location.code}</Badge>
                        </div>
                        <p className="text-xs text-ink-500 mt-0.5">
                          {[location.city, location.state].filter(Boolean).join(', ') || 'No city specified'}
                        </p>
                      </div>
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 border border-brand-200">
                        <Icon name="building" size={18} />
                      </div>
                    </div>

                    {location.address && (
                      <p className="mt-2.5 text-xs text-ink-600 line-clamp-2">
                        <span className="font-semibold text-ink-500">Address: </span>
                        {location.address}
                      </p>
                    )}

                    <div className="mt-3.5 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-ink-50 p-2.5 border border-ink-100">
                        <span className="text-ink-500 block text-[11px] font-medium">Assigned Staff</span>
                        <span className="font-bold text-ink-900 text-sm mt-0.5 block">
                          {location.employeeCount ?? 0} {location.employeeCount === 1 ? 'employee' : 'employees'}
                        </span>
                      </div>
                      <div className="rounded-lg bg-ink-50 p-2.5 border border-ink-100">
                        <span className="text-ink-500 block text-[11px] font-medium">Geofence Radius</span>
                        <span className="font-semibold text-ink-800 text-xs mt-0.5 block">
                          {location.geofenceRadiusM ? `${location.geofenceRadiusM} m (opt-in)` : 'Not configured'}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between text-xs text-ink-500 pt-2.5 border-t border-ink-100">
                      <span className="truncate">Timezone: {location.timezone}</span>
                      {location.latitude !== null && location.latitude !== undefined && location.longitude !== null && location.longitude !== undefined && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                          <Icon name="check" size={10} />
                          <span>GPS Geofenced</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {canManageLocations && (
                    <div className="mt-4 flex items-center justify-end gap-2 pt-2.5 border-t border-ink-100">
                      <button
                        type="button"
                        className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold cursor-pointer"
                        onClick={() => openEditLocation(location)}
                        title={`Edit ${location.name}`}
                      >
                        <Icon name="edit" size={13} />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold !text-rose-700 !border-rose-200 hover:!bg-rose-50 cursor-pointer"
                        onClick={() => openDeleteLocation(location)}
                        title={`Delete ${location.name}`}
                      >
                        <Icon name="trash" size={13} />
                        <span>Delete</span>
                      </button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : tab === 'roles' ? (
        /* Roles Management Tab */
        <div className="space-y-4">
          {/* Action & Filter Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-ink-100 shadow-2xs">
            <div className="flex items-center gap-3">
              <div className="relative">
                <input
                  type="search"
                  className="input py-1.5 pl-8 pr-3 text-sm w-64"
                  placeholder="Search roles by name or slug…"
                  value={roleSearch}
                  onChange={(e) => setRoleSearch(e.target.value)}
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400">
                  <Icon name="search" size={14} />
                </span>
              </div>
              <span className="text-xs font-semibold text-ink-500">
                {filteredRoles.length} {filteredRoles.length === 1 ? 'Role' : 'Roles'}
              </span>
            </div>

            {canManageRoles && (
              <button
                type="button"
                className="btn-primary btn-sm inline-flex items-center gap-1.5 !bg-brand-600 hover:!bg-brand-700 !text-white shadow-xs cursor-pointer"
                onClick={openAddRole}
              >
                <Icon name="plus" size={15} />
                <span>Add Role</span>
              </button>
            )}
          </div>

          {filteredRoles.length === 0 ? (
            <EmptyState
              title="No roles found"
              description={
                roleSearch.trim()
                  ? `No workforce role matches "${roleSearch}".`
                  : 'No roles have been created yet.'
              }
              action={
                canManageRoles ? (
                  <button
                    type="button"
                    className="btn-primary btn-sm inline-flex items-center gap-1.5 cursor-pointer"
                    onClick={openAddRole}
                  >
                    <Icon name="plus" size={14} />
                    <span>Create Role</span>
                  </button>
                ) : undefined
              }
            />
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Slug</th>
                      <th>Level</th>
                      <th>Employees</th>
                      {canManageRoles && <th className="text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRoles.map((role) => (
                      <tr key={role.id} className="hover:bg-slate-50/60 transition">
                        <td>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-ink-900">{role.name}</span>
                            {role.slug === 'super_admin' ? (
                              <Badge tone="danger">System Root</Badge>
                            ) : role.isSystem ? (
                              <Badge tone="brand">System</Badge>
                            ) : null}
                          </div>
                          {role.description && (
                            <p className="text-xs text-ink-500 line-clamp-1 mt-0.5">{role.description}</p>
                          )}
                        </td>
                        <td>
                          <span className="font-mono text-xs text-ink-600 bg-ink-100/70 px-2 py-0.5 rounded">
                            {role.slug}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                              role.level >= 90
                                ? 'bg-purple-100 text-purple-800'
                                : role.level >= 60
                                ? 'bg-blue-100 text-blue-800'
                                : role.level >= 30
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            Level {role.level}
                          </span>
                        </td>
                        <td>
                          <span className="font-semibold text-ink-800">
                            {role.employeeCount} {role.employeeCount === 1 ? 'employee' : 'employees'}
                          </span>
                        </td>
                        {canManageRoles && (
                          <td className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <a
                                href={`/admin/roles?role=${role.id}`}
                                className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold !text-brand-700 !border-brand-200 hover:!bg-brand-50 cursor-pointer"
                                title={`Configure options, permissions, and branch access for ${role.name}`}
                              >
                                <Icon name="shield" size={13} />
                                <span>Options</span>
                              </a>
                              <button
                                type="button"
                                className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold cursor-pointer"
                                onClick={() => openEditRole(role)}
                                title={`Edit ${role.name}`}
                              >
                                <Icon name="edit" size={13} />
                                <span>Edit</span>
                              </button>
                              {role.slug !== 'super_admin' && role.level < 100 && (
                                <button
                                  type="button"
                                  className="btn-secondary btn-xs inline-flex items-center gap-1 font-semibold !text-rose-700 !border-rose-200 hover:!bg-rose-50 cursor-pointer"
                                  onClick={() => openDeleteRole(role)}
                                  title={`Delete ${role.name}`}
                                >
                                  <Icon name="trash" size={13} />
                                  <span>Delete</span>
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      ) : (
        /* Office Times & Shifts Tab */
        <div className="space-y-5">
          <Card className="card-pad bg-gradient-to-r from-blue-50/60 to-indigo-50/40 border-blue-200">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
                  <Icon name="clock" size={24} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink-900">Workforce Store Timings & Shift Policy</h3>
                  <p className="text-xs text-ink-600 mt-0.5">
                    Official working hours across all retail branches, customer service desks, and corporate headquarters.
                  </p>
                </div>
              </div>

              {(has('settings.manage') || has('org.manage') || (user?.roleLevel ?? 0) >= 60 || user?.roleSlug === 'super_admin') && (
                <a
                  href="/admin/office-times"
                  className="btn-primary btn-sm inline-flex items-center gap-1.5"
                >
                  <Icon name="settings" size={14} />
                  <span>Configure Office Times</span>
                </a>
              )}
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="card-pad">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">Standard Check-In</p>
              <p className="font-mono text-2xl font-bold text-ink-900 mt-1">09:30 AM</p>
              <p className="text-xs text-ink-500 mt-1">With 10-minute grace window</p>
            </Card>

            <Card className="card-pad">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">Standard Check-Out</p>
              <p className="font-mono text-2xl font-bold text-ink-900 mt-1">06:30 PM</p>
              <p className="text-xs text-ink-500 mt-1">Full-day threshold: 9.0 hrs</p>
            </Card>

            <Card className="card-pad">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">Lunch Interval</p>
              <p className="font-mono text-2xl font-bold text-ink-900 mt-1">01:00 – 02:00 PM</p>
              <p className="text-xs text-ink-500 mt-1">60 min daily break allowance</p>
            </Card>

            <Card className="card-pad">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">Working Days</p>
              <p className="font-mono text-2xl font-bold text-blue-700 mt-1">Mon – Sat</p>
              <p className="text-xs text-ink-500 mt-1">Sunday official weekly off</p>
            </Card>
          </div>

          <Card className="card-pad">
            <div className="flex items-center justify-between pb-3 border-b border-ink-100">
              <h4 className="font-bold text-sm text-ink-900">Branch & Location Timings</h4>
              <span className="text-xs text-ink-500">Asia/Kolkata (IST)</span>
            </div>

            <div className="mt-3 divide-y divide-ink-100">
              {structure.locations.map((loc) => (
                <div key={loc.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-ink-900 text-sm">{loc.name}</span>
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs font-mono font-bold text-ink-700">
                        {loc.code}
                      </span>
                    </div>
                    <p className="text-xs text-ink-500 mt-0.5">
                      {loc.city ?? loc.name} · {loc.employeeCount ?? 0} employees assigned
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="font-mono font-semibold text-sm text-ink-900">09:30 AM – 06:30 PM</p>
                    <p className="text-[11px] text-ink-500">Standard Retail Day Shift · 10m Grace</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Add / Edit Location Modal */}
      <Modal
        open={locationModalOpen}
        onClose={() => setLocationModalOpen(false)}
        title={editingLocation ? `Edit Location: ${editingLocation.name}` : 'Add New Store / Branch Location'}
        description="Configure store branches, head offices, geographical coordinates, and local attendance geofencing."
        size="md"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setLocationModalOpen(false)}
              disabled={locationSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="location-form"
              className="btn-primary !bg-brand-600 hover:!bg-brand-700 !text-white"
              disabled={locationSaving}
            >
              {locationSaving ? 'Saving…' : editingLocation ? 'Update Location' : 'Create Location'}
            </button>
          </>
        }
      >
        <form id="location-form" onSubmit={handleSaveLocation} className="space-y-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Location Name" required hint="e.g. Belagavi Flagship Store, Hubballi Store">
              <input
                className="input font-medium"
                placeholder="e.g. Belagavi Branch"
                value={locationForm.name}
                onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })}
                required
              />
            </Field>

            <Field label="Location Code" required hint="2–12 uppercase letters/digits (e.g. BEL, DAV, SHI, HUB)">
              <input
                className="input font-mono uppercase font-bold"
                placeholder="e.g. BEL"
                value={locationForm.code}
                onChange={(e) => setLocationForm({ ...locationForm, code: e.target.value.toUpperCase() })}
                maxLength={12}
                required
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="City" hint="Store city">
              <input
                className="input"
                placeholder="e.g. Belagavi"
                value={locationForm.city}
                onChange={(e) => setLocationForm({ ...locationForm, city: e.target.value })}
              />
            </Field>

            <Field label="State / Region">
              <input
                className="input"
                placeholder="e.g. Karnataka"
                value={locationForm.state}
                onChange={(e) => setLocationForm({ ...locationForm, state: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Street Address" hint="Full physical address for store operations and dispatches">
            <textarea
              className="input min-h-[64px]"
              placeholder="e.g. Khade Bazaar, Raviwar Peth, Belagavi - 590001"
              value={locationForm.address}
              onChange={(e) => setLocationForm({ ...locationForm, address: e.target.value })}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Timezone" hint="Standard regional timezone">
              <input
                className="input"
                value={locationForm.timezone}
                onChange={(e) => setLocationForm({ ...locationForm, timezone: e.target.value })}
                placeholder="Asia/Kolkata"
              />
            </Field>

            <Field label="Geofence Radius (meters)" hint="Radius for automated check-in validation (50–5000m)">
              <input
                type="number"
                min={50}
                max={5000}
                className="input"
                placeholder="300"
                value={locationForm.geofenceRadiusM}
                onChange={(e) => setLocationForm({ ...locationForm, geofenceRadiusM: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Latitude (GPS)" hint="Optional decimal degrees (e.g. 15.8497)">
              <input
                type="number"
                step="any"
                className="input font-mono text-xs"
                placeholder="e.g. 15.8497"
                value={locationForm.latitude}
                onChange={(e) => setLocationForm({ ...locationForm, latitude: e.target.value })}
              />
            </Field>

            <Field label="Longitude (GPS)" hint="Optional decimal degrees (e.g. 74.4977)">
              <input
                type="number"
                step="any"
                className="input font-mono text-xs"
                placeholder="e.g. 74.4977"
                value={locationForm.longitude}
                onChange={(e) => setLocationForm({ ...locationForm, longitude: e.target.value })}
              />
            </Field>
          </div>
        </form>
      </Modal>

      {/* Delete Location Confirmation Modal */}
      <Modal
        open={Boolean(deleteLocationTarget)}
        onClose={() => setDeleteLocationTarget(null)}
        title={`Delete Location: ${deleteLocationTarget?.name ?? ''}`}
        description="Permanently removes or archives this location. If staff members are assigned, they must be safely transferred to another active store location."
        size="md"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDeleteLocationTarget(null)}
              disabled={locationDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary !bg-rose-600 hover:!bg-rose-700 !text-white !border-rose-600 disabled:opacity-50"
              onClick={handleConfirmDeleteLocation}
              disabled={
                locationDeleting ||
                deleteConfirmText.trim().toUpperCase() !== 'DELETE' ||
                ((deleteLocationTarget?.employeeCount ?? 0) > 0 && !moveToLocationId)
              }
            >
              {locationDeleting ? 'Deleting…' : 'Delete Location'}
            </button>
          </>
        }
      >
        {deleteLocationTarget && (
          <div className="space-y-4 py-1">
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3.5 text-xs text-rose-900 space-y-1">
              <p className="font-bold flex items-center gap-1.5 text-sm text-rose-800">
                <Icon name="alert-triangle" size={16} />
                <span>Caution: Deleting Location {deleteLocationTarget.code}</span>
              </p>
              <p>
                Deleting this location will revoke its geofence and dissolve its location-based groups.
              </p>
            </div>

            {(deleteLocationTarget.employeeCount ?? 0) > 0 && (
              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3.5">
                <p className="text-xs font-bold text-amber-900">
                  ⚠️ {deleteLocationTarget.employeeCount} active employee(s) are currently assigned to this location:
                </p>
                <Field label="Transfer assigned employees to:" required hint="Select an active destination branch">
                  <select
                    className="input font-semibold"
                    value={moveToLocationId}
                    onChange={(e) => setMoveToLocationId(e.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Select Destination Store Location
                    </option>
                    {structure?.locations
                      .filter((l) => l.id !== deleteLocationTarget.id)
                      .map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.code} – {loc.name} ({loc.city ?? 'Flagship'})
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1.5">
                Type <span className="font-mono font-bold text-rose-600">DELETE</span> to confirm:
              </label>
              <input
                className="input w-full font-mono text-sm"
                placeholder="Type DELETE"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                autoFocus
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Add / Edit Role Modal */}
      <Modal
        open={roleModalOpen}
        onClose={() => setRoleModalOpen(false)}
        title={editingRole ? `Edit Role: ${editingRole.name}` : 'Add New Workforce Role'}
        description="Define role hierarchy levels, system identifiers, and operational permission boundaries."
        size="md"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRoleModalOpen(false)}
              disabled={roleSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="role-form"
              className="btn-primary !bg-brand-600 hover:!bg-brand-700 !text-white"
              disabled={roleSaving}
            >
              {roleSaving ? 'Saving…' : editingRole ? 'Update Role' : 'Create Role'}
            </button>
          </>
        }
      >
        <form id="role-form" onSubmit={handleSaveRole} className="space-y-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role Name" required hint="e.g. Assistant Store Manager, Billing Clerk">
              <input
                className="input font-medium"
                placeholder="e.g. Operations Supervisor"
                value={roleForm.name}
                onChange={(e) => {
                  const val = e.target.value;
                  const autoSlug = !editingRole ? val.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') : roleForm.slug;
                  setRoleForm({ ...roleForm, name: val, slug: autoSlug });
                }}
                required
              />
            </Field>

            <Field label="Slug / Identifier" required hint="Unique system key (e.g. store_manager)">
              <input
                className="input font-mono text-sm"
                placeholder="e.g. operations_supervisor"
                value={roleForm.slug}
                onChange={(e) => setRoleForm({ ...roleForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                disabled={Boolean(editingRole && editingRole.slug === 'super_admin')}
                required
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Hierarchy Level (1–100)" required hint="100=Super Admin, 80=GM, 60=Manager, 10=Staff">
              <input
                type="number"
                min={1}
                max={100}
                className="input font-bold"
                value={roleForm.level}
                onChange={(e) => setRoleForm({ ...roleForm, level: e.target.value })}
                disabled={Boolean(editingRole && editingRole.slug === 'super_admin')}
                required
              />
            </Field>

            <Field label="Role Category" hint="Functional grouping">
              <select
                className="input"
                value={roleForm.category}
                onChange={(e) => setRoleForm({ ...roleForm, category: e.target.value })}
              >
                <option value="executive">Executive / Leadership</option>
                <option value="management">Store / Team Management</option>
                <option value="operations">Store Operations / Sales</option>
                <option value="it">IT & Systems</option>
                <option value="hr">Human Resources & Admin</option>
                <option value="finance">Finance & Accounts</option>
                <option value="general">General Workforce</option>
              </select>
            </Field>
          </div>

          <Field label="Description & Scope" hint="Operational responsibilities and duties">
            <textarea
              className="input min-h-[64px]"
              placeholder="e.g. Oversees inventory receipt, cash counters, customer escalations, and store staff shifts."
              value={roleForm.description}
              onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
            />
          </Field>
        </form>
      </Modal>

      {/* Delete Role Confirmation Modal */}
      <Modal
        open={Boolean(deleteRoleTarget)}
        onClose={() => setDeleteRoleTarget(null)}
        title={`Delete Role: ${deleteRoleTarget?.name ?? ''}`}
        description="Permanently deletes this workforce role. If employees are assigned, select a replacement role to transfer them to."
        size="md"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDeleteRoleTarget(null)}
              disabled={roleDeleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary !bg-rose-600 hover:!bg-rose-700 !text-white !border-rose-600 disabled:opacity-50"
              onClick={handleConfirmDeleteRole}
              disabled={
                roleDeleting ||
                deleteRoleConfirmText.trim().toUpperCase() !== 'DELETE' ||
                ((deleteRoleTarget?.employeeCount ?? 0) > 0 && !moveToRoleId)
              }
            >
              {roleDeleting ? 'Deleting…' : 'Delete Role'}
            </button>
          </>
        }
      >
        {deleteRoleTarget && (
          <div className="space-y-4 py-1">
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3.5 text-xs text-rose-900 space-y-1">
              <p className="font-bold flex items-center gap-1.5 text-sm text-rose-800">
                <Icon name="alert-triangle" size={16} />
                <span>Caution: Deleting Role "{deleteRoleTarget.name}"</span>
              </p>
              <p>
                Deleting this role removes all associated role-permission assignments.
              </p>
            </div>

            {(deleteRoleTarget.employeeCount ?? 0) > 0 && (
              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3.5">
                <p className="text-xs font-bold text-amber-900">
                  ⚠️ {deleteRoleTarget.employeeCount} active employee(s) currently hold this role:
                </p>
                <Field label="Reassign affected employees to:" required hint="Select replacement workforce role">
                  <select
                    className="input font-semibold"
                    value={moveToRoleId}
                    onChange={(e) => setMoveToRoleId(e.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Select Replacement Role
                    </option>
                    {structure?.roles
                      .filter((r) => r.id !== deleteRoleTarget.id)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} (Level {r.level} · {r.slug})
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1.5">
                Type <span className="font-mono font-bold text-rose-600">DELETE</span> to confirm:
              </label>
              <input
                className="input w-full font-mono text-sm"
                placeholder="Type DELETE"
                value={deleteRoleConfirmText}
                onChange={(e) => setDeleteRoleConfirmText(e.target.value)}
                autoFocus
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
