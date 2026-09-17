import { createRedisCheck } from '@/health/checks/redis.check';
import { runCheck } from '@/health/run-check';

const never = new AbortController().signal;

describe('createRedisCheck', () => {
  it('is optional by default, and that default is the design', () => {
    // Redis carries outbound domain events here and nothing on the request
    // path: the API writes into `outbox_messages` in the request's own
    // transaction and the relay delivers afterwards. Critical would take every
    // replica out of the load balancer for a fault that moving traffic to
    // another replica cannot route around.
    expect(createRedisCheck({ client: () => ({ ping: () => Promise.resolve('PONG') }) })).toMatchObject({
      name: 'redis',
      criticality: 'optional',
    });
  });

  it('can be made critical by a deployment that genuinely depends on it', () => {
    // A deployment serving reads out of Redis is a different service from this
    // one, and the classification belongs to the deployment rather than here.
    expect(
      createRedisCheck({
        client: () => ({ ping: () => Promise.resolve('PONG') }),
        criticality: 'critical',
      }).criticality,
    ).toBe('critical');
  });

  it('passes when the connection answers', async () => {
    let pings = 0;
    const check = createRedisCheck({
      client: () => ({
        ping: () => {
          pings += 1;
          return Promise.resolve('PONG');
        },
      }),
    });

    await expect(check.run(never)).resolves.toBeUndefined();
    expect(pings).toBe(1);
  });

  it('fails fast rather than waiting out the deadline when the socket is down', async () => {
    // `enableOfflineQueue: false` on the connection is what makes this true: a
    // command issued while disconnected is rejected instead of queued, so a
    // Redis outage costs the probe a rejection rather than its whole budget.
    const check = createRedisCheck({
      client: () => ({ ping: () => Promise.reject(new Error("Stream isn't writeable")) }),
    });

    const result = await runCheck(check, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ name: 'redis', criticality: 'optional', status: 'failed' });
    expect(result.error).toContain("Stream isn't writeable");
    // The point of the assertion: nowhere near the 5s budget.
    expect(result.durationMs).toBeLessThan(1_000);
  });

  it('stops waiting when the deadline expires and a reply never comes', async () => {
    const check = createRedisCheck({
      client: () => ({
        ping: () =>
          new Promise(() => {
            /* a connection that accepted the command and went quiet */
          }),
      }),
    });

    const result = await runCheck(check, { timeoutMs: 20 });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('did not answer within 20ms');
  });

  it('resolves the connection lazily, per check', async () => {
    // So that a reconnecting client is re-read rather than captured once.
    let resolutions = 0;
    const check = createRedisCheck({
      client: () => {
        resolutions += 1;
        return { ping: () => Promise.resolve('PONG') };
      },
    });

    expect(resolutions).toBe(0);
    await check.run(never);
    await check.run(never);
    expect(resolutions).toBe(2);
  });
});
