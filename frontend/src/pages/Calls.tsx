import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Avatar, Badge, Card, EmptyState, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatDateTime, formatTime } from '../lib/format';
import { CallProvider, useCall } from '../components/CallInterface';

interface CallRecord {
  id: number;
  callId: string;
  type: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'missed' | 'declined' | 'busy' | 'failed';
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

export default function CallsPage() {
  useDocumentTitle('Calls');
  const { user } = useAuth();
  const toast = useToast();
  const { call } = useCall();

  const [tab, setTab] = useState<'recent' | 'missed'>('recent');
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<any[]>([]);
  const [callModalOpen, setCallModalOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<any>(null);
  const [callType, setCallType] = useState<'audio' | 'video'>('video');

  const loadCalls = async () => {
    try {
      const result = await api.get<{ calls: CallRecord[] }>('/api/calls/history');
      setCalls(result.calls);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  const loadContacts = async () => {
    try {
      const result = await api.get<{ contacts: any[] }>('/api/chat/contacts');
      setContacts(result.contacts);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    loadCalls();
    loadContacts();
  }, []);

  const filteredCalls = calls.filter(call => {
    if (tab === 'missed') return call.status === 'missed';
    return true;
  });

  const handleCall = async (contact: any, type: 'audio' | 'video') => {
    try {
      await call(contact.id, type);
      setCallModalOpen(false);
    } catch {
      // Error handled in call hook
    }
  };

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };

  return (
    <CallProvider>
      <div className="space-y-5">
        <PageHeader
          title="Calls"
          description="Make and receive audio/video calls with colleagues. Call history is saved automatically."
          actions={
            <button type="button" className="btn-primary" onClick={() => { setCallType('video'); setCallModalOpen(true); }}>
              <Icon name="video" size={15} /> Video Call
            </button>
          }
        />

        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          {/* Call History */}
          <Card>
            <div className="px-4 pt-2">
              <Tabs
                tabs={[
                  { value: 'recent', label: 'Recent' },
                  { value: 'missed', label: 'Missed' },
                ]}
                value={tab}
                onChange={(value) => setTab(value as 'recent' | 'missed')}
              />
            </div>

            {!loading ? filteredCalls.length === 0 ? (
              <EmptyState 
                title={tab === 'missed' ? 'No missed calls' : 'No call history'} 
                description={tab === 'missed' ? 'Missed calls will appear here' : 'Your recent calls will appear here'} 
              />
            ) : (
              <div className="divide-y divide-ink-100">
                {filteredCalls.map(callRecord => (
                  <button
                    key={callRecord.id}
                    type="button"
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50 transition-colors"
                    onClick={() => handleCall(callRecord.participant, 'video')}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar 
                        name={callRecord.participant.name} 
                        src={callRecord.participant.photoUrl} 
                        size={44} 
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="truncate font-medium text-ink-900">{callRecord.participant.name}</p>
                          <Badge 
                            tone={
                              callRecord.status === 'missed' ? 'danger' :
                              callRecord.status === 'declined' ? 'warning' :
                              callRecord.status === 'completed' ? 'success' : 'neutral'
                            }
                            className="text-xs px-2 py-0.5"
                          >
                            {callRecord.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
                          </Badge>
                          <Badge 
                            tone={
                              callRecord.type === 'video' ? 'brand' : 'neutral'
                            }
                            className="text-xs px-2 py-0.5"
                          >
                            <Icon name={callRecord.type === 'video' ? 'video' : 'phone'} size={10} className="inline" />
                            {callRecord.type}
                          </Badge>
                          {callRecord.status === 'missed' && !callRecord.read && (
                            <Badge tone="danger" className="text-xs px-2 py-0.5">Missed</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-ink-500 flex items-center gap-2">
                          <span>{callRecord.participant.employeeCode}</span>
                          {callRecord.participant.department && (
                            <>· <span>{callRecord.participant.department}</span></>
                          )}
                          {callRecord.participant.designation && (
                            <>· <span>{callRecord.participant.designation}</span></>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <p className="text-sm font-mono text-ink-700">
                        {callRecord.duration > 0 ? formatDuration(callRecord.duration) : '—'}
                      </p>
                      <p className="text-xs text-ink-400">{formatDateTime(callRecord.startedAt)}</p>
                      <div className="flex gap-1">
                        <button type="button"
                          className="btn-secondary btn-sm h-8 px-2" 
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCall(callRecord.participant, 'audio'); }}
                          title="Audio call"
                        >
                          <Icon name="phone" size={14} />
                        </button>
                        <button type="button"
                          className="btn-secondary btn-sm h-8 px-2" 
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCall(callRecord.participant, 'video'); }}
                          title="Video call"
                        >
                          <Icon name="video" size={14} />
                        </button>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-4"><Skeleton lines={5} /></div>
            )}
          </Card>

          {/* Quick Dial / Contacts */}
          <Card>
            <div className="px-4 py-3 border-b border-ink-100">
              <h3 className="font-semibold text-ink-900">Quick Dial</h3>
            </div>
            <div className="p-4">
              {contacts.length === 0 ? (
                <EmptyState compact title="No contacts" description="Start a chat to see colleagues here" />
              ) : (
                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                  {contacts.map(contact => (
                    <button
                      key={contact.id}
                      type="button"
                      className="flex items-center justify-between w-full px-3 py-2 rounded-lg hover:bg-ink-50 transition-colors"
                      onClick={() => { setSelectedContact(contact); setCallModalOpen(true); }}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={contact.full_name} size={40} online={false} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink-900">{contact.full_name}</p>
                          <p className="truncate text-xs text-ink-500 flex items-center gap-1">
                            {contact.designation_title && <span>{contact.designation_title}</span>}
                            {contact.department_name && <>· <span>{contact.department_name}</span></>}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <button type="button" className="btn-secondary btn-sm h-8 w-8 p-0" onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCall(contact, 'audio'); }}>
                          <Icon name="phone" size={16} />
                        </button>
                        <button type="button" className="btn-primary btn-sm h-8 w-8 p-0" onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCall(contact, 'video'); }}>
                          <Icon name="video" size={16} />
                        </button>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* New Call Modal */}
        <Modal
          open={callModalOpen}
          onClose={() => { setCallModalOpen(false); setSelectedContact(null); }}
          title={selectedContact ? `Call ${selectedContact.full_name}` : 'New Call'}
          footer={
            selectedContact ? (
              <>
                <button type="button" className="btn-secondary" onClick={() => { setCallType('audio'); handleCall(selectedContact, 'audio'); }}>
                  <Icon name="phone" size={15} /> Audio Call
                </button>
                <button type="button" className="btn-primary" onClick={() => { setCallType('video'); handleCall(selectedContact, 'video'); }}>
                  <Icon name="video" size={15} /> Video Call
                </button>
              </>
            ) : null
          }
        >
          {!selectedContact ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <button type="button"
                  className={cx('h-24 flex flex-col items-center justify-center gap-2', callType === 'audio' ? 'border-2 border-brand-500 bg-brand-50' : 'border border-ink-200')}
                  onClick={() => setCallType('audio')}
                >
                  <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                    <Icon name="phone" size={28} className="text-green-600" />
                  </div>
                  <span className="font-medium">Audio Call</span>
                  <span className="text-xs text-ink-500">Voice only</span>
                </button>
                <button type="button"
                  className={cx('h-24 flex flex-col items-center justify-center gap-2', callType === 'video' ? 'border-2 border-brand-500 bg-brand-50' : 'border border-ink-200')}
                  onClick={() => setCallType('video')}
                >
                  <div className="w-14 h-14 rounded-full bg-brand-100 flex items-center justify-center">
                    <Icon name="video" size={28} className="text-brand-600" />
                  </div>
                  <span className="font-medium">Video Call</span>
                  <span className="text-xs text-ink-500">With camera</span>
                </button>
              </div>
              <p className="text-sm text-ink-500 text-center">Select call type, then choose a contact</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-3 rounded-xl bg-ink-50">
                <Avatar name={selectedContact.full_name} size={56} />
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">{selectedContact.full_name}</p>
                  <p className="text-sm text-ink-500 flex flex-wrap gap-2">
                    {selectedContact.designation_title && <span>{selectedContact.designation_title}</span>}
                    {selectedContact.department_name && <>· <span>{selectedContact.department_name}</span></>}
                  </p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <button type="button"
                  className={cx('h-20 flex flex-col items-center justify-center gap-2', callType === 'audio' ? 'border-2 border-green-500 bg-green-50' : 'border border-ink-200')}
                  onClick={() => setCallType('audio')}
                >
                  <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                    <Icon name="phone" size={24} className="text-green-600" />
                  </div>
                  <span>Audio Call</span>
                </button>
                <button type="button"
                  className={cx('h-20 flex flex-col items-center justify-center gap-2', callType === 'video' ? 'border-2 border-brand-500 bg-brand-50' : 'border border-ink-200')}
                  onClick={() => setCallType('video')}
                >
                  <div className="w-12 h-12 rounded-full bg-brand-100 flex items-center justify-center">
                    <Icon name="video" size={24} className="text-brand-600" />
                  </div>
                  <span>Video Call</span>
                </button>
              </div>
              <p className="text-xs text-ink-500 text-center">Click to start call</p>
            </div>
          )}
        </Modal>
      </div>
    </CallProvider>
  );
}