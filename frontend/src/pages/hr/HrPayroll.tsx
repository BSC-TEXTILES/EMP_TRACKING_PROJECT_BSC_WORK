import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '../../lib/hooks';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, Skeleton } from '../../components/ui';
import { Icon } from '../../components/icons';
import { formatDate } from '../../lib/format';

interface PayrollRecord {
  id: number;
  employeeId: number;
  employeeCode: string;
  fullName: string;
  departmentName: string | null;
  designationTitle: string | null;
  locationCode: string | null;
  month: number;
  year: number;
  workingDays: number;
  presentDays: number;
  paidLeaves: number;
  payableDays: number;
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
  paymentStatus: 'draft' | 'processed' | 'paid' | 'on_hold';
  paidAt: string | null;
  referenceNo: string | null;
  notes: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
}

interface SalaryItem {
  employeeId: number;
  employeeCode: string;
  fullName: string;
  departmentName: string | null;
  designationTitle: string | null;
  locationCode: string | null;
  roleName: string;
  basicSalary: number;
  hra: number;
  specialAllowance: number;
  conveyanceAllowance: number;
  medicalAllowance: number;
  grossSalary: number;
  epfDeduction: number;
  esiDeduction: number;
  professionalTax: number;
  tdsDeduction: number;
  totalDeductions: number;
  netSalary: number;
  bankName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  panNumber: string | null;
  uanNumber: string | null;
  effectiveFrom: string | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export default function HrPayroll() {
  useDocumentTitle('HR Payroll & Salaries');
  const toast = useToast();
  const { has } = useAuth();

  const now = new Date();
  const [activeTab, setActiveTab] = useState<'payroll' | 'salaries'>('payroll');
  const [selectedMonth, setSelectedMonth] = useState<number>(now.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState<number>(now.getFullYear());
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [locations, setLocations] = useState<Array<{ id: number; code: string; name: string }>>([]);

  // Payroll data
  const [payrollLoading, setPayrollLoading] = useState(true);
  const [payrollRecords, setPayrollRecords] = useState<PayrollRecord[]>([]);
  const [summary, setSummary] = useState({ totalGross: 0, totalDeductions: 0, totalNetPay: 0, totalCount: 0, paidCount: 0 });
  const [generating, setGenerating] = useState(false);

  // Status edit modal
  const [statusTarget, setStatusTarget] = useState<PayrollRecord | null>(null);
  const [statusForm, setStatusForm] = useState({ paymentStatus: 'paid', referenceNo: '', notes: '' });
  const [savingStatus, setSavingStatus] = useState(false);

  // Salary structures
  const [salariesLoading, setSalariesLoading] = useState(false);
  const [salaries, setSalaries] = useState<SalaryItem[]>([]);
  const [salarySearch, setSalarySearch] = useState('');
  const [editSalaryTarget, setEditSalaryTarget] = useState<SalaryItem | null>(null);
  const [salaryForm, setSalaryForm] = useState({
    basicSalary: 0,
    hra: 0,
    specialAllowance: 0,
    conveyanceAllowance: 0,
    medicalAllowance: 0,
    epfDeduction: 0,
    esiDeduction: 0,
    professionalTax: 200,
    tdsDeduction: 0,
    bankName: '',
    bankAccountNo: '',
    bankIfsc: '',
    panNumber: '',
    uanNumber: '',
    effectiveFrom: '',
  });
  const [savingSalary, setSavingSalary] = useState(false);

  useEffect(() => {
    api.get<{ locations: Array<{ id: number; code: string; name: string }> }>('/employees/allowed-locations')
      .then((res) => { if (res?.locations) setLocations(res.locations); })
      .catch(() => undefined);
  }, []);

  const loadPayroll = async () => {
    setPayrollLoading(true);
    try {
      const q = new URLSearchParams({
        month: String(selectedMonth),
        year: String(selectedYear),
        ...(selectedLocation ? { locationId: selectedLocation } : {}),
      });
      const res = await api.get<{ records: PayrollRecord[]; summary: typeof summary }>(`/hr/payroll?${q.toString()}`);
      setPayrollRecords(res.records);
      setSummary(res.summary);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPayrollLoading(false);
    }
  };

  const loadSalaries = async () => {
    setSalariesLoading(true);
    try {
      const q = new URLSearchParams({
        ...(selectedLocation ? { locationId: selectedLocation } : {}),
        ...(salarySearch ? { search: salarySearch } : {}),
      });
      const res = await api.get<{ salaries: SalaryItem[] }>(`/hr/salaries?${q.toString()}`);
      setSalaries(res.salaries);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSalariesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'payroll') void loadPayroll();
    else void loadSalaries();
  }, [activeTab, selectedMonth, selectedYear, selectedLocation]);

  const handleGeneratePayroll = async () => {
    setGenerating(true);
    try {
      const res = await api.post<{ ok: boolean; processedCount: number }>('/hr/payroll/generate', {
        month: selectedMonth,
        year: selectedYear,
        locationId: selectedLocation ? Number(selectedLocation) : undefined,
      });
      toast.success(`Generated payroll records for ${res.processedCount} employee(s).`);
      await loadPayroll();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusTarget) return;
    setSavingStatus(true);
    try {
      await api.patch(`/hr/payroll/${statusTarget.id}/status`, {
        paymentStatus: statusForm.paymentStatus,
        referenceNo: statusForm.referenceNo,
        notes: statusForm.notes,
      });
      toast.success('Payment status updated successfully.');
      setStatusTarget(null);
      await loadPayroll();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingStatus(false);
    }
  };

  const handleOpenEditSalary = (s: SalaryItem) => {
    setEditSalaryTarget(s);
    setSalaryForm({
      basicSalary: s.basicSalary,
      hra: s.hra,
      specialAllowance: s.specialAllowance,
      conveyanceAllowance: s.conveyanceAllowance,
      medicalAllowance: s.medicalAllowance,
      epfDeduction: s.epfDeduction,
      esiDeduction: s.esiDeduction,
      professionalTax: s.professionalTax,
      tdsDeduction: s.tdsDeduction,
      bankName: s.bankName ?? '',
      bankAccountNo: s.bankAccountNo ?? '',
      bankIfsc: s.bankIfsc ?? '',
      panNumber: s.panNumber ?? '',
      uanNumber: s.uanNumber ?? '',
      effectiveFrom: s.effectiveFrom ?? '',
    });
  };

  const handleSaveSalary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editSalaryTarget) return;
    setSavingSalary(true);
    try {
      await api.put(`/hr/salaries/${editSalaryTarget.employeeId}`, salaryForm);
      toast.success(`Salary structure updated for ${editSalaryTarget.fullName}.`);
      setEditSalaryTarget(null);
      await loadSalaries();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingSalary(false);
    }
  };

  const statusBadge = (s: PayrollRecord['paymentStatus']) => {
    switch (s) {
      case 'paid':
        return <Badge tone="success">Paid</Badge>;
      case 'processed':
        return <Badge tone="info">Processed</Badge>;
      case 'on_hold':
        return <Badge tone="danger">On Hold</Badge>;
      default:
        return <Badge tone="warning">Draft</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <PageHeader
            title="HR Salary & Payroll Information"
            description="Manage monthly employee payslips, salary structures, attendance deductions, and bank payouts."
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-slate-300 bg-white p-1 shadow-sm">
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'payroll' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:text-ink-900'
              }`}
              onClick={() => setActiveTab('payroll')}
            >
              Monthly Payroll
            </button>
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'salaries' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:text-ink-900'
              }`}
              onClick={() => setActiveTab('salaries')}
            >
              Salary Structures
            </button>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="card-pad flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {activeTab === 'payroll' && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Month</label>
                <select
                  className="input py-1 text-sm"
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(Number(e.target.value))}
                >
                  {MONTH_NAMES.map((name, idx) => (
                    <option key={idx + 1} value={idx + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-500">Year</label>
                <select
                  className="input py-1 text-sm"
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                >
                  {[2024, 2025, 2026, 2027].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">Store Location</label>
            <select
              className="input py-1 text-sm"
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
            >
              <option value="">All Locations</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.code} – {loc.name}
                </option>
              ))}
            </select>
          </div>

          {activeTab === 'salaries' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-500">Search Employee</label>
              <input
                type="text"
                className="input py-1 text-sm"
                placeholder="Name or employee code…"
                value={salarySearch}
                onChange={(e) => setSalarySearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void loadSalaries(); }}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {activeTab === 'payroll' && (
            <button
              type="button"
              className="btn-primary flex items-center gap-1.5"
              disabled={generating}
              onClick={handleGeneratePayroll}
            >
              <Icon name="refresh" className={`h-4 w-4 ${generating ? 'animate-spin' : ''}`} />
              <span>{generating ? 'Processing…' : 'Generate / Refresh Records'}</span>
            </button>
          )}
        </div>
      </Card>

      {activeTab === 'payroll' ? (
        <>
          {/* Payroll KPI Summary */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Card className="card-pad border-l-4 border-l-blue-600">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-500">Employees Processed</span>
              <p className="mt-1 text-2xl font-bold text-ink-900">{summary.totalCount}</p>
            </Card>
            <Card className="card-pad border-l-4 border-l-brand-600">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-500">Gross Earnings</span>
              <p className="mt-1 text-xl font-bold text-ink-900">₹{summary.totalGross.toLocaleString('en-IN')}</p>
            </Card>
            <Card className="card-pad border-l-4 border-l-rose-500">
              <span className="text-xs font-medium uppercase tracking-wider text-rose-700">Total Deductions</span>
              <p className="mt-1 text-xl font-bold text-rose-700">₹{summary.totalDeductions.toLocaleString('en-IN')}</p>
            </Card>
            <Card className="card-pad border-l-4 border-l-emerald-600">
              <span className="text-xs font-medium uppercase tracking-wider text-emerald-700">Net Payable</span>
              <p className="mt-1 text-xl font-bold text-emerald-700">₹{summary.totalNetPay.toLocaleString('en-IN')}</p>
            </Card>
            <Card className="card-pad border-l-4 border-l-teal-600">
              <span className="text-xs font-medium uppercase tracking-wider text-teal-700">Paid Out</span>
              <p className="mt-1 text-2xl font-bold text-teal-700">{summary.paidCount} / {summary.totalCount}</p>
            </Card>
          </div>

          {/* Payroll Table */}
          <Card className="overflow-x-auto">
            {payrollLoading ? (
              <div className="p-6">
                <Skeleton lines={6} />
              </div>
            ) : payrollRecords.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-ink-600">No payroll records generated yet for {MONTH_NAMES[selectedMonth - 1]} {selectedYear}.</p>
                <button
                  type="button"
                  className="btn-primary mt-4"
                  disabled={generating}
                  onClick={handleGeneratePayroll}
                >
                  Generate {MONTH_NAMES[selectedMonth - 1]} {selectedYear} Payroll
                </button>
              </div>
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Location</th>
                    <th>Days (Work / Payable)</th>
                    <th>Gross</th>
                    <th>Deductions</th>
                    <th>Net Pay</th>
                    <th>Bank Details</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payrollRecords.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="font-semibold text-ink-900">{r.fullName}</div>
                        <div className="text-xs font-mono text-brand-700">{r.employeeCode}</div>
                        <div className="text-xs text-ink-500">{r.designationTitle || r.departmentName}</div>
                      </td>
                      <td>
                        {r.locationCode ? (
                          <Badge tone="info" className="font-mono">{r.locationCode}</Badge>
                        ) : '—'}
                      </td>
                      <td>
                        <div className="text-xs">
                          <span className="font-medium text-ink-900">{r.payableDays}</span> / {r.workingDays} days
                        </div>
                        <div className="text-xs text-ink-400">
                          {r.presentDays} pres, {r.paidLeaves} leave
                        </div>
                      </td>
                      <td className="font-medium text-ink-900">₹{r.grossEarnings.toLocaleString('en-IN')}</td>
                      <td className="font-medium text-rose-600">₹{r.totalDeductions.toLocaleString('en-IN')}</td>
                      <td className="font-bold text-emerald-700">₹{r.netPay.toLocaleString('en-IN')}</td>
                      <td className="text-xs">
                        {r.bankName ? (
                          <div>
                            <span className="font-medium text-ink-800">{r.bankName}</span>
                            <div className="font-mono text-ink-500">{r.bankAccountNo || '—'}</div>
                          </div>
                        ) : (
                          <span className="text-ink-400">Not configured</span>
                        )}
                      </td>
                      <td>{statusBadge(r.paymentStatus)}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn-secondary py-1 text-xs"
                          onClick={() => {
                            setStatusTarget(r);
                            setStatusForm({
                              paymentStatus: r.paymentStatus,
                              referenceNo: r.referenceNo ?? '',
                              notes: r.notes ?? '',
                            });
                          }}
                        >
                          Update Status
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      ) : (
        /* Salary Structures Table */
        <Card className="overflow-x-auto">
          {salariesLoading ? (
            <div className="p-6">
              <Skeleton lines={6} />
            </div>
          ) : salaries.length === 0 ? (
            <p className="p-8 text-center text-ink-500">No salary structures found.</p>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Location</th>
                  <th>Basic Salary</th>
                  <th>HRA</th>
                  <th>Allowances</th>
                  <th>Gross Salary</th>
                  <th>Deductions</th>
                  <th>Net Salary</th>
                  <th>Bank Account / IFSC</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {salaries.map((s) => {
                  const allowances = s.specialAllowance + s.conveyanceAllowance + s.medicalAllowance;
                  return (
                    <tr key={s.employeeId}>
                      <td>
                        <div className="font-semibold text-ink-900">{s.fullName}</div>
                        <div className="text-xs font-mono text-brand-700">{s.employeeCode}</div>
                        <div className="text-xs text-ink-500">{s.designationTitle || s.roleName}</div>
                      </td>
                      <td>
                        {s.locationCode ? (
                          <Badge tone="info" className="font-mono">{s.locationCode}</Badge>
                        ) : '—'}
                      </td>
                      <td className="font-medium text-ink-900">₹{s.basicSalary.toLocaleString('en-IN')}</td>
                      <td className="text-ink-700">₹{s.hra.toLocaleString('en-IN')}</td>
                      <td className="text-ink-700">₹{allowances.toLocaleString('en-IN')}</td>
                      <td className="font-semibold text-ink-900">₹{s.grossSalary.toLocaleString('en-IN')}</td>
                      <td className="text-rose-600">₹{s.totalDeductions.toLocaleString('en-IN')}</td>
                      <td className="font-bold text-emerald-700">₹{s.netSalary.toLocaleString('en-IN')}</td>
                      <td className="text-xs">
                        {s.bankAccountNo ? (
                          <div>
                            <span className="font-medium text-ink-800">{s.bankName}</span>
                            <div className="font-mono text-ink-500">{s.bankAccountNo} ({s.bankIfsc})</div>
                          </div>
                        ) : (
                          <span className="text-ink-400">None</span>
                        )}
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn-primary py-1 text-xs"
                          onClick={() => handleOpenEditSalary(s)}
                        >
                          Edit Structure
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Payment Status Modal */}
      {statusTarget && (
        <Modal
          open={Boolean(statusTarget)}
          title={`Update Payment Status: ${statusTarget.fullName}`}
          onClose={() => setStatusTarget(null)}
        >
          <form className="space-y-4" onSubmit={handleSaveStatus}>
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-ink-700">
              <span className="font-semibold">Period:</span> {MONTH_NAMES[statusTarget.month - 1]} {statusTarget.year} &bull;{' '}
              <span className="font-semibold">Net Payable:</span> ₹{statusTarget.netPay.toLocaleString('en-IN')}
            </div>

            <Field label="Payment Status" required>
              <select
                className="input"
                value={statusForm.paymentStatus}
                onChange={(e) => setStatusForm((f) => ({ ...f, paymentStatus: e.target.value as any }))}
                required
              >
                <option value="draft">Draft</option>
                <option value="processed">Processed (Approved for Payout)</option>
                <option value="paid">Paid (Disbursed)</option>
                <option value="on_hold">On Hold</option>
              </select>
            </Field>

            <Field label="Transaction / Reference No.">
              <input
                type="text"
                className="input"
                placeholder="e.g. UTR1234567890 / IMPS / NEFT Ref"
                value={statusForm.referenceNo}
                onChange={(e) => setStatusForm((f) => ({ ...f, referenceNo: e.target.value }))}
              />
            </Field>

            <Field label="Notes / Disbursal Remarks">
              <textarea
                className="input"
                rows={2}
                placeholder="Optional payment notes…"
                value={statusForm.notes}
                onChange={(e) => setStatusForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStatusTarget(null)}
                disabled={savingStatus}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={savingStatus}>
                {savingStatus ? 'Saving…' : 'Save Payment Status'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit Salary Structure Modal */}
      {editSalaryTarget && (
        <Modal
          open={Boolean(editSalaryTarget)}
          title={`Configure Salary: ${editSalaryTarget.fullName} (${editSalaryTarget.employeeCode})`}
          onClose={() => setEditSalaryTarget(null)}
        >
          <form className="space-y-4" onSubmit={handleSaveSalary}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Basic Salary (₹ / month)" required>
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.basicSalary}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, basicSalary: Number(e.target.value) }))}
                  required
                />
              </Field>

              <Field label="HRA (House Rent Allowance ₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.hra}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, hra: Number(e.target.value) }))}
                />
              </Field>

              <Field label="Special Allowance (₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.specialAllowance}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, specialAllowance: Number(e.target.value) }))}
                />
              </Field>

              <Field label="Conveyance Allowance (₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.conveyanceAllowance}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, conveyanceAllowance: Number(e.target.value) }))}
                />
              </Field>

              <Field label="Medical Allowance (₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.medicalAllowance}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, medicalAllowance: Number(e.target.value) }))}
                />
              </Field>

              <Field label="EPF Deduction (₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.epfDeduction}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, epfDeduction: Number(e.target.value) }))}
                />
              </Field>

              <Field label="Professional Tax (₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={10}
                  value={salaryForm.professionalTax}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, professionalTax: Number(e.target.value) }))}
                />
              </Field>

              <Field label="TDS (Income Tax ₹)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  step={100}
                  value={salaryForm.tdsDeduction}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, tdsDeduction: Number(e.target.value) }))}
                />
              </Field>
            </div>

            <div className="border-t border-slate-200 pt-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-600">Banking & Statutory IDs</h4>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Bank Name">
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. State Bank of India"
                    value={salaryForm.bankName}
                    onChange={(e) => setSalaryForm((f) => ({ ...f, bankName: e.target.value }))}
                  />
                </Field>
                <Field label="Account Number">
                  <input
                    type="text"
                    className="input"
                    placeholder="Account number"
                    value={salaryForm.bankAccountNo}
                    onChange={(e) => setSalaryForm((f) => ({ ...f, bankAccountNo: e.target.value }))}
                  />
                </Field>
                <Field label="Bank IFSC">
                  <input
                    type="text"
                    className="input"
                    placeholder="SBIN0001234"
                    value={salaryForm.bankIfsc}
                    onChange={(e) => setSalaryForm((f) => ({ ...f, bankIfsc: e.target.value.toUpperCase() }))}
                  />
                </Field>
                <Field label="PAN Card Number">
                  <input
                    type="text"
                    className="input"
                    placeholder="ABCDE1234F"
                    value={salaryForm.panNumber}
                    onChange={(e) => setSalaryForm((f) => ({ ...f, panNumber: e.target.value.toUpperCase() }))}
                  />
                </Field>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditSalaryTarget(null)}
                disabled={savingSalary}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={savingSalary}>
                {savingSalary ? 'Saving…' : 'Save Salary Structure'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
