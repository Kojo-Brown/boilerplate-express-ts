import { createHash } from 'crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '@/db/pool';
import type { Queryable } from '@/db/queryable';
import type { TransactionClient } from '@/db/transaction';
import { localSettingStatements } from '@/db/transaction';

/**
 * A mutex whose subject is not a row.
 *
 * Row locks (`db/locking.ts`) can hold still anything that exists in a table,
 * and that is their limit: `SELECT ... FOR UPDATE` needs rows to lock. The
 * things a multi-replica service most needs to serialise have none. "Only one
 * instance runs the purge", "only one instance drains the outbox", "only one
 * process applies the migrations" are all statements about *work*, and the
 * usual workaround — inventing a `jobs` table so there is something to lock —
 * buys a row, a migration and a cleanup story for a mutex that Postgres already
 * offers directly.
 *
 * An advisory lock is that mutex: a 64-bit name in a lock table Postgres
 * maintains but never interprets, taken and released like any other lock, and
 * therefore participating in the same wait graph. Both facts were verified
 * against PostgreSQL 16 rather than assumed, because both are load-bearing
 * here: `lock_timeout` does abort a waiting `pg_advisory_xact_lock` with
 * `55P03`, and two transactions taking two advisory locks in opposite order do
 * deadlock and are reported as `40P01`. Everything `withTransaction` and
 * `withRetryableTransaction` already do about contention therefore applies
 * unchanged, which is the main reason to prefer this over a lock invented in
 * application code.
 *
 * ## Advisory, in the sense that nothing enforces it
 *
 * Postgres does not know what the key means. Code that takes the lock is
 * excluded; code that does not is not. That makes it exactly as strong as a
 * mutex in a single process and no stronger — a second code path that touches
 * the same data without asking for the key proceeds straight through, and there
 * is no equivalent of the foreign key or the unique index that would have
 * caught it. Which is the argument for keeping the set of keys small, named,
 * and declared in one place per module rather than constructed at call sites.
 *
 * @see https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
 */

const ADVISORY_LOCK_KEY: unique symbol = Symbol('db.advisoryLockKey');

/**
 * A resolved advisory lock name: the two `int4`s Postgres will actually be
 * asked for, plus the strings they were derived from so a log line, an error or
 * a `pg_locks` join can say which lock is meant.
 *
 * Branded so the pair cannot be assembled inline. Two unrelated call sites that
 * each write `{ classId: 1, objId: 7 }` have silently agreed to exclude each
 * other, and nothing about either one says so; going through
 * `advisoryLockKey()` means the agreement is a shared name.
 */
export interface AdvisoryLockKey {
  readonly [ADVISORY_LOCK_KEY]: true;
  readonly namespace: string;
  readonly name: string;
  readonly classId: number;
  readonly objId: number;
}

/**
 * The outcome of an acquisition that was allowed to fail.
 *
 * A discriminated union rather than `T | null`, because `null` is a value the
 * callback may legitimately return and the two cases have to stay
 * distinguishable: "nobody else was running, and the answer is nothing" is not
 * "somebody else is running".
 */
export type AdvisoryLockResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

export interface AdvisorySessionLockOptions {
  /**
   * `wait` blocks until the holder releases; `nowait` resolves
   * `{ acquired: false }` immediately.
   *
   * Default `nowait`, the opposite of the transaction-scoped helpers' default,
   * and the difference is what the two are for. A session lock is held across
   * transactions by something long-running — a relay, a scheduled job, a
   * leader — and a second instance that queues behind it does not become
   * useful when it finally wins the lock hours later; it runs a job whose
   * moment has passed while its connection sat blocked. Skipping is the
   * correct answer to "someone is already doing this".
   */
  readonly wait?: 'wait' | 'nowait';
  /**
   * Bounds a `wait: 'wait'` acquisition, failing it with `55P03`.
   *
   * Applied with `SET LOCAL` inside a short transaction that exists only to
   * take the lock, so the setting is reverted before the connection is used
   * for anything else — a session-level `SET` on a pooled connection outlives
   * the request that made it.
   */
  readonly lockTimeoutMs?: number;
}

