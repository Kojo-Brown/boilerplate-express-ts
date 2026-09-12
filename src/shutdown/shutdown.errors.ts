import { AppError } from '@/lib/errors';

/**
 * A request that arrived after the listener had already closed.
 *
 * 503 and not 502 or 500: this instance declined, deliberately, and the work was
 * never attempted — so a client is free to repeat it verbatim, including a
 * non-idempotent one. That is the difference the status carries, and it is the
 * reason this is refused explicitly rather than left to a socket that vanishes
 * mid-request: a connection reset tells the client nothing about whether its
 * `POST` ran.
 *
 * `Connection: close` is part of the meaning rather than a nicety. The request
 * reached us on a keep-alive socket that this process is about to end, and a
 * client that reuses it finds it gone a moment later — which is the one failure
 * an HTTP client library retries *unsafely*, having no way to know whether the
 * request was received. Saying so in the response turns that into an orderly
 * reconnect to whichever instance is taking traffic now.
 *
 * `Retry-After` is a small number of seconds because that is how long a
 * replacement takes to start serving, not how long this process will live.
 */
export class ServerShuttingDownError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      503,
      'This instance is shutting down and is no longer accepting requests',
      'SERVER_SHUTTING_DOWN',
      {
        // Never below 1: `Retry-After: 0` reads as "retry immediately", which
        // aims the retry back at the instance that just refused it.
        'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
        Connection: 'close',
      },
    );
    this.name = 'ServerShuttingDownError';
  }
}
