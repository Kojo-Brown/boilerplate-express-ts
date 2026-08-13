import type { Request } from 'express';
import type { InjectionToken } from '@/lib/container';
import { createToken } from '@/lib/container';
import type { RequestContext } from '@/container/request-context';
import type { DomainEventBus } from '@/events';
import type { IdempotencyStore } from '@/idempotency/idempotency.types';
import type { UserRepository } from '@/users/users.repository';

/**
 * Every token this service resolves, in one file.
 *
 * Tokens live apart from the registrations that fill them so a consumer can
 * import the key without importing the graph — `users.controller.ts` needs
 * `USER_REPOSITORY`, not `pg`, not the event bus, and not whatever the
 * composition root will register next month.
 */

/**
 * The live HTTP request. Seeded per scope by `containerMiddleware`; no factory
 * could construct it.
 *
 * Annotated rather than inferred: `Request` is generic over four parameters
 * from `@types/express-serve-static-core` and `@types/qs`, and `declaration:
 * true` cannot name them from here.
 */
export const REQUEST: InjectionToken<Request> = createToken<Request>('express.Request');

/** Derived from `REQUEST`, one per request. */
export const REQUEST_CONTEXT: InjectionToken<RequestContext> =
  createToken<RequestContext>('RequestContext');

export const USER_REPOSITORY: InjectionToken<UserRepository> =
  createToken<UserRepository>('UserRepository');

export const EVENT_BUS: InjectionToken<DomainEventBus> =
  createToken<DomainEventBus>('DomainEventBus');

/**
 * Where `Idempotency-Key` claims are recorded.
 *
 * Typed as the interface rather than the Postgres class on purpose: the routes
 * that depend on it depend on the protocol, and a test that swaps in the
 * in-memory implementation is then a registration, not a monkey-patch.
 */
export const IDEMPOTENCY_STORE: InjectionToken<IdempotencyStore> =
  createToken<IdempotencyStore>('IdempotencyStore');
