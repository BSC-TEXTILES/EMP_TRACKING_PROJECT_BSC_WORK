import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { query, execute, queryOne } from '../db/index.js';
import { emitToEmployees } from '../realtime/io.js';
import { toIso } from '../lib/dates.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const devicesRouter = Router();
devicesRouter.use(authenticate);

/**
 * Register or update device information
 */
devicesRouter.post(
  '/register',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        deviceType: z.enum(['windows', 'android', 'iphone', 'ipad', 'mac', 'linux', 'unknown']),
        browser: z.enum(['chrome', 'edge', 'firefox', 'safari', 'opera', 'unknown']),
        os: z.string().max(100),
        isInstalled: z.boolean().optional(),
        isStandalone: z.boolean().optional(),
        userAgent: z.string().max(500).optional(),
        screenWidth: z.number().int().positive().optional(),
        screenHeight: z.number().int().positive().optional(),
        pixelRatio: z.number().optional(),
        pushEndpoint: z.string().max(500).optional(),
        pushKeys: z.object({
          p256dh: z.string(),
          auth: z.string(),
        }).optional(),
      }),
      req.body,
    );

    // Generate device fingerprint
    const fingerprint = generateDeviceFingerprint(body);

    // Check if device already exists
    let device = await queryOne<{ id: number }>(
      'SELECT id FROM devices WHERE employee_id = ? AND fingerprint = ?',
      [user.id, fingerprint],
    );

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    if (device) {
      // Update existing device
      await execute(
        `UPDATE devices SET 
          device_type = ?, browser = ?, os = ?, user_agent = ?,
          is_installed = ?, is_standalone = ?, screen_width = ?, screen_height = ?,
          pixel_ratio = ?, push_endpoint = ?, push_keys = ?, last_active_at = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          body.deviceType, body.browser, body.os, body.userAgent || '',
          body.isInstalled ?? false, body.isStandalone ?? false,
          body.screenWidth ?? null, body.screenHeight ?? null,
          body.pixelRatio ?? null, body.pushEndpoint ?? null,
          body.pushKeys ? JSON.stringify(body.pushKeys) : null,
          now, now, device.id,
        ],
      );
    } else {
      // Create new device
      const result = await execute(
        `INSERT INTO devices (
          employee_id, fingerprint, device_type, browser, os, user_agent,
          is_installed, is_standalone, screen_width, screen_height, pixel_ratio,
          push_endpoint, push_keys, last_active_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id, fingerprint, body.deviceType, body.browser, body.os,
          body.userAgent || '', body.isInstalled ?? false, body.isStandalone ?? false,
          body.screenWidth ?? null, body.screenHeight ?? null, body.pixelRatio ?? null,
          body.pushEndpoint ?? null, body.pushKeys ? JSON.stringify(body.pushKeys) : null,
          now, now, now,
        ],
      );
      device = { id: result.insertId };
    }

    // If push subscription provided, store it
    if (body.pushEndpoint && body.pushKeys) {
      await upsertPushSubscription(user.id, device!.id, body.pushEndpoint, body.pushKeys);
    }

    res.json({ ok: true, deviceId: device!.id });
  })
);

/**
 * Get all registered devices for current user
 */
devicesRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const rows = await query<{
      id: number;
      fingerprint: string;
      device_type: string;
      browser: string;
      os: string;
      user_agent: string;
      is_installed: number;
      is_standalone: number;
      push_endpoint: string | null;
      push_keys: string | null;
      last_active_at: string;
      created_at: string;
    }>(
      'SELECT id, fingerprint, device_type, browser, os, user_agent, is_installed, is_standalone, push_endpoint, push_keys, last_active_at, created_at FROM devices WHERE employee_id = ? ORDER BY last_active_at DESC',
      [user.id],
    );

    // Determine current device based on fingerprint
    const currentFingerprint = generateDeviceFingerprint({
      deviceType: req.body?.deviceType || 'unknown',
      browser: req.body?.browser || 'unknown',
      os: req.body?.os || '',
      userAgent: req.get('user-agent') || '',
    });

    const devices = rows.map(r => ({
      id: Number(r.id),
      deviceType: r.device_type,
      browser: r.browser,
      os: r.os,
      userAgent: r.user_agent,
      isInstalled: Boolean(r.is_installed),
      isStandalone: Boolean(r.is_standalone),
      pushSubscribed: Boolean(r.push_endpoint),
      lastActiveAt: toIso(r.last_active_at),
      createdAt: toIso(r.created_at),
      current: r.fingerprint === currentFingerprint,
    }));

    res.json({ devices });
  })
);

