/**
 * The wire contract between the pool on the main thread and a worker thread.
 *
 * Both sides import this file, and that is the only thing they share: a worker
 * is a separate V8 isolate with its own module registry, so nothing crosses the
 * boundary except structured-cloneable values and the *types* described here.
 *
 * Kept free of `node:` imports on purpose. The worker-side runtime needs
 * `worker_threads`; the pool needs it too — this file needs neither, which is
 * what lets a test exercise the protocol without a thread in sight.
 */

/**
 * One task's payload and result type, named together.
 *
 * A task map is written as `{ digest: { payload: X; result: Y } }` rather than
 * being derived from the handler functions with `Parameters`/`ReturnType`. The
 * derived form reads better and does not work: a handler map wide enough to
 * hold every task has to be typed `Record<string, (payload: never) => unknown>`
 * for the functions to be assignable, and `Parameters<...>[0]` off that is
 * `never` — every call site then fails to typecheck against its own payload.
 * Declaring the signature and *checking* the handlers against it (see
 * `TaskHandlers`) keeps the inference pointing the way calls actually flow.
 */
export interface TaskSignature {
  readonly payload: unknown;
  readonly result: unknown;
}

/** A set of named task signatures — the thing a pool is generic over. */
export type TaskMap = { readonly [name: string]: TaskSignature };

/**
 * The worker-side implementations of a `TaskMap`.
 *
 * Handlers may be sync or async. Sync is the expected case — the whole reason
 * for a thread is that the work does not yield — but a task that awaits one I/O
 * call in the middle of its computation should not have to be split in two.
 */
export type TaskHandlers<TTasks extends TaskMap> = {
  readonly [K in keyof TTasks]: (
    payload: TTasks[K]['payload'],
  ) => TTasks[K]['result'] | Promise<TTasks[K]['result']>;
};

/** Requests travel main → worker. One per `pool.run()` call. */
export interface TaskRequest {
  readonly kind: 'task';
  /** Correlates the response. Unique per pool, not per worker. */
  readonly id: number;
  readonly task: string;
  readonly payload: unknown;
}

/** Responses travel worker → main. Exactly one per request. */
export type TaskResponse = TaskSuccessResponse | TaskFailureResponse;

export interface TaskSuccessResponse {
  readonly kind: 'result';
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
}

export interface TaskFailureResponse {
  readonly kind: 'result';
  readonly id: number;
  readonly ok: false;
  readonly error: SerializedError;
}

/**
 * What survives of an error when it crosses a thread boundary.
 *
 * The structured clone algorithm does carry `Error` objects, which is why this
 * looks redundant until you check what arrives. It preserves `name`, `message`,
 * `stack` and `cause` — and nothing else. Every own property is dropped, and
 * every subclass is flattened to its nearest built-in: an `AppError` thrown
 * inside a task arrives as a plain `Error` with its `statusCode` and `code`
 * gone, so the pool would answer 500 to something the task had already decided
 * was a 400.
 *
 * Serialising explicitly keeps the two fields that carry meaning across.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** Preserved from `AppError.code` and from Node's `err.code`. */
  readonly code?: string;
  /** Preserved from `AppError.statusCode`. */
  readonly statusCode?: number;
}

function readStringProperty(value: object, key: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function readNumberProperty(value: object, key: string): number | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

/**
 * Flattens anything a task can throw into a cloneable record.
 *
 * A thrown non-`Error` is not an edge case worth losing: `throw 'nope'` and a
 * rejected promise carrying an object both reach here, and turning them into
 * `String(value)` keeps the failure legible instead of reporting an empty
 * message from a property read that found nothing.
 */
export function serializeError(value: unknown): SerializedError {
  if (typeof value !== 'object' || value === null) {
    return { name: 'Error', message: String(value) };
  }

  const name = readStringProperty(value, 'name') ?? 'Error';
  const message = readStringProperty(value, 'message') ?? String(value);
  const stack = readStringProperty(value, 'stack');
  const code = readStringProperty(value, 'code');
  const statusCode = readNumberProperty(value, 'statusCode');

  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(code === undefined ? {} : { code }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

/**
 * Narrows an inbound message without trusting it.
 *
 * The pool validates what arrives from a worker for the same reason it
 * validates a request body: the sender is a separate program. A worker entry
 * that `postMessage`s something of its own — a progress ping, a stray log
 * object — must not be able to satisfy `response.id` by accident and settle an
 * unrelated caller's promise.
 */
export function isTaskResponse(value: unknown): value is TaskResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TaskResponse>;
  if (candidate.kind !== 'result' || typeof candidate.id !== 'number') return false;
  return candidate.ok === true || candidate.ok === false;
}
