const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
  // The repository's default executor. Absent from this factory it would be
  // `undefined`, and every call that did not explicitly pass a transaction
  // would fail on it — see `poolQueryable` in `@/db/query`.
  poolQueryable: { query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockQueryOne(...args), queryCount: (...args: unknown[]) => mockQueryCount(...args) },
}));

import type { QueryResultRow } from 'pg';
import { BaseRepository } from '@/db/repository';
import type { FindAllOptions, WhereCondition } from '@/db/repository';
import type { RowLockOptions } from '@/db/locking';
import type { TransactionClient } from '@/db/transaction';
import { IN_TRANSACTION } from '@/db/queryable';

interface TestRow extends QueryResultRow {
  id: string;
  name: string;
  value: number;
  created_at: Date;
  updated_at: Date;
}

type TestInsert = { name: string; value: number };
type TestUpdate = { name?: string; value?: number };

class TestRepository extends BaseRepository<TestRow, TestInsert, TestUpdate> {
  protected override readonly tableName = 'test_items';
}

class NoTimestampsRepository extends BaseRepository<TestRow, TestInsert, TestUpdate> {
  protected override readonly tableName = 'simple_items';
  protected override readonly hasTimestamps = false;
}

const repo = new TestRepository();
const noTsRepo = new NoTimestampsRepository();

beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
});

describe('BaseRepository.findById', () => {
  it('queries by id and returns the row', async () => {
    const row: TestRow = { id: '1', name: 'item', value: 42, created_at: new Date(), updated_at: new Date() };
    mockQueryOne.mockResolvedValue(row);
    const result = await repo.findById('1');
    expect(result).toEqual(row);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE id = $1',
      ['1'],
    );
  });

  it('returns null when no row found', async () => {
    mockQueryOne.mockResolvedValue(null);
    const result = await repo.findById('nonexistent');
    expect(result).toBeNull();
  });
});

describe('BaseRepository.findAll', () => {
  it('returns all rows with default ordering', async () => {
    const rows: TestRow[] = [
      { id: '1', name: 'a', value: 1, created_at: new Date(), updated_at: new Date() },
      { id: '2', name: 'b', value: 2, created_at: new Date(), updated_at: new Date() },
    ];
    mockQuery.mockResolvedValue(rows);
    const result = await repo.findAll();
    expect(result).toEqual(rows);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" ORDER BY "created_at" ASC',
      undefined,
    );
  });

  it('applies limit and offset', async () => {
    mockQuery.mockResolvedValue([]);
    await repo.findAll({ limit: 10, offset: 20 });
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" ORDER BY "created_at" ASC LIMIT $1 OFFSET $2',
      [10, 20],
    );
  });

  it('applies custom orderBy and order direction', async () => {
    mockQuery.mockResolvedValue([]);
    const options: FindAllOptions = { orderBy: 'name', order: 'DESC' };
    await repo.findAll(options);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" ORDER BY "name" DESC',
      undefined,
    );
  });

  it('applies only limit without offset', async () => {
    mockQuery.mockResolvedValue([]);
    await repo.findAll({ limit: 5 });
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" ORDER BY "created_at" ASC LIMIT $1',
      [5],
    );
  });
});

describe('BaseRepository.findOne', () => {
  it('finds a row by where condition', async () => {
    const row: TestRow = { id: '1', name: 'target', value: 99, created_at: new Date(), updated_at: new Date() };
    mockQueryOne.mockResolvedValue(row);
    const where: WhereCondition<TestRow> = { name: 'target' };
    const result = await repo.findOne(where);
    expect(result).toEqual(row);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE "name" = $1 LIMIT 1',
      ['target'],
    );
  });

  it('handles multiple where conditions', async () => {
    mockQueryOne.mockResolvedValue(null);
    await repo.findOne({ name: 'x', value: 5 });
    const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"name" = $1');
    expect(sql).toContain('"value" = $2');
    expect(params).toEqual(['x', 5]);
  });

  it('returns first row when where is empty', async () => {
    mockQueryOne.mockResolvedValue(null);
    await repo.findOne({});
    expect(mockQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" LIMIT 1',
    );
  });
});

describe('BaseRepository.findWhere', () => {
  it('finds all rows matching where condition', async () => {
    const rows: TestRow[] = [
      { id: '1', name: 'a', value: 5, created_at: new Date(), updated_at: new Date() },
    ];
    mockQuery.mockResolvedValue(rows);
    await repo.findWhere({ value: 5 });
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE "value" = $1 ORDER BY "created_at" ASC',
      [5],
    );
  });

  it('returns all rows when where is empty', async () => {
    mockQuery.mockResolvedValue([]);
    await repo.findWhere({});
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" ORDER BY "created_at" ASC',
      undefined,
    );
  });

  it('applies limit and offset with where', async () => {
    mockQuery.mockResolvedValue([]);
    await repo.findWhere({ name: 'foo' }, { limit: 3, offset: 6 });
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE "name" = $1 ORDER BY "created_at" ASC LIMIT $2 OFFSET $3',
      ['foo', 3, 6],
    );
  });
});

