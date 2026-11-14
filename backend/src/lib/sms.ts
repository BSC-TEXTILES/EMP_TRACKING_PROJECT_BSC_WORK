import { config } from '../config.js';

/**
 * Sends an SMS through a configurable HTTP gateway. Provider specifics differ,
 * so the request shape is intentionally generic: JSON POST with recipient,
 * sender, and message. Without configured credentials the message is logged.
 */
export async function sendSms(to: string, message: string): Promise<boolean> {
  if (!config.sms.configured) {
    console.warn('[sms] Delivery unavailable: provider is not configured');
    return false;
  }
  try {
    const response = await fetch(config.sms.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.sms.key}`,
      },
      body: JSON.stringify({ to, sender: config.sms.senderId, message }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error('[sms] gateway responded', response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[sms] delivery failed');
    return false;
  }
}
