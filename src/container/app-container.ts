import type { Container } from '@/lib/container';
import { createContainer } from '@/lib/container';
import {
  CPU_WORKER_POOL,
  EVENT_BUS,
  IDEMPOTENCY_STORE,
  OUTBOX,
  REQUEST,
  REQUEST_CONTEXT,
  USER_REPOSITORY,
} from '@/container/tokens';
import { createRequestContext } from '@/container/request-context';
import { env } from '@/config/env';
import { domainEventBus } from '@/events';
import { PostgresIdempotencyStore } from '@/idempotency';
import { PostgresOutboxStore } from '@/outbox';
import { UserRepository } from '@/users/users.repository';
import { createCpuWorkerPool } from '@/workers/cpu-pool';

/**
 * The composition root: the only file that knows what fills each token.
 *
 * Exported as a function so tests can build a container that is not the
 * process-wide one — the alternative is a `reset()` that every suite has to
 * remember to call, and that one suite eventually forgets.
 */
export function registerAppDependencies(container: Container): Container {
  return (
    container
      /**
       * Stateless and shared. It was a module-level `new UserRepository()`
       * before this, which is the same instance count and none of the
       * guarantees: nothing said whether it could hold per-request state, and
       * nothing would have complained when it started to.
       */
      .registerSingleton(USER_REPOSITORY, () => new UserRepository())

      /**
       * A value, not a singleton factory, because the container did not create
       * it: `domain-events.ts` builds the bus at import time and `app.ts`
       * attaches subscribers to *that* object before any request arrives.
       * Registering it as a value says the container may hand it out and may
       * not close it.
       */
      .registerValue(EVENT_BUS, domainEventBus)

      /**
       * Stateless, like every other store here: it holds a uuid generator and
       * the SQL, and the state is the table. A singleton so the enqueue a
       * controller reaches for and the claim the relay reaches for are the same
       * object, which matters only for the reason all of this does — a test
       * that substitutes one substitutes both.
       */
      .registerSingleton(OUTBOX, () => new PostgresOutboxStore())

      /**
       * Stateless like the repository — the state is the table — so one
       * instance, configured once from the environment. Retention and lease
       * are operational numbers rather than code constants: how long a
       * response stays replayable is a data-retention decision, and the lease
       * has to be raised by whoever knows how slow the slowest guarded route
       * is allowed to be.
       */
      .registerSingleton(
        IDEMPOTENCY_STORE,
        () =>
          new PostgresIdempotencyStore({
            retentionMs: env.IDEMPOTENCY_RETENTION_SECONDS * 1000,
            leaseMs: env.IDEMPOTENCY_LEASE_SECONDS * 1000,
          }),
      )

      /**
       * Threads, so it is a singleton — and the first registration here that
       * owns an OS resource, so it is the first with a `dispose`.
       *
       * `drain()` rather than `terminate()`: disposal happens at shutdown, and
       * a queued task is a request whose client is still waiting. Discarding
       * it would turn every in-flight upload on a replaced instance into a 503
       * during exactly the rolling deploy that was supposed to be invisible.
       *
       * Constructing the pool is free — `WorkerPool` spawns threads lazily on
       * the first task — so resolving this token on a request that turns out
       * to be below the offload threshold costs nothing, and a deployment that
       * never uploads anything large never starts a thread.
       */
      .registerSingleton(CPU_WORKER_POOL, () => createCpuWorkerPool(), {
        dispose: (pool) => pool.drain(),
      })

      /** Seeded by `containerMiddleware`; see `REQUEST`. */
      .registerSeed(REQUEST)

      .registerScoped(REQUEST_CONTEXT, (resolve) => createRequestContext(resolve.resolve(REQUEST)))
  );
}

/**
 * The container the running service uses.
 *
 * Nothing is registered `transient` today, and that is a finding rather than an
 * omission: a transient earns its keep when instances accumulate per-use state
 * that must not be shared — a query builder, a retry budget — and every
 * collaborator here is either stateless, where a singleton is strictly cheaper,
 * or per-request, which is what `scoped` means.
 *
 * `dispose()` is deliberately not wired to a signal handler here. Draining the
 * server and closing the pool is its own spec item, and a container that closed
 * the pool while requests were still in flight would be the bug that item
 * exists to prevent.
 */
export const appContainer: Container = registerAppDependencies(createContainer({ name: 'app' }));
