import { withAbort } from '@/health/with-abort';
import type { DependencyCheck, DependencyCriticality } from '@/health/health.types';

/** The one command this check needs, so a test can supply a connection that is not one. */
export interface HealthRedis {
  ping(): Promise<unknown>;
}

export interface RedisCheckOptions {
  readonly client: () => HealthRedis;
  readonly name?: string;
  readonly criticality?: DependencyCriticality;
}

/**
 * Readiness for Redis — `optional` by default, and that default is the whole
 * design decision.
 *
 * Redis carries outbound domain events in this service and nothing on the
 * request path. A request that publishes an event writes it into
 * `outbox_messages` inside its own transaction and returns; the relay picks it
 * up afterwards. So with Redis unreachable every endpoint still answers
 * correctly, and the only consequence is that delivery waits — which is what
 * the outbox exists to make survivable.
 *
 * Marking it `critical` therefore fails every replica's readiness at once and
 * empties the load balancer, turning "events are late" into "the API is gone".
 * The test for whether a dependency belongs in the critical set is whether
 * routing the request to a *different* replica would help; for a shared Redis
 * the answer is no, for every replica, which is the definition of a dependency
 * a readiness probe must not gate on.
 *
 * What the check is for, then, is the `degraded` status: 200, still in the
 * pool, and an unmistakable signal for an alert to fire on.
 *
 * `enableOfflineQueue: false` on the connection is what makes this fast when it
 * matters — a PING issued while the socket is down is rejected immediately
 * rather than queued, so a Redis outage costs the probe a rejection instead of
 * its whole deadline.
 */
export function createRedisCheck(options: RedisCheckOptions): DependencyCheck {
  const { client, name = 'redis', criticality = 'optional' } = options;

  return {
    name,
    criticality,
    async run(signal: AbortSignal): Promise<void> {
      // `ioredis` has no way to withdraw a command it has already written, so
      // the deadline stops the waiting and the reply is discarded when it
      // arrives. Nothing is held open by that: unlike a pooled Postgres client,
      // an unread PONG on a shared connection costs one reply frame.
      await withAbort(client().ping(), signal);
    },
  };
}
