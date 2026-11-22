import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { Icon } from './icons';
import { useToast } from '../contexts/ToastContext';

interface InstallAppButtonProps {
  onClose?: () => void;
  variant?: 'profile' | 'standalone';
}

function isAndroid(): boolean {
  return /Android/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function InstallAppButton({ onClose, variant = 'profile' }: InstallAppButtonProps) {
  const toast = useToast();
  const [apkAvailable, setApkAvailable] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  useEffect(() => {
    checkApkAvailability();
  }, []);

  const checkApkAvailability = async () => {
    try {
      const response = await api.get<{ release: { available: boolean }; debug: { available: boolean } }>('/downloads/apk/info');
      setApkAvailable(response.release.available || response.debug.available);
    } catch {
      setApkAvailable(false);
    }
  };

  const handleDownload = useCallback(async (variantType: 'release' | 'debug' = 'release') => {
    if (downloading) return;

    const isAndroidDevice = isAndroid();
    const isAppInstalled = isStandalone();

    // If running as installed app (standalone), don't show download
    if (isAppInstalled) {
      toast.info('You are already using the installed app.');
      return;
    }

    // On non-Android devices, show info message
    if (!isAndroidDevice) {
      toast.info('APK installation requires an Android device. Visit this page on your Android phone to download and install the app.');
      return;
    }

    setDownloading(true);
    setDownloadProgress(0);

    try {
      const url = `/api/downloads/apk/${variantType}`;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include', // Include cookies for auth if needed
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Download failed' }));
        throw new Error(error.error || `Download failed: ${response.status}`);
      }

      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      let loaded = 0;

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const chunks: Uint8Array<ArrayBuffer>[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        loaded += value.length;
        if (total > 0) {
          setDownloadProgress(Math.round((loaded / total) * 100));
        }
      }

      const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = variantType === 'release' ? 'bsc-hrms-release.apk' : 'bsc-hrms-debug.apk';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up blob URL after a delay
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      toast.success(`${variantType === 'release' ? 'Release' : 'Debug'} APK download started. Open your Downloads folder to install.`);
      onClose?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to download APK');
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
    }
  }, [downloading, onClose, toast]);

  const androidOnly = isAndroid();

  if (!apkAvailable) {
    return null; // Don't show if APK not available
  }

  if (variant === 'profile') {
    return (
      <button
        type="button"
        onClick={() => handleDownload('release')}
        disabled={downloading || !androidOnly}
        className="flex items-center justify-between px-4 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2.5">
          <Icon name="smartphone" size={16} className="text-emerald-600" />
          <span>{downloading ? `Downloading… ${downloadProgress}%` : 'Download Android App'}</span>
        </div>
        {downloading ? (
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
              {downloadProgress}%
            </span>
          </div>
        ) : (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
            APK
          </span>
        )}
      </button>
    );
  }

  // Standalone variant for dedicated install page
  return (
    <div className="space-y-3">
      {androidOnly ? (
        <button
          type="button"
          onClick={() => handleDownload('release')}
          disabled={downloading}
          className="btn-primary w-full text-center flex items-center justify-center gap-2 py-3 text-lg disabled:opacity-50"
        >
          <Icon name="download" size={20} />
          <span>{downloading ? `Downloading Release APK… ${downloadProgress}%` : 'Download Release APK (Production)'}</span>
        </button>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center">
          <Icon name="smartphone" size={24} className="mx-auto text-amber-600 mb-2" />
          <p className="text-sm font-medium text-amber-800">Android Device Required</p>
          <p className="mt-1 text-xs text-amber-700">
            APK installation is only supported on Android devices. Please visit this page on your Android phone or tablet to download and install the BSC Textiles HRMS app.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => handleDownload('debug')}
        disabled={downloading}
        className="btn-secondary w-full text-center flex items-center justify-center gap-2 py-2.5 disabled:opacity-50"
      >
        <Icon name="download" size={16} />
        <span>{downloading ? `Downloading Debug APK… ${downloadProgress}%` : 'Download Debug APK (Development)'}</span>
      </button>

      {!androidOnly && (
        <p className="text-center text-xs text-ink-500">
          The debug APK is also available for IT administrators and QA testing.
        </p>
      )}

      <div className="rounded-xl border border-ink-200 bg-ink-50 p-3.5">
        <h4 className="text-xs font-bold text-ink-900 mb-2">Installation Steps (Android)</h4>
        <ol className="space-y-1.5 text-[11px] text-ink-600">
          <li className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[9px] font-bold text-white">1</span>Tap <strong>Download Release APK</strong> above.</li>
          <li className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[9px] font-bold text-white">2</span>Open the download notification or your <strong>Files / Downloads</strong> folder.</li>
          <li className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[9px] font-bold text-white">3</span>Tap <code className="font-mono">bsc-hrms-release.apk</code> to start installation.</li>
          <li className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[9px] font-bold text-white">4</span>If prompted <strong>"Install unknown apps"</strong>, tap <strong>Settings</strong> → enable <strong>Allow from this source</strong>.</li>
          <li className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[9px] font-bold text-white">5</span>Tap <strong>Install</strong>, then open the app and sign in with your BSC Textiles credentials.</li>
        </ol>
      </div>
    </div>
  );
}