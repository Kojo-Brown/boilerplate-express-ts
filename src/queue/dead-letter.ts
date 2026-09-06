import type { Queue } from 'bullmq';
import { DeadLetterWriteError } from '@/queue/queue.errors';

/**
 * The dead-letter queue: where a job goes when the ladder runs out.
 *
 * ## Why a second queue, when BullMQ already has a failed set
 *
 * A failed job stays in its queue's `failed` set, so "we already have a
 * dead-letter queue" is a reasonable first reaction. Three things are wrong
 * with it, and they are the three reasons this module exists.
 *
 * The failed set holds *every* failed attempt's end state, including jobs that
 * went on to succeed on the next try — a queue with a flaky dependency fills it
 * with jobs that are fine. Its retention is a cleanup policy (`removeOnFail`
 * counts and ages) tuned for keeping the queue's memory bounded, not for
 * keeping a record somebody will act on: the entries worth reading are evicted
 * on the same schedule as the noise. And it is not replayable as a queue —
 * `job.retry()` puts the job back on the *source* queue, which is right, but
 * there is nowhere to see "everything we have given up on" as a worklist.
 *
 * So: terminal failures are copied to `<queue>-dead-letter`, which nothing
 * consumes. Its jobs sit in `wait` forever, which is the point — `wait` is the
 * inbox. `replayDeadLetter` takes one out and puts the original payload back on
 * the source queue.
 *
 * ## What the transfer guarantees, and what it does not
 *
 * The copy happens after BullMQ has moved the job to `failed`, so a worker that
 * dies in between leaves the record unwritten. That is why `createJobProducer`
 * refuses a `retention.failed` below 1: the failed set is the durable backstop,
 * and this queue is an index over it that is convenient rather than
 * authoritative. A lost write is reported through the sink's `onError` and
 * recoverable by hand from the failed set; it is not silent data loss.
 *
 * In the other direction the transfer is idempotent: the record's job id is
 * derived from the source queue and job id, and BullMQ does not add a second
 * job under an id already present. A job re-processed after a stall and failed
 * again produces one record, not two.
 */

/** The suffix that turns a queue name into its dead-letter queue's name. */
export const DEAD_LETTER_SUFFIX = '-dead-letter';

/** `<name>-dead-letter` — the companion queue a queue's terminal failures land on. */
export function deadLetterQueueName(queueName: string): string {
  return `${queueName}${DEAD_LETTER_SUFFIX}`;
}

/** Every record carries this name, so the queue reads as one kind of thing. */
export const DEAD_LETTER_JOB_NAME = 'dead-letter';

/**
 * What the worker knows about a job it has given up on.
 *
 * A structural type rather than BullMQ's `Job`, so the sink can be tested
 * against a literal and the adapter that builds one from a real job is the only
 * thing that has to know BullMQ's field names.
 */
export interface TerminalJobFailure {
  readonly queueName: string;
  readonly jobId: string;
  readonly jobName: string;
  /** The stored envelope, exactly as it came out of Redis. */
  readonly data: unknown;
  /** Attempts actually run, counting the first. */
  readonly attemptsMade: number;
  /** Epoch ms the job was added. */
  readonly enqueuedAt: number;
  /** Epoch ms the job moved to `failed`. */
  readonly failedAt: number;
  /** One-line rendering of the last error; see `describeFailure`. */
  readonly failedReason: string;
}

/**
 * A dead-letter queue entry.
 *
 * Timestamps are ISO strings rather than epoch numbers: this is read by a
 * person in a queue UI or a `getJobs` dump, and `1757155200000` is not a time.
 * The two that matter are kept separately because their *difference* is the
 * question people actually ask — a job that failed four seconds after it was
 * queued failed differently from one that spent six minutes climbing the
 * ladder.
 */
export interface DeadLetterRecord {
  readonly sourceQueue: string;
  readonly sourceJobId: string;
  readonly jobName: string;
  readonly attemptsMade: number;
  readonly failedReason: string;
  readonly correlationId: string | null;
  /** The payload, after `redact`. Replayed verbatim, so redaction is lossy on purpose. */
  readonly payload: unknown;
  readonly enqueuedAt: string;
  readonly failedAt: string;
  readonly deadLetteredAt: string;
}

