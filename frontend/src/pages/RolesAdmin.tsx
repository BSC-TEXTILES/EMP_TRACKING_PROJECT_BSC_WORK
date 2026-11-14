import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, SectionHeader, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { titleize } from '../lib/format';

interface Role {
  id: number;
  name: string;
  slug: string;
  level: number;
  description: string | null;
  isSystem: boolean;
  permissions: number[];
}

interface Permission {
  id: number;
  code: string;
  module: string;
  action: string;
  description: string | null;
}

export default function RolesAdmin() {
  useDocumentTitle('Roles & permissions');
  const { has } = useAuth();
  const toast = useToast();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', level: 40, description: '' });
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      const result = await api.get<{ roles: Role[]; permissions: Permission[] }>('/employees/roles');
      setRoles(result.roles);
      setPermissions(result.permissions);
      if (selectedRoleId === null && result.roles.length > 0) {
        setSelectedRoleId(result.roles[0].id);
        setDraft(new Set(result.roles[0].permissions));
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRole = roles?.find((role) => role.id === selectedRoleId) ?? null;

  useEffect(() => {
    if (selectedRole) setDraft(new Set(selectedRole.permissions));
  }, [selectedRoleId, roles]);

  const grouped = useMemo(() => {
    const map = new Map<string, Permission[]>();
    permissions
      .filter((permission) => (search ? `${permission.code} ${permission.description ?? ''}`.toLowerCase().includes(search.toLowerCase()) : true))
      .forEach((permission) => {
        if (!map.has(permission.module)) map.set(permission.module, []);
        map.get(permission.module)!.push(permission);
      });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [permissions, search]);

  const dirty = selectedRole ? draft.size !== selectedRole.permissions.length || selectedRole.permissions.some((id) => !draft.has(id)) : false;

  const save = async () => {
    if (!selectedRole) return;
    setBusy(true);
    try {
      await api.put(`/employees/roles/${selectedRole.id}/permissions`, { permissionIds: [...draft] });
      toast.success(`Permissions updated for ${selectedRole.name}. The change is audited and applies immediately.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Roles & permission matrix"
        description="Every module is protected by explicit permission codes. Changes take effect on the next request."
        actions={
          has('roles.manage') ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={15} /> Create role
            </button>
          ) : undefined
        }
      />

      {!roles ? (
        <Card className="card-pad"><Skeleton lines={8} /></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Card className="overflow-hidden">
            <p className="border-b border-ink-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Roles ({roles.length})</p>
            <div className="max-h-[600px] overflow-y-auto">
              {roles.map((role) => (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => setSelectedRoleId(role.id)}
                  className={`flex w-full items-start justify-between gap-2 border-b border-ink-50 px-3 py-2 text-left hover:bg-ink-50 ${selectedRoleId === role.id ? 'bg-brand-50' : ''}`}
                >
                  <div>
                    <p className="text-sm font-medium text-ink-800">{role.name}</p>
                    <p className="text-[11px] text-ink-400">{role.slug} · level {role.level}</p>
                  </div>
                  <Badge tone="neutral">{role.permissions.length}</Badge>
                </button>
              ))}
            </div>
          </Card>

          <Card className="card-pad">
            {!selectedRole ? (
              <p className="text-sm text-ink-500">Select a role to edit its permissions.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <SectionHeader title={selectedRole.name} description={selectedRole.description ?? `Level ${selectedRole.level} role`} />
                    <div className="mt-1 flex gap-1.5">
                      <Badge tone="brand">{selectedRole.slug}</Badge>
                      {selectedRole.isSystem && <Badge tone="neutral">System role</Badge>}
                      <Badge tone="neutral">{draft.size} selected</Badge>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input className="input w-44" placeholder="Filter permissions" value={search} onChange={(event) => setSearch(event.target.value)} />
                    <button type="button" className="btn-primary btn-sm" disabled={!dirty || busy || !has('roles.manage')} onClick={() => void save()}>
                      {busy ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-4">
                  {grouped.map(([module, modulePermissions]) => {
                    const allSelected = modulePermissions.every((permission) => draft.has(permission.id));
                    return (
                      <div key={module} className="rounded-lg border border-ink-200">
                        <div className="flex items-center justify-between gap-2 border-b border-ink-100 bg-ink-50 px-3 py-1.5">
                          <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">{titleize(module)}</p>
                          <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={allSelected}
                              disabled={!has('roles.manage')}
                              onChange={(event) =>
                                setDraft((prev) => {
                                  const next = new Set(prev);
                                  modulePermissions.forEach((permission) => {
                                    if (event.target.checked) next.add(permission.id);
                                    else next.delete(permission.id);
                                  });
                                  return next;
                                })
                              }
                            />
                            all
                          </label>
                        </div>
                        <div className="grid gap-1 p-2 sm:grid-cols-2">
                          {modulePermissions.map((permission) => (
                            <label key={permission.id} className="flex items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-ink-50">
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4"
                                checked={draft.has(permission.id)}
                                disabled={!has('roles.manage')}
                                onChange={(event) =>
                                  setDraft((prev) => {
                                    const next = new Set(prev);
                                    if (event.target.checked) next.add(permission.id);
                                    else next.delete(permission.id);
                                    return next;
                                  })
                                }
                              />
                              <span>
                                <span className="font-mono text-[11px] text-ink-700">{permission.code}</span>
                                {permission.description && <span className="block text-[11px] text-ink-400">{permission.description}</span>}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create a role" description="New roles start with no permissions; grant them in the matrix."
        footer={<><button className="btn-secondary" onClick={() => setCreateOpen(false)}>Cancel</button><button className="btn-primary" form="role-form" type="submit">Create role</button></>}>
        <form id="role-form" className="space-y-3" onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api.post('/employees/roles', { ...form, level: Number(form.level) });
            toast.success('Role created.');
            setCreateOpen(false);
            setForm({ name: '', slug: '', level: 40, description: '' });
            await load();
          } catch (caught) {
            toast.error(errorMessage(caught));
          }
        }}>
          <Field label="Role name" required><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
          <Field label="Slug" required hint="Lowercase, underscores"><input className="input" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} required /></Field>
          <Field label="Level" hint="Higher level roles sit above lower levels in the hierarchy"><input type="number" min={1} max={100} className="input" value={form.level} onChange={(event) => setForm({ ...form, level: Number(event.target.value) })} /></Field>
          <Field label="Description"><input className="input" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        </form>
      </Modal>
    </div>
  );
}
