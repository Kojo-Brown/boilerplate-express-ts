import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '@/lib/jwt';
import { AppError } from '@/lib/errors';
import type { JwtPayload } from '@/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    next(new AppError(401, 'Missing or invalid Authorization header', 'UNAUTHORIZED'));
    return;
  }

  const token = authHeader.slice(7);

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: string[]): (req: Request, _res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'Authentication required', 'UNAUTHORIZED'));
      return;
    }

    const hasRole = roles.some((role) => req.user!.roles.includes(role));

    if (!hasRole) {
      next(new AppError(403, 'Insufficient permissions', 'FORBIDDEN'));
      return;
    }

    next();
  };
}