/**
 * The storage the sink writes through.
 *
 * A port, so the sink's own logic — id derivation, redaction, the trim — is
 * unit-testable without a Redis, and so a deployment that wants its dead
 * letters in Postgres or on a paging channel can supply one without touching
 * the worker.
 */
export interface DeadLetterStore {
  /** Adds a record under `jobId`. An id already present must be a no-op. */
  add(record: DeadLetterRecord, jobId: string): Promise<void>;
  /** Drops the oldest entries until at most `maxSize` remain. Returns how many went. */
  evictOldest(maxSize: number): Promise<number>;
  /** The oldest `limit` entries, oldest first — the order a person works through them in. */
  list(limit: number): Promise<readonly StoredDeadLetter[]>;
  /** Drops one entry. Absent is not an error: a concurrent replay may have taken it. */
  remove(entryId: string): Promise<void>;
}

/** A record as it sits in the store, with the id needed to remove it again. */
export interface StoredDeadLetter {
  readonly entryId: string;
  readonly record: DeadLetterRecord;
}

/** Called with a job the worker has given up on. Never throws at the caller. */
export type DeadLetterSink = (failure: TerminalJobFailure) => Promise<void>;

export interface DeadLetterSinkOptions {
  readonly store: DeadLetterStore;
  /**
   * Entries kept before the oldest are dropped.
   *
   * Much smaller than a source queue's retention, for the reason the stream
   * parking lot gives: entries arrive here at the rate things go wrong rather
   * than at the rate things happen, and an entry that ages out unexamined was
   * never going to be examined. It is still a bound — a producer emitting
   * malformed payloads in a loop would otherwise fill the instance with the
   * evidence of it.
   */
  readonly maxSize?: number;
  /**
   * Rewrites a payload before it is stored.
   *
   * A dead-letter record is the longest-lived copy of a payload in the system:
   * the source job is evicted by `removeOnFail` within hours, and this sits in
   * `wait` until somebody looks. Any payload carrying a credential — the magic
   * link job's plaintext token is the one in this repository — must not be kept
   * that way, and redacting on the way in is the only place that holds for
   * records written by a process that has already crashed once.
   *
   * The cost is stated rather than hidden: a redacted record cannot be replayed
   * as-is. `replayDeadLetter` puts back exactly what is stored, so a job whose
   * payload was redacted has to be re-issued at its source instead.
   */
  readonly redact?: (jobName: string, payload: unknown) => unknown;
  /** Injected so a test can pin the timestamp. */
  readonly now?: () => Date;
  /** Reported when the write itself fails. Default: logs. Never rethrows. */
  readonly onError?: (error: DeadLetterWriteError) => void;
}

const DEFAULT_MAX_SIZE = 10_000;

function defaultOnError(error: DeadLetterWriteError): void {
  console.error(`[dead-letter] ${error.message}:`, error.cause ?? error);
}

/**
 * The id a record is stored under: stable for a source job, so a repeated
 * transfer collapses into one entry.
 *
 * Prefixed rather than bare, because BullMQ reserves ids starting with `0:` for
 * its own list markers and rejects them — a source queue named `0` would
 * otherwise produce an id it refuses.
 */
export function deadLetterJobId(queueName: string, jobId: string): string {
  return `dlq:${queueName}:${jobId}`;
}

/**
 * Builds the sink the worker hands terminal failures to.
 *
 * It never throws. A dead-letter write that fails must not fail the worker: the
 * job it describes has already failed, the record is an index over a failed set
 * that still holds it, and an exception escaping here would surface as an
 * unhandled rejection inside BullMQ's `failed` emit rather than as anything an
 * operator could act on.
 */
