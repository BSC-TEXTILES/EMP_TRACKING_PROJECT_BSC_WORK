import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Card, Field, PageHeader } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';

type Kind = 'departments' | 'designations' | 'locations' | 'leave-types';
interface Item { id: number; name?: string; title?: string; code?: string; annual_quota?: number; }
export default function OrganizationSettings() {
  const { has } = useAuth();
  const [kind, setKind] = useState<Kind>('departments');
  const [items, setItems] = useState<Record<Kind, Item[]>>({ departments: [], designations: [], locations: [], 'leave-types': [] });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = async () => {
    try {
      const [structure, leave] = await Promise.all([api.get<{ departments: Item[]; designations: Item[]; locations: Item[] }>('/employees/structure'), api.get<{ types: Item[] }>('/leave/types')]);
      setItems({ ...structure, 'leave-types': leave.types });
    } catch (error) { setError(errorMessage(error)); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  if (!has('org.manage')) return <p>You do not have permission to manage organization data.</p>;
  return <div className="space-y-5"><PageHeader title="Organization data" description="Enter your actual departments, designations, locations and leave policies. Employee forms use these saved records." />
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    <div className="flex flex-wrap gap-2">{(['departments', 'designations', 'locations', 'leave-types'] as Kind[]).map(value => <button type="button" key={value} className={kind === value ? 'btn-primary' : 'btn-secondary'} onClick={() => { setKind(value); setError(''); setMessage(''); }}>{value.replace('-', ' ')}</button>)}</div>
    <Card className="card-pad"><form key={kind} className="space-y-4" onSubmit={async event => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const text = (key: string) => String(data.get(key) || ''); setBusy(true); setError(''); setMessage('');
      try {
        const body = kind === 'designations' ? { title: text('name'), departmentId: Number(text('departmentId')), level: Number(text('level')) }
          : kind === 'locations' ? { name: text('name'), code: text('code'), city: text('city'), timezone: 'Asia/Kolkata' }
          : kind === 'leave-types' ? { name: text('name'), code: text('code'), annualQuota: Number(text('quota')), isPaid: data.get('paid') === 'on', requiresDocument: data.get('document') === 'on' }
          : { name: text('name'), code: text('code'), description: text('description') };
        await api.post(kind === 'leave-types' ? '/admin/leave-types' : `/employees/${kind}`, body);
        form.reset(); await load(); setMessage('Saved. The new record is available in employee workflows.');
      } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
    }}><fieldset disabled={busy} className="grid items-end gap-3 sm:grid-cols-2">
      <Field label={kind === 'designations' ? 'Designation title' : 'Name'} required><input className="input" name="name" minLength={2} maxLength={120} required /></Field>
      {kind !== 'designations' && <Field label="Code" required><input className="input" name="code" minLength={2} maxLength={24} required /></Field>}
      {kind === 'departments' && <Field label="Description"><input className="input" name="description" maxLength={255} /></Field>}
      {kind === 'locations' && <Field label="City"><input className="input" name="city" maxLength={80} /></Field>}
      {kind === 'designations' && <><Field label="Department" required><select className="input" name="departmentId" required defaultValue=""><option value="" disabled>Select a department</option>{items.departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Hierarchy level (1–20)"><input name="level" type="number" className="input" min={1} max={20} defaultValue={1} required /></Field></>}
      {kind === 'leave-types' && <><Field label="Annual allowance (days)"><input className="input" name="quota" type="number" min={0} max={366} step={0.5} required /></Field><label className="text-sm"><input name="paid" type="checkbox" /> Paid leave</label><label className="text-sm"><input name="document" type="checkbox" /> Supporting document required</label></>}
      <button className="btn-primary" type="submit">{busy ? 'Saving…' : 'Add record'}</button>
    </fieldset></form></Card>
    <Card><table className="table-base"><thead><tr><th>Name</th><th>{kind === 'leave-types' ? 'Code / annual allowance' : 'Code'}</th></tr></thead><tbody>{items[kind].map(item => <tr key={item.id}><td>{item.name || item.title}</td><td>{item.code || '—'}{kind === 'leave-types' ? ` / ${item.annual_quota} days` : ''}</td></tr>)}</tbody></table>{!items[kind].length && <p className="p-5 text-sm text-ink-500">{loading ? 'Loading records…' : 'No records yet. Add your organization data above.'}</p>}</Card>
  </div>;
}
