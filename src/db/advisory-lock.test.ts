const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@/db/pool', () => ({
  getPool: () => ({ connect: (...args: unknown[]) => mockConnect(...args) }),
}));

import {
  advisoryLockKey,
  formatAdvisoryLockKey,
  tryAdvisoryXactLock,
  withAdvisorySessionLock,
  withAdvisoryXactLock,
} from '@/db/advisory-lock';
import { IN_TRANSACTION } from '@/db/queryable';
import type { TransactionClient } from '@/db/transaction';

const KEY = advisoryLockKey('test-namespace', 'test-lock');

/**
 * A `TransactionClient` whose three methods are spies. The brand is forged
 * deliberately, which is the case `IN_TRANSACTION` documents as intended: a
 * fake connection is exactly the caller that has a client this module did not
 * hand out.
 */
function fakeTx(): TransactionClient & {
  query: jest.Mock;
  queryOne: jest.Mock;
  queryCount: jest.Mock;
} {
  return {
    [IN_TRANSACTION]: true,
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    queryCount: jest.fn().mockResolvedValue(0),
  };
}

beforeEach(() => {
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  mockClientQuery.mockResolvedValue({ rows: [] });
});

describe('advisoryLockKey', () => {
  it('derives both halves deterministically from the two names', () => {
    expect(advisoryLockKey('ns', 'lock')).toEqual(advisoryLockKey('ns', 'lock'));
  });

  it('pins the digest, because two replicas coordinate only by computing the same integers', () => {
    // SHA-256('boilerplate-express-ts') and SHA-256('idempotency.purge'), first
    // four bytes each, read big-endian as int32. Hard-coded on purpose: a
    // change to the derivation is a change every replica has to agree on, and
    // it should not be able to slip through as a refactor.
    expect(advisoryLockKey('boilerplate-express-ts', 'idempotency.purge')).toMatchObject({
      classId: -415_441_977,
      objId: 1_402_299_784,
    });
  });

  it('separates identical names in different namespaces', () => {
    const a = advisoryLockKey('service-a', 'purge');
    const b = advisoryLockKey('service-b', 'purge');
    expect(a.objId).toBe(b.objId);
    expect(a.classId).not.toBe(b.classId);
  });

  it('keeps both halves inside the int4 range Postgres accepts', () => {
    for (const name of ['a', 'purge', 'outbox.relay', 'x'.repeat(500)]) {
      const key = advisoryLockKey('ns', name);
      expect(key.classId).toBeGreaterThanOrEqual(-2_147_483_648);
      expect(key.classId).toBeLessThanOrEqual(2_147_483_647);
      expect(Number.isInteger(key.objId)).toBe(true);
      expect(key.objId).toBeGreaterThanOrEqual(-2_147_483_648);
      expect(key.objId).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it.each([
    ['namespace', '', 'name'],
    ['name', 'ns', ''],
  ])('rejects an empty %s', (_label, namespace, name) => {
    expect(() => advisoryLockKey(namespace, name)).toThrow(RangeError);
  });

  it('renders both the names and the integers for a log line', () => {
    expect(formatAdvisoryLockKey(KEY)).toBe(
      `test-namespace/test-lock (${KEY.classId}, ${KEY.objId})`,
    );
  });
});

describe('withAdvisoryXactLock', () => {
  it('takes the transaction-scoped lock before running the callback', async () => {
    const tx = fakeTx();
    const order: string[] = [];
    tx.query.mockImplementation(async (sql: string) => {
      order.push(sql);
      return [];
    });

    await withAdvisoryXactLock(tx, KEY, async () => {
      order.push('callback');
      return 'done';
    });

    expect(order).toEqual(['SELECT pg_advisory_xact_lock($1::int4, $2::int4)', 'callback']);
  });

  it('passes both halves of the key as bound parameters', async () => {
    const tx = fakeTx();
    await withAdvisoryXactLock(tx, KEY, async () => null);
    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [
      KEY.classId,
      KEY.objId,
    ]);
  });

  it('returns the callback result', async () => {
    await expect(withAdvisoryXactLock(fakeTx(), KEY, async () => 42)).resolves.toBe(42);
  });

  it('does not run the callback when the acquisition fails', async () => {
    const tx = fakeTx();
    // What `lock_timeout` produces on a waiting advisory acquisition.
    tx.query.mockRejectedValue(Object.assign(new Error('canceling statement'), { code: '55P03' }));
    const fn = jest.fn();

    await expect(withAdvisoryXactLock(tx, KEY, fn)).rejects.toThrow('canceling statement');
    expect(fn).not.toHaveBeenCalled();
  });

  it('issues no unlock of its own — the transaction ending is the release', async () => {
    const tx = fakeTx();
    await withAdvisoryXactLock(tx, KEY, async () => null);
    const sql = tx.query.mock.calls.map((call) => String(call[0])).join(' ');
    expect(sql).not.toContain('unlock');
  });
});

describe('tryAdvisoryXactLock', () => {
  it('runs the callback and reports the value when the lock is free', async () => {
    const tx = fakeTx();
    tx.queryOne.mockResolvedValue({ acquired: true });

    await expect(tryAdvisoryXactLock(tx, KEY, async () => 'swept')).resolves.toEqual({
      acquired: true,
      value: 'swept',
    });
  });

  it('skips the callback entirely when another holder has it', async () => {
    const tx = fakeTx();
    tx.queryOne.mockResolvedValue({ acquired: false });
    const fn = jest.fn();

    await expect(tryAdvisoryXactLock(tx, KEY, fn)).resolves.toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats a missing row as a miss rather than assuming the lock', async () => {
    const tx = fakeTx();
    tx.queryOne.mockResolvedValue(null);
    const fn = jest.fn();

    await expect(tryAdvisoryXactLock(tx, KEY, fn)).resolves.toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('distinguishes a null result from a lost race', async () => {
    const tx = fakeTx();
    tx.queryOne.mockResolvedValue({ acquired: true });

    // The reason the return type is a discriminated union and not `T | null`.
    await expect(tryAdvisoryXactLock(tx, KEY, async () => null)).resolves.toEqual({
      acquired: true,
      value: null,
    });
  });

  it('uses the non-blocking function, never the waiting one', async () => {
    const tx = fakeTx();
    tx.queryOne.mockResolvedValue({ acquired: true });
    await tryAdvisoryXactLock(tx, KEY, async () => null);

    expect(tx.queryOne).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS acquired',
      [KEY.classId, KEY.objId],
    );
  });
});

describe('withAdvisorySessionLock', () => {
  /** Answers the acquisition with `acquired`; every other statement is empty. */
  function respondWith(acquired: boolean, released = true): void {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ released }] };
      return { rows: [] };
    });
  }

  it('defaults to the non-blocking acquisition', async () => {
    respondWith(true);
    await withAdvisorySessionLock(KEY, async () => null);

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.includes('pg_try_advisory_lock'))).toBe(true);
    expect(sql.some((s) => /pg_advisory_lock\(/.test(s))).toBe(false);
  });

  it('waits when asked to, and reports acquisition from the call returning', async () => {
    respondWith(true);
    await expect(
      withAdvisorySessionLock(KEY, async () => 'ran', { wait: 'wait' }),
    ).resolves.toEqual({ acquired: true, value: 'ran' });

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain('SELECT pg_advisory_lock($1::int4, $2::int4)');
  });

  it('skips the callback and releases the connection when the lock is taken', async () => {
    respondWith(false);
    const fn = jest.fn();

    await expect(withAdvisorySessionLock(KEY, fn)).resolves.toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(mockClientRelease).toHaveBeenCalledWith(undefined);
  });

  it('does not unlock a lock it never took', async () => {
    respondWith(false);
    await withAdvisorySessionLock(KEY, async () => null);

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0])).join(' ');
    expect(sql).not.toContain('pg_advisory_unlock');
  });

  it('takes the lock in its own transaction so a SET LOCAL cannot outlive it', async () => {
    respondWith(true);
    await withAdvisorySessionLock(KEY, async () => null, { wait: 'wait', lockTimeoutMs: 750 });

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sql.slice(0, 4)).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '750ms'",
      'SELECT pg_advisory_lock($1::int4, $2::int4)',
      'COMMIT',
    ]);
  });

  it('rejects a malformed timeout before checking a connection out', async () => {
    await expect(
      withAdvisorySessionLock(KEY, async () => null, { lockTimeoutMs: 12.5 }),
    ).rejects.toThrow(RangeError);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('gives the callback the connection holding the lock', async () => {
    respondWith(true);
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }] };
      if (sql === 'SELECT 1 AS n') return { rows: [{ n: 1 }] };
      return { rows: [] };
    });

    const result = await withAdvisorySessionLock(KEY, (client) => client.query('SELECT 1 AS n'));
    expect(result).toEqual({ acquired: true, value: [{ n: 1 }] });
  });

  it('unlocks and returns the connection to the pool on the happy path', async () => {
    respondWith(true);
    await withAdvisorySessionLock(KEY, async () => null);

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain('SELECT pg_advisory_unlock($1::int4, $2::int4) AS released');
    expect(mockClientRelease).toHaveBeenCalledWith(undefined);
  });

  it('still unlocks when the callback throws, and rethrows the original error', async () => {
    respondWith(true);

    await expect(
      withAdvisorySessionLock(KEY, async () => {
        throw new Error('job failed');
      }),
    ).rejects.toThrow('job failed');

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0])).join(' ');
    expect(sql).toContain('pg_advisory_unlock');
    expect(mockClientRelease).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection when the unlock reports the lock was not held', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    respondWith(true, false);

    await withAdvisorySessionLock(KEY, async () => null);

    // Ending the session is what Postgres releases a session lock on, so a
    // connection whose unlock did not take must not go back into the pool.
    expect(mockClientRelease).toHaveBeenCalledWith(expect.any(Error));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('destroys the connection when the unlock itself throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('connection reset');
      return { rows: [] };
    });

    await expect(withAdvisorySessionLock(KEY, async () => 'ok')).resolves.toEqual({
      acquired: true,
      value: 'ok',
    });
    expect(mockClientRelease).toHaveBeenCalledWith(expect.any(Error));
    errorSpy.mockRestore();
  });

  it('rolls back and releases the connection when the acquisition fails', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        throw Object.assign(new Error('canceling statement'), { code: '55P03' });
      }
      return { rows: [] };
    });

    await expect(withAdvisorySessionLock(KEY, async () => null)).rejects.toThrow(
      'canceling statement',
    );

    const sql = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sql).toContain('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('rethrows the acquisition error even when the rollback also fails', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) throw new Error('acquisition failed');
      if (sql === 'ROLLBACK') throw new Error('network gone');
      return { rows: [] };
    });

    await expect(withAdvisorySessionLock(KEY, async () => null)).rejects.toThrow(
      'acquisition failed',
    );
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});
