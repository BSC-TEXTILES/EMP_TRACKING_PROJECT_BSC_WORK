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

import { API_ORIGIN, isNative, mediaUrl, nativeTokens, openExternal, setMediaToken, setNativeTokens } from './native';

// The mobile app calls the API by absolute URL (it runs on its own origin).
const BASE = isNative ? `${API_ORIGIN}/api` : (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');
/** Cookies on the website; Bearer tokens in the mobile app. */
const CREDENTIALS: RequestCredentials = isNative ? 'omit' : 'include';

function authHeaders(headers: Headers = new Headers()): Headers {
  const tokens = isNative ? nativeTokens() : null;
  if (tokens && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  return headers;
}
const REQUEST_TIMEOUT_MS = 20_000;
/** Files above this size use the resumable, chunked upload endpoint. */
const CHUNKED_UPLOAD_THRESHOLD = 10 * 1024 * 1024;

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
    credentials: CREDENTIALS,
    keepalive: true,
    headers: authHeaders(new Headers({ 'Content-Type': 'application/json' })),
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

/**
 * Mobile app: rotates the refresh token. A network failure is NOT a sign-out
 * (phones lose signal all the time); only a 401 from the server ends the session.
 */
async function renewNativeSession(): Promise<void> {
  const current = nativeTokens();
  if (!current) throw new ApiError(401, 'Please sign in.', 'session_expired');
  let response: Response;
  try {
    response = await fetch(`${BASE}/auth/mobile/refresh`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the service. Check your network connection and try again.', 'network_error');
  }
  if (response.status === 401) {
    await setNativeTokens(null);
    sessionExpired = true;
    localStorage.removeItem('wfm_access_expiry');
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, 'Your session has expired. Please sign in again.', 'session_expired');
  }
  if (!response.ok) throw new ApiError(response.status, 'The service is temporarily unavailable. Please try again in a moment.', 'service_unavailable');
  const result = (await response.json()) as { accessToken: string; refreshToken: string; accessTokenExpiresAt: number };
  await setNativeTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken, accessTokenExpiresAt: result.accessTokenExpiresAt });
  localStorage.setItem('wfm_access_expiry', String(result.accessTokenExpiresAt));
  scheduleRefresh(result.accessTokenExpiresAt);
}

/** Mobile app: makes sure the access token is valid for at least 30 more seconds. */
export async function ensureFreshAccess(): Promise<string | null> {
  if (!isNative) return null;
  const current = nativeTokens();
  if (!current) return null;
  if (current.accessTokenExpiresAt < Date.now() + 30_000) await renewSession();
  return nativeTokens()?.accessToken ?? null;
}

let mediaTimer: ReturnType<typeof setTimeout> | undefined;
/** Mobile app: fetches the short-lived token used in image and download URLs. */
export async function refreshMediaToken(): Promise<void> {
  if (!isNative || !nativeTokens()) return;
  clearTimeout(mediaTimer);
  try {
    const result = await request<{ token: string; expiresAt: number }>('/auth/mobile/media-token', { method: 'POST' });
    setMediaToken(result);
    mediaTimer = setTimeout(() => { void refreshMediaToken(); }, Math.max(60_000, result.expiresAt - Date.now() - 10 * 60_000));
  } catch {
    mediaTimer = setTimeout(() => { void refreshMediaToken(); }, 60_000);
  }
}

