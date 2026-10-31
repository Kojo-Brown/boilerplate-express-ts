import type { QueryResultRow } from 'pg';
import { LOCK_NOT_AVAILABLE } from '@/db/locking';
import { query } from '@/db/query';
import { BaseRepository } from '@/db/repository';
import { withTransaction } from '@/db/transaction';
import type { RowLockOptions, TransactionClient } from '@/db';
import { createTable, holding, truncate, wait } from './fixtures';

/**
 * Row locks, against the only thing that implements them.
 *
 * `lockingClause` is a string builder and its unit suite tests it as one: four
 * strengths, three waits, twelve expected fragments. Every claim in
 * `locking.ts`'s and `repository.ts`'s doc-comments about what those fragments
 * *do* is a claim about PostgreSQL, and this is where each one is either true or
 * was never checked:
 *
 * - `FOR UPDATE` blocks a second transaction until the first ends, and the
 *   waiter then reads the committed value rather than the one it would have
 *   read had it not waited.
 * - `NOWAIT` fails immediately with `55P03`, and `lock_timeout` produces the
 *   same SQLSTATE from a wait that was allowed to start.
 * - `SKIP LOCKED` returns the rows nobody holds — "these are some of them" —
 *   which is why `SingleRowLockOptions` excludes it.
 * - `FOR NO KEY UPDATE` does not conflict with the `KEY SHARE` a foreign-key
 *   check takes, and `FOR UPDATE` does. This is the whole substance of the
 *   choice between the two strengths, and it is invisible from the SQL string.
 * - Under `read committed`, a locking scan that waited re-checks the row and
 *   drops it if it no longer matches the `WHERE` clause.
 */

const TABLE = 'it_lock';
const PARENT = 'it_lock_parent';
const CHILD = 'it_lock_child';

interface Row extends QueryResultRow {
  id: string;
  tags: string[];
  value: number;
  created_at: Date;
  updated_at: Date;
}

class Items extends BaseRepository<Row, { id: string; tags: string[]; value: number }> {
  protected override readonly tableName = TABLE;

  lockTagged(
    tx: TransactionClient,
    tags: readonly string[],
    options: RowLockOptions = {},
  ): Promise<Row[]> {
    return this.lockWhereArrayContains(tx, 'tags', tags, options);
  }
}

const items = new Items();

beforeAll(async () => {
  await createTable(
    TABLE,
    `
      id text PRIMARY KEY,
      tags text[] NOT NULL,
      value integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    `,
  );
  await createTable(PARENT, 'id text PRIMARY KEY, label text NOT NULL');
  await createTable(
    CHILD,
    `id text PRIMARY KEY, parent_id text NOT NULL REFERENCES "${PARENT}" (id)`,
  );
});

beforeEach(async () => {
  await truncate(CHILD, PARENT, TABLE);
  await query(
    `INSERT INTO "${TABLE}" (id, tags, value) VALUES
       ('a', ARRAY['admin'], 1),
       ('b', ARRAY['admin'], 2),
       ('c', ARRAY['user'], 3)`,
  );
  await query(`INSERT INTO "${PARENT}" (id, label) VALUES ('p', 'parent')`);
});

describe('FOR UPDATE', () => {
  it('blocks the second transaction until the first commits, which then reads the new value', async () => {
    const order: string[] = [];

    const { waiter } = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await items.lockById(tx, 'a');
          order.push('first-locked');
          held();
          await release;
          await tx.query(`UPDATE "${TABLE}" SET value = 42 WHERE id = 'a'`);
          order.push('first-committing');
        }),
      async () => {
        const blocked = withTransaction(
          async (tx) => {
            order.push('second-waiting');
            const row = await items.lockById(tx, 'a');
            order.push('second-locked');
            return row?.value;
          },
          { lockTimeoutMs: 10_000 },
        );

        // The one place a sleep is the right tool: the claim is that the second
        // transaction has *not* acquired the lock, and there is no event to
        // wait for.
        await wait(200);
        expect(order).toEqual(['first-locked', 'second-waiting']);
        return { waiter: blocked };
      },
    );

    expect(await waiter).toBe(42);
    expect(order).toEqual([
      'first-locked',
      'second-waiting',
      'first-committing',
      'second-locked',
    ]);
  });

  it('is released by a rollback as well as a commit', async () => {
    const rolledBack = withTransaction(async (tx) => {
      await items.lockById(tx, 'a');
      throw new Error('rolled back');
    });
    await expect(rolledBack).rejects.toThrow('rolled back');

    // Immediately available: `ROLLBACK` releases row locks exactly as `COMMIT`
    // does, so `NOWAIT` succeeding is the assertion — a wait would have passed
    // whether or not the lock had been released.
    expect((await withTransaction(async (tx) => items.lockById(tx, 'a', { wait: 'nowait' })))?.value).toBe(
      1,
    );
  });
});

