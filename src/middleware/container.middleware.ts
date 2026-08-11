import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Container, Scope } from '@/lib/container';
import { AppError } from '@/lib/errors';
import { appContainer } from '@/container/app-container';
import { REQUEST } from '@/container/tokens';
import { correlationIdOf } from '@/middleware/logger.middleware';

/**
 * Opens a resolution scope for the request and closes it when the response is
 * done.
 *
 * `close` rather than `finish`: `finish` fires only when the response was sent,
 * so a client that hung up mid-request would leave its scope — and anything the
 * scope had opened — alive until the process restarted. `close` fires on both
 * outcomes.
 *
 * Disposal is not awaited. Nothing downstream is waiting on it, and holding the
 * socket open while a scope drains would make a slow disposer look like a slow
 * endpoint.
 */
export function createContainerMiddleware(container: Container): RequestHandler {
  return function containerMiddleware(req: Request, res: Response, next: NextFunction): void {
    const scope = container.createScope(`request:${correlationIdOf(req) ?? 'unlabelled'}`);
    scope.seed(REQUEST, req);
    req.scope = scope;

    res.on('close', () => {
      // `dispose` already routes disposer failures to the container's reporter,
      // so this only catches a rejection from the disposal machinery itself.
      // An unhandled rejection here would take the process down.
      void scope.dispose().catch((error: unknown) => {
        console.error(`[container] Disposing ${scope.name} failed:`, error);
      });
    });

    next();
  };
}

/** The middleware the app installs, bound to the process-wide container. */
export const containerMiddleware: RequestHandler = createContainerMiddleware(appContainer);

/**
 * The request's scope, or a 500.
 *
 * Returning `undefined` would push an `if (!scope)` into every caller for a
 * condition none of them can do anything about: a missing scope means
 * `containerMiddleware` is not installed, which is a wiring bug in `app.ts`
 * and identical for every request.
 */
export function scopeOf(req: Request): Scope {
  const scope = req.scope;
  if (!scope) {
    throw new AppError(
      500,
      'Request scope is missing — containerMiddleware did not run for this request',
      'CONTAINER_SCOPE_MISSING',
    );
  }
  return scope;
}
