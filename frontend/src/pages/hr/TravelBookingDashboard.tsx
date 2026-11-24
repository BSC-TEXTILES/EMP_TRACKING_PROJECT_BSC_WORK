import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { useToast } from '../../contexts/ToastContext';
import { api, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { Badge, Card, EmptyState, Modal, PageHeader, Skeleton } from '../../components/ui';
import { Icon } from '../../components/icons';

interface TravelSummary {
  today: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalEntries: number;
    pendingBookings: number;
    confirmedBookings: number;
    cancelledBookings: number;
  };
  thisWeek: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalEntries: number;
  };
  thisMonth: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalEntries: number;
    totalAmount: number;
  };
  overall: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalEntries: number;
  };
  byStore: Array<{
    locationId: number;
    code: string;
    name: string;
    todayTickets: number;
    todayBus: number;
    todayTrain: number;
    weekTickets: number;
    monthTickets: number;
    totalTickets: number;
    totalEntries: number;
    activeBookings: number;
  }>;
  serverToday: string;
  userStore: {
    id: number;
    code: string;
    name: string;
  } | null;
}

interface DailyHistoryItem {
  bookingDate: string;
  locationId: number;
  storeCode: string;
  storeName: string;
  busTickets: number;
  trainTickets: number;
  totalTickets: number;
  entryCount: number;
  latestUpdatedAt: string;
  updatedByEmployeeName: string;
  updatedByEmployeeCode: string;
}

interface DailyHistoryResponse {
  summary: {
    totalBus: number;
    totalTrain: number;
    grandTotal: number;
    totalEntries: number;
  };
  items: DailyHistoryItem[];
  totalRows: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface DailyTicketEntryItem {
  id: number;
  bookingDate: string;
  locationId: number;
  storeCode: string;
  storeName: string;
  ticketType: 'bus' | 'train';
  ticketCount: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  editHistory: Array<{
    id: number;
    editorName: string;
    editorCode: string;
    previousCount: number;
    newCount: number;
    reason: string | null;
    createdAt: string;
  }>;
}

export function TravelBookingDashboard() {
  useDocumentTitle('Travel & Ticket Booking');
  const { user, canAny } = useAuth();
  const { toast } = useToast();

  const isHrOrAdmin = useMemo(() => {
    if (!user) return false;
    return (
      user.roleSlug === 'admin' ||
      user.roleSlug === 'super_admin' ||
      user.roleSlug === 'hr_manager' ||
      user.roleSlug === 'location_hr' ||
      canAny('travel.manage', 'employees.manage')
    );
  }, [user, canAny]);

  // Dashboard Summary State
  const [summary, setSummary] = useState<TravelSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  // New Simple Booking Entry State
  const [entryType, setEntryType] = useState<'bus' | 'train'>('bus');
  const [entryCount, setEntryCount] = useState<string>('1');
  const [entryNotes, setEntryNotes] = useState<string>('');
  const [submittingEntry, setSubmittingEntry] = useState(false);

  // Daily History State & Filters
  const [datePreset, setDatePreset] = useState<'all' | 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom'>('this_month');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [filterType, setFilterType] = useState<'all' | 'bus' | 'train'>('all');
  const [filterLocationId, setFilterLocationId] = useState<string>('all');
  const [historyPage, setHistoryPage] = useState<number>(1);
  const [historyData, setHistoryData] = useState<DailyHistoryResponse | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Breakdown Modal for Date Entries
  const [selectedBreakdownDate, setSelectedBreakdownDate] = useState<string | null>(null);
  const [selectedBreakdownLocId, setSelectedBreakdownLocId] = useState<number | undefined>(undefined);
  const [selectedBreakdownStore, setSelectedBreakdownStore] = useState<string>('');
  const [breakdownEntries, setBreakdownEntries] = useState<DailyTicketEntryItem[]>([]);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);

