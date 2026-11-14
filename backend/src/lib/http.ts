import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

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

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, 'bad_request', details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, message, 'unauthorized');
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, message, 'forbidden');
  }
  static notFound(message = 'Resource not found') {
    return new ApiError(404, message, 'not_found');
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, message, 'conflict', details);
  }
  static tooMany(message = 'Too many requests, please try again later') {
    return new ApiError(429, message, 'rate_limited');
  }
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

export function asyncHandler(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function parseBody<T>(schema: ZodSchema<T>, value: unknown): T {
  try {
    return schema.parse(value ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((e) => ({ path: e.path.join('.'), message: e.message }));
      throw ApiError.badRequest(details[0]?.message ?? 'Invalid request payload', details);
    }
    throw error;
  }
}

export function intParam(value: string | undefined, name = 'id'): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw ApiError.badRequest(`Invalid ${name}`);
  }
  return parsed;
}

export function pagination(query: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(String(query.pageSize ?? '25'), 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function requireSameOrigin(req: Request): void {
  const origin = req.get('origin');
  if (!origin) return; // non-browser client or same-origin GET; cookies carry SameSite=Lax
  const allowed = (process.env.APP_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim());
  const host = req.get('host');
  const sameHost = host ? origin === `http://${host}` || origin === `https://${host}` : false;
  if (!allowed.includes(origin) && !sameHost) {
    throw ApiError.forbidden('Cross-origin request blocked');
  }
}

export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').slice(0, 60);
}
