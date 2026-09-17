import { clearHealthChecks, registeredHealthChecks } from '@/health/health.registry';
import { registerProcessHealthChecks } from '@/health/process-checks';
import type { HealthPool } from '@/health/checks/postgres.check';

const pool = (): HealthPool => ({
  connect: () =>
    Promise.resolve({
      query: () => Promise.resolve(),
      release: () => {},
    }),
});

/**
 * The set a running process registers.
 *
 * Worth a test of its own because the failure mode of getting it wrong is the
 * one bug in a health subsystem that nobody notices: a readiness endpoint that
 * answers `ok` to everything, forever, with nothing logged and nothing red.
 */
describe('registerProcessHealthChecks', () => {
  afterEach(() => {
    clearHealthChecks();
  });

  it('registers Postgres as critical', () => {
    registerProcessHealthChecks({ pool });

    expect(registeredHealthChecks().map((check) => [check.name, check.criticality])).toEqual([
      ['postgres', 'critical'],
    ]);
  });

  it('registers Redis as optional when the process holds a connection', () => {
    registerProcessHealthChecks({ pool, redisPing: () => Promise.resolve('PONG') });

    expect(registeredHealthChecks().map((check) => [check.name, check.criticality])).toEqual([
      ['postgres', 'critical'],
      ['redis', 'optional'],
    ]);
  });

  it('leaves Redis out when the process never opened one', () => {
    // `OUTBOX_DISPATCH_TARGET=bus` is the default and speaks to no Redis at all.
    // Registering a check there would report on a dependency the process does
    // not have, and opening a connection to satisfy it would create one.
    registerProcessHealthChecks({ pool, redisPing: undefined });

    expect(registeredHealthChecks().map((check) => check.name)).toEqual(['postgres']);
  });

  it('does not connect to anything at registration time', async () => {
    let connects = 0;
    registerProcessHealthChecks({
      pool: () => ({
        connect: () => {
          connects += 1;
          return Promise.resolve({ query: () => Promise.resolve(), release: () => {} });
        },
      }),
    });

    expect(connects).toBe(0);

    // ...and does when something asks.
    await registeredHealthChecks()[0]?.run(new AbortController().signal);
    expect(connects).toBe(1);
  });
});