  // Correction / Edit Modal
  const [editingEntry, setEditingEntry] = useState<DailyTicketEntryItem | null>(null);
  const [correctedCount, setCorrectedCount] = useState<string>('');
  const [correctionReason, setCorrectionReason] = useState<string>('');
  const [savingCorrection, setSavingCorrection] = useState(false);

  // Fetch Dashboard Summary
  const fetchSummary = async () => {
    try {
      const res = await api.get<TravelSummary>('/travel/dashboard');
      setSummary(res);
    } catch (err) {
      console.error('Failed to load travel summary:', err);
    } finally {
      setLoadingSummary(false);
    }
  };

  // Fetch Daily Ticket Booking History
  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams();
      if (datePreset !== 'all') params.append('datePreset', datePreset);
      if (datePreset === 'custom') {
        if (customStartDate) params.append('startDate', customStartDate);
        if (customEndDate) params.append('endDate', customEndDate);
      }
      if (filterType !== 'all') params.append('ticketType', filterType);
      if (filterLocationId !== 'all') params.append('locationId', filterLocationId);
      params.append('page', String(historyPage));
      params.append('limit', '15');

      const res = await api.get<DailyHistoryResponse>(`/travel/daily-history?${params.toString()}`);
      setHistoryData(res);
    } catch (err) {
      console.error('Failed to load ticket history:', err);
      toast('Failed to load ticket booking history', 'error');
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [datePreset, customStartDate, customEndDate, filterType, filterLocationId, historyPage]);

  // Real-time synchronization
  useSocketEvent('travel:updated', () => {
    fetchSummary();
    fetchHistory();
    if (selectedBreakdownDate) {
      openDayBreakdown(selectedBreakdownDate, selectedBreakdownLocId, selectedBreakdownStore);
    }
  });

  // Handle Simple Count Submission
  const handleSubmitCount = async (e: React.FormEvent) => {
    e.preventDefault();
    const count = parseInt(entryCount, 10);
    if (!Number.isFinite(count) || count < 1) {
      toast('Please enter a valid positive ticket count (minimum 1).', 'error');
      return;
    }

    setSubmittingEntry(true);
    try {
      const res = await api.post<{ success: boolean; message: string }>('/travel/counts', {
        ticketType: entryType,
        ticketCount: count,
        notes: entryNotes ? entryNotes.trim() : undefined,
      });

      toast(res.message || `Successfully recorded ${count} ${entryType} ticket(s).`, 'success');
      setEntryCount('1');
      setEntryNotes('');
      fetchSummary();
      fetchHistory();
    } catch (err) {
      toast(errorMessage(err) || 'Failed to record ticket count.', 'error');
    } finally {
      setSubmittingEntry(false);
    }
  };

  // Open Date Breakdown
  const openDayBreakdown = async (date: string, locationId?: number, storeName = '') => {
    setSelectedBreakdownDate(date);
    setSelectedBreakdownLocId(locationId);
    setSelectedBreakdownStore(storeName);
    setLoadingBreakdown(true);
    try {
      const url = locationId
        ? `/travel/daily-history/entries?date=${date}&locationId=${locationId}`
        : `/travel/daily-history/entries?date=${date}`;
      const entries = await api.get<DailyTicketEntryItem[]>(url);
      setBreakdownEntries(entries);
    } catch (err) {
      toast('Failed to load detailed entries for this date.', 'error');
    } finally {
      setLoadingBreakdown(false);
    }
  };

  // Open Edit Dialog
  const handleOpenEdit = (entry: DailyTicketEntryItem) => {
    setEditingEntry(entry);
    setCorrectedCount(String(entry.ticketCount));
    setCorrectionReason('');
  };

  // Submit Correction
  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEntry) return;

    const count = parseInt(correctedCount, 10);
    if (!Number.isFinite(count) || count < 1) {
      toast('Please enter a valid corrected ticket count (minimum 1).', 'error');
      return;
    }

    setSavingCorrection(true);
    try {
      const res = await api.patch<{ success: boolean; message: string }>(`/travel/counts/${editingEntry.id}`, {
        ticketCount: count,
        reason: correctionReason.trim() || undefined,
      });

      toast(res.message || 'Ticket count corrected successfully.', 'success');
      setEditingEntry(null);
      fetchSummary();
      fetchHistory();
      if (selectedBreakdownDate) {
        openDayBreakdown(selectedBreakdownDate, selectedBreakdownLocId, selectedBreakdownStore);
      }
    } catch (err) {
      toast(errorMessage(err) || 'Failed to correct ticket count.', 'error');
    } finally {
      setSavingCorrection(false);
    }
  };

  // 1-Click Excel CSV Export
  const handleExportExcel = () => {
    const params = new URLSearchParams();
    if (datePreset !== 'all') params.append('datePreset', datePreset);
    if (datePreset === 'custom') {
      if (customStartDate) params.append('startDate', customStartDate);
      if (customEndDate) params.append('endDate', customEndDate);
    }
    if (filterType !== 'all') params.append('ticketType', filterType);
    if (filterLocationId !== 'all') params.append('locationId', filterLocationId);

    window.open(`/api/travel/daily-history/export?${params.toString()}`, '_blank');
  };

  // 1-Click PDF Report (Formatted Print View)
  const handleDownloadPdf = () => {
    window.print();
  };

  const detectedStoreLabel = summary?.userStore
    ? `${summary.userStore.name} (${summary.userStore.code})`
    : 'All Stores / Central HQ';

  const serverDateLabel = summary?.serverToday
    ? formatDate(summary.serverToday)
    : 'Today';

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <PageHeader
        title="Travel & Ticket Booking"
        description="Daily bus and train ticket counting, store-wise automatic tracking, and verified reports."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <button
              onClick={handleDownloadPdf}
              className="btn-secondary text-xs flex items-center gap-1.5 px-3 py-2 shadow-xs"
              title="Download or print professional PDF report"
            >
              <Icon name="printer" className="h-4 w-4 text-ink-600" />
              <span>Download PDF</span>
            </button>
            <button
              onClick={handleExportExcel}
              className="btn-secondary text-xs flex items-center gap-1.5 px-3 py-2 shadow-xs"
              title="Export date-wise records to Excel format"
            >
              <Icon name="download" className="h-4 w-4 text-emerald-600" />
              <span>Download Excel</span>
            </button>
          </div>
        }
      />

      {/* Screen & Print Header Banner */}
      <div className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50/70 via-sky-50/50 to-white p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
              <Icon name="ticket" className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink-900">BSC Textiles Travel System</h2>
              <div className="flex flex-wrap items-center gap-2 mt-0.5 text-xs text-ink-600">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Live Tracking Active</span>
                </span>
                <span>&bull;</span>
                <span>Timezone: <strong>Asia/Kolkata (+05:30)</strong></span>
                <span>&bull;</span>
                <span>Store: <strong className="text-brand-700">{detectedStoreLabel}</strong></span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="brand" className="px-3 py-1 text-xs font-semibold">
              <Icon name="calendar" className="mr-1 h-3.5 w-3.5" />
              Date: {serverDateLabel}
            </Badge>
          </div>
        </div>
      </div>

      {/* Live Dashboard Metric Cards */}
      {loadingSummary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Card className="card-pad border-l-4 border-l-brand-600 bg-white">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Today Total</span>
            <p className="mt-1 text-2xl font-black text-brand-700">{summary.today.totalTickets}</p>
            <span className="text-xs text-ink-500">tickets booked today</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-blue-600 bg-white">
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">Today Bus</span>
            <p className="mt-1 text-2xl font-black text-blue-800">{summary.today.busTickets}</p>
            <span className="text-xs text-ink-500">bus tickets</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-emerald-600 bg-white">
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Today Train</span>
            <p className="mt-1 text-2xl font-black text-emerald-800">{summary.today.trainTickets}</p>
            <span className="text-xs text-ink-500">train tickets</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-indigo-600 bg-white">
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-700">This Week</span>
            <p className="mt-1 text-2xl font-black text-indigo-800">{summary.thisWeek.totalTickets}</p>
            <span className="text-xs text-ink-500">
              Bus: {summary.thisWeek.busTickets} | Train: {summary.thisWeek.trainTickets}
            </span>
          </Card>

          <Card className="card-pad border-l-4 border-l-purple-600 bg-white">
            <span className="text-[11px] font-bold uppercase tracking-wider text-purple-700">This Month</span>
            <p className="mt-1 text-2xl font-black text-purple-800">{summary.thisMonth.totalTickets}</p>
            <span className="text-xs text-ink-500">
              Bus: {summary.thisMonth.busTickets} | Train: {summary.thisMonth.trainTickets}
            </span>
          </Card>

          <Card className="card-pad border-l-4 border-l-amber-600 bg-white">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Overall Total</span>
            <p className="mt-1 text-2xl font-black text-amber-800">{summary.overall.totalTickets}</p>
            <span className="text-xs text-ink-500">all-time records</span>
          </Card>
        </div>
      ) : null}

      {/* Main Operational Section: Form + Store Comparison Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Simple Ticket Count Entry Form */}
        <Card className="lg:col-span-1 border border-slate-200 bg-white p-5 shadow-xs">
          <div className="border-b border-slate-100 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Icon name="plus" className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-ink-900">Record Daily Ticket Count</h3>
                <p className="text-[11px] text-ink-500">Quick entry for today's ticket count</p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmitCount} className="space-y-4">
            {/* A. Ticket Type Selection */}
            <div>
              <label className="block text-xs font-bold text-ink-700 mb-1.5">
                Ticket Type <span className="text-rose-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setEntryType('bus')}
                  className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-xs font-bold transition ${
                    entryType === 'bus'
                      ? 'border-blue-600 bg-blue-50/80 text-blue-900 ring-2 ring-blue-500/20 shadow-xs'
                      : 'border-slate-200 bg-white text-ink-600 hover:bg-slate-50'
                  }`}
                >
                  <Icon name="bus" className={`h-4 w-4 ${entryType === 'bus' ? 'text-blue-600' : 'text-ink-400'}`} />
                  <span>Bus Ticket</span>
                </button>

                <button
                  type="button"
                  onClick={() => setEntryType('train')}
                  className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-xs font-bold transition ${
                    entryType === 'train'
                      ? 'border-emerald-600 bg-emerald-50/80 text-emerald-900 ring-2 ring-emerald-500/20 shadow-xs'
                      : 'border-slate-200 bg-white text-ink-600 hover:bg-slate-50'
                  }`}
                >
                  <Icon name="train" className={`h-4 w-4 ${entryType === 'train' ? 'text-emerald-600' : 'text-ink-400'}`} />
                  <span>Train Ticket</span>
                </button>
              </div>
            </div>

            {/* B. Total Number of Tickets Booked */}
            <div>
              <label htmlFor="ticket-count-input" className="block text-xs font-bold text-ink-700 mb-1.5">
                Total Number of Tickets Booked <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="ticket-count-input"
                  type="number"
                  min="1"
                  step="1"
                  value={entryCount}
                  onChange={(e) => setEntryCount(e.target.value)}
                  placeholder="e.g. 10"
                  required
                  className="input text-base font-extrabold text-ink-900 py-2.5 px-3 w-full"
                />
                <span className="absolute right-3 top-2.5 text-xs font-semibold text-ink-400">
                  ticket(s)
                </span>
              </div>
              <p className="mt-1 text-[11px] text-ink-500">
                Positive whole numbers only (min: 1). Multiple entries automatically add to today's total.
              </p>
            </div>

            {/* C. Booking Date Display */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between text-ink-600">
                <span className="font-medium">Booking Date:</span>
                <span className="font-bold text-ink-900">{serverDateLabel}</span>
              </div>
              <p className="text-[10px] text-ink-500">
                Automatically logged from server in Indian Standard Time (Asia/Kolkata).
              </p>
            </div>

            {/* D. Store Identification */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between text-ink-600">
                <span className="font-medium">Store Location:</span>
                <span className="font-bold text-brand-700">{detectedStoreLabel}</span>
              </div>
              <p className="text-[10px] text-ink-500">
                Automatically identified from your active employee assignment.
              </p>
            </div>

            {/* Optional Notes */}
            <div>
              <label htmlFor="entry-notes" className="block text-xs font-medium text-ink-600 mb-1">
                Remarks / Purpose (Optional)
              </label>
              <input
                id="entry-notes"
                type="text"
                value={entryNotes}
                onChange={(e) => setEntryNotes(e.target.value)}
                placeholder="e.g. Fabric sourcing team, Store staff travel"
                className="input text-xs py-2 px-3 w-full"
              />
            </div>

            {/* E. Submit Button */}
            <button
              type="submit"
              disabled={submittingEntry}
              className="btn-primary w-full py-2.5 text-xs font-bold flex items-center justify-center gap-2 shadow-xs"
            >
              {submittingEntry ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Saving Ticket Count...</span>
                </>
              ) : (
                <>
                  <Icon name="check" className="h-4 w-4" />
                  <span>Submit Ticket Count</span>
                </>
              )}
            </button>
          </form>
        </Card>

        {/* Store Comparison Breakdown Table */}
        <Card className="lg:col-span-2 border border-slate-200 bg-white p-5 shadow-xs">
          <div className="border-b border-slate-100 pb-3 mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-ink-900">Store-Wise Ticket Allocation</h3>
              <p className="text-[11px] text-ink-500">Live comparison across BEL, DAV, SHI and Central HQ</p>
            </div>
            <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
              Isolated Store Data
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-ink-700">
                <tr>
                  <th className="py-2.5 px-3">Store Location</th>
                  <th className="py-2.5 px-3 text-right">Today Bus</th>
                  <th className="py-2.5 px-3 text-right">Today Train</th>
                  <th className="py-2.5 px-3 text-right">Today Total</th>
                  <th className="py-2.5 px-3 text-right">This Week</th>
                  <th className="py-2.5 px-3 text-right">This Month</th>
                  <th className="py-2.5 px-3 text-right">All-Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-ink-800">
                {summary?.byStore && summary.byStore.length > 0 ? (
                  summary.byStore.map((store) => (
                    <tr key={store.locationId} className="hover:bg-slate-50/60 transition">
                      <td className="py-2.5 px-3 font-semibold text-ink-900">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[11px] text-brand-600 bg-brand-50 border border-brand-200 px-1.5 py-0.5 rounded">
                            {store.code}
                          </span>
                          <span>{store.name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium text-blue-700">{store.todayBus}</td>
                      <td className="py-2.5 px-3 text-right font-medium text-emerald-700">{store.todayTrain}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-brand-700 bg-brand-50/40">
                        {store.todayTickets}
                      </td>
                      <td className="py-2.5 px-3 text-right font-semibold text-indigo-700">{store.weekTickets}</td>
                      <td className="py-2.5 px-3 text-right font-semibold text-purple-700">{store.monthTickets}</td>
                      <td className="py-2.5 px-3 text-right font-black text-ink-900">{store.totalTickets}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-ink-500">
                      No store allocations recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Date-Wise Daily Ticket Booking History Section */}
      <Card className="border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-4 mb-4">
          <div>
            <h3 className="text-base font-bold text-ink-900">Daily Ticket Booking History</h3>
            <p className="text-xs text-ink-500">
              Date-wise consolidated bus and train totals dynamically calculated from database records.
            </p>
          </div>

          {/* Quick Summary Pill for Filtered Selection */}
          {historyData && (
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="rounded-lg bg-blue-50 border border-blue-200 px-2.5 py-1 text-blue-800">
                Bus: {historyData.summary.totalBus}
              </span>
              <span className="rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-emerald-800">
                Train: {historyData.summary.totalTrain}
              </span>
              <span className="rounded-lg bg-indigo-50 border border-indigo-200 px-2.5 py-1 text-indigo-800 font-bold">
                Grand Total: {historyData.summary.grandTotal}
              </span>
            </div>
          )}
        </div>

        {/* Filter Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50/70 p-3 rounded-xl border border-slate-200 mb-4 print:hidden">
          {/* Preset Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'all', label: 'All Dates' },
              { id: 'today', label: 'Today' },
              { id: 'yesterday', label: 'Yesterday' },
              { id: 'this_week', label: 'This Week' },
              { id: 'this_month', label: 'This Month' },
              { id: 'custom', label: 'Custom' },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setDatePreset(p.id as any);
                  setHistoryPage(1);
                }}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  datePreset === p.id
                    ? 'bg-brand-600 text-white shadow-xs'
                    : 'bg-white border border-slate-200 text-ink-700 hover:bg-slate-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom Date Inputs if 'custom' is active */}
          {datePreset === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => {
                  setCustomStartDate(e.target.value);
                  setHistoryPage(1);
                }}
                className="input py-1 px-2 text-xs"
              />
              <span className="text-xs text-ink-500">to</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => {
                  setCustomEndDate(e.target.value);
                  setHistoryPage(1);
                }}
                className="input py-1 px-2 text-xs"
              />
            </div>
          )}

          {/* Type & Store Dropdowns */}
          <div className="flex items-center gap-2">
            <select
              value={filterType}
              onChange={(e) => {
                setFilterType(e.target.value as any);
                setHistoryPage(1);
              }}
              className="input py-1 px-2.5 text-xs font-medium"
            >
              <option value="all">All Modes (Bus & Train)</option>
              <option value="bus">Bus Only</option>
              <option value="train">Train Only</option>
            </select>

            {isHrOrAdmin && (
              <select
                value={filterLocationId}
                onChange={(e) => {
                  setFilterLocationId(e.target.value);
                  setHistoryPage(1);
                }}
                className="input py-1 px-2.5 text-xs font-medium"
              >
                <option value="all">All Stores</option>
                <option value="1">BEL - Belagavi</option>
                <option value="2">DAV - Davanagere</option>
                <option value="3">SHI - Shivamogga</option>
              </select>
            )}
          </div>
        </div>

        {/* Date-Wise History Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-100/70 font-semibold text-ink-700">
              <tr>
                <th className="py-2.5 px-4">Booking Date</th>
                <th className="py-2.5 px-4">Store</th>
                <th className="py-2.5 px-4 text-right">Bus Tickets</th>
                <th className="py-2.5 px-4 text-right">Train Tickets</th>
                <th className="py-2.5 px-4 text-right">Total Tickets</th>
                <th className="py-2.5 px-4">Updated By</th>
                <th className="py-2.5 px-4 text-right print:hidden">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-ink-800">
              {loadingHistory ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="py-3 px-4">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : historyData && historyData.items.length > 0 ? (
                historyData.items.map((row, idx) => (
                  <tr
                    key={`${row.bookingDate}-${row.locationId}-${idx}`}
                    className="hover:bg-slate-50/70 transition cursor-pointer"
                    onClick={() => openDayBreakdown(row.bookingDate, row.locationId, `${row.storeCode} - ${row.storeName}`)}
                  >
                    <td className="py-3 px-4 font-bold text-ink-900 flex items-center gap-2">
                      <Icon name="calendar" className="h-4 w-4 text-ink-400" />
                      <span>{formatDate(row.bookingDate)}</span>
                    </td>
                    <td className="py-3 px-4 font-medium text-ink-700">
                      <span className="font-mono text-[11px] bg-slate-100 text-ink-800 border border-slate-200 px-1.5 py-0.5 rounded mr-1.5">
                        {row.storeCode}
                      </span>
                      <span>{row.storeName}</span>
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-blue-700">{row.busTickets}</td>
                    <td className="py-3 px-4 text-right font-bold text-emerald-700">{row.trainTickets}</td>
                    <td className="py-3 px-4 text-right font-black text-brand-700 bg-brand-50/30 text-sm">
                      {row.totalTickets}
                    </td>
                    <td className="py-3 px-4 text-ink-600">
                      <div>
                        <span className="font-medium text-ink-900">{row.updatedByEmployeeName}</span>
                        {row.updatedByEmployeeCode && (
                          <span className="text-[11px] text-ink-400 ml-1">({row.updatedByEmployeeCode})</span>
                        )}
                      </div>
                      <span className="text-[10px] text-ink-400">Entries: {row.entryCount}</span>
                    </td>
                    <td className="py-3 px-4 text-right print:hidden" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => openDayBreakdown(row.bookingDate, row.locationId, `${row.storeCode} - ${row.storeName}`)}
                        className="btn-secondary text-[11px] font-semibold py-1 px-2.5"
                      >
                        <span>View Details</span>
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="py-12">
                    <EmptyState
                      title="No Ticket Bookings Recorded"
                      description="No bus or train tickets found for the selected date range and store filters."
                    />
                  </td>
                </tr>
              )}
            </tbody>
            {/* Grand Totals Footer */}
            {historyData && historyData.items.length > 0 && (
              <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold text-ink-900">
                <tr>
                  <td colSpan={2} className="py-3 px-4 uppercase tracking-wider text-xs">
                    Total for Filtered Selection
                  </td>
                  <td className="py-3 px-4 text-right text-blue-800 text-sm">{historyData.summary.totalBus}</td>
                  <td className="py-3 px-4 text-right text-emerald-800 text-sm">{historyData.summary.totalTrain}</td>
                  <td className="py-3 px-4 text-right text-brand-700 text-base font-black bg-brand-50">
                    {historyData.summary.grandTotal}
                  </td>
                  <td colSpan={2} className="py-3 px-4 text-ink-500 text-[11px]">
                    Total Submissions: {historyData.summary.totalEntries}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Pagination Bar */}
        {historyData && historyData.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-ink-600 print:hidden">
            <span>
              Showing page <strong>{historyData.page}</strong> of <strong>{historyData.totalPages}</strong> ({historyData.totalRows} date records)
            </span>
            <div className="flex items-center gap-1.5">
              <button
                disabled={historyPage <= 1}
                onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                className="btn-secondary py-1 px-2.5 text-xs disabled:opacity-40"
              >
                Previous
              </button>
              <button
                disabled={historyPage >= historyData.totalPages}
                onClick={() => setHistoryPage((p) => p + 1)}
                className="btn-secondary py-1 px-2.5 text-xs disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Date Breakdown Modal */}
      <Modal
        open={Boolean(selectedBreakdownDate)}
        onClose={() => setSelectedBreakdownDate(null)}
        title={`Booking Entries: ${selectedBreakdownDate ? formatDate(selectedBreakdownDate) : ''} (${selectedBreakdownStore || 'Store'})`}
        size="lg"
      >
        <div className="space-y-4">
          <p className="text-xs text-ink-500">
            Individual booking count submissions for this date. Authorized HR users can correct counts if entered erroneously.
          </p>

          {loadingBreakdown ? (
            <div className="space-y-2 py-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : breakdownEntries.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-ink-700">
                  <tr>
                    <th className="py-2.5 px-3">Entry ID</th>
                    <th className="py-2.5 px-3">Time</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3 text-right">Count</th>
                    <th className="py-2.5 px-3">Entered By</th>
                    <th className="py-2.5 px-3">Remarks</th>
                    {isHrOrAdmin && <th className="py-2.5 px-3 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-ink-800">
                  {breakdownEntries.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50/60">
                      <td className="py-2.5 px-3 font-mono text-[11px] text-ink-500">#{item.id}</td>
                      <td className="py-2.5 px-3 text-ink-600">{item.createdAt.split(' ')[1] || item.createdAt}</td>
                      <td className="py-2.5 px-3">
                        <Badge
                          tone={item.ticketType === 'bus' ? 'info' : 'success'}
                          className="text-[10px] uppercase font-bold px-2 py-0.5"
                        >
                          {item.ticketType}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3 text-right font-black text-ink-900 text-sm">
                        {item.ticketCount}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="font-semibold text-ink-900">{item.employeeName}</span>
                        <span className="text-[11px] text-ink-400 ml-1">({item.employeeCode})</span>
                      </td>
                      <td className="py-2.5 px-3 text-ink-600">
                        {item.notes || <span className="text-ink-400 italic">None</span>}
                        {item.editHistory.length > 0 && (
                          <div className="mt-1 text-[10px] text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 border border-amber-200 inline-block">
                            Corrected from {item.editHistory[item.editHistory.length - 1].previousCount} by {item.editHistory[item.editHistory.length - 1].editorName}
                          </div>
                        )}
                      </td>
                      {isHrOrAdmin && (
                        <td className="py-2.5 px-3 text-right">
                          <button
                            onClick={() => handleOpenEdit(item)}
                            className="btn-secondary text-[11px] font-semibold py-1 px-2 text-brand-600"
                            title="Correct this ticket count"
                          >
                            <Icon name="edit" className="h-3 w-3 mr-1 inline" />
                            <span>Correct</span>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-center py-6 text-xs text-ink-500">No individual entries found.</p>
          )}

          <div className="flex justify-end pt-2">
            <button
              onClick={() => setSelectedBreakdownDate(null)}
              className="btn-secondary text-xs px-4 py-2"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      {/* Editing / Correction Modal */}
      <Modal
        open={Boolean(editingEntry)}
        onClose={() => setEditingEntry(null)}
        title="Correct Ticket Count"
        size="md"
      >
        {editingEntry && (
          <form onSubmit={handleSaveCorrection} className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 space-y-1">
              <span className="font-bold">Correction Audit Notice:</span>
              <p>
                Modifications to previously recorded ticket counts are permanently logged with your employee name,
                previous count, updated count, and timestamp.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
                <span className="text-ink-500 font-medium">Ticket Type</span>
                <p className="font-bold text-ink-900 uppercase mt-0.5">{editingEntry.ticketType}</p>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
                <span className="text-ink-500 font-medium">Current Count</span>
                <p className="font-bold text-ink-900 mt-0.5">{editingEntry.ticketCount} tickets</p>
              </div>
            </div>

            <div>
              <label htmlFor="corrected-count" className="block text-xs font-bold text-ink-700 mb-1">
                New / Corrected Ticket Count <span className="text-rose-500">*</span>
              </label>
              <input
                id="corrected-count"
                type="number"
                min="1"
                step="1"
                value={correctedCount}
                onChange={(e) => setCorrectedCount(e.target.value)}
                required
                className="input py-2 px-3 text-base font-bold w-full"
              />
            </div>

            <div>
              <label htmlFor="correction-reason" className="block text-xs font-bold text-ink-700 mb-1">
                Reason for Correction <span className="text-rose-500">*</span>
              </label>
              <textarea
                id="correction-reason"
                rows={2}
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                required
                placeholder="e.g. Typographical error during evening punch, duplicate slip adjustment"
                className="input py-2 px-3 text-xs w-full"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setEditingEntry(null)}
                className="btn-secondary text-xs px-3 py-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingCorrection}
                className="btn-primary text-xs px-4 py-2 font-bold"
              >
                {savingCorrection ? 'Saving...' : 'Save Correction'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
export default TravelBookingDashboard;
