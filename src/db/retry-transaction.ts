import { DatabaseError } from 'pg';
import { fullJitterDelay } from '@/lib/backoff';
import { DEADLOCK_DETECTED, LOCK_NOT_AVAILABLE, SERIALIZATION_FAILURE } from '@/db/locking';
import { withTransaction } from '@/db/transaction';
import type { TransactionClient, TransactionOptions } from '@/db/transaction';

/**
 * The failures a transaction may be re-run after, and the only ones.
 *
 * Both are cases where Postgres has *already* rolled the transaction back and
 * said so on a connection that is still healthy. That is the property that
 * makes replaying safe, and it is a stronger claim than "the error looks
 * transient": the retry cannot double-apply the work, because there is no
 * outcome in which the first attempt's writes survive.
 *
 * - `40P01` deadlock_detected — two transactions waited on each other and
 *   Postgres chose this one to abort. The other one is making progress, so the
 *   retry is likely to find the row free.
 * - `40001` serialization_failure — under `repeatable read` or `serializable`,
 *   the transaction saw a state it can no longer be serialised into. Re-running
 *   it against the committed state is the documented way to handle this, and
 *   the reason a serialisable application needs a retry loop at all.
 *
 * ## What is deliberately absent
 *
 * `55P03` lock_not_available is not retried. It is raised by `NOWAIT`, which is
 * the caller having said "do not wait for this", and by `lock_timeout`
 * expiring, which is the caller having said how long it was willing to wait.
 * Re-entering the same wait immediately is a busy-wait against a holder that is
 * still holding, and it spends the request's deadline on the answer it already
 * has. The right recovery lives at the client, with its own backoff — which is
 * why `db.errors.ts` renders it as a 409 rather than swallowing it.
 *
 * Connection-level failures (`ECONNRESET`, `57P01 admin_shutdown`, a pool
 * timeout) are not retried either, and this is the important one. A connection
 * that dies while `COMMIT` is in flight leaves the outcome genuinely unknown —
 * the server may have committed and lost the acknowledgement — so a retry can
 * apply the transaction twice. "The error arrived after the work may have
 * landed" is exactly the case a retry loop must refuse; recovering from it
 * needs a deduplication key, which this codebase spells `Idempotency-Key`.
 */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
]);

/** Total attempts including the first. Three covers a deadlock plus one more. */
const DEFAULT_ATTEMPTS = 3;

/**
 * Deliberately small. A deadlock is only detected after `deadlock_timeout` —
 * one second by default — so the request has already spent most of any sane
 * deadline before this delay is even chosen. The contending transaction was
 * aborted or committed by the time the error arrived, so there is nothing to
 * wait *out*; the delay exists only to keep two abort-and-retry loops from
 * lockstepping into each other again.
 */
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 250;

export interface RetryableTransactionOptions extends TransactionOptions {
  /** Total attempts including the first. `1` disables retrying. */
  readonly attempts?: number;
  /** First backoff step; doubles per attempt. Default 25ms. */
  readonly baseDelayMs?: number;
  /** Ceiling for a single backoff step. Default 250ms. */
  readonly maxDelayMs?: number;
  /** Which SQLSTATEs are worth another attempt. Default `RETRYABLE_SQLSTATES`. */
  readonly retryOn?: ReadonlySet<string>;
  /** Injected so tests do not spend real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so the jitter is reproducible under test. */
  readonly random?: () => number;
}

/** The SQLSTATE of a driver error, or `null` for anything else. */
export function sqlStateOf(err: unknown): string | null {
  return err instanceof DatabaseError && err.code !== undefined ? err.code : null;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` in a transaction, re-running the whole transaction when it fails on
 * contention.
 *
 * ## Why the retry is outside the transaction and not inside it
 *
 * There is no such thing as retrying a statement after a deadlock. The
 * transaction is already aborted when the error arrives; every subsequent
 * statement on that connection fails with `25P02 in_failed_sql_transaction`
 * until it is rolled back. So the unit of retry is the transaction, which is
 * why this wraps `withTransaction` rather than being an option inside it — each
 * attempt gets its own `BEGIN`, its own snapshot, and its own locks.
 *
 * That also fixes what `fn` may contain, and it is the one rule a caller has to
 * follow: **the callback must be safe to run more than once.** Database work
 * qualifies by construction — the failed attempt rolled back. Anything else
 * does not. Publishing a domain event, invalidating a cache, sending a mail,
 * charging a card: run those *after* this call returns, on the committed
 * result, or a deadlock silently doubles them. The signature helps as far as a
 * signature can — `fn` receives a `TransactionClient` and nothing else — but
 * the callback can still close over the world, so this is a rule, not a
 * guarantee.
 *
 * The attempt number is passed through, mostly so a caller can log the second
 * one. Deadlock retries that succeed are invisible otherwise, and a route whose
 * throughput quietly depends on them is worth knowing about before it stops
 * succeeding.
 */
export async function withRetryableTransaction<T>(
  fn: (client: TransactionClient, attempt: number) => Promise<T>,
  options: RetryableTransactionOptions = {},
): Promise<T> {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    retryOn = RETRYABLE_SQLSTATES,
    sleep = sleepFor,
    random = Math.random,
    ...transactionOptions
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(
      `withRetryableTransaction: attempts must be an integer >= 1, received ${String(attempts)}`,
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTransaction((tx) => fn(tx, attempt), transactionOptions);
    } catch (err) {
      const sqlState = sqlStateOf(err);
      // The last attempt's error is thrown as it is, rather than wrapped in a
      // "retries exhausted" error: a deadlock that survived three tries is
      // still a deadlock, and `db.errors.ts` already knows what to answer for
      // it. Wrapping would hide the SQLSTATE behind a class the translator
      // chain does not recognise, turning a 409 into a 500.
      if (attempt >= attempts || sqlState === null || !retryOn.has(sqlState)) throw err;
      await sleep(fullJitterDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs, random }));
    }
  }
}

/**
 * True for a failure that means "somebody else is writing this right now".
 *
 * Exported for call sites that need to tell contention apart from a genuine
 * fault — a metric, a log line worth a different level — without re-deriving
 * the SQLSTATE list.
 */
export function isContentionError(err: unknown): boolean {
  const sqlState = sqlStateOf(err);
  return (
    sqlState === DEADLOCK_DETECTED ||
    sqlState === SERIALIZATION_FAILURE ||
    sqlState === LOCK_NOT_AVAILABLE
  );
}
