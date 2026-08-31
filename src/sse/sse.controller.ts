import type { Request, Response, NextFunction } from 'express';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { openSseConnection } from '@/sse/connection';
import { domainEventStreamHub } from '@/sse/events.hub';
import { readLastEventId } from '@/sse/last-event-id';
import type { SseHub } from '@/sse/hub';

/**
 * `GET /v1/events/stream` — the domain event bus, as it happens.
 *
 * The ordering in here is the whole handler, and it is one-way: everything that
 * could refuse the request has to happen before `openSseConnection`, because
 * that call flushes the headers and commits the response to 200. After it there
 * is no status left to send — a stream that has already started can only be
 * closed, which a client cannot tell apart from a network fault. `requireAuth`
 * and `requireRole` run ahead of this handler for the same reason, and the
 * capacity check is here rather than inside `hub.attach` for it.
 *
 * Nothing is awaited, and that is not incidental either: `attach` reads the
 * replay log and joins the live set with no suspension point between them, so
 * an event published in the middle cannot fall between the two. An `await`
 * anywhere above it reopens that window.
 *
 * A factory rather than a bare handler so the hub is a parameter: the module
 * default is the process-wide one, and a test supplies its own instead of
 * reaching into a singleton whose state outlives the case.
 */
export function createEventStreamHandler(hub: SseHub) {
  return function streamDomainEvents(req: Request, res: Response, next: NextFunction): void {
    try {
      if (!hub.hasCapacity()) {
        // 503 and not 429: the caller has not done anything wrong and slowing
        // it down will not help — this instance is full, and `Retry-After` is
        // the only useful thing to say.
        throw new AppError(
          503,
          `This instance is already serving its maximum of ${hub.maxConnections} event streams`,
          'SSE_CAPACITY_EXHAUSTED',
          { 'Retry-After': String(env.SSE_RETRY_AFTER_SECONDS) },
        );
      }

      const lastEventId = readLastEventId(req);

      const connection = openSseConnection(req, res, {
        heartbeatIntervalMs: env.SSE_HEARTBEAT_INTERVAL_MS,
        retryMs: env.SSE_RETRY_MS,
        maxBufferedBytes: env.SSE_MAX_BUFFERED_BYTES,
      });

      hub.attach(connection, lastEventId);
    } catch (err) {
      next(err);
    }
  };
}

export const sseController = {
  stream: createEventStreamHandler(domainEventStreamHub),
};
