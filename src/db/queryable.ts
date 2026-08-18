import type { QueryResultRow } from 'pg';

/**
 * Somewhere a statement can be sent. The pool is one; a client inside an open
 * transaction is another.
 *
 * ## Why repositories take this rather than reaching for the pool
 *
 * A repository method that always issues its statement on the pool cannot be
 * called from inside a transaction — or rather it can, and the statement lands
 * on a *different* connection, outside the caller's transaction, where it
 * neither sees the caller's uncommitted rows nor rolls back with them. The
 * caller is then made to choose between using the repository and being atomic,
 * and the usual resolution is to hand-write the SQL at the call site, which is
 * how a repository layer stops being where the table's SQL lives.
 *
 * So every method below takes an optional executor. Omitted, it means the pool
 * and one statement is its own transaction, which is what the great majority of
 * reads want. Supplied, the statement joins whatever the caller has open.
 */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>;
  queryCount(sql: string, params?: unknown[]): Promise<number>;
}

/**
 * The brand that separates "a connection" from "a connection with a transaction
 * open on it", carried by `TransactionClient` and by nothing else.
 *
 * It exists because of what row locks do outside a transaction. `SELECT ... FOR
 * UPDATE` sent on an autocommit connection takes the lock and releases it when
 * the statement ends, so by the time the caller reads the row it just "locked",
 * it holds nothing. Nothing fails: no error, no warning, and the read-modify-
 * write it was guarding is exactly as racy as it was before the lock was added.
 * A defect whose only symptom is a race that shows up under load is worth a
 * compile error, and this is the type that produces one — the locking helpers
 * take a `TransactionClient`, so passing `poolQueryable` does not compile.
 *
 * The symbol is exported so an adapter can construct a client that satisfies
 * the type. That is deliberate: forging the brand should be possible, because
 * some caller will eventually have a connection this module did not hand out —
 * but it should be a line of code someone wrote on purpose and a reviewer can
 * find, not something that happens by passing the wrong argument.
 */
export const IN_TRANSACTION: unique symbol = Symbol('db.inTransaction');
