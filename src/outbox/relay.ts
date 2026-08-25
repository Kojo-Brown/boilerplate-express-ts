import { fullJitterDelay } from '@/lib/backoff';
import { withTransaction } from '@/db/transaction';
import type { EventPayloadMap } from '@/events/event-bus';
import { describeFailure, OutboxDispatchTimeoutError } from '@/outbox/outbox.errors';
import type { OutboxDispatcher, OutboxMessage, OutboxStore } from '@/outbox/outbox.types';

/**
 * The relay: the half of the outbox that turns durable rows into delivered
 * events.
 *
 * ## At-least-once, and where the "at least" comes from
 *
 * One batch is one transaction: claim rows with `FOR UPDATE SKIP LOCKED`,
 * dispatch each, delete the delivered ones, and commit. A crash anywhere in
 * that sequence rolls the deletes back while leaving whatever the dispatcher
 * already did done — so a message delivered a moment before the process died is
 * claimed again by the next relay and delivered a second time. That is not a
 * bug to be fixed later; it is the only guarantee available. Exactly-once
 * delivery across two systems that cannot commit together does not exist, and
 * the honest arrangement is the one that never loses a message and admits it
 * may repeat one.
 *
 * Which makes the consumer's obligation the load-bearing half of the design,
 * and it is why `OutboxMessage.id` is the row's primary key rather than a value
 * generated per attempt: a redelivery is recognisable.
 *
 * ## Why the marks are inside the claim's transaction
 *
 * Because they must be. The claim is a row lock, and a lock only exists for as
 * long as its transaction: a delete issued after the commit would race with
 * whichever relay claimed the row in the meantime. Keeping them together also
 * means a batch is atomic in the direction that matters — the outcomes recorded
 * are exactly the outcomes that were reached before the crash, never a subset
 * chosen by which statement happened to have flushed.
 *
 * The cost is that the transaction stays open for the whole batch, holding its
 * connection and the cluster's `xmin` horizon with it. That is bounded, not
 * hoped about: `batchSize * dispatchTimeoutMs` is the worst case, and both are
 * deliberately small.
 */

/** What one pass through the queue did. */
export interface OutboxRelayOutcome {
  /** Rows locked. Fewer than `batchSize` when another relay held some. */
  readonly claimed: number;
  readonly delivered: number;
  readonly rescheduled: number;
  readonly deadLettered: number;
}

const EMPTY_OUTCOME: OutboxRelayOutcome = {
  claimed: 0,
  delivered: 0,
  rescheduled: 0,
  deadLettered: 0,
};

