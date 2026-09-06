import type { JobsOptions, Queue } from 'bullmq';
import type { RetryPolicy } from '@/queue/retry';
import { retryJobOptions } from '@/queue/retry';
import type {
  EnqueueOptions,
  EnqueuedJobId,
  JobEnvelope,
  JobName,
  JobPayloadMap,
} from '@/queue/queue.types';

/**
 * The producing half: typed `enqueue`, and the job options every job on this
 * queue is written with.
 *
 * It is a separate object from the worker because it runs in a different
 * process. An API replica holds one of these and never processes anything; the
 * worker process holds a `JobQueueWorker` and never enqueues. They share only
 * the queue name, the payload map, and the `RetryPolicy` — which is exactly the
 * set of things that has to be kept in agreement across a deploy.
 */

/**
 * The writing surface of a queue.
 *
 * A port rather than BullMQ's `Queue`, so that everything this file decides —
 * envelope shape, retention, how an override interacts with the policy — is
 * testable against a literal instead of a Redis. `toJobQueueWriter` is the
 * adapter; nothing else in the module knows BullMQ's `add` signature.
 */
export interface JobQueueWriter {
  readonly name: string;
  add(jobName: string, data: JobEnvelope, options: JobsOptions): Promise<EnqueuedJobId>;
  close(): Promise<void>;
}

/**
 * How much of the queue's own history is kept, in job counts.
 *
 * Counts rather than ages, because what a bound on a Redis-backed queue has to
 * protect is memory, and memory is a function of how many jobs are kept rather
 * than of how old they are. BullMQ evaluates the eviction when a job finishes,
 * so neither is a background sweep.
 */
export interface JobRetention {
  /** Completed jobs kept. Debugging history; nothing reads it programmatically. */
  readonly completed: number;
  /**
   * Failed jobs kept. Must be at least 1.
   *
   * This is the dead-letter queue's backstop. The transfer happens after BullMQ
   * has moved the job to `failed` and reads it from there, so a queue that
   * deletes on failure — `removeOnFail: true`, or a count of 0 — turns a
   * crashed worker's missed write into silent loss rather than something
   * recoverable from the failed set.
   */
  readonly failed: number;
}

export const DEFAULT_JOB_RETENTION: JobRetention = { completed: 1_000, failed: 5_000 };

export interface JobProducerOptions {
  readonly queue: JobQueueWriter;
  readonly retry: RetryPolicy;
  readonly retention?: JobRetention;
}

export interface JobProducer<TJobs extends JobPayloadMap> {
  readonly queueName: string;
  /**
   * Queues one job. Resolves with its id once Redis has it.
   *
   * Awaiting it is the caller's decision and usually the right one: a handler
   * that returns 202 without awaiting has told the client the work is queued
   * when it may not be. The exception is a caller already inside a database
   * transaction — enqueuing there is the dual-write this service has an outbox
   * to avoid, and the job should be queued by a subscriber after the commit.
   */
  enqueue<TName extends JobName<TJobs>>(
    name: TName,
    payload: TJobs[TName],
    options?: EnqueueOptions,
  ): Promise<EnqueuedJobId>;
  close(): Promise<void>;
}

/**
 * Wraps a BullMQ `Queue` as the narrow port this module writes through.
 *
 * Explicit rather than relying on structural assignability: `Queue`'s generics
 * make it *almost* satisfy `JobQueueWriter` and the difference (its `add`
 * resolving to a `Job` rather than an id) is the kind of thing that would be
 * bridged with a cast the first time it did not line up.
 */
export function toJobQueueWriter(queue: Queue<JobEnvelope, void, string>): JobQueueWriter {
  return {
    name: queue.name,
    async add(jobName: string, data: JobEnvelope, options: JobsOptions): Promise<EnqueuedJobId> {
      const job = await queue.add(jobName, data, options);
      // BullMQ leaves `id` optional on its `Job` type because a job that is
      // part of an unresolved flow has none. Nothing here adds flows, so an
      // absent id means something changed and is worth saying out loud rather
      // than returning an empty string somebody later logs.
      if (job.id === undefined) {
        throw new Error(`Queue "${queue.name}" returned a job with no id for "${jobName}"`);
      }
      return job.id;
    },
    close: () => queue.close(),
  };
}

export function createJobProducer<TJobs extends JobPayloadMap>(
  options: JobProducerOptions,
): JobProducer<TJobs> {
  const { queue, retry, retention = DEFAULT_JOB_RETENTION } = options;

  if (!Number.isInteger(retention.completed) || retention.completed < 0) {
    throw new RangeError(
      `createJobProducer: retention.completed must be an integer >= 0, received ${String(retention.completed)}`,
    );
  }
  if (!Number.isInteger(retention.failed) || retention.failed < 1) {
    throw new RangeError(
      `createJobProducer: retention.failed must be an integer >= 1 — the dead-letter ` +
        `transfer reads the job out of the failed set, so a queue that deletes on ` +
        `failure loses the record when a worker dies mid-transfer. Received ` +
        `${String(retention.failed)}`,
    );
  }

  return {
    queueName: queue.name,

    async enqueue<TName extends JobName<TJobs>>(
      name: TName,
      payload: TJobs[TName],
      enqueueOptions: EnqueueOptions = {},
    ): Promise<EnqueuedJobId> {
      const { jobId, delayMs, priority, attempts, correlationId } = enqueueOptions;

      const envelope: JobEnvelope<TJobs[TName]> = {
        payload,
        correlationId: correlationId ?? null,
      };

      const jobOptions: JobsOptions = {
        ...retryJobOptions(retry, { attempts }),
        removeOnComplete: { count: retention.completed },
        removeOnFail: { count: retention.failed },
        ...(jobId === undefined ? {} : { jobId }),
        ...(delayMs === undefined ? {} : { delay: delayMs }),
        ...(priority === undefined ? {} : { priority }),
      };

      return queue.add(name, envelope, jobOptions);
    },

    close: () => queue.close(),
  };
}
