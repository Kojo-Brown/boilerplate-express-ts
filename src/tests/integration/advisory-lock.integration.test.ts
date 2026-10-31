import { randomUUID } from 'node:crypto';
import {
  advisoryLockKey,
  tryAdvisoryXactLock,
  withAdvisoryXactLock,
  withAdvisorySessionLock,
} from '@/db/advisory-lock';
import type { AdvisoryLockKey } from '@/db/advisory-lock';
import { LOCK_NOT_AVAILABLE } from '@/db/locking';
import { getPool } from '@/db/pool';
import { queryOne } from '@/db/query';
import { withTransaction } from '@/db/transaction';
import { holding, wait } from './fixtures';

/**
 * Advisory locks, which are the one part of the DB layer whose doc-comments
 * assert server behaviour in so many words — "verified against PostgreSQL 16",
 * four times over. Until this file existed, nothing in the repository verified
 * any of it; the sentences recorded what somebody had checked by hand once.
 *
 * The four:
 *
 * - `lock_timeout` does abort a waiting advisory acquisition with `55P03`.
 * - The two-`int4` form and the `bigint` form are **separate lock spaces**,
 *   distinguished in `pg_locks` by `objsubid`. This is the reason the codebase
 *   uses the pair, and if it were false the whole argument for it — staying out
 *   of the way of `node-pg-migrate`'s own advisory lock — would be wrong.
 * - A transaction-scoped lock is released by `COMMIT` *and* by `ROLLBACK`,
 *   which is what makes the family safe without a `finally`.
 * - A session-scoped lock survives both, which is what makes it usable by work
 *   that commits incrementally — and is also why its release has to be
 *   explicit.
 *
 * Every key is namespaced with a fresh UUID. The advisory lock space is global
 * to the database and shared with every other connection to it, so a fixed key
 * would make these tests contend with each other on a rerun and with anything
 * else holding the same name.
 */

function freshKey(name = 'subject'): AdvisoryLockKey {
  return advisoryLockKey(`it-advisory-${randomUUID()}`, name);
}

