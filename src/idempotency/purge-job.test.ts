const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@/db/pool', () => ({
  getPool: () => ({ connect: (...args: unknown[]) => mockConnect(...args) }),
}));

import type { Queryable } from '@/db/queryable';
import type { IdempotencyStore } from '@/idempotency/idempotency.types';
import {
  IDEMPOTENCY_PURGE_LOCK,
  runIdempotencyPurge,
  startIdempotencyPurgeJob,
} from '@/idempotency/purge-job';

/**
 * A store whose only interesting method is the sweep. The rest of the protocol
 * is not reachable from this module and is stubbed to fail loudly if it ever
 * becomes reachable by accident.
 */
function fakeStore(purgeExpired: jest.Mock): IdempotencyStore {
  const unreachable = (name: string) => (): never => {
    throw new Error(`purge job called ${name}`);
  };
  return {
    claim: unreachable('claim'),
    complete: unreachable('complete'),
    release: unreachable('release'),
    purgeExpired: purgeExpired as unknown as IdempotencyStore['purgeExpired'],
  };
}

function sqlSent(): string[] {
  return mockClientQuery.mock.calls.map((call) => String(call[0]));
}

/** Answers the `pg_try_advisory_xact_lock` probe; everything else is empty. */
function lockAvailable(acquired: boolean): void {
  mockClientQuery.mockImplementation(async (sql: string) =>
    sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ acquired }] } : { rows: [] },
  );
}

beforeEach(() => {
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  lockAvailable(true);
});

describe('IDEMPOTENCY_PURGE_LOCK', () => {
  it('is named rather than assembled from bare integers', () => {
    expect(IDEMPOTENCY_PURGE_LOCK).toMatchObject({
      namespace: 'boilerplate-express-ts',
      name: 'idempotency.purge',
    });
  });
});

describe('runIdempotencyPurge', () => {
  it('sweeps and reports the row count when it wins the lock', async () => {
    const purgeExpired = jest.fn().mockResolvedValue(12);

    await expect(runIdempotencyPurge(fakeStore(purgeExpired))).resolves.toEqual({
      outcome: 'purged',
      purged: 12,
    });
  });

  it('takes the lock non-blockingly, inside a transaction, before sweeping', async () => {
    const order: string[] = [];
    mockClientQuery.mockImplementation(async (sql: string) => {
      order.push(sql);
      return sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ acquired: true }] } : { rows: [] };
    });
    const purgeExpired = jest.fn().mockImplementation(async () => {
      order.push('purge');
      return 0;
    });

    await runIdempotencyPurge(fakeStore(purgeExpired));

    expect(order).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '5000ms'",
      'SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS acquired',
      'purge',
      'COMMIT',
    ]);
  });

  it('runs the delete on the locked transaction, not on the pool', async () => {
    const purgeExpired = jest.fn().mockResolvedValue(0);
    await runIdempotencyPurge(fakeStore(purgeExpired));

    // Handing the store the pool here would put the delete on a different
    // connection — outside the transaction whose lifetime *is* the lock.
    const executor: unknown = purgeExpired.mock.calls[0]?.[0];
    expect(executor).toBeDefined();
    await (executor as Queryable).query('SELECT 1');
    expect(sqlSent()).toContain('SELECT 1');
  });

  it('does nothing at all when another replica holds the lock', async () => {
    lockAvailable(false);
    const purgeExpired = jest.fn();

    await expect(runIdempotencyPurge(fakeStore(purgeExpired))).resolves.toEqual({
      outcome: 'skipped',
    });
    expect(purgeExpired).not.toHaveBeenCalled();
    // Still a clean transaction: a skip is a success, not a rollback.
    expect(sqlSent()).toContain('COMMIT');
  });

  it('honours an overridden lock timeout', async () => {
    await runIdempotencyPurge(fakeStore(jest.fn().mockResolvedValue(0)), { lockTimeoutMs: 250 });
    expect(sqlSent()).toContain("SET LOCAL lock_timeout = '250ms'");
  });

  it('rolls back and propagates when the sweep itself fails', async () => {
    const purgeExpired = jest.fn().mockRejectedValue(new Error('delete failed'));

    await expect(runIdempotencyPurge(fakeStore(purgeExpired))).rejects.toThrow('delete failed');
    expect(sqlSent()).toContain('ROLLBACK');
  });
});