/**
 * Revoke device access (logout from device)
 */
devicesRouter.post(
  '/:id/revoke',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const deviceId = intParam(req.params.id);

    const device = await queryOne<{ id: number; employee_id: number; push_endpoint: string | null }>(
      'SELECT id, employee_id, push_endpoint FROM devices WHERE id = ? AND employee_id = ?',
      [deviceId, user.id],
    );

    if (!device) {
      res.status(404).json({ error: 'Device not found', code: 'not_found' });
      return;
    }

    // Remove push subscription if exists
    if (device.push_endpoint) {
      await execute('DELETE FROM push_subscriptions WHERE employee_id = ? AND endpoint = ?', [user.id, device.push_endpoint]);
    }

    // Delete device
    await execute('DELETE FROM devices WHERE id = ?', [deviceId]);

    // Notify other sessions to update
    emitToEmployees([user.id], 'device:revoked', { deviceId });

    res.json({ ok: true });
  })
);

/**
 * Revoke all other devices (keep current)
 */
devicesRouter.post(
  '/revoke-all-others',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const currentFingerprint = req.body?.currentFingerprint || generateDeviceFingerprint({
      deviceType: req.body?.deviceType || 'unknown',
      browser: req.body?.browser || 'unknown',
      os: req.body?.os || '',
      userAgent: req.get('user-agent') || '',
    });

    // Get push endpoints for other devices
    const otherDevices = await query<{ push_endpoint: string }>(
      'SELECT push_endpoint FROM devices WHERE employee_id = ? AND fingerprint != ? AND push_endpoint IS NOT NULL',
      [user.id, currentFingerprint],
    );

    // Delete push subscriptions
    for (const d of otherDevices) {
      await execute('DELETE FROM push_subscriptions WHERE employee_id = ? AND endpoint = ?', [user.id, d.push_endpoint]);
    }

    // Delete other devices
    await execute('DELETE FROM devices WHERE employee_id = ? AND fingerprint != ?', [user.id, currentFingerprint]);

    emitToEmployees([user.id], 'device:revoked_all', { keptFingerprint: currentFingerprint });

    res.json({ ok: true, revokedCount: otherDevices.length });
  })
);

/**
 * Update device heartbeat (called periodically)
 */
devicesRouter.post(
  '/heartbeat',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const fingerprint = generateDeviceFingerprint({
      deviceType: req.body?.deviceType || 'unknown',
      browser: req.body?.browser || 'unknown',
      os: req.body?.os || '',
      userAgent: req.get('user-agent') || '',
    });

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await execute(
      'UPDATE devices SET last_active_at = ? WHERE employee_id = ? AND fingerprint = ?',
      [now, user.id, fingerprint],
    );

    res.json({ ok: true });
  })
);

/**
 * Generate device fingerprint from attributes
 */
function generateDeviceFingerprint(data: {
  deviceType: string;
  browser: string;
  os: string;
  userAgent?: string;
}): string {
  const userAgent = data.userAgent || '';
  const str = `${data.deviceType}|${data.browser}|${data.os}|${userAgent.slice(0, 100)}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `fp_${Math.abs(hash).toString(36)}${Date.now().toString(36).slice(-6)}`;
}

/**
 * Upsert push subscription
 */
async function upsertPushSubscription(
  employeeId: number,
  deviceId: number,
  endpoint: string,
  keys: { p256dh: string; auth: string }
): Promise<void> {
  await execute(
    `INSERT INTO push_subscriptions (employee_id, device_id, endpoint, p256dh, auth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE 
       device_id = VALUES(device_id),
       p256dh = VALUES(p256dh),
       auth = VALUES(auth),
       updated_at = NOW(3)`,
    [employeeId, deviceId, endpoint, keys.p256dh, keys.auth],
  );
}