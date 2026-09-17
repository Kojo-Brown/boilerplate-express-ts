import { env } from '@/config/env';
import { registeredHealthChecks } from '@/health/health.registry';
import { createReadinessProbe } from '@/health/readiness';
import type { ReadinessProbe } from '@/health/readiness';

/**
 * This process's readiness probe, as a singleton.
 *
 * A singleton for the reason `appLifecycle` is one: the cache and the
 * single-flight only do their jobs if every poller arrives at the *same* probe.
 * Two instances would be two caches, two concurrent evaluations, and twice the
 * pool clients taken during the incident the single-flight exists for.
 *
 * Kept apart from `createReadinessProbe` so that every test in this directory
 * can drive a probe of its own, over its own checks and its own clock, without
 * touching the one the running process answers from.
 */
export const appReadinessProbe: ReadinessProbe = createReadinessProbe({
  // The registry read lazily, per evaluation — `server.ts` registers after
  // `createApp()` has already built the router. See `ReadinessProbeOptions`.
  checks: registeredHealthChecks,
  timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  cacheTtlMs: env.HEALTH_CACHE_TTL_MS,
});
