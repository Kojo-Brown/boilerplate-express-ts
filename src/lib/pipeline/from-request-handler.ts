import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/lib/errors';
import type { PipelineStep } from '@/lib/pipeline/types';

/**
 * Raised when adapted middleware calls `next('route')` or `next('router')`.
 *
 * Those are not errors — they are Express's instruction to abandon the rest of
 * *this route's* handler stack and try the next matching route. A composed
 * pipeline is a single handler as far as Express is concerned, so there is no
 * remaining stack to abandon and no honest way to emulate one: silently
 * treating it as `next()` would run the operation the middleware just asked to
 * skip, and treating it as an error would report a 500 for a routing decision.
 *
 * The middleware that wants this behaviour belongs on the router, ahead of the
 * pipeline, where Express can still act on it.
 */
export class NextRouteUnsupportedError extends AppError {
  constructor(signal: string) {
    super(
      500,
      `Adapted middleware called next('${signal}'), which a composed pipeline cannot honour — ` +
        'mount that middleware on the router instead',
      'PIPELINE_NEXT_ROUTE_UNSUPPORTED',
    );
    this.name = 'NextRouteUnsupportedError';
  }
}

/**
 * Lift an ordinary `(req, res, next)` middleware into a pipeline step.
 *
 * This exists because most middleware is not ours and never will be:
 * `express-rate-limit`, `multer`, `passport`, `helmet`, `cors`. A composition
 * story that only works for handwritten steps is not one, so the adapter is
 * part of the design rather than an escape hatch — the price is that adapted
 * middleware proves nothing about the request, which is why the step returns
 * the same type it was given. Anything it attached to `req` is reachable only
 * through the global augmentation, exactly as before.
 *
 * Three things it fixes on the way through:
 *
 * - **Double `next()`.** Express runs the remainder of the chain once per call;
 *   a middleware with a callback that both errors and succeeds therefore runs
 *   the handler twice and answers twice. Here the first settle wins.
 * - **Respond-without-`next()`.** A rate limiter that sends 429 never calls
 *   `next`, so the promise would hang forever waiting for a signal that is not
 *   coming. Resolving on `finish` ends the pipeline instead.
 * - **A rejected promise.** Express 5 forwards one from a route handler; a
 *   handler invoked directly, as here, would leave it unhandled.
 */
export function fromRequestHandler<TReq extends Request>(
  handler: RequestHandler,
): PipelineStep<TReq, TReq> {
  return (req: TReq, res: Response) =>
    new Promise<TReq>((resolve, reject) => {
      let settled = false;

      const onFinish = (): void => {
        // The middleware answered the request itself. Resolve rather than
        // reject — nothing went wrong — and let the pipeline notice the
        // response is over and stop.
        if (settled) return;
        settled = true;
        resolve(req);
      };

      res.once('finish', onFinish);

      const next: NextFunction = (err?: unknown) => {
        res.removeListener('finish', onFinish);
        if (settled) return;
        settled = true;

        if (err === undefined || err === null) {
          resolve(req);
          return;
        }
        if (err === 'route' || err === 'router') {
          reject(new NextRouteUnsupportedError(err));
          return;
        }
        reject(err);
      };

      // `RequestHandler` is typed as returning `void`, but an `async` one
      // returns a promise all the same, and Express 5 forwards its rejection.
      // Calling the handler directly means doing that here or losing it.
      const returned: unknown = handler(req, res, next);

      if (isPromiseLike(returned)) {
        returned.then(undefined, next);
      }
    });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