async function renewSession(): Promise<void> {
  if (refreshFlight) return refreshFlight;
  if (isNative) {
    refreshFlight = renewNativeSession().finally(() => { refreshFlight = null; });
    return refreshFlight;
  }
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

function isRawBody(body: BodyInit | null | undefined): boolean {
  return body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof ReadableStream;
}

async function request<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const publicAuth = path.startsWith('/setup/') || path.startsWith('/auth/') && path !== '/auth/me' && !path.startsWith('/auth/sessions');
  if (sessionExpired && !publicAuth) throw new ApiError(401, 'Your session has expired. Please sign in again.', 'session_expired');

  // Mobile app: same screens, token endpoints (see docs/MOBILE_BACKEND.md).
  let url = path;
  if (isNative) {
    if (path === '/auth/login') url = '/auth/mobile/login';
    else if (path === '/auth/login/otp/verify') url = '/auth/mobile/login/otp/verify';
    else if (path === '/auth/logout') {
      url = '/auth/mobile/logout';
      let extra: Record<string, unknown> = {};
      try {
        extra = typeof options.body === 'string' ? JSON.parse(options.body) : {};
      } catch {
        extra = {};
      }
      options = { ...options, body: JSON.stringify({ keepNotifications: extra.keepNotifications !== false, refreshToken: nativeTokens()?.refreshToken }) };
    } else if (!publicAuth || path === '/auth/mobile/media-token') {
      await ensureFreshAccess().catch(() => undefined);
    }
  }
  const headers = authHeaders(new Headers(options.headers));
  if (options.body !== undefined && options.body !== null && !(options.body instanceof FormData) && !isRawBody(options.body)) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE}${url}`, {
      credentials: CREDENTIALS,
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ApiError(0, 'The request was cancelled.', 'aborted');
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'The request took too long. Check your connection and try again.', 'timeout');
    }
    throw new ApiError(0, 'Cannot reach the service. Check your network connection and try again.', 'network_error');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 503) {
    const payload = await response.clone().json().catch(() => ({}));
    if (payload.code === 'setup_required' && window.location.pathname !== '/setup') window.location.replace('/setup');
  }
  if (response.status === 401 && !publicAuth && !retried) {
    if (!localStorage.getItem('wfm_session_known')) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
      throw new ApiError(401, 'Please sign in.', 'unauthorized');
    }
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
    if (isNative) {
      clearTimeout(mediaTimer);
      await setNativeTokens(null);
    }
  }
  if (response.status === 401 && !publicAuth) window.dispatchEvent(new CustomEvent('auth:expired'));

  if (!response.ok) {
    reportClientFailure(path, response.status);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      // A gateway or proxy error page. Never claim the whole application is
      // down based on a single response; surface a neutral, actionable message.
      const message = response.status >= 502
        ? 'The service is temporarily unavailable. Please try again in a moment.'
        : `The request could not be completed (${response.status}). Please try again.`;
      throw new ApiError(response.status, message, 'service_unavailable');
    }
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
  const data = await response.json();
  if (isNative && data && typeof data === 'object' && typeof data.accessToken === 'string') {
    // Mobile sign-in: keep the tokens in secure storage, hand the screen only the rest.
    const { accessToken, refreshToken, accessTokenExpiresAt, ...rest } = data as { accessToken: string; refreshToken: string; accessTokenExpiresAt: number };
    await setNativeTokens({ accessToken, refreshToken, accessTokenExpiresAt });
    sessionExpired = false;
    localStorage.setItem('wfm_access_expiry', String(accessTokenExpiresAt));
    scheduleRefresh(accessTokenExpiresAt);
    await refreshMediaToken();
    return rest as T;
  }
  return data as T;
}

export interface UploadedFile {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  sha256?: string | null;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

function notifyProgress(options: UploadOptions, loaded: number, total: number): void {
  options.onProgress?.({ loaded, total, percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0 });
}

async function sha256Hex(file: File): Promise<string | null> {
  if (!crypto.subtle || file.size > 64 * 1024 * 1024) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new ApiError(0, 'The upload was cancelled.', 'aborted'));
    }, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

/** Form upload with real progress events (XHR is the only browser API that reports upload progress). */
async function uploadSingle(file: File, options: UploadOptions): Promise<UploadedFile> {
  const sha256 = await sha256Hex(file);
  const bearer = await ensureFreshAccess().catch(() => null);
  return new Promise<UploadedFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    if (sha256) form.append('sha256', sha256);
    xhr.open('POST', `${BASE}/files/upload`, true);
    xhr.withCredentials = !isNative;
    if (bearer) xhr.setRequestHeader('Authorization', `Bearer ${bearer}`);
    xhr.timeout = 5 * 60_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) notifyProgress(options, event.loaded, event.total);
    };
    xhr.onload = () => {
      let payload: unknown = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      const data = payload as { id?: number; name?: string; mimeType?: string; size?: number; url?: string; sha256?: string; error?: string; code?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) {
        notifyProgress(options, file.size, file.size);
        resolve({ id: data.id, name: data.name ?? file.name, mimeType: data.mimeType ?? file.type, size: data.size ?? file.size, url: data.url ?? `/api/files/${data.id}`, sha256: data.sha256 });
        return;
      }
      reject(new ApiError(xhr.status || 0, data?.error ?? 'The file could not be uploaded.', data?.code ?? 'upload_failed'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'The upload lost its connection. Check your network and retry.', 'network_error'));
    xhr.ontimeout = () => reject(new ApiError(0, 'The upload took too long. Retry the file.', 'timeout'));
    xhr.onabort = () => reject(new ApiError(0, 'The upload was cancelled.', 'aborted'));
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

interface UploadSession {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
}

interface UploadSessionStatus extends UploadSession {
  uploadedChunks: number[];
  receivedBytes: number;
  status: string;
}

async function putChunk(
  uploadId: string,
  index: number,
  blob: Blob,
  options: UploadOptions,
  attempt = 0,
): Promise<void> {
  try {
    await request<{ receivedBytes: number }>(`/files/chunked/${uploadId}/chunk/${index}`, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: options.signal,
    });
  } catch (error) {
    if (attempt < 3 && isRetryable(error) && !options.signal?.aborted) {
      await delay(600 * 2 ** attempt, options.signal);
      return putChunk(uploadId, index, blob, options, attempt + 1);
    }
    throw error;
  }
}

async function uploadChunked(file: File, options: UploadOptions): Promise<UploadedFile> {
  const session = await request<UploadSession>('/files/chunked/start', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size }),
    signal: options.signal,
  });

  let status: UploadSessionStatus | null = null;
  try {
    status = await request<UploadSessionStatus>(`/files/chunked/${session.uploadId}`, { signal: options.signal });
  } catch {
    status = null;
  }
  const alreadyUploaded = new Set(status?.uploadedChunks ?? []);
  let loaded = status?.receivedBytes ?? 0;
  notifyProgress(options, loaded, file.size);

  for (let index = 0; index < session.totalChunks; index += 1) {
    if (alreadyUploaded.has(index)) continue;
    if (options.signal?.aborted) {
      void request(`/files/chunked/${session.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
      throw new ApiError(0, 'The upload was cancelled.', 'aborted');
    }
    const start = index * session.chunkSize;
    const blob = file.slice(start, Math.min(file.size, start + session.chunkSize));
    await putChunk(session.uploadId, index, blob, options);
    loaded += blob.size;
    notifyProgress(options, loaded, file.size);
  }

  try {
    const uploaded = await request<UploadedFile>(`/files/chunked/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
      signal: options.signal,
    });
    notifyProgress(options, file.size, file.size);
    return uploaded;
  } catch (error) {
    void request(`/files/chunked/${session.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}

/** Uploads a file, choosing a single request or a resumable chunked session. */
async function uploadFile(file: File, options: UploadOptions = {}): Promise<UploadedFile> {
  if (file.size === 0) throw new ApiError(400, 'The selected file is empty.', 'bad_request');
  if (file.size > CHUNKED_UPLOAD_THRESHOLD) return uploadChunked(file, options);
  return uploadSingle(file, options);
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
  delWithBody: <T>(path: string, body: unknown) => request<T>(path, { method: 'DELETE', body: JSON.stringify(body) }),
  upload: <T>(file: File) => uploadFile(file) as Promise<T>,
  uploadFile,
  uploadPhoto: <T>(file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<T>('/me/photo', { method: 'POST', body: form });
  },
};

export function fileUrl(fileId: number, download = false): string {
  // Mobile app: absolute URL with a short-lived media token (img/video/links cannot send headers).
  if (isNative) return mediaUrl(`/api/files/${fileId}${download ? '?download=1' : ''}`);
  // BASE already contains the API prefix (`/api` or an absolute API origin).
  // Using it directly keeps authenticated downloads working in both setups.
  return `${BASE}/files/${fileId}${download ? '?download=1' : ''}`;
}

export function downloadReport(params: Record<string, string | number | undefined>): void {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  if (isNative) {
    void openExternal(`/api/exports?${search.toString()}`);
    return;
  }
  window.location.href = `${BASE}/exports?${search.toString()}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
