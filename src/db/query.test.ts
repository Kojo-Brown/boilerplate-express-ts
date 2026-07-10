const mockPoolQuery = jest.fn();

jest.mock('@/db/pool', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
}));

import { query, queryOne, queryCount } from '@/db/query';

beforeEach(() => {
  mockPoolQuery.mockClear();
});

describe('query', () => {
  it('returns all rows from the result set', async () => {
    const rows = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    mockPoolQuery.mockResolvedValue({ rows });
    const result = await query('SELECT * FROM users');
    expect(result).toEqual(rows);
  });

  it('forwards sql and params to pool.query', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await query('SELECT * FROM users WHERE id = $1', [42]);
    expect(mockPoolQuery).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [42]);
  });

  it('returns an empty array when no rows match', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const result = await query('SELECT * FROM users WHERE 1=0');
    expect(result).toEqual([]);
  });

  it('calls pool.query with undefined params when none are provided', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await query('SELECT 1');
    expect(mockPoolQuery).toHaveBeenCalledWith('SELECT 1', undefined);
  });
});

describe('queryOne', () => {
  it('returns the first row when rows exist', async () => {
    const rows = [{ id: 1, email: 'alice@example.com' }, { id: 2, email: 'bob@example.com' }];
    mockPoolQuery.mockResolvedValue({ rows });
    const result = await queryOne('SELECT * FROM users LIMIT 2');
    expect(result).toEqual({ id: 1, email: 'alice@example.com' });
  });

  it('returns null when no rows are found', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const result = await queryOne('SELECT * FROM users WHERE id = $1', [999]);
    expect(result).toBeNull();
  });

  it('forwards sql and params to pool.query', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 5 }] });
    await queryOne('SELECT * FROM users WHERE id = $1', [5]);
    expect(mockPoolQuery).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [5]);
  });
});

describe('queryCount', () => {
  it('parses the count string into a number', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ count: '42' }] });
    const count = await queryCount('SELECT COUNT(*) AS count FROM users');
    expect(count).toBe(42);
  });

  it('returns 0 when the result has no rows', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const count = await queryCount('SELECT COUNT(*) AS count FROM empty_table');
    expect(count).toBe(0);
  });

  it('forwards sql and params to pool.query', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ count: '3' }] });
    await queryCount('SELECT COUNT(*) AS count FROM users WHERE role = $1', ['admin']);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM users WHERE role = $1',
      ['admin'],
    );
  });

  it('handles a large count correctly', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ count: '1000000' }] });
    const count = await queryCount('SELECT COUNT(*) AS count FROM large_table');
    expect(count).toBe(1_000_000);
  });
});