describe('BaseRepository.create', () => {
  it('inserts a row and returns it', async () => {
    const row: TestRow = { id: 'new-id', name: 'new', value: 7, created_at: new Date(), updated_at: new Date() };
    mockQueryOne.mockResolvedValue(row);
    const result = await repo.create({ name: 'new', value: 7 });
    expect(result).toEqual(row);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'INSERT INTO "test_items" ("name", "value") VALUES ($1, $2) RETURNING *',
      ['new', 7],
    );
  });

  it('throws when insert returns no rows', async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(repo.create({ name: 'x', value: 1 })).rejects.toThrow(
      'Insert into "test_items" returned no rows',
    );
  });

  it('uses DEFAULT VALUES when data is empty', async () => {
    const row: TestRow = { id: 'def', name: '', value: 0, created_at: new Date(), updated_at: new Date() };
    mockQueryOne.mockResolvedValue(row);
    await repo.create({} as TestInsert);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'INSERT INTO "test_items" DEFAULT VALUES RETURNING *',
    );
  });
});

describe('BaseRepository.update', () => {
  it('updates a row and returns it', async () => {
    const updated: TestRow = { id: '1', name: 'updated', value: 99, created_at: new Date(), updated_at: new Date() };
    mockQueryOne.mockResolvedValue(updated);
    const result = await repo.update('1', { name: 'updated' });
    expect(result).toEqual(updated);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'UPDATE "test_items" SET "name" = $1, "updated_at" = NOW() WHERE id = $2 RETURNING *',
      ['updated', '1'],
    );
  });

  it('excludes protected columns from SET clause', async () => {
    mockQueryOne.mockResolvedValue(null);
    await repo.update('1', { name: 'safe' } as TestUpdate & Record<string, unknown>);
    const [sql] = mockQueryOne.mock.calls[0] as [string];
    expect(sql).not.toContain('"id" =');
    expect(sql).not.toContain('"created_at" =');
  });

  it('does not add updated_at clause when hasTimestamps is false', async () => {
    mockQueryOne.mockResolvedValue(null);
    await noTsRepo.update('1', { name: 'val' });
    const [sql] = mockQueryOne.mock.calls[0] as [string];
    expect(sql).not.toContain('updated_at');
    expect(sql).toContain('"name" = $1');
  });

  it('falls back to findById when no updatable fields provided', async () => {
    const row: TestRow = { id: '1', name: 'x', value: 1, created_at: new Date(), updated_at: new Date() };
    mockQueryOne.mockResolvedValue(row);
    const result = await repo.update('1', {});
    expect(mockQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE id = $1',
      ['1'],
    );
    expect(result).toEqual(row);
  });
});

describe('BaseRepository.delete', () => {
  it('returns true when a row is deleted', async () => {
    mockQueryOne.mockResolvedValue({ id: '1' });
    const result = await repo.delete('1');
    expect(result).toBe(true);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'DELETE FROM "test_items" WHERE id = $1 RETURNING id',
      ['1'],
    );
  });

  it('returns false when no row matched', async () => {
    mockQueryOne.mockResolvedValue(null);
    const result = await repo.delete('nonexistent');
    expect(result).toBe(false);
  });
});

describe('BaseRepository.count', () => {
  it('counts all rows when no where clause provided', async () => {
    mockQueryCount.mockResolvedValue(5);
    const result = await repo.count();
    expect(result).toBe(5);
    expect(mockQueryCount).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM "test_items"',
    );
  });

  it('counts rows matching where condition', async () => {
    mockQueryCount.mockResolvedValue(2);
    const result = await repo.count({ value: 42 });
    expect(result).toBe(2);
    expect(mockQueryCount).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM "test_items" WHERE "value" = $1',
      [42],
    );
  });

  it('counts all rows when where is empty object', async () => {
    mockQueryCount.mockResolvedValue(10);
    await repo.count({});
    expect(mockQueryCount).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM "test_items"',
    );
  });
});

/**
 * A double for the client `withTransaction` hands out. The brand is written by
 * hand here, which `IN_TRANSACTION` says is the intended way to produce one
 * outside the transaction module: visible, deliberate, and greppable.
 */
const txQuery = jest.fn();
const txQueryOne = jest.fn();
const txQueryCount = jest.fn();
const tx: TransactionClient = {
  [IN_TRANSACTION]: true,
  query: txQuery,
  queryOne: txQueryOne,
  queryCount: txQueryCount,
};

/** Exposes the protected locking helper for direct assertions. */
class LockingRepository extends TestRepository {
  lockAdminsLike(client: TransactionClient, options?: RowLockOptions): Promise<TestRow[]> {
    return this.lockWhereArrayContains(client, 'name', ['admin'], options);
  }
}

const lockingRepo = new LockingRepository();

