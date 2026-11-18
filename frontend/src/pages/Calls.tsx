import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime, useSocketEvent } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Avatar, Badge, Card, EmptyState, Field, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime } from '../lib/format';
import { useCall, type CallPeer } from '../components/CallInterface';

interface CallRecord {
  id: number;
  callId: string;
  type: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'missed' | 'declined' | 'busy' | 'failed' | 'ringing' | 'active';
  duration: number;
  participant: {
    id: number;
    name: string;
    photoUrl: string | null;
    employeeCode: string;
    department: string | null;
    designation: string | null;
  };
  startedAt: string;
  endedAt: string | null;
  read: boolean;
}

interface Contact {
  id: number;
  employeeCode: string;
  fullName: string;
  photoUrl: string | null;
  departmentName: string | null;
  designationTitle: string | null;
  locationId?: number | null;
  locationName?: string | null;
  locationCode?: string | null;
  managerName?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  missed: 'Missed',
  declined: 'Declined',
  busy: 'Busy',
  failed: 'Failed',
  ringing: 'Ringing',
  active: 'In progress',
};

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'completed' || status === 'active') return 'success';
  if (status === 'missed' || status === 'failed') return 'danger';
  if (status === 'declined' || status === 'busy') return 'warning';
  return 'neutral';
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toPeer(record: CallRecord['participant']): CallPeer {
  return {
    employeeId: record.id,
    employeeCode: record.employeeCode,
    name: record.name,
    photoUrl: record.photoUrl,
    department: record.department,
    designation: record.designation,
  };
}

