import type { DeadLetterStore, StoredDeadLetter } from '@/queue/dead-letter';
import type { JobProducer } from '@/queue/producer';
import type { JobName, JobPayloadMap } from '@/queue/queue.types';

/**
 * Putting a dead letter back on the queue it came from.
 *
 * This is the half of a dead-letter queue people forget to build, and without
 * it the queue is a graveyard rather than an inbox: the point of keeping the
 * payload is that once the bug is fixed or the dependency is back, the work can
 * be run rather than reconstructed by hand from a log.
 *
 * ## Order, and which duplicate is the safe one
 *
 * Re-enqueue first, then delete the record. A crash between them leaves a dead
 * letter that has already been replayed, so the next replay runs the job twice.
 * The other order loses the work entirely. Every handler on this queue is
 * required to be idempotent — delivery is at-least-once regardless — so a
 * duplicate is absorbed, while a loss is not recoverable from anywhere.
 *
 * ## What replay cannot do
 *
 * A record whose payload was redacted on the way in (see
 * `DeadLetterSinkOptions.redact`) replays the redacted payload, because that is
 * what was kept. Those jobs have to be re-issued at their source. Redaction is
 * therefore a decision about whether a job name is replayable at all, and it is
 * made per job name for exactly that reason.
 *
 * Replay is deliberately manual — a script or an admin route, never a timer.
 * Everything here failed the retry ladder already; a loop that put it back
 * automatically would be a slower version of the ladder with no ceiling.
 */

export interface ReplayOptions<TJobs extends JobPayloadMap> {
  readonly store: DeadLetterStore;
  /** The producer for the *source* queue. Its retry policy applies afresh. */
  readonly producer: JobProducer<TJobs>;
  /** Entries to work through in one call. */
  readonly limit?: number;
  /**
   * Names that may be replayed.
   *
   * Omitted, every name is. Supplied, anything else is left in place and
   * counted as skipped — which is how "replay the S3 uploads that failed during
   * the outage, leave the rest" is expressed without hand-picking ids.
   */
  readonly only?: readonly string[];
  /** Reported per entry that could not be replayed. Default: logs. */
  readonly onError?: (error: unknown, entry: StoredDeadLetter) => void;
}

export interface ReplayOutcome {
  /** Entries read from the store. */
  readonly examined: number;
  readonly replayed: number;
  /** Filtered out by `only`. */
  readonly skipped: number;
  /** Re-enqueue threw; the entry is still in the store. */
  readonly failed: number;
}

const DEFAULT_LIMIT = 100;

function defaultOnError(error: unknown, entry: StoredDeadLetter): void {
  console.error(
    `[dead-letter] replay of ${entry.record.jobName} (${entry.record.sourceJobId}) failed:`,
    error,
  );
}

export async function replayDeadLetters<TJobs extends JobPayloadMap>(
  options: ReplayOptions<TJobs>,
): Promise<ReplayOutcome> {
  const { store, producer, limit = DEFAULT_LIMIT, only, onError = defaultOnError } = options;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`replayDeadLetters: limit must be an integer >= 1, received ${String(limit)}`);
  }

  const entries = await store.list(limit);

  let replayed = 0;
  let skipped = 0;
  let failed = 0;

  // Sequentially rather than in parallel. A replay is a burst of work aimed at
  // a dependency that was recently unhealthy — it is the exact shape of load
  // the retry ladder's jitter exists to avoid producing — and the queue's own
  // concurrency is what should decide how fast it is worked through.
  for (const entry of entries) {
    const { record } = entry;

    if (only !== undefined && !only.includes(record.jobName)) {
      skipped += 1;
      continue;
    }

    try {
      // The record came off this queue, so its name is one of the map's and its
      // payload is that name's type. The compiler cannot see it — the name is a
      // string that has been through Redis — and this is the same assertion the
      // worker's dispatch makes, in the same one place per direction.
      await producer.enqueue(
        record.jobName as JobName<TJobs>,
        record.payload as TJobs[JobName<TJobs>],
        {
          ...(record.correlationId === null ? {} : { correlationId: record.correlationId }),
        },
      );

      // Only after the enqueue has resolved. See the ordering note above.
      await store.remove(entry.entryId);
      replayed += 1;
    } catch (error) {
      onError(error, entry);
      failed += 1;
    }
  }

  return { examined: entries.length, replayed, skipped, failed };
}
