import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import type { Authenticated } from '@/lib/pipeline';
import type { RouteOperation } from '@/lib/route-decorators';
import { MemoryCacheStore, withCache, withRetry, withTimeout } from '@/lib/route-decorators';
import { EVENT_BUS, REQUEST_CONTEXT, USER_REPOSITORY } from '@/container/tokens';
import { scopeOf } from '@/middleware/container.middleware';
import type { UserRow } from '@/users/users.repository';
import type { CreateUserBody, UpdateUserBody, UserIdParams } from '@/users/users.schemas';

/** A query that has not answered in two seconds is holding a pooled connection
 * a live request will never use. Fail it and let the pool recover. */
const USER_QUERY_TIMEOUT_MS = 2_000;

/** Three tries covers a pool hiccup or a failover; more just delays the 500. */
const USER_QUERY_ATTEMPTS = 3;

/**
 * Short on purpose. `MemoryCacheStore` is per-replica, so a write invalidates
 * one process and the others serve stale rows until their entries expire —
 * five seconds is the window a second replica can be wrong for.
 */
const USERS_CACHE_TTL_MS = 5_000;

/**
 * One store for the whole resource, which makes `clear()` the invalidation
 * boundary: every write below drops the reads. Exported so tests can start
 * from a cold cache, the same way `resetRateLimiters` exists.
 */
export const usersCache = new MemoryCacheStore({ maxEntries: 200 });

/**
 * The read stack, outermost first: cache, then retry, then a deadline *per
 * attempt*. A hit costs nothing below it; a miss gets three chances at two
 * seconds each rather than one shared budget.
 */
function cachedRead<TResult, TReq extends Request>(
  operation: RouteOperation<TResult, TReq>,
  label: string,
): RouteOperation<TResult, TReq> {
  return withCache(
    withRetry(withTimeout(operation, { ms: USER_QUERY_TIMEOUT_MS, label }), {
      attempts: USER_QUERY_ATTEMPTS,
    }),
    { ttlMs: USERS_CACHE_TTL_MS, namespace: 'users', store: usersCache },
  );
}

/**
 * What each route's pipeline has established by the time its operation runs.
 *
 * Exported because these are the contract between `users.router.ts` and the
 * operations below: the router has to build a pipeline that produces one of
 * these, and it cannot do that without the steps that make each claim true.
 */
export type ListUsersRequest = Authenticated<Request>;
export type GetUserRequest = Authenticated<Request<UserIdParams>>;
export type CreateUserRequest = Authenticated<
  // `Request['params']` rather than the `Record<string, string>` this declared
  // before: Express 5 types a route parameter as `string | string[]`, because a
  // pattern can bind the same name twice. Nothing checked the difference while
  // `toRequestHandler`'s cast stood between the router and this signature; the
  // pipeline checks it, and the route has no parameters to narrow anyway.
  Request<Request['params'], unknown, CreateUserBody>
>;
export type UpdateUserRequest = Authenticated<Request<UserIdParams, unknown, UpdateUserBody>>;

/**
 * Collaborators come out of the request scope rather than a module import.
 *
 * The repository is a container singleton, so this is the same object every
 * time; the point is that its lifetime is declared in one file instead of being
 * whatever `new UserRepository()` at module scope happened to mean.
 */
const listUsers: RouteOperation<UserRow[], ListUsersRequest> = async (req) =>
  scopeOf(req).resolve(USER_REPOSITORY).findAll({ orderBy: 'created_at', order: 'ASC' });

const getUser: RouteOperation<UserRow, GetUserRequest> = async (req) => {
  const user = await scopeOf(req).resolve(USER_REPOSITORY).findById(req.params.id);
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
  return user;
};

/**
 * Cache invalidation stays here, inline, and is deliberately *not* a subscriber.
 *
 * The bus isolates handler failures by design, so an invalidation that failed
 * as a subscriber would be logged and the write would still answer 200 — with
 * this replica serving the row it just changed for the rest of the TTL. That is
 * a correctness consequence of the write, so it belongs on the write's own
 * error path. Events carry the consequences the publisher can afford to lose.
 */
