import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocketEvent } from '../../contexts/RealtimeContext';
import { useToast } from '../../contexts/ToastContext';
import { api, errorMessage } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { Avatar, Badge, Card, EmptyState, Modal, PageHeader, Skeleton, Tabs } from '../../components/ui';
import { Icon } from '../../components/icons';

function formatCurrency(amount?: number | null): string {
  if (amount === undefined || amount === null) return '₹0';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

interface PassengerItem {
  id?: number;
  passengerName: string;
  age?: number | null;
  gender?: 'male' | 'female' | 'other' | null;
  seatBerth?: string | null;
  ticketNumber?: string | null;
  status?: 'confirmed' | 'cancelled' | 'waitlisted' | 'rac';
}

interface BookingAuditLog {
  id: number;
  actorId: number;
  actorName: string;
  actorCode: string;
  action: string;
  previousStatus: string | null;
  newStatus: string | null;
  remarks: string | null;
  createdAt: string;
}

interface TravelBooking {
  id: number;
  bookingReference: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  locationId: number;
  locationCode: string;
  locationName: string;
  transportType: 'bus' | 'train';
  status: 'requested' | 'pending' | 'confirmed' | 'cancelled' | 'rejected' | 'completed';
  bookingDate: string;
  bookedAt: string;
  journeyDate: string;
  journeyTime: string | null;
  returnDate: string | null;
  sourceLocation: string;
  destinationLocation: string;
  boardingPoint: string | null;
  droppingPoint: string | null;
  operatorOrTrainName: string | null;
  trainNumber: string | null;
  pnrOrTicketNumber: string | null;
  seatClass: string | null;
  seatNumbers: string | null;
  passengerCount: number;
  totalAmount: number;
  purpose: string | null;
  bookedById: number;
  bookedByName: string;
  notes: string | null;
  attachmentUrl: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  passengers: PassengerItem[];
  logs?: BookingAuditLog[];
}

interface TravelSummary {
  today: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    pendingBookings: number;
    confirmedBookings: number;
    cancelledBookings: number;
  };
  thisWeek: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
  };
  thisMonth: {
    totalTickets: number;
    busTickets: number;
    trainTickets: number;
    totalBookings: number;
    totalAmount: number;
  };
  byStatus: {
    requested: number;
    pending: number;
    confirmed: number;
    cancelled: number;
    rejected: number;
    completed: number;
  };
  byStore: Array<{
    locationId: number;
    code: string;
    name: string;
    todayTickets: number;
    todayBus: number;
    todayTrain: number;
    monthTickets: number;
    activeBookings: number;
  }>;
}

interface ChartPoint {
  date: string;
  bus: number;
  train: number;
  total: number;
}

interface ActiveEmployee {
  id: number;
  employeeCode: string;
  fullName: string;
  locationId: number;
  locationCode: string;
}

const STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  requested: 'info',
  pending: 'warning',
  confirmed: 'success',
  completed: 'success',
  cancelled: 'danger',
  rejected: 'danger',
};

