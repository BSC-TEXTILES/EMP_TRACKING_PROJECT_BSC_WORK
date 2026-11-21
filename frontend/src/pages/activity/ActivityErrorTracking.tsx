import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { api, errorMessage } from '../../lib/api';
import { trackError } from '../../lib/errorTracking';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Card, EmptyState, Skeleton } from '../../components/ui';
import { Icon } from '../../components/icons';
import { formatDateTime } from '../../lib/format';

export interface SystemErrorEvent {
  id: number;
  employeeId: number | null;
  incidentId: number;
  incidentTitle: string;
  incidentStatus: 'open' | 'suggested' | 'ticket_created' | 'resolved' | 'ignored';
  occurrenceCount: number;
  employeeName: string;
  employeeCode?: string | null;
  application: string | null;
  module: string | null;
  category: string;
  errorCode: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  status: 'new' | 'grouped' | 'ticket_created' | 'suggested' | 'dismissed';
  occurredAt: string;
  clientEventId: string;
  diagnostic: Record<string, unknown>;
  ticketId: number | null;
  ticketNo?: string | null;
  ticketStatus?: string | null;
  assignedTechnician?: string | null;
}

export function ActivityErrorTracking() {
  const { user } = useAuth();
  const toast = useToast();

  const [errors, setErrors] = useState<SystemErrorEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIncidentId, setBusyIncidentId] = useState<number | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const fetchErrors = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await api.get<{ errors: SystemErrorEvent[] }>('/activity/errors');
      setErrors(data.errors || []);
    } catch (err) {
      toast.error(errorMessage(err) || 'Failed to fetch error tracking events');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchErrors();

    // Listen to real-time client error notifications
    const handleLocalErrorTracked = () => {
      void fetchErrors(true);
    };
    window.addEventListener('wfm:error-tracked', handleLocalErrorTracked);
    return () => {
      window.removeEventListener('wfm:error-tracked', handleLocalErrorTracked);
    };
  }, [fetchErrors]);

  const handleCreateTicket = async (incidentId: number) => {
    setBusyIncidentId(incidentId);
    try {
      const res = await api.post<{ ticketId: number; ticketNo?: string; existed: boolean }>(
        `/activity/errors/${incidentId}/ticket`,
        {}
      );
      toast.success(res.existed ? 'Incident already linked to ticket' : `IT Ticket ${res.ticketNo || res.ticketId} created`);
      void fetchErrors(true);
    } catch (err) {
      toast.error(errorMessage(err) || 'Failed to create helpdesk ticket');
    } finally {
      setBusyIncidentId(null);
    }
  };

  const handleDismissIncident = async (incidentId: number) => {
    setBusyIncidentId(incidentId);
    try {
      await api.post(`/activity/errors/${incidentId}/dismiss`, {});
      toast.success('Incident dismissed');
      void fetchErrors(true);
    } catch (err) {
      toast.error(errorMessage(err) || 'Failed to dismiss incident');
    } finally {
      setBusyIncidentId(null);
    }
  };

  const handleTriggerTestError = async () => {
    try {
      const testErr = new Error(`Manual Test Crash: Diagnostic verification at ${new Date().toLocaleTimeString()}`);
      testErr.name = 'DiagnosticTestError';
      const success = await trackError(testErr, {
        module: 'ErrorTrackingTestSuite',
        severity: 'medium',
        extra: { triggerSource: 'ActivityErrorTracking' },
      });
      if (success) {
        toast.success('Test error recorded to tracking engine');
        setTimeout(() => void fetchErrors(true), 600);
      } else {
        toast.info('Test error sent (or suppressed by deduplication cooldown)');
      }
    } catch (err) {
      toast.error(errorMessage(err) || 'Failed to emit test error');
    }
  };

  const handleCopyDiagnostic = (item: SystemErrorEvent) => {
    const text = JSON.stringify(
      {
        id: item.id,
        clientEventId: item.clientEventId,
        incidentId: item.incidentId,
        errorCode: item.errorCode,
        description: item.description,
        employee: item.employeeName,
        occurredAt: item.occurredAt,
        diagnostic: item.diagnostic,
      },
      null,
      2
    );
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => undefined);
  };

  // Metrics computation
  const metrics = useMemo(() => {
    const total = errors.length;
    const openIncidents = new Set(errors.filter((e) => e.incidentStatus === 'open' || e.incidentStatus === 'suggested').map((e) => e.incidentId)).size;
    const criticalOrHigh = errors.filter((e) => e.severity === 'critical' || e.severity === 'high').length;
    const withTickets = errors.filter((e) => Boolean(e.ticketId || e.ticketNo)).length;
    return { total, openIncidents, criticalOrHigh, withTickets };
  }, [errors]);

  // Filtered list
  const filteredErrors = useMemo(() => {
    return errors.filter((item) => {
      if (severityFilter !== 'all' && item.severity !== severityFilter) return false;
      if (statusFilter !== 'all') {
        if (statusFilter === 'open' && !['open', 'suggested', 'new'].includes(item.incidentStatus)) return false;
        if (statusFilter === 'ticket_created' && item.incidentStatus !== 'ticket_created' && !item.ticketId) return false;
        if (statusFilter === 'dismissed' && item.status !== 'dismissed' && item.incidentStatus !== 'ignored') return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchesDesc = item.description?.toLowerCase().includes(q);
        const matchesCode = item.errorCode?.toLowerCase().includes(q);
        const matchesEmp = item.employeeName?.toLowerCase().includes(q);
        const matchesMod = item.module?.toLowerCase().includes(q);
        const matchesTicket = item.ticketNo?.toLowerCase().includes(q);
        if (!matchesDesc && !matchesCode && !matchesEmp && !matchesMod && !matchesTicket) return false;
      }
      return true;
    });
  }, [errors, severityFilter, statusFilter, search]);

  const severityTone = (sev: string): 'danger' | 'warning' | 'info' | 'neutral' => {
    if (sev === 'critical') return 'danger';
    if (sev === 'high') return 'warning';
    if (sev === 'medium') return 'info';
    return 'neutral';
  };

  return (
    <div className="space-y-5">
      {/* 1. Header & Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4 border border-ink-200 bg-white shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">Total Errors</span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-100 text-ink-700">
              <Icon name="alertTriangle" size={16} />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-ink-900">{loading ? '…' : metrics.total}</div>
          <p className="mt-1 text-xs text-ink-500">Tracked telemetry events</p>
        </Card>

        <Card className="p-4 border border-amber-200 bg-amber-50/40 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-700">Open Incidents</span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-800">
              <Icon name="shield" size={16} />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-900">{loading ? '…' : metrics.openIncidents}</div>
          <p className="mt-1 text-xs text-amber-600">Pending review or ticket</p>
        </Card>

        <Card className="p-4 border border-rose-200 bg-rose-50/40 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-700">High / Critical</span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100 text-rose-800">
              <Icon name="alertTriangle" size={16} />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-rose-900">{loading ? '…' : metrics.criticalOrHigh}</div>
          <p className="mt-1 text-xs text-rose-600">Priority crashes & exceptions</p>
        </Card>

        <Card className="p-4 border border-blue-200 bg-blue-50/40 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-700">IT Tickets Linked</span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 text-blue-800">
              <Icon name="ticket" size={16} />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-blue-900">{loading ? '…' : metrics.withTickets}</div>
          <p className="mt-1 text-xs text-blue-600">Automated helpdesk tickets</p>
        </Card>
      </div>

      {/* 2. Controls & Filter Bar */}
      <Card className="p-4 border border-ink-200 bg-white shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2.5">
            {/* Search Input */}
            <div className="relative min-w-[240px] flex-1 max-w-md">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-ink-400">
                <Icon name="search" size={15} />
              </span>
              <input
                type="text"
                placeholder="Search error code, module, description or employee…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-ink-200 bg-ink-50/50 py-2 pl-9 pr-3 text-xs text-ink-900 placeholder-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-ink-400 hover:text-ink-600"
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>

            {/* Severity Filter */}
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="rounded-lg border border-ink-200 bg-white px-2.5 py-2 text-xs font-medium text-ink-700 focus:border-brand-500 focus:outline-none"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-ink-200 bg-white px-2.5 py-2 text-xs font-medium text-ink-700 focus:border-brand-500 focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="open">Open / Suggested</option>
              <option value="ticket_created">IT Ticket Created</option>
              <option value="dismissed">Dismissed / Resolved</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTriggerTestError}
              className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors"
              title="Emits a simulated diagnostic crash to verify end-to-end telemetry recording"
            >
              <Icon name="play" size={13} />
              Test Error Tracker
            </button>

            <button
              type="button"
              onClick={() => void fetchErrors(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs font-semibold text-ink-700 hover:bg-ink-50 transition-colors disabled:opacity-60"
            >
              <Icon name="refresh" size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </Card>

      {/* 3. Incident List */}
      <div className="space-y-3">
        {loading ? (
          <Skeleton lines={6} />
        ) : filteredErrors.length === 0 ? (
          <EmptyState
            title="No Error Events Found"
            description={search || severityFilter !== 'all' || statusFilter !== 'all' ? 'Try adjusting your search criteria.' : 'No system errors or runtime exceptions have been reported.'}
          />
        ) : (
          filteredErrors.map((item) => {
            const isExpanded = expandedId === item.id;
            const isCopied = copiedId === item.id;
            const isBusy = busyIncidentId === item.incidentId;
            const hasTicket = Boolean(item.ticketId || item.ticketNo);

            return (
              <div
                key={item.id}
                className={`overflow-hidden rounded-xl border bg-white shadow-xs transition-all ${
                  item.severity === 'critical'
                    ? 'border-rose-300 ring-1 ring-rose-200'
                    : item.severity === 'high'
                    ? 'border-amber-300'
                    : 'border-ink-200'
                }`}
              >
                {/* Main Card Header / Bar */}
                <div className="p-4">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Severity Badge */}
                        <Badge tone={severityTone(item.severity)} className="capitalize font-semibold text-[11px] px-2 py-0.5">
                          {item.severity}
                        </Badge>

                        {/* Error Code */}
                        {item.errorCode && (
                          <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-ink-700">
                            {item.errorCode}
                          </span>
                        )}

                        {/* Module Tag */}
                        <span className="rounded border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-600">
                          {item.module || 'Web Client'}
                        </span>

                        {/* Occurrence count */}
                        {item.occurrenceCount > 1 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                            {item.occurrenceCount}x occurrences
                          </span>
                        )}

                        {/* Ticket Indicator */}
                        {hasTicket ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 border border-blue-200">
                            <Icon name="ticket" size={12} />
                            Ticket #{item.ticketNo || item.ticketId} {item.ticketStatus ? `(${item.ticketStatus})` : ''}
                          </span>
                        ) : item.incidentStatus === 'suggested' ? (
                          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 border border-amber-200">
                            Suggested for Ticket
                          </span>
                        ) : null}
                      </div>

                      {/* Description */}
                      <p className="text-sm font-semibold text-ink-900 break-words leading-snug pt-0.5">
                        {item.description}
                      </p>

                      {/* Meta: Employee, Time, App */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
                        <span className="flex items-center gap-1">
                          <Icon name="user" size={13} className="text-ink-400" />
                          <strong className="text-ink-700">{item.employeeName}</strong>
                          {item.employeeCode && <span className="text-ink-400">({item.employeeCode})</span>}
                        </span>

                        <span className="flex items-center gap-1">
                          <Icon name="clock" size={13} className="text-ink-400" />
                          {formatDateTime(item.occurredAt)}
                        </span>

                        {item.application && (
                          <span className="flex items-center gap-1 text-ink-400">
                            <Icon name="monitor" size={13} />
                            {item.application}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0 pt-1 sm:pt-0">
                      {!hasTicket && item.incidentStatus !== 'ignored' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleCreateTicket(item.incidentId)}
                          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 transition-colors disabled:opacity-50"
                        >
                          <Icon name="plus" size={13} />
                          Open Ticket
                        </button>
                      )}

                      {!hasTicket && ['open', 'suggested'].includes(item.incidentStatus) && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleDismissIncident(item.incidentId)}
                          className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 transition-colors disabled:opacity-50"
                        >
                          <Icon name="check" size={13} />
                          Dismiss
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleCopyDiagnostic(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 transition-colors"
                        title="Copy diagnostic information to clipboard"
                      >
                        <Icon name={isCopied ? 'check' : 'copy'} size={13} />
                        {isCopied ? 'Copied' : 'Copy'}
                      </button>

                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : item.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 transition-colors"
                      >
                        <Icon name={isExpanded ? 'chevronUp' : 'chevronDown'} size={14} />
                        {isExpanded ? 'Less' : 'Details'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Collapsible Diagnostics Section */}
                {isExpanded && (
                  <div className="border-t border-ink-100 bg-ink-950 p-4 font-mono text-xs text-ink-100">
                    <div className="flex items-center justify-between pb-2 border-b border-ink-800 mb-3 text-ink-400">
                      <span className="font-semibold text-ink-300">Technical Diagnostic Payload</span>
                      <span>Client Event: {item.clientEventId}</span>
                    </div>

                    <div className="space-y-2">
                      {item.diagnostic?.path ? (
                        <div>
                          <span className="text-emerald-400 font-semibold">Route / Path: </span>
                          <span className="text-ink-200">{String(item.diagnostic.path)}</span>
                        </div>
                      ) : null}

                      {item.diagnostic?.userAgent ? (
                        <div>
                          <span className="text-cyan-400 font-semibold">User Agent: </span>
                          <span className="text-ink-300">{String(item.diagnostic.userAgent)}</span>
                        </div>
                      ) : null}

                      {item.diagnostic?.stack ? (
                        <div className="pt-2">
                          <span className="text-rose-400 font-semibold">Stack Trace:</span>
                          <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink-900 p-2 text-[11px] text-ink-200 whitespace-pre-wrap">
                            {String(item.diagnostic.stack)}
                          </pre>
                        </div>
                      ) : null}

                      {item.diagnostic?.componentStack ? (
                        <div className="pt-2">
                          <span className="text-amber-400 font-semibold">React Component Hierarchy:</span>
                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-ink-900 p-2 text-[11px] text-ink-300 whitespace-pre-wrap">
                            {String(item.diagnostic.componentStack)}
                          </pre>
                        </div>
                      ) : null}

                      <div className="pt-2">
                        <span className="text-ink-400 font-semibold">Raw Diagnostic JSON:</span>
                        <pre className="mt-1 max-h-36 overflow-auto rounded bg-ink-900 p-2 text-[11px] text-ink-400">
                          {JSON.stringify(item.diagnostic, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
