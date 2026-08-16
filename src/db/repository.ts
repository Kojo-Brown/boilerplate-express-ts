import type { QueryResultRow } from 'pg';
import { query, queryOne, queryCount } from '@/db/query';

export type OrderDirection = 'ASC' | 'DESC';

export interface FindAllOptions {
  orderBy?: string;
  order?: OrderDirection;
  limit?: number;
  offset?: number;
}

export type WhereCondition<TRow extends QueryResultRow> = {
  [K in keyof TRow]?: TRow[K];
};

export abstract class BaseRepository<
  TRow extends QueryResultRow,
  TInsert extends Record<string, unknown> = Record<string, unknown>,
  TUpdate extends Record<string, unknown> = Partial<TInsert>,
> {
  protected abstract readonly tableName: string;
  protected readonly hasTimestamps: boolean = true;

  async findById(id: string): Promise<TRow | null> {
    return queryOne<TRow>(`SELECT * FROM "${this.tableName}" WHERE id = $1`, [id]);
  }

  async findAll(options: FindAllOptions = {}): Promise<TRow[]> {
    const { orderBy = 'created_at', order = 'ASC', limit, offset } = options;
    const params: unknown[] = [];
    let sql = `SELECT * FROM "${this.tableName}" ORDER BY "${orderBy}" ${order}`;
    if (limit !== undefined) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (offset !== undefined) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
    return query<TRow>(sql, params.length > 0 ? params : undefined);
  }

  async findOne(where: WhereCondition<TRow>): Promise<TRow | null> {
    const entries = Object.entries(where).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return queryOne<TRow>(`SELECT * FROM "${this.tableName}" LIMIT 1`);
    }
    const conditions = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(' AND ');
    const values = entries.map(([, v]) => v);
    return queryOne<TRow>(
      `SELECT * FROM "${this.tableName}" WHERE ${conditions} LIMIT 1`,
      values,
    );
  }

  async findWhere(where: WhereCondition<TRow>, options: FindAllOptions = {}): Promise<TRow[]> {
    const entries = Object.entries(where).filter(([, v]) => v !== undefined);
    const { orderBy = 'created_at', order = 'ASC', limit, offset } = options;
    const params: unknown[] = entries.map(([, v]) => v);
    let sql: string;
    if (entries.length === 0) {
      sql = `SELECT * FROM "${this.tableName}"`;
    } else {
      const conditions = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(' AND ');
      sql = `SELECT * FROM "${this.tableName}" WHERE ${conditions}`;
    }
    sql += ` ORDER BY "${orderBy}" ${order}`;
    if (limit !== undefined) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (offset !== undefined) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
    return query<TRow>(sql, params.length > 0 ? params : undefined);
  }

  /**
   * Rows whose array column *contains* every one of `values` (Postgres `@>`).
   *
   * `findWhere` compares for equality, so passing an array to it asks "is this
   * column exactly this array", which is almost never what a caller with a
   * `text[]` column means. Subclasses need containment expressed in the base
   * class's own vocabulary; without it the tempting move is to cast an array
   * through `WhereCondition` and silently get equality semantics.
   *
   * `column` is constrained to the row's own string keys, so it cannot carry
   * caller-supplied text into the SQL.
   */
  protected async findWhereArrayContains(
    column: Extract<keyof TRow, string>,
    values: readonly unknown[],
    options: FindAllOptions = {},
  ): Promise<TRow[]> {
    const { orderBy = 'created_at', order = 'ASC', limit, offset } = options;
    const params: unknown[] = [values];
    let sql = `SELECT * FROM "${this.tableName}" WHERE "${column}" @> $1 ORDER BY "${orderBy}" ${order}`;
    if (limit !== undefined) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (offset !== undefined) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
    return query<TRow>(sql, params);
  }

  async create(data: TInsert): Promise<TRow> {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      const result = await queryOne<TRow>(
        `INSERT INTO "${this.tableName}" DEFAULT VALUES RETURNING *`,
      );
      if (!result) throw new Error(`Insert into "${this.tableName}" returned no rows`);
      return result;
    }
    const columns = entries.map(([k]) => `"${k}"`).join(', ');
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
    const values = entries.map(([, v]) => v);
    const result = await queryOne<TRow>(
      `INSERT INTO "${this.tableName}" (${columns}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    if (!result) throw new Error(`Insert into "${this.tableName}" returned no rows`);
    return result;
  }

  /**
   * Columns an update never writes, whatever a caller puts in the patch.
   *
   * A method rather than the inline `Set` this used to be, because subclasses
   * have columns of their own that the database owns — `version`, maintained by
   * a trigger, is the first. Letting a patch through to one of those does not
   * fail loudly: the write succeeds and the column silently disagrees with the
   * mechanism that depends on it.
   */
  protected immutableColumns(): readonly string[] {
    return this.hasTimestamps ? ['id', 'created_at', 'updated_at'] : ['id'];
  }

  async update(id: string, data: TUpdate): Promise<TRow | null> {
    const protectedCols = new Set(this.immutableColumns());
    const entries = Object.entries(data).filter(([k]) => !protectedCols.has(k));
    // Nothing to write: return the current row rather than issuing an UPDATE
    // whose only effect would be to bump `updated_at`. Checked before the
    // timestamp clause is appended, or `hasTimestamps` would defeat the guard.
    if (entries.length === 0) return this.findById(id);
    const setClauses: string[] = entries.map(([k], i) => `"${k}" = $${i + 1}`);
    const values: unknown[] = entries.map(([, v]) => v);
    if (this.hasTimestamps) {
      setClauses.push('"updated_at" = NOW()');
    }
    values.push(id);
    return queryOne<TRow>(
      `UPDATE "${this.tableName}" SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await queryOne<{ id: string }>(
      `DELETE FROM "${this.tableName}" WHERE id = $1 RETURNING id`,
      [id],
    );
    return result !== null;
  }

  async count(where?: WhereCondition<TRow>): Promise<number> {
    if (!where) {
      return queryCount(`SELECT COUNT(*) AS count FROM "${this.tableName}"`);
    }
    const entries = Object.entries(where).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return queryCount(`SELECT COUNT(*) AS count FROM "${this.tableName}"`);
    }
    const conditions = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(' AND ');
    const values = entries.map(([, v]) => v);
    return queryCount(
      `SELECT COUNT(*) AS count FROM "${this.tableName}" WHERE ${conditions}`,
      values,
    );
  }
}