beforeEach(() => {
  txQuery.mockReset();
  txQueryOne.mockReset();
  txQueryCount.mockReset();
});

describe('BaseRepository executor routing', () => {
  /**
   * The point of the optional executor: a repository call inside a transaction
   * has to land on that transaction's connection. Sent to the pool it would run
   * outside the caller's transaction, see none of its uncommitted rows, and
   * survive its rollback.
   */
  it('sends the statement to the transaction when one is passed', async () => {
    txQueryOne.mockResolvedValue(null);

    await repo.findById('1', tx);

    expect(txQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('falls back to the pool when no transaction is passed', async () => {
    mockQueryOne.mockResolvedValue(null);

    await repo.findById('1');

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(txQueryOne).not.toHaveBeenCalled();
  });

  it.each([
    ['findAll', async (client?: TransactionClient) => repo.findAll({}, client), txQuery],
    ['findOne', async (client?: TransactionClient) => repo.findOne({ id: '1' }, client), txQueryOne],
    [
      'findWhere',
      async (client?: TransactionClient) => repo.findWhere({ id: '1' }, {}, client),
      txQuery,
    ],
    [
      'create',
      async (client?: TransactionClient) => repo.create({ name: 'n', value: 1 }, client),
      txQueryOne,
    ],
    [
      'update',
      async (client?: TransactionClient) => repo.update('1', { name: 'n' }, client),
      txQueryOne,
    ],
    ['delete', async (client?: TransactionClient) => repo.delete('1', client), txQueryOne],
    ['count', async (client?: TransactionClient) => repo.count(undefined, client), txQueryCount],
  ])('%s joins the caller transaction', async (_name, call, expected) => {
    txQuery.mockResolvedValue([]);
    txQueryOne.mockResolvedValue({ id: '1' });
    txQueryCount.mockResolvedValue(0);

    await call(tx);

    expect(expected).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockQueryCount).not.toHaveBeenCalled();
  });
});

describe('BaseRepository.lockById', () => {
  it('appends FOR UPDATE by default', async () => {
    txQueryOne.mockResolvedValue(null);

    await repo.lockById(tx, 'row-1');

    expect(txQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE id = $1 FOR UPDATE',
      ['row-1'],
    );
  });

  it('carries the requested strength and wait policy into the clause', async () => {
    txQueryOne.mockResolvedValue(null);

    await repo.lockById(tx, 'row-1', { strength: 'no key update', wait: 'nowait' });

    expect(txQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE id = $1 FOR NO KEY UPDATE NOWAIT',
      ['row-1'],
    );
  });

  it('returns the locked row', async () => {
    const row: TestRow = {
      id: 'row-1',
      name: 'item',
      value: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    txQueryOne.mockResolvedValue(row);

    await expect(repo.lockById(tx, 'row-1')).resolves.toBe(row);
  });

  /**
   * `null` can only mean "no such row" here, and that is a property of the
   * types rather than of this assertion: `SingleRowLockOptions` has no
   * `skip locked`, so a contended row cannot come back as an empty result.
   */
  it('returns null for a row that does not exist', async () => {
    txQueryOne.mockResolvedValue(null);
    await expect(repo.lockById(tx, 'missing')).resolves.toBeNull();
  });

  it('never issues its statement on the pool', async () => {
    txQueryOne.mockResolvedValue(null);

    await repo.lockById(tx, 'row-1');

    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('BaseRepository.lockWhereArrayContains', () => {
  /**
   * The ordering is the substance. Two transactions locking the same set in
   * opposite orders deadlock; ordering by the primary key gives every caller
   * the same sequence, so they queue instead.
   */
  it('locks in primary-key order', async () => {
    txQuery.mockResolvedValue([]);

    await lockingRepo.lockAdminsLike(tx);

    expect(txQuery).toHaveBeenCalledWith(
      'SELECT * FROM "test_items" WHERE "name" @> $1 ORDER BY "id" ASC FOR UPDATE',
      [['admin']],
    );
  });

  it('uses containment rather than equality, so a longer list still matches', async () => {
    txQuery.mockResolvedValue([]);

    await lockingRepo.lockAdminsLike(tx);

    const [sql] = txQuery.mock.calls[0] as [string];
    expect(sql).toContain('@>');
    expect(sql).not.toMatch(/"name" = /);
  });

  it('honours the requested lock strength', async () => {
    txQuery.mockResolvedValue([]);

    await lockingRepo.lockAdminsLike(tx, { strength: 'no key update' });

    const [sql] = txQuery.mock.calls[0] as [string];
    expect(sql).toContain('FOR NO KEY UPDATE');
  });

  it('returns the locked rows', async () => {
    const rows: TestRow[] = [
      { id: 'a', name: 'admin', value: 1, created_at: new Date(), updated_at: new Date() },
    ];
    txQuery.mockResolvedValue(rows);

    await expect(lockingRepo.lockAdminsLike(tx)).resolves.toBe(rows);
  });
});