export function createDeadLetterSink(options: DeadLetterSinkOptions): DeadLetterSink {
  const {
    store,
    maxSize = DEFAULT_MAX_SIZE,
    redact,
    now = (): Date => new Date(),
    onError = defaultOnError,
  } = options;

  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new RangeError(
      `createDeadLetterSink: maxSize must be an integer >= 1, received ${String(maxSize)}`,
    );
  }

  return async function deadLetter(failure: TerminalJobFailure): Promise<void> {
    const envelope = failure.data;
    const { payload, correlationId } = unwrapEnvelope(envelope);

    const record: DeadLetterRecord = {
      sourceQueue: failure.queueName,
      sourceJobId: failure.jobId,
      jobName: failure.jobName,
      attemptsMade: failure.attemptsMade,
      failedReason: failure.failedReason,
      correlationId,
      payload: redact ? redact(failure.jobName, payload) : payload,
      enqueuedAt: new Date(failure.enqueuedAt).toISOString(),
      failedAt: new Date(failure.failedAt).toISOString(),
      deadLetteredAt: now().toISOString(),
    };

    try {
      await store.add(record, deadLetterJobId(failure.queueName, failure.jobId));
      // After the add rather than before, so a burst that arrives together is
      // trimmed to the bound rather than trimmed to one below it and then
      // pushed back over. The trim is cheap to skip and expensive to get
      // wrong, so its own failure is reported and swallowed with the write's.
      await store.evictOldest(maxSize);
    } catch (error) {
      onError(new DeadLetterWriteError(failure.queueName, failure.jobId, { cause: error }));
    }
  };
}

/**
 * Reads the payload back out of whatever the job carried.
 *
 * Tolerant on purpose. This runs on data that has already caused one failure,
 * and a record that says "we could not even parse the payload, here it is" is
 * worth strictly more than a sink that throws while trying to describe it.
 */
function unwrapEnvelope(data: unknown): { payload: unknown; correlationId: string | null } {
  if (typeof data === 'object' && data !== null && 'payload' in data) {
    const envelope = data as { payload: unknown; correlationId?: unknown };
    return {
      payload: envelope.payload,
      correlationId: typeof envelope.correlationId === 'string' ? envelope.correlationId : null,
    };
  }

  return { payload: data, correlationId: null };
}

/**
 * The BullMQ-backed store: a queue nothing consumes.
 *
 * `attempts: 1` and no backoff, because a dead-letter entry is a record rather
 * than work — nothing processes it, so there is nothing to retry. `priority` is
 * left unset for the same reason.
 */
export function createBullDeadLetterStore(
  queue: Queue<DeadLetterRecord, void, string>,
): DeadLetterStore {
  return {
    async add(record: DeadLetterRecord, jobId: string): Promise<void> {
      await queue.add(DEAD_LETTER_JOB_NAME, record, {
        jobId,
        attempts: 1,
        // Never removed on completion: nothing completes it. Stated rather
        // than left to the default so that a future `defaultJobOptions` on
        // this queue cannot quietly start evicting the records.
        removeOnComplete: false,
        removeOnFail: false,
      });
    },

    async evictOldest(maxSize: number): Promise<number> {
      const waiting = await queue.getJobCountByTypes('wait');
      const excess = waiting - maxSize;
      if (excess <= 0) return 0;

      // `asc` reads the wait list from its tail, which is the end a worker
      // would take from — i.e. oldest first. Asserted against a real server in
      // `queue.integration.test.ts` rather than assumed: the ordering is a
      // property of BullMQ's list discipline, not of its documented API.
      const oldest = await queue.getJobs(['wait'], 0, excess - 1, true);
      await Promise.all(oldest.map((job) => job.remove()));
      return oldest.length;
    },

    async list(limit: number): Promise<readonly StoredDeadLetter[]> {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`DeadLetterStore.list: limit must be an integer >= 1, received ${String(limit)}`);
      }

      const jobs = await queue.getJobs(['wait'], 0, limit - 1, true);
      // An entry with no id cannot be removed after a replay, so it is left
      // where it is rather than replayed and orphaned.
      return jobs.flatMap((job) =>
        job.id === undefined ? [] : [{ entryId: job.id, record: job.data }],
      );
    },

    async remove(entryId: string): Promise<void> {
      await queue.remove(entryId);
    },
  };
}
