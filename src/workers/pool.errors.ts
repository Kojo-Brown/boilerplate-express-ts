import { AppError } from '@/lib/errors';
import type { SerializedError } from '@/workers/protocol';

/**
 * The pool's failures, as `AppError`s.
 *
 * Extending `AppError` rather than inventing a parallel hierarchy is what keeps
 * `errorMiddleware` from having to learn about threads: each of these already
 * knows the status it means, so a route that awaits `pool.run()` and does
 * nothing else answers correctly.
 *
 * The statuses matter more than usual here, because they are the only thing a
 * client can act on and the three cases want three different reactions.
 */

/**
 * The queue is full: this service is CPU-saturated right now.
 *
 * 503 with `Retry-After`, not 429. A 429 says *you* have sent too much and
 * would be wrong to send even one more; this says the service as a whole is at
 * capacity and the same request is welcome shortly. A client that treats 429 as
 * "back off my own quota" would penalise a well-behaved caller for the load
 * somebody else generated.
 *
 * `Retry-After` carries a number of seconds rather than being omitted, because
 * a 503 without one is an invitation to retry immediately, and a retry storm
 * against a saturated CPU is the failure this rejection exists to prevent.
 */
export class WorkerQueueFullError extends AppError {
  constructor(
    public readonly queueDepth: number,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      503,
      `Worker pool queue is full (${queueDepth} task(s) waiting)`,
      'WORKER_QUEUE_FULL',
      { 'Retry-After': String(retryAfterSeconds) },
    );
    this.name = 'WorkerQueueFullError';
  }
}

/**
 * A task overran its deadline.
 *
 * 504 for the same reason `withTimeout` chose it: the work was accepted and did
 * not finish in time. It is not 503 — the service is not refusing traffic — and
 * it is not 500, because nothing has been shown to be broken.
 *
 * What makes this error unusual is the remedy it forces on the pool. A
 * synchronous CPU task cannot be cancelled: there is no yield point at which an
 * `AbortSignal` could be observed, and that is the definitional property of the
 * work this pool exists to run. The only way to reclaim the thread is to
 * destroy it, so a timeout costs a `terminate()` and a respawn — see
 * `WorkerPool`.
 */
export class WorkerTaskTimeoutError extends AppError {
  constructor(
    public readonly task: string,
    public readonly timeoutMs: number,
  ) {
    super(504, `Worker task "${task}" timed out after ${timeoutMs}ms`, 'WORKER_TASK_TIMEOUT');
    this.name = 'WorkerTaskTimeoutError';
  }
}

/**
 * The thread died while the task was on it, or before it could start.
 *
 * An uncaught throw at the top level of the entry point, an OOM, an explicit
 * `process.exit()` inside a task — all reach the pool as a dead worker rather
 * than as a failed task, because a healthy worker answers *every* request with
 * a message (see `serveTasks`). Whether the task ran is unknown, which is why
 * this is not retried automatically anywhere in the pool: it is not idempotent
 * to assume it did not.
 */
export class WorkerCrashedError extends AppError {
  constructor(
    public readonly task: string,
    // `override`, because `Error.cause` already exists in ES2022. Narrowing it
    // to a constructor parameter here is the point: whatever killed the thread
    // is the only evidence there is, and it must not be dropped on the way to
    // the log.
    public override readonly cause?: unknown,
  ) {
    super(500, `Worker thread died while running task "${task}"`, 'WORKER_CRASHED');
    this.name = 'WorkerCrashedError';
    this.cause = cause;
  }
}

/**
 * The pool is draining or closed and will not take new work.
 *
 * 503, because it is temporary from a client's point of view even when it is
 * permanent from the process's: the instance is going away and a load balancer
 * is about to stop sending here. No `Retry-After` — the answer is another
 * instance, not a later attempt at this one.
 */
export class WorkerPoolClosedError extends AppError {
  constructor(public readonly state: 'draining' | 'closed') {
    super(503, `Worker pool is ${state} and is not accepting tasks`, 'WORKER_POOL_CLOSED');
    this.name = 'WorkerPoolClosedError';
  }
}

/**
 * A task threw inside the worker, rehydrated on this side.
 *
 * The status is carried over when the remote error had one — an `AppError`
 * thrown by a task means what it meant in the thread, and flattening a
 * deliberate 400 into a 500 because it crossed an isolate boundary would make
 * the pool the reason a client cannot tell its own bad input from a server
 * fault. 500 is the default for everything else, which is what an unexpected
 * throw deserves.
 *
 * `remoteStack` is kept beside the local one rather than overwriting it. Both
 * are needed and they describe different things: the local stack says which
 * route awaited the task, the remote one says where inside the task it broke.
 */
export class WorkerTaskError extends AppError {
  public readonly remoteName: string;
  public readonly remoteStack: string | undefined;

  constructor(
    public readonly task: string,
    error: SerializedError,
  ) {
    super(
      error.statusCode ?? 500,
      error.message,
      error.code ?? 'WORKER_TASK_FAILED',
    );
    this.name = 'WorkerTaskError';
    this.remoteName = error.name;
    this.remoteStack = error.stack;
  }
}
