import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import type { RouteOperation } from '@/lib/route-decorators/types';
import { deriveContext } from '@/lib/route-decorators/types';

/**
 * Extends `AppError`, so the existing translator chain turns it into a 504
 * without the error middleware learning anything new.
 *
 * 504 rather than 503: the deadline says a dependency this handler is waiting
 * on did not answer in time, not that this service is refusing traffic. A 503
 * invites a client to back off from the whole API when one upstream is slow.
 */
export class TimeoutError extends AppError {
  constructor(
    public readonly timeoutMs: number,
    label?: string,
  ) {
    super(504, `${label ?? 'Operation'} timed out after ${timeoutMs}ms`, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

export interface TimeoutOptions {
  /** Deadline in milliseconds. Must be finite and positive. */
  ms: number;
  /** Names the operation in the timeout message, e.g. `'User lookup'`. */
  label?: string;
}

/**
 * Fails the operation if it has not settled within `ms`.
 *
 * The timer does not merely abandon the work — it aborts the signal the
 * operation was handed, with the `TimeoutError` as the abort reason. An
 * operation that respects its signal (any `fetch`, any `pg` query given the
 * signal, any nested decorator) stops immediately instead of running on
 * unobserved and holding a connection past the deadline that was supposed to
 * release it.
 *
 * Composition is meaningful in both directions:
 *   `withRetry(withTimeout(op))` — a deadline per attempt.
 *   `withTimeout(withRetry(op))` — one deadline across all attempts.
 */
export function withTimeout<TResult, TReq extends Request = Request>(
  operation: RouteOperation<TResult, TReq>,
  options: TimeoutOptions,
): RouteOperation<TResult, TReq> {
  const { ms, label } = options;

  // Thrown at wiring time, not on the first request: a route configured with a
  // nonsense deadline should fail the process at import, not silently never
  // time out in production.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`withTimeout: ms must be a finite positive number, received ${ms}`);
  }

  return async (req, ctx) => {
    const controller = new AbortController();
    const propagateAbort = (): void => {
      controller.abort(ctx.signal.reason);
    };

    if (ctx.signal.aborted) {
      controller.abort(ctx.signal.reason);
    } else {
      ctx.signal.addEventListener('abort', propagateAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new TimeoutError(ms, label);
        controller.abort(err);
        reject(err);
      }, ms);
    });

    try {
      // `Promise.race` subscribes to both promises, so a rejection arriving
      // from the operation after the deadline already won is still handled and
      // never surfaces as an unhandled rejection.
      return await Promise.race([
        operation(req, deriveContext(ctx, { signal: controller.signal })),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', propagateAbort);
    }
  };
}
