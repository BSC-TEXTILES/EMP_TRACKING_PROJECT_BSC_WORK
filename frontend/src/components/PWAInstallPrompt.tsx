import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import { Modal, Card } from './ui';
import { Icon } from './icons';
import { cx } from '../lib/format';

interface DeviceInfo {
  type: 'windows' | 'android' | 'iphone' | 'ipad' | 'mac' | 'linux' | 'unknown';
  browser: 'chrome' | 'edge' | 'firefox' | 'safari' | 'opera' | 'unknown';
  isInstallable: boolean;
  isStandalone: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  isWindows: boolean;
  isMac: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PWAInstallPrompt() {
  const { user } = useAuth();
  const [showBanner, setShowBanner] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const dismissedRef = useRef(false);
  const installInstructionsRef = useRef<Record<string, string>>({
    windows: `**Windows (Chrome/Edge):**
1. Click the **Install** button in the address bar (right side)
2. Or click the ⋮ menu → "Install BSC Textiles Workforce"
3. Or right-click the app tab → "Install page as app"
4. The app will appear in Start Menu and can be pinned to Taskbar`,
    android: `**Android (Chrome):**
1. Tap the **Install** button in the banner below
2. Or tap ⋮ menu → "Add to Home screen" / "Install app"
3. Confirm the installation prompt
4. The app icon will appear on your home screen`,
    iphone: `**iPhone/iPad (Safari):**
1. Tap the **Share** button (□↑) at the bottom
2. Scroll down and tap **"Add to Home Screen"**
3. Tap **"Add"** in the top right
4. The app will appear on your home screen like a native app`,
    mac: `**macOS (Chrome/Edge):**
1. Click the **Install** button in the address bar
2. Or click ⋮ menu → "Install BSC Textiles Workforce"
3. The app will appear in Applications folder and Launchpad`,
    linux: `**Linux (Chrome/Edge):**
1. Click the **Install** button in the address bar
2. Or click ⋮ menu → "Install BSC Textiles Workforce"
3. The app will appear in your application menu`,
    unknown: `**General Installation:**
1. Look for an **Install** button in your browser's address bar
2. Or check the browser menu (⋮) for "Install" or "Add to Home Screen"
3. Follow your browser's specific installation steps`,
  });

  // Detect device and browser
  useEffect(() => {
    if (!user) return;

    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const isWindows = /Windows NT/.test(ua);
    const isMac = /Macintosh/.test(ua) && !isIOS;
    const isLinux = /Linux/.test(ua) && !isAndroid;

    let browser: DeviceInfo['browser'] = 'unknown';
    if (/Edg\//.test(ua)) browser = 'edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua)) browser = 'chrome';
    else if (/Firefox\//.test(ua)) browser = 'firefox';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'safari';
    else if (/OPR\//.test(ua)) browser = 'opera';

    let type: DeviceInfo['type'] = 'unknown';
    if (isIOS && /iPad/.test(ua)) type = 'ipad';
    else if (isIOS && /iPhone|iPod/.test(ua)) type = 'iphone';
    else if (isAndroid && /Mobile/.test(ua)) type = 'android';
    else if (isAndroid && !/Mobile/.test(ua)) type = 'android'; // tablet
    else if (isWindows) type = 'windows';
    else if (isMac) type = 'mac';
    else if (isLinux) type = 'linux';

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    const info: DeviceInfo = {
      type,
      browser,
      isInstallable: false,
      isStandalone,
      isIOS,
      isAndroid,
      isWindows,
      isMac,
    };

    setDeviceInfo(info);

    // Check if already installed (via localStorage flag or standalone mode)
    const wasInstalled = localStorage.getItem('bsc_pwa_installed') === 'true' || isStandalone;
    if (wasInstalled) {
      setInstalled(true);
      return;
    }

    // Check if user dismissed recently (24 hours)
    const dismissedAt = localStorage.getItem('bsc_pwa_dismissed_at');
    if (dismissedAt && Date.now() - parseInt(dismissedAt) < 24 * 60 * 60 * 1000) {
      dismissedRef.current = true;
      return;
    }

    // Listen for beforeinstallprompt event (Chrome/Edge on Android/Desktop)
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      const promptEvent = e as BeforeInstallPromptEvent;
      setDeferredPrompt(promptEvent);
      setDeviceInfo(prev => prev ? { ...prev, isInstallable: true } : null);
      if (!isStandalone && !dismissedRef.current) {
        setShowBanner(true);
      }
    };

    // Listen for appinstalled event
    const handleAppInstalled = () => {
      setInstalled(true);
      setShowBanner(false);
      localStorage.setItem('bsc_pwa_installed', 'true');
      localStorage.removeItem('bsc_pwa_dismissed_at');
      // Register device as installed
      registerDevice({ ...info, installed: true });
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    // For iOS, show banner if not in standalone mode
    if (isIOS && !isStandalone && !dismissedRef.current) {
      setShowBanner(true);
    }

    // For browsers that don't fire beforeinstallprompt but support installation
    // (Firefox, Safari on desktop), show banner after a delay
    if (!isIOS && !['chrome', 'edge'].includes(browser) && !isStandalone && !dismissedRef.current) {
      const timer = setTimeout(() => setShowBanner(true), 3000);
      return () => clearTimeout(timer);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, [user]);

  // Register device with backend
  const registerDevice = async (info: DeviceInfo & { installed?: boolean }) => {
    try {
      await api.post('/api/devices/register', {
        deviceType: info.type,
        browser: info.browser,
        os: getOSName(info),
        isInstalled: info.installed ?? false,
        isStandalone: info.isStandalone,
        userAgent: navigator.userAgent,
        screenWidth: screen.width,
        screenHeight: screen.height,
        pixelRatio: window.devicePixelRatio,
      });
    } catch {
      // Silently fail - device registration is not critical
    }
  };

  const getOSName = (info: DeviceInfo): string => {
    if (info.isIOS) return info.type === 'ipad' ? 'iPadOS' : 'iOS';
    if (info.isAndroid) return 'Android';
    if (info.isWindows) return 'Windows';
    if (info.isMac) return 'macOS';
    return 'Linux';
  };

  const handleInstall = async () => {
    if (!deferredPrompt) {
      // For iOS or browsers without beforeinstallprompt, show instructions
      setShowInstructions(true);
      return;
    }

    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstalled(true);
        setShowBanner(false);
        localStorage.setItem('bsc_pwa_installed', 'true');
        if (deviceInfo) {
          registerDevice({ ...deviceInfo, installed: true });
        }
      }
      setDeferredPrompt(null);
    } catch {
      setShowInstructions(true);
    } finally {
      setInstalling(false);
    }
  };

  const handleNotNow = () => {
    setShowBanner(false);
    dismissedRef.current = true;
    localStorage.setItem('bsc_pwa_dismissed_at', String(Date.now()));
  };

  const handleInstructions = () => {
    setShowInstructions(true);
  };

  const handleInstructionsClose = () => {
    setShowInstructions(false);
  };

  if (!deviceInfo || deviceInfo.isStandalone || installed || !showBanner) {
    return null;
  }

  const instructions = installInstructionsRef.current[deviceInfo.type] || installInstructionsRef.current.unknown;

  return (
    <>
      {/* Installation Banner */}
      <div className={cx('fixed bottom-0 left-0 right-0 z-50 px-4 pb-4 sm:px-6 sm:pb-6', installed && 'hidden')}>
        <div className="max-w-xl mx-auto">
          <Card className="overflow-hidden shadow-xl border-ink-200 bg-white animate-slide-up">
            <div className="flex items-start gap-3 p-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-brand-100 flex items-center justify-center">
                <Icon name="downloadCloud" size={24} className="text-brand-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-ink-900">Install BSC Textiles Workforce App</h3>
                <p className="mt-1 text-xs text-ink-600">
                  Install the application for faster access to employee activities, calls, meetings, notifications, tasks and collaboration.
                </p>
              </div>
              <button
                type="button"
                className="flex-shrink-0 rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-600"
                onClick={handleNotNow}
                aria-label="Dismiss"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="border-t border-ink-100 px-4 py-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-primary btn-sm flex-1 sm:flex-none"
                onClick={handleInstall}
                disabled={installing}
              >
                {installing ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
                    Installing...
                  </>
                ) : (
                  <>
                    <Icon name="downloadCloud" size={14} />
                    Install App
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm flex-1 sm:flex-none"
                onClick={handleInstructions}
              >
                <Icon name="helpCircle" size={14} />
                Instructions
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm flex-1 sm:flex-none text-ink-500"
                onClick={handleNotNow}
              >
                Not Now
              </button>
            </div>
          </Card>
        </div>
      </div>

      {/* Installation Instructions Modal */}
      <Modal
        open={showInstructions}
        onClose={handleInstructionsClose}
        title="Installation Instructions"
        size="lg"
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-brand-50 p-3">
            <p className="text-sm font-medium text-brand-800">Detected Device</p>
            <p className="mt-1 text-sm text-brand-700">
              {getDeviceDisplayName(deviceInfo)} · {deviceInfo.browser.charAt(0).toUpperCase() + deviceInfo.browser.slice(1)}
            </p>
          </div>
          <div className="prose prose-sm max-w-none text-sm text-ink-700 whitespace-pre-line">
            {instructions}
          </div>
          {deviceInfo.isIOS && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
              <p className="text-sm font-medium text-amber-800">iOS Note</p>
              <p className="mt-1 text-sm text-amber-700">
                Safari does not support automatic installation prompts. You must use the Share button method described above.
                Web Push notifications require iOS 16.4+ and adding the app to Home Screen.
              </p>
            </div>
          )}
          <div className="flex justify-end pt-2">
            <button type="button" className="btn-primary" onClick={handleInstructionsClose}>
              Got It
            </button>
          </div>
        </div>
      </Modal>

      {/* Success Toast */}
      {installed && (
        <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-4 sm:px-6 sm:pb-6 animate-slide-down">
          <div className="max-w-xl mx-auto">
            <Card className="shadow-xl border-emerald-200 bg-emerald-50">
              <div className="flex items-center gap-3 p-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                  <Icon name="checkCircle" size={20} className="text-emerald-600" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-emerald-900">Application Installed Successfully</h3>
                  <p className="mt-0.5 text-xs text-emerald-700">
                    BSC Textiles Workforce is now available on your device. Access it from your home screen or app launcher.
                  </p>
                </div>
                <button
                  type="button"
                  className="flex-shrink-0 rounded-lg p-1.5 text-emerald-500 hover:bg-emerald-100"
                  onClick={() => setInstalled(false)}
                  aria-label="Dismiss"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function getDeviceDisplayName(info: DeviceInfo): string {
  switch (info.type) {
    case 'windows': return 'Windows Desktop';
    case 'android': return 'Android';
    case 'iphone': return 'iPhone';
    case 'ipad': return 'iPad';
    case 'mac': return 'macOS';
    case 'linux': return 'Linux';
    default: return 'Unknown Device';
  }
}