const createUser: RouteOperation<UserRow, CreateUserRequest> = async (req) => {
  const scope = scopeOf(req);
  const context = scope.resolve(REQUEST_CONTEXT);

  const user = await scope.resolve(USER_REPOSITORY).create(req.body);
  await usersCache.clear();

  await scope.resolve(EVENT_BUS).publish(
    'user.created',
    {
      userId: user.id,
      email: user.email,
      roles: user.roles,
      actorId: context.actorId,
    },
    { correlationId: context.correlationId },
  );

  return user;
};

const updateUser: RouteOperation<UserRow, UpdateUserRequest> = async (req) => {
  const scope = scopeOf(req);
  const context = scope.resolve(REQUEST_CONTEXT);

  const user = await scope.resolve(USER_REPOSITORY).update(req.params.id, req.body);
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
  await usersCache.clear();

  await scope.resolve(EVENT_BUS).publish(
    'user.updated',
    {
      userId: user.id,
      // The request's keys, not a diff against the previous row: this says what
      // the caller asked to change, which is the question an audit trail is
      // actually asked. A field set to the value it already held still
      // represents someone reaching for it.
      changedFields: Object.keys(req.body),
      actorId: context.actorId,
    },
    { correlationId: context.correlationId },
  );

  return user;
};

const removeUser: RouteOperation<void, GetUserRequest> = async (req) => {
  const scope = scopeOf(req);
  const context = scope.resolve(REQUEST_CONTEXT);

  const deleted = await scope.resolve(USER_REPOSITORY).delete(req.params.id);
  if (!deleted) throw new AppError(404, 'User not found', 'NOT_FOUND');
  await usersCache.clear();

  // Awaited rather than fired and forgotten. `publish` cannot reject, so this
  // costs nothing but ordering — and the ordering matters: the 204 should not
  // be on the wire before the subscriber that revokes the deleted user's
  // refresh tokens has had its turn.
  await scope.resolve(EVENT_BUS).publish(
    'user.deleted',
    { userId: req.params.id, actorId: context.actorId },
    { correlationId: context.correlationId },
  );
};

/**
 * Decorated operations, not Express handlers.
 *
 * This used to export `RequestHandler`s built here with `toRequestHandler`,
 * which meant the request type each operation was written against — parsed
 * params, a parsed body, a principal — was erased at this line and re-asserted
 * inside the adapter. The router then had to be trusted to put the matching
 * `validate()` and `requireAuth` above it. Handing the pipeline an operation
 * instead moves that adapter to the end of the chain that establishes those
 * things, so `UpdateUserRequest` and its siblings above became a requirement
 * the wiring has to satisfy rather than a claim it makes.
 *
 * Writes get a deadline but no retry. `PUT` and `DELETE` are idempotent enough
 * for `withRetry` to replay by default, and that is exactly the trap: a delete
 * whose first attempt commits and then loses the connection would answer 404
 * on the retry, reporting failure for work that succeeded. Replaying a write
 * safely needs a deduplication key, not a retry loop.
 */
export interface UsersOperations {
  list: RouteOperation<UserRow[], ListUsersRequest>;
  getById: RouteOperation<UserRow, GetUserRequest>;
  create: RouteOperation<UserRow, CreateUserRequest>;
  update: RouteOperation<UserRow, UpdateUserRequest>;
  remove: RouteOperation<void, GetUserRequest>;
}

export const usersOperations: UsersOperations = {
  list: cachedRead(listUsers, 'User list'),
  getById: cachedRead(getUser, 'User lookup'),
  create: withTimeout(createUser, { ms: USER_QUERY_TIMEOUT_MS }),
  update: withTimeout(updateUser, { ms: USER_QUERY_TIMEOUT_MS }),
  remove: withTimeout(removeUser, { ms: USER_QUERY_TIMEOUT_MS }),
};
