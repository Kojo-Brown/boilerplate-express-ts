import type { Request, RequestHandler } from 'express';
import { AppError } from '@/lib/errors';
import type { RouteOperation } from '@/lib/route-decorators';
import {
  MemoryCacheStore,
  toRequestHandler,
  withCache,
  withRetry,
  withTimeout,
} from '@/lib/route-decorators';
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
 * Collaborators come out of the request scope rather than a module import.
 *
 * The repository is a container singleton, so this is the same object every
 * time; the point is that its lifetime is declared in one file instead of being
 * whatever `new UserRepository()` at module scope happened to mean.
 */
const listUsers: RouteOperation<UserRow[]> = async (req) =>
  scopeOf(req).resolve(USER_REPOSITORY).findAll({ orderBy: 'created_at', order: 'ASC' });

const getUser: RouteOperation<UserRow, Request<UserIdParams>> = async (req) => {
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
const createUser: RouteOperation<UserRow, Request<Record<string, string>, unknown, CreateUserBody>> =
  async (req) => {
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

const updateUser: RouteOperation<UserRow, Request<UserIdParams, unknown, UpdateUserBody>> = async (
  req,
) => {
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

const removeUser: RouteOperation<void, Request<UserIdParams>> = async (req) => {
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
 * Transport only. Params and bodies arrive already parsed by `validate()` on
 * the router, so nothing here re-derives them or hand-rolls a 422; the
 * operations above never touch `res`, so the decorators around them are free
 * to re-run or replay their results.
 *
 * Writes get a deadline but no retry. `PUT` and `DELETE` are idempotent enough
 * for `withRetry` to replay by default, and that is exactly the trap: a delete
 * whose first attempt commits and then loses the connection would answer 404
 * on the retry, reporting failure for work that succeeded. Replaying a write
 * safely needs a deduplication key, not a retry loop.
 */
export const usersController: Record<
  'list' | 'getById' | 'create' | 'update' | 'remove',
  RequestHandler
> = {
  list: toRequestHandler(cachedRead(listUsers, 'User list')),
  getById: toRequestHandler(cachedRead(getUser, 'User lookup')),
  create: toRequestHandler(withTimeout(createUser, { ms: USER_QUERY_TIMEOUT_MS }), { status: 201 }),
  update: toRequestHandler(withTimeout(updateUser, { ms: USER_QUERY_TIMEOUT_MS })),
  remove: toRequestHandler(withTimeout(removeUser, { ms: USER_QUERY_TIMEOUT_MS }), { status: 204 }),
};