/**
 * Derives a lock key from two names.
 *
 * ## Why the two-`int4` form rather than the `bigint` one
 *
 * Postgres offers both, and they are *separate lock spaces*: a session holding
 * `pg_advisory_xact_lock(1, 2)` does not block `pg_advisory_xact_lock(4294967298)`
 * even though the bit patterns match — confirmed against PostgreSQL 16, where
 * `pg_locks` distinguishes them by `objsubid` (1 for the bigint form, 2 for the
 * pair). The whole space is global to the database and shared with every
 * extension, tool and application connected to it; `node-pg-migrate`, for one,
 * takes an advisory lock of its own around a migration run. Choosing the form
 * this codebase does not otherwise use, and deriving `classId` from a namespace
 * string, is what keeps an accidental collision with somebody else's lock out
 * of the picture, and it costs nothing.
 *
 * ## What a collision inside the namespace would mean
 *
 * `objId` is 32 bits of SHA-256, so two different names in one namespace can
 * hash to the same lock. That is a false conflict — two unrelated jobs
 * serialise against each other — and never a missed one, so it is a latency
 * bug rather than a correctness bug; the failure mode is bounded by
 * construction. It is still a reason to keep namespaces to a handful of named
 * coordination points rather than to mint a key per row: at a few dozen names
 * a collision is vanishingly unlikely, at tens of thousands it is expected, and
 * a per-row mutex is `SELECT ... FOR UPDATE`, which has the row to lock and
 * needs no hash at all.
 *
 * The digest is part of the deployed contract, not an implementation detail:
 * two replicas exclude each other only by computing the same integers, so
 * changing how these are derived is a change that has to go out everywhere
 * before it means anything. That is why it is SHA-256 of the name rather than
 * a JS string hash — stable across processes, releases and Node versions.
 */
export function advisoryLockKey(namespace: string, name: string): AdvisoryLockKey {
  assertNonEmpty('namespace', namespace);
  assertNonEmpty('name', name);

  return {
    [ADVISORY_LOCK_KEY]: true,
    namespace,
    name,
    classId: hash32(namespace),
    objId: hash32(name),
  };
}

/** Renders a key for a log line or an error message. */
export function formatAdvisoryLockKey(key: AdvisoryLockKey): string {
  return `${key.namespace}/${key.name} (${key.classId}, ${key.objId})`;
}

/**
 * Takes the lock for the rest of `tx`, waiting for it, and runs `fn` holding
 * it.
 *
 * ## The automatic release
 *
 * There is no unlock call here and no `finally` that could be skipped, because
 * `pg_advisory_xact_lock` is released by the transaction ending — on `COMMIT`,
 * on `ROLLBACK`, and on the connection dying with neither. That is the whole
 * argument for preferring the transaction-scoped family: every other way to
 * hold a distributed lock has a path where the holder disappears and the lock
 * does not, and recovering from that means a lease, a heartbeat, and a fencing
 * token to keep the evicted holder from writing after its lease expired.
 * Postgres already knows the holder is gone, because the holder is a session.
 *
 * ## Why it takes a `TransactionClient`
 *
 * The same reason the row-lock helpers do, and the failure is quieter here. Run
 * on an autocommit connection, `pg_advisory_xact_lock` takes the lock and
 * releases it when that statement ends — verified: a second session acquires
 * the key immediately afterwards. Nothing errors, nothing warns, and the
 * critical section that follows runs unprotected. The brand makes passing the
 * pool a compile error instead.
 *
 * ## What the caller still owns
 *
 * *How long to wait* belongs to the transaction, not to this call:
 * `withTransaction`'s `lockTimeoutMs` bounds the wait, and without it a
 * blocked acquisition waits forever while holding a pooled connection. Set it
 * on any transaction that takes a lock it might have to wait for.
 *
 * *How much work to do while holding it* is the other half. The lock is held
 * until the transaction ends, not until `fn` resolves, so everything after this
 * call in the same transaction is inside the critical section too. Keep the
 * transaction to the work the lock is protecting.
 */
export async function withAdvisoryXactLock<T>(
  tx: TransactionClient,
  key: AdvisoryLockKey,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  await tx.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [key.classId, key.objId]);
  return fn(tx);
}

/**
 * Takes the lock for the rest of `tx` if it is free, and otherwise does not run
 * `fn` at all.
 *
 * This is the right default for scheduled work. Every replica wakes on the same
 * interval and reaches for the same key; with a waiting acquisition they queue,
 * and the queue drains into N consecutive runs of a job that needed one — each
 * of which finds nothing to do, having been preceded by the run that did it,
 * while its connection was parked for the duration. Skipping makes the losers
 * free.
 *
 * The miss is returned rather than thrown, because for the caller it is an
 * ordinary outcome and usually not even worth a log line above `debug`. A
 * caller that does need it to be an error has the discriminant to raise one.
 */
export async function tryAdvisoryXactLock<T>(
  tx: TransactionClient,
  key: AdvisoryLockKey,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  const row = await tx.queryOne<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS acquired',
    [key.classId, key.objId],
  );
  if (row?.acquired !== true) return { acquired: false };
  return { acquired: true, value: await fn(tx) };
}

