import type { ConnectionOptions, Job, Processor } from 'bullmq';
import { Worker } from 'bullmq';
import type { DeadLetterSink, TerminalJobFailure } from '@/queue/dead-letter';
import {
  describeFailure,
  MalformedJobDataError,
  UnknownJobNameError,
} from '@/queue/queue.errors';
import type {
  JobContext,
  JobEnvelope,
  JobHandler,
  JobHandlers,
  JobName,
  JobPayloadMap,
} from '@/queue/queue.types';
import type { RetryPolicy } from '@/queue/retry';
import { createFullJitterBackoffStrategy } from '@/queue/retry';

/**
 * The consuming half: a BullMQ worker with the handler table in front of it and
 * the dead-letter sink behind it.
 *
 * Three things happen here that BullMQ does not do on its own.
 *
 * **The name is resolved to a typed handler.** BullMQ hands the processor every
 * job on the queue regardless of name; a single `switch` with a `default` that
 * silently succeeds is the usual result. `dispatch` looks the name up in an
 * exhaustive table and throws `UnknownJobNameError` when it is absent, which is
 * retryable on purpose — the case is a rolling deploy, not a typo.
 *
 * **The custom backoff strategy is registered.** It has to be here rather than
 * on the `Queue`: `Job#shouldRetryJob` reads `backoffStrategy` off the options
 * of the queue instance that is *processing* the job. A producer registering it
 * has registered it on the wrong object, and finds out when the first job
 * fails.
 *
 * **A terminal failure is copied to the dead-letter queue.** BullMQ emits
 * `failed` on every failed attempt, retry or not, so the interesting part is
 * telling the last one apart: `job.finishedOn` is set by `moveToFailed` only on
 * the branch that does not reschedule. That is a better signal than comparing
 * `attemptsMade` to `opts.attempts`, which is wrong for an
 * `UnprocessableJobError` — a job that skipped the ladder is terminal at
 * attempt 1 of 5.
 */

export interface JobQueueWorkerOptions<TJobs extends JobPayloadMap> {
  readonly connection: ConnectionOptions;
  readonly queueName: string;
  readonly handlers: JobHandlers<TJobs>;
  /**
   * Must match what the producer enqueues with. `attempts` is written into each
   * job by the producer and is not read from here; the delays are read from
   * here and are not stored on the job.
   */
  readonly retry: RetryPolicy;
  /** Where a job the ladder gave up on is recorded. `null` logs and forgets. */
  readonly deadLetter?: DeadLetterSink | null;
  /**
   * Jobs run at once in this process.
   *
   * A concurrency above 1 is not free the way a thread pool's is: the jobs
   * share one event loop, so it buys overlap on I/O and nothing at all on CPU.
   * It also multiplies how many jobs a `SIGKILL` leaves stalled.
   */
  readonly concurrency?: number;
  /**
   * How long a job's lock is held before another worker may treat it as
   * stalled.
   *
   * The same trade as `REDIS_STREAM_MIN_IDLE_MS`: below the slowest healthy
   * handler, a merely slow job is taken over and its work runs twice,
   * concurrently. BullMQ renews the lock every `lockDuration / 2` while the
   * handler runs, so this bounds recovery after a *crash* rather than the
   * handler itself.
   */
  readonly lockDurationMs?: number;
  /** Start consuming on construction. Off by default so `start()` is explicit. */
  readonly autorun?: boolean;
  /** Injected so a test can pin the backoff jitter. */
  readonly random?: () => number;
  /** Called for every failed attempt, retried or not. Default: logs. */
  readonly onFailedAttempt?: (job: Job<JobEnvelope> | undefined, error: Error) => void;
  /**
   * Called for a worker-level error — a lost Redis connection, a failure inside
   * BullMQ itself. Default: logs.
   *
   * Not optional in practice: `Worker` is an `EventEmitter`, and an `error` with
   * no listener is rethrown by Node and takes the process down.
   */
  readonly onError?: (error: Error) => void;
}

export interface JobQueueWorker {
  /** Begins consuming. Idempotent. */
  start(): Promise<void>;
  /**
   * Stops consuming and resolves once the jobs in flight have finished.
   *
   * The await is what keeps a deploy from creating duplicates it did not have
   * to: a handler killed mid-job leaves the job locked until it stalls, at
   * which point another worker runs it again — paying for a second of shutdown
   * in repeated side effects.
   */
  close(): Promise<void>;
  /** Escape hatch for tests and metrics. Prefer the methods above. */
  readonly bull: Worker<JobEnvelope, void, string>;
}

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_LOCK_DURATION_MS = 30_000;

function defaultOnFailedAttempt(job: Job<JobEnvelope> | undefined, error: Error): void {
  const id = job?.id ?? 'unknown';
  const name = job?.name ?? 'unknown';
  const attempt = (job?.attemptsMade ?? 0) + 1;
  console.warn(`[queue] job ${name} (${id}) failed on attempt ${attempt}: ${describeFailure(error)}`);
}