describe('NOWAIT and lock_timeout', () => {
  it('NOWAIT fails with 55P03 instead of waiting', async () => {
    const elapsed = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await items.lockById(tx, 'a');
          held();
          await release;
        }),
      async () => {
        const started = Date.now();
        await expect(
          withTransaction(async (tx) => items.lockById(tx, 'a', { wait: 'nowait' })),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        return Date.now() - started;
      },
    );

    // "Immediately" is the point of `NOWAIT`; a generous bound still
    // distinguishes it from the `lock_timeout` case below.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('lock_timeout turns a wait that was allowed to start into the same 55P03', async () => {
    const elapsed = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await items.lockById(tx, 'a');
          held();
          await release;
        }),
      async () => {
        const started = Date.now();
        await expect(
          withTransaction(async (tx) => items.lockById(tx, 'a'), { lockTimeoutMs: 300 }),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
        return Date.now() - started;
      },
    );

    // It waited, which is what separates this from `NOWAIT` — same SQLSTATE,
    // different reason, and `db.errors.ts` renders both as a 409.
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  it('a missing row is null rather than a lock failure', async () => {
    expect(await withTransaction(async (tx) => items.lockById(tx, 'nope'))).toBeNull();
  });
});

describe('SKIP LOCKED', () => {
  it('returns the rows nobody else holds, which changes what the result means', async () => {
    const claimed = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await items.lockById(tx, 'a');
          held();
          await release;
        }),
      async () =>
        withTransaction(async (tx) => items.lockTagged(tx, ['admin'], { wait: 'skip locked' })),
    );

    // `a` and `b` both match the predicate. Only `b` comes back, and nothing
    // about the result says `a` exists — which is exactly why
    // `SingleRowLockOptions` has no `skip locked`: on a one-row read this is
    // indistinguishable from a 404.
    expect(claimed.map((row) => row.id)).toEqual(['b']);
  });

  it('locks a set in id order, so two claimants cannot take it in opposite orders', async () => {
    await query(
      `INSERT INTO "${TABLE}" (id, tags, value) VALUES ('z', ARRAY['admin'], 9), ('d', ARRAY['admin'], 4)`,
    );

    const locked = await withTransaction(async (tx) => items.lockTagged(tx, ['admin']));

    // Not presentation: a plan-dependent order is what lets two transactions
    // locking the same set deadlock, and the `ORDER BY "id"` removes the cycle
    // by construction.
    expect(locked.map((row) => row.id)).toEqual(['a', 'b', 'd', 'z']);
  });
});

describe('lock strength against a foreign-key check', () => {
  it('FOR NO KEY UPDATE lets a referencing insert through', async () => {
    await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await tx.query(`SELECT * FROM "${PARENT}" WHERE id = 'p' FOR NO KEY UPDATE`);
          held();
          await release;
        }),
      async () =>
        // The FK check takes `KEY SHARE` on the parent, which does not
        // conflict, so this completes rather than waiting the timeout out.
        withTransaction(
          async (tx) => tx.query(`INSERT INTO "${CHILD}" (id, parent_id) VALUES ('c1', 'p')`),
          { lockTimeoutMs: 2_000 },
        ),
    );

    expect(await items.count()).toBe(3);
    expect(
      await query<{ id: string }>(`SELECT id FROM "${CHILD}"`),
    ).toEqual([{ id: 'c1' }]);
  });

  it('FOR UPDATE blocks the same insert, for no benefit when no key is changing', async () => {
    await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          await tx.query(`SELECT * FROM "${PARENT}" WHERE id = 'p' FOR UPDATE`);
          held();
          await release;
        }),
      async () => {
        await expect(
          withTransaction(
            async (tx) => tx.query(`INSERT INTO "${CHILD}" (id, parent_id) VALUES ('c1', 'p')`),
            { lockTimeoutMs: 300 },
          ),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
      },
    );
  });
});

describe('the read-committed re-check', () => {
  it('drops a row that left the predicate while the scan was waiting', async () => {
    const { waiter } = await holding(
      ({ held, release }) =>
        withTransaction(async (tx) => {
          // `a` matches `tags @> ARRAY['admin']` and is about to stop.
          await tx.query(`SELECT * FROM "${TABLE}" WHERE id = 'a' FOR UPDATE`);
          held();
          await release;
          await tx.query(`UPDATE "${TABLE}" SET tags = ARRAY['user'] WHERE id = 'a'`);
        }),
      async () => {
        const blocked = withTransaction(async (tx) => items.lockTagged(tx, ['admin']), {
          lockTimeoutMs: 10_000,
        });
        // Long enough for the scan to be waiting on `a` rather than to have
        // passed it before the lock was taken.
        await wait(150);
        return { waiter: blocked };
      },
    );

    // The caveat `lockWhereArrayContains` documents, demonstrated: the waiter
    // re-checked `a` against the committed row and dropped it, so the result is
    // not a snapshot of any single instant — it is the smaller, later set.
    expect((await waiter).map((row) => row.id)).toEqual(['b']);
  });
});
