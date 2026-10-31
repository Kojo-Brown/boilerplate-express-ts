import { getPool } from '@/db/pool';
import { query, queryOne } from '@/db/query';
import { withTransaction } from '@/db/transaction';
import { createTable, truncate } from './fixtures';

/**
 * `withTransaction` against a server that has transactions.
 *
 * The unit suite drives a fake `PoolClient` and asserts the order of the
 * strings sent to it — `BEGIN`, the `SET LOCAL`s, the callback, `COMMIT`. What
 * it cannot assert is that any of those did anything, and three of this
 * module's doc-comments make claims that only a real server can settle:
 *
 * - `SET LOCAL` and not `SET SESSION`, "because the connection goes back to the
 *   pool". The test below proves the setting is gone from the *same backend*
 *   afterwards, identified by `pg_backend_pid()` — without that identity the
 *   assertion would pass against a fresh connection and mean nothing.
 * - The timeout is built before the connection is taken, so a malformed one
 *   "would leak a pooled connection on the way out". The pool's own counters
 *   are what show it did not.
 * - `read uncommitted` is absent "because Postgres does not implement it".
 *   `SHOW transaction_isolation` is the only thing that can confirm the three
 *   that are present map to what their names say.
 */

const TABLE = 'it_tx';

interface Row {
  id: number;
  value: number;
}

beforeAll(async () => {
  await createTable(TABLE, 'id integer PRIMARY KEY, value integer NOT NULL');
});

beforeEach(async () => {
  await truncate(TABLE);
  await query(`INSERT INTO "${TABLE}" (id, value) VALUES (1, 100), (2, 200)`);
});

async function valueOf(id: number): Promise<number | null> {
  const row = await queryOne<{ value: number }>(`SELECT value FROM "${TABLE}" WHERE id = $1`, [id]);
  return row?.value ?? null;
}