function defaultOnError(error: Error): void {
  console.error('[queue] worker error:', error);
}

/**
 * Pulls the payload back out of the stored envelope.
 *
 * Strict where the sink is tolerant, and the asymmetry is deliberate: the sink
 * is describing something that already failed, whereas this is about to run a
 * handler. A handler given `undefined` because the envelope was not the shape
 * this build writes will fail somewhere inside itself, with a message about a
 * missing property rather than about a malformed job.
 */
function decodeEnvelope(job: Job<JobEnvelope>): JobEnvelope {
  const { data } = job;

  if (typeof data !== 'object' || data === null || !('payload' in data)) {
    throw new MalformedJobDataError(job.name, `expected { payload, correlationId }, got ${typeof data}`);
  }

  const correlationId = (data as { correlationId?: unknown }).correlationId;
  return {
    payload: data.payload,
    correlationId: typeof correlationId === 'string' ? correlationId : null,
  };
}

/**
 * Turns a BullMQ job into the structural failure the sink takes.
 *
 * `finishedOn` is asserted by the caller before this runs; the `??` is a floor
 * rather than a fallback, so a record can never carry `new Date(undefined)`.
 */
function toTerminalFailure(
  queueName: string,
  job: Job<JobEnvelope>,
  error: Error,
  now: number,
): TerminalJobFailure {
  return {
    queueName,
    jobId: job.id ?? 'unknown',
    jobName: job.name,
    data: job.data,
    attemptsMade: job.attemptsMade,
    enqueuedAt: job.timestamp,
    failedAt: job.finishedOn ?? now,
    // The event's error rather than `job.failedReason`: the latter is the
    // message alone, and a `TypeError` and an `AppError` with the same message
    // are not the same incident.
    failedReason: describeFailure(error),
  };
}

/** A handler with its payload type erased, which is what a runtime lookup can produce. */
type ErasedJobHandler = (payload: unknown, context: JobContext) => Promise<void>;

/**
 * Flattens the typed handler table into one keyed by plain strings.
 *
 * This is the seam where the payload map's guarantee stops being checked and
 * starts being asserted, and it is worth having in one named function rather
 * than inline in the processor. A job's name arrives from Redis as a `string`,
 * so the compiler cannot know that the value it looks up is the handler for
 * *that* name — the correlation between key and value type is exactly what a
 * runtime lookup destroys.
 *
 * The assertion is narrow: each handler keeps its own signature inside the
 * closure, and only the argument crossing the boundary is widened. What makes
 * it sound in practice is that the same map types the producer, so a payload
 * reaching a name was written by an `enqueue` call the compiler did check —
 * and a payload that is not the right shape (an old deploy's, a hand-written
 * job) is a bug the handler will surface, not one this cast created.
 */
function eraseHandlerTable<TJobs extends JobPayloadMap>(
  handlers: JobHandlers<TJobs>,
): Record<string, ErasedJobHandler> {
  const table: Record<string, ErasedJobHandler> = {};

  for (const [name, handler] of Object.entries(handlers)) {
    const typed = handler as JobHandler<TJobs, JobName<TJobs>>;
    table[name] = (payload, context) => typed(payload as TJobs[JobName<TJobs>], context);
  }

  return table;
}

/**
 * The processor, without the Worker around it.
 *
 * Exported because everything interesting about running a job happens here —
 * the name lookup, the envelope decode, the attempt arithmetic — and
 * constructing a `Worker` to reach it would mean a Redis for every test of any
 * of it. `createJobQueueWorker` is then thin enough that what it does not cover
 * is only the wiring an integration test has to prove anyway.
 */
export function createJobProcessor<TJobs extends JobPayloadMap>(
  handlers: JobHandlers<TJobs>,
): Processor<JobEnvelope, void, string> {
  const known = Object.keys(handlers);
  if (known.length === 0) {
    throw new RangeError(
      'createJobProcessor: handlers is empty — a worker with no handlers fails ' +
        'every job it is given and dead-letters the queue',
    );
  }

  const table = eraseHandlerTable(handlers);

  return async function processJob(job): Promise<void> {
    // `hasOwn` and not a bare index: a job named `constructor` or `toString`
    // would otherwise resolve to something off `Object.prototype` and be called
    // as a handler.
    const handler = Object.hasOwn(table, job.name) ? table[job.name] : undefined;

    if (handler === undefined) {
      throw new UnknownJobNameError(job.name, known);
    }

    const { payload, correlationId } = decodeEnvelope(job);
    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;

    const context: JobContext = {
      name: job.name,
      id: job.id ?? 'unknown',
      attempt,
      maxAttempts,
      isFinalAttempt: attempt >= maxAttempts,
      correlationId,
    };

    await handler(payload, context);
  };
}

