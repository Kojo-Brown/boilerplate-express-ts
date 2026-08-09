import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '@/lib/errors';
import type { ApiMeta } from '@/lib/response';
import { ok, sendNoContent } from '@/lib/response';
import type { OperationContext, RouteOperation } from '@/lib/route-decorators/types';

/**
 * Raised as the abort reason when the socket closes before the handler
 * finished. Never reaches the client — there is no client left — but it gives
 * anything watching the signal a reason with a name instead of `undefined`.
 *
 * 499 is nginx's non-standard "client closed request"; it is used here only as
 * an internal label, and the code is what shows up in logs.
 */
export class ClientClosedRequestError extends AppError {
  constructor() {
    super(499, 'Client closed the request before it completed', 'CLIENT_CLOSED_REQUEST');
    this.name = 'ClientClosedRequestError';
  }
}

export interface RouteHandlerOptions<TResult> {
  /** Response status on success. `204` sends no body. Default `200`. */
  status?: number;
  /** Replaces the default `{ data, meta, error }` envelope write. */
  send?: (res: Response, result: TResult, meta: ApiMeta | undefined) => void;
}

/**
 * Turns a decorated `RouteOperation` into an Express handler.
 *
 * This is the only place in the stack that knows about `res`, which is what
 * keeps the decorators honest. It owns three edge concerns:
 *
 * 1. **Cancellation.** Builds the `AbortSignal` every decorator inherits and
 *    aborts it when the socket closes, so a client that gave up stops costing
 *    a database connection.
 * 2. **Errors.** Routes every rejection to `next(err)` — one path to the
 *    translator chain, no handler-local status codes.
 * 3. **Serialisation.** Emits `ctx.meta` as the envelope's `meta`, so what the
 *    decorators recorded (`cache: 'hit'`, `attempts: 2`) is visible on the wire
 *    rather than only in the process.
 */
export function toRequestHandler<TResult, TReq extends Request = Request>(
  operation: RouteOperation<TResult, TReq>,
  options: RouteHandlerOptions<TResult> = {},
): RequestHandler {
  const { status = 200, send } = options;

  return (req, res, next) => {
    const controller = new AbortController();
    let clientGone = false;

    const onClose = (): void => {
      // `close` also fires on a response that completed normally; only an
      // unfinished one means the peer hung up.
      if (res.writableEnded) return;
      clientGone = true;
      controller.abort(new ClientClosedRequestError());
    };
    res.on('close', onClose);

    const ctx: OperationContext = {
      signal: controller.signal,
      attempt: 1,
      meta: {},
    };

    // The bridge cast. Express types the handler's `req` with the router's
    // default generics, while the operation was authored against its own
    // validated params and body (`Request<UserIdParams>`). The narrowing is
    // sound because `validate()` has already parsed those shapes upstream —
    // and it happens exactly once, here, rather than in every operation.
    const typedReq = req as TReq;

    operation(typedReq, ctx)
      .then((result) => {
        if (res.writableEnded || res.headersSent) return;

        if (send !== undefined) {
          send(res, result, metaOrUndefined(ctx.meta));
          return;
        }

        if (status === 204) {
          sendNoContent(res);
          return;
        }

        res.status(status).json(ok(result, metaOrUndefined(ctx.meta)));
      })
      .catch((err: unknown) => {
        // Nobody is listening and Express would try to write to a dead socket.
        if (clientGone && !res.headersSent) return;
        next(err);
      })
      .finally(() => {
        res.removeListener('close', onClose);
      });
  };
}

/** An empty `meta` should serialise as `null`, not `{}`. */
function metaOrUndefined(meta: Record<string, unknown>): ApiMeta | undefined {
  return Object.keys(meta).length > 0 ? meta : undefined;
}
