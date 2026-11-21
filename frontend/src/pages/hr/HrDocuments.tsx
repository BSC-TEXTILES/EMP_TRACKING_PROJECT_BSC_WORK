import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '../../lib/hooks';
import { useToast } from '../../contexts/ToastContext';
import { Badge, Card, Field, Modal, PageHeader, Skeleton } from '../../components/ui';
import { Icon } from '../../components/icons';
import { formatDate } from '../../lib/format';

interface EmployeeDoc {
  id: number;
  employeeId: number;
  employeeCode: string;
  fullName: string;
  locationCode: string | null;
  departmentName: string | null;
  documentType: string;
  title: string;
  fileUrl: string;
  fileSizeBytes: number;
  fileType: string;
  status: 'pending' | 'verified' | 'rejected';
  verifiedBy: number | null;
  verifierName: string | null;
  verifiedAt: string | null;
  notes: string | null;
  createdAt: string;
}

const DOC_TYPES = [
  { key: 'aadhaar', label: 'Aadhaar Card' },
  { key: 'pan', label: 'PAN Card' },
  { key: 'resume', label: 'Resume / CV' },
  { key: 'offer_letter', label: 'Offer Letter / Contract' },
  { key: 'experience', label: 'Experience Certificate' },
  { key: 'education', label: 'Educational Degree / Marksheet' },
  { key: 'bank_proof', label: 'Bank Passbook / Cancelled Cheque' },
  { key: 'other', label: 'Other Document' },
];

