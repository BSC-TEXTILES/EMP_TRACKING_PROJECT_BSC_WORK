import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { ApiError, clientIp } from '../lib/http.js';

/** Conservative security headers for an API + SPA host. */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(options: { windowMs: number; max: number; keyPrefix?: string }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = `${options.keyPrefix ?? 'global'}:${clientIp(req)}:${req.method}:${req.path}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      _res.setHeader('Retry-After', String(retryAfter));
      next(new ApiError(429, 'Too many requests. Please slow down and try again shortly.', 'rate_limited'));
      return;
    }
    next();
  };
}

// Periodically drop expired buckets so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 60_000).unref();

/** Blocks cross-site state-changing requests in addition to SameSite cookies. */
export function originGuard(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }
  const allowed = config.appOrigin.split(',').map((o) => o.trim());
  const host = req.get('host');
  const sameHost = host ? origin === `http://${host}` || origin === `https://${host}` : false;
  if (!allowed.includes(origin) && !sameHost) {
    next(ApiError.forbidden('Cross-origin request blocked'));
    return;
  }
  next();
}
