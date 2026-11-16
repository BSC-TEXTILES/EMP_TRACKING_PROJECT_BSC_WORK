export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20_000;

const clientFailureReports = new Map<string, number>();

/** Reports sanitized failed platform operations while a monitored session is active. */
function reportClientFailure(path: string, status: number): void {
  if (status < 500 || path.startsWith('/activity/client-error')) return;
  const normalized = path.split('?')[0].replace(/\d+/g, ':id');
  const now = Date.now();
  if (now - (clientFailureReports.get(normalized) ?? 0) < 5 * 60 * 1000) return;
  clientFailureReports.set(normalized, now);
  const module = normalized.split('/').filter(Boolean)[0] ?? 'Platform';
  void fetch(`${BASE}/activity/client-error`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: normalized, status, module }),
  }).catch(() => undefined);
}

let refreshFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let sessionExpired = false;

function scheduleRefresh(expiresAt: number): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void renewSession().catch(() => undefined); }, Math.max(1000, expiresAt - Date.now() - 60000));
}

async function renewSession(): Promise<void> {
  if (refreshFlight) return refreshFlight;
  const renew = async () => {
    // Web Locks serialize cookie rotation across tabs. Only expiry metadata is stored.
    const expiry = Number(localStorage.getItem('wfm_access_expiry') || 0);
    if (expiry > Date.now() + 60000) { scheduleRefresh(expiry); return; }
    const response = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Session expired');
    const result = await response.json();
    const next = Date.now() + result.expiresIn * 1000;
    localStorage.setItem('wfm_access_expiry', String(next));
    scheduleRefresh(next);
  };
  refreshFlight = (async () => {
    if (navigator.locks) await navigator.locks.request('wfm-session-refresh', renew);
    else await renew();
  })()
    .catch(() => {
      sessionExpired = true;
      clearTimeout(refreshTimer);
      localStorage.removeItem('wfm_access_expiry');
      window.dispatchEvent(new CustomEvent('auth:expired'));
      throw new ApiError(401, 'Your session has expired. Please sign in again.', 'session_expired');
    }).finally(() => { refreshFlight = null; });
  return refreshFlight;
}

async function request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const publicAuth = path.startsWith('/setup/') || path.startsWith('/auth/') && path !== '/auth/me' && !path.startsWith('/auth/sessions');
  if (sessionExpired && !publicAuth) throw new ApiError(401, 'Your session has expired. Please sign in again.', 'session_expired');
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'The request took too long. Check your connection and try again.', 'timeout');
    }
    throw new ApiError(0, 'Cannot reach the server. Check your network connection.', 'network_error');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 503) {
    const payload = await response.clone().json().catch(() => ({}));
    if (payload.code === 'setup_required' && window.location.pathname !== '/setup') window.location.replace('/setup');
  }
  if (response.status === 401 && !publicAuth && !retried) {
    localStorage.removeItem('wfm_access_expiry');
    await renewSession();
    return request<T>(path, options, true);
  }
  if (response.ok && (path === '/auth/login' || path === '/auth/login/otp/verify')) sessionExpired = false;
  const expiry = Number(response.headers.get('X-Access-Expires-At'));
  if (response.ok && expiry) {
    localStorage.setItem('wfm_access_expiry', String(expiry));
    scheduleRefresh(expiry);
  }
  if (path === '/auth/logout') {
    clearTimeout(refreshTimer);
    localStorage.removeItem('wfm_access_expiry');
    sessionExpired = true;
  }
  if (response.status === 401 && !publicAuth) window.dispatchEvent(new CustomEvent('auth:expired'));

  if (!response.ok) {
    reportClientFailure(path, response.status);
    let payload: { error?: string; code?: string; details?: unknown } = {};
    try {
      payload = await response.json();
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`, payload.code ?? 'error', payload.details);
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return (await response.text()) as unknown as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<T>('/files/upload', { method: 'POST', body: form });
  },
  uploadPhoto: <T>(file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<T>('/me/photo', { method: 'POST', body: form });
  },
};

export function downloadReport(params: Record<string, string | number | undefined>): void {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  window.location.href = `${BASE}/exports?${search.toString()}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
