import type { QueryResultRow, PoolClient } from 'pg';
import { getPool } from '@/db/pool';
import { IN_TRANSACTION } from '@/db/queryable';
import type { Queryable } from '@/db/queryable';

/**
 * A `Queryable` that is demonstrably inside an open transaction.
 *
 * The brand is the whole difference — see `IN_TRANSACTION`. Row locks are the
 * reason it exists: taken outside a transaction they are released at the end of
 * the statement that took them, silently, so a lock helper that accepted any
 * executor would compile, run, and protect nothing.
 */
export interface TransactionClient extends Queryable {
  readonly [IN_TRANSACTION]: true;
}

/**
 * Postgres transaction isolation levels, lowercase because these are values
 * rather than SQL fragments; `beginStatement` writes the SQL.
 *
 * `read uncommitted` is absent because Postgres does not implement it — asking
 * for it silently gets you `read committed`, and a setting that does not do
 * what its name says is worse than one that is unavailable.
 */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  /** Default: whatever the server's `default_transaction_isolation` says. */
  readonly isolationLevel?: IsolationLevel;
  /**
   * How long a statement in this transaction will wait for a lock before it
   * fails with `55P03`.
   *
   * Effectively required for any transaction that takes row locks, and the
   * reason is the connection rather than the lock: a blocked statement holds
   * its pooled connection for as long as it waits, so a single slow lock holder
   * is enough to park every one of the pool's connections on the same row while
   * requests that never touch it queue behind them. `0` restores Postgres's
   * default of waiting forever, and is not the same as omitting this.
   */
  readonly lockTimeoutMs?: number;
  /**
   * How long a statement waits before Postgres checks whether it is in a
   * deadlock cycle. Server default is 1s.
   *
   * Worth lowering for a transaction that has both a `lockTimeoutMs` and a
   * retry loop around it, because the two interact in a way that is easy to
   * miss: with a lock timeout below `deadlock_timeout`, a genuine cycle is
   * reported as `55P03` — "still held" — before the detector ever runs, and the
   * retry loop, which exists for `40P01`, never engages. Setting this under the
   * lock timeout is what makes a deadlock arrive labelled as one.
   *
   * The cost is that deadlock detection is not free: each check walks the wait
   * graph under a global lock, and every lock wait longer than this value pays
   * for one. Low values suit a short, contended transaction, not a bulk job
   * whose statements routinely wait.
   */
  readonly deadlockTimeoutMs?: number;
}

const ISOLATION_SQL: Record<IsolationLevel, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

export function beginStatement(options: TransactionOptions = {}): string {
  const { isolationLevel } = options;
  return isolationLevel === undefined
    ? 'BEGIN'
    : `BEGIN ISOLATION LEVEL ${ISOLATION_SQL[isolationLevel]}`;
}

/**
 * The `SET LOCAL` statements this transaction's options ask for, in the order
 * they should be sent. Empty when none were given.
 *
 * `SET` does not accept bind parameters, so these values are interpolated — and
 * therefore checked first. A non-integer here is a programming error rather
 * than client input, so it throws at the call instead of being coerced:
 * rounding `500.7` to a timeout nobody chose hides the bug, and letting an
 * unchecked value through is how a settings-shaped string becomes an injection
 * point the day one of them starts coming from configuration.
 *
 * `LOCAL` and not `SESSION`, because the connection goes back to the pool. A
 * session-scoped `SET` would follow it there and apply to whatever unrelated
 * request picked it up next, which is a bug that only appears under load and
 * only on some requests.
 */
export function localSettingStatements(options: TransactionOptions = {}): string[] {
  const settings: [name: string, value: number | undefined][] = [
    ['lock_timeout', options.lockTimeoutMs],
    ['deadlock_timeout', options.deadlockTimeoutMs],
  ];

  return settings.flatMap(([name, ms]) => {
    if (ms === undefined) return [];
    if (!Number.isInteger(ms) || ms < 0) {
      throw new RangeError(
        `withTransaction: ${name} must be given as a non-negative integer of milliseconds, received ${String(ms)}`,
      );
    }
    return [`SET LOCAL ${name} = '${ms}ms'`];
  });
}

function buildTxClient(client: PoolClient): TransactionClient {
  return {
    [IN_TRANSACTION]: true,

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
  options: TransactionOptions = {},
): Promise<T> {
  // Built before the connection is taken. A malformed timeout throws here, and
  // doing it after `connect()` would leak a pooled connection on the way out —
  // the `finally` below only covers what is inside the `try`.
  const settings = localSettingStatements(options);
  const client: PoolClient = await getPool().connect();

  try {
    await client.query(beginStatement(options));
    for (const setting of settings) await client.query(setting);
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
