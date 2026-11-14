import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useAuth } from '../contexts/AuthContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { Badge, Card, EmptyState, Field, Modal, PageHeader, ProgressBar, SectionHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { downloadReport } from '../lib/api';
import { formatDateTime, titleize } from '../lib/format';
import type { KpiItem } from '../lib/types';

interface ParameterScore {
  key: string;
  label: string;
  weight: number;
  score: number;
  weighted: number;
  available: boolean;
  note?: string;
  raw?: number | string | null;
}

interface KpiDetail {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  designationTitle: string | null;
  period: string;
  templateName: string;
  scores: ParameterScore[];
  metrics: Record<string, unknown>;
  totalScore: number;
  category: string;
  status: string;
  strengths: string | null;
  improvements: string | null;
  managerComment: string | null;
  employeeComment: string | null;
  computedAt: string | null;
  reviewedAt: string | null;
  publishedAt: string | null;
}

interface KpiParameter {
  key: string;
  label: string;
  weight: number;
  description?: string;
}

export default function Kpi() {
  useDocumentTitle('Performance & KPI');
  const { has, user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'mine' | 'team' | 'all'>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'all' && has('kpi.view.all')) return 'all';
    if (requested === 'team' && has('kpi.view.team', 'kpi.view.all')) return 'team';
    return 'mine';
  });
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [items, setItems] = useState<KpiItem[] | null>(null);
  const [detail, setDetail] = useState<KpiDetail | null>(null);
  const [parameters, setParameters] = useState<KpiParameter[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [review, setReview] = useState({ strengths: '', improvements: '', managerComment: '' });
  const [employeeComment, setEmployeeComment] = useState('');

  const load = async () => {
    try {
      const scope = tab === 'mine' ? '' : `&scope=${tab}`;
      const result = await api.get<{ items: KpiItem[] }>(`/kpi?period=${period}${scope}`);
      setItems(result.items);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, period]);

  useEffect(() => {
    api
      .get<{ parameters: KpiParameter[]; templateId?: number }>('/kpi/parameters')
      .then((result) => {
        setParameters(result.parameters);
        setTemplateId(result.templateId ?? null);
      })
      .catch(() => undefined);
  }, []);

  useSocketEvent('notification:new', () => void load());

  const openDetail = async (id: number) => {
    try {
      const result = await api.get<KpiDetail>(`/kpi/${id}`);
      setDetail(result);
      setReview({ strengths: result.strengths ?? '', improvements: result.improvements ?? '', managerComment: result.managerComment ?? '' });
      setEmployeeComment(result.employeeComment ?? '');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ generated: number }>('/kpi/generate', { period });
      toast.success(`Generated ${result.generated} KPI evaluation(s) for ${period}.`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!window.confirm(`Publish all evaluations for ${period}? Employees will be notified.`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ published: number }>('/kpi/publish', { period });
      toast.success(`Published ${result.published} evaluation(s).`);
      await load();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveReview = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.post<KpiDetail>(`/kpi/${detail.id}/review`, review);
      setDetail(result);
      toast.success('Review saved. The weighted score was recalculated.');
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
        title="Monthly KPI & performance"
        description="Transparent, weighted scoring. Unavailable metrics are excluded and weights redistributed so missing data never counts as poor performance."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => downloadReport({ type: 'kpi', format: 'xlsx', period })}>
              Export
            </button>
            {has('kpi.review', 'kpi.publish') && (
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setWeightsOpen(true)}>
                Weights
              </button>
            )}
            {has('kpi.configure', 'kpi.review') && (
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void generate()}>
                Generate {period}
              </button>
            )}
            {has('kpi.publish') && (
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void publish()}>
                Publish
              </button>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-2">
          <Tabs
            tabs={[
              { value: 'mine', label: 'My KPI' },
              ...(has('kpi.view.team', 'kpi.view.all') ? [{ value: 'team', label: 'My team' }] : []),
              ...(has('kpi.view.all') ? [{ value: 'all', label: 'Organisation' }] : []),
            ]}
            value={tab}
            onChange={(value) => setTab(value as 'mine' | 'team' | 'all')}
          />
          <input type="month" className="input mb-1 w-auto" value={period} onChange={(event) => setPeriod(event.target.value)} />
        </div>

        {!items ? (
          <div className="p-4">
            <Skeleton lines={6} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No evaluations for this period"
            description={has('kpi.configure', 'kpi.review') ? 'Generate evaluations to score the month from recorded data.' : 'Your manager has not published an evaluation for this period yet.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Score</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Computed</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="cursor-pointer" onClick={() => void openDetail(item.id)}>
                    <td>
                      <p className="font-medium text-ink-800">{item.employeeName}</p>
                      <p className="text-xs text-ink-400">{item.employeeCode} · {item.designationTitle ?? ''}</p>
                    </td>
                    <td className="text-ink-600">{item.departmentName ?? '—'}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink-900">{item.totalScore.toFixed(1)}</span>
                        <div className="w-16"><ProgressBar value={item.totalScore} tone={item.totalScore >= 80 ? 'success' : item.totalScore >= 60 ? 'brand' : 'danger'} /></div>
                      </div>
                    </td>
                    <td><Badge tone={item.category === 'Excellent' ? 'success' : item.category === 'Needs Improvement' ? 'warning' : 'brand'}>{item.category}</Badge></td>
                    <td><StatusBadge status={item.status} /></td>
                    <td className="text-xs text-ink-500">{formatDateTime(item.computedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="card-pad">
        <SectionHeader title="How scoring works" description="Every parameter is normalised to 0–100, multiplied by its configured weight and summed." />
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {parameters.map((parameter) => (
            <div key={parameter.key} className="rounded-lg border border-ink-200 p-2.5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink-800">{parameter.label}</p>
                <Badge tone="neutral">{parameter.weight}%</Badge>
              </div>
              {parameter.description && <p className="mt-0.5 text-xs text-ink-500">{parameter.description}</p>}
            </div>
          ))}
        </div>
      </Card>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail ? `${detail.employeeName} · ${detail.period}` : ''} size="xl"
        description={detail ? `${detail.templateName} · computed ${formatDateTime(detail.computedAt)}` : undefined}
        footer={
          detail ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-ink-500">Published evaluations are locked to protect the audit trail.</span>
              <div className="flex gap-2">
                {has('kpi.review') && detail.status !== 'published' && (
                  <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveReview()}>
                    Save review
                  </button>
                )}
                <button type="button" className="btn-secondary btn-sm" onClick={() => setDetail(null)}>Close</button>
              </div>
            </div>
          ) : null
        }
      >
        {detail && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <p className="text-3xl font-semibold text-ink-900">{detail.totalScore.toFixed(1)}<span className="text-base text-ink-400">/100</span></p>
                <p className="text-xs text-ink-500">{detail.category}</p>
              </div>
              <div className="flex-1"><ProgressBar value={detail.totalScore} /></div>
              <StatusBadge status={detail.status} />
            </div>

            <div>
              <SectionHeader title="Parameter breakdown" />
              <div className="mt-2 space-y-1.5">
                {detail.scores.map((score) => (
                  <div key={score.key} className={`rounded-lg border p-2.5 ${score.available ? 'border-ink-200' : 'border-dashed border-ink-200 bg-ink-50'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-ink-800">{score.label}</p>
                        <Badge tone="neutral">{score.weight}%</Badge>
                        {!score.available && <Badge tone="warning">No data</Badge>}
                      </div>
                      <p className="text-sm text-ink-700">
                        {score.available ? `${score.score.toFixed(1)} → ${score.weighted.toFixed(2)} pts` : 'excluded, weight redistributed'}
                      </p>
                    </div>
                    {score.available && <div className="mt-1.5"><ProgressBar value={score.score} tone={score.score >= 75 ? 'success' : score.score >= 50 ? 'brand' : 'danger'} /></div>}
                    {score.note && <p className="mt-1 text-[11px] text-ink-500">{score.note}</p>}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Strengths">
                <textarea className="input min-h-[70px]" value={review.strengths} onChange={(event) => setReview({ ...review, strengths: event.target.value })} disabled={detail.status === 'published'} />
              </Field>
              <Field label="Areas for improvement">
                <textarea className="input min-h-[70px]" value={review.improvements} onChange={(event) => setReview({ ...review, improvements: event.target.value })} disabled={detail.status === 'published'} />
              </Field>
            </div>
            <Field label="Manager comment">
              <textarea className="input min-h-[70px]" value={review.managerComment} onChange={(event) => setReview({ ...review, managerComment: event.target.value })} disabled={detail.status === 'published'} />
            </Field>

            <div>
              <SectionHeader title="Employee comment" />
              {detail.employeeId === user?.id ? (
                <form className="mt-2 flex gap-2" onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    await api.post(`/kpi/${detail.id}/comment`, { comment: employeeComment });
                    toast.success('Comment saved.');
                  } catch (caught) { toast.error(errorMessage(caught)); }
                }}>
                  <input className="input" value={employeeComment} onChange={(event) => setEmployeeComment(event.target.value)} placeholder="Add your response" />
                  <button type="submit" className="btn-secondary btn-sm" disabled={!employeeComment.trim()}>Save</button>
                </form>
              ) : (
                <p className="mt-1 text-sm text-ink-600">{detail.employeeComment ?? 'No employee comment.'}</p>
              )}
            </div>

            <p className="text-xs text-ink-400">
              Raw metrics: {Object.entries(detail.metrics).map(([key, value]) => `${key}=${String(value)}`).join(' · ')}
            </p>
          </div>
        )}
      </Modal>

      <WeightsModal open={weightsOpen} onClose={() => setWeightsOpen(false)} parameters={parameters} templateId={templateId} onSaved={() => { setWeightsOpen(false); toast.success('Weights updated for future evaluations.'); }} />
    </div>
  );
}

function WeightsModal({ open, onClose, parameters, templateId, onSaved }: { open: boolean; onClose: () => void; parameters: KpiParameter[]; templateId: number | null; onSaved: () => void }) {
  const toast = useToast();
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setWeights(Object.fromEntries(parameters.map((parameter) => [parameter.key, parameter.weight])));
  }, [open, parameters]);

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

  const save = async () => {
    if (!templateId) {
      toast.error('KPI template not found.');
      return;
    }
    if (total !== 100) {
      toast.error(`Weights must total 100% (currently ${total}%).`);
      return;
    }
    setBusy(true);
    try {
      await api.put('/kpi/parameters', { templateId, weights: Object.entries(weights).map(([key, weight]) => ({ key, weight })) });
      onSaved();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Configure KPI weights" description="Weights apply to new evaluations generated after saving and are recorded in the audit log."
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>Save weights</button></>}>
      <div className="space-y-2">
        {parameters.map((parameter) => (
          <div key={parameter.key} className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-ink-800">{titleize(parameter.label)}</p>
              {parameter.description && <p className="text-xs text-ink-500">{parameter.description}</p>}
            </div>
            <input type="number" min={0} max={100} className="input w-20" value={weights[parameter.key] ?? 0} onChange={(event) => setWeights({ ...weights, [parameter.key]: Number(event.target.value) })} />
            <span className="w-4 text-sm text-ink-500">%</span>
          </div>
        ))}
        <div className={`rounded-lg px-3 py-2 text-sm ${total === 100 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          Total: {total}% {total === 100 ? '✓' : '(must equal 100%)'}
        </div>
      </div>
    </Modal>
  );
}
