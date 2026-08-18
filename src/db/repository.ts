import type { QueryResultRow } from 'pg';
import { poolQueryable } from '@/db/query';
import type { Queryable } from '@/db/queryable';
import { lockingClause } from '@/db/locking';
import type { RowLockOptions, SingleRowLockOptions } from '@/db/locking';
import type { TransactionClient } from '@/db/transaction';

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

  /**
   * Where this call's statement is sent: the caller's open transaction if it
   * passed one, the pool otherwise.
   *
   * Every method takes the executor as an optional *last* parameter, so no
   * existing call site changes and joining a transaction is one argument. The
   * alternative shape — a repository constructed around a connection, so that
   * `new UserRepository(tx)` is a different object from the singleton — was
   * rejected because it makes the repository's lifetime depend on the
   * transaction's, and the container registers this one as a singleton.
   */
  protected executor(tx?: Queryable): Queryable {
    return tx ?? poolQueryable;
  }

  async findById(id: string, tx?: Queryable): Promise<TRow | null> {
    const db = this.executor(tx);
    return db.queryOne<TRow>(`SELECT * FROM "${this.tableName}" WHERE id = $1`, [id]);
  }

  async findAll(options: FindAllOptions = {}, tx?: Queryable): Promise<TRow[]> {
    const db = this.executor(tx);
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
    return db.query<TRow>(sql, params.length > 0 ? params : undefined);
  }

  async findOne(where: WhereCondition<TRow>, tx?: Queryable): Promise<TRow | null> {
    const db = this.executor(tx);
    const entries = Object.entries(where).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return db.queryOne<TRow>(`SELECT * FROM "${this.tableName}" LIMIT 1`);
    }
    const conditions = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(' AND ');
    const values = entries.map(([, v]) => v);
    return db.queryOne<TRow>(
      `SELECT * FROM "${this.tableName}" WHERE ${conditions} LIMIT 1`,
      values,
    );
  }

  async findWhere(
    where: WhereCondition<TRow>,
    options: FindAllOptions = {},
    tx?: Queryable,
  ): Promise<TRow[]> {
    const db = this.executor(tx);
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
    return db.query<TRow>(sql, params.length > 0 ? params : undefined);
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
    tx?: Queryable,
  ): Promise<TRow[]> {
    const db = this.executor(tx);
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
    return db.query<TRow>(sql, params);
  }

  async create(data: TInsert, tx?: Queryable): Promise<TRow> {
    const db = this.executor(tx);
    const entries = Object.entries(data);
    if (entries.length === 0) {
      const result = await db.queryOne<TRow>(
        `INSERT INTO "${this.tableName}" DEFAULT VALUES RETURNING *`,
      );
      if (!result) throw new Error(`Insert into "${this.tableName}" returned no rows`);
      return result;
    }
    const columns = entries.map(([k]) => `"${k}"`).join(', ');
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
    const values = entries.map(([, v]) => v);
    const result = await db.queryOne<TRow>(
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

  async update(id: string, data: TUpdate, tx?: Queryable): Promise<TRow | null> {
    const db = this.executor(tx);
    const protectedCols = new Set(this.immutableColumns());
    const entries = Object.entries(data).filter(([k]) => !protectedCols.has(k));
    // Nothing to write: return the current row rather than issuing an UPDATE
    // whose only effect would be to bump `updated_at`. Checked before the
    // timestamp clause is appended, or `hasTimestamps` would defeat the guard.
    if (entries.length === 0) return this.findById(id, tx);
    const setClauses: string[] = entries.map(([k], i) => `"${k}" = $${i + 1}`);
    const values: unknown[] = entries.map(([, v]) => v);
    if (this.hasTimestamps) {
      setClauses.push('"updated_at" = NOW()');
    }
    values.push(id);
    return db.queryOne<TRow>(
      `UPDATE "${this.tableName}" SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
  }

  async delete(id: string, tx?: Queryable): Promise<boolean> {
    const db = this.executor(tx);
    const result = await db.queryOne<{ id: string }>(
      `DELETE FROM "${this.tableName}" WHERE id = $1 RETURNING id`,
      [id],
    );
    return result !== null;
  }

  async count(where?: WhereCondition<TRow>, tx?: Queryable): Promise<number> {
    const db = this.executor(tx);
    if (!where) {
      return db.queryCount(`SELECT COUNT(*) AS count FROM "${this.tableName}"`);
    }
    const entries = Object.entries(where).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return db.queryCount(`SELECT COUNT(*) AS count FROM "${this.tableName}"`);
    }
    const conditions = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(' AND ');
    const values = entries.map(([, v]) => v);
    return db.queryCount(
      `SELECT COUNT(*) AS count FROM "${this.tableName}" WHERE ${conditions}`,
      values,
    );
  }

  /**
   * Read one row and hold it against concurrent writers until `tx` ends.
   *
   * The `tx` parameter is required here and optional everywhere else, which is
   * the point: a lock outside a transaction is released when the statement that
   * took it finishes, so `findById`-with-`FOR UPDATE`-on-the-pool returns a row
   * it is no longer protecting and the read-modify-write it was added to guard
   * is exactly as racy as before. Requiring a `TransactionClient` — a type only
   * `withTransaction` hands out — makes that a compile error rather than a race
   * that appears under load.
   *
   * Returns `null` for a row that does not exist. It cannot mean anything else,
   * because `SingleRowLockOptions` has no `skip locked`.
   */
  async lockById(
    tx: TransactionClient,
    id: string,
    options: SingleRowLockOptions = {},
  ): Promise<TRow | null> {
    return tx.queryOne<TRow>(
      `SELECT * FROM "${this.tableName}" WHERE id = $1 ${lockingClause(options)}`,
      [id],
    );
  }

  /**
   * Lock every row whose array column contains `values`, in `id` order.
   *
   * The locking counterpart of `findWhereArrayContains`, and the ordering is
   * the substance rather than presentation. Lock a set in an order that depends
   * on the plan, and two transactions locking the same set can take its members
   * in opposite orders and deadlock; agreeing on a total order over the table's
   * primary key removes the cycle by construction, so the transactions queue
   * instead of one of them being aborted. It is cheaper than the retry loop for
   * exactly the contention it prevents — a deadlock is not detected until
   * `deadlock_timeout` elapses, one second by default, which is longer than
   * most of the requests it interrupts.
   *
   * What it does not prevent is a cycle with a writer that is not using this
   * method: an unconditional `UPDATE` from a backfill, a `psql` session, a
   * future repository method that locks by some other key. Deterministic
   * ordering holds among participants who share the convention, which is why
   * `withRetryableTransaction` exists and is not made redundant by this.
   *
   * ## The caveat worth stating
   *
   * Under `read committed`, a locking scan that had to wait re-checks the row
   * it was waiting for against the *updated* version and drops it if it no
   * longer matches the `WHERE` clause. That is the behaviour an invariant check
   * over this set depends on — after a concurrent transaction commits a change
   * that removes a row from the set, the waiter sees the smaller set — but it
   * also means the result is not a snapshot of any single instant, and a row
   * added to the set by a transaction that commits during the wait is not seen
   * at all. An invariant of the form "at least one must remain" is safe under
   * that, since it can only be under-counted; one of the form "at most N" is
   * not, and needs `repeatable read` plus a retry loop.
   */
  protected async lockWhereArrayContains(
    tx: TransactionClient,
    column: Extract<keyof TRow, string>,
    values: readonly unknown[],
    options: RowLockOptions = {},
  ): Promise<TRow[]> {
    return tx.query<TRow>(
      `SELECT * FROM "${this.tableName}" WHERE "${column}" @> $1 ORDER BY "id" ASC ${lockingClause(options)}`,
      [values],
    );
  }
}
