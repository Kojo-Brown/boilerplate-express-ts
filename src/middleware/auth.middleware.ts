import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '@/lib/jwt';
import { AppError } from '@/lib/errors';
import type { JwtPayload } from '@/auth/auth.types';
import type { Authenticated } from '@/lib/pipeline';

/**
 * The decision, with no transport in it: bearer token in, principal out,
 * `AppError` on the way out if there is not one.
 *
 * Split out so the classic middleware below and the pipeline step further down
 * are two callers of one rule rather than two copies of it — a fork here is a
 * fork in how the API decides who someone is.
 */
export function authenticateRequest(req: Request): JwtPayload {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'Missing or invalid Authorization header', 'UNAUTHORIZED');
  }

  return verifyAccessToken(authHeader.slice(7));
}

/**
 * Role check against an already-established principal.
 *
 * The `principal === undefined` case cannot happen on a pipeline — the step
 * requires an authenticated request to typecheck — but stays enforced here,
 * because the classic middleware has no such guarantee and 401 is a much better
 * answer than reading roles off `undefined`.
 */
export function authorizeRoles(principal: JwtPayload | undefined, roles: readonly string[]): void {
  if (!principal) {
    throw new AppError(401, 'Authentication required', 'UNAUTHORIZED');
  }

  if (!roles.some((role) => principal.roles.includes(role))) {
    throw new AppError(403, 'Insufficient permissions', 'FORBIDDEN');
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    req.auth = authenticateRequest(req);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(
  ...roles: string[]
): (req: Request, _res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      authorizeRoles(req.auth, roles);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Pipeline step: establishes the principal and says so in the type.
 *
 * `req.auth` is still assigned, because everything already reading it — the
 * request-scoped `RequestContext`, the audit subscriber — goes on working. What
 * changes is that the return type is `Authenticated<TReq>`, so from here on
 * `req.auth` is a `JwtPayload` rather than a `JwtPayload | undefined` that no
 * handler behind a token could ever actually be handed.
 */
export function authenticate<TReq extends Request>(req: TReq): Authenticated<TReq> {
  const principal = authenticateRequest(req);
  req.auth = principal;
  return req as Authenticated<TReq>;
}

/**
 * Pipeline step: rejects a principal holding none of `roles`.
 *
 * Declared over an authenticated request, which is the whole point — this is
 * the ordering rule that used to live in a comment above the route table
 * ("auth stays ahead of the role check"). Reversing them is now a type error at
 * the `use` that does it, not a 401 nobody sees until a caller without a token
 * gets one.
 */
export function requireRoles(
  ...roles: string[]
): <TReq extends Authenticated<Request>>(req: TReq) => TReq {
  if (roles.length === 0) {
    // An empty list authorises nobody, which reads at the call site as
    // authorising everybody. Fail at wiring time rather than serving 403s.
    throw new RangeError('requireRoles: at least one role is required');
  }

  return <TReq extends Authenticated<Request>>(req: TReq): TReq => {
    authorizeRoles(req.auth, roles);
    return req;
  };
}