/** Whether any session currently holds the key, asked from the pool. */
async function isHeld(key: AdvisoryLockKey): Promise<boolean> {
  const row = await queryOne<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
     ) AS held`,
    // `pg_locks` reports these as unsigned `oid`s, so the signed ints the key
    // carries have to be reinterpreted to be compared.
    [key.classId >>> 0, key.objId >>> 0],
  );
  return row?.held === true;
}

describe('withAdvisoryXactLock', () => {
  it('excludes a second transaction for as long as the first is open', async () => {
    const key = freshKey();
    const order: string[] = [];

    const second = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) =>
          withAdvisoryXactLock(tx, key, async () => {
            order.push('first-holding');
            held();
            await release;
            order.push('first-done');
          }),
        ),
      async () => {
        expect(await isHeld(key)).toBe(true);

        const waiter = withTransaction(
          async (tx) =>
            withAdvisoryXactLock(tx, key, async () => {
              order.push('second-holding');
            }),
          { lockTimeoutMs: 10_000 },
        );

        // The one claim a latch cannot make: that something has *not* happened.
        await wait(150);
        expect(order).toEqual(['first-holding']);
        // Wrapped, not returned bare: `holding` awaits what the body resolves
        // to, and this promise is blocked on the lock the body is inside.
        return { waiter };
      },
    );

    await second.waiter;
    expect(order).toEqual(['first-holding', 'first-done', 'second-holding']);
  });

  it('is released by the transaction ending, with no unlock call and no finally', async () => {
    const key = freshKey();

    await withTransaction(async (tx) => withAdvisoryXactLock(tx, key, async () => undefined));
    expect(await isHeld(key)).toBe(false);

    // The path that matters: a rollback releases it too, which is what removes
    // the need for a lease, a heartbeat and a fencing token.
    await expect(
      withTransaction(async (tx) =>
        withAdvisoryXactLock(tx, key, async () => {
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');
    expect(await isHeld(key)).toBe(false);
  });

  it('is bounded by the transaction\u2019s lock_timeout rather than waiting forever', async () => {
    const key = freshKey();

    await holding(
      ({ held, release }) =>
        withTransaction(async (tx) =>
          withAdvisoryXactLock(tx, key, async () => {
            held();
            await release;
          }),
        ),
      async () => {
        await expect(
          withTransaction(async (tx) => withAdvisoryXactLock(tx, key, async () => 'never'), {
            lockTimeoutMs: 200,
          }),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
      },
    );
  });

  it('does not exclude a different name in the same namespace', async () => {
    const namespace = `it-advisory-${randomUUID()}`;
    const one = advisoryLockKey(namespace, 'job-one');
    const two = advisoryLockKey(namespace, 'job-two');

    const ran = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) =>
          withAdvisoryXactLock(tx, one, async () => {
            held();
            await release;
          }),
        ),
      async () =>
        withTransaction(async (tx) => tryAdvisoryXactLock(tx, two, async () => 'ran'), {
          lockTimeoutMs: 2_000,
        }),
    );

    expect(ran).toEqual({ acquired: true, value: 'ran' });
  });
});

describe('tryAdvisoryXactLock', () => {
  it('runs the callback when the key is free', async () => {
    const key = freshKey();

    const result = await withTransaction(async (tx) =>
      tryAdvisoryXactLock(tx, key, async () => 'did the work'),
    );

    expect(result).toEqual({ acquired: true, value: 'did the work' });
  });

  it('skips the callback entirely when somebody else holds it', async () => {
    const key = freshKey();
    let ran = false;

    const result = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) =>
          withAdvisoryXactLock(tx, key, async () => {
            held();
            await release;
          }),
        ),
      async () =>
        withTransaction(async (tx) =>
          tryAdvisoryXactLock(tx, key, async () => {
            ran = true;
            return 'should not happen';
          }),
        ),
    );

    expect(result).toEqual({ acquired: false });
    expect(ran).toBe(false);
  });

  it('distinguishes "nobody else was running, and the answer is nothing" from a miss', async () => {
    const key = freshKey();

    // The reason `AdvisoryLockResult` is a union and not `T | null`.
    expect(
      await withTransaction(async (tx) => tryAdvisoryXactLock(tx, key, async () => null)),
    ).toEqual({ acquired: true, value: null });
  });
});

describe('withAdvisorySessionLock', () => {
  it('resolves with the callback\u2019s value and releases the key', async () => {
    const key = freshKey();

    expect(await withAdvisorySessionLock(key, async () => 'relayed')).toEqual({
      acquired: true,
      value: 'relayed',
    });
    expect(await isHeld(key)).toBe(false);
  });

  it('holds the key across the callback\u2019s own transactions', async () => {
    const key = freshKey();

    await holding(
      ({ held, release }) =>
        withAdvisorySessionLock(key, async (client) => {
          // A session lock's whole purpose: committing incrementally while
          // still holding the mutex, which a transaction-scoped lock cannot do.
          await client.query('BEGIN');
          await client.query('SELECT 1');
          await client.query('COMMIT');
          await client.query('BEGIN');
          await client.query('ROLLBACK');
          held();
          await release;
        }),
      async () => {
        expect(await isHeld(key)).toBe(true);
      },
    );

    // Released by the explicit `pg_advisory_unlock`: the connection went back
    // to the pool rather than ending, so nothing else would have.
    expect(await isHeld(key)).toBe(false);
  });

  it('skips rather than queues by default, because a late scheduled run is not useful', async () => {
    const key = freshKey();
    let ran = false;

    const second = await holding(
      ({ held, release }) =>
        withAdvisorySessionLock(key, async () => {
          held();
          await release;
        }),
      async () =>
        withAdvisorySessionLock(key, async () => {
          ran = true;
          return 'second';
        }),
    );

    expect(second).toEqual({ acquired: false });
    expect(ran).toBe(false);
  });

  it('waits when asked, and lock_timeout bounds the wait with 55P03', async () => {
    const key = freshKey();

    await holding(
      ({ held, release }) =>
        withAdvisorySessionLock(key, async () => {
          held();
          await release;
        }),
      async () => {
        await expect(
          withAdvisorySessionLock(key, async () => 'second', { wait: 'wait', lockTimeoutMs: 200 }),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
      },
    );

    // And the `SET LOCAL lock_timeout` the failed attempt used did not follow
    // its connection back into the pool.
    expect(
      (await queryOne<{ s: string }>("SELECT current_setting('lock_timeout') AS s"))?.s,
    ).toBe('0');
  });

  it('releases the key when the callback throws, and propagates the error', async () => {
    const key = freshKey();

    await expect(
      withAdvisorySessionLock(key, async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');

    expect(await isHeld(key)).toBe(false);
    // Reusable afterwards, which is the observable difference between
    // releasing the lock and destroying the connection.
    expect(await withAdvisorySessionLock(key, async () => 'again')).toEqual({
      acquired: true,
      value: 'again',
    });
  });

  it('is not reentrant: a nested acquisition is a different session and misses', async () => {
    const key = freshKey();

    const outer = await withAdvisorySessionLock(key, async () =>
      withAdvisorySessionLock(key, async () => 'inner ran'),
    );

    // The documented behaviour, and the reason the default is `nowait`: under
    // `wait` this would be a self-deadlock no detector reports, because the
    // outer holder is not waiting on anything.
    expect(outer).toEqual({ acquired: true, value: { acquired: false } });
  });

  it('returns the connection to the pool rather than destroying it on the happy path', async () => {
    await queryOne('SELECT 1');
    const pool = getPool();
    const before = pool.totalCount;

    await withAdvisorySessionLock(freshKey(), async () => undefined);

    expect(pool.totalCount).toBe(before);
    expect(pool.idleCount).toBe(before);
  });
});

describe('the two lock spaces', () => {
  it('the int4 pair and the bigint with the same bits do not exclude each other', async () => {
    const key = freshKey();

    const row = await holding(
      ({ held, release }) =>
        withAdvisorySessionLock(key, async () => {
          held();
          await release;
        }),
      async () =>
        // Transaction-scoped on purpose: a session lock taken here would be
        // held by whichever pooled connection served the statement, and the
        // `pg_advisory_unlock` releasing it is not guaranteed to land on the
        // same one. `COMMIT` has no such ambiguity.
        withTransaction(async (tx) =>
          tx.queryOne<{ taken: boolean; subids: number[] }>(
            `SELECT pg_try_advisory_xact_lock(($1::bigint << 32) | ($2::bigint & 4294967295)) AS taken,
                    ARRAY(
                      SELECT DISTINCT objsubid FROM pg_locks
                      WHERE locktype = 'advisory' AND classid = $3::oid AND objid = $4::oid
                      ORDER BY objsubid
                    ) AS subids`,
            // The same 64 bits the pair occupies, as the single-argument form
            // takes them. Assembled in SQL so the shift happens in 64-bit
            // integer arithmetic rather than in a JS `number`, where the high
            // word would lose precision.
            [key.classId, key.objId, key.classId >>> 0, key.objId >>> 0],
          ),
        ),
    );

    // Taken, while the pair is held, from a different session. The two forms
    // land on the *same* `classid`/`objid` and are told apart only by
    // `objsubid` — 1 for the bigint form, 2 for the pair — so both rows being
    // present at once is the separation the doc-comment claims, and the whole
    // reason this codebase uses the pair rather than the bigint that
    // `node-pg-migrate` reaches for.
    expect(row?.taken).toBe(true);
    expect(row?.subids).toEqual([1, 2]);
  });
});

describe('advisoryLockKey', () => {
  it('derives the same two int4s for the same names, on any process', async () => {
    const a = advisoryLockKey('jobs', 'purge');
    const b = advisoryLockKey('jobs', 'purge');

    expect([a.classId, a.objId]).toEqual([b.classId, b.objId]);
    // And they are in range for `pg_advisory_lock(int, int)`, which is the
    // constraint the signed reading of the digest exists to satisfy. A value
    // outside it is a `22003` from the server rather than a wrong lock.
    const row = await queryOne<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS ok',
      [a.classId, a.objId],
    );
    expect(row?.ok).toBe(true);
  });
});
