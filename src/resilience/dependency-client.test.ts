import { env } from '@/config/env';
import { createDependencyClient, envHttpClientDefaults } from '@/resilience/dependency-client';

describe('envHttpClientDefaults', () => {
  it('carries the configured policy through to a client', () => {
    const defaults = envHttpClientDefaults();

    expect(defaults.timeoutMs).toBe(env.HTTP_CLIENT_TIMEOUT_MS);
    expect(defaults.headersTimeoutMs).toBe(env.HTTP_CLIENT_HEADERS_TIMEOUT_MS);
    expect(defaults.bodyIdleTimeoutMs).toBe(env.HTTP_CLIENT_BODY_IDLE_TIMEOUT_MS);
    expect(defaults.bulkhead).toMatchObject({
      maxConcurrent: env.HTTP_CLIENT_BULKHEAD_MAX_CONCURRENT,
      maxQueue: env.HTTP_CLIENT_BULKHEAD_MAX_QUEUE,
      queueTimeoutMs: env.HTTP_CLIENT_BULKHEAD_QUEUE_TIMEOUT_MS,
    });
    expect(defaults.retry).toMatchObject({
      attempts: env.HTTP_CLIENT_RETRY_ATTEMPTS,
      baseDelayMs: env.HTTP_CLIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: env.HTTP_CLIENT_RETRY_MAX_DELAY_MS,
      maxRetryAfterMs: env.HTTP_CLIENT_MAX_RETRY_AFTER_MS,
    });
    expect(defaults.breaker).toMatchObject({
      windowMs: env.HTTP_CLIENT_BREAKER_WINDOW_MS,
      failureRateThreshold: env.HTTP_CLIENT_BREAKER_FAILURE_RATE,
      minimumThroughput: env.HTTP_CLIENT_BREAKER_MIN_THROUGHPUT,
      openMs: env.HTTP_CLIENT_BREAKER_OPEN_MS,
    });
  });

  it('leaves the shipped defaults sane against each other', () => {
    // The same five invariants `env.ts` refuses a deployment for, asserted
    // against the values a clean clone actually boots with — so the checked-in
    // defaults cannot drift into a combination the boot check would reject.
    expect(env.HTTP_CLIENT_RETRY_MAX_DELAY_MS).toBeGreaterThanOrEqual(
      env.HTTP_CLIENT_RETRY_BASE_DELAY_MS,
    );
    // A finer deadline above the whole-exchange budget is not a laxer timeout
    // but a dead one: the coarse deadline always fires first, so the instrument
    // an operator is relying on silently never runs.
    expect(env.HTTP_CLIENT_HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(env.HTTP_CLIENT_TIMEOUT_MS);
    expect(env.HTTP_CLIENT_BODY_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(env.HTTP_CLIENT_TIMEOUT_MS);
    expect(env.HTTP_CLIENT_BREAKER_WINDOW_MS).toBeGreaterThanOrEqual(
      env.HTTP_CLIENT_BREAKER_BUCKETS,
    );
    expect(env.HTTP_CLIENT_BREAKER_MIN_THROUGHPUT).toBeGreaterThanOrEqual(
      env.HTTP_CLIENT_RETRY_ATTEMPTS,
    );
  });
});

describe('createDependencyClient', () => {
  it('names the breaker after the dependency', () => {
    const client = createDependencyClient({ name: 'payments' });

    expect(client.name).toBe('payments');
    expect(client.breaker.name).toBe('payments');
    expect(client.breaker.state).toBe('closed');
  });

  it('gives each dependency its own breaker and its own bulkhead', () => {
    // One client per dependency, always: a single breaker in front of two
    // upstreams opens on the failures of the sick one and refuses calls to the
    // healthy one, which is a worse outage than the one it was containing. A
    // shared bulkhead has the same shape — a saturated dependency's backlog
    // would shed calls to a healthy one.
    const payments = createDependencyClient({ name: 'payments' });
    const search = createDependencyClient({ name: 'search' });

    expect(payments.breaker).not.toBe(search.breaker);
    expect(payments.bulkhead).not.toBe(search.bulkhead);
    expect(payments.bulkhead.name).toBe('payments');
  });

  it('merges a bulkhead override into the configured group', () => {
    const client = createDependencyClient({ name: 'payments', bulkhead: { maxConcurrent: 4 } });

    expect(client.bulkhead.stats()).toMatchObject({
      maxConcurrent: 4,
      // Not restated by the caller, so still the operator's.
      maxQueue: env.HTTP_CLIENT_BULKHEAD_MAX_QUEUE,
    });
  });

  it('merges an override into the group rather than replacing it', async () => {
    const calls: string[] = [];
    const client = createDependencyClient({
      name: 'payments',
      retry: { attempts: 2 },
      sleep: async () => {},
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(new Response('nope', { status: 503 }));
      },
    });

    await client.fetch('https://payments.test/charges');

    // `attempts` came from the caller; the base and max delays it did not
    // mention still came from the environment, so a caller that wants a longer
    // ladder does not have to restate the whole policy.
    expect(calls).toHaveLength(2);
  });
});
