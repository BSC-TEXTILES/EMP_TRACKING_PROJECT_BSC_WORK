import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '../../lib/hooks';
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton, StatCard } from '../../components/ui';
import { Icon } from '../../components/icons';
import { formatDate } from '../../lib/format';

interface HrDashboardData {
  totalEmployees: number;
  activeEmployees: number;
  inactiveEmployees: number;
  presentToday: number;
  absentToday: number;
  onLeaveToday: number;
  newJoiningsThisMonth: number;
  pendingHrTasks: number;
  pendingLeaveApprovals: number;
  pendingDocumentVerifications: number;
  departmentCounts: Array<{ id: number; name: string; count: number }>;
  locationCounts: Array<{ id: number; code: string; name: string; count: number }>;
  recentJoinings: Array<{
    id: number;
    employeeCode: string;
    fullName: string;
    departmentName: string | null;
    designationTitle: string | null;
    locationCode: string | null;
    joiningDate: string | null;
  }>;
  recentLeaves: Array<{
    id: number;
    employeeId: number;
    employeeCode: string;
    fullName: string;
    leaveType: string;
    startDate: string;
    endDate: string;
    days: number;
    status: string;
  }>;
}

export default function HrDashboard() {
  useDocumentTitle('HR Dashboard');
  const { user } = useAuth();
  const [data, setData] = useState<HrDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [locationId, setLocationId] = useState<string>('');
  const [locations, setLocations] = useState<Array<{ id: number; code: string; name: string }>>([]);

  const loadData = async (loc?: string) => {
    setLoading(true);
    setError('');
    try {
      const q = loc ? `?locationId=${loc}` : '';
      const res = await api.get<HrDashboardData>(`/hr/dashboard${q}`);
      setData(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Load allowed locations
    api.get<{ locations: Array<{ id: number; code: string; name: string }> }>('/employees/allowed-locations')
      .then((res) => {
        if (res?.locations) setLocations(res.locations);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadData(locationId);
  }, [locationId]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <PageHeader
            title="HR Operations & Employee Management"
            description="Live overview of workforce metrics, daily attendance, onboarding, pending leave requests, and store locations."
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-ink-700 whitespace-nowrap">Filter Location:</label>
          <select
            className="input max-w-xs"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">All BSC Textiles Stores</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.code} – {loc.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary flex items-center gap-1.5"
            onClick={() => void loadData(locationId)}
            title="Refresh statistics"
          >
            <Icon name="refresh" className="h-4 w-4" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="p-4">
                <Skeleton lines={2} />
              </Card>
            ))}
          </div>
          <Card className="p-6">
            <Skeleton lines={6} />
          </Card>
        </div>
      ) : data ? (
        <>
          {/* Quick Operations Strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Link
              to="/admin/employees"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-brand-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Icon name="users" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Directory</span>
            </Link>
            <Link
              to="/attendance"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-emerald-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <Icon name="clock" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Attendance</span>
            </Link>
            <Link
              to="/leave"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-amber-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                <Icon name="leave" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Leave Approvals</span>
            </Link>
            <Link
              to="/hr/payroll"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-blue-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <Icon name="wallet" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Payroll & Salary</span>
            </Link>
            <Link
              to="/hr/documents"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-purple-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
                <Icon name="file" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Documents</span>
            </Link>
            <Link
              to="/hr/announcements"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-rose-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
                <Icon name="bell" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Notices</span>
            </Link>
            <Link
              to="/kpi"
              className="card-pad flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-center transition hover:border-teal-500 hover:shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                <Icon name="kpi" className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold text-ink-900">Performance</span>
            </Link>
          </div>

          {/* Primary Live Metric Cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Card className="card-pad border-l-4 border-l-brand-600">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-500">Total Staff</span>
              <p className="mt-1 text-2xl font-bold text-ink-900">{data.totalEmployees}</p>
              <span className="text-xs text-ink-500">Across stores</span>
            </Card>

            <Card className="card-pad border-l-4 border-l-emerald-600">
              <span className="text-xs font-medium uppercase tracking-wider text-emerald-700">Active</span>
              <p className="mt-1 text-2xl font-bold text-emerald-700">{data.activeEmployees}</p>
              <span className="text-xs text-ink-500">On active roster</span>
            </Card>

            <Card className="card-pad border-l-4 border-l-teal-600">
              <span className="text-xs font-medium uppercase tracking-wider text-teal-700">Present Today</span>
              <p className="mt-1 text-2xl font-bold text-teal-700">{data.presentToday}</p>
              <span className="text-xs text-ink-500">Checked in</span>
            </Card>

            <Card className="card-pad border-l-4 border-l-rose-500">
              <span className="text-xs font-medium uppercase tracking-wider text-rose-700">Absent Today</span>
              <p className="mt-1 text-2xl font-bold text-rose-700">{data.absentToday}</p>
              <span className="text-xs text-ink-500">Not checked in</span>
            </Card>

            <Card className="card-pad border-l-4 border-l-amber-500">
              <span className="text-xs font-medium uppercase tracking-wider text-amber-700">On Leave Today</span>
              <p className="mt-1 text-2xl font-bold text-amber-700">{data.onLeaveToday}</p>
              <span className="text-xs text-ink-500">Approved leaves</span>
            </Card>

            <Card className="card-pad border-l-4 border-l-indigo-600">
              <span className="text-xs font-medium uppercase tracking-wider text-indigo-700">New Joinings</span>
              <p className="mt-1 text-2xl font-bold text-indigo-700">{data.newJoiningsThisMonth}</p>
              <span className="text-xs text-ink-500">This month</span>
            </Card>
          </div>

          {/* Actionable Pending Counts */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="card-pad flex items-center justify-between border-amber-200 bg-amber-50/60">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-amber-800">Pending Leave Approvals</span>
                <p className="text-2xl font-extrabold text-amber-900">{data.pendingLeaveApprovals}</p>
                <Link to="/leave" className="text-xs font-medium text-amber-800 underline hover:text-amber-950">
                  Review leave applications &rarr;
                </Link>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-200 text-amber-800">
                <Icon name="leave" className="h-6 w-6" />
              </div>
            </Card>

            <Card className="card-pad flex items-center justify-between border-blue-200 bg-blue-50/60">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-blue-800">Pending HR Tasks</span>
                <p className="text-2xl font-extrabold text-blue-900">{data.pendingHrTasks}</p>
                <Link to="/tasks" className="text-xs font-medium text-blue-800 underline hover:text-blue-950">
                  Manage open tasks &rarr;
                </Link>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-200 text-blue-800">
                <Icon name="tasks" className="h-6 w-6" />
              </div>
            </Card>

            <Card className="card-pad flex items-center justify-between border-purple-200 bg-purple-50/60">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-purple-800">Pending Document Verifications</span>
                <p className="text-2xl font-extrabold text-purple-900">{data.pendingDocumentVerifications}</p>
                <Link to="/hr/documents" className="text-xs font-medium text-purple-800 underline hover:text-purple-950">
                  Verify employee KYC docs &rarr;
                </Link>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-200 text-purple-800">
                <Icon name="file" className="h-6 w-6" />
              </div>
            </Card>
          </div>

          {/* Location & Department Breakdowns */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Store Location Breakdown */}
            <Card className="p-5">
              <h3 className="mb-4 text-base font-semibold text-ink-900">BSC Textiles Locations</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {data.locationCounts.map((loc) => (
                  <div
                    key={loc.id}
                    className="flex flex-col items-center rounded-xl border border-slate-200 bg-slate-50 p-4 text-center"
                  >
                    <Badge tone="info" className="mb-2 font-mono">
                      {loc.code}
                    </Badge>
                    <span className="text-sm font-semibold text-ink-900">{loc.name}</span>
                    <span className="mt-1 text-2xl font-bold text-brand-600">{loc.count}</span>
                    <span className="text-xs text-ink-500">active staff</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Department Breakdown */}
            <Card className="p-5">
              <h3 className="mb-4 text-base font-semibold text-ink-900">Department Workforce Distribution</h3>
              <div className="space-y-3">
                {data.departmentCounts.slice(0, 6).map((dept) => {
                  const maxCount = Math.max(...data.departmentCounts.map((d) => d.count), 1);
                  const pct = Math.round((dept.count / maxCount) * 100);
                  return (
                    <div key={dept.id} className="space-y-1">
                      <div className="flex justify-between text-xs font-medium text-ink-700">
                        <span>{dept.name}</span>
                        <span className="font-semibold text-ink-900">{dept.count} employees</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-brand-500 transition-all duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>

          {/* Recent Joinings & Pending Leaves Tables */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Recent Joinings */}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/75 p-4">
                <h3 className="text-sm font-semibold text-ink-900">Recent Joinings</h3>
                <Link to="/admin/employees" className="text-xs font-medium text-brand-600 hover:text-brand-800">
                  View all employees &rarr;
                </Link>
              </div>
              <div className="divide-y divide-slate-100">
                {data.recentJoinings.length === 0 ? (
                  <p className="p-4 text-sm text-ink-500">No new joinings recorded recently.</p>
                ) : (
                  data.recentJoinings.map((emp) => (
                    <div key={emp.id} className="flex items-center justify-between p-3.5 hover:bg-slate-50">
                      <div className="flex items-center gap-3">
                        <Avatar name={emp.fullName} size={30} />
                        <div>
                          <p className="text-sm font-medium text-ink-900">{emp.fullName}</p>
                          <p className="text-xs text-ink-500">
                            <span className="font-mono text-brand-700">{emp.employeeCode}</span> &bull; {emp.designationTitle || emp.departmentName || 'Staff'}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        {emp.locationCode && (
                          <Badge tone="info" className="font-mono">
                            {emp.locationCode}
                          </Badge>
                        )}
                        <p className="mt-0.5 text-xs text-ink-400">
                          {emp.joiningDate ? formatDate(emp.joiningDate) : '—'}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>

            {/* Pending Leave Requests */}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/75 p-4">
                <h3 className="text-sm font-semibold text-ink-900">Pending Leave Requests</h3>
                <Link to="/leave" className="text-xs font-medium text-brand-600 hover:text-brand-800">
                  Manage leaves &rarr;
                </Link>
              </div>
              <div className="divide-y divide-slate-100">
                {data.recentLeaves.length === 0 ? (
                  <p className="p-4 text-sm text-ink-500">No pending leave requests awaiting approval.</p>
                ) : (
                  data.recentLeaves.map((lr) => (
                    <div key={lr.id} className="flex items-center justify-between p-3.5 hover:bg-slate-50">
                      <div>
                        <p className="text-sm font-medium text-ink-900">{lr.fullName}</p>
                        <p className="text-xs text-ink-500">
                          {lr.leaveType} &bull; {formatDate(lr.startDate)} to {formatDate(lr.endDate)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone="warning">
                          {lr.days} {lr.days === 1 ? 'day' : 'days'}
                        </Badge>
                        <Badge tone="neutral">
                          {lr.status === 'pending_manager' ? 'Awaiting Manager' : 'Awaiting HR'}
                        </Badge>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
