import { DEADLOCK_DETECTED, LOCK_NOT_AVAILABLE, SERIALIZATION_FAILURE } from '@/db/locking';
import { query, queryOne } from '@/db/query';
import { isContentionError, sqlStateOf, withRetryableTransaction } from '@/db/retry-transaction';
import { withTransaction } from '@/db/transaction';
import { createTable, holding, latch, truncate } from './fixtures';

/**
 * The two contention failures `withRetryableTransaction` exists for, produced
 * by a real server rather than constructed.
 *
 * The unit suite builds `DatabaseError`s with the right `code` and checks the
 * loop's arithmetic against them, which is the right way to test the loop and
 * is circular as evidence about Postgres: it proves the code retries what the
 * test said to retry. Three claims in the source are about the server, and this
 * is where they are settled.
 *
 * **A deadlock arrives labelled as one only if `deadlock_timeout` is under
 * `lock_timeout`.** `transaction.ts` says so in a doc-comment, and the
 * consequence is severe enough to be worth a pair of tests: get it backwards
 * and a genuine cycle is reported as `55P03`, which `RETRYABLE_SQLSTATES`
 * deliberately excludes, so the retry loop that exists for `40P01` never
 * engages and the request fails on the first attempt. Both orderings are run
 * below against the same cycle.
 *
 * **A `repeatable read` transaction that writes a row another transaction
 * committed after its snapshot fails with `40001`,** and re-running it against
 * the committed state succeeds. That is the entire argument for the retry loop,
 * and the test drives it through the real loop rather than a simulated one.
 *
 * **`55P03` is not retried,** which is a decision rather than an oversight: the
 * attempt counter below is what shows the loop gave up after one.
 */

const TABLE = 'it_contend';

beforeAll(async () => {
  await createTable(TABLE, 'id text PRIMARY KEY, value integer NOT NULL');
});

beforeEach(async () => {
  await truncate(TABLE);
  await query(`INSERT INTO "${TABLE}" (id, value) VALUES ('a', 1), ('b', 2)`);
});

/** Two transactions taking `a` and `b` in opposite orders. */
async function deadlock(options: {
  lockTimeoutMs: number;
  deadlockTimeoutMs?: number;
}): Promise<PromiseSettledResult<void>[]> {
  const firstHasA = latch();
  const secondHasB = latch();

  const lock = (id: string) => `SELECT value FROM "${TABLE}" WHERE id = '${id}' FOR UPDATE`;

  const first = withTransaction(async (tx) => {
    await tx.query(lock('a'));
    firstHasA.open();
    await secondHasB.promise;
    await tx.query(lock('b'));
  }, options);

  const second = withTransaction(async (tx) => {
    await tx.query(lock('b'));
    secondHasB.open();
    await firstHasA.promise;
    await tx.query(lock('a'));
  }, options);

  return Promise.allSettled([first, second]);
}

function reasons(results: PromiseSettledResult<unknown>[]): (string | null)[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => sqlStateOf(result.reason));
}

describe('a deadlock', () => {
  it('is reported as 40P01 when deadlock_timeout is under lock_timeout', async () => {
    const results = await deadlock({ lockTimeoutMs: 5_000, deadlockTimeoutMs: 100 });

    // Postgres aborts exactly one side of the cycle; the other makes progress.
    expect(reasons(results)).toEqual([DEADLOCK_DETECTED]);
    expect(isContentionError(results.find((r) => r.status === 'rejected')?.reason)).toBe(true);
  });

  it('is reported as 55P03 when lock_timeout fires first, which is what hides it from the retry loop', async () => {
    const results = await deadlock({ lockTimeoutMs: 100, deadlockTimeoutMs: 1_000 });

    const codes = reasons(results);
    expect(codes.length).toBeGreaterThan(0);
    // The failure mode the doc-comment warns about: the same cycle, a SQLSTATE
    // `RETRYABLE_SQLSTATES` does not contain, and a retry loop that will not
    // run. Nothing errors about the configuration; the transaction just stops
    // being retried.
    expect(codes.every((code) => code === LOCK_NOT_AVAILABLE)).toBe(true);
    expect(codes).not.toContain(DEADLOCK_DETECTED);
  });
});

