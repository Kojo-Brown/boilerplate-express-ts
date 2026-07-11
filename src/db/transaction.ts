import type { QueryResultRow, PoolClient } from 'pg';
import { getPool } from '@/db/pool';

export interface TransactionClient {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>;
  queryCount(sql: string, params?: unknown[]): Promise<number>;
}

function buildTxClient(client: PoolClient): TransactionClient {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> {
      const result = await client.query<T>(sql, params as unknown[]);
      return result.rows;
    },

    async queryOne<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<T | null> {
      const result = await client.query<T>(sql, params as unknown[]);
      return result.rows[0] ?? null;
    },

    async queryCount(sql: string, params?: unknown[]): Promise<number> {
      const result = await client.query<{ count: string }>(sql, params as unknown[]);
      const row = result.rows[0];
      return row ? parseInt(row.count, 10) : 0;
    },
  };
}

export async function withTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await fn(buildTxClient(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback failure is suppressed; original error is rethrown
    }
    throw err;
  } finally {
    client.release();
  }
}