export default function TravelBookingDashboard() {
  useDocumentTitle('Travel & Ticket Booking');
  const { user } = useAuth();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<'overview' | 'bus' | 'train' | 'reports'>('overview');
  const [summary, setSummary] = useState<TravelSummary | null>(null);
  const [bookings, setBookings] = useState<TravelBooking[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [locations, setLocations] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [employees, setEmployees] = useState<ActiveEmployee[]>([]);

  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [locationId, setLocationId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [datePreset, setDatePreset] = useState<'all' | 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom'>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<TravelBooking | null>(null);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [statusActionOpen, setStatusActionOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState<string>('confirmed');
  const [cancelReason, setCancelReason] = useState('');
  const [actionRemarks, setActionRemarks] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  // New Booking Form State
  const [newForm, setNewForm] = useState({
    employeeId: '',
    locationId: '',
    transportType: 'bus' as 'bus' | 'train',
    status: 'confirmed' as 'confirmed' | 'pending' | 'requested',
    bookingDate: new Date().toISOString().split('T')[0],
    journeyDate: '',
    journeyTime: '',
    returnDate: '',
    sourceLocation: '',
    destinationLocation: '',
    boardingPoint: '',
    droppingPoint: '',
    operatorOrTrainName: '',
    trainNumber: '',
    pnrOrTicketNumber: '',
    seatClass: '',
    seatNumbers: '',
    totalAmount: '',
    purpose: '',
    notes: '',
    attachmentUrl: '',
    passengers: [
      { passengerName: '', age: '', gender: 'male', seatBerth: '', ticketNumber: '', status: 'confirmed' },
    ],
  });
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Load allowed locations and employees on mount
  useEffect(() => {
    api.get<{ locations: Array<{ id: number; code: string; name: string }> }>('/employees/allowed-locations')
      .then((res) => {
        if (res?.locations) setLocations(res.locations);
      })
      .catch(() => undefined);

    api.get<{ employees: ActiveEmployee[] }>('/employees?limit=200&status=active')
      .then((res) => {
        if (Array.isArray(res?.employees)) {
          setEmployees(
            res.employees.map((e: any) => ({
              id: Number(e.id),
              employeeCode: e.employeeCode || e.employee_code,
              fullName: e.fullName || e.full_name,
              locationId: Number(e.locationId || e.location_id),
              locationCode: e.locationCode || e.location_code || '',
            })),
          );
        }
      })
      .catch(() => undefined);
  }, []);

  // Load summary stats
  const loadSummary = async (loc?: string) => {
    try {
      const q = loc ? `?locationId=${loc}` : '';
      const data = await api.get<TravelSummary>(`/travel/dashboard${q}`);
      setSummary(data);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // Load bookings list
  const loadBookings = async () => {
    setListLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationId) params.set('locationId', locationId);
      if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);

      // Determine transportType based on active tab
      if (activeTab === 'bus') params.set('transportType', 'bus');
      else if (activeTab === 'train') params.set('transportType', 'train');

      if (datePreset && datePreset !== 'all') params.set('datePreset', datePreset);
      if (datePreset === 'custom') {
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
      }
      if (search.trim()) params.set('search', search.trim());
      params.set('page', String(page));
      params.set('limit', '20');

      const res = await api.get<{ items: TravelBooking[]; total: number }>(`/travel/bookings?${params.toString()}`);
      setBookings(res.items || []);
      setTotalCount(res.total || 0);
    } catch (err) {
      toast.error(errorMessage(err), 'Failed to load bookings');
    } finally {
      setListLoading(false);
    }
  };

  // Load chart trend data
  const loadChart = async () => {
    try {
      const params = new URLSearchParams();
      if (locationId) params.set('locationId', locationId);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      const data = await api.get<ChartPoint[]>(`/travel/reports/chart?${params.toString()}`);
      setChartData(data || []);
    } catch {
      // Optional chart load
    }
  };

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([loadSummary(locationId), loadBookings(), loadChart()]).finally(() => setLoading(false));
  }, [locationId]);

  // Tab or filter changes
  useEffect(() => {
    setPage(1);
    void loadBookings();
    if (activeTab === 'reports') void loadChart();
  }, [activeTab, statusFilter, datePreset, startDate, endDate]);

  // Realtime updates
  useSocketEvent('travel:updated', () => {
    void loadSummary(locationId);
    void loadBookings();
    if (activeTab === 'reports') void loadChart();
  });

  // Handle employee change in new booking form to autofill store and passenger
  const handleFormEmployeeChange = (empId: string) => {
    const selected = employees.find((e) => String(e.id) === empId);
    setNewForm((prev) => {
      const updatedPassengers = [...prev.passengers];
      if (selected && (!updatedPassengers[0]?.passengerName || updatedPassengers[0]?.passengerName === '')) {
        updatedPassengers[0] = {
          ...updatedPassengers[0],
          passengerName: selected.fullName,
        };
      }
      return {
        ...prev,
        employeeId: empId,
        locationId: selected ? String(selected.locationId) : prev.locationId,
        passengers: updatedPassengers,
      };
    });
  };

  const addPassengerRow = () => {
    setNewForm((prev) => ({
      ...prev,
      passengers: [
        ...prev.passengers,
        { passengerName: '', age: '', gender: 'male', seatBerth: '', ticketNumber: '', status: 'confirmed' },
      ],
    }));
  };

  const removePassengerRow = (index: number) => {
    if (newForm.passengers.length <= 1) return;
    setNewForm((prev) => ({
      ...prev,
      passengers: prev.passengers.filter((_, i) => i !== index),
    }));
  };

  const updatePassengerField = (index: number, field: string, value: any) => {
    setNewForm((prev) => {
      const next = [...prev.passengers];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, passengers: next };
    });
  };

  // Submit New Booking
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newForm.employeeId) {
      toast.error('Please select an employee.');
      return;
    }
    if (!newForm.journeyDate) {
      toast.error('Please enter the journey date.');
      return;
    }
    if (!newForm.sourceLocation.trim() || !newForm.destinationLocation.trim()) {
      toast.error('Please specify source and destination locations.');
      return;
    }
    const validPassengers = newForm.passengers.filter((p) => p.passengerName.trim().length > 0);
    if (validPassengers.length === 0) {
      toast.error('Please enter at least one passenger name.');
      return;
    }

    setFormSubmitting(true);
    try {
      await api.post('/travel/bookings', {
        employeeId: Number(newForm.employeeId),
        locationId: newForm.locationId ? Number(newForm.locationId) : undefined,
        transportType: newForm.transportType,
        status: newForm.status,
        bookingDate: newForm.bookingDate || undefined,
        journeyDate: newForm.journeyDate,
        journeyTime: newForm.journeyTime || undefined,
        returnDate: newForm.returnDate || undefined,
        sourceLocation: newForm.sourceLocation.trim(),
        destinationLocation: newForm.destinationLocation.trim(),
        boardingPoint: newForm.boardingPoint.trim() || undefined,
        droppingPoint: newForm.droppingPoint.trim() || undefined,
        operatorOrTrainName: newForm.operatorOrTrainName.trim() || undefined,
        trainNumber: newForm.trainNumber.trim() || undefined,
        pnrOrTicketNumber: newForm.pnrOrTicketNumber.trim() || undefined,
        seatClass: newForm.seatClass.trim() || undefined,
        seatNumbers: newForm.seatNumbers.trim() || undefined,
        totalAmount: newForm.totalAmount ? parseFloat(newForm.totalAmount) : 0,
        purpose: newForm.purpose.trim() || undefined,
        notes: newForm.notes.trim() || undefined,
        attachmentUrl: newForm.attachmentUrl.trim() || undefined,
        passengers: validPassengers.map((p) => ({
          passengerName: p.passengerName.trim(),
          age: p.age ? Number(p.age) : undefined,
          gender: p.gender || undefined,
          seatBerth: p.seatBerth?.trim() || undefined,
          ticketNumber: p.ticketNumber?.trim() || undefined,
          status: p.status || 'confirmed',
        })),
      });

      toast.success('Travel ticket booking created successfully!');
      setCreateModalOpen(false);
      // Reset form
      setNewForm({
        employeeId: '',
        locationId: '',
        transportType: 'bus',
        status: 'confirmed',
        bookingDate: new Date().toISOString().split('T')[0],
        journeyDate: '',
        journeyTime: '',
        returnDate: '',
        sourceLocation: '',
        destinationLocation: '',
        boardingPoint: '',
        droppingPoint: '',
        operatorOrTrainName: '',
        trainNumber: '',
        pnrOrTicketNumber: '',
        seatClass: '',
        seatNumbers: '',
        totalAmount: '',
        purpose: '',
        notes: '',
        attachmentUrl: '',
        passengers: [
          { passengerName: '', age: '', gender: 'male', seatBerth: '', ticketNumber: '', status: 'confirmed' },
        ],
      });
      void loadSummary(locationId);
      void loadBookings();
    } catch (err) {
      toast.error(errorMessage(err), 'Failed to create booking');
    } finally {
      setFormSubmitting(false);
    }
  };

  // Open single booking details modal
  const openBookingDetails = async (id: number) => {
    try {
      const data = await api.get<TravelBooking>(`/travel/bookings/${id}`);
      setSelectedBooking(data);
      setDetailsModalOpen(true);
    } catch (err) {
      toast.error(errorMessage(err), 'Could not load booking details');
    }
  };

  // Handle Status Update / Cancellation
  const handleStatusSubmit = async () => {
    if (!selectedBooking) return;
    if (actionStatus === 'cancelled' && !cancelReason.trim()) {
      toast.error('Please enter a cancellation reason.');
      return;
    }

    setActionBusy(true);
    try {
      await api.patch(`/travel/bookings/${selectedBooking.id}/status`, {
        status: actionStatus,
        cancellationReason: actionStatus === 'cancelled' ? cancelReason.trim() : undefined,
        remarks: actionRemarks.trim() || undefined,
      });

      toast.success(`Booking status successfully updated to ${actionStatus}!`);
      setStatusActionOpen(false);
      setCancelReason('');
      setActionRemarks('');
      // Refresh current open details
      const refreshed = await api.get<TravelBooking>(`/travel/bookings/${selectedBooking.id}`);
      setSelectedBooking(refreshed);
      void loadSummary(locationId);
      void loadBookings();
    } catch (err) {
      toast.error(errorMessage(err), 'Failed to update status');
    } finally {
      setActionBusy(false);
    }
  };

  // Export CSV
  const handleExportCsv = () => {
    const params = new URLSearchParams();
    if (locationId) params.set('locationId', locationId);
    if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
    if (activeTab === 'bus') params.set('transportType', 'bus');
    else if (activeTab === 'train') params.set('transportType', 'train');
    if (datePreset && datePreset !== 'all') params.set('datePreset', datePreset);
    if (datePreset === 'custom') {
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
    }
    if (search.trim()) params.set('search', search.trim());

    window.open(`/api/travel/reports/export?${params.toString()}`, '_blank');
  };

  // Trigger Print for PDF
  const handlePrintPdf = () => {
    window.print();
  };

  const tabs = [
    { value: 'overview', label: 'Overview & Register' },
    {
      value: 'bus',
      label: 'Bus Bookings',
      count: summary?.today.busTickets ?? 0,
    },
    {
      value: 'train',
      label: 'Train Bookings',
      count: summary?.today.trainTickets ?? 0,
    },
    { value: 'reports', label: 'Daily & Monthly Reports' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div>
          <PageHeader
            title="Travel & Ticket Booking"
            description="Live daily bus and train ticket bookings across BSC Textiles stores, passenger registers, PNR tracking, and reports."
          />
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
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
            onClick={() => {
              void loadSummary(locationId);
              void loadBookings();
              if (activeTab === 'reports') void loadChart();
            }}
            title="Refresh statistics"
          >
            <Icon name="refresh" className="h-4 w-4" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5"
            onClick={() => setCreateModalOpen(true)}
          >
            <Icon name="plus" className="h-4 w-4" />
            <span>New Ticket Booking</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {error}
        </div>
      )}

      {/* Live Statistics Cards Strip */}
      {loading && !summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton lines={2} />
            </Card>
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Card className="card-pad border-l-4 border-l-brand-600 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">Total Today</span>
            <p className="mt-1 text-2xl font-black text-brand-700">{summary.today.totalTickets}</p>
            <span className="text-[11px] text-ink-500">{summary.today.totalBookings} bookings today</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-blue-600 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">Bus Tickets</span>
            <p className="mt-1 text-2xl font-black text-blue-800">{summary.today.busTickets}</p>
            <span className="text-[11px] text-ink-500">Booked today</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-emerald-600 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Train Tickets</span>
            <p className="mt-1 text-2xl font-black text-emerald-800">{summary.today.trainTickets}</p>
            <span className="text-[11px] text-ink-500">Booked today</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-amber-500 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">Pending</span>
            <p className="mt-1 text-2xl font-black text-amber-800">{summary.today.pendingBookings}</p>
            <span className="text-[11px] text-ink-500">Awaiting action</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-teal-600 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-700">Confirmed</span>
            <p className="mt-1 text-2xl font-black text-teal-800">{summary.today.confirmedBookings}</p>
            <span className="text-[11px] text-ink-500">Active tickets</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-rose-500 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-rose-700">Cancelled</span>
            <p className="mt-1 text-2xl font-black text-rose-800">{summary.today.cancelledBookings}</p>
            <span className="text-[11px] text-ink-500">Excluded from active</span>
          </Card>

          <Card className="card-pad border-l-4 border-l-indigo-600 bg-white">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">This Month</span>
            <p className="mt-1 text-2xl font-black text-indigo-800">{summary.thisMonth.totalTickets}</p>
            <span className="text-[11px] text-ink-500">{formatCurrency(summary.thisMonth.totalAmount)}</span>
          </Card>
        </div>
      ) : null}

      {/* Store Comparison Strip (for all locations / multi-store view) */}
      {summary && summary.byStore.length > 1 && (
        <Card className="p-4 bg-slate-50 border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-700">Store-Wise Live Comparison</span>
            <span className="text-[11px] text-ink-500">Independent store allocation & data access</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {summary.byStore.map((st) => (
              <div
                key={st.locationId}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3 shadow-2xs"
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <Badge tone="info" className="font-mono text-[10px]">
                      {st.code}
                    </Badge>
                    <span className="text-xs font-semibold text-ink-900">{st.name.replace(/ Store$/, '')}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-ink-500">
                    <span>{st.todayBus} bus</span> &bull; <span>{st.todayTrain} train</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xl font-extrabold text-brand-600">{st.todayTickets}</p>
                  <span className="text-[10px] text-ink-400">tickets today</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Tabs */}
      <Tabs
        tabs={tabs}
        value={activeTab}
        onChange={(t) => setActiveTab(t as any)}
      />

      {/* Tab 1: Overview & Register */}
      {(activeTab === 'overview' || activeTab === 'bus' || activeTab === 'train') && (
        <div className="space-y-4">
          {/* Specific Tab Callouts */}
          {activeTab === 'bus' && summary && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3.5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-blue-200 text-blue-800 flex items-center justify-center">
                  <Icon name="bus" className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[11px] font-bold uppercase text-blue-900">Total Bus Tickets Today</span>
                  <p className="text-2xl font-black text-blue-900">{summary.today.busTickets}</p>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
                  <Icon name="calendar" className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[11px] font-bold uppercase text-ink-700">Bus Bookings This Week</span>
                  <p className="text-2xl font-black text-ink-900">{summary.thisWeek.busTickets}</p>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
                  <Icon name="wallet" className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[11px] font-bold uppercase text-ink-700">Bus Bookings This Month</span>
                  <p className="text-2xl font-black text-ink-900">{summary.thisMonth.busTickets}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'train' && summary && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-emerald-200 text-emerald-800 flex items-center justify-center">
                  <Icon name="train" className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[11px] font-bold uppercase text-emerald-900">Total Train Tickets Today</span>
                  <p className="text-2xl font-black text-emerald-900">{summary.today.trainTickets}</p>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
                  <Icon name="calendar" className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[11px] font-bold uppercase text-ink-700">Train Bookings This Week</span>
                  <p className="text-2xl font-black text-ink-900">{summary.thisWeek.trainTickets}</p>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
                  <Icon name="wallet" className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[11px] font-bold uppercase text-ink-700">Train Bookings This Month</span>
                  <p className="text-2xl font-black text-ink-900">{summary.thisMonth.trainTickets}</p>
                </div>
              </div>
            </div>
          )}

          {/* Filter Bar */}
          <Card className="p-3.5 bg-white border-slate-200">
            <div className="flex flex-wrap items-center gap-3 justify-between">
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Search */}
                <div className="relative min-w-[220px]">
                  <Icon name="search" className="absolute left-3 top-2.5 h-4 w-4 text-ink-400" />
                  <input
                    type="text"
                    className="input pl-9 text-xs"
                    placeholder="Search PNR, ref, employee, route..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && loadBookings()}
                  />
                </div>

                {/* Date Preset */}
                <select
                  className="input text-xs max-w-[130px]"
                  value={datePreset}
                  onChange={(e) => setDatePreset(e.target.value as any)}
                >
                  <option value="all">All Dates</option>
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="this_week">This Week</option>
                  <option value="this_month">This Month</option>
                  <option value="custom">Custom Range</option>
                </select>

                {datePreset === 'custom' && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="date"
                      className="input text-xs max-w-[130px]"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                    <span className="text-xs text-ink-400">to</span>
                    <input
                      type="date"
                      className="input text-xs max-w-[130px]"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                )}

                {/* Status */}
                <select
                  className="input text-xs max-w-[130px]"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All Statuses</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="pending">Pending</option>
                  <option value="requested">Requested</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="completed">Completed</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>

              {/* Action utilities */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs flex items-center gap-1.5"
                  onClick={handleExportCsv}
                  title="Export filtered records to Excel (CSV)"
                >
                  <Icon name="download" className="h-3.5 w-3.5" />
                  <span>Export Excel</span>
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs flex items-center gap-1.5"
                  onClick={handlePrintPdf}
                  title="Print / Save as PDF"
                >
                  <Icon name="file" className="h-3.5 w-3.5" />
                  <span>PDF / Print</span>
                </button>
              </div>
            </div>
          </Card>

          {/* Bookings Register Table */}
          <Card className="overflow-hidden bg-white border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-ink-700">
                  <tr>
                    <th className="py-3 px-3.5">Booking Ref</th>
                    <th className="py-3 px-3.5">Employee</th>
                    <th className="py-3 px-3.5">Type</th>
                    <th className="py-3 px-3.5">Route</th>
                    <th className="py-3 px-3.5">Journey Date</th>
                    <th className="py-3 px-3.5">Booking Date</th>
                    <th className="py-3 px-3.5">Carrier / PNR</th>
                    <th className="py-3 px-3.5 text-center">Tickets</th>
                    <th className="py-3 px-3.5 text-right">Amount</th>
                    <th className="py-3 px-3.5 text-center">Status</th>
                    <th className="py-3 px-3.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {listLoading ? (
                    <tr>
                      <td colSpan={11} className="p-8 text-center text-ink-500">
                        <Skeleton lines={5} />
                      </td>
                    </tr>
                  ) : bookings.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="p-10 text-center">
                        <EmptyState
                          title="No travel bookings found"
                          description="No bus or train ticket bookings match your active filters or store selection."
                        />
                      </td>
                    </tr>
                  ) : (
                    bookings.map((b) => (
                      <tr key={b.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-3.5 font-mono font-medium text-brand-700">
                          <button
                            type="button"
                            className="hover:underline font-bold text-left cursor-pointer"
                            onClick={() => openBookingDetails(b.id)}
                          >
                            {b.bookingReference}
                          </button>
                        </td>
                        <td className="py-3 px-3.5">
                          <div className="flex items-center gap-2">
                            <Avatar name={b.employeeName} size={26} />
                            <div>
                              <p className="font-semibold text-ink-900">{b.employeeName}</p>
                              <div className="flex items-center gap-1.5 text-[10px] text-ink-500">
                                <span className="font-mono">{b.employeeCode}</span>
                                <span>&bull;</span>
                                <Badge tone="info" className="text-[9px] px-1 py-0 font-mono">
                                  {b.locationCode}
                                </Badge>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3.5">
                          {b.transportType === 'bus' ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 border border-blue-200">
                              <Icon name="bus" className="h-3 w-3" />
                              <span>Bus</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                              <Icon name="train" className="h-3 w-3" />
                              <span>Train</span>
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3.5">
                          <div className="font-medium text-ink-900">
                            {b.sourceLocation} &rarr; {b.destinationLocation}
                          </div>
                          {b.boardingPoint && (
                            <div className="text-[10px] text-ink-500 truncate max-w-[140px]" title={b.boardingPoint}>
                              Board: {b.boardingPoint}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3.5">
                          <div className="font-medium text-ink-900">{formatDate(b.journeyDate)}</div>
                          {b.journeyTime && <div className="text-[10px] text-ink-500">{b.journeyTime}</div>}
                        </td>
                        <td className="py-3 px-3.5 text-ink-600">
                          <div>{formatDate(b.bookingDate)}</div>
                          <div className="text-[10px] text-ink-400">by {b.bookedByName}</div>
                        </td>
                        <td className="py-3 px-3.5">
                          <div className="font-medium text-ink-900 truncate max-w-[150px]" title={b.operatorOrTrainName || ''}>
                            {b.operatorOrTrainName || (b.trainNumber ? `Train #${b.trainNumber}` : '—')}
                          </div>
                          {b.pnrOrTicketNumber && (
                            <div className="font-mono text-[10px] text-ink-600 truncate max-w-[140px]" title={b.pnrOrTicketNumber}>
                              PNR: {b.pnrOrTicketNumber}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3.5 text-center font-bold text-ink-900">
                          <span
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs text-ink-800"
                            title={b.passengers.map((p) => p.passengerName).join(', ')}
                          >
                            {b.passengerCount}
                          </span>
                        </td>
                        <td className="py-3 px-3.5 text-right font-medium text-ink-900">
                          {formatCurrency(b.totalAmount)}
                        </td>
                        <td className="py-3 px-3.5 text-center">
                          <Badge tone={STATUS_TONES[b.status] || 'neutral'} className="capitalize text-[10px]">
                            {b.status}
                          </Badge>
                        </td>
                        <td className="py-3 px-3.5 text-right">
                          <button
                            type="button"
                            className="btn-secondary text-[11px] px-2.5 py-1"
                            onClick={() => openBookingDetails(b.id)}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination footer */}
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 bg-slate-50 text-xs text-ink-500">
              <div>
                Showing <span className="font-semibold">{bookings.length}</span> of <span className="font-semibold">{totalCount}</span> total bookings
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs px-2.5 py-1"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <span>Page {page}</span>
                <button
                  type="button"
                  className="btn-secondary text-xs px-2.5 py-1"
                  disabled={bookings.length < 20}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Tab 4: Daily & Monthly Reports */}
      {activeTab === 'reports' && (
        <div className="space-y-6">
          {/* Daily Trend Chart Card */}
          <Card className="p-5 bg-white border-slate-200">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-3 mb-4">
              <div>
                <h3 className="text-base font-bold text-ink-900">Daily Bus vs Train Booking Trend</h3>
                <p className="text-xs text-ink-500">Tickets booked per day (based on actual booking date)</p>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-xs bg-blue-500" />
                  <span className="font-medium text-ink-700">Bus Tickets</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-xs bg-emerald-500" />
                  <span className="font-medium text-ink-700">Train Tickets</span>
                </div>
              </div>
            </div>

            {chartData.length === 0 ? (
              <div className="py-12 text-center text-xs text-ink-500">
                No booking records recorded for this time frame.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="h-56 flex items-end gap-3 pt-6 pb-2 px-2 border-b border-slate-200 overflow-x-auto">
                  {(() => {
                    const maxVal = Math.max(...chartData.map((d) => d.total), 1);
                    return chartData.map((pt) => {
                      const busHeight = Math.round((pt.bus / maxVal) * 100);
                      const trainHeight = Math.round((pt.train / maxVal) * 100);
                      return (
                        <div key={pt.date} className="flex-1 min-w-[42px] flex flex-col items-center gap-1.5">
                          <span className="text-[10px] font-bold text-ink-700">{pt.total}</span>
                          <div className="w-full flex items-end justify-center gap-1 h-36 bg-slate-50 rounded-t-sm p-0.5">
                            <div
                              className="w-1/2 bg-blue-500 rounded-t-sm transition-all"
                              style={{ height: `${busHeight}%` }}
                              title={`Bus: ${pt.bus}`}
                            />
                            <div
                              className="w-1/2 bg-emerald-500 rounded-t-sm transition-all"
                              style={{ height: `${trainHeight}%` }}
                              title={`Train: ${pt.train}`}
                            />
                          </div>
                          <span className="text-[9px] text-ink-500 font-mono whitespace-nowrap">
                            {pt.date.slice(5)}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
          </Card>

          {/* Quick Reports Export & Status Breakdown */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="p-5 bg-white border-slate-200">
              <h3 className="text-base font-bold text-ink-900 mb-3">Booking Status Lifecycle Distribution</h3>
              {summary && (
                <div className="space-y-2.5">
                  {Object.entries(summary.byStatus).map(([st, cnt]) => {
                    const totalMonth = Math.max(summary.thisMonth.totalBookings, 1);
                    const pct = Math.round((cnt / totalMonth) * 100);
                    return (
                      <div key={st} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="capitalize font-medium text-ink-700">{st}</span>
                          <span className="font-bold text-ink-900">
                            {cnt} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              st === 'confirmed' ? 'bg-teal-500' : st === 'cancelled' ? 'bg-rose-500' : 'bg-amber-500'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card className="p-5 bg-white border-slate-200 flex flex-col justify-between">
              <div>
                <h3 className="text-base font-bold text-ink-900 mb-1">Export Travel & Booking Audits</h3>
                <p className="text-xs text-ink-500 mb-4">
                  Download verifiable corporate audit reports for accounting, HR verification, and store logistics reconciliation.
                </p>
                <div className="space-y-2 text-xs text-ink-700">
                  <div className="flex items-center gap-2">
                    <Icon name="check" className="h-4 w-4 text-emerald-600" />
                    <span>Includes individual passenger seats, PNRs, and train/bus ticket numbers</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Icon name="check" className="h-4 w-4 text-emerald-600" />
                    <span>Distinguishes booking date from journey date</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Icon name="check" className="h-4 w-4 text-emerald-600" />
                    <span>Separates active confirmed bookings from cancelled records</span>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex items-center gap-3">
                <button
                  type="button"
                  className="btn-primary flex items-center gap-1.5 text-xs flex-1 justify-center py-2"
                  onClick={handleExportCsv}
                >
                  <Icon name="download" className="h-4 w-4" />
                  <span>Download Excel CSV</span>
                </button>
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1.5 text-xs flex-1 justify-center py-2"
                  onClick={handlePrintPdf}
                >
                  <Icon name="file" className="h-4 w-4" />
                  <span>Generate PDF Report</span>
                </button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* MODAL 1: New Ticket Booking */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Record New Ticket Booking"
        size="lg"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-5">
          {/* Top selection: Employee & Transport */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">
                Select Employee <span className="text-rose-500">*</span>
              </label>
              <select
                className="input text-xs w-full"
                value={newForm.employeeId}
                onChange={(e) => handleFormEmployeeChange(e.target.value)}
                required
              >
                <option value="">-- Choose Employee --</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} ({emp.employeeCode}) – {emp.locationCode}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">
                Transport Mode <span className="text-rose-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-semibold transition ${
                    newForm.transportType === 'bus'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-ink-700 hover:bg-slate-50'
                  }`}
                  onClick={() => setNewForm((p) => ({ ...p, transportType: 'bus' }))}
                >
                  <Icon name="bus" className="h-4 w-4" />
                  <span>Bus Booking</span>
                </button>
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-semibold transition ${
                    newForm.transportType === 'train'
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-ink-700 hover:bg-slate-50'
                  }`}
                  onClick={() => setNewForm((p) => ({ ...p, transportType: 'train' }))}
                >
                  <Icon name="train" className="h-4 w-4" />
                  <span>Train Booking</span>
                </button>
              </div>
            </div>
          </div>

          {/* Route details */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">
                From / Source Location <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                className="input text-xs w-full"
                placeholder="e.g. Belagavi, Davanagere, Shivamogga"
                value={newForm.sourceLocation}
                onChange={(e) => setNewForm((p) => ({ ...p, sourceLocation: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">
                To / Destination Location <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                className="input text-xs w-full"
                placeholder="e.g. Bengaluru, Hubballi, Pune"
                value={newForm.destinationLocation}
                onChange={(e) => setNewForm((p) => ({ ...p, destinationLocation: e.target.value }))}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">Boarding Point (Optional)</label>
              <input
                type="text"
                className="input text-xs w-full"
                placeholder="e.g. CBT Bus Stand, Davanagere Railway Station"
                value={newForm.boardingPoint}
                onChange={(e) => setNewForm((p) => ({ ...p, boardingPoint: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">Dropping Point (Optional)</label>
              <input
                type="text"
                className="input text-xs w-full"
                placeholder="e.g. Majestic, Yesvantpur Junction"
                value={newForm.droppingPoint}
                onChange={(e) => setNewForm((p) => ({ ...p, droppingPoint: e.target.value }))}
              />
            </div>
          </div>

          {/* Dates & Schedule */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">
                Booking Date (Actual booked) <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                className="input text-xs w-full"
                value={newForm.bookingDate}
                onChange={(e) => setNewForm((p) => ({ ...p, bookingDate: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">
                Journey Date <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                className="input text-xs w-full"
                value={newForm.journeyDate}
                onChange={(e) => setNewForm((p) => ({ ...p, journeyDate: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">Journey Time</label>
              <input
                type="time"
                className="input text-xs w-full"
                value={newForm.journeyTime}
                onChange={(e) => setNewForm((p) => ({ ...p, journeyTime: e.target.value }))}
              />
            </div>
          </div>

          {/* Carrier specific information */}
          {newForm.transportType === 'bus' ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
              <span className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                <Icon name="bus" className="h-4 w-4" />
                <span>Bus Booking Details</span>
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">Bus Operator</label>
                  <input
                    type="text"
                    className="input text-xs w-full"
                    placeholder="e.g. KSRTC Airavat, VRL, SRS"
                    value={newForm.operatorOrTrainName}
                    onChange={(e) => setNewForm((p) => ({ ...p, operatorOrTrainName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">Ticket / Reference #</label>
                  <input
                    type="text"
                    className="input text-xs w-full"
                    placeholder="e.g. KSRTC-BLG-9921"
                    value={newForm.pnrOrTicketNumber}
                    onChange={(e) => setNewForm((p) => ({ ...p, pnrOrTicketNumber: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">Bus Class / Type</label>
                  <input
                    type="text"
                    className="input text-xs w-full"
                    placeholder="e.g. AC Sleeper, Rajahamsa"
                    value={newForm.seatClass}
                    onChange={(e) => setNewForm((p) => ({ ...p, seatClass: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
              <span className="text-xs font-bold text-emerald-900 flex items-center gap-1.5">
                <Icon name="train" className="h-4 w-4" />
                <span>Railway Booking Details</span>
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">Train Name</label>
                  <input
                    type="text"
                    className="input text-xs w-full"
                    placeholder="e.g. Jan Shatabdi, Rani Chennamma"
                    value={newForm.operatorOrTrainName}
                    onChange={(e) => setNewForm((p) => ({ ...p, operatorOrTrainName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">Train Number</label>
                  <input
                    type="text"
                    className="input text-xs w-full"
                    placeholder="e.g. 12080, 16589"
                    value={newForm.trainNumber}
                    onChange={(e) => setNewForm((p) => ({ ...p, trainNumber: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">10-Digit PNR Number</label>
                  <input
                    type="text"
                    className="input text-xs w-full font-mono"
                    placeholder="e.g. 481-2245901"
                    value={newForm.pnrOrTicketNumber}
                    onChange={(e) => setNewForm((p) => ({ ...p, pnrOrTicketNumber: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-700 mb-1">Class / Coach</label>
                  <input
                    type="text"
                    className="input text-xs w-full"
                    placeholder="e.g. 3A, CC, SL, 2S"
                    value={newForm.seatClass}
                    onChange={(e) => setNewForm((p) => ({ ...p, seatClass: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Multi-Passenger Section */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-ink-900">Passengers Register</span>
                <p className="text-[11px] text-ink-500">
                  Multiple passengers under one booking reference are tracked and counted as individual tickets.
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary text-xs flex items-center gap-1 py-1 px-2.5"
                onClick={addPassengerRow}
              >
                <Icon name="plus" className="h-3 w-3" />
                <span>Add Passenger</span>
              </button>
            </div>

            <div className="space-y-2">
              {newForm.passengers.map((p, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 gap-2 bg-white p-2.5 rounded-lg border border-slate-200 items-center"
                >
                  <div className="col-span-1 text-center font-bold text-xs text-ink-500">#{idx + 1}</div>
                  <div className="col-span-4">
                    <input
                      type="text"
                      className="input text-xs w-full"
                      placeholder="Passenger Full Name *"
                      value={p.passengerName}
                      onChange={(e) => updatePassengerField(idx, 'passengerName', e.target.value)}
                      required
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      type="number"
                      className="input text-xs w-full"
                      placeholder="Age"
                      value={p.age}
                      onChange={(e) => updatePassengerField(idx, 'age', e.target.value)}
                    />
                  </div>
                  <div className="col-span-2">
                    <select
                      className="input text-xs w-full"
                      value={p.gender}
                      onChange={(e) => updatePassengerField(idx, 'gender', e.target.value)}
                    >
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <input
                      type="text"
                      className="input text-xs w-full"
                      placeholder="Seat/Berth"
                      value={p.seatBerth}
                      onChange={(e) => updatePassengerField(idx, 'seatBerth', e.target.value)}
                    />
                  </div>
                  <div className="col-span-1 text-right">
                    {newForm.passengers.length > 1 && (
                      <button
                        type="button"
                        className="text-rose-500 hover:text-rose-700 p-1"
                        onClick={() => removePassengerRow(idx)}
                        title="Remove passenger"
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Total Amount, Purpose & Initial Status */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">Total Booking Amount (₹)</label>
              <input
                type="number"
                step="0.01"
                className="input text-xs w-full"
                placeholder="0.00"
                value={newForm.totalAmount}
                onChange={(e) => setNewForm((p) => ({ ...p, totalAmount: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">Travel Purpose</label>
              <input
                type="text"
                className="input text-xs w-full"
                placeholder="e.g. Store Inventory Audit, Management Meet"
                value={newForm.purpose}
                onChange={(e) => setNewForm((p) => ({ ...p, purpose: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-700 mb-1">Booking Status</label>
              <select
                className="input text-xs w-full"
                value={newForm.status}
                onChange={(e) => setNewForm((p) => ({ ...p, status: e.target.value as any }))}
              >
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
                <option value="requested">Requested</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-700 mb-1">Remarks / Notes</label>
            <textarea
              className="input text-xs w-full"
              rows={2}
              placeholder="Add optional notes, invoice details or reference..."
              value={newForm.notes}
              onChange={(e) => setNewForm((p) => ({ ...p, notes: e.target.value }))}
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setCreateModalOpen(false)}
              disabled={formSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary text-xs flex items-center gap-1.5"
              disabled={formSubmitting}
            >
              {formSubmitting ? (
                <>
                  <Icon name="refresh" className="h-4 w-4 animate-spin" />
                  <span>Saving Booking...</span>
                </>
              ) : (
                <>
                  <Icon name="check" className="h-4 w-4" />
                  <span>Confirm & Save Booking</span>
                </>
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL 2: View Booking Details & Audit Logs */}
      {selectedBooking && (
        <Modal
          open={detailsModalOpen}
          onClose={() => setDetailsModalOpen(false)}
          title={`Booking Details: ${selectedBooking.bookingReference}`}
          size="lg"
        >
          <div className="space-y-5">
            {/* Cancellation alert if cancelled */}
            {selectedBooking.status === 'cancelled' && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900 space-y-1">
                <div className="font-bold flex items-center gap-1.5 text-rose-800">
                  <Icon name="alertTriangle" className="h-4 w-4" />
                  <span>This travel booking has been cancelled</span>
                </div>
                <p>
                  <strong>Reason:</strong> {selectedBooking.cancellationReason || 'No reason provided'}
                </p>
                {selectedBooking.cancelledAt && (
                  <p className="text-rose-700">
                    Cancelled on: {formatDateTime(selectedBooking.cancelledAt)}
                  </p>
                )}
              </div>
            )}

            {/* Quick summary grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
              <div>
                <span className="text-[10px] uppercase font-bold text-ink-500">Employee</span>
                <p className="font-bold text-sm text-ink-900">{selectedBooking.employeeName}</p>
                <span className="text-xs text-ink-500">{selectedBooking.employeeCode}</span>
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-ink-500">Store / Location</span>
                <p className="font-bold text-sm text-ink-900">{selectedBooking.locationCode}</p>
                <span className="text-xs text-ink-500">{selectedBooking.locationName}</span>
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-ink-500">Mode & Status</span>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge tone={selectedBooking.transportType === 'bus' ? 'info' : 'success'}>
                    {selectedBooking.transportType.toUpperCase()}
                  </Badge>
                  <Badge tone={STATUS_TONES[selectedBooking.status] || 'neutral'}>
                    {selectedBooking.status}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-ink-500">Total Amount</span>
                <p className="font-extrabold text-sm text-brand-700">
                  {formatCurrency(selectedBooking.totalAmount)}
                </p>
                <span className="text-xs text-ink-500">{selectedBooking.passengerCount} passenger(s)</span>
              </div>
            </div>

            {/* Route & Journey Timings */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">Journey & Carrier Details</span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 rounded-xl border border-slate-200 p-3.5 bg-white text-xs">
                <div className="space-y-1.5">
                  <p>
                    <span className="text-ink-500">Route:</span>{' '}
                    <strong className="text-ink-900">
                      {selectedBooking.sourceLocation} &rarr; {selectedBooking.destinationLocation}
                    </strong>
                  </p>
                  {selectedBooking.boardingPoint && (
                    <p>
                      <span className="text-ink-500">Boarding Point:</span>{' '}
                      <span className="text-ink-800">{selectedBooking.boardingPoint}</span>
                    </p>
                  )}
                  {selectedBooking.droppingPoint && (
                    <p>
                      <span className="text-ink-500">Dropping Point:</span>{' '}
                      <span className="text-ink-800">{selectedBooking.droppingPoint}</span>
                    </p>
                  )}
                  <p>
                    <span className="text-ink-500">Purpose:</span>{' '}
                    <span className="text-ink-800">{selectedBooking.purpose || 'Official Travel'}</span>
                  </p>
                </div>

                <div className="space-y-1.5">
                  <p>
                    <span className="text-ink-500">Carrier:</span>{' '}
                    <strong className="text-ink-900">
                      {selectedBooking.operatorOrTrainName || '—'}
                    </strong>
                    {selectedBooking.trainNumber && <span> (#{selectedBooking.trainNumber})</span>}
                  </p>
                  <p>
                    <span className="text-ink-500">PNR / Ticket:</span>{' '}
                    <span className="font-mono font-bold text-ink-900">
                      {selectedBooking.pnrOrTicketNumber || '—'}
                    </span>
                  </p>
                  <p>
                    <span className="text-ink-500">Class & Seats:</span>{' '}
                    <span className="text-ink-800">
                      {selectedBooking.seatClass || '—'} {selectedBooking.seatNumbers ? `(${selectedBooking.seatNumbers})` : ''}
                    </span>
                  </p>
                  <p>
                    <span className="text-ink-500">Journey Date:</span>{' '}
                    <strong className="text-ink-900">
                      {formatDate(selectedBooking.journeyDate)} {selectedBooking.journeyTime || ''}
                    </strong>
                  </p>
                </div>
              </div>
            </div>

            {/* Passengers List */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
                Passenger Manifest ({selectedBooking.passengers.length})
              </span>
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 font-semibold text-ink-700 border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">Passenger Name</th>
                      <th className="py-2 px-3">Age / Gender</th>
                      <th className="py-2 px-3">Seat / Berth</th>
                      <th className="py-2 px-3">Ticket / PNR</th>
                      <th className="py-2 px-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedBooking.passengers.map((p, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50">
                        <td className="py-2 px-3 text-ink-500">{idx + 1}</td>
                        <td className="py-2 px-3 font-semibold text-ink-900">{p.passengerName}</td>
                        <td className="py-2 px-3 text-ink-600">
                          {p.age ? `${p.age} yrs` : '—'} &bull; {p.gender || '—'}
                        </td>
                        <td className="py-2 px-3 font-mono text-ink-700">{p.seatBerth || '—'}</td>
                        <td className="py-2 px-3 font-mono text-ink-700">
                          {p.ticketNumber || selectedBooking.pnrOrTicketNumber || '—'}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <Badge tone={p.status === 'cancelled' ? 'danger' : 'success'} className="text-[10px]">
                            {p.status || 'confirmed'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Audit Logs */}
            {selectedBooking.logs && selectedBooking.logs.length > 0 && (
              <div className="space-y-2">
                <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">Activity Audit Log</span>
                <div className="space-y-1.5 max-h-40 overflow-y-auto rounded-xl border border-slate-200 p-3 bg-slate-50/50 text-xs">
                  {selectedBooking.logs.map((log) => (
                    <div key={log.id} className="flex items-start justify-between border-b border-slate-100 pb-1.5 last:border-0 last:pb-0">
                      <div>
                        <span className="font-semibold text-ink-900">{log.actorName}</span>{' '}
                        <span className="text-ink-500">({log.action}):</span>{' '}
                        <span className="text-ink-700">{log.remarks || 'Status updated'}</span>
                      </div>
                      <span className="text-[10px] text-ink-400 whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Status change actions */}
            <div className="flex items-center justify-between pt-3 border-t border-slate-200">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => {
                    setStatusActionOpen(true);
                    setActionStatus(selectedBooking.status === 'confirmed' ? 'completed' : 'confirmed');
                  }}
                >
                  <Icon name="edit" className="h-3.5 w-3.5" />
                  <span>Update Status / Action</span>
                </button>
                {selectedBooking.status !== 'cancelled' && (
                  <button
                    type="button"
                    className="btn-danger text-xs"
                    onClick={() => {
                      setStatusActionOpen(true);
                      setActionStatus('cancelled');
                    }}
                  >
                    <Icon name="close" className="h-3.5 w-3.5" />
                    <span>Cancel Ticket Booking</span>
                  </button>
                )}
              </div>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => setDetailsModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* MODAL 3: Update Status or Cancel Booking Dialog */}
      <Modal
        open={statusActionOpen}
        onClose={() => setStatusActionOpen(false)}
        title={actionStatus === 'cancelled' ? 'Cancel Ticket Booking' : 'Update Booking Status'}
        size="md"
      >
        <div className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-ink-700 mb-1">Select New Status</label>
            <select
              className="input text-xs w-full"
              value={actionStatus}
              onChange={(e) => setActionStatus(e.target.value)}
            >
              <option value="confirmed">Confirmed</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {actionStatus === 'cancelled' && (
            <div>
              <label className="block font-semibold text-rose-700 mb-1">
                Reason for Cancellation <span className="text-rose-500">*</span>
              </label>
              <textarea
                className="input text-xs w-full border-rose-300 focus:border-rose-500"
                rows={3}
                placeholder="State why this ticket is being cancelled (e.g. Supplier postponed visit, meeting rescheduled)..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                required
              />
            </div>
          )}

          <div>
            <label className="block font-semibold text-ink-700 mb-1">Action Remarks / Notes</label>
            <input
              type="text"
              className="input text-xs w-full"
              placeholder="Optional remarks for audit trail..."
              value={actionRemarks}
              onChange={(e) => setActionRemarks(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-200">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setStatusActionOpen(false)}
              disabled={actionBusy}
            >
              Dismiss
            </button>
            <button
              type="button"
              className={actionStatus === 'cancelled' ? 'btn-danger text-xs' : 'btn-primary text-xs'}
              onClick={handleStatusSubmit}
              disabled={actionBusy}
            >
              {actionBusy ? 'Updating...' : actionStatus === 'cancelled' ? 'Confirm Cancellation' : 'Update Status'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
