const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@/db/pool', () => ({
  getPool: () => ({ connect: (...args: unknown[]) => mockConnect(...args) }),
}));

import { withTransaction } from '@/db/transaction';

beforeEach(() => {
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
  mockClientQuery.mockResolvedValue({ rows: [] });
});

describe('withTransaction', () => {
  describe('happy path', () => {
    it('sends BEGIN then COMMIT and returns the callback result', async () => {
      const result = await withTransaction(async () => 'success');
      expect(result).toBe('success');
      expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    });

    it('releases the client after a successful transaction', async () => {
      await withTransaction(async () => null);
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('rollback on error', () => {
    it('rolls back and rethrows the original error', async () => {
      const error = new Error('db failure');
      await expect(
        withTransaction(async () => {
          throw error;
        }),
      ).rejects.toThrow('db failure');
      expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClientQuery).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    });

    it('releases the client even when the transaction fails', async () => {
      await expect(
        withTransaction(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it('still releases the client and rethrows original when ROLLBACK itself throws', async () => {
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('network gone');
        return { rows: [] };
      });
      await expect(
        withTransaction(async () => {
          throw new Error('original error');
        }),
      ).rejects.toThrow('original error');
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('TransactionClient.query', () => {
    it('returns rows array from the result', async () => {
      const rows = [{ id: 1, name: 'item' }];
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })  // BEGIN
        .mockResolvedValueOnce({ rows })       // user query
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await withTransaction((tx) => tx.query('SELECT * FROM items'));
      expect(result).toEqual(rows);
    });

    it('forwards params to the underlying client', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await withTransaction((tx) => tx.query('SELECT * FROM items WHERE id = $1', ['abc']));
      expect(mockClientQuery).toHaveBeenNthCalledWith(
        2,
        'SELECT * FROM items WHERE id = $1',
        ['abc'],
      );
    });
  });

  describe('TransactionClient.queryOne', () => {
    it('returns the first row when rows are present', async () => {
      const row = { id: 'x', value: 99 };
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await withTransaction((tx) =>
        tx.queryOne('SELECT * FROM items WHERE id = $1', ['x']),
      );
      expect(result).toEqual(row);
    });

    it('returns null when no rows match', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await withTransaction((tx) =>
        tx.queryOne('SELECT * FROM items WHERE id = $1', ['missing']),
      );
      expect(result).toBeNull();
    });
  });

  describe('TransactionClient.queryCount', () => {
    it('parses the count string to a number', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '42' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await withTransaction((tx) =>
        tx.queryCount('SELECT COUNT(*) AS count FROM items'),
      );
      expect(result).toBe(42);
    });

    it('returns 0 when the result set is empty', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await withTransaction((tx) =>
        tx.queryCount('SELECT COUNT(*) AS count FROM items WHERE 1 = 0'),
      );
      expect(result).toBe(0);
    });
  });

  describe('multiple operations in one transaction', () => {
    it('executes all queries on the same client before committing', async () => {
      const insertedRow = { id: 'new', amount: 50 };
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })                // BEGIN
        .mockResolvedValueOnce({ rows: [insertedRow] })     // insert
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // count
        .mockResolvedValueOnce({ rows: [] });               // COMMIT

      const result = await withTransaction(async (tx) => {
        const [created] = await tx.query<{ id: string; amount: number }>(
          'INSERT INTO orders (amount) VALUES ($1) RETURNING *',
          [50],
        );
        const total = await tx.queryCount('SELECT COUNT(*) AS count FROM orders');
        return { created, total };
      });

      expect(result.created).toEqual(insertedRow);
      expect(result.total).toBe(1);
      expect(mockClientQuery).toHaveBeenCalledTimes(4);
      expect(mockClientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
    });
  });
});
