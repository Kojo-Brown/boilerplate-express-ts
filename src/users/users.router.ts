import { Router } from 'express';
import { usersOperations } from '@/users/users.controller';
import {
  createUserBodySchema,
  updateUserBodySchema,
  userIdParamsSchema,
} from '@/users/users.schemas';
import { idempotent } from '@/idempotency';
import { compose } from '@/lib/pipeline';
import { validateBody, validateParams } from '@/middleware/validate.middleware';
import { authenticate, requireRoles } from '@/middleware/auth.middleware';

const router: Router = Router();

/**
 * Two named chains instead of a middleware array repeated on every line.
 *
 * `use` returns a new pipeline rather than mutating this one, so branching off
 * `authenticated` below cannot reach back and add a step to `adminOnly`.
 */
const authenticated = compose().use(authenticate);
const adminOnly = authenticated.use(requireRoles('admin'));

/**
 * The comment that used to live here — "auth stays ahead of validation so an
 * unauthenticated caller gets 401/403 without learning anything about the
 * accepted request shape" — is now the type. `requireRoles` is declared over an
 * authenticated request, so hoisting it above `authenticate` fails to compile,
 * and `usersOperations.getById` is declared over a request whose params were
 * parsed, so dropping the `validateParams` below fails to compile too.
 *
 * The chain is also the last thing to run before the operation, which is what
 * lets `handle` hand the operation a request whose type has actually been
 * established rather than one asserted at the edge and hoped for here.
 */
router.get('/', adminOnly.handle(usersOperations.list));

router.get(
  '/:id',
  authenticated.use(validateParams(userIdParamsSchema)).handle(usersOperations.getById),
);

/**
 * The one route here that is not idempotent by its HTTP method, and therefore
 * the one that needs a key to become so: a retried `POST /v1/users` creates a
 * second user, where a retried `PUT` or `DELETE` converges on the same state.
 * That is also why `usersOperations.create` gets a timeout but no `withRetry` —
 * a retry loop cannot replay a write safely, and this is what can.
 *
 * `idempotent()` sits after `requireRoles` because the key is scoped by the
 * principal, and before `validateBody` because the fingerprint should be taken
 * over the body as it arrived: a retry of a request the schema rejected then
 * replays that 422 instead of re-deriving it.
 */
router.post(
  '/',
  adminOnly
    .use(idempotent())
    .use(validateBody(createUserBodySchema))
    .handle(usersOperations.create, { status: 201 }),
);

router.put(
  '/:id',
  authenticated
    .use(validateParams(userIdParamsSchema))
    .use(validateBody(updateUserBodySchema))
    .handle(usersOperations.update),
);

router.delete(
  '/:id',
  adminOnly.use(validateParams(userIdParamsSchema)).handle(usersOperations.remove, { status: 204 }),
);

export { router as usersRouter };
