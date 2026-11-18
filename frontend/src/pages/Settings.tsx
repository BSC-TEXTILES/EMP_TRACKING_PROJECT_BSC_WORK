import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Card, SectionHeader, Badge, Modal, Field, Switch } from '../components/ui';
import { Icon } from '../components/icons';
import { DeviceManager } from '../components/DeviceManager';
import { cx } from '../lib/format';
import { openInstallPopup, runningInstalled } from '../lib/installPrompt';
import { setThemePreference, themePreference, type ThemePreference } from '../lib/theme';

interface UserPreferences {
  emailNotifications: boolean;
  pushNotifications: boolean;
  desktopNotifications: boolean;
  callNotifications: boolean;
  meetingReminders: boolean;
  taskNotifications: boolean;
  theme: 'light' | 'dark' | 'system';
  language: string;
  timezone: string;
}

export default function Settings() {
  useDocumentTitle('Settings');
  const { user } = useAuth();
  const toast = useToast();

  const [preferences, setPreferences] = useState<UserPreferences>({
    emailNotifications: true,
    pushNotifications: true,
    desktopNotifications: true,
    callNotifications: true,
    meetingReminders: true,
    taskNotifications: true,
    theme: themePreference(),
    language: 'en',
    timezone: 'Asia/Kolkata',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showInstallInstructions, setShowInstallInstructions] = useState(false);

  const loadPreferences = async () => {
    try {
      const result = await api.get<{ preferences: Partial<UserPreferences> }>('/me/preferences');
      // The theme is per device (this browser / this phone), not per account.
      setPreferences(prev => ({ ...prev, ...result.preferences, theme: themePreference() }));
    } catch {
      // Ignore - use defaults
    } finally {
      setLoading(false);
    }
  };

  const savePreferences = async () => {
    setSaving(true);
    try {
      await api.post('/me/preferences', preferences);
      toast.success('Settings saved');
      
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    loadPreferences();
  }, []);

  const handlePreferenceChange = (key: keyof UserPreferences, value: any) => {
    setPreferences(prev => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-ink-900">Settings</h1>
            <p className="text-sm text-ink-500">Manage your preferences and devices</p>
          </div>
        </div>
        <Card><div className="p-6"><div className="animate-pulse space-y-4">{[1,2,3,4].map(i => <div key={i} className="h-12 bg-ink-100 rounded-lg" />)}</div></div></Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Settings</h1>
          <p className="text-sm text-ink-500">Manage your preferences, devices, and installation options</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => setShowInstallInstructions(true)}>
          <Icon name="helpCircle" size={15} /> Installation Help
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        {/* Main Settings */}
        <div className="space-y-5">
          {/* Notifications */}
          <Card>
            <SectionHeader title="Notifications" description="Choose how you want to be notified" />
            <div className="px-4 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink-900">Email Notifications</p>
                  <p className="text-sm text-ink-500">Receive notifications via email</p>
                </div>
                <Switch
                  checked={preferences.emailNotifications}
                  onChange={(checked) => handlePreferenceChange('emailNotifications', checked)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink-900">Push Notifications</p>
                  <p className="text-sm text-ink-500">Receive push notifications on installed app</p>
                </div>
                <Switch
                  checked={preferences.pushNotifications}
                  onChange={(checked) => handlePreferenceChange('pushNotifications', checked)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink-900">Desktop Notifications</p>
                  <p className="text-sm text-ink-500">Show browser notifications when app is open</p>
                </div>
                <Switch
                  checked={preferences.desktopNotifications}
                  onChange={(checked) => handlePreferenceChange('desktopNotifications', checked)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink-900">Call Notifications</p>
                  <p className="text-sm text-ink-500">Alert for incoming audio/video calls</p>
                </div>
                <Switch
                  checked={preferences.callNotifications}
                  onChange={(checked) => handlePreferenceChange('callNotifications', checked)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink-900">Meeting Reminders</p>
                  <p className="text-sm text-ink-500">Get reminded before scheduled meetings</p>
                </div>
                <Switch
                  checked={preferences.meetingReminders}
                  onChange={(checked) => handlePreferenceChange('meetingReminders', checked)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink-900">Task Notifications</p>
                  <p className="text-sm text-ink-500">Notifications for task assignments and updates</p>
                </div>
                <Switch
                  checked={preferences.taskNotifications}
                  onChange={(checked) => handlePreferenceChange('taskNotifications', checked)}
                />
              </div>
            </div>
          </Card>

          {/* Appearance */}
          <Card>
            <SectionHeader title="Appearance" description="Customize how the app looks" />
            <div className="px-4 py-4 space-y-4">
              <Field label="Theme">
                <select
                  className="input"
                  value={preferences.theme}
                  onChange={(e) => {
                    // Applies at once on this device; no need to press Save.
                    setThemePreference(e.target.value as ThemePreference);
                    handlePreferenceChange('theme', e.target.value as ThemePreference);
                  }}
                >
                  <option value="system">Same as this device</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </Field>
              <Field label="Language">
                <select className="input" value={preferences.language} onChange={(e) => handlePreferenceChange('language', e.target.value)}>
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                  <option value="ta">Tamil</option>
                </select>
              </Field>
              <Field label="Timezone">
                <select className="input" value={preferences.timezone} onChange={(e) => handlePreferenceChange('timezone', e.target.value)}>
                  <option value="Asia/Kolkata">India Standard Time (GMT+5:30)</option>
                  <option value="UTC">UTC</option>
                  <option value="America/New_York">Eastern Time (GMT-5)</option>
                  <option value="America/Los_Angeles">Pacific Time (GMT-8)</option>
                  <option value="Europe/London">London (GMT+0)</option>
                  <option value="Asia/Dubai">Dubai (GMT+4)</option>
                  <option value="Asia/Singapore">Singapore (GMT+8)</option>
                </select>
              </Field>
            </div>
          </Card>

          {/* Data & Privacy */}
          <Card>
            <SectionHeader title="Data & Privacy" description="Manage your data" />
            <div className="px-4 py-4 space-y-3">
              <button type="button" className="btn-secondary w-full sm:w-auto" onClick={async () => {
                try {
                  await api.post('/me/export-data');
                  toast.success('Data export started. You will receive an email when ready.');
                } catch (caught) { toast.error(errorMessage(caught)); }
              }}>
                <Icon name="download" size={15} /> Export My Data
              </button>
              <button type="button" className="btn-ghost text-red-600 hover:bg-red-50 w-full sm:w-auto" onClick={() => {
                if (window.confirm('This will delete all your personal data. This action cannot be undone.')) {
                  // Implementation would go here
                  toast.info('Data deletion requested. Contact admin for completion.');
                }
              }}>
                <Icon name="trash" size={15} /> Delete My Data
              </button>
            </div>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          {/* Device Management */}
          <DeviceManager />

          {/* Installation Status */}
          <Card>
            <SectionHeader title="App Installation" description="Install for faster access and notifications" />
            <div className="px-4 py-4 space-y-3">
              <div className="rounded-lg bg-brand-50 p-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-brand-100 flex items-center justify-center">
                    <Icon name="downloadCloud" size={16} className="text-brand-600" />
                  </div>
                  <div>
                    <p className="font-medium text-brand-900">BSC Textiles Workforce</p>
                    <p className="text-sm text-brand-700">Progressive Web App</p>
                  </div>
                </div>
                <p className="mt-2 text-sm text-brand-700">
                  Install to get native app experience with offline support, push notifications, and home screen access.
                </p>
              </div>
              {runningInstalled() ? (
                <p className="rounded-lg bg-emerald-50 p-2 text-center text-sm text-emerald-700">You are using the installed app.</p>
              ) : (
                <button type="button" className="btn-primary w-full" onClick={openInstallPopup}>
                  <Icon name="download" size={15} /> Install app
                </button>
              )}
              <button type="button" className="btn-ghost w-full" onClick={() => setShowInstallInstructions(true)}>
                <Icon name="helpCircle" size={15} /> Installation instructions
              </button>
              <button type="button" className="btn-secondary w-full" onClick={() => {
                if ('serviceWorker' in navigator) {
                  navigator.serviceWorker.getRegistrations().then(regs => {
                    regs.forEach(reg => reg.unregister());
                  });
                  caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
                  toast.success('App data cleared. Reload to reinstall.');
                }
              }}>
                <Icon name="refreshCw" size={15} /> Clear App Data & Reinstall
              </button>
              <p className="text-xs text-ink-400 text-center">Version: 1.0.0</p>
            </div>
          </Card>

          {/* Quick Actions */}
          <Card>
            <SectionHeader title="Quick Actions" />
            <div className="px-4 py-4 space-y-2">
              <button type="button" className="btn-secondary w-full justify-start" onClick={() => savePreferences()}>
                <Icon name="save" size={15} /> Save Preferences
              </button>
              <button type="button" className="btn-ghost w-full justify-start" onClick={() => loadPreferences()}>
                <Icon name="refreshCw" size={15} /> Reset to Defaults
              </button>
              <button type="button" className="btn-ghost w-full justify-start text-blue-600 hover:bg-blue-50" onClick={() => {
                window.open('/api/push/test', '_blank');
              }}>
                <Icon name="bell" size={15} /> Test Push Notification
              </button>
            </div>
          </Card>
        </div>
      </div>

      {/* Installation Instructions Modal */}
      <Modal
        open={showInstallInstructions}
        onClose={() => setShowInstallInstructions(false)}
        title="Installation Instructions"
        size="lg"
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-sm font-medium text-brand-800">BSC Textiles Workforce PWA</p>
            <p className="mt-1 text-sm text-brand-700">
              Follow the instructions below for your device to install the app.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-ink-200 p-4">
              <h4 className="font-medium text-ink-900 flex items-center gap-2">
                <Icon name="monitor" size={18} className="text-brand-600" />
                Windows (Chrome / Edge)
              </h4>
              <ol className="mt-3 space-y-2 text-sm text-ink-600 list-decimal list-inside">
                <li>Open this website in Chrome or Microsoft Edge</li>
                <li>Click the <strong>Install</strong> icon in the address bar (right side)</li>
                <li>Or click ⋮ menu → "Install BSC Textiles Workforce"</li>
                <li>Confirm installation in the dialog</li>
                <li>The app appears in Start Menu and can be pinned to Taskbar</li>
              </ol>
            </div>

            <div className="rounded-lg border border-ink-200 p-4">
              <h4 className="font-medium text-ink-900 flex items-center gap-2">
                <Icon name="smartphone" size={18} className="text-green-600" />
                Android (Chrome)
              </h4>
              <ol className="mt-3 space-y-2 text-sm text-ink-600 list-decimal list-inside">
                <li>Open this website in Chrome</li>
                <li>Tap the <strong>Install</strong> button in the banner</li>
                <li>Or tap ⋮ menu → "Add to Home screen" / "Install app"</li>
                <li>Confirm the installation prompt</li>
                <li>App icon appears on your home screen</li>
              </ol>
            </div>

            <div className="rounded-lg border border-ink-200 p-4">
              <h4 className="font-medium text-ink-900 flex items-center gap-2">
                <Icon name="smartphone" size={18} className="text-blue-600" />
                iPhone / iPad (Safari)
              </h4>
              <ol className="mt-3 space-y-2 text-sm text-ink-600 list-decimal list-inside">
                <li>Open this website in Safari</li>
                <li>Tap the <strong>Share</strong> button (□↑) at bottom</li>
                <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
                <li>Tap <strong>"Add"</strong> in top right</li>
                <li>App appears on home screen like a native app</li>
              </ol>
            </div>

            <div className="rounded-lg border border-ink-200 p-4">
              <h4 className="font-medium text-ink-900 flex items-center gap-2">
                <Icon name="laptop" size={18} className="text-purple-600" />
                macOS (Chrome / Edge)
              </h4>
              <ol className="mt-3 space-y-2 text-sm text-ink-600 list-decimal list-inside">
                <li>Open in Chrome or Edge</li>
                <li>Click the <strong>Install</strong> icon in address bar</li>
                <li>Or ⋮ menu → "Install BSC Textiles Workforce"</li>
                <li>App appears in Applications folder and Launchpad</li>
              </ol>
            </div>
          </div>

          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
            <h4 className="font-medium text-amber-800 flex items-center gap-1">
              <Icon name="alertTriangle" size={16} /> Important Notes
            </h4>
            <ul className="mt-2 space-y-1 text-sm text-amber-700 list-disc list-inside">
              <li>Push notifications require the app to be installed on home screen (iOS 16.4+)</li>
              <li>Incoming call alerts work best when app is installed</li>
              <li>Offline mode caches recent data for viewing without internet</li>
              <li>Use the same login credentials as the web version</li>
            </ul>
          </div>

          <div className="flex justify-end pt-2">
            <button type="button" className="btn-primary" onClick={() => setShowInstallInstructions(false)}>
              Got It
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}