import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import type { RouteOperation } from '@/lib/route-decorators/types';
import { deriveContext } from '@/lib/route-decorators/types';

/**
 * HTTP methods whose semantics permit replaying the request. `POST` and
 * `PATCH` are absent because a retry after an ambiguous failure — the write
 * committed, the response was lost — creates a second resource or applies a
 * delta twice. Replaying those safely needs a deduplication key, which is a
 * different mechanism from this one.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
]);

/**
 * Default retry predicate.
 *
 * An `AppError` is a decision this service already made about the request, so
 * a 4xx is retried never — the second attempt gets the same 404 and the caller
 * waits longer for it. Anything that is not an `AppError` reached us as a raw
 * failure (socket reset, pool exhausted, DNS) and is assumed transient; the
 * translator chain will still decide what it means if every attempt fails.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof AppError) return err.statusCode >= 500;
  return true;
}

export interface RetryOptions {
  /** Total attempts including the first. `1` disables retrying. */
  attempts: number;
  /** First backoff step; doubles per attempt. Default 50ms. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff step. Default 1000ms. */
  maxDelayMs?: number;
  /** Which failures are worth another attempt. Default `isTransientError`. */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Replay `POST`/`PATCH` too. Off by default; turn it on only for an
   * operation you know is idempotent in fact, whatever its method says.
   */
  retryNonIdempotent?: boolean;
  /** Injected so tests do not spend real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected so the jitter is reproducible under test. */
  random?: () => number;
}

/** Rejects if the signal aborts first, so a dead client stops the backoff. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    // A declaration rather than a `const`, so the timer callback above can name
    // it before it is defined.
    function onAbort(): void {
      clearTimeout(timer);
      reject(toError(signal.reason));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `signal.reason` is `any` by specification; normalise before rejecting. */
function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Operation aborted');
}

/**
 * Full jitter (`random() * cap`), not equal jitter or a fixed step. Retrying a
 * shared dependency on a fixed schedule re-synchronises every client that
 * failed together, so the second attempt arrives as one spike and the recovery
 * fails the same way the outage did.
 */
function backoffDelay(attempt: number, base: number, max: number, random: () => number): number {
  const cap = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

/**
 * Re-runs the operation while it keeps failing transiently.
 *
 * Safe to place around an operation precisely because a `RouteOperation` has
 * not touched `res` — an attempt that failed left nothing on the wire to
 * contradict. Two guards keep it from making things worse: a non-idempotent
 * method is run exactly once unless explicitly opted in, and an aborted signal
 * (client gone, enclosing deadline blown) ends the loop instead of burning the
 * remaining attempts on work nobody will read.
 */
export function withRetry<TResult, TReq extends Request = Request>(
  operation: RouteOperation<TResult, TReq>,
  options: RetryOptions,
): RouteOperation<TResult, TReq> {
  const {
    attempts,
    baseDelayMs = 50,
    maxDelayMs = 1000,
    isRetryable = isTransientError,
    retryNonIdempotent = false,
    sleep = delay,
    random = Math.random,
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`withRetry: attempts must be an integer >= 1, received ${attempts}`);
  }

  return async (req, ctx) => {
    const replayable = retryNonIdempotent || IDEMPOTENT_METHODS.has(req.method.toUpperCase());
    const maxAttempts = replayable ? attempts : 1;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      ctx.signal.throwIfAborted();

      try {
        const result = await operation(req, deriveContext(ctx, { attempt }));
        // Only recorded when it is news. `attempts: 1` on every response is
        // noise in the envelope; `attempts: 3` is a signal worth an alert.
        if (attempt > 1) ctx.meta['attempts'] = attempt;
        return result;
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts || ctx.signal.aborted || !isRetryable(err)) break;
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random), ctx.signal);
      }
    }

    throw lastError;
  };
}
