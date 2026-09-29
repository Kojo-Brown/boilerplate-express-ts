import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import type { Authenticated } from '@/lib/pipeline';
import { ADMIN_ROLE } from '@/users/users.repository';
import type { UpdateUserBody } from '@/users/users.schemas';

/**
 * Property-level authorization for `PUT /v1/users/:id`: `roles` is an
 * administrator's field, whoever owns the row.
 *
 * This is the half of the update path that object-level authorization cannot
 * cover, and leaving it out would make the object-level check worse than
 * useless. `requireSelfOrRoles` lets a caller edit *their own* record, which is
 * the behaviour anybody would want and the reason not to make the route
 * admin-only — and `updateUserBodySchema` accepts `roles`, so the first thing
 * an ordinary user could do with that permission is `PUT /v1/users/<self>`
 * with `{"roles":["admin"]}`. A privilege escalation reachable from any valid
 * token, through the route added to restrict access.
 *
 * OWASP files this apart from API1 for the same reason it is a separate step
 * here: object-level authorization asks *which rows* a caller may write, and
 * this asks *which columns of them*. A design that answers only the first is
 * the mass-assignment bug, and it does not look like a bug at either call site.
 *
 * The check is on the field being *present*, not on it changing the value.
 * "Set `roles` to what it already is" cannot be told apart from an escalation
 * attempt without reading the row first — a query an unauthorised write should
 * not get to make — and the no-op it refuses costs a legitimate client nothing:
 * every client that has a reason to send `roles` is an administrator.
 */
export function requireAdminToAssignRoles<
  TReq extends Authenticated<Request<{ id: string }, unknown, UpdateUserBody>>,
>(req: TReq): TReq {
  if (req.body.roles === undefined) return req;

  if (!req.auth.roles.includes(ADMIN_ROLE)) {
    throw new AppError(403, 'Only an administrator may assign roles', 'FORBIDDEN');
  }

  return req;
}
