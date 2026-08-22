import type { Request } from 'express';
import type { InjectionToken } from '@/lib/container';
import { createToken } from '@/lib/container';
import type { RequestContext } from '@/container/request-context';
import type { DomainEventBus } from '@/events';
import type { IdempotencyStore } from '@/idempotency/idempotency.types';
import type { UserRepository } from '@/users/users.repository';
import type { CpuTasks } from '@/workers/cpu.tasks';
import type { WorkerPool } from '@/workers/worker-pool';

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

/**
 * The thread pool CPU-bound work runs on.
 *
 * A singleton because threads are a process-wide resource — a pool per request
 * would spawn and destroy OS threads per request, which costs more than the
 * work it was meant to move off the loop — and resolved through the container
 * rather than imported as a module-level instance so that its `drain()` is
 * reached by `dispose()` instead of by every caller remembering to.
 *
 * Typed as the class rather than an interface, because it is generic over its
 * task map and that is the whole point: `pool.run('digest', payload)` is
 * checked against `CpuTasks`, so a renamed task or a changed payload is a
 * compile error at the call site instead of an `UNKNOWN_WORKER_TASK` in
 * production.
 */
export const CPU_WORKER_POOL: InjectionToken<WorkerPool<CpuTasks>> =
  createToken<WorkerPool<CpuTasks>>('WorkerPool<CpuTasks>');