export interface FailureListenerOptions {
  readonly queueName: string;
  readonly deadLetter: DeadLetterSink | null;
  readonly onFailedAttempt?: (job: Job<JobEnvelope> | undefined, error: Error) => void;
  readonly now?: () => number;
}

/**
 * The `failed` listener, without the Worker around it.
 *
 * Exported for the same reason as the processor, and it is the half more worth
 * testing directly: BullMQ emits `failed` for *every* failed attempt, so the
 * only thing standing between a retryable failure and a dead-letter record is
 * the `finishedOn` check below. A test that drives it with three literals is a
 * better description of that rule than one that has to arrange three real
 * failures to reach it.
 */
export function createFailureListener(
  options: FailureListenerOptions,
): (job: Job<JobEnvelope> | undefined, error: Error) => void {
  const {
    queueName,
    deadLetter,
    onFailedAttempt = defaultOnFailedAttempt,
    now = Date.now,
  } = options;

  return function onFailed(job: Job<JobEnvelope> | undefined, error: Error): void {
    onFailedAttempt(job, error);

    // `finishedOn` is set by `moveToFailed` only on the branch that did not
    // reschedule, so this is exactly "the ladder is over" — and it is right
    // where comparing `attemptsMade` to `opts.attempts` is wrong, because an
    // `UnprocessableJobError` is terminal at attempt 1 of 5. An absent job
    // means BullMQ could not load it (a lock lost to a stall, say) and there is
    // nothing to record.
    if (job === undefined || job.finishedOn === undefined) return;
    if (deadLetter === null) return;

    // Not awaited, and it cannot be: this is an `EventEmitter` callback, so
    // there is no caller to await it and a returned promise would be dropped.
    // The sink is contracted never to throw for that reason — see
    // `createDeadLetterSink`.
    void deadLetter(toTerminalFailure(queueName, job, error, now()));
  };
}

export function createJobQueueWorker<TJobs extends JobPayloadMap>(
  options: JobQueueWorkerOptions<TJobs>,
): JobQueueWorker {
  const {
    connection,
    queueName,
    handlers,
    retry,
    deadLetter = null,
    concurrency = DEFAULT_CONCURRENCY,
    lockDurationMs = DEFAULT_LOCK_DURATION_MS,
    autorun = false,
    random = Math.random,
    onFailedAttempt = defaultOnFailedAttempt,
    onError = defaultOnError,
  } = options;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `createJobQueueWorker: concurrency must be an integer >= 1, received ${String(concurrency)}`,
    );
  }
  if (!Number.isInteger(lockDurationMs) || lockDurationMs < 1_000) {
    throw new RangeError(
      `createJobQueueWorker: lockDurationMs must be an integer >= 1000, received ${String(lockDurationMs)}`,
    );
  }

  // Before the `Worker` is constructed, so a misconfiguration is a throw at the
  // composition root rather than a connected worker that fails every job.
  const process = createJobProcessor(handlers);
  const backoffStrategy = createFullJitterBackoffStrategy(retry, random);

  const worker = new Worker<JobEnvelope, void, string>(queueName, process, {
    connection,
    concurrency,
    lockDuration: lockDurationMs,
    autorun,
    settings: { backoffStrategy },
  });

  worker.on('error', onError);
  worker.on('failed', createFailureListener({ queueName, deadLetter, onFailedAttempt }));

  /**
   * The main loop, held so `close()` can wait for it.
   *
   * `Worker#run()` does not resolve when the worker has started — it resolves
   * when the worker has *stopped*, because it awaits the main loop from inside.
   * Awaiting it in `start()` is therefore a hang, and the mistake is invisible
   * in a test that only ever starts a worker. It is kicked off and kept
   * instead, with `waitUntilReady()` supplying the "started" that `run()` does
   * not.
   */
  let mainLoop: Promise<void> | null = null;

  return {
    async start(): Promise<void> {
      // `run()` rejects outright if the worker is already running, which a
      // caller that passed `autorun: true` and then called `start()` would hit.
      // Idempotent is the more useful contract for a composition root.
      if (worker.isRunning()) {
        await worker.waitUntilReady();
        return;
      }

      // A rejection here is a worker-level failure with no caller to receive
      // it, and an unhandled rejection from a background loop takes the process
      // down under Node's default. It goes where every other worker-level
      // failure goes.
      mainLoop = worker.run().catch(onError);
      await worker.waitUntilReady();
    },

    async close(): Promise<void> {
      await worker.close();
      // `close()` resolves once the jobs in flight are done, but the loop
      // promise is the thing that owns the stalled-check timer and the lock
      // renewal; waiting for it is what makes "closed" mean the process can
      // exit rather than "the jobs finished".
      await mainLoop;
      mainLoop = null;
    },

    bull: worker,
  };
}
