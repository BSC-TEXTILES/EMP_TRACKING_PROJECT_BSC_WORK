import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Minimal Firebase Cloud Messaging HTTP v1 client.
 *
 * Uses a Google service account (server-side only) to obtain an OAuth access
 * token and sends one message per device token. FCM delivers to Android
 * directly and to iOS through APNs (the APNs key is uploaded in the Firebase
 * console, never configured here).
 *
 * No SDK dependency: the OAuth step is a signed JWT (RS256) exchanged at
 * Google's token endpoint, which `jsonwebtoken` already supports.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmMessage {
  title: string;
  body?: string | null;
  /** String-only key/values delivered to the app (deep link, ids). */
  data: Record<string, string>;
  /** Android notification channel; the app creates these channels. */
  channel: 'general' | 'urgent' | 'chat' | 'calls';
  priority: 'high' | 'normal';
  /** Collapses repeated notifications of the same thread on the device. */
  tag?: string;
  /** iOS app-icon badge (unread count). */
  badge?: number;
  /** Seconds FCM keeps an undelivered message. Calls use ~40 s so a phone that comes online late never rings for a dead call. */
  ttlSeconds?: number;
}

export type FcmOutcome =
  | { status: 'sent' }
  /** The token is dead (app uninstalled, token rotated, other Firebase project). Delete it. */
  | { status: 'invalid_token'; error: string }
  /** Temporary FCM problem; the in-app notification is still stored. */
  | { status: 'transient'; error: string }
  | { status: 'failed'; error: string };

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

let account: ServiceAccount | null | undefined;
let cachedToken: { value: string; expiresAt: number } | null = null;

function loadAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  account = null;
  try {
    let raw = '';
    if (config.fcm.serviceAccountJson) {
      raw = config.fcm.serviceAccountJson.trim();
      if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    } else if (config.fcm.serviceAccountFile) {
      raw = fs.readFileSync(config.fcm.serviceAccountFile, 'utf8');
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      console.error('[fcm] Service account JSON is missing project_id, client_email or private_key; push to phones is disabled.');
      return null;
    }
    account = {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
      token_uri: parsed.token_uri,
    };
  } catch (error) {
    console.error('[fcm] Could not read the Firebase service account; push to phones is disabled.', (error as Error).message);
    account = null;
  }
  return account;
}

/** True when a Firebase service account is configured and readable. */
export function fcmConfigured(): boolean {
  return loadAccount() !== null;
}

/** Test hook: forget the cached service account and access token. */
export function resetFcmForTests(): void {
  account = undefined;
  cachedToken = null;
}

let tokenFlight: Promise<string> | null = null;

/** Cached Google access token; concurrent sends share one in-flight request. */
function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return Promise.resolve(cachedToken.value);
  tokenFlight ??= fetchAccessToken().finally(() => { tokenFlight = null; });
  return tokenFlight;
}

async function fetchAccessToken(): Promise<string> {
  const sa = loadAccount();
  if (!sa) throw new Error('FCM is not configured');
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google OAuth failed (${res.status} ${json.error ?? ''})`.trim());
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

function buildBody(token: string, message: FcmMessage) {
  return {
    message: {
      token,
      notification: { title: message.title.slice(0, 200), body: message.body?.slice(0, 500) ?? undefined },
      data: message.data,
      android: {
        priority: message.priority === 'high' ? 'HIGH' : 'NORMAL',
        // Undelivered notifications are dropped (default: after a day) rather than arriving stale.
        ttl: `${Math.max(0, Math.floor(message.ttlSeconds ?? 86400))}s`,
        notification: { channel_id: message.channel, tag: message.tag, default_sound: true },
      },
      apns: {
        headers: {
          'apns-priority': message.priority === 'high' ? '10' : '5',
          ...(message.ttlSeconds !== undefined ? { 'apns-expiration': String(Math.floor(Date.now() / 1000) + Math.floor(message.ttlSeconds)) } : {}),
          ...(message.tag ? { 'apns-collapse-id': message.tag.slice(0, 64) } : {}),
        },
        payload: { aps: { sound: 'default', ...(message.badge !== undefined ? { badge: message.badge } : {}), ...(message.tag ? { 'thread-id': message.tag } : {}) } },
      },
    },
  };
}

interface FcmErrorBody {
  error?: { status?: string; message?: string; details?: { '@type'?: string; errorCode?: string }[] };
}

function classify(status: number, body: FcmErrorBody): FcmOutcome {
  const err = body.error ?? {};
  const code = err.details?.find((d) => d.errorCode)?.errorCode ?? err.status ?? String(status);
  const text = `${code}: ${err.message ?? ''}`.slice(0, 160);
  if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH' || status === 404) return { status: 'invalid_token', error: text };
  if (code === 'INVALID_ARGUMENT' && /registration token/i.test(err.message ?? '')) return { status: 'invalid_token', error: text };
  if (status === 429 || status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL' || code === 'QUOTA_EXCEEDED') {
    return { status: 'transient', error: text };
  }
  return { status: 'failed', error: text };
}

/** Sends one message to one device token. Never throws. */
export async function sendFcm(token: string, message: FcmMessage): Promise<FcmOutcome> {
  const sa = loadAccount();
  if (!sa) return { status: 'failed', error: 'FCM is not configured' };
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
  const body = JSON.stringify(buildBody(token, message));

  let outcome: FcmOutcome = { status: 'failed', error: 'not sent' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const bearer = await accessToken();
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { status: 'sent' };
      const json = (await res.json().catch(() => ({}))) as FcmErrorBody;
      if (res.status === 401 && attempt === 0) {
        // Access token revoked or clock skew: fetch a fresh one and retry once.
        cachedToken = null;
        outcome = { status: 'failed', error: '401 unauthenticated' };
        continue;
      }
      outcome = classify(res.status, json);
      if (outcome.status !== 'transient' || attempt > 0) return outcome;
      const retryAfter = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 1000));
    } catch (error) {
      outcome = { status: 'transient', error: (error as Error).message.slice(0, 160) };
      if (attempt > 0) return outcome;
    }
  }
  return outcome;
}
