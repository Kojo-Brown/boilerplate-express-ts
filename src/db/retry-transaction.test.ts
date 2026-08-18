const mockWithTransaction = jest.fn();

jest.mock('@/db/transaction', () => ({
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}));

import { DatabaseError } from 'pg';
import {
  isContentionError,
  sqlStateOf,
  withRetryableTransaction,
  RETRYABLE_SQLSTATES,
} from '@/db/retry-transaction';
import type { TransactionClient } from '@/db/transaction';
import { IN_TRANSACTION } from '@/db/queryable';

/**
 * A stand-in for the client `withTransaction` hands out. The brand is written
 * here on purpose — see `IN_TRANSACTION`: forging it should be a visible line
 * in a file a reviewer can find, which is exactly what a test double is.
 */
const TX: TransactionClient = {
  [IN_TRANSACTION]: true,
  query: jest.fn(),
  queryOne: jest.fn(),
  queryCount: jest.fn(),
};

function pgError(code: string): DatabaseError {
  const err = new DatabaseError(`simulated ${code}`, 0, 'error');
  // `code` is readonly on the type but set by the driver from the wire; a
  // constructed instance has to be given one the same way.
  Object.defineProperty(err, 'code', { value: code });
  return err;
}

const DEADLOCK = '40P01';
const SERIALIZATION = '40001';
const LOCK_NOT_AVAILABLE = '55P03';

