/**
 * Liveness and readiness.
 *
 * Two endpoints, because the right answer to "is this process alive" and "should
 * it be sent traffic" is opposite during a drain and during a dependency
 * outage — `health.router.ts` is where that argument lives, and it is the one
 * file to read first. `docs/health-checks.md` is the map.
 */

export type {
  CheckResult,
  CheckStatus,
  DependencyCheck,
  DependencyCriticality,
  HealthLogger,
  ReadinessReport,
  ReadinessStatus,
} from '@/health/health.types';

export { DuplicateHealthCheckError, HealthCheckTimeoutError } from '@/health/health.errors';

export type { RunCheckOptions } from '@/health/run-check';
export { runCheck, runChecks } from '@/health/run-check';

export type { ReadinessProbe, ReadinessProbeOptions } from '@/health/readiness';
export { createReadinessProbe, redactReport } from '@/health/readiness';

export {
  clearHealthChecks,
  registerHealthCheck,
  registeredHealthChecks,
} from '@/health/health.registry';

export { appReadinessProbe } from '@/health/app-health';

export type { HealthRouterOptions } from '@/health/health.router';
export { createHealthRouter } from '@/health/health.router';

export type { HealthPool, HealthPoolClient, PostgresCheckOptions } from '@/health/checks/postgres.check';
export { createPostgresCheck, POSTGRES_PING_SQL } from '@/health/checks/postgres.check';

export type { HealthRedis, RedisCheckOptions } from '@/health/checks/redis.check';
export { createRedisCheck } from '@/health/checks/redis.check';

export type { ProcessHealthCheckOptions } from '@/health/process-checks';
export { registerProcessHealthChecks } from '@/health/process-checks';