export default function HrDocuments() {
  useDocumentTitle('Employee Documents');
  const toast = useToast();
  const { has, user } = useAuth();

  const [documents, setDocuments] = useState<EmployeeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [locations, setLocations] = useState<Array<{ id: number; code: string; name: string }>>([]);

  // Upload Modal
  const [uploadOpen, setUploadOpen] = useState(false);
  const [employeesPicker, setEmployeesPicker] = useState<Array<{ id: number; employeeCode: string; fullName: string }>>([]);
  const [uploadForm, setUploadForm] = useState({
    employeeId: '',
    documentType: 'aadhaar',
    title: '',
    fileUrl: '',
    notes: '',
  });
  const [uploading, setUploading] = useState(false);

  // Verification Modal
  const [verifyTarget, setVerifyTarget] = useState<EmployeeDoc | null>(null);
  const [verifyNotes, setVerifyNotes] = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    api.get<{ locations: Array<{ id: number; code: string; name: string }> }>('/employees/allowed-locations')
      .then((res) => { if (res?.locations) setLocations(res.locations); })
      .catch(() => undefined);

    api.get<{ employees: Array<{ id: number; employeeCode: string; fullName: string }> }>('/employees/picker')
      .then((res) => { if (res?.employees) setEmployeesPicker(res.employees); })
      .catch(() => undefined);
  }, []);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({
        ...(search ? { search } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(typeFilter ? { documentType: typeFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
      });
      const res = await api.get<{ documents: EmployeeDoc[] }>(`/hr/documents?${q.toString()}`);
      setDocuments(res.documents);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDocuments();
  }, [statusFilter, typeFilter, locationFilter]);

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadForm.employeeId || !uploadForm.title || !uploadForm.fileUrl) {
      toast.error('Please fill in all required fields.');
      return;
    }
    setUploading(true);
    try {
      await api.post('/hr/documents', {
        employeeId: Number(uploadForm.employeeId),
        documentType: uploadForm.documentType,
        title: uploadForm.title,
        fileUrl: uploadForm.fileUrl,
        notes: uploadForm.notes,
      });
      toast.success('Document uploaded successfully.');
      setUploadOpen(false);
      setUploadForm({ employeeId: '', documentType: 'aadhaar', title: '', fileUrl: '', notes: '' });
      await loadDocuments();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const handleVerify = async (doc: EmployeeDoc, status: 'verified' | 'rejected') => {
    setVerifying(true);
    try {
      await api.patch(`/hr/documents/${doc.id}/verify`, {
        status,
        notes: verifyNotes || undefined,
      });
      toast.success(`Document marked as ${status}.`);
      setVerifyTarget(null);
      setVerifyNotes('');
      await loadDocuments();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this document record?')) return;
    try {
      await api.del(`/hr/documents/${id}`);
      toast.success('Document deleted.');
      await loadDocuments();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const statusBadge = (s: EmployeeDoc['status']) => {
    switch (s) {
      case 'verified':
        return <Badge tone="success">Verified</Badge>;
      case 'rejected':
        return <Badge tone="danger">Rejected</Badge>;
      default:
        return <Badge tone="warning">Pending Verification</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="Employee Document & KYC Verification"
          description="Maintain and verify employee identity proofs, contracts, academic credentials, and bank documents."
        />
        <button
          type="button"
          className="btn-primary flex items-center gap-1.5"
          onClick={() => setUploadOpen(true)}
        >
          <Icon name="upload" className="h-4 w-4" />
          <span>Upload Document</span>
        </button>
      </div>

      {/* Filter Bar */}
      <Card className="card-pad flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[200px]">
            <input
              type="text"
              className="input py-1 text-sm"
              placeholder="Search by employee or title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadDocuments(); }}
            />
          </div>

          <select
            className="input py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
          </select>

          <select
            className="input py-1 text-sm"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">All Document Types</option>
            {DOC_TYPES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>

          <select
            className="input py-1 text-sm"
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
          >
            <option value="">All Locations</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.code} – {loc.name}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="btn-secondary py-1 text-xs"
          onClick={() => void loadDocuments()}
        >
          Apply Filters
        </button>
      </Card>

      {/* Documents Table */}
      <Card className="overflow-x-auto">
        {loading ? (
          <div className="p-6">
            <Skeleton lines={6} />
          </div>
        ) : documents.length === 0 ? (
          <div className="p-8 text-center text-ink-500">
            No documents found matching your filter criteria.
          </div>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Store</th>
                <th>Document Type</th>
                <th>Document Title</th>
                <th>Status</th>
                <th>Uploaded</th>
                <th>Verifier</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const typeLabel = DOC_TYPES.find((t) => t.key === doc.documentType)?.label ?? doc.documentType;
                return (
                  <tr key={doc.id}>
                    <td>
                      <div className="font-semibold text-ink-900">{doc.fullName}</div>
                      <div className="text-xs font-mono text-brand-700">{doc.employeeCode}</div>
                      <div className="text-xs text-ink-500">{doc.departmentName || 'Staff'}</div>
                    </td>
                    <td>
                      {doc.locationCode ? (
                        <Badge tone="info" className="font-mono">{doc.locationCode}</Badge>
                      ) : '—'}
                    </td>
                    <td>
                      <span className="text-xs font-medium text-ink-800">{typeLabel}</span>
                    </td>
                    <td>
                      <div className="font-medium text-ink-900">{doc.title}</div>
                      <a
                        href={doc.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand-600 underline hover:text-brand-800"
                      >
                        View file &nearr;
                      </a>
                    </td>
                    <td>{statusBadge(doc.status)}</td>
                    <td className="text-xs text-ink-500">{formatDate(doc.createdAt)}</td>
                    <td className="text-xs">
                      {doc.verifierName ? (
                        <div>
                          <div className="font-medium text-ink-800">{doc.verifierName}</div>
                          <div className="text-ink-400">{doc.verifiedAt ? formatDate(doc.verifiedAt) : ''}</div>
                        </div>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {doc.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              className="btn-primary py-1 px-2 text-xs"
                              onClick={() => {
                                setVerifyTarget(doc);
                                setVerifyNotes('');
                              }}
                            >
                              Verify
                            </button>
                            <button
                              type="button"
                              className="btn-danger py-1 px-2 text-xs"
                              onClick={() => handleVerify(doc, 'rejected')}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="btn-ghost py-1 px-2 text-xs text-rose-600 hover:bg-rose-50"
                          onClick={() => handleDelete(doc.id)}
                          title="Delete document"
                        >
                          <Icon name="trash" className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Upload Document Modal */}
      {uploadOpen && (
        <Modal
          open={uploadOpen}
          title="Upload Employee KYC / Document"
          onClose={() => setUploadOpen(false)}
        >
          <form className="space-y-4" onSubmit={handleUploadSubmit}>
            <Field label="Employee" required>
              <select
                className="input"
                value={uploadForm.employeeId}
                onChange={(e) => setUploadForm((f) => ({ ...f, employeeId: e.target.value }))}
                required
              >
                <option value="">Select an employee…</option>
                {employeesPicker.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.employeeCode} &bull; {emp.fullName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Document Category" required>
              <select
                className="input"
                value={uploadForm.documentType}
                onChange={(e) => setUploadForm((f) => ({ ...f, documentType: e.target.value }))}
                required
              >
                {DOC_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Document Title" required>
              <input
                type="text"
                className="input"
                placeholder="e.g. Aadhaar Card Copy / Degree Certificate"
                value={uploadForm.title}
                onChange={(e) => setUploadForm((f) => ({ ...f, title: e.target.value }))}
                required
              />
            </Field>

            <Field label="File URL / Path" required>
              <input
                type="text"
                className="input"
                placeholder="https://... or /uploads/..."
                value={uploadForm.fileUrl}
                onChange={(e) => setUploadForm((f) => ({ ...f, fileUrl: e.target.value }))}
                required
              />
            </Field>

            <Field label="Notes / Identification Number">
              <textarea
                className="input"
                rows={2}
                placeholder="Optional notes or masked ID number…"
                value={uploadForm.notes}
                onChange={(e) => setUploadForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setUploadOpen(false)}
                disabled={uploading}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={uploading}>
                {uploading ? 'Saving…' : 'Upload Document'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Verification Modal */}
      {verifyTarget && (
        <Modal
          open={Boolean(verifyTarget)}
          title={`Verify Document: ${verifyTarget.title}`}
          onClose={() => setVerifyTarget(null)}
        >
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-ink-700">
              <p><span className="font-semibold">Employee:</span> {verifyTarget.fullName} ({verifyTarget.employeeCode})</p>
              <p><span className="font-semibold">Type:</span> {DOC_TYPES.find((t) => t.key === verifyTarget.documentType)?.label}</p>
              <p className="mt-1">
                <a
                  href={verifyTarget.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-brand-600 underline"
                >
                  Open attached document in new window &nearr;
                </a>
              </p>
            </div>

            <Field label="Verification Remarks">
              <textarea
                className="input"
                rows={3}
                placeholder="Enter remarks or approval notes…"
                value={verifyNotes}
                onChange={(e) => setVerifyNotes(e.target.value)}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setVerifyTarget(null)}
                disabled={verifying}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={verifying}
                onClick={() => handleVerify(verifyTarget, 'rejected')}
              >
                Reject Document
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={verifying}
                onClick={() => handleVerify(verifyTarget, 'verified')}
              >
                Approve & Mark Verified
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
