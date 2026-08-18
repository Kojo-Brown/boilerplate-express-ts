const mockQueryOne = jest.fn();
const mockQuery = jest.fn();
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

import { UserRepository } from '@/users/users.repository';
import type { UserRow } from '@/users/users.repository';
import type { TransactionClient } from '@/db/transaction';
import { IN_TRANSACTION } from '@/db/queryable';

const repo = new UserRepository();

const makeUser = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: 'abc-123',
  email: 'test@example.com',
  password_hash: 'hashed',
  roles: ['user'],
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
  version: 1,
  ...overrides,
});

beforeEach(() => {
  mockQueryOne.mockReset();
  mockQuery.mockReset();
  mockQueryCount.mockReset();
});

describe('UserRepository.findByEmail', () => {
  it('finds a user by email using findOne', async () => {
    const user = makeUser();
    mockQueryOne.mockResolvedValue(user);
    const result = await repo.findByEmail('test@example.com');
    expect(result).toEqual(user);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE "email" = $1 LIMIT 1',
      ['test@example.com'],
    );
  });

  it('returns null when user not found', async () => {
    mockQueryOne.mockResolvedValue(null);
    const result = await repo.findByEmail('nobody@example.com');
    expect(result).toBeNull();
  });
});

describe('UserRepository inherits BaseRepository', () => {
  it('findById queries the users table', async () => {
    const user = makeUser({ id: 'user-id' });
    mockQueryOne.mockResolvedValue(user);
    await repo.findById('user-id');
    expect(mockQueryOne).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE id = $1',
      ['user-id'],
    );
  });

  it('create inserts into users table', async () => {
    const user = makeUser();
    mockQueryOne.mockResolvedValue(user);
    await repo.create({ email: 'test@example.com', password_hash: 'hashed' });
    expect(mockQueryOne).toHaveBeenCalledWith(
      'INSERT INTO "users" ("email", "password_hash") VALUES ($1, $2) RETURNING *',
      ['test@example.com', 'hashed'],
    );
  });

  it('update sets fields and updated_at on users table', async () => {
    const user = makeUser({ email: 'new@example.com' });
    mockQueryOne.mockResolvedValue(user);
    await repo.update('abc-123', { email: 'new@example.com' });
    const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE "users"');
    expect(sql).toContain('"email" = $1');
    expect(sql).toContain('"updated_at" = NOW()');
    expect(params).toContain('new@example.com');
    expect(params).toContain('abc-123');
  });

  it('delete removes a user by id', async () => {
    mockQueryOne.mockResolvedValue({ id: 'abc-123' });
    const deleted = await repo.delete('abc-123');
    expect(deleted).toBe(true);
    expect(mockQueryOne).toHaveBeenCalledWith(
      'DELETE FROM "users" WHERE id = $1 RETURNING id',
      ['abc-123'],
    );
  });
});

describe('UserRepository.findByRole', () => {
  it('asks for containment, not array equality', async () => {
    mockQuery.mockResolvedValue([]);

    await repo.findByRole('admin');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"roles" @> $1');
    expect(sql).not.toContain('"roles" = $1');
    expect(params).toEqual([['admin']]);
  });

  it('returns users who hold the role alongside others', async () => {
    // The equality form this replaced matched only rows whose roles column was
    // exactly ['admin'], so a user with ['admin','user'] was invisible.
    const multiRole = makeUser({ id: 'multi', roles: ['admin', 'user'] });
    mockQuery.mockResolvedValue([multiRole]);

    await expect(repo.findByRole('admin')).resolves.toEqual([multiRole]);
  });

  it('returns an empty list when nobody holds the role', async () => {
    mockQuery.mockResolvedValue([]);
    await expect(repo.findByRole('nobody-has-this')).resolves.toEqual([]);
  });
});

describe('UserRepository.lockAdmins', () => {
  const tx: TransactionClient = {
    [IN_TRANSACTION]: true,
    query: mockQuery,
    queryOne: mockQueryOne,
    queryCount: mockQueryCount,
  };

  it('locks every holder of the admin role, in id order, on the caller transaction', async () => {
    mockQuery.mockResolvedValue([]);

    await repo.lockAdmins(tx, 'update');

    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE "roles" @> $1 ORDER BY "id" ASC FOR UPDATE',
      [['admin']],
    );
  });

  /**
   * The two writers need different modes: a role change touches no key, so it
   * takes the weaker lock and leaves inserts that merely reference the user
   * unblocked, while a delete changes the key and needs the stronger one.
   */
  it('takes the weaker no-key lock when the caller asks for it', async () => {
    mockQuery.mockResolvedValue([]);

    await repo.lockAdmins(tx, 'no key update');

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('FOR NO KEY UPDATE');
  });

  it('returns the locked administrators', async () => {
    const admins = [makeUser({ id: 'admin-1', roles: ['admin'] })];
    mockQuery.mockResolvedValue(admins);

    await expect(repo.lockAdmins(tx, 'update')).resolves.toBe(admins);
  });
});