describe('withRetryableTransaction', () => {
  async function valueOf(id: string): Promise<number | null> {
    return (
      await queryOne<{ value: number }>(`SELECT value FROM "${TABLE}" WHERE id = $1`, [id])
    )?.value ?? null;
  }

  it('re-runs a transaction that failed to serialise, and the second attempt commits', async () => {
    const seenAttempts: number[] = [];

    const result = await withRetryableTransaction(
      async (tx, attempt) => {
        seenAttempts.push(attempt);
        // Establishes this transaction's snapshot.
        await tx.query(`SELECT value FROM "${TABLE}" WHERE id = 'a'`);

        if (attempt === 1) {
          // A different connection, committed after the snapshot above. The
          // write below can no longer be serialised against it.
          await query(`UPDATE "${TABLE}" SET value = value + 100 WHERE id = 'a'`);
        }

        await tx.query(`UPDATE "${TABLE}" SET value = value + 1 WHERE id = 'a'`);
        return attempt;
      },
      { isolationLevel: 'repeatable read', sleep: async () => undefined },
    );

    expect(seenAttempts).toEqual([1, 2]);
    expect(result).toBe(2);
    // 1 + 100 from the interfering write, + 1 from the attempt that committed.
    // The failed attempt's `+1` is not in there, which is the property that
    // makes replaying safe: there is no outcome where its writes survive.
    expect(await valueOf('a')).toBe(102);
  });

  it('throws the last attempt’s error unwrapped, so its SQLSTATE still reaches the translator', async () => {
    let attemptsRun = 0;

    const error = await withRetryableTransaction(
      async (tx, attempt) => {
        attemptsRun = attempt;
        await tx.query(`SELECT value FROM "${TABLE}" WHERE id = 'a'`);
        await query(`UPDATE "${TABLE}" SET value = value + 1 WHERE id = 'a'`);
        await tx.query(`UPDATE "${TABLE}" SET value = value + 1 WHERE id = 'a'`);
      },
      { isolationLevel: 'repeatable read', attempts: 2, sleep: async () => undefined },
    ).catch((err: unknown) => err);

    expect(attemptsRun).toBe(2);
    // Not a "retries exhausted" wrapper: `db.errors.ts` reads `code` off a
    // `DatabaseError`, and a wrapper would turn this 409 into a 500.
    expect(sqlStateOf(error)).toBe(SERIALIZATION_FAILURE);
    expect(isContentionError(error)).toBe(true);
  });

  it('does not retry 55P03, because the caller already said how long to wait', async () => {
    let attemptsRun = 0;

    const error = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await tx.query(`SELECT value FROM "${TABLE}" WHERE id = 'a' FOR UPDATE`);
          held();
          await release;
        }),
      async () =>
        withRetryableTransaction(
          async (tx, attempt) => {
            attemptsRun = attempt;
            await tx.query(`SELECT value FROM "${TABLE}" WHERE id = 'a' FOR UPDATE NOWAIT`);
          },
          { sleep: async () => undefined },
        ).catch((err: unknown) => err),
    );

    expect(sqlStateOf(error)).toBe(LOCK_NOT_AVAILABLE);
    // One attempt out of a budget of three. Re-entering the same wait would be
    // a busy-wait against a holder that is still holding.
    expect(attemptsRun).toBe(1);
  });

  it('commits on the first attempt when there is nothing to contend with', async () => {
    const attempt = await withRetryableTransaction(async (tx, n) => {
      await tx.query(`UPDATE "${TABLE}" SET value = 7 WHERE id = 'b'`);
      return n;
    });

    expect(attempt).toBe(1);
    expect(await valueOf('b')).toBe(7);
  });
});

describe('isContentionError', () => {
  it('is false for an integrity violation, which is the client’s fault and not a race', async () => {
    const error = await query(`INSERT INTO "${TABLE}" (id, value) VALUES ('a', 1)`).catch(
      (err: unknown) => err,
    );

    expect(sqlStateOf(error)).toBe('23505');
    expect(isContentionError(error)).toBe(false);
  });

  it('is false for a non-driver error', () => {
    expect(isContentionError(new Error('not from pg'))).toBe(false);
    expect(sqlStateOf(new Error('not from pg'))).toBeNull();
  });
});
