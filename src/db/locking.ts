/**
 * The `FOR ...` clause that turns a `SELECT` into a row lock.
 *
 * Pessimistic locking is the answer to the case optimistic concurrency cannot
 * reach. `updateWithVersion` decides a *single row's* write by comparing the
 * version the client named — it is a compare-and-swap, and it is the right tool
 * whenever the client holds a validator and can retry. It cannot help when the
 * rule being enforced spans rows, because each writer's own row is untouched
 * and every version check passes: two transactions each demoting a different
 * administrator both read "two administrators exist", both pass their
 * preconditions, and the system ends with none. Nothing about that is a lost
 * update; the invariant is over a set, and holding it requires holding the set
 * still while it is checked.
 *
 * @see https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
 */

/**
 * How strongly a locked row is held, weakest conflict surface last.
 *
 * The two that matter in practice are `update` and `no key update`, and picking
 * the wrong one costs concurrency rather than correctness. A foreign key check
 * — an insert into any table referencing this row — takes `key share` on the
 * parent, and `update` conflicts with it while `no key update` does not. So a
 * transaction that locks a user with `FOR UPDATE` in order to edit that user's
 * roles also blocks every insert that merely *references* the user, for no
 * benefit: nothing about the row's key is changing.
 *
 * `update` remains the honest choice when the row may be deleted, since a
 * delete does change the key, and `no key update` would let a referencing
 * insert proceed against a row that is about to disappear.
 */
export type RowLockStrength = 'update' | 'no key update' | 'share' | 'key share';

/**
 * What a statement does when the rows it wants are already locked.
 *
 * - `wait` — block until the holder commits or rolls back, bounded by the
 *   transaction's `lock_timeout` (see `TransactionOptions`). Correct default:
 *   the caller wants the row, and the wait is usually milliseconds.
 * - `nowait` — fail immediately with `55P03`. For a request that would rather
 *   answer "busy, try again" than hold a connection.
 * - `skip locked` — silently return only the rows nobody else holds. A queue
 *   claim, and nothing else: it changes what the result *means*, from "these
 *   are the matching rows" to "these are some of them", so any caller reasoning
 *   about a set (counting, checking membership, enforcing an invariant) is
 *   wrong under it.
 */
export type RowLockWait = 'wait' | 'nowait' | 'skip locked';

export interface RowLockOptions {
  readonly strength?: RowLockStrength;
  readonly wait?: RowLockWait;
}

/**
 * Locking options for a statement that reads at most one row.
 *
 * `skip locked` is removed rather than documented-against, because on a
 * single-row read it produces the one failure mode a caller cannot detect:
 * "locked by someone else" and "no such row" both arrive as zero rows, so the
 * contended case is reported as a 404 — an answer that tells the client to stop
 * retrying at exactly the moment retrying was the correct response.
 */
export interface SingleRowLockOptions {
  readonly strength?: RowLockStrength;
  readonly wait?: Exclude<RowLockWait, 'skip locked'>;
}

const STRENGTH_SQL: Record<RowLockStrength, string> = {
  update: 'FOR UPDATE',
  'no key update': 'FOR NO KEY UPDATE',
  share: 'FOR SHARE',
  'key share': 'FOR KEY SHARE',
};

const WAIT_SQL: Record<RowLockWait, string> = {
  wait: '',
  nowait: ' NOWAIT',
  'skip locked': ' SKIP LOCKED',
};

/**
 * Renders the clause. Both inputs are closed unions, so nothing caller-supplied
 * reaches the SQL — which is what lets this be appended as text at all.
 */
export function lockingClause(options: RowLockOptions = {}): string {
  const { strength = 'update', wait = 'wait' } = options;
  return `${STRENGTH_SQL[strength]}${WAIT_SQL[wait]}`;
}

/**
 * SQLSTATEs a transaction can fail with because of *contention*, and what each
 * one means for the caller.
 *
 * Kept here rather than inline at the two places that read it, because the
 * distinction between them is the entire retry policy and it is only visible
 * when they are side by side.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const SERIALIZATION_FAILURE = '40001';
export const DEADLOCK_DETECTED = '40P01';
export const LOCK_NOT_AVAILABLE = '55P03';
