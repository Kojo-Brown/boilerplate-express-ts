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

/**
 * Object-level authorization: the principal is the subject, or holds one of
 * `roles`.
 *
 * Kept next to `authorizeRoles` and deliberately not folded into it, because
 * they answer different questions and OWASP counts them as different risks.
 * `authorizeRoles` asks whether this *kind* of caller may use this *operation*
 * at all (API5, function level); this asks whether this *particular* caller may
 * touch this *particular* object (API1, object level). A route guarded only by
 * the first is the shape of every BOLA advisory ever written: `GET
 * /v1/users/:id` behind a valid token, serving any id the caller cares to type.
 *
 * The identifier compared is `req.auth.userId` — the subject the token was
 * minted for — against the id in the path. There is no second lookup and
 * nothing to spoof: both sides of the comparison come from the server, one from
 * a signature it verified and one from its own router.
 */
export function authorizeSelfOrRoles(
  principal: JwtPayload | undefined,
  subjectId: string,
  roles: readonly string[],
): void {
  if (!principal) {
    throw new AppError(401, 'Authentication required', 'UNAUTHORIZED');
  }

  if (principal.userId === subjectId) return;

  authorizeRoles(principal, roles);
}

/**
 * Pipeline step: rejects a principal that is neither the subject of `:id` nor a
 * holder of one of `roles`.
 *
 * Declared over an authenticated request whose `params` carry an `id`, so the
 * two steps it depends on — `authenticate` and the `validateParams` that proves
 * `id` is a string rather than Express 5's `string | string[]` — cannot be left
 * out or hoisted above it without failing to compile.
 *
 * It answers 403 and not 404 for someone else's id. Hiding existence behind a
 * 404 is the stronger posture in general and is the wrong trade here: the ids
 * are already handed out in the admin list and in every `user.*` event payload,
 * so a 404 would conceal nothing from anyone who can enumerate — while costing
 * a lookup of the row before the refusal, which is the request an unauthorised
 * caller should not be able to make the database do.
 */
export function requireSelfOrRoles(
  ...roles: string[]
): <TReq extends Authenticated<Request<{ id: string }>>>(req: TReq) => TReq {
  if (roles.length === 0) {
    // Same reasoning as `requireRoles`: an empty list reads at the call site as
    // "anybody", and means "the subject and nobody else". If that is what a
    // route wants it should say so with a step that has that name.
    throw new RangeError('requireSelfOrRoles: at least one role is required');
  }

  return <TReq extends Authenticated<Request<{ id: string }>>>(req: TReq): TReq => {
    authorizeSelfOrRoles(req.auth, req.params.id, roles);
    return req;
  };
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
