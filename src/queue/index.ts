/**
 * The BullMQ job subsystem.
 *
 * Four pieces, in the order a unit of work moves through them: a typed producer
 * that writes an envelope onto a queue, a worker that resolves the job's name
 * to a handler and runs it, a retry ladder with full jitter and a ceiling
 * between the attempts, and a dead-letter queue for the jobs no amount of
 * retrying will fix. `docs/job-queue.md` is the map.
 *
 * ## Not the same thing as the Redis Streams consumer
 *
 * Both are Redis, both have a worker process, and both have somewhere for what
 * failed to end up — but they answer different questions and a service the size
 * of this one wants both.
 *
 * `@/redis` carries *events*: a stream is an append-only log, a consumer group
 * hands each entry to one member, the reader controls the pace, and a second
 * group can read the same history without taking anything away from the first.
 * What it does not have is per-entry scheduling. There is no "run this in five
 * minutes", no per-entry attempt ceiling, no priority — an entry that fails is
 * redelivered when the reclaim loop next notices it is idle.
 *
 * A job queue carries *work*: each job has its own delay, priority, attempt
 * budget and backoff, and the queue exists to run it once rather than to record
 * that it happened. `auth.magic-link.deliver` is a job because the second
 * attempt should be a few hundred milliseconds after the first and not when a
 * sweep gets round to it; `user.created` is an event because three subscribers
 * care and none of them own it.
 */

export type {
  EnqueueOptions,
  EnqueuedJobId,
  JobContext,
  JobEnvelope,
  JobHandler,
  JobHandlers,
  JobName,
  JobPayloadMap,
} from '@/queue/queue.types';

export {
  DeadLetterWriteError,
  describeFailure,
  MalformedJobDataError,
  MAX_LAST_ERROR_LENGTH,
  UnknownJobNameError,
  UnprocessableJobError,
} from '@/queue/queue.errors';

export type { RetryPolicy } from '@/queue/retry';
export { createFullJitterBackoffStrategy, retryJobOptions } from '@/queue/retry';

export type {
  JobProducer,
  JobProducerOptions,
  JobQueueWriter,
  JobRetention,
} from '@/queue/producer';
export { createJobProducer, DEFAULT_JOB_RETENTION, toJobQueueWriter } from '@/queue/producer';

export type {
  FailureListenerOptions,
  JobQueueWorker,
  JobQueueWorkerOptions,
} from '@/queue/worker';
export {
  createFailureListener,
  createJobProcessor,
  createJobQueueWorker,
} from '@/queue/worker';

export type {
  DeadLetterRecord,
  DeadLetterSink,
  DeadLetterSinkOptions,
  DeadLetterStore,
  StoredDeadLetter,
  TerminalJobFailure,
} from '@/queue/dead-letter';
export {
  createBullDeadLetterStore,
  createDeadLetterSink,
  DEAD_LETTER_JOB_NAME,
  DEAD_LETTER_SUFFIX,
  deadLetterJobId,
  deadLetterQueueName,
} from '@/queue/dead-letter';

export type { ReplayOptions, ReplayOutcome } from '@/queue/replay';
export { replayDeadLetters } from '@/queue/replay';

export type { BullQueueOptions } from '@/queue/bull';
export { createDeadLetterQueue, createJobQueue, jobQueueConnection } from '@/queue/bull';

export type { AppJobDependencies, AppJobPayloads } from '@/queue/jobs';
export {
  createAppJobHandlers,
  createMagicLinkDeliveryHandler,
  createQueuedMagicLinkDelivery,
  MAGIC_LINK_DELIVERY_JOB,
  REDACTED,
  redactAppJobPayload,
} from '@/queue/jobs';