describe('startIdempotencyPurgeJob', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects a non-positive interval instead of scheduling a hot loop', () => {
    const store = fakeStore(jest.fn());
    for (const intervalMs of [0, -1, 1.5]) {
      expect(() => startIdempotencyPurgeJob({ store, intervalMs })).toThrow(RangeError);
    }
  });

  it('does not sweep before the first interval elapses', () => {
    const purgeExpired = jest.fn().mockResolvedValue(0);
    startIdempotencyPurgeJob({ store: fakeStore(purgeExpired), intervalMs: 1000 });

    jest.advanceTimersByTime(999);
    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it('sweeps once per interval', async () => {
    const purgeExpired = jest.fn().mockResolvedValue(0);
    const onOutcome = jest.fn();
    const job = startIdempotencyPurgeJob({
      store: fakeStore(purgeExpired),
      intervalMs: 1000,
      onOutcome,
    });

    jest.advanceTimersByTime(1000);
    await job.stop();
    expect(onOutcome).toHaveBeenCalledWith({ outcome: 'purged', purged: 0 });
    expect(purgeExpired).toHaveBeenCalledTimes(1);
  });

  it('skips a tick rather than stacking a second sweep on top of a slow one', async () => {
    let finishSweep: (() => void) | undefined;
    const purgeExpired = jest.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSweep = () => resolve(0);
        }),
    );
    const job = startIdempotencyPurgeJob({ store: fakeStore(purgeExpired), intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    jest.advanceTimersByTime(3000);
    await flushMicrotasks();

    // The advisory lock cannot help here: a second tick on this replica would
    // check out a different pooled connection and win the lock legitimately.
    expect(purgeExpired).toHaveBeenCalledTimes(1);

    finishSweep?.();
    await job.stop();
  });

  it('reports a failure and keeps the schedule alive', async () => {
    const purgeExpired = jest
      .fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(3);
    const onError = jest.fn();
    const onOutcome = jest.fn();
    const job = startIdempotencyPurgeJob({
      store: fakeStore(purgeExpired),
      intervalMs: 1000,
      onOutcome,
      onError,
    });

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(onOutcome).toHaveBeenCalledWith({ outcome: 'purged', purged: 3 });

    await job.stop();
  });

  it('clears its interval on stop', () => {
    const job = startIdempotencyPurgeJob({
      store: fakeStore(jest.fn().mockResolvedValue(0)),
      intervalMs: 1000,
    });

    expect(jest.getTimerCount()).toBe(1);
    void job.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('unrefs the timer, so the janitor never decides when the process exits', () => {
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    startIdempotencyPurgeJob({
      store: fakeStore(jest.fn().mockResolvedValue(0)),
      intervalMs: 1000,
    });

    expect(unref).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('stops scheduling and waits for the sweep in flight', async () => {
    let finishSweep: (() => void) | undefined;
    const purgeExpired = jest.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSweep = () => resolve(1);
        }),
    );
    const onOutcome = jest.fn();
    const job = startIdempotencyPurgeJob({
      store: fakeStore(purgeExpired),
      intervalMs: 1000,
      onOutcome,
    });

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    finishSweep?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(onOutcome).toHaveBeenCalledWith({ outcome: 'purged', purged: 1 });

    jest.advanceTimersByTime(10_000);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
  });

  it('logs a sweep that removed rows and stays quiet otherwise', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const purgeExpired = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    const job = startIdempotencyPurgeJob({ store: fakeStore(purgeExpired), intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(logSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed 4'));

    await job.stop();
    logSpy.mockRestore();
  });
});

/**
 * Lets the sweep's promise chain settle. `advanceTimersByTime` fires the
 * callback synchronously, but everything it awaits is a microtask, and a single
 * `await` only drains one link of the chain.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}