export interface OutboxRelayOptions<TEvents extends EventPayloadMap> {
  readonly store: OutboxStore<TEvents>;
  readonly dispatcher: OutboxDispatcher;
  /**
   * Rows per transaction. Small on purpose: it is the multiplier on how long
   * one transaction can stay open, and a larger batch buys throughput the
   * poll interval could have bought without holding a connection for it.
   */
  readonly batchSize?: number;
  /**
   * How many full batches one tick may drain before yielding.
   *
   * Without it, a poll interval is also a rate limit — a backlog of ten
   * thousand messages at one batch per five seconds takes half an hour to
   * clear. With it, a tick keeps claiming while batches come back full, which
   * is the shape of a backlog, and stops as soon as one does not.
   */
  readonly maxBatchesPerTick?: number;
  /**
   * Attempts before a message is dead-lettered, counting the first.
   *
   * Finite because the alternative is a message that fails forever taking a
   * slot in every batch for the life of the deployment. The ladder below is
   * what makes the number small enough to be a decision rather than a
   * formality.
   */
  readonly maxAttempts?: number;
  /** First backoff step; doubles per attempt, with full jitter. */
  readonly baseDelayMs?: number;
  /** Ceiling for a single backoff step. */
  readonly maxDelayMs?: number;
  /**
   * Backstop for a dispatcher that does not come back. See
   * `OutboxDispatchTimeoutError` — it bounds the relay's *wait*, not the work.
   */
  readonly dispatchTimeoutMs?: number;
  /**
   * How long a statement in the claim transaction waits on a lock.
   *
   * `SKIP LOCKED` means the claim itself never waits, so this covers the marks
   * — an `UPDATE` on a row some other statement is holding. Housekeeping has no
   * deadline worth parking a pooled connection for.
   */
  readonly lockTimeoutMs?: number;
  /** Injected so the jitter is reproducible under test. */
  readonly random?: () => number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_BATCHES_PER_TICK = 5;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Awaits `dispatch`, or gives up on it.
 *
 * `Promise.race` and not an `AbortSignal`, because the dispatcher's contract is
 * a promise and nothing more — a signal would only be enforceable on the
 * dispatchers that chose to read it, which is the subset that did not need the
 * backstop. The losing promise stays attached to the race, so a dispatcher that
 * rejects after the timeout has already fired does not become an unhandled
 * rejection.
 */
async function dispatchWithin(
  dispatcher: OutboxDispatcher,
  message: OutboxMessage,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new OutboxDispatchTimeoutError(message.id, message.name, timeoutMs)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([dispatcher(message), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One dispatch's outcome, so a dispatcher failure never shares a `catch` with a store failure. */
type DispatchAttempt = { readonly delivered: true } | { readonly delivered: false; readonly error: unknown };

async function attemptDispatch(
  dispatcher: OutboxDispatcher,
  message: OutboxMessage,
  timeoutMs: number,
): Promise<DispatchAttempt> {
  try {
    await dispatchWithin(dispatcher, message, timeoutMs);
    return { delivered: true };
  } catch (error) {
    return { delivered: false, error };
  }
}

/**
 * Claims one batch, delivers it, and records what happened — all in one
 * transaction.
 *
 * A dispatcher failure is contained per message rather than abandoning the
 * batch: it is not a SQL error, so the transaction is still healthy, and one
 * broken message must not cost the nineteen beside it their outcomes. A failure
 * from the *store* is different and is left to propagate — the transaction is
 * likely aborted, and every mark in this batch is rolled back with it.
 */
export async function runOutboxBatch<TEvents extends EventPayloadMap>(
  options: OutboxRelayOptions<TEvents>,
): Promise<OutboxRelayOutcome> {
  const {
    store,
    dispatcher,
    batchSize = DEFAULT_BATCH_SIZE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    random = Math.random,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `runOutboxBatch: maxAttempts must be an integer >= 1, received ${String(maxAttempts)}`,
    );
  }

  return withTransaction(async (tx) => {
    const messages = await store.claimDue(tx, batchSize);

    let delivered = 0;
    let rescheduled = 0;
    let deadLettered = 0;

    for (const message of messages) {
      // The `try` covers the dispatch and nothing else, which is a distinction
      // with teeth: a `store` call that fails has not failed to *deliver*, it
      // has failed to record a delivery that already happened. Catching it here
      // would reschedule a message the dispatcher sent — guaranteeing the
      // duplicate rather than risking it — and would do so with a statement
      // issued on a transaction Postgres may have already aborted, which fails
      // in turn and is swallowed by the same handler. Store failures belong to
      // the transaction: they propagate, everything in the batch rolls back,
      // and the rows are claimed again.
      const attempt = await attemptDispatch(dispatcher, message, dispatchTimeoutMs);

      if (attempt.delivered) {
        await store.remove(tx, message.id);
        delivered += 1;
      } else {
        const reason = describeFailure(attempt.error);
        // `attempts` is what the row carried, so this attempt is the next one.
        const attemptsAfter = message.attempts + 1;

        if (attemptsAfter >= maxAttempts) {
          await store.deadLetter(tx, message.id, reason);
          deadLettered += 1;
        } else {
          // Full jitter for the reason `lib/backoff.ts` gives and which applies
          // with particular force here: every message in a batch that failed
          // because one dependency is down failed at the same instant, so a
          // fixed ladder would re-present all of them together, and the
          // recovering dependency would meet the same spike that took it down.
          const delayMs = fullJitterDelay(attemptsAfter, {
            baseMs: baseDelayMs,
            maxMs: maxDelayMs,
            random,
          });
          await store.reschedule(tx, message.id, delayMs, reason);
          rescheduled += 1;
        }
      }
    }

    return { claimed: messages.length, delivered, rescheduled, deadLettered };
  }, { lockTimeoutMs });
}

/**
 * One tick: batches until the queue stops coming back full.
 *
 * "Full" rather than "non-empty" is the right stopping condition, and a short
 * batch under contention stops it early on purpose — a short batch means
 * another relay is holding the rows this one skipped, so there is nothing here
 * left to do that somebody else is not already doing.
 */
export async function runOutboxRelay<TEvents extends EventPayloadMap>(
  options: OutboxRelayOptions<TEvents>,
): Promise<OutboxRelayOutcome> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    maxBatchesPerTick = DEFAULT_MAX_BATCHES_PER_TICK,
  } = options;

  if (!Number.isInteger(maxBatchesPerTick) || maxBatchesPerTick < 1) {
    throw new RangeError(
      `runOutboxRelay: maxBatchesPerTick must be an integer >= 1, received ${String(maxBatchesPerTick)}`,
    );
  }

  let total: OutboxRelayOutcome = EMPTY_OUTCOME;

  for (let batch = 0; batch < maxBatchesPerTick; batch += 1) {
    const outcome = await runOutboxBatch(options);
    total = {
      claimed: total.claimed + outcome.claimed,
      delivered: total.delivered + outcome.delivered,
      rescheduled: total.rescheduled + outcome.rescheduled,
      deadLettered: total.deadLettered + outcome.deadLettered,
    };
    if (outcome.claimed < batchSize) break;
  }

  return total;
}

export interface OutboxRelayJobOptions<TEvents extends EventPayloadMap>
  extends OutboxRelayOptions<TEvents> {
  /**
   * How often to poll.
   *
   * This is the *latency* of every event the service publishes, so it is
   * seconds rather than minutes — and it is a poll rather than a notification
   * because `LISTEN`/`NOTIFY` would hold a dedicated connection per replica to
   * save a query that costs an index scan on a partial index of the backlog.
   * Worth revisiting when the backlog is normally empty and the interval has to
   * come down; not worth it at five seconds.
   */
  readonly intervalMs: number;
  /** Called after every tick. Default: logs anything that was not a delivery. */
  readonly onOutcome?: (outcome: OutboxRelayOutcome) => void;
  /** Called when a tick throws. Default: logs. Never rethrows. */
  readonly onError?: (error: unknown) => void;
}

export interface OutboxRelayJob {
  /**
   * Stops polling and resolves once the tick in flight has finished.
   *
   * The await is what keeps a deploy from creating duplicates it did not have
   * to: a tick killed mid-batch has already dispatched messages whose deletes
   * are about to be rolled back, and every one of them is redelivered by the
   * next replica. Letting it commit costs a second and removes that.
   */
  stop(): Promise<void>;
}

function defaultOnOutcome(outcome: OutboxRelayOutcome): void {
  // A quiet tick and a tick that delivered cleanly are both the steady state;
  // logging either per replica every few seconds is how a channel becomes
  // unreadable. Anything that did not deliver is a fact about the service.
  if (outcome.rescheduled > 0 || outcome.deadLettered > 0) {
    console.warn(
      `[outbox relay] ${outcome.delivered} delivered, ${outcome.rescheduled} rescheduled, ` +
        `${outcome.deadLettered} dead-lettered`,
    );
  }
}

function defaultOnError(error: unknown): void {
  console.error('[outbox relay] tick failed:', error);
}

/**
 * Starts the in-process relay. Returns the handle that stops it.
 *
 * Every replica runs one, and unlike the idempotency purge there is no lock
 * deciding which of them does the work: `SKIP LOCKED` lets them all work at
 * once on disjoint rows, which is the property that makes the backlog drain
 * faster as replicas are added rather than exactly as fast.
 *
 * The three properties it shares with the purge job are each a way this would
 * otherwise misbehave: the timer is `unref`'d so the janitor does not decide
 * when the process exits; ticks never overlap in-process, because two ticks on
 * one replica would take *different* pooled connections and therefore not skip
 * each other's rows; and a failure never escapes, since an unhandled rejection
 * from a timer callback is attributable to no request and takes the process
 * down under Node's default.
 */
export function startOutboxRelay<TEvents extends EventPayloadMap>(
  options: OutboxRelayJobOptions<TEvents>,
): OutboxRelayJob {
  const {
    intervalMs,
    onOutcome = defaultOnOutcome,
    onError = defaultOnError,
    ...relayOptions
  } = options;

  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `startOutboxRelay: intervalMs must be a positive integer, received ${String(intervalMs)}`,
    );
  }

  let inFlight: Promise<void> | null = null;

  async function tick(): Promise<void> {
    try {
      onOutcome(await runOutboxRelay(relayOptions));
    } catch (err) {
      onError(err);
    }
  }

  function schedule(): void {
    if (inFlight !== null) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  }

  const timer = setInterval(schedule, intervalMs);
  timer.unref();

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await inFlight;
    },
  };
}
