import { z } from 'zod';
import { AppError } from '@/lib/errors';

export const cursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export interface CursorPage<T> {
  data: T[];
  meta: {
    nextCursor: string | null;
    hasNextPage: boolean;
    limit: number;
  };
}

export interface CursorWhereClause {
  sql: string;
  params: unknown[];
}

export interface BuildCursorOptions {
  cursor: string | undefined;
  sortColumn: string;
  direction: 'ASC' | 'DESC';
  /** 1-based index of the first $N placeholder (default 1) */
  paramStart?: number;
}

function encodeCursor(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Malformed cursor payload');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'Invalid pagination cursor', 'INVALID_CURSOR');
  }
}

/**
 * Builds a SQL WHERE clause fragment for cursor-based pagination.
 *
 * Uses PostgreSQL row-value comparison so the query planner can leverage
 * a composite index on (sortColumn, id):
 *   ASC:  ("sort_col", "id") > ($n, $n+1)
 *   DESC: ("sort_col", "id") < ($n, $n+1)
 *
 * Returns an empty string when no cursor is provided (first page).
 */
export function buildCursorWhere(options: BuildCursorOptions): CursorWhereClause {
  const { cursor, sortColumn, direction, paramStart = 1 } = options;

  if (!cursor) {
    return { sql: '', params: [] };
  }

  const decoded = decodeCursor(cursor);
  const sortValue = decoded[sortColumn];
  const idValue = decoded['id'];

  if (sortValue === undefined || idValue === undefined) {
    throw new AppError(400, 'Invalid pagination cursor', 'INVALID_CURSOR');
  }

  const op = direction === 'ASC' ? '>' : '<';
  const sql = `("${sortColumn}", "id") ${op} ($${paramStart}, $${paramStart + 1})`;

  return { sql, params: [sortValue, idValue] };
}

/**
 * Creates a base64url-encoded cursor from a row, encoding the sort column
 * value and the row's id for stable, tie-breaking pagination.
 */
export function createCursor(row: Record<string, unknown>, sortColumn: string): string {
  const sortValue = row[sortColumn];
  const id = row['id'];
  if (sortValue === undefined || id === undefined) {
    throw new Error(`Row is missing required fields: ${sortColumn}, id`);
  }
  return encodeCursor({ [sortColumn]: sortValue, id });
}

/**
 * Wraps a row array into a CursorPage result.
 *
 * Caller must fetch `limit + 1` rows; the extra row signals whether a
 * next page exists without a separate COUNT query.
 */
export function paginate<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  sortColumn: string,
): CursorPage<T> {
  const hasNextPage = rows.length > limit;
  const data = hasNextPage ? rows.slice(0, limit) : rows;
  const lastRow = data.at(-1);
  const nextCursor =
    hasNextPage && lastRow !== undefined ? createCursor(lastRow, sortColumn) : null;

  return {
    data,
    meta: { nextCursor, hasNextPage, limit },
  };
}
