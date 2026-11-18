import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReportingHierarchy from '../components/ReportingHierarchy';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, PageHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';

interface Structure {
  departments: { id: number; name: string; code: string; head_name: string | null; employeeCount: number }[];
  designations: { id: number; title: string; departmentId: number | null; level: number }[];
  locations: { id: number; name: string; code: string; city: string | null; timezone: string; geofenceRadiusM: number | null }[];
  roles: { id: number; name: string; slug: string; level: number; employeeCount: number }[];
}

export default function Organization() {
  useDocumentTitle('Organization');
  const toast = useToast();
  const [structure, setStructure] = useState<Structure | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'hierarchy';
  const setTab = (value: string) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('tab', value); return next; }, { replace: true });

  useEffect(() => {
    if (tab === 'hierarchy' || structure) return;
    api.get<Structure>('/employees/structure')
      .then(setStructure)
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organisation structure"
        description="Reporting hierarchy, live workforce status and location-wise attendance, plus departments, locations and roles."
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
      ) : !structure ? (
        <Card className="card-pad"><Skeleton lines={8} /></Card>
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
                {structure.designations.filter((designation) => designation.departmentId === department.id).slice(0, 6).map((designation) => (
                  <span key={designation.id} className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-600">{designation.title}</span>
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : tab === 'locations' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {structure.locations.map((location) => (
            <Card key={location.id} className="card-pad">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-ink-900">{location.name}</p>
                  <p className="text-xs text-ink-400">{location.code} · {location.city ?? '—'}</p>
                </div>
                <Icon name="building" size={18} className="text-ink-400" />
              </div>
              <p className="mt-2 text-xs text-ink-500">Timezone: {location.timezone}</p>
              <p className="text-xs text-ink-500">Geofence: {location.geofenceRadiusM ? `${location.geofenceRadiusM} m (opt-in)` : 'not configured'}</p>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Role</th><th>Slug</th><th>Level</th><th>Employees</th></tr></thead>
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
    </div>
  );
}
