import { env } from '@/config/env';
import { createHttpClient } from '@/resilience/http-client';
import type { HttpClient, HttpClientOptions } from '@/resilience/http-client';

/**
 * The service-wide defaults, as an operator can change them without a deploy.
 *
 * Separated from `createHttpClient` rather than read inside it, and the reason
 * is the same one that keeps `env` out of every other mechanism here: a client
 * that reached for `env` itself could not be constructed twice with different
 * policies in one process, which is precisely what a service with a fast
 * dependency and a slow one needs — and its tests would be configuring the
 * global environment to exercise a backoff.
 */
export function envHttpClientDefaults(): Pick<
  HttpClientOptions,
  'timeoutMs' | 'retry' | 'breaker'
> {
  return {
    timeoutMs: env.HTTP_CLIENT_TIMEOUT_MS,
    retry: {
      attempts: env.HTTP_CLIENT_RETRY_ATTEMPTS,
      baseDelayMs: env.HTTP_CLIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: env.HTTP_CLIENT_RETRY_MAX_DELAY_MS,
      maxRetryAfterMs: env.HTTP_CLIENT_MAX_RETRY_AFTER_MS,
      drainBytes: env.HTTP_CLIENT_DRAIN_BYTES,
    },
    breaker: {
      windowMs: env.HTTP_CLIENT_BREAKER_WINDOW_MS,
      bucketCount: env.HTTP_CLIENT_BREAKER_BUCKETS,
      failureRateThreshold: env.HTTP_CLIENT_BREAKER_FAILURE_RATE,
      minimumThroughput: env.HTTP_CLIENT_BREAKER_MIN_THROUGHPUT,
      openMs: env.HTTP_CLIENT_BREAKER_OPEN_MS,
      halfOpenProbes: env.HTTP_CLIENT_BREAKER_HALF_OPEN_PROBES,
      halfOpenSuccessThreshold: env.HTTP_CLIENT_BREAKER_HALF_OPEN_SUCCESSES,
    },
  };
}

/**
 * A client for one named dependency, on the service defaults.
 *
 * One client per dependency and never one shared client, because the breaker is
 * the client: a single instance in front of two upstreams opens on the failures
 * of the sick one and refuses calls to the healthy one, which is a worse outage
 * than the one it was containing.
 *
 * Overrides are shallow-merged per group, so a caller that wants a longer
 * ladder does not have to restate the breaker.
 */
export function createDependencyClient(
  options: HttpClientOptions & { readonly name: string },
): HttpClient {
  const defaults = envHttpClientDefaults();
  return createHttpClient({
    ...defaults,
    ...options,
    retry: { ...defaults.retry, ...options.retry },
    breaker: { ...defaults.breaker, ...options.breaker },
  });
}