describe('commit and rollback', () => {
  it('commits the callback’s writes when it resolves', async () => {
    const returned = await withTransaction(async (tx) => {
      await tx.query(`UPDATE "${TABLE}" SET value = 111 WHERE id = 1`);
      return 'done';
    });

    expect(returned).toBe('done');
    expect(await valueOf(1)).toBe(111);
  });

  it('rolls them back when it rejects, and rethrows the original error', async () => {
    const boom = new Error('callback failed');

    await expect(
      withTransaction(async (tx) => {
        await tx.query(`UPDATE "${TABLE}" SET value = 999 WHERE id = 1`);
        await tx.query(`DELETE FROM "${TABLE}" WHERE id = 2`);
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await valueOf(1)).toBe(100);
    expect(await valueOf(2)).toBe(200);
  });

  it('rolls back and rethrows the server’s error when a statement is the failure', async () => {
    await expect(
      withTransaction(async (tx) => {
        await tx.query(`UPDATE "${TABLE}" SET value = 42 WHERE id = 1`);
        await tx.query(`INSERT INTO "${TABLE}" (id, value) VALUES (1, 1)`);
      }),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await valueOf(1)).toBe(100);
  });

  it('leaves the transaction aborted after a failed statement, which is why the retry unit is the transaction', async () => {
    let secondStatement: unknown;

    await expect(
      withTransaction(async (tx) => {
        try {
          await tx.query('SELECT 1 / 0');
        } catch {
          // Swallowed on purpose: the interesting part is what the *next*
          // statement does on a connection whose transaction is already dead.
        }
        try {
          await tx.query(`SELECT value FROM "${TABLE}" WHERE id = 1`);
        } catch (err) {
          secondStatement = err;
        }
        throw new Error('give up');
      }),
    ).rejects.toThrow('give up');

    // `25P02 in_failed_sql_transaction`. This is the behaviour
    // `withRetryableTransaction` is shaped around — there is no retrying a
    // statement, only a transaction.
    expect(secondStatement).toMatchObject({ code: '25P02' });
    // And the connection survives it, because the rollback happened.
    expect(await valueOf(1)).toBe(100);
  });

  it('returns the connection to the pool on both paths', async () => {
    // One warm connection, so the counters below are about this transaction
    // rather than about pool growth.
    await query('SELECT 1');
    const pool = getPool();
    const before = pool.totalCount;

    await withTransaction(async (tx) => tx.query('SELECT 1'));
    await expect(
      withTransaction(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    expect(pool.totalCount).toBe(before);
    expect(pool.idleCount).toBe(before);
    expect(pool.waitingCount).toBe(0);
  });
});

describe('isolation levels', () => {
  it.each([
    ['read committed', 'read committed'],
    ['repeatable read', 'repeatable read'],
    ['serializable', 'serializable'],
  ] as const)('BEGIN ISOLATION LEVEL %s is what the server reports', async (level, reported) => {
    const actual = await withTransaction(
      async (tx) => (await tx.queryOne<{ s: string }>("SELECT current_setting('transaction_isolation') AS s"))?.s,
      { isolationLevel: level },
    );

    expect(actual).toBe(reported);
  });

  it('holds a repeatable-read snapshot across a committed concurrent write', async () => {
    const seen = await withTransaction(
      async (tx) => {
        const first = await tx.queryOne<{ value: number }>(
          `SELECT value FROM "${TABLE}" WHERE id = 1`,
        );

        // A different connection, committed while this transaction is open.
        await query(`UPDATE "${TABLE}" SET value = 500 WHERE id = 1`);

        const second = await tx.queryOne<{ value: number }>(
          `SELECT value FROM "${TABLE}" WHERE id = 1`,
        );
        return [first?.value, second?.value];
      },
      { isolationLevel: 'repeatable read' },
    );

    expect(seen).toEqual([100, 100]);
    expect(await valueOf(1)).toBe(500);
  });

  it('sees it under read committed, which is the difference between the two', async () => {
    const seen = await withTransaction(
      async (tx) => {
        const first = await tx.queryOne<{ value: number }>(
          `SELECT value FROM "${TABLE}" WHERE id = 1`,
        );
        await query(`UPDATE "${TABLE}" SET value = 500 WHERE id = 1`);
        const second = await tx.queryOne<{ value: number }>(
          `SELECT value FROM "${TABLE}" WHERE id = 1`,
        );
        return [first?.value, second?.value];
      },
      { isolationLevel: 'read committed' },
    );

    expect(seen).toEqual([100, 500]);
  });
});

describe('SET LOCAL', () => {
  it('applies the timeouts inside the transaction', async () => {
    const settings = await withTransaction(
      async (tx) => ({
        lock: (await tx.queryOne<{ s: string }>("SELECT current_setting('lock_timeout') AS s"))?.s,
        deadlock: (await tx.queryOne<{ s: string }>("SELECT current_setting('deadlock_timeout') AS s"))?.s,
      }),
      { lockTimeoutMs: 250, deadlockTimeoutMs: 100 },
    );

    expect(settings).toEqual({ lock: '250ms', deadlock: '100ms' });
  });

  it('does not follow the connection back into the pool', async () => {
    // Warm the pool so there is exactly one backend to be handed back, and take
    // its pid: without comparing pids this assertion would also pass on a
    // *different* connection, where it says nothing about `SET LOCAL` at all.
    await query('SELECT 1');

    const inside = await withTransaction(
      async (tx) => ({
        pid: (await tx.queryOne<{ pid: number }>('SELECT pg_backend_pid() AS pid'))?.pid,
        lock: (await tx.queryOne<{ s: string }>("SELECT current_setting('lock_timeout') AS s"))?.s,
      }),
      { lockTimeoutMs: 250 },
    );

    const after = await queryOne<{ pid: number; lock: string }>(
      'SELECT pg_backend_pid() AS pid, current_setting(\'lock_timeout\') AS lock',
    );

    expect(inside.lock).toBe('250ms');
    expect(after?.pid).toBe(inside.pid);
    // Same backend, default restored. A `SET SESSION` here would have left
    // `250ms` on a connection the next unrelated request picks up.
    expect(after?.lock).toBe('0');
  });

  it('refuses a non-integer timeout without taking a connection', async () => {
    await query('SELECT 1');
    const pool = getPool();
    const before = pool.totalCount;

    await expect(withTransaction(async () => undefined, { lockTimeoutMs: 500.7 })).rejects.toThrow(
      RangeError,
    );
    await expect(withTransaction(async () => undefined, { lockTimeoutMs: -1 })).rejects.toThrow(
      RangeError,
    );

    // The claim in the source: built before `connect()`, so nothing leaked.
    expect(pool.totalCount).toBe(before);
    expect(pool.idleCount).toBe(before);
  });

  it('accepts 0 as "wait forever", which is not the same as omitting it', async () => {
    const lock = await withTransaction(
      async (tx) => (await tx.queryOne<{ s: string }>("SELECT current_setting('lock_timeout') AS s"))?.s,
      { lockTimeoutMs: 0 },
    );

    expect(lock).toBe('0');
  });
});

describe('the client the callback is handed', () => {
  it('returns rows, first row and parsed count from the transaction’s own connection', async () => {
    await withTransaction(async (tx) => {
      await tx.query(`INSERT INTO "${TABLE}" (id, value) VALUES (3, 300)`);

      const rows = await tx.query<Row>(`SELECT id, value FROM "${TABLE}" ORDER BY id`);
      expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);

      expect(await tx.queryOne<Row>(`SELECT id FROM "${TABLE}" ORDER BY id DESC`)).toEqual({
        id: 3,
      });
      expect(await tx.queryOne(`SELECT 1 FROM "${TABLE}" WHERE id = 99`)).toBeNull();

      expect(await tx.queryCount(`SELECT COUNT(*) AS count FROM "${TABLE}"`)).toBe(3);
      // The branch a mock cannot reach: no row at all, rather than a row
      // holding zero.
      expect(await tx.queryCount(`SELECT COUNT(*) AS count FROM "${TABLE}" WHERE false`)).toBe(0);
    });
  });
});