/** Records the delays asked for instead of spending them. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  mockWithTransaction.mockReset();
  // Default: run the callback against the fake client, as the real one would.
  mockWithTransaction.mockImplementation(async (fn: (tx: TransactionClient) => Promise<unknown>) =>
    fn(TX),
  );
});

describe('sqlStateOf', () => {
  it('reads the code off a driver error', () => {
    expect(sqlStateOf(pgError(DEADLOCK))).toBe(DEADLOCK);
  });

  it('is null for anything that is not a driver error', () => {
    expect(sqlStateOf(new Error('boom'))).toBeNull();
    expect(sqlStateOf('40P01')).toBeNull();
    expect(sqlStateOf(undefined)).toBeNull();
  });

  it('is null for a driver error with no code', () => {
    expect(sqlStateOf(new DatabaseError('no code', 0, 'error'))).toBeNull();
  });
});

describe('withRetryableTransaction', () => {
  describe('happy path', () => {
    it('runs the callback once and returns its value', async () => {
      const result = await withRetryableTransaction(async () => 'committed');

      expect(result).toBe('committed');
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    });

    it('passes the transaction client and a 1-based attempt number', async () => {
      const seen: { tx: TransactionClient; attempt: number }[] = [];

      await withRetryableTransaction(async (tx, attempt) => {
        seen.push({ tx, attempt });
        if (attempt === 1) throw pgError(DEADLOCK);
        return null;
      }, sleepless());

      expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
      expect(seen[0]?.tx).toBe(TX);
    });

    it('forwards transaction options through to withTransaction', async () => {
      await withRetryableTransaction(async () => null, {
        isolationLevel: 'serializable',
        lockTimeoutMs: 500,
        deadlockTimeoutMs: 100,
        attempts: 5,
      });

      expect(mockWithTransaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'serializable',
        lockTimeoutMs: 500,
        deadlockTimeoutMs: 100,
      });
    });
  });

  describe('retrying', () => {
    it.each([DEADLOCK, SERIALIZATION])('re-runs the whole transaction after %s', async (code) => {
      let attempts = 0;

      const result = await withRetryableTransaction(async () => {
        attempts += 1;
        if (attempts === 1) throw pgError(code);
        return 'second attempt';
      }, sleepless());

      expect(result).toBe('second attempt');
      expect(attempts).toBe(2);
      // Each attempt is its own BEGIN/COMMIT: retrying a statement inside an
      // aborted transaction would only earn `25P02`.
      expect(mockWithTransaction).toHaveBeenCalledTimes(2);
    });

    it('gives up after the configured number of attempts and rethrows the last error', async () => {
      const error = pgError(DEADLOCK);
      let attempts = 0;

      await expect(
        withRetryableTransaction(async () => {
          attempts += 1;
          throw error;
        }, sleepless({ attempts: 4 })),
      ).rejects.toBe(error);

      expect(attempts).toBe(4);
    });

    it('rethrows the driver error unwrapped, so the translator still sees the SQLSTATE', async () => {
      await expect(
        withRetryableTransaction(async () => {
          throw pgError(DEADLOCK);
        }, sleepless({ attempts: 1 })),
      ).rejects.toBeInstanceOf(DatabaseError);
    });

    it('backs off with full jitter, doubling the cap and stopping at the ceiling', async () => {
      const { sleep, delays } = recordingSleep();

      await expect(
        withRetryableTransaction(
          async () => {
            throw pgError(DEADLOCK);
          },
          {
            attempts: 5,
            baseDelayMs: 100,
            maxDelayMs: 250,
            sleep,
            // A pinned draw of 1 makes the jitter window observable: each delay
            // is the cap itself, minus the floor's one millisecond.
            random: () => 0.99999,
          },
        ),
      ).rejects.toBeInstanceOf(DatabaseError);

      // caps: 100, 200, 250 (ceiling), 250 — one delay fewer than attempts.
      expect(delays).toEqual([99, 199, 249, 249]);
    });

    it('does not sleep when only one attempt is allowed', async () => {
      const { sleep, delays } = recordingSleep();

      await expect(
        withRetryableTransaction(
          async () => {
            throw pgError(DEADLOCK);
          },
          { attempts: 1, sleep },
        ),
      ).rejects.toBeInstanceOf(DatabaseError);

      expect(delays).toEqual([]);
    });

    it('honours a caller-supplied SQLSTATE set', async () => {
      let attempts = 0;

      const result = await withRetryableTransaction(
        async () => {
          attempts += 1;
          if (attempts === 1) throw pgError(LOCK_NOT_AVAILABLE);
          return 'retried anyway';
        },
        { ...sleepless(), retryOn: new Set([LOCK_NOT_AVAILABLE]) },
      );

      expect(result).toBe('retried anyway');
    });
  });

  describe('failures it refuses to retry', () => {
    /**
     * `55P03` is the caller's own timeout or `NOWAIT` coming back. Re-entering
     * the wait immediately is a busy-wait against a holder that is still
     * holding, and it spends the request's remaining deadline to learn nothing.
     */
    it('does not retry lock_not_available', async () => {
      let attempts = 0;

      await expect(
        withRetryableTransaction(async () => {
          attempts += 1;
          throw pgError(LOCK_NOT_AVAILABLE);
        }, sleepless()),
      ).rejects.toBeInstanceOf(DatabaseError);

      expect(attempts).toBe(1);
    });

    /**
     * The important refusal. A connection that dies with `COMMIT` in flight
     * leaves the outcome unknown — the server may have committed and lost the
     * acknowledgement — so replaying can apply the transaction twice.
     */
    it('does not retry a connection-level failure', async () => {
      let attempts = 0;

      await expect(
        withRetryableTransaction(async () => {
          attempts += 1;
          throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        }, sleepless()),
      ).rejects.toThrow('read ECONNRESET');

      expect(attempts).toBe(1);
    });

    it('does not retry an application error thrown from inside the callback', async () => {
      let attempts = 0;

      await expect(
        withRetryableTransaction(async () => {
          attempts += 1;
          throw new Error('the last admin may not be removed');
        }, sleepless()),
      ).rejects.toThrow('the last admin may not be removed');

      expect(attempts).toBe(1);
    });

    it.each([
      ['23505', 'unique_violation'],
      ['23503', 'foreign_key_violation'],
      ['25P02', 'in_failed_sql_transaction'],
    ])('does not retry %s (%s)', async (code) => {
      let attempts = 0;

      await expect(
        withRetryableTransaction(async () => {
          attempts += 1;
          throw pgError(code);
        }, sleepless()),
      ).rejects.toBeInstanceOf(DatabaseError);

      expect(attempts).toBe(1);
    });
  });

  describe('argument validation', () => {
    it.each([0, -1, 2.5, Number.NaN])('rejects attempts = %p', async (attempts) => {
      await expect(withRetryableTransaction(async () => null, { attempts })).rejects.toThrow(
        RangeError,
      );
      expect(mockWithTransaction).not.toHaveBeenCalled();
    });
  });
});

describe('RETRYABLE_SQLSTATES', () => {
  it('is exactly the two rollback-guaranteed contention codes', () => {
    expect([...RETRYABLE_SQLSTATES].sort()).toEqual([SERIALIZATION, DEADLOCK].sort());
  });
});

describe('isContentionError', () => {
  it.each([DEADLOCK, SERIALIZATION, LOCK_NOT_AVAILABLE])('is true for %s', (code) => {
    expect(isContentionError(pgError(code))).toBe(true);
  });

  it('is false for an integrity violation and for a plain error', () => {
    expect(isContentionError(pgError('23505'))).toBe(false);
    expect(isContentionError(new Error('boom'))).toBe(false);
  });
});

/** Retry options that skip the real timers, with overrides merged in. */
function sleepless(overrides: { attempts?: number } = {}): {
  attempts?: number;
  sleep: () => Promise<void>;
} {
  return { ...overrides, sleep: () => Promise.resolve() };
}
