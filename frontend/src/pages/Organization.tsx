import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useToast } from '../contexts/ToastContext';
import { Avatar, Badge, Card, EmptyState, PageHeader, SectionHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';

interface Node {
  id: number;
  name: string;
  employeeCode: string;
  managerId: number | null;
  designation: string | null;
  department: string | null;
  photoUrl: string | null;
  roleSlug: string;
  status: string;
}

interface Structure {
  departments: { id: number; name: string; code: string; head_name: string | null; employeeCount: number }[];
  designations: { id: number; title: string; departmentId: number | null; level: number }[];
  locations: { id: number; name: string; code: string; city: string | null; timezone: string; geofenceRadiusM: number | null }[];
  roles: { id: number; name: string; slug: string; level: number; employeeCount: number }[];
}

export default function Organization() {
  useDocumentTitle('Organization');
  const toast = useToast();
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [tab, setTab] = useState('hierarchy');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    Promise.all([
      api.get<{ employees: Node[] }>('/employees/hierarchy'),
      api.get<Structure>('/employees/structure'),
    ])
      .then(([hierarchy, structureResult]) => {
        setNodes(hierarchy.employees);
        setStructure(structureResult);
      })
      .catch((caught) => toast.error(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const childrenOf = useMemo(() => {
    const map = new Map<number | null, Node[]>();
    for (const node of nodes ?? []) {
      const key = node.managerId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(node);
    }
    return map;
  }, [nodes]);

  const roots = (nodes ?? []).filter((node) => node.managerId === null || !nodes?.some((candidate) => candidate.id === node.managerId));
  const matches = search
    ? new Set((nodes ?? []).filter((node) => `${node.name} ${node.employeeCode} ${node.designation ?? ''}`.toLowerCase().includes(search.toLowerCase())).map((node) => node.id))
    : null;

  const renderNode = (node: Node, depth: number) => {
    const children = childrenOf.get(node.id) ?? [];
    const isCollapsed = collapsed.has(node.id);
    const visible = !matches || matches.has(node.id) || children.some((child) => matches.has(child.id));
    if (!visible && depth > 0) return null;
    return (
      <div key={node.id} className="relative">
        <div className={cx('flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-2', depth === 0 && 'border-brand-300 bg-brand-50/50')}>
          {children.length > 0 ? (
            <button type="button" className="rounded p-0.5 text-ink-500 hover:bg-ink-100" onClick={() => setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(node.id)) next.delete(node.id);
              else next.add(node.id);
              return next;
            })}>
              <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} />
            </button>
          ) : (
            <span className="w-5" />
          )}
          <Avatar name={node.name} src={node.photoUrl} size={28} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink-800">{node.name}</p>
            <p className="truncate text-[11px] text-ink-400">{node.employeeCode} · {node.designation ?? '—'} · {node.department ?? '—'}</p>
          </div>
          <Badge tone="neutral">{node.roleSlug.replace(/_/g, ' ')}</Badge>
          {node.status === 'pending_approval' && <Badge tone="warning">Pending</Badge>}
        </div>
        {!isCollapsed && children.length > 0 && (
          <div className="ml-4 mt-1.5 space-y-1.5 border-l border-dashed border-ink-200 pl-3">
            {children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organisation structure"
        description="Reporting lines, departments, designations, locations and role distribution across the company."
        actions={<input className="input w-auto" placeholder="Find employee…" value={search} onChange={(event) => setSearch(event.target.value)} />}
      />

      <Tabs
        tabs={[
          { value: 'hierarchy', label: 'Hierarchy' },
          { value: 'departments', label: 'Departments' },
          { value: 'locations', label: 'Locations' },
          { value: 'roles', label: 'Roles' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {!nodes || !structure ? (
        <Card className="card-pad"><Skeleton lines={8} /></Card>
      ) : tab === 'hierarchy' ? (
        <Card className="card-pad">
          <SectionHeader title="Reporting hierarchy" description={`${nodes.length} active employees · click a node to expand or collapse`} />
          <div className="mt-4 space-y-2">
            {roots.length === 0 ? <EmptyState title="No hierarchy" description="Assign reporting managers to build the hierarchy." /> : roots.map((root) => renderNode(root, 0))}
          </div>
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
