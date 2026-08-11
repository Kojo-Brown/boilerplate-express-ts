import type { Container } from '@/lib/container';
import { createContainer } from '@/lib/container';
import { EVENT_BUS, REQUEST, REQUEST_CONTEXT, USER_REPOSITORY } from '@/container/tokens';
import { createRequestContext } from '@/container/request-context';
import { domainEventBus } from '@/events';
import { UserRepository } from '@/users/users.repository';

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
