/**
 * The types the job queue is parameterised by.
 *
 * BullMQ's own generics are per-`Queue`: `Queue<TData, TResult, TName>` fixes
 * one payload type for every job name on that queue. That is the wrong shape
 * for a service whose queue carries several kinds of work — the only way to
 * satisfy it is `TData = unknown` and a cast in every handler, which puts the
 * one thing a type system is for on the far side of a boundary that crosses a
 * process and a JSON round-trip.
 *
 * So the map is declared once (see `AppJobPayloads`) and both ends are typed
 * against it: `enqueue` refuses a payload that does not match the name, and the
 * handler table is exhaustive over the same keys, so adding a job name is a
 * compile error until something handles it.
 */

/**
 * Job name → payload type.
 *
 * Must be a `type` alias rather than an `interface`, for the same reason
 * `EventPayloadMap` must: only the former gets an implicit index signature, and
 * an interface is open to declaration merging so TypeScript refuses to treat
 * its keys as final.
 */
export type JobPayloadMap = Record<string, unknown>;

/** The names on a map, as a closed union of string literals. */
export type JobName<TJobs extends JobPayloadMap> = keyof TJobs & string;

/**
 * What a handler is told about the attempt it is running in.
 *
 * `attempt` is 1-based — it is 1 on the first run — which is deliberately *not*
 * BullMQ's `attemptsMade`. That field counts attempts already finished, so it
 * reads 0 inside the first attempt, and "attempt 0 of 5" in a log line is the
 * kind of off-by-one that survives for years because it is never quite wrong
 * enough to fix.
 */
export interface JobContext {
  /**
   * The job's name. `string` rather than the map's key union: a handler already
   * knows which name it is registered under, and carrying the literal type here
   * would make the handler table's value type depend on its key — which is what
   * turns the worker's one runtime lookup into an unsatisfiable variance
   * problem rather than a single documented assertion.
   */
  readonly name: string;
  readonly id: string;
  /** 1-based. `1` on the first run. */
  readonly attempt: number;
  /** The job's own ceiling, which may differ from the queue's default. */
  readonly maxAttempts: number;
  /**
   * Whether a throw from here ends the job rather than scheduling a retry.
   *
   * For a handler that wants to do something different when it is out of road —
   * write a compensating record, notify a human — rather than discovering it
   * from the dead-letter queue afterwards.
   */
  readonly isFinalAttempt: boolean;
  /** The job's correlation id, when it was enqueued inside a request. */
  readonly correlationId: string | null;
}

/**
 * One job's worth of work.
 *
 * Returning normally completes the job; throwing fails the attempt and hands it
 * to the retry ladder. Throw `UnprocessableJobError` to skip the ladder
 * entirely — see `queue.errors.ts`.
 *
 * The contract a handler owes the queue is idempotence. Delivery is
 * at-least-once for the same reason it is everywhere else in this service: a
 * process that dies between finishing the work and reporting it leaves a job
 * that another worker picks up after the stall interval, and the work runs
 * twice. There is no setting that changes that.
 */
export type JobHandler<
  TJobs extends JobPayloadMap,
  TName extends JobName<TJobs>,
> = (payload: TJobs[TName], context: JobContext) => Promise<void>;

/**
 * The full handler table, exhaustive over the map.
 *
 * A mapped type rather than `Partial<…>` on purpose: a job whose name reaches a
 * worker with no handler fails every attempt and dead-letters, which is a
 * runtime discovery of something the compiler could have said. The cost is that
 * a worker deployment wanting to process a *subset* of the names has to say so
 * explicitly — `Pick<AppJobHandlers, 'a' | 'b'>` and its own queue — which is
 * the right amount of friction for a decision that splits a queue in two.
 */
export type JobHandlers<TJobs extends JobPayloadMap> = {
  readonly [TName in JobName<TJobs>]: JobHandler<TJobs, TName>;
};

/**
 * The per-call options `enqueue` accepts.
 *
 * A deliberately narrow subset of BullMQ's `JobsOptions`. Two of the omissions
 * are load-bearing rather than tidiness:
 *
 * - `removeOnFail` is not exposed, because the dead-letter transfer happens
 *   *after* the job lands in the failed set and reads it from there. A caller
 *   that set `removeOnFail: true` would delete the job in the same breath as
 *   failing it and take the record with it. The queue-wide setting is
 *   `JobRetention.failed`, which `createJobProducer` refuses to set below 1;
 *   this is the half that stops it being overridden per job.
 * - `backoff` is not exposed, because the strategy is registered on the *worker*
 *   and a job asking for a strategy name the worker did not register throws
 *   from inside BullMQ's failure path — where the throw is not the handler's
 *   failure and is much harder to read. `retryJobOptions` sets it from the
 *   shared policy instead.
 */
export interface EnqueueOptions {
  /**
   * The job's identity, when the caller has one that makes the enqueue
   * idempotent. BullMQ silently does not add a second job with an id already
   * present, which turns "enqueue on every retry of the HTTP request" into one
   * job rather than five.
   */
  readonly jobId?: string;
  /** Milliseconds to hold the job before it becomes runnable. */
  readonly delayMs?: number;
  /**
   * 1 (highest) to 2 097 151. Omitted means unprioritised, which BullMQ runs
   * *before* prioritised jobs — so adding a priority to one job name changes
   * the ordering of every other one.
   */
  readonly priority?: number;
  /**
   * Overrides the queue's default attempt ceiling for this job.
   *
   * For work whose cost or urgency genuinely differs from the queue's norm. The
   * backoff ladder is unchanged: it is the worker's, and the delays it produces
   * do not depend on how many attempts remain.
   */
  readonly attempts?: number;
  /**
   * The originating request's `x-correlation-id`, so the log lines a handler
   * writes minutes later can be joined to the request that queued the work.
   * Carried beside the payload rather than inside it, so every job name gets it
   * without every payload type declaring it.
   */
  readonly correlationId?: string;
}

/** What `enqueue` returns: the job's id, for logging or a later lookup. */
export type EnqueuedJobId = string;

/**
 * The envelope actually stored in Redis.
 *
 * The payload is nested under `payload` rather than being the job data itself,
 * so queue-level metadata (today the correlation id) can be added without
 * colliding with a payload field and without every payload type having to
 * declare it. `decodeJobData` is the only thing that should read this shape.
 */
export interface JobEnvelope<TPayload = unknown> {
  readonly payload: TPayload;
  readonly correlationId: string | null;
}
