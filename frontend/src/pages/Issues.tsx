import { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useSocketEvent } from '../contexts/RealtimeContext';
import { api, errorMessage } from '../lib/api';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';
import type { IssueItem } from '../lib/types';
import { IssueCards } from './issues/IssueCards';
import { IssueDetailModal } from './issues/IssueDetailModal';
import { RaiseIssueModal } from './issues/RaiseIssueModal';
import { EscalationRulesModal } from './issues/EscalationRulesModal';
import { EditIssueModal } from './issues/EditIssueModal';
import { DeleteIssueModal } from './issues/DeleteIssueModal';

export default function Issues() {
  const { user, has } = useAuth();
  const toast = useToast();

  const isSuperAdmin = user?.roleSlug === 'super_admin' || (user?.roleLevel ?? 0) >= 90;
  const isManager = Boolean((user?.roleLevel ?? 0) >= 50 || user?.permissions?.includes('issues.view.team') || isSuperAdmin);

  // Filter and tab states
  const [activeTab, setActiveTab] = useState<'my_issues' | 'assigned_to_me' | 'team_issues' | 'escalated' | 'all'>('my_issues');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState<number | ''>('');
  const [locations, setLocations] = useState<{ id: number; name: string; code: string }[]>([]);

  // Data states
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Metrics summary
  const [summary, setSummary] = useState({
    myOpen: 0,
    assignedPending: 0,
    assignedInProgress: 0,
    escalated: 0,
    overdue: 0,
    resolvedToday: 0,
  });

  // Modals
  const [raiseModalOpen, setRaiseModalOpen] = useState(false);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [editIssue, setEditIssue] = useState<IssueItem | null>(null);
  const [deleteConfirmIssue, setDeleteConfirmIssue] = useState<IssueItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Check URL query parameters for deep linking (e.g. ?id=123)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idParam = params.get('id');
    if (idParam) {
      const parsed = parseInt(idParam, 10);
      if (!Number.isNaN(parsed)) setSelectedIssueId(parsed);
    }
  }, []);

  // Fetch locations
  useEffect(() => {
    api.get<{ locations: any[] }>('/organization/locations')
      .then((res) => setLocations(res.locations ?? []))
      .catch(() => undefined);
  }, []);

  const fetchSummary = async () => {
    try {
      const res = await api.get<any>('/issues/summary');
      setSummary(res);
    } catch {
      // non-blocking
    }
  };

  const fetchIssues = async () => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams();
      queryParams.set('tab', activeTab);
      queryParams.set('page', String(page));
      queryParams.set('pageSize', '24');
      if (search.trim()) queryParams.set('search', search.trim());
      if (statusFilter) queryParams.set('status', statusFilter);
      if (priorityFilter) queryParams.set('priority', priorityFilter);
      if (categoryFilter) queryParams.set('category', categoryFilter);
      if (locationFilter) queryParams.set('locationId', String(locationFilter));

      const res = await api.get<{ items: IssueItem[]; total: number }>(`/issues?${queryParams.toString()}`);
      setIssues(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchIssues();
    void fetchSummary();
  }, [activeTab, page, statusFilter, priorityFilter, categoryFilter, locationFilter]);

  // Realtime Socket listeners
  useSocketEvent('issue:created', () => {
    void fetchIssues();
    void fetchSummary();
  });
  useSocketEvent('issue:updated', () => {
    void fetchIssues();
    void fetchSummary();
  });
  useSocketEvent('issue:escalated', () => {
    void fetchIssues();
    void fetchSummary();
  });
  useSocketEvent('issue:deleted', (data: any) => {
    void fetchIssues();
    void fetchSummary();
    if (selectedIssueId && data?.issueId === selectedIssueId) {
      setSelectedIssueId(null);
    }
  });

  const handleDeleteIssue = async () => {
    if (!deleteConfirmIssue) return;
    setDeleteBusy(true);
    try {
      await api.del(`/issues/${deleteConfirmIssue.id}`);
      toast.success(`Issue ${deleteConfirmIssue.issue_no} deleted successfully.`);
      if (selectedIssueId === deleteConfirmIssue.id) {
        setSelectedIssueId(null);
      }
      setDeleteConfirmIssue(null);
      void fetchIssues();
      void fetchSummary();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    void fetchIssues();
  };

  const handleAcknowledge = async (id: number) => {
    try {
      await api.post(`/issues/${id}/acknowledge`, {});
      toast.success('Issue acknowledged.');
      void fetchIssues();
      void fetchSummary();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleQuickEscalate = (id: number) => {
    setSelectedIssueId(id);
  };

  return (
    <div className="space-y-5">
      {/* --------------------------------- Top Header */}
      <header className="rounded-xl border border-ink-200 bg-white p-4 sm:p-5 shadow-xs">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-brand-700 bg-brand-50 px-2 py-0.5 rounded border border-brand-200">
                Operational Escalations
              </span>
              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live Sync Active
              </span>
            </div>
            <h1 className="mt-1.5 text-xl font-bold text-ink-900 sm:text-2xl">
              Issue Management & Automatic Escalation
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-ink-600">
              Report operational blockers, track SLA response timelines, and auto-escalate unacknowledged issues across store locations.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                void fetchIssues();
                void fetchSummary();
                toast.success('Issues synchronized.');
              }}
              className="btn-secondary btn-sm inline-flex items-center gap-1.5"
            >
              <Icon name="refresh" size={14} />
              <span>Refresh</span>
            </button>

            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => setRulesModalOpen(true)}
                className="btn-secondary btn-sm inline-flex items-center gap-1.5 text-ink-700"
              >
                <Icon name="settings" size={14} />
                <span>SLA Rules</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setRaiseModalOpen(true)}
              className="btn-primary btn-sm inline-flex items-center gap-1.5 shadow-sm"
            >
              <Icon name="plus" size={14} />
              <span>Raise Issue</span>
            </button>
          </div>
        </div>
      </header>

      {/* --------------------------------- Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <button
          type="button"
          onClick={() => {
            setActiveTab('my_issues');
            setStatusFilter('');
          }}
          className={cx(
            'flex flex-col rounded-xl border p-3.5 text-left transition-all shadow-xs cursor-pointer',
            activeTab === 'my_issues' && !statusFilter
              ? 'border-brand-500 bg-brand-50/40 ring-2 ring-brand-500/20'
              : 'border-ink-200 bg-white hover:border-ink-300'
          )}
        >
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-500">My Open</span>
          <span className="mt-1 text-2xl font-black text-ink-900">{summary.myOpen}</span>
          <span className="text-[10px] text-ink-400 mt-0.5">Raised by you</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('assigned_to_me');
            setStatusFilter('pending');
          }}
          className={cx(
            'flex flex-col rounded-xl border p-3.5 text-left transition-all shadow-xs cursor-pointer',
            activeTab === 'assigned_to_me' && statusFilter === 'pending'
              ? 'border-amber-500 bg-amber-50/40 ring-2 ring-amber-500/20'
              : 'border-ink-200 bg-white hover:border-ink-300'
          )}
        >
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Awaiting Ack</span>
          <span className="mt-1 text-2xl font-black text-amber-900">{summary.assignedPending}</span>
          <span className="text-[10px] text-amber-600 mt-0.5">Assigned pending ack</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('assigned_to_me');
            setStatusFilter('in_progress');
          }}
          className={cx(
            'flex flex-col rounded-xl border p-3.5 text-left transition-all shadow-xs cursor-pointer',
            activeTab === 'assigned_to_me' && statusFilter === 'in_progress'
              ? 'border-blue-500 bg-blue-50/40 ring-2 ring-blue-500/20'
              : 'border-ink-200 bg-white hover:border-ink-300'
          )}
        >
          <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">In Progress</span>
          <span className="mt-1 text-2xl font-black text-blue-900">{summary.assignedInProgress}</span>
          <span className="text-[10px] text-blue-600 mt-0.5">Active investigation</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('escalated');
            setStatusFilter('');
          }}
          className={cx(
            'flex flex-col rounded-xl border p-3.5 text-left transition-all shadow-xs cursor-pointer',
            activeTab === 'escalated'
              ? 'border-purple-500 bg-purple-50/40 ring-2 ring-purple-500/20'
              : 'border-ink-200 bg-white hover:border-ink-300'
          )}
        >
          <span className="text-[11px] font-bold uppercase tracking-wider text-purple-700">Escalated</span>
          <span className="mt-1 text-2xl font-black text-purple-900">{summary.escalated}</span>
          <span className="text-[10px] text-purple-600 mt-0.5">Higher authority review</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('all');
            setStatusFilter('');
            setPriorityFilter('critical');
          }}
          className={cx(
            'flex flex-col rounded-xl border p-3.5 text-left transition-all shadow-xs cursor-pointer',
            priorityFilter === 'critical'
              ? 'border-red-500 bg-red-50/40 ring-2 ring-red-500/20'
              : 'border-ink-200 bg-white hover:border-ink-300'
          )}
        >
          <span className="text-[11px] font-bold uppercase tracking-wider text-red-700">Overdue / SLA</span>
          <span className="mt-1 text-2xl font-black text-red-900">{summary.overdue}</span>
          <span className="text-[10px] text-red-600 mt-0.5">Breached deadlines</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('all');
            setStatusFilter('resolved');
            setPriorityFilter('');
          }}
          className={cx(
            'flex flex-col rounded-xl border p-3.5 text-left transition-all shadow-xs cursor-pointer',
            statusFilter === 'resolved'
              ? 'border-emerald-500 bg-emerald-50/40 ring-2 ring-emerald-500/20'
              : 'border-ink-200 bg-white hover:border-ink-300'
          )}
        >
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Resolved Today</span>
          <span className="mt-1 text-2xl font-black text-emerald-900">{summary.resolvedToday}</span>
          <span className="text-[10px] text-emerald-600 mt-0.5">Closed operations</span>
        </button>
      </div>

      {/* --------------------------------- Scope Tabs & Filters Container */}
      <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-xs space-y-3.5">
        {/* Navigation Tabs */}
        <div className="flex items-center justify-between border-b border-ink-100 pb-3 flex-wrap gap-2">
          <div className="flex gap-1 overflow-x-auto rounded-lg bg-ink-100 p-1" role="tablist">
            {[
              { id: 'my_issues', label: 'My Raised Issues', show: true },
              { id: 'assigned_to_me', label: 'Assigned to Me', show: true },
              { id: 'team_issues', label: 'Team Issues', show: isManager },
              { id: 'escalated', label: 'Escalations', show: true },
              { id: 'all', label: 'All Store Issues', show: isManager },
            ]
              .filter((t) => t.show)
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.id as any);
                    setPage(1);
                  }}
                  className={cx(
                    'shrink-0 whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-bold transition-all',
                    activeTab === tab.id
                      ? 'bg-white text-ink-900 shadow-xs'
                      : 'text-ink-600 hover:text-ink-900'
                  )}
                >
                  {tab.label}
                </button>
              ))}
          </div>

          <span className="text-xs font-bold text-ink-500">
            {total} {total === 1 ? 'Issue' : 'Issues'} Found
          </span>
        </div>

        {/* Filters Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          {/* Search */}
          <form onSubmit={handleSearchSubmit} className="lg:col-span-2 relative">
            <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              type="text"
              placeholder="Search reference #, title, reporter, or description…"
              className="input pl-8 py-1.5 text-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>

          {/* Priority */}
          <div>
            <select
              className="input py-1.5 text-xs font-medium"
              value={priorityFilter}
              onChange={(e) => {
                setPriorityFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* Status */}
          <div>
            <select
              className="input py-1.5 text-xs font-medium"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="escalated">Escalated</option>
              <option value="on_hold">On Hold</option>
              <option value="resolved">Resolved</option>
              <option value="reopened">Reopened</option>
              <option value="closed">Closed</option>
            </select>
          </div>

          {/* Store Location */}
          <div>
            <select
              className="input py-1.5 text-xs font-medium"
              value={locationFilter}
              onChange={(e) => {
                setLocationFilter(e.target.value ? Number(e.target.value) : '');
                setPage(1);
              }}
            >
              <option value="">All Store Locations</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.code} · {loc.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* --------------------------------- Issue Cards */}
      {loading ? (
        <div className="py-20 text-center text-sm text-ink-500 rounded-xl bg-white border border-ink-200">
          Loading operational issues…
        </div>
      ) : (
        <IssueCards
          issues={issues}
          currentUserId={user?.id}
          isManagerOrAdmin={isManager}
          onOpen={(id) => setSelectedIssueId(id)}
          onAcknowledge={handleAcknowledge}
          onEscalate={handleQuickEscalate}
          onEdit={(issue) => setEditIssue(issue)}
          onDelete={(issue) => setDeleteConfirmIssue(issue)}
        />
      )}

      {/* --------------------------------- Modals */}
      <RaiseIssueModal
        open={raiseModalOpen}
        onClose={() => setRaiseModalOpen(false)}
        onCreated={(newId) => {
          void fetchIssues();
          void fetchSummary();
          setSelectedIssueId(newId);
        }}
      />

      <IssueDetailModal
        issueId={selectedIssueId}
        open={!!selectedIssueId}
        onClose={() => setSelectedIssueId(null)}
        onUpdated={() => {
          void fetchIssues();
          void fetchSummary();
        }}
      />

      <EditIssueModal
        issue={editIssue}
        open={Boolean(editIssue)}
        onClose={() => setEditIssue(null)}
        onSaved={() => {
          void fetchIssues();
          void fetchSummary();
        }}
      />

      <DeleteIssueModal
        issue={deleteConfirmIssue}
        open={Boolean(deleteConfirmIssue)}
        busy={deleteBusy}
        onClose={() => setDeleteConfirmIssue(null)}
        onConfirm={handleDeleteIssue}
      />

      <EscalationRulesModal
        open={rulesModalOpen}
        onClose={() => setRulesModalOpen(false)}
      />
    </div>
  );
}
