/**
 * Centralized Client Error Tracking Service
 * Captures, sanitizes, deduplicates, and logs client runtime crashes,
 * unhandled promise rejections, and React boundary exceptions to the backend telemetry engine.
 */

import { isNative, nativeTokens, API_ORIGIN } from './native';

const BASE = isNative ? `${API_ORIGIN}/api` : (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');
const CREDENTIALS: RequestCredentials = isNative ? 'omit' : 'include';

export interface ErrorReportOptions {
  componentStack?: string;
  module?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  errorCode?: string;
  status?: number;
  extra?: Record<string, unknown>;
}

// Fingerprint-based cooldown cache (prevents duplicate error flooding within 15 seconds)
const recentErrorDedupe = new Map<string, number>();

function getFingerprint(name: string, message: string, fileOrPath: string): string {
  const normMsg = message.slice(0, 150).replace(/\d+/g, '#');
  return `${name}:${normMsg}:${fileOrPath}`;
}

function isIgnoredError(message: string, stack?: string): boolean {
  if (!message) return true;
  const lower = message.toLowerCase();
  // Benign browser notifications and intentional aborts
  if (
    lower.includes('resizeobserver loop completed with undelivered notifications') ||
    lower.includes('resizeobserver loop limit exceeded') ||
    lower.includes('the user aborted a request') ||
    lower.includes('aborterror') ||
    lower.includes('load failed') && lower.includes('google-analytics') ||
    lower.includes('safari-extension://') ||
    lower.includes('chrome-extension://')
  ) {
    return true;
  }
  if (stack && (stack.includes('chrome-extension://') || stack.includes('moz-extension://'))) {
    return true;
  }
  return false;
}

/**
 * Report an error to the backend error tracking system
 */
export async function trackError(
  error: unknown,
  options: ErrorReportOptions = {}
): Promise<boolean> {
  try {
    let name = 'Error';
    let message = 'Unknown error';
    let stack: string | undefined = undefined;

    if (error instanceof Error) {
      name = error.name || 'Error';
      message = error.message || 'Unknown error';
      stack = error.stack;
    } else if (typeof error === 'string') {
      message = error;
    } else if (typeof error === 'object' && error !== null) {
      const errObj = error as Record<string, unknown>;
      name = String(errObj.name || errObj.errorName || 'Error');
      message = String(errObj.message || errObj.description || JSON.stringify(error));
      if (typeof errObj.stack === 'string') stack = errObj.stack;
    }

    if (isIgnoredError(message, stack)) {
      return false;
    }

    const path = window.location.pathname + window.location.search;
    const fingerprint = getFingerprint(name, message, path);
    const now = Date.now();
    const lastReported = recentErrorDedupe.get(fingerprint) ?? 0;

    // 15-second cooldown per error fingerprint
    if (now - lastReported < 15_000) {
      return false;
    }
    recentErrorDedupe.set(fingerprint, now);

    // Limit deduplication cache size
    if (recentErrorDedupe.size > 200) {
      const cutoff = now - 30_000;
      for (const [key, timestamp] of recentErrorDedupe.entries()) {
        if (timestamp < cutoff) recentErrorDedupe.delete(key);
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (isNative) {
      const tokens = nativeTokens();
      if (tokens?.accessToken) {
        headers['Authorization'] = `Bearer ${tokens.accessToken}`;
      }
    }

    const payload = {
      name,
      errorName: name,
      message: message.slice(0, 900),
      stack: stack?.slice(0, 2000),
      componentStack: options.componentStack?.slice(0, 2000),
      module: options.module ?? (path.split('/')[1] || 'Web Client'),
      path: path.slice(0, 180),
      url: window.location.href.slice(0, 250),
      severity: options.severity ?? (options.componentStack ? 'high' : 'medium'),
      status: options.status,
      errorCode: options.errorCode,
      extra: options.extra,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(`${BASE}/activity/client-error`, {
      method: 'POST',
      credentials: CREDENTIALS,
      keepalive: true,
      headers,
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      // Notify any local UI or listeners that a new client error incident was captured
      window.dispatchEvent(new CustomEvent('wfm:error-tracked', { detail: payload }));
      return true;
    }
    return false;
  } catch (err) {
    // Fail silently so error logging never triggers cascading errors
    console.warn('[ErrorTracker] Failed to transmit client error:', err);
    return false;
  }
}

let initialized = false;

/**
 * Initializes global uncaught exception and unhandled promise rejection tracking
 */
export function initErrorTracking(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // Uncaught standard JavaScript errors
  window.addEventListener('error', (event: ErrorEvent) => {
    // Ignore script loading errors from external domains or extensions
    if (event.filename && (event.filename.includes('extensions::') || event.filename.includes('chrome-extension://'))) {
      return;
    }

    const err = event.error || new Error(event.message || 'Script error');
    void trackError(err, {
      module: 'GlobalRuntime',
      severity: 'medium',
      extra: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });

  // Unhandled asynchronous Promise rejections
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    void trackError(reason, {
      module: 'AsyncPromise',
      severity: 'medium',
      extra: {
        type: 'unhandledrejection',
      },
    });
  });

  console.debug('[ErrorTracker] Client error tracking initialized');
}
