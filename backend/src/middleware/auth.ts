import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { ApiError } from '../lib/http.js';
import { AuthService, type AuthUser } from '../services/AuthService.js';

/** Routes that accept a mobile media token (`?mt=`): file downloads and report exports. */
const MEDIA_PATHS = /^\/api\/(?:files\/\d+|exports)\/?$/;

export interface AuthedRequest extends Request {
  user?: AuthUser;
  authToken?: string;
}

export async function authenticate(req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[config.cookieName] as string | undefined;
    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const candidate = token ?? bearer;
    if (!candidate) {
      // Mobile app media link (?mt=): only for file downloads and exports. Never
      // accepted on any other route or method.
      const media = typeof req.query.mt === 'string' ? req.query.mt : undefined;
      if (media && req.method === 'GET' && MEDIA_PATHS.test(req.originalUrl.split('?')[0])) {
        const mediaUser = await AuthService.authenticateMediaToken(media);
        if (!mediaUser) throw ApiError.unauthorized('This link has expired. Refresh the page.');
        req.user = mediaUser;
        _res.setHeader('Referrer-Policy', 'no-referrer');
        next();
        return;
      }
      throw ApiError.unauthorized();
    }
    const user = await AuthService.authenticateToken(candidate);
    if (!user) throw ApiError.unauthorized('Your session has expired. Please sign in again.');
    const payload = jwt.decode(candidate) as { exp: number };
    _res.setHeader('X-Access-Expires-At', String(payload.exp * 1000));
    req.user = user;
    req.authToken = candidate;
    next();
  } catch (error) {
    next(error);
  }
}

export function currentUser(req: Request): AuthUser {
  const user = (req as AuthedRequest).user;
  if (!user) throw ApiError.unauthorized();
  return user;
}

export function hasPermission(user: AuthUser, code: string): boolean {
  return user.permissions.includes(code);
}

/** Requires every listed permission. */
export function requirePermission(...codes: string[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    try {
      const user = currentUser(req);
      const missing = codes.filter((code) => !user.permissions.includes(code));
      if (missing.length > 0) throw ApiError.forbidden(`Missing permission: ${missing.join(', ')}`);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Requires at least one of the listed permissions. */
export function requireAny(...codes: string[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    try {
      const user = currentUser(req);
      if (!codes.some((code) => user.permissions.includes(code))) {
        throw ApiError.forbidden('You do not have access to this module');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
