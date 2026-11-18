import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { Card, Badge, Modal } from './ui';
import { Icon } from './icons';
import { formatDateTime } from '../lib/format';
import { cx } from '../lib/format';

interface RegisteredDevice {
  id: number;
  deviceType: string;
  browser: string;
  os: string;
  userAgent: string;
  isInstalled: boolean;
  isStandalone: boolean;
  pushSubscribed: boolean;
  lastActiveAt: string;
  createdAt: string;
  current: boolean;
}

export function DeviceManager() {
  const { user } = useAuth();
  const toast = useToast();
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState<number | null>(null);

  const loadDevices = async () => {
    try {
      const result = await api.get<{ devices: RegisteredDevice[] }>('/devices');
      setDevices(result.devices);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  const handleRevoke = async (deviceId: number) => {
    setRevokingId(deviceId);
    try {
      await api.post(`/devices/${deviceId}/revoke`);
      toast.success('Device access revoked');
      await loadDevices();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRevokingId(null);
      setShowRevokeConfirm(null);
    }
  };

  const handleRevokeAllOthers = async () => {
    const currentDevice = devices.find(d => d.current);
    const otherDevices = devices.filter(d => !d.current && d.id !== currentDevice?.id);
    
    for (const device of otherDevices) {
      try {
        await api.post(`/devices/${device.id}/revoke`);
      } catch {
        // Continue with others
      }
    }
    toast.success('All other devices revoked');
    await loadDevices();
  };

  const getDeviceIcon = (deviceType: string, browser: string) => {
    if (deviceType === 'windows') return 'monitor';
    if (deviceType === 'android') return 'smartphone';
    if (deviceType === 'iphone') return 'smartphone';
    if (deviceType === 'ipad') return 'tablet';
    if (deviceType === 'mac') return 'laptop';
    return 'cpu';
  };

  const getBrowserIcon = (browser: string) => {
    switch (browser) {
      case 'chrome': return 'chrome';
      case 'edge': return 'microsoftEdge';
      case 'firefox': return 'firefox';
      case 'safari': return 'safari';
      case 'opera': return 'opera';
      default: return 'globe';
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="p-4">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-3 h-16">
                <div className="w-12 h-12 rounded-xl bg-ink-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-ink-100 rounded" />
                  <div className="h-3 w-1/2 bg-ink-100 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="px-4 py-3 border-b border-ink-100">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-ink-900">Registered Devices</h3>
          {devices.filter(d => !d.current).length > 0 && (
            <button 
              type="button"
              className="btn-secondary btn-sm" 
              onClick={handleRevokeAllOthers}
            >
              <Icon name="logOut" size={14} />
              Revoke All Others
            </button>
          )}
        </div>
      </div>
      
      <div className="divide-y divide-ink-100">
        {devices.length === 0 ? (
          <div className="p-6 text-center">
            <Icon name="cpu" size={32} className="mx-auto text-ink-300" />
            <p className="mt-2 text-sm text-ink-500">No registered devices</p>
          </div>
        ) : (
          devices.map(device => (
            <div key={device.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={cx('w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0', 
                  device.current ? 'bg-brand-100' : 'bg-ink-100')}>
                  <Icon name={getDeviceIcon(device.deviceType, device.browser)} 
                    size={20} 
                    className={cx(device.current ? 'text-brand-600' : 'text-ink-500')} 
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={cx('font-medium text-ink-900 truncate', device.current && 'text-brand-700')}>
                      {getDeviceDisplayName(device)}
                    </p>
                    {device.current && (
                      <Badge tone="brand" className="text-xs px-2 py-0.5">Current</Badge>
                    )}
                    {device.isInstalled && (
                      <Badge tone="success" className="text-xs px-2 py-0.5">Installed</Badge>
                    )}
                    {device.isStandalone && (
                      <Badge tone="neutral" className="text-xs px-2 py-0.5">Standalone</Badge>
                    )}
                    {device.pushSubscribed && (
                      <Badge tone="brand" className="text-xs px-2 py-0.5">
                        <Icon name="bell" size={10} className="inline" /> Push
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-500">
                    <span className="flex items-center gap-1">
                      <Icon name={getBrowserIcon(device.browser)} size={12} />
                      {device.browser.charAt(0).toUpperCase() + device.browser.slice(1)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Icon name="cpu" size={12} />
                      {device.os}
                    </span>
                    <span>Last active: {formatDateTime(device.lastActiveAt)}</span>
                  </div>
                </div>
              </div>
              
              {!device.current && (
                <button
                  type="button"
                  className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                  onClick={() => setShowRevokeConfirm(device.id)}
                  disabled={revokingId === device.id}
                >
                  {revokingId === device.id ? (
                    <span className="flex items-center gap-1">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                      Revoking...
                    </span>
                  ) : (
                    <>
                      <Icon name="logOut" size={14} />
                      Revoke
                    </>
                  )}
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Revoke Confirmation Modal */}
      {showRevokeConfirm && (
        <Modal
          open={true}
          onClose={() => setShowRevokeConfirm(null)}
          title="Revoke Device Access"
          description="This will sign out the selected device and remove its push subscription. The employee will need to log in again on that device."
        >
          <div className="space-y-3">
            <p className="text-sm text-ink-600">
              Are you sure you want to revoke access for this device?
            </p>
            <div className="rounded-lg bg-ink-50 p-3 text-sm">
              <p className="font-medium text-ink-900">
                {devices.find(d => d.id === showRevokeConfirm)?.os || 'Unknown'} · 
                {devices.find(d => d.id === showRevokeConfirm)?.browser || 'Unknown'}
              </p>
              <p className="text-ink-500">
                Last active: {devices.find(d => d.id === showRevokeConfirm)?.lastActiveAt || 'Unknown'}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowRevokeConfirm(null)}>
                Cancel
              </button>
              <button 
                type="button"
                className="btn-danger" 
                onClick={() => handleRevoke(showRevokeConfirm!)}
                disabled={revokingId === showRevokeConfirm}
              >
                {revokingId === showRevokeConfirm ? 'Revoking...' : 'Revoke Access'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function getDeviceDisplayName(device: RegisteredDevice): string {
  const typeNames: Record<string, string> = {
    windows: 'Windows Desktop',
    android: 'Android',
    iphone: 'iPhone',
    ipad: 'iPad',
    mac: 'macOS',
    linux: 'Linux',
  };
  return typeNames[device.deviceType] || device.deviceType;
}