import { createPostgresCheck } from '@/health/checks/postgres.check';
import type { HealthPool } from '@/health/checks/postgres.check';
import { createRedisCheck } from '@/health/checks/redis.check';
import { registerHealthCheck } from '@/health/health.registry';

export interface ProcessHealthCheckOptions {
  /** The application's own pool, as a thunk — see `PostgresCheckOptions`. */
  readonly pool: () => HealthPool;
  /**
   * The outbox's Redis connection, when this deployment has one.
   *
   * `undefined` for `OUTBOX_DISPATCH_TARGET=bus`, which never speaks to Redis:
   * registering a check there would report on a dependency the process does not
   * have, and opening a connection to satisfy the check would create one.
   */
  readonly redisPing?: (() => Promise<unknown>) | undefined;
}

/**
 * The checks a *running process* registers, as one function so that the wiring
 * is testable without starting a server.
 *
 * It exists because the failure mode of forgetting to register is a readiness
 * endpoint that answers `ok` to everything, forever, with nothing logged and
 * nothing red — the one bug in a health subsystem that cannot be noticed by
 * looking at it. `process-checks.test.ts` is what turns that into a failing
 * test: it asserts the set, and the criticality of each member.
 *
 * Called from `server.ts` and nowhere else. `createApp()` must not call it: an
 * app built by an e2e suite would then open a pool client on every probe.
 */
export function registerProcessHealthChecks(options: ProcessHealthCheckOptions): void {
  const { pool, redisPing } = options;

  registerHealthCheck(createPostgresCheck({ pool }));

  if (redisPing !== undefined) {
    registerHealthCheck(createRedisCheck({ client: () => ({ ping: redisPing }) }));
  }
}
