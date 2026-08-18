import type { QueryResultRow } from 'pg';
import { getPool } from '@/db/pool';
import type { Queryable } from '@/db/queryable';

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

/**
 * The pool as a `Queryable`, and the default executor for every repository
 * method.
 *
 * Built from the functions above rather than closing over `getPool()` so that a
 * suite which mocks `@/db/query` replaces this too — a partially mocked query
 * layer, where the repository's explicit calls are intercepted and its default
 * executor is not, is the kind of test that passes while asserting nothing.
 */
export const poolQueryable: Queryable = { query, queryOne, queryCount };
