import { UnrecoverableError } from 'bullmq';

/**
 * Failures the queue subsystem produces itself, as opposed to the ones a
 * handler throws at it.
 *
 * As in `@/outbox`, none of them extend `AppError`: nothing here is on a
 * request path, so there is no status code to carry and no translator that
 * should recognise them. They exist to be *readable*, because
 * `DeadLetterRecord.failedReason` is what somebody has to work from at 3am.
 */

// Both dead-letter records and `outbox_messages.last_error` are durable
// renderings of a failure read by a person later, and they have to agree about
// what one looks like. Re-exported so `@/queue`'s surface is self-contained.
export { describeFailure, MAX_LAST_ERROR_LENGTH } from '@/lib/describe-error';

/**
 * A job that failing again will not fix: stop the ladder, dead-letter now.
 *
 * The distinction is between a failure of the *attempt* and a failure of the
 * *job*. A timeout talking to S3 is the first — the next attempt runs against a
 * different second and may well succeed — and retrying it is the whole point of
 * the queue. A payload referring to a user that no longer exists is the second:
 * four more attempts spread over a minute produce four more identical failures,
 * four more log lines, and a dead-letter record a minute later than the one
 * available immediately.
 *
 * It extends BullMQ's `UnrecoverableError` rather than being recognised by name
 * in our own code, because the check that matters happens inside BullMQ's
 * failure path (`Job#shouldRetryJob`) where our code does not run. Subclassing
 * is what makes `instanceof` hold there.
 *
 * `cause` is kept because the thing that went wrong is usually the wrapped
 * error, and a dead-letter record naming only the wrapper is a record of the
 * decision rather than of the failure.
 */
export class UnprocessableJobError extends UnrecoverableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'UnprocessableJobError';
    if (options && 'cause' in options) {
      this.cause = options.cause;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * A job whose name no handler in this build knows.
 *
 * Retryable rather than unprocessable, and for the same reason
 * `UnknownOutboxEventError` is: the ordinary cause is a rolling deploy, where
 * the new version enqueues `report.export` and an old worker replica picks it
 * up. Retrying is right — the deploy finishes and the next attempt succeeds.
 * The job reaches the dead-letter queue only by exhausting the ladder, at which
 * point the deploy has been half-finished for minutes and somebody should hear
 * about it.
 *
 * The exhaustive `JobHandlers` table means this cannot be a *typo*: it is
 * always a version skew, or a queue two different services are both writing to.
 */
export class UnknownJobNameError extends Error {
  constructor(
    readonly jobName: string,
    readonly known: readonly string[],
  ) {
    super(
      `No handler for job "${jobName}" in this build — either a rolling deploy ` +
        `is in progress or the job was removed. Known: ${known.join(', ')}`,
    );
    this.name = 'UnknownJobNameError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * A job whose stored data is not the envelope this build writes.
 *
 * Unprocessable rather than retryable: the bytes in Redis do not change between
 * attempts, so the second read of a malformed payload fails exactly like the
 * first. The record is what a person needs, and they need it now.
 */
export class MalformedJobDataError extends UnprocessableJobError {
  constructor(
    readonly jobName: string,
    detail: string,
  ) {
    super(`Job "${jobName}" does not carry a decodable envelope: ${detail}`);
    this.name = 'MalformedJobDataError';
  }
}

/**
 * The dead-letter write failed.
 *
 * Never thrown at a handler — by the time it happens the job has already
 * failed — but reported to `onDeadLetterError` and, by default, logged. It
 * exists so that the failure is attributable: "adding to the dead-letter queue
 * failed" and "the job failed" are different incidents that would otherwise
 * arrive as the same log line.
 *
 * A lost dead-letter write is recoverable rather than fatal, which is why it
 * does not take the worker down: the job is still in the source queue's failed
 * set, because `createJobQueueWorker` refuses to run with `removeOnFail: true`
 * while a sink is configured.
 */
export class DeadLetterWriteError extends Error {
  constructor(
    readonly queueName: string,
    readonly jobId: string,
    options: { cause?: unknown } = {},
  ) {
    super(`Failed to dead-letter job ${jobId} from queue "${queueName}"`);
    this.name = 'DeadLetterWriteError';
    if ('cause' in options) {
      this.cause = options.cause;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}