/**
 * Holds the lock for a critical section that must not sit inside a transaction,
 * on a connection pinned for its duration.
 *
 * ## When this rather than the transaction-scoped pair
 *
 * When the work is long. A transaction open for minutes pins its connection
 * *and* holds back the cluster's `xmin` horizon, so autovacuum cannot reclaim
 * dead tuples anywhere in the database for as long as it runs — a job that
 * merely wanted a mutex ends up bloating tables it never touched. A session
 * lock costs the connection and nothing else. It is also the only option for
 * work that must commit incrementally: a relay that marks each batch delivered
 * as it goes cannot do that inside one transaction and still be at-least-once.
 *
 * ## Making the release automatic anyway
 *
 * A session lock is released when the session ends, and a pooled connection's
 * session does not end — it goes back in the pool and serves the next request
 * still holding the key. So the release is explicit, and the interesting part
 * is what happens when the explicit release does not work: `pg_advisory_unlock`
 * resolving `false` (this session does not hold it, which it should) or
 * throwing (the connection is in an unknown state) both mean the lock's fate is
 * no longer known. Both therefore destroy the connection instead of returning
 * it, which ends the session, which is what Postgres releases session locks on.
 * The pool opens a replacement; the alternative is a key held until the process
 * exits, silently, by a connection nobody can identify.
 *
 * ## Not reentrant
 *
 * Each call checks out its own connection, so a nested acquisition of the same
 * key is a different session asking a holder to let go — under `wait` that is a
 * self-deadlock no detector will report, since the two are not waiting on each
 * other in the graph; the outer one is not waiting at all. It is one more
 * reason the default is `nowait`, where the nested call cleanly answers
 * `{ acquired: false }`.
 */
export async function withAdvisorySessionLock<T>(
  key: AdvisoryLockKey,
  fn: (client: Queryable) => Promise<T>,
  options: AdvisorySessionLockOptions = {},
): Promise<AdvisoryLockResult<T>> {
  const { wait = 'nowait', lockTimeoutMs } = options;
  // Built before the connection is taken: a malformed timeout must throw
  // without having checked one out. `SET LOCAL` needs a transaction to be
  // local to, which the acquisition below already opens.
  const settings = localSettingStatements({ lockTimeoutMs });

  const client: PoolClient = await getPool().connect();
  let held = false;

  try {
    // `BEGIN`/`COMMIT` around the acquisition only. The lock outlives it —
    // session locks survive both `COMMIT` and `ROLLBACK`, verified — while
    // `SET LOCAL lock_timeout` does not, which is the point: the setting must
    // not follow this connection back into the pool.
    await client.query('BEGIN');
    try {
      for (const setting of settings) await client.query(setting);
      if (wait === 'wait') {
        // Returns `void`, and returning at all is the acquisition; the only
        // other way out is the throw that `lock_timeout` produces.
        await client.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [key.classId, key.objId]);
        held = true;
      } else {
        const result = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired',
          [key.classId, key.objId],
        );
        held = result.rows[0]?.acquired === true;
      }
      await client.query('COMMIT');
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    }

    if (!held) return { acquired: false };
    return { acquired: true, value: await fn(asQueryable(client)) };
  } finally {
    if (held) held = !(await unlockQuietly(client, key));
    // Releasing with an error destroys the connection rather than returning it
    // to the pool. Reached only when the unlock did not demonstrably succeed,
    // and then it *is* the release: ending the session is what Postgres drops
    // a session lock on.
    client.release(
      held ? new Error(`advisory lock ${formatAdvisoryLockKey(key)} was not released`) : undefined,
    );
  }
}

/** True when the lock is demonstrably released. */
async function unlockQuietly(client: PoolClient, key: AdvisoryLockKey): Promise<boolean> {
  try {
    const result = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock($1::int4, $2::int4) AS released',
      [key.classId, key.objId],
    );
    if (result.rows[0]?.released === true) return true;
    // Postgres also emits a warning for this. It means the session does not
    // hold the key it took — the connection was reset underneath us, or
    // something else unlocked it — so the count this session is responsible
    // for is no longer knowable and the connection cannot be trusted back.
    console.error(`[advisory lock] ${formatAdvisoryLockKey(key)} was not held at release`);
    return false;
  } catch (err) {
    console.error(`[advisory lock] failed to release ${formatAdvisoryLockKey(key)}:`, err);
    return false;
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Suppressed so the original acquisition failure is what propagates.
  }
}

/**
 * The pinned connection as a `Queryable`, so the callback's own statements go
 * to the session that holds the lock.
 *
 * Not a `TransactionClient`: nothing is open, and branding it would claim a
 * guarantee the row-lock helpers rely on and this connection does not have.
 */
function asQueryable(client: PoolClient): Queryable {
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

/**
 * The leading four bytes of the SHA-256 digest, read as a signed 32-bit
 * integer because that is what `pg_advisory_lock(int, int)` takes — the range
 * is Postgres's, so the sign is not a detail to normalise away.
 */
function hash32(input: string): number {
  return createHash('sha256').update(input, 'utf8').digest().readInt32BE(0);
}

function assertNonEmpty(label: string, value: string): void {
  if (value.length === 0) {
    throw new RangeError(`advisoryLockKey: ${label} must be a non-empty string`);
  }
}
