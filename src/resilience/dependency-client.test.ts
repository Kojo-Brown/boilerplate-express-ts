import { env } from '@/config/env';
import { createDependencyClient, envHttpClientDefaults } from '@/resilience/dependency-client';

describe('envHttpClientDefaults', () => {
  it('carries the configured policy through to a client', () => {
    const defaults = envHttpClientDefaults();

    expect(defaults.timeoutMs).toBe(env.HTTP_CLIENT_TIMEOUT_MS);
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
    // The same three invariants `env.ts` refuses a deployment for, asserted
    // against the values a clean clone actually boots with — so the checked-in
    // defaults cannot drift into a combination the boot check would reject.
    expect(env.HTTP_CLIENT_RETRY_MAX_DELAY_MS).toBeGreaterThanOrEqual(
      env.HTTP_CLIENT_RETRY_BASE_DELAY_MS,
    );
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

  it('gives each dependency its own breaker', () => {
    // One client per dependency, always: a single breaker in front of two
    // upstreams opens on the failures of the sick one and refuses calls to the
    // healthy one, which is a worse outage than the one it was containing.
    const payments = createDependencyClient({ name: 'payments' });
    const search = createDependencyClient({ name: 'search' });

    expect(payments.breaker).not.toBe(search.breaker);
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