export default function CallsPage() {
  useDocumentTitle('Calls');
  const { user } = useAuth();
  const toast = useToast();
  const { call, active, historyVersion } = useCall();
  const { onlineIds, syncVersion } = useRealtime();

  const [tab, setTab] = useState<'recent' | 'missed'>('recent');
  const [records, setRecords] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [startingId, setStartingId] = useState<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const result = await api.get<{ calls: CallRecord[] }>('/calls/history');
      setRecords(result.calls);
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadContacts = useCallback(async () => {
    try {
      const result = await api.get<{ contacts: Contact[] }>('/calls/contacts');
      setContacts(result.contacts);
    } catch {
      /* The picker shows an empty state; history still works. */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadContacts();
  }, [loadHistory, loadContacts]);

  // Realtime, reconnects and call completion all invalidate the history list.
  useEffect(() => {
    if (historyVersion > 0) void loadHistory();
  }, [historyVersion, loadHistory]);

  useEffect(() => {
    if (syncVersion > 0) void loadHistory();
  }, [syncVersion, loadHistory]);

  useSocketEvent('call:ended', () => void loadHistory());
  useSocketEvent('call:missed', () => void loadHistory());
  useSocketEvent('call:rejected', () => void loadHistory());
  useSocketEvent('call:accepted', () => void loadHistory());

  const filtered = useMemo(
    () => (tab === 'missed' ? records.filter((record) => record.status === 'missed' || record.status === 'declined') : records),
    [records, tab],
  );

  const searchedContacts = useMemo(() => {
    let result = contacts;
    if (branchFilter !== 'all') {
      result = result.filter((c) => (c.locationCode || 'HUB').toUpperCase() === branchFilter.toUpperCase());
    }
    const query = contactSearch.trim().toLowerCase();
    if (!query) return result;
    return result.filter((contact) =>
      [contact.fullName, contact.employeeCode, contact.departmentName, contact.designationTitle, contact.locationName, contact.managerName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [branchFilter, contactSearch, contacts]);

  const startCall = useCallback(
    async (employeeId: number, type: 'audio' | 'video', peer?: CallPeer) => {
      if (active) {
        toast.info('Finish the current call before starting another.');
        return;
      }
      setStartingId(employeeId);
      try {
        await call(employeeId, type, peer);
        setPickerOpen(false);
      } catch (caught) {
        toast.error(errorMessage(caught));
      } finally {
        setStartingId(null);
      }
    },
    [active, call, toast],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Calls"
        description="In-app audio and video calls with colleagues. Every call is recorded in your history."
        actions={
          <button type="button" className="btn-primary" onClick={() => setPickerOpen(true)}>
            <Icon name="video" size={15} /> New call
          </button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card>
          <div className="border-b border-ink-100 px-4 pt-2">
            <Tabs
              tabs={[
                { value: 'recent', label: 'Recent' },
                { value: 'missed', label: 'Missed' },
              ]}
              value={tab}
              onChange={(value) => setTab(value as 'recent' | 'missed')}
            />
          </div>

          {loading ? (
            <div className="p-4">
              <Skeleton lines={6} />
            </div>
          ) : loadError ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-red-600">{loadError}</p>
              <button type="button" className="btn-secondary mt-3" onClick={() => void loadHistory()}>
                <Icon name="refresh" size={15} /> Try again
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={tab === 'missed' ? 'No missed calls' : 'No call history yet'}
              description={
                tab === 'missed'
                  ? 'Calls you missed or declined will appear here.'
                  : 'Start an audio or video call from quick dial.'
              }
            />
          ) : (
            <div className="divide-y divide-ink-100">
              {filtered.map((record) => (
                <div
                  key={record.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-ink-50"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => void startCall(record.participant.id, record.type, toPeer(record.participant))}
                    title={`Call ${record.participant.name} back`}
                  >
                    <div className="relative">
                      <Avatar name={record.participant.name} src={record.participant.photoUrl} size={44} />
                      <span
                        className={cx(
                          'absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-white',
                          record.direction === 'incoming' ? 'bg-sky-500 text-white' : 'bg-emerald-500 text-white',
                        )}
                        aria-hidden="true"
                      >
                        <Icon name={record.type === 'video' ? 'video' : 'phone'} size={10} />
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium text-ink-900">{record.participant.name}</p>
                        <Badge tone={statusTone(record.status)} className="px-2 py-0.5 text-xs">
                          {STATUS_LABEL[record.status] ?? record.status}
                        </Badge>
                        <span className="text-[11px] text-ink-400">
                          {record.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
                        </span>
                        {record.status === 'missed' && !record.read && (
                          <span className="h-2 w-2 rounded-full bg-red-500" aria-label="Unread missed call" />
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-ink-500">
                        {[record.participant.employeeCode, record.participant.designation, record.participant.department]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <p className="font-mono text-sm text-ink-700">{formatDuration(record.duration)}</p>
                      <p className="text-xs text-ink-400">{formatDateTime(record.startedAt)}</p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="btn-secondary btn-sm h-8 w-8 p-0"
                        onClick={() => void startCall(record.participant.id, 'audio', toPeer(record.participant))}
                        disabled={startingId === record.participant.id}
                        aria-label={`Audio call ${record.participant.name}`}
                      >
                        <Icon name="phone" size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm h-8 w-8 p-0"
                        onClick={() => void startCall(record.participant.id, 'video', toPeer(record.participant))}
                        disabled={startingId === record.participant.id}
                        aria-label={`Video call ${record.participant.name}`}
                      >
                        <Icon name="video" size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="border-b border-ink-100 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-ink-900">Quick dial & Directory</h3>
                <p className="mt-0.5 text-xs text-ink-500">Live colleagues across store branches</p>
              </div>
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="input py-1 px-2 text-xs w-auto font-medium"
              >
                <option value="all">All Branches</option>
                <option value="BEL">BEL – Belagavi</option>
                <option value="DAV">DAV – Davanagere</option>
                <option value="SHI">SHI – Shivamogga</option>
                <option value="HUB">HUB/HQ – Head Office</option>
              </select>
            </div>
          </div>
          <div className="p-3">
            {searchedContacts.length === 0 ? (
              <EmptyState compact title="No contacts found" description="No active colleagues in this branch filter." />
            ) : (
              <div className="max-h-[520px] space-y-1.5 overflow-y-auto">
                {searchedContacts.slice(0, 40).map((contact) => (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between gap-2 rounded-lg p-2 transition-colors hover:bg-ink-50 border border-transparent hover:border-ink-200"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar
                        name={contact.fullName}
                        src={contact.photoUrl}
                        size={36}
                        online={onlineIds.includes(contact.id)}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-semibold text-ink-900">{contact.fullName}</p>
                          {contact.locationCode && (
                            <span className="shrink-0 rounded px-1.5 py-0.2 text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                              {contact.locationCode}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-ink-500">
                          {contact.employeeCode}
                          {contact.designationTitle ? ` · ${contact.designationTitle}` : ''}
                        </p>
                        {contact.managerName && (
                          <p className="truncate text-[10px] text-ink-400">
                            Reports to: {contact.managerName}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Link
                        to={`/chat?dm=${contact.id}`}
                        className="btn-secondary btn-sm h-8 w-8 p-0 inline-flex items-center justify-center text-ink-600 hover:text-brand-600"
                        title={`Send message to ${contact.fullName}`}
                      >
                        <Icon name="chat" size={13} />
                      </Link>
                      <button
                        type="button"
                        className="btn-secondary btn-sm h-8 w-8 p-0"
                        onClick={() =>
                          void startCall(contact.id, 'audio', {
                            employeeId: contact.id,
                            employeeCode: contact.employeeCode,
                            name: contact.fullName,
                            photoUrl: contact.photoUrl,
                            department: contact.departmentName,
                            designation: contact.designationTitle,
                          })
                        }
                        disabled={startingId === contact.id}
                        title={`Audio call ${contact.fullName}`}
                        aria-label={`Audio call ${contact.fullName}`}
                      >
                        <Icon name="phone" size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm h-8 w-8 p-0"
                        onClick={() =>
                          void startCall(contact.id, 'video', {
                            employeeId: contact.id,
                            employeeCode: contact.employeeCode,
                            name: contact.fullName,
                            photoUrl: contact.photoUrl,
                            department: contact.departmentName,
                            designation: contact.designationTitle,
                          })
                        }
                        disabled={startingId === contact.id}
                        title={`Video call ${contact.fullName}`}
                        aria-label={`Video call ${contact.fullName}`}
                      >
                        <Icon name="video" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Start a call"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setPickerOpen(false)}>
              Cancel
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Search colleagues">
            <input
              type="search"
              className="input"
              placeholder="Name, employee ID, department…"
              value={contactSearch}
              onChange={(event) => setContactSearch(event.target.value)}
              autoFocus
            />
          </Field>
          {searchedContacts.length === 0 ? (
            <EmptyState compact title="No colleagues found" description="Try a different name or employee ID." />
          ) : (
            <div className="max-h-[340px] space-y-1 overflow-y-auto">
              {searchedContacts.map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      name={contact.fullName}
                      src={contact.photoUrl}
                      size={38}
                      online={onlineIds.includes(contact.id)}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-semibold text-ink-900">{contact.fullName}</p>
                        {contact.locationCode && (
                          <span className="shrink-0 rounded px-1.5 py-0.2 text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                            {contact.locationCode}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-ink-500">
                        {[contact.employeeCode, contact.designationTitle, contact.departmentName]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() =>
                        void startCall(contact.id, 'audio', {
                          employeeId: contact.id,
                          employeeCode: contact.employeeCode,
                          name: contact.fullName,
                          photoUrl: contact.photoUrl,
                          department: contact.departmentName,
                          designation: contact.designationTitle,
                        })
                      }
                      disabled={startingId === contact.id}
                    >
                      <Icon name="phone" size={14} /> Audio
                    </button>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() =>
                        void startCall(contact.id, 'video', {
                          employeeId: contact.id,
                          employeeCode: contact.employeeCode,
                          name: contact.fullName,
                          photoUrl: contact.photoUrl,
                          department: contact.departmentName,
                          designation: contact.designationTitle,
                        })
                      }
                      disabled={startingId === contact.id}
                    >
                      <Icon name="video" size={14} /> Video
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {user && (
            <p className="text-[11px] text-ink-400">
              Signed in as {user.fullName} · calls use the in-app microphone and camera only.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
