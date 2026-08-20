import { advisoryLockKey, tryAdvisoryXactLock } from '@/db/advisory-lock';
import type { AdvisoryLockKey } from '@/db/advisory-lock';
import { withTransaction } from '@/db/transaction';
import type { IdempotencyStore } from '@/idempotency/idempotency.types';

/**
 * The scheduled sweep that keeps `idempotency_keys` from growing forever, and
 * the first real user of the advisory lock.
 *
 * The table is append-only from the protocol's point of view: `claim` inserts,
 * `complete` updates, and nothing ever deletes an expired row — `claim` simply
 * treats one as absent. `PostgresIdempotencyStore.purgeExpired` has existed
 * since the record was introduced and, until this file, was called by exactly
 * one thing: its own unit test. Every request through `POST /v1/users` was
 * leaving a row behind permanently.
 *
 * Which makes it the textbook shape for a distributed lock rather than a row
 * lock: the thing that must happen once is a *job*, and there is no row that
 * represents it. Every replica boots the same interval and reaches for the same
 * key; the winner sweeps, the losers return immediately and go back to serving
 * requests.
 */

/**
 * The namespace every lock in this service is derived under.
 *
 * One string, in one place, because the namespace is half of the identity: two
 * replicas coordinate only if both compute the same `classId`, so this is
 * deployment configuration frozen into a constant rather than something a call
 * site should be free to spell its own way.
 */
export const ADVISORY_LOCK_NAMESPACE = 'boilerplate-express-ts';

export const IDEMPOTENCY_PURGE_LOCK: AdvisoryLockKey = advisoryLockKey(
  ADVISORY_LOCK_NAMESPACE,
  'idempotency.purge',
);

/**
 * `purged` carries the row count; `skipped` means another replica held the lock
 * and this one did nothing at all.
 *
 * `skipped` is a success. It is reported rather than swallowed because the
 * ratio is the only signal that says whether the schedule is doing what it
 * looks like it is doing — all-skipped for a day means the winner is wedged
 * holding the key, which reads identically to "healthy" if the outcome is
 * discarded.
 */
export type IdempotencyPurgeOutcome =
  | { readonly outcome: 'purged'; readonly purged: number }
  | { readonly outcome: 'skipped' };

export interface RunIdempotencyPurgeOptions {
  /**
   * Bounds how long the sweep waits on a row lock before failing with `55P03`.
   *
   * The advisory lock itself is taken with `pg_try_advisory_xact_lock` and
   * never waits, but the `DELETE` underneath it does: an expired record whose
   * key is being taken over at that moment is locked by the request doing the
   * takeover. Housekeeping has no deadline worth blocking a connection for, so
   * it gives up quickly and finds the row again next hour.
   */
  readonly lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * One sweep.
 *
 * The transaction exists for the lock, and the `DELETE` runs inside it — hence
 * the executor being passed down to `purgeExpired` rather than letting it reach
 * for the pool. On the pool it would run on a *different* connection: still
 * serialised, because the transaction stays open across the await and the lock
 * with it, but no longer covered by it. Two things then become possible that
 * are not possible here — `idle_in_transaction_session_timeout` ending the
 * lock-holding transaction while the delete is still running on its own
 * connection, and the sweep costing two connections instead of one.
 *
 * Exported separately from the scheduler so a deployment that prefers an
 * external cron — a Kubernetes `CronJob`, an ECS scheduled task — can call this
 * and exit. The lock is what makes those safe to run concurrently with the
 * in-process schedule, so the choice is genuinely free.
 */
export async function runIdempotencyPurge(
  store: IdempotencyStore,
  options: RunIdempotencyPurgeOptions = {},
): Promise<IdempotencyPurgeOutcome> {
  const { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = options;

  return withTransaction(
    async (tx) => {
      const result = await tryAdvisoryXactLock(tx, IDEMPOTENCY_PURGE_LOCK, (locked) =>
        store.purgeExpired(locked),
      );
      return result.acquired
        ? ({ outcome: 'purged', purged: result.value } as const)
        : ({ outcome: 'skipped' } as const);
    },
    { lockTimeoutMs },
  );
}

export interface IdempotencyPurgeJobOptions extends RunIdempotencyPurgeOptions {
  readonly store: IdempotencyStore;
  /** How often to sweep. */
  readonly intervalMs: number;
  /** Called after every completed sweep. Default: logs a non-empty purge. */
  readonly onOutcome?: (outcome: IdempotencyPurgeOutcome) => void;
  /** Called when a sweep throws. Default: logs. Never rethrows. */
  readonly onError?: (error: unknown) => void;
}

export interface IdempotencyPurgeJob {
  /**
   * Stops the schedule and resolves once the sweep in flight has finished.
   *
   * Awaiting the in-flight run is the part that matters at shutdown: it is
   * holding an advisory lock inside an open transaction, and a process that
   * exits without letting it finish leaves the pool to tear the connection
   * down mid-statement.
   */
  stop(): Promise<void>;
}

function defaultOnOutcome(outcome: IdempotencyPurgeOutcome): void {
  // A skip and a sweep that found nothing are both the steady state; logging
  // either one hourly per replica is noise that trains people to filter the
  // channel the interesting line will arrive on.
  if (outcome.outcome === 'purged' && outcome.purged > 0) {
    console.log(`[idempotency purge] removed ${outcome.purged} expired record(s)`);
  }
}

function defaultOnError(error: unknown): void {
  console.error('[idempotency purge] sweep failed:', error);
}

/**
 * Starts the in-process schedule. Returns the handle that stops it.
 *
 * Three properties, each of which is a way this would otherwise misbehave in
 * production rather than a nicety:
 *
 * - **The timer is `unref`'d.** A `setInterval` keeps the event loop alive, so
 *   without this a service that has closed its listener still sits there until
 *   the next tick — and the janitor is the least important thing in the
 *   process to be deciding when it exits.
 * - **Runs never overlap in-process.** The advisory lock excludes *replicas*;
 *   it cannot exclude a second tick on the same one, because the lock is held
 *   by the session and a pool hands out a different connection each time — two
 *   ticks of this job would both acquire and both delete. A sweep that outruns
 *   its interval therefore skips ticks rather than stacking.
 * - **A failure never escapes.** An unhandled rejection from a timer callback
 *   is not attributable to any request and, under `--unhandled-rejections=throw`
 *   (Node's default since v15), takes the process down. A janitor that cannot
 *   reach the database must not be able to kill a service that is otherwise
 *   answering fine.
 */
export function startIdempotencyPurgeJob(
  options: IdempotencyPurgeJobOptions,
): IdempotencyPurgeJob {
  const {
    store,
    intervalMs,
    onOutcome = defaultOnOutcome,
    onError = defaultOnError,
    ...runOptions
  } = options;

  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `startIdempotencyPurgeJob: intervalMs must be a positive integer, received ${String(intervalMs)}`,
    );
  }

  let inFlight: Promise<void> | null = null;

  async function sweep(): Promise<void> {
    try {
      onOutcome(await runIdempotencyPurge(store, runOptions));
    } catch (err) {
      onError(err);
    }
  }

  function tick(): void {
    if (inFlight !== null) return;
    inFlight = sweep().finally(() => {
      inFlight = null;
    });
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await inFlight;
    },
  };
}
