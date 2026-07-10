import type { QueryResultRow } from 'pg';
import { getPool } from '@/db/pool';

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await getPool().query<T>(sql, params as unknown[]);
  return result.rows[0] ?? null;
}

export async function queryCount(sql: string, params?: unknown[]): Promise<number> {
  const result = await getPool().query<{ count: string }>(sql, params as unknown[]);
  const row = result.rows[0];
  return row ? parseInt(row.count, 10) : 0;
}
