const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
  poolQueryable: {
    query: (...args: unknown[]) => mockQuery(...args),
    queryOne: (...args: unknown[]) => mockQueryOne(...args),
    queryCount: (...args: unknown[]) => mockQueryCount(...args),
  },
}));

import type { QueryResultRow } from 'pg';
import { BaseRepository, MAX_BIND_PARAMETERS } from '@/db/repository';

interface ItemRow extends QueryResultRow {
  id: string;
  email: string;
  roles: string[];
}

type ItemInsert = { email: string; roles?: string[] };

class ItemRepository extends BaseRepository<ItemRow, ItemInsert> {
  protected override readonly tableName = 'items';
}

const repo = new ItemRepository();

/** The SQL of the single statement the call under test issued. */
function sql(): string {
  return (mockQuery.mock.calls[0] as [string, unknown[]])[0];
}

function params(): unknown[] {
  return (mockQuery.mock.calls[0] as [string, unknown[]])[1];
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([]);
});

describe('BaseRepository.createMany', () => {
  it('sends one statement for the whole batch', async () => {
    await repo.createMany([
      { email: 'a@x.test', roles: ['user'] },
      { email: 'b@x.test', roles: ['admin'] },
    ]);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(sql()).toContain('INSERT INTO "items" ("email", "roles") VALUES ($1, $2), ($3, $4)');
    expect(params()).toEqual(['a@x.test', ['user'], 'b@x.test', ['admin']]);
  });

  it('returns the inserted rows', async () => {
    mockQuery.mockResolvedValue([{ id: '1', email: 'a@x.test', roles: ['user'] }]);
    await expect(repo.createMany([{ email: 'a@x.test' }])).resolves.toEqual([
      { id: '1', email: 'a@x.test', roles: ['user'] },
    ]);
  });

  it('issues nothing at all for an empty batch', async () => {
    await expect(repo.createMany([])).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('errors on conflict by default', async () => {
    await repo.createMany([{ email: 'a@x.test' }]);
    expect(sql()).not.toContain('ON CONFLICT');
  });

  it('scopes DO NOTHING to the named constraint columns', async () => {
    await repo.createMany([{ email: 'a@x.test' }], {
      onConflict: 'ignore',
      conflictTarget: ['email'],
    });
    expect(sql()).toContain('ON CONFLICT ("email") DO NOTHING RETURNING *');
  });

  it('falls back to a bare DO NOTHING when no target is named', async () => {
    await repo.createMany([{ email: 'a@x.test' }], { onConflict: 'ignore' });
    expect(sql()).toContain('ON CONFLICT DO NOTHING');
  });

  it('quotes the conflict target, which is constrained to the row’s own columns', async () => {
    // The type is what keeps caller text out of the SQL; the quoting is what
    // keeps a legitimately reserved column name working.
    await repo.createMany([{ email: 'a@x.test' }], {
      onConflict: 'ignore',
      conflictTarget: ['email', 'id'],
    });
    expect(sql()).toContain('ON CONFLICT ("email", "id") DO NOTHING');
  });

  it('refuses a batch that would exceed the protocol’s bind-parameter ceiling', async () => {
    // Two columns, so the ceiling lands at 32,767 rows. Unchecked, `pg` builds a
    // message the server rejects with an error naming nothing that leads anyone
    // back to the batch size.
    const rows = Array.from({ length: MAX_BIND_PARAMETERS / 2 + 1 }, (_, i) => ({
      email: `user-${String(i)}@x.test`,
      roles: ['user'],
    }));

    await expect(repo.createMany(rows)).rejects.toThrow(/bind parameters/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts a batch exactly at the ceiling', async () => {
    const rows = Array.from({ length: MAX_BIND_PARAMETERS / 2 }, (_, i) => ({
      email: `user-${String(i)}@x.test`,
      roles: ['user'],
    }));
    await expect(repo.createMany(rows)).resolves.toEqual([]);
  });

  it('refuses a batch whose rows do not share one column list', async () => {
    // One statement has one column list. Padding the short row with NULL would
    // override the column's DEFAULT on exactly the rows that omitted it.
    await expect(
      repo.createMany([{ email: 'a@x.test', roles: ['user'] }, { email: 'b@x.test' }]),
    ).rejects.toThrow(/row 1 has columns/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses rows with no columns at all', async () => {
    await expect(repo.createMany([{} as unknown as ItemInsert])).rejects.toThrow(/no columns/);
  });

  it('sends the statement on the caller’s transaction when given one', async () => {
    const tx = { query: jest.fn().mockResolvedValue([]), queryOne: jest.fn(), queryCount: jest.fn() };
    await repo.createMany([{ email: 'a@x.test' }], {}, tx);

    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
