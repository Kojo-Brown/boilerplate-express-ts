import type { RequestHandler } from 'express';
import type { Lifecycle } from '@/shutdown/lifecycle';
import { ServerShuttingDownError } from '@/shutdown/shutdown.errors';

export interface ShutdownGuardOptions {
  readonly lifecycle: Lifecycle;
  /**
   * What the 503 tells a client to wait. Seconds, and small: it is how long a
   * replacement instance takes to start taking traffic, not how long this one
   * intends to keep running.
   */
  readonly retryAfterSeconds?: number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * Refuses new requests once the listener has closed, and only then.
 *
 * The narrowness is the design. Three of the four lifecycle states pass straight
 * through, including `draining` — the window where the signal has landed but the
 * listener is still open. Refusing there would fail traffic a load balancer is
 * still routing in good faith, which is precisely the damage the drain window
 * exists to avoid; the balancer is being told to stop by the readiness answer,
 * not by errors thrown at its users.
 *
 * So what is left for this to catch is a small, real case: a request that
 * arrives on a keep-alive socket opened before the listener closed. Closing a
 * listener stops *new connections*; it does nothing to an established one, and
 * an HTTP client with a warm pool will happily send another request down it.
 * Without this guard that request is routed into an app whose dependencies are
 * being torn down underneath it, and the client's answer is whatever error the
 * closing pool produces — or a socket that disappears mid-request, which is
 * strictly worse, because a reset says nothing about whether the request ran.
 *
 * In-flight requests never see this: they passed through before the state
 * changed, and finishing them is the entire point of the phase that follows.
 *
 * Mounted ahead of the routers and after the logger, so a refusal is recorded
 * with the same correlation id as everything else.
 */
export function shutdownGuard(options: ShutdownGuardOptions): RequestHandler {
  const { lifecycle, retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS } = options;

  return function shutdownGuardMiddleware(_req, _res, next): void {
    if (lifecycle.isServing) {
      next();
      return;
    }

    // Through the error pipeline rather than answered here, so the 503 carries
    // the same envelope, headers and logging as every other refusal in the
    // service. `AppError.headers` is what puts `Retry-After` and
    // `Connection: close` on it.
    next(new ServerShuttingDownError(retryAfterSeconds));
  };
}
