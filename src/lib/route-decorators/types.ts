import type { Request } from 'express';

/**
 * Per-request state threaded through a decorator stack.
 *
 * `meta` is shared by reference on purpose: a decorator anywhere in the stack
 * records what it did (`cache: 'hit'`, `attempts: 2`) and the adapter at the
 * bottom emits the whole object as the response envelope's `meta`. Nothing
 * needs to thread a return channel back out through the wrappers.
 */
export interface OperationContext {
  /**
   * Cancellation for everything the operation starts. Aborted when the client
   * disconnects or when an enclosing `withTimeout` expires; the abort `reason`
   * carries the error that caused it, so a rejected `fetch` or `pg` query says
   * *why* it was cancelled rather than surfacing a bare `AbortError`.
   */
  readonly signal: AbortSignal;
  /** 1 on the first call. `withRetry` increments it for each re-attempt. */
  readonly attempt: number;
  /** Diagnostics for the response envelope's `meta`. */
  readonly meta: Record<string, unknown>;
}

/**
 * What the decorators wrap: a request in, a value out.
 *
 * Deliberately *not* an Express `RequestHandler`. Retrying or caching a
 * function whose only output is a side effect on `res` cannot work — once a
 * handler has called `res.json()` there is nothing left to retry and nothing a
 * cache can store but a recording of writes. Reducing the unit of work to
 * "request → value" is what makes the three decorators below sound rather than
 * approximately right; `toRequestHandler` puts the `res` back at the edge.
 */
export type RouteOperation<TResult, TReq extends Request = Request> = (
  req: TReq,
  ctx: OperationContext,
) => Promise<TResult>;

/** A decorator: same shape in, same shape out, so they nest in any order. */
export type RouteDecorator<TResult, TReq extends Request = Request> = (
  operation: RouteOperation<TResult, TReq>,
) => RouteOperation<TResult, TReq>;

/**
 * A child context that overrides part of the parent's. `meta` is carried by
 * reference rather than copied — see `OperationContext`.
 */
export function deriveContext(
  parent: OperationContext,
  overrides: Partial<Pick<OperationContext, 'signal' | 'attempt'>>,
): OperationContext {
  return {
    signal: overrides.signal ?? parent.signal,
    attempt: overrides.attempt ?? parent.attempt,
    meta: parent.meta,
  };
}
