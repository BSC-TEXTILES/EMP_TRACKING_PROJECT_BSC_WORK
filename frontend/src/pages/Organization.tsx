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

interface Structure {
  departments: { id: number; name: string; code: string; head_name: string | null; employeeCount: number }[];
  designations: { id: number; title: string; departmentId: number | null; level: number }[];
  locations: LocationItem[];
  roles: { id: number; name: string; slug: string; level: number; employeeCount: number }[];
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

  // Permission check for locations & org management
  const canManageLocations =
    has('locations.manage') ||
    has('org.manage') ||
    user?.roleSlug === 'super_admin' ||
    (user?.roleLevel ?? 0) >= 90;

  // Search filter for locations
  const [locationSearch, setLocationSearch] = useState('');

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
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { value: 'hierarchy', label: 'Reporting hierarchy' },
          { value: 'departments', label: 'Departments' },
          { value: 'locations', label: 'Locations' },
          { value: 'roles', label: 'Roles' },
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
                </tr>
              </thead>
              <tbody>
                {structure.roles.map((role) => (
                  <tr key={role.id}>
                    <td className="font-medium text-ink-800">{role.name}</td>
                    <td className="text-xs text-ink-500">{role.slug}</td>
                    <td>{role.level}</td>
                    <td>{role.employeeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
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
    </div>
  );
}
