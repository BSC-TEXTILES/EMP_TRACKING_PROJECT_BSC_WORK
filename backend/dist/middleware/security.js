import { config } from '../config.js';
import { ApiError, clientIp } from '../lib/http.js';
/** Conservative security headers for an API + SPA host. */
export function securityHeaders(req, res, next) {
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
const buckets = new Map();
export function rateLimit(options) {
    return (req, _res, next) => {
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
        if (bucket.resetAt < now)
            buckets.delete(key);
    }
}, 60_000).unref();
/** Blocks cross-site state-changing requests in addition to SameSite cookies. */
export function originGuard(req, _res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        next();
        return;
    }
    const origin = req.get('origin');
    if (!origin) {
        next();
        return;
    }
    if (isMobileOrigin(origin)) {
        // The mobile app sends Bearer tokens only. A cookie here means a page on that
        // origin is trying to ride a browser session: refuse it.
        if (req.headers.cookie)
            next(ApiError.forbidden('Cross-origin request blocked'));
        else
            next();
        return;
    }
    const allowed = config.appOrigin.split(',').map((o) => o.trim().replace(/\/+$/, ''));
    const host = req.get('host');
    let sameHost = false;
    if (host) {
        const cleanHost = host.replace(/:(?:80|443)$/, '');
        const originClean = origin.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:(?:80|443)$/, '');
        sameHost = origin === `http://${host}` || origin === `https://${host}` || originClean === cleanHost;
    }
    if (!allowed.includes(origin.replace(/\/+$/, '')) && !sameHost) {
        next(ApiError.forbidden('Cross-origin request blocked'));
        return;
    }
    next();
}
/** True for the Capacitor app's origins (see config.mobileOrigins). */
export function isMobileOrigin(origin) {
    return Boolean(origin) && config.mobileOrigins.includes(origin.replace(/\/+$/, ''));
}
/**
 * CORS for the mobile app only. The app authenticates with a Bearer token, so
 * credentials (cookies) are never allowed cross-origin: no
 * Access-Control-Allow-Credentials header is sent, and originGuard rejects any
 * state-changing request from these origins that carries cookies.
 */
export function mobileCors(req, res, next) {
    const origin = req.get('origin');
    if (!req.path.startsWith('/api/') || !isMobileOrigin(origin)) {
        next();
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.append('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Access-Expires-At, Content-Disposition, Retry-After');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
    }
    next();
}
//# sourceMappingURL=security.js.map