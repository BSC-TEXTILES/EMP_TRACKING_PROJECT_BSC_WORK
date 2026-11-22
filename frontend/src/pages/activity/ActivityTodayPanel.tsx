import React, { useState } from 'react';
import { Card, SectionHeader, EmptyState, Badge, Field } from '../../components/ui';
import { Icon } from '../../components/icons';
import { AppIcon } from '../../components/AppIcon';
import { cx, formatDate, formatDateTime, titleize } from '../../lib/format';
import { formatMinutes, type SelfDashboard, type AppUsage, type BrowserActivityItem } from './activityTypes';

interface ActivityTodayPanelProps {
  self: SelfDashboard;
  date: string;
  busy: boolean;
  notes: string;
  onNotesChange: (notes: string) => void;
  onSubmitDaily: () => void;
  canDelete: boolean;
  onRequestDelete: (type: 'app' | 'browser' | 'module' | 'work' | 'session', id: number, title: string, detail?: string) => void;
  onBulkDelete?: (items: { type: string; id: number }[]) => void;
}

export function ActivityTodayPanel({
  self,
  date,
  busy,
  notes,
  onNotesChange,
  onSubmitDaily,
  canDelete,
  onRequestDelete,
  onBulkDelete,
}: ActivityTodayPanelProps) {
  const [selectedApps, setSelectedApps] = useState<number[]>([]);
  const [selectedBrowsers, setSelectedBrowsers] = useState<number[]>([]);

  const maxAppSeconds = Math.max(1, ...(self.daily?.appBreakdown ?? []).map((item) => item.seconds));
  const appList = self.daily?.appBreakdown ?? [];
  const browserList = self.browser ?? [];

  const toggleSelectApp = (id: number) => {
    setSelectedApps((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleSelectBrowser = (id: number) => {
    setSelectedBrowsers((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleBulkDeleteApps = () => {
    if (!onBulkDelete || selectedApps.length === 0) return;
    const items = selectedApps.map((id) => ({ type: 'app', id }));
    onBulkDelete(items);
    setSelectedApps([]);
  };

  const handleBulkDeleteBrowsers = () => {
    if (!onBulkDelete || selectedBrowsers.length === 0) return;
    const items = selectedBrowsers.map((id) => ({ type: 'browser', id }));
    onBulkDelete(items);
    setSelectedBrowsers([]);
  };

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------ Row 1: App Usage & Browser Activity */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Card 1: Application Usage */}
        <Card className="card-pad border-ink-200/90 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-ink-100 pb-3">
              <SectionHeader
                title="Application Usage"
                description="Foreground active time only; background applications are excluded."
              />
              {canDelete && selectedApps.length > 0 && (
                <button
                  type="button"
                  className="btn-danger btn-sm text-xs inline-flex items-center gap-1.5"
                  onClick={handleBulkDeleteApps}
                >
                  <Icon name="trash" size={13} />
                  <span>Delete Selected ({selectedApps.length})</span>
                </button>
              )}
            </div>

            {!appList.length ? (
              <EmptyState
                compact
                title="No application activity recorded"
                description="Start a monitored work session with the desktop agent or browser extension to capture app usage."
              />
            ) : (
              <div className="mt-3.5 space-y-3">
                {appList.slice(0, 10).map((item, index) => {
                  const itemId = item.id ?? index + 1;
                  const isSelected = selectedApps.includes(itemId);
                  return (
                    <div
                      key={item.app + index}
                      className={cx(
                        'group rounded-lg p-2 transition-colors border',
                        isSelected ? 'bg-rose-50/50 border-rose-200' : 'border-transparent hover:bg-ink-50/70 hover:border-ink-200/60',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3 text-xs sm:text-sm">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {canDelete && item.id && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectApp(item.id!)}
                              className="h-3.5 w-3.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                              title="Select for deletion"
                            />
                          )}
                          <AppIcon name={item.app} size={18} />
                          <span className="truncate font-semibold text-ink-900">{item.app}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone="neutral">{item.category}</Badge>
                          <span className="w-16 text-right font-mono font-medium text-ink-700">
                            {formatMinutes(item.minutes)}
                          </span>
                          {canDelete && item.id && (
                            <button
                              type="button"
                              className="opacity-0 group-hover:opacity-100 rounded p-1 text-ink-400 hover:text-rose-600 hover:bg-rose-50 transition-all"
                              onClick={() =>
                                onRequestDelete(
                                  'app',
                                  item.id!,
                                  item.app,
                                  `${formatMinutes(item.minutes)} active time · ${item.category}`,
                                )
                              }
                              title="Delete this application usage record"
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
                        <div
                          className="h-full rounded-full bg-brand-600 transition-all duration-300"
                          style={{ width: `${Math.max(4, Math.round((item.seconds / maxAppSeconds) * 100))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-ink-100 flex items-center justify-between text-xs text-ink-500">
            <span>Total Logged Apps: {appList.length}</span>
            <span className="font-medium text-ink-700">Top 10 foreground processes shown</span>
          </div>
        </Card>

        {/* Card 2: Authorised Browser Activity */}
        <Card className="card-pad border-ink-200/90 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-ink-100 pb-3">
              <SectionHeader
                title="Authorised Browser Activity"
                description="Approved work domains only; URLs, search keywords and keystrokes are never recorded."
              />
              {canDelete && selectedBrowsers.length > 0 && (
                <button
                  type="button"
                  className="btn-danger btn-sm text-xs inline-flex items-center gap-1.5"
                  onClick={handleBulkDeleteBrowsers}
                >
                  <Icon name="trash" size={13} />
                  <span>Delete Selected ({selectedBrowsers.length})</span>
                </button>
              )}
            </div>

            {!browserList.length ? (
              <EmptyState
                compact
                title="No approved browsing recorded"
                description="Only domains explicitly permitted in the Monitoring Policy are monitored."
              />
            ) : (
              <div className="mt-3.5 divide-y divide-ink-100 dark:divide-ink-800/80">
                {browserList.map((item, index) => {
                  const itemId = item.id ?? index + 1;
                  const isSelected = selectedBrowsers.includes(itemId);
                  return (
                    <div
                      key={item.domain + index}
                      className={cx(
                        'group flex items-center justify-between gap-3 py-2.5 text-xs sm:text-sm transition-colors rounded-md px-1.5',
                        isSelected ? 'bg-rose-50/50' : 'hover:bg-ink-50/60',
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {canDelete && item.id && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectBrowser(item.id!)}
                            className="h-3.5 w-3.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                            title="Select for deletion"
                          />
                        )}
                        <Icon name="globe" size={15} className="text-brand-600 shrink-0" />
                        <span className="truncate font-medium text-ink-900">{item.domain}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge tone="info">{item.category}</Badge>
                        <span className="text-xs font-mono font-medium text-ink-600">
                          {formatMinutes(item.minutes)}
                        </span>
                        {canDelete && item.id && (
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 rounded p-1 text-ink-400 hover:text-rose-600 hover:bg-rose-50 transition-all"
                            onClick={() =>
                              onRequestDelete(
                                'browser',
                                item.id!,
                                item.domain,
                                `${formatMinutes(item.minutes)} · ${item.category}`,
                              )
                            }
                            title="Delete this browsing record"
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-ink-100 flex items-center justify-between text-xs text-ink-500">
            <span>Work Domains: {browserList.length}</span>
            <span>Policy Version {self.policy?.version ?? 2} compliance</span>
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------------ Row 2: Platform Modules & Key Activities */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Card 3: Platform Modules */}
        <Card className="card-pad border-ink-200/90 shadow-sm">
          <SectionHeader
            title="Platform Modules"
            description="Active time inside Workforce application modules during this work session."
          />
          {!self.daily?.moduleBreakdown?.length ? (
            <EmptyState
              compact
              title="No module activity yet"
              description="Platform module visits and durations are tracked automatically while active."
            />
          ) : (
            <div className="mt-3.5 divide-y divide-ink-100 dark:divide-ink-800/80">
              {self.daily.moduleBreakdown.map((item) => (
                <div key={item.module} className="flex items-center justify-between py-2.5 text-xs sm:text-sm">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-700">
                      <Icon name="tasks" size={13} />
                    </span>
                    <span className="font-semibold text-ink-900">{item.module}</span>
                  </div>
                  <span className="text-xs text-ink-500 font-mono">
                    {formatMinutes(Math.round(item.seconds / 60))} · {item.visits} visits
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Card 4: Key Activities */}
        <Card className="card-pad border-ink-200/90 shadow-sm">
          <SectionHeader
            title="Key Activities"
            description="Derived from your accepted tasks, daily reports and approved store events."
          />
          {!self.daily?.keyActivities?.length ? (
            <EmptyState
              compact
              title="No key activities extracted"
              description="Complete tasks or submit store work reports to populate this summary."
            />
          ) : (
            <ol className="mt-3.5 space-y-2 text-xs sm:text-sm text-ink-700">
              {self.daily.keyActivities.map((activity, index) => (
                <li key={index} className="flex items-start gap-2.5 rounded-lg border border-ink-100 bg-ink-50/40 p-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white">
                    {index + 1}
                  </span>
                  <span className="leading-snug">{activity}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------------------ Row 3: Daily Summary & Notes */}
      <Card className="card-pad border-ink-200/90 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
          <SectionHeader
            title="Daily Activity Summary"
            description={`Employee work submission for ${formatDate(date)}.`}
          />
          <Badge tone={self.daily?.status === 'approved' ? 'success' : self.daily?.status === 'submitted' ? 'info' : 'neutral'}>
            Status: {titleize(self.daily?.status ?? 'draft')}
          </Badge>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {/* Completed Tasks */}
          <div className="rounded-lg border border-ink-100 bg-surface-alt/40 p-3 space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-wider text-ink-600">Completed Store Tasks</p>
            {!self.daily?.taskSummary?.completedItems?.length ? (
              <p className="text-xs text-ink-500">No tasks completed on this date.</p>
            ) : (
              <ul className="space-y-1 text-xs text-ink-800">
                {self.daily.taskSummary.completedItems.map((task) => (
                  <li key={task.id} className="flex items-center gap-1.5">
                    <span className="font-mono text-brand-700 font-semibold">{task.taskNo}</span>
                    <span>·</span>
                    <span className="truncate">{task.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Issues and Tickets */}
          <div className="rounded-lg border border-ink-100 bg-surface-alt/40 p-3 space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-wider text-ink-600">Technical Issues & Incidents</p>
            {!self.daily?.issues?.length ? (
              <p className="text-xs text-ink-500">No technical issues recorded on this date.</p>
            ) : (
              <ul className="space-y-1 text-xs text-ink-800">
                {self.daily.issues.map((issue, index) => (
                  <li key={index} className="flex items-center justify-between gap-2">
                    <span className="truncate">{issue.title}</span>
                    <Badge tone={issue.severity === 'critical' ? 'danger' : 'warning'}>{issue.severity}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-4">
          <Field
            label="Your Daily Notes / Work Explanations"
            hint="Add operational context, customer walk notes, or manual task corrections for your manager."
          >
            <textarea
              className="input min-h-[85px] text-xs sm:text-sm"
              value={notes}
              onChange={(event) => onNotesChange(event.target.value)}
              placeholder="e.g. Completed store floor walk, assisted billing rush between 5 PM and 8 PM, reconciled cash balance..."
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-ink-100">
          <p className="text-xs text-ink-500">
            Derived from attendance checkpoints, monitored store applications, tasks, and checkout reports.
          </p>
          <button
            type="button"
            className="btn-primary btn-sm h-9 px-4 text-xs font-semibold"
            disabled={busy || self.daily?.status === 'approved'}
            onClick={onSubmitDaily}
          >
            {self.daily?.status === 'submitted' ? 'Resubmit Daily Summary' : 'Submit Summary to Manager'}
          </button>
        </div>

        {self.daily?.managerNote && (
          <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/70 p-3 text-xs text-brand-900">
            <span className="font-bold">Manager Remarks:</span> {self.daily.managerNote}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------ Row 4: Technical Issues & Tickets */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="card-pad border-ink-200/90 shadow-sm">
          <SectionHeader title="Technical Issues & Incident Logs" />
          {!self.errors.length ? (
            <EmptyState
              compact
              title="No technical issues"
              description="Application crashes and workstation telemetry errors are logged here."
            />
          ) : (
            <ul className="mt-3.5 divide-y divide-ink-100 text-xs sm:text-sm">
              {self.errors.map((issue) => (
                <li key={issue.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-ink-900">{issue.description}</span>
                    <Badge tone={issue.severity === 'critical' ? 'danger' : 'warning'}>{issue.severity}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500 font-mono">
                    {formatDateTime(issue.occurredAt)}
                    {issue.ticketId ? ` · Ticket #${issue.ticketId}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="card-pad border-ink-200/90 shadow-sm">
          <div className="flex items-center justify-between border-b border-ink-100 pb-3">
            <SectionHeader title="Helpdesk Tickets" />
            <a className="text-xs font-semibold text-brand-700 hover:underline inline-flex items-center gap-1" href="/tickets">
              <span>Open Helpdesk</span>
              <span>→</span>
            </a>
          </div>
          {!self.tickets.length ? (
            <EmptyState
              compact
              title="No tickets raised"
              description="Automated incident tickets and employee requests appear here."
            />
          ) : (
            <ul className="mt-3.5 divide-y divide-ink-100 text-xs sm:text-sm">
              {self.tickets.map((ticket) => (
                <li key={ticket.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <span className="font-mono text-xs font-semibold text-brand-700">{ticket.ticket_no}</span>
                    <p className="truncate text-ink-800">{ticket.subject}</p>
                  </div>
                  <Badge tone={ticket.status === 'resolved' || ticket.status === 'closed' ? 'success' : 'info'}>
                    {titleize(ticket.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
